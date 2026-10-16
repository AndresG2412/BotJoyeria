import crypto from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { getSession, getSessionDetail, getSessionSummaries, getMemory, saveMemory, clearHumanTakeover } from '../data/database';
import { pauseChat, processUnansweredMessage, resumeChat, sendWhatsAppMessage } from '../channels/whatsapp-cloud';

// ─────────────────────────────────────────────────────────────────────────────
//  API servidor a servidor para el admin de la tienda (Mostrador → WhatsApp)
//
//  Solo la llama el SERVIDOR de la tienda, con `Authorization: Bearer <BOT_ADMIN_API_TOKEN>`.
//  Quién del equipo puede ver o responder lo decide la tienda con sus roles; aquí solo
//  se valida la llave. El bot sigue siendo el único que envía por WhatsApp y que pausa
//  o reactiva el bot en cada chat.
// ─────────────────────────────────────────────────────────────────────────────

/** Límite de WhatsApp para un mensaje de texto. */
export const MAX_REPLY_LENGTH = 4096;

export const adminApiRouter = Router();

function sameToken(received: string, expected: string): boolean {
    const a = crypto.createHash('sha256').update(received).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

export function requireAdminToken(req: Request, res: Response, next: NextFunction) {
    if (!config.BOT_ADMIN_API_TOKEN) {
        return res.status(503).json({ error: 'El acceso desde el admin de la tienda no está configurado.' });
    }
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || !sameToken(token, config.BOT_ADMIN_API_TOKEN)) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    next();
}

adminApiRouter.use(requireAdminToken);

/** Solo lo que una persona lee en un chat: sin instrucciones ni llamadas internas de la IA. */
export function toReadableMessages(history: any[]): Array<{ role: 'user' | 'assistant'; content: string }> {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const message of Array.isArray(history) ? history : []) {
        if (message?.role !== 'user' && message?.role !== 'assistant') continue;
        let content = '';
        if (typeof message.content === 'string') {
            content = message.content;
        } else if (Array.isArray(message.content)) {
            const text = message.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join(' ').trim();
            const hasImage = message.content.some((p: any) => p?.type === 'image_url' || p?.type === 'image');
            content = [hasImage ? '[Foto]' : '', text].filter(Boolean).join(' ');
        }
        content = content.trim();
        if (content) messages.push({ role: message.role, content });
    }
    return messages;
}

function readableError(error: any): string {
    const message = String(error?.message || '');
    // Fuera de la ventana de 24 h de WhatsApp solo se permiten plantillas aprobadas.
    if (/131047|re-engagement|24 hours/i.test(message)) {
        return 'Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp no permite escribirle hasta que él vuelva a escribir.';
    }
    return 'No se pudo enviar el mensaje por WhatsApp. Intenta de nuevo en un momento.';
}

/** GET /admin-api/sessions — lista de chats (solo resumen). */
adminApiRouter.get('/sessions', async (req: Request, res: Response) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    res.json(await getSessionSummaries(undefined, limit));
});

/** GET /admin-api/sessions/:sessionId — un chat completo, legible. */
adminApiRouter.get('/sessions/:sessionId', async (req: Request, res: Response) => {
    const detail = await getSessionDetail(String(req.params['sessionId']));
    if (!detail) return res.status(404).json({ error: 'Conversación no encontrada' });
    const { history, ...rest } = detail;
    res.json({ ...rest, messages: toReadableMessages(history) });
});

/** POST /admin-api/sessions/:sessionId/reply — un asesor responde; el bot se pausa en ese chat. */
adminApiRouter.post('/sessions/:sessionId/reply', async (req: Request, res: Response) => {
    const sessionId = String(req.params['sessionId']);
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'Escribe un mensaje.' });
    if (message.length > MAX_REPLY_LENGTH) {
        return res.status(400).json({ error: `El mensaje supera ${MAX_REPLY_LENGTH} caracteres.` });
    }

    const session: any = await getSession(sessionId);
    if (!session?.sessionId || !session.storeId || !session.senderPhone) {
        return res.status(404).json({ error: 'Conversación no encontrada' });
    }
    // Solo WhatsApp: los chats de Telegram no se responden desde aquí.
    if (sessionId.includes('_tg_')) {
        return res.status(400).json({ error: 'Este chat es de Telegram y no se puede responder desde aquí.' });
    }

    // El destino es siempre el cliente de ese chat, nunca un número que mande la petición.
    // Se pausa ANTES de enviar para que la IA no conteste a la vez; si WhatsApp rechaza el
    // mensaje, el chat vuelve a como estaba: nadie le escribió al cliente.
    const wasPaused = Boolean(session.isPaused);
    await pauseChat(sessionId);
    try {
        await sendWhatsAppMessage(session.storeId, session.senderPhone, message);
    } catch (error: any) {
        if (!wasPaused) await resumeChat(sessionId);
        return res.status(502).json({ error: readableError(error), botPaused: wasPaused });
    }

    try {
        const history = await getMemory(sessionId);
        history.push({ role: 'assistant', content: message });
        await saveMemory(sessionId, session.storeId, session.senderPhone, history);
    } catch (error: any) {
        logger.error(`Respuesta del admin enviada pero no guardada en el historial: ${error.message}`);
    }

    // Sin el texto ni el número: solo quién respondió y en qué chat.
    const author = typeof req.body?.author === 'string' ? req.body.author.slice(0, 80) : 'desconocido';
    logger.info(`Admin de la tienda: ${author} respondió en ${sessionId}`);
    res.json({ success: true, botPaused: true });
});

/** POST /admin-api/sessions/:sessionId/resume — el bot vuelve a atender el chat. */
adminApiRouter.post('/sessions/:sessionId/resume', async (req: Request, res: Response) => {
    const sessionId = String(req.params['sessionId']);
    const session: any = await getSession(sessionId);
    if (!session?.sessionId) return res.status(404).json({ error: 'Conversación no encontrada' });

    await resumeChat(sessionId);
    await clearHumanTakeover(sessionId);
    if (session.storeId && session.senderPhone) {
        processUnansweredMessage(sessionId, session.storeId, session.senderPhone).catch(error =>
            logger.error(`Error retomando chat desde el admin: ${error.message}`),
        );
    }
    res.json({ success: true, botResumed: true });
});
