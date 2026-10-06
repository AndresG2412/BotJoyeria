# Base de datos del bot

El bot guarda sus conversaciones y citas en la **base de la tienda** (proyecto Supabase
`mr-18-kilates`), en un esquema propio llamado `bot`. No lee ni escribe ninguna tabla de la
tienda (`public.*`): el catálogo lo toma de la API pública de la tienda.

| Objeto | Para qué |
|---|---|
| `bot.sessions` | Historial de cada conversación (lo que se le pasa a la IA), pausa del asesor |
| `bot.appointments` | Citas presenciales agendadas (también quedan en Google Calendar) |
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

## Comprobar permisos

```sql
select has_table_privilege('bot_joyeria', 'bot.sessions', 'INSERT')   as escribe_sesiones,  -- true
       has_table_privilege('bot_joyeria', 'public.clientes', 'SELECT') as lee_clientes;     -- false
```
