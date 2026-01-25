require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenAI } = require("@google/genai");
const http = require('http');

// --- 1. CONFIGURACIÓN ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };

// --- NUEVO: SISTEMA DE MEMORIA TEMPORAL (CACHÉ) ---
// Aquí guardaremos los análisis para no repetirlos.
// Formato: { "Real Madrid-Barcelona": "Texto del análisis..." }
const memoriaCache = new Map(); 

// --- 2. MENÚ PRINCIPAL ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "🧠 *Tipster IA - Modo Aprendizaje*\nEl bot recordará los análisis de hoy para responder más rápido.", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇮🇹 Serie A', callback_data: 'comp_SA' }, { text: '🇩🇪 Bundesliga', callback_data: 'comp_BL1' }],
                [{ text: '🏆 Champions', callback_data: 'comp_CL' }, { text: '🗑️ Borrar Memoria', callback_data: 'clean_mem' }]
            ]
        }
    });
});

// --- 3. MANEJADOR DE EVENTOS ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data === 'clean_mem') {
        memoriaCache.clear();
        bot.answerCallbackQuery(query.id, { text: '🧠 Memoria reiniciada' });
    }
    else if (data.startsWith('comp_')) {
        await buscarPartidos(chatId, data.split('_')[1]);
    } 
    else if (data.startsWith('analyze|')) {
        const [_, home, away, code] = data.split('|');
        await generarAnalisisIA(chatId, home, away, code);
    }
    try { await bot.answerCallbackQuery(query.id); } catch(e) {}
});

// --- 4. BUSCAR PARTIDOS ---
async function buscarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        const hoy = new Date();
        const proximaSemana = new Date();
        proximaSemana.setDate(hoy.getDate() + 7);

        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders,
            params: {
                dateFrom: hoy.toISOString().split('T')[0],
                dateTo: proximaSemana.toISOString().split('T')[0],
                status: 'SCHEDULED'
            }
        });

        const matches = res.data.matches;
        if (!matches || matches.length === 0) return bot.sendMessage(chatId, "⚠️ No hay partidos esta semana.");

        for (const m of matches.slice(0, 5)) {
            const home = m.homeTeam.name;
            const away = m.awayTeam.name;
            
            // Verificamos si ya tenemos este análisis en memoria para poner un icono diferente
            const idPartido = `${home}-${away}`;
            const btnText = memoriaCache.has(idPartido) ? '✅ Ver Análisis Guardado' : '🧠 Analizar Nuevo';

            bot.sendMessage(chatId, `🏟️ *${home}* vs *${away}*`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: btnText, callback_data: `analyze|${home.substring(0,18)}|${away.substring(0,18)}|${code}` }
                    ]]
                }
            });
        }
    } catch (e) {
        bot.sendMessage(chatId, "❌ Error API Fútbol.");
    }
}

// --- 5. OBTENER RESULTADOS PASADOS ---
async function obtenerRacha(code) {
    try {
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders,
            params: { status: 'FINISHED' }
        });
        const ultimos = res.data.matches.slice(-8); 
        return ultimos.map(m => `${m.homeTeam.name} (${m.score.fullTime.home}-${m.score.fullTime.away}) ${m.awayTeam.name}`).join(", ");
    } catch (e) { return "Sin datos recientes."; }
}

// --- 6. IA CON MEMORIA (CACHÉ) ---
async function generarAnalisisIA(chatId, home, away, code) {
    const idPartido = `${home}-${away}`;

    // 1. REVISAR MEMORIA: ¿Ya analizamos esto?
    if (memoriaCache.has(idPartido)) {
        console.log(`Recuperando análisis de caché para: ${idPartido}`);
        const analisisGuardado = memoriaCache.get(idPartido);
        return bot.sendMessage(chatId, `📂 *ANÁLISIS GUARDADO (Sin gastar IA):*\n\n${analisisGuardado}`, { parse_mode: 'Markdown' });
    }

    // 2. Si no está en memoria, procedemos a llamar a la IA
    bot.sendMessage(chatId, `⚡ *Generando análisis nuevo para ${home} vs ${away}...*`);
    bot.sendChatAction(chatId, 'typing');
    
    const rachaLiga = await obtenerRacha(code);

    try {
        const prompt = `Eres un Tipster Experto. Analiza ${home} vs ${away}.
        Contexto reciente de la liga: ${rachaLiga}.
        
        Estructura:
        1. 📈 Probabilidades %
        2. 🎯 Marcador Probable
        3. 💎 Pick de Valor
        4. 🛡️ Stake (1-10)

        Sé breve, usa emojis y negritas (*). No uses guiones bajos.`;

        const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview", 
            contents: prompt
        });

        const texto = response.text;

        // 3. GUARDAR EN MEMORIA (APRENDER)
        // Guardamos el resultado para que la próxima vez sea gratis/rápido
        memoriaCache.set(idPartido, texto);

        await bot.sendMessage(chatId, `📊 *NUEVO ANÁLISIS:*\n\n${texto}`, { parse_mode: 'Markdown' })
            .catch(() => bot.sendMessage(chatId, `📊 ANÁLISIS:\n\n${texto}`));

    } catch (e) {
        bot.sendMessage(chatId, "❌ Error al conectar con la IA.");
    }
}

// --- CIERRE Y SERVIDOR ---
const cleanup = () => bot.stopPolling().then(() => process.exit(0));
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
http.createServer((req, res) => res.end('Bot con Memoria Activo')).listen(process.env.PORT || 3000);