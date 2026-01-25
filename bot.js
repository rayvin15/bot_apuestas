require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenAI } = require("@google/genai");
const http = require('http');
const mongoose = require('mongoose');
const cron = require('node-cron'); // LIBRERÍA NUEVA PARA HORARIOS

// --- 1. CONFIGURACIÓN ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Variable para guardar tu ID y enviarte la alerta a las 6 AM
let adminChatId = null; 

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 MongoDB Atlas: Sistema Financiero & Cron Activo'))
    .catch(err => console.error('🔴 Error BD:', err));

// --- 2. MODELO DE DATOS ---
const PrediccionSchema = new mongoose.Schema({
    partidoId: { type: String, unique: true },
    equipoLocal: String,
    equipoVisita: String,
    fechaPartido: String,
    analisisIA: String,
    pickIA: String, // El resumen corto para el Juez
    liga: String,
    resultadoReal: { type: String, default: null },
    estado: { type: String, default: 'PENDIENTE' }, // PENDIENTE, GANADA, PERDIDA
    montoApostado: { type: Number, default: 0 }, // Nuevo campo para contabilidad
    createdAt: { type: Date, default: Date.now }
});
const Prediccion = mongoose.model('Prediccion', PrediccionSchema);

// --- 3. MENÚ PRINCIPAL ---
bot.onText(/\/start/, (msg) => {
    adminChatId = msg.chat.id; // Guardamos tu ID para las alertas mañaneras
    bot.sendMessage(msg.chat.id, "🌞 *Bot Configurado*\nTe avisaré a las 06:00 AM hora Perú con las fijas del día.\n\nUsa el menú para operar:", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇮🇹 Serie A', callback_data: 'comp_SA' }, { text: '🏆 Champions', callback_data: 'comp_CL' }],
                [{ text: '📊 AUDITAR RESULTADOS', callback_data: 'ver_resumen' }, { text: '💰 VER MI BANCO', callback_data: 'ver_banco' }]
            ]
        }
    });
});

bot.onText(/\/banco/, (msg) => mostrarBanco(msg.chat.id));
bot.onText(/\/resumen/, (msg) => verificarResultados(msg.chat.id));

// --- 4. CRON JOB: ALARMA 6:00 AM PERÚ ---
// "0 6 * * *" significa: Minuto 0, Hora 6, Cualquier día.
cron.schedule('0 6 * * *', async () => {
    if (!adminChatId) {
        console.log("⚠️ No tengo ChatID para enviar la alerta matutina.");
        return;
    }
    
    console.log("⏰ Ejecutando análisis matutino...");
    await bot.sendMessage(adminChatId, "🌅 *BUENOS DÍAS TIPSTER*\nAnalizando la cartelera de hoy para buscar 'Las Fijas'...");
    
    // Buscamos partidos para HOY en ligas principales
    const ligas = ['PL', 'PD', 'SA', 'BL1']; // Premier, LaLiga, Serie A, Bundesliga
    let partidosHoy = [];
    
    try {
        const hoy = new Date().toISOString().split('T')[0];
        
        for (const code of ligas) {
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
                headers: footballHeaders,
                params: { dateFrom: hoy, dateTo: hoy }
            });
            if (res.data.matches) {
                partidosHoy = [...partidosHoy, ...res.data.matches];
            }
        }

        if (partidosHoy.length === 0) {
            return bot.sendMessage(adminChatId, "☕ Hoy no hay partidos destacados en las grandes ligas. Día de descanso.");
        }

        // Filtramos solo los partidos 'Safe' con IA (Top 3)
        const listaPartidos = partidosHoy.map(m => `${m.homeTeam.name} vs ${m.awayTeam.name} (${m.competition.name})`).join("\n");
        
        const promptDia = `Actúa como Tipster Profesional. Tienes estos partidos para hoy:\n${listaPartidos}\n\nSelecciona SOLO los 2 partidos más seguros (Probabilidad > 80%).
        Formato de respuesta:
        ☀️ *LA FIJA DEL DÍA:* (Partido y Pick)
        🛡️ *LA SEGURA:* (Partido y Pick)
        ⚠️ (Breve razón de por qué son seguros)`;

        const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: promptDia
        });

        bot.sendMessage(adminChatId, `🗞️ *INFORME MATUTINO (06:00 AM)*\n\n${response.text}`, { parse_mode: 'Markdown' });

    } catch (e) {
        console.error("Error Cron:", e);
    }
}, {
    scheduled: true,
    timezone: "America/Lima"
});

// --- 5. MANEJADOR DE EVENTOS ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    adminChatId = chatId; // Refrescamos el ID por si acaso

    if (data === 'ver_resumen') await verificarResultados(chatId);
    else if (data === 'ver_banco') await mostrarBanco(chatId);
    else if (data.startsWith('comp_')) await listarPartidos(chatId, data.split('_')[1]);
    else if (data.startsWith('analyze|')) {
        const [_, home, away, code, date] = data.split('|');
        await procesarAnalisis(chatId, home, away, code, date);
    }
    bot.answerCallbackQuery(query.id).catch(() => {});
});

// --- 6. FUNCIONES PRINCIPALES ---

async function listarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        const hoy = new Date();
        const limite = new Date();
        limite.setDate(hoy.getDate() + 7);
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders,
            params: { dateFrom: hoy.toISOString().split('T')[0], dateTo: limite.toISOString().split('T')[0], status: 'SCHEDULED' }
        });
        
        const matches = res.data.matches || [];
        if (matches.length === 0) return bot.sendMessage(chatId, "⚠️ No hay partidos pronto.");

        for (const m of matches.slice(0, 5)) {
            const home = m.homeTeam.name;
            const away = m.awayTeam.name;
            const fecha = m.utcDate.split('T')[0];
            const idPartido = `${home}-${away}-${fecha}`;
            
            // Botón dinámico
            const existe = await Prediccion.exists({ partidoId: idPartido });
            const btnText = existe ? "✅ Ver Análisis Ya Hecho" : "🧠 Analizar Partido";

            bot.sendMessage(chatId, `🏟️ *${home}* vs *${away}*\n📅 ${fecha}`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: btnText, callback_data: `analyze|${home.substring(0,18)}|${away.substring(0,18)}|${code}|${fecha}` }]] }
            });
        }
    } catch (e) { bot.sendMessage(chatId, "❌ Error API Fútbol."); }
}

async function procesarAnalisis(chatId, home, away, code, date) {
    const idUnico = `${home}-${away}-${date}`;
    const cached = await Prediccion.findOne({ partidoId: idUnico });
    if (cached) return bot.sendMessage(chatId, `📂 *ANÁLISIS GUARDADO:*\n\n${cached.analisisIA}`, { parse_mode: 'Markdown' });

    bot.sendMessage(chatId, `⚡ *Gemini Auditando ${home} vs ${away}...*`);
    bot.sendChatAction(chatId, 'typing');

    // Contexto de Aprendizaje (Opción C)
    const historial = await Prediccion.find({ liga: code, estado: { $ne: 'PENDIENTE' } }).sort({ createdAt: -1 }).limit(5);
    const fallos = historial.filter(p => p.estado === 'PERDIDA').length;
    let consejo = fallos >= 3 ? "⚠️ OJO: Vienes de una mala racha en esta liga. Sé conservador." : "";

    try {
        const racha = await obtenerRacha(code);
        
        const prompt = `Eres un Tipster Experto. 
        ${consejo}
        Partido: ${home} vs ${away}. Contexto: ${racha}.
        
        Genera Ficha Técnica (Max 80 palabras):
        💎 *PICK:* (Predicción Principal)
        🚩 *CÓRNERS:* (Dato clave)
        💰 *INVERSIÓN:* (Sugiere monto en 'S/.' pensando en banco de 1000)
        🎯 *MARCADOR:* (Resultado exacto)
        
        Usa emojis.`;

        const response = await ai.models.generateContent({ model: "gemini-3-flash-preview", contents: prompt });
        const texto = response.text;

        // Extraer monto para contabilidad
        const montoMatch = texto.match(/S\/\.?\s?(\d+)/);
        const monto = montoMatch ? parseInt(montoMatch[1]) : 0;

        const nuevaPred = new Prediccion({
            partidoId: idUnico, equipoLocal: home, equipoVisita: away,
            fechaPartido: date, analisisIA: texto, pickIA: texto, liga: code, montoApostado: monto
        });
        await nuevaPred.save();

        await bot.sendMessage(chatId, `📝 *NUEVO PICK:*\n\n${texto}`, { parse_mode: 'Markdown' });
    } catch (e) { bot.sendMessage(chatId, "❌ Error IA."); }
}

// --- 7. COMANDO /banco (DASHBOARD FINANCIERO) ---
async function mostrarBanco(chatId) {
    const todos = await Prediccion.find({ estado: { $ne: 'PENDIENTE' } });
    
    if (todos.length === 0) return bot.sendMessage(chatId, "📉 Aún no hay apuestas finalizadas para calcular balance.");

    let ganadas = 0, perdidas = 0, solesGanados = 0, solesPerdidos = 0;

    todos.forEach(p => {
        if (p.estado === 'GANADA') {
            ganadas++;
            // Estimamos ganancia neta (Cuota promedio 1.80 aprox -> ganancia 0.80 * apuesta)
            solesGanados += (p.montoApostado * 0.80); 
        } else if (p.estado === 'PERDIDA') {
            perdidas++;
            solesPerdidos += p.montoApostado;
        }
    });

    const balance = solesGanados - solesPerdidos;
    const emoji = balance >= 0 ? "📈" : "📉";
    const color = balance >= 0 ? "VERDE" : "ROJO";

    bot.sendMessage(chatId, 
        `🏦 *ESTADO DE CUENTA*\n\n` +
        `✅ Picks Ganados: ${ganadas}\n` +
        `❌ Picks Perdidos: ${perdidas}\n` +
        `📊 Efectividad: ${((ganadas/todos.length)*100).toFixed(1)}%\n` +
        `-----------------------------\n` +
        `${emoji} *BALANCE NETO: S/. ${balance.toFixed(2)}*\n` +
        `_(Números en ${color})_`, 
        { parse_mode: 'Markdown' }
    );
}

// --- 8. VERIFICACIÓN MEJORADA (EL JUEZ V2) ---
async function verificarResultados(chatId) {
    bot.sendMessage(chatId, "🕵️ *Auditando resultados oficiales...*");
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' });
    
    if (pendientes.length === 0) return bot.sendMessage(chatId, "✅ Todo está al día.");

    let procesados = 0;

    for (const p of pendientes) {
        try {
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${p.liga}/matches`, {
                headers: footballHeaders,
                params: { status: 'FINISHED', dateFrom: p.fechaPartido, dateTo: p.fechaPartido }
            });

            const match = res.data.matches.find(m => 
                (m.homeTeam.name.includes(p.equipoLocal) || p.equipoLocal.includes(m.homeTeam.name)) &&
                (m.awayTeam.name.includes(p.equipoVisita) || p.equipoVisita.includes(m.awayTeam.name))
            );

            if (match && match.status === 'FINISHED') {
                const score = `${match.score.fullTime.home}-${match.score.fullTime.away}`;
                
                // PROMPT DEL JUEZ MEJORADO (Evita errores Real Sociedad)
                const promptJuez = `ACTÚA COMO ÁRBITRO DE APUESTAS.
                
                1. Predicción del Tipster: "${p.pickIA}"
                2. Partido: ${match.homeTeam.name} vs ${match.awayTeam.name}
                3. Resultado FINAL Oficial: ${match.homeTeam.name} ${score} ${match.awayTeam.name}
                
                INSTRUCCIÓN: Compara la predicción con el resultado.
                - Si el Tipster dijo "Gana Local" y el local ganó, responde SI.
                - Si dijo "Más de 2.5 goles" y quedaron 2-1 (3 goles), responde SI.
                - Si falló, responde NO.
                
                Respuesta (SOLO UNA PALABRA: SI o NO):`;

                const veredicto = await ai.models.generateContent({ model: "gemini-3-flash-preview", contents: promptJuez });
                const esAcierto = veredicto.text.trim().toUpperCase().includes("SI");

                p.resultadoReal = score;
                p.estado = esAcierto ? 'GANADA' : 'PERDIDA';
                await p.save();
                procesados++;
            }
        } catch (e) { console.error("Error auditando", e.message); }
    }

    if (procesados > 0) {
        bot.sendMessage(chatId, `✅ Se han auditado ${procesados} partidos. Usa /banco para ver el impacto en tu saldo.`);
    } else {
        bot.sendMessage(chatId, "⏳ Los partidos pendientes aún no han finalizado.");
    }
}

async function obtenerRacha(code) {
    try {
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders, params: { status: 'FINISHED' }
        });
        return res.data.matches.slice(-5).map(m => `${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away}`).join(", ");
    } catch (e) { return "Sin datos."; }
}

http.createServer((req, res) => res.end('Bot Tipster 24/7')).listen(process.env.PORT || 10000);