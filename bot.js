require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenAI } = require("@google/genai");
const http = require('http');
const mongoose = require('mongoose');

// --- 1. CONFIGURACIÓN ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Conexión MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 MongoDB Atlas Conectado'))
    .catch(err => console.error('🔴 Error BD:', err));

// --- 2. MODELO DE DATOS ACTUALIZADO ---
const PrediccionSchema = new mongoose.Schema({
    partidoId: { type: String, unique: true }, // ID: Local-Visita-Fecha
    equipoLocal: String,
    equipoVisita: String,
    fechaPartido: String, // Formato YYYY-MM-DD
    analisisIA: String,   // El texto corto
    pickIA: String,       // El "resumen" de la apuesta para validar (ej: "Local gana")
    liga: String,
    resultadoReal: { type: String, default: null }, // Ej: "2-1"
    estado: { type: String, default: 'PENDIENTE' }, // PENDIENTE, GANADA, PERDIDA
    createdAt: { type: Date, default: Date.now }
});
const Prediccion = mongoose.model('Prediccion', PrediccionSchema);

// --- 3. MENÚ PRINCIPAL ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "💰 *Tipster IA - Gestión de Capital*\n\n1. Elige liga para analizar.\n2. Usa /resumen para ver tus ganancias/pérdidas.", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇮🇹 Serie A', callback_data: 'comp_SA' }, { text: '🇪🇺 Champions', callback_data: 'comp_CL' }],
                [{ text: '🇧🇷 Brasileirao', callback_data: 'comp_BSA' }, { text: '📊 VER RESUMEN DIARIO', callback_data: 'ver_resumen' }]
            ]
        }
    });
});

bot.onText(/\/resumen/, (msg) => verificarResultados(msg.chat.id));

// --- 4. MANEJADOR DE EVENTOS ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data === 'ver_resumen') {
        await verificarResultados(chatId);
    } else if (data.startsWith('comp_')) {
        await listarPartidos(chatId, data.split('_')[1]);
    } else if (data.startsWith('analyze|')) {
        const [_, home, away, code, date] = data.split('|');
        await procesarAnalisis(chatId, home, away, code, date);
    }
    bot.answerCallbackQuery(query.id).catch(() => {});
});

// --- 5. LISTAR PARTIDOS ---
async function listarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        const hoy = new Date();
        const limite = new Date();
        limite.setDate(hoy.getDate() + 7);

        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders,
            params: {
                dateFrom: hoy.toISOString().split('T')[0],
                dateTo: limite.toISOString().split('T')[0],
                status: 'SCHEDULED'
            }
        });

        const matches = res.data.matches || [];
        if (matches.length === 0) return bot.sendMessage(chatId, "⚠️ No hay partidos esta semana.");

        for (const m of matches.slice(0, 5)) {
            const home = m.homeTeam.name;
            const away = m.awayTeam.name;
            const fecha = m.utcDate.split('T')[0];
            const idPartido = `${home}-${away}-${fecha}`;

            const existe = await Prediccion.exists({ partidoId: idPartido });
            const btnText = existe ? "📂 Ver Apuesta Guardada" : "S/. Calcular Apuesta";

            bot.sendMessage(chatId, `🏟️ *${home}* vs *${away}*\n📅 ${fecha}`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: btnText, callback_data: `analyze|${home.substring(0,18)}|${away.substring(0,18)}|${code}|${fecha}` }
                    ]]
                }
            });
        }
    } catch (e) {
        bot.sendMessage(chatId, "❌ Error al conectar con la liga.");
    }
}

// --- 6. IA ANALISTA (Versión Resumida y en Soles) ---
async function procesarAnalisis(chatId, home, away, code, date) {
    const idUnico = `${home}-${away}-${date}`;

    // A. Recuperar de MongoDB
    const cached = await Prediccion.findOne({ partidoId: idUnico });
    if (cached) {
        return bot.sendMessage(chatId, `📂 *APUESTA GUARDADA:*\n\n${cached.analisisIA}`, { parse_mode: 'Markdown' });
    }

    // B. Generar Nuevo
    bot.sendMessage(chatId, `🧠 *Calculando inversión para ${home} vs ${away}...*`);
    bot.sendChatAction(chatId, 'typing');

    try {
        const racha = await obtenerRacha(code);
        
        // PROMPT OPTIMIZADO: Corto, en Soles y directo al grano.
        const prompt = `Actúa como asesor de apuestas deportivas. 
        Partido: ${home} vs ${away}. Racha Liga: ${racha}.
        
        Responde MUY BREVE (Max 60 palabras). Formato obligatorio:
        
        💎 *PICK:* (Tu predicción principal, ej: Gana Local)
        💰 *INVERSIÓN:* (Sugiere monto en S/. Soles pensando en un banco de S/. 1000. Ej: S/. 50)
        📊 *RAZÓN:* (1 frase corta)
        🎯 *MARCADOR:* (Ej: 2-1)
        
        Usa emojis.`;

        const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: prompt
        });

        const texto = response.text;

        // Guardamos en BD
        const nuevaPred = new Prediccion({
            partidoId: idUnico,
            equipoLocal: home,
            equipoVisita: away,
            fechaPartido: date,
            analisisIA: texto,
            liga: code,
            pickIA: texto // Guardamos todo el texto para que el Juez lo lea después
        });
        await nuevaPred.save();

        await bot.sendMessage(chatId, `📝 *FICHA DE APUESTA:*\n\n${texto}`, { parse_mode: 'Markdown' });

    } catch (e) {
        bot.sendMessage(chatId, "❌ Error generando predicción.");
    }
}

// --- 7. EL JUEZ: VERIFICACIÓN DE RESULTADOS ---
async function verificarResultados(chatId) {
    bot.sendMessage(chatId, "🕵️ *Auditando resultados y calculando aciertos...*");
    bot.sendChatAction(chatId, 'typing');

    // 1. Buscamos apuestas PENDIENTES en MongoDB
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' });
    
    if (pendientes.length === 0) {
        return bot.sendMessage(chatId, "✅ No hay apuestas pendientes de revisión.");
    }

    let aciertos = 0;
    let fallos = 0;
    let revisados = 0;

    for (const p of pendientes) {
        try {
            // 2. Consultar API para ver si el partido terminó
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${p.liga}/matches`, {
                headers: footballHeaders,
                params: { status: 'FINISHED', dateFrom: p.fechaPartido, dateTo: p.fechaPartido }
            });

            // Buscar el partido específico en la respuesta de la API
            const match = res.data.matches.find(m => 
                (m.homeTeam.name.includes(p.equipoLocal) || p.equipoLocal.includes(m.homeTeam.name)) &&
                (m.awayTeam.name.includes(p.equipoVisita) || p.equipoVisita.includes(m.awayTeam.name))
            );

            if (match && match.status === 'FINISHED') {
                const resultadoFinal = `${match.score.fullTime.home}-${match.score.fullTime.away}`;
                
                // 3. LA IA JUZGA: ¿Ganamos o perdimos?
                // Le damos a la IA su propia predicción y el resultado real
                const promptJuez = `Tú predijiste: "${p.pickIA}".
                El resultado REAL fue: ${match.homeTeam.name} ${resultadoFinal} ${match.awayTeam.name}.
                
                ¿Acerté la apuesta principal? Responde SOLO con una palabra: "SI" o "NO".`;

                const veredicto = await ai.models.generateContent({
                    model: "gemini-3-flash-preview",
                    contents: promptJuez
                });

                const esAcierto = veredicto.text.trim().toUpperCase().includes("SI");
                
                // 4. Actualizar MongoDB
                p.resultadoReal = resultadoFinal;
                p.estado = esAcierto ? 'GANADA' : 'PERDIDA';
                await p.save();

                if (esAcierto) aciertos++; else fallos++;
                revisados++;
            }
        } catch (e) {
            console.error("Error auditando partido:", e.message);
        }
    }

    if (revisados === 0) {
        bot.sendMessage(chatId, "⏳ Los partidos pendientes aún no han terminado.");
    } else {
        bot.sendMessage(chatId, `📊 *REPORTE DE RENDIMIENTO*\n\n✅ Ganadas: ${aciertos}\n❌ Perdidas: ${fallos}\n\nLos registros han sido actualizados en la base de datos.`);
    }
}

// Auxiliar Racha
async function obtenerRacha(code) {
    try {
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders,
            params: { status: 'FINISHED' }
        });
        return res.data.matches.slice(-5).map(m => `${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away}`).join(", ");
    } catch (e) { return "Sin datos."; }
}

// Servidor
const cleanup = () => { bot.stopPolling(); mongoose.disconnect(); process.exit(0); };
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
http.createServer((req, res) => res.end('Bot Financiero Online')).listen(process.env.PORT || 10000);