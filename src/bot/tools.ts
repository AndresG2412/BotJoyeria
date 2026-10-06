import OpenAI from 'openai';
import { searchProducts, filterProducts, getProductById, getProductRawImages } from '../data/catalog';
import { config } from '../config/env';
import { clearSession, getSession, setSessionAppointmentFlag, checkPendingAppointment, getPendingAppointment, updateAppointmentSchedule, saveAppointment, getMemory } from '../data/database';
import { google } from 'googleapis';
import { logger } from '../utils/logger';
import { sendAppointmentNotification } from '../utils/mailer';
import { isWeekend, isHoliday, nextBusinessDay } from '../utils/holidays';
import axios from 'axios';
import path from 'path';
import { APPOINTMENT_ADDRESS, APPOINTMENT_CITY, APPOINTMENT_DURATION_MINUTES, APPOINTMENT_HOURS, availabilityInstruction, availabilityLabel, isValidAppointmentTime } from './policies';
import { parseWebProductLead } from '../utils/web-product';

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
        const product = await getProductById(lead.productId, storeId);
        return product ? `${product.name} — Ref: ${lead.productId}` : lead.productId;
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
                 'Registra una cita de atención presencial en Pitalito en Google Calendar.',
                 'SOLO llama esta función cuando el cliente haya proporcionado nombre completo, fecha y hora.',
                'REGLAS ESTRICTAS:',
                 `- La cita dura ${APPOINTMENT_DURATION_MINUTES} minutos aproximadamente. La asesoría puede tardar más si el cliente aún está explorando opciones.`,
                 '- La fecha debe ser MÍNIMO el día siguiente al de hoy.',
                 `- SOLO se atiende presencialmente en ${APPOINTMENT_CITY}, ${APPOINTMENT_ADDRESS}. Horario: ${APPOINTMENT_HOURS}.`,
                 '- SOLO se agendan días hábiles: de lunes a viernes, NUNCA sábados, domingos ni días festivos.',
                 '- La hora de inicio debe ser en punto. Las franjas válidas son 08:00–12:00 y 14:00–18:00. NUNCA permitas minutos.',
                '- NUNCA modifiques ni canceles citas existentes. Solo crea nuevas.',
                '- NUNCA reveles información de citas de otros clientes ni de sus fechas.',
                '',
                'DATOS:',
                 '- Necesitas del cliente: client_name, phone, date y time.',
                 `- city siempre es ${APPOINTMENT_CITY}; address siempre es ${APPOINTMENT_ADDRESS}. No preguntes ciudad de envío.`,
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
                         description: 'Tipo de cita presencial.'
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
                 required: ['client_name', 'phone', 'date', 'time', 'appointment_type']
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
    logger.info(`Ejecutando tool: ${name}`, args);

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
                    instrucciones: 'Presenta SOLO una pieza con nombre y precio, en una línea y sin listas. Si el stock es 0, indica que es bajo pedido y que debe separar cita o visitar personalmente para confirmar. Si pide más detalles, usa get_product_details. Si pide foto, usa send_product_image.'
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
                        ? 'Presenta solo esta pieza con nombre y precio. Si pide detalles usa get_product_details; si pide foto usa send_product_image.'
                        : 'Presenta solo esta pieza e indica que está disponible bajo pedido y que debe separar una cita presencial para confirmar disponibilidad.',
                });
            }

            // ── Detalle de una propiedad ────────────────────────────────
            case 'get_product_details': {
                const product = await getProductById(args.id, storeId);
                if (!product) return JSON.stringify({ error: 'No se encontró la propiedad con ese ID.' });
                return JSON.stringify({
                    ...product,
                    disponibilidad: availabilityLabel(product.stock),
                    instrucciones_disponibilidad: availabilityInstruction(product.stock),
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
                let sent = 0;

                for (let i = 0; i < images.length; i++) {
                    const imageUrl = images[i];
                    const caption = i === 0 ? `📸 ${baseName}` : undefined;
                    try {
                        if (imageUrl.startsWith('data:')) {
                            queueImage(sessionKey, imageUrl, caption);
                        } else {
                            const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
                            const contentType = response.headers['content-type'] || 'image/jpeg';
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
                        : 'Las fotos se envían con tu respuesta. Continúa tu respuesta de texto normalmente.'
                });
            }

            // ── Agendar cita en Google Calendar ────────────────────────
            case 'schedule_appointment': {
                const { client_name, date, time, appointment_type, property_reference, phone } = args as {
                    client_name: string;
                    date: string;
                    time: string;
                    appointment_type: 'asesoria_presencial' | 'producto_bajo_pedido';
                    property_reference?: string;
                    phone?: string;
                };

                const effectiveCity = APPOINTMENT_CITY;
                const effectiveAddress = APPOINTMENT_ADDRESS;
                const effectiveReference = property_reference?.trim()
                    || await getWebLeadProductReference(sessionId, storeId)
                    || 'Asesoría general';

                if (
                    !client_name || !client_name.trim() ||
                    !date || !date.trim() ||
                    !time || !time.trim() ||
                    !phone || !phone.trim() ||
                    !appointment_type
                ) {
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'Faltan datos obligatorios para registrar la cita. Asegúrate de tener nombre completo, teléfono, fecha y hora.'
                    });
                }

                // ── Validar que el número de teléfono sea válido (10 dígitos colombianos) ──
                const cleanPhone = phone.replace(/\D/g, '');
                const normalizedPhone = (cleanPhone.startsWith('57') && cleanPhone.length === 12)
                    ? cleanPhone.slice(2)
                    : cleanPhone;

                if (normalizedPhone.length !== 10) {
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'El número de teléfono proporcionado no es válido. Debe ser un número de celular de 10 dígitos (por ejemplo, 3123456789). Dile al cliente que por favor proporcione un número de celular válido de 10 dígitos para continuar.'
                    });
                }

                // ── Verificar si ya hay una cita agendada en la base de datos o en la sesión ──
                if (sessionId) {
                    const hasApp = await checkPendingAppointment(storeId, senderPhone);
                    if (hasApp) {
                        const email = pqrEmail || adminCalendarEmail || 'el correo del administrador';
                        return JSON.stringify({
                            success: false,
                            error: 'Solicitud ya agendada previamente',
                            instructions_for_ai: `Ya existe un registro de venta previamente agendado en este chat. No puedes agendar otra ni modificarla. Dile al cliente de forma muy amable que para cambiar o coordinar debe contactar al correo del administrador: ${email}`
                        });
                    }
                }

                // ── Validaciones de negocio iniciales ──
                const [year, month, day] = date.split('-').map(Number);
                const [hour, minute] = time.split(':').map(Number);

                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                tomorrow.setHours(0, 0, 0, 0);

                const appointmentDate = new Date(year, month - 1, day);

                if (appointmentDate < tomorrow) {
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'La fecha solicitada es hoy o en el pasado. Dile al cliente que la atención presencial más próxima disponible es mañana y pregúntale qué día le queda bien.'
                    });
                }

                // ── Validar que el día sea hábil (lunes a viernes, sin festivos) ──
                if (isWeekend(appointmentDate) || isHoliday(appointmentDate)) {
                    const nextBusiness = nextBusinessDay(appointmentDate);
                    const nextBusinessStr = `${nextBusiness.getFullYear()}-${String(nextBusiness.getMonth() + 1).padStart(2, '0')}-${String(nextBusiness.getDate()).padStart(2, '0')}`;
                    const dayName = isWeekend(appointmentDate)
                        ? 'fin de semana (sábado o domingo)'
                        : 'un día festivo';
                    return JSON.stringify({
                        success: false,
                        error: 'Día no hábil',
                        instructions_for_ai: `La fecha solicitada (${date}) cae en ${dayName}. Las citas solo se agendan de lunes a viernes y no se programan en días festivos. Dile esto al cliente de forma muy amable y propónle directamente el siguiente día hábil disponible: ${nextBusinessStr}. Si el cliente quiere otro día, que elija un día entre lunes y viernes.`
                    });
                }

                if (!isValidAppointmentTime(time)) {
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'La hora solicitada no es válida. Las citas se programan de lunes a viernes, en horas exactas entre 8:00 AM y 12:00 PM o entre 2:00 PM y 6:00 PM. Dile al cliente que elija una hora en punto dentro de esas franjas.'
                    });
                }
                if (!adminCalendarEmail) {
                    logger.warn(`schedule_appointment: sin adminCalendarEmail para storeId ${storeId}`);
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'No hay calendario configurado. Dile al cliente que un asesor de Mr. 18Kilates lo contactará pronto para confirmar la venta.'
                    });
                }

                // ── Flujo con Google Calendar API ──
                try {
                    const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH
                        ? path.resolve(process.cwd(), process.env.GOOGLE_SERVICE_ACCOUNT_PATH)
                        : path.resolve(process.cwd(), 'google-service-account.json');
                    const auth = new google.auth.GoogleAuth({
                        keyFile: keyFilePath,
                        scopes: ['https://www.googleapis.com/auth/calendar'],
                    });
                    const calendar = google.calendar({ version: 'v3', auth });

                    const typeLabels: Record<string, string> = {
                        asesoria_presencial: 'Asesoría presencial',
                        producto_bajo_pedido: 'Producto bajo pedido',
                    };

                    const startTime = new Date(year, month - 1, day, hour, minute);
                    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // Duración fija: 1 hora

                    // ── VERIFICACIÓN DE DISPONIBILIDAD (Cruces de Horarios) ──
                    const existingEvents = await calendar.events.list({
                        calendarId: adminCalendarEmail,
                        timeMin: startTime.toISOString(),
                        timeMax: endTime.toISOString(),
                        singleEvents: true,
                        maxResults: 1
                    });

                    if (existingEvents.data.items && existingEvents.data.items.length > 0) {
                        logger.warn(`Conflicto de horario detectado para la fecha ${date} a las ${time}`);
                        return JSON.stringify({
                            success: false,
                            error: 'Horario ocupado',
                            instructions_for_ai: `El horario de las ${time} del día ${date} ya está reservado. Dile de forma muy amable al cliente que ese espacio no está disponible e invítalo a proponer otra hora (en punto entre la 1:00 PM y las 5:00 PM) u otra fecha.`
                        });
                    }

                    // ── Crear evento si el horario está libre ──
                    const createdEvent = await calendar.events.insert({
                        calendarId: adminCalendarEmail,
                        requestBody: {
                            summary: `${typeLabels[appointment_type]} (${effectiveCity}) — ${client_name}`,
                            description: [
                                `Cliente: ${client_name}`,
                                `Atención presencial: ${effectiveCity}`,
                                phone ? `WhatsApp: ${phone}` : '',
                                `Joya/interés: ${effectiveReference}`,
                                `Dirección: ${effectiveAddress}`,
                                `Tipo: ${typeLabels[appointment_type]}`,
                                `Agendado automáticamente vía bot de WhatsApp — Mr. 18Kilates`,
                            ].filter(Boolean).join('\n'),
                            start: { dateTime: startTime.toISOString(), timeZone: 'America/Bogota' },
                            end: { dateTime: endTime.toISOString(), timeZone: 'America/Bogota' },
                        },
                    });

                    const saved = await saveAppointment(storeId, senderPhone, {
                        clientName: client_name,
                        city: effectiveCity,
                        date,
                        time,
                        appointmentType: appointment_type,
                        propertyReference: effectiveReference,
                        address: effectiveAddress,
                        phone: phone || '',
                        calendarEventId: createdEvent.data.id || undefined,
                        status: 'scheduled',
                        createdAt: new Date()
                    });

                    if (!saved) {
                        if (createdEvent.data.id) {
                            await calendar.events.delete({ calendarId: adminCalendarEmail, eventId: createdEvent.data.id }).catch(() => undefined);
                        }
                        return JSON.stringify({
                            success: false,
                            instructions_for_ai: 'La cita no pudo guardarse correctamente. Dile al cliente que hubo un problema técnico y que un asesor lo contactará para confirmarla.'
                        });
                    }

                    // ── Guardar flag de cita y notificar solo después de persistir ──
                    if (sessionId) await setSessionAppointmentFlag(sessionId, true);
                    sendAppointmentNotification({
                        adminEmail: adminCalendarEmail,
                        clientName: client_name,
                        city: effectiveCity,
                        date,
                        time,
                        appointmentType: appointment_type,
                        phone,
                        propertyReference: effectiveReference,
                        address: effectiveAddress,
                    });

                    const contactInfo = pqrEmail
                        ? `Si necesitas cambiar o cancelar, escríbenos al correo ${pqrEmail} o espera a que un asesor te contacte.`
                        : 'Si necesitas cambiar o cancelar, espera a que un asesor de Mr. 18Kilates te contacte.';

                    return JSON.stringify({
                        success: true,
                        confirmed_date: date,
                        confirmed_time: time,
                        city: effectiveCity,
                        contact_info: contactInfo,
                        instructions_for_ai: `La cita presencial quedó registrada en ${effectiveCity}, ${effectiveAddress}. Confirma al cliente la fecha ${date} y hora ${time}. Explica que dura aproximadamente una hora, aunque la asesoría puede tardar más si aún está explorando opciones. ${contactInfo}`
                    });

                } catch (calErr: any) {
                    logger.error(`Error creando evento en Google Calendar:`, calErr.message);
                    if (calErr.response?.data) {
                        logger.error(`Detalles del error de Calendar API:`, JSON.stringify(calErr.response.data));
                    }
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'Hubo un error técnico al registrar la cita. Dile al cliente que un asesor de Mr. 18Kilates lo contactará pronto para confirmar manualmente.'
                    });
                }
            }

            case 'reschedule_appointment': {
                const pending = await getPendingAppointment(storeId, senderPhone);
                if (!pending) {
                    return JSON.stringify({ success: false, instructions_for_ai: 'No encontré una cita futura asociada a este número de WhatsApp. Si desea agendar, inicia el flujo de atención presencial.' });
                }
                if (!pending.calendarEventId) {
                    return JSON.stringify({ success: false, instructions_for_ai: 'La cita existente no tiene identificador de calendario. Un asesor debe ayudar a reprogramarla manualmente.' });
                }

                const { date, time } = args as { date?: string; time?: string };
                if (!date || !time || !isValidAppointmentTime(time)) {
                    return JSON.stringify({ success: false, instructions_for_ai: 'La nueva fecha u hora no es válida. Usa un día hábil y una hora exacta entre 8:00 AM–12:00 PM o 2:00 PM–6:00 PM.' });
                }

                const [year, month, day] = date.split('-').map(Number);
                const newDate = new Date(year, month - 1, day);
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                tomorrow.setHours(0, 0, 0, 0);
                if (newDate < tomorrow || isWeekend(newDate) || isHoliday(newDate)) {
                    return JSON.stringify({ success: false, instructions_for_ai: 'La nueva fecha debe ser un día hábil posterior a hoy. Propón otra fecha de lunes a viernes.' });
                }

                if (!adminCalendarEmail) {
                    return JSON.stringify({ success: false, instructions_for_ai: 'No hay calendario configurado. Un asesor debe confirmar la reprogramación manualmente.' });
                }

                try {
                    const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH
                        ? path.resolve(process.cwd(), process.env.GOOGLE_SERVICE_ACCOUNT_PATH)
                        : path.resolve(process.cwd(), 'google-service-account.json');
                    const auth = new google.auth.GoogleAuth({ keyFile: keyFilePath, scopes: ['https://www.googleapis.com/auth/calendar'] });
                    const calendar = google.calendar({ version: 'v3', auth });
                    const startTime = new Date(year, month - 1, day, Number(time.split(':')[0]), 0);
                    const endTime = new Date(startTime.getTime() + APPOINTMENT_DURATION_MINUTES * 60 * 1000);
                    const existingEvents = await calendar.events.list({
                        calendarId: adminCalendarEmail,
                        timeMin: startTime.toISOString(),
                        timeMax: endTime.toISOString(),
                        singleEvents: true,
                        maxResults: 2,
                    });
                    const unrelatedEvent = (existingEvents.data.items || []).some(event => event.id !== pending.calendarEventId);
                    if (unrelatedEvent) {
                        return JSON.stringify({ success: false, error: 'Horario ocupado', instructions_for_ai: 'Ese horario ya está ocupado. Pide otra hora o fecha.' });
                    }

                    await calendar.events.patch({
                        calendarId: adminCalendarEmail,
                        eventId: pending.calendarEventId,
                        requestBody: {
                            start: { dateTime: startTime.toISOString(), timeZone: 'America/Bogota' },
                            end: { dateTime: endTime.toISOString(), timeZone: 'America/Bogota' },
                        },
                    });

                    const updated = await updateAppointmentSchedule(storeId, senderPhone, pending.id, date, time, pending.calendarEventId);
                    if (!updated) {
                        return JSON.stringify({ success: false, instructions_for_ai: 'El calendario se actualizó, pero la base de datos no confirmó el cambio. Un asesor debe revisar la cita.' });
                    }

                    sendAppointmentNotification({
                        adminEmail: adminCalendarEmail,
                        clientName: pending.clientName,
                        city: APPOINTMENT_CITY,
                        date,
                        time,
                        appointmentType: pending.appointmentType,
                        phone: pending.phone,
                        propertyReference: pending.propertyReference,
                        address: APPOINTMENT_ADDRESS,
                    });

                    return JSON.stringify({ success: true, confirmed_date: date, confirmed_time: time, instructions_for_ai: `La cita fue reprogramada para el ${date} a las ${time} en ${APPOINTMENT_ADDRESS}, ${APPOINTMENT_CITY}.` });
                } catch (error: any) {
                    logger.error(`Error reprogramando cita: ${error.message}`);
                    return JSON.stringify({ success: false, instructions_for_ai: 'No pude reprogramar la cita por un problema técnico. Un asesor te ayudará a confirmarla.' });
                }
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
