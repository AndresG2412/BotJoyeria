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

### Fase 0 — Proteger el trabajo actual (build) ✅
- `npm run build && npm test`; commit lógico del rework sin commitear.
- Commit: `c2fc425 feat(appointments): scheduling flow with validations, Google Calendar and policies`.
- **Terminado:** `git status` limpio; build y tests en verde.

### Fase 1 — Reparar la persistencia (base de PRUEBA) ✅
- Aplicado en Supabase: `ALTER TABLE public.appointments ADD COLUMN IF NOT EXISTS calendar_event_id text;`
- Corregido `supabase/001_appointments.sql`: quitado el FK a `stores`; queda como plantilla para la base real.
- Commit: `db11b89 feat(calendar): health check dashboard, appointment schema fix and explicit scheduling permission`.

### Fase 2 — Permisos de Calendar visibles en el dashboard del admin ✅
- Creado `src/utils/calendar-health.ts` y endpoint `GET /dashboard/api/calendar/health/:storeId`.
- Nueva tarjeta en el panel con estados `SIN_CONFIGURAR` / `CALENDARIO_NO_COMPARTIDO` / `OPERATIVO` y el `client_email` exacto a compartir.

### Fase 3 — Pulido del flujo de agendar ✅
- Agregado paso de permiso explícito: "¿Me das permiso para agendarte una cita presencial en Pitalito?".
- Confirmación incluye: solo atienden en Pitalito y un asesor llamará horas antes para confirmar.
- `npm run build && npm test` sigue en verde.

### Fase 4 — Verificación E2E en local (calendario de prueba) ⏳
**Pendiente de la parte humana.**
Requisitos para continuar:
1. `google-service-account.json` en la raíz del proyecto (ya está en `.gitignore`).
2. Un calendario de Google de prueba compartido con el `client_email` de ese JSON, con permiso **"Hacer cambios en eventos"**.
3. `adminCalendarEmail` configurado en `data/local-stores.json` vía el dashboard (pestaña "Mis Datos" → "Configurar Citas").

Verificación a realizar:
- Enviar "Hola" al bot (por WhatsApp o con un script directo) y completar el flujo hasta agendar.
- Comprobar que en el panel la tarjeta de Calendar pase a `OPERATIVO`.
- Confirmar que el evento de 1 h aparece en el calendario de prueba con los datos del cliente.
- Confirmar que la fila en `appointments` tiene `calendar_event_id`.
- Confirmar que el cliente recibe la confirmación sin "problema técnico".
- Limpiar el evento y la fila de prueba.
- **Terminado:** registrar fecha y resultado en este documento.

## Fuera de alcance
- Cierre de RLS / clave service role (se retoma al conectar la base real).
- `reschedule_appointment`, recordatorio automático, despliegue y push.

## Riesgos
- Base real ≠ base de prueba: repetir Fase 1 sobre la real cuando se conecte (el `.sql` corregido queda de plantilla).
- Schema cache de PostgREST tras el ALTER: si la prueba falla raro, forzar `NOTIFY pgrst, 'reload schema';`.
- Google puede tardar en propagar el compartir calendario (minutos).
