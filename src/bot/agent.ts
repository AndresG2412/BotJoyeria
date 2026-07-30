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

const MAX_HISTORY_LENGTH  = 15;
const INACTIVITY_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 horas

// ─────────────────────────────────────────
//  Cascadas de modelos
// ─────────────────────────────────────────
type ModelEntry = { id: string; tools: boolean };

const SIMPLE_MODEL_CASCADE: ModelEntry[] = [
    { id: 'gemini-3.1-flash-lite', tools: true  },
    { id: 'gemini-2.5-flash',      tools: true  },
    { id: 'gemini-3-flash',        tools: true  },
];

const COMPLEX_MODEL_CASCADE: ModelEntry[] = [
    { id: 'gemini-3.5-flash',      tools: true  },
    { id: 'gemini-3.1-flash-lite', tools: true  },
    { id: 'gemini-2.5-flash-lite', tools: false },
];

async function createWithCascade(
    cascade: ModelEntry[],
    apiKeys: string[],
    baseURL: string | undefined,
    params: Omit<Parameters<OpenAI['chat']['completions']['create']>[0], 'model'>
): Promise<{ completion: OpenAI.Chat.ChatCompletion; usedTools: boolean }> {
    let lastError: any;
    for (const entry of cascade) {
        for (const apiKey of apiKeys) {
            try {
                const openai = new OpenAI({ apiKey, baseURL });
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
                if ([400, 404, 429, 500, 503].includes(status)) {
                    logger.warn(`Cascada: ${entry.id} [key ...${apiKey.slice(-4)}] → HTTP ${status}, probando siguiente...`);
                    continue;
                }
                throw err;
            }
        }
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
            return `- [ID: ${p.id}] ${p.name} — ${price}${p.description ? ` | ${p.description}` : ''}`;
        }).join('\n');
        return `\n\nPIEZAS DISPONIBLES EN CATÁLOGO:\n${lines}\n\nCuando el cliente quiera ver una pieza, usa send_product_image con el ID correspondiente.`;
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
export async function handleUserMessage(
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
    const catalogContext    = await buildCatalogContext(storeId);
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
- Ya hay una cita previamente agendada en este chat.
- Si el cliente quiere CANCELARLA, CAMBIARLA (reprogramar, modificar) o AGENDAR NUEVAMENTE (agendar otra cita), debes decirle de forma muy amable que debe contactar al correo del administrador: ${contactEmail}.
- NUNCA intentes agendar otra cita, cambiarla o cancelarla tú mismo.
- NUNCA uses la herramienta schedule_appointment bajo ninguna circunstancia en este chat.
`;
    }

    const enrichedSystemPrompt = SECURITY_PROMPT + '\n\n' + baseSystemPrompt + appointmentInstruction + dateContext + categoriasContext + catalogContext;

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
    const isNewSession = history.length === 1 && history[0].role === 'system';
    if (isNewSession) {
        const welcomeMsg = 'Hola, soy Mr. 18Kilates. Cuéntame en que te ayudo, ¿ya tienes en mente la joya que buscas, estás explorando opciones o te gustaría que diseñemos una pieza única desde cero?';
        history.push({ role: 'user',      content: userText || 'Hola' });
        history.push({ role: 'assistant', content: welcomeMsg });
        await saveMemory(sessionId, storeId, senderPhone, history);
        return singleResponse(welcomeMsg);
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
        while (usedTools && responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
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
                    logger.error(`Error parseando args de ${toolCall.function.name}:`, toolCall.function.arguments);
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
        let finalContent = responseMessage.content || 'Hubo un error de procesamiento.';

        if (finalContent.includes('Demasiadas solicitudes') || finalContent.includes('Too many requests')) {
            finalContent = 'Lo siento, estoy recibiendo muchas consultas en este momento. Por favor, escríbeme de nuevo en unos minutos.';
        }

        // ── Detectar confirmación falsa de cita (modelo respondió en texto sin llamar la herramienta) ──
        const appointmentPhrases = /agendad[ao]|registrad[ao]|confirmad[ao]|quedó la cita|cita queda|tu (visita|cita) (es|será|quedó|queda)/i;
        const scheduleWasCalled  = history.some(
            m => m.role === 'assistant' &&
            Array.isArray((m as any).tool_calls) &&
            (m as any).tool_calls.some((tc: any) => tc.function?.name === 'schedule_appointment')
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

        // ── Dividir en mensajes si el modelo usó ||MSG|| ──
        const outMessages = splitMessages(finalContent);

        // Guardar en historial el texto unificado (sin separadores)
        const textForHistory = outMessages.join(' ');
        history.push({ role: 'assistant', content: textForHistory });

        const finalHistory = history.length > MAX_HISTORY_LENGTH
            ? [history[0], ...history.slice(history.length - MAX_HISTORY_LENGTH + 1)]
            : history;

        await saveMemory(sessionId, storeId, senderPhone, finalHistory);

        return { text: outMessages[0], messages: outMessages, images: getPendingImages(sessionId) };

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
                const retryContent = retryResponse.choices[0].message.content || 'Hubo un error de procesamiento.';
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