require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenAI } = require("@google/genai");
const http = require('http');
const mongoose = require('mongoose');
const cron = require('node-cron');
const fs = require('fs');

// --- 1. CONFIGURACIÓN ---

// NOTA: Usamos 'gemini-2.0-flash-exp' o 'gemini-1.5-flash' ya que la versión 3 aún no es pública
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Control de rate limiting (evitar exceder 5 RPM y 20 RPD en versión free)
let requestCount = { minute: 0, day: 0, lastMinuteReset: Date.now(), lastDayReset: Date.now() };

async function llamarGeminiConLimite(prompt) {
    // Resetear contadores si pasó el tiempo
    const ahora = Date.now();
    if (ahora - requestCount.lastMinuteReset > 60000) {
        requestCount.minute = 0;
        requestCount.lastMinuteReset = ahora;
    }
    if (ahora - requestCount.lastDayReset > 86400000) {
        requestCount.day = 0;
        requestCount.lastDayReset = ahora;
    }

    // Verificar límites
    if (requestCount.minute >= 4) {
        throw new Error("⏳ Límite de 5 RPM alcanzado. Espera 1 minuto.");
    }
    if (requestCount.day >= 45) { // Subido un poco asumiendo que Google da 50 al día en algunas cuentas, ajusta a 20 si es estricto
        throw new Error("⏳ Límite diario alcanzado. Intenta mañana.");
    }

    try {
        // CORRECCIÓN: Nombre del modelo válido actual
        const response = await ai.models.generateContent({
            model: "gemini-2.0-flash-exp",
            contents: prompt
        });

        requestCount.minute++;
        requestCount.day++;
        console.log(`📊 API Calls: ${requestCount.minute} RPM | ${requestCount.day} RPD`);

        // CORRECCIÓN: La nueva librería devuelve el texto directamente o dentro de candidates
        return response.text ? response.text() : response.candidates[0].content.parts[0].text;
    } catch (error) {
        console.error("Error Gemini Detallado:", JSON.stringify(error, null, 2));
        if (error.message && error.message.includes("RESOURCE_EXHAUSTED")) {
            throw new Error("❌ Cuota de Gemini agotada. Espera o usa otra API key.");
        }
        throw error;
    }
}

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Bot Tipster V3.3: Base de Datos Conectada'))
    .catch(err => console.error('🔴 Error BD:', err));

// --- 2. MODELOS DE DATOS ---
const PrediccionSchema = new mongoose.Schema({
    partidoId: { type: String, unique: true },
    equipoLocal: String,
    equipoVisita: String,
    fechaPartido: String,
    analisisIA: String,
    pickIA: String,
    liga: String,
    resultadoReal: { type: String, default: null },
    estado: { type: String, default: 'PENDIENTE' },
    montoApostado: { type: Number, default: 0 },
    confianza: { type: String, default: '🟡' },
    createdAt: { type: Date, default: Date.now }
});
const Prediccion = mongoose.model('Prediccion', PrediccionSchema);

const ConfigSchema = new mongoose.Schema({ key: String, value: String });
const Config = mongoose.model('Config', ConfigSchema);

// --- 3. MENÚ PRINCIPAL ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    // Guardamos el chatID para las alarmas automáticas
    await Config.findOneAndUpdate({ key: 'adminChatId' }, { value: chatId }, { upsert: true });

    bot.sendMessage(chatId, `⚽ *Tipster IA V3.3 - Edición Europea*
Tu ID ha sido vinculado para reportes automáticos a las 6:30 AM.

*Ligas Activas:* 🇪🇸 🏴󠁧󠁢󠁥󠁮󠁧󠁿 🇮🇹 🇩🇪 🇫🇷 🏆`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇮🇹 Serie A', callback_data: 'comp_SA' }, { text: '🇩🇪 Bundesliga', callback_data: 'comp_BL1' }],
                [{ text: '🇫🇷 Ligue 1', callback_data: 'comp_FL1' }, { text: '🏆 Champions', callback_data: 'comp_CL' }],
                [{ text: '📊 AUDITAR', callback_data: 'ver_resumen' }, { text: '💰 BANCO', callback_data: 'ver_banco' }],
                [{ text: '📥 EXPORTAR', callback_data: 'exportar_excel' }, { text: '📈 STATS API', callback_data: 'ver_stats' }]
            ]
        }
    });
});

// --- 4. CRON JOB ACTIVADO (ALARMA) ---
// Se ejecuta todos los días a las 6:30 AM hora Perú/Colombia
cron.schedule('30 6 * * *', async () => {
    console.log("⏰ Ejecutando cron job matutino...");
    const config = await Config.findOne({ key: 'adminChatId' });
    if (config) {
        await ejecutarReporteMatutino(config.value);
    } else {
        console.log("⚠️ No hay AdminChatId configurado para el reporte.");
    }
}, {
    scheduled: true,
    timezone: "America/Lima"
});

async function ejecutarReporteMatutino(chatId) {
    bot.sendMessage(chatId, "⏰ *Buenos días. Generando informe de apuestas...*", { parse_mode: 'Markdown' });

    // Agregadas Serie A (SA) y Bundesliga (BL1)
    const ligas = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL'];
    let partidosHoy = [];
    const hoy = new Date().toISOString().split('T')[0];

    try {
        // Recopilar partidos de todas las ligas
        for (const code of ligas) {
            try {
                const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
                    headers: footballHeaders,
                    params: { dateFrom: hoy, dateTo: hoy }
                });
                if (res.data.matches && res.data.matches.length > 0) {
                    // Tomamos solo los partidos importantes para no llenar el prompt
                    partidosHoy = [...partidosHoy, ...res.data.matches.map(m => ({
                        h: m.homeTeam.name, a: m.awayTeam.name, l: m.competition.name, time: m.utcDate
                    }))];
                }
            } catch (err) {
                console.error(`Error obteniendo liga ${code}:`, err.message);
            }
        }

        if (partidosHoy.length === 0) {
            return bot.sendMessage(chatId, "☕ Hoy no hay partidos destacados en las ligas principales.", { parse_mode: 'Markdown' });
        }

        // Seleccionamos máximo 15 partidos para no exceder tokens
        const listaPartidos = partidosHoy.slice(0, 15).map(m => `• ${m.h} vs ${m.a} (${m.l})`).join("\n");

        const promptDia = `Actúa como un Tipster Profesional. Analiza rápidamente estos partidos de hoy y dame ÚNICAMENTE los 3 mejores picks (apuestas seguras) con este formato exacto:
        
        🏆 *LIGA*
        ⚽ Partido: Equipo A vs Equipo B
        🎯 Pick: (Ej: Gana Local, +2.5 Goles, Ambos marcan)
        💡 Razón: (Breve explicación de 1 linea)
        💰 Confianza: Alta/Media

        Partidos disponibles:
        ${listaPartidos}`;

        const respuesta = await llamarGeminiConLimite(promptDia);
        bot.sendMessage(chatId, `🗞️ *PICKS DEL DÍA (${hoy})*\n\n${respuesta}`, { parse_mode: 'Markdown' });

    } catch (e) {
        console.error("Error reporte:", e);
        bot.sendMessage(chatId, "❌ Error generando reporte diario: " + e.message);
    }
}

// --- 5. MANEJADOR DE EVENTOS ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data === 'ver_resumen') await verificarResultados(chatId);
    else if (data === 'ver_banco') await mostrarBanco(chatId);
    else if (data === 'exportar_excel') await exportarDatos(chatId);
    else if (data === 'ver_stats') await mostrarStatsAPI(chatId);
    else if (data.startsWith('comp_')) await listarPartidos(chatId, data.split('_')[1]);
    else if (data.startsWith('analyze|')) {
        const [_, home, away, code, date] = data.split('|');
        await procesarAnalisis(chatId, home, away, code, date);
    }
    else if (data.startsWith('lineup|')) {
        const [_, home, away] = data.split('|');
        await chequearAlineaciones(chatId, home, away);
    }

    try {
        await bot.answerCallbackQuery(query.id);
    } catch (e) { /* Ignorar error de timeout */ }
});

// --- 6. FUNCIONES DE APOYO ---

async function listarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        const hoy = new Date().toISOString().split('T')[0];
        const limite = new Date();
        limite.setDate(limite.getDate() + 5);

        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders,
            params: { dateFrom: hoy, dateTo: limite.toISOString().split('T')[0], status: 'SCHEDULED' }
        });

        const matches = res.data.matches || [];
        if (matches.length === 0) return bot.sendMessage(chatId, "⚠️ No hay partidos programados pronto en esta liga.");

        // Mostrar max 5 partidos
        for (const m of matches.slice(0, 5)) {
            const h = m.homeTeam.name;
            const a = m.awayTeam.name;
            const d = m.utcDate.split('T')[0];
            const existe = await Prediccion.exists({ partidoId: `${h}-${a}-${d}` });

            bot.sendMessage(chatId, `🏟️ *${h}* vs *${a}*\n📅 ${d}`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: existe ? "✅ Ver Pick Guardado" : "🧠 Analizar con IA", callback_data: `analyze|${h.substring(0, 15)}|${a.substring(0, 15)}|${code}|${d}` }]] }
            });
        }
    } catch (e) {
        console.error("Error listando partidos:", e);
        bot.sendMessage(chatId, "❌ Error obteniendo datos de la liga. Verifica tu API Key de Football-Data.");
    }
}

async function procesarAnalisis(chatId, home, away, code, date) {
    const idUnico = `${home}-${away}-${date}`;

    // Verificar cache
    const cached = await Prediccion.findOne({ partidoId: idUnico });
    if (cached) return bot.sendMessage(chatId, `📂 *ANÁLISIS GUARDADO*\n\n${cached.analisisIA}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "🔍 Jugadores Clave", callback_data: `lineup|${home}|${away}` }]] }
    });

    bot.sendChatAction(chatId, 'typing');
    try {
        const racha = await obtenerRacha(code, home, away); // Función mejorada para filtrar por equipos

        const prompt = `Actúa como analista deportivo experto.
Partido: ${home} (Local) vs ${away} (Visita).
Contexto reciente: ${racha}

Responde estrictamente con este formato:
1. 🟢/🟡/🔴 PICK: (Tu predicción principal)
2. 💰 Inversión sugerida: S/. (Entre 20 y 100)
3. ⚽ Marcador probable: (Ej: 2-1)
4. 🗝️ Razón clave: (Máximo 20 palabras)`;

        const texto = await llamarGeminiConLimite(prompt);

        // Extracción simple de datos
        let confianza = texto.includes('🟢') ? '🟢' : (texto.includes('🔴') ? '🔴' : '🟡');
        const montoMatch = texto.match(/S\/\.?\s?(\d+)/);
        const monto = montoMatch ? parseInt(montoMatch[1]) : 20;

        const nueva = new Prediccion({
            partidoId: idUnico,
            equipoLocal: home,
            equipoVisita: away,
            fechaPartido: date,
            analisisIA: texto,
            pickIA: texto, // Guardamos el texto completo como referencia
            liga: code,
            montoApostado: monto,
            confianza: confianza
        });
        await nueva.save();

        bot.sendMessage(chatId, `📝 *NUEVO ANÁLISIS*\n\n${texto}`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "🔍 Jugadores Clave", callback_data: `lineup|${home}|${away}` }]] }
        });
    } catch (e) {
        console.error("Error análisis:", e);
        bot.sendMessage(chatId, "❌ " + e.message);
    }
}

async function chequearAlineaciones(chatId, home, away) {
    bot.sendChatAction(chatId, 'typing');
    try {
        const respuesta = await llamarGeminiConLimite(`Dime los 2 jugadores más peligrosos actualmente de ${home} y los 2 de ${away}. Sé muy breve.`);
        bot.sendMessage(chatId, `🕵️ *RADAR DE JUGADORES*\n\n${respuesta}`, { parse_mode: 'Markdown' });
    } catch (e) {
        bot.sendMessage(chatId, "❌ " + e.message);
    }
}

async function mostrarBanco(chatId) {
    const todos = await Prediccion.find({ estado: { $ne: 'PENDIENTE' } });
    let ganadas = 0, perdidas = 0, balance = 0;

    todos.forEach(p => {
        if (p.estado === 'GANADA') {
            ganadas++;
            balance += (p.montoApostado * 0.85); // Asumiendo cuota promedio 1.85
        }
        else if (p.estado === 'PERDIDA') {
            perdidas++;
            balance -= p.montoApostado;
        }
    });

    const winRate = todos.length > 0 ? ((ganadas / todos.length) * 100).toFixed(1) : 0;

    bot.sendMessage(chatId, `🏦 *BANCO TIPSTER*
✅ Ganadas: ${ganadas}
❌ Perdidas: ${perdidas}
📊 Win Rate: ${winRate}%
💰 *Balance Neto: S/. ${balance.toFixed(2)}*`, { parse_mode: 'Markdown' });
}

async function mostrarStatsAPI(chatId) {
    bot.sendMessage(chatId, `📊 *USO DE GEMINI API*

Minuto actual: ${requestCount.minute}/5 RPM
Hoy: ${requestCount.day} llamadas (aprox)

*Estado:* ${requestCount.day >= 20 ? '⚠️ Cerca del límite diario' : '✅ Operativo'}`, { parse_mode: 'Markdown' });
}

async function exportarDatos(chatId) {
    bot.sendChatAction(chatId, 'upload_document');
    try {
        const predicciones = await Prediccion.find({}).sort({ fechaPartido: -1 });
        let csv = "FECHA,PARTIDO,LIGA,CONFIANZA,INVERSION,ESTADO,RESULTADO_REAL\n";

        predicciones.forEach(p => {
            csv += `${p.fechaPartido},"${p.equipoLocal} vs ${p.equipoVisita}",${p.liga},"${p.confianza}",${p.montoApostado},${p.estado},${p.resultadoReal || '-'}\n`;
        });

        const fileName = `./Reporte_${Date.now()}.csv`;
        fs.writeFileSync(fileName, csv);
        await bot.sendDocument(chatId, fileName, {}, { filename: 'Tipster_Export.csv', contentType: 'text/csv' });
        fs.unlinkSync(fileName); // Borrar archivo local
    } catch (e) {
        console.error("Error exportar:", e);
        bot.sendMessage(chatId, "❌ Error al generar el Excel.");
    }
}

async function verificarResultados(chatId) {
    bot.sendChatAction(chatId, 'typing');
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' });

    if (pendientes.length === 0) return bot.sendMessage(chatId, "✅ No hay predicciones pendientes de validación.");

    bot.sendMessage(chatId, `🔎 Auditando ${pendientes.length} predicciones pendientes con la API...`);

    let actualizados = 0;
    for (const p of pendientes) {
        try {
            // Buscamos resultados terminados
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${p.liga}/matches`, {
                headers: footballHeaders,
                params: { status: 'FINISHED', dateFrom: p.fechaPartido, dateTo: p.fechaPartido }
            });

            // Lógica difusa para encontrar el partido (a veces los nombres varían un poco)
            const m = res.data.matches.find(match =>
                (match.homeTeam.name.includes(p.equipoLocal) || p.equipoLocal.includes(match.homeTeam.name)) &&
                (match.awayTeam.name.includes(p.equipoVisita) || p.equipoVisita.includes(match.awayTeam.name))
            );

            if (m && m.score.fullTime.home !== null) {
                const score = `${m.score.fullTime.home}-${m.score.fullTime.away}`;

                // Usamos la IA para determinar si se ganó o perdió basado en el análisis
                // Esto es más flexible que comparar strings exactos
                const prompt = `Contexto apuesta:
Pick realizado: "${p.pickIA}"
Resultado Final Real: ${m.homeTeam.name} ${score} ${m.awayTeam.name}.
Pregunta: ¿La apuesta se ganó? Responde SOLO con la palabra "GANADA" o "PERDIDA".`;

                const veredicto = await llamarGeminiConLimite(prompt);

                const estadoFinal = veredicto.toUpperCase().includes("GANADA") ? 'GANADA' : 'PERDIDA';

                p.estado = estadoFinal;
                p.resultadoReal = score;
                await p.save();
                actualizados++;
            }
        } catch (e) {
            console.error(`Error verificando ${p.partidoId}:`, e.message);
        }
    }

    bot.sendMessage(chatId, `✅ Auditoría finalizada. ${actualizados} predicciones actualizadas.`);
}

async function obtenerRacha(code, homeName, awayName) {
    try {
        // Intentamos obtener partidos recientes de la liga para dar contexto
        // La API free no deja filtrar mucho por equipo histórico, así que traemos los últimos terminados de la liga
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders,
            params: { status: 'FINISHED', limit: 10 }
        });

        // Filtramos manualmente si aparece alguno de los equipos (no es perfecto en free tier pero ayuda)
        const relevantes = res.data.matches.filter(m =>
            m.homeTeam.name === homeName || m.awayTeam.name === homeName ||
            m.homeTeam.name === awayName || m.awayTeam.name === awayName
        );

        if (relevantes.length === 0) return "Sin datos recientes directos.";

        return relevantes.map(m =>
            `${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away} ${m.awayTeam.name}`
        ).join(", ");
    } catch (e) {
        return "Información de racha no disponible.";
    }
}

// --- 7. SERVIDOR HTTP (Para mantener vivo en Render/Replit/Heroku) ---
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('Bot Tipster IA V3.3 Online - Cron Activo');
    res.end();
}).listen(PORT, () => {
    console.log(`🌐 Servidor escuchando en puerto ${PORT}`);
});