require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const http = require('http');

// --- CONFIGURACIÓN DE IA (SIN CENSURA) ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
    safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ]
});

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const apiConfig = {
    headers: { 
        'x-apisports-key': process.env.FOOTBALL_API_KEY, 
        'x-rapidapi-host': 'v3.football.api-sports.io' 
    }
};

// --- MENÚ PRINCIPAL ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "🤖 *Tipster IA Activo*\nSelecciona qué buscar:", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'league_140' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'league_39' }],
                [{ text: '🔴 EN VIVO AHORA', callback_data: 'live_now' }]
            ]
        }
    });
});

// --- MANEJADOR DE CLICS ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data.startsWith('league_')) {
        await buscarPartidos(chatId, { league: data.split('_')[1], next: 5 });
    } 
    else if (data === 'live_now') {
        await buscarPartidos(chatId, { live: 'all' });
    } 
    else if (data.startsWith('analyze|')) {
        const parts = data.split('|');
        // analyze|Home|Away
        await generarAnalisisApuestas(chatId, parts[1], parts[2]);
    }
    
    try { await bot.answerCallbackQuery(query.id); } catch(e) {}
});

async function buscarPartidos(chatId, params) {
    bot.sendChatAction(chatId, 'typing');
    try {
        const res = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
            headers: apiConfig.headers,
            params: params
        });
        
        const partidos = res.data.response;

        if (!partidos || partidos.length === 0) {
            return bot.sendMessage(chatId, "⚠️ No encontré partidos disponibles con ese filtro.");
        }

        // Enviamos los primeros 5
        for (const p of partidos.slice(0, 5)) {
            const home = p.teams.home.name;
            const away = p.teams.away.name;
            const status = p.fixture.status.short;
            const score = p.goals.home !== null ? `(${p.goals.home}-${p.goals.away})` : '';

            // Limpiamos nombres para evitar errores en el botón
            const safeHome = home.replace(/[|]/g, ''); 
            const safeAway = away.replace(/[|]/g, '');

            const txt = `🏆 *${p.league.name}*\n⚽ *${home}* vs *${away}* ${score}\n⏱️ Estado: ${status}`;
            
            bot.sendMessage(chatId, txt, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🧠 Predecir con IA', callback_data: `analyze|${safeHome}|${safeAway}` }
                    ]]
                }
            });
        }
    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, "❌ Error al conectar con API Fútbol (Revisa tu API Key).");
    }
}

async function generarAnalisisApuestas(chatId, home, away) {
    bot.sendMessage(chatId, `🔮 *Consultando a la IA sobre ${home} vs ${away}...*`, { parse_mode: 'Markdown' });
    bot.sendChatAction(chatId, 'typing');
    
    try {
        const prompt = `Eres un experto analista deportivo. 
        Analiza el partido de fútbol: ${home} (Local) vs ${away} (Visitante).
        Dame un pronóstico breve para apostar.
        
        Formato de respuesta:
        1. 📊 Probabilidad de victoria (Ej: Local 40%, Empate 30%, Visita 30%)
        2. 💎 La Apuesta recomendada.
        3. 🎯 Marcador exacto probable.
        
        Sé directo y usa emojis.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });

    } catch (e) {
        console.error("Error Gemini:", e);
        // AQUÍ ESTÁ LA CLAVE: Le enviamos el error real al usuario
        let errorMsg = e.message || JSON.stringify(e);
        if (errorMsg.includes("API key not valid")) errorMsg = "La API Key de Google Gemini es inválida o falta en Render.";
        if (errorMsg.includes("SAFETY")) errorMsg = "La IA bloqueó la respuesta por seguridad (tema apuestas).";
        
        bot.sendMessage(chatId, `❌ Error técnico de la IA:\n\`${errorMsg}\``, { parse_mode: 'Markdown' });
    }
}

http.createServer((req, res) => res.end('Bot OK')).listen(process.env.PORT || 3000);