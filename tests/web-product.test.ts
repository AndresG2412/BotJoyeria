import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildWebProductMessage,
    parseWebProductLead,
} from '../src/utils/web-product';

test('construye el mensaje que debe usar el botón de la web', () => {
    const message = buildWebProductMessage('Anillo de Oro 18K', 'AN-001');
    assert.equal(
        message,
        'Hola, estoy interesado en el producto "Anillo de Oro 18K" (Ref: AN-001) que vi en la web. Por favor dame más información.',
    );
});

test('el mensaje generado se reconoce como lead web', () => {
    const message = buildWebProductMessage('Anillo de Oro 18K', 'AN-001');
    assert.deepEqual(
        parseWebProductLead(message),
        { productId: 'AN-001', productName: 'Anillo de Oro 18K' },
    );
});

test('detecta únicamente leads con formato de la web', () => {
    const lead = parseWebProductLead(
        'Hola, estoy interesado en el producto "Anillo de Oro 18K" (Ref: AN-001) que vi en la web. Por favor dame más información.',
    );
    assert.deepEqual(lead, { productId: 'AN-001', productName: 'Anillo de Oro 18K' });
    assert.equal(parseWebProductLead('Hola, me interesa la referencia AN-001'), null);
});

test('acepta referencias largas y nombres con caracteres especiales', () => {
    const lead = parseWebProductLead(
        'Hola, estoy interesado en el producto “Anillo María & José” (Referencia: 550e8400-e29b-41d4-a716-446655440000) que vi en la web.',
    );
    assert.equal(lead?.productId, '550e8400-e29b-41d4-a716-446655440000');
    assert.equal(lead?.productName, 'Anillo María & José');
});

test('reconoce el mensaje del botón de la ficha de la tienda', () => {
    assert.deepEqual(
        parseWebProductLead('Hola, me interesa la pieza: Cadena dije esmeralda . ¿Me das más info?'),
        { productId: '', productName: 'Cadena dije esmeralda' },
    );
    assert.deepEqual(
        parseWebProductLead('Hola, me interesa la pieza: Anillo Sr. Martínez en Oro blanco. ¿Me das más info?'),
        { productId: '', productName: 'Anillo Sr. Martínez', tono: 'Oro blanco' },
    );
    assert.equal(parseWebProductLead('Hola, me interesa la pieza que vi ayer'), null);
});
