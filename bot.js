require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { DateTime } = require('luxon');
const http = require('http');

const TOKEN = process.env.TELEGRAM_TOKEN;
const API_KEY = process.env.FOOTBALL_API_KEY;
const TZ = process.env.TZ || 'America/Lima';

const bot = new TelegramBot(TOKEN, { polling: { autoStart: true, params: { timeout: 10 } } });

const apiConfig = {
    headers: { 'x-apisports-key': API_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' }
};

bot.onText(/\/start/, (msg) => {
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'league_140' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'league_39' }],
                [{ text: '🗓️ Todo Hoy', callback_data: 'period_all_today' }, { text: '🔴 En Vivo', callback_data: 'period_all_live' }]
            ]
        }
    };
    bot.sendMessage(msg.chat.id, "⚽ *Bot de Apuestas*\nSelecciona una opción:", { parse_mode: 'Markdown', ...opts });
});

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data.startsWith('league_')) {
        const id = data.split('_')[1];
        await mostrarPartidos(chatId, id, 'next'); // Por defecto traemos lo que viene
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
        
        // --- INTENTO 1: Búsqueda Estándar ---
        let params = { 
            league: leagueId === 'all' ? undefined : leagueId,
            season: leagueId === 'all' ? undefined : 2025,
            date: period === 'today' || leagueId === 'all' ? ahora.toISODate() : undefined,
            next: (period === 'next' && leagueId !== 'all') ? 10 : undefined,
            live: period === 'live' ? 'all' : undefined
        };

        // Limpiar parámetros undefined
        Object.keys(params).forEach(key => params[key] === undefined && delete params[key]);

        let res = await axios.get(`https://v3.football.api-sports.io/fixtures`, { 
            headers: apiConfig.headers, 
            params: params 
        });

        let partidos = res.data.response;

        // --- INTENTO 2: PLAN DE RESCATE (Si el 1 falló) ---
        if ((!partidos || partidos.length === 0) && leagueId !== 'all') {
            console.log("Reintentando búsqueda global de liga...");
            // Quitamos fecha y temporada, solo pedimos los próximos 10
            res = await axios.get(`https://v3.football.api-sports.io/fixtures`, { 
                headers: apiConfig.headers, 
                params: { league: leagueId, next: 10 } 
            });
            partidos = res.data.response;
        }

        if (!partidos || partidos.length === 0) {
            return bot.sendMessage(chatId, "❌ La API gratuita no devuelve datos para esta liga en este momento. Prueba con '🔴 En Vivo' para ver qué hay disponible ahora.");
        }

        // Enviar mensajes
        for (const p of partidos.slice(0, 6)) {
            const localDT = DateTime.fromISO(p.fixture.date).setZone(TZ);
            const status = p.fixture.status.short;
            
            let txt = `🏆 *${p.league.name}*\n⚽ *${p.teams.home.name}* vs *${p.teams.away.name}*\n📅 ${localDT.toFormat('dd/MM HH:mm')} (${status})`;

            const btns = [[{ text: '📈 Ver Cuotas', callback_data: `odds_${p.fixture.id}` }]];
            await bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
        }
    } catch (e) {
        bot.sendMessage(chatId, "❌ Error de conexión.");
    }
}

async function mostrarCuotas(chatId, fixtureId) {
    try {
        bot.sendChatAction(chatId, 'typing');
        const res = await axios.get(`https://v3.football.api-sports.io/odds?fixture=${fixtureId}`, apiConfig);
        
        // Diagnóstico de respuesta vacía
        if (!res.data.response || res.data.response.length === 0) {
            return bot.sendMessage(chatId, "🔒 *Cuotas restringidas:* Tu plan de API no permite ver cuotas para este partido o liga.", { parse_mode: 'Markdown' });
        }

        const data = res.data.response[0];
        const bookie = data.bookmakers?.[0];
        const market = bookie?.markets?.find(m => m.name === "Match Winner");

        if (!market) {
            return bot.sendMessage(chatId, "📉 No hay cuotas de 'Ganador' para este evento.");
        }

        let msg = `💰 *Cuotas (${bookie.name})*\n`;
        market.values.forEach(v => {
            msg += `\n${v.value === 'Home' ? '1' : v.value === 'Draw' ? 'X' : '2'}: *${v.odd}*`;
        });

        bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    } catch (e) {
        bot.sendMessage(chatId, "❌ Error al consultar cuotas.");
    }
}

http.createServer((req, res) => { res.end('Bot OK'); }).listen(process.env.PORT || 3000);