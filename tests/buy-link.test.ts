import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeTextIntoCaption } from '../src/channels/whatsapp-cloud';
import { SYSTEM_PROMPT } from '../src/bot/prompts';

const foto = { mimetype: 'image/jpeg', base64: 'QUJD', caption: '📸 Cadena dije esmeralda\nCompra aquí: https://www.mr18kts.online/pieza/cadena-dije-esmeralda' };

test('con una foto, la respuesta va en su pie para llegar en orden', () => {
    const { images, texts } = mergeTextIntoCaption([foto], ['¿Te ayudo con algo más?']);
    assert.equal(texts.length, 0);
    assert.equal(images[0].caption, `${foto.caption}\n\n¿Te ayudo con algo más?`);
});

test('sin foto, con varias fotos o con texto muy largo no se toca nada', () => {
    assert.deepEqual(mergeTextIntoCaption([], ['Hola']), { images: [], texts: ['Hola'] });
    assert.equal(mergeTextIntoCaption([foto, foto], ['Hola']).texts.length, 1);
    assert.equal(mergeTextIntoCaption([foto], ['x'.repeat(1100)]).texts.length, 1);
});

test('una pieza disponible se compra con su enlace, no con cita', () => {
    assert.match(SYSTEM_PROMPT, /COMPRAR UNA PIEZA DISPONIBLE/);
    assert.match(SYSTEM_PROMPT, /NO ofrezcas cita ni llamada para comprar una pieza disponible/);
    assert.doesNotMatch(SYSTEM_PROMPT, /ni cierres ventas a distancia/);
});
