/** Reglas deterministas de negocio que no deben depender únicamente del modelo. */

export const MULTIPLE_PRODUCT_RESPONSE =
    'Para ver varias opciones, visita nuestra página: https://www.mr18kts.online. Si no estás seguro de cuál elegir, revisa el catálogo y dime el nombre de la pieza que te interese.';

export const SINGLE_PRODUCT_RESPONSE =
    'Solo puedo mostrarte un producto a la vez. Selecciona la pieza que deseas ver.';

export const MULTIPLE_IMAGE_RESPONSE =
    'No es posible enviar varias imágenes. Selecciona un solo producto y te mostraré una imagen.';

export const UNSUPPORTED_FILE_RESPONSE =
    'Solo puedo ayudarte mostrando productos de nuestro catálogo. Envíame el nombre o referencia de la joya que te interesa.';

export const APPOINTMENT_CITY = 'Pitalito';
export const APPOINTMENT_ADDRESS = 'Calle 4 #1-31';
export const APPOINTMENT_DURATION_MINUTES = 60;
export const APPOINTMENT_HOURS = 'lunes a viernes, de 8:00 AM a 12:00 PM y de 2:00 PM a 6:00 PM';

export function isValidAppointmentTime(time: string): boolean {
    const match = /^(\d{1,2}):(\d{2})$/.exec((time || '').trim());
    if (!match) return false;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return minute === 0 && ((hour >= 8 && hour <= 12) || (hour >= 14 && hour <= 18));
}

const PRODUCT_TYPES = [
    'anillo', 'anillos', 'cadena', 'cadenas', 'collar', 'collares',
    'arete', 'aretes', 'pulsera', 'pulseras', 'dije', 'dijes',
    'candado', 'candados', 'diente', 'dientes', 'joya', 'joyas',
];

function normalize(value: string): string {
    return (value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** Detecta solicitudes que deben ir al sitio web en vez de listar productos. */
export function isMultipleProductRequest(text: string): boolean {
    const normalized = normalize(text);
    if (!normalized) return false;

    if (/(todos?|toda|todas) (los )?(productos?|articulos?|piezas?|joyas?)/.test(normalized)) return true;
    if (/(todo el|toda la|todos los|todas las)?\s*(catalogo|inventario)\b/.test(normalized)) return true;
    if (/(que|que tienen|que hay|muestrame|muestreme|quiero ver|dame).*(productos?|opciones?|piezas?|joyas?)/.test(normalized)) return true;
    if (/(dos|tres|cuatro|varios|varias|mas de uno|mas de una|variedad)\s+(productos?|piezas?|joyas?|fotos?|imagenes?)/.test(normalized)) return true;
    if (/\b\d+\s+(productos?|piezas?|joyas?|fotos?|imagenes?)\b/.test(normalized)) return true;

    const mentionedTypes = new Set(PRODUCT_TYPES.filter(type => new RegExp(`\\b${type}\\b`).test(normalized)));
    const singularTypes = new Set([...mentionedTypes].map(type => type.replace(/s$/, '')));
    return singularTypes.size >= 2;
}

export function isMultipleImageRequest(text: string): boolean {
    const normalized = normalize(text);
    return /\b(dos|tres|cuatro|varias|varios|mas de una|mas de uno|\d+)\s+(fotos?|imagenes?)\b/.test(normalized)
        || /\b(fotos?|imagenes?)\s+de\s+(dos|tres|cuatro|varias|varios|\d+)\b/.test(normalized);
}

export function availabilityLabel(stock: number): 'disponible' | 'bajo_pedido' {
    return Number(stock) > 0 ? 'disponible' : 'bajo_pedido';
}

export function availabilityInstruction(stock: number): string {
    return availabilityLabel(stock) === 'bajo_pedido'
        ? 'Esta pieza está disponible bajo pedido. Indica que debe separar una cita o visitarnos personalmente para confirmar disponibilidad.'
        : 'Esta pieza aparece disponible en el catálogo.';
}

const UNSUPPORTED_INBOUND_TYPES = new Set([
    'image', 'document', 'audio', 'video', 'sticker', 'contacts', 'location',
]);

export function isUnsupportedInboundType(type?: string): boolean {
    return !!type && UNSUPPORTED_INBOUND_TYPES.has(type.toLowerCase());
}
