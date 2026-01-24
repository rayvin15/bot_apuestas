require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const http = require('http');

// Configuración
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const apiConfig = {
    headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' }
};

// --- MENÚ ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "⚽ *IA Predictora Activa*\nElige una liga para analizar:", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'league_140' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'league_39' }],
                [{ text: '🔴 En Vivo', callback_data: 'period_all_live' }]
            ]
        }
    });
});

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data.startsWith('league_')) {
        await buscarPartidos(chatId, data.split('_')[1]);
    } else if (data.startsWith('analyze_')) {
        const info = data.split('_'); // analyze_TeamA_vs_TeamB
        await generarAnalisisIA(chatId, info[1], info[2]);
    }
    bot.answerCallbackQuery(query.id);
});

async function buscarPartidos(chatId, leagueId) {
    try {
        // Buscamos los próximos 5 partidos
        const res = await axios.get(`https://v3.football.api-sports.io/fixtures?league=${leagueId}&next=5`, apiConfig);
        const partidos = res.data.response;

        if (!partidos || partidos.length === 0) {
            return bot.sendMessage(chatId, "No hay partidos cercanos.");
        }

        for (const p of partidos) {
            const home = p.teams.home.name;
            const away = p.teams.away.name;
            const txt = `🏟️ *${home}* vs *${away}*\n🏆 ${p.league.name}`;
            
            bot.sendMessage(chatId, txt, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🧠 Análisis IA', callback_data: `analyze_${home}_${away}` }
                    ]]
                }
            });
        }
    } catch (e) {
        bot.sendMessage(chatId, "Error al obtener partidos.");
    }
}

async function generarAnalisisIA(chatId, home, away) {
    bot.sendMessage(chatId, `⏳ Analizando estadísticas para ${home} vs ${away}...`);
    
    try {
        const prompt = `Actúa como un analista experto en apuestas deportivas. 
        Analiza el próximo partido entre ${home} (Local) y ${away} (Visitante). 
        Dime:
        1. Quién tiene más probabilidades de ganar y por qué.
        2. Un pronóstico de marcador exacto probable.
        3. Una sugerencia de apuesta (ej. Ambos anotan, +2.5 goles, etc.).
        Sé breve, usa emojis y responde en español.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        bot.sendMessage(chatId, `📊 *ANÁLISIS DE LA IA*\n\n${text}`, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, "❌ La IA no pudo procesar el análisis en este momento.");
    }
}

http.createServer((req, res) => res.end('Bot Online')).listen(process.env.PORT || 3000);