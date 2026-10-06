import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import sharp from 'sharp';
import { logger, maskPhone } from '../utils/logger';
import { config } from '../config/env';
import { handleUserMessage } from '../bot/agent';
import { db } from '../data/connection';
import { getSession, setSessionPause, checkRateLimit, incrementMessageCount, getMemory, saveMemory, getStalePausedSessions, isHumanAttending, markHumanReply } from '../data/database';
import { SYSTEM_PROMPT } from '../bot/prompts';
import { PendingImage } from '../bot/tools';
import { isUnsupportedInboundType, UNSUPPORTED_FILE_RESPONSE } from '../bot/policies';
import { getProductById } from '../data/catalog';
import { buildWebProductLeadResponse } from '../bot/web-product-lead';
import { parseWebProductLead, webLeadReference, WebProductLead } from '../utils/web-product';
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
    // Meta comenzó a enviar BSUID cuando el número del usuario no está disponible.
    // Ejemplo: CO.1250759470573907
    from_user_id?: string;
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

/** Mensaje que alguien de la joyería envió desde la app WhatsApp Business (coexistencia). */
export type MessageEcho = {
    id?: string;
    from?: string;
    to?: string;
    to_user_id?: string;
    type?: string;
    text?: { body?: string };
    image?: { caption?: string };
    video?: { caption?: string };
    document?: { caption?: string; filename?: string };
};

export type EchoEnvelope = {
    phoneNumberId: string;
    echo: MessageEcho;
};

export type ParsedWebhook = {
    messages: InboundEnvelope[];
    echoes: EchoEnvelope[];
    statuses: Array<{ phoneNumberId: string; status: MessageStatus }>;
    webhooks: Array<{ phoneNumberId: string; displayPhoneNumber?: string }>;
    disconnections: Array<{ phoneNumber?: string; event?: string; reason?: string; initiatedBy?: string }>;
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

/** Identificador Business-Scoped User ID (BSUID) enviado por Meta. */
function isBsuid(value: string): boolean {
    return /^[A-Z]{2}\.[A-Za-z0-9]+$/.test(value);
}

/**
 * Meta puede identificar al destinatario por teléfono o por BSUID.
 * Los BSUID deben enviarse en `recipient`; los números en `to`.
 */
function recipientFields(identifier: string): Record<string, string> {
    return isBsuid(identifier)
        ? { recipient: identifier }
        : { to: normalizePhone(identifier) };
}

function normalizeRecipientIdentifier(identifier: string): string {
    return isBsuid(identifier) ? identifier.trim() : normalizePhone(identifier);
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
        ...recipientFields(to),
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
        ...recipientFields(to),
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

/**
 * Separa el payload del webhook de Meta en lo que interesa al bot (sin efectos, para poder probarlo):
 * mensajes de clientes, respuestas enviadas desde el celular de la joyería (smb_message_echoes),
 * estados de entrega y desconexiones de la coexistencia (account_update).
 */
export function parseWebhookPayload(payload: any): ParsedWebhook {
    const parsed: ParsedWebhook = { messages: [], echoes: [], statuses: [], webhooks: [], disconnections: [] };
    if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return parsed;

    for (const entry of payload.entry) {
        for (const change of entry?.changes || []) {
            const value = change?.value;
            if (change?.field === 'account_update') {
                if (value?.disconnection_info || value?.event === 'PARTNER_REMOVED') {
                    parsed.disconnections.push({
                        phoneNumber: value?.phone_number,
                        event: value?.event,
                        reason: value?.disconnection_info?.reason,
                        initiatedBy: value?.disconnection_info?.initiated_by,
                    });
                }
                continue;
            }
            if (change?.field !== 'messages' && change?.field !== 'smb_message_echoes') continue;

            const phoneNumberId = value?.metadata?.phone_number_id;
            if (!phoneNumberId) continue;
            parsed.webhooks.push({ phoneNumberId, displayPhoneNumber: value?.metadata?.display_phone_number });

            for (const status of (value?.statuses || []) as MessageStatus[]) parsed.statuses.push({ phoneNumberId, status });
            for (const message of value?.messages || []) parsed.messages.push({ phoneNumberId, message });
            for (const echo of value?.message_echoes || []) parsed.echoes.push({ phoneNumberId, echo });
        }
    }
    return parsed;
}

/** Texto que queda en el historial por un mensaje enviado desde el celular. */
export function echoText(echo: MessageEcho): string {
    if (echo.type === 'text') return echo.text?.body?.trim() || '';
    const caption = echo.image?.caption || echo.video?.caption || echo.document?.caption || '';
    const kind: Record<string, string> = {
        image: 'una imagen', video: 'un video', audio: 'un audio', document: 'un documento',
        sticker: 'un sticker', location: 'una ubicación', contacts: 'un contacto',
    };
    const label = `[La joyería envió ${kind[echo.type || ''] || 'un mensaje'} desde el celular]`;
    return caption ? `${label} ${caption.trim()}` : label;
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

    // Si alguien de la joyería contestó desde el celular mientras la IA pensaba, el bot calla.
    if (isHumanAttending(await getSession(sessionId))) {
        logger.info(`WhatsApp: respuesta del bot descartada en ${sessionId}: la joyería contestó desde el celular.`);
        return;
    }

    for (const image of aiResponse.images) {
        try {
            await sendImageMessage(store, senderPhone, image);
        } catch (imageError: any) {
            logger.error(`Error enviando imagen Cloud API [${store.id}]: ${imageError.message}`);
        }
    }

    await sendMultipleMessages(store, senderPhone, aiResponse.messages);
    await incrementMessageCount(sessionId);
}

/**
 * Respuesta especial para el botón de producto de la web.
 * No pasa por el modelo, herramientas ni búsqueda conversacional.
 */
async function runWebProductLeadResponse(
    conversation: Conversation,
    userText: string,
    lead: WebProductLead,
): Promise<void> {
    const { store, senderPhone } = conversation;
    const sessionId = sessionIdFor(conversation);
    const product = await getProductById(webLeadReference(lead), store.id);
    const response = buildWebProductLeadResponse(product, lead.tono);

    const history = await getMemory(sessionId);
    const initialSystemPrompt = store.systemPrompt?.trim() || SYSTEM_PROMPT;
    const sessionHistory = history.length > 0 && history[0]?.role === 'system'
        ? history
        : [{ role: 'system', content: initialSystemPrompt }, ...history];
    sessionHistory.push({ role: 'user', content: userText });
    sessionHistory.push({ role: 'assistant', content: response });
    await saveMemory(sessionId, store.id, senderPhone, sessionHistory);

    await sendTextMessage(store, senderPhone, response);
    await incrementMessageCount(sessionId);

    logger.info(`WhatsApp: lead de producto web ${product?.id || 'no encontrado'} atendido sin IA para ${maskPhone(senderPhone)}`);
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
            if (session?.isPaused || isHumanAttending(session)) {
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

/** Encola el lead web sin pasar por el agrupador de mensajes de la IA. */
function enqueueWebProductLead(
    conversation: Conversation,
    userText: string,
    lead: WebProductLead,
    lastMessageId?: string,
): void {
    const sessionId = sessionIdFor(conversation);
    const currentQueue = conversationQueues.get(conversation.key) || Promise.resolve();
    const nextQueue = currentQueue
        .then(async () => {
            const session = await getSession(sessionId);
            if (session?.isPaused || isHumanAttending(session)) {
                const history = await getMemory(sessionId);
                const sessionHistory = history.length > 0 && history[0]?.role === 'system'
                    ? history
                    : [{ role: 'system', content: conversation.store.systemPrompt?.trim() || SYSTEM_PROMPT }, ...history];
                sessionHistory.push({ role: 'user', content: userText });
                await saveMemory(sessionId, conversation.store.id, conversation.senderPhone, sessionHistory);
                return;
            }
            await showTypingIndicator(conversation.store, lastMessageId);
            await runWebProductLeadResponse(conversation, userText, lead);
        })
        .catch(error => logger.error(`Error procesando lead web [${conversation.key}]: ${error.message}`))
        .finally(() => {
            if (conversationQueues.get(conversation.key) === nextQueue) conversationQueues.delete(conversation.key);
        });

    conversationQueues.set(conversation.key, nextQueue);
}

/** Saca (sin procesar) los mensajes del cliente que esperaban al bot. */
function takePendingBatch(key: string): string[] {
    const batch = pendingBatches.get(key);
    if (!batch) return [];
    pendingBatches.delete(key);
    clearTimeout(batch.timer);
    return batch.texts;
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

    // Desde abril de 2026 Meta puede omitir `from` y enviar únicamente
    // `from_user_id` (BSUID). Debemos conservarlo completo: quitarle el punto
    // o las letras impediría responder usando `recipient`.
    const senderPhone = message.from
        ? normalizePhone(message.from)
        : (message.from_user_id || '').trim();
    const userText = extractMessageText(message);
    logger.info(`WhatsApp: mensaje entrante ${message.id || 'sin id'} de ${senderPhone || 'sin identificador'} (${message.type || 'sin tipo'})`);
    if (!senderPhone) {
        logger.warn(`WhatsApp: mensaje sin identificador de remitente (id ${message.id || 'desconocido'})`);
        return;
    }

    const store = await resolveStore(phoneNumberId);
    if (!store) {
        logger.warn(`No se encontró tienda para el Phone Number ID ${phoneNumberId}`);
        return;
    }

    const conversation = buildConversation(store, phoneNumberId, senderPhone);
    const sessionId = sessionIdFor(conversation);
    const currentSession = await getSession(sessionId);

    if (!userText) {
        // Si la joyería está atendiendo desde el celular, el bot no interviene ni con archivos.
        if (isUnsupportedInboundType(message.type) && !isHumanAttending(currentSession)) {
            logger.info(`Mensaje Cloud API no soportado rechazado: ${message.type}`);
            await sendTextMessage(store, senderPhone, UNSUPPORTED_FILE_RESPONSE);
        }
        return;
    }

    if (userText.toLowerCase() === '!bot') {
        await resumeChat(sessionId);
        await sendTextMessage(store, senderPhone, 'Bot reactivado correctamente. ¿En qué te puedo ayudar?');
        return;
    }

    if (currentSession?.isPaused || isHumanAttending(currentSession)) {
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

    const webProductLead = parseWebProductLead(userText);
    if (webProductLead) {
        // Se procesa antes de addToBatch: el cliente ya eligió una pieza y no
        // necesita pasar por búsqueda, filtros ni preguntas de descubrimiento.
        enqueueWebProductLead(conversation, userText, webProductLead, message.id);
        return;
    }

    addToBatch(conversation, userText, message.id);
}

/**
 * Coexistencia: alguien de la joyería contestó desde la app WhatsApp Business. Se guarda en el
 * historial (con lo que el cliente había escrito y esperaba al bot) y el bot se aparta del chat.
 */
async function processMessageEcho(envelope: EchoEnvelope): Promise<void> {
    const { echo, phoneNumberId } = envelope;
    if (hasProcessedMessage(echo.id)) return;

    const customer = echo.to ? normalizePhone(echo.to) : (echo.to_user_id || '').trim();
    if (!customer) return;
    const store = await resolveStore(phoneNumberId);
    if (!store) return;

    const conversation = buildConversation(store, phoneNumberId, customer);
    const sessionId = sessionIdFor(conversation);
    const pending = takePendingBatch(conversation.key);
    const saved = await markHumanReply(
        sessionId, store.id, customer, pending, echoText(echo), config.HUMAN_TAKEOVER_HOURS,
    );
    if (saved) {
        logger.info(`WhatsApp: la joyería contestó desde el celular en ${sessionId}; el bot se aparta ${config.HUMAN_TAKEOVER_HOURS} h.`);
    }
}

function handleDisconnection(info: ParsedWebhook['disconnections'][number]): void {
    const detail = `Coexistencia desconectada (${info.event || 'sin evento'}${info.reason ? `, motivo ${info.reason}` : ''}${info.initiatedBy ? `, por ${info.initiatedBy}` : ''}). El número ya no llega al bot: hay que volver a conectarlo.`;
    logger.error(`WhatsApp: ${detail}`);
    const credentials = getCredentials(null);
    recordError(credentials.phoneNumberId, 'account_update', detail);
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

    const parsed = parseWebhookPayload(req.body);
    for (const hook of parsed.webhooks) recordWebhook(hook.phoneNumberId, hook.displayPhoneNumber);
    for (const { phoneNumberId, status } of parsed.statuses) handleMessageStatus(phoneNumberId, status);
    for (const info of parsed.disconnections) handleDisconnection(info);
    // Primero las respuestas desde el celular: si en el mismo aviso llega un mensaje del
    // cliente, el bot ya sabe que la joyería está atendiendo.
    void (async () => {
        for (const envelope of parsed.echoes) {
            await processMessageEcho(envelope).catch(error => logger.error(`Error procesando eco de WhatsApp: ${error.message}`));
        }
        for (const envelope of parsed.messages) {
            void processInboundMessage(envelope).catch(error => {
                logger.error(`Error procesando webhook de WhatsApp: ${error.message}`);
            });
        }
    })();
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

    const conversation = buildConversation(store, getCredentials(store).phoneNumberId, normalizeRecipientIdentifier(phone));
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
            // Chats que un asesor pausó, con mensajes del cliente sin responder hace 5 minutos.
            for (const session of await getStalePausedSessions(5)) {
                await resumeChat(session.sessionId);
                await processUnansweredMessage(session.sessionId, session.storeId, session.phone);
            }
        } catch (error: any) {
            logger.error(`Error en job de sesiones Cloud API: ${error.message}`);
        } finally {
            inactivityJobRunning = false;
        }
    }, 60 * 1000);
}
