// Mock de esquemas para evitar errores de TypeScript
export const users = {
    id: "id",
    username: "username",
    role: "role",
    storeId: "storeId",
    createdAt: "createdAt"
} as any;

export const stores = {
    id: "id",
    name: "name",
    systemPrompt: "systemPrompt",
    isActive: "isActive",
    openaiApiKey: "openaiApiKey",
    pqrEmail: "pqrEmail",
    adminCalendarEmail: "adminCalendarEmail",
    telegramToken: "telegramToken",
    telegramBotActive: "telegramBotActive",
    whatsappPhoneNumberId: "whatsappPhoneNumberId",
    whatsappAccessToken: "whatsappAccessToken"
} as any;

export const products = {
    id: "id",
    storeId: "storeId",
    name: "name",
    description: "description",
    productType: "productType",
    price: "price",
    imageUrl: "imageUrl",
    checkoutUrl: "checkoutUrl"
} as any;

export const sessions = {
    id: "id",
    storeId: "storeId",
    phone: "phone",
    lastMessageAt: "lastMessageAt",
    isPaused: "isPaused"
} as any;

