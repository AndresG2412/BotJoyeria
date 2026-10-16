-- Aviso «Pide cotización» (kind = 'cotizacion') en bot.notifications.
--
-- Cuando un cliente quiere una pieza que hay que fabricar, a medida o sin precio, el bot llama
-- request_quote: deja el aviso en la campana del admin (con sonido) para que un empleado haga la
-- cotización y le escriba por el mismo chat. Solo amplía la lista de tipos permitidos.
--
-- Se corre en Supabase → SQL Editor (como postgres) ANTES de desplegar el código que lo usa.
-- Es idempotente y no borra datos.

alter table bot.notifications drop constraint if exists notifications_kind_check;
alter table bot.notifications add constraint notifications_kind_check
    check (kind in ('cita_nueva', 'llamada_agendada', 'cita_reprogramada', 'llamar_ya', 'pide_asesor', 'cotizacion'));

-- Comprobación (debe incluir 'cotizacion'):
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'notifications_kind_check';
