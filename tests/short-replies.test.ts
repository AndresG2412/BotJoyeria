import assert from 'node:assert/strict';
import test from 'node:test';
import { keepFirstQuestion } from '../src/bot/agent';
import { FILTER_QUESTIONS, SYSTEM_PROMPT } from '../src/bot/prompts';

test('solo se envía hasta la primera pregunta', () => {
    assert.deepEqual(
        keepFirstQuestion(['Claro. ¿Qué joya buscas? ¿En oro o plata? ¿Cuál es tu presupuesto?']),
        ['Claro. ¿Qué joya buscas?'],
    );
});

test('una pregunta en un mensaje separado descarta los mensajes siguientes', () => {
    assert.deepEqual(
        keepFirstQuestion(['Listo, Juan. Tu cita es el lunes a las 9.', '¿Te ayudo con algo más?', '¿Quieres ver otra pieza?']),
        ['Listo, Juan. Tu cita es el lunes a las 9.', '¿Te ayudo con algo más?'],
    );
});

test('sin preguntas no se recorta nada y los "?" de los enlaces no cuentan', () => {
    assert.deepEqual(keepFirstQuestion(['Está disponible.']), ['Está disponible.']);
    assert.deepEqual(
        keepFirstQuestion(['Mira https://www.mr18kts.online/pieza?ref=12 ¿Te gusta? ¿Otra?']),
        ['Mira https://www.mr18kts.online/pieza?ref=12 ¿Te gusta?'],
    );
});

test('el banco de preguntas tiene preguntas cortas, una por entrada, y está en el prompt', () => {
    for (const q of FILTER_QUESTIONS) {
        assert.equal(q.pregunta.split('?').length - 1, 1, `${q.id} debe tener una sola pregunta`);
        assert.ok(q.pregunta.split(/\s+/).length <= 12, `${q.id} es demasiado larga`);
        assert.ok(SYSTEM_PROMPT.includes(q.pregunta), `${q.id} no está en el prompt`);
    }
});
