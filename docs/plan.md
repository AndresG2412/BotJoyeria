# Plan — Pulir y verificar la herramienta de agendar citas (`schedule_appointment`)

**Alcance:** SOLO la sección de citas del bot: flujo conversacional, validaciones, Google Calendar, persistencia. Todo contra la base de datos de **PRUEBA** (la real aún no se conecta y tiene otra estructura). Nada de push ni despliegue sin permiso explícito.

## Contexto verificado (2026-10-05)

- **Flujo actual** (`src/bot/prompts.ts:110-148`): pide nombre → confirma teléfono (10 dígitos) → recuerda ubicación/horario (Pitalito, Calle 4 #1-31, lun–vie 8–12/14–18) → pide día y hora → llama `schedule_appointment`. La ciudad nunca se pregunta.
- **Herramienta** (`src/bot/tools.ts:378-595`): valida teléfono, una sola cita activa por número, fecha ≥ mañana, día hábil sin festivos (`holidays.ts`), hora en punto 8–12/14–18 (`policies.ts:20`); crea evento de 1 h en Calendar, guarda en Supabase, notifica por email (Resend).
- **Bug crítico:** la tabla `appointments` de la base de prueba NO tiene la columna `calendar_event_id` y el código la escribe → el guardado falla → el bot **borra el evento de Calendar recién creado** (`tools.ts:548-551`) y el cliente recibe "problema técnico". La cita no queda en ningún lado.
- `supabase/001_appointments.sql` nunca se aplicó y fallaría tal cual: tiene FK a `public.stores` (no existe; la tienda vive en `data/local-stores.json`, que está en `.gitignore`).
- **Permisos de Calendar SÍ hacen falta:** hay que compartir el calendario del admin (`adminCalendarEmail`) con el email de la cuenta de servicio (`client_email` dentro de `google-service-account.json`), con permiso "Hacer cambios en eventos". Hoy nada lo indica en el panel; el error solo aparece al agendar.
- Hay ~607 líneas del rework de citas sin commitear.

## Fases

### Fase 0 — Proteger el trabajo actual (build)
- `npm run build && npm test`; commit lógico del rework sin commitear.
- **Terminado:** `git status` limpio; build y tests en verde.

### Fase 1 — Reparar la persistencia (base de PRUEBA)
- Aplicar: `ALTER TABLE public.appointments ADD COLUMN IF NOT EXISTS calendar_event_id text;`
- Corregir `supabase/001_appointments.sql`: quitar el FK a `stores` y dejarlo como plantilla aplicable a la base real cuando se conecte.
- **Terminado:** una cita de prueba (marcada "PRUEBA") queda en `appointments` con `calendar_event_id` y el evento de Calendar NO se borra. Limpieza de la prueba al final.

### Fase 2 — Permisos de Calendar visibles en el dashboard del admin
- Nueva tarjeta de salud de Calendar en el panel (patrón de `whatsapp-health.ts`): endpoint `GET /dashboard/api/calendar/health` que intenta listar eventos del calendario `adminCalendarEmail`.
- Estados: `SIN_CONFIGURAR` (falta `adminCalendarEmail` o el JSON de la cuenta de servicio) / `CALENDARIO_NO_COMPARTIDO` (403 o 404 de Google) / `OPERATIVO`.
- En `CALENDARIO_NO_COMPARTIDO`, el panel muestra el `client_email` de la cuenta de servicio y la instrucción exacta: "Comparte tu Google Calendar con este correo, con permiso 'Hacer cambios en eventos'".
- **Terminado:** sin compartir el calendario, el panel muestra el correo y el paso a seguir; tras compartirlo, la tarjeta pasa a `OPERATIVO` sin reiniciar.

### Fase 3 — Pulido del flujo de agendar
- Paso de permiso explícito ANTES de pedir datos: "¿Te agendo una cita presencial?" — el bot no pide nombre/teléfono/fecha hasta un sí.
- La confirmación final incluye: solo atienden en Pitalito y un asesor llamará horas antes.
- Se conserva lo que ya funciona: el bot pregunta los datos, ciudad/dirección fijas, horario validado en `policies.ts`.
- **Terminado:** flujo de prueba completo paso a paso + `npm run build && npm test` en verde.

### Fase 4 — Verificación E2E en local (calendario de prueba)
- Requisitos (usuario): `google-service-account.json` en la raíz (ya en `.gitignore`), calendario de prueba compartido a la cuenta de servicio, `adminCalendarEmail` en `data/local-stores.json`.
- Ejercitar `schedule_appointment` con una cita "PRUEBA": evento visible en el calendario (nombre, teléfono, fecha, 1 h), fila en `appointments` con `calendar_event_id`, respuesta sin "problema técnico".
- Limpiar el evento y la fila de prueba.
- **Terminado:** los tres puntos verificados y registrados en este documento (fecha y resultado).

## Fuera de alcance
- Cierre de RLS / clave service role (se retoma al conectar la base real).
- `reschedule_appointment`, recordatorio automático, despliegue y push.

## Riesgos
- Base real ≠ base de prueba: repetir Fase 1 sobre la real cuando se conecte (el `.sql` corregido queda de plantilla).
- Schema cache de PostgREST tras el ALTER: si la prueba falla raro, forzar `NOTIFY pgrst, 'reload schema';`.
- Google puede tardar en propagar el compartir calendario (minutos).
