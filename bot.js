import 'dotenv/config'; 
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { GoogleGenAI } from "@google/genai";
import http from 'http';
import mongoose from 'mongoose';
import fs from 'fs';

// --- 1. CONFIGURACIÓN Y VERIFICACIÓN ---
console.log("--- INICIANDO BOT V8.2 (IA AVANZADA + CONTEXTO BD) ---");
console.log("🔑 API Key Fútbol:", process.env.FOOTBALL_API_KEY ? "✅ CARGADA" : "❌ NO DETECTADA");
console.log("🔑 API Key Gemini:", process.env.GEMINI_API_KEY ? "✅ CARGADA" : "❌ NO DETECTADA");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODELO_USADO = "gemini-2.5-flash"; 
const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };

// --- 2. INICIALIZACIÓN DEL BOT CON TOLERANCIA A FALLOS ---
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { 
    polling: {
        interval: 300,      
        autoStart: true,
        params: { timeout: 10 } 
    } 
});

const partidosCache = new Map(); 

// --- 3. MANEJO DE ERRORES DE CONEXIÓN ---
bot.on('polling_error', (error) => {
    console.log(`⚠️ Red inestable (${error.code || error.message}). Reintentando...`);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Error Inesperado (No Fatal):', err.message);
});

// --- 4. SISTEMA DE SEGURIDAD (ANTI-BLOQUEO GEMINI) ---
let lastRequestTime = 0;
const COOLDOWN_MS = 4000; 
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function llamarGeminiSeguro(prompt) {
    const tiempoDesdeUltima = Date.now() - lastRequestTime;
    if (tiempoDesdeUltima < COOLDOWN_MS) {
        await delay(COOLDOWN_MS - tiempoDesdeUltima);
    }

    try {
        console.log(`🚀 Consultando a ${MODELO_USADO}...`);
        
        const peticionIA = ai.models.generateContent({
            model: MODELO_USADO,
            contents: prompt
        });

        const timeoutError = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("La IA tardó demasiado (Timeout)")), 45000)
        );

        const response = await Promise.race([peticionIA, timeoutError]);

        lastRequestTime = Date.now();
        
        let text = "";
        if (response.text) {
             text = typeof response.text === 'function' ? response.text() : response.text;
        } else {
             text = JSON.stringify(response); 
        }
        return text;

    } catch (error) {
        console.error("❌ Error AI:", error.message);
        if (error.message.includes('429') || error.message.includes('Quota')) {
            throw new Error("⏳ Cuota agotada momentáneamente (Error 429).");
        }
        throw error;
    }
}

async function enviarMensajeSeguro(chatId, texto, opciones = {}) {
    try {
        await bot.sendMessage(chatId, texto, { ...opciones, parse_mode: 'Markdown' });
    } catch (error) {
        try {
            await bot.sendMessage(chatId, "⚠️ _Formato simple:_\n" + texto, opciones);
        } catch (e) { console.error("Error Telegram Crítico:", e.message); }
    }
}

// --- 5. BASE DE DATOS ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log(`🟢 Mongo Conectado.`))
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

const Prediccion = mongoose.models.Prediccion || mongoose.model('Prediccion', PrediccionSchema);
const Config = mongoose.models.Config || mongoose.model('Config', new mongoose.Schema({ key: String, value: String }));

// --- NUEVA FUNCIÓN: RECUPERAR HISTORIAL DE LA BD ---
async function obtenerHistorialBD(home, away) {
    try {
        const historial = await Prediccion.find({
            $or: [
                { equipoLocal: home }, { equipoVisita: home },
                { equipoLocal: away }, { equipoVisita: away }
            ],
            estado: { $in: ['GANADA', 'PERDIDA'] }
        }).sort({ fechaPartido: -1 }).limit(8);

        if (historial.length === 0) return "No hay registro previo de apuestas para estos equipos en la BD.";

        let resumen = "";
        historial.forEach(p => {
            resumen += `- Partido: ${p.equipoLocal} vs ${p.equipoVisita} | Pick: ${p.pickIA} | Estado: ${p.estado} | Marcador Real: ${p.resultadoReal}\n`;
        });
        return resumen;
    } catch (e) {
        console.error("Error leyendo BD para historial:", e.message);
        return "Error al leer historial.";
    }
}

// --- 6. COMANDOS Y MENÚS ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await Config.findOneAndUpdate({ key: 'adminChatId' }, { value: chatId }, { upsert: true });

    enviarMensajeSeguro(chatId, `🧠 *Tipster AI 2026 PRO*\n🤖 Modelo: ${MODELO_USADO}\n🛡️ Filtro de Valor: Activado`, {
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

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    bot.answerCallbackQuery(query.id).catch(() => {}); 

    try {
        if (data.startsWith('comp_')) {
            await listarPartidos(chatId, data.split('_')[1]);
        }
        else if (data.startsWith('an|')) {
            const matchId = data.split('|')[1];
            const info = partidosCache.get(matchId);

            if (info) {
                await procesarAnalisisCompleto(chatId, info.home, info.away, info.code, info.date);
            } else {
                await enviarMensajeSeguro(chatId, "⚠️ La sesión expiró. Pide la lista de nuevo.");
            }
        }
        else if (data.startsWith('radar|')) {
            const [_, home, away] = data.split('|');
            await consultarRadar(chatId, home, away);
        }
        else if (data === 'ver_pendientes') await verPendientes(chatId);
        else if (data === 'ver_auditoria') await ejecutarAuditoria(chatId);
        else if (data === 'ver_banca') await mostrarBanca(chatId);
        else if (data === 'exportar_excel') await exportarCSV(chatId);

    } catch (e) {
        console.error("Error procesando botón:", e.message);
    }
});

// --- 7. LÓGICA DE PARTIDOS ---
async function listarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        await delay(500); 
        
        const fechaHoy = new Date();
        const fechaFuturo = new Date();
        fechaFuturo.setDate(fechaHoy.getDate() + 3);

        const sHoy = fechaHoy.toISOString().split('T')[0];
        const sFuturo = fechaFuturo.toISOString().split('T')[0];

        console.log(`📡 Buscando partidos ${code} entre ${sHoy} y ${sFuturo}`);

        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders, 
            params: { dateFrom: sHoy, dateTo: sFuturo, status: 'SCHEDULED' }
        });

        const matches = res.data.matches || [];
        
        if (matches.length === 0) {
            return enviarMensajeSeguro(chatId, `⚠️ No hay partidos de ${code} hasta el ${sFuturo}.`);
        }

        for (const m of matches.slice(0, 8)) { 
            const h = m.homeTeam.name;
            const a = m.awayTeam.name;
            const d = m.utcDate.split('T')[0];
            
            partidosCache.set(String(m.id), { home: h, away: a, date: d, code: code });

            const existe = await Prediccion.exists({ partidoId: `${h}-${a}-${d}` });
            const btnText = existe ? "✅ Ver Pick" : "🧠 Analizar BD+IA";
            
            await bot.sendMessage(chatId, `🏟️ *${h}* vs *${a}*\n📅 ${d}`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: btnText, callback_data: `an|${m.id}` }]] }
            });
            
            await delay(1200); 
        }
    } catch (e) { 
        console.error("🔴 Error API Fútbol:", e.message);
        enviarMensajeSeguro(chatId, "❌ No se pudo obtener la lista. Intenta en un minuto.");
    }
}

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
    enviarMensajeSeguro(chatId, "🧠 *Cruzando datos con la BD y generando análisis...*");

    try {
        const racha = await obtenerRacha(code, home, away);
        const historialBD = await obtenerHistorialBD(home, away);
        
        const prompt = `Actúa como un Analista Profesional de Trading Deportivo con 20 años de experiencia. Tu objetivo no es "adivinar" quién gana, sino encontrar "Value Bets".

DATOS CLAVE DEL PARTIDO:
- Encuentro: ${home} vs ${away}
- Liga: ${code}
- Fecha: ${date}

CONTEXTO HISTÓRICO (RACHA RECIENTE):
${racha}

HISTORIAL DE RENDIMIENTO EN LA BASE DE DATOS:
${historialBD}
(Nota: Este historial indica cómo hemos fallado o acertado antes apostando a estos equipos. Úsalo para no repetir errores de juicio y ajustar tu nivel de confianza).

INSTRUCCIONES DE ANÁLISIS:
1. ANÁLISIS DE ESTILOS: Compara cómo el estilo táctico del local afecta al visitante basado en las rachas.
2. FILTRO DE PESIMISMO: Dime por qué esta apuesta PODRÍA PERDERSE.
3. CRITERIO DE "NO BET": Si los datos son contradictorios o no hay una ventaja estadística clara, tu recomendación DEBE ser "PASAR / NO VALOR" con confianza 🔴 y Stake 0.
4. AJUSTE DE STAKE: Escala de 1 a 10. Solo usa Stake 8-10 si la probabilidad es abrumadora.

REQUISITOS DEL FORMATO DE SALIDA (JSON PURO):
Responde ÚNICAMENTE con un objeto JSON. No incluyas explicaciones fuera del JSON, ni bloques de código (ni \`\`\`json).
{
  "pick": "Escribe aquí la apuesta. Si no es clara, pon 'PASAR / NO VALOR'",
  "confianza": "🟢, 🟡 o 🔴",
  "stake": (un número del 0 al 10),
  "analisis": "Resumen técnico de la ventaja estadística (max 250 caracteres).",
  "marcador": "Resultado exacto más probable.",
  "consejo": "Advertencia específica sobre qué factor externo podría arruinar el pick."
}`;

        const rawText = await llamarGeminiSeguro(prompt);
        let datos = extraerDatosDeTexto(rawText); 
        
        if (!datos.pick || datos.pick === "Error lectura") {
             datos.analisis = rawText; 
             datos.pick = "PASAR / VER ANÁLISIS";
             datos.stake = 0;
             datos.confianza = "🔴";
        }

        const msgFinal = `🎯 *PICK:* ${datos.pick}
${datos.confianza} *Confianza:* ${getNombreConfianza(datos.confianza)}
💰 *Stake:* ${datos.stake}/10
⚽ *Marcador:* ${datos.marcador}

💡 *Análisis:* ${datos.analisis}

⚠️ *Advertencia:* _${datos.consejo}_`;

        const nueva = new Prediccion({
            partidoId: id, equipoLocal: home, equipoVisita: away, fechaPartido: date,
            analisisIA: msgFinal, pickIA: datos.pick, liga: code,
            montoApostado: datos.stake, confianza: datos.confianza
        });
        await nueva.save();

        bot.sendMessage(chatId, msgFinal, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "🔍 Últimas Noticias", callback_data: `radar|${home}|${away}` }]] }
        });

    } catch (e) { enviarMensajeSeguro(chatId, "❌ Error Análisis: " + e.message); }
}

function extraerDatosDeTexto(rawText) {
    let datos = { pick: "Error lectura", confianza: "🟡", stake: 0, analisis: "", marcador: "?", consejo: "" };
    try {
        let jsonClean = typeof rawText === 'string' ? rawText.replace(/```json/g, '').replace(/```/g, '').trim() : "";
        const firstOpen = jsonClean.indexOf('{');
        const lastClose = jsonClean.lastIndexOf('}');
        
        if (firstOpen !== -1 && lastClose !== -1) {
            jsonClean = jsonClean.substring(firstOpen, lastClose + 1);
            datos = { ...datos, ...JSON.parse(jsonClean) };
        }
    } catch (e) { console.log("JSON Parse Error, usando texto plano."); }
    return datos;
}

// --- UTILS ADICIONALES ---
async function verPendientes(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' }).sort({ fechaPartido: 1 });
    if (pendientes.length === 0) return enviarMensajeSeguro(chatId, "✅ No tienes apuestas pendientes.");
    
    let mensaje = `⏳ *PENDIENTES (${pendientes.length})*\n\n`;
    pendientes.forEach((p, i) => {
        mensaje += `*${i + 1}.* ${p.equipoLocal} vs ${p.equipoVisita}\n🎯 ${p.pickIA} (Stake: ${p.montoApostado})\n\n`;
    });
    enviarMensajeSeguro(chatId, mensaje);
}

async function consultarRadar(chatId, home, away) {
    enviarMensajeSeguro(chatId, "🔍 *Escaneando radar del partido...*");
    try {
        const prompt = `Responde en máximo 30 palabras: ¿Hay información de bajas, lesiones clave o contexto crítico para el partido ${home} vs ${away} hoy?`;
        const resp = await llamarGeminiSeguro(prompt);
        enviarMensajeSeguro(chatId, `🚨 *RADAR:* \n${resp}`);
    } catch (e) { enviarMensajeSeguro(chatId, "❌ Radar no disponible."); }
}

async function ejecutarAuditoria(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' });
    if (!pendientes.length) return enviarMensajeSeguro(chatId, "✅ Todo auditado.");

    enviarMensajeSeguro(chatId, `👨‍⚖️ *Verificando ${pendientes.length} partidos...*`);
    let ganadas = 0, perdidas = 0, anuladas = 0;

    for (const p of pendientes) {
        try {
            await delay(2000); 
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${p.liga}/matches`, {
                headers: footballHeaders, 
                params: { status: 'FINISHED', dateFrom: p.fechaPartido, dateTo: p.fechaPartido }
            });
            
            const match = res.data.matches.find(m => m.homeTeam.name === p.equipoLocal && m.awayTeam.name === p.equipoVisita);

            if (match && match.score.fullTime.home !== null) {
                // Si la IA mandó a "PASAR / NO VALOR" (Stake 0), no lo contamos como pérdida ni ganancia
                if (p.montoApostado === 0 || p.pickIA.includes("PASAR")) {
                    p.estado = 'ANULADA';
                    p.resultadoReal = `${match.score.fullTime.home}-${match.score.fullTime.away}`;
                    await p.save();
                    anuladas++;
                    continue;
                }

                const marcadorReal = `${match.score.fullTime.home}-${match.score.fullTime.away}`;
                const prompt = `Actúa como Juez. Apuesta: "${p.pickIA}". Resultado: ${match.homeTeam.name} ${marcadorReal} ${match.awayTeam.name}. Responde SOLO con una palabra: "GANADA" o "PERDIDA".`;
                
                const veredicto = await llamarGeminiSeguro(prompt);
                const estadoFinal = veredicto.toUpperCase().includes('GAN') ? 'GANADA' : 'PERDIDA';
                
                p.estado = estadoFinal;
                p.resultadoReal = marcadorReal;
                await p.save();
                
                await enviarMensajeSeguro(chatId, `${estadoFinal === 'GANADA'?'✅':'❌'} *${p.equipoLocal} vs ${p.equipoVisita}*\nResultado: ${marcadorReal}`);
                if (estadoFinal === 'GANADA') ganadas++; else perdidas++;
            }
        } catch (e) { console.log(`Skip audit: ${p.equipoLocal}`); }
    }
    enviarMensajeSeguro(chatId, `📊 *Resumen Auditoría:*\n✅ +${ganadas} Ganadas\n❌ -${perdidas} Perdidas\n⚪ ${anuladas} Evitadas (No Bet)`);
}

async function mostrarBanca(chatId) {
    const historial = await Prediccion.find({ estado: { $ne: 'PENDIENTE' } });
    let saldo = 0;
    historial.forEach(p => {
        if (p.estado === 'GANADA') saldo += (p.montoApostado * 0.85); // Calculando 85% de ganancia aprox.
        else if (p.estado === 'PERDIDA') saldo -= p.montoApostado;
    });
    const emoji = saldo >= 0 ? '🤑' : '📉';
    enviarMensajeSeguro(chatId, `💰 *BANCA ACTUAL*\n\nSaldo Neto (Stakes): ${saldo.toFixed(2)} U ${emoji}\nApuestas evaluadas: ${historial.length}`);
}

async function exportarCSV(chatId) {
    try {
        const data = await Prediccion.find({});
        let csv = "FECHA,PARTIDO,PICK,RESULTADO,ESTADO,STAKE\n";
        data.forEach(p => csv += `${p.fechaPartido},${p.equipoLocal} vs ${p.equipoVisita},"${p.pickIA}",${p.resultadoReal},${p.estado},${p.montoApostado}\n`);
        const path = `./history_export.csv`;
        fs.writeFileSync(path, csv);
        await bot.sendDocument(chatId, path);
    } catch (e) { enviarMensajeSeguro(chatId, "Error al exportar."); }
}

async function obtenerRacha(code, home, away) {
    try {
        await delay(500);
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders, params: { status: 'FINISHED', limit: 20 } 
        });
        return res.data.matches
            .filter(m => m.homeTeam.name === home || m.awayTeam.name === home || m.homeTeam.name === away || m.awayTeam.name === away)
            .slice(0, 5)
            .map(m => `${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away} ${m.awayTeam.name}`)
            .join(" | ") || "Sin datos recientes";
    } catch { return "No se pudo obtener racha reciente."; }
}

function getNombreConfianza(simbolo) {
    if (simbolo && (simbolo.includes('🟢') || simbolo.toUpperCase() === 'ALTA')) return "ALTA";
    if (simbolo && (simbolo.includes('🔴') || simbolo.toUpperCase() === 'BAJA')) return "BAJA (O NO BET)";
    return "MEDIA";
}

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.end('Bot V8.2 Online'); }).listen(PORT);