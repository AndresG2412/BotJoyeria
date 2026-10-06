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
