import { isHoliday, isWeekend, nextBusinessDay } from '../utils/holidays';
import { APPOINTMENT_HOURS, appointmentInstant, isValidAppointmentTime, parseAppointmentDate, todayInBogota } from './policies';

// ─────────────────────────────────────────────────────────────────────────────
//  Reglas de un horario de cita: las mismas para el bot y para el panel de la tienda.
//  Lunes a viernes sin festivos, horas en punto en las franjas de atención, nunca en el pasado.
//  El bot agenda desde mañana; el mostrador puede anotar también para hoy (alguien que llamó).
// ─────────────────────────────────────────────────────────────────────────────

export type SlotProblem = { code: 'fecha' | 'pasado' | 'no_habil' | 'hora'; message: string };

function formatDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** null si el horario sirve; si no, qué tiene de malo (en palabras para el mostrador o para la IA). */
export function checkSlot(date: string, time: string, opts: { earliest: 'today' | 'tomorrow' }, now = new Date()): SlotProblem | null {
    const day = parseAppointmentDate(date);
    if (!day) return { code: 'fecha', message: 'La fecha no es válida.' };

    const today = todayInBogota(now);
    if (date < today || (opts.earliest === 'tomorrow' && date === today)) {
        return { code: 'pasado', message: opts.earliest === 'tomorrow' ? 'La cita debe ser desde mañana.' : 'Esa fecha ya pasó.' };
    }
    if (isWeekend(day) || isHoliday(day)) {
        return {
            code: 'no_habil',
            message: `Ese día no se atiende (${isWeekend(day) ? 'fin de semana' : 'festivo'}). El siguiente día hábil es ${formatDate(nextBusinessDay(day))}.`,
        };
    }
    if (!isValidAppointmentTime(time)) return { code: 'hora', message: `La hora debe ser en punto, ${APPOINTMENT_HOURS}.` };
    if (appointmentInstant(date, time).getTime() <= now.getTime()) return { code: 'pasado', message: 'Esa hora ya pasó.' };
    return null;
}

/** La hora con dos dígitos ("9:00" → "09:00"), como se guarda. */
export function normalizeTime(time: string): string {
    const match = /^(\d{1,2}):(\d{2})$/.exec((time || '').trim());
    return match ? `${match[1].padStart(2, '0')}:${match[2]}` : (time || '').trim();
}
