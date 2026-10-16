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

test('un mensaje con foto trae su identificador y como texto solo el pie de foto', async () => {
    const { toReadableMessages } = await import('../src/routes/admin-api');
    const history = [
        { role: 'user', content: '[El cliente envió una foto] ¿Tienen algo así?', photoMediaId: '1234567890123' },
        { role: 'user', content: '[El cliente envió una foto]', photoMediaId: '9876543210987' },
        // Fotos de antes de guardar el identificador: solo el texto.
        { role: 'user', content: '[El cliente envió una foto]' },
        // Un identificador raro no se ofrece.
        { role: 'user', content: '[El cliente envió una foto] hola', photoMediaId: '../../me' },
    ];
    assert.deepEqual(toReadableMessages(history), [
        { role: 'user', content: '¿Tienen algo así?', photoId: '1234567890123' },
        { role: 'user', content: '', photoId: '9876543210987' },
        { role: 'user', content: '[El cliente envió una foto]' },
        { role: 'user', content: '[El cliente envió una foto] hola' },
    ]);
});

test('solo se entregan fotos que pertenecen a ese chat', async () => {
    const { chatHasPhoto } = await import('../src/routes/admin-api');
    const history = [{ role: 'user', content: '[El cliente envió una foto]', photoMediaId: '1234567890123' }];
    assert.equal(chatHasPhoto(history, '1234567890123'), true);
    assert.equal(chatHasPhoto(history, '5555555555555'), false, 'foto de otro chat');
    assert.equal(chatHasPhoto(history, 'me?fields=x'), false, 'no deja colar otra ruta de Graph');
});

test('la IA nunca recibe el identificador de la foto', async () => {
    const { messagesForModel } = await import('../src/bot/agent');
    const conFoto: any = { role: 'user', content: '[El cliente envió una foto] mira', photoMediaId: '1234567890123' };
    const anterior: any = { role: 'user', content: '[El cliente envió una foto]', photoMediaId: '9876543210987' };
    const salida = messagesForModel([anterior, conFoto], conFoto, { mimetype: 'image/jpeg', data: 'AAAA', mediaId: '1234567890123' });
    assert.equal(JSON.stringify(salida).includes('1234567890123'), false);
    assert.equal(JSON.stringify(salida).includes('9876543210987'), false);
    assert.equal(Array.isArray(salida[1].content), true, 'la foto de este turno sí viaja a la IA');
});
