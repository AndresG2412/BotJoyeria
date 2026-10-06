import assert from 'node:assert/strict';
import test from 'node:test';
import { findProductByReference, mapSitePiece, matchesProductFilters, matchesQuery } from '../src/data/catalog';

// Forma real de una pieza en GET /api/products?depth=1 de la tienda.
const doc = {
    id: 37,
    titulo: 'Cadena dije esmeralda ',
    resumen: 'Cadena  con dije de esmeralda natural',
    descripcion: null,
    galeria: [
        { id: 'a', imagen: { id: 3, interna: false, url: '/api/media/file/foto.avif', sizes: { tarjeta: { url: '/api/media/file/foto-750x1000.webp' } } } },
        { id: 'b', imagen: { id: 4, interna: true, url: '/api/media/file/interna.avif', sizes: {} } },
        { id: 'c', imagen: 5 },
    ],
    material: 'oro-amarillo-18k',
    gema: 'esmeralda',
    tonos: ['amarillo'],
    pesoGramos: 1.32,
    priceInCOPEnabled: true,
    priceInCOP: 2250000,
    porEncargo: false,
    inventory: 1,
    categorias: [{ id: 10, titulo: 'Cadenas', slug: 'cadenas' }],
    slug: 'cadena-dije-esmeralda',
    _status: 'published',
};

test('convierte una pieza de la tienda al formato del bot', () => {
    const p = mapSitePiece(doc);
    assert.equal(p.id, '37');
    assert.equal(p.name, 'Cadena dije esmeralda');
    assert.equal(p.price, 2250000);
    assert.equal(p.stock, 1);
    assert.equal(p.peso, 1.32);
    assert.equal(p.material, 'Oro amarillo 18K');
    assert.equal(p.piedra, 'Esmeralda colombiana');
    assert.equal(p.colorPiedra, 'verde');
    assert.equal(p.categoriaId, 'cadenas');
    assert.deepEqual(p.categorias, ['Cadenas']);
    assert.equal(p.url, 'https://www.mr18kts.online/pieza/cadena-dije-esmeralda');
    // Solo fotos públicas, en tamaño tarjeta y con la URL completa.
    assert.deepEqual(p.imagenes, ['https://www.mr18kts.online/api/media/file/foto-750x1000.webp']);
});

test('sin precio habilitado la pieza queda «a consultar» (precio 0)', () => {
    assert.equal(mapSitePiece({ ...doc, priceInCOPEnabled: false }).price, 0);
    assert.equal(mapSitePiece({ ...doc, gema: 'ninguna' }).piedra, '');
});

test('encuentra la pieza por id, slug o nombre exacto', () => {
    const products = [mapSitePiece(doc), mapSitePiece({ ...doc, id: 38, titulo: 'Anillo solitario', slug: 'anillo-solitario' })];
    assert.equal(findProductByReference(products, '37')?.id, '37');
    assert.equal(findProductByReference(products, 'anillo-solitario')?.id, '38');
    assert.equal(findProductByReference(products, 'cadena DIJE esmeralda.')?.id, '37');
    assert.equal(findProductByReference(products, 'cadena'), null);
});

test('la búsqueda acepta palabras sueltas, plurales y tildes', () => {
    const p = mapSitePiece(doc);
    assert.equal(matchesQuery(p, 'cadenas de oro con esmeralda'), true);
    assert.equal(matchesQuery(p, 'dije esmeraldá 18k'), true);
    assert.equal(matchesQuery(p, 'cadena de plata'), false);
    assert.equal(matchesQuery(p, 'de con'), false);
});

test('los filtros usan las categorías de la tienda', () => {
    const p = mapSitePiece(doc);
    assert.equal(matchesProductFilters(p, { storeId: 'default', categoriaId: 'cadena', material: 'oro amarillo', piedra: 'esmeralda' }), true);
    assert.equal(matchesProductFilters(p, { storeId: 'default', categoriaId: 'anillos' }), false);
    assert.equal(matchesProductFilters(p, { storeId: 'default', categoriaId: 'cadena', presupuestoMax: 2000000 }), false);
});
