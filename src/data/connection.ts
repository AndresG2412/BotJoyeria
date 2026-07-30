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
    try {
        if (fs.existsSync(storesFile)) {
            const parsed = JSON.parse(fs.readFileSync(storesFile, 'utf8'));
            if (Array.isArray(parsed)) return parsed;
        }
    } catch {
        // Si el archivo local se corrompe, arrancamos con la tienda base.
    }

    return [{ id: "default", name: "Mi Tienda", isActive: true, systemPrompt: "" }];
}

function saveStores(stores: LocalStore[]) {
    ensureDataDir();
    fs.writeFileSync(storesFile, JSON.stringify(stores, null, 2));
}

let localStores = loadStores();

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
    delete: () => ({
        where: async () => {
            localStores = localStores.length > 1 ? localStores.slice(1) : [];
            saveStores(localStores);
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
