import { pool } from './pool';
import { logger } from '../utils/logger';

/** Lo que la base devuelve de una orden de taller ya verificada (supabase/004_consulta_taller.sql). */
export type RepairOrderRow = {
    numero: string;
    pieza: string;
    material: string | null;
    estado: string | null;
    fecha_recibido: Date | null;
    fecha_prometida: Date | null;
    entregada_en: Date | null;
    saldo: string | number | null;
};

export type RepairLookup = (input: { numero?: string; documento?: string; telefono?: string }) => Promise<RepairOrderRow[] | null>;

/**
 * Consulta las órdenes del taller de la tienda. La verificación ocurre en la base: solo
 * vuelven órdenes cuyos datos coinciden. Devuelve null si la consulta no está disponible.
 */
export const lookupRepairOrders: RepairLookup = async ({ numero, documento, telefono }) => {
    if (!pool) return null;
    try {
        const { rows } = await pool.query(
            'select * from bot.consultar_orden_taller($1, $2, $3)',
            [numero || null, documento || null, telefono || null],
        );
        return rows as RepairOrderRow[];
    } catch (e: any) {
        // Sin los argumentos: pueden traer la cédula del cliente.
        logger.error(`Error consultando órdenes de taller: ${e.message}`);
        return null;
    }
};
