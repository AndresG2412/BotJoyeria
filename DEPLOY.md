# Guía de despliegue a producción (VPS)

Paso a paso para dejar el bot funcionando 24/7 en un VPS con una URL fija para el webhook de
WhatsApp Cloud API. Está pensada para un **VPS Windows** (el proyecto ya trae
`iniciar_bot_vps_windows.bat`); al final hay notas para Linux.

> Tiempo estimado: 30–45 minutos la primera vez.

---

## 0. Qué cambió en esta versión (leer antes de desplegar)

- **Imágenes:** el catálogo guarda las fotos en WebP y WhatsApp solo acepta JPEG/PNG. El bot ahora
  las convierte a JPEG al enviarlas (librería `sharp`). Antes Meta las rechazaba sin dejar error.
- **Panel:** se quitaron el QR y los botones "Iniciar/Detener Bot". Ahora muestra el estado real de
  Cloud API (Operativa / Configuración incompleta / Error), el número, el último webhook, el último
  mensaje enviado y el último error.
- **Mensajes seguidos:** se agrupan (3 s de silencio, máximo 10 s) y van en una sola solicitud a la IA.
- **Concurrencia:** una cola por cliente (tienda + número del negocio + cliente) y máximo 5
  conversaciones con la IA al mismo tiempo.
- **Límites:** máximo 3 mensajes de texto y 3 imágenes por respuesta.
- **Variables nuevas (opcionales)** en `.env`: `WHATSAPP_BATCH_QUIET_MS`, `WHATSAPP_BATCH_MAX_WAIT_MS`,
  `BOT_MAX_CONCURRENT_CONVERSATIONS`, `BOT_MAX_TEXT_MESSAGES`, `BOT_MAX_IMAGES`. Si no se definen,
  se usan los valores por defecto. Ver `.env.example`.
- **No hay cambios en la base de datos.** No hace falta correr migraciones.

---

## 1. Requisitos en el VPS

| Requisito | Cómo verificar |
|---|---|
| Node.js 20 o superior (recomendado 22/24 LTS) | `node -v` |
| Git | `git --version` |
| Acceso a internet saliente (Supabase, Meta, Google AI Studio) | — |

Instalar Node.js: https://nodejs.org (versión LTS). Instalar Git: https://git-scm.com.

> En PowerShell, si `npm` da el error "la ejecución de scripts está deshabilitada", ejecutar una vez:
> `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

---

## 2. Descargar el proyecto

```powershell
cd C:\
git clone https://github.com/AndresG2412/BotJoyeria.git bot
cd C:\bot
```

Si el proyecto ya estaba clonado en el VPS, solo actualizar:

```powershell
cd C:\bot
git pull origin master
```

---

## 3. Configurar el `.env`

1. Copiar la plantilla: `copy .env.example .env`
2. Completar **todas** las credenciales reales (OpenAI/Google AI Studio, Supabase, Meta, Resend,
   `DASHBOARD_USER`, `DASHBOARD_PASSWORD`).
3. Cambiar obligatoriamente en producción:
   - `DASHBOARD_PASSWORD` → una contraseña fuerte (no `admin123`).
   - `JWT_SECRET` → una cadena larga y aleatoria. Se puede generar con:
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
4. **Token de Meta permanente:** `META_ACCESS_TOKEN` debe ser un token de **usuario del sistema**
   (Business Settings → Usuarios del sistema → Generar token, con los permisos
   `whatsapp_business_messaging` y `whatsapp_business_management`). Los tokens temporales del panel
   de desarrolladores caducan en 24 horas y el bot dejaría de responder.
5. **Google Calendar:** copiar al VPS el JSON de la cuenta de servicio y poner su ruta en
   `GOOGLE_SERVICE_ACCOUNT_PATH` (por ejemplo `google-service-account.json` en la raíz del proyecto).
   Sin este archivo las citas no se crean en el calendario.

> El `.env` y el JSON de Google **nunca** se suben a GitHub (ya están en `.gitignore`).
> Pasarlos al VPS por escritorio remoto o por un canal privado.

---

## 4. Instalar y compilar

```powershell
cd C:\bot
npm ci
npm run build
```

`npm ci` instala exactamente las versiones de `package-lock.json`. Puede mostrar avisos
`npm warn allow-scripts` sobre `esbuild`: son solo avisos, no errores.

Prueba rápida (Ctrl+C para detener):

```powershell
node dist/app.js
```

Debe mostrar `Panel de control escuchando en el puerto 3000` y `Supabase conectado exitosamente`.

---

## 5. Dejar el bot corriendo 24/7 con PM2

PM2 reinicia el bot si se cae y lo mantiene vivo aunque se cierre la ventana.

```powershell
npm install -g pm2
cd C:\bot
pm2 start dist/app.js --name whatsapp-bot
pm2 save
```

Para que arranque solo cuando se reinicie el VPS:

```powershell
npm install -g pm2-windows-startup
pm2-startup install
pm2 save
```

> Alternativa si `pm2-startup` falla: crear una tarea en el **Programador de tareas** de Windows
> que se ejecute "Al iniciar el sistema" con el comando `pm2 resurrect`.

Comandos útiles:

| Acción | Comando |
|---|---|
| Ver estado | `pm2 status` |
| Ver logs en vivo | `pm2 logs whatsapp-bot` |
| Reiniciar | `pm2 restart whatsapp-bot --update-env` |
| Detener | `pm2 stop whatsapp-bot` |

> Ya no usar `iniciar_bot_vps_windows.bat` en producción: deja el bot atado a una ventana abierta.

---

## 6. URL pública fija (HTTPS) para el webhook

Meta necesita una URL HTTPS pública y fija. Hay dos opciones:

### Opción A — ngrok con dominio fijo (la más rápida, gratis)

Usar el dominio ngrok que ya existe (el actual de Meta es `reviving-pelt-scoured.ngrok-free.dev`).

1. Descargar ngrok para Windows: https://ngrok.com/download y dejar `ngrok.exe` en `C:\ngrok\`.
2. Crear el archivo `C:\ngrok\ngrok.yml`:

   ```yaml
   version: 3
   agent:
     authtoken: TU_NGROK_AUTHTOKEN
   endpoints:
     - name: whatsapp-bot
       url: https://TU-DOMINIO.ngrok-free.dev
       upstream:
         url: 3000
   ```

3. Instalarlo como servicio de Windows (arranca solo con el VPS). En PowerShell **como administrador**:

   ```powershell
   cd C:\ngrok
   .\ngrok.exe service install --config C:\ngrok\ngrok.yml
   .\ngrok.exe service start
   ```

4. Verificar desde cualquier navegador: `https://TU-DOMINIO.ngrok-free.dev/health` debe responder
   `{"status":"ok", ...}`.

> Un dominio ngrok solo puede estar activo en **un** equipo a la vez. Una vez esté en el VPS, no
> encenderlo en la PC.

### Opción B — dominio propio (recomendado a largo plazo)

Apuntar un subdominio (ej. `bot.midominio.com`) a la IP del VPS y poner delante un proxy con HTTPS
automático (por ejemplo **Caddy**: `caddy reverse-proxy --from bot.midominio.com --to localhost:3000`).
Abrir los puertos 80 y 443 en el firewall del VPS.

---

## 7. Apuntar el webhook de Meta a producción

1. developers.facebook.com → app **BotJoyeria** → **WhatsApp → Configuración → Webhook → Editar**.
2. **URL de devolución de llamada:** `https://TU-DOMINIO/webhook/whatsapp`
3. **Token de verificación:** el mismo valor de `META_VERIFY_TOKEN` del `.env` del VPS.
4. **Verificar y guardar.** Si falla, revisar que el bot y el túnel estén encendidos (paso 6.4).
5. En **Campos del webhook**, confirmar que **messages** está suscrito.

> Revisar también que `META_APP_SECRET` en el `.env` sea el de esta app
> (Configuración de la app → Básica → Clave secreta). Si no coincide, el bot rechaza todos los
> webhooks con el aviso "firma inválida".

---

## 8. Pruebas de funcionamiento

1. Entrar al panel: `https://TU-DOMINIO/dashboard` → la tarjeta de WhatsApp debe decir
   **OPERATIVA** y mostrar el número.
2. Escribir al número de WhatsApp desde otro teléfono:
   - Enviar "Hola" → responde el saludo.
   - Enviar tres mensajes seguidos ("Busco un anillo" / "de oro" / "18k") → debe llegar **una sola**
     respuesta que tenga en cuenta los tres.
   - Pedir la foto de un anillo → debe llegar la **imagen** además del texto.
3. En el panel, "Último webhook recibido" y "Último mensaje enviado" deben actualizarse.
4. Revisar logs: `pm2 logs whatsapp-bot`. No deben aparecer `Entrega fallida` ni `firma inválida`.
5. Probar la respuesta humana: desde la pestaña de conversaciones responder un chat y confirmar que
   el mensaje llega y el bot queda pausado; luego reactivarlo.

---

## 9. Actualizar en el futuro

```powershell
cd C:\bot
git pull origin master
npm ci
npm run build
pm2 restart whatsapp-bot --update-env
```

> `deploy.bat` todavía tiene datos de ejemplo y usa la rama `main` (el repo usa `master`).
> Si se quiere usar, editar sus variables y la rama antes.

---

## 10. Solución de problemas

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| El bot no responde y no aparece nada en los logs | Meta no llega al servidor | Verificar `https://TU-DOMINIO/health`, el túnel/proxy y la URL del webhook en Meta |
| Log: "Webhook de Meta rechazado: firma inválida" | `META_APP_SECRET` incorrecto | Copiar la clave secreta correcta de la app en `.env` y reiniciar |
| Panel en ERROR con "(código 190)" | Token de Meta vencido o inválido | Generar token de usuario del sistema (paso 3.4) |
| Llega el texto pero no la imagen | Error de entrega de Meta | Ver "Último error" en el panel y `pm2 logs` |
| Respuestas lentas y logs "Cascada ... HTTP 503" | Google AI Studio saturado | Es temporal; el bot pasa al siguiente modelo automáticamente |
| Panel en CONFIGURACIÓN INCOMPLETA | Faltan variables de Meta | El panel lista cuáles faltan en el `.env` |

---

## Notas para VPS Linux

Mismos pasos cambiando: clonar en `/opt/bot`, `cp .env.example .env`, y para el arranque automático
de PM2 usar `pm2 startup` (seguir la instrucción que imprime) y luego `pm2 save`. Para ngrok:
`sudo ngrok service install --config /etc/ngrok.yml && sudo ngrok service start`.
