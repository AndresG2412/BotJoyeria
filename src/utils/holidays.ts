// ─────────────────────────────────────────
//  Festivos y días hábiles (Colombia)
// ─────────────────────────────────────────

// Fecha de Pascua (Algoritmo de Gauss)
function computus(year: number): Date {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
}

// Ley Emiliani (Ley 51 de 1983): trasladar la fecha al siguiente lunes si no lo es
function emiliani(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay(); // 0 = Domingo, 1 = Lunes
    if (day === 0) d.setDate(d.getDate() + 1);
    else if (day !== 1) d.setDate(d.getDate() + (8 - day));
    return d;
}

function toLocal(year: number, month: number, day: number): Date {
    return new Date(year, month - 1, day);
}

function daysAfter(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

// Festivos colombianos para un año dado
export function getColombianHolidays(year: number): Date[] {
    const easter = computus(year);
    return [
        // Fijos (no se trasladan)
        toLocal(year, 1, 1),    // Año Nuevo
        toLocal(year, 5, 1),    // Día del Trabajo
        toLocal(year, 7, 20),   // Día de la Independencia
        toLocal(year, 8, 7),    // Batalla de Boyacá
        toLocal(year, 12, 8),   // Inmaculada Concepción
        toLocal(year, 12, 25),  // Navidad
        // Movibles por Ley Emiliani
        emiliani(toLocal(year, 1, 6)),    // Reyes Magos
        emiliani(toLocal(year, 3, 19)),   // San José
        emiliani(toLocal(year, 6, 29)),   // San Pedro y San Pablo
        emiliani(toLocal(year, 8, 15)),   // Asunción de la Virgen
        emiliani(toLocal(year, 10, 12)),  // Día de la Raza
        emiliani(toLocal(year, 11, 1)),   // Todos los Santos
        emiliani(toLocal(year, 11, 11)),  // Independencia de Cartagena
        // Basados en Pascua
        emiliani(daysAfter(easter, 39)),  // Ascensión del Señor
        emiliani(daysAfter(easter, 60)),  // Corpus Christi
        emiliani(daysAfter(easter, 68)),  // Sagrado Corazón de Jesús
        daysAfter(easter, -3),            // Jueves Santo
        daysAfter(easter, -2),            // Viernes Santo
    ];
}

// ¿La fecha es un festivo colombiano?
export function isHoliday(date: Date): boolean {
    const year = date.getFullYear();
    return getColombianHolidays(year).some(h =>
        h.getFullYear() === year &&
        h.getMonth() === date.getMonth() &&
        h.getDate() === date.getDate()
    );
}

// ¿La fecha cae en fin de semana?
export function isWeekend(date: Date): boolean {
    const day = date.getDay();
    return day === 0 || day === 6;
}

// ¿La fecha es un día hábil? (lunes a viernes sin festivos)
export function isBusinessDay(date: Date): boolean {
    return !isWeekend(date) && !isHoliday(date);
}

// Siguiente día hábil estrictamente posterior a `from`
export function nextBusinessDay(from: Date): Date {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    do {
        d.setDate(d.getDate() + 1);
    } while (!isBusinessDay(d));
    return d;
}
