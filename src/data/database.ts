import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
//  Sesiones de chat y citas sobre Supabase (Postgres)
//  Tablas: sessions, appointments

// ─────────────────────────────────────────────────────────────────────────────

export const getSession = async (sessionId: string) => {
    if (!supabase) return { isPaused: false };
    try {
        const { data, error } = await supabase
            .from('sessions')
            .select('*')
            .eq('session_id', sessionId)
            .maybeSingle();

        if (error) throw error;
        if (data) {
            // Misma forma que devolvía Firestore (doc.data())
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
    } catch (e) {}
    return { isPaused: false };
};

export const setSessionPause = async (sessionId: string, isPaused: boolean) => {
    if (!supabase) return true;
    try {
        const { error } = await supabase
            .from('sessions')
            .upsert({ session_id: sessionId, is_paused: isPaused }, { onConflict: 'session_id' });

        if (error) throw error;
        return true;
    } catch (e) {
        return false;
    }
};

export const checkRateLimit = async (sessionId: string, maxMessages: number) => {
    return { allowed: true };
};

export const incrementMessageCount = async (sessionId: string) => {
    return true;
};

export const getAllSessions = async (storeId?: string) => {
    if (!supabase) return [];
    try {
        const { data, error } = await supabase
            .from('sessions')
            .select('*')
            .order('updated_at', { ascending: false });

        if (error) throw error;

        return (data || []).map(row => ({
            id: row.session_id,
            sessionId: row.session_id,
            storeId: row.store_id || 'default',
            phone: row.sender_phone || row.session_id.split('_')[1] || row.session_id,
            isPaused: row.is_paused || false,
            history: row.messages || [],
            updatedAt: row.updated_at ? new Date(row.updated_at) : new Date()
        }));
    } catch (e) {
        logger.error(`Error getting all sessions: ${e}`);
        return [];
    }
};

export const deleteSession = async (sessionId: string) => {
    if (!supabase) return true;
    try {
        const { error } = await supabase
            .from('sessions')
            .delete()
            .eq('session_id', sessionId);

        if (error) throw error;
        return true;
    } catch (e) {
        return false;
    }
};

export const getSessionLastActivity = async (sessionId: string): Promise<Date | null> => {
    if (!supabase) return null;
    try {
        const { data, error } = await supabase
            .from('sessions')
            .select('updated_at')
            .eq('session_id', sessionId)
            .maybeSingle();

        if (error) throw error;
        if (data?.updated_at) {
            return new Date(data.updated_at);
        }
    } catch (e) {
        logger.error(`Error getting session last activity: ${e}`);
    }
    return null;
};

export const clearSession = async (sessionId: string, storeId: string, senderPhone: string, systemPrompt: string) => {
    if (!supabase) return true;
    try {
        const freshMessages = [{ role: 'system', content: systemPrompt }];
        const { error } = await supabase
            .from('sessions')
            .upsert({
                session_id: sessionId,
                store_id: storeId,
                sender_phone: senderPhone,
                messages: freshMessages,
                has_appointment: false,
                updated_at: new Date().toISOString()
            }, { onConflict: 'session_id' });

        if (error) throw error;
        return true;
    } catch (e) {
        logger.error(`Error clearing session: ${e}`);
        return false;
    }
};

export const setSessionAppointmentFlag = async (sessionId: string, hasAppointment: boolean) => {
    if (!supabase) return true;
    try {
        const { error } = await supabase
            .from('sessions')
            .upsert({ session_id: sessionId, has_appointment: hasAppointment }, { onConflict: 'session_id' });

        if (error) throw error;
        return true;
    } catch (e) {
        logger.error(`Error setting session appointment flag: ${e}`);
        return false;
    }
};

export const getMemory = async (sessionId: string): Promise<any[]> => {
    if (!supabase) return [];
    try {
        const { data, error } = await supabase
            .from('sessions')
            .select('messages')
            .eq('session_id', sessionId)
            .maybeSingle();

        if (error) throw error;
        if (data) return data.messages || [];
    } catch (e) {}
    return [];
};

export const saveMemory = async (sessionId: string, storeId: string, senderPhone: string, messages: any[]) => {
    if (!supabase) return true;
    try {
        // Sanitizar array: solo JSON puro
        const cleanMessages = JSON.parse(JSON.stringify(messages));
        const { error } = await supabase
            .from('sessions')
            .upsert({
                session_id: sessionId,
                store_id: storeId,
                sender_phone: senderPhone,
                messages: cleanMessages,
                updated_at: new Date().toISOString()
            }, { onConflict: 'session_id' });

        if (error) throw error;
        return true;
    } catch (e) {
        logger.error(`Error saving memory: ${e}`);
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
    if (!supabase) return false;
    try {
        const appointmentId = `${storeId}_${senderPhone}_${data.date}_${data.time.replace(':', '')}`;
        const { error } = await supabase
            .from('appointments')
            .upsert({
                id: appointmentId,
                store_id: storeId,
                sender_phone: senderPhone,
                client_name: data.clientName || '',
                city: data.city || '',
                date: data.date || '',
                time: data.time || '',
                appointment_type: data.appointmentType || '',
                property_reference: data.propertyReference || '',
                address: data.address || '',
                phone: data.phone || '',
                calendar_event_id: data.calendarEventId || null,
                status: data.status || 'scheduled',
                created_at: data.createdAt instanceof Date ? data.createdAt.toISOString() : new Date().toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'id' });

        if (error) throw error;
        return true;
    } catch (e) {
        logger.error(`Error saving appointment: ${e}`);
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
    if (!supabase) return null;
    try {
        const { data, error } = await supabase
            .from('appointments')
            .select('*')
            .eq('store_id', storeId)
            .eq('sender_phone', senderPhone)
            .eq('status', 'scheduled');

        if (error) throw error;
        if (!data || data.length === 0) return null;

        const now = new Date();
        for (const row of data) {
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
    } catch (e) {
        logger.error(`Error checking pending appointment: ${e}`);
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
    if (!supabase) return false;
    try {
        const { error } = await supabase
            .from('appointments')
            .update({
                date,
                time,
                ...(calendarEventId !== undefined ? { calendar_event_id: calendarEventId } : {}),
                status: 'scheduled',
                updated_at: new Date().toISOString(),
            })
            .eq('id', appointmentId)
            .eq('store_id', storeId)
            .eq('sender_phone', senderPhone);
        if (error) throw error;
        return true;
    } catch (e) {
        logger.error(`Error updating appointment: ${e}`);
        return false;
    }
};
