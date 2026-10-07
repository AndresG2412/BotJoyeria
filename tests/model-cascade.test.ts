import assert from 'node:assert/strict';
import test from 'node:test';
import { availableModels, coolDownModel, ModelEntry } from '../src/bot/agent';

const cascade: ModelEntry[] = [
    { id: 'modelo-a', tools: true },
    { id: 'modelo-b', tools: true },
];

test('un modelo que falló descansa unos minutos y luego vuelve', () => {
    const now = 1_000_000;
    coolDownModel('modelo-a', now);
    assert.deepEqual(availableModels(cascade, now + 1000).map(m => m.id), ['modelo-b']);
    assert.deepEqual(availableModels(cascade, now + 3 * 60 * 1000 + 1).map(m => m.id), ['modelo-a', 'modelo-b']);
});

test('si todos están descansando se prueban igual', () => {
    const now = 2_000_000;
    coolDownModel('modelo-a', now);
    coolDownModel('modelo-b', now);
    assert.deepEqual(availableModels(cascade, now + 1000).map(m => m.id), ['modelo-a', 'modelo-b']);
});

test('el recorte del historial nunca deja un resultado de herramienta huérfano', async () => {
    const { trimHistory } = await import('../src/bot/agent');
    const history = [
        { role: 'system' },
        { role: 'user' }, { role: 'assistant' },
        { role: 'user' }, { role: 'assistant', tool_calls: [{}] }, { role: 'tool' }, { role: 'assistant' },
        { role: 'user' }, { role: 'assistant', tool_calls: [{}] }, { role: 'tool' }, { role: 'assistant' },
    ] as any[];
    const trimmed = trimHistory(history, 6);
    assert.equal(trimmed[0].role, 'system');
    assert.equal(trimmed[1].role, 'user');
    assert.ok(trimmed.length <= 6);
    assert.deepEqual(trimmed.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'assistant']);
    assert.equal(trimHistory(history, 50).length, history.length);
});
