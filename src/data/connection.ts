import fs from 'fs';
import path from 'path';

const dataDir = path.join(process.cwd(), 'data');
const storesFile = path.join(dataDir, 'local-stores.json');

type LocalStore = {
    id: string;
    name: string;
    isActive: boolean;
    systemPrompt: string;
    openaiApiKey?: string | null;
    pqrEmail?: string | null;
    adminCalendarEmail?: string | null;
    telegramToken?: string | null;
    telegramBotActive?: boolean;
    whatsappPhoneNumberId?: string | null;
    whatsappAccessToken?: string | null;
};

function ensureDataDir() {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function loadStores(): LocalStore[] {
    const defaultStore: LocalStore = {
        id: "default",
        name: "Mr. 18Kilates",
        isActive: true,
        systemPrompt: "Eres un asesor de joyería experto en ventas de Mr. 18Kilates.",
    };

    try {
        if (fs.existsSync(storesFile)) {
            const parsed = JSON.parse(fs.readFileSync(storesFile, 'utf8'));
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
            // Si el array existe pero está vacío, restaurar la tienda por defecto
            if (Array.isArray(parsed) && parsed.length === 0) {
                saveStores([defaultStore]);
                return [defaultStore];
            }
        }
    } catch {
        // Si el archivo local se corrompe, arrancamos con la tienda base.
    }

    saveStores([defaultStore]);
    return [defaultStore];
}

function saveStores(stores: LocalStore[]) {
    ensureDataDir();
    fs.writeFileSync(storesFile, JSON.stringify(stores, null, 2));
}

let localStores = loadStores();

/** Borra una tienda por id. Devuelve false si no existe. */
export function deleteLocalStore(id: string): boolean {
    const remaining = localStores.filter(store => store.id !== id);
    if (remaining.length === localStores.length) return false;
    localStores = remaining;
    saveStores(localStores);
    return true;
}

// Mock de base de datos para saltar Postgres y usar una tienda por defecto (Single-Tenant)
export const db = {
    query: {
        users: { 
            findFirst: async () => null, 
            findMany: async () => [] 
        },
        stores: { 
            findFirst: async () => localStores[0] || null,
            findMany: async () => localStores
        },
        products: {
            findFirst: async () => null,
            findMany: async () => []
        }
    },
    select: () => ({ from: async () => [] }),
    insert: () => ({
        values: (values: any) => ({
            returning: async () => {
                if (values?.systemPrompt !== undefined || values?.telegramToken !== undefined || values?.pqrEmail !== undefined) {
                    const store = { ...values, isActive: values.isActive ?? true };
                    localStores = [...localStores.filter(s => s.id !== store.id), store];
                    saveStores(localStores);
                    return [store];
                }
                return [{ id: '1', username: values?.username || 'admin', role: values?.role || 'superadmin' }];
            }
        })
    }),
    // El mock no puede leer la condición del where: borrar a ciegas eliminaba siempre la
    // primera tienda. Las tiendas se borran con deleteLocalStore(id).
    delete: () => ({
        where: async () => {
            throw new Error('Borrado no disponible en el almacenamiento local; usa deleteLocalStore(id).');
        }
    }),
    update: () => ({
        set: (values: any) => ({
            where: () => ({
                returning: async () => {
                    if (localStores.length === 0) localStores = [{ id: "default", name: "Mi Tienda", isActive: true, systemPrompt: "" }];
                    localStores[0] = { ...localStores[0], ...values };
                    saveStores(localStores);
                    return [localStores[0]];
                }
            })
        })
    })
} as any;
