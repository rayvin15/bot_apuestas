require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { DateTime } = require('luxon');
const http = require('http');

const TOKEN = process.env.TELEGRAM_TOKEN;
const API_KEY = process.env.FOOTBALL_API_KEY;
const TZ = process.env.TZ || 'America/Lima';

// Evitamos que el error 409 crashee el bot
const bot = new TelegramBot(TOKEN, { polling: { autoStart: true, params: { timeout: 10 } } });

bot.on('polling_error', (err) => {
    if (err.message.includes('409 Conflict')) {
        console.log("⚠️ Conflicto de instancia: Asegúrate de cerrar el bot en tu PC.");
    } else {
        console.error("Polling Error:", err.code);
    }
});

const apiConfig = {
    headers: { 'x-apisports-key': API_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' }
};

bot.onText(/\/start/, (msg) => {
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'league_140' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'league_39' }],
                [{ text: '🌍 Todos los de Hoy', callback_data: 'period_all_today' }]
            ]
        }
    };
    bot.sendMessage(msg.chat.id, "🏆 *Bot de Apuestas*\nSelecciona una opción:", { parse_mode: 'Markdown', ...opts });
});

bot.on('callback_query', async (query) => {
    const data = query.data;
    if (data.startsWith('league_')) {
        const id = data.split('_')[1];
        bot.sendMessage(query.message.chat.id, "📅 ¿Cuándo?", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Hoy', callback_data: `period_${id}_today` }, { text: 'Semana', callback_data: `period_${id}_week` }]
                ]
            }
        });
    } else if (data.startsWith('period_')) {
        const [_, id, time] = data.split('_');
        await mostrarPartidos(query.message.chat.id, id, time);
    } else if (data.startsWith('odds_')) {
        await mostrarCuotas(query.message.chat.id, data.split('_')[1]);
    }
    bot.answerCallbackQuery(query.id);
});

async function mostrarPartidos(chatId, leagueId, period) {
    try {
        const ahora = DateTime.now().setZone(TZ);
        let params = {};
        
        // Si es una liga específica (ej. 140), intentamos ser flexibles con la temporada
        if (leagueId !== 'all') {
            params.league = leagueId;
            params.season = 2025; // Para ligas europeas en Enero 2026 sigue siendo 2025
        }

        if (period === 'today') {
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
            return bot.sendMessage(chatId, "No encontré partidos. Prueba con 'Todos los de Hoy'.");
        }

        // Mostrar máximo 5 para no saturar
        partidos.slice(0, 8).forEach(p => {
            const localDT = DateTime.fromISO(p.fixture.date).setZone(TZ);
            const txt = `⚽ *${p.teams.home.name}* vs *${p.teams.away.name}*\n🏟 ${p.fixture.venue.name || 'Estadio'}\n⏰ ${localDT.toFormat('dd/MM HH:mm')}`;
            bot.sendMessage(chatId, txt, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '📈 Cuotas', callback_data: `odds_${p.fixture.id}` }]] }
            });
        });
    } catch (e) {
        bot.sendMessage(chatId, "Error de conexión. ❌");
    }
}


// 4. Función: Mostrar Cuotas (1X2)
async function mostrarCuotas(chatId, fixtureId) {
    try {
        const res = await axios.get(`https://v3.football.api-sports.io/odds?fixture=${fixtureId}`, apiConfig);
        const data = res.data.response[0];

        if (!data || !data.bookmakers.length) {
            return bot.sendMessage(chatId, "Cuotas no disponibles para este partido. ⏳");
        }

        const bookie = data.bookmakers[0];
        const market = bookie.markets.find(m => m.name === "Match Winner");

        if (market) {
            let msg = `📊 *Cuotas 1X2 (${bookie.name})*\n\n`;
            market.values.forEach(v => {
                const emoji = v.value === 'Home' ? '🏠' : v.value === 'Draw' ? '🤝' : '🚀';
                msg += `${emoji} *${v.value}:* ${v.odd}\n`;
            });
            bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        bot.sendMessage(chatId, "Error al obtener cuotas. ❌");
    }
}

// 5. Servidor HTTP para mantener vivo el bot en Render
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot de Apuestas Online 🤖');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor HTTP escuchando en puerto ${PORT}`);
});

console.log("🤖 Bot iniciado correctamente...");