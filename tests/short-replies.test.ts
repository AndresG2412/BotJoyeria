import assert from 'node:assert/strict';
import test from 'node:test';
import { keepFirstQuestion } from '../src/bot/agent';

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

test('la frase por defecto de la tienda no reemplaza el flujo completo', async () => {
    const { resolveSystemPrompt, SYSTEM_PROMPT, DEFAULT_STORE_SYSTEM_PROMPT } = await import('../src/bot/prompts');
    assert.equal(resolveSystemPrompt(DEFAULT_STORE_SYSTEM_PROMPT), SYSTEM_PROMPT);
    assert.equal(resolveSystemPrompt(`  ${DEFAULT_STORE_SYSTEM_PROMPT}\n`), SYSTEM_PROMPT);
    assert.equal(resolveSystemPrompt(''), SYSTEM_PROMPT);
    assert.equal(resolveSystemPrompt(null), SYSTEM_PROMPT);
    assert.equal(resolveSystemPrompt('Prompt propio de otra tienda.'), 'Prompt propio de otra tienda.');
});
