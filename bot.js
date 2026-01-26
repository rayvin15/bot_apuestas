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

    bot.sendMessage(chatId, "⚽ *Tipster IA V3.2 - Suite Profesional*\nTu ID ha sido vinculado para los reportes de las 6:30 AM.", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 La Liga', callback_data: 'comp_PD' }, { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇫🇷 Ligue 1', callback_data: 'comp_FL1' }, { text: '🏆 Champions', callback_data: 'comp_CL' }],
                [{ text: '📊 AUDITAR', callback_data: 'ver_resumen' }, { text: '💰 BANCO', callback_data: 'ver_banco' }],
                [{ text: '📥 EXPORTAR', callback_data: 'exportar_excel' }, { text: '🚨 PROBAR ALARMA', callback_data: 'test_alarma' }]
            ]
        }
    });
});

// --- 4. CRON JOB: REFORZADO (6:30 AM PERÚ) ---
cron.schedule('30 6 * * *', async () => {
    const config = await Config.findOne({ key: 'adminChatId' });
    if (config) {
        ejecutarReporteMatutino(config.value);
    } else {
        console.log("⚠️ No hay ChatID en la BD para el reporte.");
    }
}, { scheduled: true, timezone: "America/Lima" });

async function ejecutarReporteMatutino(chatId) {
    bot.sendMessage(chatId, "⏰ *Generando informe matutino de hoy...*", { parse_mode: 'Markdown' });
    const ligas = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL', 'BSA']; 
    let partidosHoy = [];
    const hoy = new Date().toISOString().split('T')[0];
    
    try {
        for (const code of ligas) {
            const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, {
                headers: footballHeaders,
                params: { dateFrom: hoy, dateTo: hoy }
            });
            if (res.data.matches && res.data.matches.length > 0) {
                partidosHoy = [...partidosHoy, ...res.data.matches.map(m => ({
                    h: m.homeTeam.name, a: m.awayTeam.name, l: m.competition.name
                }))];
            }
        }

        if (partidosHoy.length === 0) {
            return bot.sendMessage(chatId, "☕ *INFORME MATUTINO*\nNo hay partidos destacados para hoy en las ligas seguidas.", { parse_mode: 'Markdown' });
        }

        const listaPartidos = partidosHoy.map(m => `• ${m.l}: ${m.h} vs ${m.a}`).join("\n");
        const promptDia = `Tipster Pro. Analiza estos partidos:\n${listaPartidos}\n\nSelecciona los 2 más seguros (Fija y Segura). Formato Markdown.`;

        const response = await ai.models.generateContent({
            model: "gemini-2.0-flash-exp",
            contents: promptDia
        });

        bot.sendMessage(chatId, `🗞️ *INFORME MATUTINO (06:30 AM)*\n\n${response.text}`, { parse_mode: 'Markdown' });

    } catch (e) {
        console.error("Error en reporte matutino:", e);
        bot.sendMessage(chatId, "❌ Error al generar el reporte: " + e.message);
    }
}

// --- 5. MANEJADOR DE EVENTOS ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data === 'ver_resumen') await verificarResultados(chatId);
    else if (data === 'ver_banco') await mostrarBanco(chatId);
    else if (data === 'exportar_excel') await exportarDatos(chatId);
    else if (data === 'test_alarma') await ejecutarReporteMatutino(chatId);
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
        limite.setDate(limite.getDate() + 14);
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
        bot.sendMessage(chatId, "❌ Error API."); 
    }
}

async function procesarAnalisis(chatId, home, away, code, date) {
    const idUnico = `${home}-${away}-${date}`;
    const cached = await Prediccion.findOne({ partidoId: idUnico });
    if (cached) return bot.sendMessage(chatId, `📂 *GUARDADO:*\n\n${cached.analisisIA}`, { parse_mode: 'Markdown' });

    bot.sendChatAction(chatId, 'typing');
    try {
        const racha = await obtenerRacha(code);
        const prompt = `Tipster Experto. Analiza ${home} vs ${away} (${code}). Racha reciente: ${racha}. 

Proporciona:
1. Nivel de confianza: 🟢 (alta), 🟡 (media), 🔴 (baja)
2. PICK recomendado (victoria local, empate, victoria visitante, over/under, etc.)
3. INVERSIÓN sugerida en S/. (entre 10 y 100)
4. MARCADOR probable
5. Justificación breve

Formato Markdown.`;

        const response = await ai.models.generateContent({
            model: "gemini-2.0-flash-exp",
            contents: prompt
        });
        
        const texto = response.text;
        
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
        
        bot.sendMessage(chatId, `📝 *NUEVO ANÁLISIS:*\n\n${texto}`, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "🔍 Radar Clave", callback_data: `lineup|${home}|${away}` }]] }
        });
    } catch (e) { 
        console.error("Error procesando análisis:", e);
        bot.sendMessage(chatId, "❌ Error IA: " + e.message); 
    }
}

async function chequearAlineaciones(chatId, home, away) {
    try {
        const response = await ai.models.generateContent({
            model: "gemini-2.0-flash-exp",
            contents: `Jugadores clave para ${home} vs ${away} y su impacto si no juegan. Respuesta corta en 3-4 líneas.`
        });
        
        bot.sendMessage(chatId, `🕵️ *RADAR:*\n\n${response.text}`, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error("Error chequeando alineaciones:", e);
        bot.sendMessage(chatId, "❌ Error obteniendo radar de jugadores.");
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
    
    bot.sendMessage(chatId, `🏦 *BANCO TIPSTER*\n✅ Ganadas: ${ganadas}\n❌ Perdidas: ${perdidas}\n📊 Win Rate: ${winRate}%\n💰 *NETO: S/. ${balance.toFixed(2)}*`, { parse_mode: 'Markdown' });
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
        await bot.sendDocument(chatId, './Reporte.csv', {}, { filename: 'Reporte_Tipster.csv', contentType: 'text/csv' });
        fs.unlinkSync('./Reporte.csv');
    } catch (e) { 
        console.error("Error exportando:", e);
        bot.sendMessage(chatId, "❌ Error exportar."); 
    }
}

async function verificarResultados(chatId) {
    const pendientes = await Prediccion.find({ estado: 'PENDIENTE' });
    if (pendientes.length === 0) return bot.sendMessage(chatId, "✅ Sin pendientes.");
    
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
                const prompt = `El tipster predijo: "${p.pickIA}". 
                
El resultado final fue: ${m.homeTeam.name} ${score} ${m.awayTeam.name}.

¿La predicción fue CORRECTA? Responde únicamente SI o NO.`;

                const response = await ai.models.generateContent({
                    model: "gemini-2.0-flash-exp",
                    contents: prompt
                });
                
                const veredicto = response.text.toUpperCase();
                p.estado = veredicto.includes("SI") || veredicto.includes("SÍ") ? 'GANADA' : 'PERDIDA';
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

async function obtenerRacha(code) {
    try {
        const res = await axios.get(`https://api.football-data.org/v4/competitions/${code}/matches`, { 
            headers: footballHeaders, 
            params: { status: 'FINISHED' } 
        });
        return res.data.matches.slice(-3).map(m => 
            `${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away} ${m.awayTeam.name}`
        ).join(" | ");
    } catch (e) { 
        console.error("Error obteniendo racha:", e);
        return "Sin datos de racha."; 
    }
}

// --- 7. SERVIDOR HTTP ---
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot Tipster V3.2 Online');
}).listen(process.env.PORT || 10000, () => {
    console.log(`🌐 Servidor HTTP escuchando en puerto ${process.env.PORT || 10000}`);
});