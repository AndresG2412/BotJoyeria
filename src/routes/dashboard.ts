import { Router, Request, Response } from 'express';
import { getSession, getSessionSummaries, getSessionDetail, deleteSession, getMemory, saveMemory, clearHumanTakeover } from '../data/database';
import { getAllProducts, getAllCategorias, clearCatalogCache } from '../data/catalog';
import { db, deleteLocalStore } from '../data/connection';
import { stores, users } from '../data/schema';
import { eq } from 'drizzle-orm';
import path from 'path';
import {
    getStoreWhatsAppHealth,
    sendWhatsAppMessage, pauseChat, resumeChat, processUnansweredMessage
} from '../channels/whatsapp-cloud';
import { testConfiguredModels } from '../bot/agent';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { DEFAULT_STORE_SYSTEM_PROMPT } from '../bot/prompts';

export const dashboardRouter = Router();

// ─────────────────────────────────────────
//  Helpers de autenticación / roles
// ─────────────────────────────────────────
const isSuperAdmin = (req: any): boolean =>
    req.user?.role === 'superadmin' || req.user?.user === config.DASHBOARD_USER;

/** Un dueño de tienda solo toca los chats de su tienda (el id del chat empieza por el de la tienda). */
const ownsSession = (req: any, sessionId: string): boolean =>
    isSuperAdmin(req) || (!!req.user?.storeId && sessionId.startsWith(`${req.user.storeId}_`));

/** Error para el navegador sin detalles internos; el detalle queda en el log. */
const serverError = (res: Response, e: any) => {
    logger.error(`Error en el panel: ${e?.message || e}`);
    res.status(500).json({ error: 'Error interno' });
};

const checkSuperAdmin = (req: any, res: Response, next: any) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Prohibido: Solo superadmin' });
    next();
};

// ─────────────────────────────────────────
//  LEGACY Cloudinary — configuración única
//  (Las imágenes de productos ahora se suben a Supabase Storage; se conserva
//   este bloque comentado por si se quiere volver a Cloudinary)
// ─────────────────────────────────────────
// cloudinary.config({
//     cloud_name: config.CLOUDINARY_CLOUD_NAME,
//     api_key:    config.CLOUDINARY_API_KEY,
//     api_secret: config.CLOUDINARY_API_SECRET,
// });

// ─────────────────────────────────────────
//  USUARIOS  (solo superadmin)
// ─────────────────────────────────────────

/** GET /api/users — listar todos los usuarios */
dashboardRouter.get('/api/users', checkSuperAdmin, async (_req: Request, res: Response) => {
    try {
        const allUsers = await db.select({
            id:        users.id,
            username:  users.username,
            role:      users.role,
            storeId:   users.storeId,
            createdAt: users.createdAt,
        }).from(users);
        res.json(allUsers);
    } catch (e: any) {
        serverError(res, e);
    }
});

/** POST /api/users — crear usuario */
dashboardRouter.post('/api/users', checkSuperAdmin, (_req: Request, res: Response) => {
    // Los usuarios del panel aún no tienen tabla (el acceso es el admin del .env).
    res.status(501).json({ error: 'La gestión de usuarios del panel no está disponible.' });
});

/** DELETE /api/users/:id — eliminar usuario */
dashboardRouter.delete('/api/users/:id', checkSuperAdmin, async (req: Request, res: Response) => {
    try {
        // Los usuarios del panel aún no tienen tabla (el acceso es el admin del .env).
        res.status(501).json({ error: 'La gestión de usuarios del panel no está disponible.' });
    } catch (e: any) {
        serverError(res, e);
    }
});

// ─────────────────────────────────────────
//  TIENDAS / BOTS
// ─────────────────────────────────────────

/** GET /api/stores */
dashboardRouter.get('/api/stores', async (req: any, res: Response) => {
    try {
        const result = isSuperAdmin(req)
            ? await db.query.stores.findMany()
            : await db.query.stores.findMany({ where: eq(stores.id, req.user.storeId) });
        res.json(result);
    } catch (e: any) {
        serverError(res, e);
    }
});

/** POST /api/stores — crear tienda */
dashboardRouter.post('/api/stores', checkSuperAdmin, async (req: Request, res: Response) => {
    try {
        const { id, name, systemPrompt, openaiApiKey, pqrEmail, adminCalendarEmail, telegramToken, telegramBotActive } = req.body;
        if (!id || !name) return res.status(400).json({ error: 'ID y Nombre son obligatorios' });

        const [store] = await db.insert(stores).values({
            id,
            name,
            systemPrompt:       systemPrompt || DEFAULT_STORE_SYSTEM_PROMPT,
            openaiApiKey:       openaiApiKey       || null,
            pqrEmail:           pqrEmail           || null,
            adminCalendarEmail: adminCalendarEmail || null,
            telegramToken:      telegramToken      || null,
            telegramBotActive:  !!telegramBotActive,
            isActive: true,
        }).returning();

        res.status(201).json(store);
    } catch (e: any) {
        serverError(res, e);
    }
});

/** PUT /api/stores/:id — actualizar tienda */
dashboardRouter.put('/api/stores/:id', async (req: any, res: Response) => {
    try {
        const { id } = req.params;
        if (!isSuperAdmin(req) && req.user.storeId !== id)
            return res.status(403).json({ error: 'Sin permiso para modificar esta tienda' });

        const {
            name, systemPrompt, openaiApiKey, isActive,
            whatsappPhoneNumberId, whatsappAccessToken,
            pqrEmail, adminCalendarEmail, telegramToken, telegramBotActive,
        } = req.body;

        if (!name)         return res.status(400).json({ error: 'El nombre es obligatorio' });
        if (!systemPrompt) return res.status(400).json({ error: 'El System Prompt es obligatorio' });

        const [updated] = await db.update(stores)
            .set({
                name, systemPrompt,
                openaiApiKey:       openaiApiKey       || null,
                pqrEmail:           pqrEmail           || null,
                adminCalendarEmail: adminCalendarEmail || null,
                telegramToken:      telegramToken      || null,
                telegramBotActive:  !!telegramBotActive,
                isActive,
                ...(whatsappPhoneNumberId !== undefined && { whatsappPhoneNumberId: whatsappPhoneNumberId || null }),
                ...(whatsappAccessToken   !== undefined && { whatsappAccessToken:   whatsappAccessToken   || null }),
            })
            .where(eq(stores.id, id))
            .returning();

        if (!updated) return res.status(404).json({ error: 'Tienda no encontrada' });
        res.json(updated);
    } catch (e: any) {
        serverError(res, e);
    }
});

/** DELETE /api/stores/:id — eliminar tienda */
dashboardRouter.delete('/api/stores/:id', checkSuperAdmin, async (req: Request, res: Response) => {
    try {
        const id = req.params['id'] as string;
        if (!deleteLocalStore(id)) return res.status(404).json({ error: 'Tienda no encontrada' });
        res.json({ success: true });
    } catch (e: any) {
        serverError(res, e);
    }
});

// ─────────────────────────────────────────
//  WHATSAPP CLOUD API — salud
// ─────────────────────────────────────────

/**
 * GET /api/whatsapp/health/:storeId
 * Cloud API no mantiene una conexión local; este endpoint reporta variables
 * configuradas, último webhook, última respuesta de Graph API y último error.
 */
dashboardRouter.get('/api/whatsapp/health/:storeId', async (req: any, res: Response) => {
    const { storeId } = req.params;
    if (!isSuperAdmin(req) && req.user.storeId !== storeId)
        return res.status(403).json({ error: 'Prohibido' });

    try {
        res.json(await getStoreWhatsAppHealth(storeId));
    } catch (e: any) {
        serverError(res, e);
    }
});

// ─────────────────────────────────────────
//  SESIONES / CHATS
// ─────────────────────────────────────────

/** GET /api/sessions */
dashboardRouter.get('/api/sessions', async (req: any, res: Response) => {
    const storeId = isSuperAdmin(req)
        ? (req.query.storeId as string | undefined)
        : req.user.storeId;

    if (!storeId && !isSuperAdmin(req))
        return res.status(400).json({ error: 'storeId es obligatorio' });

    // Solo el resumen de cada chat: el panel consulta cada 5 s y el historial completo
    // de todas las conversaciones agotaría la transferencia gratuita de Supabase.
    res.json(await getSessionSummaries(storeId));
});

/** GET /api/sessions/:sessionId — historial completo del chat abierto */
dashboardRouter.get('/api/sessions/:sessionId', async (req: any, res: Response) => {
    const sessionId = req.params['sessionId'] as string;
    if (!isSuperAdmin(req) && !sessionId.startsWith(`${req.user.storeId}_`))
        return res.status(403).json({ error: 'Prohibido' });

    const detail = await getSessionDetail(sessionId);
    if (!detail) return res.status(404).json({ error: 'Conversación no encontrada' });
    res.json(detail);
});

/** DELETE /api/sessions/:sessionId */
dashboardRouter.delete('/api/sessions/:sessionId', async (req: Request, res: Response) => {
    try {
        const sessionId = req.params['sessionId'] as string;
        if (!ownsSession(req, sessionId)) return res.status(403).json({ error: 'Prohibido' });
        await deleteSession(sessionId);
        res.json({ success: true });
    } catch (e: any) {
        serverError(res, e);
    }
});

/** POST /api/reply — respuesta humana desde el panel. El destino sale del chat guardado, nunca de la petición. */
dashboardRouter.post('/api/reply', async (req: any, res: Response) => {
    try {
        const { sessionId, message } = req.body;
        if (typeof sessionId !== 'string' || typeof message !== 'string' || !message.trim())
            return res.status(400).json({ error: 'Falta el chat o el mensaje' });
        if (!ownsSession(req, sessionId)) return res.status(403).json({ error: 'Prohibido' });

        const session: any = await getSession(sessionId);
        if (!session?.senderPhone || !session?.storeId)
            return res.status(404).json({ error: 'Conversación no encontrada' });

        await pauseChat(sessionId);
        try {
            const history = await getMemory(sessionId);
            history.push({ role: 'assistant', content: message });
            await saveMemory(sessionId, session.storeId, session.senderPhone, history);
        } catch (e: any) {
            logger.error(`Error guardando mensaje de admin: ${e.message}`);
        }

        await sendWhatsAppMessage(session.storeId, session.senderPhone, message);
        res.json({ success: true, botPaused: true });
    } catch (e: any) {
        serverError(res, e);
    }
});

/** POST /api/resume — reactivar bot en chat pausado */
dashboardRouter.post('/api/resume', async (req: Request, res: Response) => {
    try {
        const { sessionId } = req.body;
        if (typeof sessionId !== 'string' || !sessionId) return res.status(400).json({ error: 'Falta sessionId' });
        if (!ownsSession(req, sessionId)) return res.status(403).json({ error: 'Prohibido' });

        await resumeChat(sessionId);
        // También le quita el chat a la joyería si estaba contestando desde el celular.
        await clearHumanTakeover(sessionId);

        const session: any = await getSession(sessionId);
        if (session?.storeId && session?.senderPhone) {
            processUnansweredMessage(sessionId, session.storeId, session.senderPhone).catch(err =>
                logger.error(`Error en processUnansweredMessage: ${err.message}`)
            );
        }

        res.json({ success: true, botResumed: true });
    } catch (e: any) {
        serverError(res, e);
    }
});

// ─────────────────────────────────────────
//  CATÁLOGO — solo lectura
//  Las piezas y categorías se administran en el panel de la tienda; el bot
//  las lee de su API pública (ver src/data/catalog.ts).
// ─────────────────────────────────────────

const CATALOGO_EN_LA_TIENDA = {
    error: 'El catálogo se administra en el panel de la tienda.',
    adminUrl: `${config.SITE_URL.replace(/\/+$/, '')}/admin`,
};

/** GET /api/categorias — categorías publicadas en la tienda */
dashboardRouter.get('/api/categorias', async (_req: Request, res: Response) => {
    res.json(await getAllCategorias());
});

/** GET /api/products — piezas publicadas en la tienda (opcional ?categoriaId=<slug>) */
dashboardRouter.get('/api/products', async (req: any, res: Response) => {
    if (req.query.refresh === '1') clearCatalogCache();
    const categoriaId = req.query.categoriaId as string | undefined;
    const products = await getAllProducts(undefined, categoriaId);

    res.json(products.map(p => ({
        id:              p.id,
        nombre:          p.name,
        precio:          p.price,
        imagen_url:      p.imageUrl,
        caracteristicas: p.caracteristicas,
        peso:            p.peso,
        stock:           p.stock,
        imagenes:        p.imagenes,
        categoriaId:     p.categoriaId,
        url:             p.url,
    })));
});

// Escrituras retiradas: crear, editar o borrar desde aquí pisaría el inventario de la tienda.
for (const route of ['/api/categorias', '/api/categorias/:id', '/api/products', '/api/products/:id', '/api/upload-images']) {
    dashboardRouter.post(route, (_req: Request, res: Response) => res.status(410).json(CATALOGO_EN_LA_TIENDA));
    dashboardRouter.put(route, (_req: Request, res: Response) => res.status(410).json(CATALOGO_EN_LA_TIENDA));
    dashboardRouter.delete(route, (_req: Request, res: Response) => res.status(410).json(CATALOGO_EN_LA_TIENDA));
}

// ─────────────────────────────────────────
//  UTILIDADES
// ─────────────────────────────────────────

/** GET /api/test-models — prueba rápida de los modelos de IA configurados (superadmin) */
dashboardRouter.get('/api/test-models', checkSuperAdmin, async (_req: Request, res: Response) => {
    res.json(await testConfiguredModels());
});

// ─────────────────────────────────────────
//  Servir el dashboard HTML
// ─────────────────────────────────────────
dashboardRouter.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '../../public/dashboard.html'));
});
