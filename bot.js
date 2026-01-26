require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenAI } = require("@google/genai"); // LIBRERÍA NUEVA
const http = require('http');
const mongoose = require('mongoose');
const cron = require('node-cron');
const fs = require('fs');

// --- 1. CONFIGURACIÓN ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODELO_USADO = "gemini-3-flash-preview"; 

const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// --- 2. SISTEMA DE SEGURIDAD (ANTI-429 y ANTI-CRASH) ---
let lastRequestTime = 0;
const COOLDOWN_MS = 6000; // 6 seg entre llamadas

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function llamarGeminiSeguro(prompt) {
    // Escudo de Tiempo
    const tiempoDesdeUltima = Date.now() - lastRequestTime;
    if (tiempoDesdeUltima < COOLDOWN_MS) {
        const espera = COOLDOWN_MS - tiempoDesdeUltima;
        await delay(espera);
    }

    try {
        console.log(`🚀 AI Request: ${MODELO_USADO}`);
        const response = await ai.models.generateContent({
            model: MODELO_USADO,
            contents: prompt
        });
        lastRequestTime = Date.now();
        
        // Extracción robusta del texto
        let text = "";
        if (response.text && typeof response.text === 'function') text = response.text();
        else if (response.text) text = response.text;
        else if (response.candidates?.[0]?.content?.parts?.[0]?.text) text = response.candidates[0].content.parts[0].text;
        
        return text || "Error: Respuesta vacía IA";

    } catch (error) {
        console.error("❌ Error AI:", error.message);
        if (error.status === 429 || error.message.includes('429')) {
            throw new Error("⏳ AI Saturada. Reintenta en 1 min.");
        }
        throw error;
    }
}

async function enviarMensajeSeguro(chatId, texto, opciones = {}) {
    try {
        await bot.sendMessage(chatId, texto, { ...opciones, parse_mode: 'Markdown' });
    } catch (error) {
        if (error.message.includes("can't parse entities") || error.message.includes("Bad Request")) {
            // Fallback a texto plano si falla el markdown
            await bot.sendMessage(chatId, "⚠️ _Formato simplificado:_\n" + texto, opciones);
        } else {
            console.error("Error Telegram:", error.message);
        }
    }
}

// --- 3. BASE DE DATOS (ESQUEMA EXTENDIDO) ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Bot V5 PRO: DB Conectada'))
    .catch(err => console.error('🔴 Error BD:', err));

const PrediccionSchema = new mongoose.Schema({
    partidoId: { type: String, unique: true },
    equipoLocal: String, equipoVisita: String, fechaPartido: String,
    analisisIA: String, pickIA: String, liga: String,
    
    // CAMPOS NUEVOS (Recuperados)
    montoApostado: { type: Number, default: 0 },
    confianza: { type: String, default: '🟡' }, // Semáforo
    resultadoReal: { type: String, default: null },
    estado: { type: String, default: 'PENDIENTE' }, // PENDIENTE, GANADA, PERDIDA
    
    createdAt: { type: Date, default: Date.now }
});
const Prediccion = mongoose.model('Prediccion', PrediccionSchema);
const Config = mongoose.model('Config', new mongoose.Schema({ key: String, value: String }));

// --- 4. COMANDOS PRINCIPALES ---

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await Config.findOneAndUpdate({ key: 'adminChatId' }, { value: chatId }, { upsert: true });

    enviarMensajeSeguro(chatId, `⚽ *Tipster AI V5 - PRO*
_Motor: Gemini 3 Flash Preview_

✅ Semáforo de Confianza
✅ Gestión de Banca
✅ Auditoría Automática
✅ Radar de Lesiones`, {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 LaLiga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇮🇹 Serie A', callback_data: 'comp_SA' }, { text: '🇩🇪 Bundesliga', callback_data: 'comp_BL1' }],
                [{ text: '🏆 Champions', callback_data: 'comp_CL' }, { text: '🇫🇷 Ligue 1', callback_data: 'comp_FL1' }],
                [{ text: '📊 AUDITAR (Juez IA)', callback_data: 'ver_auditoria' }, { text: '💰 MI BANCA', callback_data: 'ver_banca' }],
                [{ text: '📥 EXPORTAR EXCEL', callback_data: 'exportar_excel' }]
            ]
        }
    });
});

// --- 5. LÓGICA DE ANÁLISIS (CORE) ---

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data.startsWith('comp_')) await listarPartidos(chatId, data.split('_')[1]);
    else if (data.startsWith('analyze|')) {
        const [_, home, away, code, date] = data.split('|');
        await procesarAnalisisCompleto(chatId, home, away, code, date);
    }
    else if (data.startsWith('radar|')) {
        const [_, home, away] = data.split('|');
        await consultarRadar(chatId, home, away);
    }
    else if (data === 'ver_auditoria') await ejecutarAuditoria(chatId);
    else if (data === 'ver_banca') await mostrarBanca(chatId);
    else if (data === 'exportar_excel') await exportarCSV(chatId);

    try { await bot.answerCallbackQuery(query.id); } catch(e){}
});

// LISTAR PARTIDOS
async function listarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        await delay(1000); // Pausa API Fútbol
        const hoy = new Date().toISOString().split('T')[0];
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders, params: { dateFrom: hoy, dateTo: hoy, status: 'SCHEDULED' }
        });

        const matches = res.data.matches || [];
        if (matches.length === 0) return enviarMensajeSeguro(chatId, "⚠️ No hay partidos hoy en esta liga.");

        for (const m of matches.slice(0, 4)) { // Limitado a 4 para no saturar visualmente
            const h = m.homeTeam.name;
            const a = m.awayTeam.name;
            const d = m.utcDate.split('T')[0];
            const existe = await Prediccion.exists({ partidoId: `${h}-${a}-${d}` });
            
            const btnText = existe ? "✅ Ver Pick" : "🧠 Analizar IA";
            bot.sendMessage(chatId, `🏟️ *${h}* vs *${a}*`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: btnText, callback_data: `analyze|${h}|${a}|${code}|${d}` }]] }
            });
        }
    } catch (e) { enviarMensajeSeguro(chatId, "❌ Error API Fútbol."); }
}

// ANÁLISIS IA + SEMÁFORO + STAKE
async function procesarAnalisisCompleto(chatId, home, away, code, date) {
    const id = `${home}-${away}-${date}`;
    const cached = await Prediccion.findOne({ partidoId: id });
    
    if (cached) {
        return bot.sendMessage(chatId, `📂 *YA ANALIZADO*\n\n${cached.analisisIA}`, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "🔍 Radar Lesiones/Claves", callback_data: `radar|${home}|${away}` }]] }
        });
    }

    bot.sendChatAction(chatId, 'typing');
    enviarMensajeSeguro(chatId, "🧠 *Gemini 3 analizando stats...* (Esto toma ~6s)");

    try {
        const racha = await obtenerRacha(code, home, away);
        
        // Prompt diseñado para devolver JSON (aunque la API a veces falla, lo limpiamos luego)
        const prompt = `Analista Deportivo Experto.
        Partido: ${home} vs ${away}.
        Historial reciente: ${racha}.
        
        Genera un JSON válido (sin bloques de código) con esta estructura exacta:
        {"pick": "Texto corto del pick", "confianza": "🟢/🟡/🔴", "stake": 20, "razon": "Explicación breve de 2 lineas", "marcador": "1-0"}
        
        Reglas de confianza:
        🟢 Alta (Stake 50) = Muy probable.
        🟡 Media (Stake 20) = Partido parejo.
        🔴 Baja (Stake 10) = Arriesgado.`;

        const rawText = await llamarGeminiSeguro(prompt);
        
        // Limpieza de JSON (A veces Gemini pone markdown ```json ... ```)
        let jsonStr = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        let datos = {};
        
        try {
            datos = JSON.parse(jsonStr);
        } catch (e) {
            // Fallback si falla el JSON
            datos = { pick: rawText.substring(0, 50), confianza: '🟡', stake: 20, razon: "Análisis manual requerido", marcador: "?" };
        }

        const msgFinal = `🎯 *PICK:* ${datos.pick}
${datos.confianza} *Confianza:* ${getNombreConfianza(datos.confianza)}
💰 *Stake Sugerido:* S/. ${datos.stake}
⚽ *Marcador Probable:* ${datos.marcador}

💡 *Análisis:* ${datos.razon}`;

        const nueva = new Prediccion({
            partidoId: id, equipoLocal: home, equipoVisita: away, fechaPartido: date,
            analisisIA: msgFinal, pickIA: datos.pick, liga: code,
            montoApostado: datos.stake, confianza: datos.confianza
        });
        await nueva.save();

        bot.sendMessage(chatId, msgFinal, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "🔍 Radar Lesiones/Claves", callback_data: `radar|${home}|${away}` }]] }
        });

    } catch (e) { enviarMensajeSeguro(chatId, "❌ Error Análisis: " + e.message); }
}

// RADAR DE ALINEACIONES
async function consultarRadar(chatId, home, away) {
    enviarMensajeSeguro(chatId, "🔍 *Escaneando noticias de última hora...*");
    try {
        const prompt = `¿Hay bajas importantes, lesiones o noticias de última hora que afecten el partido ${home} vs ${away}? Responde en 2 frases cortas.`;
        const resp = await llamarGeminiSeguro(prompt);
        enviarMensajeSeguro(chatId, `🚨 *RADAR INFO:*\n${resp}`);
    } catch (e) { enviarMensajeSeguro(chatId, "❌ Radar no disponible."); }
}

// --- 6. AUDITORÍA (JUEZ IA) Y BANCA ---

async function ejecutarAuditoria(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' });
    if (!pendientes.length) return enviarMensajeSeguro(chatId, "✅ Todo auditado. No hay pendientes.");

    enviarMensajeSeguro(chatId, `👨‍⚖️ *Juez IA iniciando sesión...*
Revisando ${pendientes.length} partidos.
⏳ _Esto puede tardar un poco para no saturar el sistema._`);

    let ganadas = 0, perdidas = 0;

    // Loop secuencial para respetar el tiempo de espera
    for (const p of pendientes) {
        try {
            await delay(2000); // Pausa API Futbol
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${p.liga}/matches`, {
                headers: footballHeaders, params: { status: 'FINISHED', dateFrom: p.fechaPartido, dateTo: p.fechaPartido }
            });
            
            const match = res.data.matches.find(m => m.homeTeam.name === p.equipoLocal);
            
            if (match && match.score.fullTime.home !== null) {
                const resultado = `${match.score.fullTime.home}-${match.score.fullTime.away}`;
                
                // Juez IA: Le preguntamos si ganó o perdió
                const prompt = `Apuesta: "${p.pickIA}". Resultado Final: ${p.equipoLocal} ${resultado} ${p.equipoVisita}.
                ¿La apuesta se GANÓ o PERDIÓ? Responde SOLO una palabra: GANADA o PERDIDA.`;
                
                const veredicto = await llamarGeminiSeguro(prompt);
                
                const estadoFinal = veredicto.toUpperCase().includes('GAN') ? 'GANADA' : 'PERDIDA';
                
                p.estado = estadoFinal;
                p.resultadoReal = resultado;
                await p.save();
                
                if (estadoFinal === 'GANADA') ganadas++; else perdidas++;
            }
        } catch (e) { console.log(`Error auditando ${p.equipoLocal}: ${e.message}`); }
    }
    
    enviarMensajeSeguro(chatId, `✅ *Auditoría Finalizada*
🏆 Ganadas: ${ganadas}
❌ Perdidas: ${perdidas}
💰 Usa el botón "MI BANCA" para ver saldo.`);
}

async function mostrarBanca(chatId) {
    const historial = await Prediccion.find({ estado: { $ne: 'PENDIENTE' } });
    let saldo = 0;
    let invertido = 0;

    historial.forEach(p => {
        invertido += p.montoApostado;
        if (p.estado === 'GANADA') {
            // Asumimos cuota media 1.80 para cálculo simple
            saldo += (p.montoApostado * 0.80); 
        } else {
            saldo -= p.montoApostado;
        }
    });

    const emoji = saldo >= 0 ? '🤑' : '📉';
    enviarMensajeSeguro(chatId, `💰 *BANCA PERSONAL*
    
🔢 Apuestas cerradas: ${historial.length}
💸 Total Invertido: S/. ${invertido}
${emoji} *GANANCIA NETA:* S/. ${saldo.toFixed(2)}`);
}

// --- 7. EXPORTAR EXCEL (CSV) ---
async function exportarCSV(chatId) {
    try {
        const data = await Prediccion.find({});
        if (!data.length) return enviarMensajeSeguro(chatId, "📭 No hay datos para exportar.");

        let csv = "FECHA,LOCAL,VISITA,PICK,CONFIANZA,STAKE,RESULTADO,ESTADO\n";
        data.forEach(p => {
            csv += `${p.fechaPartido},${p.equipoLocal},${p.equipoVisita},"${p.pickIA}",${p.confianza},${p.montoApostado},${p.resultadoReal || '-'},${p.estado}\n`;
        });

        const path = `/tmp/Tipster_History_${Date.now()}.csv`;
        fs.writeFileSync(path, csv);
        await bot.sendDocument(chatId, path, { caption: "📊 Aquí tienes tu historial completo." });
        fs.unlinkSync(path); // Borrar archivo temporal
    } catch (e) { enviarMensajeSeguro(chatId, "Error generando archivo."); }
}

// --- UTILIDADES ---
async function obtenerRacha(code, home, away) {
    try {
        await delay(500);
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders, params: { status: 'FINISHED', limit: 8 }
        });
        const relevantes = res.data.matches.filter(m => m.homeTeam.name === home || m.awayTeam.name === away);
        return relevantes.slice(0, 5).map(m => `(${m.utcDate.split('T')[0]}) ${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away} ${m.awayTeam.name}`).join(", ");
    } catch { return "Sin datos previos."; }
}

function getNombreConfianza(simbolo) {
    if (simbolo.includes('🟢')) return "ALTA";
    if (simbolo.includes('🔴')) return "BAJA";
    return "MEDIA";
}

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.end('Bot V5 PRO Online'); }).listen(PORT);