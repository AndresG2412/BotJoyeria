import { Router, Request, Response } from 'express';
import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { logger } from '../utils/logger';
import { config } from '../config/env';
import { handleUserMessage } from '../bot/agent';
import { recordUserActivity } from '../bot/remarketing';
import { db } from '../data/connection';
import { stores } from '../data/schema';
import { eq } from 'drizzle-orm';
import { getSession, setSessionPause, checkRateLimit, incrementMessageCount, getMemory, saveMemory } from '../data/database';
import { SYSTEM_PROMPT } from '../bot/prompts';

export const whatsappRouter = Router();

// Gestión Multi-Instancia
const clients      = new Map<string, Client>();
const qrCodes      = new Map<string, string>();
const clientStatus = new Map<string, 'DISCONNECTED' | 'CONNECTING' | 'QR_READY' | 'CONNECTED'>();
const messageQueues = new Map<string, Promise<void>>();

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: enviar múltiples mensajes con delay natural entre ellos
// ─────────────────────────────────────────────────────────────────────────────
async function sendMultipleMessages(
    client: Client,
    chatId: string,
    messages: string[],
    delayMs = 1200
): Promise<void> {
    for (let i = 0; i < messages.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, delayMs));
        await client.sendMessage(chatId, messages[i]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Procesar mensaje pendiente (usado por el job de inactividad del admin)
// ─────────────────────────────────────────────────────────────────────────────
export async function processUnansweredMessage(sessionId: string, storeId: string, phone: string) {
    try {
        const memNow = await getMemory(sessionId);
        if (memNow.length === 0) return;

        const lastMsg = memNow[memNow.length - 1];
        if (lastMsg.role !== 'user') return;

        logger.info(`Procesando mensaje pendiente para ${sessionId}`);

        memNow.pop();
        await saveMemory(sessionId, storeId, phone, memNow);

        const textToProcess = lastMsg.content as string || 'Hola';

        const client = clients.get(storeId);
        if (!client) {
            logger.error(`Bot no inicializado para la tienda ${storeId}`);
            return;
        }

        const messageFrom = phone.includes('@') ? phone : `${phone}@c.us`;

        const currentQueue = messageQueues.get(sessionId) || Promise.resolve();
        const nextQueue = currentQueue.then(async () => {
            const store = await db.query.stores.findFirst({ where: eq(stores.id, storeId) });

            const typingDelay = Math.floor(Math.random() * 3000) + 2000;
            await new Promise(resolve => setTimeout(resolve, typingDelay));

            const defaultPrompt = SYSTEM_PROMPT;

            const aiResponse = await handleUserMessage(
                sessionId,
                storeId,
                phone,
                textToProcess,
                store?.systemPrompt?.trim() ? store.systemPrompt : defaultPrompt,
                (store?.openaiApiKey?.trim() || config.OPENAI_API_KEY) || '',
                undefined
            );

            // Enviar imágenes primero si las hay
            for (const img of aiResponse.images) {
                try {
                    const media = new MessageMedia(img.mimetype, img.base64);
                    await client.sendMessage(messageFrom, media, { caption: img.caption || undefined });
                } catch (imgErr: any) {
                    logger.error(`Error enviando imagen por WA [${storeId}]: ${imgErr.message}`);
                }
            }

            // Enviar mensajes de texto con delay entre ellos
            await sendMultipleMessages(client, messageFrom, aiResponse.messages);

            await incrementMessageCount(sessionId);
            await recordUserActivity(sessionId);

        }).catch(err => logger.error(`Error en cola processUnansweredMessage [${storeId}]: ${err.message}`));

        messageQueues.set(sessionId, nextQueue);
    } catch (e: any) {
        logger.error(`Error en processUnansweredMessage: ${e.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Inicializar todos los bots activos
// ─────────────────────────────────────────────────────────────────────────────
export async function initializeWhatsAppClient() {
    try {
        const allStores = await db.query.stores.findMany({ where: eq(stores.isActive, true) });
        logger.info(`🚀 Iniciando ${allStores.length} instancias de WhatsApp...`);

        for (const store of allStores) {
            try {
                await startBotInstance(store.id);
            } catch (err: any) {
                logger.error(`❌ No se pudo iniciar el bot [${store.id}]: ${err.message}`);
            }
        }

        // Job de revisión global de inactividad (cada 1 minuto)
        setInterval(async () => {
            try {
                const { getAllSessions } = await import('../data/database');
                const sessions = await getAllSessions();
                const now = new Date().getTime();

                for (const session of sessions) {
                    if (session.isPaused && session.history && session.history.length > 0) {
                        const lastMsg = session.history[session.history.length - 1];
                        if (lastMsg.role === 'user') {
                            const updatedAtTime = (session.updatedAt && typeof (session.updatedAt as any).getTime === 'function')
                                ? (session.updatedAt as any).getTime()
                                : new Date(session.updatedAt).getTime();
                            const timeDiff = now - updatedAtTime;
                            if (timeDiff >= 5 * 60 * 1000) {
                                logger.info(`Reactivando sesión ${session.sessionId} por inactividad del admin (5 min)`);
                                await resumeChat(session.sessionId);
                                await processUnansweredMessage(session.sessionId, session.storeId, session.phone);
                            }
                        }
                    }
                }
            } catch (err: any) {
                logger.error(`Error en job de revisión de sesiones: ${err.message}`);
            }
        }, 60 * 1000);

    } catch (error: any) {
        logger.error(`Error inicializando clientes: ${error.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Arrancar una instancia específica
// ─────────────────────────────────────────────────────────────────────────────
export async function startBotInstance(storeId: string) {
    if (clients.has(storeId)) {
        logger.warn(`El bot para la tienda ${storeId} ya está en ejecución o iniciado.`);
        return;
    }

    logger.info(`🛠️ Arrancando instancia para tienda: ${storeId}`);
    clientStatus.set(storeId, 'CONNECTING');

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: storeId }),
        puppeteer: {
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
            ],
        },
    });

    client.on('qr', (qr) => {
        qrCodes.set(storeId, qr);
        clientStatus.set(storeId, 'QR_READY');
        logger.info(`📲 [${storeId}] Nuevo QR generado. Entra al Dashboard para escanearlo.`);
    });

    client.on('ready', () => {
        qrCodes.delete(storeId);
        clientStatus.set(storeId, 'CONNECTED');
        logger.info(`✅ [${storeId}] Cliente está LISTO.`);
    });

    client.on('authenticated', () => {
        logger.info(`🔐 [${storeId}] Autenticado correctamente.`);
    });

    client.on('auth_failure', (msg) => {
        clientStatus.set(storeId, 'DISCONNECTED');
        logger.error(`❌ [${storeId}] Fallo de autenticación: ${msg}`);
    });

    client.on('disconnected', (reason) => {
        clientStatus.set(storeId, 'DISCONNECTED');
        clients.delete(storeId);
        logger.warn(`🔌 [${storeId}] Cliente desconectado: ${reason}`);
    });

    client.on('message', async (message) => {
        try {
            if (message.isStatus || message.from.endsWith('@g.us') || message.from.includes('@broadcast')) return;

            // Resolver número real del contacto (los LIDs @lid no son teléfonos reales)
            let senderPhone = message.from.replace(/@.*$/, '');
            const isLid = message.from.includes('@lid');

            if (isLid) {
                try {
                    const contact = await message.getContact();
                    const idUser = (contact as any)?.id?.user;
                    if (idUser && /^\d{7,15}$/.test(idUser)) {
                        senderPhone = idUser;
                    } else {
                        try {
                            const formatted = await (contact as any).getFormattedNumber();
                            if (formatted) senderPhone = formatted.replace(/[^0-9]/g, '');
                        } catch (e) {}
                    }
                } catch (e: any) {
                    logger.error(`📱 Error resolviendo LID ${message.from}: ${e.message}`);
                }
                logger.info(`📱 [${storeId}] LID: ${message.from} → Resuelto: ${senderPhone}`);
            }

            const userText  = message.body;
            const sessionId = `${storeId}_${senderPhone}`;
            const chatId    = message.from;

            // Handover humano
            if (userText.trim().toLowerCase() === '!bot') {
                await resumeChat(sessionId);
                await client.sendMessage(chatId, 'Bot reactivado correctamente. ¿En qué te puedo ayudar?');
                return;
            }

            const currentSession = await getSession(sessionId);

            if (currentSession?.isPaused) {
                try {
                    const history = await getMemory(sessionId);
                    history.push({ role: 'user', content: userText });
                    await saveMemory(sessionId, storeId, senderPhone, history);
                } catch (e: any) {
                    logger.error(`Error guardando mensaje en modo pausa: ${e.message}`);
                }
                return;
            }

            // Rate limit
            const limit = await checkRateLimit(sessionId, 50);
            if (!limit.allowed) {
                await client.sendMessage(chatId, 'Has alcanzado el límite de mensajes por hoy. Podrás seguir chateando mañana. ¡Gracias!');
                return;
            }

            // Encolar mensaje
            const currentQueue = messageQueues.get(sessionId) || Promise.resolve();
            const nextQueue = currentQueue.then(async () => {
                const sessionCheck = await getSession(sessionId);
                if (sessionCheck?.isPaused) return;

                // Delay de humanización
                const typingDelay = Math.floor(Math.random() * 3000) + 2000;
                await new Promise(resolve => setTimeout(resolve, typingDelay));

                const store = await db.query.stores.findFirst({ where: eq(stores.id, storeId) });
                const defaultPrompt = SYSTEM_PROMPT;

                const aiResponse = await handleUserMessage(
                    sessionId,
                    storeId,
                    senderPhone,
                    userText,
                    store?.systemPrompt?.trim() ? store.systemPrompt : defaultPrompt,
                    (store?.openaiApiKey?.trim() || config.OPENAI_API_KEY) || '',
                    undefined
                );

                // Enviar imágenes primero si las hay
                for (const img of aiResponse.images) {
                    try {
                        const media = new MessageMedia(img.mimetype, img.base64);
                        await client.sendMessage(chatId, media, { caption: img.caption || undefined });
                    } catch (imgErr: any) {
                        logger.error(`Error enviando imagen por WA [${storeId}]: ${imgErr.message}`);
                    }
                }

                // Enviar mensajes de texto con delay entre ellos
                await sendMultipleMessages(client, chatId, aiResponse.messages);

                await incrementMessageCount(sessionId);
                await recordUserActivity(sessionId);

            }).catch(err => logger.error(`Error en cola [${storeId}]:`, err));

            messageQueues.set(sessionId, nextQueue);

        } catch (error: any) {
            logger.error(`Error procesando mensaje en [${storeId}]:`, error);
        }
    });

    clients.set(storeId, client);

    try {
        await client.initialize();
    } catch (err: any) {
        if (err.message.includes('Execution context was destroyed') || err.message.includes('Session closed')) {
            logger.warn(`⚠️ [${storeId}] El bot se detuvo durante el inicio.`);
        } else {
            logger.error(`❌ Error inicializando bot [${storeId}]: ${err.message}`);
        }
        clients.delete(storeId);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Utilidades del Dashboard
// ─────────────────────────────────────────────────────────────────────────────
export function getBotStatus(storeId: string) {
    return {
        status: clientStatus.get(storeId) || 'DISCONNECTED',
        qr:     qrCodes.get(storeId)      || null,
    };
}

export async function stopBotInstance(storeId: string) {
    const client = clients.get(storeId);
    if (client) {
        try {
            await client.destroy();
            logger.info(`🛑 Bot [${storeId}] detenido y destruido.`);
        } catch (err: any) {
            logger.error(`Error destruyendo bot [${storeId}]: ${err.message}`);
        }
    }
    clients.delete(storeId);
    qrCodes.delete(storeId);
    clientStatus.delete(storeId);
}

export async function pauseChat(sessionId: string) {
    await setSessionPause(sessionId, true);
}

export async function resumeChat(sessionId: string) {
    await setSessionPause(sessionId, false);
}

export async function sendWhatsAppMessage(storeId: string, to: string, text: string) {
    try {
        const client = clients.get(storeId);
        if (!client) throw new Error(`Cliente no iniciado para la tienda ${storeId}`);

        const chatId = to.includes('@') ? to : `${to}@c.us`;
        try {
            await client.sendMessage(chatId, text);
            logger.info(`✅ Mensaje enviado desde [${storeId}] a ${to}`);
        } catch (sendError: any) {
            if (sendError.message?.includes('LID') && !to.includes('@')) {
                const resolvedId = await (client as any).getNumberId(to);
                if (resolvedId) {
                    await client.sendMessage(resolvedId._serialized, text);
                    logger.info(`✅ Mensaje enviado desde [${storeId}] a ${to} (vía LID resuelto)`);
                } else {
                    throw sendError;
                }
            } else {
                throw sendError;
            }
        }
    } catch (error: any) {
        logger.error(`❌ Error enviando desde [${storeId}]: ${error.message}`);
    }
}