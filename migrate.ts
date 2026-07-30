import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config();

async function runMigration() {
    console.log('Iniciando migracion a Supabase...');
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    const db = drizzle(pool);

    console.log('Limpiando tablas antiguas para evitar conflictos...');
    try {
        await pool.query('DROP TABLE IF EXISTS products CASCADE;');
        await pool.query('DROP TABLE IF EXISTS sessions CASCADE;');
        await pool.query('DROP TABLE IF EXISTS stores CASCADE;');
        await pool.query('DROP TABLE IF EXISTS drizzle_migrations CASCADE;');
        
        console.log('Ejecutando script de migracion...');
        await migrate(db, { migrationsFolder: path.join(__dirname, 'drizzle') });
        console.log('Migracion exitosa! Las tablas fueron creadas.');
    } catch (error) {
        console.error('Error durante la migracion:', error);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

runMigration();
