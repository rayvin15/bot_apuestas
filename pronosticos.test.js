import assert from 'node:assert/strict';
import test from 'node:test';
import { leerCuota, leerPronostico, liquidarPronostico, mercadoAnterior, resumirBanca, validarMercado } from './pronosticos.js';

function partidoFinal(home, away) {
    return {
        status: 'FINISHED',
        score: { duration: 'REGULAR', fullTime: { home, away }, regularTime: { home: null, away: null } }
    };
}

test('liquida los tres mercados por el marcador', () => {
    const casos = [
        ['GANADOR', 'LOCAL', 2, 1, 'GANADA'],
        ['GANADOR', 'EMPATE', 1, 1, 'GANADA'],
        ['GANADOR', 'VISITA', 1, 0, 'PERDIDA'],
        ['GOLES_2_5', 'MAS', 1, 1, 'PERDIDA'],
        ['GOLES_2_5', 'MAS', 1, 2, 'GANADA'],
        ['GOLES_2_5', 'MENOS', 2, 0, 'GANADA'],
        ['AMBOS_MARCAN', 'SI', 2, 1, 'GANADA'],
        ['AMBOS_MARCAN', 'NO', 2, 0, 'GANADA'],
        ['AMBOS_MARCAN', 'NO', 1, 1, 'PERDIDA']
    ];
    for (const [mercado, seleccion, home, away, estado] of casos) {
        const resultado = liquidarPronostico(validarMercado(mercado, seleccion), partidoFinal(home, away));
        assert.deepEqual(resultado, { estado, resultadoReal: `${home}-${away}` });
    }
});

test('usa el marcador a los 90 minutos en prórroga y penales y espera si falta el dato', () => {
    const pick = validarMercado('GANADOR', 'EMPATE');
    for (const duration of ['EXTRA_TIME', 'PENALTY_SHOOTOUT']) {
        const partido = partidoFinal(4, 3);
        partido.score.duration = duration;
        assert.equal(liquidarPronostico(pick, partido), null);
        partido.score.regularTime = { home: 1, away: 1 };
        assert.deepEqual(liquidarPronostico(pick, partido), { estado: 'GANADA', resultadoReal: '1-1' });
    }
});

test('deja partidos aplazados y en juego pendientes y anula los cancelados o adjudicados', () => {
    const pick = validarMercado('GOLES_2_5', 'MAS');
    for (const status of ['POSTPONED', 'IN_PLAY']) {
        assert.equal(liquidarPronostico(pick, { ...partidoFinal(1, 4), status }), null);
    }
    for (const status of ['CANCELLED', 'AWARDED']) {
        assert.deepEqual(liquidarPronostico(pick, { status }), { estado: 'ANULADA', resultadoReal: null });
    }
});

test('reconoce solo formatos históricos inequívocos', () => {
    const mercado = (pickIA) => mercadoAnterior({ pickIA, equipoLocal: 'Cádiz CF', equipoVisita: 'Real Madrid CF' });
    assert.deepEqual(mercado('Gana Cádiz CF'), validarMercado('GANADOR', 'LOCAL'));
    assert.deepEqual(mercado('BTTS: Sí'), validarMercado('AMBOS_MARCAN', 'SI'));
    assert.deepEqual(mercado('Menos de 2,5 goles'), validarMercado('GOLES_2_5', 'MENOS'));
    assert.equal(mercado('Local DNB'), null);
    assert.equal(mercado('Over 2.5 y ambos marcan'), null);
});

test('valida el contrato de Gemini antes de guardar un pick', () => {
    const datos = { mercado: 'GOLES_2_5', seleccion: 'MAS', stake: 5, confianza: '🟢', analisis: 'Forma reciente favorable.' };
    assert.deepEqual(leerPronostico(JSON.stringify(datos)), { ...datos, linea: 2.5 });
    assert.equal(leerPronostico(JSON.stringify({ ...datos, stake: '5' })), null);
    assert.equal(leerPronostico(JSON.stringify({ ...datos, seleccion: 'SI' })), null);
    assert.equal(leerPronostico(JSON.stringify({ ...datos, mercado: ['GOLES_2_5'] })), null);
    assert.equal(leerPronostico('datos incompletos'), null);
    assert.deepEqual(leerPronostico('{"mercado":"SIN_PICK","stake":0,"analisis":"Faltan datos."}'), { analisis: 'Faltan datos.' });
});

test('acepta una cuota decimal con fuente y rechaza entradas inválidas', () => {
    assert.deepEqual(leerCuota('123 1,85 Casa de ejemplo'), {
        partidoId: 123, cuotaDecimal: 1.85, cuotaFuente: 'Casa de ejemplo'
    });
    assert.equal(leerCuota('123 1.00 Casa'), null);
    assert.equal(leerCuota('123 1.85  '), null);
    assert.equal(leerCuota('0 2.50 Casa'), null);
});

test('cuenta una ganada, una perdida y una anulada y calcula el saldo con la cuota registrada', () => {
    const liquidadoEn = new Date('2026-01-01');
    const resumen = resumirBanca([
        { estado: 'GANADA', montoApostado: 10, cuotaDecimal: 1.75, liquidadoEn },
        { estado: 'PERDIDA', montoApostado: 5, cuotaDecimal: 2.4, liquidadoEn },
        { estado: 'ANULADA', montoApostado: 9, cuotaDecimal: 1.8, liquidadoEn }
    ]);
    assert.deepEqual(resumen, {
        ganadas: 1, perdidas: 1, anuladas: 1, historicas: 0, unidades: 15, conCuota: 2, saldo: 2.5
    });
});

test('los picks antiguos sin cuota cuentan para efectividad y los borradores quedan fuera', () => {
    const resumen = resumirBanca([
        { estado: 'GANADA', montoApostado: 5 },
        { estado: 'PERDIDA', montoApostado: 3 },
        { estado: 'SIN_PICK' },
        { estado: 'REVISAR', montoApostado: 4 },
        { estado: 'BORRADOR', montoApostado: 9, cuotaDecimal: 1.9 }
    ]);
    assert.deepEqual(resumen, {
        ganadas: 1, perdidas: 1, anuladas: 0, historicas: 2, unidades: 0, conCuota: 0, saldo: 0
    });
});
