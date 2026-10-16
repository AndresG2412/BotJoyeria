-- Calendario propio de citas (reemplaza a Google Calendar) y avisos para el admin de la tienda.
--
-- 1. bot.appointments pasa a ser el ÚNICO calendario:
--    - estado nuevo «no_show» (el cliente no vino / no contestó la llamada);
--    - `notes` (lo que anota el mostrador) y `source` (quién la creó: el bot o el panel);
--    - un índice único que impide dos citas vigentes en la misma fecha y hora, aunque dos
--      clientes confirmen a la vez (antes lo cuidaba Google Calendar).
-- 2. bot.notifications: lo que el bot le avisa a la joyería (cita nueva, llamada agendada,
--    «llámenme», cliente que pide un asesor, cita reprogramada). El panel los cuenta, los lista y
--    los marca como atendidos.
--
-- Se corre en Supabase → SQL Editor (como postgres). Es idempotente y no borra datos.
-- ANTES de correrlo, revisa que no haya dos citas vigentes en el mismo horario (consulta al final).

-- ── 1. Citas ─────────────────────────────────────────────────────────────────
alter table bot.appointments add column if not exists notes  text not null default '';
alter table bot.appointments add column if not exists source text not null default 'bot';

alter table bot.appointments drop constraint if exists appointments_status_check;
alter table bot.appointments add constraint appointments_status_check
    check (status in ('scheduled', 'cancelled', 'completed', 'no_show'));

alter table bot.appointments drop constraint if exists appointments_source_check;
alter table bot.appointments add constraint appointments_source_check
    check (source in ('bot', 'panel'));

create unique index if not exists appointments_one_per_slot
    on bot.appointments (store_id, date, time)
    where status = 'scheduled';

-- ── 2. Avisos ────────────────────────────────────────────────────────────────
create table if not exists bot.notifications (
    id             bigserial primary key,
    store_id       text not null default 'default',
    kind           text not null
                   check (kind in ('cita_nueva', 'llamada_agendada', 'cita_reprogramada', 'llamar_ya', 'pide_asesor')),
    session_id     text,
    phone          text not null default '',
    client_name    text not null default '',
    detail         text not null default '',
    appointment_id text,
    created_at     timestamptz not null default now(),
    read_at        timestamptz,
    read_by        text
);
create index if not exists notifications_unread_idx on bot.notifications (store_id, created_at desc) where read_at is null;
create index if not exists notifications_recent_idx on bot.notifications (store_id, created_at desc);

grant select, insert, update on bot.notifications to bot_joyeria;
grant usage, select on sequence bot.notifications_id_seq to bot_joyeria;
revoke all on bot.notifications from anon, authenticated;

alter table bot.notifications enable row level security;
drop policy if exists bot_joyeria_notifications on bot.notifications;
create policy bot_joyeria_notifications on bot.notifications
    for all to bot_joyeria using (true) with check (true);

-- ── Comprobaciones ───────────────────────────────────────────────────────────
-- Antes de correr: dos citas vigentes en el mismo horario harían fallar el índice único.
--   select store_id, date, time, count(*) from bot.appointments
--   where status = 'scheduled' group by 1, 2, 3 having count(*) > 1;
-- Después (debe dar true / true):
--   select has_table_privilege('bot_joyeria', 'bot.notifications', 'INSERT') as crea_avisos,
--          has_sequence_privilege('bot_joyeria', 'bot.notifications_id_seq', 'USAGE') as usa_secuencia;
