require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenAI } = require("@google/genai"); 
const http = require('http');
const mongoose = require('mongoose');
const cron = require('node-cron');
const fs = require('fs');

// --- 1. CONFIGURACIÓN ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// Modelo rápido y avanzado
const MODELO_USADO = "gemini-3-flash-preview"; 

const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// --- 2. SISTEMA DE SEGURIDAD (ANTI-BLOQUEO 429) ---
let lastRequestTime = 0;
const COOLDOWN_MS = 6000; // 6 segundos obligatorios entre peticiones a la IA

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
        // Extracción segura para la librería nueva
        if (response.text && typeof response.text === 'function') text = response.text();
        else if (response.text) text = response.text;
        else if (response.candidates?.[0]?.content?.parts?.[0]?.text) text = response.candidates[0].content.parts[0].text;
        
        return text || "";

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
        // Si falla el Markdown (negritas mal cerradas), enviamos texto plano
        if (error.message.includes("can't parse entities") || error.message.includes("Bad Request")) {
            await bot.sendMessage(chatId, "⚠️ _Formato simplificado:_\n" + texto, opciones);
        } else {
            console.error("Error Telegram:", error.message);
        }
    }
}

// --- 3. BASE DE DATOS ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Bot V6.2 (Champions & Fixes): DB Conectada'))
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

// --- 4. MENÚ PRINCIPAL ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await Config.findOneAndUpdate({ key: 'adminChatId' }, { value: chatId }, { upsert: true });

    enviarMensajeSeguro(chatId, `⚽ *Tipster AI V6.2 - Full Leagues*
    
✅ Champions League y Ligue 1 Activas
✅ Corrección de picks vacíos
✅ Reporte automático 6:00 AM`, {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 LaLiga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇮🇹 Serie A', callback_data: 'comp_SA' }, { text: '🇩🇪 Bundesliga', callback_data: 'comp_BL1' }],
                // AQUÍ ESTÁN TUS LIGAS SOLICITADAS:
                [{ text: '🏆 Champions', callback_data: 'comp_CL' }, { text: '🇫🇷 Ligue 1', callback_data: 'comp_FL1' }],
                
                [{ text: '⏳ PENDIENTES', callback_data: 'ver_pendientes' }, { text: '💰 BANCA', callback_data: 'ver_banca' }],
                [{ text: '📊 AUDITAR', callback_data: 'ver_auditoria' }, { text: '📥 EXPORTAR', callback_data: 'exportar_excel' }]
            ]
        }
    });
});

// --- 5. LOGICA MATUTINA (6:00 AM) ---
cron.schedule('0 6 * * *', async () => {
    const config = await Config.findOne({ key: 'adminChatId' });
    if (config) ejecutarReporteSeguro(config.value);
}, { scheduled: true, timezone: "America/Lima" });

async function ejecutarReporteSeguro(chatId) {
    enviarMensajeSeguro(chatId, "☀️ *Buenos días. Escaneando TODAS las ligas...*");
    
    // Lista completa de ligas para el reporte
    const ligas = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL'];
    let partidos = [];
    const hoy = new Date().toISOString().split('T')[0];

    try {
        // Paso 1: Recopilar partidos (sin gastar IA)
        for (const code of ligas) {
            await delay(1000); // Pausa API Fútbol
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
                headers: footballHeaders, params: { dateFrom: hoy, dateTo: hoy }
            });
            if (res.data.matches) partidos = [...partidos, ...res.data.matches];
        }

        if (partidos.length === 0) return enviarMensajeSeguro(chatId, "☕ No hay partidos importantes hoy.");

        // Paso 2: Crear lista de texto
        const listaTexto = partidos.slice(0, 15).map(m => `• ${m.homeTeam.name} vs ${m.awayTeam.name} (${m.competition.name})`).join("\n");

        // Paso 3: Una sola llamada a Gemini (Picks Seguros)
        const prompt = `Analiza los partidos de hoy:
${listaTexto}

Dame SOLO las 3 apuestas más seguras (Stake Alto).
Formato obligatorio:
🏆 *LIGA*
⚔️ Partido: Local vs Visita
💎 Pick: (Ej: Gana Local)
💡 Razón: (Breve)
💰 Confianza: ALTA (🟢)`;

        const respuesta = await llamarGeminiSeguro(prompt);
        enviarMensajeSeguro(chatId, `🗞️ *PICKS DE LA MAÑANA*\n\n${respuesta}`);

    } catch (e) {
        enviarMensajeSeguro(chatId, "❌ Error reporte: " + e.message);
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
    else if (data === 'ver_pendientes') await verPendientes(chatId);
    else if (data === 'ver_auditoria') await ejecutarAuditoria(chatId);
    else if (data === 'ver_banca') await mostrarBanca(chatId);
    else if (data === 'exportar_excel') await exportarCSV(chatId);

    try { await bot.answerCallbackQuery(query.id); } catch(e){}
});

// LISTAR PARTIDOS
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

// --- CORE DEL FIX: ANALISIS ROBUSTO (NO MÁS UNDEFINED) ---
async function procesarAnalisisCompleto(chatId, home, away, code, date) {
    const id = `${home}-${away}-${date}`;
    const cached = await Prediccion.findOne({ partidoId: id });
    
    if (cached) {
        return bot.sendMessage(chatId, `📂 *GUARDADO*\n\n${cached.analisisIA}`, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "🔍 Radar", callback_data: `radar|${home}|${away}` }]] }
        });
    }

    bot.sendChatAction(chatId, 'typing');
    enviarMensajeSeguro(chatId, "🧠 *Gemini 3 cocinando pick...*");

    try {
        const racha = await obtenerRacha(code, home, away);
        
        const prompt = `Actúa como Tipster Experto.
        Partido: ${home} vs ${away}.
        Historial: ${racha}.
        
        Tu misión: Generar un JSON válido.
        Estructura OBLIGATORIA:
        {
          "pick": "Solo el mercado (ej: Gana Local)",
          "confianza": "🟢, 🟡 o 🔴",
          "stake": 20,
          "razon": "Explicación breve",
          "marcador": "1-0"
        }
        
        NO añadas texto antes ni después.`;

        const rawText = await llamarGeminiSeguro(prompt);
        
        // Usamos el extractor inteligente
        let datos = extraerDatosDeTexto(rawText); 

        const msgFinal = `🎯 *PICK:* ${datos.pick}
${datos.confianza} *Confianza:* ${getNombreConfianza(datos.confianza)}
💰 *Stake:* S/. ${datos.stake}
⚽ *Marcador:* ${datos.marcador}

💡 *Análisis:* ${datos.razon}`;

        const nueva = new Prediccion({
            partidoId: id, equipoLocal: home, equipoVisita: away, fechaPartido: date,
            analisisIA: msgFinal, // Mensaje completo
            pickIA: datos.pick,   // Pick limpio para BD
            liga: code,
            montoApostado: datos.stake, confianza: datos.confianza
        });
        await nueva.save();

        bot.sendMessage(chatId, msgFinal, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "🔍 Radar", callback_data: `radar|${home}|${away}` }]] }
        });

    } catch (e) { enviarMensajeSeguro(chatId, "❌ Error: " + e.message); }
}

// FUNCIÓN DE LIMPIEZA (FIX UNDEFINED)
function extraerDatosDeTexto(rawText) {
    let datos = { pick: "Ver Análisis", confianza: "🟡", stake: 20, razon: "", marcador: "?" };

    try {
        // Limpiar bloques de código markdown
        let jsonClean = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        
        // Buscar el objeto JSON real dentro del texto
        const firstOpen = jsonClean.indexOf('{');
        const lastClose = jsonClean.lastIndexOf('}');
        
        if (firstOpen !== -1 && lastClose !== -1) {
            jsonClean = jsonClean.substring(firstOpen, lastClose + 1);
            const parsed = JSON.parse(jsonClean);
            if (parsed.pick) datos = { ...datos, ...parsed };
            return datos;
        }
    } catch (e) {
        console.log("Fallo JSON, usando extracción manual por Regex...");
    }

    // Extracción manual si Gemini no manda JSON
    const pickMatch = rawText.match(/"?pick"?:\s*"([^"]+)"/i) || rawText.match(/Pick:\s*(.+)/i);
    const stakeMatch = rawText.match(/"?stake"?:\s*(\d+)/i) || rawText.match(/Stake:\s*(\d+)/i);
    const confMatch = rawText.match(/"?confianza"?:\s*"([^"]+)"/i);
    
    if (pickMatch) datos.pick = pickMatch[1].replace(/["},]/g, '').trim(); // Limpieza extra
    else datos.pick = rawText.substring(0, 50).replace(/\n/g, ' ');

    if (stakeMatch) datos.stake = parseInt(stakeMatch[1]);
    if (confMatch) datos.confianza = confMatch[1];
    
    if (!datos.razon && rawText.length > 50) datos.razon = "Ver detalles arriba.";

    return datos;
}

// --- OTRAS FUNCIONES ---
async function verPendientes(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' }).sort({ fechaPartido: 1 });
    
    if (pendientes.length === 0) return enviarMensajeSeguro(chatId, "✅ No tienes apuestas pendientes.");

    let mensaje = `⏳ *PENDIENTES (${pendientes.length})*\n\n`;
    pendientes.forEach((p, index) => {
        mensaje += `*${index + 1}.* ${p.equipoLocal} vs ${p.equipoVisita}\n`;
        // Aquí usamos p.pickIA que ahora sí estará limpio
        mensaje += `🎯 ${p.pickIA}\n`; 
        mensaje += `💰 Stake: ${p.montoApostado} | 📅 ${p.fechaPartido}\n`;
        mensaje += `-------------------\n`;
    });

    mensaje += `\n_Usa "AUDITAR" para verificar resultados._`;
    enviarMensajeSeguro(chatId, mensaje);
}

async function consultarRadar(chatId, home, away) {
    enviarMensajeSeguro(chatId, "🔍 *Revisando bajas...*");
    try {
        const prompt = `Ultimas noticias: ${home} vs ${away}. ¿Lesiones graves?`;
        const resp = await llamarGeminiSeguro(prompt);
        enviarMensajeSeguro(chatId, `🚨 *RADAR:*\n${resp}`);
    } catch (e) { enviarMensajeSeguro(chatId, "❌ Radar off."); }
}

async function ejecutarAuditoria(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' });
    if (!pendientes.length) return enviarMensajeSeguro(chatId, "✅ Nada que auditar.");

    enviarMensajeSeguro(chatId, `👨‍⚖️ *Auditando ${pendientes.length} apuestas...*`);
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
                // Juez IA determina si ganó
                const prompt = `Pick: "${p.pickIA}". Resultado: ${p.equipoLocal} ${resultado} ${p.equipoVisita}. ¿GANADA o PERDIDA?`;
                const veredicto = await llamarGeminiSeguro(prompt);
                
                const estadoFinal = veredicto.toUpperCase().includes('GAN') ? 'GANADA' : 'PERDIDA';
                p.estado = estadoFinal;
                p.resultadoReal = resultado;
                await p.save();
                
                if (estadoFinal === 'GANADA') ganadas++; else perdidas++;
            }
        } catch (e) { console.log(e.message); }
    }
    enviarMensajeSeguro(chatId, `✅ *Resultado:* +${ganadas} / -${perdidas}`);
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
        const path = `/tmp/History_${Date.now()}.csv`;
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
    } catch { return ""; }
}

function getNombreConfianza(simbolo) {
    if (simbolo.includes('🟢')) return "ALTA";
    if (simbolo.includes('🔴')) return "BAJA";
    return "MEDIA";
}

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.end('Bot V6.2 Full Online'); }).listen(PORT);