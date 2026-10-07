-- ============================================================
-- CLINICAL HUB · CUENTAS DE VENTAS EN SUPABASE (etapa 1)
-- Las cuentas se hacen aquí y el panel recibe solo los resultados,
-- en vez de bajar todos los avisos de Hotmart y sumarlos en el navegador.
-- Etapa 1: médicos activos por mes y renovaciones del mes.
--
-- Mismas reglas que js/ventas-calculos.js (modelo, vigente, activa):
--   · Pago válido  cobro aprobado cuya transacción no se reembolsó ni tuvo contracargo.
--   · Alta         el primer pago válido de la suscripción.
--   · Baja         el último aviso de baja (cancelación, inactiva, reembolso o contracargo)
--                  posterior al alta, solo si no hubo un pago válido después.
--   · Vigente      dada de alta y sin baja (incluye atrasados).
--   · Activa       vigente y su último movimiento de cobro fue un pago, no un atraso.
-- Meses en hora de Colombia.
--
-- Solo CREA cosas nuevas: no toca, cambia ni borra nada existente.
-- Todo es «security invoker»: lee hotmart_eventos con los permisos de quien
-- pregunta, así que aplica la misma regla de la tabla (sesión segura).
-- ============================================================

-- 1. Una fila por suscripción con su alta, baja, pagos y atrasos
create or replace view public.v_ventas_subs
with (security_invoker = true) as
with devueltas as (
  select distinct transaccion from public.hotmart_eventos
  where evento in ('PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK') and transaccion is not null
),
pagos as (
  select e.suscriptor, e.fecha from public.hotmart_eventos e
  where e.evento = 'PURCHASE_APPROVED' and e.suscriptor is not null
    and (e.transaccion is null or e.transaccion not in (select transaccion from devueltas))
),
base as (
  select suscriptor, min(fecha) as alta, max(fecha) as ultimo_pago,
         array_agg(fecha order by fecha) as pagos
  from pagos group by suscriptor
)
select b.suscriptor, b.alta, b.ultimo_pago, b.pagos,
       case when baja_ev.fecha >= b.ultimo_pago then baja_ev.fecha end as baja,
       coalesce((select array_agg(a.fecha order by a.fecha) from public.hotmart_eventos a
                 where a.suscriptor = b.suscriptor and a.evento = 'PURCHASE_DELAYED'),
                '{}'::timestamptz[]) as atrasos
from base b
left join lateral (
  select e.fecha from public.hotmart_eventos e
  where e.suscriptor = b.suscriptor and e.fecha > b.alta
    and e.evento in ('SUBSCRIPTION_CANCELLATION', 'SUBSCRIPTION_INACTIVE', 'PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK')
  order by e.fecha desc, e.clave desc limit 1
) baja_ev on true;

-- 2. Vigente y activa (al día) en un momento dado
create or replace function public.ventas_vigente(p_alta timestamptz, p_baja timestamptz, t timestamptz)
returns boolean language sql immutable set search_path = '' as $$
  select p_alta <= t and (p_baja is null or p_baja > t)
$$;

create or replace function public.ventas_activa(p_alta timestamptz, p_baja timestamptz,
  p_pagos timestamptz[], p_atrasos timestamptz[], t timestamptz)
returns boolean language sql immutable set search_path = '' as $$
  with u as (
    select (select max(x) from unnest(p_pagos) x where x <= t) as pago,
           (select max(x) from unnest(p_atrasos) x where x <= t) as atraso
  )
  select public.ventas_vigente(p_alta, p_baja, t) and u.pago is not null
     and (u.atraso is null or u.atraso < u.pago)
  from u
$$;

-- 3. Médicos activos por mes entre dos fechas (gráfica de «Médicos activos»).
--    Cada mes: vigentes al cierre (o a «hasta», si el mes no termina dentro del
--    rango), y cuántos entraron y se fueron en el mes completo hasta ese corte.
create or replace function public.activos_por_mes(p_desde timestamptz, p_hasta timestamptz)
returns table (anio int, mes int, parcial boolean, vigentes int, entraron int, se_fueron int)
language sql stable set search_path = '' as $$
  with meses as (
    select (m at time zone 'America/Bogota') as ini,
           ((m + interval '1 month') at time zone 'America/Bogota') - interval '1 millisecond' as fin
    from generate_series(date_trunc('month', p_desde at time zone 'America/Bogota'),
                         p_hasta at time zone 'America/Bogota', interval '1 month') m
  ),
  cortes as (select ini, fin, least(fin, p_hasta) as corte from meses)
  select extract(year from c.ini at time zone 'America/Bogota')::int,
         extract(month from c.ini at time zone 'America/Bogota')::int - 1,   -- 0 = enero, como en JS
         c.corte < c.fin,
         (select count(*) from public.v_ventas_subs s where public.ventas_vigente(s.alta, s.baja, c.corte))::int,
         (select count(*) from public.v_ventas_subs s where s.alta >= c.ini and s.alta <= c.corte)::int,
         (select count(*) from public.v_ventas_subs s where s.baja >= c.ini and s.baja <= c.corte)::int
  from cortes c order by c.ini
$$;

-- 4. Vigentes y al día en un momento (la cifra grande de «Médicos activos»)
create or replace function public.activos_en(p_t timestamptz)
returns table (vigentes int, al_dia int)
language sql stable set search_path = '' as $$
  select count(*) filter (where public.ventas_vigente(alta, baja, p_t))::int,
         count(*) filter (where public.ventas_activa(alta, baja, pagos, atrasos, p_t))::int
  from public.v_ventas_subs
$$;

-- 5. Renovaciones del mes de p_ahora. La lista: activos y al día al cierre del
--    mes anterior. Cada uno cae en un grupo: pagaron (hubo pago este mes),
--    cancelaron (sin pago y ya no vigente), en reintento (sin pago, vigente y no
--    al día) o con cobro programado (el resto).
create or replace function public.renovaciones_mes(p_ahora timestamptz)
returns table (lista int, pagaron int, cobro_programado int, reintento int, cancelaron int)
language sql stable set search_path = '' as $$
  with ini as (select date_trunc('month', p_ahora at time zone 'America/Bogota') at time zone 'America/Bogota' as t),
  l as (
    select s.*, exists (select 1 from unnest(s.pagos) x, ini where x >= ini.t and x <= p_ahora) as pago
    from public.v_ventas_subs s, ini
    where public.ventas_activa(s.alta, s.baja, s.pagos, s.atrasos, ini.t - interval '1 millisecond')
  )
  select count(*)::int,
         count(*) filter (where pago)::int,
         count(*) filter (where not pago and public.ventas_activa(alta, baja, pagos, atrasos, p_ahora))::int,
         count(*) filter (where not pago and public.ventas_vigente(alta, baja, p_ahora)
                            and not public.ventas_activa(alta, baja, pagos, atrasos, p_ahora))::int,
         count(*) filter (where not pago and not public.ventas_vigente(alta, baja, p_ahora))::int
  from l
$$;

-- 6. Permisos: solo usuarios con sesión; nadie anónimo.
revoke all on public.v_ventas_subs from anon, authenticated;
grant select on public.v_ventas_subs to authenticated;
revoke execute on function public.ventas_vigente(timestamptz, timestamptz, timestamptz),
  public.ventas_activa(timestamptz, timestamptz, timestamptz[], timestamptz[], timestamptz),
  public.activos_por_mes(timestamptz, timestamptz), public.activos_en(timestamptz),
  public.renovaciones_mes(timestamptz)
  from public, anon;
grant execute on function public.ventas_vigente(timestamptz, timestamptz, timestamptz),
  public.ventas_activa(timestamptz, timestamptz, timestamptz[], timestamptz[], timestamptz),
  public.activos_por_mes(timestamptz, timestamptz), public.activos_en(timestamptz),
  public.renovaciones_mes(timestamptz)
  to authenticated;
