import * as admin from 'firebase-admin';
import path from 'path';
import { logger } from '../utils/logger';

// Construye la ruta absoluta al archivo JSON
// Asumimos que lo guardarás en la raíz del proyecto como "firebase-key.json"
const serviceAccountPath = path.resolve(__dirname, '../../firebase-key.json');

export const initializeFirebase = () => {
    try {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccountPath),
            // Si usas Realtime Database, descomenta y pon tu URL abajo:
            // databaseURL: "https://<TU_PROYECTO>.firebaseio.com"
        });
        logger.info('✅ Firebase conectado exitosamente a la base de datos!');
        return admin;
    } catch (error) {
        logger.error('❌ Error conectando a Firebase. ¿Olvidaste el archivo firebase-key.json?', error);
        return null;
    }
};

// Exportamos la instancia para usarla luego en tus herramientas
export const firebaseAdmin = admin;
