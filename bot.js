require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const http = require('http');

// CONFIGURACIÓN
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Headers específicos para Football-Data.org
const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };

// --- MENÚ PRINCIPAL ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "🎯 *Analista Predictivo (Ligas Top)*\nElige una competición:", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League', callback_data: 'comp_PL' }],
                [{ text: '🇮🇹 Serie A', callback_data: 'comp_SA' }, { text: '🇩🇪 Bundesliga', callback_data: 'comp_BL1' }]
            ]
        }
    });
});

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data.startsWith('comp_')) {
        const code = data.split('_')[1];
        await buscarPartidos(chatId, code);
    } 
    else if (data.startsWith('analyze|')) {
        const [_, home, away] = data.split('|');
        await generarAnalisisIA(chatId, home, away);
    }
    bot.answerCallbackQuery(query.id).catch(() => {});
});

// --- BUSCAR PARTIDOS ---
async function buscarPartidos(chatId, compCode) {
    bot.sendChatAction(chatId, 'typing');
    try {
        // Obtenemos los partidos de la jornada actual
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${compCode}/matches?status=SCHEDULED`, {
            headers: footballHeaders
        });

        const matches = res.data.matches;

        if (!matches || matches.length === 0) {
            return bot.sendMessage(chatId, "No hay partidos programados próximamente.");
        }

        // Mostramos los primeros 5 de la lista
        for (const m of matches.slice(0, 5)) {
            const home = m.homeTeam.name;
            const away = m.awayTeam.name;
            const date = new Date(m.utcDate).toLocaleString('es-PE', { timeZone: 'America/Lima' });

            const txt = `🏟️ *${home}* vs *${away}*\n📅 ${date}`;
            
            bot.sendMessage(chatId, txt, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🧠 Análisis de Apuestas IA', callback_data: `analyze|${home}|${away}` }
                    ]]
                }
            });
        }
    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, "❌ Error al obtener datos. Verifica tu nueva API Key.");
    }
}

// --- IA TIPSTER ---
async function generarAnalisisIA(chatId, home, away) {
    bot.sendMessage(chatId, `🔮 Analizando ${home} vs ${away}...`);
    try {
        const prompt = `Eres un experto en apuestas deportivas. Analiza el partido ${home} vs ${away}. 
        Dame: 
        1. Porcentajes de probabilidad (Local/Empate/Visita).
        2. Pronóstico de marcador.
        3. Recomendación de apuesta (Stake alto/bajo).
        Responde corto y con emojis.`;

        const result = await model.generateContent(prompt);
        bot.sendMessage(chatId, `📊 *PRONÓSTICO IA:*\n\n${result.response.text()}`, { parse_mode: 'Markdown' });
    } catch (e) {
        bot.sendMessage(chatId, "❌ La IA no pudo responder. Revisa la GEMINI_API_KEY.");
    }
}

http.createServer((req, res) => res.end('Bot Operativo')).listen(process.env.PORT || 3000);