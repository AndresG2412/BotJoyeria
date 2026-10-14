import assert from 'node:assert/strict';
import test from 'node:test';
import { fromClaudeMessage, toClaudeMessages, toClaudeToolChoice, toClaudeTools } from '../src/bot/claude';

test('el historial guardado se traduce a mensajes de Claude', () => {
    const { system, messages } = toClaudeMessages([
        { role: 'system', content: 'Eres Mr. 18Kilates.' },
        { role: 'user', content: 'Busco un anillo' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'filter_products', arguments: '{"tipo":"anillo"}' } },
                { id: 'c2', type: 'function', function: { name: 'get_product_details', arguments: 'no-es-json' } },
            ],
        },
        { role: 'tool', tool_call_id: 'c1', content: '{"total":1}' },
        { role: 'tool', tool_call_id: 'c2', content: '{"ok":true}' },
        { role: 'assistant', content: 'Anillo Solitario — $350.000' },
    ] as any);

    assert.equal(system, 'Eres Mr. 18Kilates.');
    assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);

    // Sin bloque de texto vacío: Claude lo rechaza.
    const toolUse = messages[1].content as any[];
    assert.deepEqual(toolUse.map(b => b.type), ['tool_use', 'tool_use']);
    assert.deepEqual(toolUse[0].input, { tipo: 'anillo' });
    assert.deepEqual(toolUse[1].input, {});

    // Los resultados seguidos van juntos en un solo mensaje.
    const results = messages[2].content as any[];
    assert.deepEqual(results.map(b => [b.type, b.tool_use_id]), [['tool_result', 'c1'], ['tool_result', 'c2']]);
});

test('una foto del cliente llega como imagen base64', () => {
    const { messages } = toClaudeMessages([
        {
            role: 'user',
            content: [
                { type: 'text', text: '¿Tienen algo así?' },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
            ],
        },
    ] as any);
    const blocks = messages[0].content as any[];
    assert.equal(blocks[0].text, '¿Tienen algo así?');
    assert.deepEqual(blocks[1].source, { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' });
});

test('herramientas y tool_choice se traducen', () => {
    const tools = toClaudeTools([
        { type: 'function', function: { name: 'close_conversation', description: 'Cierra', parameters: { type: 'object', properties: {} } } },
    ]);
    assert.deepEqual(tools, [{ name: 'close_conversation', description: 'Cierra', input_schema: { type: 'object', properties: {} } }]);
    assert.deepEqual(toClaudeToolChoice('auto'), { type: 'auto' });
    assert.deepEqual(
        toClaudeToolChoice({ type: 'function', function: { name: 'schedule_appointment' } }),
        { type: 'tool', name: 'schedule_appointment' },
    );
});

test('la respuesta de Claude vuelve al formato del historial', () => {
    const reply = fromClaudeMessage({
        content: [
            { type: 'text', text: 'Te muestro la foto.' },
            { type: 'tool_use', id: 't1', name: 'send_product_image', input: { product_id: '7' } },
        ],
    } as any);
    assert.equal(reply.content, 'Te muestro la foto.');
    assert.deepEqual(reply.tool_calls, [
        { id: 't1', type: 'function', function: { name: 'send_product_image', arguments: '{"product_id":"7"}' } },
    ]);

    const empty = fromClaudeMessage({ content: [] } as any);
    assert.equal(empty.content, null);
    assert.equal(empty.tool_calls, undefined);
});
