import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../config/env';
import { AssistantReply, fromClaudeMessage, fromOpenAIMessage, toClaudeMessages, toClaudeToolChoice, toClaudeTools } from './claude';
import { logger } from '../utils/logger';
import { botTools, executeTool, getPendingImages, PendingImage } from './tools';
import { getMemory, saveMemory, getSessionLastActivity, clearSession, getSession, checkPendingAppointment, setSessionAppointmentFlag } from '../data/database';
import { getAllProducts, getAllCategorias } from '../data/catalog';
import { SECURITY_PROMPT } from './prompts';
import { db } from '../data/connection';
import { stores } from '../data/schema';
import { eq } from 'drizzle-orm';
import { createLimiter } from '../utils/limiter';
import { MULTIPLE_IMAGE_RESPONSE, MULTIPLE_PRODUCT_RESPONSE, isMultipleImageRequest, isMultipleProductRequest } from './policies';

const MAX_HISTORY_LENGTH  = 15;
const INACTIVITY_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 horas
const MAX_TOOL_ROUNDS = 5;           // Evita bucles infinitos de tool calls
const MODEL_TIMEOUT_MS = config.AI_TIMEOUT_MS;  // Si un modelo no responde, se reintenta una vez y luego se pasa al siguiente

// Conversaciones procesándose con la IA al mismo tiempo (todas las tiendas y canales).
const aiLimiter = createLimiter(config.BOT_MAX_CONCURRENT_CONVERSATIONS);

// ─────────────────────────────────────────
//  Cascada de modelos
// ─────────────────────────────────────────
// Proveedor principal (AI_*) y, opcional, uno de respaldo (AI_FALLBACK_*): si los modelos
// del principal fallan o no responden, se usan los del respaldo. Ver src/config/env.ts.
// `effort`: el modelo acepta output_config.effort y apagar el pensamiento extendido
// (Claude Haiku 5.5). Haiku 4.5 y otros proveedores responden 400 o lo ignoran.
export type ProviderConfig = { name: string; format: 'anthropic' | 'openai'; baseURL: string; apiKeys: string[] };
export type ModelEntry = { id: string; effort: boolean; provider?: ProviderConfig };

const EFFORT_MODELS = new Set(['claude-haiku-5-5']);

const PRIMARY_PROVIDER: ProviderConfig = {
    name: 'principal',
    format: config.AI_PROVIDER,
    baseURL: config.AI_BASE_URL,
    apiKeys: [config.AI_API_KEY, config.AI_API_KEY_2].filter(Boolean),
};
const FALLBACK_PROVIDER: ProviderConfig = {
    name: 'respaldo',
    format: config.AI_FALLBACK_PROVIDER,
    baseURL: config.AI_FALLBACK_BASE_URL,
    apiKeys: [config.AI_FALLBACK_API_KEY, config.AI_FALLBACK_API_KEY_2].filter(Boolean),
};

// Todos con herramientas: sin acceso al catálogo un modelo inventaba piezas y precios.
const MODEL_CASCADE: ModelEntry[] = [
    ...config.AI_MODELS.map(id => ({ id, effort: EFFORT_MODELS.has(id), provider: PRIMARY_PROVIDER })),
    ...(FALLBACK_PROVIDER.apiKeys.length > 0
        ? config.AI_FALLBACK_MODELS.map(id => ({ id, effort: EFFORT_MODELS.has(id), provider: FALLBACK_PROVIDER }))
        : []),
];

// Tope de salida por respuesta. Las respuestas cortas las pide el prompt; esto solo
// evita que una respuesta desbocada gaste de más (el texto no debería acercarse).
const MAX_OUTPUT_TOKENS = 1024;

/** Lo que ve el cliente si la IA no devuelve texto: nunca un error técnico. */
const EMPTY_REPLY_FALLBACK = 'Perdona, no alcancé a procesar tu mensaje. ¿Me lo repites, por favor?';

// Un modelo que responde 503/429 o se queda sin contestar suele seguir así un rato:
// se le da un descanso para no hacer esperar a cada cliente hasta que vuelva a fallar.
const MODEL_COOLDOWN_MS = 3 * 60 * 1000;
const modelCooldownUntil = new Map<string, number>();

/** Modelos de la cascada en orden, saltando los que están descansando (si todos lo están, se prueban igual). */
export function availableModels(cascade: ModelEntry[], now = Date.now()): ModelEntry[] {
    const ready = cascade.filter(entry => (modelCooldownUntil.get(entry.id) ?? 0) <= now);
    return ready.length > 0 ? ready : cascade;
}

export function coolDownModel(modelId: string, now = Date.now()): void {
    modelCooldownUntil.set(modelId, now + MODEL_COOLDOWN_MS);
}

type ChatParams = {
    messages: OpenAI.Chat.ChatCompletionMessageParam[];
    tools: OpenAI.Chat.Completions.ChatCompletionTool[];
    tool_choice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
};

/** Una llamada con el formato de Anthropic (Claude, o DeepSeek en /anthropic). */
async function callAnthropicFormat(entry: ModelEntry, provider: ProviderConfig, apiKey: string, params: ChatParams): Promise<AssistantReply> {
    const { system, messages } = toClaudeMessages(params.messages);
    // Sin reintentos internos del SDK: la cascada ya prueba otra key/modelo
    // y el cliente no debe esperar minutos por un modelo saturado.
    const client = new Anthropic({ apiKey, baseURL: provider.baseURL || undefined, maxRetries: 0, timeout: MODEL_TIMEOUT_MS });
    const result = await client.messages.create({
        model: entry.id,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages,
        ...(params.tools.length > 0
            ? { tools: toClaudeTools(params.tools), tool_choice: toClaudeToolChoice(params.tool_choice) }
            : {}),
        // Chat de WhatsApp: respuestas rápidas y baratas. Sin pensamiento extendido
        // tampoco hay bloques de pensamiento que conservar al recortar el historial.
        ...(entry.effort
            ? { thinking: { type: 'disabled' as const }, output_config: { effort: 'low' as const } }
            : {}),
    });
    if (result.stop_reason === 'refusal') {
        logger.warn(`Cascada: ${entry.id} declinó responder (${result.stop_details?.category ?? 'sin categoría'}).`);
    }
    return fromClaudeMessage(result);
}

/** Una llamada con el formato de OpenAI (DeepSeek, Gemini y plataformas compatibles). */
async function callOpenAIFormat(entry: ModelEntry, provider: ProviderConfig, apiKey: string, params: ChatParams): Promise<AssistantReply> {
    const client = new OpenAI({ apiKey, baseURL: provider.baseURL || undefined, maxRetries: 0, timeout: MODEL_TIMEOUT_MS });
    const result = await client.chat.completions.create({
        model: entry.id,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: params.messages,
        ...(params.tools.length > 0 ? { tools: params.tools, tool_choice: params.tool_choice ?? 'auto' } : {}),
    });
    const message = result.choices[0]?.message;
    return fromOpenAIMessage(message);
}

async function createWithCascade(cascade: ModelEntry[], params: ChatParams): Promise<AssistantReply> {
    const isConnectionError = (err: unknown) =>
        err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError;

    const models = availableModels(cascade);
    let lastError: any = new Error('No hay AI_API_KEY o AI_MODELS configurados.');
    for (const [index, entry] of models.entries()) {
        const provider = entry.provider ?? PRIMARY_PROVIDER;
        const call = provider.format === 'openai' ? callOpenAIFormat : callAnthropicFormat;
        const isLastModel = index === models.length - 1;
        let modelFailed = false;
        for (const apiKey of provider.apiKeys) {
            try {
                let reply: AssistantReply;
                try {
                    reply = await call(entry, provider, apiKey, params);
                } catch (firstErr) {
                    // Sin más modelos de respaldo, una demora puntual se reintenta una vez
                    // en lugar de llegarle al cliente como error.
                    if (!isConnectionError(firstErr) || !isLastModel) throw firstErr;
                    logger.warn(`Cascada: ${entry.id} no respondió a tiempo, reintentando una vez...`);
                    reply = await call(entry, provider, apiKey, params);
                }
                if (entry.id !== cascade[0].id) {
                    logger.warn(`Cascada: ${cascade[0].id} falló, usando ${entry.id} (${provider.name})`);
                }
                return reply;
            } catch (err: any) {
                lastError = err;
                const status = err.status ?? err.statusCode;
                const isTimeout = isConnectionError(err);
                if (status === 401 || status === 402 || status === 403) {
                    // Key inválida, sin saldo o sin permiso: se prueba la otra key, si hay.
                    logger.warn(`Cascada: key ...${apiKey.slice(-4)} (${provider.name}) rechazada (HTTP ${status}).`);
                    modelFailed = true;
                    continue;
                }
                if (isTimeout || [404, 429, 500, 502, 503, 504, 529].includes(status)) {
                    logger.warn(`Cascada: ${entry.id} [key ...${apiKey.slice(-4)}] → ${isTimeout ? 'timeout' : `HTTP ${status}`}, probando siguiente...`);
                    modelFailed = true;
                    // 429 es la cuota de esa key: se prueba la otra.
                    if (status === 429) continue;
                    // Saturado, caído o sin respuesta: es el modelo, no la key. Siguiente modelo.
                    break;
                }
                // 400: la petición está mal (p. ej. historial dañado); otro modelo no lo arregla.
                throw err;
            }
        }
        if (modelFailed) coolDownModel(entry.id);
    }
    throw lastError;
}

/** Prueba rápida de cada modelo configurado (panel): "✅ OK" o el error, sin la key. */
export async function testConfiguredModels(): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    for (const entry of MODEL_CASCADE) {
        const label = `${entry.id} (${entry.provider?.name ?? 'principal'})`;
        try {
            const reply = await createWithCascade([entry], {
                messages: [{ role: 'user', content: 'Responde solo: OK' }],
                tools: [],
            });
            results[label] = `✅ ${reply.content ?? ''}`;
        } catch (err: any) {
            results[label] = `❌ ${err.status ?? ''} ${String(err.message ?? '').substring(0, 80)}`;
        }
    }
    return results;
}

// ─────────────────────────────────────────
//  Saludos
// ─────────────────────────────────────────
function isGreeting(userText: string): boolean {
    const text = userText.trim().toLowerCase().replace(/[¡!¿?.,]/g, '');
    const greetingWords = new Set([
        'hola', 'holaa', 'holaaa', 'buenas', 'buen dia', 'buen día',
        'buenos dias', 'buenos días', 'buenas tardes', 'buenas noches',
        'que tal', 'qué tal', 'como estas', 'cómo estás',
        'como vas', 'cómo vas', 'como va', 'cómo va',
        'alo', 'aló', 'hi', 'hello',
    ]);
    if (greetingWords.has(text)) return true;
    const words = text.split(/\s+/);
    return words.length <= 3 && words.some(w => greetingWords.has(w));
}

// ─────────────────────────────────────────
//  Contexto del catálogo
// ─────────────────────────────────────────
async function buildCatalogContext(storeId: string): Promise<string> {
    try {
        const products = await getAllProducts(storeId);
        if (products.length === 0) return '';
        const lines = products.map(p => {
            const price = p.price != null ? `$${p.price}` : 'consultar precio';
            return `- [ID: ${p.id}] ${p.name} — ${price}`;
        }).join('\n');
        return `\n\nPIEZAS DISPONIBLES EN CATÁLOGO:\n${lines}\n\nCuando el cliente pida VER la pieza usa send_product_image con el ID. Para detalles (peso, material, stock, características) usa get_product_details. Nunca repitas detalles en el texto salvo que el cliente los pida.`;
    } catch {
        return '';
    }
}

async function buildCategoriasContext(): Promise<string> {
    try {
        const categorias = await getAllCategorias();
        if (categorias.length === 0) return '';
        const lines = categorias.map(c => `- ID: "${c.id}" → Nombre: "${c.nombre}"`).join('\n');
        return `\n\nCATEGORÍAS DISPONIBLES EN LA BASE DE DATOS:\n${lines}`;
    } catch {
        return '';
    }
}

// ─────────────────────────────────────────
//  Sesión / historial
// ─────────────────────────────────────────
async function getOrCreateSession(
    sessionId: string,
    systemPrompt: string
): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
    // El historial se guarda sin las instrucciones: se ponen frescas en cada mensaje.
    const mem = await getMemory(sessionId);
    return [{ role: 'system', content: systemPrompt }, ...mem];
}

/** `mediaId`: el identificador de la foto en WhatsApp. Se guarda SOLO eso (nunca la imagen) para que el
 *  admin de la tienda pueda verla mientras WhatsApp la conserve (src/routes/admin-api.ts). */
export type CustomerPhoto = { mimetype: string; data: string; mediaId?: string };

/** Campo del mensaje del cliente con el identificador de su foto en WhatsApp. La IA nunca lo recibe. */
export const PHOTO_MEDIA_ID_FIELD = 'photoMediaId';

/** Texto que queda en el historial en lugar de la foto del cliente (la imagen no se guarda). */
export function photoPlaceholder(caption: string): string {
    const text = caption.trim();
    return text ? `[El cliente envió una foto] ${text}` : '[El cliente envió una foto]';
}

/**
 * Mensajes tal como los ve el modelo: todo en texto (historiales viejos podían traer partes
 * de imagen) salvo el mensaje del cliente de este turno, que lleva la foto si la envió.
 */
export function messagesForModel(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    photoMessage: OpenAI.Chat.ChatCompletionMessageParam,
    photo?: CustomerPhoto,
): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map(original => {
        // El identificador de la foto es para el admin de la tienda: la IA no lo recibe.
        const msg = PHOTO_MEDIA_ID_FIELD in (original as any) ? withoutPhotoMediaId(original) : original;
        if (photo && original === photoMessage) {
            return {
                role: 'user',
                content: [
                    { type: 'text', text: String(msg.content) },
                    { type: 'image_url', image_url: { url: `data:${photo.mimetype};base64,${photo.data}` } },
                ],
            };
        }
        if (Array.isArray(msg.content)) {
            const text = (msg.content as any[])
                .filter(part => part?.type === 'text')
                .map(part => part.text)
                .join(' ') || '[imagen]';
            return { ...msg, content: text } as OpenAI.Chat.ChatCompletionMessageParam;
        }
        return msg;
    });
}

function withoutPhotoMediaId(msg: OpenAI.Chat.ChatCompletionMessageParam): OpenAI.Chat.ChatCompletionMessageParam {
    const { [PHOTO_MEDIA_ID_FIELD]: _mediaId, ...rest } = msg as any;
    return rest;
}

/**
 * Recorta el historial a las instrucciones + los últimos mensajes SIN partir un turno:
 * si el corte deja al principio un resultado de herramienta (o la llamada que lo pidió),
 * la IA rechaza la conversación con HTTP 400 y el bot terminaba borrando el historial.
 * El primer mensaje después de las instrucciones siempre es del cliente.
 */
export function trimHistory<T extends { role?: string }>(history: T[], max: number): T[] {
    const [first, ...rest] = history;
    const hasSystem = first?.role === 'system';
    const body = hasSystem ? rest : history;
    let tail = body.length > max - 1 ? body.slice(body.length - (max - 1)) : body;
    while (tail.length > 0 && tail[0]?.role !== 'user') tail = tail.slice(1);
    return hasSystem ? [first, ...tail] : tail;
}

// ─────────────────────────────────────────
//  Helpers de respuesta
// ─────────────────────────────────────────

/** Divide el texto por ||MSG|| y devuelve un array limpio de mensajes. */
function splitMessages(content: string): string[] {
    return content
        .split('||MSG||')
        .map(m => m.trim())
        .filter(m => m.length > 0);
}

/**
 * Humaniza la respuesta del modelo:
 * 1) Quita markdown (asteriscos, viñetas) para que no se vea "formateado" en WhatsApp.
 * 2) Si el mensaje resultante queda largo, lo parte en varios mensajes cortos
 *    por límites de oración, de forma que cada uno se envía por separado.
 */
export function humanizeAndSplit(content: string, maxLen = 600): string[] {
    // 1. Quitar markdown: negritas y asteriscos (en WhatsApp no se renderizan)
    let text = content
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*/g, '')
        .replace(/_+([^_]+)_+/g, '$1')
        .replace(/^[#>\s]+/gm, '');

    // 2. Convertir viñetas de lista en texto plano
    text = text
        .split('\n')
        .map(line => line.replace(/^\s*(?:[•\-*]|\d+[.)])\s+/, '').trim())
        .filter(line => line.length > 0)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!text) return [];

    // 3. Separar por oraciones: puntuación seguida de espacio + mayúscula.
    //    No rompe precios ($350.000) ni abreviaturas (Mr. 18Kilates).
    const sentences = text
        .split(/(?<=[.!?…])\s+(?=[A-ZÁÉÍÓÚÜÑ¿¡])/)
        .map(s => s.trim())
        .filter(Boolean);

    const messages: string[] = [];
    let current = '';
    const pushChunk = (chunk: string) => {
        const piece = chunk.trim();
        if (!piece) return;
        if (current && (current + ' ' + piece).length > maxLen) {
            messages.push(current);
            current = piece;
        } else {
            current = current ? current + ' ' + piece : piece;
        }
    };

    for (const sentence of sentences) {
        if (sentence.length <= maxLen) {
            pushChunk(sentence);
        } else {
            // Oración muy larga: partir por comas
            for (const clause of sentence.split(/, /)) pushChunk(clause);
        }
    }
    if (current) messages.push(current);
    return messages;
}

/**
 * Una sola pregunta por respuesta: se envía todo hasta la primera pregunta (inclusive)
 * y se descarta lo que venga después. El modelo a veces encadenaba dos o tres preguntas
 * y los mensajes quedaban largos y confusos. Los "?" dentro de enlaces no cuentan.
 */
export function keepFirstQuestion(messages: string[]): string[] {
    const kept: string[] = [];
    for (const message of messages) {
        const masked = message.replace(/\S+:\/\/\S+/g, url => ' '.repeat(url.length));
        const end = masked.indexOf('?');
        if (end === -1) {
            kept.push(message);
            continue;
        }
        kept.push(message.slice(0, end + 1).trim());
        break;
    }
    return kept;
}

/**
 * Limita la cantidad de mensajes por respuesta sin perder contenido:
 * lo que sobra se une al último mensaje permitido.
 */
function capMessages(messages: string[], max: number): string[] {
    if (messages.length <= max) return messages;
    return [...messages.slice(0, max - 1), messages.slice(max - 1).join('\n\n')];
}

/** Construye un BotResponse a partir de texto plano (sin separadores). */
function singleResponse(text: string, images: PendingImage[] = []): BotResponse {
    return { text, messages: [text], images };
}

// ─────────────────────────────────────────
//  Tipo de respuesta
// ─────────────────────────────────────────
export type BotResponse = { text: string; messages: string[]; images: PendingImage[] };

// ─────────────────────────────────────────
//  Handler principal
// ─────────────────────────────────────────

/**
 * Punto de entrada de los canales. Pasa por el limitador global para no saturar
 * el servidor ni la cuota del proveedor de IA cuando escriben muchos clientes a la vez.
 */
export function handleUserMessage(
    sessionId: string,
    storeId: string,
    senderPhone: string,
    userText: string,
    systemPrompt: string,
    media?: CustomerPhoto
): Promise<BotResponse> {
    return aiLimiter(async () => {
        try {
            return await processUserMessage(sessionId, storeId, senderPhone, userText, systemPrompt, media);
        } finally {
            // Si la respuesta falló a mitad de camino, no dejar imágenes huérfanas para el siguiente mensaje.
            getPendingImages(sessionId);
        }
    });
}

async function processUserMessage(
    sessionId: string,
    storeId: string,
    senderPhone: string,
    userText: string,
    systemPrompt: string,
    media?: CustomerPhoto
): Promise<BotResponse> {

    // ── Datos del store (para Calendar y PQR email) ──
    const store = await db.query.stores.findFirst({ where: eq(stores.id, storeId) });
    const adminCalendarEmail = store?.adminCalendarEmail ?? '';
    const pqrEmail           = store?.pqrEmail           ?? '';

    // ── Consultar si ya hay una cita agendada en la base de datos o en la sesión ──
    const hasAppointment = await checkPendingAppointment(storeId, senderPhone);
    if (sessionId) {
        await setSessionAppointmentFlag(sessionId, hasAppointment);
    }

    // ── Construir system prompt enriquecido ──
    const categoriasContext = await buildCategoriasContext();

    // Fecha y hora actual en zona horaria de Colombia
    const nowColombia = new Date().toLocaleString('es-CO', {
        timeZone: 'America/Bogota',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
    });
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = tomorrowDate.toLocaleDateString('es-CO', {
        timeZone: 'America/Bogota',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });

    const dateContext =
        `\n\n[CONTEXTO TEMPORAL - INFORMACIÓN CRÍTICA]:\n` +
        `- Fecha y hora actual: ${nowColombia}\n` +
        `- Mañana es: ${tomorrowStr}\n` +
        `- SIEMPRE usa esta fecha como referencia. NUNCA inventes ni adivines la fecha.\n` +
        `- Si el cliente dice "mañana", la fecha correcta es ${tomorrowStr}.\n` +
        `- Si el cliente dice "hoy", la fecha es la de arriba.\n`;

    // Reemplazar [pqrEmail] por el correo del store o admin en el systemPrompt
    const contactEmail = pqrEmail || adminCalendarEmail || 'el correo del administrador';
    const baseSystemPrompt = systemPrompt.replace(/\[pqrEmail\]/g, contactEmail);

    let appointmentInstruction = '';
    if (hasAppointment) {
        appointmentInstruction = `
\n\n[REGLA CRÍTICA - CITA PREVIAMENTE AGENDADA]:
- Ya hay una cita futura previamente agendada para este número de WhatsApp.
- Si el cliente intenta agendar, informa que ya tiene una cita y pregunta si desea reprogramarla.
- Solo si responde afirmativamente y proporciona nueva fecha y hora, usa reschedule_appointment.
- Nunca uses schedule_appointment para crear una segunda cita.
- Para cancelar o cualquier caso que no pueda resolver la herramienta, deriva al administrador: ${contactEmail}.
`;
    }

    // Las búsquedas deben pasar por herramientas limitadas; no inyectamos todo
    // el catálogo en cada prompt porque permitiría enumerarlo masivamente.
    const enrichedSystemPrompt = SECURITY_PROMPT + '\n\n' + baseSystemPrompt + appointmentInstruction + dateContext + categoriasContext;

    // ── Cierre por inactividad ──
    const lastActivity = await getSessionLastActivity(sessionId);
    if (lastActivity) {
        const elapsed = Date.now() - lastActivity.getTime();
        if (elapsed > INACTIVITY_TIMEOUT_MS) {
            logger.info(`Sesión ${sessionId} inactiva ${Math.round(elapsed / 3600000)}h — reiniciando.`);
            await clearSession(sessionId, storeId, senderPhone, enrichedSystemPrompt);
        }
    }

    const history = await getOrCreateSession(sessionId, enrichedSystemPrompt);

    // ── Mensaje inicial fijo — sin pasar por el modelo ──
    // Solo si el cliente únicamente saludó; si ya preguntó algo ("Hola\nBusco un anillo"),
    // el modelo responde directamente a su consulta.
    const isNewSession = history.length === 1 && history[0].role === 'system';
    if (isNewSession && !media && (!userText.trim() || isGreeting(userText))) {
        const welcomeMsg = 'Hola, soy Mr. 18Kilates. ¿Ya tienes en mente una joya, estás explorando opciones o quieres diseñar una pieza única?';
        history.push({ role: 'user',      content: userText || 'Hola' });
        history.push({ role: 'assistant', content: welcomeMsg });
        await saveMemory(sessionId, storeId, senderPhone, history);
        return singleResponse(welcomeMsg);
    }

    // Regla comercial determinista: una solicitud de varios productos se
    // redirige al sitio web sin depender únicamente de la obediencia del LLM.
    const policyResponse = isMultipleImageRequest(userText)
        ? MULTIPLE_IMAGE_RESPONSE
        : isMultipleProductRequest(userText)
            ? MULTIPLE_PRODUCT_RESPONSE
            : null;

    if (policyResponse) {
        history.push({ role: 'user', content: userText });
        history.push({ role: 'assistant', content: policyResponse });
        await saveMemory(sessionId, storeId, senderPhone, history);
        return singleResponse(policyResponse);
    }

    // ── Mensaje del usuario ──
    // La foto del cliente nunca se guarda: en el historial queda un texto y la imagen
    // solo viaja al modelo en este turno (egress de Supabase y Ley 1581).
    const userMessage: OpenAI.Chat.ChatCompletionUserMessageParam = {
        role: 'user',
        content: media ? photoPlaceholder(userText) : (userText || 'El usuario envió un archivo sin texto.'),
        ...(media?.mediaId ? { [PHOTO_MEDIA_ID_FIELD]: media.mediaId } : {}),
    } as OpenAI.Chat.ChatCompletionUserMessageParam;
    history.push(userMessage);

    await saveMemory(sessionId, storeId, senderPhone, history);

    const toModel = (messages: OpenAI.Chat.ChatCompletionMessageParam[]) => messagesForModel(messages, userMessage, media);

    try {
        let responseMessage = await createWithCascade(
            MODEL_CASCADE,
            { messages: toModel(trimHistory(history, MAX_HISTORY_LENGTH)), tools: botTools, tool_choice: 'auto' }
        );

        // ── Bucle de tool calls ──
        let toolRounds = 0;
        while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            if (++toolRounds > MAX_TOOL_ROUNDS) {
                logger.warn(`Sesión ${sessionId}: se alcanzó el máximo de ${MAX_TOOL_ROUNDS} rondas de herramientas.`);
                break;
            }
            history.push(responseMessage);

            for (const toolCall of responseMessage.tool_calls) {
                let functionResult: string;
                try {
                    const functionName = toolCall.function.name;
                    const functionArgs = JSON.parse(toolCall.function.arguments);

                    functionResult = await executeTool(
                        functionName,
                        functionArgs,
                        storeId,
                        senderPhone,
                        sessionId,
                        enrichedSystemPrompt,
                        adminCalendarEmail,
                        pqrEmail
                    );
                } catch (parseError) {
                    logger.error(`Error parseando args de ${toolCall.function.name} (${toolCall.function.arguments?.length || 0} caracteres)`);
                    functionResult = JSON.stringify({ error: 'Argumentos inválidos proporcionados por la IA.' });
                }

                history.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: functionResult,
                });
            }

            responseMessage = await createWithCascade(
                MODEL_CASCADE,
                { messages: toModel(history), tools: botTools, tool_choice: 'auto' }
            );
        }

        // ── Respuesta final ──
        let finalContent = responseMessage.content || EMPTY_REPLY_FALLBACK;

        if (finalContent.includes('Demasiadas solicitudes') || finalContent.includes('Too many requests')) {
            finalContent = 'Lo siento, estoy recibiendo muchas consultas en este momento. Por favor, escríbeme de nuevo en unos minutos.';
        }

        // ── Detectar confirmación falsa de cita (modelo respondió en texto sin llamar la herramienta) ──
        const appointmentPhrases = /agendad[ao]|registrad[ao]|confirmad[ao]|quedó la cita|cita queda|tu (visita|cita) (es|será|quedó|queda)/i;
        const scheduleWasCalled  = history.some(
            m => m.role === 'assistant' &&
            Array.isArray((m as any).tool_calls) &&
            (m as any).tool_calls.some((tc: any) => ['schedule_appointment', 'reschedule_appointment'].includes(tc.function?.name))
        );

        if (appointmentPhrases.test(finalContent) && !scheduleWasCalled) {
            logger.warn(`Sesión ${sessionId}: modelo confirmó cita sin invocar schedule_appointment. Reintentando con tool_choice forzado.`);
            try {
                const forcedMsg = await createWithCascade(
                    MODEL_CASCADE,
                    {
                        messages: toModel(history),
                        tools: botTools,
                        tool_choice: { type: 'function', function: { name: 'schedule_appointment' } },
                    }
                );
                if (forcedMsg.tool_calls?.length) {
                    // Una sola vez: repetir la llamada con el mismo id la rechaza Claude (HTTP 400).
                    history.push(forcedMsg);
                    for (const tc of forcedMsg.tool_calls) {
                        const result = await executeTool(
                            tc.function.name,
                            JSON.parse(tc.function.arguments),
                            storeId, senderPhone, sessionId,
                            enrichedSystemPrompt, adminCalendarEmail, pqrEmail
                        );
                        history.push({ role: 'tool', tool_call_id: tc.id, content: result });
                    }
                    const finalCall = await createWithCascade(
                        MODEL_CASCADE,
                        { messages: toModel(history), tools: botTools, tool_choice: 'auto' }
                    );
                    finalContent = finalCall.content || finalContent;
                }
            } catch (forceErr: any) {
                logger.error(`Reintento forzado fallido: ${forceErr.message}`);
                finalContent = 'Perdona, tuve un problema técnico al registrar tu cita. ¿Me confirmas de nuevo el día, la hora y tu nombre completo?';
            }
        }

        // ── Dividir en mensajes si el modelo usó ||MSG||, humanizar, una sola pregunta y limitar la cantidad ──
        const splitOut = splitMessages(finalContent).flatMap(msg => humanizeAndSplit(msg));
        const oneQuestion = keepFirstQuestion(splitOut);
        if (oneQuestion.join(' ').length < splitOut.join(' ').length) {
            logger.info(`Sesión ${sessionId}: se recortó la respuesta para dejar una sola pregunta.`);
        }
        const outMessages = capMessages(oneQuestion, config.BOT_MAX_TEXT_MESSAGES);
        if (outMessages.length === 0) outMessages.push(EMPTY_REPLY_FALLBACK);

        // Guardar en historial el texto unificado (sin separadores)
        const textForHistory = outMessages.join(' ');
        history.push({ role: 'assistant', content: textForHistory });

        const finalHistory = trimHistory(history, MAX_HISTORY_LENGTH);

        await saveMemory(sessionId, storeId, senderPhone, finalHistory);

        const images = getPendingImages(sessionId).slice(0, config.BOT_MAX_IMAGES);
        return { text: outMessages[0], messages: outMessages, images };

    } catch (error: any) {
        logger.error(
            `Error sesión ${sessionId}:`, error.message, error.status,
            JSON.stringify(error.error ?? error.response?.data ?? '')
        );

        // ── Recuperación ante historial corrupto ──
        if ((error.status ?? error.statusCode) === 400) {
            logger.warn(`Sesión ${sessionId} con historial corrupto — limpiando y reintentando...`);
            const freshHistory: OpenAI.Chat.ChatCompletionMessageParam[] = [
                { role: 'system', content: enrichedSystemPrompt },
                { role: 'user',   content: userText || 'Hola' },
            ];
            await saveMemory(sessionId, storeId, senderPhone, freshHistory);
            try {
                const retryResponse = await createWithCascade(
                    MODEL_CASCADE,
                    { messages: freshHistory, tools: botTools, tool_choice: 'auto' }
                );
                const retryContent = retryResponse.content || EMPTY_REPLY_FALLBACK;
                freshHistory.push({ role: 'assistant', content: retryContent });
                await saveMemory(sessionId, storeId, senderPhone, freshHistory);
                return singleResponse(retryContent);
            } catch (retryErr: any) {
                logger.error(`Reintento fallido para ${sessionId}: ${retryErr.message}`);
            }
        }

        const isRateLimit = (error.status ?? error.statusCode) === 429;
        const errorMsg = isRateLimit
            ? 'Estoy atendiendo muchas consultas en este momento, dame un momento y escríbeme de nuevo en 1 minuto.'
            : 'Lo siento, tengo un problema técnico en este momento. Por favor escríbeme de nuevo más tarde.';

        return singleResponse(errorMsg);
    }
}
