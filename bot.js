require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenAI } = require("@google/genai");
const http = require('http');

// --- 1. CONFIGURACIÓN ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };

// --- 2. MENÚ PRINCIPAL ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "🏆 *Tipster IA v3.0 - Análisis Pro*\nPartidos para los próximos 7 días. Selecciona liga:", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }, { text: '🇪🇺 Champions', callback_data: 'comp_CL' }],
                [{ text: '🇮🇹 Serie A', callback_data: 'comp_SA' }, { text: '🇩🇪 Bundesliga', callback_data: 'comp_BL1' }, { text: '🇫🇷 Ligue 1', callback_data: 'comp_FL1' }],
                [{ text: '🇧🇷 Brasileirao', callback_data: 'comp_BSA' }, { text: '🇳🇱 Eredivisie', callback_data: 'comp_DED' }, { text: '🇵🇹 Primeira', callback_data: 'comp_PPL' }],
                [{ text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Champ.', callback_data: 'comp_ELC' }, { text: '🏆 Euro', callback_data: 'comp_EC' }, { text: '🌍 Mundial', callback_data: 'comp_WC' }]
            ]
        }
    });
});

// --- 3. MANEJADOR DE BOTONES ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data.startsWith('comp_')) {
        await buscarPartidos(chatId, data.split('_')[1]);
    } else if (data.startsWith('analyze|')) {
        const [_, home, away] = data.split('|');
        await generarAnalisisIA(chatId, home, away);
    }
    bot.answerCallbackQuery(query.id).catch(() => {});
});

// --- 4. BUSCAR PARTIDOS (FILTRO 7 DÍAS) ---
async function buscarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        // Cálculo de fechas: Hoy y Hoy + 7 días
        const hoy = new Date();
        const proximaSemana = new Date();
        proximaSemana.setDate(hoy.getDate() + 7);

        const fechaDesde = hoy.toISOString().split('T')[0];
        const fechaHasta = proximaSemana.toISOString().split('T')[0];

        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders,
            params: {
                dateFrom: fechaDesde,
                dateTo: fechaHasta,
                status: 'SCHEDULED'
            }
        });

        const matches = res.data.matches;
        if (!matches || matches.length === 0) {
            return bot.sendMessage(chatId, "⚠️ No hay partidos programados para esta semana.");
        }

        // Limitamos a 6 partidos para que el chat no sea infinito
        for (const m of matches.slice(0, 6)) {
            const home = m.homeTeam.name;
            const away = m.awayTeam.name;
            const fecha = new Date(m.utcDate).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });

            bot.sendMessage(chatId, `📅 *${fecha}*\n🏟️ *${home}* vs *${away}*`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🧠 Análisis de Valor', callback_data: `analyze|${home.substring(0,18)}|${away.substring(0,18)}` }
                    ]]
                }
            });
        }
    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, "❌ Error al conectar con la API de fútbol.");
    }
}

// --- 5. GENERAR PRONÓSTICO IA (REFINADO) ---
async function generarAnalisisIA(chatId, home, away) {
    bot.sendMessage(chatId, `⏳ *Calculando cuotas y datos para ${home} vs ${away}...*`, { parse_mode: 'Markdown' });
    bot.sendChatAction(chatId, 'typing');

    try {
        const prompt = `Actúa como un Tipster Senior con 20 años de experiencia. 
        Analiza el partido: ${home} (Local) vs ${away} (Visitante).
        
        Dame una respuesta estructurada así:
        1. 📈 *Probabilidades:* (Local % - Empate % - Visita %).
        2. 🎯 *Marcador más probable:* (Ej: 2-0).
        3. 💎 *Pick de Valor:* La mejor apuesta (ej: Under 2.5, Handicap +1).
        4. 🛡️ *Confianza:* (Stake 1 al 10).
        5. 📝 *Breve Clave:* (Máximo 10 palabras).

        REGLAS: No uses guiones bajos (_). Responde en español. Sé muy directo. Usa asteriscos para negritas.`;

        const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview", 
            contents: prompt
        });

        const textOut = response.text;

        await bot.sendMessage(chatId, `📊 *INFORME DE INTELIGENCIA*\n\n${textOut}`, { parse_mode: 'Markdown' })
            .catch(async () => {
                // Fallback si el Markdown de la IA viene corrupto
                await bot.sendMessage(chatId, `📊 INFORME DE INTELIGENCIA:\n\n${textOut}`);
            });

    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, "❌ La IA ha fallado al procesar el análisis.");
    }
}

// --- 6. SERVIDOR Y CIERRE ---
const cleanup = () => {
    console.log("Cerrando proceso...");
    bot.stopPolling().then(() => process.exit(0));
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

http.createServer((req, res) => res.end('Tipster Bot Online')).listen(process.env.PORT || 3000);