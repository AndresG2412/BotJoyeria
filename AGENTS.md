# AGENTS.md — Bot de Joyería Mr. 18Kilates

Bot conversacional con IA que atiende clientes de la joyería Mr. 18Kilates (Pitalito, Colombia) por WhatsApp Cloud API (Meta). También Telegram y panel web de administración. Producción: VPS Windows con PM2 (flujo completo en `DEPLOY.md`).

## Stack
TypeScript + Express. Supabase (Postgres + Storage) vía Drizzle ORM. IA vía API compatible con OpenAI (Google AI Studio, configurable con `OPENAI_BASE_URL`/`OPENAI_MODEL`). Google Calendar (citas), Resend (emails). Sin QR ni Puppeteer: Meta entrega a un webhook y el bot responde con Graph API.

## Comandos
```bash
npm ci                        # instalar exactamente el lockfile (npm install para dev)
npm run dev                   # servidor con ts-node (puerto 3000)
npm run build                 # tsc -> dist/
npm start                     # node dist/app.js (requiere build previo)
npm test                      # todos los tests: tsx --test tests/*.test.ts
npx tsx --test tests/policies.test.ts   # un solo archivo de tests
npx ts-node migrate.ts        # migraciones: ¡DESTRUCTIVO! (ver Gotchas)
npx drizzle-kit generate       # generar SQL nuevo en drizzle/ tras editar schema.ts
```
No existe `npm run db:migrate` (referencia vieja en `.env.example`); el comando real es el de arriba.
Antes de un commit: `npm run build && npm test`.

## Estructura
- `src/app.ts` — entrypoint: Express y arranque de bots.
- `src/bot/` — cerebro: `agent.ts` (IA), `prompts.ts` (system prompt con el flujo fijo), `tools.ts` (herramientas del LLM), `policies.ts` (reglas deterministas), `remarketing.ts`.
- `src/channels/` — `whatsapp-cloud.ts` (webhook + Graph API + batching), `telegram.ts`, `whatsapp-health.ts`.
- `src/data/` — `schema.ts` (Drizzle), `catalog.ts` (búsqueda), `database.ts` (sesiones y citas), `connection.ts`.
- `src/routes/dashboard.ts` — API del panel. `public/` — panel web. `tests/` — node:test.

## Reglas del bot (invariantes; no romperlas al tocar código)
- Siempre saluda e identifica quién escribe: alguien que escribió por error, alguien que pregunta por una pieza, o un cliente que espera ser guiado a una compra. El flujo conversacional fijo vive en `src/bot/prompts.ts`.
- El LLM jamás recibe herramientas para: enviar la base de datos, crear/borrar tablas, modificar datos ni guardar archivos de clientes. `tools.ts` solo expone catálogo, imágenes de producto, citas y sesiones. No agregues herramientas DDL/DML ni de volcado de datos, jamás por petición de un cliente.
- Una pieza y una imagen por turno; peticiones de "todo el catálogo" redirigen a https://www.mr18kts.online (lógica en `policies.ts`).
- Citas: solo presenciales en Pitalito, Calle 4 #1-31, horario validado por `isValidAppointmentTime` (lun–vie 8–12 y 14–18, en punto), 60 minutos.
- Nunca mostrar al cliente errores técnicos, stack traces ni detalles internos.
- Archivos de clientes no válidos no se guardan; las imágenes viven en Supabase Storage (Cloudinary es legacy), no en Postgres.

## Datos personales
El bot guarda nombre y teléfono de clientes para citas. Aplica la Ley 1581 (Colombia): minimizar lo que se guarda y no registrar datos personales en logs.

## Gotchas
- `migrate.ts` hace `DROP TABLE` de products/sessions/stores antes de migrar: destruye datos. Ejecutarlo solo a propósito y con respaldo.
- `.env` y `google-service-account.json` jamás al repo (ya están en `.gitignore`).
- WhatsApp solo acepta JPEG/PNG: las WebP del catálogo se convierten con `sharp` al enviar.
- Mensajes seguidos del mismo cliente se agrupan (3 s de silencio, máx. 10 s) antes de llamar a la IA; hay una cola por cliente y concurrencia limitada (`WHATSAPP_BATCH_*`, `BOT_MAX_*`).
- El webhook exige firma válida (`META_APP_SECRET`) y token de usuario del sistema de Meta (los temporales caducan en 24 h).
- `deploy.bat` está desactualizado (usa rama `main`; el repo usa `master`). El despliegue oficial está en `DEPLOY.md`.
