import axios from 'axios';
import { handleUserMessage } from '../bot/agent';
import { resolveSystemPrompt } from '../bot/prompts';
import { logger } from '../utils/logger';
import { stores } from '../data/schema';
import { eq } from 'drizzle-orm';
import { db } from '../data/connection';
import { checkRateLimit } from '../data/database';

type TelegramMessage = { chat: { id: number }; text?: string; from?: { is_bot?: boolean } };

/**
 * Cliente mínimo de la Bot API de Telegram (long polling con getUpdates). Reemplaza a
 * node-telegram-bot-api, que arrastraba `request` y otras dependencias con vulnerabilidades.
 * El token va en la URL: los errores se registran sin la URL para no filtrarlo.
 */
class TelegramPoller {
    private running = false;
    private offset = 0;
    private handler: (msg: TelegramMessage) => void = () => {};
    private errorHandler: (error: unknown) => void = () => {};

    constructor(private readonly token: string) {}

    private url(method: string) {
        return `https://api.telegram.org/bot${this.token}/${method}`;
    }

    on(event: 'message' | 'polling_error', fn: (arg: any) => void) {
        if (event === 'message') this.handler = fn;
        else this.errorHandler = fn;
    }

    start() {
        if (this.running) return;
        this.running = true;
        void this.loop();
    }

    stopPolling() {
        this.running = false;
    }

    async sendMessage(chatId: string, text: string) {
        await axios.post(this.url('sendMessage'), { chat_id: chatId, text }, { timeout: 15_000 });
    }

    private async loop() {
        while (this.running) {
            try {
                const { data } = await axios.get(this.url('getUpdates'), {
                    params: { offset: this.offset, timeout: 30, allowed_updates: JSON.stringify(['message']) },
                    timeout: 40_000,
                });
                for (const update of data?.result || []) {
                    this.offset = Math.max(this.offset, Number(update.update_id) + 1);
                    if (update.message) this.handler(update.message);
                }
            } catch (error: any) {
                this.errorHandler(`${error?.code || ''} ${error?.response?.status || ''}`.trim() || 'sin detalle');
                await new Promise(resolve => setTimeout(resolve, 5_000));
            }
        }
    }
}

const telegramBots = new Map<string, TelegramPoller>();

/**
 * Inicializa todos los bots de Telegram que tengan token configurado
 */
export async function initializeTelegramClients() {
    try {
        const allStores = await db.query.stores.findMany({
            where: eq(stores.telegramBotActive, true)
        });

        if (allStores.length === 0) return;

        logger.info(`🚀 Iniciando ${allStores.length} instancias de Telegram...`);
        for (const s of allStores) {
            if (s.telegramToken) {
                await initTelegramBot(s.id, s.telegramToken);
            }
        }
    } catch (error) {
        logger.error('❌ Error inicializando Telegram:', error);
    }
}

export async function initTelegramBot(storeId: string, token: string) {
    if (telegramBots.has(storeId)) {
        telegramBots.get(storeId)?.stopPolling();
    }

    const bot = new TelegramPoller(token);
    telegramBots.set(storeId, bot);

    logger.info(`✈️ [${storeId}] Bot de Telegram iniciado.`);

    bot.on('message', async (msg: TelegramMessage) => {
        try {
            if (!msg.text || msg.from?.is_bot) return;

            const chatId = msg.chat.id.toString();
            const sessionId = `${storeId}_tg_${chatId}`;
            const userText = msg.text;

            // Ley 1581: el texto del cliente no va a los logs.
            logger.info(`✈️ [${storeId}] Mensaje de Telegram (${userText.length} caracteres).`);

            const limit = await checkRateLimit(sessionId, 50);
            if (!limit.allowed) return;

            const store = await db.query.stores.findFirst({ where: eq(stores.id, storeId) });
            if (!store) return;

            const response = await handleUserMessage(
                sessionId,
                storeId,
                `tg_${chatId}`,
                userText,
                resolveSystemPrompt(store.systemPrompt),
            );

            // Antes solo se enviaba el primer mensaje y se perdía el resto de la respuesta.
            for (const text of response?.messages || []) {
                await bot.sendMessage(chatId, text);
            }
        } catch (error) {
            logger.error(`❌ [${storeId}] Error en Telegram:`, error);
        }
    });

    bot.on('polling_error', (error: unknown) => {
        logger.error(`⚠️ [${storeId}] Error de polling en Telegram: ${error}`);
    });
    bot.start();
}

export function stopTelegramBot(storeId: string) {
    const bot = telegramBots.get(storeId);
    if (bot) {
        bot.stopPolling();
        telegramBots.delete(storeId);
        logger.info(`✈️ [${storeId}] Bot de Telegram detenido.`);
    }
}
