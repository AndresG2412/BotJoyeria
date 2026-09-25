import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import sharp from 'sharp';
import { logger } from '../utils/logger';
import { config } from '../config/env';
import { handleUserMessage } from '../bot/agent';
import { recordUserActivity } from '../bot/remarketing';
import { db } from '../data/connection';
import { getSession, setSessionPause, checkRateLimit, incrementMessageCount, getMemory, saveMemory, getAllSessions } from '../data/database';
import { SYSTEM_PROMPT } from '../bot/prompts';
import { PendingImage } from '../bot/tools';
import {
    WhatsAppCredentials, getWhatsAppHealth, recordWebhook, recordGraphResponse,
    recordMessageSent, recordError, describeGraphError,
} from './whatsapp-health';

type StoreRecord = {
    id: string;
    isActive?: boolean;
    systemPrompt?: string | null;
    openaiApiKey?: string | null;
    whatsappPhoneNumberId?: string | null;
    whatsappAccessToken?: string | null;
};

type RawBodyRequest = Request & { rawBody?: Buffer };

type InboundMessage = {
    id?: string;
    from?: string;
    type?: string;
    text?: { body?: string };
    interactive?: {
        button_reply?: { title?: string };
        list_reply?: { title?: string };
    };
};

type InboundEnvelope = {
    phoneNumberId: string;
    message: InboundMessage;
};

type MessageStatus = {
    id?: string;
    status?: string;
    recipient_id?: string;
    errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }>;
};

/** Conversación = tienda + número de WhatsApp del negocio + cliente. Nunca se mezclan entre sí. */
type Conversation = {
    key: string;
    store: StoreRecord;
    phoneNumberId: string;
    senderPhone: string;
};

type PendingBatch = {
    conversation: Conversation;
    texts: string[];
    lastMessageId?: string;
    firstAt: number;
    timer: NodeJS.Timeout;
};

export const whatsappRouter = Router();

// Formatos que WhatsApp acepta en mensajes de tipo imagen (WebP solo sirve para stickers).
const WHATSAPP_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

const conversationQueues = new Map<string, Promise<void>>();
const pendingBatches = new Map<string, PendingBatch>();
const processedMessageIds = new Map<string, number>();
let inactivityJobStarted = false;
let inactivityJobRunning = false;

function graphUrl(path: string): string {
    return `https://graph.facebook.com/${config.META_API_VERSION}${path}`;
}

function normalizePhone(phone: string): string {
    return phone.replace(/@c\.us$/, '').replace(/\D/g, '');
}

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getStores(): Promise<StoreRecord[]> {
    const stores = await db.query.stores.findMany();
    return (stores || []) as StoreRecord[];
}

async function getStoreById(storeId: string): Promise<StoreRecord | null> {
    const stores = await getStores();
    return stores.find(store => store.id === storeId) || null;
}

async function resolveStore(phoneNumberId: string): Promise<StoreRecord | null> {
    const activeStores = (await getStores()).filter(store => store.isActive !== false);
    const exactStore = activeStores.find(store => store.whatsappPhoneNumberId === phoneNumberId);
    if (exactStore) return exactStore;

    // Single-tenant fallback for the global META_PHONE_ID configuration.
    if (config.META_PHONE_ID === phoneNumberId && activeStores.length > 0) {
        return activeStores[0];
    }

    if (activeStores.length === 1 && !activeStores[0].whatsappPhoneNumberId) {
        return activeStores[0];
    }

    return null;
}

function getCredentials(store?: StoreRecord | null): WhatsAppCredentials {
    return {
        phoneNumberId: (store?.whatsappPhoneNumberId || config.META_PHONE_ID).trim(),
        accessToken: (store?.whatsappAccessToken || config.META_ACCESS_TOKEN).trim(),
    };
}

function assertCredentials(credentials: WhatsAppCredentials): void {
    if (!credentials.phoneNumberId || !credentials.accessToken) {
        throw new Error('Faltan META_PHONE_ID o META_ACCESS_TOKEN para WhatsApp Cloud API');
    }
}

/** POST a Graph API registrando el resultado para el panel de salud. */
async function graphPost<T = any>(credentials: WhatsAppCredentials, operation: string, path: string, body: any, timeout = 20000): Promise<T> {
    assertCredentials(credentials);
    try {
        const response = await axios.post<T>(graphUrl(path), body, {
            headers: { Authorization: `Bearer ${credentials.accessToken}` },
            timeout,
        });
        recordGraphResponse(credentials.phoneNumberId, operation, true, response.status);
        return response.data;
    } catch (error: any) {
        recordGraphResponse(credentials.phoneNumberId, operation, false, error?.response?.status ?? null);
        const message = describeGraphError(error);
        recordError(credentials.phoneNumberId, operation, message);
        throw new Error(message);
    }
}

async function sendTextMessage(store: StoreRecord | null, to: string, text: string): Promise<void> {
    const credentials = getCredentials(store);
    await graphPost(credentials, 'send_text', `/${credentials.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizePhone(to),
        type: 'text',
        text: {
            preview_url: false,
            body: text,
        },
    });
    recordMessageSent(credentials.phoneNumberId);
}

/**
 * WhatsApp solo acepta JPEG y PNG en mensajes de imagen. El catálogo guarda WebP,
 * así que cualquier otro formato se convierte a JPEG (con fondo blanco para transparencias).
 */
async function toWhatsAppImage(image: PendingImage): Promise<{ buffer: Buffer; mimetype: string; filename: string }> {
    const buffer = Buffer.from(image.base64, 'base64');
    const mimetype = image.mimetype.split(';')[0].trim().toLowerCase();

    if (WHATSAPP_IMAGE_TYPES.has(mimetype)) {
        return { buffer, mimetype, filename: mimetype === 'image/png' ? 'product.png' : 'product.jpg' };
    }

    const jpeg = await sharp(buffer)
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 85 })
        .toBuffer();
    return { buffer: jpeg, mimetype: 'image/jpeg', filename: 'product.jpg' };
}

async function uploadMedia(credentials: WhatsAppCredentials, image: PendingImage): Promise<string> {
    const { buffer, mimetype, filename } = await toWhatsAppImage(image);
    const form = new FormData();

    form.append('messaging_product', 'whatsapp');
    form.append('type', mimetype);
    form.append('file', new Blob([Uint8Array.from(buffer)], { type: mimetype }), filename);

    const data = await graphPost<{ id: string }>(credentials, 'upload_media', `/${credentials.phoneNumberId}/media`, form, 30000);
    return data.id;
}

async function sendImageMessage(store: StoreRecord | null, to: string, image: PendingImage): Promise<void> {
    const credentials = getCredentials(store);
    assertCredentials(credentials);
    const mediaId = await uploadMedia(credentials, image);

    await graphPost(credentials, 'send_image', `/${credentials.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizePhone(to),
        type: 'image',
        image: {
            id: mediaId,
            ...(image.caption ? { caption: image.caption } : {}),
        },
    });
    recordMessageSent(credentials.phoneNumberId);
}

/** Marca el mensaje como leído y muestra "escribiendo..." mientras el agente responde. */
async function showTypingIndicator(store: StoreRecord, messageId?: string): Promise<void> {
    if (!messageId) return;
    try {
        const credentials = getCredentials(store);
        await axios.post(
            graphUrl(`/${credentials.phoneNumberId}/messages`),
            {
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: messageId,
                typing_indicator: { type: 'text' },
            },
            { headers: { Authorization: `Bearer ${credentials.accessToken}` }, timeout: 10000 },
        );
    } catch (error: any) {
        // Es solo cosmético: si falla no debe afectar la respuesta.
        logger.warn(`No se pudo mostrar el indicador de escritura: ${describeGraphError(error)}`);
    }
}

async function sendMultipleMessages(store: StoreRecord | null, to: string, messages: string[]): Promise<void> {
    for (let index = 0; index < messages.length; index++) {
        if (index > 0) await wait(1200);
        await sendTextMessage(store, to, messages[index]);
    }
}

export async function sendWhatsAppMessage(storeId: string, to: string, text: string): Promise<void> {
    try {
        const store = await getStoreById(storeId);
        await sendTextMessage(store, to, text);
        logger.info(`✅ Mensaje Cloud API enviado desde [${storeId}] a ${normalizePhone(to)}`);
    } catch (error: any) {
        logger.error(`❌ Error enviando mensaje Cloud API desde [${storeId}]: ${error.message}`);
        throw error;
    }
}

function extractMessageText(message: InboundMessage): string {
    if (message.type === 'text') return message.text?.body?.trim() || '';
    if (message.type === 'interactive') {
        return (
            message.interactive?.button_reply?.title ||
            message.interactive?.list_reply?.title ||
            ''
        ).trim();
    }
    return '';
}

/** Recorre el payload del webhook: registra actividad, estados de entrega y devuelve los mensajes entrantes. */
function extractInboundMessages(payload: any): InboundEnvelope[] {
    const envelopes: InboundEnvelope[] = [];
    if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
        return envelopes;
    }

    for (const entry of payload.entry) {
        for (const change of entry?.changes || []) {
            if (change?.field !== 'messages') continue;
            const value = change.value;
            const phoneNumberId = value?.metadata?.phone_number_id;
            if (!phoneNumberId) continue;

            recordWebhook(phoneNumberId, value?.metadata?.display_phone_number);

            for (const status of (value?.statuses || []) as MessageStatus[]) {
                handleMessageStatus(phoneNumberId, status);
            }

            for (const message of value?.messages || []) {
                envelopes.push({ phoneNumberId, message });
            }
        }
    }

    return envelopes;
}

/**
 * Meta acepta el envío (HTTP 200) y reporta los fallos de entrega después, en el webhook
 * de estados. Sin esto, una imagen rechazada no deja rastro en los logs.
 */
function handleMessageStatus(phoneNumberId: string, status: MessageStatus): void {
    if (status.status !== 'failed') return;
    const error = status.errors?.[0];
    const detail = error?.error_data?.details || error?.message || error?.title || 'sin detalle';
    const message = `Entrega fallida a ${status.recipient_id || 'desconocido'}: ${detail}${error?.code ? ` (código ${error.code})` : ''}`;
    recordError(phoneNumberId, 'delivery', message);
    logger.warn(`WhatsApp: ${message}`);
}

function hasProcessedMessage(messageId?: string): boolean {
    if (!messageId) return false;

    const now = Date.now();
    for (const [id, timestamp] of processedMessageIds) {
        if (now - timestamp > 15 * 60 * 1000) processedMessageIds.delete(id);
    }

    if (processedMessageIds.has(messageId)) return true;
    processedMessageIds.set(messageId, now);
    return false;
}

function sessionIdFor(conversation: Conversation): string {
    return `${conversation.store.id}_${conversation.senderPhone}`;
}

function buildConversation(store: StoreRecord, phoneNumberId: string, senderPhone: string): Conversation {
    return {
        key: `${store.id}:${phoneNumberId}:${senderPhone}`,
        store,
        phoneNumberId,
        senderPhone,
    };
}

async function runBotResponse(conversation: Conversation, userText: string): Promise<void> {
    const { store, senderPhone } = conversation;
    const sessionId = sessionIdFor(conversation);

    const aiResponse = await handleUserMessage(
        sessionId,
        store.id,
        senderPhone,
        userText,
        store.systemPrompt?.trim() ? store.systemPrompt : SYSTEM_PROMPT,
        store.openaiApiKey?.trim() || config.OPENAI_API_KEY || null,
        undefined,
    );

    for (const image of aiResponse.images) {
        try {
            await sendImageMessage(store, senderPhone, image);
        } catch (imageError: any) {
            logger.error(`Error enviando imagen Cloud API [${store.id}]: ${imageError.message}`);
        }
    }

    await sendMultipleMessages(store, senderPhone, aiResponse.messages);
    await incrementMessageCount(sessionId);
    await recordUserActivity(sessionId);
}

/**
 * Cola por conversación: los mensajes de un mismo cliente se procesan en orden,
 * mientras que clientes distintos avanzan en paralelo (limitados en el agente).
 */
function enqueueConversation(conversation: Conversation, userText: string, lastMessageId?: string): void {
    const sessionId = sessionIdFor(conversation);
    const currentQueue = conversationQueues.get(conversation.key) || Promise.resolve();
    const nextQueue = currentQueue
        .then(async () => {
            const session = await getSession(sessionId);
            if (session?.isPaused) {
                // Un asesor tomó el chat mientras se agrupaban los mensajes: se guardan para que los vea.
                const history = await getMemory(sessionId);
                history.push({ role: 'user', content: userText });
                await saveMemory(sessionId, conversation.store.id, conversation.senderPhone, history);
                return;
            }
            await showTypingIndicator(conversation.store, lastMessageId);
            await runBotResponse(conversation, userText);
        })
        .catch(error => logger.error(`Error en cola Cloud API [${conversation.key}]: ${error.message}`))
        .finally(() => {
            if (conversationQueues.get(conversation.key) === nextQueue) conversationQueues.delete(conversation.key);
        });

    conversationQueues.set(conversation.key, nextQueue);
}

function flushBatch(key: string): void {
    const batch = pendingBatches.get(key);
    if (!batch) return;
    pendingBatches.delete(key);
    clearTimeout(batch.timer);

    if (batch.texts.length > 1) {
        logger.info(`Conversación ${key}: ${batch.texts.length} mensajes agrupados en una sola solicitud.`);
    }
    enqueueConversation(batch.conversation, batch.texts.join('\n'), batch.lastMessageId);
}

/**
 * Agrupa mensajes consecutivos: espera WHATSAPP_BATCH_QUIET_MS de silencio tras el último
 * mensaje, pero nunca más de WHATSAPP_BATCH_MAX_WAIT_MS desde el primero.
 */
function addToBatch(conversation: Conversation, text: string, messageId?: string): void {
    const now = Date.now();
    const existing = pendingBatches.get(conversation.key);
    const firstAt = existing?.firstAt ?? now;
    const remainingMaxWait = config.WHATSAPP_BATCH_MAX_WAIT_MS - (now - firstAt);
    const delay = Math.max(0, Math.min(config.WHATSAPP_BATCH_QUIET_MS, remainingMaxWait));

    if (existing) clearTimeout(existing.timer);

    pendingBatches.set(conversation.key, {
        conversation,
        texts: [...(existing?.texts || []), text],
        lastMessageId: messageId || existing?.lastMessageId,
        firstAt,
        timer: setTimeout(() => flushBatch(conversation.key), delay),
    });
}

async function processInboundMessage(envelope: InboundEnvelope): Promise<void> {
    const { message, phoneNumberId } = envelope;
    if (hasProcessedMessage(message.id)) return;

    const senderPhone = normalizePhone(message.from || '');
    const userText = extractMessageText(message);
    if (!senderPhone || !userText) {
        if (message.type && message.type !== 'text' && message.type !== 'interactive') {
            logger.info(`Mensaje Cloud API no textual ignorado: ${message.type}`);
        }
        return;
    }

    const store = await resolveStore(phoneNumberId);
    if (!store) {
        logger.warn(`No se encontró tienda para el Phone Number ID ${phoneNumberId}`);
        return;
    }

    const conversation = buildConversation(store, phoneNumberId, senderPhone);
    const sessionId = sessionIdFor(conversation);

    if (userText.toLowerCase() === '!bot') {
        await resumeChat(sessionId);
        await sendTextMessage(store, senderPhone, 'Bot reactivado correctamente. ¿En qué te puedo ayudar?');
        return;
    }

    const currentSession = await getSession(sessionId);
    if (currentSession?.isPaused) {
        const history = await getMemory(sessionId);
        history.push({ role: 'user', content: userText });
        await saveMemory(sessionId, store.id, senderPhone, history);
        return;
    }

    const limit = await checkRateLimit(sessionId, 50);
    if (!limit.allowed) {
        await sendTextMessage(store, senderPhone, 'Has alcanzado el límite de mensajes por hoy. Podrás seguir chateando mañana. ¡Gracias!');
        return;
    }

    addToBatch(conversation, userText, message.id);
}

function isValidMetaSignature(req: RawBodyRequest): boolean {
    const signature = req.get('x-hub-signature-256') || '';
    const rawBody = req.rawBody;
    const receivedHash = signature.startsWith('sha256=') ? signature.slice(7) : '';

    if (!config.META_APP_SECRET || !rawBody || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
        return false;
    }

    const expectedHash = crypto
        .createHmac('sha256', config.META_APP_SECRET)
        .update(rawBody)
        .digest('hex');

    return crypto.timingSafeEqual(
        Buffer.from(expectedHash, 'hex'),
        Buffer.from(receivedHash, 'hex'),
    );
}

whatsappRouter.get('/', (req: Request, res: Response) => {
    const mode = typeof req.query['hub.mode'] === 'string' ? req.query['hub.mode'] : '';
    const verifyToken = typeof req.query['hub.verify_token'] === 'string' ? req.query['hub.verify_token'] : '';
    const challenge = typeof req.query['hub.challenge'] === 'string' ? req.query['hub.challenge'] : '';

    if (mode === 'subscribe' && verifyToken === config.META_VERIFY_TOKEN && challenge) {
        return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
});

whatsappRouter.post('/', (req: Request, res: Response) => {
    const rawRequest = req as RawBodyRequest;
    if (!isValidMetaSignature(rawRequest)) {
        logger.warn('Webhook de Meta rechazado: firma inválida o App Secret no configurado.');
        return res.sendStatus(401);
    }

    res.sendStatus(200);

    const envelopes = extractInboundMessages(req.body);
    for (const envelope of envelopes) {
        void processInboundMessage(envelope).catch(error => {
            logger.error(`Error procesando webhook de WhatsApp: ${error.message}`);
        });
    }
});

export async function processUnansweredMessage(sessionId: string, storeId: string, phone: string): Promise<void> {
    const memory = await getMemory(sessionId);
    if (memory.length === 0) return;

    // Junta todos los mensajes del cliente que quedaron sin respuesta mientras el chat estaba pausado.
    const pendingTexts: string[] = [];
    while (memory.length > 0 && memory[memory.length - 1]?.role === 'user') {
        pendingTexts.unshift(String(memory.pop().content || ''));
    }
    if (pendingTexts.length === 0) return;

    await saveMemory(sessionId, storeId, phone, memory);

    const store = await getStoreById(storeId);
    if (!store) return;

    const conversation = buildConversation(store, getCredentials(store).phoneNumberId, normalizePhone(phone));
    enqueueConversation(conversation, pendingTexts.filter(Boolean).join('\n') || 'Hola');
}

export async function pauseChat(sessionId: string): Promise<void> {
    await setSessionPause(sessionId, true);
}

export async function resumeChat(sessionId: string): Promise<void> {
    await setSessionPause(sessionId, false);
}

/** Estado de salud de WhatsApp Cloud API para una tienda (lo consume el panel). */
export async function getStoreWhatsAppHealth(storeId: string) {
    const store = await getStoreById(storeId);
    return getWhatsAppHealth(getCredentials(store));
}

export function initializeWhatsAppCloud(): void {
    if (inactivityJobStarted) return;
    inactivityJobStarted = true;

    if (!config.META_PHONE_ID || !config.META_ACCESS_TOKEN) {
        logger.warn('WhatsApp Cloud API pendiente: completa META_ACCESS_TOKEN y META_PHONE_ID en .env.');
    }

    setInterval(async () => {
        if (inactivityJobRunning) return;
        inactivityJobRunning = true;

        try {
            const sessions = await getAllSessions();
            const now = Date.now();

            for (const session of sessions) {
                if (!session.isPaused || !session.history?.length) continue;
                const lastMessage = session.history[session.history.length - 1];
                if (lastMessage?.role !== 'user') continue;

                const updatedAt = session.updatedAt ? new Date(session.updatedAt).getTime() : 0;
                if (updatedAt && now - updatedAt >= 5 * 60 * 1000) {
                    await resumeChat(session.sessionId);
                    await processUnansweredMessage(session.sessionId, session.storeId, session.phone);
                }
            }
        } catch (error: any) {
            logger.error(`Error en job de sesiones Cloud API: ${error.message}`);
        } finally {
            inactivityJobRunning = false;
        }
    }, 60 * 1000);
}
