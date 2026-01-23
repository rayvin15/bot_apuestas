require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { DateTime } = require('luxon');
const http = require('http');

// CONFIGURACIÓN
const TOKEN = process.env.TELEGRAM_TOKEN;
const API_KEY = process.env.FOOTBALL_API_KEY;
const TZ = process.env.TZ || 'America/Lima';

// Inicialización segura para evitar Error 409
const bot = new TelegramBot(TOKEN, { 
    polling: { autoStart: false, params: { timeout: 10 } } 
});

const apiConfig = {
    headers: { 
        'x-apisports-key': API_KEY, 
        'x-rapidapi-host': 'v3.football.api-sports.io' 
    }
};

// --- MENÚ PRINCIPAL ---
bot.onText(/\/start/, (msg) => {
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'league_140' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'league_39' }],
                [{ text: '🔴 En Vivo (Live)', callback_data: 'period_all_live' }, { text: '📅 Todo Hoy', callback_data: 'period_all_today' }]
            ]
        }
    };
    bot.sendMessage(msg.chat.id, "⚽ *Centro de Apuestas*\nSelecciona competición o filtro:", { parse_mode: 'Markdown', ...opts });
});

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data.startsWith('league_')) {
        const id = data.split('_')[1];
        bot.sendMessage(chatId, "📅 ¿Qué deseas ver?", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Ver Partidos de Hoy', callback_data: `period_${id}_today` }],
                    [{ text: 'Próximos Partidos (Calendario)', callback_data: `period_${id}_next` }]
                ]
            }
        });
    } 
    else if (data.startsWith('period_')) {
        const [_, id, time] = data.split('_');
        await mostrarPartidos(chatId, id, time);
    } 
    else if (data.startsWith('odds_')) {
        await mostrarCuotas(chatId, data.split('_')[1]);
    }

    try { await bot.answerCallbackQuery(query.id); } catch(e) {}
});

async function mostrarPartidos(chatId, leagueId, period) {
    try {
        bot.sendChatAction(chatId, 'typing');
        const ahora = DateTime.now().setZone(TZ);
        let params = { timezone: TZ };

        // Configuración de parámetros según la elección
        if (leagueId !== 'all') {
            params.league = leagueId;
            if (period === 'today') {
                params.date = ahora.toISODate();
            } else {
                // Para Premier/La Liga siempre es mejor traer los siguientes 10 si no hay hoy
                params.next = 10;
            }
        } else {
            // Filtro global "Todo Hoy"
            if (period === 'live') params.live = 'all';
            else params.date = ahora.toISODate();
        }

        console.log(`Consultando API: ${JSON.stringify(params)}`);

        let res = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
            headers: apiConfig.headers,
            params: params
        });

        let partidos = res.data.response;

        // REINTENTO AUTOMÁTICO: Si pides hoy y no hay nada, busca los siguientes 5
        if ((!partidos || partidos.length === 0) && leagueId !== 'all') {
            params.next = 5;
            delete params.date;
            delete params.season; 

            res = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
                headers: apiConfig.headers,
                params: params
            });
            partidos = res.data.response;
        }

        if (!partidos || partidos.length === 0) {
            return bot.sendMessage(chatId, "🚫 No hay partidos disponibles en este momento.");
        }

        for (const p of partidos.slice(0, 8)) {
            const localDT = DateTime.fromISO(p.fixture.date).setZone(TZ);
            const status = p.fixture.status.short;
            const marcador = ['NS', 'PST', 'CANC'].includes(status) ? '' : `[${p.goals.home}-${p.goals.away}]`;
            
            let txt = `🏆 *${p.league.name}*\n`;
            txt += `⚽ *${p.teams.home.name}* vs *${p.teams.away.name}* ${marcador}\n`;
            txt += `📅 ${localDT.toFormat('dd/MM')} | ⏰ ${localDT.toFormat('HH:mm')} (${status})`;

            const keyboard = [[{ text: '📊 Ver Cuotas', callback_data: `odds_${p.fixture.id}` }]];
            
            await bot.sendMessage(chatId, txt, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        }

    } catch (e) {
        console.error("Error en partidos:", e.message);
        bot.sendMessage(chatId, "❌ Error al cargar partidos.");
    }
}

async function mostrarCuotas(chatId, fixtureId) {
    bot.sendChatAction(chatId, 'typing');
    try {
        const res = await axios.get(`https://v3.football.api-sports.io/odds?fixture=${fixtureId}`, apiConfig);
        const data = res.data.response?.[0];

        // Blindaje para evitar el error "find of undefined"
        if (!data || !data.bookmakers || data.bookmakers.length === 0) {
            return bot.sendMessage(chatId, "🔒 Cuotas no disponibles para este partido en el plan gratuito.");
        }

        // Buscamos un bookmaker con mercados reales
        const bookie = data.bookmakers.find(b => b.markets && b.markets.length > 0) || data.bookmakers[0];
        const market = bookie.markets?.find(m => m.name === "Match Winner");

        if (!market) {
            return bot.sendMessage(chatId, `📉 No hay mercado 1X2 disponible en ${bookie.name}.`);
        }

        let msg = `💰 *Cuotas 1X2 (${bookie.name})*\n`;
        market.values.forEach(v => {
            const label = v.value === 'Home' ? '🏠 Local' : v.value === 'Draw' ? '🤝 Empate' : '✈️ Visita';
            msg += `\n${label}: *${v.odd}*`;
        });

        bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });

    } catch (e) {
        bot.sendMessage(chatId, "❌ Error al procesar las cuotas.");
    }
}

// Servidor Render
http.createServer((req, res) => { res.end('Bot Online'); }).listen(process.env.PORT || 3000);

// Inicio seguro
setTimeout(() => {
    bot.startPolling();
    console.log("🚀 Bot funcionando correctamente.");
}, 3000);