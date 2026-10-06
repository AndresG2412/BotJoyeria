// ─────────────────────────────────────────────────────────────────────────────
//  Salud de Google Calendar
//  Verifica que la cuenta de servicio pueda leer/escribir en el calendario
//  del administrador. El calendario debe estar compartido con el client_email
//  de la cuenta de servicio con permiso "Hacer cambios en eventos".
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { config } from '../config/env';
import { logger } from './logger';

export type CalendarState = 'OPERATIVO' | 'CALENDARIO_NO_COMPARTIDO' | 'SIN_CONFIGURAR' | 'ERROR';

export interface CalendarHealth {
    state: CalendarState;
    adminCalendarEmail: string | null;
    serviceAccountEmail: string | null;
    message: string;
    checkedAt: string;
    error?: string;
}

function resolveServiceAccountPath(): string | null {
    if (config.GOOGLE_SERVICE_ACCOUNT_PATH) {
        return path.resolve(process.cwd(), config.GOOGLE_SERVICE_ACCOUNT_PATH);
    }
    const defaultPath = path.resolve(process.cwd(), 'google-service-account.json');
    return fs.existsSync(defaultPath) ? defaultPath : null;
}

export function getServiceAccountEmail(): string | null {
    const filePath = resolveServiceAccountPath();
    if (!filePath) return null;
    try {
        const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return json.client_email || null;
    } catch (e: any) {
        logger.error(`Error leyendo google-service-account.json: ${e.message}`);
        return null;
    }
}

export async function getCalendarHealth(adminCalendarEmail?: string | null): Promise<CalendarHealth> {
    const checkedAt = new Date().toISOString();
    const serviceAccountEmail = getServiceAccountEmail();

    if (!serviceAccountEmail || !adminCalendarEmail) {
        return {
            state: 'SIN_CONFIGURAR',
            adminCalendarEmail: adminCalendarEmail || null,
            serviceAccountEmail,
            message: serviceAccountEmail
                ? 'Falta el correo del calendario. Configúralo en "Mis Datos" → Configurar Citas.'
                : 'Falta el archivo google-service-account.json en la raíz del proyecto o GOOGLE_SERVICE_ACCOUNT_PATH en el .env.',
            checkedAt,
        };
    }

    try {
        const keyFile = resolveServiceAccountPath();
        if (!keyFile) throw new Error('No se encontró el archivo de cuenta de servicio');

        const auth = new google.auth.GoogleAuth({
            keyFile,
            scopes: ['https://www.googleapis.com/auth/calendar'],
        });
        const calendar = google.calendar({ version: 'v3', auth });

        // Ventana mínima para verificar acceso sin devolver muchos eventos.
        const now = new Date();
        const soon = new Date(now.getTime() + 60_000);
        await calendar.events.list({
            calendarId: adminCalendarEmail,
            timeMin: now.toISOString(),
            timeMax: soon.toISOString(),
            maxResults: 1,
            singleEvents: true,
        });

        return {
            state: 'OPERATIVO',
            adminCalendarEmail,
            serviceAccountEmail,
            message: 'Google Calendar está conectado y listo para agendar citas.',
            checkedAt,
        };
    } catch (err: any) {
        const code = err.code;
        const msg = (err.message || '').toLowerCase();
        const isAccessDenied = code === 403 || msg.includes('forbidden') || msg.includes('access denied');
        const isNotFound = code === 404 || msg.includes('notfound') || msg.includes('not found');
        const isUnauthorized = code === 401 || msg.includes('unauthorized') || msg.includes('invalid_grant');

        if (isAccessDenied || isNotFound || isUnauthorized) {
            return {
                state: 'CALENDARIO_NO_COMPARTIDO',
                adminCalendarEmail,
                serviceAccountEmail,
                message: `Comparte tu calendario ${adminCalendarEmail} con ${serviceAccountEmail} dándole permiso "Hacer cambios en eventos".`,
                checkedAt,
                error: err.message,
            };
        }

        logger.error(`Error verificando salud de Calendar: ${err.message}`);
        return {
            state: 'ERROR',
            adminCalendarEmail,
            serviceAccountEmail,
            message: 'Error inesperado al consultar Google Calendar. Revisa los logs del servidor.',
            checkedAt,
            error: err.message,
        };
    }
}
