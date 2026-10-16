import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config/env';
import { requireAdminToken, toReadableMessages } from '../src/routes/admin-api';

function runAuth(header: string | undefined, token: string) {
    (config as any).BOT_ADMIN_API_TOKEN = token;
    let status = 200;
    let nextCalled = false;
    const req: any = { get: (name: string) => (name.toLowerCase() === 'authorization' ? header : undefined) };
    const res: any = { status(code: number) { status = code; return this; }, json() { return this; } };
    requireAdminToken(req, res, () => { nextCalled = true; });
    return { status, nextCalled };
}

test('sin llave configurada el acceso del admin queda apagado', () => {
    assert.deepEqual(runAuth('Bearer algo', ''), { status: 503, nextCalled: false });
});

test('rechaza llaves ausentes o incorrectas y acepta la correcta', () => {
    const secret = 'llave-larga-de-prueba-123';
    assert.equal(runAuth(undefined, secret).status, 401);
    assert.equal(runAuth('Bearer otra', secret).status, 401);
    assert.equal(runAuth(secret, secret).status, 401, 'exige el formato Bearer');
    assert.deepEqual(runAuth(`Bearer ${secret}`, secret), { status: 200, nextCalled: true });
});

test('el chat que ve el admin no trae instrucciones ni llamadas internas de la IA', () => {
    const history = [
        { role: 'system', content: 'instrucciones' },
        { role: 'user', content: 'Hola, ¿ya está mi anillo?' },
        { role: 'assistant', content: null, tool_calls: [{ id: '1', function: { name: 'check_repair_status', arguments: '{"cedula":"1083456789"}' } }] },
        { role: 'tool', tool_call_id: '1', content: '{"verificado":true}' },
        { role: 'user', content: [{ type: 'text', text: 'Esta' }, { type: 'image_url', image_url: { url: 'data:...' } }] },
        { role: 'assistant', content: 'Tu anillo está listo para recoger.' },
    ];
    assert.deepEqual(toReadableMessages(history), [
        { role: 'user', content: 'Hola, ¿ya está mi anillo?' },
        { role: 'user', content: '[Foto] Esta' },
        { role: 'assistant', content: 'Tu anillo está listo para recoger.' },
    ]);
});
