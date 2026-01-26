require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenAI } = require("@google/genai");
const http = require('http');
const mongoose = require('mongoose');
const cron = require('node-cron');
const fs = require('fs');

// --- 1. CONFIGURACIÓN ---

// Inicialización corregida para la librería @google/genai
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// --- CONTROL DE TRÁFICO (ANTI-ERROR 429) ---
let requestCount = { minute: 0, day: 0, lastMinuteReset: Date.now(), lastDayReset: Date.now() };
let lastRequestTime = 0; // Para controlar el espacio entre llamadas

// Función de espera (Sleep)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function llamarGeminiConLimite(prompt) {
    // 1. Gestión de contadores locales
    const ahora = Date.now();
    if (ahora - requestCount.lastMinuteReset > 60000) {
        requestCount.minute = 0;
        requestCount.lastMinuteReset = ahora;
    }
    if (ahora - requestCount.lastDayReset > 86400000) {
        requestCount.day = 0;
        requestCount.lastDayReset = ahora;
    }

    // 2. Bloqueo preventivo local
    if (requestCount.minute >= 12) throw new Error("⏳ Calma... demasiadas peticiones por minuto.");
    if (requestCount.day >= 100) throw new Error("⏳ Límite diario alcanzado.");

    // 3. COLA DE ESPERA INTELIGENTE (Throttling)
    // Esto asegura que haya al menos 4 segundos entre CADA llamada a la API
    const tiempoDesdeUltima = Date.now() - lastRequestTime;
    if (tiempoDesdeUltima < 4000) {
        const tiempoEspera = 4000 - tiempoDesdeUltima;
        await delay(tiempoEspera);
    }

    // Actualizamos el tiempo de la última llamada
    lastRequestTime = Date.now();

    // 4. LLAMADA CON REINTENTO AUTOMÁTICO
    try {
        return await realizarLlamadaAI(prompt);
    } catch (error) {
        // Si es error 429, esperamos 12 segundos y reintentamos UNA vez
        if (error.status === 429 || (error.message && error.message.includes("429"))) {
            console.log("⚠️ Error 429 detectado. Aplicando pausa de enfriamiento (12s)...");
            await delay(12000); // Pausa larga
            lastRequestTime = Date.now(); // Resetear timer
            return await realizarLlamadaAI(prompt); // Reintento
        }
        throw error;
    }
}

// Función auxiliar separada para hacer la llamada
async function realizarLlamadaAI(prompt) {
    // Usamos el modelo 'gemini-1.5-flash' que es más estable y rápido para free tier
    // Nota: La sintaxis depende de la versión exacta de la librería, usamos la estándar compatible
    const response = await genAI.models.generateContent({
        model: "gemini-1.5-flash",
        contents: prompt
    });

    requestCount.minute++;
    requestCount.day++;
    console.log(`📊 API Gemini: ${requestCount.minute} RPM | ${requestCount.day} RPD`);

    // Manejo seguro de la respuesta según versión de librería
    if (response.text && typeof response.text === 'function') {
        return response.text();
    } else if (response.candidates && response.candidates[0]) {
        return response.candidates[0].content.parts[0].text;
    }
    return JSON.stringify(response);
}

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Bot Tipster V3.6: Base de Datos Conectada'))
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
    await Config.findOneAndUpdate({ key: 'adminChatId' }, { value: chatId }, { upsert: true });

    bot.sendMessage(chatId, `⚽ *Tipster IA V3.6 - Anti-Lag System*
Sistema optimizado para evitar saturación de Google.
*Nota:* Los análisis pueden tardar 4-5 segundos para proteger la API.

*Ligas:* 🇪🇸 🏴󠁧󠁢󠁥󠁮󠁧󠁿 🇮🇹 🇩🇪 🇫🇷 🏆`, {
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

// --- 4. CRON JOB (ALARMA) ---
cron.schedule('30 6 * * *', async () => {
    console.log("⏰ Ejecutando cron job matutino...");
    const config = await Config.findOne({ key: 'adminChatId' });
    if (config) {
        await ejecutarReporteMatutino(config.value);
    }
}, { scheduled: true, timezone: "America/Lima" });

async function ejecutarReporteMatutino(chatId) {
    bot.sendMessage(chatId, "⏰ *Buenos días. Analizando mercado... esto tomará unos segundos.*", { parse_mode: 'Markdown' });
    
    const ligas = ['PL', 'PD', 'SA', 'BL1']; // Reducimos ligas para el reporte automático para ahorrar cuota
    let partidosHoy = [];
    const hoy = new Date().toISOString().split('T')[0];
    
    try {
        for (const code of ligas) {
            try {
                // Pequeña pausa entre llamadas a la API de fútbol también
                await delay(1000); 
                const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
                    headers: footballHeaders,
                    params: { dateFrom: hoy, dateTo: hoy }
                });
                if (res.data.matches && res.data.matches.length > 0) {
                    partidosHoy = [...partidosHoy, ...res.data.matches.map(m => ({
                        h: m.homeTeam.name, a: m.awayTeam.name, l: m.competition.name
                    }))];
                }
            } catch (err) { console.error(`Skip liga ${code}`); }
        }

        if (partidosHoy.length === 0) {
            return bot.sendMessage(chatId, "☕ No hay partidos destacados temprano.", { parse_mode: 'Markdown' });
        }

        const listaPartidos = partidosHoy.slice(0, 10).map(m => `• ${m.h} vs ${m.a} (${m.l})`).join("\n");
        const promptDia = `Analiza estos partidos y dame SOLO los 2 picks más seguros (High Confidence). Formato breve:\n${listaPartidos}`;

        const respuesta = await llamarGeminiConLimite(promptDia);
        bot.sendMessage(chatId, `🗞️ *PICKS DEL DÍA*\n\n${respuesta}`, { parse_mode: 'Markdown' });

    } catch (e) {
        bot.sendMessage(chatId, "❌ Error reporte: " + e.message);
    }
}

// --- 5. EVENTOS ---
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

    try { await bot.answerCallbackQuery(query.id); } catch (e) {}
});

// --- 6. FUNCIONES DE APOYO ---

async function listarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        const hoy = new Date().toISOString().split('T')[0];
        const limite = new Date();
        limite.setDate(limite.getDate() + 4);

        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders,
            params: { dateFrom: hoy, dateTo: limite.toISOString().split('T')[0], status: 'SCHEDULED' }
        });

        const matches = res.data.matches || [];
        if (matches.length === 0) return bot.sendMessage(chatId, "⚠️ No hay partidos programados.");

        for (const m of matches.slice(0, 5)) {
            const h = m.homeTeam.name;
            const a = m.awayTeam.name;
            const d = m.utcDate.split('T')[0];
            const existe = await Prediccion.exists({ partidoId: `${h}-${a}-${d}` });

            bot.sendMessage(chatId, `🏟️ *${h}* vs *${a}*\n📅 ${d}`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: existe ? "✅ Ver Pick" : "🧠 Analizar IA", callback_data: `analyze|${h.substring(0, 15)}|${a.substring(0, 15)}|${code}|${d}` }]] }
            });
        }
    } catch (e) {
        bot.sendMessage(chatId, "❌ Error obteniendo datos.");
    }
}

async function procesarAnalisis(chatId, home, away, code, date) {
    const idUnico = `${home}-${away}-${date}`;
    const cached = await Prediccion.findOne({ partidoId: idUnico });
    
    if (cached) return bot.sendMessage(chatId, `📂 *ANÁLISIS (Guardado)*\n\n${cached.analisisIA}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "🔍 Jugadores", callback_data: `lineup|${home}|${away}` }]] }
    });

    bot.sendChatAction(chatId, 'typing');
    // Aviso visual al usuario
    bot.sendMessage(chatId, "🧠 *Analizando...* (Esto puede tardar unos segundos por seguridad de la API)", { parse_mode: 'Markdown' });

    try {
        const racha = await obtenerRacha(code, home, away);
        
        // Prompt optimizado para ser breve y gastar menos tokens
        const prompt = `Analista de apuestas.
Partido: ${home} (Local) vs ${away} (Visita).
Datos: ${racha}

Responde formato JSON minificado implícito:
1. 🟢/🟡/🔴 PICK:
2. 💰 Inversión S/.:
3. ⚽ Marcador:
4. 🗝️ Razón (max 15 palabras):`;

        const texto = await llamarGeminiConLimite(prompt);

        // Extracción segura
        let confianza = '🟡';
        if (texto.includes('🟢')) confianza = '🟢';
        if (texto.includes('🔴')) confianza = '🔴';
        
        const montoMatch = texto.match(/S\/\.?\s?(\d+)/);
        const monto = montoMatch ? parseInt(montoMatch[1]) : 20;

        const nueva = new Prediccion({
            partidoId: idUnico,
            equipoLocal: home, equipoVisita: away, fechaPartido: date,
            analisisIA: texto, pickIA: texto, liga: code,
            montoApostado: monto, confianza: confianza
        });
        await nueva.save();

        bot.sendMessage(chatId, `📝 *ANÁLISIS COMPLETADO*\n\n${texto}`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "🔍 Jugadores", callback_data: `lineup|${home}|${away}` }]] }
        });
    } catch (e) {
        console.error("Fallo Análisis:", e);
        bot.sendMessage(chatId, "⚠️ " + e.message);
    }
}

async function chequearAlineaciones(chatId, home, away) {
    bot.sendChatAction(chatId, 'typing');
    try {
        const respuesta = await llamarGeminiConLimite(`Nombra 2 jugadores clave de ${home} y ${away}.`);
        bot.sendMessage(chatId, `🕵️ *JUGADORES*\n\n${respuesta}`, { parse_mode: 'Markdown' });
    } catch (e) {
        bot.sendMessage(chatId, "❌ " + e.message);
    }
}

async function mostrarBanco(chatId) {
    const todos = await Prediccion.find({ estado: { $ne: 'PENDIENTE' } });
    let ganadas = 0, perdidas = 0, balance = 0;
    todos.forEach(p => {
        if (p.estado === 'GANADA') { ganadas++; balance += (p.montoApostado * 0.80); }
        else if (p.estado === 'PERDIDA') { perdidas++; balance -= p.montoApostado; }
    });
    bot.sendMessage(chatId, `🏦 *BANCO*\n✅ ${ganadas} | ❌ ${perdidas}\n💰 Balance: S/. ${balance.toFixed(2)}`, { parse_mode: 'Markdown' });
}

async function mostrarStatsAPI(chatId) {
    bot.sendMessage(chatId, `📊 *MONITOR API*
RPM Local: ${requestCount.minute}
RPD Local: ${requestCount.day}
Cooldown: 4 seg entre llamadas.`, { parse_mode: 'Markdown' });
}

async function exportarDatos(chatId) {
    bot.sendChatAction(chatId, 'upload_document');
    try {
        const predicciones = await Prediccion.find({}).sort({ fechaPartido: -1 });
        let csv = "FECHA,PARTIDO,LIGA,CONFIANZA,INVERSION,ESTADO\n";
        predicciones.forEach(p => csv += `${p.fechaPartido},"${p.equipoLocal} vs ${p.equipoVisita}",${p.liga},${p.confianza},${p.montoApostado},${p.estado}\n`);
        const fileName = `/tmp/Reporte_${Date.now()}.csv`; // Usar /tmp para compatibilidad con sistemas read-only
        fs.writeFileSync(fileName, csv);
        await bot.sendDocument(chatId, fileName, {}, { filename: 'Tipster_Export.csv', contentType: 'text/csv' });
        fs.unlinkSync(fileName);
    } catch (e) { bot.sendMessage(chatId, "❌ Error exportar."); }
}

async function verificarResultados(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' });
    if (pendientes.length === 0) return bot.sendMessage(chatId, "✅ Nada pendiente.");
    bot.sendMessage(chatId, `🔎 Auditando ${pendientes.length} predicciones...`);

    let actualizados = 0;
    for (const p of pendientes) {
        try {
            await delay(1500); // Retraso para no saturar Football API ni Gemini
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${p.liga}/matches`, {
                headers: footballHeaders,
                params: { status: 'FINISHED', dateFrom: p.fechaPartido, dateTo: p.fechaPartido }
            });
            
            const m = res.data.matches.find(match => 
                (match.homeTeam.name.includes(p.equipoLocal) || p.equipoLocal.includes(match.homeTeam.name))
            );

            if (m && m.score.fullTime.home !== null) {
                const score = `${m.score.fullTime.home}-${m.score.fullTime.away}`;
                const prompt = `Pick: "${p.pickIA}". Resultado: ${m.homeTeam.name} ${score} ${m.awayTeam.name}. ¿Ganada o Perdida? Responde solo 1 palabra.`;
                const veredicto = await llamarGeminiConLimite(prompt);
                
                p.estado = veredicto.toUpperCase().includes("GAN") ? 'GANADA' : 'PERDIDA';
                p.resultadoReal = score;
                await p.save();
                actualizados++;
            }
        } catch (e) { console.error(`Error auditando ${p.partidoId}`); }
    }
    bot.sendMessage(chatId, `✅ Fin auditoría. ${actualizados} actualizadas.`);
}

async function obtenerRacha(code, home, away) {
    try {
        await delay(500); // Protección Football API
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders, params: { status: 'FINISHED', limit: 8 }
        });
        const relevantes = res.data.matches.filter(m => m.homeTeam.name === home || m.awayTeam.name === away);
        return relevantes.map(m => `${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away} ${m.awayTeam.name}`).join(", ") || "Sin datos recientes";
    } catch (e) { return "Sin racha"; }
}

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot Tipster V3.6 Online');
}).listen(PORT, () => console.log(`🌐 Puerto ${PORT}`));