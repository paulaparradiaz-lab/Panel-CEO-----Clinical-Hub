/* ============================================================
   CLINICAL HUB · VENTAS › RESUMEN
   Como el inicio de Hotmart: la gráfica de ventas por día con un
   calendario (desde / hasta) y atajos de periodo; países del mismo
   rango (top 5 y «Mostrar más»); médicos activos al cierre de cada mes,
   con su propio selector de fechas (como el del MRR); y las renovaciones
   del mes: la lista de los que tenían que renovar este mes, fijada al cierre
   del mes anterior, y qué pasó con cada uno.
   Médicos activos y renovaciones los calcula Supabase (funciones
   activos_por_mes, activos_en y renovaciones_mes, ver
   sql/ventas_en_supabase.sql): aquí solo se pintan los resultados.
   Venta = cobro aprobado y no reembolsado (compra nueva o renovación).
   ============================================================ */
import { sb, escapar, num } from "./nucleo.js";
import { nombrePais } from "./ia.js";
import { finDelDia } from "./ventas-calculos.js";
import { usd, grafica, cabecera, armarAyudas, selectorFechas, armarSelector } from "./ventas-comun.js";

const DIA = 864e5;
const ZONA = -5 * 3600e3;
const PERIODOS = [
  ["hoy", "Hoy"], ["7", "7 días"], ["30", "30 días"], ["mes", "Este mes"], ["mesAnterior", "Mes anterior"]
];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"];

let periodo = "30";
let rangoElegido = null;   // [desde, hasta] del calendario
let datos = null;
/* Rango de «Médicos activos» (se conserva al volver a la pestaña); de entrada, desde la primera venta */
const elegidoActivos = { atajo: "todo", rango: null };
const aDia = t => new Date(t + ZONA).toISOString().slice(0, 10);
const deDia = (s, fin) => Date.parse(s + "T00:00:00Z") - ZONA + (fin ? DIA - 1 : 0);

export async function render(caja, d){
  datos = d;
  caja.innerHTML = `
<section class="caja" style="margin-top:18px">
  ${cabecera("ayuda-ventas-dia", "Ventas por día", { id: "vr-rango", texto: "" }, [
    "Cada <b>barra</b> son las ventas del día: cobros aprobados en Hotmart, tanto <b>compras nuevas</b> como <b>renovaciones</b> mensuales. Los reembolsos no cuentan.",
    "La <b>línea</b> es la <b>facturación neta</b> del día: lo que le queda a Clinical Hub en dólares, ya sin la tarifa de Hotmart ni los impuestos de cada país.",
    "Las <b>barras rojas hacia abajo</b> son el dinero que salió ese día por <b>reembolsos y contracargos</b> (en dólares netos).",
    "Elige las fechas en el calendario o usa los atajos (Hoy, 7 días…). «Por país» usa el mismo rango."])}
  <div class="vt-fechas vt-fechas-resumen">
    <label>Desde <input class="campo" type="date" id="vr-desde"></label>
    <label>Hasta <input class="campo" type="date" id="vr-hasta"></label>
    <div class="filtros" id="vr-periodos">${PERIODOS.map(([k, t]) =>
      '<button class="chip" data-periodo="' + k + '" aria-pressed="' + (k === periodo) + '">' + t + '</button>').join("")}</div>
  </div>
  <div class="vt-grafica"><canvas id="vr-grafica" aria-label="Ventas por día"></canvas></div>
</section>
<div class="vt-dos">
  <section class="caja">${cabecera("ayuda-paises", "Por país", "", [
    "Ventas del rango elegido arriba, según el país desde donde pagó el médico: la <b>cantidad de ventas</b> y su <b>facturación neta</b> en dólares.",
    "Se ven los 5 países con más ventas; «Mostrar más» abre el resto."])}<div id="vr-paises"></div></section>
  <section class="caja">${cabecera("ayuda-activos", "Médicos activos", "Al cierre de cada mes · * el mes todavía no cierra", [
    "Cada <b>barra</b> es cuántos médicos tenían la suscripción <b>vigente</b> al cierre de ese mes: ya pagaron y no se han dado de baja. Incluye a los que tienen un pago atrasado, porque todavía pueden pagar.",
    "El número grande es el total al final del rango elegido, separado entre los que están <b>al día</b> y los que tienen un <b>pago atrasado</b>.",
    "Pasa el mouse por una barra para ver cuántos <b>entraron</b> y cuántos <b>se fueron</b> ese mes. Elige las fechas o usa los atajos."])}
    ${selectorFechas("activos")}
    <div class="vt-activos-cifra" id="vr-activos-cifra"></div>
    <div class="vt-grafica"><canvas id="vr-activos" aria-label="Médicos activos por mes"></canvas></div></section>
</div>
<section class="caja" style="margin-top:14px">${cabecera("ayuda-cobros", "Renovaciones de " + MESES[new Date(Date.now() + ZONA).getUTCMonth()], { id: "vr-cobros-sub", texto: "" }, [
    "La lista se fija al <b>cierre del mes anterior</b>: todos los médicos que ese día estaban activos y al día, porque a todos les toca renovar este mes. Durante el mes la lista no cambia.",
    "Los que <b>entran nuevos</b> este mes no cuentan: su primera renovación es el mes siguiente. Tampoco los que al cierre del mes anterior ya estaban atrasados (deben de antes).",
    "<b>Pagaron:</b> Hotmart ya les cobró este mes. <b>Con cobro programado:</b> su fecha de cobro todavía no llega este mes; Hotmart les cobrará solo ese día. <b>En reintento de cobro:</b> Hotmart intentó cobrarles y no pudo; lo sigue intentando unos días. <b>Cancelaron:</b> se dieron de baja (o Hotmart los dio de baja) sin pagar este mes.",
    "La <b>tasa de renovación</b> es pagaron ÷ la lista. Al cerrar el mes queda la cifra final; lo que no renovó es el churn del mes."])}
  <div class="vt-cobros-barra" id="vr-cobros-barra"></div>
  <div class="vt-cobros-partes" id="vr-cobros-partes"></div>
</section>
`;
  armarAyudas(caja);
  /* Los atajos llenan el calendario; tocar el calendario quita el atajo */
  caja.querySelector("#vr-periodos").addEventListener("click", e => {
    const b = e.target.closest("[data-periodo]");
    if (!b) return;
    periodo = b.dataset.periodo;
    rangoElegido = rango(periodo, Date.now());
    pintar();
  });
  ["#vr-desde", "#vr-hasta"].forEach(sel => caja.querySelector(sel).addEventListener("change", () => {
    const a = caja.querySelector("#vr-desde").value, b = caja.querySelector("#vr-hasta").value;
    if (!a || !b || a > b) return;
    periodo = null;
    rangoElegido = [deDia(a), Math.min(deDia(b, true), Date.now())];
    pintar();
  }));
  if (!rangoElegido || periodo) rangoElegido = rango(periodo || "30", Date.now());
  pintar();
  const m = datos.modelo;
  const primero = m.subs.length ? m.subs.reduce((x, s) => Math.min(x, s.alta), Infinity) : Date.now();
  armarSelector(caja, "activos", elegidoActivos, primero, pintarActivos);
  pintarCobros();
}

const enIso = t => new Date(t).toISOString();
const sinDatos = (id, texto) => { const el = document.getElementById(id); if (el) el.innerHTML = '<p class="vacio">' + escapar(texto) + '</p>'; };

/* Renovaciones del mes: la lista son los activos y al día al cierre del mes
   anterior (a todos les toca renovar este mes); cada uno cae en un grupo */
async function pintarCobros(){
  const ahora = Date.now();
  const { data, error } = await sb.rpc("renovaciones_mes", { p_ahora: enIso(ahora) });
  if (!document.getElementById("vr-cobros-barra")) return;   // mientras llegaba, se cambió de vista
  if (error || !data || !data[0]) return sinDatos("vr-cobros-partes", "No se pudieron leer las renovaciones. " + ((error && error.message) || ""));
  const { lista, pagaron, cobro_programado: faltan, reintento, cancelaron } = data[0];
  const d = new Date(ahora + ZONA);
  const iniMes = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - ZONA;
  const total = lista || 1;
  const pct = n => Math.round(n / total * 100) + " %";
  const partes = [
    ["vt-cobros-pagaron", pagaron, "pagaron"],
    ["vt-cobros-faltan", faltan, "con cobro programado"],
    ["vt-cobros-reintento", reintento, "en reintento de cobro"],
    ["vt-cobros-cancelaron", cancelaron, "cancelaron"]
  ];
  const cierre = new Date(iniMes - 1 + ZONA);
  document.getElementById("vr-cobros-sub").textContent = num(lista) + " médicos tenían que renovar (activos y al día al " +
    cierre.getUTCDate() + " de " + MESES[cierre.getUTCMonth()] + ") · tasa de renovación " + pct(pagaron);
  document.getElementById("vr-cobros-barra").innerHTML = partes.filter(p => p[1])
    .map(([c, n, t]) => '<span class="' + c + '" style="width:' + (n / total * 100) + '%" title="' + num(n) + " " + t + '"></span>').join("");
  document.getElementById("vr-cobros-partes").innerHTML = partes.map(([c, n, t]) =>
    '<div class="vt-cobros-parte ' + c + '"><b>' + num(n) + '</b> ' + t + ' <span>' + pct(n) + '</span></div>').join("");
}

/* Médicos activos: una barra por mes del rango con los vigentes al cierre
   (o a la fecha «Hasta», si el mes no termina dentro del rango).
   Supabase entrega una fila por mes y la cifra al final del rango; si llega
   tarde una respuesta vieja (se cambiaron las fechas en el camino), se ignora. */
let turnoActivos = 0;
async function pintarActivos(a, b){
  const mio = ++turnoActivos;
  const [porMes, alFinal] = await Promise.all([
    sb.rpc("activos_por_mes", { p_desde: enIso(a), p_hasta: enIso(b) }),
    sb.rpc("activos_en", { p_t: enIso(b) })
  ]);
  if (mio !== turnoActivos || !document.getElementById("vr-activos-cifra")) return;
  const error = porMes.error || alFinal.error;
  if (error || !alFinal.data || !alFinal.data[0]) return sinDatos("vr-activos-cifra", "No se pudieron leer los médicos activos. " + ((error && error.message) || ""));
  const lista = porMes.data.map(x => ({ anio: x.anio, mes: x.mes, parcial: x.parcial,
    vigentes: x.vigentes, entraron: x.entraron, seFueron: x.se_fueron }));
  const { vigentes, al_dia: alDia } = alFinal.data[0];
  const esHoy = finDelDia(b) >= finDelDia(Date.now());
  const d = new Date(b + ZONA);
  document.getElementById("vr-activos-cifra").innerHTML = "<b>" + num(vigentes) + "</b><span>vigentes " +
    (esHoy ? "hoy" : "al " + d.getUTCDate() + " de " + MESES[d.getUTCMonth()]) + " · " + num(alDia) + " al día" +
    (vigentes > alDia ? " y " + num(vigentes - alDia) + " con pago atrasado" : "") + "</span>";
  grafica("vr-activos", {
    type: "bar",
    data: {
      labels: lista.map(x => MESES_CORTOS[x.mes] + (x.parcial ? " *" : "")),
      /* El mes que todavía no cierra va en el verde claro de la marca */
      datasets: [{ label: "Activos", data: lista.map(x => x.vigentes), borderRadius: 6,
        backgroundColor: lista.map(x => x.parcial ? "#c1e187" : "#7ab447") }]
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: i => { const x = lista[i[0].dataIndex]; return MESES[x.mes] + " " + x.anio + (x.parcial ? " (todavía no cierra)" : ""); },
          label: c => " " + num(c.raw) + (c.raw === 1 ? " activo" : " activos"),
          afterLabel: c => { const x = lista[c.dataIndex]; return " Entraron " + num(x.entraron) + " · se fueron " + num(x.seFueron); } } }
      },
      scales: { x: { ticks: { maxRotation: 0, autoSkip: true }, grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
}

/* Rango del periodo elegido y el anterior de igual duración */
function rango(clave, ahora){
  const hoyIni = finDelDia(ahora) - DIA + 1;
  if (clave === "hoy") return [hoyIni, ahora];
  if (clave === "7" || clave === "30") return [hoyIni - (Number(clave) - 1) * DIA, ahora];
  const d = new Date(ahora + ZONA);
  if (clave === "mes") return [Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - ZONA, ahora];
  const ini = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) - ZONA;
  const fin = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - ZONA - 1;
  return [ini, fin];
}

function cifras(m, a, b){
  const pagos = m.pagos.filter(p => p.t >= a && p.t <= b);
  return {
    pagos,
    ventas: pagos.length,
    facturacion: pagos.reduce((x, p) => x + p.valor, 0),
    nuevos: pagos.filter(p => p.nuevo).length,
    renovaciones: pagos.filter(p => !p.nuevo).length,
    reembolsos: m.reembolsos.filter(r => r.t >= a && r.t <= b).length,
    devuelto: m.reembolsos.filter(r => r.t >= a && r.t <= b).reduce((x, r) => x + r.valor, 0)
  };
}

function pintar(){
  const m = datos.modelo;
  const [a, b] = rangoElegido;
  const act = cifras(m, a, b);
  document.getElementById("vr-desde").value = aDia(a);
  document.getElementById("vr-hasta").value = aDia(b);
  document.querySelectorAll("#vr-periodos .chip").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.periodo === periodo)));
  document.getElementById("vr-rango").textContent = num(act.ventas) + " ventas · " + usd(act.facturacion) +
    " netos · " + num(act.nuevos) + " nuevos y " + num(act.renovaciones) + " renovaciones" +
    (act.reembolsos ? " · " + usd(act.devuelto) + " devueltos (" + num(act.reembolsos) + ")" : "");

  /* Ventas por día del rango elegido */
  const dias = [];
  for (let t = a; t <= b; t += DIA){
    const fin = finDelDia(t);
    const del = m.pagos.filter(p => p.t >= fin - DIA + 1 && p.t <= fin);
    const salen = m.reembolsos.filter(r => r.t >= fin - DIA + 1 && r.t <= fin);
    dias.push({ t, ventas: del.length, fact: del.reduce((x, p) => x + p.valor, 0),
                devuelto: salen.reduce((x, r) => x + r.valor, 0) });
  }
  /* Los dos ejes con el cero a la misma altura: las devoluciones bajan desde
     la misma línea donde suben las ventas */
  /* Y además con las mismas divisiones (4 a 6 por encima del cero, en
     números redondos): cada línea guía cae en un número de la izquierda y
     otro de la derecha. Se elige la cantidad que mejor llena la altura. */
  const paso = (tope, n, entero) => {
    const crudo = Math.max(tope * 1.05, entero ? 1 : 0.01) / n;   // un poco de aire arriba
    const base = Math.pow(10, Math.floor(Math.log10(crudo)));
    return [1, 2, 2.5, 5, 10].map(x => x * base).find(x => x >= crudo && (!entero || Number.isInteger(x))) || Math.ceil(crudo);
  };
  const topeVentas = Math.max(...dias.map(d => d.ventas)), topeFact = Math.max(...dias.map(d => d.fact));
  const { n: divisiones, pv: pasoVentas, pf: pasoFact } = [4, 5, 6]
    .map(n => ({ n, pv: paso(topeVentas, n, true), pf: paso(topeFact, n, true) }))   // dólares enteros
    .map(o => ({ ...o, lleno: Math.max(topeVentas, 1) / (o.pv * o.n) + Math.max(topeFact, .01) / (o.pf * o.n) }))
    .sort((x, y) => y.lleno - x.lleno)[0];
  const maxVentas = pasoVentas * divisiones;
  const maxFact = pasoFact * divisiones;
  const maxSale = Math.max(0, ...dias.map(d => d.devuelto)) * 1.1;
  const parte = maxSale / maxFact;
  grafica("vr-grafica", {
    type: "bar",
    data: {
      labels: dias.map(d => new Date(d.t + ZONA).getUTCDate() + "/" + (new Date(d.t + ZONA).getUTCMonth() + 1)),
      /* La línea de facturación va dibujada por encima de las barras (order 0) */
      datasets: [
        { type: "line", label: "Facturación neta (US$)", data: dias.map(d => Math.round(d.fact * 100) / 100),
          borderColor: "#2a4927", backgroundColor: "#2a4927", borderWidth: 2.5, pointRadius: 2.5,
          pointBackgroundColor: "#fff", pointBorderWidth: 1.5, tension: .3, yAxisID: "y2", order: 0 },
        { type: "bar", label: "Ventas", data: dias.map(d => d.ventas), backgroundColor: "rgba(193,225,135,.75)",
          borderRadius: 6, yAxisID: "y", order: 1 },
        { type: "bar", label: "Devoluciones (US$)", data: dias.map(d => d.devuelto ? -Math.round(d.devuelto * 100) / 100 : null),
          backgroundColor: "#d9654d", borderRadius: 6, minBarLength: 6, yAxisID: "y2", order: 2 }
      ]
    },
    options: {
      plugins: {
        legend: { labels: { font: { family: "DM Sans" }, boxWidth: 12 } },
        tooltip: { callbacks: { label: c => c.dataset.yAxisID === "y2"
          ? " " + (c.raw < 0 ? usd(-c.raw) + " devueltos" : "Facturación neta: " + usd(c.raw))
          : " " + num(c.raw) + (c.raw === 1 ? " venta" : " ventas") } }
      },
      scales: {
        /* Fechas derechas y espaciadas (en PC eran 30 inclinadas) */
        x: { ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 14 } },
        y: { min: -maxVentas * parte, max: maxVentas, title: { display: true, text: "Ventas" },
             ticks: { stepSize: pasoVentas, precision: 0, callback: v => v < 0 ? "" : v } },
        y2: { min: -maxSale, max: maxFact, position: "right", grid: { display: false }, title: { display: true, text: "US$" },
              ticks: { stepSize: pasoFact, callback: v => v < 0 ? "" : Math.round(v).toLocaleString("es-CO") } }
      }
    }
  });

  /* Países del periodo */
  /* limite: cuántas filas se ven de entrada; el resto, con «Mostrar más» */
  const agrupar = (clave, nombre, limite) => {
    const g = new Map();
    act.pagos.forEach(p => {
      const k = p[clave] || "—";
      if (!g.has(k)) g.set(k, { ventas: 0, fact: 0 });
      g.get(k).ventas++; g.get(k).fact += p.valor;
    });
    const filas = [...g.entries()].sort((x, y) => y[1].ventas - x[1].ventas);
    if (!filas.length) return '<p class="vacio">No hay ventas en este periodo.</p>';
    const max = filas[0][1].ventas;
    const resto = limite ? filas.length - limite : 0;
    return '<div class="vt-barras">' + filas.map(([k, v], i) =>
      '<div class="vt-barra-fila"' + (limite && i >= limite ? ' data-resto hidden' : '') + '><span class="vt-barra-nombre">' + escapar(nombre(k)) + '</span>' +
      '<span class="vt-barra"><span style="width:' + (v.ventas / max * 100) + '%"></span></span>' +
      '<span class="vt-barra-num">' + num(v.ventas) + ' · ' + escapar(usd(v.fact)) + '</span></div>').join("") + '</div>' +
      (resto > 0 ? '<button class="enlace vt-mas" type="button" data-mas>Mostrar ' + resto + ' más</button>' : '');
  };
  const paises = document.getElementById("vr-paises");
  paises.innerHTML = agrupar("pais", k => k === "—" ? "Sin país" : nombrePais(k), 5);
  const mas = paises.querySelector("[data-mas]");
  if (mas) mas.addEventListener("click", () => {
    const ocultos = paises.querySelectorAll("[data-resto]");
    const abrir = ocultos[0].hidden;
    ocultos.forEach(f => { f.hidden = !abrir; });
    mas.textContent = abrir ? "Mostrar menos" : "Mostrar " + ocultos.length + " más";
  });
}
