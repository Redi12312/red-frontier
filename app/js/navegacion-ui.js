// Interfaz aislada: no modifica el plan ni la ruta de la app. Toda integración es explícita.
import { crearNavegacion, validarArranque, parametro, puntoCelda, alturaEn, angular } from "./navegacion.js";
import { crearVistaMarte, leerTextura } from "./vista-marte.js";
import { crearVoz, COMANDOS } from "./voz.js";
import { leerHttp, cargarZona, lonLatACelda, celdaALonLat } from "./zona.js";
import { amanecerAtardecer } from "./luz.js";
import { locale, crearTraductor } from "./idioma.js";

const RAIZ = new URL("../../", import.meta.url);
const url = (s) => new URL(s, RAIZ).href;
const json = (s) => leerHttp(url(s), "json");
let sesion = null;
const textosComandos = { estado: "Estado", oxigeno: "Oxígeno", posicion: "¿Dónde estoy?", hito: "Próximo punto", regreso: "Regreso",
  pausa: "Pausa", seguir: "Seguir", rapido: "Más rápido", aborto: "Abortar", foto: "Foto", peligro: "Marcar peligro", ayuda: "Ayuda", terminar: "Terminar navegación" };
const tiposMedidas = { barometro: "Barómetro", radio: "Distancia por radio", uwb: "Baliza UWB", pasos: "Pasos", odometria: "Odometría",
  reseccion: "Rumbo a un cerro", sol: "Sol", doppler: "Posición Doppler externa", estrellas: "Posición astronómica externa" };
const avisosES = { aborto: "ABORTAR: no alcanza el margen de regreso. Volvé al refugio por el camino calculado.",
  regreso: "ABORTAR: regreso desconocido o fuera del límite de emergencia.", terreno: "ABORTAR: la posición estimada queda en terreno prohibido o sin datos.",
  aborto_ordenado: "ABORTAR: regreso ordenado por la tripulación.",
  terminar: "Terminá la salida: queda poco margen de regreso.", corredor: "Te saliste del corredor. Pausá y localizate antes de seguir.",
  localizar: "El error de posición supera el radio de decisión. Corregí con una foto o medidas.",
  blando: "Precaución: suelo blando probable, modelado con THEMIS.", radio: "Advertencia: sin cobertura geométrica de radio." };

export async function cargarEscenarioNavegacion() { return json("datos/navegacion/gale.json"); }

// Comparte el Worker existente sin reemplazar onmessage ni ocupar la cola óptica.
export function crearEnlaceRutasNavegacion({ worker, inicio, perfil, antenas = [], espera_s }) {
  if (!(espera_s > 0)) throw new Error("Falta el plazo de espera del Worker.");
  let secuencia = 0, cerrado = false;
  const pendientes = new Map();
  function recibir({ data }) {
    const p = pendientes.get(data.pedido);
    if (!p) return;
    if (data.tipo === "error") { clearTimeout(p.reloj); pendientes.delete(data.pedido); p.rechazar(new Error(data.mensaje)); }
    else if (data.tipo === p.tipo) { clearTimeout(p.reloj); pendientes.delete(data.pedido); p.resolver(data); }
  }
  worker.addEventListener("message", recibir);
  function pedir(tipo, datos) {
    if (cerrado) return Promise.reject(new Error("Enlace cerrado."));
    const pedido = `navegacion-${Date.now()}-${++secuencia}`;
    return new Promise((resolver, rechazar) => {
      const reloj = setTimeout(() => { pendientes.delete(pedido); rechazar(new Error("Worker sin respuesta.")); }, espera_s * 1000);
      pendientes.set(pedido, { tipo, resolver, rechazar, reloj });
      try { worker.postMessage({ tipo, pedido, ...datos }); } catch (error) { clearTimeout(reloj); pendientes.delete(pedido); rechazar(error); }
    });
  }
  return {
    async pedirCamino({ desde, campo, limite_s }) {
      const r = await pedir("camino_regreso", { desde, campo, limite: limite_s, inicio, perfil });
      return r.celdas ? { celdas: r.celdas, tiempos: r.tiempos, criterio: r.criterio } : null;
    },
    async pedirRadio(cfg) { return (await pedir("radio", { antenas, cfg })).visible; },
    cerrar() { cerrado = true; worker.removeEventListener("message", recibir); for (const p of pendientes.values()) { clearTimeout(p.reloj); p.rechazar(new Error("Enlace cerrado.")); } pendientes.clear(); },
  };
}

// Vinculación opcional: conserva el motivo visible en un span porque un botón disabled no recibe foco.
export function conectarBotonNavegacion(boton, obtenerContexto, alError = (e) => globalThis.alert(e.message)) {
  const motivo = document.createElement("span"); motivo.id = `${boton.id}-motivo`; motivo.setAttribute("role", "status");
  boton.after(motivo); boton.setAttribute("aria-describedby", motivo.id);
  const actualizar = () => {
    if (boton.isConnected === false) { clearInterval(reloj); boton.removeEventListener("click", abrir); motivo.remove(); return; }
    const en = locale().startsWith("en"), v = validarArranque(obtenerContexto());
    boton.textContent = en ? "Start navigation" : "Iniciar navegación"; boton.disabled = !v.ok;
    motivo.textContent = v.ok ? "" : en ? "Choose a walking zone and an approved route with simulation data."
      : "Elegí una zona de caminata y una ruta aprobada con datos de simulación.";
  };
  const abrir = async () => { try { await iniciarNavegacion(obtenerContexto()); } catch (e) { alError(e); } };
  boton.addEventListener("click", abrir);
  const reloj = setInterval(actualizar, 500); actualizar();
  return { actualizar, cerrar() { clearInterval(reloj); boton.removeEventListener("click", abrir); motivo.remove(); } };
}

/** iniciarNavegacion({zona,ruta,aprobada,plan,opciones}) → controlador.
 * opciones: idioma, riesgo efectivo, escenario?, zonaBase?, inicio_ms?, region?, prohibido?,
 * pedirCamino({desde,campo,limite_s})→Promise<{celdas,tiempos,nombreRefugio?}|null>, alPeligro?.
 * La aprobación la entrega la app. Nunca se deduce por la mera existencia de una polilínea.
 * Un tramo por bases/días usa el mismo contrato ruta.sim; iniciar cada tramo preserva su aprobación.
 */
export async function iniciarNavegacion({ zona, ruta, aprobada, plan = {}, opciones = {} } = {}) {
  const idioma = opciones.idioma ?? (locale().startsWith("en") ? "en" : "es");
  const diccionario = await json("app/i18n/navegacion.en.json");
  const tr = crearTraductor(diccionario, idioma), t = tr.t, en = idioma === "en";
  const valido = validarArranque({ zona, ruta, aprobada });
  if (!valido.ok) throw new Error(t("Elegí una zona de caminata y una ruta aprobada con datos de simulación."));
  sesion?.cerrar();
  const [cfg, riesgoArchivo, consumibles, cfgGeo, cfgBarometro, cfgExpedicion] = await Promise.all([
    "config/navegacion.json", "config/riesgo.json", "config/consumibles.json", "config/geoubicacion.json", "config/barometro.json", "config/expedicion.json"].map(json));
  const riesgo = opciones.riesgo ?? riesgoArchivo, escenario = opciones.escenario ?? {};
  const sensores = (escenario.sensores ?? []).map((s) => s.tipo === "barometro" ? { ...s, cfg: cfgBarometro } : s);
  const z = { ...zona, prohibido: opciones.prohibido ?? zona.prohibido };
  const motor = crearNavegacion({ zona: z, ruta, cfg, riesgo, consumibles, escenario: { ...escenario, sensores },
    inicio_ms: opciones.inicio_ms ?? escenario.inicio_ms ?? Date.now() });
  const baseZona = opciones.zonaBase ?? url(`datos/${zona.meta.id}`);
  const enlace = opciones.worker ? crearEnlaceRutasNavegacion({ worker: opciones.worker,
    inicio: opciones.inicio ?? puntoCelda(zona, motor.ruta.celdas[0]), perfil: opciones.perfil,
    antenas: opciones.antenas ?? [{ ...puntoCelda(zona, motor.ruta.celdas[0]), tipo: "base" }], espera_s: parametro(cfg, "espera_localizador_s") }) : null;
  const focoAnterior = document.activeElement, scrollAnterior = document.body.style.overflow;
  const raiz = document.createElement("section"); raiz.className = "nav-casco"; raiz.dataset.noTraducir = "";
  raiz.setAttribute("role", "dialog"); raiz.setAttribute("aria-modal", "true"); raiz.setAttribute("aria-label", t("Navegación de casco"));
  raiz.lang = idioma; raiz.tabIndex = -1;
  // Todos los datos externos entran con textContent; el HTML siguiente solo contiene texto propio.
  raiz.innerHTML = `<canvas class="nav-vista" aria-label="${t("Vista simulada del relieve")}"></canvas>
    <header><strong>${t("Navegación de casco")}</strong><span>${t("Tiempo real simulado · a calibrar")}</span><button data-c="terminar">${t("Terminar navegación")} (Esc)</button></header>
    <p class="nav-origen">${t("Vista simulada desde el relieve HiRISE (no es video real)")} · ${t("Sombras aproximadas")}</p>
    <div class="nav-cuerpo"><div class="nav-datos"><p data-v="decision"></p><p data-v="guia"></p><p data-v="posicion"></p>
      <canvas class="nav-minimapa" width="260" height="200" aria-label="${t("Minimapa: ruta, incertidumbre y bases")}"></canvas>
      <dl data-v="datos"></dl><div data-v="recursos"></div></div>
    <aside><div class="nav-avisos" role="status" aria-live="polite"></div>
      <details open><summary>${t("Cámara")}</summary><img class="nav-foto" hidden alt="${t("Foto real de Curiosity Navcam")}"><p data-v="credito"></p>
        <button data-c="foto">${t("Localizar con la foto actual")}</button><button data-cancelar>${t("Cancelar corrección")}</button><progress max="1" value="0" hidden></progress>
        <label>${t("Fotos del entorno (JPG/PNG)")}<input data-archivos type="file" accept="image/jpeg,image/png" multiple></label>
        <label>${t("Metadatos CAHVOR y orientación (JSON)")}<input data-meta type="file" accept="application/json"></label><p>${t("Las fotos necesitan CAHVOR y attitude; sin metadatos no se estima una posición.")}</p>
      </details><details><summary>${t("Sumar medidas")}</summary><form class="nav-medidas">
        <label>${t("Tipo")}<select name="tipo">${Object.entries(tiposMedidas).map(([s, etiqueta]) => `<option value="${s}">${t(etiqueta)}</option>`).join("")}</select></label>
        <div data-campos></div><button type="submit">${t("Corregir posición")}</button></form>
        <p>${t("Medidas independientes, errores de 1 sigma. Reutiliza la fusión de «Geoubicación sin GPS»; no cargues dos veces la misma lectura.")}</p></details>
      <details><summary>${t("Simulación y fallas")}</summary><label><input data-sensores type="checkbox" checked>${t("Correcciones simuladas de sensores")}</label>
        ${["fuga", "companero", "tormenta", "radio"].map((f) => `<button data-falla="${f}">${t({ fuga: "Fuga de oxígeno", companero: "Compañero incapacitado", tormenta: "Partículas solares", radio: "Pérdida de radio" }[f])}</button>`).join("")}
        <button data-orientacion>${t("Orientación del teléfono solo para mirar")}</button>
        <p>${t("Radiación y DONKI: revisá la fecha del parte. Sin dosímetro; no se supone ausencia de riesgo.")}</p><p data-v="radiacion"></p>
      </details><details><summary>${t("Bitácora y rendimiento")}</summary><button data-exportar="json">JSON</button><button data-exportar="geojson">GeoJSON</button><p data-v="fps"></p><p data-v="registro"></p></details>
    </aside></div><footer><div class="nav-controles">${COMANDOS.map((c) => `<button data-c="${c}">${t(textosComandos[c])}</button>`).join("")}
      ${cfg.velocidades.valor.map((v) => `<button data-vel="${v}">×${v}</button>`).join("")}<button data-saltar>${t("Saltar al próximo hito")}</button>
      <button data-micro>${t("Hablar")} (V)</button></div><p data-v="transcripcion" aria-live="polite"></p><p data-v="mensaje" role="status"></p></footer>`;
  document.body.append(raiz); document.body.style.overflow = "hidden"; raiz.focus();
  const $ = (s) => raiz.querySelector(s), escribir = (clave, texto) => { const n = $(`[data-v="${clave}"]`); if (n.textContent !== texto) n.textContent = texto; };
  const n = (v, dec = 0) => Number.isFinite(v) ? v.toLocaleString(en ? "en-US" : "es-UY", { maximumFractionDigits: dec }) : "—";
  const tiempo = (s) => Number.isFinite(s) ? `${n(s / 60, 1)} min` : "—";
  let cerrado = false, pausa = false, velocidad = cfg.velocidades.valor[0], ultimo = performance.now(), raf = null, hudUltimo = -Infinity;
  let vista = crearVistaMarte({ canvas: $(".nav-vista"), zona, cfg: cfg.render, movimientoReducido: matchMedia("(prefers-reduced-motion: reduce)").matches });
  let contexto = null, textura = null, fotoActual = null, fotosSubidas = [], metadatos = [], indiceOptico = null;
  let worker = null, secuencia = 0, trabajo = null, permisoOrientacion = false, orientacionBase = null, giroCamara = 0;
  let estuvoPantallaCompleta = false;
  let ultimoAviso = "", nombreRefugio = "", pidiendoCamino = false, turnoCamino = 0, radioVisible = null;
  let ocaso = null;
  const escenarioActivo = [...sensores]; // se conserva al desactivar y volver a activar
  const filasSeguras = new Map();
  for (const [f, desde, hasta] of escenario.zonaSegura ?? []) { const fila = filasSeguras.get(f) ?? []; fila.push([desde, hasta]); filasSeguras.set(f, fila); }
  const voz = crearVoz({ idioma, alComando: ejecutar, alTexto: (s) => escribir("transcripcion", s), alError: mensaje });
  function mensaje(s) { if (!cerrado) escribir("mensaje", s); }
  const campos = {
    barometro: ["base_lat", "base_lon", "p", "pBase", "T"], radio: ["base_lat", "base_lon", "distancia_m", "sigma_m"], uwb: ["base_lat", "base_lon", "distancia_m", "sigma_m"],
    pasos: ["base_lat", "base_lon", "cantidad_pasos", "rumbo", "sigma_distancia_m", "sigma_rumbo_grados"],
    odometria: ["base_lat", "base_lon", "distancia_m", "rumbo", "sigma_distancia_m", "sigma_rumbo_grados"],
    reseccion: ["punto_lat", "punto_lon", "rumbo", "sigma_grados"], sol: ["instante_utc", "elevacion", "azimut", "sigma_grados"],
    doppler: ["posicion_lat", "posicion_lon", "sigma_m"], estrellas: ["posicion_lat", "posicion_lon", "sigma_m"],
  };
  const etiquetas = { base_f: "Fila de referencia", base_c: "Columna de referencia", punto_f: "Fila del cerro", punto_c: "Columna del cerro", posicion_f: "Fila de posición", posicion_c: "Columna de posición",
    base_lat: "Latitud de referencia (°)", base_lon: "Longitud este de referencia (°)", punto_lat: "Latitud del cerro (°)", punto_lon: "Longitud este del cerro (°)",
    posicion_lat: "Latitud de posición (°)", posicion_lon: "Longitud este de posición (°)", cantidad_pasos: "Cantidad de pasos (largo modelado, a calibrar)",
    instante_utc: "Fecha y hora UTC",
    p: "Presión exterior (Pa)", pBase: "Presión exterior simultánea en referencia (Pa)", T: "Temperatura de columna de aire (K)",
    distancia_m: "Distancia (m)", sigma_m: "Error (m, 1 sigma)", rumbo: "Rumbo (° desde norte, IMU + Sol)", sigma_distancia_m: "Error de distancia (m)",
    sigma_rumbo_grados: "Error de rumbo (°)", sigma_grados: "Error angular (°)", ms: "Instante UTC (milisegundos)", elevacion: "Elevación solar (°)", azimut: "Azimut solar (°)" };
  function armarMedidas() {
    const tipo = $("[name=tipo]").value, caja = $("[data-campos]"); caja.replaceChildren();
    const p = motor.estado.posicion, base = plan.marcas?.[0]?.celda ?? puntoCelda(zona, motor.ruta.celdas[0]);
    const geoBase = celdaALonLat(zona.meta, base.f, base.c), geoPosicion = celdaALonLat(zona.meta, p.f, p.c);
    const valores = { base_lat: geoBase.lat, base_lon: geoBase.lon, punto_lat: geoBase.lat, punto_lon: geoBase.lon, posicion_lat: geoPosicion.lat, posicion_lon: geoPosicion.lon,
      p: cfgGeo.presion_inicial_pa.valor, pBase: cfgGeo.presion_inicial_pa.valor, T: cfgGeo.temperatura_inicial_k.valor,
      sigma_m: (tipo === "uwb" ? cfgGeo.sigma_uwb_m : tipo === "estrellas" ? cfgGeo.sigma_estrellas_m : tipo === "doppler" ? cfgGeo.sigma_doppler_m : cfgGeo.sigma_radio_m).valor,
      sigma_distancia_m: zona.paso, sigma_rumbo_grados: cfgBarometro.sigma_rumbo_grados.valor,
      sigma_grados: (tipo === "sol" ? cfgGeo.sigma_sol_grados : cfgGeo.sigma_reseccion_grados).valor,
      instante_utc: new Date(motor.estado.ms).toISOString().slice(0, 19), elevacion: motor.estado.sol.elevacion, azimut: motor.estado.sol.azimut };
    for (const clave of campos[tipo]) {
      const label = document.createElement("label"), input = document.createElement("input"); label.textContent = t(etiquetas[clave]);
      input.name = clave; input.type = clave === "instante_utc" ? "datetime-local" : "number"; input.step = "any"; input.required = true;
      if (valores[clave] !== undefined) input.value = valores[clave]; label.append(input); caja.append(label);
    }
  }
  armarMedidas(); $("[name=tipo]").addEventListener("change", armarMedidas);
  $(".nav-medidas").addEventListener("submit", (e) => {
    e.preventDefault(); const f = new FormData(e.currentTarget), tipo = f.get("tipo"), m = { id: `manual-${++secuencia}`, tipo };
    for (const clave of campos[tipo]) { const v = clave === "instante_utc" ? Date.parse(`${f.get(clave)}Z`) : Number(f.get(clave)); if (!Number.isFinite(v)) return mensaje(t("Revisá las medidas."));
      if (clave === "instante_utc") { m.ms = v; continue; }
      const partes = clave.split("_");
      if (["base", "punto", "posicion"].includes(partes[0]) && partes.length === 2) { m[partes[0]] ??= {}; m[partes[0]][partes[1]] = v; }
      else m[clave] = v;
    }
    if (tipo === "pasos") { m.distancia_m = m.cantidad_pasos * cfgExpedicion.a_pie.largo_paso_m.valor; delete m.cantidad_pasos; }
    localizar({ tipo: "geoubicar", usarHorizonte: false, medidas: [m], cfg: cfgGeo, cfgBarometro });
  });

  function asegurarWorker() {
    if (worker) return worker;
    worker = new Worker(new URL("./localizador-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data: d }) => {
      if (cerrado || !trabajo || d.pedido !== trabajo.id && !(d.tipo === "error" && d.pedido === undefined)) return;
      if (d.tipo === "localizando") { $("progress").hidden = false; $("progress").value = d.fraccion; }
      if (d.tipo === "error") { terminarTrabajo(); mensaje(t("No se pudo localizar. Revisá los datos o volvé a intentar.")); }
      if (d.tipo === "ubicacion" || d.tipo === "geoubicacion") {
        try {
          let p, error;
          if (d.tipo === "ubicacion") {
            const [a, , x0, , e, y0] = zona.meta.grilla.transform;
            p = { f: (d.y - y0) / e - 0.5, c: (d.x - x0) / a - 0.5 }; error = d.incertidumbre;
          } else { p = d.resultado.mejor; error = d.resultado.error_m; }
          motor.corregir({ id: `correccion-${d.pedido}`, tipo: d.tipo === "ubicacion" ? "horizonte" : "fusion", ...p,
            error_95_m: error, fuente: trabajo.fuente });
          mensaje(t("Corrección recibida. El radio 95 % es modelado y requiere calibración."));
        } catch { mensaje(t("La corrección no es válida para esta zona.")); }
        terminarTrabajo(); dibujarHud();
      }
    };
    worker.onerror = () => { terminarTrabajo(); worker?.terminate(); worker = null; mensaje(t("Falló el Worker de localización. Podés volver a intentar.")); };
    worker.postMessage({ tipo: "cargar", base: baseZona }); return worker;
  }
  function terminarTrabajo() {
    clearTimeout(trabajo?.reloj);
    if (trabajo) pausa = trabajo.pausa;
    trabajo = null; $("progress").hidden = true;
  }
  $("[data-cancelar]").addEventListener("click", () => { terminarTrabajo(); worker?.terminate(); worker = null; secuencia++; mensaje(t("Corrección cancelada.")); });
  function localizar(datos) {
    if (trabajo || cerrado) return mensaje(t("Esperá la corrección en curso."));
    try {
      const w = asegurarWorker(); trabajo = { id: ++secuencia, pausa, fuente: datos.tipo === "geoubicar" ? "medida_manual" : "foto_real" };
      trabajo.reloj = setTimeout(() => { terminarTrabajo(); worker?.terminate(); worker = null; mensaje(t("Falló el Worker de localización. Podés volver a intentar.")); }, parametro(cfg, "espera_localizador_s") * 1000);
      pausa = true; mensaje(t("Localizando en el Worker; caminata en pausa."));
      w.postMessage({ ...datos, pedido: trabajo.id });
    } catch { terminarTrabajo(); mensaje(t("No se pudo iniciar el Worker.")); }
  }
  async function fotosParaWorker(archivos) {
    const salida = [];
    for (const a of archivos) {
      const foto = metadatos.find((m) => (m.imageid ?? m.id) === a.name.replace(/\.[^.]+$/, ""));
      if (!foto?.camera_model_component_list || !foto.attitude) throw new Error("metadata");
      const imagen = await createImageBitmap(a), c = document.createElement("canvas"); c.width = imagen.width; c.height = imagen.height;
      const g = c.getContext("2d"); g.drawImage(imagen, 0, 0); imagen.close();
      const rgba = g.getImageData(0, 0, c.width, c.height).data, gris = new Float32Array(c.width * c.height);
      // Igual que la conversión de geoubicacion.js y PIL (ITU-R 601).
      for (let i = 0; i < gris.length; i++) gris[i] = Math.floor((rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000 + 0.5);
      salida.push({ foto, gris, ancho: c.width, alto: c.height });
    }
    return salida;
  }
  async function foto() {
    try {
      if (trabajo) return mensaje(t("Esperá la corrección en curso."));
      indiceOptico ??= await leerHttp(`${baseZona}/localizacion/indice.json`, "json");
      if (cerrado) return;
      const comun = { raizDatos: url("datos"), relieveLejano: indiceOptico.relieve_lejano, sesgo: indiceOptico.sesgo_vertical_m, alturaCamara: indiceOptico.altura_camara_m };
      if (fotosSubidas.length) {
        const fotos = await fotosParaWorker(fotosSubidas); if (cerrado) return;
        localizar({ tipo: "localizar_fotos", fotos, ...comun });
      } else if (fotoActual) localizar({ tipo: "localizar", medidoUrl: `${baseZona}/localizacion/${escenario.parada.id}/medido.json`, parada: escenario.parada.id, ...comun });
      else mensaje(t("No hay foto en esta posición. Cargá fotos con metadatos o acercate a la parada del escenario."));
    } catch { mensaje(t("No se pudo leer la foto o sus metadatos. Necesitás CAHVOR y attitude.")); }
  }
  $("[data-archivos]").addEventListener("change", (e) => { fotosSubidas = Array.from(e.target.files); mensaje(t("Fotos cargadas. Agregá sus metadatos y tocá Foto.")); });
  $("[data-meta]").addEventListener("change", async (e) => {
    try { const m = JSON.parse(await e.target.files[0].text()); metadatos = Array.isArray(m) ? m : m.items ?? [m]; mensaje(t("Metadatos cargados.")); }
    catch { mensaje(t("No se pudo leer la foto o sus metadatos. Necesitás CAHVOR y attitude.")); }
  });

  async function pedirCamino() {
    if (pidiendoCamino || !motor.estado.pedirCamino) return;
    const e = motor.estado, turno = ++turnoCamino; pidiendoCamino = true;
    try {
      const pedido = { desde: puntoCelda(zona, e.celda), ...e.pedirCamino };
      const precargados = escenario.caminos?.[e.celda], segura = precargados?.[`${pedido.campo}Seguro`];
      const precargado = segura?.tiempos[0] <= pedido.limite_s ? segura : precargados?.[pedido.campo];
      const camino = opciones.pedirCamino ? await opciones.pedirCamino(pedido)
        : enlace ? await enlace.pedirCamino(pedido) : precargado ?? null;
      if (cerrado || turno !== turnoCamino) return;
      const fin = camino?.celdas?.at(-1);
      nombreRefugio = camino?.nombreRefugio ?? (plan.marcas ?? []).find((m) => {
        const p = m.celda ?? lonLatACelda(zona.meta, m.lon, m.lat); return Math.round(p.f) * zona.ancho + Math.round(p.c) === fin;
      })?.nombre ?? "";
      motor.recibirCamino(camino); if (!camino) mensaje(t("No hay camino de regreso disponible dentro de los límites."));
      if (camino) { motor.registrar("criterio_regreso", { criterio: camino.criterio, refugio: nombreRefugio });
        mensaje(`${t("Regreso al refugio")} ${nombreRefugio}: ${t(camino.criterio === "segura" ? "Camino más seguro" : "Camino más rápido dentro del plazo")}`); }
    } catch { if (!cerrado && turno === turnoCamino) motor.recibirCamino(null); }
    finally { if (turno === turnoCamino) { pidiendoCamino = false; if (!cerrado) dibujarHud(); } }
  }
  function falla(tipo) { turnoCamino++; pidiendoCamino = false; motor.inyectar(tipo); pedirCamino(); dibujarHud(); }
  function ejecutar(comando, transcripcion = "") {
    if (cerrado) return;
    motor.registrar("comando", { comando, transcripcion });
    const e = motor.estado;
    if (comando === "terminar") { cerrar(); return; }
    if (comando === "pausa") pausa = true;
    if (comando === "seguir" && !trabajo) pausa = false;
    if (comando === "rapido") velocidad = cfg.velocidades.valor[(cfg.velocidades.valor.indexOf(velocidad) + 1) % cfg.velocidades.valor.length];
    if (comando === "regreso") falla("volver");
    if (comando === "aborto") { turnoCamino++; pidiendoCamino = false; motor.abortar(); pedirCamino(); }
    if (comando === "foto") foto();
    if (comando === "peligro") {
      motor.registrar("peligro", { origen: "marca_manual" }); opciones.alPeligro?.({ ...e.posicion }); mensaje(t("Peligro anotado en la bitácora."));
    }
    const respuestas = {
      estado: `${t(e.veredicto)} · ${tiempo(e.t)} · ${t("Regreso")}: ${tiempo(e.regreso_s)}`,
      oxigeno: `${t("Oxígeno primario")}: ${tiempo(e.o2.primario_s / e.tasa)}. ${t("Oxígeno secundario")}: ${tiempo(e.o2.secundario_s / e.tasa)}`,
      posicion: `${n(e.geo.lat, 5)}, ${n(e.geo.lon, 5)} · ${t("Error 95 % modelado")}: ${n(e.posicion.error_95_m, 1)} m`,
      hito: `${t("Próximo punto")}: ${n(e.hito.distancia_m)} m · ${n(e.rumboObjetivo)}°`,
      ayuda: COMANDOS.map((c) => t(textosComandos[c])).join(" · "),
    };
    if (respuestas[comando]) { mensaje(respuestas[comando]); voz.hablar(respuestas[comando]); }
    dibujarHud();
  }
  raiz.querySelectorAll("[data-c]").forEach((b) => b.addEventListener("click", () => ejecutar(b.dataset.c)));
  raiz.querySelectorAll("[data-falla]").forEach((b) => b.addEventListener("click", () => falla(b.dataset.falla)));
  raiz.querySelectorAll("[data-vel]").forEach((b) => b.addEventListener("click", () => { velocidad = +b.dataset.vel; dibujarHud(); }));
  $("[data-micro]").addEventListener("pointerdown", () => voz.escuchar());
  $("[data-micro]").addEventListener("pointerup", () => voz.detenerEscucha());
  $("[data-micro]").addEventListener("pointercancel", () => voz.detenerEscucha());
  $("[data-micro]").addEventListener("click", (e) => { if (e.detail === 0) voz.escuchar(); });
  $("[data-saltar]").addEventListener("click", () => { if (!trabajo) { motor.avanzar(motor.estado.hito.tiempo_s); pedirCamino(); dibujarHud(); } });
  $("[data-sensores]").addEventListener("change", (e) => { sensores.splice(0, sensores.length, ...(e.target.checked ? escenarioActivo : [])); motor.registrar("sensores", { habilitados: e.target.checked }); });
  // Solo cambia la vista. No se usa GPS terrestre ni rumbo magnético para ubicar en Marte.
  function orientar(e) {
    if (!Number.isFinite(e.alpha)) return; orientacionBase ??= e.alpha; giroCamara = angular(e.alpha - orientacionBase); vista.mirar(giroCamara);
  }
  $("[data-orientacion]").addEventListener("click", async () => {
    try {
      if (typeof DeviceOrientationEvent === "undefined") return mensaje(t("Orientación no disponible."));
      if (typeof DeviceOrientationEvent.requestPermission === "function" && await DeviceOrientationEvent.requestPermission() !== "granted") return mensaje(t("Orientación no disponible."));
      permisoOrientacion = true; window.addEventListener("deviceorientation", orientar); mensaje(t("Orientación del teléfono solo para mirar"));
    } catch { mensaje(t("Orientación no disponible.")); }
  });
  function teclado(e) {
    if (e.key === "Escape") { e.preventDefault(); cerrar(); return; }
    if (e.key === "Tab") {
      const nodos = [...raiz.querySelectorAll("button,input,select,summary")].filter((n) => !n.disabled && n.getClientRects().length);
      if (e.shiftKey && document.activeElement === nodos[0]) { nodos.at(-1)?.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === nodos.at(-1)) { nodos[0]?.focus(); e.preventDefault(); }
      return;
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.repeat) return;
    const c = { " ": pausa ? "seguir" : "pausa", s: "estado", o: "oxigeno", p: "posicion", n: "hito", r: "regreso", a: "aborto", f: "foto", h: "ayuda", m: "peligro", "+": "rapido" }[e.key.toLowerCase()];
    if (e.key.toLowerCase() === "v") { e.preventDefault(); voz.escuchar(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") { giroCamara += e.key === "ArrowLeft" ? -5 : 5; vista.mirar(giroCamara); e.preventDefault(); }
    else if (c) { e.preventDefault(); ejecutar(c); }
  }
  raiz.addEventListener("keydown", teclado);
  raiz.addEventListener("keyup", (e) => { if (e.key.toLowerCase() === "v") voz.detenerEscucha(); });
  function pantallaCompleta() {
    if (document.fullscreenElement === raiz) estuvoPantallaCompleta = true;
    else if (estuvoPantallaCompleta) cerrar();
  }
  document.addEventListener?.("fullscreenchange", pantallaCompleta);
  const urlsDescarga = new Set();
  raiz.querySelectorAll("[data-exportar]").forEach((b) => b.addEventListener("click", () => {
    const formato = b.dataset.exportar, blob = new Blob([JSON.stringify(motor.exportar(formato), null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob), a = document.createElement("a"); urlsDescarga.add(href); a.href = href; a.download = `red-frontier-navegacion.${formato}`; a.click();
  }));

  let fotosEscenario = [], mostrandoFoto = "";
  function actualizarFoto(e) {
    const parada = escenario.parada;
    const cerca = parada && Math.hypot(e.verdad.f - parada.celda.f, e.verdad.c - parada.celda.c) * zona.paso <= parametro(cfg, "radio_foto_m");
    fotoActual = cerca ? fotosEscenario.reduce((mejor, f) => !mejor || Math.abs(angular(f.azimut - e.rumbo)) < Math.abs(angular(mejor.azimut - e.rumbo)) ? f : mejor, null) : null;
    const clave = fotoActual?.archivo ?? "";
    if (clave !== mostrandoFoto) {
      mostrandoFoto = clave; $(".nav-foto").hidden = !fotoActual;
      if (fotoActual) $(".nav-foto").src = `${baseZona}/localizacion/${parada.id}/${fotoActual.archivo}`;
    }
    escribir("credito", fotoActual ? `${t("Foto real NASA/JPL-Caltech, Curiosity Navcam, sol")} ${fotoActual.sol}` : t("No hay foto real en esta posición."));
  }
  function minimapa(e) {
    const c = $(".nav-minimapa"), g = c.getContext("2d"), r = motor.ruta;
    const puntos = r.celdas.map((i) => puntoCelda(zona, i)); puntos.push(e.posicion);
    const margen = Math.max(parametro(cfg, "corredor_m"), e.posicion.error_95_m) / zona.paso;
    let fMin = Infinity, fMax = -Infinity, cMin = Infinity, cMax = -Infinity;
    for (const p of puntos) { fMin = Math.min(fMin, p.f); fMax = Math.max(fMax, p.f); cMin = Math.min(cMin, p.c); cMax = Math.max(cMax, p.c); }
    const f0 = fMin - margen, c0 = cMin - margen;
    const escala = Math.min(c.width / (cMax - c0 + margen), c.height / (fMax - f0 + margen));
    const xy = (p) => [(p.c - c0) * escala, (p.f - f0) * escala];
    g.fillStyle = "#081817"; g.fillRect(0, 0, c.width, c.height);
    if (opciones.region || escenario.zonaSegura) {
      g.fillStyle = "#285c3a";
      for (let y = 0; y < c.height; y += 4) for (let x = 0; x < c.width; x += 4) {
        const f = Math.round(f0 + y / escala), col = Math.round(c0 + x / escala);
        const segura = opciones.region ? opciones.region[f * zona.ancho + col] : filasSeguras.get(f)?.some(([desde, hasta]) => col >= desde && col <= hasta);
        if (f >= 0 && col >= 0 && f < zona.alto && col < zona.ancho && segura) g.fillRect(x, y, 4, 4);
      }
    }
    g.strokeStyle = "#c1ffe7"; g.lineWidth = 2; g.beginPath();
    r.celdas.forEach((i, k) => { const p = xy(puntoCelda(zona, i)); if (!k) g.moveTo(...p); else g.lineTo(...p); }); g.stroke();
    for (const m of plan.marcas ?? []) {
      const p = m.celda ?? lonLatACelda(zona.meta, m.lon, m.lat), [x, y] = xy(p);
      g.fillStyle = "#ffce73"; g.fillRect(x - 3, y - 3, 6, 6); g.fillText(m.nombre ?? m.id, x + 5, y);
    }
    const [x, y] = xy(e.posicion); g.strokeStyle = "#ffd97e"; g.beginPath(); g.arc(x, y, e.posicion.error_95_m / zona.paso * escala, 0, 2 * Math.PI); g.stroke();
    g.fillStyle = "#fff"; g.beginPath(); g.arc(x, y, 3, 0, 2 * Math.PI); g.fill();
  }
  function dibujarHud() {
    if (cerrado) return;
    const e = motor.estado, p = e.posicion, i = Math.round(p.f) * zona.ancho + Math.round(p.c);
    raiz.dataset.nivel = e.avisos.some((a) => a.nivel === 3) ? "rojo" : e.avisos.length ? "ambar" : e.nivel;
    escribir("decision", `${t(e.veredicto)} · ${pausa ? t("En pausa") : `×${velocidad}`} · ${t("Modelado")}`);
    const direccion = Math.abs(e.giro) < 1 ? t("Seguí de frente") : `${t("Desviate")} ${n(Math.abs(e.giro))}° ${t(e.giro < 0 ? "a la izquierda" : "a la derecha")}`;
    escribir("guia", `${e.giro < 0 ? "↖" : "↗"} ${direccion} · ${n(e.rumboObjetivo)}° · ${n(e.hito.distancia_m)} m · ${tiempo(e.hito.tiempo_s)}`);
    escribir("posicion", `${n(e.geo.lat, 5)}°, ${n(((e.geo.lon % 360) + 360) % 360, 5)}° E · ${t("Error 95 % modelado")}: ${n(p.error_95_m, 1)} m · ${t(p.fuente)}${p.estima ? ` + ${t("estima")}` : ""}`);
    const filas = [["Tiempo afuera", tiempo(e.t)], ["Destino", `${n(e.destino_m)} m · ${tiempo(e.destino_s)}`],
      ["Regreso al refugio", `${nombreRefugio} ${tiempo(e.regreso_s)} + ${tiempo(riesgo.pie.ingreso_refugio_min.valor * 60)} ${t("de ingreso")}`],
      ["Margen de regreso", tiempo(e.margen_s)], ["Rumbo IMU + Sol (simulado)", `${n(e.rumbo)}° · ${t("Sol modelado")}: ${n(e.sol.azimut)}° / ${n(e.sol.elevacion)}°`],
      ["Pendiente adelante (DTM real)", `${n(zona.crudo ? zona.crudo.pendQ[i] * zona.meta.capas.pendiente.escala : zona.pendiente?.[i], 1)}°`],
      ["Radio (modelado)", e.radio === null ? t("Sin dato") : t(e.radio ? "Con enlace geométrico" : "Sin enlace geométrico")],
      ["Luz hasta el ocaso (modelado)", ocaso === null ? t("Sin dato") : tiempo(Math.max(0, (ocaso - e.ms) / 1000))],
      ["Traje (simulado)", `${n(e.sensores.temperatura_traje_c)} °C · ${n(e.sensores.presion_traje_pa)} Pa`],
      ["Pulso / metabolismo (simulado / modelado)", `${n(e.sensores.pulso_lpm)} bpm · ${n(e.metabolismo_w)} W`]];
    const dl = $("[data-v=datos]"); dl.replaceChildren();
    for (const [clave, valor] of filas) { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = t(clave); dd.textContent = valor; dl.append(dt, dd); }
    const recursos = $("[data-v=recursos]"); recursos.replaceChildren();
    const cfgMotor = { primario: riesgo.pie.consumibles_primarios_h.valor * 3600, secundario: riesgo.pie.regreso_emergencia_max_min.valor * 60 };
    const rs = [{ nombre: "Oxígeno primario", valor: e.o2.primario_s, capacidad: cfgMotor.primario },
      { nombre: "Oxígeno secundario", valor: e.o2.secundario_s, capacidad: cfgMotor.secundario },
      ...e.recursos.map((r) => ({ nombre: { co2: "CO₂ por absorber", agua: "Agua de enfriamiento", bateria: "Batería" }[r.id], valor: r.restante, capacidad: r.capacidad }))];
    for (const r of rs) { const label = document.createElement("label"), barra = document.createElement("meter"); barra.min = 0; barra.max = r.capacidad; barra.value = r.valor;
      label.textContent = `${t(r.nombre)} · ${n(r.valor / r.capacidad * 100)} % · ${t("Modelado")}`; label.append(barra); recursos.append(label); }
    const firma = e.avisos.map((a) => a.codigo).join(",");
    if (firma !== ultimoAviso) {
      ultimoAviso = firma; const caja = $(".nav-avisos"); caja.replaceChildren();
      for (const a of e.avisos) { const p = document.createElement("p"); p.textContent = t(avisosES[a.codigo]); caja.append(p); }
      if (e.avisos.length) voz.hablar(t(avisosES[e.avisos[0].codigo]));
    }
    if (radioVisible) motor.fijarRadio(!!radioVisible[i]);
    else if (escenario.radio) motor.fijarRadio(escenario.radio[i] === undefined ? null : !!escenario.radio[i]);
    actualizarFoto(e); minimapa(e);
    escribir("registro", `${t("Eventos registrados")}: ${motor.cantidadEventos}`);
    escribir("fps", `${n(vista.estadisticas.fps, 1)} fps · ${n(vista.estadisticas.total_ms / vista.estadisticas.cuadros, 1)} ms ${t("por cuadro de render")} · ${t("Resolución interna")}: ${vista.estadisticas.ancho}×${vista.estadisticas.alto}`);
  }
  function cuadro(ahora) {
    if (cerrado) return;
    if (opciones.vigente && !opciones.vigente()) { cerrar(); return; }
    const dt = Math.min(1, Math.max(0, (ahora - ultimo) / 1000)); ultimo = ahora;
    try {
      if (!pausa && !trabajo && !pidiendoCamino) motor.avanzar(dt * velocidad);
      pedirCamino();
      vista.dibujar(motor.estado, ahora);
      if (ahora - hudUltimo >= 1000 / parametro(cfg.render, "hud_hz")) { dibujarHud(); hudUltimo = ahora; }
      raf = requestAnimationFrame(cuadro);
    } catch { pausa = true; mensaje(t("La navegación se detuvo por datos inválidos. Exportá la bitácora.")); }
  }
  function cerrar() {
    if (cerrado) return; cerrado = true; turnoCamino++; motor.registrar("fin_navegacion", {});
    cancelAnimationFrame(raf); clearTimeout(trabajo?.reloj); worker?.terminate(); enlace?.cerrar(); voz.cerrar(); raiz.removeEventListener("keydown", teclado);
    if (permisoOrientacion) window.removeEventListener("deviceorientation", orientar);
    document.removeEventListener?.("fullscreenchange", pantallaCompleta);
    if (document.fullscreenElement === raiz) document.exitFullscreen().catch(() => {});
    document.body.style.overflow = scrollAnterior; raiz.remove(); focoAnterior?.focus();
    for (const href of urlsDescarga) URL.revokeObjectURL(href);
    if (sesion?.motor === motor) sesion = null;
  }
  const controlador = { motor, cerrar, ejecutar, corregir: (m) => motor.corregir(m),
    get rendimiento() { return { ...vista.estadisticas }; }, exportar: (f) => motor.exportar(f), elemento: raiz };
  sesion = controlador;
  // Pedir fullscreen puede ser rechazado tras cargas async; el panel fixed siempre cubre la app.
  raiz.requestFullscreen?.().catch(() => {});
  dibujarHud(); raf = requestAnimationFrame(cuadro);
  mensaje(t("V para hablar; Espacio pausa; S estado; O oxígeno; P posición; N hito; R regreso; A aborto; F foto; M peligro; H ayuda; + velocidad; flechas para mirar; Esc termina."));
  if (!voz.disponible || navigator.onLine === false) mensaje(t("Reconocimiento de voz no disponible sin soporte o conexión. Usá los botones y el teclado. La voz sintetizada requiere una voz local instalada."));
  const p0 = motor.estado;
  const puesta = amanecerAtardecer(p0.ms, p0.geo.lon, p0.geo.lat);
  if (puesta.atardecer !== null) ocaso = p0.ms + (puesta.atardecer - p0.sol.lmst) * 1.0274912517 * 86400000 / 24;
  if (escenario.parada) leerHttp(`${baseZona}/localizacion/${escenario.parada.id}/fotos.json`, "json").then((f) => { if (!cerrado) fotosEscenario = f; }).catch(() => mensaje(t("No se pudieron cargar las fotos del escenario.")));
  if (zona.meta.capas?.orto) leerTextura(`${baseZona}/${zona.meta.capas.orto.archivo}`, cfg.render.ancho.valor).then((x) => { if (!cerrado) { textura = x; reconstruirVista(); } }).catch(() => mensaje(t("Ortoimagen no disponible: colores ilustrativos del relieve.")));
  if (zona.meta.id === "gale_boxwork") cargarZona(url("datos/region_20_gale_crater"), leerHttp).then((x) => { if (!cerrado) { contexto = x; reconstruirVista(); } }).catch(() => mensaje(t("Contexto lejano no disponible: horizonte limitado al DTM local.")));
  // La cobertura pesada puede llegar del Worker de rutas mediante la app; no se calcula en el hilo del HUD.
  if (opciones.radioVisible) radioVisible = opciones.radioVisible;
  else if (enlace) json("config/radio.json").then((c) => enlace.pedirRadio(c)).then((v) => { if (!cerrado) radioVisible = v; }).catch(() => {});
  if (escenario.radiacion) {
    const r = escenario.radiacion;
    escribir("radiacion", `${t("DONKI archivado")}: ${r.desde} / ${r.hasta}. ${t("Descargado")}: ${r.descargado}. ${t("Llegadas a Marte modeladas")}: ${n(r.llegadas?.length ?? 0)}. ${t("Sin dosímetro; sin tasa de dosis medida.")}`);
    if (r.llegadas?.length) escribir("radiacion", `${$("[data-v=radiacion]").textContent} ${t("Última llegada prevista (archivo)")}: ${new Date(r.llegadas[0].llegada).toLocaleString(en ? "en-US" : "es-UY", { timeZone: "UTC" })} UTC.`);
  } else escribir("radiacion", t("Sin parte cargado."));
  function reconstruirVista() { vista = crearVistaMarte({ canvas: $(".nav-vista"), zona, contexto, textura, cfg: cfg.render, movimientoReducido: matchMedia("(prefers-reduced-motion: reduce)").matches }); vista.mirar(giroCamara); }
  return controlador;
}
