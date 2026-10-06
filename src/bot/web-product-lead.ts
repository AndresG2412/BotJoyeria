import type { Product } from '../data/catalog';

export function buildWebProductLeadResponse(product: Product | null): string {
    if (!product) {
        return 'Hola, gracias por escribirnos. No pude validar esa pieza en nuestro catálogo actual. Puedes enviarnos una captura o el nombre del producto para ayudarte.';
    }

    const name = product.name || product.nombre || 'esta pieza';
    if (Number(product.stock) > 0) {
        return `Hola, gracias por escribirnos. El producto de tu interés es ${name} y aparece disponible. ¿Es correcto? Si deseas, te ayudo a agendar una cita para verlo presencialmente en Pitalito.`;
    }

    return `Hola, gracias por escribirnos. El producto de tu interés es ${name} y aparece actualmente bajo pedido. ¿Es correcto? Si deseas, te ayudo a agendar una cita presencial en Pitalito para revisarlo.`;
}
