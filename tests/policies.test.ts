import assert from 'node:assert/strict';
import test from 'node:test';
import {
    MULTIPLE_PRODUCT_RESPONSE,
    MULTIPLE_IMAGE_RESPONSE,
    UNSUPPORTED_FILE_RESPONSE,
    availabilityInstruction,
    availabilityLabel,
    APPOINTMENT_ADDRESS,
    APPOINTMENT_CITY,
    isValidAppointmentTime,
    isMultipleProductRequest,
    isMultipleImageRequest,
    isUnsupportedInboundType,
} from '../src/bot/policies';

test('detecta solicitudes de varios productos', () => {
    const cases = [
        'Muéstrame un anillo y una cadena',
        'Mándame fotos de tres productos',
        'Quiero ver todo el catálogo',
        '¿Qué productos tienen disponibles?',
        'Dame varias opciones',
    ];

    for (const message of cases) {
        assert.equal(isMultipleProductRequest(message), true, message);
    }
});

test('no bloquea una consulta de un solo producto', () => {
    const cases = [
        'Quiero un anillo de oro',
        'Muéstrame la cadena AN-001',
        '¿Cuánto cuesta este producto?',
    ];

    for (const message of cases) {
        assert.equal(isMultipleProductRequest(message), false, message);
    }
});

test('usa la respuesta definida para solicitudes múltiples', () => {
    assert.match(MULTIPLE_PRODUCT_RESPONSE, /mr18kts\.online/);
    assert.match(MULTIPLE_PRODUCT_RESPONSE, /nombre de la pieza/);
});

test('separa varias imágenes de la solicitud de varios productos', () => {
    assert.equal(isMultipleImageRequest('Mándame fotos de tres productos'), true);
    assert.equal(isMultipleImageRequest('Quiero dos fotos del AN-001'), true);
    assert.equal(isMultipleImageRequest('Muéstrame la foto del AN-001'), false);
    assert.match(MULTIPLE_IMAGE_RESPONSE, /una imagen/i);
});

test('clasifica stock disponible y bajo pedido', () => {
    assert.equal(availabilityLabel(1), 'disponible');
    assert.equal(availabilityLabel(0), 'bajo_pedido');
    assert.equal(availabilityLabel(-1), 'bajo_pedido');
    assert.match(availabilityInstruction(0), /bajo pedido/i);
    assert.match(availabilityInstruction(0), /cita/i);
});

test('valida los horarios presenciales', () => {
    assert.equal(isValidAppointmentTime('08:00'), true);
    assert.equal(isValidAppointmentTime('12:00'), true);
    assert.equal(isValidAppointmentTime('14:00'), true);
    assert.equal(isValidAppointmentTime('18:00'), true);
    assert.equal(isValidAppointmentTime('13:00'), false);
    assert.equal(isValidAppointmentTime('18:30'), false);
    assert.match(`${APPOINTMENT_CITY} ${APPOINTMENT_ADDRESS}`, /Pitalito.*Calle 4/);
});

test('rechaza archivos y contenido multimedia entrante', () => {
    for (const type of ['image', 'document', 'audio', 'video', 'sticker']) {
        assert.equal(isUnsupportedInboundType(type), true, type);
    }
    assert.equal(isUnsupportedInboundType('text'), false);
    assert.match(UNSUPPORTED_FILE_RESPONSE, /catálogo/i);
});
