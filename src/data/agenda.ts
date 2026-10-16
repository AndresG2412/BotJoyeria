import { pool } from './pool';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
//  Calendario propio de citas y avisos para la joyería (supabase/005_calendario_y_avisos.sql)
//
//  bot.appointments es el único calendario (ya no hay Google Calendar). Un índice único impide
//  dos citas vigentes en la misma fecha y hora. bot.notifications guarda lo que el panel de la
//  tienda muestra en la campana.
// ─────────────────────────────────────────────────────────────────────────────

export type AppointmentStatus = 'scheduled' | 'cancelled' | 'completed' | 'no_show';
export const APPOINTMENT_STATUSES: AppointmentStatus[] = ['scheduled', 'cancelled', 'completed', 'no_show'];

export type NotificationKind = 'cita_nueva' | 'llamada_agendada' | 'cita_reprogramada' | 'llamar_ya' | 'pide_asesor' | 'cotizacion';

export type Appointment = {
    id: string;
    storeId: string;
    sessionPhone: string;
    clientName: string;
    phone: string;
    date: string;
    time: string;
    city: string;
    address: string;
    appointmentType: string;
    reference: string;
    status: AppointmentStatus;
    notes: string;
    source: 'bot' | 'panel';
    createdAt: string;
    updatedAt: string;
};

export type SlotResult = { ok: true; id: string } | { ok: false; reason: 'taken' | 'not_found' | 'error' };

/** Código de Postgres para una fila que choca con un índice único (aquí: el horario ya tiene cita). */
const UNIQUE_VIOLATION = '23505';

function toAppointment(row: any): Appointment {
    return {
        id: row.id,
        storeId: row.store_id,
        sessionPhone: row.sender_phone,
        clientName: row.client_name || '',
        phone: row.phone || '',
        date: row.date,
        time: row.time,
        city: row.city || '',
        address: row.address || '',
        appointmentType: row.appointment_type || '',
        reference: row.property_reference || '',
        status: row.status,
        notes: row.notes || '',
        source: row.source === 'panel' ? 'panel' : 'bot',
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}

/** ¿Hay una cita vigente en ese horario? (sin contar `exceptId`, la que se está moviendo) */
export async function isSlotTaken(storeId: string, date: string, time: string, exceptId?: string): Promise<boolean> {
    if (!pool) return false;
    const { rows } = await pool.query(
        `select 1 from bot.appointments
         where store_id = $1 and date = $2 and time = $3 and status = 'scheduled' and ($4::text is null or id <> $4)
         limit 1`,
        [storeId, date, time, exceptId ?? null],
    );
    return rows.length > 0;
}

export type NewAppointment = {
    storeId: string;
    sessionPhone: string;
    clientName: string;
    phone: string;
    date: string;
    time: string;
    city: string;
    address: string;
    appointmentType: string;
    reference: string;
    notes?: string;
    source: 'bot' | 'panel';
};

/** Crea la cita. Si el horario ya está ocupado (aunque otro cliente lo haya tomado un instante antes) devuelve `taken`. */
export async function createAppointment(data: NewAppointment): Promise<SlotResult> {
    if (!pool) return { ok: false, reason: 'error' };
    const id = `${data.storeId}_${data.sessionPhone}_${data.date}_${data.time.replace(':', '')}_${Date.now().toString(36)}`;
    try {
        await pool.query(
            `insert into bot.appointments (
                id, store_id, sender_phone, client_name, city, date, time, appointment_type,
                property_reference, address, phone, status, notes, source, created_at, updated_at
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'scheduled', $12, $13, now(), now())`,
            [
                id, data.storeId, data.sessionPhone, data.clientName, data.city, data.date, data.time,
                data.appointmentType, data.reference, data.address, data.phone, data.notes || '', data.source,
            ],
        );
        return { ok: true, id };
    } catch (e: any) {
        if (e.code === UNIQUE_VIOLATION) return { ok: false, reason: 'taken' };
        logger.error(`Error creando cita: ${e.message}`);
        return { ok: false, reason: 'error' };
    }
}

export async function getAppointment(id: string): Promise<Appointment | null> {
    if (!pool) return null;
    const { rows } = await pool.query('select * from bot.appointments where id = $1', [id]);
    return rows[0] ? toAppointment(rows[0]) : null;
}

/** Citas entre dos fechas (YYYY-MM-DD, inclusive), en orden. */
export async function listAppointments(from: string, to: string): Promise<Appointment[]> {
    if (!pool) return [];
    const { rows } = await pool.query(
        `select * from bot.appointments where date >= $1 and date <= $2 order by date, time, created_at limit 500`,
        [from, to],
    );
    return rows.map(toAppointment);
}

export type AppointmentChanges = { status?: AppointmentStatus; date?: string; time?: string; notes?: string };

/** Cambia estado, horario o notas. Mover a un horario ocupado devuelve `taken`. */
export async function updateAppointment(id: string, changes: AppointmentChanges): Promise<SlotResult> {
    if (!pool) return { ok: false, reason: 'error' };
    try {
        const { rowCount } = await pool.query(
            `update bot.appointments set
                status = coalesce($2, status),
                date   = coalesce($3, date),
                time   = coalesce($4, time),
                notes  = coalesce($5, notes),
                updated_at = now()
             where id = $1`,
            [id, changes.status ?? null, changes.date ?? null, changes.time ?? null, changes.notes ?? null],
        );
        return (rowCount ?? 0) > 0 ? { ok: true, id } : { ok: false, reason: 'not_found' };
    } catch (e: any) {
        if (e.code === UNIQUE_VIOLATION) return { ok: false, reason: 'taken' };
        logger.error(`Error actualizando cita: ${e.message}`);
        return { ok: false, reason: 'error' };
    }
}

// ── Avisos ──────────────────────────────────────────────────────────────────

export type Notification = {
    id: number;
    kind: NotificationKind;
    sessionId: string | null;
    phone: string;
    clientName: string;
    detail: string;
    appointmentId: string | null;
    /** La fecha de la cita del aviso, para que el panel abra esa semana. */
    appointmentDate: string | null;
    createdAt: string;
    readAt: string | null;
    readBy: string | null;
};

export type NewNotification = {
    kind: NotificationKind;
    storeId: string;
    sessionId?: string;
    phone?: string;
    clientName?: string;
    detail?: string;
    appointmentId?: string;
};

/** Registra un aviso. Nunca rompe el flujo del cliente: si falla, solo queda en el registro. */
export async function createNotification(data: NewNotification): Promise<boolean> {
    if (!pool) return false;
    try {
        await pool.query(
            `insert into bot.notifications (store_id, kind, session_id, phone, client_name, detail, appointment_id)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [data.storeId, data.kind, data.sessionId ?? null, data.phone ?? '', (data.clientName ?? '').slice(0, 120),
             (data.detail ?? '').slice(0, 500), data.appointmentId ?? null],
        );
        return true;
    } catch (e: any) {
        logger.error(`Error registrando aviso (${data.kind}): ${e.message}`);
        return false;
    }
}

function toNotification(row: any): Notification {
    return {
        id: Number(row.id),
        kind: row.kind,
        sessionId: row.session_id,
        phone: row.phone || '',
        clientName: row.client_name || '',
        detail: row.detail || '',
        appointmentId: row.appointment_id,
        appointmentDate: row.appointment_date ?? null,
        createdAt: new Date(row.created_at).toISOString(),
        readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
        readBy: row.read_by,
    };
}

/** Lo que consulta la campana cada pocos segundos: barato (solo cuenta y la fecha del último). */
export async function countUnreadNotifications(): Promise<{ unread: number; latest: string | null }> {
    if (!pool) return { unread: 0, latest: null };
    const { rows } = await pool.query(
        `select count(*)::int as unread, max(created_at) as latest from bot.notifications where read_at is null`,
    );
    return { unread: rows[0]?.unread ?? 0, latest: rows[0]?.latest ? new Date(rows[0].latest).toISOString() : null };
}

export async function listNotifications(limit = 30): Promise<Notification[]> {
    if (!pool) return [];
    const { rows } = await pool.query(
        `select n.*, a.date as appointment_date
         from bot.notifications n left join bot.appointments a on a.id = n.appointment_id
         order by (n.read_at is null) desc, n.created_at desc limit $1`,
        [Math.min(Math.max(limit, 1), 100)],
    );
    return rows.map(toNotification);
}

export async function markNotificationRead(id: number, by: string): Promise<boolean> {
    if (!pool) return false;
    const { rowCount } = await pool.query(
        `update bot.notifications set read_at = now(), read_by = $2 where id = $1 and read_at is null`,
        [id, by.slice(0, 80)],
    );
    return (rowCount ?? 0) > 0;
}

export async function markAllNotificationsRead(by: string): Promise<number> {
    if (!pool) return 0;
    const { rowCount } = await pool.query(
        `update bot.notifications set read_at = now(), read_by = $1 where read_at is null`,
        [by.slice(0, 80)],
    );
    return rowCount ?? 0;
}
