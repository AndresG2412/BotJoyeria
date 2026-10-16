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

/**
 * Las instrucciones de la IA (~18 mil caracteres) se rearman en cada mensaje: guardarlas en
 * cada conversación solo gastaba espacio y transferencia. Se quitan al guardar y el agente
 * las vuelve a poner al leer.
 */
export function withoutSystemPrompt(messages: any[]): any[] {
    return (Array.isArray(messages) ? messages : []).filter(m => m?.role !== 'system');
}

/** Lo justo para el panel: nunca se lee el historial completo de todas las conversaciones. */
const SESSION_SUMMARY_COLUMNS = `
    session_id, store_id, sender_phone, is_paused, has_appointment, human_until, updated_at,
    (select jsonb_build_object('role', e.m->>'role', 'content', left(e.m->>'content', 80))
       from jsonb_array_elements(s.messages) with ordinality as e(m, i)
      where e.m->>'role' in ('user', 'assistant') and jsonb_typeof(e.m->'content') = 'string'
      order by e.i desc limit 1) as last_message`;

function phoneOf(row: any): string {
    return row.sender_phone || row.session_id.split('_').slice(1).join('_') || row.session_id;
}

export const getSession = async (sessionId: string) => {
    if (!pool) return { isPaused: false };
    try {
        // Sin `messages`: quien necesita el historial usa getMemory.
        const { rows } = await pool.query(
            'select session_id, store_id, sender_phone, is_paused, has_appointment, human_until, updated_at from bot.sessions where session_id = $1',
            [sessionId],
        );
        const data = rows[0];
        if (data) {
            return {
                sessionId: data.session_id,
                storeId: data.store_id,
                senderPhone: data.sender_phone,
                isPaused: data.is_paused || false,
                humanUntil: data.human_until ? new Date(data.human_until) : null,
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

/** Lista para el panel: datos de cada conversación y su último mensaje (recortado). */
export const getSessionSummaries = async (storeId?: string, limit = 200) => {
    if (!pool) return [];
    try {
        const { rows } = await pool.query(
            `select ${SESSION_SUMMARY_COLUMNS} from bot.sessions s
             where ($1::text is null or s.store_id = $1)
             order by s.updated_at desc limit $2`,
            [storeId ?? null, limit],
        );
        return rows.map(row => ({
            sessionId: row.session_id,
            storeId: row.store_id || 'default',
            phone: phoneOf(row),
            isPaused: row.is_paused || false,
            humanUntil: row.human_until ? new Date(row.human_until) : null,
            hasAppointment: row.has_appointment || false,
            lastMessage: row.last_message || null,
            updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
        }));
    } catch (e: any) {
        logger.error(`Error listando sesiones: ${e.message}`);
        return [];
    }
};

/** Una conversación completa (la que el asesor abre en el panel). */
export const getSessionDetail = async (sessionId: string) => {
    if (!pool) return null;
    try {
        const { rows } = await pool.query('select * from bot.sessions where session_id = $1', [sessionId]);
        const row = rows[0];
        if (!row) return null;
        return {
            sessionId: row.session_id,
            storeId: row.store_id || 'default',
            phone: phoneOf(row),
            isPaused: row.is_paused || false,
            humanUntil: row.human_until ? new Date(row.human_until) : null,
            history: withoutSystemPrompt(row.messages),
            updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
        };
    } catch (e: any) {
        logger.error(`Error leyendo sesión: ${e.message}`);
        return null;
    }
};

/**
 * Chats pausados por un asesor cuyo último mensaje es del cliente y llevan `minutes` sin
 * movimiento: el bot los retoma. El filtro corre en la base; solo vuelven los ids.
 */
export const getStalePausedSessions = async (minutes: number) => {
    if (!pool) return [];
    try {
        const { rows } = await pool.query(
            `select session_id, store_id, sender_phone from bot.sessions
             where is_paused
               and updated_at <= now() - make_interval(mins => $1)
               and messages -> -1 ->> 'role' = 'user'`,
            [minutes],
        );
        return rows.map(row => ({ sessionId: row.session_id, storeId: row.store_id || 'default', phone: phoneOf(row) }));
    } catch (e: any) {
        logger.error(`Error buscando chats pausados: ${e.message}`);
        return [];
    }
};

/** Ley 1581: los chats sin actividad por más de `days` días se borran (las citas se conservan). */
export const purgeInactiveSessions = async (days: number): Promise<number> => {
    if (!pool || !(days > 0)) return 0;
    try {
        const { rowCount } = await pool.query(
            'delete from bot.sessions where updated_at < now() - make_interval(days => $1)',
            [days],
        );
        return rowCount ?? 0;
    } catch (e: any) {
        logger.error(`Error borrando chats viejos: ${e.message}`);
        return 0;
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
        void systemPrompt; // el agente lo vuelve a poner al leer
        await pool.query(
            `insert into bot.sessions (session_id, store_id, sender_phone, messages, has_appointment, updated_at)
             values ($1, $2, $3, $4::jsonb, false, now())
             on conflict (session_id) do update set
                store_id = excluded.store_id,
                sender_phone = excluded.sender_phone,
                messages = excluded.messages,
                has_appointment = false,
                updated_at = now()`,
            [sessionId, storeId, senderPhone, toJson([])],
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
        if (rows[0]) return withoutSystemPrompt(rows[0].messages);
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
            [sessionId, storeId, senderPhone, toJson(withoutSystemPrompt(messages))],
        );
        return true;
    } catch (e: any) {
        logger.error(`Error saving memory: ${e.message}`);
        return false;
    }
};

/** ¿Alguien de la joyería está atendiendo este chat desde el celular? */
export function isHumanAttending(session: { humanUntil?: Date | null } | null | undefined, now = new Date()): boolean {
    return !!session?.humanUntil && session.humanUntil.getTime() > now.getTime();
}

/** Máximo de mensajes que se conservan al agregar desde fuera del agente (el agente ya recorta a 15). */
const MAX_STORED_MESSAGES = 40;

/**
 * Alguien de la joyería contestó desde la app WhatsApp Business (coexistencia): se agregan al
 * historial los mensajes del cliente que esperaban respuesta y la respuesta humana, y el bot se
 * aparta del chat por `hours` horas. Todo en una sola sentencia, sin leer y reescribir el historial.
 */
export const markHumanReply = async (
    sessionId: string,
    storeId: string,
    senderPhone: string,
    pendingUserTexts: string[],
    humanText: string,
    hours: number,
): Promise<boolean> => {
    if (!pool) return false;
    const appended = [
        ...pendingUserTexts.filter(Boolean).map(content => ({ role: 'user', content })),
        { role: 'assistant', content: humanText },
    ];
    try {
        await pool.query(
            `insert into bot.sessions (session_id, store_id, sender_phone, messages, human_until, updated_at)
             values ($1, $2, $3, $4::jsonb, now() + make_interval(hours => $5), now())
             on conflict (session_id) do update set
                messages = (
                    select coalesce(jsonb_agg(e.m order by e.i), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(bot.sessions.messages, '[]'::jsonb) || excluded.messages)
                         with ordinality as e(m, i)
                    where e.i > jsonb_array_length(coalesce(bot.sessions.messages, '[]'::jsonb) || excluded.messages) - $6
                ),
                human_until = excluded.human_until,
                updated_at = now()`,
            [sessionId, storeId, senderPhone, toJson(appended), hours, MAX_STORED_MESSAGES],
        );
        return true;
    } catch (e: any) {
        logger.error(`Error registrando respuesta desde el celular: ${e.message}`);
        return false;
    }
};

/** El bot vuelve a atender el chat (botón «Reactivar bot» del panel). */
export const clearHumanTakeover = async (sessionId: string): Promise<boolean> => {
    if (!pool) return false;
    try {
        await pool.query('update bot.sessions set human_until = null where session_id = $1', [sessionId]);
        return true;
    } catch (e: any) {
        logger.error(`Error devolviendo el chat al bot: ${e.message}`);
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
