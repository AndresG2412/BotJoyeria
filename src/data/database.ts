import { pool } from './pool';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
//  Sesiones de chat y citas en la base de la tienda, esquema `bot`
//  Tablas: bot.sessions, bot.appointments (supabase/002_bot_schema.sql)
// ─────────────────────────────────────────────────────────────────────────────

/** El historial se guarda como jsonb: node-postgres convertiría un array JS en un array de Postgres. */
function toJson(value: unknown): string {
    return JSON.stringify(value ?? []);
}

export const getSession = async (sessionId: string) => {
    if (!pool) return { isPaused: false };
    try {
        const { rows } = await pool.query(
            'select * from bot.sessions where session_id = $1',
            [sessionId],
        );
        const data = rows[0];
        if (data) {
            return {
                sessionId: data.session_id,
                storeId: data.store_id,
                senderPhone: data.sender_phone,
                messages: data.messages || [],
                isPaused: data.is_paused || false,
                hasAppointment: data.has_appointment || false,
                updatedAt: data.updated_at ? new Date(data.updated_at) : null,
            };
        }
    } catch (e: any) {
        logger.error(`Error leyendo sesión: ${e.message}`);
    }
    return { isPaused: false };
};

export const setSessionPause = async (sessionId: string, isPaused: boolean) => {
    if (!pool) return true;
    try {
        await pool.query(
            `insert into bot.sessions (session_id, is_paused) values ($1, $2)
             on conflict (session_id) do update set is_paused = excluded.is_paused`,
            [sessionId, isPaused],
        );
        return true;
    } catch (e: any) {
        logger.error(`Error pausando sesión: ${e.message}`);
        return false;
    }
};

export const checkRateLimit = async (_sessionId: string, _maxMessages: number) => {
    return { allowed: true };
};

export const incrementMessageCount = async (_sessionId: string) => {
    return true;
};

export const getAllSessions = async (storeId?: string) => {
    if (!pool) return [];
    try {
        const { rows } = storeId
            ? await pool.query('select * from bot.sessions where store_id = $1 order by updated_at desc', [storeId])
            : await pool.query('select * from bot.sessions order by updated_at desc');

        return rows.map(row => ({
            id: row.session_id,
            sessionId: row.session_id,
            storeId: row.store_id || 'default',
            phone: row.sender_phone || row.session_id.split('_')[1] || row.session_id,
            isPaused: row.is_paused || false,
            history: row.messages || [],
            updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
        }));
    } catch (e: any) {
        logger.error(`Error getting all sessions: ${e.message}`);
        return [];
    }
};

export const deleteSession = async (sessionId: string) => {
    if (!pool) return true;
    try {
        await pool.query('delete from bot.sessions where session_id = $1', [sessionId]);
        return true;
    } catch (e: any) {
        logger.error(`Error borrando sesión: ${e.message}`);
        return false;
    }
};

export const getSessionLastActivity = async (sessionId: string): Promise<Date | null> => {
    if (!pool) return null;
    try {
        const { rows } = await pool.query('select updated_at from bot.sessions where session_id = $1', [sessionId]);
        if (rows[0]?.updated_at) return new Date(rows[0].updated_at);
    } catch (e: any) {
        logger.error(`Error getting session last activity: ${e.message}`);
    }
    return null;
};

export const clearSession = async (sessionId: string, storeId: string, senderPhone: string, systemPrompt: string) => {
    if (!pool) return true;
    try {
        const freshMessages = [{ role: 'system', content: systemPrompt }];
        await pool.query(
            `insert into bot.sessions (session_id, store_id, sender_phone, messages, has_appointment, updated_at)
             values ($1, $2, $3, $4::jsonb, false, now())
             on conflict (session_id) do update set
                store_id = excluded.store_id,
                sender_phone = excluded.sender_phone,
                messages = excluded.messages,
                has_appointment = false,
                updated_at = now()`,
            [sessionId, storeId, senderPhone, toJson(freshMessages)],
        );
        return true;
    } catch (e: any) {
        logger.error(`Error clearing session: ${e.message}`);
        return false;
    }
};

export const setSessionAppointmentFlag = async (sessionId: string, hasAppointment: boolean) => {
    if (!pool) return true;
    try {
        await pool.query(
            `insert into bot.sessions (session_id, has_appointment) values ($1, $2)
             on conflict (session_id) do update set has_appointment = excluded.has_appointment`,
            [sessionId, hasAppointment],
        );
        return true;
    } catch (e: any) {
        logger.error(`Error setting session appointment flag: ${e.message}`);
        return false;
    }
};

export const getMemory = async (sessionId: string): Promise<any[]> => {
    if (!pool) return [];
    try {
        const { rows } = await pool.query('select messages from bot.sessions where session_id = $1', [sessionId]);
        if (rows[0]) return Array.isArray(rows[0].messages) ? rows[0].messages : [];
    } catch (e: any) {
        logger.error(`Error leyendo historial: ${e.message}`);
    }
    return [];
};

export const saveMemory = async (sessionId: string, storeId: string, senderPhone: string, messages: any[]) => {
    if (!pool) return true;
    try {
        await pool.query(
            `insert into bot.sessions (session_id, store_id, sender_phone, messages, updated_at)
             values ($1, $2, $3, $4::jsonb, now())
             on conflict (session_id) do update set
                store_id = excluded.store_id,
                sender_phone = excluded.sender_phone,
                messages = excluded.messages,
                updated_at = now()`,
            [sessionId, storeId, senderPhone, toJson(messages)],
        );
        return true;
    } catch (e: any) {
        logger.error(`Error saving memory: ${e.message}`);
        return false;
    }
};

export interface AppointmentData {
    clientName: string;
    city: string;
    date: string; // YYYY-MM-DD
    time: string; // HH:MM
    appointmentType: string;
    propertyReference?: string;
    address?: string;
    phone?: string;
    calendarEventId?: string;
    status: 'scheduled' | 'cancelled' | 'completed';
    createdAt: Date | any;
}

export const saveAppointment = async (storeId: string, senderPhone: string, data: AppointmentData) => {
    if (!pool) return false;
    try {
        const appointmentId = `${storeId}_${senderPhone}_${data.date}_${data.time.replace(':', '')}`;
        await pool.query(
            `insert into bot.appointments (
                id, store_id, sender_phone, client_name, city, date, time, appointment_type,
                property_reference, address, phone, calendar_event_id, status, created_at, updated_at
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
             on conflict (id) do update set
                client_name = excluded.client_name,
                city = excluded.city,
                appointment_type = excluded.appointment_type,
                property_reference = excluded.property_reference,
                address = excluded.address,
                phone = excluded.phone,
                calendar_event_id = excluded.calendar_event_id,
                status = excluded.status,
                updated_at = now()`,
            [
                appointmentId, storeId, senderPhone,
                data.clientName || '', data.city || '', data.date || '', data.time || '',
                data.appointmentType || '', data.propertyReference || '', data.address || '',
                data.phone || '', data.calendarEventId || null, data.status || 'scheduled',
                data.createdAt instanceof Date ? data.createdAt : new Date(),
            ],
        );
        return true;
    } catch (e: any) {
        logger.error(`Error saving appointment: ${e.message}`);
        return false;
    }
};

export const checkPendingAppointment = async (storeId: string, senderPhone: string): Promise<boolean> => {
    return !!(await getPendingAppointment(storeId, senderPhone));
};

export type PendingAppointment = AppointmentData & {
    id: string;
    storeId: string;
    senderPhone: string;
    calendarEventId?: string | null;
};

export const getPendingAppointment = async (storeId: string, senderPhone: string): Promise<PendingAppointment | null> => {
    if (!pool) return null;
    try {
        const { rows } = await pool.query(
            `select * from bot.appointments
             where store_id = $1 and sender_phone = $2 and status = 'scheduled'
             order by date, time`,
            [storeId, senderPhone],
        );

        const now = new Date();
        for (const row of rows) {
            if (row.date && row.time) {
                const appointmentDateTime = new Date(`${row.date}T${row.time}:00-05:00`);
                if (appointmentDateTime > now) return {
                    id: row.id,
                    storeId: row.store_id,
                    senderPhone: row.sender_phone,
                    clientName: row.client_name || '',
                    city: row.city || '',
                    date: row.date,
                    time: row.time,
                    appointmentType: row.appointment_type || '',
                    propertyReference: row.property_reference || '',
                    address: row.address || '',
                    phone: row.phone || '',
                    calendarEventId: row.calendar_event_id || null,
                    status: row.status,
                    createdAt: row.created_at,
                };
            }
        }
    } catch (e: any) {
        logger.error(`Error checking pending appointment: ${e.message}`);
    }
    return null;
};

export const updateAppointmentSchedule = async (
    storeId: string,
    senderPhone: string,
    appointmentId: string,
    date: string,
    time: string,
    calendarEventId?: string | null,
): Promise<boolean> => {
    if (!pool) return false;
    try {
        const { rowCount } = await pool.query(
            `update bot.appointments set
                date = $4,
                time = $5,
                calendar_event_id = case when $6::boolean then $7 else calendar_event_id end,
                status = 'scheduled',
                updated_at = now()
             where id = $1 and store_id = $2 and sender_phone = $3`,
            [appointmentId, storeId, senderPhone, date, time, calendarEventId !== undefined, calendarEventId ?? null],
        );
        return (rowCount ?? 0) > 0;
    } catch (e: any) {
        logger.error(`Error updating appointment: ${e.message}`);
        return false;
    }
};
