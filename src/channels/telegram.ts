import TelegramBot from 'node-telegram-bot-api';
import { handleUserMessage } from '../bot/agent';
import { logger } from '../utils/logger';
import { stores } from '../data/schema';
import { eq } from 'drizzle-orm';
import { db } from '../data/connection';

const telegramBots = new Map<string, TelegramBot>();

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

    const bot = new TelegramBot(token, { polling: true });
    telegramBots.set(storeId, bot);

    logger.info(`✈️ [${storeId}] Bot de Telegram iniciado.`);

    bot.on('message', async (msg) => {
        try {
            if (!msg.text || msg.from?.is_bot) return;

            const chatId = msg.chat.id.toString();
            const sessionId = `${storeId}_tg_${chatId}`;
            const userText = msg.text;

            logger.info(`✈️ [${storeId}] Mensaje de Telegram (${chatId}): ${userText}`);

            const store = await db.query.stores.findFirst({ where: eq(stores.id, storeId) });
            if (!store) return;

            const response = await handleUserMessage(
                sessionId,
                storeId,
                chatId,
                userText,
                store.systemPrompt,
                store.openaiApiKey || null
            );

            if (response) {
                await bot.sendMessage(chatId, response.text);
            }
        } catch (error) {
            logger.error(`❌ [${storeId}] Error en Telegram:`, error);
        }
    });

    bot.on('polling_error', (error) => {
        logger.error(`⚠️ [${storeId}] Error de polling en Telegram:`, error);
    });
}

export function stopTelegramBot(storeId: string) {
    const bot = telegramBots.get(storeId);
    if (bot) {
        bot.stopPolling();
        telegramBots.delete(storeId);
        logger.info(`✈️ [${storeId}] Bot de Telegram detenido.`);
    }
}
