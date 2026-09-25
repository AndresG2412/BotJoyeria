import dotenv from 'dotenv';
import path from 'path';

// Cargar variables de entorno desde .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/** Lee un entero positivo del entorno; si falta o es inválido usa el valor por defecto. */
function intFromEnv(name: string, fallback: number): number {
    const value = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENAI_API_KEY_2: process.env.OPENAI_API_KEY_2 || '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || '',
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    STORE_NAME: process.env.STORE_NAME || 'nuestro ecommerce',
    PORT: process.env.PORT || 3000,
    DASHBOARD_USER: process.env.DASHBOARD_USER || 'admin',
    DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || 'admin123',
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN || '',
    META_PHONE_ID: process.env.META_PHONE_ID || '',
    META_WABA_ID: process.env.META_WABA_ID || '',
    META_APP_SECRET: process.env.META_APP_SECRET || '',
    META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN || '',
    META_API_VERSION: process.env.META_API_VERSION || 'v26.0',
    NGROK_AUTHTOKEN: process.env.NGROK_AUTHTOKEN || '',
    NGROK_DOMAIN: process.env.NGROK_DOMAIN || '',
    JWT_SECRET: process.env.JWT_SECRET || 'super-secreto-ai-bot-99',
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || '',
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || '',
    RESEND_API_KEY: process.env.RESEND_API_KEY || '',
    // Supabase (base de datos + Storage de imágenes)
    SUPABASE_URL: process.env.SUPABASE_URL || '',
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    // Ruta al JSON de cuenta de servicio de Google (solo para Google Calendar)
    GOOGLE_SERVICE_ACCOUNT_PATH: process.env.GOOGLE_SERVICE_ACCOUNT_PATH || '',
    // Agrupación de mensajes consecutivos del mismo cliente (WhatsApp)
    WHATSAPP_BATCH_QUIET_MS: intFromEnv('WHATSAPP_BATCH_QUIET_MS', 3000),
    WHATSAPP_BATCH_MAX_WAIT_MS: intFromEnv('WHATSAPP_BATCH_MAX_WAIT_MS', 10000),
    // Conversaciones procesándose con la IA al mismo tiempo (protege servidor y cuota)
    BOT_MAX_CONCURRENT_CONVERSATIONS: intFromEnv('BOT_MAX_CONCURRENT_CONVERSATIONS', 5),
    // Límites de calidad por mensaje entrante (no son límites oficiales de Meta)
    BOT_MAX_TEXT_MESSAGES: intFromEnv('BOT_MAX_TEXT_MESSAGES', 3),
    BOT_MAX_IMAGES: intFromEnv('BOT_MAX_IMAGES', 3),
};

// Validación simple
if (!config.OPENAI_API_KEY) {
    console.warn("⚠️ ADVERTENCIA: No se ha configurado OPENAI_API_KEY en el archivo .env!");
}
if (!config.META_ACCESS_TOKEN) {
    console.warn("⚠️ ADVERTENCIA: No se ha configurado META_ACCESS_TOKEN para la WhatsApp Cloud API.");
}
if (!config.META_PHONE_ID) {
    console.warn("⚠️ ADVERTENCIA: No se ha configurado META_PHONE_ID para la WhatsApp Cloud API.");
}
if (!config.META_APP_SECRET) {
    console.warn("⚠️ ADVERTENCIA: No se ha configurado META_APP_SECRET para validar el webhook de WhatsApp.");
}
if (!config.META_VERIFY_TOKEN) {
    console.warn("⚠️ ADVERTENCIA: No se ha configurado META_VERIFY_TOKEN para verificar el webhook de WhatsApp.");
}
