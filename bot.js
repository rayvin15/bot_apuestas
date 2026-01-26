require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
// USAMOS LA LIBRERÍA NUEVA EXACTA DE TU DOCUMENTACIÓN
const { GoogleGenAI } = require("@google/genai");
const http = require('http');
const mongoose = require('mongoose');
const cron = require('node-cron');
const fs = require('fs');

// --- 1. CONFIGURACIÓN E INICIALIZACIÓN ---

// Inicializamos según la nueva guía
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODELO_USADO = "gemini-3-flash-preview"; 

const footballHeaders = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Variables para controlar el tráfico y evitar el Error 429
let lastRequestTime = 0;
const COOLDOWN_MS = 6000; // 6 segundos de espera entre llamadas a la IA

// --- 2. FUNCIONES DE SEGURIDAD (ESCUDOS) ---

// Función de espera (Sleep)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ESCUDO 1: Wrapper para llamar a Gemini sin saturarlo
async function llamarGeminiSeguro(prompt) {
    // Verificamos cuánto tiempo pasó desde la última llamada
    const tiempoDesdeUltima = Date.now() - lastRequestTime;
    
    // Si han pasado menos de 6 segundos, esperamos la diferencia
    if (tiempoDesdeUltima < COOLDOWN_MS) {
        const espera = COOLDOWN_MS - tiempoDesdeUltima;
        console.log(`⏳ Enfriando motores... esperando ${espera}ms`);
        await delay(espera);
    }

    try {
        console.log(`🚀 Enviando petición a modelo: ${MODELO_USADO}`);
        
        // SINTAXIS EXACTA DE LA NUEVA LIBRERÍA @google/genai
        const response = await ai.models.generateContent({
            model: MODELO_USADO,
            contents: prompt
        });

        lastRequestTime = Date.now(); // Actualizamos el reloj

        // Manejo flexible de la respuesta (por si cambia la API preview)
        if (response.text && typeof response.text === 'function') {
            return response.text(); 
        } else if (response.text) {
            return response.text; // Según tu guía, a veces es propiedad directa
        } else if (response.candidates && response.candidates[0]) {
             // Fallback por si la estructura cambia internamente
            return response.candidates[0].content.parts[0].text;
        }
        return "⚠️ Error: La IA no devolvió texto legible.";

    } catch (error) {
        console.error("❌ Error Gemini:", JSON.stringify(error, null, 2));
        
        // Manejo específico del error 429 (Límite excedido)
        if (error.status === 429 || (error.message && error.message.includes('429'))) {
            throw new Error("⏳ La IA está descansando (Límite 429). Intenta en 1 min.");
        }
        // Manejo del error 404 (Si el modelo preview deja de existir mañana)
        if (error.status === 404) {
            throw new Error("❌ El modelo 'gemini-3-flash-preview' no está disponible en esta región o clave.");
        }
        throw new Error("Error interno IA");
    }
}

// ESCUDO 2: Envío seguro a Telegram (Evita el crash 'can't parse entities')
async function enviarMensajeSeguro(chatId, texto, opciones = {}) {
    try {
        // Intentamos enviar con formato Markdown primero
        await bot.sendMessage(chatId, texto, { ...opciones, parse_mode: 'Markdown' });
    } catch (error) {
        // Si falla porque la IA puso un asterisco mal puesto...
        if (error.message.includes("can't parse entities") || error.message.includes("Bad Request")) {
            console.warn(`⚠️ Error de formato Markdown detectado. Reenviando en texto plano.`);
            // Reenviamos SIN parse_mode (Texto plano seguro)
            await bot.sendMessage(chatId, "⚠️ _Nota: Formato simplificado por seguridad_\n\n" + texto, opciones);
        } else {
            console.error("Error enviando mensaje Telegram:", error.message);
        }
    }
}

// --- 3. BASE DE DATOS ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Bot V4.0 (Gemini 3 Ready): DB Conectada'))
    .catch(err => console.error('🔴 Error BD:', err));

const PrediccionSchema = new mongoose.Schema({
    partidoId: { type: String, unique: true },
    equipoLocal: String, equipoVisita: String, fechaPartido: String,
    analisisIA: String, liga: String,
    estado: { type: String, default: 'PENDIENTE' },
    createdAt: { type: Date, default: Date.now }
});
const Prediccion = mongoose.model('Prediccion', PrediccionSchema);
const Config = mongoose.model('Config', new mongoose.Schema({ key: String, value: String }));

// --- 4. LÓGICA DEL BOT ---

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await Config.findOneAndUpdate({ key: 'adminChatId' }, { value: chatId }, { upsert: true });

    enviarMensajeSeguro(chatId, `🤖 *Tipster AI - Powered by Gemini 3 Preview*
    
Sistema listo. He activado protecciones contra caídas.
Ligas Activas: 🇪🇸 🏴󠁧󠁢󠁥󠁮󠁧󠁿 🇮🇹 🇩🇪`, {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇮🇹 Serie A', callback_data: 'comp_SA' }, { text: '🇩🇪 Bundesliga', callback_data: 'comp_BL1' }],
                [{ text: '📊 Resultados', callback_data: 'ver_resumen' }]
            ]
        }
    });
});

// CRON JOB (6:30 AM)
cron.schedule('30 6 * * *', async () => {
    const config = await Config.findOne({ key: 'adminChatId' });
    if (config) ejecutarReporteMatutino(config.value);
}, { scheduled: true, timezone: "America/Lima" });

async function ejecutarReporteMatutino(chatId) {
    enviarMensajeSeguro(chatId, "☀️ *Buenos días. Consultando Gemini 3...*");
    // Lógica simplificada para el ejemplo
    try {
        const prompt = "Dime 2 frases motivadoras cortas para apostadores deportivos.";
        const respuesta = await llamarGeminiSeguro(prompt);
        enviarMensajeSeguro(chatId, `🗞️ *INFORME DIARIO*\n\n${respuesta}`);
    } catch (e) {
        enviarMensajeSeguro(chatId, "❌ Error reporte: " + e.message);
    }
}

// EVENTOS
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data.startsWith('comp_')) await listarPartidos(chatId, data.split('_')[1]);
    else if (data.startsWith('analyze|')) {
        const [_, home, away, code, date] = data.split('|');
        await procesarAnalisis(chatId, home, away, code, date);
    }
    else if (data === 'ver_resumen') {
        enviarMensajeSeguro(chatId, "Función de resumen en construcción.");
    }
    try { await bot.answerCallbackQuery(query.id); } catch(e){}
});

async function listarPartidos(chatId, code) {
    bot.sendChatAction(chatId, 'typing');
    try {
        // Pausa preventiva para no saturar API Futbol
        await delay(1000);
        
        const hoy = new Date().toISOString().split('T')[0];
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders,
            params: { dateFrom: hoy, dateTo: hoy, status: 'SCHEDULED' }
        });

        const matches = res.data.matches || [];
        if (matches.length === 0) return enviarMensajeSeguro(chatId, "⚠️ No hay partidos hoy en esta liga.");

        // Solo mostramos 3 partidos para no saturar al usuario
        for (const m of matches.slice(0, 3)) {
            const h = m.homeTeam.name;
            const a = m.awayTeam.name;
            const d = m.utcDate.split('T')[0];
            
            const existe = await Prediccion.exists({ partidoId: `${h}-${a}-${d}` });
            
            bot.sendMessage(chatId, `⚽ *${h}* vs *${a}*`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ 
                    text: existe ? "✅ Ver Guardado" : "🧠 Analizar (Gemini 3)", 
                    callback_data: `analyze|${h}|${a}|${code}|${d}` 
                }]] }
            });
        }
    } catch (e) {
        console.error(e);
        enviarMensajeSeguro(chatId, "❌ Error al conectar con Football API.");
    }
}

async function procesarAnalisis(chatId, home, away, code, date) {
    const idUnico = `${home}-${away}-${date}`;
    const cached = await Prediccion.findOne({ partidoId: idUnico });
    
    if (cached) return enviarMensajeSeguro(chatId, `📂 *ANÁLISIS GUARDADO*\n\n${cached.analisisIA}`);

    bot.sendChatAction(chatId, 'typing');
    enviarMensajeSeguro(chatId, "🧠 *Gemini 3 está pensando...* (Espera 5 seg)");

    try {
        // Obtenemos datos previos (Racha)
        const racha = await obtenerRacha(code, home, away);
        
        const prompt = `Actúa como Tipster Pro.
        Partido: ${home} vs ${away}.
        Datos previos: ${racha}.
        
        Dame un análisis MUY CORTO Y DIRECTO (Max 4 lineas).
        Formato:
        🎯 PICK: [Tu predicción]
        💰 CONF: [Alta/Media/Baja]
        💡 PORQUÉ: [1 frase]
        
        NO uses negritas ni asteriscos en tu respuesta, solo texto plano.`; 
        // ^ Le pedimos texto plano para minimizar errores de Telegram

        const texto = await llamarGeminiSeguro(prompt);

        const nueva = new Prediccion({
            partidoId: idUnico,
            equipoLocal: home, equipoVisita: away, fechaPartido: date,
            analisisIA: texto, liga: code
        });
        await nueva.save();

        enviarMensajeSeguro(chatId, `⚡ *ANÁLISIS GEMINI 3*\n\n${texto}`);

    } catch (e) {
        enviarMensajeSeguro(chatId, "⚠️ " + e.message);
    }
}

async function obtenerRacha(code, home, away) {
    try {
        await delay(500); // Pequeña pausa
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
            headers: footballHeaders, params: { status: 'FINISHED', limit: 5 }
        });
        // Filtro básico
        const rel = res.data.matches.filter(m => m.homeTeam.name === home || m.awayTeam.name === away);
        return rel.map(m => `${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away} ${m.awayTeam.name}`).join(", ");
    } catch (e) { return "Datos históricos no disponibles"; }
}

// SERVER HTTP (Para Render)
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot Online - Gemini 3 Preview Active');
}).listen(PORT, () => console.log(`🌐 Servidor en puerto ${PORT}`));