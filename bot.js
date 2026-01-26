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

// --- 2. SISTEMA DE SEGURIDAD (INTACTO) ---
let lastRequestTime = 0;
const COOLDOWN_MS = 6000; // 6 seg entre llamadas para proteger tu cuenta

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
            await bot.sendMessage(chatId, "⚠️ _Formato simplificado:_\n" + texto, opciones);
        } else {
            console.error("Error Telegram:", error.message);
        }
    }
}

// --- 3. BASE DE DATOS ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Bot V6.0: DB Conectada'))
    .catch(err => console.error('🔴 Error BD:', err));

const PrediccionSchema = new mongoose.Schema({
    partidoId: { type: String, unique: true },
    equipoLocal: String, equipoVisita: String, fechaPartido: String,
    analisisIA: String, pickIA: String, liga: String,
    montoApostado: { type: Number, default: 0 },
    confianza: { type: String, default: '🟡' }, 
    resultadoReal: { type: String, default: null },
    estado: { type: String, default: 'PENDIENTE' },
    createdAt: { type: Date, default: Date.now }
});
const Prediccion = mongoose.model('Prediccion', PrediccionSchema);
const Config = mongoose.model('Config', new mongoose.Schema({ key: String, value: String }));

// --- 4. COMANDOS PRINCIPALES ---

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await Config.findOneAndUpdate({ key: 'adminChatId' }, { value: chatId }, { upsert: true });

    enviarMensajeSeguro(chatId, `⚽ *Tipster AI V6.0 - Morning Edition*
    
✅ Reporte 6:00 AM Activado
✅ Picks Seguros Diarios
✅ Gestión de Pendientes`, {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 LaLiga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇮🇹 Serie A', callback_data: 'comp_SA' }, { text: '🇩🇪 Bundesliga', callback_data: 'comp_BL1' }],
                [{ text: '🏆 Champions', callback_data: 'comp_CL' }, { text: '🇫🇷 Ligue 1', callback_data: 'comp_FL1' }],
                // BOTÓN NUEVO AGREGADO:
                [{ text: '⏳ MIS PENDIENTES', callback_data: 'ver_pendientes' }, { text: '💰 BANCA', callback_data: 'ver_banca' }],
                [{ text: '📊 AUDITAR', callback_data: 'ver_auditoria' }, { text: '📥 EXPORTAR', callback_data: 'exportar_excel' }]
            ]
        }
    });
});

// --- 5. LOGICA MATUTINA (6:00 AM) ---
// Cron modificado a las 6:00 AM
cron.schedule('0 6 * * *', async () => {
    const config = await Config.findOne({ key: 'adminChatId' });
    if (config) ejecutarReporteSeguro(config.value);
}, { scheduled: true, timezone: "America/Lima" });

async function ejecutarReporteSeguro(chatId) {
    enviarMensajeSeguro(chatId, "☀️ *Buenos días. Buscando apuestas seguras...*");
    
    const ligas = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL'];
    let partidos = [];
    const hoy = new Date().toISOString().split('T')[0];

    try {
        // 1. Recopilamos partidos SIN llamar a la IA todavía (ahorra recursos)
        for (const code of ligas) {
            await delay(1000); // Pausa API Fútbol
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
                headers: footballHeaders, params: { dateFrom: hoy, dateTo: hoy }
            });
            if (res.data.matches) partidos = [...partidos, ...res.data.matches];
        }

        if (partidos.length === 0) return enviarMensajeSeguro(chatId, "☕ No hay partidos importantes hoy.");

        // 2. Preparamos una lista de texto para enviarla en UN SOLO PROMPT
        const listaTexto = partidos.slice(0, 15).map(m => `• ${m.homeTeam.name} vs ${m.awayTeam.name} (${m.competition.name})`).join("\n");

        // 3. Llamada ÚNICA a Gemini (Anti-Saturación)
        const prompt = `Analiza estos partidos de hoy:
${listaTexto}

Tu tarea: Selecciona ÚNICAMENTE los 3 partidos más seguros (High Confidence/Stake Alto).
Ignora los partidos parejos o arriesgados.

Responde con este formato limpio:
🏆 *LIGA*
⚔️ Partido: Local vs Visita
💎 Pick Seguro: (Ej: Gana Local, +1.5 Goles)
💡 Razón: (1 frase corta)
💰 Confianza: ALTA (🟢)`;

        const respuesta = await llamarGeminiSeguro(prompt);
        enviarMensajeSeguro(chatId, `🗞️ *TOP 3 APUESTAS SEGURAS DE HOY*\n\n${respuesta}`);

    } catch (e) {
        enviarMensajeSeguro(chatId, "❌ Error reporte matutino: " + e.message);
    }
}

// --- 6. MANEJO DE BOTONES ---

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
    else if (data === 'ver_pendientes') await verPendientes(chatId); // NUEVA FUNCIÓN
    else if (data === 'ver_auditoria') await ejecutarAuditoria(chatId);
    else if (data === 'ver_banca') await mostrarBanca(chatId);
    else if (data === 'exportar_excel') await exportarCSV(chatId);

    try { await bot.answerCallbackQuery(query.id); } catch(e){}
});

// NUEVA FUNCIÓN: VER PENDIENTES
async function verPendientes(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' }).sort({ fechaPartido: 1 });
    
    if (pendientes.length === 0) {
        return enviarMensajeSeguro(chatId, "✅ No tienes apuestas pendientes.");
    }

    let mensaje = `⏳ *TUS APUESTAS ACTIVAS (${pendientes.length})*\n\n`;
    
    // Listamos sin gastar IA
    pendientes.forEach((p, index) => {
        mensaje += `*${index + 1}.* ${p.equipoLocal} vs ${p.equipoVisita}\n`;
        mensaje += `🎯 Pick: ${p.pickIA}\n`;
        mensaje += `📅 Fecha: ${p.fechaPartido} | 💰 Stake: ${p.montoApostado}\n`;
        mensaje += `-------------------\n`;
    });

    mensaje += `\n_Usa "AUDITAR" para verificar si ya terminaron._`;
    enviarMensajeSeguro(chatId, mensaje);
}

// --- FUNCIONES EXISTENTES (CORE) ---

async function listarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        await delay(1000); 
        const hoy = new Date().toISOString().split('T')[0];
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders, params: { dateFrom: hoy, dateTo: hoy, status: 'SCHEDULED' }
        });

        const matches = res.data.matches || [];
        if (matches.length === 0) return enviarMensajeSeguro(chatId, "⚠️ No hay partidos hoy en esta liga.");

        for (const m of matches.slice(0, 4)) { 
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

async function procesarAnalisisCompleto(chatId, home, away, code, date) {
    const id = `${home}-${away}-${date}`;
    const cached = await Prediccion.findOne({ partidoId: id });
    
    if (cached) {
        return bot.sendMessage(chatId, `📂 *YA ANALIZADO*\n\n${cached.analisisIA}`, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "🔍 Radar", callback_data: `radar|${home}|${away}` }]] }
        });
    }

    bot.sendChatAction(chatId, 'typing');
    enviarMensajeSeguro(chatId, "🧠 *Gemini 3 calculando pick seguro...*");

    try {
        const racha = await obtenerRacha(code, home, away);
        
        const prompt = `Analista Deportivo.
        Partido: ${home} vs ${away}.
        Historial: ${racha}.
        
        Responde JSON (sin markdown):
        {"pick": "Pick corto", "confianza": "🟢/🟡/🔴", "stake": 20, "razon": "Razón corta", "marcador": "1-0"}`;

        const rawText = await llamarGeminiSeguro(prompt);
        let jsonStr = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        let datos = {};
        
        try { datos = JSON.parse(jsonStr); } 
        catch (e) { datos = { pick: rawText.substring(0, 40), confianza: '🟡', stake: 20, razon: "Análisis manual", marcador: "?" }; }

        const msgFinal = `🎯 *PICK:* ${datos.pick}
${datos.confianza} *Confianza:* ${datos.confianza.includes('🟢') ? 'ALTA' : 'MEDIA'}
💰 *Stake:* S/. ${datos.stake}
💡 *Razón:* ${datos.razon}`;

        const nueva = new Prediccion({
            partidoId: id, equipoLocal: home, equipoVisita: away, fechaPartido: date,
            analisisIA: msgFinal, pickIA: datos.pick, liga: code,
            montoApostado: datos.stake, confianza: datos.confianza
        });
        await nueva.save();

        bot.sendMessage(chatId, msgFinal, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "🔍 Radar", callback_data: `radar|${home}|${away}` }]] }
        });

    } catch (e) { enviarMensajeSeguro(chatId, "❌ Error: " + e.message); }
}

async function consultarRadar(chatId, home, away) {
    enviarMensajeSeguro(chatId, "🔍 *Consultando noticias...*");
    try {
        const prompt = `Noticias cortas de última hora: ${home} vs ${away}. ¿Lesiones claves?`;
        const resp = await llamarGeminiSeguro(prompt);
        enviarMensajeSeguro(chatId, `🚨 *RADAR INFO:*\n${resp}`);
    } catch (e) { enviarMensajeSeguro(chatId, "❌ Radar inactivo."); }
}

async function ejecutarAuditoria(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' });
    if (!pendientes.length) return enviarMensajeSeguro(chatId, "✅ No hay pendientes para auditar.");

    enviarMensajeSeguro(chatId, `👨‍⚖️ *Auditando ${pendientes.length} apuestas...* (Paciencia)`);
    let ganadas = 0, perdidas = 0;

    for (const p of pendientes) {
        try {
            await delay(2000); 
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${p.liga}/matches`, {
                headers: footballHeaders, params: { status: 'FINISHED', dateFrom: p.fechaPartido, dateTo: p.fechaPartido }
            });
            
            const match = res.data.matches.find(m => m.homeTeam.name === p.equipoLocal);
            if (match && match.score.fullTime.home !== null) {
                const resultado = `${match.score.fullTime.home}-${match.score.fullTime.away}`;
                const prompt = `Pick: "${p.pickIA}". Resultado: ${p.equipoLocal} ${resultado} ${p.equipoVisita}. ¿GANADA o PERDIDA? Solo 1 palabra.`;
                const veredicto = await llamarGeminiSeguro(prompt);
                
                const estadoFinal = veredicto.toUpperCase().includes('GAN') ? 'GANADA' : 'PERDIDA';
                p.estado = estadoFinal;
                p.resultadoReal = resultado;
                await p.save();
                
                if (estadoFinal === 'GANADA') ganadas++; else perdidas++;
            }
        } catch (e) { console.log(e.message); }
    }
    enviarMensajeSeguro(chatId, `✅ *Resultado Auditoría:*\n🏆 +${ganadas} | ❌ -${perdidas}`);
}

async function mostrarBanca(chatId) {
    const historial = await Prediccion.find({ estado: { $ne: 'PENDIENTE' } });
    let saldo = 0;
    historial.forEach(p => {
        if (p.estado === 'GANADA') saldo += (p.montoApostado * 0.80);
        else saldo -= p.montoApostado;
    });
    enviarMensajeSeguro(chatId, `💰 *BANCA NETA:* S/. ${saldo.toFixed(2)}`);
}

async function exportarCSV(chatId) {
    try {
        const data = await Prediccion.find({});
        if (!data.length) return enviarMensajeSeguro(chatId, "📭 Vacío.");
        let csv = "FECHA,PARTIDO,PICK,STAKE,ESTADO\n";
        data.forEach(p => csv += `${p.fechaPartido},${p.equipoLocal} vs ${p.equipoVisita},"${p.pickIA}",${p.montoApostado},${p.estado}\n`);
        const path = `/tmp/Tipster_History_${Date.now()}.csv`;
        fs.writeFileSync(path, csv);
        await bot.sendDocument(chatId, path);
        fs.unlinkSync(path);
    } catch (e) { enviarMensajeSeguro(chatId, "Error archivo."); }
}

async function obtenerRacha(code, home, away) {
    try {
        await delay(500);
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders, params: { status: 'FINISHED', limit: 8 }
        });
        return res.data.matches.filter(m => m.homeTeam.name === home || m.awayTeam.name === away)
            .slice(0, 5).map(m => `${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away} ${m.awayTeam.name}`).join(", ");
    } catch { return "Sin datos previos."; }
}

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.end('Bot V6 Online'); }).listen(PORT);