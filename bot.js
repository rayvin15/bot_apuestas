require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { DateTime } = require('luxon');
const http = require('http');

// CONFIGURACIÓN
const TOKEN = process.env.TELEGRAM_TOKEN;
const API_KEY = process.env.FOOTBALL_API_KEY;
const TZ = process.env.TZ || 'America/Lima';

// Inicialización segura para evitar Error 409 en Render
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

    // 1. Selección de Liga
    if (data.startsWith('league_')) {
        const id = data.split('_')[1];
        bot.sendMessage(chatId, "📅 ¿Cuándo?", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Ver Partidos de Hoy', callback_data: `period_${id}_today` }],
                    [{ text: 'Próximos Partidos', callback_data: `period_${id}_next` }]
                ]
            }
        });
    } 
    // 2. Selección de Periodo
    else if (data.startsWith('period_')) {
        const [_, id, time] = data.split('_');
        await mostrarPartidos(chatId, id, time);
    } 
    // 3. Ver Cuotas
    else if (data.startsWith('odds_')) {
        await mostrarCuotas(chatId, data.split('_')[1]);
    }

    try { await bot.answerCallbackQuery(query.id); } catch(e) {}
});

async function mostrarPartidos(chatId, leagueId, period) {
    try {
        const ahora = DateTime.now().setZone(TZ);
        let params = { 
            timezone: TZ // Pedimos a la API que devuelva horas en nuestra zona (opcional pero ayuda)
        };

        // LÓGICA DE TEMPORADA: Enero 2026 sigue siendo temporada 2025 en Europa
        if (leagueId !== 'all') {
            params.league = leagueId;
            params.season = 2025; 
        }

        // LÓGICA DE FECHAS
        if (period === 'live') {
            params.live = 'all';
            delete params.season; // Para live no solemos necesitar season
        } else if (period === 'today') {
            params.date = ahora.toISODate();
        } else if (period === 'next') {
            params.next = 10; // Trae los próximos 10 partidos sin importar la fecha
        } else {
            // Default: Semana
            params.from = ahora.toISODate();
            params.to = ahora.plus({ days: 5 }).toISODate();
        }

        console.log(`Buscando partidos... Params: ${JSON.stringify(params)}`); // Log para Render

        let res = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
            headers: apiConfig.headers,
            params: params
        });

        let partidos = res.data.response;

        // --- PLAN B: SI NO HAY PARTIDOS HOY EN ESA LIGA ---
        // Si el usuario pidió "Hoy" de una liga específica y está vacío, buscamos los próximos automáticamente
        if ((!partidos || partidos.length === 0) && period === 'today' && leagueId !== 'all') {
            await bot.sendMessage(chatId, "⚠️ No hay partidos programados para hoy en esta liga.\n🔎 Buscando los próximos encuentros...");
            
            // Reintentamos buscando los próximos 5
            params.next = 5;
            delete params.date;
            
            res = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
                headers: apiConfig.headers,
                params: params
            });
            partidos = res.data.response;
        }

        if (!partidos || partidos.length === 0) {
            return bot.sendMessage(chatId, "🚫 No se encontraron partidos recientes ni próximos.");
        }

        // Enviar resultados (Máximo 8)
        const lista = partidos.slice(0, 8);
        for (const p of lista) {
            const localDT = DateTime.fromISO(p.fixture.date).setZone(TZ);
            const status = p.fixture.status.short;
            const goles = ['NS', 'P', 'CANC'].includes(status) ? '' : `[${p.goals.home}-${p.goals.away}]`;
            
            let txt = `🏆 *${p.league.name}* (Jornada ${p.league.round.replace(/\D/g,'')})\n`;
            txt += `⚽ *${p.teams.home.name}* vs *${p.teams.away.name}* ${goles}\n`;
            txt += `📅 ${localDT.toFormat('dd/MM')} | ⏰ ${localDT.toFormat('HH:mm')} (${status})`;

            // Botón de cuotas
            const keyboard = [[{ text: '📊 Ver Cuotas', callback_data: `odds_${p.fixture.id}` }]];
            
            await bot.sendMessage(chatId, txt, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        }

    } catch (e) {
        console.error("Error en mostrarPartidos:", e.message);
        bot.sendMessage(chatId, "❌ Error de conexión con la API.");
    }
}

async function mostrarCuotas(chatId, fixtureId) {
    // Feedback visual
    bot.sendChatAction(chatId, 'typing');

    try {
        console.log(`Consultando cuotas para ID: ${fixtureId}`);
        const res = await axios.get(`https://v3.football.api-sports.io/odds?fixture=${fixtureId}`, apiConfig);
        
        const data = res.data.response?.[0]; // Uso de Optional Chaining para evitar crash

        if (!data || !data.bookmakers || data.bookmakers.length === 0) {
            return bot.sendMessage(chatId, "🔒 Cuotas no disponibles (API Limit o partido no listado).");
        }

        // --- CORRECCIÓN DEL CRASH (undefined reading 'find') ---
        // Buscamos un bookmaker que tenga mercados. Si el 0 no tiene, buscamos cualquiera que tenga.
        const bookie = data.bookmakers.find(b => b.markets && b.markets.length > 0);

        if (!bookie) {
            return bot.sendMessage(chatId, "⚠️ Hay bookmakers, pero sin mercados disponibles.");
        }

        // Buscamos el mercado exacto con proteccion '?'
        const market = bookie.markets?.find(m => m.name === "Match Winner");

        if (!market) {
            return bot.sendMessage(chatId, `📉 Cuotas disponibles en ${bookie.name}, pero no el 1X2.`);
        }

        let msg = `💰 *Cuotas 1X2 (${bookie.name})*\n`;
        market.values.forEach(v => {
            const label = v.value === 'Home' ? '🏠 Local' : v.value === 'Draw' ? '🤝 Empate' : '✈️ Visita';
            msg += `\n${label}: *${v.odd}*`;
        });

        bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });

    } catch (e) {
        console.error("Error mostrando cuotas:", e); // Ver el error real en consola
        bot.sendMessage(chatId, "❌ Ocurrió un error al procesar las cuotas.");
    }
}

// Servidor HTTP para Render
http.createServer((req, res) => { res.writeHead(200); res.end('Bot Online'); }).listen(process.env.PORT || 3000);

// Arranque retardado
console.log("⏳ Iniciando bot en 3 segundos...");
setTimeout(() => {
    bot.startPolling();
    console.log("🚀 Bot escuchando...");
}, 3000);