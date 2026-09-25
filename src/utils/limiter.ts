/**
 * Limitador de concurrencia simple (semáforo en memoria).
 * Ejecuta como máximo `max` tareas a la vez; el resto espera en orden de llegada.
 */
export function createLimiter(max: number) {
    let active = 0;
    const waiting: Array<() => void> = [];

    const release = () => {
        active--;
        const next = waiting.shift();
        if (next) next();
    };

    return async function run<T>(task: () => Promise<T>): Promise<T> {
        if (active >= max) {
            await new Promise<void>(resolve => waiting.push(resolve));
        }
        active++;
        try {
            return await task();
        } finally {
            release();
        }
    };
}
