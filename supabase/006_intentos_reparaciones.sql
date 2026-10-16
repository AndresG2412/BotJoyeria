-- Intentos fallidos de consulta de reparaciones, guardados en la base.
--
-- Antes vivían en la memoria del bot: un reinicio de PM2 los ponía en cero y solo se contaban
-- por chat. Ahora se cuentan por chat Y por cédula (24 h, src/bot/repairs.ts), así que probar
-- números de orden contra la cédula de otra persona desde varios celulares también se frena.
--
-- `key` nunca lleva la cédula en claro: es «chat:<sesión>» o «doc:<sha256 de la cédula>».
-- Las filas de más de 2 días se borran solas al registrar un intento nuevo.
--
-- Se corre en Supabase → SQL Editor (como postgres). Es idempotente y no borra datos.

create table if not exists bot.repair_lookup_failures (
    id        bigserial primary key,
    key       text not null,
    failed_at timestamptz not null default now()
);
create index if not exists repair_lookup_failures_key_idx on bot.repair_lookup_failures (key, failed_at desc);

grant select, insert, delete on bot.repair_lookup_failures to bot_joyeria;
grant usage, select on sequence bot.repair_lookup_failures_id_seq to bot_joyeria;
revoke all on bot.repair_lookup_failures from anon, authenticated;

alter table bot.repair_lookup_failures enable row level security;
drop policy if exists bot_joyeria_repair_lookup_failures on bot.repair_lookup_failures;
create policy bot_joyeria_repair_lookup_failures on bot.repair_lookup_failures
    for all to bot_joyeria using (true) with check (true);

-- ── Comprobación (debe dar true / true / true) ───────────────────────────────
--   select has_table_privilege('bot_joyeria', 'bot.repair_lookup_failures', 'insert'),
--          has_table_privilege('bot_joyeria', 'bot.repair_lookup_failures', 'delete'),
--          not has_table_privilege('anon', 'bot.repair_lookup_failures', 'select');
