import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildRepairReport, checkRepairStatus, isRepairLookupLocked, MAX_FAILED_REPAIR_LOOKUPS,
    normalizeDocument, normalizeOrderNumber, repairStatusLabel, resetRepairLookupAttempts, senderMobile,
} from '../src/bot/repairs';
import { botTools } from '../src/bot/tools';
import type { RepairOrderRow } from '../src/data/taller';

const ORDER: RepairOrderRow = {
    numero: 'T-0012',
    pieza: 'Anillo solitario',
    material: 'oro_18k',
    estado: 'listo',
    fecha_recibido: new Date('2026-10-01T15:00:00Z'),
    fecha_prometida: new Date('2026-10-20T15:00:00Z'),
    entregada_en: null,
    saldo: '45000',
};

function fakeLookup(rows: RepairOrderRow[] | null) {
    const calls: any[] = [];
    const lookup = async (input: any) => { calls.push(input); return rows; };
    return { lookup, calls };
}

test('la herramienta de reparaciones existe y es solo de consulta', () => {
    const tool = botTools.find(t => t.function.name === 'check_repair_status');
    assert.ok(tool);
    assert.deepEqual(Object.keys((tool!.function.parameters as any).properties).sort(), ['cedula', 'numero_orden']);
    // El teléfono nunca lo pone la IA: sale del webhook.
    assert.equal('telefono' in (tool!.function.parameters as any).properties, false);
});

test('normaliza número de orden, cédula y celular del remitente', () => {
    assert.equal(normalizeOrderNumber('#t-0012 '), 'T0012');
    assert.equal(normalizeOrderNumber(''), null);
    assert.equal(normalizeDocument('1.083.456.789'), '1083456789');
    assert.equal(normalizeDocument('123'), null);
    assert.equal(senderMobile('573157870130'), '3157870130');
    assert.equal(senderMobile('CO.1234567890123456'), null);
});

test('traduce los estados reales del admin (enum_ordenes_taller_estado)', () => {
    assert.equal(repairStatusLabel('recibido'), 'Recibida en el taller');
    assert.equal(repairStatusLabel('en-taller'), 'En reparación');
    assert.equal(repairStatusLabel('listo'), 'Lista para recoger');
    assert.equal(repairStatusLabel('entregado'), 'Entregada');
    assert.equal(repairStatusLabel('cancelado'), 'Cancelada');
});

test('un estado nuevo que no conoce se muestra legible', () => {
    assert.equal(repairStatusLabel('pulido_final'), 'Pulido final');
});

test('el reporte solo trae datos para el cliente, en hora de Colombia', () => {
    const report = buildRepairReport(ORDER);
    assert.deepEqual(Object.keys(report).sort(), ['entregada', 'estado', 'fecha_prometida', 'numero_orden', 'pieza', 'recibida', 'saldo_pendiente'].sort());
    assert.equal(report.estado, 'Lista para recoger');
    assert.equal(report.pieza, 'Anillo solitario (oro 18k)');
    assert.match(report.saldo_pendiente || '', /^\$45.000$/);
    assert.match(report.fecha_prometida || '', /20 de octubre de 2026/);
});

test('consulta con número de orden y el celular del remitente', async () => {
    resetRepairLookupAttempts();
    const { lookup, calls } = fakeLookup([ORDER]);
    const result = JSON.parse(await checkRepairStatus({ numero_orden: 'T-0012' }, { sessionKey: 's1', senderPhone: '573157870130' }, lookup));
    assert.equal(result.verificado, true);
    assert.equal(result.ordenes[0].numero_orden, 'T-0012');
    assert.deepEqual(calls[0], { numero: 'T0012', documento: undefined, telefono: '3157870130' });
});

test('sin coincidencia y sin cédula, pide la cédula sin confirmar si la orden existe', async () => {
    resetRepairLookupAttempts();
    const { lookup } = fakeLookup([]);
    const result = JSON.parse(await checkRepairStatus({ numero_orden: 'T-0012' }, { sessionKey: 's2', senderPhone: '573000000000' }, lookup));
    assert.equal(result.verificado, false);
    assert.match(result.instrucciones, /cédula/);
    assert.equal(isRepairLookupLocked('s2'), false);
});

test('bloquea tras varios intentos fallidos con cédula', async () => {
    resetRepairLookupAttempts();
    const { lookup, calls } = fakeLookup([]);
    for (let i = 0; i < MAX_FAILED_REPAIR_LOOKUPS; i++) {
        await checkRepairStatus({ numero_orden: 'T-0012', cedula: `1083456${i}00` }, { sessionKey: 's3', senderPhone: '573000000000' }, lookup);
    }
    assert.equal(isRepairLookupLocked('s3'), true);
    const result = JSON.parse(await checkRepairStatus({ numero_orden: 'T-0012', cedula: '1083456789' }, { sessionKey: 's3', senderPhone: '573000000000' }, lookup));
    assert.equal(result.verificado, false);
    assert.equal(calls.length, MAX_FAILED_REPAIR_LOOKUPS, 'bloqueado ya no consulta la base');
});

test('solo cédula desde un identificador que no es celular: pide el número de orden y no consulta', async () => {
    resetRepairLookupAttempts();
    const { lookup, calls } = fakeLookup([ORDER]);
    const result = JSON.parse(await checkRepairStatus({ cedula: '1083456789' }, { sessionKey: 's4', senderPhone: 'CO.1234567890123456' }, lookup));
    assert.equal(result.verificado, false);
    assert.match(result.instrucciones, /número de orden/);
    assert.equal(calls.length, 0);
});

test('si la consulta falla no muestra errores técnicos', async () => {
    resetRepairLookupAttempts();
    const { lookup } = fakeLookup(null);
    const result = JSON.parse(await checkRepairStatus({ numero_orden: 'T-1' }, { sessionKey: 's5', senderPhone: '573157870130' }, lookup));
    assert.equal(result.verificado, false);
    assert.match(result.instrucciones, /No menciones errores técnicos/);
});
