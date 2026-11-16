// Interfaz del mapa de salida: zonas, capas, marcas de base y destino, y rutas a pie.
import { cargarZona, leerHttp, valoresCelda, celdaALonLat, lonLatACelda } from "./zona.js";
import { celdaMasCercana } from "./ruteo.js";
import { cargarMarte, capasMarte, metrosPorGrado } from "./marte.js";
import { limitePendientePie } from "./riesgo.js";
import { crearManual } from "./manual.js";
import { crearUbicacion } from "./ubicacion.js";
import { crearVentana, conClima } from "./ventana.js";
import { crearMenuMapa } from "./menu-mapa.js";
import { crearPlanZona } from "./plan.js";
import { crearHerramientasMapa } from "./herramientas-mapa.js";
import { crearSimulacion } from "./simulacion.js";
import { crearBarometro } from "./barometro-ui.js";
import { formatoCoordenadas } from "./herramientas.js";
import { elegirIdioma, crearTraductor, usarTraductor, traducirNodo, observarTraduccion, t, locale } from "./idioma.js";
import { crearFormatos, OPCIONES, unidades, fijarUnidades } from "./unidades.js";
import { capaLienzo, lienzoDesdeLut } from "./lienzo.js";
import { guardar, borrar } from "./guardado.js";
import { amanecerAtardecer } from "./luz.js";
import { evaluarConfiabilidad } from "./confiabilidad.js";
import { crearGuia } from "./guia.js";
import { conectarBotonNavegacion } from "./navegacion-ui.js";
import { instanteSalidaNavegacion } from "./navegacion.js";
// Carpeta de datos relativa a la app: sirve en localhost y en un subdirectorio (GitHub Pages).
const RAIZ_DATOS = new URL("../../datos", import.meta.url).href;

// Idioma: ?lang=en|es, lo elegido antes o el del navegador. Los números siguen el formato del idioma.
const IDIOMA = elegirIdioma({ url: location.href, guardado: (() => { try { return localStorage.getItem("rf-idioma"); } catch { return null; } })(), navegador: navigator.language });
const LOCALE = IDIOMA === "en" ? "en-US" : "es-UY";

// Quién recorre la zona: en las regiones (200 m) es el rover; en los mapas de caminata, el traje.
const quien = () => (estado.zona?.meta.vehiculo === "rover" ? "el rover" : "el traje");

const RAIZ = "..";
const num = (v, dec = 0) => new Intl.NumberFormat(LOCALE, { maximumFractionDigits: dec, minimumFractionDigits: dec }).format(v);
const fmt = crearFormatos(num); // distancia, altura, pendiente, temperatura y presión en las unidades elegidas
const $ = (s) => document.querySelector(s);

const estado = window.__rf = {
  vista: null, indice: null, marte: null, plan: "auto", vehiculos: {}, riesgo: null, limitePendiente: null, pieEfectivo: null,
  zona: null, traje: null, perfiles: [], worker: null, prohibido: null, region: null, defs: [],
  capas: {}, marcas: { base: null, destino: null }, marcando: "base",
  rutas: {}, lineas: {}, elegida: null,
};

const mapa = L.map("mapa", { crs: L.CRS.Simple, minZoom: -5, maxZoom: 4, zoomSnap: 0.25, attributionControl: false });

function avisar(texto) {
  const el = $("#estado");
  if (el.textContent === texto) return;
  el.textContent = texto;
  el.classList.remove("cambio");
  void el.offsetWidth; // reinicia la animación de resaltado
  el.classList.add("cambio");
}

// Lámpara y barra de progreso de la barra de estado mientras el motor calcula.
function ocupado(si) { document.body.classList.toggle("ocupado", si); }
const TERMINALES = new Set(["listo", "region", "config", "rutas_fin", "manual", "tramo", "error", "ubicacion", "itinerario", "expedicion",
  "exclusiones", "camino_regreso", "radio", "sombras", "perfil", "barometro"]);

// La ruta "se dibuja" de punta a punta. Barato: solo anima el trazo SVG que ya existe.
function animarTrazo(linea) {
  const p = linea.getElement?.();
  if (!p || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const largo = p.getTotalLength();
  p.style.strokeDasharray = `${largo}`;
  p.style.strokeDashoffset = `${largo}`;
  p.classList.add("ruta-anim");
  p.addEventListener("animationend", () => {
    p.classList.remove("ruta-anim");
    p.style.strokeDasharray = "";
    p.style.strokeDashoffset = "";
  }, { once: true });
}

// Hora de Marte: Mars Sol Date y hora coordinada de Marte (Allison y McEwen 2000; TT − UTC = 69,184 s).
function relojMarte() {
  const jdTT = Date.now() / 86400000 + 2440587.5 + 69.184 / 86400;
  const msd = (jdTT - 2405522.0028779) / 1.0274912517;
  const h = ((msd % 1) + 1) % 1 * 24;
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = Math.floor(((h - hh) * 60 - mm) * 60);
  $("#msd").textContent = num(Math.floor(msd));
  $("#mtc").textContent = [hh, mm, ss].map((v) => String(v).padStart(2, "0")).join(":");
}
relojMarte();
setInterval(relojMarte, 1000);

// ---------- Opciones: la salida (oxígeno, tripulación, ritmo) ----------
// Lo que la tripulación carga y cómo va a trabajar cambia los límites de todo el motor: zona segura, rutas,
// decisión y visor. Se guarda en este navegador. Base del cálculo: config/riesgo.json.
const RITMOS = { liviano: 0.8, moderado: 1, intenso: 1.3 };
function leerSalida() {
  try { return JSON.parse(localStorage.getItem("rf-salida") || "null"); } catch { return null; }
}
function salidaPorDefecto(r) {
  return { personas: 2, o2_h: r.pie.consumibles_primarios_h.valor, carga_pct: 100, secundario_min: r.pie.regreso_emergencia_max_min.valor, ritmo: "moderado", hora_salida: "09:00" };
}
// Copia de las reglas con los consumibles de esta salida aplicados (marcados como «configurado»).
function aplicarSalida(base, sal) {
  const r = structuredClone(base);
  const f = RITMOS[sal.ritmo] || 1;
  const horas = (sal.o2_h * sal.carga_pct) / 100 / f;
  const fuente = `Configurado en Opciones: ${num(sal.o2_h, 1)} h de primario al ${num(sal.carga_pct)} %, ritmo ${sal.ritmo} (×${num(f, 1)}). Referencia: ${base.pie.consumibles_primarios_h.fuente}`;
  for (const v of ["pie", "rover"]) r[v].consumibles_primarios_h = { valor: Math.round(horas * 100) / 100, base: "configurado", fuente };
  r.pie.regreso_emergencia_max_min = { valor: Math.round(sal.secundario_min / Math.max(1, f)), base: "configurado",
    fuente: `Configurado en Opciones: ${num(sal.secundario_min)} min de oxígeno secundario${f > 1 ? ` a ritmo ${sal.ritmo}` : ""}. Referencia: ${base.pie.regreso_emergencia_max_min.fuente}` };
  r.pie.tripulacion = { valor: sal.personas, base: "configurado", fuente: "Configurado en Opciones. NASA: nunca un astronauta solo (mínimo 2)." };
  return r;
}
function alCambiarSalida() {
  guardar("rf-salida", JSON.stringify(estado.salida));
  estado.riesgo = aplicarSalida(estado.riesgoBase, estado.salida);
  if (estado.zona) { planZona.redibujarMarcas(); planZona.dibujarResumen(); alCambiarPlan(); } // el stock necesario depende de la tripulación
  if (estado.worker && estado.zona) {
    borrarRutas();
    estado.worker.postMessage({ tipo: "config", riesgo: estado.riesgo });
  }
  avisar(`Salida: ${num(estado.riesgo.pie.consumibles_primarios_h.valor, 1)} h de oxígeno primario útiles, ${num(estado.riesgo.pie.regreso_emergencia_max_min.valor)} min de secundario, ${estado.salida.personas} tripulantes.`);
}
function dibujarSalida() {
  const caja = $("#opciones-salida"), sal = estado.salida;
  caja.innerHTML = `<h3>Salida y consumibles</h3>
    <label>Tripulación en la salida<input type="number" min="1" max="6" step="1" data-salida="personas" value="${sal.personas}"></label>
    <label>Oxígeno primario del traje (h a ritmo moderado)<input type="number" min="0.5" max="12" step="0.5" data-salida="o2_h" value="${sal.o2_h}"></label>
    <label>Carga actual del primario (%)<input type="number" min="5" max="100" step="5" data-salida="carga_pct" value="${sal.carga_pct}"></label>
    <label>Oxígeno secundario (min)<input type="number" min="10" max="120" step="5" data-salida="secundario_min" value="${sal.secundario_min}"></label>
    <label>Hora de salida (hora solar local)<input type="time" data-salida="hora_salida" value="${sal.hora_salida || "09:00"}"></label>
    <label>Ritmo de trabajo<select data-salida="ritmo">${Object.entries(RITMOS).map(([k, f]) => `<option value="${k}" ${k === sal.ritmo ? "selected" : ""}>${k} (×${num(f, 1)} de consumo)</option>`).join("")}</select></label>
    <p class="ayuda">Horas útiles de primario: <b>${num(estado.riesgo.pie.consumibles_primarios_h.valor, 1)} h</b>. El ritmo es una propuesta a calibrar. Con menos de 2 tripulantes ninguna salida se aprueba.</p>
    <button type="button" class="chico" data-salida-reset>Volver a los valores de NASA</button>`;
  caja.querySelectorAll("[data-salida]").forEach((el) => el.addEventListener("change", () => {
    const k = el.dataset.salida;
    estado.salida[k] = k === "ritmo" || k === "hora_salida" ? el.value : Math.max(Number(el.min) || 0, Math.min(Number(el.max) || Infinity, Number(el.value) || 0));
    alCambiarSalida();
    dibujarSalida();
  }));
  caja.querySelector("[data-salida-reset]").addEventListener("click", () => {
    estado.salida = salidaPorDefecto(estado.riesgoBase);
    alCambiarSalida();
    dibujarSalida();
  });
}

// ---------- Opciones: unidades ----------
{
  const boton = $("#opciones"), panel = $("#panel-opciones");
  const NOMBRES = { distancia: "Distancia y altura", pendiente: "Pendiente", temperatura: "Temperatura", presion: "Presión" };
  panel.innerHTML = `<div id="opciones-salida"></div><h3>Unidades</h3>${Object.entries(OPCIONES).map(([k, ops]) => `<label>${NOMBRES[k]}
      <select data-unidad="${k}">${ops.map(([v, txt]) => `<option value="${v}">${txt}</option>`).join("")}</select></label>`).join("")}
    <p class="ayuda">El cálculo es siempre en el sistema internacional; esto cambia solo cómo se muestra.</p>`;
  panel.querySelectorAll("[data-unidad]").forEach((sel) => {
    sel.value = unidades()[sel.dataset.unidad];
    sel.addEventListener("change", () => { fijarUnidades({ [sel.dataset.unidad]: sel.value }); alCambiarUnidades(); });
  });
  boton.addEventListener("click", () => { panel.hidden = !panel.hidden; boton.setAttribute("aria-expanded", String(!panel.hidden)); });
  document.addEventListener("pointerdown", (e) => { if (!panel.hidden && !panel.contains(e.target) && e.target !== boton) { panel.hidden = true; boton.setAttribute("aria-expanded", "false"); } });
}

// Con unidades nuevas se redibuja lo que está a la vista (y se rehacen los cálculos que ya se mostraron).
function alCambiarUnidades() {
  escala.actualizar();
  ventana.dibujar();
  if (Object.keys(estado.rutas).length && estado.marcas.base && estado.marcas.destino) $("#calcular").click();
  if (planZona.ultimoItinerario()) $("#itinerario-calcular").click();
  avisar("Unidades actualizadas.");
}

// Rótulo de cada tramo en el mapa (largo y tiempo), al costado de la línea para no taparla.
function rotularTramos(capa, tramos) {
  const z = estado.zona;
  for (const tr of tramos) {
    if (!tr.celdas?.length) continue;
    const k = Math.floor(tr.celdas.length / 2);
    const a = tr.celdas[Math.max(0, k - 8)], b = tr.celdas[Math.min(tr.celdas.length - 1, k + 8)], i = tr.celdas[k];
    const dx = (b % z.ancho) - (a % z.ancho), dy = Math.floor(b / z.ancho) - Math.floor(a / z.ancho);
    // Línea más bien horizontal: rótulo arriba; más bien vertical: a la derecha.
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    L.tooltip({ permanent: true, direction: horizontal ? "top" : "right", offset: horizontal ? [0, -10] : [12, 0],
      className: "rotulo-tramo", interactive: false, opacity: 0.92 })
      .setLatLng(aMapa(Math.floor(i / z.ancho), i % z.ancho)).setContent(tr.texto).addTo(capa);
  }
}

// ---------- Sesión: al recargar vuelve todo como estaba (zona, pestaña, base, destino, capas, vista y rutas) ----------
const claveSesion = () => `rf-sesion-${estado.zona?.meta.id}`;
let restaurando = false;
function guardarSesion() {
  if (!estado.zona || restaurando || !estado.sesionLista) return; // no pisar la sesión guardada antes de reponerla
  const casillas = Object.fromEntries([...document.querySelectorAll("[data-capa]")].map((c) => [c.dataset.capa, c.checked]));
  const c = mapa.getCenter();
  const sesion = {
    plan: estado.plan, baseId: estado.baseId, destinoId: estado.destinoId, destino: estado.marcas.destino?.celda || null,
    capas: casillas, vista: { lat: c.lat, lng: c.lng, zoom: mapa.getZoom() },
    rutas: Object.keys(estado.rutas).length > 0, itinerario: !!planZona.ultimoItinerario(),
  };
  guardar(claveSesion(), JSON.stringify(sesion));
  guardar("rf-zona", estado.zona.meta.id);
}
function leerSesion() {
  try { return JSON.parse(localStorage.getItem(claveSesion()) || "null"); } catch { return null; }
}
let esperaSesion = null;
const guardarSesionLuego = () => { clearTimeout(esperaSesion); esperaSesion = setTimeout(guardarSesion, 400); };

// Se llama cuando el motor ya tiene la zona: repone base, destino, pestaña y capas, y rehace los cálculos.
async function restaurarSesion() {
  const ses = leerSesion();
  if (!ses) return false;
  restaurando = true;
  try {
    if (ses.plan && ses.plan !== estado.plan && document.querySelector(`[data-plan="${ses.plan}"]:not([hidden])`)) elegirPlan(ses.plan);
    for (const [id, encendida] of Object.entries(ses.capas || {})) {
      const casilla = document.querySelector(`[data-capa="${id}"]`), def = estado.defs.find((d) => d.id === id);
      if (!casilla || !def || casilla.checked === encendida) continue;
      casilla.checked = encendida;
      casilla.dispatchEvent(new Event("change"));
    }
    if (ses.vista) mapa.setView([ses.vista.lat, ses.vista.lng], ses.vista.zoom, { animate: false });
    const base = planZona.bases().find((b) => b.id === ses.baseId);
    if (base) ponerMarca("base", base.celda, base.id);
    const destinoBase = planZona.bases().find((b) => b.id === ses.destinoId);
    if (destinoBase) ponerMarca("destino", destinoBase.celda, destinoBase.id);
    else if (ses.destino) ponerMarca("destino", ses.destino);
    // Las rutas se recalculan cuando esté la zona segura (mensaje «region»).
    estado.recalcular = { rutas: ses.rutas && ses.plan !== "itinerario", itinerario: ses.itinerario && ses.plan === "itinerario" };
    return !!base;
  } finally {
    restaurando = false;
  }
}

// ---------- Escala en metros (CRS.Simple: 1 unidad = 1 celda) ----------
const Escala = L.Control.extend({
  options: { position: "bottomleft" },
  onAdd() { this._el = L.DomUtil.create("div", "leaflet-control-scale-line"); mapa.on("zoomend", () => this.actualizar()); return this._el; },
  actualizar() {
    if (!estado.vista) return;
    // En la vista de Marte 1 unidad = 1 grado (medido en el ecuador); en una zona, 1 unidad = 1 celda.
    const unidad = estado.vista === "marte" ? metrosPorGrado() : estado.zona.paso;
    const mPorPx = unidad / Math.pow(2, mapa.getZoom());
    const objetivo = mPorPx * 100;
    const base = Math.pow(10, Math.floor(Math.log10(objetivo)));
    const lindo = [1, 2, 5, 10].map((k) => k * base).filter((v) => v <= objetivo).pop();
    this._el.style.width = `${lindo / mPorPx}px`;
    this._el.textContent = unidades().distancia === "imperial" ? fmt.dist(lindo) : lindo >= 1000 ? `${num(lindo / 1000, lindo % 1000 ? 1 : 0)} km` : `${num(lindo)} m`;
  },
});
const escala = new Escala().addTo(mapa);
mapa.on("moveend", () => { if (estado.vista === "zona") guardarSesionLuego(); });

// ---------- Conversión celda ↔ punto del mapa ----------
const aMapa = (f, c) => L.latLng(-(f + 0.5), c + 0.5);
function deMapa(latlng) {
  const f = Math.floor(-latlng.lat), c = Math.floor(latlng.lng);
  const z = estado.zona;
  return f >= 0 && c >= 0 && f < z.alto && c < z.ancho ? { f, c } : null;
}

// ---------- Capas ----------
function rampa(paradas) {
  // paradas: [[valor0a1, [r,g,b,a]], ...] ordenadas
  return (t) => {
    for (let k = 1; k < paradas.length; k++) {
      if (t <= paradas[k][0]) {
        const [t0, c0] = paradas[k - 1], [t1, c1] = paradas[k];
        const u = (t - t0) / Math.max(t1 - t0, 1e-9);
        return c0.map((v, i) => v + (c1[i] - v) * u);
      }
    }
    return paradas[paradas.length - 1][1];
  };
}

function imagenDesdeLut(valores, valido, lut, k) {
  const z = estado.zona;
  k ??= z.ancho * z.alto > 4e6 ? 2 : 1; // en las zonas de 2 m se dibuja a 4 m (más que suficiente a la vista)
  return lienzoDesdeLut(valores, valido, lut, z.ancho, z.alto, k);
}

// Colorea una imagen en gris (0 = sin dato) estirando entre los percentiles 2 y 98.
async function imagenColoreada(url, color) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const lienzo = document.createElement("canvas");
  lienzo.width = img.naturalWidth; lienzo.height = img.naturalHeight;
  const ctx = lienzo.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const datos = ctx.getImageData(0, 0, lienzo.width, lienzo.height);
  const px = datos.data;
  const hist = new Uint32Array(256);
  let total = 0;
  for (let j = 0; j < px.length; j += 4) if (px[j]) { hist[px[j]]++; total++; }
  const corte = (q) => { let a = 0; for (let k = 1; k < 256; k++) { a += hist[k]; if (a >= q * total) return k; } return 255; };
  const lo = corte(0.02), hi = Math.max(corte(0.98), lo + 1);
  const lut = Array.from({ length: 256 }, (_, k) => color(Math.min(Math.max((k - lo) / (hi - lo), 0), 1)));
  for (let j = 0; j < px.length; j += 4) {
    const o = px[j] ? lut[px[j]] : [0, 0, 0, 0];
    px[j] = o[0]; px[j + 1] = o[1]; px[j + 2] = o[2]; px[j + 3] = o[3];
  }
  ctx.putImageData(datos, 0, 0);
  return lienzo;
}

function definirCapas() {
  const z = estado.zona, meta = z.meta, lim = estado.traje.pendiente_max_grados.valor;
  const limR = estado.traje.rugosidad_max_cm.valor;
  const bordes = [[-z.alto, 0], [0, z.ancho]];
  const escP = meta.capas.pendiente.escala, escR = meta.capas.rugosidad.escala * 100;

  const colorP = rampa([[0, [40, 160, 90, 150]], [0.5, [235, 210, 60, 170]], [1, [220, 60, 40, 200]], [1.0001, [90, 20, 90, 220]], [10, [90, 20, 90, 220]]]);
  const lutP = Array.from({ length: 256 }, (_, q) => colorP((q * escP) / lim));
  const colorR = rampa([[0, [255, 255, 255, 0]], [0.2, [250, 220, 120, 110]], [1, [170, 70, 20, 210]], [10, [110, 30, 10, 230]]]);
  const lutR = Array.from({ length: 256 }, (_, q) => colorR((q * escR) / limR));
  const colorT = rampa([[0, [30, 20, 90, 210]], [0.5, [160, 50, 130, 200]], [1, [255, 205, 70, 210]]]);

  return [
    { id: "orto", nombre: meta.capas.orto.nombre || "Imagen HiRISE", activa: true,
      crear: async () => L.imageOverlay(`${RAIZ}/datos/${meta.id}/${meta.capas.orto.archivo}`, bordes) },
    { id: "pendiente", nombre: "Pendiente", leyenda: [colorP, `0°`, `${lim}° (límite)`],
      crear: async () => capaLienzo(imagenDesdeLut(z.crudo.pendQ, z.valido, lutP), bordes) },
    { id: "rugosidad", nombre: "Rugosidad del suelo", leyenda: [colorR, "0 cm", `${limR} cm (límite)`],
      crear: async () => capaLienzo(imagenDesdeLut(z.crudo.rugQ, z.valido, lutR), bordes) },
    { id: "prohibido", nombre: `Zonas prohibidas para ${quien()}`, activa: true, requiere: () => estado.prohibido,
      crear: async () => capaLienzo(imagenDesdeLut(estado.prohibido, null, [[0, 0, 0, 0], [200, 30, 40, 120]]), bordes) },
    { id: "alcanzable", nombre: "Sombrear lo que queda fuera de la zona segura", activa: true, requiere: () => estado.region,
      crear: async () => capaLienzo(imagenDesdeLut(mascaraNoAlcanzable(), null, [[0, 0, 0, 0], [15, 15, 25, 150]]), bordes) },
    z.blando && { id: "blando", nombre: "Suelo blando probable (modelado)", nota: meta.capas.blando.aviso,
      lista: [["rgba(235,170,40,.75)", `oscuro de noche (≤ ${num(meta.capas.blando.umbral_termico)}) y liso (≤ ${num(meta.capas.blando.rugosidad_max_m.valor * 100)} cm): ${num(meta.capas.blando.fraccion * 100, 1)} % de la zona`]],
      crear: async () => capaLienzo(imagenDesdeLut(z.blando, null, [[0, 0, 0, 0], [235, 170, 40, 150]]), bordes) },
    meta.capas.termico_noche && { id: "termico", nombre: meta.capas.termico_noche.nombre, nota: meta.capas.termico_noche.aviso,
      leyenda: [colorT, "frío: fino y suelto", "tibio: roca"],
      crear: async () => capaLienzo(await imagenColoreada(`${RAIZ}/datos/${meta.id}/${meta.capas.termico_noche.archivo}`, colorT), bordes, { opacity: 0.8 }) },
    ...["crism_hyd", "crism_phy"].filter((k) => meta.capas[k]).map((k) => ({
      id: k, nombre: meta.capas[k].nombre, lista: meta.capas[k].leyenda,
      nota: `${meta.capas[k].observaciones.length} observaciones de CRISM (${meta.capas[k].observaciones.map((o) => o.id.toUpperCase()).join(", ")}). Cada franja tiene su propio estiramiento de color: compará dentro de una misma franja.`,
      crear: async () => L.imageOverlay(`${RAIZ}/datos/${meta.id}/${meta.capas[k].archivo}`, bordes, { opacity: 0.85 }),
    })),
    meta.capas.curiosity && { id: "curiosity", nombre: "Recorrido de Curiosity", activa: true, crear: crearCapaCuriosity },
    caminatasDentro().length > 0 && { id: "caminata", nombre: "Mapas de caminata (1 m) dentro de la región", activa: true, crear: crearCapaCaminatas },
  ].filter(Boolean);
}

// Zonas de caminata (detalle de 1 m) cuyo centro cae dentro de la región abierta.
function caminatasDentro() {
  const lim = estado.zona.meta.limites;
  return estado.indice.zonas.filter((z) => z.nivel === "salida" && z.id !== estado.zona.meta.id
    && z.centro.lat >= lim.lat_sur && z.centro.lat <= lim.lat_norte && z.centro.lon_este >= lim.lon_oeste && z.centro.lon_este <= lim.lon_este);
}

async function crearCapaCaminatas() {
  const meta = estado.zona.meta;
  const grupo = L.layerGroup();
  for (const z of caminatasDentro()) {
    const a = lonLatACelda(meta, z.limites.lon_oeste, z.limites.lat_norte);
    const b = lonLatACelda(meta, z.limites.lon_este, z.limites.lat_sur);
    L.rectangle([aMapa(a.f, a.c), aMapa(b.f, b.c)], { color: "#4cc488", weight: 2, fillOpacity: 0.1 })
      .bindTooltip(`${z.nombre} · tocá para abrir el mapa de caminata`)
      .on("click", (e) => { L.DomEvent.stop(e); abrirZona(z.id); })
      .addTo(grupo);
  }
  return grupo;
}

// 1 = terreno caminable que no se puede alcanzar desde la base (lo prohibido ya tiene su capa).
function mascaraNoAlcanzable() {
  const { region, prohibido } = estado;
  const m = new Uint8Array(region.length);
  for (let i = 0; i < m.length; i++) m[i] = !region[i] && !prohibido[i] && estado.zona.valido[i] ? 1 : 0;
  return m;
}

// Vuelve a dibujar una capa que depende de datos nuevos, si está encendida.
async function rehacerCapa(id) {
  if (estado.capas[id]) { mapa.removeLayer(estado.capas[id]); delete estado.capas[id]; }
  const casilla = document.querySelector(`[data-capa="${id}"]`);
  if (casilla?.checked) await alternarCapa(estado.defs.find((d) => d.id === id), true);
}

async function crearCapaCuriosity() {
  const meta = estado.zona.meta;
  const geo = await leerHttp(`${RAIZ}/datos/${meta.id}/${meta.capas.curiosity.archivo}`, "json");
  const grupo = L.layerGroup();
  // Corrimiento medido entre el marco de Curiosity y el modelo de terreno (validar_curiosity.py).
  const mov = meta.capas.curiosity.corrimiento_m || { este: 0, norte: 0 };
  const [a, , , , e] = meta.grilla.transform;
  const aLatLng = ([lon, lat]) => {
    const { f, c } = lonLatACelda(meta, lon, lat);
    return aMapa(f + mov.norte / e, c + mov.este / a);
  };
  for (const ft of geo.features) {
    if (ft.properties.tipo === "recorrido") {
      for (const tramo of ft.geometry.coordinates) L.polyline(tramo.map(aLatLng), { color: "#f5f5f5", weight: 2, opacity: 0.9, dashArray: "4 4" }).addTo(grupo);
    } else {
      L.circleMarker(aLatLng(ft.geometry.coordinates), { radius: 3, color: "#f5f5f5", weight: 1, fillOpacity: 0.8 })
        .bindTooltip(`Curiosity · sol ${ft.properties.sol}`).addTo(grupo);
    }
  }
  return grupo;
}

async function alternarCapa(def, encender) {
  if (encender) {
    if (def.requiere && !def.requiere()) return;
    if (!estado.capas[def.id]) {
      const previo = $("#estado").textContent;
      avisar(`Preparando la capa «${def.nombre}»…`);
      estado.capas[def.id] = await def.crear();
      if ($("#estado").textContent.startsWith(t("Preparando la capa").split("«")[0].trim())) avisar(previo);
    }
    estado.capas[def.id].addTo(mapa);
    if (estado.capas.curiosity && mapa.hasLayer(estado.capas.curiosity)) estado.capas.curiosity.bringToFront?.();
  } else if (estado.capas[def.id]) {
    mapa.removeLayer(estado.capas[def.id]);
  }
}

function dibujarControlesCapas(defs) {
  const caja = $("#capas");
  caja.innerHTML = "";
  for (const def of defs) {
    const fila = document.createElement("label");
    const casilla = document.createElement("input");
    casilla.type = "checkbox";
    casilla.checked = !!def.activa;
    casilla.dataset.capa = def.id;
    const extra = document.createElement("div");
    extra.className = "capa-extra";
    extra.hidden = !def.activa;
    casilla.addEventListener("change", () => { extra.hidden = !casilla.checked; alternarCapa(def, casilla.checked); guardarSesionLuego(); });
    fila.append(casilla, def.nombre);
    if (def.nota) fila.title = def.nota;
    caja.append(fila, extra);
    if (def.lista) {
      const lista = document.createElement("ul");
      lista.className = "leyenda-lista";
      lista.innerHTML = def.lista.map(([c, t]) => `<li><i style="background:${c}"></i>${t}</li>`).join("");
      extra.append(lista);
    }
    if (def.leyenda) {
      const [color, ini, fin] = def.leyenda;
      const barra = document.createElement("div");
      barra.className = "leyenda";
      const pasos = Array.from({ length: 11 }, (_, k) => { const c = color(k / 10); return `rgba(${c[0]},${c[1]},${c[2]},${Math.max(c[3], 80) / 255})`; });
      barra.style.background = `linear-gradient(90deg, ${pasos.join(",")})`;
      const texto = document.createElement("div");
      texto.className = "leyenda-texto";
      texto.innerHTML = `<span>${ini}</span><span>${fin}</span>`;
      extra.append(barra, texto);
    }
  }
}

// ---------- Lectura bajo el cursor ----------
mapa.on("mousemove", (e) => {
  if (estado.vista === "marte") {
    const { lat, lng } = e.latlng;
    $("#lectura").textContent = Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      ? `${num(Math.abs(lat), 2)}° ${lat < 0 ? "S" : "N"}, ${num(((lng % 360) + 360) % 360, 2)}° E` : "Fuera del mapa";
    return;
  }
  if (!estado.zona) return;
  const celda = deMapa(e.latlng);
  if (!celda) { $("#lectura").textContent = "Fuera de la zona"; return; }
  const z = estado.zona, i = celda.f * z.ancho + celda.c;
  const v = valoresCelda(z, i);
  const { lon, lat } = celdaALonLat(z.meta, celda.f, celda.c);
  const pos = `${num(Math.abs(lat), 5)}° ${lat < 0 ? "S" : "N"}, ${num(lon, 5)}° E`;
  $("#lectura").textContent = v.valido
    ? `${pos} · altura ${fmt.alt(v.altura, 1)} · pendiente ${fmt.pend(v.pendiente)} · rugosidad ${num(v.rugosidad * 100)} cm${z.blando?.[i] ? " · suelo blando probable" : ""}`
    : `${pos} · sin datos del modelo de terreno`;
});

// ---------- Marcas y rutas ----------
const iconos = {
  base: L.divIcon({ className: "", html: '<div class="marca base">B</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
  destino: L.divIcon({ className: "", html: '<div class="marca destino">D</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
};

function elegirModo(modo) {
  estado.marcando = modo;
  document.querySelectorAll(".modos button").forEach((b) => b.classList.toggle("activo", b.dataset.marca === modo));
  actualizarAyuda();
}
document.querySelectorAll(".modos button").forEach((b) => b.addEventListener("click", () => elegirModo(b.dataset.marca)));

function actualizarAyuda() {
  const { base, destino } = estado.marcas;
  if (estado.plan === "manual") {
    $("#ayuda-ruta").textContent = !base ? "Clic derecho en el mapa → «Base de la ruta aquí»."
      : "Tocá el mapa para agregar puntos en orden. Cada tramo se verifica solo; los rojos se pueden ajustar. "
        + "Arrastrá un punto para moverlo y hacé clic derecho para quitarlo.";
    return;
  }
  $("#ayuda-ruta").textContent = !base ? "Clic derecho en el mapa → «Base de la ruta aquí»."
    : !destino ? "Ahora clic derecho en el mapa → «Destino aquí»."
    : "Tocá «Calcular rutas». Podés mover la base o el destino arrastrándolos.";
  $("#calcular").disabled = !(base && destino && estado.prohibido && estado.region);
}

// Si el destino no se alcanza a pie desde la base, lo corre al punto alcanzable más cercano.
function ajustarDestino(celda) {
  const z = estado.zona;
  const i = celda.f * z.ancho + celda.c;
  if (!estado.region) {
    // Sin base todavía: solo se descarta lo prohibido. Al marcar la base se vuelve a ajustar.
    return estado.prohibido?.[i] ? { celda: null, aviso: `Ese punto está en una zona prohibida para ${quien()}: elegí otro destino.` } : { celda, aviso: null };
  }
  if (estado.region[i]) return { celda, aviso: null };
  const radio = Math.ceil(Math.max(2000, 100 * z.paso) / z.paso); // 2 km a pie, 20 km en rover
  const cerca = celdaMasCercana(estado.region, z.ancho, z.alto, celda.f, celda.c, radio);
  if (!cerca) return { celda: null, aviso: `Desde esa base no se llega a nada en ${num((radio * z.paso) / 1000)} km a la redonda de ese destino.` };
  return { celda: { f: cerca.f, c: cerca.c }, aviso: `Ese destino queda fuera de la zona segura desde la base: lo corrí ${num(cerca.d * z.paso)} m al punto alcanzable más cercano.` };
}

function ponerMarca(tipo, celda, idBase = null) {
  const z = estado.zona;
  const i = celda.f * z.ancho + celda.c;
  if (estado.prohibido && estado.prohibido[i] && tipo === "base") {
    avisar(`Ese punto está en una zona prohibida para ${quien()}: elegí otro para la base.`);
    return false;
  }
  let aviso = null;
  if (tipo === "destino" && estado.plan === "expedicion") {
    if (estado.prohibido?.[i]) { avisar(`Ese punto está en una zona prohibida para ${quien()}: elegí otro destino.`); return false; }
  } else if (tipo === "destino" && !idBase) { // una base del plan como destino no se corre: es un refugio
    ({ celda, aviso } = ajustarDestino(celda));
    if (!celda) { avisar(aviso); return false; }
  }
  avisar(aviso || listoTexto());
  estado.marcas[tipo]?.remove();
  const m = L.marker(aMapa(celda.f, celda.c), { icon: iconos[tipo], draggable: true, keyboard: true, title: tipo === "base" ? "Base" : "Destino" }).addTo(mapa);
  m.celda = celda;
  m.on("dragend", () => {
    const nueva = deMapa(m.getLatLng());
    if (!nueva || !ponerMarca(tipo, nueva)) m.setLatLng(aMapa(m.celda.f, m.celda.c));
  });
  estado.marcas[tipo] = m;
  if (tipo === "base") estado.baseId = idBase; else estado.destinoId = idBase;
  if (idBase) { m.dragging?.disable(); m.options.title = "Se mueve arrastrando la base del plan"; }
  borrarRutas();
  if (tipo === "base") pedirRegion(celda);
  actualizarAyuda();
  sincronizarBases();
  guardarSesionLuego();
  return true;
}

// Selectores «Salir desde» y «Llegar a»: las bases del plan (hábitats y refugios).
const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function sincronizarBases() {
  if (!estado.zona) return;
  const bases = planZona.bases();
  const opcion = (b) => `<option value="${b.id}">${escHtml(b.nombre)}</option>`;
  // La base vinculada se movió o se borró: la marca B la sigue.
  const b = bases.find((x) => x.id === estado.baseId);
  if (estado.baseId && !b) { estado.baseId = null; }
  else if (b && estado.marcas.base && (b.celda.f !== estado.marcas.base.celda.f || b.celda.c !== estado.marcas.base.celda.c)) { ponerMarca("base", b.celda, b.id); return; }
  const d = bases.find((x) => x.id === estado.destinoId);
  if (estado.destinoId && !d) estado.destinoId = null;
  else if (d && estado.marcas.destino && (d.celda.f !== estado.marcas.destino.celda.f || d.celda.c !== estado.marcas.destino.celda.c)) { ponerMarca("destino", d.celda, d.id); return; }
  const desde = $("#salir-desde"), hasta = $("#llegar-a");
  desde.innerHTML = bases.map(opcion).join("") + `<option value="">${bases.length ? "— otra: clic derecho en el mapa —" : "— clic derecho en el mapa para crear la base —"}</option>`;
  desde.value = estado.baseId || "";
  hasta.innerHTML = '<option value="">— un punto del mapa —</option>' + bases.filter((x) => x.id !== estado.baseId).map(opcion).join("");
  hasta.value = estado.destinoId || "";
}
$("#salir-desde").addEventListener("change", (e) => {
  const b = planZona.bases().find((x) => x.id === e.target.value);
  if (!b) { elegirModo("base"); avisar("Hacé clic derecho donde está (o va a estar) la base → «Base de la ruta aquí»: se agrega al plan como hábitat."); return; }
  if (estado.plan === "itinerario") { planZona.cambiarSalida(b.id); ponerMarca("base", b.celda, b.id); return; }
  ponerMarca("base", b.celda, b.id);
  if (!estado.marcas.destino && estado.plan !== "manual") elegirModo("destino");
});
$("#llegar-a").addEventListener("change", (e) => {
  const b = planZona.bases().find((x) => x.id === e.target.value);
  if (!b) { elegirModo("destino"); return; }
  ponerMarca("destino", b.celda, b.id);
});

function pedirRegion(celda) {
  estado.region = null;
  rehacerCapa("alcanzable");
  const refugios = planZona.refugios();
  firmaPlan = JSON.stringify(refugios); // así el cambio de plan pendiente no la pide dos veces
  avisar(`Calculando hasta dónde puede llegar ${quien()} desde la base${refugios.length ? ` y ${refugios.length} refugios del plan` : ""}…`);
  estado.worker.postMessage({ tipo: "region", inicio: celda, refugios });
}

mapa.on("click", (e) => {
  if (!estado.zona) return;
  const celda = deMapa(e.latlng);
  if (!celda) return;
  // El clic izquierdo solo sirve a las herramientas activas y al trazado manual: base, destino y paradas van por
  // el menú del clic derecho, así un toque sin querer no cambia el plan.
  if (herramientas.ocupaClic()) { herramientas.alClic(celda); return; }
  if (estado.plan === "manual" && estado.marcas.base) { manual.agregar(celda); return; }
  avisar("Hacé clic derecho para elegir la base, el destino o agregar al plan.");
});

// La salida siempre es una base del plan: si se toca cerca de una (≤ 20 m), se usa esa; si no, se crea un hábitat.
function marcarBase(celda) {
  const z = estado.zona;
  if (estado.prohibido?.[celda.f * z.ancho + celda.c]) { avisar(`Ese punto está en una zona prohibida para ${quien()}: elegí otro para la base.`); return false; }
  const cerca = planZona.baseCerca(celda, Math.max(2, 20 / z.paso));
  if (cerca) return ponerMarca("base", cerca.celda, cerca.id);
  const m = planZona.agregar("habitat", celda);
  const b = planZona.bases().find((x) => x.id === m.id);
  return ponerMarca("base", b.celda, b.id);
}

function borrarRutas() {
  estado.rotulos?.clearLayers();
  estado.lineasBases?.forEach((l) => l.remove());
  estado.lineasBases = null;
  Object.values(estado.lineas).forEach((l) => l.remove());
  estado.lineas = {}; estado.rutas = {}; estado.elegida = null;
  $("#rutas").innerHTML = "";
  $("#perfil").hidden = true;
}

$("#borrar").addEventListener("click", () => {
  borrarRutas();
  manual.limpiar();
  estado.marcas.base?.remove(); estado.marcas.destino?.remove();
  estado.marcas = { base: null, destino: null };
  estado.baseId = null; estado.destinoId = null;
  estado.region = null;
  $("#info-zona").textContent = "";
  guardarSesionLuego();
  if (estado.capas.alcanzable) { mapa.removeLayer(estado.capas.alcanzable); delete estado.capas.alcanzable; }
  elegirModo("base");
});

$("#calcular").addEventListener("click", () => {
  borrarRutas();
  $("#calcular").disabled = true;
  avisar("Calculando rutas…");
  const nombre = (id) => planZona.bases().find((b) => b.id === id)?.nombre;
  const pie = estado.zona.meta.vehiculo !== "rover";
  const [hh, mm] = String(estado.salida?.hora_salida || "09:00").split(":").map(Number);
  estado.worker.postMessage({
    tipo: "rutas", perfiles: estado.perfiles, inicio: estado.marcas.base.celda, fin: estado.marcas.destino.celda,
    nodos: planZona.nodosRuta().filter((n) => pie || (n.recargaOk && n.id !== estado.baseId && n.id !== estado.destinoId)),
    ...(pie ? { baseId: estado.baseId, destinoId: estado.destinoId, refugios: planZona.refugios(),
      consumibles: planZona.configConsumibles(), planificacion: planZona.configRutas()?.planificacion,
      confiabilidad: estado.cfgConf, controlesDia: conClima({ controles: [], decision: "SI" }, estado.ventana).controles,
      instante: Date.now(), horaSalida: hh + mm / 60 } : {}),
    nombreInicio: nombre(estado.baseId) || "Base", nombreFin: nombre(estado.destinoId) || "Destino",
  });
});

// ---------- Trazado manual ----------
const manual = crearManual({ mapa, estado, $, num, aMapa, deMapa, avisar, decisionHtml, dibujarPerfil, duracion, animarTrazo });
$("#borrar-manual").addEventListener("click", () => $("#borrar").click());
const ventana = crearVentana({ $, num, fmt, leerHttp, RAIZ, estado });
const ubicacion = crearUbicacion({ mapa, estado, $, num, aMapa, lonLatACelda, avisar, leerHttp, RAIZ,
  referencias: () => [
    ...planZona.bases().map((b) => ({ ...b, id: `${b.id}@${b.celda.f},${b.celda.c}` })),
    ...planZona.balizas().map((celda, i) => ({ id: `${celda.f},${celda.c}`, nombre: `${t("Baliza")} ${i + 1}`, celda })),
  ] });
const simulacion = crearSimulacion({ mapa, estado, $, num, fmt, aMapa, avisar });

// La ruta que se ve ahora (automática, manual o itinerario), para radio, sombras y simulación.
function rutaActual() {
  if (estado.plan === "itinerario") return planZona.ultimoItinerario()?.ruta || null;
  if (estado.plan === "manual") return estado.ultimoManual || null;
  return estado.rutas[estado.elegida] || null;
}

const planZona = crearPlanZona({
  mapa, estado, $, num, fmt, rotularTramos, aMapa, avisar, decisionHtml, duracion, animarTrazo, celdaALonLat, lonLatACelda, leerHttp, RAIZ, dibujarPerfil,
  evaluacionCompleta: (ev) => evaluacionCompleta(ev),
  confiabilidadHtml: (ruta) => confiabilidadHtml(ruta),
  usarComoBase: (celda) => { if (estado.plan === "itinerario") elegirPlan("auto"); ponerMarca("base", celda); },
  mostrarItinerario: () => { if (estado.plan !== "itinerario") elegirPlan("itinerario"); },
  // El itinerario sale de un refugio: se marca como base para ver su zona segura sombreada.
  baseDelItinerario: (celda, id) => { const b = estado.marcas.base?.celda; if (!b || b.f !== celda.f || b.c !== celda.c) ponerMarca("base", celda, id); },
  alCambiarBases: () => sincronizarBases(),
  fueraDeZonaSegura: (celda) => !!estado.region && !estado.region[celda.f * estado.zona.ancho + celda.c],
  simular: (ruta, titulo) => simulacion.iniciar(ruta, titulo, (() => { const i = ruta.sim.celdas[0]; return { f: Math.floor(i / estado.zona.ancho), c: i % estado.zona.ancho }; })()),
  alCambiarPlan: () => alCambiarPlan(),
});

// «Iniciar navegación»: HUD de casco sobre la ruta aprobada que se ve (o sobre un tramo por bases).
function contextoNavegacion(ruta = rutaActual(), evaluacion = null) {
  const zona = estado.zona;
  const ev = evaluacion ?? ruta?.evaluacion ?? (estado.plan === "itinerario" ? planZona.ultimoItinerario()?.evaluacion : null);
  return {
    zona, ruta, aprobada: !!ev && evaluacionCompleta(ev).decision === "SI",
    plan: { marcas: planZona.bases() },
    opciones: {
      riesgo: estado.riesgo, worker: estado.worker, perfil: estado.perfiles[0],
      region: estado.region, prohibido: estado.prohibido,
      inicio_ms: zona && ruta?.sim?.celdas?.length ? instanteSalidaNavegacion(zona, ruta, estado.salida.hora_salida, Date.now()) : Date.now(),
      antenas: [
        ...planZona.bases().filter((m) => ["habitat", "refugio"].includes(m.tipo)).map((m) => ({ ...m.celda, tipo: "base" })),
        ...(estado.marcas.base ? [{ ...estado.marcas.base.celda, tipo: "base" }] : []), ...planZona.balizas(),
      ],
      vigente: () => estado.zona === zona,
    },
  };
}
// Versión sin navegación (<html data-navegacion="no">): se oculta el botón y no se ofrece en los tramos.
const NAVEGACION_ACTIVA = document.documentElement.dataset.navegacion !== "no";
if (NAVEGACION_ACTIVA) conectarBotonNavegacion($("#btn-navegar"), () => contextoNavegacion(), (e) => avisar(e.message));
else $("#btn-navegar").hidden = true;
// La navegación se abre en una pestaña aparte: esa pestaña repone la sesión (zona, base, destino, plan),
// rehace la ruta y arranca el visor sola. En la pestaña de navegación el botón funciona en el lugar.
const PESTANA_NAVEGACION = new URL(location.href).searchParams.get("navegar") === "1";
$("#btn-navegar").addEventListener("click", (e) => {
  if (PESTANA_NAVEGACION) return;
  e.stopImmediatePropagation();
  guardarSesion();
  const u = new URL(location.href);
  u.searchParams.set("navegar", "1");
  u.searchParams.set("zona", estado.zona.meta.id);
  u.searchParams.set("lang", locale().startsWith("en") ? "en" : "es");
  if (!window.open(u.href, "_blank")) avisar("El navegador bloqueó la pestaña nueva: permití las ventanas emergentes para este sitio.");
}, { capture: true });
if (PESTANA_NAVEGACION) {
  // Espera a que la ruta repuesta quede aprobada y arranca el visor una sola vez.
  const boton = $("#btn-navegar"), limite = Date.now() + 90000;
  let pedido = false;
  const intento = setInterval(() => {
    if (!boton.disabled) { clearInterval(intento); boton.click(); return; }
    // Si la sesión no trajo el itinerario calculado, se pide una vez cuando el motor ya tiene la zona.
    const calc = $("#itinerario-calcular");
    if (!pedido && estado.plan === "itinerario" && planZona.hayItinerario() && calc && !calc.disabled) { pedido = true; calc.click(); }
    else if (Date.now() > limite) { clearInterval(intento); avisar("No hay una ruta aprobada para navegar: calculala en esta pestaña y tocá «Iniciar navegación»."); }
  }, 500);
}
const herramientas = crearHerramientasMapa({
  mapa, estado, $, num, fmt, aMapa, avisar, celdaALonLat, lonLatACelda, leerHttp, RAIZ, imagenDesdeLut,
  bordes: () => [[-estado.zona.alto, 0], [0, estado.zona.ancho]], rutaActual,
  balizas: () => planZona.balizas(), agregarMarca: (tipo, celda) => planZona.agregar(tipo, celda),
});
const barometro = crearBarometro({ mapa, estado, num, aMapa, avisar, leerHttp, RAIZ, herramientas,
  base: () => estado.marcas.base?.celda || planZona.refugios()[0] || null });

// Cuando cambian los refugios o los peligros del plan, el motor rehace la zona segura (y las rutas viejas no valen).
let firmaPlan = "", firmaExclusiones = "[]", esperaPlan = null;
function alCambiarPlan() {
  ubicacion.cambioPlan();
  clearTimeout(esperaPlan);
  esperaPlan = setTimeout(() => {
    if (!estado.worker || !estado.prohibido) return;
    const exc = JSON.stringify(planZona.exclusiones());
    const firma = JSON.stringify(planZona.refugios());
    if (exc !== firmaExclusiones) {
      firmaExclusiones = exc; firmaPlan = firma;
      borrarRutas();
      avisar("Actualizando el terreno prohibido con los peligros marcados…");
      estado.worker.postMessage({ tipo: "exclusiones", lista: planZona.exclusiones() });
    } else if (firma !== firmaPlan) {
      firmaPlan = firma;
      borrarRutas();
      if (estado.marcas.base) pedirRegion(estado.marcas.base.celda);
    }
  }, 250);
}

const menu = crearMenuMapa(mapa);
mapa.on("contextmenu", (e) => {
  e.originalEvent?.preventDefault?.();
  if (estado.vista !== "zona" || !estado.zona) return;
  const celda = deMapa(e.latlng);
  if (!celda) return;
  const z = estado.zona, i = celda.f * z.ancho + celda.c, v = valoresCelda(z, i);
  const { lon, lat } = celdaALonLat(z.meta, celda.f, celda.c);
  const tipos = planZona.tipos();
  const pie = z.meta.vehiculo !== "rover";
  const x = e.originalEvent.clientX, y = e.originalEvent.clientY;
  menu.abrir(x, y, [
    { titulo: `${formatoCoordenadas(lat, ((lon % 360) + 360) % 360)}<br><small>${v.valido ? `altura ${num(v.altura)} m · pendiente ${num(v.pendiente, 1)}°${estado.prohibido?.[i] ? " · prohibido" : ""}` : "sin datos del terreno"}</small>` },
    { texto: "Base de la ruta aquí", accion: () => { if (estado.plan === "itinerario") elegirPlan("auto"); if (marcarBase(celda) && estado.plan === "manual") elegirModo("punto"); } },
    estado.plan !== "manual" && estado.plan !== "itinerario" && { texto: "Destino aquí", accion: () => ponerMarca("destino", celda) },
    { texto: "Parada del itinerario aquí", accion: () => { elegirPlan("itinerario"); planZona.alClicMapa(celda); } },
    "-",
    { titulo: "Agregar al plan" },
    { fila: Object.entries(tipos).map(([k, t]) => ({ letra: t.letra, color: t.color, texto: `${t.nombre}: ${t.descripcion}`, accion: () => planZona.agregar(k, celda) })) },
    "-",
    { texto: "Medir distancia y perfil desde aquí", accion: () => herramientas.medirDesde(celda) },
    { texto: "Cobertura de radio desde aquí", accion: () => herramientas.radioDesde(celda), ayuda: "Línea de vista sobre el relieve, con la curvatura de Marte" },
    { texto: "Luz y sombras del día", accion: () => herramientas.luzYSombras() },
    pie && { texto: "Geoubicación · barómetro", accion: () => barometro.abrir(celda) },
    { texto: "Último punto conocido aquí", accion: () => ubicacion.fijarUltimo(celda) },
    { texto: "Agregar referencia de resección aquí", accion: () => ubicacion.agregarReferencia(celda) },
    { texto: "Ir a coordenadas…", accion: () => herramientas.irACoordenadas() },
    { texto: "Copiar coordenadas", accion: () => herramientas.copiar(celda) },
  ]);
});

function elegirPlan(plan) {
  estado.plan = plan;
  document.querySelectorAll(".pestanas button").forEach((b) => {
    b.classList.toggle("activo", b.dataset.plan === plan);
    b.setAttribute("aria-selected", String(b.dataset.plan === plan));
  });
  document.querySelectorAll("#seccion-ruta [data-solo]").forEach((b) => { b.hidden = !b.dataset.solo.split(" ").includes(plan); });
  for (const id of ["auto", "manual", "itinerario", "expedicion"]) $(`#plan-${id}`).hidden = plan !== id;
  borrarRutas();
  if (plan !== "itinerario") planZona.borrarResultado();
  if (plan !== "expedicion") planZona.borrarExpedicion();
  if (plan === "itinerario") {
    manual.limpiar();
    planZona.dibujarItinerario();
    $("#ayuda-ruta").textContent = "Clic derecho en el mapa → «Parada del itinerario aquí»: la primera es el hábitat y las siguientes, paradas científicas.";
  } else if (plan === "manual") {
    estado.marcas.destino?.remove();
    estado.marcas.destino = null;
    elegirModo(estado.marcas.base ? "punto" : "base");
    manual.verificar();
  } else {
    manual.limpiar();
    elegirModo(estado.marcas.base ? "destino" : "base");
  }
  if (plan === "expedicion") $("#ayuda-ruta").textContent = "Marcá la base y el destino lejano: se planifican los soles de manejo, las noches, los depósitos y los refugios.";
  guardarSesionLuego();
}
document.querySelectorAll(".pestanas button").forEach((b) => b.addEventListener("click", () => elegirPlan(b.dataset.plan)));

function duracion(seg) {
  const m = Math.round(seg / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

function mostrarRuta(r) {
  const perfil = estado.perfiles.find((p) => p.id === r.perfil);
  const color = getComputedStyle(document.documentElement).getPropertyValue(`--${perfil.id}`).trim() || "#fff";
  const tarjeta = document.createElement("button");
  tarjeta.type = "button";
  tarjeta.className = "ruta";
  tarjeta.style.setProperty("--color", color);
  if (r.error) {
    const motivo = { inicio: "la base está en zona prohibida", destino: "el destino está en zona prohibida", sin_camino: "no hay camino dentro de la zona segura" }[r.error] || r.error;
    tarjeta.classList.add("error");
    tarjeta.innerHTML = `<strong>${perfil.nombre}</strong><div class="por-que">Sin ruta: ${motivo}.</div>`;
    tarjeta.disabled = true;
    $("#rutas").append(tarjeta);
    return;
  }
  const z = estado.zona;
  const ev = evaluacionCompleta(r.evaluacion);
  const si = ev?.decision === "SI";
  const colorRuta = si ? color : "#d33a2c";
  tarjeta.style.setProperty("--color", colorRuta);
  estado.rutas[r.perfil] = r;
  estado.lineas[r.perfil] = L.polyline(r.celdas.map((i) => aMapa(Math.floor(i / z.ancho), i % z.ancho)),
    { color: colorRuta, weight: 4, opacity: 0.95, dashArray: si ? null : "8 6" }).addTo(mapa);
  animarTrazo(estado.lineas[r.perfil]);
  estado.rotulos ??= L.layerGroup().addTo(mapa);
  rotularTramos(estado.rotulos, [{ celdas: r.celdas, texto: `${fmt.dist(r.distancia)} · ${duracion(r.tiempo)}${r.sim?.idaYVuelta ? " (ida)" : ""}` }]);
  tarjeta.innerHTML = `${ev ? decisionHtml(ev) : ""}${confiabilidadHtml(r)}<strong>${perfil.nombre}</strong>
    <div class="datos">
      <span>${fmt.dist(r.distancia)}</span><span>${duracion(r.tiempo)} de marcha</span>
      <span>Sube ${fmt.alt(r.sube)}</span><span>Baja ${fmt.alt(r.baja)}</span>
      <span>Pendiente máx. ${fmt.pend(r.pendMax)}</span>${z.paso > 20 ? `<span>Variación del relieve máx. ${num(r.rugMax, 1)} m (en 1 km)</span>` : `<span>Rugosidad máx. ${num(r.rugMax * 100)} cm</span>`}
      ${z.meta.vehiculo !== "rover" && estado.cfgExp ? `<span>≈ ${num(Math.round(r.distancia / estado.cfgExp.a_pie.largo_paso_m.valor))} pasos</span><span>paso de ${num(estado.cfgExp.a_pie.largo_paso_m.valor, 2)} m (a calibrar)</span>` : ""}
      ${Number.isFinite(r.blandoM) && r.blandoM > 0 ? `<span>Suelo blando: ${num(r.blandoM)} m</span>` : ""}
    </div>
    <div class="por-que">${perfil.descripcion}</div>
    ${r.sim ? '<div class="acciones"><span class="boton primario" role="button" tabindex="0" data-simular>Simular la salida</span></div>' : ""}`;
  tarjeta.querySelector("[data-simular]")?.addEventListener("click", (e) => { e.stopPropagation(); simulacion.iniciar(r, "Ruta automática", estado.marcas.base.celda); });
  tarjeta.addEventListener("click", () => elegirRuta(r.perfil));
  tarjeta.dataset.perfil = r.perfil;
  $("#rutas").append(tarjeta);
  if (!estado.elegida) elegirRuta(r.perfil);
}

// Comparación: ruta directa o pasando por bases del plan (recargando el traje en cada una).
function mostrarRutaBases(d) {
  const z = estado.zona;
  const caja = document.createElement("div");
  caja.className = "ruta-bases";
  const titulo = { directa: "RUTA DIRECTA", bases: "CONVIENE PASAR POR BASES", ninguna: "SIN SALIDA APROBADA" }[d.recomendada];
  let html = `<div class="decision ${d.recomendada === "ninguna" ? "no" : "si"}"><div class="veredicto">${titulo}</div>
    <div class="motivo">${escHtml(d.motivo)} <small>(${num(d.consideradas)} bases o depósitos considerados)</small></div></div>`;
  if (d.excluidas?.length) html += `<details><summary>Marcas excluidas: ${num(d.excluidas.length)}</summary><ul>${d.excluidas.map((n) => `<li>${escHtml(n.nombre)}: ${escHtml(n.motivo)}</li>`).join("")}</ul></details>`;
  if (d.diagnostico && !d.cadena) {
    const f = d.diagnostico, ll = celdaALonLat(z.meta, f.punto.f, f.punto.c);
    html += `<p class="falla">${escHtml(f.desde)} → ${escHtml(f.hasta)}: ${escHtml(f.motivo)}<br>
      Punto: ${num(ll.lat, 5)}°, ${num(ll.lon, 5)}° E. ${escHtml(f.sugerencia)}</p>`;
    if (f.controles?.length) html += `<details><summary>Controles del tramo</summary><ul>${f.controles.map((x) => `<li>${escHtml(x.nombre)}: ${typeof x.valor === "number" ? num(x.valor, 2) : escHtml(x.valor ?? "")} / ${typeof x.umbral === "number" ? num(x.umbral, 2) : escHtml(x.umbral ?? "")} ${escHtml(x.unidad ?? "")}</li>`).join("")}</ul></details>`;
    estado.lineasBases?.forEach((l) => l.remove());
    estado.lineasBases = [L.marker(aMapa(f.punto.f, f.punto.c)).bindTooltip(escHtml(f.motivo)).addTo(mapa)];
  }
  const c = d.cadena;
  if (c && (c.recargas > 0 || c.dias)) {
    html += `<ol class="tramos-bases">${c.tramos.map((t, k) => `<li class="${t.ok ? "ok" : "falla"}">
        <b>${escHtml(t.nombreDesde)} → ${escHtml(t.nombreHasta)}</b>${t.dia ? ` (día ${num(t.dia)})` : ""}: ${fmt.dist(t.distancia)} · ${duracion(t.tiempo)}${t.sim?.idaYVuelta ? " (ida y vuelta)" : ""}
        ${t.margenMin !== null ? ` · margen ${num(t.margenMin)} min` : ""}${k < c.tramos.length - 1 ? ` · recarga ${num(d.recargaMin)} min` : ""}
        ${t.pernocte ? `<p>Pernocte en ${escHtml(t.pernocte)}; recarga antes de salir.</p>` : ""}
        ${t.probabilidad ? `<p>Supervivencia estimada de la EVA: ${porcentaje(t.probabilidad.probabilidad_supervivencia)} (modelo, a calibrar).</p>` : ""}
        <details><summary>Controles del tramo</summary><table class="controles">${t.evaluacion.controles.map((x) => `<tr class="${x.ok ? "ok" : x.aviso ? "aviso" : "falla"}" title="${escHtml(`${x.fuente} ${x.detalle}`)}"><td>${x.ok ? "✔" : "⚠"}</td><td>${escHtml(x.nombre)}</td><td>${typeof x.valor === "number" ? num(x.valor, 2) : escHtml(x.valor)} / ${typeof x.umbral === "number" ? num(x.umbral, 2) : escHtml(x.umbral)} ${escHtml(x.unidad)}</td></tr>`).join("")}</table></details>
        <span class="boton chico" role="button" tabindex="0" data-tramo="${k}">Simular</span></li>`).join("")}</ol>
      <div class="datos"><span>Total ${duracion(c.total_s)}</span>${c.dias ? `<span>${num(c.dias)} ${c.dias === 1 ? "día" : "días"}</span><span>${fmt.dist(c.distancia)}</span>` : ""}<span>${num(c.recargas)} ${c.recargas === 1 ? "recarga" : "recargas"}</span>
        ${(() => { const ps = c.tramos.map((t) => (t.probabilidad || confiabilidadDe(t))?.probabilidad_supervivencia).filter((x) => x != null); return ps.length === c.tramos.length ? `<span>Supervivencia de la cadena: <b>${porcentaje(ps.reduce((a, b) => a * b, 1))}</b></span>` : ""; })()}</div>`;
    estado.lineasBases?.forEach((l) => l.remove());
    estado.lineasBases = c.tramos.map((t, k) => L.polyline(t.celdas.map((i) => aMapa(Math.floor(i / z.ancho), i % z.ancho)),
      { color: k % 2 ? "#2bd4c4" : "#46d28c", weight: 5, opacity: d.recomendada === "bases" ? 0.95 : 0.55 }).addTo(mapa));
    estado.lineasBases.forEach(animarTrazo);
    estado.rotulos ??= L.layerGroup().addTo(mapa);
    rotularTramos(estado.rotulos, c.tramos.map((t, k) => ({ celdas: t.celdas, texto: `${k + 1} · ${fmt.dist(t.distancia)} · ${duracion(t.tiempo)}${t.dia ? ` · día ${num(t.dia)}` : ""}` })));
  }
  if (d.aviso) html += `<p class="ayuda">${escHtml(d.aviso)}</p>`;
  caja.innerHTML = html;
  caja.querySelectorAll("[data-tramo]").forEach((b) => b.addEventListener("click", () => {
    const t = c.tramos[+b.dataset.tramo];
    const i = t.celdas[0];
    simulacion.iniciar(t, `Tramo ${+b.dataset.tramo + 1}: ${t.nombreDesde} → ${t.nombreHasta}`, { f: Math.floor(i / z.ancho), c: i % z.ancho });
  }));
  if (NAVEGACION_ACTIVA) caja.querySelectorAll("[data-tramo]").forEach((b) => {
    const tramo = c.tramos[+b.dataset.tramo];
    const nav = document.createElement("button");
    nav.type = "button"; nav.className = "chico";
    b.after(nav);
    conectarBotonNavegacion(nav, () => contextoNavegacion(tramo, tramo.evaluacion), (e) => avisar(e.message));
  });
  $("#rutas").prepend(caja);
}

const BASES = { verificado: "NASA", verificado_parcial: "NASA (parcial)", medicion_propia: "medido", propuesta: "propuesta", calculo: "cálculo", configurado: "configurado" };

// Toda la salida con luz de día: salir después del amanecer y volver antes del atardecer, con margen.
const MARGEN_LUZ_H = 0.5; // propuesta del equipo, a calibrar
function conLuz(ev) {
  if (!ev || !estado.zona) return ev;
  const dur = ev.controles.find((c) => c.id === "duracion");
  if (!dur || !Number.isFinite(dur.valor)) return ev;
  const l = estado.zona.meta.limites;
  const sol = amanecerAtardecer(Date.now(), (l.lon_oeste + l.lon_este) / 2, (l.lat_sur + l.lat_norte) / 2);
  if (sol.amanecer === null || sol.atardecer === null) return ev;
  const [hh0, mm0] = String(estado.salida?.hora_salida || "09:00").split(":").map(Number);
  const sale = hh0 + mm0 / 60, vuelve = sale + dur.valor / 1.0275; // la duración es en horas terrestres; el reloj, en horas de Marte
  const hh = (h) => `${String(Math.floor(h) % 24).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`;
  const ok = sale >= sol.amanecer + MARGEN_LUZ_H && vuelve <= sol.atardecer - MARGEN_LUZ_H;
  const control = { id: "luz", nombre: "Toda la salida con luz de día", valor: `${hh(sale)}–${hh(vuelve)}`, umbral: `${hh(sol.amanecer + MARGEN_LUZ_H)}–${hh(sol.atardecer - MARGEN_LUZ_H)}`,
    ok, aviso: false, unidad: "", base: "propuesta", detalle: "Hora de salida en Opciones (hora solar local).",
    fuente: "Propuesta del equipo: salir y volver con sol, 30 min de margen (de noche el suelo baja a −80 °C y no se ve el terreno). Amanecer y atardecer: Mars24, validado con 700 soles de Curiosity." };
  const controles = [...ev.controles.filter((c) => c.id !== "luz"), control];
  return { ...ev, controles, decision: controles.every((c) => c.ok || c.aviso) ? "SI" : "NO" };
}
const evaluacionCompleta = (ev) => conLuz(conClima(ev, estado.ventana));

// ---------- Confiabilidad: probabilidad de completar la salida y de volver a salvo ----------
// Modelo de primera falla con tasas propuestas (config/confiabilidad.json): sirve para comparar rutas y ver
// dónde conviene un refugio, no es una probabilidad medida en Marte.
const NOMBRE_FALLA = { fuga: "fuga del traje", mochila: "falla de la mochila", companero: "compañero incapacitado", tormenta: "tormenta solar", radio: "pérdida de radio", rover: "falla del rover" };
function confiabilidadDe(ruta) {
  if (!ruta?.sim || !estado.cfgConf || !estado.zona) return null;
  const s = ruta.sim, z = estado.zona;
  const d = [0];
  for (let k = 1; k < s.celdas.length; k++) {
    const i = s.celdas[k - 1], j = s.celdas[k];
    const diag = (i % z.ancho) !== (j % z.ancho) && ((i / z.ancho) | 0) !== ((j / z.ancho) | 0);
    d.push(d[k - 1] + (i === j ? 0 : diag ? z.paso * Math.SQRT2 : z.paso));
  }
  const r = estado.riesgo, v = z.meta.vehiculo === "rover" ? "rover" : "pie";
  const limites = {
    vehiculo: v, primario_s: r[v].consumibles_primarios_h.valor * 3600, secundario_s: r.pie.regreso_emergencia_max_min.valor * 60,
    ingreso_s: r.pie.ingreso_refugio_min.valor * 60, colchon: r.pie.colchon_regreso.valor, rescate_max_s: r.pie.rescate_max_min.valor * 60,
    tormenta_refugio_s: (r.pie.tormenta_refugio_min?.valor ?? 30) * 60,
    // Si falla la mochila, el traje pasa al oxígeno secundario: mismo límite que el regreso de emergencia.
    mochila_s: r.pie.regreso_emergencia_max_min.valor * 60,
    ...(v === "rover" ? { caminata_max_s: r.rover.regreso_a_pie_max_h.valor * 3600 } : {}),
  };
  try {
    return evaluarConfiabilidad({ ruta: { celdas: s.celdas, t: s.t, d, regreso: s.regreso, rescate: s.rescate }, cfg: estado.cfgConf, limites });
  } catch (err) {
    console.warn("Confiabilidad:", err);
    return null;
  }
}
const porcentaje = (p) => (p === null || p === undefined ? "—" : `${num(p * 100, p > 0.999 && p < 1 ? 3 : 1)} %`);
function confiabilidadHtml(ruta) {
  const c = confiabilidadDe(ruta);
  if (!c) return "";
  // Puntos débiles: por tipo de falla, el tramo donde más baja la probabilidad de volver.
  const porTipo = new Map();
  for (const p of c.puntos_debiles) {
    const a = porTipo.get(p.tipo) || { tipo: p.tipo, desde_m: p.desde_m, hasta_m: p.hasta_m, p: 0, motivo: p.motivo };
    a.desde_m = Math.min(a.desde_m, p.desde_m); a.hasta_m = Math.max(a.hasta_m, p.hasta_m); a.p += p.probabilidad_no_regreso;
    porTipo.set(p.tipo, a);
  }
  const debiles = [...porTipo.values()].sort((a, b) => b.p - a.p).slice(0, 3);
  const nivel = c.probabilidad_supervivencia >= 0.9999 ? "si" : c.probabilidad_supervivencia >= 0.999 ? "ambar" : "no";
  return `<div class="confiabilidad ${nivel}">
      <div class="conf-titulo">Probabilidad estimada <small>(modelo de primera falla, tasas a calibrar)</small></div>
      <div class="datos"><span>Completar sin incidentes: <b>${porcentaje(c.probabilidad_completar_sin_incidentes)}</b></span>
        <span>Volver a salvo si algo falla: <b>${porcentaje(c.probabilidad_regreso_si_falla)}</b></span>
        <span>Supervivencia: <b>${porcentaje(c.probabilidad_supervivencia)}</b></span></div>
      ${debiles.length ? `<ul class="motivos">${debiles.map((d) => `<li class="ambar">Punto débil (${NOMBRE_FALLA[d.tipo] || d.tipo}): entre ${fmt.dist(d.desde_m)} y ${fmt.dist(d.hasta_m)} de la ruta el regreso no llega a tiempo. Un refugio más cerca lo resuelve.</li>`).join("")}</ul>`
        : '<p class="ayuda">Desde todos los puntos de la ruta hay regreso a tiempo para cada falla modelada.</p>'}
    </div>`;
}

// Decisión de salida: SÍ / NO y cada control con su valor, umbral y origen del umbral.
function decisionHtml(ev) {
  ev = evaluacionCompleta(ev);
  const fmt = (c) => (typeof c.valor === "string" ? c.valor : c.unidad === "h" ? num(c.valor, 1) : c.unidad === "°" ? num(c.valor, 1) : num(c.valor));
  const tipo = (c) => (c.ok ? "ok" : c.aviso ? "aviso" : "falla");
  const ICONO = { ok: "✔", aviso: "⚠", falla: "✖" };
  const filas = ev.controles.map((c) => `<tr class="${tipo(c)}" title="${(c.fuente + " " + c.detalle).replace(/"/g, "&quot;")}">
      <td>${ICONO[tipo(c)]}</td><td>${c.nombre}</td>
      <td>${fmt(c)} ${c.unidad} / ${typeof c.umbral === "string" ? c.umbral : `≤ ${c.unidad === "h" ? num(c.umbral, 1) : num(c.umbral, c.unidad === "°" ? 1 : 0)} ${c.unidad}`}</td>
      <td class="origen">${BASES[c.base] || c.base}</td></tr>`).join("");
  const fallas = ev.controles.filter((c) => tipo(c) === "falla").map((c) => c.nombre.toLowerCase());
  const avisos = ev.controles.filter((c) => tipo(c) === "aviso").map((c) => c.nombre.toLowerCase());
  const clase = ev.decision !== "SI" ? "no" : avisos.length ? "ambar" : "si";
  return `<div class="decision ${clase}">
      <div class="veredicto">${ev.decision !== "SI" ? "SALIDA NO APROBADA" : avisos.length ? "SALIDA APROBADA CON AVISOS" : "SALIDA APROBADA"}</div>
      ${fallas.length ? `<div class="motivo">No cumple: ${fallas.join(", ")}.</div>` : ""}
      ${avisos.length ? `<div class="motivo">Revisar antes de salir: ${avisos.join(", ")}.</div>` : ""}
      ${!fallas.length && !avisos.length ? `<div class="motivo">Cumple todos los controles. Pasá el cursor por cada uno para ver su fuente.</div>` : ""}
      <table class="controles">${filas}</table>
    </div>`;
}

function elegirRuta(id) {
  estado.elegida = id;
  document.querySelectorAll(".ruta").forEach((t) => t.classList.toggle("elegida", t.dataset.perfil === id));
  Object.entries(estado.lineas).forEach(([k, l]) => l.setStyle({ weight: k === id ? 6 : 3, opacity: k === id ? 1 : 0.6 }));
  estado.lineas[id].bringToFront();
  dibujarPerfil(estado.rutas[id], estado.lineas[id].options.color);
}

function dibujarPerfil(r, color) {
  const lienzo = $("#perfil");
  lienzo.hidden = false;
  const dpr = window.devicePixelRatio || 1;
  const w = lienzo.clientWidth, h = lienzo.clientHeight;
  lienzo.width = w * dpr; lienzo.height = h * dpr;
  const ctx = lienzo.getContext("2d");
  ctx.scale(dpr, dpr);
  const zs = r.perfilAltura.map((p) => p.z);
  const zMin = Math.min(...zs), zMax = Math.max(...zs), dMax = r.perfilAltura[r.perfilAltura.length - 1].d || 1;
  const m = { i: 40, d: 8, a: 8, b: 18 };
  const X = (d) => m.i + (d / dMax) * (w - m.i - m.d);
  const Y = (zz) => h - m.b - ((zz - zMin) / Math.max(zMax - zMin, 1)) * (h - m.a - m.b);
  const texto = getComputedStyle(document.body).color;
  ctx.font = "11px system-ui"; ctx.fillStyle = texto; ctx.globalAlpha = 0.7;
  ctx.fillText(`${num(zMax)} m`, 2, m.a + 8);
  ctx.fillText(`${num(zMin)} m`, 2, h - m.b);
  ctx.fillText(`${num(dMax / 1000, 2)} km`, w - 50, h - 4);
  ctx.globalAlpha = 1; ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath();
  r.perfilAltura.forEach((p, k) => (k ? ctx.lineTo(X(p.d), Y(p.z)) : ctx.moveTo(X(p.d), Y(p.z))));
  ctx.stroke();
}

// ---------- Carga de zona ----------
function listoTexto() {
  const z = estado.zona;
  return `${z.meta.nombre}: ${num((z.ancho * z.paso) / 1000, 1)} × ${num((z.alto * z.paso) / 1000, 1)} km, celdas de ${num(z.paso)} m`;
}

function mostrarFuentes() {
  const ul = $("#fuentes");
  ul.innerHTML = "";
  for (const f of Object.values(estado.zona.meta.fuentes)) {
    const li = document.createElement("li");
    li.innerHTML = `<a href="${f.url}" target="_blank" rel="noopener">${f.nombre}</a> · ${f.mision}`;
    ul.append(li);
  }
  for (const [clave, p] of [["Pendiente máxima", estado.limitePendiente], ["Rugosidad máxima", estado.traje.rugosidad_max_cm]]) {
    const li = document.createElement("li");
    li.textContent = `${t(clave)}: ${num(p.valor, Number.isInteger(p.valor) ? 0 : 1)} (${t(p.fuente)})`;
    ul.append(li);
  }
}

// Deja el mapa vacío antes de cambiar de vista.
function limpiarVista() {
  simulacion.detener();
  barometro.limpiar();
  herramientas.limpiar();
  planZona.limpiar();
  menu.cerrar();
  Object.values(estado.capas).forEach((c) => mapa.removeLayer(c));
  estado.capas = {}; estado.prohibido = null;
  $("#borrar").click();
  estado.worker?.terminate();
  estado.worker = null;
  estado.zona = null;
  mapa.closePopup();
}

// Zoom hacia la zona tocada y, al terminar el vuelo, abre el mapa de su región.
function elegirCandidata({ lat, lon, region, nombre }) {
  if (!region) { avisar(`${nombre}: la región todavía no se generó. Corré el pipeline de regiones.`); return; }
  avisar(`Yendo a ${nombre}…`);
  let abierta = false;
  const abrir = () => { if (!abierta) { abierta = true; abrirZona(region.id); } };
  const tam = mapa.getSize();
  if (tam.x > 0 && tam.y > 0) {
    try {
      mapa.once("moveend", abrir);
      mapa.flyTo([lat, lon], 6, { duration: 1.2 });
      return;
    } catch {
      mapa.off("moveend", abrir);
    }
  }
  abrir(); // sin espacio para animar (mapa oculto o muy chico): se abre directo
}

async function abrirMarte() {
  borrar("rf-zona");
  limpiarVista();
  estado.vista = "marte";
  $("#zona").value = "marte";
  ubicacion.limpiar();
  $("#seccion-ubicacion").hidden = true;
  $("#seccion-ruta").hidden = true;
  avisar("Cargando el mapa de Marte…");
  ocupado(true);
  estado.marte ??= await cargarMarte(RAIZ);
  const defs = capasMarte(estado.marte, estado.indice.zonas, RAIZ, num, elegirCandidata)
    .map((d) => ({ ...d, crear: async () => d.capa }));
  estado.defs = defs;
  dibujarControlesCapas(defs);
  for (const d of defs) if (d.activa) await alternarCapa(d, true);
  mapa.fitBounds([[-90, -180], [90, 180]]);
  escala.actualizar();
  const m = estado.marte.meta;
  $("#fuentes").innerHTML = `<li><a href="${m.fondo.pagina}" target="_blank" rel="noopener">JPL Mars Trek</a>: ${m.fondo.nombre}</li>
    <li>${m.candidatas.nombre}. Radio: ${m.candidatas.radio_zona_km.fuente}</li>`;
  ocupado(false);
  const conMapa = estado.marte.candidatas.features.length;
  avisar(`Marte: ${conMapa} zonas candidatas para misiones humanas. Tocá una para ver de qué se trata; las verdes tienen mapa detallado.`);
}

async function abrirZona(id) {
  estado.sesionLista = false;
  limpiarVista();
  estado.vista = "zona";
  $("#zona").value = id;
  ubicacion.limpiar();
  $("#seccion-ruta").hidden = false;
  avisar("Cargando la zona…");
  ocupado(true);
  estado.zona = await cargarZona(`${RAIZ}/datos/${id}`, leerHttp);
  const z = estado.zona;
  // Límite de pendiente para caminar: capacidad del traje menos el margen medido en esta zona.
  const lim = limitePendientePie(estado.riesgo, z.meta.validacion?.margen_pendiente_p95_grados);
  estado.pieEfectivo = { ...estado.vehiculos.pie, pendiente_max_grados: lim };
  if (z.meta.vehiculo === "rover") {
    estado.traje = estado.vehiculos.rover;
    estado.limitePendiente = { valor: estado.traje.pendiente_max_grados.valor, fuente: estado.traje.pendiente_max_grados.fuente };
  } else {
    estado.traje = estado.pieEfectivo;
    estado.limitePendiente = lim;
  }
  $("#seccion-ruta h2").textContent = z.meta.vehiculo === "rover" ? "Plan de salida · rover" : "Plan de salida · a pie";
  $('[data-plan="expedicion"]').hidden = z.meta.vehiculo !== "rover";
  if (estado.plan === "expedicion" && z.meta.vehiculo !== "rover") elegirPlan("auto");
  await planZona.abrirZona(id);
  firmaPlan = JSON.stringify(planZona.refugios());
  firmaExclusiones = "[]";
  mapa.fitBounds([[-z.alto, 0], [0, z.ancho]]);
  escala.actualizar();
  mostrarFuentes();
  const defs = definirCapas();
  estado.defs = defs;
  dibujarControlesCapas(defs);
  for (const d of defs) if (d.activa && !d.requiere) await alternarCapa(d, true);

  ubicacion.abrirZona(id);
  avisar(`Calculando las zonas prohibidas para ${quien()}…`);
  estado.worker = new Worker("js/ruteo-worker.js", { type: "module" });
  const enviar = estado.worker.postMessage.bind(estado.worker);
  estado.worker.postMessage = (m) => { ocupado(true); enviar(m); };
  estado.worker.onmessage = async ({ data }) => {
    if (TERMINALES.has(data.tipo)) ocupado(false);
    if (data.tipo === "listo") {
      estado.prohibido = data.prohibido;
      const casilla = document.querySelector('[data-capa="prohibido"]');
      if (casilla?.checked) await alternarCapa(defs.find((d) => d.id === "prohibido"), true);
      avisar(`${listoTexto()} · ${num((100 * data.prohibidas) / (z.ancho * z.alto), 1)} % prohibido para ${quien()}`);
      actualizarAyuda();
      planZona.dibujarItinerario();
      alCambiarPlan(); // peligros con radio de un plan guardado
      sincronizarBases();
      if (!(await restaurarSesion())) {
        const primera = planZona.bases()[0];
        if (primera && !estado.marcas.base) ponerMarca("base", primera.celda, primera.id);
      }
      estado.sesionLista = true;
      guardarSesionLuego();
    } else if (data.tipo === "region") {
      const base = estado.marcas.base?.celda;
      if (!base || base.f !== data.inicio.f || base.c !== data.inicio.c) return; // respuesta vieja
      estado.region = data.region;
      await rehacerCapa("alcanzable");
      const area = data.celdas * z.paso * z.paso;
      const areaTexto = area >= 1e5 ? `${num(area / 1e6, 2)} km²` : `${num(area)} m²`;
      const clave = `${data.inicio.f},${data.inicio.c}`;
      const otros = planZona.refugios().filter((c) => c.f !== data.inicio.f || c.c !== data.inicio.c).length;
      const previa = estado.areaSegura?.clave === clave ? estado.areaSegura : null;
      estado.areaSegura = { clave, area, refugios: data.refugios };
      const delta = previa && data.refugios !== previa.refugios ? area - previa.area : 0;
      const crecio = Math.abs(delta) >= z.paso * z.paso
        ? ` ${delta > 0 ? "Creció" : "Bajó"} ${Math.abs(delta) >= 1e5 ? `${num(Math.abs(delta) / 1e6, 2)} km²` : `${num(Math.abs(delta))} m²`} con los refugios del plan.`
        : previa && data.refugios !== previa.refugios ? " Ese refugio no la agranda: no es el tiempo lo que la encierra." : "";
      // Qué marca el borde: así se sabe dónde conviene el próximo refugio.
      const lim = data.limites, tot = lim ? lim.terreno + lim.rescate + lim.tiempo : 0;
      const pc = (x) => num((100 * x) / tot);
      const borde = tot ? ` Borde: ${[[lim.rescate, `${pc(lim.rescate)} % pendiente de más de ${num(estado.riesgo.pie.rescate_pendiente_max_grados.valor)}° (no se podría arrastrar a un compañero)`],
        [lim.terreno, `${pc(lim.terreno)} % terreno prohibido`], [lim.tiempo, `${pc(lim.tiempo)} % tiempo de regreso`]].filter(([x]) => x > 0).sort((a, b) => b[0] - a[0]).map(([, t]) => t).join(", ")}.`
        + (lim.tiempo / tot > 0.2 ? " Un refugio cerca de ese borde la agranda." : " Un refugio adentro no la agranda: probá uno del otro lado de esa pendiente.") : "";
      let aviso = area < estado.traje.region_minima_m2.valor && !data.refugios
        ? `Esa base queda en un parche aislado de ${areaTexto}, rodeado de terreno prohibido: conviene elegir otra.`
        : `Zona segura ${otros ? `de la base y ${otros} ${otros === 1 ? "refugio más" : "refugios más"}` : "desde la base"}: ${areaTexto} (${z.meta.vehiculo === "rover"
          ? `regreso a pie en ${estado.riesgo.rover.regreso_a_pie_max_h.valor} h o menos si falla el rover`
          : `regreso de emergencia en ${estado.riesgo.pie.regreso_emergencia_max_min.valor} min y rescate del compañero posibles hasta el refugio más cercano`}).${crecio}${borde}`;
      const destino = estado.marcas.destino;
      if (estado.plan === "manual") manual.verificar();
      else if (destino) {
        const ajuste = ajustarDestino(destino.celda);
        if (ajuste.aviso) {
          aviso = ajuste.aviso;
          if (ajuste.celda) { destino.celda = ajuste.celda; destino.setLatLng(aMapa(ajuste.celda.f, ajuste.celda.c)); }
          else { destino.remove(); estado.marcas.destino = null; }
        }
      }
      $("#info-zona").textContent = aviso;
      avisar(aviso.split(". ")[0] + ".");
      actualizarAyuda();
      const re = estado.recalcular;
      estado.recalcular = null;
      if (re?.rutas && estado.marcas.base && estado.marcas.destino) { avisar("Recalculando la ruta que tenías antes de recargar…"); $("#calcular").click(); }
      if (re?.itinerario && planZona.hayItinerario()) $("#itinerario-calcular").click();
    } else if (data.tipo === "localizando") {
      ubicacion.alProgreso(data);
    } else if (data.tipo === "evento") {
      ubicacion.alEvento(data);
    } else if (data.tipo === "ubicacion") {
      ubicacion.alResultado(data);
    } else if (data.tipo === "manual") {
      estado.ultimoManual = data.ruta;
      if (estado.ultimoManual) estado.ultimoManual.evaluacion = data.evaluacion;
      manual.alResponder(data);
      if (data.ruta?.sim && data.evaluacion) {
        $("#manual-plan").insertAdjacentHTML("beforeend", confiabilidadHtml(data.ruta));
        const b = document.createElement("div");
        b.className = "acciones";
        b.innerHTML = '<button type="button" class="primario">Simular la salida</button>';
        b.firstChild.addEventListener("click", () => simulacion.iniciar(data.ruta, "Trazado manual", estado.marcas.base.celda));
        $("#manual-plan").append(b);
      }
    } else if (data.tipo === "itinerario") {
      planZona.alResponderItinerario(data);
    } else if (data.tipo === "expedicion") {
      planZona.alResponderExpedicion(data);
    } else if (data.tipo === "exclusiones") {
      estado.prohibido = data.prohibido;
      await rehacerCapa("prohibido");
      avisar(`Terreno prohibido actualizado: ${num((100 * data.prohibidas) / (z.ancho * z.alto), 1)} % (incluye los peligros marcados).`);
      if (estado.marcas.base) pedirRegion(estado.marcas.base.celda);
    } else if (data.tipo === "camino_regreso") {
      simulacion.alCamino(data);
    } else if (data.tipo === "radio") {
      herramientas.alRadio(data);
    } else if (data.tipo === "sombras") {
      herramientas.alSombras(data);
    } else if (data.tipo === "perfil") {
      herramientas.alPerfil(data);
    } else if (data.tipo === "barometro") {
      barometro.alResultado(data);
    } else if (data.tipo === "tramo") {
      manual.alResponderTramo(data);
    } else if (data.tipo === "ruta") {
      mostrarRuta(data);
    } else if (data.tipo === "config") {
      if (estado.marcas.base) { estado.recalcular = { rutas: !!estado.marcas.destino, itinerario: estado.plan === "itinerario" && planZona.hayItinerario() }; pedirRegion(estado.marcas.base.celda); }
    } else if (data.tipo === "ruta_bases") {
      mostrarRutaBases(data);
    } else if (data.tipo === "rutas_fin") {
      guardarSesionLuego();
      avisar(listoTexto());
      actualizarAyuda();
    } else if (data.tipo === "error") {
      $("#ubicar").disabled = false;
      $("#ubicacion-progreso").hidden = true;
      avisar(`Error: ${data.mensaje}`);
      actualizarAyuda();
    }
  };
  estado.worker.postMessage({
    tipo: "cargar", base: `${RAIZ_DATOS}/${id}`, traje: estado.traje, pie: estado.pieEfectivo,
    riesgo: estado.riesgo, vehiculo: z.meta.vehiculo || "pie", limitePendiente: estado.limitePendiente,
  });
}

// Traducción al inglés: se aplica a todo lo que se muestra (y a lo que aparece después) antes del primer dibujo.
async function prepararIdioma() {
  const sel = $("#idioma");
  sel.value = IDIOMA;
  sel.addEventListener("change", () => {
    guardar("rf-idioma", sel.value);
    const u = new URL(location.href);
    u.searchParams.set("lang", sel.value);
    location.href = u.toString();
  });
  if (IDIOMA !== "en") return;
  try {
    const dic = await leerHttp("i18n/en.json", "json");
    const tr = crearTraductor(dic, "en");
    usarTraductor(tr);
    document.documentElement.lang = "en";
    document.title = tr.t(document.title);
    traducirNodo(document.body, tr.t);
    observarTraduccion(document.body, tr.t);
    window.__faltantes = tr.faltantes; // para revisar lo que falta traducir
  } catch (err) {
    console.warn("Sin traducción al inglés:", err);
  }
}

async function iniciar() {
  await prepararIdioma();
  await guia.bienvenida();
  try {
    const [indice, traje, rutas, riesgo] = await Promise.all([
      leerHttp(`${RAIZ}/datos/indice.json`, "json"),
      leerHttp(`${RAIZ}/config/traje.json`, "json"),
      leerHttp(`${RAIZ}/config/rutas.json`, "json"),
      leerHttp(`${RAIZ}/config/riesgo.json`, "json"),
    ]);
    estado.riesgoBase = riesgo;
    estado.salida = { ...salidaPorDefecto(riesgo), ...(leerSalida() || {}) };
    estado.riesgo = aplicarSalida(riesgo, estado.salida);
    dibujarSalida();
    ventana.cargar();
    estado.traje = traje;
    estado.perfiles = rutas.perfiles;
    estado.indice = indice;
    estado.vehiculos = { pie: traje, rover: await leerHttp(`${RAIZ}/config/rover.json`, "json") };
    estado.cfgExp = await leerHttp(`${RAIZ}/config/expedicion.json`, "json");
    estado.cfgConf = await leerHttp(`${RAIZ}/config/confiabilidad.json`, "json").catch(() => null);
    const sel = $("#zona");
    if (indice.marte) sel.append(new Option("Todo Marte · zonas candidatas", "marte"));
    const grupos = [["salida", "Mapas de caminata (1 m)"], ["region", "Zonas candidatas · región para rover (200 m)"]];
    for (const [nivel, titulo] of grupos) {
      const zs = indice.zonas.filter((z) => z.nivel === nivel).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
      if (!zs.length) continue;
      const g = document.createElement("optgroup");
      g.label = `${titulo} · ${zs.length}`;
      for (const z of zs) g.append(new Option(z.nombre, z.id));
      sel.append(g);
    }
    if (!sel.options.length) { avisar("No hay zonas generadas. Corré el pipeline primero."); return; }
    sel.addEventListener("change", () => (sel.value === "marte" ? abrirMarte() : abrirZona(sel.value)));
    const pedida = new URL(location.href).searchParams.get("zona") || (() => { try { return localStorage.getItem("rf-zona"); } catch { return null; } })();
    if (pedida && indice.zonas.some((z) => z.id === pedida)) await abrirZona(pedida);
    else await (indice.marte ? abrirMarte() : abrirZona(indice.zonas[0].id));
    guia.lista();
  } catch (err) {
    avisar(`No se pudo iniciar: ${err.message}`);
    console.error(err);
  }
}

const guia = crearGuia({ idioma: IDIOMA, estado, ganchos: {
  marte: abrirMarte, zona: abrirZona,
  menu: () => { const p = mapa.getCenter(), r = $("#mapa").getBoundingClientRect(); mapa.fire("contextmenu", { latlng: p, originalEvent: { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 } }); },
  herramienta: (nombre) => { const celda = estado.marcas.base?.celda || deMapa(mapa.getCenter()); return nombre === "barometro" ? barometro.abrir(celda) : herramientas[nombre](celda); },
} });
iniciar();
