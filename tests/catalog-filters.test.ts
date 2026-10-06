import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesProductFilters, Product } from '../src/data/catalog';

const ring: Product = {
    id: 'AN-001', storeId: 'store-a', nombre: 'Anillo Elegante', name: 'Anillo Elegante',
    description: 'Pieza en oro blanco con zafiro azul', productType: 'joya', price: 1800000,
    imageUrl: '', checkoutUrl: '', caracteristicas: ['oro blanco', 'zafiro azul'], peso: 3,
    stock: 1, imagenes: [], categoriaId: 'anillos', material: 'oro blanco', piedra: 'zafiro',
    colorMetal: 'blanco', colorPiedra: 'azul', estilo: 'elegante',
};

test('filtra por categoría, material, piedra, color y presupuesto', () => {
    assert.equal(matchesProductFilters(ring, {
        storeId: 'store-a', categoriaId: 'anillo', material: 'oro', piedra: 'zafiro',
        colorPiedra: 'azul', presupuestoMax: 2000000,
    }), true);
    assert.equal(matchesProductFilters(ring, {
        storeId: 'store-a', categoriaId: 'anillo', material: 'plata',
    }), false);
    assert.equal(matchesProductFilters(ring, {
        storeId: 'store-a', categoriaId: 'anillo', presupuestoMax: 1000000,
    }), false);
});

test('mantiene visibles los productos bajo pedido', () => {
    assert.equal(matchesProductFilters({ ...ring, stock: 0 }, {
        storeId: 'store-a', categoriaId: 'anillo', disponibilidad: 'bajo_pedido',
    }), true);
    assert.equal(matchesProductFilters({ ...ring, stock: 0 }, {
        storeId: 'store-a', categoriaId: 'anillo', disponibilidad: 'disponible',
    }), false);
});
