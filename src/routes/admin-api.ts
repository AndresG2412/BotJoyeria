import crypto from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { getSession, getSessionDetail, getSessionSummaries, getMemory, saveMemory, clearHumanTakeover } from '../data/database';
import { fetchCustomerPhotoForAdmin, pauseChat, processUnansweredMessage, resumeChat, sendWhatsAppMessage } from '../channels/whatsapp-cloud';
import { PHOTO_MEDIA_ID_FIELD } from '../bot/agent';
import {
    APPOINTMENT_STATUSES, Appointment, AppointmentChanges, countUnreadNotifications, createAppointment, getAppointment,
    listAppointments, listNotifications, markAllNotificationsRead, markNotificationRead, updateAppointment,
} from '../data/agenda';
import { AppointmentMode, CALL_APPOINTMENT_CITY, appointmentPlace } from '../bot/policies';
import { checkSlot, normalizeTime } from '../bot/scheduling';
import { normalizeColombianMobile } from '../bot/tools';

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

export type ReadableMessage = { role: 'user' | 'assistant'; content: string; photoId?: string };

/** El identificador de una foto de WhatsApp: solo dígitos (así nadie cuela otra ruta de Graph). */
const MEDIA_ID = /^\d{5,32}$/;

/** El texto que deja el bot en lugar de la foto (src/bot/agent.ts, photoPlaceholder). */
const PHOTO_PLACEHOLDER = /^\[El cliente envió una foto\]\s*/;

/**
 * Solo lo que una persona lee en un chat: sin instrucciones ni llamadas internas de la IA.
 * Un mensaje con foto trae `photoId` (el panel la pide aparte) y como texto solo su pie de foto.
 */
export function toReadableMessages(history: any[]): ReadableMessage[] {
    const messages: ReadableMessage[] = [];
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
        const photoId = typeof message[PHOTO_MEDIA_ID_FIELD] === 'string' && MEDIA_ID.test(message[PHOTO_MEDIA_ID_FIELD])
            ? message[PHOTO_MEDIA_ID_FIELD]
            : undefined;
        content = (photoId ? content.replace(PHOTO_PLACEHOLDER, '') : content).trim();
        if (photoId) messages.push({ role: message.role, content, photoId });
        else if (content) messages.push({ role: message.role, content });
    }
    return messages;
}

/** ¿Esa foto es de ESE chat? El admin no puede pedir cualquier foto de la cuenta de WhatsApp. */
export function chatHasPhoto(history: any[], mediaId: string): boolean {
    return MEDIA_ID.test(mediaId) && (Array.isArray(history) ? history : []).some(m => m?.[PHOTO_MEDIA_ID_FIELD] === mediaId);
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

/**
 * GET /admin-api/sessions/:sessionId/photos/:mediaId — la foto que mandó el cliente, descargada
 * de WhatsApp en el momento. No se guarda en ningún lado; WhatsApp la conserva un tiempo limitado.
 */
adminApiRouter.get('/sessions/:sessionId/photos/:mediaId', async (req: Request, res: Response) => {
    const sessionId = String(req.params['sessionId']);
    const mediaId = String(req.params['mediaId']);
    const session: any = await getSession(sessionId);
    if (!session?.sessionId || !chatHasPhoto(await getMemory(sessionId), mediaId)) {
        return res.status(404).json({ error: 'Foto no encontrada en esta conversación' });
    }
    try {
        const jpeg = await fetchCustomerPhotoForAdmin(session.storeId, mediaId);
        res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' });
        res.send(jpeg);
    } catch (error: any) {
        const gone = error?.status === 404 || /\(código 100\)/.test(String(error?.message));
        res.status(gone ? 410 : 502).json({
            error: gone ? 'WhatsApp ya no tiene esta foto: las borra pasado un tiempo.' : 'No se pudo traer la foto de WhatsApp. Intenta de nuevo.',
        });
    }
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

// ─────────────────────────────────────────────────────────────────────────────
//  CALENDARIO DE CITAS (Mostrador → Citas). Las reglas de horario son las mismas del bot
//  (src/bot/scheduling.ts); desde el panel se puede anotar también para hoy.
// ─────────────────────────────────────────────────────────────────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 62;

function authorOf(req: Request): string {
    return typeof req.body?.author === 'string' && req.body.author.trim() ? req.body.author.trim().slice(0, 80) : 'panel';
}

/** La cita como la ve el panel: la modalidad sale de la ciudad guardada (las llamadas usan CALL_APPOINTMENT_CITY). */
export function toPanelAppointment(appointment: Appointment) {
    const { sessionPhone: _session, city, address, ...rest } = appointment;
    const isCall = city === CALL_APPOINTMENT_CITY;
    return { ...rest, mode: isCall ? 'llamada' : 'presencial', place: isCall ? '' : `${address}, ${city}` };
}

function slotError(res: Response, reason: 'taken' | 'not_found' | 'error') {
    if (reason === 'taken') return res.status(409).json({ error: 'Ese horario ya tiene una cita.' });
    if (reason === 'not_found') return res.status(404).json({ error: 'Cita no encontrada.' });
    return res.status(500).json({ error: 'No se pudo guardar la cita. Intenta de nuevo.' });
}

/** GET /admin-api/appointments?from=YYYY-MM-DD&to=YYYY-MM-DD */
adminApiRouter.get('/appointments', async (req: Request, res: Response) => {
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) {
        return res.status(400).json({ error: 'Rango de fechas inválido.' });
    }
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS) {
        return res.status(400).json({ error: `Máximo ${MAX_RANGE_DAYS} días por consulta.` });
    }
    res.json((await listAppointments(from, to)).map(toPanelAppointment));
});

/** POST /admin-api/appointments — una cita anotada desde el mostrador (alguien que llamó o vino). */
adminApiRouter.post('/appointments', async (req: Request, res: Response) => {
    const b = req.body || {};
    const clientName = typeof b.clientName === 'string' ? b.clientName.trim().slice(0, 120) : '';
    const phone = normalizeColombianMobile(String(b.phone || ''));
    const date = String(b.date || '').trim();
    const time = normalizeTime(String(b.time || ''));
    const mode: AppointmentMode = b.mode === 'llamada' ? 'llamada' : 'presencial';
    if (!clientName) return res.status(400).json({ error: 'Escribe el nombre del cliente.' });
    if (!phone) return res.status(400).json({ error: 'El celular debe tener 10 dígitos.' });
    const problem = checkSlot(date, time, { earliest: 'today' });
    if (problem) return res.status(400).json({ error: problem.message });

    const { city, address } = appointmentPlace(mode);
    const created = await createAppointment({
        storeId: typeof b.storeId === 'string' && b.storeId ? b.storeId : 'default',
        // El mismo identificador que tendría su chat: si después escribe, el bot ve la cita.
        sessionPhone: `57${phone}`,
        clientName,
        phone,
        date,
        time,
        city,
        address,
        appointmentType: b.appointmentType === 'producto_bajo_pedido' ? 'producto_bajo_pedido' : 'asesoria_presencial',
        reference: typeof b.reference === 'string' && b.reference.trim() ? b.reference.trim().slice(0, 200) : 'Asesoría general',
        notes: typeof b.notes === 'string' ? b.notes.trim().slice(0, 1000) : '',
        source: 'panel',
    });
    if (!created.ok) return slotError(res, created.reason);
    logger.info(`Admin de la tienda: ${authorOf(req)} anotó una cita (${created.id})`);
    const appointment = await getAppointment(created.id);
    res.status(201).json(appointment ? toPanelAppointment(appointment) : { id: created.id });
});

/** PATCH /admin-api/appointments/:id — estado, horario o notas. */
adminApiRouter.patch('/appointments/:id', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const current = await getAppointment(id);
    if (!current) return slotError(res, 'not_found');

    const b = req.body || {};
    const changes: AppointmentChanges = {};
    if (b.status !== undefined) {
        if (!APPOINTMENT_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Estado inválido.' });
        changes.status = b.status;
    }
    if (b.notes !== undefined) changes.notes = String(b.notes).trim().slice(0, 1000);
    if (b.date !== undefined || b.time !== undefined) {
        const date = String(b.date ?? current.date).trim();
        const time = normalizeTime(String(b.time ?? current.time));
        const problem = checkSlot(date, time, { earliest: 'today' });
        if (problem) return res.status(400).json({ error: problem.message });
        changes.date = date;
        changes.time = time;
        // Reprogramar una cita cancelada o atendida la vuelve a dejar vigente.
        changes.status = changes.status ?? 'scheduled';
    }
    if (!Object.keys(changes).length) return res.status(400).json({ error: 'No hay cambios.' });

    const result = await updateAppointment(id, changes);
    if (!result.ok) return slotError(res, result.reason);
    logger.info(`Admin de la tienda: ${authorOf(req)} cambió la cita ${id} (${Object.keys(changes).join(', ')})`);
    const updated = await getAppointment(id);
    res.json(updated ? toPanelAppointment(updated) : { id });
});

// ─────────────────────────────────────────────────────────────────────────────
//  AVISOS (la campana del admin de la tienda)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /admin-api/notifications/count — barato: lo consulta la campana cada pocos segundos. */
adminApiRouter.get('/notifications/count', async (_req: Request, res: Response) => {
    res.json(await countUnreadNotifications());
});

/** GET /admin-api/notifications?limit=30 — primero los no leídos. */
adminApiRouter.get('/notifications', async (req: Request, res: Response) => {
    res.json(await listNotifications(Number(req.query.limit) || 30));
});

/** POST /admin-api/notifications/read-all */
adminApiRouter.post('/notifications/read-all', async (req: Request, res: Response) => {
    res.json({ success: true, marked: await markAllNotificationsRead(authorOf(req)) });
});

/** POST /admin-api/notifications/:id/read */
adminApiRouter.post('/notifications/:id/read', async (req: Request, res: Response) => {
    const id = Number(req.params['id']);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Aviso inválido.' });
    res.json({ success: await markNotificationRead(id, authorOf(req)) });
});
