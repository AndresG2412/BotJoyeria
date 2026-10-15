import type { Product } from '../data/catalog';

export function buildWebProductLeadResponse(product: Product | null, tono?: string): string {
    if (!product) {
        return 'Hola, gracias por escribirnos. No pude validar esa pieza en nuestro catálogo actual. Puedes enviarnos una captura o el nombre del producto para ayudarte.';
    }

    const name = product.name || product.nombre || 'esta pieza';
    const pieza = tono ? `${name} en ${tono.toLowerCase()}` : name;
    if (Number(product.stock) > 0) {
        return `Hola, gracias por escribirnos. ${pieza} está disponible. ¿Te agendo una cita en Pitalito o una llamada?`;
    }

    return `Hola, gracias por escribirnos. ${pieza} está bajo pedido. ¿Te agendo una cita en Pitalito o una llamada?`;
}
