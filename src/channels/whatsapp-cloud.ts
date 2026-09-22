import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { logger } from '../utils/logger';
import { config } from '../config/env';
import { handleUserMessage } from '../bot/agent';
import { recordUserActivity } from '../bot/remarketing';
import { db } from '../data/connection';
import { getSession, setSessionPause, checkRateLimit, incrementMessageCount, getMemory, saveMemory, getAllSessions } from '../data/database';
import { SYSTEM_PROMPT } from '../bot/prompts';
import { PendingImage } from '../bot/tools';

type StoreRecord = {
    id: string;
    isActive?: boolean;
    systemPrompt?: string | null;
    openaiApiKey?: string | null;
    whatsappPhoneNumberId?: string | null;
    whatsappAccessToken?: string | null;
};

type CloudCredentials = {
    phoneNumberId: string;
    accessToken: string;
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

export const whatsappRouter = Router();

const messageQueues = new Map<string, Promise<void>>();
const processedMessageIds = new Map<string, number>();
let inactivityJobStarted = false;
let inactivityJobRunning = false;

function graphUrl(path: string): string {
    return `https://graph.facebook.com/${config.META_API_VERSION}${path}`;
}

function normalizePhone(phone: string): string {
    return phone.replace(/@c\.us$/, '').replace(/\D/g, '');
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

function getCredentials(store?: StoreRecord | null): CloudCredentials {
    return {
        phoneNumberId: (store?.whatsappPhoneNumberId || config.META_PHONE_ID).trim(),
        accessToken: (store?.whatsappAccessToken || config.META_ACCESS_TOKEN).trim(),
    };
}

function assertCredentials(credentials: CloudCredentials): void {
    if (!credentials.phoneNumberId || !credentials.accessToken) {
        throw new Error('Faltan META_PHONE_ID o META_ACCESS_TOKEN para WhatsApp Cloud API');
    }
}

async function sendTextMessage(store: StoreRecord | null, to: string, text: string): Promise<void> {
    const credentials = getCredentials(store);
    assertCredentials(credentials);

    await axios.post(
        graphUrl(`/${credentials.phoneNumberId}/messages`),
        {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: normalizePhone(to),
            type: 'text',
            text: {
                preview_url: false,
                body: text,
            },
        },
        {
            headers: {
                Authorization: `Bearer ${credentials.accessToken}`,
                'Content-Type': 'application/json',
            },
            timeout: 20000,
        },
    );
}

async function uploadMedia(credentials: CloudCredentials, image: PendingImage): Promise<string> {
    const form = new FormData();
    const bytes = Uint8Array.from(Buffer.from(image.base64, 'base64'));

    form.append('messaging_product', 'whatsapp');
    form.append('type', image.mimetype);
    form.append('file', new Blob([bytes], { type: image.mimetype }), 'product-image');

    const response = await axios.post<{ id: string }>(
        graphUrl(`/${credentials.phoneNumberId}/media`),
        form,
        {
            headers: {
                Authorization: `Bearer ${credentials.accessToken}`,
            },
            timeout: 30000,
        },
    );

    return response.data.id;
}

async function sendImageMessage(store: StoreRecord | null, to: string, image: PendingImage): Promise<void> {
    const credentials = getCredentials(store);
    assertCredentials(credentials);
    const mediaId = await uploadMedia(credentials, image);

    await axios.post(
        graphUrl(`/${credentials.phoneNumberId}/messages`),
        {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: normalizePhone(to),
            type: 'image',
            image: {
                id: mediaId,
                ...(image.caption ? { caption: image.caption } : {}),
            },
        },
        {
            headers: {
                Authorization: `Bearer ${credentials.accessToken}`,
                'Content-Type': 'application/json',
            },
            timeout: 20000,
        },
    );
}

async function sendMultipleMessages(store: StoreRecord | null, to: string, messages: string[]): Promise<void> {
    for (let index = 0; index < messages.length; index++) {
        if (index > 0) await new Promise(resolve => setTimeout(resolve, 1200));
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
            if (!phoneNumberId || !Array.isArray(value?.messages)) continue;

            for (const message of value.messages) {
                envelopes.push({ phoneNumberId, message });
            }
        }
    }

    return envelopes;
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

async function runBotResponse(store: StoreRecord, senderPhone: string, userText: string): Promise<void> {
    const sessionId = `${store.id}_${senderPhone}`;
    const typingDelay = Math.floor(Math.random() * 3000) + 2000;
    await new Promise(resolve => setTimeout(resolve, typingDelay));

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

function enqueueBotResponse(store: StoreRecord, senderPhone: string, userText: string): void {
    const sessionId = `${store.id}_${senderPhone}`;
    const currentQueue = messageQueues.get(sessionId) || Promise.resolve();
    const nextQueue = currentQueue
        .then(async () => {
            const session = await getSession(sessionId);
            if (session?.isPaused) return;
            await runBotResponse(store, senderPhone, userText);
        })
        .catch(error => logger.error(`Error en cola Cloud API [${store.id}]: ${error.message}`));

    messageQueues.set(sessionId, nextQueue);
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

    const sessionId = `${store.id}_${senderPhone}`;

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

    enqueueBotResponse(store, senderPhone, userText);
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

    const lastMessage = memory[memory.length - 1];
    if (lastMessage?.role !== 'user') return;

    memory.pop();
    await saveMemory(sessionId, storeId, phone, memory);

    const store = await getStoreById(storeId);
    if (!store) return;

    enqueueBotResponse(store, normalizePhone(phone), String(lastMessage.content || 'Hola'));
}

export async function pauseChat(sessionId: string): Promise<void> {
    await setSessionPause(sessionId, true);
}

export async function resumeChat(sessionId: string): Promise<void> {
    await setSessionPause(sessionId, false);
}

export function getBotStatus(_storeId: string) {
    return {
        status: config.META_PHONE_ID && config.META_ACCESS_TOKEN ? 'CONNECTED' : 'DISCONNECTED',
        qr: null,
        transport: 'whatsapp-cloud-api',
    };
}

export async function startBotInstance(storeId: string): Promise<void> {
    logger.info(`WhatsApp Cloud API activa para la tienda ${storeId}; no se inicia navegador local.`);
}

export async function stopBotInstance(storeId: string): Promise<void> {
    logger.info(`WhatsApp Cloud API detenida para la tienda ${storeId}; no hay proceso local que cerrar.`);
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
