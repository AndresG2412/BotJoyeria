import OpenAI from 'openai';
import { searchProducts, getProductById, getAllProducts, getProductRawImages } from '../data/catalog';
import { config } from '../config/env';
import { clearSession, getSession, setSessionAppointmentFlag, checkPendingAppointment, saveAppointment } from '../data/database';
import { google } from 'googleapis';
import { logger } from '../utils/logger';
import { sendAppointmentNotification } from '../utils/mailer';
import { isWeekend, isHoliday, nextBusinessDay } from '../utils/holidays';
import axios from 'axios';
import path from 'path';

// ─────────────────────────────────────────
//  Cola temporal de imágenes pendientes
// ─────────────────────────────────────────
export type PendingImage = { mimetype: string; base64: string; caption?: string };
const pendingImagesMap = new Map<string, PendingImage[]>();

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
        precio: p.price,
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
            name: 'list_all_products',
            description: 'Obtiene todos los productos disponibles en el catálogo de la joyería. Úsalo cuando el cliente pregunte qué joyas hay disponibles en general.',
            parameters: { type: 'object', properties: {}, required: [] }
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
                'Registra la venta y agenda los detalles de envío/coordinación de una joya en Google Calendar.',
                'SOLO llama esta función cuando el cliente haya proporcionado el nombre completo, teléfono y ciudad de envío.',
                'REGLAS ESTRICTAS:',
                '- La fecha y hora deben ser acordadas o asignadas (por defecto para mañana a las 14:00 si el cliente no define, pero valida que sea en horas permitidas).',
                '- La fecha debe ser MÍNIMO el día siguiente al de hoy.',
                '- SOLO se agendan días hábiles: de lunes a viernes, NUNCA sábados, domingos ni días festivos.',
                '- La hora de inicio debe ser en punto (ej: 13:00, 14:00, 15:00, 16:00, 17:00) entre la 1:00 PM (13:00) y las 5:00 PM (17:00) inclusive. NUNCA permitas minutos (como 14:30 o 15:15).',
                '- NUNCA modifiques ni canceles citas existentes. Solo crea nuevas.',
                '- NUNCA reveles información de citas de otros clientes ni de sus fechas.',
                '',
                'DATOS:',
                '- Necesitas del cliente: client_name, phone y city (ciudad de envío).',
                '- property_reference y address son la referencia/nombre de la joya elegida del catálogo. Autocomplétalos con el nombre/ID de la joya (NO se los pidas al cliente).',
            ].join(' '),
            parameters: {
                type: 'object',
                properties: {
                    client_name: {
                        type: 'string',
                        description: 'Nombre completo del cliente.'
                    },
                    city: {
                        type: 'string',
                        description: 'Ciudad de envío de la joya.'
                    },
                    date: {
                        type: 'string',
                        description: 'Fecha en formato YYYY-MM-DD. Debe ser mínimo mañana.'
                    },
                    time: {
                        type: 'string',
                        description: 'Hora en formato HH:MM (24h). Debe estar entre 13:00 y 17:00, y los minutos deben ser 00 (horas en punto).'
                    },
                    appointment_type: {
                        type: 'string',
                        enum: ['venta_joya'],
                        description: 'Tipo de cita: venta_joya.'
                    },
                    property_reference: {
                        type: 'string',
                        description: 'Referencia o nombre de la joya del catálogo a comprar.'
                    },
                    address: {
                        type: 'string',
                        description: 'Referencia o nombre de la joya (usar el mismo valor que property_reference, NO preguntar al cliente).'
                    },
                    phone: {
                        type: 'string',
                        description: 'Número de WhatsApp de 10 dígitos del cliente.'
                    }
                },
                required: ['client_name', 'phone', 'date', 'time', 'appointment_type', 'property_reference', 'city', 'address']
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
                    const all = await getAllProducts(storeId);
                    if (all.length > 0) {
                        return JSON.stringify({
                            nota: 'No hay coincidencias exactas, pero aquí hay otras piezas disponibles:',
                            productos: summarizeProductsBrief(all.slice(0, 10)),
                            instrucciones: 'Presenta SOLO el nombre y el precio de cada pieza, en una línea y sin listas. NUNCA menciones detalles, peso, stock ni características. Si el cliente pide más detalles, usa get_product_details. Si pide foto, usa send_product_image.'
                        });
                    }
                    return JSON.stringify({ error: 'No se encontraron piezas en el catálogo.' });
                }
                return JSON.stringify({
                    productos: summarizeProductsBrief(products),
                    instrucciones: 'Presenta SOLO el nombre y el precio de cada pieza, en una línea y sin listas. NUNCA menciones detalles, peso, stock ni características. Si el cliente pide más detalles, usa get_product_details. Si pide foto, usa send_product_image.'
                });
            }

            // ── Listar todas ────────────────────────────────────────────
            case 'list_all_products': {
                const all = await getAllProducts(storeId);
                return JSON.stringify({
                    productos: summarizeProductsBrief(all),
                    instrucciones: 'Presenta máximo 3 piezas a la vez, SOLO con nombre y precio, en una línea y sin listas. NUNCA menciones detalles, peso, stock ni características. Si el cliente pide más detalles de una, usa get_product_details. Si pide foto, usa send_product_image.'
                });
            }

            // ── Detalle de una propiedad ────────────────────────────────
            case 'get_product_details': {
                const product = await getProductById(args.id, storeId);
                if (!product) return JSON.stringify({ error: 'No se encontró la propiedad con ese ID.' });
                return JSON.stringify(product);
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
                const slots = Math.max(0, config.BOT_MAX_IMAGES - alreadyQueued);
                if (slots === 0) {
                    return JSON.stringify({
                        success: false,
                        error: `Ya se alcanzó el máximo de ${config.BOT_MAX_IMAGES} imágenes por respuesta.`,
                        instructions_for_ai: 'No envíes más fotos en esta respuesta. Ofrece enviar las de esta joya en el siguiente mensaje.'
                    });
                }
                const images = allImages.slice(0, slots);
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
                const { client_name, city, date, time, appointment_type, property_reference, address, phone } = args as {
                    client_name: string;
                    city: string;
                    date: string;
                    time: string;
                    appointment_type: 'venta_joya';
                    property_reference?: string;
                    address?: string;
                    phone?: string;
                };

                const effectiveCity = city?.trim() || 'Por definir';
                const effectiveAddress = address?.trim() || property_reference || 'Joya del catálogo';

                if (
                    !client_name || !client_name.trim() ||
                    !date || !date.trim() ||
                    !time || !time.trim() ||
                    !phone || !phone.trim() ||
                    !property_reference || !property_reference.trim()
                ) {
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'Faltan datos obligatorios para poder registrar la venta y coordinar el envío. Asegúrate de tener: nombre completo, teléfono de contacto de 10 dígitos, ciudad de envío, y la referencia de la joya.'
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
                        instructions_for_ai: 'La fecha solicitada es hoy o en el pasado. Dile al cliente que la coordinación de envío más próxima disponible es mañana y pregúntale qué día le queda bien.'
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

                if (hour < 13 || hour > 17 || minute !== 0) {
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'La hora solicitada no es válida. Las citas se programan únicamente en horas exactas (13:00, 14:00, 15:00, 16:00, 17:00) y la última disponible para iniciar es a las 5:00 PM (17:00). Dile de forma amable al cliente que por favor proporcione una hora en punto (ej. 2:00 PM o 14:00) dentro de este rango.'
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
                        venta_joya: 'Venta de Joya',
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
                    await calendar.events.insert({
                        calendarId: adminCalendarEmail,
                        requestBody: {
                            summary: `${typeLabels[appointment_type]} (${effectiveCity}) — ${client_name}`,
                            description: [
                                `Cliente: ${client_name}`,
                                `Ciudad de Envío: ${effectiveCity}`,
                                phone ? `WhatsApp: ${phone}` : '',
                                property_reference ? `Joya: ${property_reference}` : '',
                                effectiveAddress ? `Detalles/Referencia: ${effectiveAddress}` : '',
                                `Tipo: ${typeLabels[appointment_type]}`,
                                `Agendado automáticamente vía bot de WhatsApp — Mr. 18Kilates`,
                            ].filter(Boolean).join('\n'),
                            start: { dateTime: startTime.toISOString(), timeZone: 'America/Bogota' },
                            end: { dateTime: endTime.toISOString(), timeZone: 'America/Bogota' },
                        },
                    });

                    // ── Notificar al administrador por correo ──
                    sendAppointmentNotification({
                        adminEmail: adminCalendarEmail,
                        clientName: client_name,
                        city: effectiveCity,
                        date,
                        time,
                        appointmentType: appointment_type,
                        phone,
                        propertyReference: property_reference,
                        address: effectiveAddress,
                    });

                    // ── Guardar flag de cita agendada en la sesión y base de datos ──
                    if (sessionId) {
                        await setSessionAppointmentFlag(sessionId, true);
                        await saveAppointment(storeId, senderPhone, {
                            clientName: client_name,
                            city: effectiveCity,
                            date,
                            time,
                            appointmentType: appointment_type,
                            propertyReference: property_reference || '',
                            address: effectiveAddress || '',
                            phone: phone || '',
                            status: 'scheduled',
                            createdAt: new Date()
                        });
                    }

                    const contactInfo = pqrEmail
                        ? `Si necesitas cambiar o cancelar, escríbenos al correo ${pqrEmail} o espera a que un asesor te contacte.`
                        : 'Si necesitas cambiar o cancelar, espera a que un asesor de Mr. 18Kilates te contacte.';

                    return JSON.stringify({
                        success: true,
                        confirmed_date: date,
                        confirmed_time: time,
                        city: effectiveCity,
                        contact_info: contactInfo,
                        instructions_for_ai: `La venta quedó registrada con éxito con destino a ${effectiveCity}. Confirma al cliente: fecha ${date}, hora ${time}, y dile: "${contactInfo}"`
                    });

                } catch (calErr: any) {
                    logger.error(`Error creando evento en Google Calendar:`, calErr.message);
                    if (calErr.response?.data) {
                        logger.error(`Detalles del error de Calendar API:`, JSON.stringify(calErr.response.data));
                    }
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'Hubo un error técnico al registrar el despacho. Dile al cliente que un asesor de Mr. 18Kilates lo contactará pronto para confirmar manualmente.'
                    });
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