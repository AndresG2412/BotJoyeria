import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { senderMobile } from '../src/bot/repairs';
import { checkRateLimit } from '../src/data/database';
import { config } from '../src/config/env';
import { whatsappRouter } from '../src/channels/whatsapp-cloud';

test('solo un número de WhatsApp en dígitos cuenta como celular verificado', () => {
    assert.equal(senderMobile('573157870130'), '3157870130');
    assert.equal(senderMobile('tg_3157870130'), null);
    assert.equal(senderMobile('CO.3157870130'), null);
    assert.equal(senderMobile(''), null);
});

test('el tope de mensajes por chat avisa una sola vez y se libera a las 24 h', async () => {
    const t0 = Date.UTC(2026, 9, 16, 12);
    for (let i = 0; i < 3; i++) assert.equal((await checkRateLimit('tope_1', 3, t0 + i)).allowed, true);
    assert.deepEqual(await checkRateLimit('tope_1', 3, t0 + 10), { allowed: false, firstBlocked: true });
    assert.deepEqual(await checkRateLimit('tope_1', 3, t0 + 11), { allowed: false, firstBlocked: false });
    assert.equal((await checkRateLimit('tope_1', 3, t0 + 25 * 60 * 60 * 1000)).allowed, true);
});

test('la verificación del webhook solo devuelve un challenge numérico, como texto plano', async () => {
    const original = config.META_VERIFY_TOKEN;
    config.META_VERIFY_TOKEN = 'token-de-prueba-largo-123';
    const app = express().use('/webhook', whatsappRouter);
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise(resolve => server.once('listening', resolve));
        const { port } = server.address() as { port: number };
        const ask = (token: string, challenge: string) =>
            fetch(`http://127.0.0.1:${port}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=${encodeURIComponent(challenge)}`);

        const ok = await ask('token-de-prueba-largo-123', '1158201444');
        assert.equal(ok.status, 200);
        assert.match(ok.headers.get('content-type') || '', /^text\/plain/);
        assert.equal(await ok.text(), '1158201444');

        assert.equal((await ask('token-de-prueba-largo-123', '<script>alert(1)</script>')).status, 403);
        assert.equal((await ask('otro', '1158201444')).status, 403);

        config.META_VERIFY_TOKEN = '';
        assert.equal((await ask('', '1158201444')).status, 403);
    } finally {
        config.META_VERIFY_TOKEN = original;
        server.close();
    }
});

test('el panel recibe las tiendas sin sus tokens, solo si están configurados', async () => {
    const { publicStore } = await import('../src/routes/dashboard');
    const visible = publicStore({ id: 'default', name: 'Joyería', whatsappAccessToken: 'EAAsecreto', telegramToken: '', openaiApiKey: null });
    assert.equal(visible.whatsappAccessToken, undefined);
    assert.equal(visible.whatsappAccessTokenConfigured, true);
    assert.equal(visible.telegramTokenConfigured, false);
    assert.ok(!JSON.stringify(visible).includes('EAAsecreto'));
});
