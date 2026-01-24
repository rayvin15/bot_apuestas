require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenAI } = require("@google/genai"); // Nueva librería
const http = require('http');

// --- 1. CONFIGURACIÓN IA (Sintaxis Gemini 3) ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };

// --- 2. MENÚ DE LIGAS COMPLETO ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "🏆 *Analista Pro v3.0*\nElige una competición para predecir:", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }, { text: '🇮🇹 Serie A', callback_data: 'comp_SA' }],
                [{ text: '🇩🇪 Bundesliga', callback_data: 'comp_BL1' }, { text: '🇫🇷 Ligue 1', callback_data: 'comp_FL1' }, { text: '🇪🇺 Champions', callback_data: 'comp_CL' }],
                [{ text: '🇵🇹 Primeira', callback_data: 'comp_PPL' }, { text: '🇳🇱 Eredivisie', callback_data: 'comp_DED' }, { text: '🇧🇷 Brasileirao', callback_data: 'comp_BSA' }],
                [{ text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Champ.', callback_data: 'comp_ELC' }, { text: '🌍 Mundial', callback_data: 'comp_WC' }, { text: '🏆 Euro', callback_data: 'comp_EC' }]
            ]
        }
    });
});

// --- 3. MANEJADOR DE EVENTOS ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data.startsWith('comp_')) {
        await buscarPartidos(chatId, data.split('_')[1]);
    } else if (data.startsWith('analyze|')) {
        const [_, home, away] = data.split('|');
        await generarAnalisisIA(chatId, home, away);
    }
    bot.answerCallbackQuery(query.id).catch(() => {});
});

// --- 4. FUNCIÓN OBTENER DATOS ---
async function buscarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches?status=SCHEDULED&limit=4`, {
            headers: footballHeaders
        });

        const matches = res.data.matches;
        if (!matches || matches.length === 0) return bot.sendMessage(chatId, "⚠️ No hay partidos próximos.");

        for (const m of matches) {
            const home = m.homeTeam.name;
            const away = m.awayTeam.name;
            bot.sendMessage(chatId, `🏟️ *${home}* vs *${away}*`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🧠 Análisis Gemini 3', callback_data: `analyze|${home.substring(0,15)}|${away.substring(0,15)}` }
                    ]]
                }
            });
        }
    } catch (e) {
        bot.sendMessage(chatId, "❌ Error en la API de Fútbol.");
    }
}

// --- 5. FUNCIÓN IA (Sintaxis Nueva de tu captura) ---
async function generarAnalisisIA(chatId, home, away) {
    bot.sendMessage(chatId, `⏳ *Gemini 3 analizando ${home} vs ${away}...*`, { parse_mode: 'Markdown' });
    
    try {
        // Usando el método y modelo de tu captura de pantalla
        const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview", 
            contents: `Eres un experto en apuestas. Analiza el partido ${home} vs ${away}. 
            Dame Probabilidades %, Apuesta Recomendada y Marcador Probable. Sé breve y usa emojis.`
        });

        bot.sendMessage(chatId, `📊 *PRONÓSTICO IA:*\n\n${response.text}`, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error("Error de IA:", e);
        bot.sendMessage(chatId, "❌ Error: Verifica si instalaste la librería `@google/genai`.");
    }
}

// --- 6. CIERRE SEGURO ---
const cleanup = () => bot.stopPolling().then(() => process.exit(0));
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

http.createServer((req, res) => res.end('Bot OK')).listen(process.env.PORT || 3000);