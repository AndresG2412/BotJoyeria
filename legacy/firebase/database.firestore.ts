import { firebaseAdmin } from '../config/firebase';
import { logger } from '../utils/logger';
import { FieldValue } from 'firebase-admin/firestore';

export const getSession = async (sessionId: string) => {
    if (!firebaseAdmin) return { isPaused: false };
    try {
        const doc = await firebaseAdmin.firestore().collection('sessions').doc(sessionId).get();
        if (doc.exists) return doc.data();
    } catch (e) {}
    return { isPaused: false };
};

export const setSessionPause = async (sessionId: string, isPaused: boolean) => {
    if (!firebaseAdmin) return true;
    try {
        await firebaseAdmin.firestore().collection('sessions').doc(sessionId).set({ isPaused }, { merge: true });
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
    if (!firebaseAdmin) return [];
    try {
        let query: FirebaseFirestore.Query = firebaseAdmin.firestore().collection('sessions');
        // if (storeId) query = query.where('storeId', '==', storeId);
        const snapshot = await query.get();
        return snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                sessionId: doc.id,
                storeId: data.storeId || 'default',
                phone: data.senderPhone || doc.id.split('_')[1] || doc.id,
                isPaused: data.isPaused || false,
                history: data.messages || [],
                updatedAt: data.updatedAt ? data.updatedAt.toDate() : new Date()
            };
        }).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    } catch (e) {
        logger.error(`Error getting all sessions: ${e}`);
        return [];
    }
};

export const deleteSession = async (sessionId: string) => {
    if (!firebaseAdmin) return true;
    try {
        await firebaseAdmin.firestore().collection('sessions').doc(sessionId).delete();
        return true;
    } catch (e) {
        return false;
    }
};

export const getSessionLastActivity = async (sessionId: string): Promise<Date | null> => {
    if (!firebaseAdmin) return null;
    try {
        const doc = await firebaseAdmin.firestore().collection('sessions').doc(sessionId).get();
        if (doc.exists) {
            const data = doc.data();
            if (data?.updatedAt) {
                return data.updatedAt.toDate();
            }
        }
    } catch (e) {
        logger.error(`Error getting session last activity: ${e}`);
    }
    return null;
};

export const clearSession = async (sessionId: string, storeId: string, senderPhone: string, systemPrompt: string) => {
    if (!firebaseAdmin) return true;
    try {
        const freshMessages = [{ role: 'system', content: systemPrompt }];
        await firebaseAdmin.firestore().collection('sessions').doc(sessionId).set({
            sessionId,
            storeId,
            senderPhone,
            messages: freshMessages,
            hasAppointment: false,
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return true;
    } catch (e) {
        logger.error(`Error clearing session: ${e}`);
        return false;
    }
};

export const setSessionAppointmentFlag = async (sessionId: string, hasAppointment: boolean) => {
    if (!firebaseAdmin) return true;
    try {
        await firebaseAdmin.firestore().collection('sessions').doc(sessionId).set({
            hasAppointment
        }, { merge: true });
        return true;
    } catch (e) {
        logger.error(`Error setting session appointment flag: ${e}`);
        return false;
    }
};

export const getMemory = async (sessionId: string): Promise<any[]> => {
    if (!firebaseAdmin) return [];
    try {
        const doc = await firebaseAdmin.firestore().collection('sessions').doc(sessionId).get();
        if (doc.exists) return doc.data()?.messages || [];
    } catch (e) {}
    return [];
};

export const saveMemory = async (sessionId: string, storeId: string, senderPhone: string, messages: any[]) => {
    if (!firebaseAdmin) return true;
    try {
        // Sanitizar array para Firebase
        const cleanMessages = JSON.parse(JSON.stringify(messages));
        await firebaseAdmin.firestore().collection('sessions').doc(sessionId).set({
            sessionId,
            storeId,
            senderPhone,
            messages: cleanMessages,
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
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
    status: 'scheduled' | 'cancelled' | 'completed';
    createdAt: Date | any;
}

export const saveAppointment = async (storeId: string, senderPhone: string, data: AppointmentData) => {
    if (!firebaseAdmin) return false;
    try {
        const appointmentId = `${storeId}_${senderPhone}_${data.date}_${data.time.replace(':', '')}`;
        await firebaseAdmin.firestore().collection('appointments').doc(appointmentId).set({
            storeId,
            senderPhone,
            ...data,
            updatedAt: FieldValue.serverTimestamp()
        });
        return true;
    } catch (e) {
        logger.error(`Error saving appointment: ${e}`);
        return false;
    }
};

export const checkPendingAppointment = async (storeId: string, senderPhone: string): Promise<boolean> => {
    if (!firebaseAdmin) return false;
    try {
        const snapshot = await firebaseAdmin.firestore()
            .collection('appointments')
            .where('storeId', '==', storeId)
            .where('senderPhone', '==', senderPhone)
            .where('status', '==', 'scheduled')
            .get();

        if (snapshot.empty) return false;

        const now = new Date();
        for (const doc of snapshot.docs) {
            const data = doc.data();
            if (data.date && data.time) {
                const [year, month, day] = data.date.split('-').map(Number);
                const [hour, minute] = data.time.split(':').map(Number);
                const appointmentDateTime = new Date(year, month - 1, day, hour, minute);
                if (appointmentDateTime > now) {
                    return true;
                }
            }
        }
    } catch (e) {
        logger.error(`Error checking pending appointment: ${e}`);
    }
    return false;
};

