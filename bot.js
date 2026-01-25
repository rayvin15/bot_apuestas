require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenAI } = require("@google/genai");
const http = require('http');
const mongoose = require('mongoose');

// --- 1. CONFIGURACIÓN ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 MongoDB Atlas Conectado con Aprendizaje'))
    .catch(err => console.error('🔴 Error BD:', err));

// --- 2. MODELO DE DATOS (Mantenemos tu esquema original) ---
const PrediccionSchema = new mongoose.Schema({
    partidoId: { type: String, unique: true },
    equipoLocal: String,
    equipoVisita: String,
    fechaPartido: String,
    analisisIA: String,
    pickIA: String,
    liga: String,
    resultadoReal: { type: String, default: null },
    estado: { type: String, default: 'PENDIENTE' },
    createdAt: { type: Date, default: Date.now }
});
const Prediccion = mongoose.model('Prediccion', PrediccionSchema);

// --- 3. MENÚ PRINCIPAL ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "💰 *Tipster IA Profesional (V2)*\n\n1. Elige liga (Ahora con Córners/Tarjetas).\n2. Auditoría inteligente integrada.", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇮🇹 Serie A', callback_data: 'comp_SA' }, { text: '🇪🇺 Champions', callback_data: 'comp_CL' }],
                [{ text: '🇧🇷 Brasileirao', callback_data: 'comp_BSA' }, { text: '📊 VER RESUMEN DIARIO', callback_data: 'ver_resumen' }]
            ]
        }
    });
});

bot.onText(/\/resumen/, (msg) => verificarResultados(msg.chat.id));

// --- 4. MANEJADOR DE EVENTOS ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data === 'ver_resumen') {
        await verificarResultados(chatId);
    } else if (data.startsWith('comp_')) {
        await listarPartidos(chatId, data.split('_')[1]);
    } else if (data.startsWith('analyze|')) {
        const [_, home, away, code, date] = data.split('|');
        await procesarAnalisis(chatId, home, away, code, date);
    }
    bot.answerCallbackQuery(query.id).catch(() => {});
});

// --- 5. LISTAR PARTIDOS (Tu función original) ---
async function listarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        const hoy = new Date();
        const limite = new Date();
        limite.setDate(hoy.getDate() + 7);
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders,
            params: { dateFrom: hoy.toISOString().split('T')[0], dateTo: limite.toISOString().split('T')[0], status: 'SCHEDULED' }
        });
        const matches = res.data.matches || [];
        if (matches.length === 0) return bot.sendMessage(chatId, "⚠️ No hay partidos esta semana.");

        for (const m of matches.slice(0, 5)) {
            const home = m.homeTeam.name;
            const away = m.awayTeam.name;
            const fecha = m.utcDate.split('T')[0];
            const idPartido = `${home}-${away}-${fecha}`;
            const existe = await Prediccion.exists({ partidoId: idPartido });
            const btnText = existe ? "📂 Ver Apuesta Guardada" : "S/. Calcular Apuesta";

            bot.sendMessage(chatId, `🏟️ *${home}* vs *${away}*\n📅 ${fecha}`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: btnText, callback_data: `analyze|${home.substring(0,18)}|${away.substring(0,18)}|${code}|${fecha}` }]] }
            });
        }
    } catch (e) { bot.sendMessage(chatId, "❌ Error al conectar con la liga."); }
}

// --- 6. IA ANALISTA CON AUTO-CORRECCIÓN (MEJORA C) Y MERCADOS (MEJORA B) ---
async function procesarAnalisis(chatId, home, away, code, date) {
    const idUnico = `${home}-${away}-${date}`;
    const cached = await Prediccion.findOne({ partidoId: idUnico });
    if (cached) return bot.sendMessage(chatId, `📂 *APUESTA GUARDADA:*\n\n${cached.analisisIA}`, { parse_mode: 'Markdown' });

    bot.sendMessage(chatId, `🧠 *IA estudiando racha y mercados de córners/tarjetas...*`);
    bot.sendChatAction(chatId, 'typing');

    // --- MEJORA C: MEMORIA DE ERRORES PASADOS ---
    const historial = await Prediccion.find({ liga: code, estado: { $ne: 'PENDIENTE' } }).sort({ createdAt: -1 }).limit(5);
    const fallos = historial.filter(p => p.estado === 'PERDIDA').length;
    let instruccionAprendizaje = "";
    if (fallos >= 3) {
        instruccionAprendizaje = `⚠️ NOTA DE APRENDIZAJE: Has fallado ${fallos} de los últimos 5 picks en esta liga. Analiza con más cautela las defensas y no arriesgues demasiado.`;
    }

    try {
        const racha = await obtenerRacha(code);
        
        // --- MEJORA B: PROMPT MULTIMERCADO Y RESUMIDO ---
        const prompt = `Actúa como asesor experto. 
        ${instruccionAprendizaje}
        Partido: ${home} vs ${away}. Racha: ${racha}.
        
        Responde breve (Max 80 palabras):
        💎 *PICK:* (Predicción principal)
        🚩 *CÓRNERS/TARJETAS:* (Analiza estos mercados secundarios)
        💰 *INVERSIÓN:* (En S/. Soles para un banco de S/. 1000)
        📊 *RAZÓN:* (1 frase)
        🎯 *MARCADOR:* (Ej: 2-1)
        
        Usa emojis y asteriscos para negritas.`;

        const response = await ai.models.generateContent({ model: "gemini-3-flash-preview", contents: prompt });
        const texto = response.text;

        const nuevaPred = new Prediccion({
            partidoId: idUnico, equipoLocal: home, equipoVisita: away,
            fechaPartido: date, analisisIA: texto, liga: code, pickIA: texto 
        });
        await nuevaPred.save();

        await bot.sendMessage(chatId, `📝 *FICHA DE APUESTA PRO:*\n\n${texto}`, { parse_mode: 'Markdown' });
    } catch (e) { bot.sendMessage(chatId, "❌ Error en IA."); }
}

// --- 7. EL JUEZ: VERIFICACIÓN (Tu función original intacta) ---
async function verificarResultados(chatId) {
    bot.sendMessage(chatId, "🕵️ *Auditando resultados y actualizando aprendizaje...*");
    bot.sendChatAction(chatId, 'typing');
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' });
    if (pendientes.length === 0) return bot.sendMessage(chatId, "✅ No hay apuestas pendientes.");

    let aciertos = 0, fallos = 0, revisados = 0;

    for (const p of pendientes) {
        try {
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${p.liga}/matches`, {
                headers: footballHeaders,
                params: { status: 'FINISHED', dateFrom: p.fechaPartido, dateTo: p.fechaPartido }
            });
            const match = res.data.matches.find(m => 
                (m.homeTeam.name.includes(p.equipoLocal) || p.equipoLocal.includes(m.homeTeam.name)) &&
                (m.awayTeam.name.includes(p.equipoVisita) || p.equipoVisita.includes(m.awayTeam.name))
            );

            if (match && match.status === 'FINISHED') {
                const resultadoFinal = `${match.score.fullTime.home}-${match.score.fullTime.away}`;
                const promptJuez = `Predicción: "${p.pickIA}". Resultado Real: ${match.homeTeam.name} ${resultadoFinal} ${match.awayTeam.name}. ¿Acerté? Responde solo SI o NO.`;
                const veredicto = await ai.models.generateContent({ model: "gemini-3-flash-preview", contents: promptJuez });
                const esAcierto = veredicto.text.trim().toUpperCase().includes("SI");
                
                p.resultadoReal = resultadoFinal;
                p.estado = esAcierto ? 'GANADA' : 'PERDIDA';
                await p.save();
                if (esAcierto) aciertos++; else fallos++;
                revisados++;
            }
        } catch (e) { console.error("Error auditando:", e.message); }
    }
    if (revisados === 0) bot.sendMessage(chatId, "⏳ Aún no terminan los partidos.");
    else bot.sendMessage(chatId, `📊 *REPORTE*\n✅ Ganadas: ${aciertos}\n❌ Perdidas: ${fallos}`);
}

async function obtenerRacha(code) {
    try {
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders, params: { status: 'FINISHED' }
        });
        return res.data.matches.slice(-5).map(m => `${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away}`).join(", ");
    } catch (e) { return "Sin datos."; }
}

http.createServer((req, res) => res.end('Bot Online')).listen(process.env.PORT || 10000);