# Base de datos del bot

El bot guarda sus conversaciones y citas en la **base de la tienda** (proyecto Supabase
`mr-18-kilates`), en un esquema propio llamado `bot`. No lee ni escribe ninguna tabla de la
tienda (`public.*`): el catálogo lo toma de la API pública de la tienda.

| Objeto | Para qué |
|---|---|
| `bot.sessions` | Historial de cada conversación (lo que se le pasa a la IA), pausa del asesor |
| `bot.appointments` | El calendario de citas (presenciales y llamadas); lo ve la tienda en Mostrador → Citas |
| `bot.notifications` | Avisos para la joyería (la campana del admin de la tienda) |
| rol `bot_joyeria` | Único usuario del bot: solo `select/insert/update/delete` en esas dos tablas |

## Instalación (una sola vez)

1. En Supabase → **SQL Editor**, correr `002_bot_schema.sql`.
2. Ponerle contraseña al rol (larga y aleatoria) en el mismo editor:
   ```sql
   alter role bot_joyeria login password '<contraseña>';
   ```
3. En el `.env` del bot:
   ```
   BOT_DATABASE_URL=postgresql://bot_joyeria.<ref>:<contraseña>@aws-0-us-east-1.pooler.supabase.com:6543/postgres
   ```
4. Descargar el certificado: **Database → Settings → SSL Configuration → Download certificate**
   y guardarlo como `supabase-ca.crt` en la raíz del bot (o indicar `BOT_DATABASE_CA_PATH`).
5. Arrancar el bot: debe registrar `✅ Base de datos conectada (esquema bot).`

## Cambios posteriores

- `003_human_takeover.sql`: columna `human_until` (coexistencia). Correr ANTES de desplegar el código que la usa.
- `004_consulta_taller.sql`: función `bot.consultar_orden_taller` para que el bot informe el estado de
  las reparaciones (Mostrador → Taller). Es de solo lectura y verifica dentro de la base: el bot NO
  recibe permisos sobre `public.ordenes_taller` ni `public.clientes`, solo puede ejecutar la función.
  Correr ANTES de desplegar el código que la usa (sin ella el bot responde que no puede consultar).
- `005_calendario_y_avisos.sql`: calendario propio (estado «no vino», notas, origen, un solo turno por
  horario) y la tabla `bot.notifications`. Reemplaza a Google Calendar. Correr ANTES de desplegar.
- `006_intentos_reparaciones.sql`: tabla `bot.repair_lookup_failures` con los intentos fallidos de
  consulta de reparaciones (por chat y por cédula con hash), para que el límite sobreviva a los
  reinicios. Si falta, el bot sigue contando en memoria.
- `007_nombre_perfil.sql`: columna `profile_name` en `bot.sessions`, el nombre de perfil de WhatsApp
  que el panel muestra en la lista de chats. Correr ANTES de desplegar (saveMemory la escribe).

## Comprobar permisos

```sql
select has_table_privilege('bot_joyeria', 'bot.sessions', 'INSERT')   as escribe_sesiones,  -- true
       has_table_privilege('bot_joyeria', 'public.clientes', 'SELECT') as lee_clientes;     -- false
```
