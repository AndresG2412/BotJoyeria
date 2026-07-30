import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './env';
import { logger } from '../utils/logger';

/**
 * Cliente único de Supabase para todo el backend.
 *
 * Credenciales (van en .env, NUNCA hardcodeadas):
 *   - SUPABASE_URL               → https://<tu-proyecto>.supabase.co
 *   - SUPABASE_ANON_KEY          → clave pública (publishable/anon)
 *   - SUPABASE_SERVICE_ROLE_KEY  → opcional; si existe se usa en su lugar y
 *                                  omite las políticas RLS (recomendado para backend).
 *
 * La conexión se hace vía HTTPS (PostgREST + Storage API), no vía Postgres directo,
 * así que funciona aunque la red no tenga salida IPv6 al host db.<ref>.supabase.co.
 */
function createSupabaseClient(): SupabaseClient | null {
    const url = config.SUPABASE_URL;
    const key = config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_ANON_KEY;

    if (!url || !key) {
        logger.error('❌ Supabase no configurado. Define SUPABASE_URL y SUPABASE_ANON_KEY (o SUPABASE_SERVICE_ROLE_KEY) en el archivo .env');
        return null;
    }

    return createClient(url, key, {
        auth: {
            // Backend: no necesitamos sesiones de usuario de Supabase Auth
            persistSession: false,
            autoRefreshToken: false,
        },
    });
}

export const supabase = createSupabaseClient();

/** Nombre del bucket de Storage para las imágenes de productos */
export const PRODUCT_IMAGES_BUCKET = 'productos';

/**
 * Verifica la conexión con Supabase al arrancar (equivalente al antiguo initializeFirebase).
 */
export const initializeSupabase = async (): Promise<boolean> => {
    if (!supabase) return false;
    try {
        const { error } = await supabase.from('categorias').select('id', { head: true, count: 'exact' });
        if (error) throw error;
        logger.info('✅ Supabase conectado exitosamente a la base de datos!');
        return true;
    } catch (error: any) {
        logger.error(`❌ Error conectando a Supabase: ${error.message || error}`);
        return false;
    }
};
