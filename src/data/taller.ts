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

/**
 * Intentos fallidos de consulta de reparaciones (supabase/006_intentos_reparaciones.sql). Las
 * claves ya vienen sin datos en claro («chat:…», «doc:<sha256>»). Si la base no responde, el
 * bot sigue con el conteo en memoria (src/bot/repairs.ts): nunca se queda sin límite.
 */
export const countRepairFailures = async (keys: string[], since: Date): Promise<number | null> => {
    if (!pool || keys.length === 0) return null;
    try {
        const { rows } = await pool.query(
            `select coalesce(max(n), 0)::int as n from (
                select count(*) as n from bot.repair_lookup_failures
                where key = any($1) and failed_at > $2 group by key
             ) t`,
            [keys, since],
        );
        return rows[0]?.n ?? 0;
    } catch (e: any) {
        logger.error(`Error leyendo intentos de reparaciones: ${e.message}`);
        return null;
    }
};

export const recordRepairFailure = async (keys: string[], at: Date): Promise<boolean> => {
    if (!pool || keys.length === 0) return false;
    try {
        await pool.query(
            'insert into bot.repair_lookup_failures (key, failed_at) select unnest($1::text[]), $2',
            [keys, at],
        );
        await pool.query(`delete from bot.repair_lookup_failures where failed_at < now() - interval '2 days'`);
        return true;
    } catch (e: any) {
        logger.error(`Error guardando intento de reparaciones: ${e.message}`);
        return false;
    }
};
