require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenAI } = require("@google/genai");
const http = require('http');
const mongoose = require('mongoose');

// --- 1. CONFIGURACIÓN DE INFRAESTRUCTURA ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };

// Conexión a Memoria Eterna (MongoDB Atlas)
// Asegúrate de poner MONGO_URI en las Variables de Entorno de Render
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Conectado exitosamente a MongoDB Atlas'))
    .catch(err => console.error('🔴 Error crítico al conectar MongoDB:', err));

// --- 2. DEFINICIÓN DEL MODELO (Esquema de Aprendizaje) ---
const PrediccionSchema = new mongoose.Schema({
    partidoId: { type: String, unique: true }, // ID único: Local-Visita-Fecha
    equipoLocal: String,
    equipoVisita: String,
    fechaPartido: String,
    analisisIA: String,
    liga: String,
    acertado: { type: Boolean, default: null }, // Para futuro aprendizaje
    createdAt: { type: Date, default: Date.now }
});
const Prediccion = mongoose.model('Prediccion', PrediccionSchema);

// --- 3. MENÚ DE INICIO ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "🤖 *Tipster Pro con Memoria Eterna*\nLas predicciones se guardan en la base de datos para mejorar cada día.", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇮🇹 Serie A', callback_data: 'comp_SA' }, { text: '🇩🇪 Bundesliga', callback_data: 'comp_BL1' }],
                [{ text: '🇪🇺 Champions', callback_data: 'comp_CL' }, { text: '🇧🇷 Brasileirao', callback_data: 'comp_BSA' }]
            ]
        }
    });
});

// --- 4. MANEJADOR DE EVENTOS ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data.startsWith('comp_')) {
        await listarPartidos(chatId, data.split('_')[1]);
    } else if (data.startsWith('analyze|')) {
        const [_, home, away, code, date] = data.split('|');
        await procesarAnalisis(chatId, home, away, code, date);
    }
    bot.answerCallbackQuery(query.id).catch(() => {});
});

// --- 5. OBTENER PARTIDOS (Próximos 7 días) ---
async function listarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        const hoy = new Date();
        const limite = new Date();
        limite.setDate(hoy.getDate() + 7);

        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders,
            params: {
                dateFrom: hoy.toISOString().split('T')[0],
                dateTo: limite.toISOString().split('T')[0],
                status: 'SCHEDULED'
            }
        });

        const matches = res.data.matches;
        if (!matches || matches.length === 0) return bot.sendMessage(chatId, "⚠️ No hay partidos cerca.");

        for (const m of matches.slice(0, 5)) {
            const home = m.homeTeam.name;
            const away = m.awayTeam.name;
            const fecha = m.utcDate.split('T')[0];
            const idPartido = `${home}-${away}-${fecha}`;

            // Verificamos si ya existe en la nube
            const existeEnBD = await Prediccion.findOne({ partidoId: idPartido });
            const label = existeEnBD ? "📂 Ver Análisis Guardado" : "🧠 Generar Nuevo Análisis";

            bot.sendMessage(chatId, `🏟️ *${home}* vs *${away}*\n📅 ${fecha}`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: label, callback_data: `analyze|${home.substring(0,18)}|${away.substring(0,18)}|${code}|${fecha}` }
                    ]]
                }
            });
        }
    } catch (e) {
        bot.sendMessage(chatId, "❌ Error al obtener datos de la liga.");
    }
}

// --- 6. NÚCLEO: IA + MONGODB ---
async function procesarAnalisis(chatId, home, away, code, date) {
    const idUnico = `${home}-${away}-${date}`;

    try {
        // A. Buscar en MongoDB Atlas
        const cached = await Prediccion.findOne({ partidoId: idUnico });
        if (cached) {
            console.log("Servido desde MongoDB");
            return bot.sendMessage(chatId, `📂 *ANÁLISIS RECUPERADO DE LA NUBE:*\n\n${cached.analisisIA}`, { parse_mode: 'Markdown' });
        }

        // B. Si no está, generar con Gemini 3
        bot.sendMessage(chatId, `⚡ *Consultando con Gemini 3 para ${home} vs ${away}...*`);
        bot.sendChatAction(chatId, 'typing');

        const racha = await obtenerRacha(code);
        const prompt = `Analiza el partido de fútbol ${home} vs ${away}. 
        Contexto reciente de la liga: ${racha}.
        Dame: Probabilidades %, Marcador, Pick de Valor y Nivel de Riesgo.
        REGLAS: Responde en español, usa asteriscos para negritas, nada de guiones bajos.`;

        const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: prompt
        });

        const analisisTexto = response.text;

        // C. GUARDAR EN LA NUBE PARA APRENDER
        const nuevaPred = new Prediccion({
            partidoId: idUnico,
            equipoLocal: home,
            equipoVisita: away,
            fechaPartido: date,
            analisisIA: analisisTexto,
            liga: code
        });
        await nuevaPred.save();

        await bot.sendMessage(chatId, `📊 *NUEVO ANÁLISIS GENERADO:*\n\n${analisisTexto}`, { parse_mode: 'Markdown' })
            .catch(() => bot.sendMessage(chatId, `📊 ANÁLISIS:\n\n${analisisTexto}`));

    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, "❌ Hubo un problema al procesar la predicción.");
    }
}

// Función auxiliar para racha
async function obtenerRacha(code) {
    try {
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders,
            params: { status: 'FINISHED' }
        });
        return res.data.matches.slice(-5).map(m => `${m.homeTeam.name} (${m.score.fullTime.home}-${m.score.fullTime.away}) ${m.awayTeam.name}`).join(", ");
    } catch (e) { return "Sin datos."; }
}

// --- 7. CIERRE SEGURO ---
const cerrar = () => { bot.stopPolling(); mongoose.disconnect(); process.exit(0); };
process.on('SIGINT', cerrar);
process.on('SIGTERM', cerrar);
http.createServer((req, res) => res.end('Bot con MongoDB Atlas Activo')).listen(process.env.PORT || 3000);