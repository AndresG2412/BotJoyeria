import OpenAI from 'openai';
import { searchProducts, filterProducts, getProductById, getProductRawImages } from '../data/catalog';
import { config } from '../config/env';
import { clearSession, getSession, setSessionAppointmentFlag, checkPendingAppointment, getPendingAppointment, getMemory } from '../data/database';
import { createAppointment, createNotification, updateAppointment } from '../data/agenda';
import { logger } from '../utils/logger';
import axios from 'axios';
import { APPOINTMENT_ADDRESS, APPOINTMENT_CITY, APPOINTMENT_DURATION_MINUTES, APPOINTMENT_HOURS, AppointmentMode, CALL_APPOINTMENT_CITY, appointmentPlace, availabilityInstruction, availabilityLabel } from './policies';
import { checkSlot, normalizeTime } from './scheduling';
import { parseWebProductLead, webLeadReference } from '../utils/web-product';
import { checkRepairStatus } from './repairs';

// ─────────────────────────────────────────
//  Cola temporal de imágenes pendientes
// ─────────────────────────────────────────
export type PendingImage = { mimetype: string; base64: string; caption?: string };
const pendingImagesMap = new Map<string, PendingImage[]>();
export const MAX_PRODUCT_IMAGES_PER_RESPONSE = 1;

export function limitProductImages(images: string[], alreadyQueued: number, configuredLimit: number): string[] {
    const totalAllowed = Math.min(MAX_PRODUCT_IMAGES_PER_RESPONSE, configuredLimit);
    const slots = Math.max(0, totalAllowed - alreadyQueued);
    return images.slice(0, slots);
}

async function getWebLeadProductReference(sessionId: string | undefined, storeId: string): Promise<string | null> {
    if (!sessionId) return null;
    const history = await getMemory(sessionId);
    for (let index = history.length - 1; index >= 0; index--) {
        const message = history[index];
        if (message?.role !== 'user' || typeof message.content !== 'string') continue;
        const lead = parseWebProductLead(message.content);
        if (!lead) continue;
        const product = await getProductById(webLeadReference(lead), storeId);
        const tono = lead.tono ? ` (${lead.tono})` : '';
        return product ? `${product.name}${tono} — Ref: ${product.id}` : `${webLeadReference(lead)}${tono}`;
    }
    return null;
}

export function getPendingImages(sessionId: string): PendingImage[] {
    const images = pendingImagesMap.get(sessionId) || [];
    pendingImagesMap.delete(sessionId);
    return images;
}

function queueImage(sessionId: string, base64DataUri: string, caption?: string) {
    const match = base64DataUri.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (match) {
        if (!pendingImagesMap.has(sessionId)) {
            pendingImagesMap.set(sessionId, []);
        }
        pendingImagesMap.get(sessionId)!.push({ mimetype: match[1], base64: match[2], caption });
    }
}

/** Celular (3xx) o fijo (60x) colombiano de 10 dígitos, con o sin 57 delante; null si no es válido. */
/**
 * Una cotización por chat cada 30 minutos: si la IA vuelve a llamar request_quote mientras el
 * cliente sigue dando detalles, la campana no suena de nuevo (el empleado ya ve el chat).
 */
const QUOTE_COOLDOWN_MS = 30 * 60 * 1000;
const lastQuoteAt = new Map<string, number>();

export function isRepeatedQuote(sessionKey: string, now = Date.now()): boolean {
    for (const [key, at] of lastQuoteAt) if (now - at >= QUOTE_COOLDOWN_MS) lastQuoteAt.delete(key);
    if (lastQuoteAt.has(sessionKey)) return true;
    lastQuoteAt.set(sessionKey, now);
    return false;
}

export function normalizeColombianMobile(phone: string): string | null {
    const digits = (phone || '').replace(/\D/g, '');
    const local = digits.startsWith('57') && digits.length === 12 ? digits.slice(2) : digits;
    return /^(3\d{9}|60\d{8})$/.test(local) ? local : null;
}

// ─────────────────────────────────────────
//  Helper: resumen breve de productos para el modelo
// ─────────────────────────────────────────
// Resumen mínimo para el modelo: solo lo necesario para presentar (nombre y precio).
// Los detalles se piden aparte con get_product_details.
function summarizeProductsBrief(products: any[]) {
    return products.map(p => ({
        id: p.id,
        nombre: p.name || p.nombre || '',
        precio: p.price > 0 ? p.price : null,
        disponibilidad: availabilityLabel(p.stock),
        // Página de la pieza en la tienda: ahí se compra y se paga en línea.
        enlace: p.url || null,
    }));
}

// ─────────────────────────────────────────
//  Definición de tools para OpenAI
// ─────────────────────────────────────────
export const botTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'search_products',
            description: 'Busca productos en el catálogo de la joyería Mr. 18Kilates según una búsqueda. Úsalo cuando el cliente describa lo que busca (tipo de joya, material, gemas, precio, etc.).',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Término de búsqueda. Ej: "anillo de oro 18k", "cadena de plata con dije".'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'filter_products',
            description: 'Filtra progresivamente una sola categoría de joyas por material, piedra, color, presupuesto y disponibilidad. No muestra listas: si hay varias coincidencias devuelve solo la cantidad para que el asesor haga otra pregunta.',
            parameters: {
                type: 'object',
                properties: {
                    categoria: { type: 'string', description: 'Categoría o tipo: anillo, cadena, pulsera, aretes, etc.' },
                    material: { type: 'string', description: 'Material como oro 18k, oro blanco, oro amarillo o plata.' },
                    piedra: { type: 'string', description: 'Piedra como diamante, zafiro, esmeralda o rubí.' },
                    color_metal: { type: 'string', description: 'Color del metal si el cliente lo especifica.' },
                    color_piedra: { type: 'string', description: 'Color de la piedra si el cliente lo especifica.' },
                    estilo: { type: 'string', description: 'Estilo u ocasión solicitada.' },
                    presupuesto_max: { type: 'number', description: 'Presupuesto máximo en pesos colombianos.' },
                    disponibilidad: { type: 'string', enum: ['disponible', 'bajo_pedido', 'cualquiera'] },
                },
                required: ['categoria']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_product_details',
            description: 'Obtiene todos los detalles de una joya específica por su ID o referencia (precio, material, peso, gemas, fotos, descripción, etc.).',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'El ID o referencia exacta del producto. Ej: "AN-001".'
                    }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'send_product_image',
            description: 'Envía las fotos de una joya al cliente por WhatsApp. Úsalo cuando el cliente pida ver el producto o quiera fotos de la pieza.',
            parameters: {
                type: 'object',
                properties: {
                    product_id: {
                        type: 'string',
                        description: 'El ID o referencia de la joya cuyas fotos quieres enviar.'
                    }
                },
                required: ['product_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'schedule_appointment',
            description: [
                 'Registra una cita (presencial en Pitalito o por llamada) en el calendario de la joyería.',
                 'SOLO llama esta función cuando el cliente haya proporcionado nombre completo, fecha y hora.',
                'REGLAS ESTRICTAS:',
                 `- La cita dura ${APPOINTMENT_DURATION_MINUTES} minutos aproximadamente. La asesoría puede tardar más si el cliente aún está explorando opciones.`,
                 '- La fecha debe ser MÍNIMO el día siguiente al de hoy.',
                 `- modalidad "presencial": en ${APPOINTMENT_CITY}, ${APPOINTMENT_ADDRESS}. modalidad "llamada": un asesor llama al teléfono del cliente. Mismo horario para ambas: ${APPOINTMENT_HOURS}.`,
                 '- SOLO se agendan días hábiles: de lunes a viernes, NUNCA sábados, domingos ni días festivos.',
                 '- La hora de inicio debe ser en punto. Las franjas válidas son 08:00–12:00 y 14:00–18:00. NUNCA permitas minutos.',
                '- NUNCA modifiques ni canceles citas existentes. Solo crea nuevas.',
                '- NUNCA reveles información de citas de otros clientes ni de sus fechas.',
                '',
                'DATOS:',
                 '- Necesitas del cliente: client_name, phone, date, time y la modalidad que eligió.',
                 '- No preguntes ciudad ni dirección: la presencial siempre es en Pitalito y la llamada es al teléfono del cliente.',
                 '- property_reference es el nombre/referencia de la pieza o "asesoría general".',
            ].join(' '),
            parameters: {
                type: 'object',
                properties: {
                    client_name: {
                        type: 'string',
                        description: 'Nombre completo del cliente.'
                    },
                    date: {
                        type: 'string',
                        description: 'Fecha en formato YYYY-MM-DD. Debe ser mínimo mañana.'
                    },
                    time: {
                        type: 'string',
                         description: 'Hora en formato HH:MM (24h). Debe estar entre 08:00 y 12:00 o entre 14:00 y 18:00, siempre en punto.'
                    },
                     appointment_type: {
                         type: 'string',
                         enum: ['asesoria_presencial', 'producto_bajo_pedido'],
                         description: 'Motivo de la cita: asesoría general o pieza bajo pedido / para fabricar.'
                    },
                    modalidad: {
                        type: 'string',
                        enum: ['presencial', 'llamada'],
                        description: 'presencial = en la joyería en Pitalito; llamada = un asesor llama al cliente al teléfono indicado.'
                    },
                    property_reference: {
                        type: 'string',
                        description: 'Referencia o nombre de la joya del catálogo a comprar.'
                    },
                    phone: {
                        type: 'string',
                        description: 'Número de WhatsApp de 10 dígitos del cliente.'
                    }
                },
                 required: ['client_name', 'phone', 'date', 'time', 'appointment_type', 'modalidad']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'reschedule_appointment',
            description: `Reprograma la cita presencial existente del cliente actual. Úsala SOLO después de que el cliente confirme que desea reprogramar y proporcione una nueva fecha y hora válidas. Horario: ${APPOINTMENT_HOURS}.`,
            parameters: {
                type: 'object',
                properties: {
                    date: { type: 'string', description: 'Nueva fecha YYYY-MM-DD, mínimo mañana.' },
                    time: { type: 'string', description: 'Nueva hora HH:MM en punto, entre 08:00–12:00 o 14:00–18:00.' },
                },
                required: ['date', 'time']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'check_repair_status',
            description: 'Consulta el estado de una joya que el cliente dejó en reparación en el taller de la joyería (solo lectura). La verificación la hace el sistema con el WhatsApp desde el que escribe el cliente. Úsala cuando el cliente pregunte por su reparación, con el número de orden de su recibo y/o la cédula del titular, tal como los escribió.',
            parameters: {
                type: 'object',
                properties: {
                    numero_orden: { type: 'string', description: 'Número de orden del recibo del taller, si el cliente lo dio.' },
                    cedula: { type: 'string', description: 'Cédula del titular de la orden, si el cliente la dio.' },
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'request_human_contact',
            description: 'Avisa al equipo de la joyería que el cliente quiere que lo llamen pronto (sin fecha ni hora fija) o que quiere hablar con un asesor por este chat. Úsala cuando el cliente lo pida explícitamente ("llámenme", "quiero hablar con alguien", "páseme con un asesor") o en reclamos y garantías. Si el cliente prefiere una hora concreta, usa schedule_appointment con modalidad "llamada".',
            parameters: {
                type: 'object',
                properties: {
                    via: { type: 'string', enum: ['llamada', 'chat'], description: 'llamada = que lo llamen al celular desde el que escribe; chat = que un asesor le escriba por este WhatsApp.' },
                    motivo: { type: 'string', description: 'Motivo en pocas palabras, ej.: "cotizar anillo de compromiso", "reclamo por reparación".' },
                    nombre: { type: 'string', description: 'Nombre del cliente si ya lo dio.' },
                },
                required: ['via']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'request_quote',
            description: 'Pide a un empleado de la joyería que haga la cotización y se la envíe al cliente por este chat. Úsala cuando el cliente quiera saber el precio de una pieza que hay que fabricar, diseñar a medida, que está bajo pedido o que no tiene precio, y ya sepas qué pieza es (por su descripción o su foto). No la uses para piezas disponibles con precio: esas se compran con el enlace.',
            parameters: {
                type: 'object',
                properties: {
                    pieza: { type: 'string', description: 'Qué hay que cotizar, en pocas palabras, ej.: "anillo de compromiso en oro con circón", "pulsera dorada con piedras cuadradas, según foto".' },
                    detalles: { type: 'string', description: 'Lo que el cliente ya dijo de material, medida, piedra, presupuesto o fecha. Vacío si no dijo nada.' },
                    nombre: { type: 'string', description: 'Nombre del cliente si ya lo dio.' },
                },
                required: ['pieza']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'close_conversation',
            description: 'Cierra y reinicia la conversación. Úsalo ÚNICAMENTE cuando el cliente se despida claramente o confirme que ya no necesita más ayuda. NO lo uses si solo dice "gracias" en medio de la conversación.',
            parameters: {
                type: 'object',
                properties: {
                    reason: {
                        type: 'string',
                        description: 'Razón breve del cierre. Ej: "cliente se despidió", "venta registrada, conversación cerrada".'
                    }
                },
                required: ['reason']
            }
        }
    }
];

// ─────────────────────────────────────────
//  Executor
// ─────────────────────────────────────────
export async function executeTool(
    name: string,
    args: any,
    storeId: string,
    senderPhone: string,
    sessionId?: string,
    systemPrompt?: string,
    adminCalendarEmail?: string,   
    pqrEmail?: string              
): Promise<string> {
    // Solo los nombres de los campos: los valores pueden traer nombre y teléfono del cliente.
    logger.info(`Ejecutando tool: ${name} (${Object.keys(args || {}).join(', ') || 'sin argumentos'})`);

    try {
        switch (name) {

            // ── Buscar piezas ──────────────────────────────────────
            case 'search_products': {
                const products = await searchProducts(args.query, storeId);
                if (products.length === 0) {
                    return JSON.stringify({
                        coincidencias: 0,
                        error: 'No se encontró una pieza con esa búsqueda.',
                        instrucciones: 'No inventes ni muestres alternativas. Pregunta qué filtro desea cambiar o solicita una referencia más precisa.',
                    });
                }
                return JSON.stringify({
                    productos: summarizeProductsBrief(products.slice(0, 1)),
                    instrucciones: 'Presenta SOLO una pieza con nombre y precio, en una línea y sin listas. Si el stock es 0, indica que es bajo pedido y ofrece cita en Pitalito o llamada para confirmarla. Si pide más detalles, usa get_product_details. Si pide foto, usa send_product_image. Si la pieza está disponible y el cliente quiere comprarla, compártele su enlace: ahí la paga en la tienda en línea. No le ofrezcas cita ni llamada para comprar una pieza disponible.'
                });
            }

            case 'filter_products': {
                const products = await filterProducts({
                    storeId,
                    categoriaId: args.categoria,
                    material: args.material,
                    piedra: args.piedra,
                    colorMetal: args.color_metal,
                    colorPiedra: args.color_piedra,
                    estilo: args.estilo,
                    presupuestoMax: Number(args.presupuesto_max) || undefined,
                    disponibilidad: args.disponibilidad || 'cualquiera',
                });

                if (products.length === 0) {
                    return JSON.stringify({
                        coincidencias: 0,
                        instrucciones: 'No hay una pieza que cumpla todos los filtros. Pregunta qué filtro desea flexibilizar. No inventes alternativas ni muestres una lista.',
                    });
                }

                if (products.length > 1) {
                    return JSON.stringify({
                        coincidencias: products.length,
                        instrucciones: 'Hay varias coincidencias. Haz una sola pregunta para agregar o precisar un filtro antes de mostrar una pieza. No muestres nombres ni una lista.',
                    });
                }

                const product = products[0];
                return JSON.stringify({
                    coincidencias: 1,
                    producto: summarizeProductsBrief([product])[0],
                    instrucciones: product.stock > 0
                        ? 'Presenta solo esta pieza con nombre y precio. Si pide detalles usa get_product_details; si pide foto usa send_product_image. Si la pieza está disponible y el cliente quiere comprarla, compártele su enlace: ahí la paga en la tienda en línea. No le ofrezcas cita ni llamada para comprar una pieza disponible.'
                        : 'Presenta solo esta pieza e indica que está disponible bajo pedido; ofrece cita en Pitalito o llamada para confirmarla.',
                });
            }

            // ── Detalle de una propiedad ────────────────────────────────
            case 'get_product_details': {
                const product = await getProductById(args.id, storeId);
                if (!product) return JSON.stringify({ error: 'No se encontró una pieza con esa referencia.' });
                const { imagenes, imageUrl, checkoutUrl, storeId: _store, ...details } = product;
                return JSON.stringify({
                    ...details,
                    fotos: imagenes.length,
                    precio: product.price > 0 ? product.price : 'a consultar con un asesor',
                    disponibilidad: availabilityLabel(product.stock),
                    instrucciones_disponibilidad: availabilityInstruction(product.stock),
                    instrucciones_enlace: product.url
                        ? (product.stock > 0
                            ? `Enlace de la pieza: ${product.url}. Si la pieza está disponible y el cliente quiere comprarla, compártele su enlace: ahí la paga en la tienda en línea. No le ofrezcas cita ni llamada para comprar una pieza disponible.`
                            : `Si el cliente quiere ver la pieza completa o más fotos, compártele este enlace: ${product.url}`)
                        : undefined,
                });
            }

            // ── Enviar fotos de una joya ────────────────────────────────
            case 'send_product_image': {
                const allImages = await getProductRawImages(args.product_id, storeId);
                if (!allImages || allImages.length === 0) {
                    return JSON.stringify({ success: false, error: 'Esta joya no tiene imágenes disponibles. Díselo al cliente con amabilidad.' });
                }
                const sessionKey = sessionId || senderPhone || 'default';
                // Límite total por respuesta (cuenta imágenes ya encoladas de otras joyas en este turno).
                const alreadyQueued = pendingImagesMap.get(sessionKey)?.length || 0;
                const images = limitProductImages(allImages, alreadyQueued, config.BOT_MAX_IMAGES);
                if (images.length === 0) {
                    return JSON.stringify({
                        success: false,
                        error: `Ya se alcanzó el máximo de ${MAX_PRODUCT_IMAGES_PER_RESPONSE} imagen por respuesta.`,
                        instructions_for_ai: 'No envíes más fotos en esta respuesta. Ofrece enviar las de esta joya en el siguiente mensaje.'
                    });
                }
                const productInfo = await getProductById(args.product_id, storeId);
                const baseName = productInfo ? productInfo.name : 'Joya';
                // Pieza disponible: la foto lleva el enlace para comprarla y pagarla en la tienda.
                const buyLink = productInfo && productInfo.stock > 0 && productInfo.url ? productInfo.url : '';
                let sent = 0;

                for (let i = 0; i < images.length; i++) {
                    const imageUrl = images[i];
                    const caption = i === 0
                        ? (buyLink ? `📸 ${baseName}\nCompra aquí: ${buyLink}` : `📸 ${baseName}`)
                        : undefined;
                    try {
                        if (imageUrl.startsWith('data:')) {
                            queueImage(sessionKey, imageUrl, caption);
                        } else {
                            const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
                            const contentType = String(response.headers['content-type'] || 'image/jpeg');
                            const base64 = Buffer.from(response.data).toString('base64');
                            if (!pendingImagesMap.has(sessionKey)) {
                                pendingImagesMap.set(sessionKey, []);
                            }
                            pendingImagesMap.get(sessionKey)!.push({ mimetype: contentType, base64, caption });
                        }
                        sent++;
                    } catch (dlErr: any) {
                        logger.error(`Error descargando imagen ${i + 1} de ${baseName}: ${dlErr.message}`);
                    }
                }

                if (sent === 0) {
                    return JSON.stringify({
                        success: false,
                        error: 'No se pudieron cargar las fotos de esta joya.',
                        instructions_for_ai: 'NO digas que enviaste la foto. Dile al cliente que en este momento no pudiste cargarla y ofrécele los detalles de la pieza.'
                    });
                }

                const remaining = allImages.length - sent;
                return JSON.stringify({
                    success: true,
                    message: `Se enviarán ${sent} imagen(es) de ${baseName} junto con tu respuesta.`,
                    instructions_for_ai: remaining > 0
                        ? `Las fotos principales se envían con tu respuesta. Hay ${remaining} foto(s) más de esta joya: ofrécelas solo si el cliente quiere ver más. Continúa tu respuesta de texto normalmente.`
                        : (buyLink
                            ? 'La foto se envía con el nombre de la pieza y su enlace para comprarla: no repitas el enlace. Responde solo con una pregunta corta, por ejemplo "¿Te ayudo con algo más?". No ofrezcas cita ni llamada.'
                            : 'Las fotos se envían con tu respuesta. Continúa tu respuesta de texto normalmente.')
                });
            }

            // ── Agendar cita en el calendario propio (bot.appointments) ──
            case 'schedule_appointment': {
                const { client_name, date, time: rawTime, appointment_type, property_reference, phone, modalidad } = args as {
                    client_name: string;
                    date: string;
                    time: string;
                    appointment_type: 'asesoria_presencial' | 'producto_bajo_pedido';
                    property_reference?: string;
                    phone?: string;
                    modalidad?: AppointmentMode;
                };

                const isCall = modalidad === 'llamada';
                const { city: effectiveCity, address: effectiveAddress } = appointmentPlace(modalidad);
                const effectiveReference = property_reference?.trim()
                    || await getWebLeadProductReference(sessionId, storeId)
                    || 'Asesoría general';

                if (!client_name?.trim() || !date?.trim() || !rawTime?.trim() || !phone?.trim() || !appointment_type) {
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'Faltan datos obligatorios para registrar la cita. Asegúrate de tener nombre completo, teléfono, fecha y hora.'
                    });
                }

                const normalizedPhone = normalizeColombianMobile(phone);
                if (!normalizedPhone) {
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'El número de teléfono proporcionado no es válido. Debe ser un número de celular de 10 dígitos (por ejemplo, 3123456789). Dile al cliente que por favor proporcione un número de celular válido de 10 dígitos para continuar.'
                    });
                }

                if (sessionId && await checkPendingAppointment(storeId, senderPhone)) {
                    return JSON.stringify({
                        success: false,
                        error: 'Solicitud ya agendada previamente',
                        instructions_for_ai: 'Este cliente ya tiene una cita o llamada pendiente. No agendes otra: si quiere cambiarla, usa reschedule_appointment con la nueva fecha y hora.'
                    });
                }

                const time = normalizeTime(rawTime);
                const problem = checkSlot(date.trim(), time, { earliest: 'tomorrow' });
                if (problem) {
                    return JSON.stringify({
                        success: false,
                        error: problem.code,
                        instructions_for_ai: `${problem.message} Las citas son ${APPOINTMENT_HOURS}, desde mañana. Díselo al cliente con amabilidad y pídele otra fecha u hora.`
                    });
                }

                const created = await createAppointment({
                    storeId,
                    sessionPhone: senderPhone,
                    clientName: client_name.trim(),
                    phone: normalizedPhone,
                    date: date.trim(),
                    time,
                    city: effectiveCity,
                    address: effectiveAddress,
                    appointmentType: appointment_type,
                    reference: effectiveReference,
                    source: 'bot',
                });

                if (!created.ok) {
                    return JSON.stringify(created.reason === 'taken'
                        ? { success: false, error: 'Horario ocupado', instructions_for_ai: `El horario de las ${time} del ${date} ya está reservado. Dile al cliente que ese espacio no está disponible e invítalo a elegir otra hora en punto (${APPOINTMENT_HOURS}) u otro día.` }
                        : { success: false, instructions_for_ai: 'Hubo un problema técnico al registrar la cita. Dile al cliente que un asesor de Mr. 18Kilates lo contactará pronto para confirmarla.' });
                }

                if (sessionId) await setSessionAppointmentFlag(sessionId, true);
                await createNotification({
                    kind: isCall ? 'llamada_agendada' : 'cita_nueva',
                    storeId,
                    sessionId,
                    phone: normalizedPhone,
                    clientName: client_name.trim(),
                    detail: `${date.trim()} ${time} · ${effectiveReference}`,
                    appointmentId: created.id,
                });

                const contactInfo = 'Si necesitas cambiarla, escríbeme por aquí.';
                return JSON.stringify({
                    success: true,
                    confirmed_date: date.trim(),
                    confirmed_time: time,
                    city: effectiveCity,
                    instructions_for_ai: isCall
                        ? `La llamada quedó agendada. Confirma al cliente en una frase corta que un asesor lo llamará el ${date} a las ${time} al ${normalizedPhone}. ${contactInfo}`
                        : `La cita presencial quedó registrada en ${effectiveCity}, ${effectiveAddress}. Confirma al cliente en una frase corta la fecha ${date}, la hora ${time} y la dirección. ${contactInfo}`
                });
            }

            case 'reschedule_appointment': {
                const pending = await getPendingAppointment(storeId, senderPhone);
                if (!pending) {
                    return JSON.stringify({ success: false, instructions_for_ai: 'No encontré una cita futura asociada a este número de WhatsApp. Si desea agendar, inicia el flujo de atención presencial.' });
                }

                const { date, time: rawTime } = args as { date?: string; time?: string };
                const time = normalizeTime(rawTime || '');
                const problem = date ? checkSlot(date.trim(), time, { earliest: 'tomorrow' }) : { message: 'Falta la fecha.' };
                if (problem) {
                    return JSON.stringify({ success: false, instructions_for_ai: `${problem.message} Propón otra fecha de lunes a viernes, ${APPOINTMENT_HOURS}.` });
                }

                const moved = await updateAppointment(pending.id, { date: date!.trim(), time });
                if (!moved.ok) {
                    return JSON.stringify(moved.reason === 'taken'
                        ? { success: false, error: 'Horario ocupado', instructions_for_ai: 'Ese horario ya está ocupado. Pide otra hora o fecha.' }
                        : { success: false, instructions_for_ai: 'No pude reprogramar la cita por un problema técnico. Un asesor te ayudará a confirmarla.' });
                }

                const pendingIsCall = pending.city === CALL_APPOINTMENT_CITY;
                await createNotification({
                    kind: 'cita_reprogramada',
                    storeId,
                    sessionId,
                    phone: pending.phone,
                    clientName: pending.clientName,
                    detail: `${pending.date} ${pending.time} → ${date!.trim()} ${time}${pendingIsCall ? ' (llamada)' : ''}`,
                    appointmentId: pending.id,
                });

                return JSON.stringify({ success: true, confirmed_date: date, confirmed_time: time, instructions_for_ai: pendingIsCall
                    ? `La llamada fue reprogramada: un asesor llamará al cliente el ${date} a las ${time}.`
                    : `La cita fue reprogramada para el ${date} a las ${time} en ${APPOINTMENT_ADDRESS}, ${APPOINTMENT_CITY}.` });
            }

            // ── «Llámenme» o «quiero hablar con un asesor», sin hora fija ──
            case 'request_human_contact': {
                const { via, motivo, nombre } = args as { via?: 'llamada' | 'chat'; motivo?: string; nombre?: string };
                const callable = normalizeColombianMobile(senderPhone);
                const wantsCall = via !== 'chat';
                await createNotification({
                    kind: wantsCall ? 'llamar_ya' : 'pide_asesor',
                    storeId,
                    sessionId,
                    phone: callable || senderPhone,
                    clientName: (nombre || '').trim(),
                    detail: (motivo || '').trim() || (wantsCall ? 'Pide que lo llamen' : 'Pide hablar con un asesor'),
                });
                return JSON.stringify({
                    success: true,
                    instructions_for_ai: wantsCall
                        ? (callable
                            ? `Ya avisé al equipo. Dile al cliente en una frase corta que un asesor lo llamará lo antes posible al ${callable}, ${APPOINTMENT_HOURS}.`
                            : 'Ya avisé al equipo. Pídele al cliente un número de celular de 10 dígitos para que el asesor lo llame.')
                        : 'Ya avisé al equipo. Dile al cliente en una frase corta que un asesor le escribirá por aquí lo antes posible.',
                });
            }

            // ── Cotización: la hace un empleado y responde por este chat ──
            case 'request_quote': {
                const { pieza, detalles, nombre } = args as { pieza?: string; detalles?: string; nombre?: string };
                const what = (pieza || '').trim() || 'Pieza sin describir';
                const extra = (detalles || '').trim();
                const key = sessionId || `${storeId}_${senderPhone}`;
                if (!isRepeatedQuote(key)) {
                    await createNotification({
                        kind: 'cotizacion',
                        storeId,
                        sessionId,
                        phone: normalizeColombianMobile(senderPhone) || senderPhone,
                        clientName: (nombre || '').trim(),
                        detail: extra ? `${what} — ${extra}` : what,
                    });
                }
                return JSON.stringify({
                    success: true,
                    instructions_for_ai: `Ya avisé al equipo. Dile al cliente en una frase corta que un asesor le enviará la cotización por este chat, ${APPOINTMENT_HOURS}. No le des precio ni tiempo de entrega.`,
                });
            }

            // ── Estado de una reparación (taller de la tienda) ─────────
            case 'check_repair_status': {
                // El celular sale del webhook, nunca de los argumentos de la IA.
                return await checkRepairStatus(args || {}, {
                    sessionKey: sessionId || `${storeId}_${senderPhone}`,
                    senderPhone,
                });
            }

            // ── Cerrar conversación ─────────────────────────────────────
            case 'close_conversation': {
                logger.info(`Cerrando conversación ${sessionId}: ${args.reason}`);
                if (sessionId && systemPrompt) {
                    await clearSession(sessionId, storeId, senderPhone, systemPrompt);
                }
                return JSON.stringify({
                    success: true,
                    instructions_for_ai: 'La conversación fue cerrada. Despídete amablemente y dile que puede escribir cuando quiera para una nueva consulta.'
                });
            }

            default:
                return JSON.stringify({ error: `Función "${name}" no reconocida.` });
        }

    } catch (error: any) {
        logger.error(`Error ejecutando tool ${name}: ${error.message}`);
        return JSON.stringify({ error: `Error inesperado al procesar "${name}". Intenta de nuevo.` });
    }
}
