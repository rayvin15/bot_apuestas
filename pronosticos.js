const seleccionesPorMercado = {
    GANADOR: ['LOCAL', 'EMPATE', 'VISITA'],
    GOLES_2_5: ['MAS', 'MENOS'],
    AMBOS_MARCAN: ['SI', 'NO']
};

export function validarMercado(mercado, seleccion) {
    if (typeof mercado !== 'string' || !Object.hasOwn(seleccionesPorMercado, mercado)) return null;
    if (!seleccionesPorMercado[mercado].includes(seleccion)) return null;
    return { mercado, seleccion, linea: mercado === 'GOLES_2_5' ? 2.5 : null };
}

export function leerPronostico(texto) {
    if (typeof texto !== 'string') return null;

    let datos;
    try {
        datos = JSON.parse(texto.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
    } catch {
        return null;
    }

    if (!datos || typeof datos.analisis !== 'string' || !datos.analisis.trim()) return null;
    const analisis = datos.analisis.trim().slice(0, 600);
    if (datos.mercado === 'SIN_PICK' && datos.stake === 0) return { analisis };

    const pick = validarMercado(datos.mercado, datos.seleccion);
    if (!pick || !Number.isInteger(datos.stake) || datos.stake < 1 || datos.stake > 10) return null;
    if (!['🟢', '🟡', '🔴'].includes(datos.confianza)) return null;
    return { ...pick, stake: datos.stake, confianza: datos.confianza, analisis };
}

export function describirPick({ mercado, seleccion, linea }, local, visita) {
    if (mercado === 'GANADOR') {
        if (seleccion === 'EMPATE') return 'Ganador (1X2) · Empate';
        return `Ganador (1X2) · ${seleccion === 'LOCAL' ? local : visita}`;
    }
    if (mercado === 'GOLES_2_5') return `${seleccion === 'MAS' ? 'Más' : 'Menos'} de ${linea} goles`;
    return `Ambos marcan · ${seleccion === 'SI' ? 'Sí' : 'No'}`;
}

export function normalizarTexto(texto) {
    return (texto || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function mercadoAnterior({ pickIA, equipoLocal, equipoVisita }) {
    const pick = normalizarTexto(pickIA);
    const total = /^(over|under|mas de|menos de)\s+2[.,]5(?:\s+goles)?$/.exec(pick);
    if (total) return validarMercado('GOLES_2_5', ['over', 'mas de'].includes(total[1]) ? 'MAS' : 'MENOS');

    const btts = /^(?:ambos(?: equipos)? marcan|btts)\s*[:·-]?\s*(si|yes|no)$/.exec(pick);
    if (btts) return validarMercado('AMBOS_MARCAN', btts[1] === 'no' ? 'NO' : 'SI');

    const ganador = pick.replace(/^(?:(?:ganador|1x2)\s*[:·-]\s*|(?:gana|victoria de)\s+)/, '');
    if (ganador === 'empate') return validarMercado('GANADOR', 'EMPATE');
    if (ganador && [normalizarTexto(equipoLocal), 'local'].includes(ganador)) return validarMercado('GANADOR', 'LOCAL');
    if (ganador && [normalizarTexto(equipoVisita), 'visita', 'visitante'].includes(ganador)) return validarMercado('GANADOR', 'VISITA');
    return null;
}

export function liquidarPronostico(pick, partido) {
    if (['CANCELLED', 'AWARDED'].includes(partido.status)) {
        return { estado: 'ANULADA', resultadoReal: null };
    }
    if (partido.status !== 'FINISHED') return null;

    const score = partido.score;
    const marcador = score?.duration === 'REGULAR' ? score.fullTime : score?.regularTime;
    const { home, away } = marcador ?? {};
    if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) return null;

    let acierto;
    if (pick.mercado === 'GANADOR') {
        acierto = pick.seleccion === (home === away ? 'EMPATE' : home > away ? 'LOCAL' : 'VISITA');
    } else if (pick.mercado === 'GOLES_2_5') {
        acierto = pick.seleccion === (home + away > pick.linea ? 'MAS' : 'MENOS');
    } else {
        acierto = pick.seleccion === (home > 0 && away > 0 ? 'SI' : 'NO');
    }
    return { estado: acierto ? 'GANADA' : 'PERDIDA', resultadoReal: `${home}-${away}` };
}

export function leerCuota(texto) {
    const partes = /^(\d+)\s+(\d{1,5}(?:[.,]\d{1,4})?)\s+(.{1,150})$/.exec(texto.trim());
    if (!partes) return null;
    const [, id, decimal, fuente] = partes;
    const partidoId = Number(id);
    const cuotaDecimal = Number(decimal.replace(',', '.'));
    if (!Number.isSafeInteger(partidoId) || partidoId < 1 || cuotaDecimal <= 1) return null;
    return { partidoId, cuotaDecimal, cuotaFuente: fuente };
}

export function resumirBanca(historial) {
    const resumen = { ganadas: 0, perdidas: 0, anuladas: 0, conCuota: 0, saldo: 0, unidades: 0, historicas: 0 };
    for (const pick of historial) {
        if (pick.estado === 'ANULADA') {
            resumen.anuladas++;
            continue;
        }
        if (pick.estado === 'GANADA') resumen.ganadas++;
        else if (pick.estado === 'PERDIDA') resumen.perdidas++;
        else continue;

        if (!pick.liquidadoEn) resumen.historicas++;
        const { montoApostado: stake, cuotaDecimal } = pick;
        if (!Number.isFinite(cuotaDecimal) || cuotaDecimal <= 1 || !Number.isFinite(stake) || stake <= 0) continue;
        resumen.conCuota++;
        resumen.unidades += stake;
        resumen.saldo += pick.estado === 'GANADA' ? stake * (cuotaDecimal - 1) : -stake;
    }
    return resumen;
}
