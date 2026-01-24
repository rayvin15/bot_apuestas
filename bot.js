require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const http = require('http');

// Configuración de Servicios
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const apiConfig = {
    headers: { 
        'x-apisports-key': process.env.FOOTBALL_API_KEY, 
        'x-rapidapi-host': 'v3.football.api-sports.io' 
    }
};

// --- MENÚ PRINCIPAL ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "💰 *Analista de Apuestas IA*\nSelecciona mercado:", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'league_140' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'league_39' }],
                [{ text: '🔴 EN VIVO (Mundial)', callback_data: 'live_now' }]
            ]
        }
    });
});

// --- MANEJADOR DE CLICS ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    // 1. Lógica para Ligas Específicas
    if (data.startsWith('league_')) {
        await buscarPartidos(chatId, { league: data.split('_')[1], next: 5 });
    } 
    // 2. Lógica para EN VIVO (Aquí estaba el error antes)
    else if (data === 'live_now') {
        await buscarPartidos(chatId, { live: 'all' });
    } 
    // 3. Lógica para ANÁLISIS IA
    else if (data.startsWith('analyze|')) {
        // Usamos '|' como separador para evitar errores con espacios en nombres
        const parts = data.split('|'); // analyze|Local|Visita
        const home = parts[1];
        const away = parts[2];
        await generarAnalisisApuestas(chatId, home, away);
    }
    
    // Evita que el botón se quede "cargando"
    try { await bot.answerCallbackQuery(query.id); } catch(e) {}
});

// --- FUNCIÓN BUSCAR PARTIDOS (Flexible) ---
async function buscarPartidos(chatId, params) {
    bot.sendChatAction(chatId, 'typing');
    try {
        const res = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
            headers: apiConfig.headers,
            params: params
        });
        
        const partidos = res.data.response;

        if (!partidos || partidos.length === 0) {
            return bot.sendMessage(chatId, "⚠️ No se encontraron partidos con este filtro ahora mismo.");
        }

        // Mostramos máximo 6 para no saturar
        for (const p of partidos.slice(0, 6)) {
            const home = p.teams.home.name;
            const away = p.teams.away.name;
            const status = p.fixture.status.short; // 1H, 2H, NS (Not Started)
            const score = p.goals.home !== null ? `(${p.goals.home}-${p.goals.away})` : '';

            const txt = `🏆 *${p.league.name}*\n⚽ *${home}* vs *${away}* ${score}\n⏱️ Estado: ${status}`;
            
            // Limitamos el tamaño del nombre para que quepa en el botón de Telegram (max 64 bytes data)
            const safeHome = home.substring(0, 15); 
            const safeAway = away.substring(0, 15);

            bot.sendMessage(chatId, txt, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        // Enviamos los datos separados por |
                        { text: '🧠 Predecir Apuesta', callback_data: `analyze|${safeHome}|${safeAway}` }
                    ]]
                }
            });
        }
    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, "❌ Error obteniendo datos (Posible API Limit o Suspensión).");
    }
}

// --- IA TIPSTER PRO ---
async function generarAnalisisApuestas(chatId, home, away) {
    bot.sendMessage(chatId, `🧠 *La IA está analizando ${home} vs ${away}...*`, { parse_mode: 'Markdown' });
    bot.sendChatAction(chatId, 'typing');
    
    try {
        // PROMPT DE INGENIERÍA PARA APUESTAS
        const prompt = `Actúa como un Tipster Profesional de Apuestas Deportivas (Handicapper).
        Analiza el partido de fútbol: ${home} (Local) vs ${away} (Visitante).
        
        Basándote en su historia, jerarquía y estilos de juego, genera un reporte breve en este formato exacto:

        📊 *PROBABILIDADES:*
        • ${home}: XX%
        • Empate: XX%
        • ${away}: XX%

        💎 *LA APUESTA SEGURA:*
        (Elige una opción de bajo riesgo: Doble Oportunidad, +1.5 Goles, etc.)

        🚀 *LA APUESTA DE VALOR:*
        (Una opción más arriesgada pero probable: Ganador directo, Ambos Marcan, +2.5 Goles)

        🎯 *MARCADOR EXACTO PROBABLE:*
        (Ej: 2-1)

        📝 *RAZÓN:*
        (Una frase corta de por qué).

        Usa emojis. Responde en Español.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error("Error IA:", e);
        bot.sendMessage(chatId, "❌ La IA está saturada o no pudo procesar la solicitud.");
    }
}

// Servidor para Render
http.createServer((req, res) => res.end('Bot Betting AI Online')).listen(process.env.PORT || 3000);