/**
 * Formato compartido entre la web pública y el webhook de WhatsApp.
 * La referencia utiliza el id actual del producto, por lo que no requiere
 * una columna adicional en Supabase y sigue siendo segura por tienda.
 */

export type WebProductLead = {
    productId: string;
    productName: string;
};

export function buildWebProductMessage(productName: string, productId: string): string {
    const safeName = (productName || 'este producto').replace(/["“”']/g, '').replace(/\s+/g, ' ').trim();
    return `Hola, estoy interesado en el producto "${safeName}" (Ref: ${productId}) que vi en la web. Por favor dame más información.`;
}

/**
 * Reconoce únicamente el formato generado por el botón de la web.
 * Exigir "vi en la web" evita convertir una consulta normal con una
 * referencia escrita manualmente en un lead directo.
 */
export function parseWebProductLead(text: string): WebProductLead | null {
    const value = (text || '').trim();
    if (!/\bvi\s+en\s+la\s+web\b/i.test(value)) return null;

    const reference = /\(\s*ref(?:erencia)?\.?\s*:\s*([^\)]+)\)/i.exec(value)?.[1]?.trim();
    if (!reference) return null;

    const productName = /producto\s+["“”']([^"“”']+)["“”']/i.exec(value)?.[1]?.trim()
        || /producto\s+(.+?)\s*\(\s*ref/i.exec(value)?.[1]?.trim()
        || '';

    return { productId: reference, productName };
}
