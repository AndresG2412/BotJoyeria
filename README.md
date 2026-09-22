# Bot de Joyeria - Mr. 18Kilates

Bot conversacional con IA para atencion al cliente via WhatsApp Cloud API oficial, Telegram y panel web.

## Requisitos

- **Node.js** >= 18
- **PostgreSQL** (Supabase recomendado)
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

# 4. Ejecutar migraciones de base de datos, si aplica
npx ts-node migrate.ts

# 5. Compilar
npm run build

# 6. Iniciar
npm start
```

## Configuracion (.env)

Copia `.env.example` a `.env` y completa **todas** las variables marcadas como REQUERIDO.

### Credenciales minimas para funcionar:

| Variable | Descripcion |
|---|---|
| `OPENAI_API_KEY` | API key del proveedor compatible configurado en `OPENAI_BASE_URL` |
| `OPENAI_BASE_URL` | URL compatible con la API de OpenAI, por ejemplo Google AI Studio |
| `SUPABASE_URL` | URL de tu proyecto en Supabase |
| `SUPABASE_ANON_KEY` | Clave anon/publica de Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | (Recomendado) Service role key |
| `DATABASE_URL` | String de conexion PostgreSQL para migraciones |
| `META_ACCESS_TOKEN` | Token de WhatsApp Cloud API |
| `META_PHONE_ID` | Phone Number ID de WhatsApp |
| `META_WABA_ID` | WhatsApp Business Account ID |
| `META_APP_SECRET` | App Secret para validar la firma del webhook |
| `META_VERIFY_TOKEN` | Token elegido para verificar el webhook en Meta |
| `META_API_VERSION` | Version de Graph API usada por el proyecto |
| `RESEND_API_KEY` | (Opcional) API Key de Resend para emails |
| `STORE_NAME` | Nombre de la tienda (ej: "Mr. 18Kilates") |
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | Credenciales del panel de control |

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
    remarketing.ts    # Motor de remarketing
    tools.ts          # Tools/Functions disponibles para el LLM
  channels/
    telegram.ts       # Integracion Telegram
    whatsapp-cloud.ts # Integracion oficial WhatsApp Cloud API y webhook
  config/
    env.ts            # Carga y validacion de .env
    supabase.ts       # Cliente de Supabase
  data/
    catalog.ts        # Busqueda de productos en Supabase
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

## Despliegue en VPS Windows

```bash
iniciar_bot_vps_windows.bat   # Instala, compila e inicia el bot
```

## Tecnologias

- TypeScript, Node.js, Express
- OpenAI API (GPT-4o-mini)
- Supabase (PostgreSQL + Storage)
- Drizzle ORM
- WhatsApp Cloud API oficial
- Telegram Bot API
- Google Calendar API
- Resend (emails)
