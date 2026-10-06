import assert from 'node:assert/strict';
import test from 'node:test';
import { withoutSystemPrompt } from '../src/data/database';

test('las conversaciones se guardan sin las instrucciones de la IA', () => {
    const history = [
        { role: 'system', content: 'instrucciones largas' },
        { role: 'user', content: 'Hola' },
        { role: 'assistant', content: 'Hola, soy Mr. 18Kilates.' },
    ];
    assert.deepEqual(withoutSystemPrompt(history).map(m => m.role), ['user', 'assistant']);
    assert.deepEqual(withoutSystemPrompt(null as any), []);
});
