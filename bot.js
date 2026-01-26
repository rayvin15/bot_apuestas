require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenAI } = require("@google/genai");
const http = require('http');
const mongoose = require('mongoose');
const cron = require('node-cron');
const fs = require('fs');

// --- 1. CONFIGURACIÓN ---
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});
const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Control de rate limiting (evitar exceder 5 RPM y 20 RPD)
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
    if (requestCount.day >= 18) {
        throw new Error("⏳ Límite diario alcanzado (20 RPD). Intenta mañana.");
    }

    try {
        const response = await ai.models.generateContent({
            model: "gemini-3-flash",
            contents: prompt
        });
        
        requestCount.minute++;
        requestCount.day++;
        console.log(`📊 API Calls: ${requestCount.minute} RPM | ${requestCount.day} RPD`);
        
        return response.text;
    } catch (error) {
        if (error.message && error.message.includes("RESOURCE_EXHAUSTED")) {
            throw new Error("❌ Cuota de Gemini agotada. Espera o usa otra API key.");
        }
        throw error;
    }
}

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Bot Tipster V3.2: Sistema de Persistencia Activo'))
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

    bot.sendMessage(chatId, `⚽ *Tipster IA V3.2 - Suite Profesional*
Tu ID ha sido vinculado para reportes de las 6:30 AM.

⚠️ *Límites API Gemini Free:*
• 5 análisis por minuto
• 20 análisis por día
Usa sabiamente.`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇫🇷 Ligue 1', callback_data: 'comp_FL1' }, { text: '🏆 Champions', callback_data: 'comp_CL' }],
                [{ text: '📊 AUDITAR', callback_data: 'ver_resumen' }, { text: '💰 BANCO', callback_data: 'ver_banco' }],
                [{ text: '📥 EXPORTAR', callback_data: 'exportar_excel' }, { text: '📈 STATS API', callback_data: 'ver_stats' }]
            ]
        }
    });
});

// --- 4. CRON JOB DESACTIVADO POR DEFECTO (consume mucha cuota) ---
// Descomenta si tienes cuota suficiente
/*
cron.schedule('30 6 * * *', async () => {
    const config = await Config.findOne({ key: 'adminChatId' });
    if (config) {
        ejecutarReporteMatutino(config.value);
    }
}, { scheduled: true, timezone: "America/Lima" });
*/

async function ejecutarReporteMatutino(chatId) {
    bot.sendMessage(chatId, "⏰ *Generando informe matutino...*", { parse_mode: 'Markdown' });
    const ligas = ['PL', 'PD', 'FL1']; // Reducido para ahorrar cuota
    let partidosHoy = [];
    const hoy = new Date().toISOString().split('T')[0];
    
    try {
        for (const code of ligas) {
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
                headers: footballHeaders,
                params: { dateFrom: hoy, dateTo: hoy }
            });
            if (res.data.matches && res.data.matches.length > 0) {
                partidosHoy = [...partidosHoy, ...res.data.matches.slice(0, 2).map(m => ({
                    h: m.homeTeam.name, a: m.awayTeam.name, l: m.competition.name
                }))];
            }
        }

        if (partidosHoy.length === 0) {
            return bot.sendMessage(chatId, "☕ Sin partidos destacados hoy.", { parse_mode: 'Markdown' });
        }

        const listaPartidos = partidosHoy.map(m => `• ${m.h} vs ${m.a} (${m.l})`).join("\n");
        const promptDia = `Analiza rápidamente estos ${partidosHoy.length} partidos y dame los 2 picks más seguros con formato: "🟢/🟡 EQUIPO - Razón breve":\n${listaPartidos}`;

        const respuesta = await llamarGeminiConLimite(promptDia);
        bot.sendMessage(chatId, `🗞️ *PICKS DEL DÍA*\n\n${respuesta}`, { parse_mode: 'Markdown' });

    } catch (e) {
        console.error("Error reporte:", e);
        bot.sendMessage(chatId, "❌ " + e.message);
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
    bot.answerCallbackQuery(query.id).catch(() => {});
});

// --- 6. FUNCIONES DE APOYO ---

async function listarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        const hoy = new Date().toISOString().split('T')[0];
        const limite = new Date();
        limite.setDate(limite.getDate() + 7); // Reducido a 7 días
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders,
            params: { dateFrom: hoy, dateTo: limite.toISOString().split('T')[0], status: 'SCHEDULED' }
        });
        const matches = res.data.matches || [];
        if (matches.length === 0) return bot.sendMessage(chatId, "⚠️ No hay partidos pronto.");

        for (const m of matches.slice(0, 5)) {
            const h = m.homeTeam.name;
            const a = m.awayTeam.name;
            const d = m.utcDate.split('T')[0];
            const existe = await Prediccion.exists({ partidoId: `${h}-${a}-${d}` });
            bot.sendMessage(chatId, `🏟️ *${h}* vs *${a}*\n📅 ${d}`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: existe ? "✅ Ver Pick" : "🧠 Analizar", callback_data: `analyze|${h.substring(0,15)}|${a.substring(0,15)}|${code}|${d}` }]] }
            });
        }
    } catch (e) { 
        console.error("Error listando partidos:", e);
        bot.sendMessage(chatId, "❌ Error API Football."); 
    }
}

async function procesarAnalisis(chatId, home, away, code, date) {
    const idUnico = `${home}-${away}-${date}`;
    const cached = await Prediccion.findOne({ partidoId: idUnico });
    if (cached) return bot.sendMessage(chatId, `📂 *ANÁLISIS GUARDADO*\n\n${cached.analisisIA}`, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "🔍 Jugadores Clave", callback_data: `lineup|${home}|${away}` }]] }
    });

    bot.sendChatAction(chatId, 'typing');
    try {
        const racha = await obtenerRacha(code);
        const prompt = `Tipster: ${home} vs ${away}.
Contexto: ${racha}

Dame en 4 líneas:
1. 🟢/🟡/🔴 + PICK
2. Inversión S/. (10-50)
3. Marcador probable
4. Razón clave`;

        const texto = await llamarGeminiConLimite(prompt);
        
        let confianza = texto.includes('🟢') ? '🟢' : (texto.includes('🔴') ? '🔴' : '🟡');
        const monto = parseInt(texto.match(/S\/\.?\s?(\d+)/)?.[1] || 20);

        const nueva = new Prediccion({
            partidoId: idUnico, 
            equipoLocal: home, 
            equipoVisita: away,
            fechaPartido: date, 
            analisisIA: texto, 
            pickIA: texto, 
            liga: code,
            montoApostado: monto, 
            confianza: confianza
        });
        await nueva.save();
        
        bot.sendMessage(chatId, `📝 *ANÁLISIS*\n\n${texto}\n\n_Guardado en BD_`, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "🔍 Jugadores Clave", callback_data: `lineup|${home}|${away}` }]] }
        });
    } catch (e) { 
        console.error("Error análisis:", e);
        bot.sendMessage(chatId, "❌ " + e.message); 
    }
}

async function chequearAlineaciones(chatId, home, away) {
    try {
        const respuesta = await llamarGeminiConLimite(`Jugadores TOP de ${home} y ${away}. 2 líneas.`);
        bot.sendMessage(chatId, `🕵️ *RADAR*\n\n${respuesta}`, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error("Error radar:", e);
        bot.sendMessage(chatId, "❌ " + e.message);
    }
}

async function mostrarBanco(chatId) {
    const todos = await Prediccion.find({ estado: { $ne: 'PENDIENTE' } });
    let ganadas = 0, perdidas = 0, balance = 0;
    todos.forEach(p => {
        if (p.estado === 'GANADA') { 
            ganadas++; 
            balance += (p.montoApostado * 0.80); 
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
💰 *Balance: S/. ${balance.toFixed(2)}*`, { parse_mode: 'Markdown' });
}

async function mostrarStatsAPI(chatId) {
    bot.sendMessage(chatId, `📊 *USO DE GEMINI API*

Minuto actual:
🔹 Llamadas: ${requestCount.minute}/5 RPM

Hoy:
🔹 Llamadas: ${requestCount.day}/20 RPD

⚠️ Límite gratuito: 20 análisis/día`, { parse_mode: 'Markdown' });
}

async function exportarDatos(chatId) {
    try {
        const predicciones = await Prediccion.find({}).sort({ fechaPartido: -1 });
        let csv = "FECHA,PARTIDO,CONFIANZA,INVERSION,ESTADO,GANANCIA\n";
        predicciones.forEach(p => {
            let gan = p.estado === 'GANADA' ? (p.montoApostado * 0.80) : (p.estado === 'PERDIDA' ? -p.montoApostado : 0);
            csv += `${p.fechaPartido},"${p.equipoLocal} vs ${p.equipoVisita}","${p.confianza}",${p.montoApostado},${p.estado},${gan.toFixed(2)}\n`;
        });
        fs.writeFileSync('./Reporte.csv', csv);
        await bot.sendDocument(chatId, './Reporte.csv', {}, { filename: 'Tipster_Export.csv', contentType: 'text/csv' });
        fs.unlinkSync('./Reporte.csv');
    } catch (e) { 
        console.error("Error exportar:", e);
        bot.sendMessage(chatId, "❌ Error al exportar."); 
    }
}

async function verificarResultados(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' });
    if (pendientes.length === 0) return bot.sendMessage(chatId, "✅ Sin predicciones pendientes.");
    
    bot.sendMessage(chatId, `🔎 Auditando ${pendientes.length} predicciones...`);
    
    let actualizados = 0;
    for (const p of pendientes) {
        try {
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${p.liga}/matches`, {
                headers: footballHeaders, 
                params: { status: 'FINISHED', dateFrom: p.fechaPartido, dateTo: p.fechaPartido }
            });
            
            const m = res.data.matches.find(match => 
                match.homeTeam.name.includes(p.equipoLocal) || 
                p.equipoLocal.includes(match.homeTeam.name)
            );
            
            if (m && m.score.fullTime) {
                const score = `${m.score.fullTime.home}-${m.score.fullTime.away}`;
                const prompt = `Pick: "${p.pickIA}". Resultado: ${m.homeTeam.name} ${score} ${m.awayTeam.name}. ¿Acertó? SI o NO.`;

                const veredicto = await llamarGeminiConLimite(prompt);
                
                p.estado = veredicto.toUpperCase().includes("SI") || veredicto.toUpperCase().includes("SÍ") ? 'GANADA' : 'PERDIDA';
                p.resultadoReal = score;
                await p.save();
                actualizados++;
            }
        } catch (e) {
            console.error(`Error verificando ${p.partidoId}:`, e.message);
        }
    }
    
    bot.sendMessage(chatId, `✅ Auditoría completa. ${actualizados} actualizadas.`);
}

async function obtenerRacha(code) {
    try {
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, { 
            headers: footballHeaders, 
            params: { status: 'FINISHED' } 
        });
        return res.data.matches.slice(-2).map(m => 
            `${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away}`
        ).join(", ");
    } catch (e) { 
        return "Sin racha."; 
    }
}

// --- 7. SERVIDOR HTTP ---
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot Tipster V3.2 Online');
}).listen(process.env.PORT || 10000, () => {
    console.log(`🌐 Servidor en puerto ${process.env.PORT || 10000}`);
});