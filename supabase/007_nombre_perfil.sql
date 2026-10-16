-- Nombre de perfil de WhatsApp de cada chat (el que el cliente puso en su app).
--
-- Meta lo manda con cada mensaje (`contacts[].profile.name`). El panel de la tienda lo muestra
-- arriba en la lista de chats, en vez del número o, peor, del identificador «CO.4478…» que llega
-- cuando el cliente no comparte su número. Solo lo ve el dueño; se borra con el chat.
--
-- Se corre en Supabase → SQL Editor (como postgres) ANTES de desplegar el código que lo usa
-- (saveMemory escribe la columna). Es idempotente y no borra datos.

alter table bot.sessions add column if not exists profile_name text not null default '';

-- Comprobación (debe dar 1):
--   select count(*) from information_schema.columns
--   where table_schema = 'bot' and table_name = 'sessions' and column_name = 'profile_name';
