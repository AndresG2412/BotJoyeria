-- Consulta del estado de reparaciones (Mostrador → Taller del admin de la tienda).
--
-- El bot NO recibe permisos sobre public.ordenes_taller ni public.clientes. En su lugar,
-- esta función de solo lectura hace la verificación DENTRO de la base y devuelve una orden
-- únicamente si los datos coinciden:
--   - número de orden + (teléfono del cliente O su documento), o
--   - documento + teléfono del cliente (lista sus órdenes).
-- Así, aunque alguien obtuviera las credenciales del bot, no podría listar cédulas ni
-- teléfonos de clientes: solo comprobar una combinación a la vez.
--
-- Solo devuelve lo que el cliente puede ver: número, pieza, estado, fechas y saldo.
-- Nunca notas internas, técnico, pesos, precio de costo ni historial.
--
-- Se corre en Supabase → SQL Editor (como postgres, dueño de la función). Es idempotente.

create or replace function bot.consultar_orden_taller(
    p_numero    text,
    p_documento text,
    p_telefono  text
)
returns table (
    numero          text,
    pieza           text,
    material        text,
    estado          text,
    fecha_recibido  timestamptz,
    fecha_prometida timestamptz,
    entregada_en    timestamptz,
    saldo           numeric
)
language sql
stable
security definer
set search_path = ''
as $$
    with p as (
        select
            nullif(upper(regexp_replace(coalesce(p_numero, ''), '[^0-9A-Za-z]', '', 'g')), '') as num,
            nullif(regexp_replace(coalesce(p_documento, ''), '[^0-9]', '', 'g'), '')            as doc,
            -- Últimos 10 dígitos: "+57 315 000 0000" y "3150000000" son el mismo celular.
            nullif(right(regexp_replace(coalesce(p_telefono, ''), '[^0-9]', '', 'g'), 10), '')  as tel
    ),
    o as (
        select
            ot.*,
            upper(regexp_replace(coalesce(ot.numero, ''), '[^0-9A-Za-z]', '', 'g'))  as num_norm,
            regexp_replace(coalesce(c.documento, ''), '[^0-9]', '', 'g')             as doc_norm,
            right(regexp_replace(coalesce(c.telefono, ''), '[^0-9]', '', 'g'), 10)   as tel_norm
        from public.ordenes_taller ot
        join public.clientes c on c.id = ot.cliente_id
    )
    select
        o.numero::text,
        coalesce(nullif(o.joya_descripcion, ''), nullif(o.descripcion, ''), 'Joya')::text,
        o.joya_material::text,
        o.estado::text,
        o.fecha_recibido,
        o.fecha_prometida,
        o.entregada_en,
        o.saldo
    from o, p
    where
        (p.num is not null
            and o.num_norm = p.num
            and ((p.tel is not null and o.tel_norm = p.tel)
              or (p.doc is not null and o.doc_norm = p.doc)))
        or
        (p.num is null
            and p.doc is not null and p.tel is not null
            and o.doc_norm = p.doc and o.tel_norm = p.tel)
    order by o.fecha_recibido desc nulls last
    limit 5;
$$;

-- Solo el bot puede ejecutarla. Nadie por la API de Supabase.
revoke all on function bot.consultar_orden_taller(text, text, text) from public, anon, authenticated;
grant execute on function bot.consultar_orden_taller(text, text, text) to bot_joyeria;

-- Comprobación (debe dar true / false / false):
-- select has_function_privilege('bot_joyeria', 'bot.consultar_orden_taller(text, text, text)', 'EXECUTE') as ejecuta,
--        has_table_privilege('bot_joyeria', 'public.ordenes_taller', 'SELECT') as lee_ordenes,
--        has_table_privilege('bot_joyeria', 'public.clientes', 'SELECT')       as lee_clientes;
