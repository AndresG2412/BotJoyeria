# Guía completa: consulta de reparaciones y chats de WhatsApp en el admin

Esta guía activa **dos funciones nuevas** de principio a fin:

1. **Consulta de reparaciones:** el cliente le pregunta al bot por la joya que dejó en el taller y el
   bot le responde el estado (lo lee de **Mostrador → Taller** del admin de la tienda).
2. **Mostrador → WhatsApp:** el dueño ve los chats del bot dentro del admin de la tienda, responde
   como asesor y le devuelve el chat al bot.

> Tiempo estimado: 45–60 minutos la primera vez. Hazlo en el orden de la guía: cada paso
> depende del anterior.

---

## Índice

- [0. Antes de empezar](#0-antes-de-empezar)
- [1. Fusionar los cambios en GitHub](#1-fusionar-los-cambios-en-github)
- [2. Base de datos: la función del taller (Supabase)](#2-base-de-datos-la-función-del-taller-supabase)
- [3. Generar la llave que une el bot con la tienda](#3-generar-la-llave-que-une-el-bot-con-la-tienda)
- [4. Actualizar el bot en el VPS](#4-actualizar-el-bot-en-el-vps)
- [5. Configurar la tienda en Vercel](#5-configurar-la-tienda-en-vercel)
- [6. Pruebas de funcionamiento](#6-pruebas-de-funcionamiento)
- [7. Solución de problemas](#7-solución-de-problemas)
- [8. Cómo apagarlo o deshacerlo](#8-cómo-apagarlo-o-deshacerlo)
- [9. Lista de verificación final](#9-lista-de-verificación-final)

---

## 0. Antes de empezar

### Qué necesitas

| Qué | Para qué paso |
|---|---|
| Acceso a GitHub a los dos repos: `AndresG2412/BotJoyeria` (bot) y `darkounus90/Mrklts` (tienda) | 1 |
| Acceso al proyecto de **Supabase** de la tienda (`mr-18-kilates`), con permiso para usar el SQL Editor | 2 |
| Node.js instalado en tu PC (solo para generar la llave) | 3 |
| Acceso al **VPS** donde corre el bot (escritorio remoto o SSH) | 4 |
| Acceso al proyecto de la tienda en **Vercel** | 5 |
| Un celular con WhatsApp para probar (que **no** sea el número del bot) | 6 |
| Un usuario **administrador** y uno **vendedor** del admin de la tienda | 6 |

### Qué se cambió (resumen)

| Proyecto | Rama | Qué trae |
|---|---|---|
| Bot | `feat/consulta-taller` | Herramienta de consulta del taller, la función SQL `004_consulta_taller.sql` y la ruta `/admin-api` para el admin de la tienda |
| Tienda | `panel-whatsapp` | Pantalla **Mostrador → WhatsApp** (solo dueño) y la jerarquía de roles `cliente < vendedor < admin` (no cambia ningún permiso actual) |

### Cómo se conectan las piezas

```
Cliente (WhatsApp) ──► Meta ──► Bot (VPS) ──► Supabase: bot.consultar_orden_taller()
                                   ▲              (solo lectura, verifica en la base)
                                   │ /admin-api  (con BOT_ADMIN_API_TOKEN)
Dueño (navegador) ──► Tienda (Vercel) /api/whatsapp  ── revisa sesión y rol de admin
```

- El navegador **nunca** habla con el bot directamente: habla con la tienda, que revisa que sea un
  administrador y recién ahí llama al bot con la llave secreta.
- El bot **nunca** recibe permiso para leer las tablas de clientes ni de órdenes: solo puede
  ejecutar una función que devuelve una orden cuando los datos coinciden.

---

## 1. Fusionar los cambios en GitHub

### 1.1 Bot

1. Abre: https://github.com/AndresG2412/BotJoyeria/pull/new/feat/consulta-taller
2. **Importante:** en **base**, elige `feat/catalogo-del-sitio` (no `master`). La rama nueva salió de
   ahí; si apuntas a `master`, el PR muestra 17 commits que no son de este cambio.
3. Revisa los 3 commits y dale **Create pull request** → **Merge pull request**.
4. Si `feat/catalogo-del-sitio` todavía no está en `master`, fusiónala también (otro PR de
   `feat/catalogo-del-sitio` → `master`). El VPS se actualiza desde `master` (ver `DEPLOY.md`).

### 1.2 Tienda

1. Abre: https://github.com/darkounus90/Mrklts/pull/new/panel-whatsapp
2. Base: `master`. Crea el PR.
3. **Todavía no lo fusiones.** Primero haz los pasos 2 a 5: al fusionar, Vercel publica solo, y
   conviene que las variables ya estén puestas (paso 5).

---

## 2. Base de datos: la función del taller (Supabase)

Se hace **una sola vez** y **antes** de actualizar el bot.

1. Entra a https://supabase.com → proyecto de la tienda (`mr-18-kilates`).
2. Menú izquierdo → **SQL Editor** → **New query**.
3. Abre el archivo `supabase/004_consulta_taller.sql` del repo del bot, copia **todo** su contenido,
   pégalo y dale **Run**. Debe decir `Success. No rows returned`.
4. Comprueba los permisos con esta consulta (pégala y dale **Run**):

   ```sql
   select has_function_privilege('bot_joyeria', 'bot.consultar_orden_taller(text, text, text)', 'EXECUTE') as ejecuta,
          has_table_privilege('bot_joyeria', 'public.ordenes_taller', 'SELECT') as lee_ordenes,
          has_table_privilege('bot_joyeria', 'public.clientes', 'SELECT')       as lee_clientes;
   ```

   El resultado correcto es: **`ejecuta = true`, `lee_ordenes = false`, `lee_clientes = false`**.

5. (Opcional) Prueba la función con una orden real del taller. Cambia los valores por los de una
   orden que exista (número de orden y el celular del cliente, 10 dígitos):

   ```sql
   select * from bot.consultar_orden_taller('T-0012', null, '3157870130');
   ```

   Si los datos coinciden devuelve una fila con la pieza y el estado; si no, no devuelve nada (es
   lo esperado: la función nunca dice si la orden existe cuando los datos no coinciden).

> El script es seguro de correr más de una vez (`create or replace`). No modifica ni borra datos.

---

## 3. Generar la llave que une el bot con la tienda

La llave (`BOT_ADMIN_API_TOKEN`) es una contraseña larga que la tienda usa para hablar con el bot.
**Es la misma en los dos lados.**

1. En tu PC, abre una terminal (PowerShell o CMD) y ejecuta:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. Copia el resultado (64 caracteres, letras y números) y guárdalo temporalmente en un lugar
   privado (un gestor de contraseñas, por ejemplo).

> **Nunca** la pegues en un chat, un correo, un commit ni en una variable que empiece con
> `NEXT_PUBLIC_`. Si se filtra, genera otra y reemplázala en los dos lados (pasos 4.3 y 5).

---

## 4. Actualizar el bot en el VPS

### 4.1 Traer el código nuevo

En el VPS, en PowerShell:

```powershell
cd C:\bot
git pull origin master
```

### 4.2 Instalar y compilar

```powershell
npm ci
npm run build
```

`npm ci` puede mostrar avisos `npm warn allow-scripts` sobre `esbuild`: son solo avisos.

### 4.3 Agregar la llave al `.env`

1. Abre `C:\bot\.env` con el Bloc de notas.
2. Agrega esta línea al final (con la llave del paso 3):

   ```
   BOT_ADMIN_API_TOKEN=pega-aqui-la-llave
   ```

3. Guarda el archivo.

### 4.4 Reiniciar el bot

```powershell
pm2 restart whatsapp-bot --update-env
pm2 logs whatsapp-bot --lines 30
```

En los logs debe aparecer `✅ Base de datos conectada (esquema bot).` y ningún error nuevo.
Sal de los logs con **Ctrl+C**.

### 4.5 Comprobar que `/admin-api` responde

Cambia `TU-DOMINIO` por la dirección pública del bot (la del webhook de Meta, sin
`/webhook/whatsapp`).

**Sin la llave** debe responder `401` (correcto: rechaza a quien no la tiene):

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" https://TU-DOMINIO/admin-api/sessions
```

**Con la llave** debe responder `200`:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -H "Authorization: Bearer pega-aqui-la-llave" "https://TU-DOMINIO/admin-api/sessions?limit=1"
```

| Responde | Significa |
|---|---|
| `200` | Todo bien |
| `401` con la llave | La llave del comando no es igual a la del `.env` |
| `503` | El `.env` no tiene `BOT_ADMIN_API_TOKEN` o el bot no se reinició con `--update-env` |
| `000` o error de conexión | El bot o el túnel (ngrok/dominio) están apagados |

---

## 5. Configurar la tienda en Vercel

1. Entra a https://vercel.com → el proyecto de la tienda (`mr18kts.online`).
2. **Settings** → **Environment Variables**.
3. Agrega la primera variable:
   - **Key:** `BOT_URL`
   - **Value:** `https://TU-DOMINIO` (la misma del paso 4.5; **sin** barra final y **sin**
     `/webhook/whatsapp`)
   - **Environments:** solo **Production**
   - **Save**
4. Agrega la segunda:
   - **Key:** `BOT_ADMIN_API_TOKEN`
   - **Value:** la llave del paso 3 (idéntica a la del `.env` del bot)
   - **Environments:** solo **Production**
   - Activa **Sensitive** (así nadie puede volver a leerla desde el panel)
   - **Save**
5. Ahora sí, **fusiona el PR de la tienda** (paso 1.2): **Merge pull request**. Vercel publica solo
   en unos minutos. Puedes seguirlo en **Deployments**; espera a que diga **Ready**.

> Si en algún momento cambias las variables, Vercel no las toma hasta un despliegue nuevo:
> **Deployments** → los tres puntos (⋯) del último de Production → **Redeploy**.

---

## 6. Pruebas de funcionamiento

### 6.1 Consulta de reparaciones (desde un celular con WhatsApp)

Necesitas una orden real en **Mostrador → Taller** cuyo cliente tenga **tu** celular y cédula, o
crea una de prueba con tus datos.

| # | Qué escribir al bot | Qué debe pasar |
|---|---|---|
| 1 | "Hola, ¿ya está mi anillo?" | Te pide el número de orden del recibo |
| 2 | El número de orden (desde el celular registrado en la orden) | Te dice la pieza, el estado y la fecha prometida |
| 3 | Desde **otro** celular: el número de orden | Te pide la cédula del titular (no dice si la orden existe) |
| 4 | Desde ese otro celular: el número de orden + la cédula correcta | Te da el reporte |
| 5 | Una cédula equivocada 3 veces | A la tercera, el bot dice que no puede consultar más hoy |
| 6 | Cambia la orden a **listo** en el admin y vuelve a preguntar | "Lista para recoger" e invita a pasar por Calle 4 #1-31 |

Así traduce el bot cada estado del admin:

| En el admin | Lo que lee el cliente |
|---|---|
| `recibido` | Recibida en el taller |
| `en-taller` | En reparación |
| `listo` | Lista para recoger |
| `entregado` | Entregada |
| `cancelado` | Cancelada |

> El bot **nunca** muestra notas internas, técnico, pesos ni precio: solo pieza, estado, fechas y
> saldo pendiente.

### 6.2 Mostrador → WhatsApp (desde el navegador)

| # | Qué hacer | Qué debe pasar |
|---|---|---|
| 1 | Entra al admin con un **administrador** | En la barra, grupo **Mostrador**, aparece **WhatsApp** |
| 2 | Ábrelo | Se ve la lista de chats con su estado ("Lo atiende el bot", "Con un asesor", "Espera respuesta") |
| 3 | Toca un chat | Se ve la conversación en burbujas |
| 4 | Escribe una respuesta y dale **Enviar** | Llega al WhatsApp del cliente y el chat pasa a "Con un asesor" (el bot ya no contesta ahí) |
| 5 | Dale **Devolver al bot** | El chat vuelve a "Lo atiende el bot" |
| 6 | Entra con un **vendedor** | No ve el enlace WhatsApp; si abre `/admin/whatsapp` a mano, le sale "página no encontrada" |
| 7 | Responde a un chat cuyo cliente no escribe hace más de 24 h | Aviso: WhatsApp no deja escribirle hasta que él vuelva a escribir |

---

## 7. Solución de problemas

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| El bot dice "en este momento no pude consultar el taller" | No se corrió el SQL del paso 2 | Correr `supabase/004_consulta_taller.sql` y repetir la comprobación del paso 2.4 |
| El bot nunca encuentra la orden, aunque los datos están bien | El celular o la cédula del cliente en el admin están mal escritos | Revisar en **Clientes** que el teléfono tenga los 10 dígitos y la cédula sea la correcta |
| El bot dice que no puede consultar más hoy | 3 intentos fallidos con cédula en ese chat | Es una protección: se libera sola en 24 h o al reiniciar el bot |
| La pantalla WhatsApp dice "no está conectado con el bot" | Faltan `BOT_URL` o `BOT_ADMIN_API_TOKEN` en Vercel, o no se redesplegó | Paso 5 y **Redeploy** |
| Dice "el bot rechazó la llave" | La llave no es igual en Vercel y en el `.env` del bot | Volver a pegar la misma en los dos lados; reiniciar el bot (4.4) y redesplegar (5) |
| Dice "no se pudo hablar con el bot" | El bot o el túnel están apagados, o `BOT_URL` está mal escrita | Paso 4.5; revisar que `BOT_URL` no tenga `/webhook/whatsapp` ni barra final |
| No aparece el enlace WhatsApp en la barra | El usuario no es administrador, o el PR de la tienda no se publicó | Revisar el rol del usuario y que el despliegue en Vercel diga **Ready** |
| La respuesta se envía pero el bot sigue contestando | El chat se devolvió al bot, o el cliente esperó un rato sin respuesta | Es el comportamiento normal: el bot retoma los chats pausados sin respuesta |
| Error al enviar con "24 horas" | Regla de WhatsApp | Esperar a que el cliente vuelva a escribir |

Para ver qué pasa en el bot: `pm2 logs whatsapp-bot` en el VPS. Los logs nunca muestran cédulas
ni números completos.

---

## 8. Cómo apagarlo o deshacerlo

- **Apagar solo el panel de WhatsApp:** borra `BOT_ADMIN_API_TOKEN` del `.env` del bot y reinicia
  (`pm2 restart whatsapp-bot --update-env`). La pantalla seguirá abriendo, pero dirá que no está
  conectada.
- **Apagar la consulta de reparaciones** sin tocar código, en el SQL Editor de Supabase:

  ```sql
  revoke execute on function bot.consultar_orden_taller(text, text, text) from bot_joyeria;
  ```

  El bot responderá que no puede consultar el taller. Para volver a encenderla:
  `grant execute on function bot.consultar_orden_taller(text, text, text) to bot_joyeria;`
- **Deshacer el código:** en GitHub, en cada PR fusionado, botón **Revert** → fusionar el PR de
  reversión. Vercel y el VPS (con `git pull` + `npm run build` + `pm2 restart`) vuelven a la
  versión anterior.

---

## 9. Lista de verificación final

- [ ] PR del bot fusionado en `feat/catalogo-del-sitio`, y esa rama en `master`
- [ ] `004_consulta_taller.sql` corrido en Supabase; comprobación: `true / false / false`
- [ ] Llave generada y guardada en un lugar privado
- [ ] VPS: `git pull`, `npm ci`, `npm run build`, `BOT_ADMIN_API_TOKEN` en `.env`, `pm2 restart --update-env`
- [ ] `/admin-api`: `401` sin llave y `200` con llave
- [ ] Vercel: `BOT_URL` y `BOT_ADMIN_API_TOKEN` (Sensitive) en Production
- [ ] PR de la tienda fusionado y despliegue **Ready**
- [ ] Pruebas 6.1 (reparaciones) y 6.2 (panel WhatsApp) completas
- [ ] Un vendedor NO ve WhatsApp
