/**
 * Formato compartido entre la web pública y el webhook de WhatsApp.
 * La referencia utiliza el id actual del producto, por lo que no requiere
 * una columna adicional en Supabase y sigue siendo segura por tienda.
 */

export type WebProductLead = {
    /** Referencia exacta del producto; vacía cuando el mensaje solo trae el nombre. */
    productId: string;
    productName: string;
    /** Tono de oro elegido en la ficha de la tienda, si vino en el mensaje. */
    tono?: string;
};

/**
 * Mensaje que arma hoy el botón «Consultar por WhatsApp» de la ficha en la tienda
 * (linkConsultaPieza en src/datos/catalogo.ts del sitio):
 *   Hola, me interesa la pieza: <título>[ en Oro amarillo|blanco|rosa]. ¿Me das más info?
 */
const SITE_PIECE_MESSAGE = /^hola,\s*me interesa la pieza:\s*(.+?)(?:\s+en\s+(oro\s+(?:amarillo|blanco|rosa)))?\s*\.\s*¿me das más info\?\s*$/i;

/** Referencia con la que se busca la pieza: el id si vino, si no el nombre. */
export function webLeadReference(lead: WebProductLead): string {
    return lead.productId || lead.productName;
}

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

    const sitePiece = SITE_PIECE_MESSAGE.exec(value);
    if (sitePiece) {
        const productName = sitePiece[1].replace(/\s+/g, ' ').trim();
        if (!productName) return null;
        return sitePiece[2]
            ? { productId: '', productName, tono: sitePiece[2].replace(/\s+/g, ' ') }
            : { productId: '', productName };
    }

    if (!/\bvi\s+en\s+la\s+web\b/i.test(value)) return null;

    const reference = /\(\s*ref(?:erencia)?\.?\s*:\s*([^\)]+)\)/i.exec(value)?.[1]?.trim();
    if (!reference) return null;

    const productName = /producto\s+["“”']([^"“”']+)["“”']/i.exec(value)?.[1]?.trim()
        || /producto\s+(.+?)\s*\(\s*ref/i.exec(value)?.[1]?.trim()
        || '';

    return { productId: reference, productName };
}
