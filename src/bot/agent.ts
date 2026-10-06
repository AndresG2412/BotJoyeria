import OpenAI from 'openai';
import { config } from '../config/env';
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
const MODEL_TIMEOUT_MS = 20 * 1000;  // Si un modelo no responde, pasar al siguiente de la cascada

// Conversaciones procesándose con la IA al mismo tiempo (todas las tiendas y canales).
const aiLimiter = createLimiter(config.BOT_MAX_CONCURRENT_CONVERSATIONS);

// ─────────────────────────────────────────
//  Cascadas de modelos
// ─────────────────────────────────────────
export type ModelEntry = { id: string; tools: boolean };

const SIMPLE_MODEL_CASCADE: ModelEntry[] = [
    { id: 'gemini-3.1-flash-lite', tools: true  },
    { id: 'gemini-2.5-flash',      tools: true  },
    { id: 'gemini-3-flash',        tools: true  },
];

const COMPLEX_MODEL_CASCADE: ModelEntry[] = [
    { id: 'gemini-3.5-flash',      tools: true  },
    { id: 'gemini-3.1-flash-lite', tools: true  },
    { id: 'gemini-2.5-flash',      tools: true  },
    // Sin modelos «sin herramientas» de respaldo: sin acceso al catálogo inventaban piezas
    // y precios, y escribían el nombre de la herramienta en el texto para el cliente.
];

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

async function createWithCascade(
    cascade: ModelEntry[],
    apiKeys: string[],
    baseURL: string | undefined,
    params: Omit<Parameters<OpenAI['chat']['completions']['create']>[0], 'model'>
): Promise<{ completion: OpenAI.Chat.ChatCompletion; usedTools: boolean }> {
    let lastError: any;
    for (const entry of availableModels(cascade)) {
        let modelFailed = false;
        for (const apiKey of apiKeys) {
            try {
                // Sin reintentos internos del SDK: la cascada ya prueba otra key/modelo.
                // Con los reintentos por defecto cada HTTP 503 tardaba hasta ~1 minuto en caer.
                const openai = new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: MODEL_TIMEOUT_MS });
                const callParams: any = { ...params, model: entry.id };
                if (!entry.tools) {
                    delete callParams.tools;
                    delete callParams.tool_choice;
                }
                const result = await openai.chat.completions.create(callParams);
                if (entry.id !== cascade[0].id) {
                    logger.warn(`Cascada: ${cascade[0].id} falló, usando ${entry.id}`);
                }
                return { completion: result as OpenAI.Chat.ChatCompletion, usedTools: entry.tools };
            } catch (err: any) {
                lastError = err;
                const status = err.status ?? err.statusCode;
                const isTimeout = err instanceof OpenAI.APIConnectionTimeoutError;
                if (isTimeout || [400, 404, 429, 500, 502, 503, 504].includes(status)) {
                    logger.warn(`Cascada: ${entry.id} [key ...${apiKey.slice(-4)}] → ${isTimeout ? 'timeout' : `HTTP ${status}`}, probando siguiente...`);
                    // 400 puede ser de la key y 429 es la cuota de esa key: se prueba la otra.
                    if (status === 400) continue;
                    modelFailed = true;
                    if (status === 429) continue;
                    // Saturado, caído o sin respuesta: es el modelo, no la key. Siguiente modelo.
                    break;
                }
                throw err;
            }
        }
        if (modelFailed) coolDownModel(entry.id);
    }
    throw lastError;
}

// ─────────────────────────────────────────
//  Evaluador de complejidad
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

function isComplexTask(userText: string, hasMedia: boolean): boolean {
    if (hasMedia)             return true;
    if (isGreeting(userText)) return false;
    if (userText.length > 20) return true;
    const complexKeywords = /precio|costo|cuánto|vende|comprar|pagar|link|checkout|catálogo|producto|inventario|disponible|imagen|foto|cita|agendar|envío|envio|anillo|cadena|aretes|pulsera|dientes|candado|oro|plata|quilate|mañana|lunes|martes|miércoles|jueves|viernes|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|pm|am|nombre|teléfono/i;
    return complexKeywords.test(userText);
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
    const mem = await getMemory(sessionId);
    if (!mem || mem.length === 0) return [{ role: 'system', content: systemPrompt }];
    if (mem[0].role === 'system') mem[0].content = systemPrompt;
    return mem;
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
    customApiKey: string | null,
    media?: { mimetype: string; data: string }
): Promise<BotResponse> {
    return aiLimiter(async () => {
        try {
            return await processUserMessage(sessionId, storeId, senderPhone, userText, systemPrompt, customApiKey, media);
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
    customApiKey: string | null,
    media?: { mimetype: string; data: string }
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
    if (isNewSession && (!userText.trim() || isGreeting(userText))) {
        const welcomeMsg = 'Hola, soy Mr. 18Kilates. Cuéntame en que te ayudo, ¿ya tienes en mente la joya que buscas, estás explorando opciones o te gustaría que diseñemos una pieza única desde cero?';
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

    // ── API keys ──
    const baseURL = config.OPENAI_BASE_URL || undefined;
    const apiKeys = [
        customApiKey || config.OPENAI_API_KEY,
        ...(config.OPENAI_API_KEY_2 ? [config.OPENAI_API_KEY_2] : []),
    ].filter(Boolean) as string[];

    // ── Mensaje del usuario ──
    const contentPayload: any = media
        ? [
            { type: 'text', text: userText || '¿Qué ves en esta foto?' },
            { type: 'image_url', image_url: { url: `data:${media.mimetype};base64,${media.data}` } },
          ]
        : (userText || 'El usuario envió un archivo sin texto.');

    history.push({ role: 'user', content: contentPayload });

    await saveMemory(sessionId, storeId, senderPhone, history);

    const historyForModel = history.length > MAX_HISTORY_LENGTH
        ? [history[0], ...history.slice(history.length - MAX_HISTORY_LENGTH + 1)]
        : history;

    // ── Sanitizar historial (quitar image_url para modelos que no lo soporten) ──
    const sanitizedHistory = historyForModel.map(msg => {
        if (Array.isArray((msg as any).content)) {
            const text = (msg as any).content
                .filter((p: any) => p.type === 'text')
                .map((p: any) => p.text)
                .join(' ') || '[imagen]';
            return { ...msg, content: text };
        }
        return msg;
    }) as OpenAI.Chat.ChatCompletionMessageParam[];

    // ── Selección de cascada ──
    const isComplex     = isComplexTask(userText, !!media);
    const activeCascade = isComplex ? COMPLEX_MODEL_CASCADE : SIMPLE_MODEL_CASCADE;
    logger.info(`Sesión ${sessionId} → cascada ${isComplex ? 'COMPLEJA' : 'SIMPLE'} (${activeCascade[0].id})`);

    try {
        let { completion: aiResponse, usedTools } = await createWithCascade(
            activeCascade, apiKeys, baseURL,
            { messages: sanitizedHistory, tools: botTools, tool_choice: 'auto' }
        );

        let responseMessage = aiResponse.choices[0].message;

        // ── Bucle de tool calls ──
        let toolRounds = 0;
        while (usedTools && responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
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

            const next = await createWithCascade(
                activeCascade, apiKeys, baseURL,
                { messages: history, tools: botTools, tool_choice: 'auto' }
            );
            aiResponse      = next.completion;
            usedTools       = next.usedTools;
            responseMessage = aiResponse.choices[0].message;
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
                const forced = await createWithCascade(
                    COMPLEX_MODEL_CASCADE,
                    apiKeys,
                    baseURL,
                    {
                        messages: history,
                        tools: botTools,
                        tool_choice: { type: 'function', function: { name: 'schedule_appointment' } },
                    }
                );
                const forcedMsg = forced.completion.choices[0].message;
                if (forcedMsg.tool_calls?.length) {
                    for (const tc of forcedMsg.tool_calls) {
                        const result = await executeTool(
                            tc.function.name,
                            JSON.parse(tc.function.arguments),
                            storeId, senderPhone, sessionId,
                            enrichedSystemPrompt, adminCalendarEmail, pqrEmail
                        );
                        history.push(forcedMsg);
                        history.push({ role: 'tool', tool_call_id: tc.id, content: result });
                    }
                    const finalCall = await createWithCascade(
                        COMPLEX_MODEL_CASCADE, apiKeys, baseURL,
                        { messages: history, tools: botTools, tool_choice: 'auto' }
                    );
                    finalContent = finalCall.completion.choices[0].message.content || finalContent;
                }
            } catch (forceErr: any) {
                logger.error(`Reintento forzado fallido: ${forceErr.message}`);
                finalContent = 'Perdona, tuve un problema técnico al registrar tu cita. ¿Me confirmas de nuevo el día, la hora y tu nombre completo?';
            }
        }

        // ── Dividir en mensajes si el modelo usó ||MSG||, humanizar y limitar la cantidad ──
        const outMessages = capMessages(
            splitMessages(finalContent).flatMap(msg => humanizeAndSplit(msg)),
            config.BOT_MAX_TEXT_MESSAGES,
        );
        if (outMessages.length === 0) outMessages.push(EMPTY_REPLY_FALLBACK);

        // Guardar en historial el texto unificado (sin separadores)
        const textForHistory = outMessages.join(' ');
        history.push({ role: 'assistant', content: textForHistory });

        const finalHistory = history.length > MAX_HISTORY_LENGTH
            ? [history[0], ...history.slice(history.length - MAX_HISTORY_LENGTH + 1)]
            : history;

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
                const { completion: retryResponse } = await createWithCascade(
                    activeCascade, apiKeys, baseURL,
                    { messages: freshHistory, tools: botTools, tool_choice: 'auto' }
                );
                const retryContent = retryResponse.choices[0].message.content || EMPTY_REPLY_FALLBACK;
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
