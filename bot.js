require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenAI } = require("@google/genai"); 
const http = require('http');
const mongoose = require('mongoose');
const cron = require('node-cron');
const fs = require('fs');

// --- 1. CONFIGURACIÓN ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// Mantenemos tu configuración exitosa
const MODELO_USADO = "gemini-3-flash-preview"; 

const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// --- 2. SISTEMA DE SEGURIDAD (ANTI-BLOQUEO 429) ---
let lastRequestTime = 0;
const COOLDOWN_MS = 6000; 

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function llamarGeminiSeguro(prompt) {
    const tiempoDesdeUltima = Date.now() - lastRequestTime;
    if (tiempoDesdeUltima < COOLDOWN_MS) {
        await delay(COOLDOWN_MS - tiempoDesdeUltima);
    }

    try {
        console.log(`🚀 AI Request: ${MODELO_USADO}`);
        const response = await ai.models.generateContent({
            model: MODELO_USADO,
            contents: prompt
        });
        lastRequestTime = Date.now();
        
        let text = "";
        if (response.text && typeof response.text === 'function') text = response.text();
        else if (response.text) text = response.text;
        else if (response.candidates?.[0]?.content?.parts?.[0]?.text) text = response.candidates[0].content.parts[0].text;
        
        return text || "";

    } catch (error) {
        console.error("❌ Error AI:", error.message);
        if (error.status === 429 || error.message.includes('429')) {
            throw new Error("⏳ AI Saturada. Reintenta en 1 min.");
        }
        throw error;
    }
}

async function enviarMensajeSeguro(chatId, texto, opciones = {}) {
    try {
        await bot.sendMessage(chatId, texto, { ...opciones, parse_mode: 'Markdown' });
    } catch (error) {
        if (error.message.includes("can't parse entities") || error.message.includes("Bad Request")) {
            await bot.sendMessage(chatId, "⚠️ _Texto plano (Error formato):_\n" + texto, opciones);
        } else {
            console.error("Error Telegram:", error.message);
        }
    }
}

// --- 3. BASE DE DATOS ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Bot V6.3 (Maestro & Auditor): DB Conectada'))
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

    enviarMensajeSeguro(chatId, `🧠 *Tipster AI V6.3 - MAESTRO*\n\n✅ Prompt Maestro (Anti-Trampas)\n✅ Auditoría Contable Estricta\n✅ Coach de Apuestas`, {
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
cron.schedule('0 6 * * *', async () => {
    const config = await Config.findOne({ key: 'adminChatId' });
    if (config) ejecutarReporteSeguro(config.value);
}, { scheduled: true, timezone: "America/Lima" });

async function ejecutarReporteSeguro(chatId) {
    enviarMensajeSeguro(chatId, "☀️ *Iniciando escaneo de valor...*");
    const ligas = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL'];
    let partidos = [];
    const hoy = new Date().toISOString().split('T')[0];

    try {
        for (const code of ligas) {
            await delay(1000); 
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
                headers: footballHeaders, params: { dateFrom: hoy, dateTo: hoy }
            });
            if (res.data.matches) partidos = [...partidos, ...res.data.matches];
        }

        if (partidos.length === 0) return enviarMensajeSeguro(chatId, "☕ Día de descanso. Sin partidos Top.");

        const listaTexto = partidos.slice(0, 15).map(m => `• ${m.homeTeam.name} vs ${m.awayTeam.name} (${m.competition.name})`).join("\n");

        // PROMPT MAESTRO (Versión Resumida para Reporte)
        const prompt = `Actúa como Inversor Deportivo. Analiza hoy:
${listaTexto}

Selecciona SOLO 3 partidos donde el favorito NO vaya a fallar.
Evita partidos trampa.
Formato:
🏆 *LIGA*
⚔️ Partido
💎 Pick: (Ej: Gana Local)
💡 Razón: (Táctica)
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

        for (const m of matches.slice(0, 4)) { 
            const h = m.homeTeam.name;
            const a = m.awayTeam.name;
            const d = m.utcDate.split('T')[0];
            const existe = await Prediccion.exists({ partidoId: `${h}-${a}-${d}` });
            
            const btnText = existe ? "✅ Ver Pick" : "🧠 Analizar IA";
            bot.sendMessage(chatId, `🏟️ *${h}* vs *${a}*`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: btnText, callback_data: `analyze|${h}|${a}|${code}|${d}` }]] }
            });
        }
    } catch (e) { enviarMensajeSeguro(chatId, "❌ Error API Fútbol."); }
}

// --- AQUÍ ESTÁ EL PROMPT MAESTRO ---
async function procesarAnalisisCompleto(chatId, home, away, code, date) {
    const id = `${home}-${away}-${date}`;
    const cached = await Prediccion.findOne({ partidoId: id });
    if (cached) return bot.sendMessage(chatId, `📂 *GUARDADO*\n\n${cached.analisisIA}`, { parse_mode: 'Markdown' });

    bot.sendChatAction(chatId, 'typing');
    enviarMensajeSeguro(chatId, "🧠 *Analizando Riesgo vs Beneficio...*");

    try {
        const racha = await obtenerRacha(code, home, away);
        
        // PROMPT MAESTRO V1: ENFOQUE EN RIESGO Y VALOR
        const prompt = `Eres un Analista de Riesgos Deportivos (No un fanático).
        Partido: ${home} vs ${away}.
        Historial reciente: ${racha}.

        TU OBJETIVO: Encontrar la apuesta más segura matemáticamente.
        REGLAS DE ORO:
        1. Si el visitante es irregular, NO apuestes a su victoria directa, usa "Doble Oportunidad" o "Goles".
        2. Si hay racha de empates, baja el Stake a 10.
        3. Busca valor: ¿Pagan bien por lo probable?
        
        Genera un JSON con este formato exacto:
        {
          "pick": "Mercado exacto (ej: Gana Local, +2.5 Goles)",
          "confianza": "🟢 (Muy seguro), 🟡 (Normal), 🔴 (Arriesgado)",
          "stake": (Numero entre 10 y 50),
          "razon": "Explicación técnica basada en datos, no en corazonadas.",
          "marcador": "Resultado exacto probable",
          "consejo": "Una frase educativa corta sobre por qué elegiste este riesgo."
        }`;

        const rawText = await llamarGeminiSeguro(prompt);
        let datos = extraerDatosDeTexto(rawText); 

        const msgFinal = `🎯 *PICK:* ${datos.pick}
${datos.confianza} *Confianza:* ${getNombreConfianza(datos.confianza)}
💰 *Stake:* S/. ${datos.stake}
⚽ *Marcador:* ${datos.marcador}

💡 *Análisis:* ${datos.razon}

🎓 *Tip del Coach:* _${datos.consejo}_`;

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
    let datos = { pick: "Ver Análisis", confianza: "🟡", stake: 20, razon: "", marcador: "?", consejo: "Gestiona tu bank." };
    try {
        let jsonClean = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        const firstOpen = jsonClean.indexOf('{');
        const lastClose = jsonClean.lastIndexOf('}');
        if (firstOpen !== -1 && lastClose !== -1) {
            jsonClean = jsonClean.substring(firstOpen, lastClose + 1);
            const parsed = JSON.parse(jsonClean);
            datos = { ...datos, ...parsed };
            return datos;
        }
    } catch (e) { console.log("Fallo JSON, usando backup..."); }

    // Backup regex
    const pickMatch = rawText.match(/"?pick"?:\s*"([^"]+)"/i);
    const stakeMatch = rawText.match(/"?stake"?:\s*(\d+)/i);
    const confMatch = rawText.match(/"?confianza"?:\s*"([^"]+)"/i);
    if (pickMatch) datos.pick = pickMatch[1];
    if (stakeMatch) datos.stake = parseInt(stakeMatch[1]);
    if (confMatch) datos.confianza = confMatch[1];
    return datos;
}

// --- OTRAS FUNCIONES ---
async function verPendientes(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' }).sort({ fechaPartido: 1 });
    if (pendientes.length === 0) return enviarMensajeSeguro(chatId, "✅ No tienes apuestas pendientes.");
    let mensaje = `⏳ *PENDIENTES (${pendientes.length})*\n\n`;
    pendientes.forEach((p, i) => {
        mensaje += `*${i + 1}.* ${p.equipoLocal} vs ${p.equipoVisita}\n🎯 ${p.pickIA} (Stake: ${p.montoApostado})\n-------------------\n`;
    });
    mensaje += `\n_Presiona "AUDITAR JUEZ" para cobrar._`;
    enviarMensajeSeguro(chatId, mensaje);
}

async function consultarRadar(chatId, home, away) {
    enviarMensajeSeguro(chatId, "🔍 *Revisando bajas...*");
    try {
        const prompt = `Ultimas noticias: ${home} vs ${away}. ¿Jugadores clave lesionados? Responde en 2 lineas.`;
        const resp = await llamarGeminiSeguro(prompt);
        enviarMensajeSeguro(chatId, `🚨 *RADAR:*\n${resp}`);
    } catch (e) { enviarMensajeSeguro(chatId, "❌ Radar off."); }
}

// --- AUDITORÍA CORREGIDA Y ESTRICTA ---
async function ejecutarAuditoria(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' });
    if (!pendientes.length) return enviarMensajeSeguro(chatId, "✅ Nada que auditar.");

    enviarMensajeSeguro(chatId, `👨‍⚖️ *El Juez está revisando ${pendientes.length} apuestas...*`);
    let ganadas = 0, perdidas = 0;

    for (const p of pendientes) {
        try {
            await delay(2000); 
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${p.liga}/matches`, {
                headers: footballHeaders, params: { status: 'FINISHED', dateFrom: p.fechaPartido, dateTo: p.fechaPartido }
            });
            
            // CORRECCIÓN 1: Búsqueda flexible (evita error si el nombre cambia un poco)
            const match = res.data.matches.find(m => 
                m.homeTeam.name.includes(p.equipoLocal) || p.equipoLocal.includes(m.homeTeam.name)
            );

            if (match && match.score.fullTime.home !== null) {
                // CORRECCIÓN 2: Obtener el resultado REAL exacto
                const golesL = match.score.fullTime.home;
                const golesV = match.score.fullTime.away;
                const marcadorReal = `${golesL}-${golesV}`;

                // CORRECCIÓN 3: Prompt "Contable" (Matemático, no interpretativo)
                const prompt = `Actúa como Contable de Casino. Se estricto.
                Evento: ${p.equipoLocal} vs ${p.equipoVisita}
                Apuesta (Pick): "${p.pickIA}"
                Resultado Final Oficial: ${marcadorReal}
                
                REGLAS DE COBRO:
                1. Si la apuesta es Ganador y hubo EMPATE, el estado es PERDIDA.
                2. Si la apuesta es Over 2.5 y hubo 2 goles o menos, es PERDIDA.
                3. Si el marcador es adverso al pick, es PERDIDA.
                
                Responde ÚNICAMENTE una palabra: "GANADA" o "PERDIDA".`;

                const veredicto = await llamarGeminiSeguro(prompt);
                const estadoFinal = veredicto.toUpperCase().includes('GAN') ? 'GANADA' : 'PERDIDA';
                
                p.estado = estadoFinal;
                p.resultadoReal = marcadorReal;
                await p.save();
                
                // Feedback visual claro
                const icono = estadoFinal === 'GANADA' ? '✅' : '❌';
                bot.sendMessage(chatId, `${icono} *${p.equipoLocal} vs ${p.equipoVisita}*\nPick: ${p.pickIA}\nResultado: ${marcadorReal}\n*${estadoFinal}*`, { parse_mode: 'Markdown' });

                if (estadoFinal === 'GANADA') ganadas++; else perdidas++;
            }
        } catch (e) { console.log("Error auditando partido:", e.message); }
    }
    enviarMensajeSeguro(chatId, `📊 *Resumen Auditoría:*\n✅ Ganadas: ${ganadas}\n❌ Perdidas: ${perdidas}`);
}

async function mostrarBanca(chatId) {
    const historial = await Prediccion.find({ estado: { $ne: 'PENDIENTE' } });
    let saldo = 0;
    historial.forEach(p => {
        if (p.estado === 'GANADA') saldo += (p.montoApostado * 0.80); // Profit neto aprox
        else saldo -= p.montoApostado;
    });
    enviarMensajeSeguro(chatId, `💰 *BANCA NETA:* S/. ${saldo.toFixed(2)}\n_(Calculado sobre Profit neto)_`);
}

async function exportarCSV(chatId) {
    try {
        const data = await Prediccion.find({});
        if (!data.length) return enviarMensajeSeguro(chatId, "📭 Vacío.");
        let csv = "FECHA,PARTIDO,PICK,STAKE,RESULTADO,ESTADO\n";
        data.forEach(p => csv += `${p.fechaPartido},${p.equipoLocal} vs ${p.equipoVisita},"${p.pickIA}",${p.montoApostado},${p.resultadoReal || '-'},${p.estado}\n`);
        const path = `/tmp/History_${Date.now()}.csv`;
        fs.writeFileSync(path, csv);
        await bot.sendDocument(chatId, path);
        fs.unlinkSync(path);
    } catch (e) { enviarMensajeSeguro(chatId, "Error archivo."); }
}

async function obtenerRacha(code, home, away) {
    try {
        await delay(500);
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders, params: { status: 'FINISHED', limit: 10 } // Miramos 10 atrás
        });
        // Filtramos y damos formato simple para ahorrar tokens
        return res.data.matches
            .filter(m => m.homeTeam.name === home || m.awayTeam.name === away)
            .slice(0, 5)
            .map(m => `(${m.utcDate.split('T')[0]}) ${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away} ${m.awayTeam.name}`)
            .join("\n");
    } catch { return "No hay datos recientes."; }
}

function getNombreConfianza(simbolo) {
    if (simbolo.includes('🟢')) return "ALTA (Segura)";
    if (simbolo.includes('🔴')) return "BAJA (Riesgo)";
    return "MEDIA (Valor)";
}

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.end('Bot V6.3 Maestro Online'); }).listen(PORT);