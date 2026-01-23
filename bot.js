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

// --- MEJORA: MENÚ PRINCIPAL ---
bot.onText(/\/start/, (msg) => {
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'league_140' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'league_39' }],
                [{ text: '🌍 Partidos en Vivo (Live)', callback_data: 'period_all_live' }],
                [{ text: '📅 Todo lo de Hoy', callback_data: 'period_all_today' }]
            ]
        }
    };
    bot.sendMessage(msg.chat.id, "🏆 *Apuestas Deportivas*\n¿Qué quieres revisar?", { parse_mode: 'Markdown', ...opts });
});

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data.startsWith('league_')) {
        const id = data.split('_')[1];
        bot.sendMessage(chatId, "📅 Selecciona periodo:", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Hoy', callback_data: `period_${id}_today` }, { text: 'Próximos 7 días', callback_data: `period_${id}_week` }]
                ]
            }
        });
    } else if (data.startsWith('period_')) {
        const [_, id, time] = data.split('_');
        await mostrarPartidos(chatId, id, time);
    } else if (data.startsWith('odds_')) {
        await mostrarCuotas(chatId, data.split('_')[1]);
    }
    bot.answerCallbackQuery(query.id);
});

async function mostrarPartidos(chatId, leagueId, period) {
    try {
        const ahora = DateTime.now().setZone(TZ);
        let params = {};
        
        if (leagueId !== 'all') {
            params.league = leagueId;
            params.season = 2025;
        }

        if (period === 'live') {
            params.live = 'all'; // Muestra solo lo que se juega AHORA
        } else if (period === 'today') {
            params.date = ahora.toISODate();
        } else {
            params.from = ahora.toISODate();
            params.to = ahora.plus({ days: 7 }).toISODate();
        }

        const res = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
            headers: apiConfig.headers,
            params: params
        });

        const partidos = res.data.response;

        if (!partidos || partidos.length === 0) {
            return bot.sendMessage(chatId, "No hay partidos disponibles para esta selección. 😴");
        }

        // Ordenar por fecha y limitar a 10
        const lista = partidos.slice(0, 10);

        for (const p of lista) {
            const localDT = DateTime.fromISO(p.fixture.date).setZone(TZ);
            const status = p.fixture.status.short;
            const goles = status !== 'NS' ? `(${p.goals.home} - ${p.goals.away})` : '';
            
            let txt = `⚽ *${p.teams.home.name}* vs *${p.teams.away.name}* ${goles}\n`;
            txt += `🏟 ${p.fixture.venue.name || 'Estadio'}\n`;
            txt += `⏰ ${localDT.toFormat('dd/MM HH:mm')} (${status})`;

            const keyboard = [];
            // Solo mostrar botón de cuotas si el partido NO ha empezado o está en vivo
            if (['NS', '1H', '2H', 'HT'].includes(status)) {
                keyboard.push([{ text: '📈 Ver Cuotas', callback_data: `odds_${p.fixture.id}` }]);
            }

            await bot.sendMessage(chatId, txt, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        }
    } catch (e) {
        bot.sendMessage(chatId, "Error al consultar partidos. ❌");
    }
}

async function mostrarCuotas(chatId, fixtureId) {
    try {
        // API-Football requiere a veces el ID del bookmaker para ser más preciso. Usamos 6 (Bwin) o 8 (Bet365)
        const res = await axios.get(`https://v3.football.api-sports.io/odds?fixture=${fixtureId}`, apiConfig);
        const oddsData = res.data.response[0];

        if (!oddsData || !oddsData.bookmakers || oddsData.bookmakers.length === 0) {
            return bot.sendMessage(chatId, "⚠️ Cuotas no disponibles. Esto sucede en ligas menores o partidos muy cercanos a empezar/finalizados.");
        }

        // Buscamos Bet365 (ID 8) o el primero disponible
        const bookie = oddsData.bookmakers.find(b => b.id === 8) || oddsData.bookmakers[0];
        const market = bookie.markets.find(m => m.name === "Match Winner" || m.name === "Home/Away");

        if (!market) return bot.sendMessage(chatId, "No se encontró el mercado 1X2.");

        let msg = `📊 *Cuotas 1X2 - ${bookie.name}*\n`;
        msg += `━━━━━━━━━━━━━━━\n`;
        market.values.forEach(v => {
            const label = v.value === 'Home' ? '1 (Local)' : v.value === 'Draw' ? 'X (Empate)' : '2 (Visita)';
            msg += `🔹 *${label}:* ${v.odd}\n`;
        });
        
        bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });

    } catch (e) {
        bot.sendMessage(chatId, "Error al obtener cuotas. ❌");
    }
}

// Servidor para Render
http.createServer((req, res) => { res.writeHead(200); res.end('Bot OK'); }).listen(process.env.PORT || 3000);