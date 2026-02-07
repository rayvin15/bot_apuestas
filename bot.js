require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
// IMPORTANTE: Usamos la nueva librería recomendada
const { GoogleGenAI } = require("@google/genai"); 
const http = require('http');
const mongoose = require('mongoose');
const fs = require('fs');

// --- 1. CONFIGURACIÓN ---
// Inicialización con la nueva sintaxis
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Usamos el modelo 2.0
const MODELO_USADO = "gemini-1.5-flash-latest"; 

const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// --- 2. SISTEMA DE SEGURIDAD (ANTI-BLOQUEO) ---
let lastRequestTime = 0;
const COOLDOWN_MS = 5000; 

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function llamarGeminiSeguro(prompt) {
    const tiempoDesdeUltima = Date.now() - lastRequestTime;
    if (tiempoDesdeUltima < COOLDOWN_MS) {
        await delay(COOLDOWN_MS - tiempoDesdeUltima);
    }

    try {
        console.log(`🚀 AI Request (New SDK) usando ${MODELO_USADO}...`);
        
        // --- SINTAXIS NUEVA LIBRERÍA (@google/genai) ---
        const response = await ai.models.generateContent({
            model: MODELO_USADO,
            contents: prompt
        });

        lastRequestTime = Date.now();
        
        // Extracción de texto compatible con la nueva versión
        let text = "";
        if (response.text) {
            text = typeof response.text === 'function' ? response.text() : response.text;
        } else {
            text = JSON.stringify(response); 
        }
        
        return text;

    } catch (error) {
        console.error("❌ Error AI:", error.message);
        
        if (error.message.includes('429') || error.message.includes('Quota')) {
            throw new Error("⏳ Cuota agotada (Error 429). Espera 1 minuto.");
        }
        throw error;
    }
}

async function enviarMensajeSeguro(chatId, texto, opciones = {}) {
    try {
        await bot.sendMessage(chatId, texto, { ...opciones, parse_mode: 'Markdown' });
    } catch (error) {
        try {
            await bot.sendMessage(chatId, "⚠️ _Texto plano (Error formato):_\n" + texto, opciones);
        } catch (e) { console.error("Error Telegram:", e.message); }
    }
}

// --- 3. BASE DE DATOS ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Bot V6.7 (Sin Alarma): DB Conectada'))
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

    enviarMensajeSeguro(chatId, `🧠 *Tipster AI V6.7*\n🚫 Alarma Desactivada\n🤖 Modelo: ${MODELO_USADO}`, {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 LaLiga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇮🇹 Serie A', callback_data: 'comp_SA' }, { text: '🇩🇪 Bundesliga', callback_data: 'comp_BL1' }],
                [{ text: '🏆 Champions', callback_data: 'comp_CL' }, { text: '🇫🇷 Ligue 1', callback_data: 'comp_FL1' }],
                [{ text: '⏳ PENDIENTES', callback_data: 'ver_pendientes' }, { text: '💰 BANCA', callback_data: 'ver_banca' }],
                [{ text: '👨‍⚖️ AUDITAR JUEZ', callback_data: 'ver_auditoria' }, { text: '📥 EXPORTAR', callback_data: 'exportar_excel' }]
            ]
        }
    });
});

// --- 5. REPORTES (Solo Manual - Alarma Eliminada) ---
// La función se mantiene por si quieres llamarla con un botón en el futuro,
// pero ya NO SE EJECUTA sola.
async function ejecutarReporteSeguro(chatId) {
    enviarMensajeSeguro(chatId, "☀️ *Analizando mercado...*");
    const ligas = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL'];
    let partidos = [];
    const hoy = new Date().toISOString().split('T')[0];

    try {
        for (const code of ligas) {
            await delay(4000); 
            try {
                const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
                    headers: footballHeaders, params: { dateFrom: hoy, dateTo: hoy }
                });
                if (res.data.matches) partidos = [...partidos, ...res.data.matches];
            } catch (e) { console.log(`Liga ${code} sin datos.`); }
        }

        if (partidos.length === 0) return enviarMensajeSeguro(chatId, "☕ Sin partidos top hoy.");

        const listaTexto = partidos.slice(0, 15).map(m => `• ${m.homeTeam.name} vs ${m.awayTeam.name} (${m.competition.name})`).join("\n");

        const prompt = `Analista Pro. Partidos de hoy:
${listaTexto}

Elige 3 partidos seguros (Value Bets).
Formato:
🏆 *LIGA*
⚔️ Partido
💎 Pick: (Ej: Gana Local)
💡 Razón:
💰 Confianza: (🟢/🟡)`;

        const respuesta = await llamarGeminiSeguro(prompt);
        enviarMensajeSeguro(chatId, `🗞️ *SELECCIÓN DEL DÍA*\n\n${respuesta}`);

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

async function listarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        await delay(1000); 
        const hoy = new Date().toISOString().split('T')[0];
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders, params: { dateFrom: hoy, dateTo: hoy, status: 'SCHEDULED' }
        });

        const matches = res.data.matches || [];
        if (matches.length === 0) return enviarMensajeSeguro(chatId, "⚠️ Liga sin partidos hoy.");

        for (const m of matches.slice(0, 8)) { 
            const h = m.homeTeam.name;
            const a = m.awayTeam.name;
            const d = m.utcDate.split('T')[0];
            const existe = await Prediccion.exists({ partidoId: `${h}-${a}-${d}` });
            
            const btnText = existe ? "✅ Ver Pick" : "🧠 Analizar IA";
            
            await bot.sendMessage(chatId, `🏟️ *${h}* vs *${a}*`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: btnText, callback_data: `analyze|${h}|${a}|${code}|${d}` }]] }
            });
            await delay(400); 
        }
    } catch (e) { enviarMensajeSeguro(chatId, "❌ Error API Fútbol."); }
}

async function procesarAnalisisCompleto(chatId, home, away, code, date) {
    const id = `${home}-${away}-${date}`;
    const cached = await Prediccion.findOne({ partidoId: id });
    
    if (cached) {
        return bot.sendMessage(chatId, `📂 *GUARDADO*\n\n${cached.analisisIA}`, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "🔍 Radar Actualizado", callback_data: `radar|${home}|${away}` }]] }
        });
    }

    bot.sendChatAction(chatId, 'typing');
    enviarMensajeSeguro(chatId, "🧠 *Gemini 2.0 Analizando...*");

    try {
        const racha = await obtenerRacha(code, home, away);
        
        const prompt = `Analista Deportivo.
        Partido: ${home} vs ${away}.
        Historial: ${racha}.

        Genera JSON:
        {"pick":"...","confianza":"🟢/🟡/🔴","stake":20,"analisis":"...","marcador":"...","consejo":"..."}`;

        const rawText = await llamarGeminiSeguro(prompt);
        let datos = extraerDatosDeTexto(rawText); 
        if (!datos.analisis) datos.analisis = "Análisis técnico basado en valor.";

        const msgFinal = `🎯 *PICK:* ${datos.pick}
${datos.confianza} *Confianza:* ${getNombreConfianza(datos.confianza)}
💰 *Stake:* S/. ${datos.stake}
⚽ *Marcador:* ${datos.marcador}

💡 *Análisis:* ${datos.analisis}

🎓 *Coach:* _${datos.consejo}_`;

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

function extraerDatosDeTexto(rawText) {
    let datos = { pick: "Error lectura", confianza: "🟡", stake: 0, analisis: "", marcador: "?", consejo: "" };
    try {
        let jsonClean = typeof rawText === 'string' ? rawText.replace(/```json/g, '').replace(/```/g, '').trim() : "";
        const firstOpen = jsonClean.indexOf('{');
        const lastClose = jsonClean.lastIndexOf('}');
        if (firstOpen !== -1 && lastClose !== -1) {
            jsonClean = jsonClean.substring(firstOpen, lastClose + 1);
            datos = { ...datos, ...JSON.parse(jsonClean) };
        }
    } catch (e) { console.log("JSON Parse Error"); }
    return datos;
}

// --- UTILS ---
async function verPendientes(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' }).sort({ fechaPartido: 1 });
    if (pendientes.length === 0) return enviarMensajeSeguro(chatId, "✅ Nada pendiente.");
    let mensaje = `⏳ *PENDIENTES (${pendientes.length})*\n\n`;
    pendientes.forEach((p, i) => {
        mensaje += `*${i + 1}.* ${p.equipoLocal} vs ${p.equipoVisita}\n🎯 ${p.pickIA}\n-------------------\n`;
    });
    enviarMensajeSeguro(chatId, mensaje);
}

async function consultarRadar(chatId, home, away) {
    enviarMensajeSeguro(chatId, "🔍 *Revisando bajas...*");
    try {
        const prompt = `Responde en 20 palabras: ¿Bajas clave para ${home} vs ${away}?`;
        const resp = await llamarGeminiSeguro(prompt);
        enviarMensajeSeguro(chatId, `🚨 *RADAR:* ${resp}`);
    } catch (e) { enviarMensajeSeguro(chatId, "❌ Radar off."); }
}

async function ejecutarAuditoria(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' });
    if (!pendientes.length) return enviarMensajeSeguro(chatId, "✅ Auditado.");

    enviarMensajeSeguro(chatId, `👨‍⚖️ *Verificando...*`);
    let ganadas = 0, perdidas = 0;

    for (const p of pendientes) {
        try {
            await delay(2000); 
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${p.liga}/matches`, {
                headers: footballHeaders, 
                params: { status: 'FINISHED', dateFrom: p.fechaPartido, dateTo: p.fechaPartido }
            });
            const match = res.data.matches.find(m => m.homeTeam.name === p.equipoLocal && m.awayTeam.name === p.equipoVisita);

            if (match && match.score.fullTime.home !== null) {
                const marcadorReal = `${match.score.fullTime.home}-${match.score.fullTime.away}`;
                const prompt = `Juez. Pick: "${p.pickIA}". Res: ${marcadorReal}. ¿GANADA o PERDIDA? Solo esa palabra.`;
                const veredicto = await llamarGeminiSeguro(prompt);
                const estadoFinal = veredicto.toUpperCase().includes('GAN') ? 'GANADA' : 'PERDIDA';
                
                p.estado = estadoFinal;
                p.resultadoReal = marcadorReal;
                await p.save();
                
                await enviarMensajeSeguro(chatId, `${estadoFinal === 'GANADA'?'✅':'❌'} *${p.equipoLocal} vs ${p.equipoVisita}*\nRes: ${marcadorReal}`);
                if (estadoFinal === 'GANADA') ganadas++; else perdidas++;
            }
        } catch (e) { console.log("Skip audit."); }
    }
    enviarMensajeSeguro(chatId, `📊 *Resultados:* +${ganadas} / -${perdidas}`);
}

async function mostrarBanca(chatId) {
    const historial = await Prediccion.find({ estado: { $ne: 'PENDIENTE' } });
    let saldo = 0;
    historial.forEach(p => {
        if (p.estado === 'GANADA') saldo += (p.montoApostado * 0.80); 
        else saldo -= p.montoApostado;
    });
    enviarMensajeSeguro(chatId, `💰 *BANCA:* S/. ${saldo.toFixed(2)}`);
}

async function exportarCSV(chatId) {
    try {
        const data = await Prediccion.find({});
        let csv = "FECHA,PARTIDO,PICK,RESULTADO,ESTADO\n";
        data.forEach(p => csv += `${p.fechaPartido},${p.equipoLocal} vs ${p.equipoVisita},"${p.pickIA}",${p.resultadoReal},${p.estado}\n`);
        const path = `/tmp/history.csv`;
        fs.writeFileSync(path, csv);
        await bot.sendDocument(chatId, path);
    } catch (e) { enviarMensajeSeguro(chatId, "Error export."); }
}

async function obtenerRacha(code, home, away) {
    try {
        await delay(500);
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders, params: { status: 'FINISHED', limit: 10 } 
        });
        return res.data.matches
            .filter(m => m.homeTeam.name === home || m.awayTeam.name === away)
            .slice(0, 5)
            .map(m => `${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away} ${m.awayTeam.name}`)
            .join(", ");
    } catch { return "Sin racha."; }
}

function getNombreConfianza(simbolo) {
    if (simbolo.includes('🟢')) return "ALTA";
    if (simbolo.includes('🔴')) return "BAJA";
    return "MEDIA";
}

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.end('Bot V6.7 (Sin Alarma) Online'); }).listen(PORT);