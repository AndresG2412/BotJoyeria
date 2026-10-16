/**
 * Ley 1581 (Colombia): los logs no deben guardar datos personales. Los números de
 * celular (10 a 13 dígitos seguidos, con o sin indicativo) se enmascaran dejando
 * solo los últimos 4; así se sigue pudiendo rastrear una conversación.
 */
const PHONE_LIKE = /(?<!\d)\d{6,9}(\d{4})(?!\d)/g;

export function maskPhone(value: string): string {
    return String(value ?? '').replace(PHONE_LIKE, '••••$1');
}

function redact(value: any): any {
    if (typeof value === 'string') return maskPhone(value);
    if (value instanceof Error) return maskPhone(value.stack || value.message);
    return value;
}

export const logger = {
    info: (msg: string, ...args: any[]) => console.log(`[INFO] ${new Date().toISOString()} - ${maskPhone(msg)}`, ...args.map(redact)),
    warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${new Date().toISOString()} - ${maskPhone(msg)}`, ...args.map(redact)),
    error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${new Date().toISOString()} - ${maskPhone(msg)}`, ...args.map(redact)),
};
