import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import { config } from './config/env';
import { logger } from './utils/logger';
import { whatsappRouter, initializeWhatsAppCloud } from './channels/whatsapp-cloud';
import { initializeTelegramClients, stopTelegramBot } from './channels/telegram';
import { dashboardRouter } from './routes/dashboard';
import { adminApiRouter } from './routes/admin-api';
import path from 'path';
import { eq } from 'drizzle-orm';
import { initializeDatabase } from './data/pool';
import { purgeInactiveSessions } from './data/database';
import { db } from './data/connection';
import { stores } from './data/schema';

/** Comparación en tiempo constante para no filtrar la contraseña por tiempos de respuesta. */
function safeEqual(a: unknown, b: string): boolean {
    const left = crypto.createHash('sha256').update(String(a ?? '')).digest();
    const right = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(left, right);
}

function bootstrap() {
    logger.info(`Iniciando AI Bot para Ecommerce: ${config.STORE_NAME}`);

    void initializeDatabase().then(async connected => {
        if (!connected) return;
        // Ley 1581: los chats sin actividad se borran pasado el plazo (al arrancar y cada 6 h).
        const purge = async () => {
            const deleted = await purgeInactiveSessions(config.BOT_SESSION_RETENTION_DAYS);
            if (deleted > 0) logger.info(`Chats borrados por inactividad (> ${config.BOT_SESSION_RETENTION_DAYS} días): ${deleted}`);
        };
        await purge();
        setInterval(purge, 6 * 60 * 60 * 1000).unref();
    });

    const app = express();

    // ngrok corre en el mismo servidor y reenvía con X-Forwarded-For: confiar en ese único salto
    // para que el límite de peticiones cuente por IP real y no a todos como si fueran ngrok.
    app.set('trust proxy', 1);

    // 1. Seguridad Básica (Headers)
    app.use(helmet({
        contentSecurityPolicy: false,
    }));

    // Meta y el panel mandan JSON pequeño (las fotos se bajan aparte): 1 MB alcanza y evita
    // que unos pocos cuerpos gigantes sin autenticar llenen la memoria.
    app.use(express.json({
        limit: '1mb',
        verify: (req, _res, buf) => {
            // Meta firma el cuerpo exacto de la petición, antes de parsearlo como JSON.
            (req as any).rawBody = Buffer.from(buf);
        },
    }));
    app.use(cookieParser());

    // 2. Limitación de Peticiones
    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 3000, // Aumentado porque el dashboard hace polling cada 5 segundos
        message: { error: 'Demasiadas peticiones desde esta IP' }
    });
    app.use('/dashboard/api', limiter);

    // Contra adivinar la contraseña del panel: 10 intentos fallidos cada 15 min por IP.
    const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 10,
        skipSuccessfulRequests: true,
        message: { error: 'Demasiados intentos. Espera unos minutos.' },
    });

    // --- SISTEMA DE AUTENTICACIÓN POR COOKIE/JWT ---

    // Middleware de protección
    const authMiddleware = (req: any, res: any, next: any) => {
        const token = req.cookies.auth_token;

        const isApiRequest = req.originalUrl.includes('/api/') || req.xhr;

        if (!token) {
            if (isApiRequest) {
                return res.status(401).json({ error: 'Sesión expirada o inválida' });
            }
            return res.redirect('/login.html');
        }

        try {
            const decoded = jwt.verify(token, config.JWT_SECRET) as any;
            req.user = decoded;
            next();
        } catch (err) {
            res.clearCookie('auth_token');
            if (isApiRequest) {
                return res.status(401).json({ error: 'Sesión expirada' });
            }
            return res.redirect('/login.html');
        }
    };

    // Ruta de Login
    app.post('/api/auth/login', loginLimiter, async (req, res) => {
        try {
            const { username, password } = req.body;
            if (!username || !password) {
                return res.status(400).json({ error: 'Faltan credenciales' });
            }

            // El único acceso al panel es el admin del .env (no hay tabla de usuarios).
            if (config.DASHBOARD_PASSWORD && safeEqual(username, config.DASHBOARD_USER) && safeEqual(password, config.DASHBOARD_PASSWORD)) {
                const token = jwt.sign({ user: username, role: 'superadmin', storeId: null }, config.JWT_SECRET, { expiresIn: '24h' });
                res.cookie('auth_token', token, {
                    httpOnly: true,
                    secure: true, // los navegadores la aceptan también en http://localhost
                    sameSite: 'strict',
                    maxAge: 24 * 60 * 60 * 1000
                });
                return res.json({ success: true });
            }
        } catch (e) {
            logger.error('Error en el login:', e);
        }

        res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    });

    // Ruta de Logout
    app.post('/api/auth/logout', (req, res) => {
        res.clearCookie('auth_token');
        res.json({ success: true });
    });

    // Salud pública mínima del proceso (para monitoreo del servidor). El detalle de
    // WhatsApp está en /dashboard/api/whatsapp/health/:storeId, protegido por login.
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
    });

    // Rutear las peticiones de WhatsApp (Webhooks suelen ser públicos o validados internamente)
    app.use('/webhook/whatsapp', whatsappRouter);

    // Chats para el admin de la tienda (servidor a servidor, con BOT_ADMIN_API_TOKEN).
    app.use('/admin-api', rateLimit({ windowMs: 60 * 1000, max: 240 }), adminApiRouter);

    // Archivos estáticos públicos (CSS, Login, etc)
    app.use(express.static(path.join(__dirname, '../public')));

    // Rutear el panel de control con protección JWT
    app.use('/dashboard', authMiddleware, dashboardRouter);

    // Errores no capturados (JSON mal formado, cuerpo muy grande, fallas de la base): nunca
    // devolver el stack ni detalles internos.
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        const status = Number(err?.status || err?.statusCode) || 500;
        if (status >= 500) logger.error('Error no controlado en una petición:', err);
        if (res.headersSent) return;
        res.status(status).json({ error: status >= 500 ? 'Error interno' : 'Petición inválida' });
    });

    // Solo en la máquina: el público entra por ngrok, que se conecta a localhost. Así nadie se
    // salta ngrok ni falsifica X-Forwarded-For (ver trust proxy arriba).
    app.listen(config.PORT, config.HOST, () => {
        logger.info(`🌍 Panel de control escuchando en ${config.HOST}:${config.PORT}`);
        logger.info(`Accede al panel en: http://localhost:${config.PORT}/dashboard`);
    });

    // La integración oficial no inicia navegador ni requiere QR.
    initializeWhatsAppCloud();
    initializeTelegramClients();

    // Manejar cierres inesperados (Graceful Shutdown)
    const shutdown = async () => {
        logger.info('🛑 Cerrando el bot...');

        try {
            const allStores = await db.query.stores.findMany({ where: eq(stores.isActive, true) });
            for (const s of allStores) {
                stopTelegramBot(s.id);
            }
            logger.info('✅ Clientes de Telegram detenidos. WhatsApp Cloud API no mantiene procesos locales.');
        } catch (error) {
            logger.error('Error durante el cierre:', error);
        }

        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Capturar errores fatales para no dejar navegadores zombies
    process.on('uncaughtException', async (err) => {
        logger.error('💥 Error Fatal no capturado:', err);
        await shutdown();
    });
    process.on('unhandledRejection', async (reason, promise) => {
        logger.error('💥 Promesa rechazada no capturada:', reason);
        // Algunos errores de Puppeteer (Execution context) son promesas rechazadas
        // Si es un error crítico de Puppeteer, cerramos todo de forma segura
        if (reason && reason.toString().includes('Execution context was destroyed')) {
            logger.error('Reiniciando bots por error de Puppeteer...');
            await shutdown();
        }
    });
}

bootstrap();
