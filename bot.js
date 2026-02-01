require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
// Usamos la librería estándar para evitar errores de compatibilidad
const { GoogleGenerativeAI } = require("@google/generative-ai"); 
const http = require('http');
const mongoose = require('mongoose');
const cron = require('node-cron');
const fs = require('fs');

// --- 1. CONFIGURACIÓN ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODELO_USADO = "gemini-2.0-flash"; // Tu elección: Más potente, menos cupo.

const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// --- 2. SISTEMA DE SEGURIDAD (ANTI-BLOQUEO 429) ---
let lastRequestTime = 0;
// Aumentamos un poco el delay para proteger el modelo 2.0
const COOLDOWN_MS = 5000; 

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function llamarGeminiSeguro(prompt) {
    const tiempoDesdeUltima = Date.now() - lastRequestTime;
    if (tiempoDesdeUltima < COOLDOWN_MS) {
        await delay(COOLDOWN_MS - tiempoDesdeUltima);
    }

    try {
        console.log(`🚀 AI Request usando ${MODELO_USADO}...`);
        
        // Configuración estándar y robusta
        const model = genAI.getGenerativeModel({ model: MODELO_USADO });
        
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        lastRequestTime = Date.now();
        return text;

    } catch (error) {
        console.error("❌ Error AI:", error.message);
        
        // Manejo específico para cuando el 2.0 se satura
        if (error.message.includes('429') || error.message.includes('Quota')) {
            throw new Error("⏳ El modelo 2.0 está saturado (Límite Google). Intenta en 1 min.");
        }
        // Manejo si el modelo 2.0 no está disponible en tu región/cuenta
        if (error.message.includes('404') || error.message.includes('not found')) {
            throw new Error("🚫 Tu API Key no tiene acceso al Beta 2.0 aún. Cambia a 1.5.");
        }
        throw error;
    }
}

async function enviarMensajeSeguro(chatId, texto, opciones = {}) {
    try {
        await bot.sendMessage(chatId, texto, { ...opciones, parse_mode: 'Markdown' });
    } catch (error) {
        // Fallback si el Markdown falla
        try {
            await bot.sendMessage(chatId, "⚠️ _Respuesta (Sin formato):_\n" + texto, opciones);
        } catch (e) { console.error("Error envío Telegram:", e.message); }
    }
}

// --- 3. BASE DE DATOS ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log(`🟢 Bot V6.5 (Motor: ${MODELO_USADO}): DB Conectada`))
    .catch(err => console.error('🔴 Error BD:', err));

const PrediccionSchema = new mongoose.Schema({
    partidoId: { type: String, unique: true },
    equipoLocal: String, equipoVisita: String, fechaPartido: String,
    analisisIA: String, pickIA: String, liga: String,
    montoApostado: { type: Number, default: 0 },
    confianza: { type: String, default: '🟡' }, 
    resultadoReal: { type: String, default: null },
    estado: { type: String, default: 'PENDIENTE' },
    createdAt: { type: Date, default: Date.now }
});
const Prediccion = mongoose.model('Prediccion', PrediccionSchema);
const Config = mongoose.model('Config', new mongoose.Schema({ key: String, value: String }));

// --- 4. MENÚ PRINCIPAL ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await Config.findOneAndUpdate({ key: 'adminChatId' }, { value: chatId }, { upsert: true });

    enviarMensajeSeguro(chatId, `🧠 *Tipster AI V6.5*\n🤖 Modelo: *${MODELO_USADO}*\n✅ Radar & Auditoría Activos`, {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 LaLiga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇮🇹 Serie A', callback_data: 'comp_SA' }, { text: '🇩🇪 Bundesliga', callback_data: 'comp_BL1' }],
                [{ text: '🏆 Champions', callback_data: 'comp_CL' }, { text: '🇫🇷 Ligue 1', callback_data: 'comp_FL1' }],
                [{ text: '⏳ PENDIENTES', callback_data: 'ver_pendientes' }, { text: '💰 BANCA', callback_data: 'ver_banca' }],
                [{ text: '👨‍⚖️ AUDITAR JUEZ', callback_data: 'ver_auditoria' }, { text: '📥 EXPORTAR', callback_data: 'exportar_excel' }]
            ]
        }
    });
});

// --- 5. LOGICA MATUTINA (6:00 AM) ---
// Nota: Con el modelo 2.0, este reporte consume mucha cuota.
cron.schedule('0 6 * * *', async () => {
    const config = await Config.findOne({ key: 'adminChatId' });
    if (config) ejecutarReporteSeguro(config.value);
}, { scheduled: true, timezone: "America/Lima" });

async function ejecutarReporteSeguro(chatId) {
    enviarMensajeSeguro(chatId, "☀️ *Iniciando reporte diario (Gemini 2.0)...*");
    const ligas = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL'];
    let partidos = [];
    const hoy = new Date().toISOString().split('T')[0];

    try {
        for (const code of ligas) {
            await delay(4000); // Pausa necesaria para evitar bloqueo de IP
            try {
                const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
                    headers: footballHeaders, params: { dateFrom: hoy, dateTo: hoy }
                });
                if (res.data.matches) partidos = [...partidos, ...res.data.matches];
            } catch (e) { console.log(`Saltando liga ${code} por error API.`); }
        }

        if (partidos.length === 0) return enviarMensajeSeguro(chatId, "☕ No hay partidos destacados hoy.");

        // Limitamos a 12 partidos para que el prompt no sea gigante
        const listaTexto = partidos.slice(0, 12).map(m => `• ${m.homeTeam.name} vs ${m.awayTeam.name} (${m.competition.name})`).join("\n");

        const prompt = `Analista Pro. Analiza hoy:
${listaTexto}

Selecciona SOLO 3 partidos con cuota de valor.
Evita partidos trampa.
Formato:
🏆 *LIGA*
⚔️ Partido
💎 Pick: (Ej: Gana Local)
💡 Razón: (Breve)
💰 Confianza: (🟢/🟡)`;

        const respuesta = await llamarGeminiSeguro(prompt);
        enviarMensajeSeguro(chatId, `🗞️ *SELECCIÓN DEL DÍA*\n\n${respuesta}`);

    } catch (e) {
        enviarMensajeSeguro(chatId, "❌ Error reporte: " + e.message);
    }
}

// --- 6. MANEJO DE BOTONES ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data.startsWith('comp_')) await listarPartidos(chatId, data.split('_')[1]);
    else if (data.startsWith('analyze|')) {
        const [_, home, away, code, date] = data.split('|');
        await procesarAnalisisCompleto(chatId, home, away, code, date);
    }
    else if (data.startsWith('radar|')) {
        const [_, home, away] = data.split('|');
        await consultarRadar(chatId, home, away);
    }
    else if (data === 'ver_pendientes') await verPendientes(chatId);
    else if (data === 'ver_auditoria') await ejecutarAuditoria(chatId);
    else if (data === 'ver_banca') await mostrarBanca(chatId);
    else if (data === 'exportar_excel') await exportarCSV(chatId);

    try { await bot.answerCallbackQuery(query.id); } catch(e){}
});

// LISTAR PARTIDOS
async function listarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        await delay(1000); 
        const hoy = new Date().toISOString().split('T')[0];
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders, params: { dateFrom: hoy, dateTo: hoy, status: 'SCHEDULED' }
        });

        const matches = res.data.matches || [];
        if (matches.length === 0) return enviarMensajeSeguro(chatId, "⚠️ No hay partidos hoy en esta liga.");

        // Mostramos máximo 8 para no saturar Telegram ni al usuario
        for (const m of matches.slice(0, 8)) { 
            const h = m.homeTeam.name;
            const a = m.awayTeam.name;
            const d = m.utcDate.split('T')[0];
            const existe = await Prediccion.exists({ partidoId: `${h}-${a}-${d}` });
            
            const btnText = existe ? "✅ Ver Pick" : "🧠 Analizar IA";
            
            await bot.sendMessage(chatId, `🏟️ *${h}* vs *${a}*`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: btnText, callback_data: `analyze|${h}|${a}|${code}|${d}` }]] }
            });
            await delay(400); 
        }
    } catch (e) { enviarMensajeSeguro(chatId, "❌ Error API Fútbol."); }
}

// --- LOGICA DE ANÁLISIS ---
async function procesarAnalisisCompleto(chatId, home, away, code, date) {
    const id = `${home}-${away}-${date}`;
    const cached = await Prediccion.findOne({ partidoId: id });
    
    if (cached) {
        return bot.sendMessage(chatId, `📂 *GUARDADO*\n\n${cached.analisisIA}`, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "🔍 Radar Actualizado", callback_data: `radar|${home}|${away}` }]] }
        });
    }

    bot.sendChatAction(chatId, 'typing');
    enviarMensajeSeguro(chatId, "🧠 *Gemini 2.0 pensando...*");

    try {
        const racha = await obtenerRacha(code, home, away);
        
        const prompt = `Analista Deportivo Experto.
        Partido: ${home} vs ${away}.
        Datos previos: ${racha}.

        Genera un JSON válido:
        {
          "pick": "Mercado específico (ej: Ambos Marcan)",
          "confianza": "🟢 (Alta) / 🟡 (Media) / 🔴 (Baja)",
          "stake": 20,
          "analisis": "Argumento táctico breve.",
          "marcador": "Resultado exacto probable",
          "consejo": "Tip de gestión."
        }`;

        const rawText = await llamarGeminiSeguro(prompt);
        let datos = extraerDatosDeTexto(rawText); 
        
        // Validación extra de seguridad
        if (!datos.analisis) datos.analisis = "Análisis basado en estadísticas recientes y localía.";

        const msgFinal = `🎯 *PICK:* ${datos.pick}
${datos.confianza} *Confianza:* ${getNombreConfianza(datos.confianza)}
💰 *Stake:* S/. ${datos.stake}
⚽ *Marcador:* ${datos.marcador}

💡 *Análisis:* ${datos.analisis}

🎓 *Coach:* _${datos.consejo}_`;

        const nueva = new Prediccion({
            partidoId: id, equipoLocal: home, equipoVisita: away, fechaPartido: date,
            analisisIA: msgFinal, pickIA: datos.pick, liga: code,
            montoApostado: datos.stake, confianza: datos.confianza
        });
        await nueva.save();

        bot.sendMessage(chatId, msgFinal, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "🔍 Radar", callback_data: `radar|${home}|${away}` }]] }
        });

    } catch (e) { enviarMensajeSeguro(chatId, "❌ Error: " + e.message); }
}

function extraerDatosDeTexto(rawText) {
    let datos = { pick: "Error lectura", confianza: "🟡", stake: 0, analisis: "Intenta de nuevo.", marcador: "?", consejo: "" };
    try {
        let jsonClean = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        const firstOpen = jsonClean.indexOf('{');
        const lastClose = jsonClean.lastIndexOf('}');
        if (firstOpen !== -1 && lastClose !== -1) {
            jsonClean = jsonClean.substring(firstOpen, lastClose + 1);
            datos = { ...datos, ...JSON.parse(jsonClean) };
        }
    } catch (e) { console.log("JSON Fallido, texto crudo recibido."); }
    return datos;
}

// --- OTRAS FUNCIONES ---
async function verPendientes(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' }).sort({ fechaPartido: 1 });
    if (pendientes.length === 0) return enviarMensajeSeguro(chatId, "✅ Sin pendientes.");
    let mensaje = `⏳ *PENDIENTES (${pendientes.length})*\n\n`;
    pendientes.forEach((p, i) => {
        mensaje += `*${i + 1}.* ${p.equipoLocal} vs ${p.equipoVisita}\n🎯 ${p.pickIA}\n-------------------\n`;
    });
    enviarMensajeSeguro(chatId, mensaje);
}

async function consultarRadar(chatId, home, away) {
    enviarMensajeSeguro(chatId, "🔍 *Revisando bajas...*");
    try {
        const prompt = `Noticias cortas: ¿Bajas importantes ${home} vs ${away}? Máximo 20 palabras.`;
        const resp = await llamarGeminiSeguro(prompt);
        enviarMensajeSeguro(chatId, `🚨 *RADAR:* ${resp}`);
    } catch (e) { enviarMensajeSeguro(chatId, "❌ Radar no disponible (Cuota)."); }
}

async function ejecutarAuditoria(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' });
    if (!pendientes.length) return enviarMensajeSeguro(chatId, "✅ Todo auditado.");

    enviarMensajeSeguro(chatId, `👨‍⚖️ *Auditando...*`);
    let ganadas = 0, perdidas = 0;

    for (const p of pendientes) {
        try {
            await delay(2500); // Delay generoso para no saturar
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${p.liga}/matches`, {
                headers: footballHeaders, 
                params: { status: 'FINISHED', dateFrom: p.fechaPartido, dateTo: p.fechaPartido }
            });
            
            const match = res.data.matches.find(m => 
                m.homeTeam.name === p.equipoLocal && m.awayTeam.name === p.equipoVisita
            );

            if (match && match.score.fullTime.home !== null) {
                const marcadorReal = `${match.score.fullTime.home}-${match.score.fullTime.away}`;
                const prompt = `Juez estricto. Pick: "${p.pickIA}". Resultado: ${marcadorReal}. Responde SOLO: GANADA o PERDIDA.`;
                const veredicto = await llamarGeminiSeguro(prompt);
                const estadoFinal = veredicto.toUpperCase().includes('GAN') ? 'GANADA' : 'PERDIDA';
                
                p.estado = estadoFinal;
                p.resultadoReal = marcadorReal;
                await p.save();
                
                const icono = estadoFinal === 'GANADA' ? '✅' : '❌';
                await enviarMensajeSeguro(chatId, `${icono} *${p.equipoLocal} vs ${p.equipoVisita}*\nRes: ${marcadorReal} -> *${estadoFinal}*`);
                if (estadoFinal === 'GANADA') ganadas++; else perdidas++;
            }
        } catch (e) { console.log("Error auditoría indiv."); }
    }
    enviarMensajeSeguro(chatId, `📊 *Resumen:* +${ganadas} / -${perdidas}`);
}

async function mostrarBanca(chatId) {
    const historial = await Prediccion.find({ estado: { $ne: 'PENDIENTE' } });
    let saldo = 0;
    historial.forEach(p => {
        if (p.estado === 'GANADA') saldo += (p.montoApostado * 0.80); 
        else saldo -= p.montoApostado;
    });
    enviarMensajeSeguro(chatId, `💰 *BANCA NETA:* S/. ${saldo.toFixed(2)}`);
}

async function exportarCSV(chatId) {
    try {
        const data = await Prediccion.find({});
        let csv = "FECHA,PARTIDO,PICK,RESULTADO,ESTADO\n";
        data.forEach(p => csv += `${p.fechaPartido},${p.equipoLocal} vs ${p.equipoVisita},"${p.pickIA}",${p.resultadoReal},${p.estado}\n`);
        const path = `/tmp/history.csv`;
        fs.writeFileSync(path, csv);
        await bot.sendDocument(chatId, path);
    } catch (e) { enviarMensajeSeguro(chatId, "Error export."); }
}

async function obtenerRacha(code, home, away) {
    try {
        await delay(500);
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders, params: { status: 'FINISHED', limit: 10 } 
        });
        return res.data.matches
            .filter(m => m.homeTeam.name === home || m.awayTeam.name === away)
            .slice(0, 5)
            .map(m => `${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away} ${m.awayTeam.name}`)
            .join(", ");
    } catch { return "Sin datos previos."; }
}

function getNombreConfianza(simbolo) {
    if (simbolo.includes('🟢')) return "ALTA";
    if (simbolo.includes('🔴')) return "BAJA";
    return "MEDIA";
}

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.end('Bot V6.5 Gemini 2.0 Online'); }).listen(PORT);