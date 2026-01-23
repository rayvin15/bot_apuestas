require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// 🔑 CONFIGURACIÓN
const TOKEN = process.env.TELEGRAM_TOKEN;
const API_KEY = process.env.FOOTBALL_API_KEY;

const bot = new TelegramBot(TOKEN, { polling: true });

const apiConfig = {
    headers: {
        'x-apisports-key': API_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io'
    }
};

// 1. Menú principal con selección de ligas
bot.onText(/\/start/, (msg) => {
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🇪🇸 La Liga', callback_data: 'league_140' },
                    { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League', callback_data: 'league_39' }
                ],
                [
                    { text: '🇪🇺 Champions League', callback_data: 'league_2' },
                    { text: '🇦🇷 Liga Profesional', callback_data: 'league_128' }
                ]
            ]
        }
    };
    bot.sendMessage(msg.chat.id, "🏆 *Bienvenido al Bot de Apuestas*\nSelecciona una liga para ver los partidos de hoy:", { parse_mode: 'Markdown', ...opts });
});

// 2. Manejador de clics en los botones (Callback Queries)
bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;

    // Si el usuario eligió una LIGA
    if (data.startsWith('league_')) {
        const leagueId = data.split('_')[1];
        await mostrarPartidos(chatId, leagueId);
    }

    // Si el usuario eligió ver CUOTAS de un partido
    if (data.startsWith('odds_')) {
        const fixtureId = data.split('_')[1];
        await mostrarCuotas(chatId, fixtureId);
    }
});

// 3. Función para mostrar partidos del día
async function mostrarPartidos(chatId, leagueId) {
    try {
        const hoy = new Date().toISOString().split('T')[0];
        const res = await axios.get(`https://v3.football.api-sports.io/fixtures?league=${leagueId}&date=${hoy}&season=2025`, apiConfig);
        const partidos = res.data.response;

        if (partidos.length === 0) {
            return bot.sendMessage(chatId, "No hay partidos para hoy en esta liga. 😴");
        }

        partidos.forEach(p => {
            const txt = `⚽ *${p.teams.home.name}* vs *${p.teams.away.name}*\n⏰ ${p.fixture.date.split('T')[1].substring(0, 5)} UTC`;
            const opts = {
                reply_markup: {
                    inline_keyboard: [[{ text: '📈 Ver Cuotas', callback_data: `odds_${p.fixture.id}` }]]
                },
                parse_mode: 'Markdown'
            };
            bot.sendMessage(chatId, txt, opts);
        });
    } catch (e) {
        bot.sendMessage(chatId, "Error al buscar partidos. ❌");
    }
}

// 4. Función para mostrar cuotas (1X2)
async function mostrarCuotas(chatId, fixtureId) {
    try {
        const res = await axios.get(`https://v3.football.api-sports.io/odds?fixture=${fixtureId}`, apiConfig);
        const data = res.data.response[0];

        if (!data || !data.bookmakers.length) {
            return bot.sendMessage(chatId, "Cuotas no disponibles para este partido todavía. ⏳");
        }

        // Buscamos el mercado "Match Winner" (1X2) en el primer bookmaker
        const bookmaker = data.bookmakers[0];
        const market = bookmaker.markets.find(m => m.name === "Match Winner");
        
        if (market) {
            let msg = `📊 *Cuotas (1X2) - ${bookmaker.name}*\n\n`;
            market.values.forEach(v => {
                msg += `🔹 *${v.value}:* ${v.odd}\n`;
            });
            bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        bot.sendMessage(chatId, "Error al obtener cuotas. ❌");
    }
}