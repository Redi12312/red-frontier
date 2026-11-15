// Plan de la zona: marcas (hábitat, refugios, depósitos, ciencia, peligros, balizas, rover), itinerario de
// varias paradas, expedición larga en rover presurizado y guardar/cargar el plan en GeoJSON.
// Los hábitats y refugios agrandan la zona segura; los peligros con radio se vuelven terreno prohibido.
import { crearPlan, agregarMarca, editarMarca, moverMarca, borrarMarca, crearItinerario, validarItinerario, aGeoJSON, desdeGeoJSON } from "./marcas.js";
import { planificarExpedicion, contarPasos } from "./expedicion.js";
import { alcanzaParaRecargar, sirveDeRefugio } from "./consumibles.js";
import { guardar, enServidor } from "./guardado.js";
import { locale } from "./idioma.js";

const REFUGIOS = new Set(["habitat", "refugio"]);
const ETIQUETAS = {
  tripulacion: "Tripulación", energia_kwh: "Energía", capacidad_personas: "Capacidad", oxigeno_h: "Oxígeno de reserva",
  oxigeno_kg: "Oxígeno", comida_kcal: "Comida", filtros_co2_h: "Filtros de CO₂", botiquin: "Botiquín",
  agua_l: "Agua", bateria_kwh: "Batería", repuestos: "Repuestos", objetivo: "Objetivo", muestras_previstas: "Muestras previstas",
  minutos_trabajo: "Trabajo en la parada", descripcion: "Descripción", radio_exclusion_m: "Radio de exclusión",
  alcance_radio_m: "Alcance de radio", estacionado: "Estacionado", bateria_pct: "Batería",
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function crearPlanZona(ctx) {
  const cuenta = (n, uno, varios) => `${ctx.num(n)} ${n === 1 ? uno : varios}`;
  const { mapa, estado, $, num, fmt, aMapa, avisar, decisionHtml, duracion, animarTrazo, celdaALonLat, lonLatACelda, leerHttp, RAIZ } = ctx;
  let rotulos = null;
  let tipos = {}, cfgExp = null, cfgCons = null, cfgRutas = null;
  let plan = crearPlan(), zonaId = null;
  let borrador = { nombre: "Itinerario", vehiculo: "pie", paradas: [] };
  const marcadores = new Map(), circulos = new Map();
  let lineaItinerario = null, version = 0, ultimoItinerario = null;
  let capaExpedicion = null, ultimaExpedicion = null;

  async function cargarConfig() {
    const [m, e, c, rutas] = await Promise.all([leerHttp(`${RAIZ}/config/marcas.json`, "json"), leerHttp(`${RAIZ}/config/expedicion.json`, "json"),
      leerHttp(`${RAIZ}/config/consumibles.json`, "json"), leerHttp(`${RAIZ}/config/rutas.json`, "json")]);
    tipos = m.tipos; cfgExp = e; cfgCons = c; cfgRutas = rutas;
  }

  // ---------- Celdas y coordenadas ----------
  const meta = () => estado.zona.meta;
  function celdaDe(m) {
    const z = estado.zona, p = lonLatACelda(meta(), m.lon, m.lat);
    return { f: Math.min(z.alto - 1, Math.max(0, Math.round(p.f))), c: Math.min(z.ancho - 1, Math.max(0, Math.round(p.c))) };
  }
  function lonLat(celda) {
    const { lon, lat } = celdaALonLat(meta(), celda.f, celda.c);
    return { lon: ((lon % 360) + 360) % 360, lat };
  }
  const coordTexto = (m) => `${num(Math.abs(m.lat), 5)}° ${m.lat < 0 ? "S" : "N"}, ${num(m.lon, 5)}° E`;

  // ---------- Guardado local ----------
  const clave = () => `rf-plan-${zonaId}`;
  function guardarLocal() {
    const aviso = $("#plan-guardado");
    guardar(clave(), JSON.stringify({ geo: aGeoJSON(plan), borrador }));
    if (aviso) aviso.textContent = `✓ Guardado ${enServidor() ? "en el proyecto (guardado/estado.json) y en este navegador" : "en este navegador (usá «Guardar plan» para llevarlo a otra computadora)"} · ${new Date().toLocaleTimeString(ctx.locale || "es-UY", { hour: "2-digit", minute: "2-digit" })}`;
  }
  function leerLocal() {
    try {
      const d = JSON.parse(localStorage.getItem(clave()) || "null");
      if (!d) return null;
      const r = desdeGeoJSON(d.geo);
      return { plan: r.plan, borrador: d.borrador };
    } catch { return null; }
  }

  // ---------- Stock de hábitats, refugios y depósitos ----------
  // Un refugio solo cuenta si sostiene a la tripulación hasta un rescate; un depósito solo sirve de recarga si
  // alcanza para recargar todos los trajes. Si no, el motor sigue de largo (config/consumibles.json).
  const personas = () => estado.riesgo?.pie?.tripulacion?.valor ?? 2;
  function evaluarStock(m) {
    if (!cfgCons || !["habitat", "refugio", "deposito"].includes(m.tipo)) return null;
    try {
      const refugio = REFUGIOS.has(m.tipo) ? sirveDeRefugio(m.datos || {}, personas(), cfgCons) : null;
      const recarga = alcanzaParaRecargar(m.datos || {}, null, personas(), cfgCons);
      return { refugio, recarga };
    } catch (err) {
      return { error: err.message, refugio: REFUGIOS.has(m.tipo) ? { ok: false, motivo: err.message } : null, recarga: { ok: false, faltan: [] } };
    }
  }
  const NOMBRE_RECURSO = { oxigeno_kg: "oxígeno", agua_l: "agua", comida_kcal: "comida", energia_kwh: "energía", filtros_co2_h: "filtros de CO₂" };
  function stockHtml(m) {
    const e = evaluarStock(m);
    if (!e) return "";
    const faltan = (e.recarga.faltan || []).map((f) => `${NOMBRE_RECURSO[f.recurso] || f.recurso}${f.falta ? ` (faltan ${num(f.falta, 1)} ${f.unidad})` : " (sin informar)"}`);
    return `${e.refugio ? `<p class="${e.refugio.ok ? "ok" : "falla"}">${e.refugio.ok ? "✔ Sirve de refugio" : "✖ No cuenta como refugio"}: ${esc(e.refugio.motivo)}</p>` : ""}
      <p class="${e.recarga.ok ? "ok" : "falla"}">${e.recarga.ok ? `✔ Alcanza para recargar los trajes de ${personas()}` : `✖ No alcanza para recargar ${personas()} trajes: ${esc(faltan.join(", "))}`}</p>`;
  }
  // Datos iniciales de una marca nueva: el inventario propuesto por tipo (editable en su ficha).
  function datosIniciales(tipo) {
    const t = tipos[tipo], porDefecto = cfgCons?.inventarios?.[tipo] || {};
    return Object.fromEntries(Object.keys(t.campos || {}).map((k) => [k, porDefecto[k]?.valor ?? null]));
  }

  // ---------- Marcas en el mapa ----------
  function icono(m) {
    const t = tipos[m.tipo] || { letra: "?", color: "#888" };
    const e = evaluarStock(m);
    const falla = e && (e.refugio ? !e.refugio.ok : !e.recarga.ok);
    return L.divIcon({ className: "", html: `<div class="marca-plan${falla ? " sin-stock" : ""}" style="--c:${t.color}" title="${esc(m.nombre)}${falla ? " · sin el stock necesario" : ""}">${t.letra}${falla ? "<b>!</b>" : ""}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
  }

  function dibujarMarca(m) {
    marcadores.get(m.id)?.remove();
    circulos.get(m.id)?.remove();
    const c = celdaDe(m);
    // Fijas por defecto: para moverlas hay que pedirlo en su ficha («Mover»), así no se corren sin querer.
    const mk = L.marker(aMapa(c.f, c.c), { icon: icono(m), draggable: true, keyboard: true, title: m.nombre }).addTo(mapa);
    mk.dragging?.disable();
    mk.bindPopup(() => popup(m.id), { minWidth: 230, maxWidth: 280, className: "popup-plan" });
    mk.on("dragend", () => {
      const p = mk.getLatLng();
      const z = estado.zona;
      const celda = { f: Math.floor(-p.lat), c: Math.floor(p.lng) };
      if (celda.f < 0 || celda.c < 0 || celda.f >= z.alto || celda.c >= z.ancho) { dibujarMarca(buscar(m.id)); return; }
      const ll = lonLat(celda);
      moverMarca(plan, m.id, ll.lon, ll.lat);
      cambio(buscar(m.id));
      avisar(`${m.nombre} quedó fijada en su nuevo lugar.`);
    });
    marcadores.set(m.id, mk);
    const radio = m.tipo === "peligro" ? Number(m.datos?.radio_exclusion_m) : 0;
    if (radio > 0) {
      circulos.set(m.id, L.circle(aMapa(c.f, c.c), { radius: radio / estado.zona.paso, color: tipos.peligro.color, weight: 1.5, dashArray: "4 4", fillOpacity: 0.12, interactive: false }).addTo(mapa));
    }
  }

  const buscar = (id) => plan.marcas.find((x) => x.id === id);

  function popup(id) {
    const m = buscar(id);
    const t = tipos[m.tipo];
    const div = document.createElement("div");
    div.className = "popup-marca";
    const enItinerario = borrador.paradas.some((p) => p.marca === id);
    div.innerHTML = `<div class="cabeza"><i style="--c:${t.color}">${t.letra}</i><input class="nombre" value="${esc(m.nombre)}" aria-label="Nombre de la marca"></div>
      <select class="tipo" aria-label="Tipo de marca">${Object.entries(tipos).map(([k, v]) => `<option value="${k}" ${k === m.tipo ? "selected" : ""}>${v.nombre}</option>`).join("")}</select>
      <p class="ayuda">${t.descripcion}${REFUGIOS.has(m.tipo) ? " Cuenta como refugio: agranda la zona segura." : ""}${m.tipo === "peligro" ? " Con radio, la ruta lo esquiva." : ""}</p>
      <div class="campos">${Object.entries(t.campos || {}).map(([k, c]) => c.tipo === "booleano"
        ? `<label>${ETIQUETAS[k] || k}<select data-campo="${k}" data-booleano><option value="">sin informar</option>
            <option value="si" ${m.datos?.[k] === true ? "selected" : ""}>sí</option><option value="no" ${m.datos?.[k] === false ? "selected" : ""}>no</option></select></label>`
        : `<label>${ETIQUETAS[k] || k}${c.unidad ? ` (${c.unidad})` : ""}
        <input data-campo="${k}" ${c.unidad ? 'type="number" step="any" min="0"' : ""} value="${esc(m.datos?.[k] ?? "")}" placeholder="sin informar"></label>`).join("")}</div>
      <div class="autonomia" data-autonomia>${stockHtml(m)}</div>
      ${["habitat", "refugio", "deposito"].includes(m.tipo) ? '<button type="button" data-acc="stock" class="chico">Cargar el stock típico (propuesta)</button>' : ""}
      <div class="coord">📌 Fijada en ${coordTexto(m)}</div>
      <div class="acciones">
        <button type="button" data-acc="mover" class="chico">Mover</button>
        <button type="button" data-acc="itinerario" class="chico" ${enItinerario && !REFUGIOS.has(m.tipo) ? "disabled" : ""}>${enItinerario && !REFUGIOS.has(m.tipo) ? "Ya está en el itinerario" : "Agregar al itinerario"}</button>
        ${REFUGIOS.has(m.tipo) ? '<button type="button" data-acc="base" class="chico">Usar como base de la ruta</button>' : ""}
        <button type="button" data-acc="borrar" class="chico peligro">Borrar</button>
      </div>`;
    div.querySelector(".nombre").addEventListener("change", (e) => {
      if (!e.target.value.trim()) { e.target.value = m.nombre; return; }
      cambio(editarMarca(plan, id, { nombre: e.target.value.trim() }), false);
    });
    div.querySelector(".tipo").addEventListener("change", (e) => {
      cambio(editarMarca(plan, id, { tipo: e.target.value }));
      marcadores.get(id)?.openPopup();
    });
    div.querySelectorAll("[data-campo]").forEach((inp) => inp.addEventListener("change", () => {
      const k = inp.dataset.campo, crudo = inp.value.trim();
      const valor = "booleano" in inp.dataset ? (crudo === "" ? null : crudo === "si") : crudo === "" ? null : inp.type === "number" ? Number(crudo) : crudo;
      if (inp.type === "number" && valor !== null && !Number.isFinite(valor)) { inp.value = ""; return; }
      cambio(editarMarca(plan, id, { datos: { [k]: valor } }), k === "radio_exclusion_m");
    }));
    div.querySelector('[data-acc="itinerario"]').addEventListener("click", () => { mapa.closePopup(); agregarParada(id); });
    div.querySelector('[data-acc="base"]')?.addEventListener("click", () => { mapa.closePopup(); ctx.usarComoBase(celdaDe(m)); });
    div.querySelector('[data-acc="borrar"]').addEventListener("click", () => { mapa.closePopup(); quitar(id); });
    div.querySelector('[data-acc="stock"]')?.addEventListener("click", () => {
      cambio(editarMarca(plan, id, { datos: datosIniciales(m.tipo) }));
      marcadores.get(id)?.openPopup();
      avisar(`${m.nombre}: stock típico cargado (propuesta a calibrar). Ajustalo con lo que de verdad hay.`);
    });
    div.querySelector('[data-acc="mover"]').addEventListener("click", () => {
      mapa.closePopup();
      const mk = marcadores.get(id);
      mk?.dragging?.enable();
      avisar(`Arrastrá ${m.nombre} a su nuevo lugar; al soltarla queda fijada de nuevo.`);
    });
    return div;
  }

  // Después de cada cambio: redibujar, guardar y, si cambió lo que afecta la seguridad, avisar al motor.
  function cambio(m, redibujar = true) {
    if (redibujar && m) dibujarMarca(m);
    guardarLocal();
    dibujarResumen();
    dibujarItinerario();
    ctx.alCambiarPlan();
    ctx.alCambiarBases?.();
  }

  function agregar(tipo, celda, nombre) {
    const t = tipos[tipo];
    const n = plan.marcas.filter((x) => x.tipo === tipo).length + 1;
    const datos = datosIniciales(tipo);
    const m = agregarMarca(plan, { tipo, nombre: nombre || `${t.nombre} ${n}`, ...lonLat(celda), datos });
    cambio(m);
    avisar(`${m.nombre} agregado al plan. Clic sobre la marca para editarla${REFUGIOS.has(tipo) ? "; cuenta como refugio" : ""}.`);
    return m;
  }

  function quitar(id) {
    const { marca, itinerariosAfectados } = borrarMarca(plan, id);
    marcadores.get(id)?.remove(); marcadores.delete(id);
    circulos.get(id)?.remove(); circulos.delete(id);
    const antes = borrador.paradas.length;
    borrador.paradas = borrador.paradas.filter((p) => p.marca !== id);
    cambio(null);
    avisar(`Se borró ${marca.nombre}${antes !== borrador.paradas.length || itinerariosAfectados.length ? " y se sacó del itinerario" : ""}.`);
  }

  // Lo que el motor necesita para la seguridad: refugios y peligros con radio (en celdas).
  function refugios() {
    return plan.marcas.filter((m) => REFUGIOS.has(m.tipo) && (evaluarStock(m)?.refugio?.ok ?? true)).map(celdaDe);
  }
  function exclusiones() {
    return plan.marcas.filter((m) => m.tipo === "peligro" && Number(m.datos?.radio_exclusion_m) > 0)
      .map((m) => ({ ...celdaDe(m), radio_celdas: Number(m.datos.radio_exclusion_m) / estado.zona.paso }));
  }
  const balizas = () => plan.marcas.filter((m) => m.tipo === "baliza").map((m) => ({ ...celdaDe(m), tipo: "baliza" }));
  // Bases desde donde se puede salir (hábitats y refugios) y lugares donde recargar en el camino (más depósitos).
  const bases = () => plan.marcas.filter((m) => REFUGIOS.has(m.tipo)).map((m) => ({ id: m.id, nombre: m.nombre, tipo: m.tipo, celda: celdaDe(m) }));
  // Se mandan también los descartados: el Worker informa el motivo y descuenta el stock
  // por rama del grafo, sin modificar el inventario guardado por la persona.
  const nodosRuta = () => plan.marcas.filter((m) => REFUGIOS.has(m.tipo) || m.tipo === "deposito")
    .map((m) => ({ id: m.id, nombre: m.nombre, tipo: m.tipo, datos: { ...m.datos }, recargaOk: evaluarStock(m)?.recarga?.ok === true, ...celdaDe(m) }));
  // Marcas que el motor deja de lado por falta de stock (para avisar).
  const sinStock = () => plan.marcas.filter((m) => { const e = evaluarStock(m); return e && (e.refugio ? !e.refugio.ok : !e.recarga.ok); });
  function baseCerca(celda, radio) {
    let mejor = null, d0 = radio;
    for (const b of bases()) { const d = Math.hypot(b.celda.f - celda.f, b.celda.c - celda.c); if (d <= d0) { d0 = d; mejor = b; } }
    return mejor;
  }
  // La base de salida elegida también es el comienzo (y la vuelta) del itinerario.
  function cambiarSalida(id) {
    const p = borrador.paradas;
    if (!p.length) { agregarParada(id); return; }
    const vuelve = p.at(-1).marca === p[0].marca;
    p[0].marca = id;
    if (vuelve) p.at(-1).marca = id;
    guardarLocal(); borrarResultado(); dibujarItinerario();
  }

  // ---------- Resumen de marcas ----------
  function dibujarResumen() {
    const caja = $("#plan-marcas");
    if (!caja) return;
    if (!plan.marcas.length) {
      caja.innerHTML = '<p class="ayuda">Sin marcas todavía. Clic derecho en el mapa para poner un hábitat, refugios, depósitos, paradas científicas, peligros o balizas.</p>';
      return;
    }
    const porTipo = Object.entries(tipos).map(([k, t]) => [k, t, plan.marcas.filter((m) => m.tipo === k)]).filter(([, , l]) => l.length);
    const fuera = sinStock();
    caja.innerHTML = `${fuera.length ? `<p class="falla aviso-stock">⚠ ${fuera.length === 1 ? "1 marca no tiene" : `${fuera.length} marcas no tienen`} el stock necesario y el motor la${fuera.length === 1 ? "" : "s"} deja de lado: ${fuera.map((m) => esc(m.nombre)).join(", ")}.</p>` : ""}<div class="chips">${porTipo.map(([k, t, l]) => `<span class="chip" title="${esc(t.descripcion)}"><i style="--c:${t.color}">${t.letra}</i>${l.length} ${t.nombre.toLowerCase()}</span>`).join("")}</div>
      <details class="lista-marcas"><summary>Ver las ${plan.marcas.length} marcas</summary><ul>${plan.marcas.map((m) => `<li><button type="button" class="enlace" data-ir="${m.id}"><i style="--c:${tipos[m.tipo].color}">${tipos[m.tipo].letra}</i>${esc(m.nombre)}</button></li>`).join("")}</ul></details>`;
    caja.querySelectorAll("[data-ir]").forEach((b) => b.addEventListener("click", () => {
      const mk = marcadores.get(b.dataset.ir);
      if (mk) { mapa.setView(mk.getLatLng(), Math.max(mapa.getZoom(), 0)); mk.openPopup(); }
    }));
  }

  // ---------- Itinerario ----------
  function agregarParada(id) {
    const m = buscar(id);
    if (!borrador.paradas.length) {
      if (!REFUGIOS.has(m.tipo)) { avisar("El itinerario empieza y termina en un hábitat o refugio: agregá uno primero (clic derecho → H o R)."); return; }
      borrador.paradas = [{ marca: id, minutos: 0 }, { marca: id, minutos: 0 }];
      ctx.baseDelItinerario(celdaDe(m), id);
    } else {
      const minutos = Number(m.datos?.minutos_trabajo) || cfgExp.trabajo_por_parada_min.valor;
      borrador.paradas.splice(borrador.paradas.length - 1, 0, { marca: id, minutos });
    }
    ctx.mostrarItinerario();
    guardarLocal();
    dibujarItinerario();
    avisar(`${m.nombre} está en el itinerario (${borrador.paradas.length} paradas).`);
  }

  // Clic izquierdo en el mapa con la pestaña Itinerario: primero el hábitat, después las paradas científicas.
  function alClicMapa(celda) {
    if (!borrador.paradas.length) {
      const existente = plan.marcas.find((m) => REFUGIOS.has(m.tipo));
      const m = existente || agregar("habitat", celda);
      agregarParada(m.id);
      if (existente) avisar(`El itinerario sale de ${existente.nombre}. Clic derecho en el mapa para agregar paradas.`);
      return;
    }
    const m = agregar("ciencia", celda);
    agregarParada(m.id);
    if (ctx.fueraDeZonaSegura(celda)) avisar(`${m.nombre} queda fuera de la zona segura sombreada: el itinerario no se va a aprobar. Movela, o poné un refugio cerca (clic derecho → R).`);
  }

  function dibujarItinerario() {
    const caja = $("#itinerario");
    if (!caja) return;
    const p = borrador.paradas;
    $("#itinerario-calcular").disabled = p.length < 2 || !estado.prohibido;
    $("#itinerario-vaciar").disabled = !p.length;
    if (!p.length) { caja.innerHTML = '<p class="ayuda">Clic derecho en el mapa → «Parada del itinerario aquí»: la primera pone (o usa) el hábitat; las siguientes, paradas científicas. También podés usar «Agregar al itinerario» en cualquier marca.</p>'; return; }
    const refs = plan.marcas.filter((m) => REFUGIOS.has(m.tipo));
    caja.innerHTML = `<ol class="paradas">${p.map((s, k) => {
      const m = buscar(s.marca);
      const t = tipos[m.tipo];
      const ico = `<i style="--c:${t.color}">${t.letra}</i>`;
      if (k === 0) return `<li>${ico}<span class="nombre">${esc(m.nombre)}</span><span class="rol">salida</span></li>`;
      if (k === p.length - 1) {
        return `<li>${ico}<select data-final aria-label="Refugio de llegada">${refs.map((r) => `<option value="${r.id}" ${r.id === s.marca ? "selected" : ""}>${esc(r.nombre)}</option>`).join("")}</select><span class="rol">llegada</span></li>`;
      }
      return `<li>${ico}<span class="nombre">${esc(m.nombre)}</span>
        <input type="number" min="0" step="5" value="${s.minutos}" data-min="${k}" aria-label="Minutos de trabajo"><span class="rol">min</span>
        <button type="button" class="mini" data-sube="${k}" ${k === 1 ? "disabled" : ""} title="Antes">↑</button>
        <button type="button" class="mini" data-baja="${k}" ${k === p.length - 2 ? "disabled" : ""} title="Después">↓</button>
        <button type="button" class="mini" data-quita="${k}" title="Sacar del itinerario">✕</button></li>`;
    }).join("")}</ol>`;
    const rehacer = () => { guardarLocal(); dibujarItinerario(); borrarResultado(); };
    caja.querySelectorAll("[data-min]").forEach((inp) => inp.addEventListener("change", () => {
      p[+inp.dataset.min].minutos = Math.max(0, Number(inp.value) || 0); rehacer();
    }));
    caja.querySelectorAll("[data-sube]").forEach((b) => b.addEventListener("click", () => { const k = +b.dataset.sube; [p[k - 1], p[k]] = [p[k], p[k - 1]]; rehacer(); }));
    caja.querySelectorAll("[data-baja]").forEach((b) => b.addEventListener("click", () => { const k = +b.dataset.baja; [p[k + 1], p[k]] = [p[k], p[k + 1]]; rehacer(); }));
    caja.querySelectorAll("[data-quita]").forEach((b) => b.addEventListener("click", () => { p.splice(+b.dataset.quita, 1); if (p.length < 3 && p[0]?.marca === p.at(-1)?.marca && p.length === 2) { /* queda ida y vuelta al mismo refugio */ } rehacer(); }));
    caja.querySelector("[data-final]")?.addEventListener("change", (e) => { p[p.length - 1].marca = e.target.value; rehacer(); });
  }

  function borrarResultado() {
    lineaItinerario?.remove(); lineaItinerario = null;
    rotulos?.remove(); rotulos = null;
    ultimoItinerario = null;
    $("#itinerario-resultado").innerHTML = "";
  }

  function calcularItinerario() {
    const problemas = validarItinerario(plan, { ...borrador, vehiculo: estado.zona.meta.vehiculo === "rover" ? "rover" : "pie" });
    if (problemas.length) { $("#itinerario-resultado").innerHTML = `<ul class="motivos">${problemas.map((x) => `<li class="rojo">${esc(x)}</li>`).join("")}</ul>`; return; }
    borrarResultado();
    $("#itinerario-calcular").disabled = true;
    avisar("Calculando el itinerario: ruta segura entre cada par de paradas…");
    estado.worker.postMessage({
      tipo: "itinerario", version: ++version, perfil: estado.perfiles[0], refugios: refugios(),
      paradas: borrador.paradas.map((s) => ({ ...celdaDe(buscar(s.marca)), minutos: s.minutos })),
    });
  }

  function alResponderItinerario(d) {
    if (d.version !== version) return;
    $("#itinerario-calcular").disabled = false;
    const z = estado.zona;
    const caja = $("#itinerario-resultado");
    if (!d.ruta) { caja.innerHTML = '<p class="ayuda">No hay ruta segura entre las paradas: revisá que estén dentro de la zona segura de algún refugio.</p>'; avisar("Itinerario sin ruta segura."); return; }
    ultimoItinerario = d;
    const si = (ctx.evaluacionCompleta ? ctx.evaluacionCompleta(d.evaluacion) : d.evaluacion).decision === "SI";
    const color = si ? "#4cc488" : "#d33a2c";
    lineaItinerario = L.polyline(d.ruta.celdas.map((i) => aMapa(Math.floor(i / z.ancho), i % z.ancho)), { color, weight: 5, opacity: 0.95, dashArray: si ? null : "8 6" }).addTo(mapa);
    animarTrazo(lineaItinerario);
    rotulos?.remove();
    rotulos = L.layerGroup().addTo(mapa);
    let desde = 0;
    ctx.rotularTramos(rotulos, d.tramos.filter((t) => t.ok).map((t, k) => {
      const tramo = { celdas: d.ruta.celdas.slice(desde, t.fin + 1), texto: `${k + 1} · ${fmt.dist(t.metros)}` };
      desde = t.fin;
      return tramo;
    }));
    const r = d.ruta, pie = z.meta.vehiculo !== "rover";
    const pasos = pie ? contarPasos(r.distancia, cfgExp) : null;
    const malos = d.tramos.filter((t) => !t.ok);
    const total = r.tiempo + r.paradasMin * 60 + (borrador.paradas.at(-1).minutos || 0) * 60;
    caja.innerHTML = `${decisionHtml(d.evaluacion)}${ctx.confiabilidadHtml ? ctx.confiabilidadHtml(r) : ""}
      <div class="datos">
        <span>${fmt.dist(r.distancia)}</span><span>${duracion(r.tiempo)} de marcha</span>
        <span>${num(r.paradasMin)} min de trabajo</span><span>${duracion(total)} en total</span>
        <span>Sube ${fmt.alt(r.sube)}</span><span>Baja ${fmt.alt(r.baja)}</span>
        ${pasos ? `<span title="${esc(pasos.fuente)}">≈ ${num(pasos.pasos)} pasos</span><span>paso de ${num(pasos.largo_paso_m, 2)} m (a calibrar)</span>` : ""}
      </div>
      ${malos.length ? `<ul class="motivos">${malos.map((t) => `<li class="rojo">Sin ruta segura entre la parada ${t.desde + 1} y la ${t.hasta + 1}.</li>`).join("")}</ul>` : ""}
      <div class="acciones"><button type="button" class="primario" id="itinerario-simular">Simular la salida</button></div>`;
    caja.querySelector("#itinerario-simular").addEventListener("click", () => ctx.simular(r, "Itinerario"));
    ctx.dibujarPerfil(r, color);
    avisar(si ? "Itinerario aprobado. Podés simular la salida." : "Itinerario NO aprobado: mirá qué controles no cumple.");
  }

  // ---------- Expedición larga (rover presurizado) ----------
  function calcularExpedicion() {
    const b = estado.marcas.base?.celda, d = estado.marcas.destino?.celda;
    if (!b || !d) { avisar("Marcá la base (B) y el destino (D) de la expedición en el mapa."); return; }
    borrarExpedicion();
    $("#exp-calcular").disabled = true;
    avisar("Buscando la ruta de la expedición (solo terreno apto para el rover)…");
    estado.worker.postMessage({ tipo: "expedicion", perfil: estado.perfiles[0], inicio: b, fin: d });
  }

  function borrarExpedicion() {
    capaExpedicion?.remove(); capaExpedicion = null; ultimaExpedicion = null;
    $("#exp-resultado").innerHTML = "";
  }

  function alResponderExpedicion(d) {
    $("#exp-calcular").disabled = false;
    const caja = $("#exp-resultado");
    if (d.error) { caja.innerHTML = '<p class="ayuda">No hay camino apto para el rover entre la base y el destino.</p>'; avisar("Expedición sin camino."); return; }
    const z = estado.zona;
    const rovers = Number($("#exp-rovers").value) || 2;
    // Paradas científicas del plan que quedan a menos de 2 km de la ruta.
    const pts = d.celdas.map((i) => ({ f: Math.floor(i / z.ancho), c: i % z.ancho }));
    const paradas = [];
    for (const m of plan.marcas.filter((x) => x.tipo === "ciencia")) {
      const c = celdaDe(m);
      let mejor = Infinity, k = -1;
      pts.forEach((p, j) => { const dd = Math.hypot(p.f - c.f, p.c - c.c); if (dd < mejor) { mejor = dd; k = j; } });
      if (mejor * z.paso <= 2000) paradas.push({ distancia_m: d.distancias_m[k], minutos: Number(m.datos?.minutos_trabajo) || cfgExp.trabajo_por_parada_min.valor, nombre: m.nombre });
    }
    paradas.sort((a, b) => a.distancia_m - b.distancia_m);
    const exp = planificarExpedicion({ distancias_m: d.distancias_m, tiempos_s: d.tiempos_s }, cfgExp, { rovers, paradas: paradas.map(({ distancia_m, minutos }) => ({ distancia_m, minutos })) });
    ultimaExpedicion = { d, exp, rovers };

    // En el mapa: la ruta, las noches y lo que hay que instalar antes de salir.
    const enKm = (km) => {
      let k = d.distancias_m.findIndex((x) => x >= km * 1000);
      if (k < 0) k = d.celdas.length - 1;
      return aMapa(pts[k].f, pts[k].c);
    };
    capaExpedicion = L.layerGroup().addTo(mapa);
    L.polyline(pts.map((p) => aMapa(p.f, p.c)), { color: "#f0a64a", weight: 4, opacity: 0.95 }).addTo(capaExpedicion);
    exp.soles.forEach((s) => {
      if (!s.duerme || s.duerme.km >= exp.totales.km_ida && s.manejo.tramos.some((t) => t.sentido === "vuelta")) return;
      L.marker(enKm(s.duerme.km), { icon: L.divIcon({ className: "", html: `<div class="noche" title="Noche del sol ${s.sol}">${s.sol}</div>`, iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false }).addTo(capaExpedicion);
    });
    for (const [lista, tipo] of [[exp.depositos, "deposito"], [exp.refugios, "refugio"]]) {
      for (const x of lista) {
        L.marker(enKm(x.km), { icon: L.divIcon({ className: "", html: `<div class="marca-plan propuesta" style="--c:${tipos[tipo].color}" title="${tipos[tipo].nombre} requerido a ${num(x.km)} km">${tipos[tipo].letra}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false }).addTo(capaExpedicion);
      }
    }
    animarTrazo(capaExpedicion.getLayers()[0]);

    const tt = exp.totales;
    caja.innerHTML = `<div class="decision ${exp.avisos.length ? "ambar" : "si"}">
        <div class="veredicto">${num(tt.soles)} SOLES · ${fmt.dist(tt.km_ida_vuelta * 1000).toUpperCase()} IDA Y VUELTA</div>
        ${exp.avisos.length ? `<ul class="motivos">${exp.avisos.map((a) => `<li class="ambar">${esc(a)}</li>`).join("")}</ul>` : '<div class="motivo">Sin depósitos ni refugios extra: alcanza con la reserva del rover.</div>'}
      </div>
      <div class="datos">
        <span>${fmt.dist(tt.km_ida * 1000)} de ida</span><span>${num(tt.horas_manejo, 1)} h de manejo</span>
        <span>${num(tt.horas_ciencia, 1)} h de ciencia</span><span>${num(tt.horas_descanso)} h de descanso</span>
        <span>${cuenta(exp.depositos.length, "depósito", "depósitos")}</span><span>${cuenta(exp.refugios.length, "refugio", "refugios")}</span>
      </div>
      <table class="tabla-soles"><thead><tr><th>Sol</th><th>Manejo</th><th>Ciencia</th><th>Noche</th></tr></thead><tbody>
      ${exp.soles.map((s) => `<tr><td>${s.sol}</td>
        <td>${s.manejo.tramos.map((t) => `${t.sentido === "vuelta" ? "↩ " : ""}${fmt.dist(t.desde_km * 1000)} → ${fmt.dist(t.hasta_km * 1000)} (${num(t.horas, 1)} h)`).join("<br>") || "—"}</td>
        <td>${s.paradas.map((p) => `${num(p.minutos)} min a km ${num(p.distancia_km)}`).join("<br>") || "—"}</td>
        <td>${s.duerme ? `km ${num(s.duerme.km)}` : "base"}</td></tr>`).join("")}
      </tbody></table>
      <details class="supuestos"><summary>Supuestos del cálculo</summary><ul>${exp.supuestos.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>
      <div class="acciones">${exp.depositos.length || exp.refugios.length ? '<button type="button" id="exp-agregar" class="primario">Agregar depósitos y refugios al plan</button>' : ""}</div>`;
    caja.querySelector("#exp-agregar")?.addEventListener("click", () => {
      const celdaKm = (km) => { let k = d.distancias_m.findIndex((x) => x >= km * 1000); if (k < 0) k = pts.length - 1; return pts[k]; };
      exp.depositos.forEach((x, k) => agregar("deposito", celdaKm(x.km), `Depósito ${k + 1} (km ${num(x.km)})`));
      exp.refugios.forEach((x, k) => agregar("refugio", celdaKm(x.km), `Refugio ${k + 1} (km ${num(x.km)})`));
      avisar(`Se agregaron ${exp.depositos.length} depósitos y ${exp.refugios.length} refugios al plan. Guardalo para compartirlo.`);
    });
    avisar(`Expedición: ${num(tt.soles)} soles; hay que instalar ${cuenta(exp.depositos.length, "depósito", "depósitos")} y ${cuenta(exp.refugios.length, "refugio", "refugios")}.`);
  }

  // ---------- Guardar y cargar ----------
  function exportar() {
    const copia = desdeGeoJSON(aGeoJSON(plan)).plan;
    copia.itinerarios = [];
    if (borrador.paradas.length >= 2) {
      try { crearItinerario(copia, { ...borrador, vehiculo: estado.zona.meta.vehiculo === "rover" ? "rover" : "pie" }); } catch { /* borrador incompleto: se guardan solo las marcas */ }
    }
    const geo = aGeoJSON(copia);
    geo.properties.zona = zonaId;
    geo.properties.app = "Red Frontier PDE";
    geo.properties.crs = "Marte, esfera IAU 2000 (R = 3 396 190 m), latitud planetocéntrica, longitud este";
    const url = URL.createObjectURL(new Blob([JSON.stringify(geo, null, 1)], { type: "application/geo+json" }));
    const a = document.createElement("a");
    a.href = url; a.download = `plan-${zonaId}.geojson`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    avisar(`Plan guardado: ${plan.marcas.length} marcas${copia.itinerarios.length ? " y el itinerario" : ""}.`);
  }

  async function importar(archivo) {
    try {
      const geo = JSON.parse(await archivo.text());
      if (geo.properties?.zona && geo.properties.zona !== zonaId) avisar(`Ojo: el plan es de la zona ${geo.properties.zona}; las marcas fuera de esta zona no se ven.`);
      const r = desdeGeoJSON(geo);
      reemplazar(r.plan, r.plan.itinerarios[0] ? { nombre: r.plan.itinerarios[0].nombre, vehiculo: r.plan.itinerarios[0].vehiculo, paradas: r.plan.itinerarios[0].paradas } : null);
      guardarLocal();
      ctx.alCambiarPlan();
      ctx.alCambiarBases?.();
      avisar(`Plan cargado: ${plan.marcas.length} marcas${r.problemas.length ? ` · ${r.problemas.length} problemas: ${r.problemas.slice(0, 2).join(" ")}` : ""}.`);
    } catch (err) {
      avisar(`No se pudo leer el plan: ${err.message}`);
    }
  }

  function reemplazar(nuevo, nuevoBorrador) {
    for (const mk of marcadores.values()) mk.remove();
    for (const c of circulos.values()) c.remove();
    marcadores.clear(); circulos.clear();
    plan = nuevo;
    borrador = nuevoBorrador ? { ...nuevoBorrador, paradas: nuevoBorrador.paradas.filter((p) => plan.marcas.some((m) => m.id === p.marca)) } : { nombre: "Itinerario", vehiculo: "pie", paradas: [] };
    plan.marcas.forEach(dibujarMarca);
    borrarResultado();
    dibujarResumen();
    dibujarItinerario();
  }

  // ---------- Ciclo de vida ----------
  async function abrirZona(id) {
    if (!cfgExp) await cargarConfig();
    zonaId = id;
    const guardado = leerLocal();
    reemplazar(guardado?.plan || crearPlan(), guardado?.borrador || null);
    borrarExpedicion();
    const ej = $("#plan-ejemplo");
    if (ej) ej.hidden = id !== "gale_boxwork";
  }

  // Misión de ejemplo de la consigna: hábitat en la última parada de Curiosity y parada científica en el boxwork
  // (otra parada real del rover), con su objetivo. Se arma con pipeline/armar_mision_ejemplo.mjs.
  async function cargarEjemplo() {
    const idioma = locale().startsWith("en") ? "en" : "es";
    try {
      const r = await fetch(new URL(`../ejemplos/mision_boxwork.${idioma}.geojson`, import.meta.url));
      if (!r.ok) throw new Error(String(r.status));
      const texto = await r.text();
      await importar({ text: async () => texto });
      ctx.mostrarItinerario();
      const ciencia = plan.marcas.find((m) => m.tipo === "ciencia");
      const calcular = $("#itinerario-calcular");
      if (calcular && !calcular.disabled) calcular.click();
      if (ciencia) {
        const mk = marcadores.get(ciencia.id);
        if (mk) mk.openPopup();
        avisar(`Misión de ejemplo: ${ciencia.datos.objetivo}`);
      }
    } catch (err) {
      avisar(`No se pudo cargar la misión de ejemplo: ${err.message}`);
    }
  }

  function limpiar() {
    for (const mk of marcadores.values()) mk.remove();
    for (const c of circulos.values()) c.remove();
    marcadores.clear(); circulos.clear();
    lineaItinerario?.remove(); lineaItinerario = null;
    capaExpedicion?.remove(); capaExpedicion = null;
  }

  function vaciarItinerario() {
    borrador.paradas = [];
    guardarLocal();
    borrarResultado();
    dibujarItinerario();
  }

  $("#itinerario-calcular").addEventListener("click", calcularItinerario);
  $("#itinerario-vaciar").addEventListener("click", vaciarItinerario);
  $("#exp-calcular").addEventListener("click", calcularExpedicion);
  $("#plan-ejemplo")?.addEventListener("click", cargarEjemplo);
  $("#plan-guardar").addEventListener("click", exportar);
  $("#plan-cargar").addEventListener("click", () => $("#plan-archivo").click());
  $("#plan-archivo").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) importar(f); e.target.value = ""; });

  return {
    cargarConfig, abrirZona, limpiar, agregar, alClicMapa, refugios, exclusiones, balizas, dibujarItinerario, dibujarResumen,
    bases, nodosRuta, configConsumibles: () => cfgCons, configRutas: () => cfgRutas, baseCerca, cambiarSalida, hayItinerario: () => borrador.paradas.length >= 2, sinStock,
    redibujarMarcas: () => plan.marcas.forEach(dibujarMarca),
    alResponderItinerario, alResponderExpedicion, borrarExpedicion, borrarResultado,
    tipos: () => tipos, ultimoItinerario: () => ultimoItinerario,
  };
}
