import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSlot, normalizeTime } from '../src/bot/scheduling';
import { botTools } from '../src/bot/tools';
import { toPanelAppointment } from '../src/routes/admin-api';
import { CALL_APPOINTMENT_CITY, CALL_APPOINTMENT_ADDRESS } from '../src/bot/policies';

// Miércoles 14 de octubre de 2026, 10:00 a. m. en Colombia (15:00 UTC).
const AHORA = new Date('2026-10-14T15:00:00Z');

test('el bot agenda desde mañana; el mostrador también puede anotar para hoy', () => {
    assert.equal(checkSlot('2026-10-14', '15:00', { earliest: 'tomorrow' }, AHORA)?.code, 'pasado');
    assert.equal(checkSlot('2026-10-14', '15:00', { earliest: 'today' }, AHORA), null);
    assert.equal(checkSlot('2026-10-14', '09:00', { earliest: 'today' }, AHORA)?.code, 'pasado', 'esa hora de hoy ya pasó');
    assert.equal(checkSlot('2026-10-15', '09:00', { earliest: 'tomorrow' }, AHORA), null);
});

test('solo lunes a viernes, sin festivos, en punto y en las franjas', () => {
    assert.equal(checkSlot('2026-10-17', '09:00', { earliest: 'today' }, AHORA)?.code, 'no_habil', 'sábado');
    assert.match(checkSlot('2026-10-17', '09:00', { earliest: 'today' }, AHORA)!.message, /2026-10-19/, 'propone el lunes');
    assert.equal(checkSlot('2026-11-02', '09:00', { earliest: 'today' }, AHORA)?.code, 'no_habil', 'festivo de Todos los Santos');
    assert.equal(checkSlot('2026-10-15', '13:00', { earliest: 'today' }, AHORA)?.code, 'hora', 'hora de almuerzo');
    assert.equal(checkSlot('2026-10-15', '09:30', { earliest: 'today' }, AHORA)?.code, 'hora', 'no en punto');
    assert.equal(checkSlot('2026-02-30', '09:00', { earliest: 'today' }, AHORA)?.code, 'fecha');
});

test('la hora se guarda con dos dígitos', () => {
    assert.equal(normalizeTime('9:00'), '09:00');
    assert.equal(normalizeTime(' 14:00 '), '14:00');
});

test('el bot puede avisar «llámenme» y ya no depende de Google Calendar', async () => {
    const tool = botTools.find(t => t.function.name === 'request_human_contact');
    assert.ok(tool);
    assert.deepEqual((tool!.function.parameters as any).properties.via.enum, ['llamada', 'chat']);
    const source = (await import('node:fs')).readFileSync('src/bot/tools.ts', 'utf8');
    assert.equal(/googleapis|calendarClient/.test(source), false);
});

test('el panel ve la modalidad de la cita y no el identificador interno del chat', () => {
    const base = {
        id: 'a1', storeId: 'default', sessionPhone: '573157870130', clientName: 'Laura', phone: '3157870130',
        date: '2026-10-15', time: '09:00', appointmentType: 'asesoria_presencial', reference: 'Anillo',
        status: 'scheduled' as const, notes: '', source: 'bot' as const, createdAt: '', updatedAt: '',
    };
    const llamada = toPanelAppointment({ ...base, city: CALL_APPOINTMENT_CITY, address: CALL_APPOINTMENT_ADDRESS });
    assert.equal(llamada.mode, 'llamada');
    assert.equal(llamada.place, '');
    assert.equal('sessionPhone' in llamada, false);
    const presencial = toPanelAppointment({ ...base, city: 'Pitalito', address: 'Calle 4 #1-31' });
    assert.equal(presencial.mode, 'presencial');
    assert.equal(presencial.place, 'Calle 4 #1-31, Pitalito');
});
