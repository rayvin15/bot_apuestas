import 'dotenv/config'; // Forma moderna de llamar a dotenv
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { GoogleGenAI } from "@google/genai";
import http from 'http';
import mongoose from 'mongoose';
import fs from 'fs';

// --- 1. CONFIGURACIÓN ---
// Inicialización del nuevo SDK (toma la API Key de process.env automáticamente)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Usamos el modelo que te funcionó en la prueba
const MODELO_USADO = "gemini-2.5-flash"; 

const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// --- 2. SISTEMA DE SEGURIDAD (ANTI-BLOQUEO) ---
let lastRequestTime = 0;
// Gemini 2.5 es rápido, dejamos 4 segs por seguridad
const COOLDOWN_MS = 4000; 

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function llamarGeminiSeguro(prompt) {
    const tiempoDesdeUltima = Date.now() - lastRequestTime;
    if (tiempoDesdeUltima < COOLDOWN_MS) {
        await delay(COOLDOWN_MS - tiempoDesdeUltima);
    }

    try {
        console.log(`🚀 Consultando a ${MODELO_USADO}...`);
        
        const response = await ai.models.generateContent({
            model: MODELO_USADO,
            contents: prompt
        });

        lastRequestTime = Date.now();
        
        // EN EL NUEVO SDK: response.text suele ser una propiedad directa, 
        // pero validamos por si acaso viene como función.
        let text = "";
        if (response.text) {
             text = typeof response.text === 'function' ? response.text() : response.text;
        } else {
             // Fallback por si la estructura cambia levemente
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
            // Si falla el Markdown, enviamos texto plano
            await bot.sendMessage(chatId, "⚠️ _Formato simple:_\n" + texto, opciones);
        } catch (e) { console.error("Error Telegram Crítico:", e.message); }
    }
}

// --- 3. BASE DE DATOS ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log(`🟢 Bot Activo con ${MODELO_USADO} (ES Modules)`))
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

// Verificamos si el modelo ya existe para evitar error de recompilación
const Prediccion = mongoose.models.Prediccion || mongoose.model('Prediccion', PrediccionSchema);
const Config = mongoose.models.Config || mongoose.model('Config', new mongoose.Schema({ key: String, value: String }));

// --- 4. MENÚ PRINCIPAL ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await Config.findOneAndUpdate({ key: 'adminChatId' }, { value: chatId }, { upsert: true });

    enviarMensajeSeguro(chatId, `🧠 *Tipster AI 2026*\n🤖 Modelo: ${MODELO_USADO}\n🚀 Estado: Online`, {
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

// --- 5. MANEJO DE BOTONES ---
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
        if (matches.length === 0) return enviarMensajeSeguro(chatId, "⚠️ Liga sin partidos hoy.");

        // Limitamos a 8 partidos para no saturar el chat
        for (const m of matches.slice(0, 8)) { 
            const h = m.homeTeam.name;
            const a = m.awayTeam.name;
            const d = m.utcDate.split('T')[0];
            const existe = await Prediccion.exists({ partidoId: `${h}-${a}-${d}` });
            
            const btnText = existe ? "✅ Ver Pick Guardado" : "🧠 Analizar con IA";
            
            await bot.sendMessage(chatId, `🏟️ *${h}* vs *${a}*`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: btnText, callback_data: `analyze|${h}|${a}|${code}|${d}` }]] }
            });
            await delay(400); 
        }
    } catch (e) { enviarMensajeSeguro(chatId, "❌ Error API Fútbol."); }
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
    enviarMensajeSeguro(chatId, "🧠 *Gemini 2.5 Analizando estrategia...*");

    try {
        const racha = await obtenerRacha(code, home, away);
        
        const prompt = `Actúa como el mejor Analista de Apuestas Deportivas del mundo.
        Partido: ${home} vs ${away}.
        Datos recientes: ${racha}.

        Tu tarea es generar un JSON puro con la mejor apuesta posible (Value Bet).
        Formato JSON requerido:
        {"pick":"nombre de la apuesta","confianza":"🟢/🟡/🔴","stake": (numero del 1 al 20),"analisis":"explicacion breve","marcador":"resultado exacto probable","consejo":"consejo de gestion"}
        
        IMPORTANTE: Solo devuelve el JSON, sin bloques de código markdown.`;

        const rawText = await llamarGeminiSeguro(prompt);
        let datos = extraerDatosDeTexto(rawText); 
        
        // Validación básica
        if (!datos.pick || datos.pick === "Error lectura") {
             datos.analisis = rawText; // Si falla el JSON, mostramos el texto crudo
             datos.pick = "Ver Análisis";
        }

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

    } catch (e) { enviarMensajeSeguro(chatId, "❌ Error Análisis: " + e.message); }
}

function extraerDatosDeTexto(rawText) {
    let datos = { pick: "Error lectura", confianza: "🟡", stake: 0, analisis: "", marcador: "?", consejo: "" };
    try {
        // Limpiamos los bloques de código que la IA a veces pone
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

// --- UTILS ---
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
    enviarMensajeSeguro(chatId, "🔍 *Escaneando noticias de última hora...*");
    try {
        const prompt = `Responde en máximo 30 palabras: ¿Hay bajas o lesiones clave confirmadas para el partido ${home} vs ${away} hoy?`;
        const resp = await llamarGeminiSeguro(prompt);
        enviarMensajeSeguro(chatId, `🚨 *RADAR DE BAJAS:*\n${resp}`);
    } catch (e) { enviarMensajeSeguro(chatId, "❌ Radar no disponible."); }
}

async function ejecutarAuditoria(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' });
    if (!pendientes.length) return enviarMensajeSeguro(chatId, "✅ Todo auditado.");

    enviarMensajeSeguro(chatId, `👨‍⚖️ *Verificando ${pendientes.length} partidos...*`);
    let ganadas = 0, perdidas = 0;

    for (const p of pendientes) {
        try {
            await delay(2000); 
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${p.liga}/matches`, {
                headers: footballHeaders, 
                params: { status: 'FINISHED', dateFrom: p.fechaPartido, dateTo: p.fechaPartido }
            });
            
            // Buscamos el partido exacto
            const match = res.data.matches.find(m => m.homeTeam.name === p.equipoLocal && m.awayTeam.name === p.equipoVisita);

            if (match && match.score.fullTime.home !== null) {
                const marcadorReal = `${match.score.fullTime.home}-${match.score.fullTime.away}`;
                
                // Le preguntamos a la IA si se ganó
                const prompt = `Actúa como Juez de apuestas.
                Apuesta realizada: "${p.pickIA}".
                Resultado Final: ${match.homeTeam.name} ${marcadorReal} ${match.awayTeam.name}.
                
                Responde SOLO con una palabra: "GANADA" o "PERDIDA".`;
                
                const veredicto = await llamarGeminiSeguro(prompt);
                const estadoFinal = veredicto.toUpperCase().includes('GAN') ? 'GANADA' : 'PERDIDA';
                
                p.estado = estadoFinal;
                p.resultadoReal = marcadorReal;
                await p.save();
                
                await enviarMensajeSeguro(chatId, `${estadoFinal === 'GANADA'?'✅':'❌'} *${p.equipoLocal} vs ${p.equipoVisita}*\nResultado: ${marcadorReal}`);
                
                if (estadoFinal === 'GANADA') ganadas++; else perdidas++;
            }
        } catch (e) { console.log(`Skip audit: ${p.equipoLocal} vs ${p.equipoVisita}`); }
    }
    enviarMensajeSeguro(chatId, `📊 *Resumen Auditoría:* +${ganadas} Ganadas / -${perdidas} Perdidas`);
}

async function mostrarBanca(chatId) {
    const historial = await Prediccion.find({ estado: { $ne: 'PENDIENTE' } });
    let saldo = 0;
    historial.forEach(p => {
        // Cálculo simple: Si gana sumamos (Stake * 0.8 de ganancia neta aprox), si pierde restamos Stake
        if (p.estado === 'GANADA') saldo += (p.montoApostado * 0.85); 
        else saldo -= p.montoApostado;
    });
    
    const emoji = saldo >= 0 ? '🤑' : '📉';
    enviarMensajeSeguro(chatId, `💰 *BANCA ACTUAL*\n\nSaldo Neto: S/. ${saldo.toFixed(2)} ${emoji}\nApuestas cerradas: ${historial.length}`);
}

async function exportarCSV(chatId) {
    try {
        const data = await Prediccion.find({});
        let csv = "FECHA,PARTIDO,PICK,RESULTADO,ESTADO\n";
        data.forEach(p => csv += `${p.fechaPartido},${p.equipoLocal} vs ${p.equipoVisita},"${p.pickIA}",${p.resultadoReal},${p.estado}\n`);
        
        const path = `./history_export.csv`;
        fs.writeFileSync(path, csv);
        await bot.sendDocument(chatId, path);
    } catch (e) { enviarMensajeSeguro(chatId, "Error al exportar archivo."); }
}

async function obtenerRacha(code, home, away) {
    try {
        await delay(500);
        // Traemos últimos partidos finalizados de la liga
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders, params: { status: 'FINISHED', limit: 20 } 
        });
        
        // Filtramos solo los que involucran a nuestros equipos
        const relevantes = res.data.matches
            .filter(m => m.homeTeam.name === home || m.awayTeam.name === home || m.homeTeam.name === away || m.awayTeam.name === away)
            .slice(0, 5)
            .map(m => `${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away} ${m.awayTeam.name}`)
            .join(" | ");
            
        return relevantes || "Sin datos recientes";
    } catch { return "No se pudo obtener racha reciente."; }
}

function getNombreConfianza(simbolo) {
    if (simbolo && simbolo.includes('🟢')) return "ALTA";
    if (simbolo && simbolo.includes('🔴')) return "BAJA";
    return "MEDIA";
}

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.end('Bot V7.0 (ESM) Online'); }).listen(PORT);