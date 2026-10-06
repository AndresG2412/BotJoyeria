-- Esquema propio del bot dentro de la base de la tienda (Supabase mr-18-kilates).
--
-- El bot NO toca las tablas de la tienda (public.*: products, categorias, clientes, ventas…).
-- Se conecta con el rol bot_joyeria, que solo puede leer y escribir en bot.sessions y
-- bot.appointments. El esquema `bot` no se expone por la API de Supabase (PostgREST).
--
-- Se aplica una vez. Es idempotente: correrlo de nuevo no rompe nada.
-- La contraseña del rol se pone APARTE (ver supabase/README.md), nunca en este archivo.

create schema if not exists bot;
revoke all on schema bot from public;

-- Conversaciones de WhatsApp/Telegram: historial que se le pasa a la IA.
create table if not exists bot.sessions (
    session_id      text primary key,               -- <storeId>_<telefono o BSUID>
    store_id        text not null default 'default',
    sender_phone    text not null default '',
    messages        jsonb not null default '[]'::jsonb,
    is_paused       boolean not null default false, -- un asesor tomó el chat
    has_appointment boolean not null default false,
    updated_at      timestamptz not null default now()
);
create index if not exists sessions_updated_at_idx on bot.sessions (updated_at desc);

-- Citas presenciales agendadas por el bot (también quedan en Google Calendar).
create table if not exists bot.appointments (
    id                 text primary key,
    store_id           text not null,
    sender_phone       text not null,
    client_name        text not null default '',
    city               text not null default 'Pitalito',
    date               text not null,              -- YYYY-MM-DD (hora de Colombia)
    time               text not null,              -- HH:MM
    appointment_type   text not null default 'asesoria_presencial',
    property_reference text not null default '',
    address            text not null default 'Calle 4 #1-31',
    phone              text not null default '',
    calendar_event_id  text,
    status             text not null default 'scheduled'
                       check (status in ('scheduled', 'cancelled', 'completed')),
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);
create index if not exists appointments_identity_idx on bot.appointments (store_id, sender_phone, status);
create index if not exists appointments_schedule_idx on bot.appointments (store_id, date, time, status);

-- Rol del bot: sin login hasta que se le ponga contraseña. Pocas conexiones y consultas cortas.
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'bot_joyeria') then
        create role bot_joyeria nologin noinherit connection limit 5;
    end if;
end
$$;
alter role bot_joyeria set search_path = bot;
alter role bot_joyeria set statement_timeout = '15s';
alter role bot_joyeria set idle_in_transaction_session_timeout = '30s';

grant usage on schema bot to bot_joyeria;
grant select, insert, update, delete on bot.sessions, bot.appointments to bot_joyeria;

-- Nadie más por la API de Supabase.
revoke all on schema bot from anon, authenticated;
revoke all on bot.sessions, bot.appointments from anon, authenticated;

-- RLS activo: solo el rol del bot tiene política (postgres/service_role la saltan, como siempre).
alter table bot.sessions enable row level security;
alter table bot.appointments enable row level security;

drop policy if exists bot_joyeria_sessions on bot.sessions;
create policy bot_joyeria_sessions on bot.sessions
    for all to bot_joyeria using (true) with check (true);

drop policy if exists bot_joyeria_appointments on bot.appointments;
create policy bot_joyeria_appointments on bot.appointments
    for all to bot_joyeria using (true) with check (true);
