import assert from 'node:assert/strict';
import test from 'node:test';
import { echoText, parseWebhookPayload } from '../src/channels/whatsapp-cloud';
import { isHumanAttending } from '../src/data/database';

// Ejemplo oficial de Meta (Onboard WhatsApp Business app users → smb_message_echoes).
const echoPayload = {
    object: 'whatsapp_business_account',
    entry: [{
        id: '102290129340398',
        changes: [{
            value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
                message_echoes: [{
                    from: '15550783881', to: '16505551234', id: 'wamid.HBgLMTY0', timestamp: '1700255121',
                    type: 'text', text: { body: "Here's the info you requested!" },
                }],
            },
            field: 'smb_message_echoes',
        }],
    }],
};

test('reconoce las respuestas enviadas desde el celular de la joyería', () => {
    const parsed = parseWebhookPayload(echoPayload);
    assert.equal(parsed.messages.length, 0);
    assert.equal(parsed.echoes.length, 1);
    assert.equal(parsed.echoes[0].phoneNumberId, '106540352242922');
    assert.equal(parsed.echoes[0].echo.to, '16505551234');
    assert.equal(echoText(parsed.echoes[0].echo), "Here's the info you requested!");
});

test('los mensajes de clientes siguen llegando como antes', () => {
    const parsed = parseWebhookPayload({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: {
            metadata: { phone_number_id: '1' },
            messages: [{ id: 'm1', from: '573000000000', type: 'text', text: { body: 'Hola' } }],
            statuses: [{ id: 's1', status: 'failed' }],
        } }] }],
    });
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.statuses.length, 1);
    assert.equal(parsed.echoes.length, 0);
});

test('detecta cuando el número se desconecta de la coexistencia', () => {
    const parsed = parseWebhookPayload({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'account_update', value: {
            phone_number: '15550783881', event: 'PARTNER_REMOVED',
            disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' },
        } }] }],
    });
    assert.deepEqual(parsed.disconnections, [{
        phoneNumber: '15550783881', event: 'PARTNER_REMOVED', reason: 'PRIMARY_INACTIVITY', initiatedBy: 'SYSTEM',
    }]);
});

test('las fotos enviadas desde el celular quedan descritas en el historial', () => {
    assert.equal(echoText({ type: 'image', image: { caption: 'Así queda en oro rosa' } }),
        '[La joyería envió una imagen desde el celular] Así queda en oro rosa');
    assert.equal(echoText({ type: 'audio' }), '[La joyería envió un audio desde el celular]');
});

test('el bot se aparta solo mientras dura el plazo', () => {
    const now = new Date('2026-10-06T22:00:00Z');
    assert.equal(isHumanAttending({ humanUntil: new Date('2026-10-07T01:00:00Z') }, now), true);
    assert.equal(isHumanAttending({ humanUntil: new Date('2026-10-06T21:00:00Z') }, now), false);
    assert.equal(isHumanAttending({ humanUntil: null }, now), false);
    assert.equal(isHumanAttending(null, now), false);
});
