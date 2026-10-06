/**
 * Comprueba la conexión del bot a la base de la tienda sin tocar datos reales:
 * crea una sesión de prueba, la lee, la borra y verifica que el rol NO puede leer
 * tablas de la tienda.
 *
 *   npx tsx scripts/probar-base.ts
 */
import { pool, initializeDatabase } from '../src/data/pool';
import { deleteSession, getMemory, getSession, saveMemory, setSessionPause } from '../src/data/database';

async function main(): Promise<void> {
    if (!pool || !(await initializeDatabase())) {
        process.exitCode = 1;
        return;
    }

    const sessionId = `prueba_${Date.now()}`;
    const messages = [{ role: 'system', content: 'prueba' }, { role: 'user', content: 'Hola' }];

    await saveMemory(sessionId, 'prueba', '0000', messages);
    await setSessionPause(sessionId, true);
    const leido = await getMemory(sessionId);
    const sesion = await getSession(sessionId);
    await deleteSession(sessionId);
    const borrado = (await getMemory(sessionId)).length === 0;

    // Las instrucciones de la IA (role system) no se guardan: queda solo el mensaje del cliente.
    const ok = leido.length === 1 && leido[0].content === 'Hola' && sesion.isPaused === true && borrado;
    console.log(`Sesiones (guardar, pausar, leer, borrar): ${ok ? 'OK' : 'FALLÓ'}`);

    let aislado = false;
    try {
        await pool.query('select 1 from public.clientes limit 1');
    } catch (error: any) {
        aislado = /permission denied/i.test(error.message);
    }
    console.log(`Sin acceso a las tablas de la tienda: ${aislado ? 'OK' : 'FALLÓ'}`);

    if (!ok || !aislado) process.exitCode = 1;
    await pool.end();
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
