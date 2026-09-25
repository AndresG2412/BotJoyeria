import axios from 'axios';
import { config } from '../config/env';

// ─────────────────────────────────────────────────────────────────────────────
//  Salud de WhatsApp Cloud API
//  Cloud API no mantiene una conexión local: la "salud" se deduce de la
//  configuración, del último webhook recibido y de las respuestas de Graph API.
//  Los registros viven en memoria y se reinician al reiniciar el servidor.
// ─────────────────────────────────────────────────────────────────────────────

export type WhatsAppCredentials = { phoneNumberId: string; accessToken: string };

export type WhatsAppState = 'OPERATIVA' | 'CONFIGURACION_INCOMPLETA' | 'ERROR';

type GraphResponse = { at: string; ok: boolean; status: number | null; operation: string };
type ErrorRecord = { at: string; source: string; message: string };

type PhoneActivity = {
    lastWebhookAt: string | null;
    lastMessageSentAt: string | null;
    lastGraphResponse: GraphResponse | null;
    lastGraphSuccessAt: string | null;
    lastError: ErrorRecord | null;
    // Solo errores del canal (Graph API); los fallos de entrega a un cliente no lo marcan como caído.
    lastChannelErrorAt: string | null;
};

type PhoneInfo = { displayPhoneNumber: string | null; verifiedName: string | null; fetchedAt: number };

const PHONE_INFO_TTL_MS = 5 * 60 * 1000;
const trackingSince = new Date().toISOString();
const activityByPhone = new Map<string, PhoneActivity>();
const phoneInfoCache = new Map<string, PhoneInfo>();

function activityFor(phoneNumberId: string): PhoneActivity {
    let activity = activityByPhone.get(phoneNumberId);
    if (!activity) {
        activity = {
            lastWebhookAt: null,
            lastMessageSentAt: null,
            lastGraphResponse: null,
            lastGraphSuccessAt: null,
            lastError: null,
            lastChannelErrorAt: null,
        };
        activityByPhone.set(phoneNumberId, activity);
    }
    return activity;
}

export function recordWebhook(phoneNumberId: string, displayPhoneNumber?: string): void {
    activityFor(phoneNumberId).lastWebhookAt = new Date().toISOString();
    if (displayPhoneNumber && !phoneInfoCache.get(phoneNumberId)?.displayPhoneNumber) {
        phoneInfoCache.set(phoneNumberId, { displayPhoneNumber, verifiedName: null, fetchedAt: 0 });
    }
}

export function recordGraphResponse(phoneNumberId: string, operation: string, ok: boolean, status: number | null): void {
    const activity = activityFor(phoneNumberId);
    const at = new Date().toISOString();
    activity.lastGraphResponse = { at, ok, status, operation };
    if (ok) activity.lastGraphSuccessAt = at;
}

export function recordMessageSent(phoneNumberId: string): void {
    activityFor(phoneNumberId).lastMessageSentAt = new Date().toISOString();
}

export function recordError(phoneNumberId: string, source: string, message: string): void {
    const activity = activityFor(phoneNumberId);
    const at = new Date().toISOString();
    activity.lastError = { at, source, message };
    if (source !== 'delivery') activity.lastChannelErrorAt = at;
}

/** Extrae un mensaje legible de un error de axios/Graph API. */
export function describeGraphError(error: any): string {
    const graphError = error?.response?.data?.error;
    if (graphError) {
        const code = graphError.code ? ` (código ${graphError.code})` : '';
        return `${graphError.message || 'Error de Graph API'}${code}`;
    }
    return error?.message || String(error);
}

/** Consulta el número visible del Phone Number ID (con caché) y verifica de paso el token. */
async function getPhoneInfo(credentials: WhatsAppCredentials): Promise<PhoneInfo | null> {
    const cached = phoneInfoCache.get(credentials.phoneNumberId);
    if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < PHONE_INFO_TTL_MS) return cached;

    try {
        const response = await axios.get(
            `https://graph.facebook.com/${config.META_API_VERSION}/${credentials.phoneNumberId}`,
            {
                params: { fields: 'display_phone_number,verified_name' },
                headers: { Authorization: `Bearer ${credentials.accessToken}` },
                timeout: 10000,
            },
        );
        recordGraphResponse(credentials.phoneNumberId, 'phone_info', true, response.status);
        const info: PhoneInfo = {
            displayPhoneNumber: response.data?.display_phone_number || null,
            verifiedName: response.data?.verified_name || null,
            fetchedAt: Date.now(),
        };
        phoneInfoCache.set(credentials.phoneNumberId, info);
        return info;
    } catch (error: any) {
        recordGraphResponse(credentials.phoneNumberId, 'phone_info', false, error?.response?.status ?? null);
        recordError(credentials.phoneNumberId, 'phone_info', describeGraphError(error));
        // Evita consultar Graph en cada refresco del panel mientras el error persiste.
        const fallback: PhoneInfo = { displayPhoneNumber: cached?.displayPhoneNumber || null, verifiedName: cached?.verifiedName || null, fetchedAt: Date.now() };
        phoneInfoCache.set(credentials.phoneNumberId, fallback);
        return fallback;
    }
}

function formatPhone(displayPhoneNumber: string | null): string | null {
    if (!displayPhoneNumber) return null;
    const trimmed = displayPhoneNumber.trim();
    return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
}

export async function getWhatsAppHealth(credentials: WhatsAppCredentials) {
    const checks = {
        META_ACCESS_TOKEN: !!credentials.accessToken,
        META_PHONE_ID: !!credentials.phoneNumberId,
        META_APP_SECRET: !!config.META_APP_SECRET,
        META_VERIFY_TOKEN: !!config.META_VERIFY_TOKEN,
    };
    const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);

    const phoneInfo = missing.length === 0 ? await getPhoneInfo(credentials) : null;
    const activity = credentials.phoneNumberId ? activityFor(credentials.phoneNumberId) : null;
    const lastError = activity?.lastError || null;

    // El canal está en error si su último fallo es más reciente que la última respuesta exitosa de Graph.
    const lastChannelErrorAt = activity?.lastChannelErrorAt || null;
    const hasActiveError = !!lastChannelErrorAt && (!activity?.lastGraphSuccessAt || lastChannelErrorAt > activity.lastGraphSuccessAt);

    let state: WhatsAppState = 'OPERATIVA';
    if (missing.length > 0) state = 'CONFIGURACION_INCOMPLETA';
    else if (hasActiveError) state = 'ERROR';

    const stateLabels: Record<WhatsAppState, string> = {
        OPERATIVA: 'Operativa',
        CONFIGURACION_INCOMPLETA: 'Configuración incompleta',
        ERROR: 'Error',
    };

    return {
        channel: 'whatsapp-cloud-api',
        state,
        stateLabel: stateLabels[state],
        phoneNumber: formatPhone(phoneInfo?.displayPhoneNumber || null),
        verifiedName: phoneInfo?.verifiedName || null,
        config: { ok: missing.length === 0, missing },
        lastWebhookAt: activity?.lastWebhookAt || null,
        lastMessageSentAt: activity?.lastMessageSentAt || null,
        lastGraphResponse: activity?.lastGraphResponse || null,
        lastError,
        trackingSince,
    };
}
