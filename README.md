# Bot de Joyeria - Mr. 18Kilates

Bot conversacional con IA para atencion al cliente via WhatsApp Cloud API oficial, Telegram y panel web.

## Requisitos

- **Node.js** >= 18
- **Base de la tienda** (Supabase) con el esquema `bot` creado (`supabase/002_bot_schema.sql`)
- **Google AI Studio** o proveedor compatible con la API de OpenAI
- **Cuenta de Meta Developer** (para WhatsApp Cloud API)
- **Cuenta de Resend** (para notificaciones por email, opcional)
- **Google Cloud** con Calendar API habilitada (opcional, para agendar citas)
- **Ngrok** (opcional, para desarrollo local con webhooks)

## Instalacion

```bash
# 1. Clonar el repositorio
git clone <url-del-repo>
cd BotJoyeria

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
copy .env.example .env
# Editar .env con tus credenciales reales

# 4. Compilar
npm run build

# 5. Iniciar
npm start
```

## Configuracion (.env)

Copia `.env.example` a `.env` y completa **todas** las variables marcadas como REQUERIDO.

### Credenciales minimas para funcionar:

| Variable | Descripcion |
|---|---|
| `OPENAI_API_KEY` | API key del proveedor compatible configurado en `OPENAI_BASE_URL` |
| `OPENAI_BASE_URL` | URL compatible con la API de OpenAI, por ejemplo Google AI Studio |
| `BOT_DATABASE_URL` | Conexion al esquema `bot` de la base de la tienda con el rol `bot_joyeria` (ver `supabase/README.md`) |
| `BOT_DATABASE_CA_PATH` | (Opcional) Certificado de Supabase; por defecto `supabase-ca.crt` en la raiz |
| `BOT_SESSION_RETENTION_DAYS` | (Opcional) Dias sin actividad tras los que se borra un chat (Ley 1581). Default 90; las citas se conservan |
| `SITE_URL` | (Opcional) Tienda de donde se lee el catalogo. Default `https://www.mr18kts.online` |
| `META_ACCESS_TOKEN` | Token de WhatsApp Cloud API |
| `META_PHONE_ID` | Phone Number ID de WhatsApp |
| `META_WABA_ID` | WhatsApp Business Account ID |
| `META_APP_SECRET` | App Secret para validar la firma del webhook |
| `META_VERIFY_TOKEN` | Token elegido para verificar el webhook en Meta |
| `META_API_VERSION` | Version de Graph API usada por el proyecto |
| `RESEND_API_KEY` | (Opcional) API Key de Resend para emails |
| `STORE_NAME` | Nombre de la tienda (ej: "Mr. 18Kilates") |
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | Credenciales del panel de control |

### Comportamiento del bot en WhatsApp (opcional)

| Variable | Default | Descripcion |
|---|---|---|
| `WHATSAPP_BATCH_QUIET_MS` | `3000` | Silencio a esperar tras el ultimo mensaje del cliente antes de responder |
| `WHATSAPP_BATCH_MAX_WAIT_MS` | `10000` | Espera maxima desde el primer mensaje agrupado |
| `BOT_MAX_CONCURRENT_CONVERSATIONS` | `5` | Conversaciones procesandose con la IA al mismo tiempo |
| `BOT_MAX_TEXT_MESSAGES` | `3` | Maximo de mensajes de texto por respuesta |
| `BOT_MAX_IMAGES` | `3` | Maximo de imagenes por respuesta |

Los mensajes consecutivos de un cliente se agrupan y se envian juntos a la IA. Cada conversacion
(tienda + numero del negocio + cliente) tiene su propia cola: los mensajes de un mismo cliente se
procesan en orden y clientes distintos se atienden en paralelo.

### Salud de WhatsApp Cloud API

- `GET /dashboard/api/whatsapp/health/:storeId` (requiere login): estado (`OPERATIVA`,
  `CONFIGURACION_INCOMPLETA` o `ERROR`), numero, variables faltantes, ultimo webhook, ultimo
  mensaje enviado, ultima respuesta de Graph API y ultimo error (incluye fallos de entrega que
  Meta reporta por webhook). Los registros viven en memoria y se reinician con el servidor.
- `GET /health` (publico): solo indica que el proceso esta vivo.

### Catalogo

El bot no guarda piezas propias: lee las **publicadas** en la tienda
(`GET ${SITE_URL}/api/products` y `/api/categorias`), sin credenciales, y las guarda en memoria
5 minutos (`CATALOG_CACHE_MS`). Si la tienda no responde, sigue usando la ultima copia buena.
Las piezas, precios, fotos y stock se administran en `${SITE_URL}/admin`; la pestaña Catalogo del
panel del bot es de solo lectura (boton "Actualizar" para forzar la lectura).

### Contacto directo desde la web

El boton "Consultar por WhatsApp" de cada ficha de la tienda envia:

```
Hola, me interesa la pieza: <titulo>[ en Oro amarillo|blanco|rosa]. ¿Me das más info?
```

`parseWebProductLead()` (`src/utils/web-product.ts`) reconoce ese mensaje (y el formato antiguo con
`(Ref: id)` y "vi en la web"), busca la pieza por id, slug o nombre exacto y responde directamente sin
pasar por la IA. Si el cliente confirma la pieza, el flujo normal solicita nombre, telefono, fecha y
hora; la cita se registra siempre en Pitalito, en Calle 4 #1-31, incluyendo el producto de interes.

Las imagenes del catalogo se guardan en WebP; como WhatsApp solo acepta JPEG/PNG en mensajes de
imagen, el bot las convierte a JPEG al enviarlas.

### Google Calendar (opcional)

1. Ve a [Google Cloud Console](https://console.cloud.google.com)
2. Habilita **Google Calendar API**
3. Crea una **Cuenta de Servicio** y descarga el JSON
4. Renombra el archivo a `google-service-account.json` y colocalo en la raiz del proyecto
5. Comparte tu calendario con el email de la cuenta de servicio (con permisos de escritura)

### Telegram

Configura el token del bot directamente en la base de datos (tabla `stores`, columna `telegramToken`). El bot se inicia automaticamente al detectarlo.

## Estructura del Proyecto

```
src/
  app.ts              # Servidor Express + inicio de bots
  bot/
    agent.ts          # Agente conversacional OpenAI
    prompts.ts        # System prompts
    tools.ts          # Tools/Functions disponibles para el LLM
  channels/
    telegram.ts       # Integracion Telegram
    whatsapp-cloud.ts # Integracion oficial WhatsApp Cloud API y webhook
  config/
    env.ts            # Carga y validacion de .env
    supabase.ts       # Cliente de Supabase
  data/
    catalog.ts        # Catalogo leido de la API publica de la tienda (solo lectura, con cache)
    connection.ts     # Conexion Drizzle ORM
    database.ts       # Gestion de sesiones y citas
    schema.ts         # Esquema de base de datos (Drizzle)
  routes/
    dashboard.ts      # API del panel de control
  utils/
    logger.ts         # Logger
    mailer.ts         # Envio de emails (Resend)
public/
    dashboard.html    # Panel de control
    login.html        # Login del panel
    styles.css        # Estilos
```

## Desarrollo Local

```bash
npm run dev     # Inicia con ts-node (hot reload manual)
```

Para desarrollo con WhatsApp Cloud API, necesitas exponer tu puerto local. Usa un dominio HTTPS de ngrok:

```bash
ngrok http --url=https://tu-dominio.ngrok-free.dev 3000
# Configura https://tu-dominio.ngrok-free.dev/webhook/whatsapp como webhook en Meta
```

El servidor no usa QR, WhatsApp Web ni Puppeteer. Meta entrega los mensajes al webhook y el bot responde mediante Graph API.

## Despliegue en VPS

Ver la guia paso a paso en [DEPLOY.md](DEPLOY.md) (PM2, URL fija para el webhook, pruebas y
solucion de problemas).

## Tecnologias

- TypeScript, Node.js, Express
- OpenAI API (GPT-4o-mini)
- Supabase (PostgreSQL + Storage)
- Drizzle ORM
- WhatsApp Cloud API oficial
- Telegram Bot API
- Google Calendar API
- Resend (emails)
