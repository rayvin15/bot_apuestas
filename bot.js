import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import http from 'node:http';
import mongoose from 'mongoose';
import {
    describirPick, leerCuota, leerPronostico, liquidarPronostico, mercadoAnterior,
    normalizarTexto, resumirBanca, validarMercado
} from './pronosticos.js';

const adminTelegramId = process.env.ADMIN_TELEGRAM_USER_ID?.trim();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const modelos = ['gemini-2.5-flash', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview'];
const apiFutbol = axios.create({
    baseURL: 'https://api.football-data.org/v4',
    headers: { 'X-Auth-Token': process.env.FOOTBALL_API_KEY, Accept: 'application/json' },
    timeout: 15000,
    family: 4
});
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
    polling: { interval: 300, autoStart: true, params: { timeout: 10 } }
});
const analisisEnCurso = new Set();
let auditoriaEnCurso = false;
let proximaPeticionIA = 0;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const fechaUTC = (fecha) => new Date(fecha).toISOString().slice(0, 10);
const opcionesHora = { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Lima' };
const horaLima = (fecha) => new Intl.DateTimeFormat('es-PE', opcionesHora).format(new Date(fecha));

if (!adminTelegramId) console.warn('Configura ADMIN_TELEGRAM_USER_ID. Usa /mi_id en un chat privado.');
bot.on('polling_error', (error) => console.log('Error de polling:', error.code));
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Mongo conectado.'))
    .catch(err => console.error('Error de conexión a Mongo:', err.name));

const PrediccionSchema = new mongoose.Schema({
    partidoId: { type: String, unique: true },
    idOficial: Number,
    equipoLocal: String,
    equipoVisita: String,
    fechaPartido: String,
    inicioPartido: Date,
    liga: String,
    analisisIA: String,
    pickIA: String,
    mercado: String,
    seleccion: String,
    linea: Number,
    montoApostado: { type: Number, default: 0 },
    confianza: { type: String, default: '🟡' },
    cuotaDecimal: Number,
    cuotaFuente: String,
    cuotaRegistradaEn: Date,
    publicadoEn: Date,
    resultadoReal: { type: String, default: null },
    estado: { type: String, default: 'PENDIENTE' },
    motivoRevision: String,
    liquidadoEn: Date,
    createdAt: { type: Date, default: Date.now }
});
const Prediccion = mongoose.model('Prediccion', PrediccionSchema);

function esAdministrador(usuario, chat) {
    return Boolean(adminTelegramId && chat?.type === 'private' && String(usuario?.id) === adminTelegramId);
}

async function enviarMensajeSeguro(chatId, texto, opciones = {}) {
    try {
        await bot.sendMessage(chatId, texto, opciones);
    } catch (error) {
        if (opciones.parse_mode && error.response?.body?.description?.includes("can't parse entities")) {
            const { parse_mode, ...textoPlano } = opciones;
            try {
                await bot.sendMessage(chatId, texto, textoPlano);
                return;
            } catch (reintento) {
                console.error('Error Telegram:', reintento.code);
            }
        } else {
            console.error('Error Telegram:', error.code);
        }
    }
}

async function llamarGeminiSeguro(prompt) {
    for (const [indice, modelo] of modelos.entries()) {
        const ahora = Date.now();
        const turno = Math.max(ahora, proximaPeticionIA);
        proximaPeticionIA = turno + 4000;
        if (turno > ahora) await delay(turno - ahora);
        try {
            const response = await ai.models.generateContent({
                model: modelo,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                config: { responseMimeType: 'application/json' }
            });
            return response.text;
        } catch (error) {
            const reintentable = [404, 429, 503].some(codigo =>
                Number(error.status) === codigo || String(error.message).includes(String(codigo)));
            if (!reintentable || indice === modelos.length - 1) throw error;
        }
    }
}

bot.onText(/^\/mi_id(?:@\w+)?\s*$/i, (msg) => {
    if (msg.chat.type === 'private') enviarMensajeSeguro(msg.chat.id, `Tu ID de usuario de Telegram es ${msg.from.id}.`);
});

bot.onText(/^\/start(?:@\w+)?\s*$/i, (msg) => {
    if (!esAdministrador(msg.from, msg.chat)) {
        return enviarMensajeSeguro(msg.chat.id, 'El bot está reservado para su administrador. Puedes consultar tu ID con /mi_id en privado.');
    }

    return enviarMensajeSeguro(msg.chat.id, '⚽ Tipster AI\nElige una competición o consulta el historial.', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🇪🇸 LaLiga', callback_data: 'comp_PD' }, { text: '🏴 Premier', callback_data: 'comp_PL' }],
                [{ text: '🇮🇹 Serie A', callback_data: 'comp_SA' }, { text: '🇩🇪 Bundesliga', callback_data: 'comp_BL1' }],
                [{ text: '🏆 Champions', callback_data: 'comp_CL' }, { text: '🇫🇷 Ligue 1', callback_data: 'comp_FL1' }],
                [{ text: '🌎 Mundial 2026', callback_data: 'comp_WC' }],
                [{ text: '⏳ Pendientes', callback_data: 'ver_pendientes' }, { text: '💰 Banca', callback_data: 'ver_banca' }],
                [{ text: '✅ Auditar', callback_data: 'ver_auditoria' }, { text: '📥 Exportar CSV', callback_data: 'exportar_excel' }]
            ]
        }
    });
});

bot.onText(/^\/cuota(?:@\w+)?(?:\s+(.+))?$/i, async (msg, [, texto]) => {
    if (!esAdministrador(msg.from, msg.chat)) return;
    const cuota = leerCuota(texto || '');
    if (!cuota) {
        return enviarMensajeSeguro(msg.chat.id, 'Uso: /cuota ID_DEL_PARTIDO 1.85 Nombre de la fuente');
    }
    try {
        await publicarPronostico(msg.chat.id, cuota.partidoId, cuota);
    } catch (error) {
        console.error('Error publicando con cuota:', error.response?.status ?? error.code ?? error.name);
        await enviarMensajeSeguro(msg.chat.id, 'No se pudo registrar la cuota. Intenta de nuevo.');
    }
});

bot.on('callback_query', async (query) => {
    const chat = query.message?.chat;
    const permitido = esAdministrador(query.from, chat);
    bot.answerCallbackQuery(query.id, permitido ? {} : { text: 'Acceso reservado al administrador.' }).catch(() => {});
    if (!permitido || typeof query.data !== 'string') return;

    const { id: chatId } = chat;
    const { data } = query;
    const [accion, valor] = data.split('|');
    const idOficial = Number(valor);
    const idValido = /^\d+$/.test(valor ?? '') && Number.isSafeInteger(idOficial) && idOficial > 0;
    try {
        if (/^comp_(?:PD|PL|SA|BL1|CL|FL1|WC)$/.test(data)) await listarPartidos(chatId, data.slice(5));
        else if (accion === 'an' && idValido) await procesarAnalisisCompleto(chatId, idOficial);
        else if (accion === 'publicar' && idValido) await publicarPronostico(chatId, idOficial);
        else if (accion === 'radar') {
            if (idValido) await consultarRadar(chatId, idOficial);
            else await enviarMensajeSeguro(chatId, 'Abre el partido desde /start para consultar el Radar actualizado.');
        } else if (data === 'ver_pendientes') await verPendientes(chatId);
        else if (data === 'ver_auditoria') await ejecutarAuditoria(chatId);
        else if (data === 'ver_banca') await mostrarBanca(chatId);
        else if (data === 'exportar_excel') await exportarCSV(chatId);
    } catch (error) {
        console.error('Error procesando botón:', error.response?.status ?? error.code ?? error.name);
        await enviarMensajeSeguro(chatId, 'No se pudo completar la operación. Intenta de nuevo.');
    }
});

async function obtenerPartido(idOficial) {
    const { data } = await apiFutbol.get(`/matches/${idOficial}`);
    return data;
}

function buscarPronostico(partido) {
    const { id, homeTeam, awayTeam, utcDate } = partido;
    return Prediccion.findOne({
        $or: [
            { partidoId: `football-data:${id}` },
            { idOficial: id },
            { partidoId: `${homeTeam.name}-${awayTeam.name}-${fechaUTC(utcDate)}` }
        ]
    }).lean();
}

async function listarPartidos(chatId, code) {
    const hoy = new Date();
    const enTresDias = new Date(hoy.getTime() + 3 * 86400000);
    const { data } = await apiFutbol.get(`/competitions/${code}/matches`, {
        params: { dateFrom: fechaUTC(hoy), dateTo: fechaUTC(enTresDias), status: 'SCHEDULED,TIMED' }
    });
    const partidos = (data.matches ?? [])
        .filter(partido => new Date(partido.utcDate) > hoy)
        .sort((a, b) => a.utcDate.localeCompare(b.utcDate))
        .slice(0, 8);

    if (!partidos.length) return enviarMensajeSeguro(chatId, `No hay partidos de ${code} en los próximos días.`);
    for (const partido of partidos) {
        const guardado = await buscarPronostico(partido);
        const boton = guardado ? 'Ver pronóstico' : 'Analizar partido';
        await enviarMensajeSeguro(chatId, `🏟️ ${partido.homeTeam.name} vs ${partido.awayTeam.name}\n📅 ${horaLima(partido.utcDate)} (Lima)`, {
            reply_markup: {
                inline_keyboard: [[
                    { text: boton, callback_data: `an|${partido.id}` },
                    { text: 'Radar', callback_data: `radar|${partido.id}` }
                ]]
            }
        });
    }
}

function puedePublicar(partido, ahora = new Date()) {
    return ['SCHEDULED', 'TIMED'].includes(partido.status) && new Date(partido.utcDate) > ahora;
}

async function obtenerRacha(equipo, fecha) {
    const hasta = new Date(Math.min(new Date(fecha).getTime(), Date.now()));
    const desde = new Date(hasta.getTime() - 90 * 86400000);
    const { data } = await apiFutbol.get(`/teams/${equipo.id}/matches`, {
        params: { dateFrom: fechaUTC(desde), dateTo: fechaUTC(hasta), status: 'FINISHED' }
    });
    return (data.matches ?? [])
        .filter(partido => new Date(partido.utcDate) < hasta &&
            Number.isInteger(partido.score?.fullTime?.home) && Number.isInteger(partido.score?.fullTime?.away))
        .sort((a, b) => b.utcDate.localeCompare(a.utcDate))
        .slice(0, 5)
        .map(({ homeTeam, awayTeam, score }) => `${homeTeam.name} ${score.fullTime.home}-${score.fullTime.away} ${awayTeam.name}`);
}

async function obtenerHistorialBD(local, visita) {
    const equipos = [local, visita];
    const historial = await Prediccion.find({
        estado: { $in: ['GANADA', 'PERDIDA'] },
        liquidadoEn: { $exists: true },
        $or: [{ equipoLocal: { $in: equipos } }, { equipoVisita: { $in: equipos } }]
    }).sort({ fechaPartido: -1 }).limit(8).lean();
    return historial.map(pick =>
        `${pick.equipoLocal} ${pick.resultadoReal} ${pick.equipoVisita} · ${pick.pickIA} · ${pick.estado}`
    ).join(' | ');
}

function alineacion(equipo) {
    return (equipo.lineup ?? []).map(jugador => jugador.name).filter(Boolean).join(', ');
}

async function procesarAnalisisCompleto(chatId, idOficial) {
    if (analisisEnCurso.has(idOficial)) return enviarMensajeSeguro(chatId, 'Ya estoy analizando este partido.');
    analisisEnCurso.add(idOficial);

    try {
        const partido = await obtenerPartido(idOficial);
        const guardado = await buscarPronostico(partido);
        if (guardado) return await mostrarPronostico(chatId, guardado, idOficial, puedePublicar(partido));
        if (!puedePublicar(partido)) return await enviarMensajeSeguro(chatId, 'El análisis previo solo está disponible antes del inicio.');

        await enviarMensajeSeguro(chatId, '🔎 Consultando la forma reciente y las alineaciones disponibles.');
        const { homeTeam, awayTeam, utcDate, competition } = partido;
        const [rachaLocal, rachaVisita] = await Promise.all([
            obtenerRacha(homeTeam, utcDate), obtenerRacha(awayTeam, utcDate)
        ]);

        let resultado;
        if (!rachaLocal.length || !rachaVisita.length) {
            resultado = { analisis: 'Football-Data no devolvió resultados recientes para ambos equipos.' };
        } else {
            const historial = await obtenerHistorialBD(homeTeam.name, awayTeam.name);
            const prompt = `Analiza el partido de fútbol ${homeTeam.name} vs ${awayTeam.name} (${competition.code}).
Usa los datos de Football-Data a continuación. Los datos ausentes son desconocidos.
No infieras bajas, alineaciones, cuotas ni resultados que no estén en los datos.
Si la evidencia no justifica un pronóstico, devuelve el mercado SIN_PICK con stake 0 y el motivo en analisis.

Forma del local (más reciente primero): ${rachaLocal.join(' | ')}
Forma del visitante (más reciente primero): ${rachaVisita.join(' | ')}
Alineación local: ${alineacion(homeTeam) || 'No disponible'}
Alineación visitante: ${alineacion(awayTeam) || 'No disponible'}
Historial auditado del bot (solo como contexto): ${historial || 'Sin registros verificados'}

Devuelve únicamente un objeto JSON con mercado, seleccion, stake, confianza y analisis.
Mercados a 90 minutos y sus selecciones exactas:
- GANADOR: LOCAL, EMPATE o VISITA.
- GOLES_2_5: MAS o MENOS.
- AMBOS_MARCAN: SI o NO.
- SIN_PICK: seleccion null y stake 0.
Para un pick, stake debe ser un entero de 1 a 10 y confianza debe ser 🟢, 🟡 o 🔴.
Escribe el análisis en español y en un máximo de 300 caracteres.`;
            resultado = leerPronostico(await llamarGeminiSeguro(prompt)) ??
                { analisis: 'Gemini no devolvió un pronóstico que se pudiera verificar.' };
        }

        const tienePick = Boolean(resultado.mercado);
        const pronostico = await Prediccion.findOneAndUpdate(
            { partidoId: `football-data:${idOficial}` },
            { $setOnInsert: {
                idOficial,
                equipoLocal: homeTeam.name,
                equipoVisita: awayTeam.name,
                fechaPartido: fechaUTC(utcDate),
                inicioPartido: new Date(utcDate),
                liga: competition.code,
                pickIA: tienePick ? describirPick(resultado, homeTeam.name, awayTeam.name) : 'Sin pick',
                analisisIA: resultado.analisis,
                mercado: resultado.mercado,
                seleccion: resultado.seleccion,
                linea: resultado.linea,
                montoApostado: resultado.stake ?? 0,
                confianza: resultado.confianza ?? '🔴',
                estado: tienePick ? 'BORRADOR' : 'SIN_PICK'
            } },
            { upsert: true, new: true }
        ).lean();

        await mostrarPronostico(chatId, pronostico, idOficial, puedePublicar(partido));
    } finally {
        analisisEnCurso.delete(idOficial);
    }
}

async function mostrarPronostico(chatId, pick, idOficial, publicable = true) {
    const radar = [{ text: 'Radar', callback_data: `radar|${idOficial}` }];
    const opciones = { reply_markup: { inline_keyboard: [radar] } };
    if (!pick.partidoId?.startsWith('football-data:')) {
        return enviarMensajeSeguro(chatId, pick.analisisIA || pick.pickIA, { ...opciones, parse_mode: 'Markdown' });
    }

    const partido = `${pick.equipoLocal} vs ${pick.equipoVisita}`;
    if (pick.estado === 'SIN_PICK') {
        return enviarMensajeSeguro(chatId, `${partido}\n⚪ Sin pick\n${pick.analisisIA}`, opciones);
    }

    const lineas = [
        partido,
        `🎯 ${pick.pickIA}`,
        `${pick.confianza} Confianza · Stake ${pick.montoApostado}/10`,
        '',
        pick.analisisIA
    ];
    if (pick.estado === 'BORRADOR') {
        lineas.unshift(publicable ? '📝 Borrador' : '📝 Borrador cerrado');
        if (publicable) {
            lineas.push('', `Para publicar con cuota: /cuota ${idOficial} 1.85 Nombre de la fuente`);
            opciones.reply_markup.inline_keyboard.unshift([
                { text: 'Publicar sin cuota', callback_data: `publicar|${idOficial}` }
            ]);
        }
    } else {
        lineas.unshift('📌 Pick publicado');
        if (pick.cuotaDecimal) {
            lineas.push('', `Cuota ${pick.cuotaDecimal} · ${pick.cuotaFuente} · ${horaLima(pick.cuotaRegistradaEn)} (Lima)`);
        } else {
            lineas.push('', 'Cuota sin registrar.');
        }
        if (pick.resultadoReal) lineas.push(`Resultado (90 min) ${pick.resultadoReal} · ${pick.estado}`);
        else if (pick.estado === 'ANULADA') lineas.push('Pick anulado.');
    }
    return enviarMensajeSeguro(chatId, lineas.join('\n'), opciones);
}

async function publicarPronostico(chatId, idOficial, cuota) {
    const filtro = { partidoId: `football-data:${idOficial}` };
    const borrador = await Prediccion.findOne(filtro).lean();
    if (!borrador) return enviarMensajeSeguro(chatId, 'Analiza el partido desde /start para crear un borrador.');
    if (borrador.estado !== 'BORRADOR') return mostrarPronostico(chatId, borrador, idOficial);

    const partido = await obtenerPartido(idOficial);
    const ahora = new Date();
    if (!puedePublicar(partido, ahora)) {
        return enviarMensajeSeguro(chatId, 'La publicación se cerró para este partido.');
    }

    const cambios = {
        estado: 'PENDIENTE',
        publicadoEn: ahora,
        inicioPartido: new Date(partido.utcDate),
        fechaPartido: fechaUTC(partido.utcDate)
    };
    if (cuota) {
        cambios.cuotaDecimal = cuota.cuotaDecimal;
        cambios.cuotaFuente = cuota.cuotaFuente;
        cambios.cuotaRegistradaEn = ahora;
    }
    const publicado = await Prediccion.findOneAndUpdate(
        { ...filtro, estado: 'BORRADOR' }, { $set: cambios }, { new: true }
    ).lean();
    const actual = publicado ?? await Prediccion.findOne(filtro).lean();
    return mostrarPronostico(chatId, actual, idOficial);
}

async function consultarRadar(chatId, idOficial) {
    const partido = await obtenerPartido(idOficial);
    const { homeTeam, awayTeam, lastUpdated, utcDate } = partido;
    const lineas = [
        `🔎 Radar · ${homeTeam.name} vs ${awayTeam.name}`,
        `Inicio previsto: ${horaLima(utcDate)} (Lima)`,
        ''
    ];
    for (const equipo of [homeTeam, awayTeam]) {
        lineas.push(`${equipo.name}: ${alineacion(equipo) || 'Alineación no disponible.'}`);
    }
    const fechaFuente = Number.isFinite(Date.parse(lastUpdated)) ?
        `Ficha actualizada el ${horaLima(lastUpdated)}` : `Ficha consultada el ${horaLima(new Date())}`;
    lineas.push('', 'Bajas: sin información confirmada en esta fuente.', `Fuente: Football-Data · partido #${idOficial} · ${fechaFuente} (Lima)`);
    return enviarMensajeSeguro(chatId, lineas.join('\n'));
}

async function verPendientes(chatId) {
    const registros = await Prediccion.find({
        $or: [
            { estado: { $in: ['PENDIENTE', 'REVISAR'] } },
            { estado: 'BORRADOR', inicioPartido: { $gt: new Date() } }
        ]
    }).sort({ fechaPartido: 1 }).lean();

    if (!registros.length) return enviarMensajeSeguro(chatId, 'No tienes picks pendientes ni borradores abiertos.');
    let mensaje = '⏳ Seguimiento de picks';
    for (const pick of registros) {
        const nota = pick.motivoRevision ? ` · ${pick.motivoRevision}` : '';
        const id = pick.idOficial ? ` · #${pick.idOficial}` : '';
        const entrada = `\n\n${pick.fechaPartido} · ${pick.equipoLocal} vs ${pick.equipoVisita}${id}\n${pick.estado} · ${pick.pickIA}${nota}`;
        if (mensaje.length + entrada.length > 3500) {
            await enviarMensajeSeguro(chatId, mensaje);
            mensaje = '⏳ Seguimiento de picks (continuación)';
        }
        mensaje += entrada;
    }
    return enviarMensajeSeguro(chatId, mensaje);
}

async function obtenerPartidoAnterior(pick) {
    const diaSiguiente = new Date(Date.parse(pick.fechaPartido) + 86400000);
    const { data } = await apiFutbol.get(`/competitions/${pick.liga}/matches`, {
        params: { dateFrom: pick.fechaPartido, dateTo: fechaUTC(diaSiguiente) }
    });
    const coincidencias = (data.matches ?? []).filter(partido =>
        fechaUTC(partido.utcDate) === pick.fechaPartido &&
        normalizarTexto(partido.homeTeam.name) === normalizarTexto(pick.equipoLocal) &&
        normalizarTexto(partido.awayTeam.name) === normalizarTexto(pick.equipoVisita)
    );
    return coincidencias.length === 1 ? coincidencias[0] : null;
}

async function ejecutarAuditoria(chatId) {
    if (auditoriaEnCurso) return enviarMensajeSeguro(chatId, 'Ya hay una auditoría en curso.');
    auditoriaEnCurso = true;
    try {
        const pendientes = await Prediccion.find({ estado: 'PENDIENTE' }).sort({ fechaPartido: 1 }).lean();
        if (!pendientes.length) return await enviarMensajeSeguro(chatId, 'No hay picks pendientes de auditar.');

        await enviarMensajeSeguro(chatId, `Revisando ${pendientes.length} picks pendientes con Football-Data.`);
        const totales = { GANADA: 0, PERDIDA: 0, ANULADA: 0, SIN_PICK: 0, REVISAR: 0 };
        let sinResultado = 0;
        let errores = 0;
        let consultas = 0;
        for (const pick of pendientes) {
            try {
                let cambios;
                const filtro = { _id: pick._id, estado: 'PENDIENTE' };
                if (pick.montoApostado === 0 || /^\s*pasar\b/i.test(pick.pickIA)) {
                    cambios = { estado: 'SIN_PICK' };
                } else {
                    const mercado = pick.mercado ? validarMercado(pick.mercado, pick.seleccion) : mercadoAnterior(pick);
                    if (!mercado) {
                        cambios = { estado: 'REVISAR', motivoRevision: 'Mercado anterior sin regla de liquidación.' };
                    } else {
                        if (consultas > 0) await delay(7000);
                        consultas++;
                        const partido = pick.idOficial ? await obtenerPartido(pick.idOficial) : await obtenerPartidoAnterior(pick);
                        if (!partido) {
                            sinResultado++;
                            continue;
                        }
                        const liquidacion = liquidarPronostico(mercado, partido);
                        if (!liquidacion) {
                            if (!pick.idOficial) {
                                await Prediccion.updateOne(filtro, { $set: { idOficial: partido.id } });
                            }
                            sinResultado++;
                            continue;
                        }
                        cambios = { ...mercado, ...liquidacion, idOficial: partido.id, liquidadoEn: new Date() };
                    }
                }
                const resultado = await Prediccion.updateOne(filtro, { $set: cambios });
                if (!resultado.modifiedCount) continue;
                totales[cambios.estado]++;
                if (cambios.resultadoReal) {
                    await enviarMensajeSeguro(chatId,
                        `${cambios.estado} · ${pick.equipoLocal} ${cambios.resultadoReal} ${pick.equipoVisita} (90 min)\n${pick.pickIA}`);
                }
            } catch (error) {
                errores++;
                console.error('Error auditando:', pick.partidoId, error.response?.status ?? error.code ?? error.name);
            }
        }
        const resumen = [
            '📊 Auditoría',
            `✅ ${totales.GANADA} ganadas · ❌ ${totales.PERDIDA} perdidas · ⚪ ${totales.ANULADA} anuladas`,
            `${totales.SIN_PICK} sin pick · ${totales.REVISAR} para revisión`,
            `${sinResultado} pendientes de marcador o identificación · ${errores} errores de consulta`
        ];
        return await enviarMensajeSeguro(chatId, resumen.join('\n'));
    } finally {
        auditoriaEnCurso = false;
    }
}

async function mostrarBanca(chatId) {
    const historial = await Prediccion.find({ estado: { $in: ['GANADA', 'PERDIDA', 'ANULADA'] } }).lean();
    const { ganadas, perdidas, anuladas, historicas, conCuota, saldo, unidades } = resumirBanca(historial);
    const validas = ganadas + perdidas;
    const efectividad = validas ? `${(100 * ganadas / validas).toFixed(1)} %` : 'Sin picks resueltos';
    const lineas = [
        '💰 Banca',
        `Picks resueltos: ${validas} (${ganadas} ganadas · ${perdidas} perdidas)`,
        `Anuladas: ${anuladas}`,
        `Efectividad: ${efectividad}`
    ];
    if (historicas) lineas.push(`Resultados de la auditoría anterior incluidos: ${historicas}.`);
    if (conCuota) {
        lineas.push('', `Saldo con cuota registrada: ${saldo.toFixed(2)} U (${conCuota} de ${validas} picks)`,
            `Rendimiento sobre las unidades registradas: ${(100 * saldo / unidades).toFixed(1)} %`);
    } else {
        lineas.push('', 'Aún no hay picks liquidados con cuota registrada.');
    }
    return enviarMensajeSeguro(chatId, lineas.join('\n'));
}

function celdaCSV(valor) {
    const texto = String(valor ?? '');
    const seguro = /^\s*[=+@-]|^[\t\r\n]/.test(texto) ? "'" + texto : texto;
    return '"' + seguro.replaceAll('"', '""') + '"';
}

async function exportarCSV(chatId) {
    const historial = await Prediccion.find({ estado: { $ne: 'BORRADOR' } }).sort({ fechaPartido: 1 }).lean();
    const filas = [
        ['FECHA', 'PARTIDO', 'PICK', 'RESULTADO', 'ESTADO', 'STAKE', 'ID_OFICIAL', 'MERCADO',
            'SELECCION', 'LINEA', 'CUOTA', 'FUENTE_CUOTA', 'CUOTA_REGISTRADA_UTC', 'PUBLICADO_UTC', 'LIQUIDADO_UTC', 'MOTIVO_REVISION']
    ];
    for (const p of historial) {
        filas.push([
            p.fechaPartido, `${p.equipoLocal} vs ${p.equipoVisita}`, p.pickIA, p.resultadoReal, p.estado,
            p.montoApostado, p.idOficial, p.mercado, p.seleccion, p.linea, p.cuotaDecimal, p.cuotaFuente,
            p.cuotaRegistradaEn?.toISOString(), p.publicadoEn?.toISOString(), p.liquidadoEn?.toISOString(), p.motivoRevision
        ]);
    }
    const csv = filas.map(fila => fila.map(celdaCSV).join(',')).join('\r\n');
    await bot.sendDocument(chatId, Buffer.from('\uFEFF' + csv, 'utf8'), {}, {
        filename: 'historial.csv',
        contentType: 'text/csv'
    });
}

const puerto = process.env.PORT || 10000;
http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Tipster AI Online');
}).listen(puerto);
