import express from 'express';
import cors from 'cors';
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
import path from 'path';
import { eq } from 'drizzle-orm';
import { initializeDatabase } from './data/pool';
import { db } from './data/connection';
import { users, stores } from './data/schema';

/** Comparación en tiempo constante para no filtrar la contraseña por tiempos de respuesta. */
function safeEqual(a: unknown, b: string): boolean {
    const left = crypto.createHash('sha256').update(String(a ?? '')).digest();
    const right = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(left, right);
}

function bootstrap() {
    logger.info(`Iniciando AI Bot para Ecommerce: ${config.STORE_NAME}`);

    void initializeDatabase();

    const app = express();

    // 1. Seguridad Básica (Headers)
    app.use(helmet({
        contentSecurityPolicy: false,
    }));

    app.use(express.json({
        limit: '25mb',
        verify: (req, _res, buf) => {
            // Meta firma el cuerpo exacto de la petición, antes de parsearlo como JSON.
            (req as any).rawBody = Buffer.from(buf);
        },
    }));
    app.use(express.urlencoded({ limit: '25mb', extended: true }));
    app.use(cookieParser());
    app.use(cors());

    // 2. Limitación de Peticiones
    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 3000, // Aumentado porque el dashboard hace polling cada 5 segundos
        message: { error: 'Demasiadas peticiones desde esta IP' }
    });
    app.use('/dashboard/api', limiter);

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
    app.post('/api/auth/login', async (req, res) => {
        try {
            const { username, password } = req.body;
            if (!username || !password) {
                return res.status(400).json({ error: 'Faltan credenciales' });
            }

            // Fallback a superadmin del .env si la tabla está vacía o es admin root
            if (config.DASHBOARD_PASSWORD && safeEqual(username, config.DASHBOARD_USER) && safeEqual(password, config.DASHBOARD_PASSWORD)) {
                const token = jwt.sign({ user: username, role: 'superadmin', storeId: null }, config.JWT_SECRET, { expiresIn: '24h' });
                res.cookie('auth_token', token, {
                    httpOnly: true,
                    sameSite: 'lax',
                    maxAge: 24 * 60 * 60 * 1000
                });
                return res.json({ success: true });
            }

            // Buscar en BD
            const user = await db.query.users.findFirst({
                where: eq(users.username, username)
            });

            if (user) {
                // Implementación simple de hash comparativo (puedes mejorar esto con bcrypt después)
                const hashedPass = crypto.createHash('sha256').update(password).digest('hex');
                if (user.passwordHash === hashedPass || user.passwordHash === password) {
                    const token = jwt.sign({
                        user: user.username,
                        role: user.role,
                        storeId: user.storeId
                    }, config.JWT_SECRET, { expiresIn: '24h' });

                    res.cookie('auth_token', token, {
                        httpOnly: true,
                        sameSite: 'lax',
                        maxAge: 24 * 60 * 60 * 1000
                    });
                    return res.json({ success: true });
                }
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

    // Archivos estáticos públicos (CSS, Login, etc)
    app.use(express.static(path.join(__dirname, '../public')));

    // Rutear el panel de control con protección JWT
    app.use('/dashboard', authMiddleware, dashboardRouter);

    app.listen(config.PORT, () => {
        logger.info(`🌍 Panel de control escuchando en el puerto ${config.PORT}`);
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
