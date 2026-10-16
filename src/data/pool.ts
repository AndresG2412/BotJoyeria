import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { config } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Conexión a la base de la tienda con el rol `bot_joyeria`, que solo puede leer y
 * escribir en el esquema `bot` (sesiones y citas). Ver supabase/002_bot_schema.sql.
 *
 * BOT_DATABASE_URL usa el Transaction pooler de Supabase (puerto 6543, IPv4):
 *   postgresql://bot_joyeria.<ref>:<password>@aws-0-us-east-1.pooler.supabase.com:6543/postgres
 *
 * TLS con verificación completa: el certificado del pooler lo firma la CA propia de
 * Supabase, que se descarga del panel (Database → Settings → SSL Configuration →
 * Download certificate) y se guarda como `supabase-ca.crt` en la raíz del bot
 * (o donde indique BOT_DATABASE_CA_PATH). Sin ese archivo el bot NO se conecta.
 */
function loadCa(): string | null {
    const caPath = path.resolve(process.cwd(), config.BOT_DATABASE_CA_PATH || 'supabase-ca.crt');
    try {
        return fs.readFileSync(caPath, 'utf8');
    } catch {
        logger.error(`❌ No se encontró el certificado de Supabase en ${caPath}. Descárgalo del panel de Supabase (Database → Settings → SSL Configuration).`);
        return null;
    }
}

function createPool(): Pool | null {
    if (!config.BOT_DATABASE_URL) {
        logger.error('❌ Falta BOT_DATABASE_URL en el .env: el bot no podrá guardar conversaciones ni citas.');
        return null;
    }
    const ca = loadCa();
    if (!ca) return null;

    const pool = new Pool({
        connectionString: config.BOT_DATABASE_URL,
        ssl: { ca, rejectUnauthorized: true },
        max: 4,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
    });
    // Un cliente inactivo que se cae (p. ej. la base se pausó) no debe tumbar el proceso.
    pool.on('error', error => logger.error(`Base de datos: conexión inactiva perdida: ${error.message}`));
    return pool;
}

export const pool = createPool();

/** Verifica la conexión y los permisos al arrancar. */
export async function initializeDatabase(): Promise<boolean> {
    if (!pool) return false;
    try {
        await pool.query('select 1 from bot.sessions limit 1');
        logger.info('✅ Base de datos conectada (esquema bot).');
        return true;
    } catch (error: any) {
        logger.error(`❌ Error conectando a la base de datos: ${error.message}`);
        return false;
    }
}
