require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { DateTime } = require('luxon');
const http = require('http');

// 🔑 CONFIGURACIÓN
const TOKEN = process.env.TELEGRAM_TOKEN;
const API_KEY = process.env.FOOTBALL_API_KEY;
const TZ = process.env.TZ || 'America/Lima'; // Configurable desde Render

const bot = new TelegramBot(TOKEN, { polling: true });

const apiConfig = {
    headers: {
        'x-apisports-key': API_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io'
    }
};

// 1. Menú principal: Selección de Ligas
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
    bot.sendMessage(msg.chat.id, "🏆 *Bot de Apuestas Pro*\nSelecciona una competición:", { parse_mode: 'Markdown', ...opts });
});

// 2. Manejador de clics (Callback Queries)
bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;

    // A. Selección de Liga -> Preguntar Periodo
    if (data.startsWith('league_')) {
        const leagueId = data.split('_')[1];
        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📅 Partidos de Hoy', callback_data: `period_${leagueId}_today` },
                        { text: '🗓️ Próximos 7 días', callback_data: `period_${leagueId}_week` }
                    ]
                ]
            }
        };
        bot.sendMessage(chatId, "⏱️ ¿Qué partidos quieres consultar?", opts);
    }

    // B. Selección de Periodo -> Mostrar Lista
    if (data.startsWith('period_')) {
        const [_, leagueId, period] = data.split('_');
        await mostrarPartidos(chatId, leagueId, period);
    }

    // C. Ver Cuotas
    if (data.startsWith('odds_')) {
        const fixtureId = data.split('_')[1];
        await mostrarCuotas(chatId, fixtureId);
    }
    
    // Cerrar el relojito de carga en Telegram
    bot.answerCallbackQuery(callbackQuery.id);
});

// 3. Función: Mostrar Partidos con Ajuste Horario
async function mostrarPartidos(chatId, leagueId, period) {
    try {
        const ahora = DateTime.now().setZone(TZ);
        let params = { 
            league: leagueId, 
            season: 2025 // Asegúrate que la temporada sea la correcta
        };

        if (period === 'today') {
            params.date = ahora.toISODate();
        } else {
            // CAMBIO: Usamos rango de fechas en lugar de 'next'
            params.from = ahora.toISODate();
            params.to = ahora.plus({ days: 7 }).toISODate();
        }

        const res = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
            headers: apiConfig.headers,
            params: params
        });

        const partidos = res.data.response;

        // Si sigue vacío, probamos sin el filtro de temporada (a veces la API cambia el año)
        if (!partidos || partidos.length === 0) {
            console.log("No se encontraron partidos con params:", params);
            return bot.sendMessage(chatId, "No encontré partidos para estos 7 días. Prueba con otra liga o intenta más tarde. 😴");
        }

        // Construir mensaje con los partidos
        let msg = "📋 *Partidos Disponibles*\n\n";
        const keyboard = [];

        partidos.forEach((partido, index) => {
            const fecha = DateTime.fromISO(partido.fixture.date).setZone(TZ);
            msg += `${index + 1}. ${partido.teams.home.name} vs ${partido.teams.away.name}\n`;
            msg += `   ⏰ ${fecha.toFormat('dd/MM HH:mm')}\n\n`;
            
            keyboard.push([{
                text: `${partido.teams.home.name} vs ${partido.teams.away.name}`,
                callback_data: `odds_${partido.fixture.id}`
            }]);
        });

        const opts = {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: keyboard
            }
        };

        bot.sendMessage(chatId, msg, opts);
    } catch (e) {
        console.error("Error en mostrarPartidos:", e.message);
        bot.sendMessage(chatId, "Error al obtener partidos. ❌");
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