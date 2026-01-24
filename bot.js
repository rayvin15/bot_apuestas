require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const http = require('http');

// 1. Verificación de Keys (Log en consola de Render)
if (!process.env.GEMINI_API_KEY) console.log("⚠️ FALTA GEMINI_API_KEY");
if (!process.env.FOOTBALL_API_KEY) console.log("⚠️ FALTA FOOTBALL_API_KEY");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "🎯 *Analista Predictivo Activo*\nElige una liga:", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇪🇺 Champions League', callback_data: 'comp_CL' }]
            ]
        }
    });
});

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data.startsWith('comp_')) {
        await buscarPartidos(chatId, data.split('_')[1]);
    } 
    else if (data.startsWith('analyze|')) {
        const [_, home, away] = data.split('|');
        await generarAnalisisIA(chatId, home, away);
    }
    bot.answerCallbackQuery(query.id).catch(() => {});
});

async function buscarPartidos(chatId, compCode) {
    bot.sendChatAction(chatId, 'typing');
    try {
        // Obtenemos los próximos 5 partidos programados
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${compCode}/matches?status=SCHEDULED&limit=5`, {
            headers: footballHeaders
        });

        const matches = res.data.matches;
        if (!matches || matches.length === 0) return bot.sendMessage(chatId, "No hay partidos próximos.");

        for (const m of matches) {
            const home = m.homeTeam.name;
            const away = m.awayTeam.name;
            
            // Acortamos nombres para el botón (Límite 64 chars)
            const safeHome = home.substring(0, 15);
            const safeAway = away.substring(0, 15);

            bot.sendMessage(chatId, `🏟️ *${home}* vs *${away}*`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🧠 Análisis de Apuestas', callback_data: `analyze|${safeHome}|${safeAway}` }
                    ]]
                }
            });
        }
    } catch (e) {
        bot.sendMessage(chatId, "❌ Error en Football-Data. Revisa tu Key.");
    }
}

async function generarAnalisisIA(chatId, home, away) {
    bot.sendMessage(chatId, `🔮 Analizando ${home} vs ${away}...`);
    bot.sendChatAction(chatId, 'typing');

    try {
        const prompt = `Eres un experto analista deportivo. Analiza el partido ${home} vs ${away}. 
        Dame: Probabilidades 1X2, marcador probable y una sugerencia de apuesta. 
        Responde en español, muy breve y con emojis.`;

        // Lógica corregida para Gemini 1.5
        const result = await model.generateContent(text = prompt);
        const response = result.response;
        const textOut = response.text();

        bot.sendMessage(chatId, `📊 *PRONÓSTICO IA:*\n\n${textOut}`, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error(e);
        // Diagnóstico detallado para el usuario
        let errorDetalle = e.message;
        if (errorDetalle.includes("API key not valid")) errorDetalle = "Tu GEMINI_API_KEY no es válida.";
        
        bot.sendMessage(chatId, `❌ *La IA falló:* \n\`${errorDetalle}\``, { parse_mode: 'Markdown' });
    }
}

http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);