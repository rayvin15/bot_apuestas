require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenAI } = require("@google/genai");
const http = require('http');
const mongoose = require('mongoose');
const cron = require('node-cron');
const fs = require('fs');

// --- 1. CONFIGURACIÓN ---
const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Bot Tipster V3.3: Ligas Europeas y Persistencia OK'))
    .catch(err => console.error('🔴 Error BD:', err));

// --- 2. MODELOS DE DATOS ---
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
    montoApostado: { type: Number, default: 0 },
    confianza: { type: String, default: '🟡' },
    createdAt: { type: Date, default: Date.now }
});
const Prediccion = mongoose.model('Prediccion', PrediccionSchema);

const ConfigSchema = new mongoose.Schema({ key: String, value: String });
const Config = mongoose.model('Config', ConfigSchema);

// --- 3. MENÚ PRINCIPAL (Ligas Actualizadas) ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await Config.findOneAndUpdate({ key: 'adminChatId' }, { value: chatId }, { upsert: true });

    bot.sendMessage(chatId, "🏆 *Tipster IA V3.3 - Elite*\nLigas: Premier, LaLiga, Serie A, Bundesliga, Ligue 1 y Champions.", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇮🇹 Serie A', callback_data: 'comp_SA' }, { text: '🇩🇪 Bundesliga', callback_data: 'comp_BL1' }],
                [{ text: '🇫🇷 Ligue 1', callback_data: 'comp_FL1' }, { text: '🏆 Champions', callback_data: 'comp_CL' }],
                [{ text: '📊 AUDITAR', callback_data: 'ver_resumen' }, { text: '💰 MI BANCO', callback_data: 'ver_banco' }],
                [{ text: '📥 EXPORTAR', callback_data: 'exportar_excel' }, { text: '🚨 PROBAR ALARMA', callback_data: 'test_alarma' }]
            ]
        }
    });
});

// --- 4. CRON JOB: 6:00 AM PERÚ ---
cron.schedule('0 6 * * *', async () => {
    const config = await Config.findOne({ key: 'adminChatId' });
    if (config) ejecutarReporteMatutino(config.value);
}, { scheduled: true, timezone: "America/Lima" });

async function ejecutarReporteMatutino(chatId) {
    bot.sendMessage(chatId, "⏰ *Generando informe matutino profesional...*");
    const ligas = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL', 'BSA']; 
    let partidosHoy = [];
    const hoy = new Date().toISOString().split('T')[0];
    
    try {
        for (const code of ligas) {
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
                headers: footballHeaders,
                params: { dateFrom: hoy, dateTo: hoy }
            });
            if (res.data.matches && res.data.matches.length > 0) {
                partidosHoy = [...partidosHoy, ...res.data.matches.map(m => ({
                    h: m.homeTeam.name, a: m.awayTeam.name, l: m.competition.name
                }))];
            }
        }

        if (partidosHoy.length === 0) {
            return bot.sendMessage(chatId, "☕ *INFORME MATUTINO*\nNo hay partidos destacados para hoy en las ligas seguidas.");
        }

        const listaPartidos = partidosHoy.map(m => `• ${m.l}: ${m.h} vs ${m.a}`).join("\n");
        const promptDia = `Eres un Tipster Experto. Analiza estos partidos de hoy:\n${listaPartidos}\n\nSelecciona los 2 más probables (La Fija y La Segura). Indica el PICK y por qué. Usa Markdown.`;

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(promptDia);
        const respuestaIA = result.response.text();

        bot.sendMessage(chatId, `🗞️ *INFORME MATUTINO*\n\n${respuestaIA}`, { parse_mode: 'Markdown' });

    } catch (e) {
        bot.sendMessage(chatId, "❌ Error en reporte: " + e.message);
    }
}

// --- 5. MANEJADOR DE CALLBACKS ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data === 'ver_resumen') await verificarResultados(chatId);
    else if (data === 'ver_banco') await mostrarBanco(chatId);
    else if (data === 'exportar_excel') await exportarDatos(chatId);
    else if (data === 'test_alarma') await ejecutarReporteMatutino(chatId);
    else if (data.startsWith('comp_')) await listarPartidos(chatId, data.split('_')[1]);
    else if (data.startsWith('analyze|')) {
        const [_, h, a, code, date] = data.split('|');
        await procesarAnalisis(chatId, h, a, code, date);
    } 
    else if (data.startsWith('lineup|')) {
        const [_, h, a] = data.split('|');
        await chequearAlineaciones(chatId, h, a);
    }
    bot.answerCallbackQuery(query.id).catch(() => {});
});

// --- 6. FUNCIONES DE ANÁLISIS ---

async function listarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        const hoy = new Date().toISOString().split('T')[0];
        const limite = new Date();
        limite.setDate(limite.getDate() + 14);
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders,
            params: { dateFrom: hoy, dateTo: limite.toISOString().split('T')[0], status: 'SCHEDULED' }
        });
        const matches = res.data.matches || [];
        if (matches.length === 0) return bot.sendMessage(chatId, "⚠️ No hay partidos programados.");

        for (const m of matches.slice(0, 5)) {
            const h = m.homeTeam.name, a = m.awayTeam.name, d = m.utcDate.split('T')[0];
            const existe = await Prediccion.exists({ partidoId: `${h}-${a}-${d}` });
            bot.sendMessage(chatId, `🏟️ *${h}* vs *${a}*\n📅 ${d}`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: existe ? "✅ Ver Pick" : "🧠 Analizar", callback_data: `analyze|${h.substring(0,15)}|${a.substring(0,15)}|${code}|${d}` }]] }
            });
        }
    } catch (e) { bot.sendMessage(chatId, "❌ Error API."); }
}

async function procesarAnalisis(chatId, home, away, code, date) {
    const idUnico = `${home}-${away}-${date}`;
    const cached = await Prediccion.findOne({ partidoId: idUnico });
    if (cached) return bot.sendMessage(chatId, `📂 *ANÁLISIS GUARDADO:*\n\n${cached.analisisIA}`, { parse_mode: 'Markdown' });

    bot.sendChatAction(chatId, 'typing');
    try {
        const racha = await obtenerRacha(code);
        const prompt = `Tipster Experto. Analiza ${home} vs ${away} (${code}). Racha: ${racha}. Da nivel (🟢, 🟡, 🔴), PICK, INVERSIÓN S/. y MARCADOR.`;
        
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(prompt);
        const texto = result.response.text();
        
        let confianza = texto.includes('🟢') ? '🟢' : (texto.includes('🔴') ? '🔴' : '🟡');
        const monto = parseInt(texto.match(/S\/\.?\s?(\d+)/)?.[1] || 0);

        const nueva = new Prediccion({
            partidoId: idUnico, equipoLocal: home, equipoVisita: away,
            fechaPartido: date, analisisIA: texto, pickIA: texto, liga: code,
            montoApostado: monto, confianza: confianza
        });
        await nueva.save();
        bot.sendMessage(chatId, `📝 *NUEVO:* ${texto}`, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "🔍 Radar Clave", callback_data: `lineup|${home}|${away}` }]] }
        });
    } catch (e) { bot.sendMessage(chatId, "❌ Error IA."); }
}

async function chequearAlineaciones(chatId, home, away) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(`Jugadores clave para ${home} vs ${away}. Corto.`);
    bot.sendMessage(chatId, `🕵️ *RADAR:* ${result.response.text()}`, { parse_mode: 'Markdown' });
}

async function mostrarBanco(chatId) {
    const todos = await Prediccion.find({ estado: { $ne: 'PENDIENTE' } });
    let g = 0, p = 0, bal = 0;
    todos.forEach(doc => {
        if (doc.estado === 'GANADA') { g++; bal += (doc.montoApostado * 0.80); } 
        else if (doc.estado === 'PERDIDA') { p++; bal -= doc.montoApostado; }
    });
    bot.sendMessage(chatId, `🏦 *BANCO*\n✅ Ganadas: ${g}\n❌ Perdidas: ${p}\n💰 *Neto: S/. ${bal.toFixed(2)}*`, { parse_mode: 'Markdown' });
}

async function exportarDatos(chatId) {
    try {
        const preds = await Prediccion.find({}).sort({ fechaPartido: -1 });
        let csv = "FECHA,PARTIDO,CONF,INVERSION,ESTADO\n";
        preds.forEach(p => { csv += `${p.fechaPartido},"${p.equipoLocal} vs ${p.equipoVisita}",${p.confianza},${p.montoApostado},${p.estado}\n`; });
        fs.writeFileSync('./Reporte.csv', csv);
        await bot.sendDocument(chatId, './Reporte.csv');
        fs.unlinkSync('./Reporte.csv');
    } catch (e) { bot.sendMessage(chatId, "❌ Error exportar."); }
}

async function verificarResultados(chatId) {
    const pends = await Prediccion.find({ estado: 'PENDIENTE' });
    if (pends.length === 0) return bot.sendMessage(chatId, "✅ Todo al día.");
    bot.sendMessage(chatId, "🔎 Verificando marcadores...");
    for (const p of pends) {
        try {
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${p.liga}/matches`, {
                headers: footballHeaders, params: { status: 'FINISHED', dateFrom: p.fechaPartido, dateTo: p.fechaPartido }
            });
            const m = res.data.matches.find(match => match.homeTeam.name.includes(p.equipoLocal) || p.equipoLocal.includes(match.homeTeam.name));
            if (m) {
                const score = `${m.score.fullTime.home}-${m.score.fullTime.away}`;
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                const vered = await model.generateContent(`Pick: "${p.pickIA}". Resultado: ${score}. ¿Gano? SI/NO.`);
                p.estado = vered.response.text().toUpperCase().includes("SI") ? 'GANADA' : 'PERDIDA';
                p.resultadoReal = score;
                await p.save();
            }
        } catch (e) {}
    }
    bot.sendMessage(chatId, "✅ Auditoría lista.");
}

async function obtenerRacha(code) {
    try {
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, { headers: footballHeaders, params: { status: 'FINISHED' } });
        return res.data.matches.slice(-3).map(m => `${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away}`).join(", ");
    } catch (e) { return "Sin racha."; }
}

http.createServer((req, res) => res.end('Bot Online V3.3')).listen(process.env.PORT || 10000);