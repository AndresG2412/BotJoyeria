import crypto from 'crypto';
import { countRepairFailures, lookupRepairOrders, recordRepairFailure, RepairLookup, RepairOrderRow } from '../data/taller';
import { APPOINTMENT_ADDRESS, APPOINTMENT_CITY } from './policies';

// ─────────────────────────────────────────────────────────────────────────────
//  Consulta del estado de reparaciones (Mostrador → Taller de la tienda)
//
//  Quién puede ver una orden lo decide este código y la base, nunca la IA:
//    - número de orden + escribe desde el celular del cliente → reporte
//    - número de orden + cédula del titular                   → reporte
//    - cédula + escribe desde el celular del cliente          → sus órdenes
//  El celular sale del webhook de WhatsApp (lo certifica Meta), no de lo que diga el chat.
//  Nunca se confirma si una orden o una cédula existe cuando la verificación falla.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_FAILED_REPAIR_LOOKUPS = 3;
const FAILED_LOOKUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Dónde se cuentan los intentos fallidos. En producción, la base (sobrevive a los reinicios);
 * si la base no responde, la memoria del proceso, para no quedarse nunca sin límite.
 */
export type RepairAttemptStore = {
    failures(keys: string[], now: number): Promise<number>;
    record(keys: string[], now: number): Promise<void>;
};

const memory = new Map<string, number[]>();

function memoryFailures(key: string, now: number): number {
    const recent = (memory.get(key) || []).filter(at => now - at < FAILED_LOOKUP_WINDOW_MS);
    if (recent.length) memory.set(key, recent);
    else memory.delete(key);
    return recent.length;
}

export const memoryAttemptStore: RepairAttemptStore = {
    async failures(keys, now) {
        return Math.max(0, ...keys.map(key => memoryFailures(key, now)));
    },
    async record(keys, now) {
        for (const key of keys) {
            memoryFailures(key, now);
            memory.set(key, [...(memory.get(key) || []), now]);
        }
    },
};

export const databaseAttemptStore: RepairAttemptStore = {
    async failures(keys, now) {
        const stored = await countRepairFailures(keys, new Date(now - FAILED_LOOKUP_WINDOW_MS));
        return stored ?? memoryAttemptStore.failures(keys, now);
    },
    async record(keys, now) {
        // También en memoria: si la base se cae justo después, el límite sigue valiendo.
        await memoryAttemptStore.record(keys, now);
        await recordRepairFailure(keys, new Date(now));
    },
};

/** Claves de conteo: el chat y, si la hay, la cédula (con hash: la cédula nunca se guarda en claro). */
export function repairAttemptKeys(sessionKey: string, documento?: string | null): string[] {
    const keys = [`chat:${sessionKey}`];
    if (documento) keys.push(`doc:${crypto.createHash('sha256').update(documento).digest('hex')}`);
    return keys;
}

export async function isRepairLookupLocked(
    keys: string[], now = Date.now(), store: RepairAttemptStore = databaseAttemptStore,
): Promise<boolean> {
    return (await store.failures(keys, now)) >= MAX_FAILED_REPAIR_LOOKUPS;
}

/** Solo para pruebas. */
export function resetRepairLookupAttempts(): void {
    memory.clear();
}

/** Número de orden tal como lo escriba el cliente ("#T-0012", "t 0012"): letras y números. */
export function normalizeOrderNumber(value: unknown): string | null {
    const clean = String(value ?? '').replace(/[^0-9a-z]/gi, '').toUpperCase();
    return clean.length >= 1 && clean.length <= 20 ? clean : null;
}

/** Cédula o documento: solo dígitos, entre 5 y 12. */
export function normalizeDocument(value: unknown): string | null {
    const digits = String(value ?? '').replace(/\D/g, '');
    return digits.length >= 5 && digits.length <= 12 ? digits : null;
}

/** Celular colombiano del remitente (10 dígitos), o null si escribe con un identificador que no es teléfono. */
export function senderMobile(senderPhone: string): string | null {
    // WhatsApp entrega el número solo en dígitos; un identificador con letras o prefijo
    // (BSUID, Telegram) no es un teléfono que Meta certifique.
    if (!/^\d+$/.test(senderPhone || '')) return null;
    const digits = senderPhone;
    const local = digits.startsWith('57') && digits.length === 12 ? digits.slice(2) : digits;
    return /^3\d{9}$/.test(local) ? local : null;
}

/** Valores reales de enum_ordenes_taller_estado en la base de la tienda. */
const EXACT_STATUS_LABELS: Record<string, string> = {
    'recibido': 'Recibida en el taller',
    'en-taller': 'En reparación',
    'listo': 'Lista para recoger',
    'entregado': 'Entregada',
    'cancelado': 'Cancelada',
};

// Respaldo por si el admin agrega un estado nuevo.
const STATUS_LABELS: Array<[RegExp, string]> = [
    [/cancel/, 'Cancelada'],
    [/entregad/, 'Entregada'],
    [/list|termin|para_?entreg|para_?recog/, 'Lista para recoger'],
    [/aprob|espera/, 'Esperando tu aprobación'],
    [/diagnost|revis|cotiz|evalu/, 'En revisión'],
    [/proceso|repar|trabaj|taller/, 'En reparación'],
    [/recib|ingres|pendiente|nueva/, 'Recibida en el taller'],
];

/** Estado del admin (valor interno) → texto para el cliente. */
export function repairStatusLabel(estado: string | null | undefined): string {
    const value = (estado || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (!value) return 'En proceso';
    if (EXACT_STATUS_LABELS[value]) return EXACT_STATUS_LABELS[value];
    const match = STATUS_LABELS.find(([pattern]) => pattern.test(value));
    if (match) return match[1];
    const text = value.replace(/[_-]+/g, ' ').trim();
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatDate(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat('es-CO', {
        timeZone: 'America/Bogota', day: 'numeric', month: 'long', year: 'numeric',
    }).format(date);
}

function formatPesos(value: string | number | null | undefined): string | null {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return `$${Math.round(amount).toLocaleString('es-CO')}`;
}

/** Lo único que se le pasa a la IA de cada orden. */
export function buildRepairReport(row: RepairOrderRow) {
    const estado = repairStatusLabel(row.estado);
    return {
        numero_orden: row.numero,
        pieza: [row.pieza, row.material ? `(${String(row.material).replace(/[_-]+/g, ' ')})` : ''].filter(Boolean).join(' '),
        estado,
        recibida: formatDate(row.fecha_recibido),
        fecha_prometida: estado === 'Entregada' || estado === 'Cancelada' ? null : formatDate(row.fecha_prometida),
        entregada: formatDate(row.entregada_en),
        saldo_pendiente: estado === 'Cancelada' ? null : formatPesos(row.saldo),
    };
}

type RepairContext = { sessionKey: string; senderPhone: string };

/** Lógica de la herramienta check_repair_status. Devuelve el JSON que recibe la IA. */
export async function checkRepairStatus(
    args: { numero_orden?: string; cedula?: string },
    context: RepairContext,
    lookup: RepairLookup = lookupRepairOrders,
    now = Date.now(),
    attempts: RepairAttemptStore = databaseAttemptStore,
): Promise<string> {
    const numero = normalizeOrderNumber(args?.numero_orden);
    const rawDocument = String(args?.cedula ?? '').trim();
    const documento = normalizeDocument(rawDocument);
    const telefono = senderMobile(context.senderPhone);
    // Se cuenta por chat y por cédula: cambiar de celular no reinicia los intentos contra una cédula.
    const attemptKeys = repairAttemptKeys(context.sessionKey, documento);

    if (await isRepairLookupLocked(attemptKeys, now, attempts)) {
        return JSON.stringify({
            verificado: false,
            instrucciones: `Por seguridad ya no puedo consultar más reparaciones desde este chat hoy. Dile al cliente que se acerque a la joyería (${APPOINTMENT_ADDRESS}, ${APPOINTMENT_CITY}) con su recibo, o que lo intente mañana. No des más detalles.`,
        });
    }

    if (rawDocument && !documento) {
        return JSON.stringify({
            verificado: false,
            instrucciones: 'La cédula no parece válida. Pídele al cliente que la escriba de nuevo, solo los números.',
        });
    }
    if (!numero && !documento) {
        return JSON.stringify({
            verificado: false,
            instrucciones: 'Pídele al cliente el número de orden que aparece en su recibo del taller. Si no lo tiene, pídele la cédula del titular de la orden.',
        });
    }
    // Solo cédula, desde un número que no es celular: no hay con qué cruzarla.
    if (!numero && !telefono) {
        return JSON.stringify({
            verificado: false,
            instrucciones: 'Pídele al cliente el número de orden que aparece en su recibo del taller.',
        });
    }

    const rows = await lookup({ numero: numero || undefined, documento: documento || undefined, telefono: telefono || undefined });
    if (rows === null) {
        return JSON.stringify({
            verificado: false,
            instrucciones: 'En este momento no pude consultar el taller. Dile al cliente que lo intente más tarde o que un asesor le confirma. No menciones errores técnicos.',
        });
    }

    if (rows.length > 0) {
        const ordenes = rows.map(buildRepairReport);
        return JSON.stringify({
            verificado: true,
            ordenes,
            instrucciones: [
                ordenes.length === 1
                    ? 'Informa al cliente el estado de su joya en una o dos frases cortas: pieza, estado y la fecha prometida si la hay.'
                    : 'El cliente tiene varias órdenes: resume cada una en una línea corta (número de orden y estado) y pregunta cuál quiere revisar en detalle.',
                `Si está "Lista para recoger", invítalo a recogerla en ${APPOINTMENT_ADDRESS}, ${APPOINTMENT_CITY}, con su recibo, y menciona el saldo pendiente si lo hay.`,
                'Nunca repitas la cédula del cliente. No inventes fechas ni costos que no estén aquí.',
            ].join(' '),
        });
    }

    // Sin coincidencias. Nunca decir si la orden o la cédula existen.
    if (documento) {
        await attempts.record(attemptKeys, now);
        const left = MAX_FAILED_REPAIR_LOOKUPS - await attempts.failures(attemptKeys, now);
        return JSON.stringify({
            verificado: false,
            instrucciones: numero
                ? `No pude verificar la orden con esos datos. Pídele al cliente que revise el número de orden de su recibo y la cédula del titular.${left > 0 ? '' : ' Si no coincide, debe acercarse a la joyería con su recibo.'}`
                : 'No encontré órdenes con esa cédula asociadas a este WhatsApp. Pídele el número de orden que aparece en su recibo del taller.',
        });
    }
    return JSON.stringify({
        verificado: false,
        instrucciones: 'Para verificar la orden, pídele al cliente la cédula del titular (la persona que dejó la joya).',
    });
}
