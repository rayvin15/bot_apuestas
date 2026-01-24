require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { DateTime } = require('luxon');
const http = require('http');

const TOKEN = process.env.TELEGRAM_TOKEN;
const API_KEY = process.env.FOOTBALL_API_KEY;
const TZ = process.env.TZ || 'America/Lima';

const bot = new TelegramBot(TOKEN, { polling: true });

const apiConfig = {
    headers: { 'x-apisports-key': API_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' }
};

bot.onText(/\/start/, (msg) => {
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'league_140' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'league_39' }],
                [{ text: '🔴 EN VIVO AHORA', callback_data: 'period_all_live' }],
                [{ text: '📅 TODO LO DE HOY', callback_data: 'period_all_today' }]
            ]
        }
    };
    bot.sendMessage(msg.chat.id, "⚽ *SISTEMA DE PARTIDOS*\nSi no hay resultados, intentaré buscarlos sin filtros.", { parse_mode: 'Markdown', ...opts });
});

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data.startsWith('league_')) {
        // Al elegir liga, buscamos directamente los próximos 10 partidos (lo más seguro)
        await mostrarPartidos(chatId, data.split('_')[1], 'next');
    } else if (data.startsWith('period_')) {
        const [_, id, time] = data.split('_');
        await mostrarPartidos(chatId, id, time);
    } else if (data.startsWith('odds_')) {
        await mostrarCuotas(chatId, data.split('_')[1]);
    }
    bot.answerCallbackQuery(query.id).catch(() => {});
});

async function mostrarPartidos(chatId, leagueId, period) {
    try {
        bot.sendChatAction(chatId, 'typing');
        const ahora = DateTime.now().setZone(TZ);
        let params = {};

        // --- LÓGICA SIMPLIFICADA AL MÁXIMO ---
        if (period === 'live') {
            params = { live: 'all' }; // Sin timezone, sin nada.
        } 
        else if (period === 'today') {
            params = { date: ahora.toISODate() };
        } 
        else if (period === 'next') {
            params = { league: leagueId, next: 10 };
            // IMPORTANTE: NO enviamos 'season' ni 'date' aquí
        }

        console.log("Petición a API:", params);

        const res = await axios.get(`https://v3.football.api-sports.io/fixtures`, { 
            headers: apiConfig.headers, 
            params: params 
        });

        const partidos = res.data.response;

        if (!partidos || partidos.length === 0) {
            return bot.sendMessage(chatId, "⚠️ *Sin resultados:* La API no tiene datos para esta búsqueda exacta.");
        }

        for (const p of partidos.slice(0, 8)) {
            // Convertimos la hora manualmente para evitar errores de la API
            const localDT = DateTime.fromISO(p.fixture.date).setZone(TZ);
            const status = p.fixture.status.short;
            const marcador = p.goals.home !== null ? `[${p.goals.home}-${p.goals.away}]` : '';
            
            let txt = `🏆 *${p.league.name}*\n`;
            txt += `⚽ *${p.teams.home.name}* vs *${p.teams.away.name}* ${marcador}\n`;
            txt += `⏰ ${localDT.toFormat('HH:mm')} (${status})`;

            const btns = [[{ text: '📊 Cuotas', callback_data: `odds_${p.fixture.id}` }]];
            await bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
        }
    } catch (e) {
        bot.sendMessage(chatId, "❌ Error de conexión.");
    }
}

async function mostrarCuotas(chatId, fixtureId) {
    try {
        const res = await axios.get(`https://v3.football.api-sports.io/odds?fixture=${fixtureId}`, apiConfig);
        const data = res.data.response?.[0];
        
        if (!data || !data.bookmakers || data.bookmakers.length === 0) {
            return bot.sendMessage(chatId, "🔒 Cuotas no disponibles (Límite Plan Free).");
        }

        const market = data.bookmakers[0].markets?.find(m => m.name === "Match Winner");
        if (!market) return bot.sendMessage(chatId, "📉 No hay mercado 1X2.");

        let msg = `💰 *Cuotas*\n`;
        market.values.forEach(v => msg += `\n${v.value}: *${v.odd}*`);
        bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    } catch (e) {
        bot.sendMessage(chatId, "❌ Error en cuotas.");
    }
}

http.createServer((req, res) => { res.end('OK'); }).listen(process.env.PORT || 3000);