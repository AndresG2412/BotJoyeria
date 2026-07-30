import { logger } from '../utils/logger';
import { db } from '../data/connection';
import { sessions, stores } from '../data/schema';
import { eq, and, lte, gte } from 'drizzle-orm';
import { getMemory, saveMemory } from '../data/database';
import { getAllProducts } from '../data/catalog';
import OpenAI from 'openai';
import { config } from '../config/env';
import { getRemarketingPrompt } from './prompts';

async function generateRemarketingMessage(
    storeId: string,
    systemPrompt: string,
    apiKey: string,
    history: OpenAI.Chat.ChatCompletionMessageParam[]
): Promise<string> {
    const products = await getAllProducts(storeId);
    const catalogLines = products.map(p => {
        const price = p.price != null ? `$${p.price}` : 'consultar precio';
        const url = p.checkoutUrl ? ` | Link: ${p.checkoutUrl}` : '';
        return `- ${p.name} — ${price}${url}`;
    }).join('\n');

    const remarketingInstruction = getRemarketingPrompt(systemPrompt, catalogLines);

    const openai = new OpenAI({
        apiKey,
        baseURL: config.OPENAI_BASE_URL || undefined
    });

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: remarketingInstruction },
        ...history.filter(m => m.role === 'user' || (m.role === 'assistant' && typeof m.content === 'string')).slice(-6)
    ];

    const response = await openai.chat.completions.create({
        model: 'gemini-3.1-flash-lite',
        messages
    });

    return response.choices[0].message.content || '';
}

/**
 * Registra o actualiza la última vez que el usuario nos mandó un mensaje
 */
export async function recordUserActivity(sessionId: string) {
    if (sessionId.includes('@g.us')) return; // No remarketing a grupos

    try {
        await db.update(sessions)
            .set({ 
                lastMessageAt: new Date(),
                remarketingSent: false 
            })
            .where(eq(sessions.sessionId, sessionId));
    } catch (error: any) {
        logger.error(`Error actualizando actividad para ${sessionId}: ${error.message}`);
    }
}

/**
 * Arranca el temporizador de fondo. Revisa constantemente a quién hay que escribirle de nuevo.
 */
export function startRemarketingCron(sendFunc: (storeId: string, to: string, msg: string) => Promise<void>) {
    logger.info("⏰ Motor de Remarketing INICIADO en PostgreSQL (Buscando carritos abandonados cada 10 minutos...)");

    setInterval(async () => {
        try {
            const now = new Date();
            
            // Calculamos las fechas límites
            // Entre 2 horas y 48 horas atrás
            const twoHoursAgo = new Date(now.getTime() - (2 * 60 * 60 * 1000));
            const fortyEightHoursAgo = new Date(now.getTime() - (48 * 60 * 60 * 1000));

            // Buscamos sesiones en la base de datos
            const pendingSessions = await db.query.sessions.findMany({
                where: and(
                    eq(sessions.remarketingSent, false),
                    lte(sessions.lastMessageAt, twoHoursAgo),
                    gte(sessions.lastMessageAt, fortyEightHoursAgo)
                )
            });

            for (const record of pendingSessions) {
                try {
                    const sessionId = record.sessionId;
                    const underscoreIdx = sessionId.indexOf('_');
                    if (underscoreIdx === -1) continue;
                    
                    const storeId = sessionId.substring(0, underscoreIdx);
                    const phone = sessionId.substring(underscoreIdx + 1);

                    const store = await db.query.stores.findFirst({ where: eq(stores.id, storeId) });
                    if (!store) continue;

                    const history = await getMemory(sessionId) || [];
                    const apiKey = store.openaiApiKey || config.OPENAI_API_KEY;

                    logger.info(`🔥 TRABAJO AUTOMÁTICO: Disparando mensaje de Remarketing a ${phone} (tienda: ${storeId})...`);

                    let msg: string;
                    try {
                        msg = await generateRemarketingMessage(storeId, store.systemPrompt, apiKey, history);
                    } catch (aiError: any) {
                        logger.error(`Error generando mensaje de remarketing con IA: ${aiError.message}`);
                        continue;
                    }

                    if (!msg) continue;

                    await sendFunc(storeId, phone, msg);

                    history.push({ role: 'assistant', content: msg });
                    await saveMemory(sessionId, storeId, phone, history);

                    // Marcamos como enviado en la DB
                    await db.update(sessions)
                        .set({ remarketingSent: true })
                        .where(eq(sessions.sessionId, sessionId));
                        
                } catch (error) {
                    logger.error(`Error enviando remarketing a ${record.sessionId}:`, error);
                }
            }
        } catch (dbError: any) {
            logger.error(`Error en cron de remarketing: ${dbError.message}`);
        }
    }, 10 * 60 * 1000);
}
