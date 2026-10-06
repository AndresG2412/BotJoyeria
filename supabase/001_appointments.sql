-- Ejecutar una vez en Supabase SQL Editor antes de activar las citas.
-- La aplicación usa esta tabla mediante Supabase REST, no mediante Drizzle.

create table if not exists public.appointments (
    id text primary key,
    store_id text not null references public.stores(id) on delete cascade,
    sender_phone text not null,
    client_name text not null default '',
    city text not null default 'Pitalito',
    date text not null,
    time text not null,
    appointment_type text not null default 'asesoria_presencial',
    property_reference text not null default '',
    address text not null default 'Calle 4 #1-31',
    phone text not null default '',
    calendar_event_id text,
    status text not null default 'scheduled',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.appointments add column if not exists calendar_event_id text;
alter table public.appointments add column if not exists updated_at timestamptz not null default now();

create index if not exists appointments_identity_idx
    on public.appointments (store_id, sender_phone, status);

create index if not exists appointments_schedule_idx
    on public.appointments (store_id, date, time, status);
