require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { DateTime } = require('luxon');
const http = require('http');

const TOKEN = process.env.TELEGRAM_TOKEN;
const API_KEY = process.env.FOOTBALL_API_KEY;
const TZ = process.env.TZ || 'America/Lima';

// 1. CORRECCIÓN POLLING: 'autoStart: false' para evitar el Error 409 en Render
const bot = new TelegramBot(TOKEN, { 
    polling: { autoStart: false, params: { timeout: 10 } } 
});

const apiConfig = {
    headers: { 'x-apisports-key': API_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' }
};

// --- MENÚ PRINCIPAL ---
bot.onText(/\/start/, (msg) => {
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'league_140' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'league_39' }],
                [{ text: '🗓️ Calendario Hoy', callback_data: 'period_all_today' }, { text: '🔴 En Vivo', callback_data: 'period_all_live' }]
            ]
        }
    };
    bot.sendMessage(msg.chat.id, "⚽ *Centro de Apuestas*\nElige una liga o revisa la agenda del día:", { parse_mode: 'Markdown', ...opts });
});

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data.startsWith('league_')) {
        const id = data.split('_')[1];
        bot.sendMessage(chatId, "📅 ¿Qué fecha?", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Partidos de Hoy', callback_data: `period_${id}_today` }],
                    [{ text: 'Próximos 3 días', callback_data: `period_${id}_week` }]
                ]
            }
        });
    } else if (data.startsWith('period_')) {
        const [_, id, time] = data.split('_');
        await mostrarPartidos(chatId, id, time);
    } else if (data.startsWith('odds_')) {
        await mostrarCuotas(chatId, data.split('_')[1]);
    }
    // Importante: Cerrar el relojito de carga de Telegram
    try { await bot.answerCallbackQuery(query.id); } catch(e) {}
});

async function mostrarPartidos(chatId, leagueId, period) {
    try {
        const ahora = DateTime.now().setZone(TZ);
        let params = {};
        
        // CORRECCIÓN CRÍTICA: No enviamos 'season' si buscamos por fechas.
        // Solo enviamos 'league' si no es una búsqueda global.
        if (leagueId !== 'all') {
            params.league = leagueId;
        }

        // Configuración de fechas
        if (period === 'live') {
            params.live = 'all';
        } else if (period === 'today') {
            params.date = ahora.toISODate(); // YYYY-MM-DD en tu zona horaria
        } else {
            params.from = ahora.toISODate();
            params.to = ahora.plus({ days: 3 }).toISODate(); // Bajé a 3 días para no saturar
        }

        // Si la liga es 'all' y es 'today', forzamos season para ayudar a la API (opcional, pero ayuda a veces)
        // Pero para ligas específicas, mejor quitar season para evitar conflictos de fecha.

        const res = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
            headers: apiConfig.headers,
            params: params
        });

        const partidos = res.data.response;

        if (!partidos || partidos.length === 0) {
            return bot.sendMessage(chatId, "🚫 No encontré partidos programados con esos filtros.");
        }

        // FILTRO LOCAL: Ocultar partidos terminados hace más de 4 horas para limpiar la vista
        const filtrados = partidos.filter(p => {
            if (period === 'live') return true;
            if (p.fixture.status.short === 'FT') {
                const fechaPartido = DateTime.fromISO(p.fixture.date);
                // Si terminó hace más de 4 horas, lo ocultamos
                return fechaPartido > ahora.minus({ hours: 4 });
            }
            return true;
        });

        if (filtrados.length === 0) {
            return bot.sendMessage(chatId, "✅ Todos los partidos de hoy ya terminaron.");
        }

        // Mostrar máximo 8 partidos
        const lista = filtrados.slice(0, 8);

        for (const p of lista) {
            const localDT = DateTime.fromISO(p.fixture.date).setZone(TZ);
            const status = p.fixture.status.short; // NS, 1H, FT
            const isLiveOrComing = ['NS', '1H', '2H', 'HT', 'ET', 'P'].includes(status);
            
            // Marcador solo si ya empezó
            const marcador = status !== 'NS' ? `[${p.goals.home}-${p.goals.away}]` : '';

            let txt = `🏆 *${p.league.name}*\n`;
            txt += `⚔️ *${p.teams.home.name}* vs *${p.teams.away.name}* ${marcador}\n`;
            txt += `⏰ ${localDT.toFormat('HH:mm')} ${TZ.split('/')[1]} (${status})`;

            const keyboard = [];
            // Botón de cuotas habilitado
            if (isLiveOrComing) {
                keyboard.push([{ text: '📊 Ver Cuotas', callback_data: `odds_${p.fixture.id}` }]);
            }

            await bot.sendMessage(chatId, txt, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        }
    } catch (e) {
        console.error(e); // Ver error en logs de Render
        bot.sendMessage(chatId, "⚠️ Error de conexión con la base de datos de fútbol.");
    }
}

async function mostrarCuotas(chatId, fixtureId) {
    bot.sendChatAction(chatId, 'typing'); // Efecto "escribiendo..."
    try {
        const res = await axios.get(`https://v3.football.api-sports.io/odds?fixture=${fixtureId}`, apiConfig);
        
        // Debug para ver en logs de Render si la API devuelve vacío
        if (res.data.results === 0) {
            console.log(`Cuotas vacías para ID ${fixtureId}. Puede ser limitación del Plan Free.`);
            return bot.sendMessage(chatId, "🔒 Cuotas bloqueadas o no disponibles en este momento (Limitación API).");
        }

        const data = res.data.response[0];

        if (!data || !data.bookmakers.length) {
            return bot.sendMessage(chatId, "📉 Las casas de apuestas aún no publican cuotas para este evento.");
        }

        // Intentamos tomar la primera casa disponible
        const bookie = data.bookmakers[0]; 
        const market = bookie.markets.find(m => m.name === "Match Winner");

        if (!market) return bot.sendMessage(chatId, "❌ Mercado 'Ganador del Partido' no encontrado.");

        let msg = `💰 *Cuotas (${bookie.name})*\n`;
        market.values.forEach(v => {
            const label = v.value === 'Home' ? '🏠 Local' : v.value === 'Draw' ? '🤝 Empate' : '✈️ Visita';
            msg += `\n${label}: *${v.odd}*`;
        });
        
        bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });

    } catch (e) {
        console.error("Error cuotas:", e.message);
        bot.sendMessage(chatId, "❌ Error al obtener las cuotas.");
    }
}

// Servidor HTTP para Render
http.createServer((req, res) => { res.writeHead(200); res.end('Bot Running'); }).listen(process.env.PORT || 3000);

// ARRANQUE SEGURO (Evita Error 409)
console.log("⏳ Esperando 3 segundos para limpiar sesiones anteriores...");
setTimeout(() => {
    bot.startPolling();
    console.log("🚀 Bot iniciado correctamente.");
}, 3000);