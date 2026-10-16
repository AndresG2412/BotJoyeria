import assert from 'node:assert/strict';
import test from 'node:test';
import { APPOINTMENT_ADDRESS, APPOINTMENT_CITY, CALL_APPOINTMENT_CITY, appointmentPlace } from '../src/bot/policies';
import { buildWebProductLeadResponse } from '../src/bot/web-product-lead';
import { botTools } from '../src/bot/tools';

test('la cita por llamada se guarda sin la dirección de la joyería', () => {
    assert.deepEqual(appointmentPlace('presencial'), { city: APPOINTMENT_CITY, address: APPOINTMENT_ADDRESS });
    assert.deepEqual(appointmentPlace(undefined), { city: APPOINTMENT_CITY, address: APPOINTMENT_ADDRESS });
    assert.equal(appointmentPlace('llamada').city, CALL_APPOINTMENT_CITY);
    assert.notEqual(appointmentPlace('llamada').address, APPOINTMENT_ADDRESS);
});

test('agendar exige elegir presencial o llamada', () => {
    const schedule = botTools.find(t => t.function.name === 'schedule_appointment');
    const params = schedule?.function.parameters as any;
    assert.deepEqual(params.properties.modalidad.enum, ['presencial', 'llamada']);
    assert.ok(params.required.includes('modalidad'));
});

test('el lead web ofrece cita o llamada con una sola pregunta', () => {
    for (const stock of [1, 0]) {
        const reply = buildWebProductLeadResponse({ name: 'Anillo Solitario', stock } as any);
        assert.match(reply, /cita en Pitalito o una llamada/);
        assert.equal(reply.split('?').length - 1, 1);
    }
});
