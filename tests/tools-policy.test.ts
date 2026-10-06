import assert from 'node:assert/strict';
import test from 'node:test';
import { botTools, limitProductImages, MAX_PRODUCT_IMAGES_PER_RESPONSE } from '../src/bot/tools';

test('no expone una herramienta para listar toda la base de productos', () => {
    const names = botTools.map(tool => tool.function.name);
    assert.equal(names.includes('list_all_products'), false);
    assert.equal(names.includes('search_products'), true);
    assert.equal(names.includes('filter_products'), true);
    assert.equal(names.includes('send_product_image'), true);
    assert.equal(names.includes('reschedule_appointment'), true);
});

test('limita las imágenes a una por respuesta', () => {
    const images = ['a', 'b', 'c'];
    assert.equal(MAX_PRODUCT_IMAGES_PER_RESPONSE, 1);
    assert.deepEqual(limitProductImages(images, 0, 3), ['a']);
    assert.deepEqual(limitProductImages(images, 1, 3), []);
    assert.deepEqual(limitProductImages(images, 0, 1), ['a']);
});

test('normaliza celulares y fijos colombianos', async () => {
    const { normalizeColombianMobile } = await import('../src/bot/tools');
    assert.equal(normalizeColombianMobile('+57 313 453 2440'), '3134532440');
    assert.equal(normalizeColombianMobile('6088365000'), '6088365000');
    assert.equal(normalizeColombianMobile('12345'), null);
    assert.equal(normalizeColombianMobile('1234567890'), null);
});
