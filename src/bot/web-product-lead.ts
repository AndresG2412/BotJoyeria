import type { Product } from '../data/catalog';

export function buildWebProductLeadResponse(product: Product | null, tono?: string): string {
    if (!product) {
        return 'Hola, gracias por escribirnos. No pude validar esa pieza en nuestro catálogo actual. Puedes enviarnos una captura o el nombre del producto para ayudarte.';
    }

    const name = product.name || product.nombre || 'esta pieza';
    const pieza = tono ? `${name} en ${tono.toLowerCase()}` : name;
    if (Number(product.stock) > 0) {
        return `Hola, gracias por escribirnos. El producto de tu interés es ${pieza} y aparece disponible. ¿Es correcto? Si deseas, te ayudo a agendar una cita para verlo presencialmente en Pitalito.`;
    }

    return `Hola, gracias por escribirnos. El producto de tu interés es ${pieza} y aparece actualmente bajo pedido. ¿Es correcto? Si deseas, te ayudo a agendar una cita presencial en Pitalito para revisarlo.`;
}
