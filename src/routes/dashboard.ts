import { Router, Request, Response } from 'express';
import { getSessionSummaries, getSessionDetail, deleteSession, getMemory, saveMemory, clearHumanTakeover } from '../data/database';
import { getAllProducts, getAllCategorias, clearCatalogCache } from '../data/catalog';
import { db, deleteLocalStore } from '../data/connection';
import { stores, users } from '../data/schema';
import { eq } from 'drizzle-orm';
import path from 'path';
import {
    getStoreWhatsAppHealth,
    sendWhatsAppMessage, pauseChat, resumeChat, processUnansweredMessage
} from '../channels/whatsapp-cloud';
import OpenAI from 'openai';
// import { v2 as cloudinary } from 'cloudinary';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { getCalendarHealth } from '../utils/calendar-health';
import crypto from 'crypto';
import { DEFAULT_STORE_SYSTEM_PROMPT } from '../bot/prompts';

export const dashboardRouter = Router();

// ─────────────────────────────────────────
//  Helpers de autenticación / roles
// ─────────────────────────────────────────
const isSuperAdmin = (req: any): boolean =>
    req.user?.role === 'superadmin' || req.user?.user === config.DASHBOARD_USER;

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
        res.status(500).json({ error: e.message });
    }
});

/** POST /api/users — crear usuario */
dashboardRouter.post('/api/users', checkSuperAdmin, async (req: Request, res: Response) => {
    try {
        const { username, password, storeId, role } = req.body;
        if (!username || !password)
            return res.status(400).json({ error: 'Usuario y contraseña obligatorios' });

        const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
        const [user] = await db.insert(users).values({
            id: Date.now().toString(),
            username,
            passwordHash,
            storeId: storeId || null,
            role:    role || 'store_owner',
        }).returning();

        res.status(201).json({ id: user.id, username: user.username, role: user.role });
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

/** DELETE /api/users/:id — eliminar usuario */
dashboardRouter.delete('/api/users/:id', checkSuperAdmin, async (req: Request, res: Response) => {
    try {
        // Los usuarios del panel aún no tienen tabla (el acceso es el admin del .env).
        res.status(501).json({ error: 'La gestión de usuarios del panel no está disponible.' });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
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
        res.status(500).json({ error: e.message });
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
        res.status(400).json({ error: e.message });
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
        res.status(400).json({ error: e.message });
    }
});

/** DELETE /api/stores/:id — eliminar tienda */
dashboardRouter.delete('/api/stores/:id', checkSuperAdmin, async (req: Request, res: Response) => {
    try {
        const id = req.params['id'] as string;
        if (!deleteLocalStore(id)) return res.status(404).json({ error: 'Tienda no encontrada' });
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
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
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────
//  GOOGLE CALENDAR — salud
// ─────────────────────────────────────────

/**
 * GET /api/calendar/health/:storeId
 * Reporta si el calendario del administrador está accesible por la cuenta de
 * servicio. Si no está compartido, devuelve el client_email exacto a autorizar.
 */
dashboardRouter.get('/api/calendar/health/:storeId', async (req: any, res: Response) => {
    const { storeId } = req.params;
    if (!isSuperAdmin(req) && req.user.storeId !== storeId)
        return res.status(403).json({ error: 'Prohibido' });

    try {
        const store = await db.query.stores.findFirst({ where: eq(stores.id, storeId) });
        res.json(await getCalendarHealth(store?.adminCalendarEmail));
    } catch (e: any) {
        res.status(500).json({ error: e.message });
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
        await deleteSession(req.params['sessionId'] as string);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

/** POST /api/reply — respuesta humana desde el panel */
dashboardRouter.post('/api/reply', async (req: any, res: Response) => {
    try {
        const { sessionId, message, phone } = req.body;
        const storeId = isSuperAdmin(req) ? req.body.storeId : req.user.storeId;

        if (!phone || !message || !storeId)
            return res.status(400).json({ error: 'Falta teléfono, mensaje o storeId' });

        if (sessionId) {
            await pauseChat(sessionId);
            try {
                const history = await getMemory(sessionId);
                history.push({ role: 'assistant', content: message });
                await saveMemory(sessionId, storeId, phone, history);
            } catch (e: any) {
                logger.error(`Error guardando mensaje de admin: ${e.message}`);
            }
        }

        await sendWhatsAppMessage(storeId, phone, message);
        res.json({ success: true, botPaused: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

/** POST /api/resume — reactivar bot en chat pausado */
dashboardRouter.post('/api/resume', async (req: Request, res: Response) => {
    try {
        const { sessionId } = req.body;
        if (!sessionId) return res.status(400).json({ error: 'Falta sessionId' });

        await resumeChat(sessionId);
        // También le quita el chat a la joyería si estaba contestando desde el celular.
        await clearHumanTakeover(sessionId);

        const parts = sessionId.split('_');
        if (parts.length >= 2) {
            const [storeId, ...rest] = parts;
            const phone = rest.join('_');
            processUnansweredMessage(sessionId, storeId, phone).catch(err =>
                logger.error(`Error en processUnansweredMessage: ${err.message}`)
            );
        }

        res.json({ success: true, botResumed: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
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

/** GET /api/test-models — prueba rápida de modelos disponibles (superadmin) */
dashboardRouter.get('/api/test-models', checkSuperAdmin, async (_req: Request, res: Response) => {
    const models = [
        'gemini-2.5-flash', 'gemini-2.5-flash-lite',
        'gemini-2.0-flash', 'gemini-2.0-flash-lite',
        'gemini-2.5-pro', 'gemma-3-27b-it', 'gemma-3-4b-it',
    ];
    const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY, baseURL: config.OPENAI_BASE_URL || undefined });
    const results: Record<string, string> = {};

    for (const model of models) {
        try {
            const r = await openai.chat.completions.create({
                model,
                messages: [{ role: 'user', content: 'Responde solo: OK' }],
                max_tokens: 5,
            } as any);
            results[model] = `✅ ${r.choices[0].message.content?.trim()}`;
        } catch (err: any) {
            results[model] = `❌ ${err.status ?? ''} ${err.message?.substring(0, 60)}`;
        }
    }

    res.json(results);
});

// ─────────────────────────────────────────
//  Servir el dashboard HTML
// ─────────────────────────────────────────
dashboardRouter.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '../../public/dashboard.html'));
});
