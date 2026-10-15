import assert from 'node:assert/strict';
import test from 'node:test';
import { messagesForModel, photoPlaceholder } from '../src/bot/agent';
import { fromOpenAIMessage } from '../src/bot/claude';

test('en el historial queda un texto en lugar de la foto', () => {
    assert.equal(photoPlaceholder(''), '[El cliente envió una foto]');
    assert.equal(photoPlaceholder('  ¿Tienen algo así? '), '[El cliente envió una foto] ¿Tienen algo así?');
});

test('la foto solo viaja al modelo en el mensaje del turno actual', () => {
    const viejo = { role: 'user', content: [{ type: 'text', text: 'Hola' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } }] } as any;
    const actual = { role: 'user', content: photoPlaceholder('¿Tienen algo así?') } as any;
    const historial = [{ role: 'system', content: 'Prompt' }, viejo, { role: 'assistant', content: 'Hola' }, actual] as any[];

    const conFoto = messagesForModel(historial, actual, { mimetype: 'image/jpeg', data: 'QUJD' });
    assert.equal(conFoto[1].content, 'Hola', 'las imágenes viejas quedan solo como texto');
    assert.deepEqual(conFoto[3].content, [
        { type: 'text', text: '[El cliente envió una foto] ¿Tienen algo así?' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
    ]);
    // El historial original no se toca: es lo que se guarda en la base.
    assert.equal(actual.content, '[El cliente envió una foto] ¿Tienen algo así?');

    const sinFoto = messagesForModel(historial, actual);
    assert.equal(sinFoto[3], actual);
});

test('la respuesta con formato OpenAI queda igual que la de Claude', () => {
    const reply = fromOpenAIMessage({
        role: 'assistant',
        content: ' Tengo algo parecido. ',
        refusal: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_products', arguments: '{"query":"anillo oro"}' } }],
    } as any);
    assert.equal(reply.content, 'Tengo algo parecido.');
    assert.equal(reply.tool_calls?.[0].function.name, 'search_products');

    const vacia = fromOpenAIMessage(undefined);
    assert.equal(vacia.content, null);
    assert.equal(vacia.tool_calls, undefined);
});
