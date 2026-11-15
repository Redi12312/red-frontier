// Fusión modelada, pura y sin DOM. Celdas en la proyección de zona.js.
// Errores 1 sigma, independientes. El horizonte es una previa circular local,
// aproximada a partir de su radio 95 %; no modela otros máximos lejanos.
import { desnivel } from "./barometro.js";
import { posicionSol } from "./luz.js";
import { celdaALonLat, lonLatACelda } from "./zona.js";
import { distancia, rumbo } from "./herramientas.js";

const MASA = 0.95;
const RADIO_95 = Math.sqrt(-2 * Math.log(1 - MASA));
const angular = (a) => ((a + 180) % 360 + 360) % 360 - 180;

function numero(v, nombre, minimo = -Infinity) {
  if (!Number.isFinite(v) || v < minimo) throw new RangeError(`Revisá ${nombre}.`);
  return v;
}

function positivo(v, nombre) { return numero(v, nombre, Number.MIN_VALUE); }
function parametro(cfg, clave) { return positivo(cfg?.[clave]?.valor, clave); }

function punto(zona, p) {
  if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
    if (Math.abs(p.lat) > 90) throw new RangeError("Revisá la latitud.");
    const centro = celdaALonLat(zona.meta, zona.alto / 2, zona.ancho / 2).lon;
    // Escoger la rama de longitud de la grilla (acepta oeste negativo y este).
    return lonLatACelda(zona.meta, centro + angular(p.lon - centro), p.lat);
  }
  return { f: numero(p?.f, "fila del punto"), c: numero(p?.c, "columna del punto") };
}

function alturaPunto(zona, p) {
  const f = Math.round(p.f), c = Math.round(p.c);
  const i = f * zona.ancho + c;
  if (f < 0 || c < 0 || f >= zona.alto || c >= zona.ancho || !Number.isFinite(zona.elevacion[i]) || zona.valido && !zona.valido[i]) {
    throw new RangeError("Elegí una referencia barométrica con altura válida dentro de la zona.");
  }
  return zona.elevacion[i];
}

// Convierte una lectura en función de log-verosimilitud. q es el radio de
// cuantización del bloque, evita perder anillos finos en la búsqueda gruesa.
function modelo(zona, m, cfgBarometro) {
  const pena = (e, s) => -0.5 * (e / s) ** 2;
  const distanciaLocal = (p, f, c) => Math.hypot(f - p.f, c - p.c) * zona.paso;
  if (m.tipo === "barometro") {
    const base = punto(zona, m.base);
    const { dz, sigma } = desnivel({ ...m, cfg: cfgBarometro });
    const z = alturaPunto(zona, base) + dz;
    positivo(sigma, "error de presión");
    return (f, c, q, altura) => pena(altura - z, sigma);
  }
  if (["radio", "uwb"].includes(m.tipo)) {
    const base = punto(zona, m.base);
    const d = numero(m.distancia_m, "distancia de radio", 0), s = positivo(m.sigma_m, "error de radio");
    return (f, c, q) => pena(distanciaLocal(base, f, c) - d, Math.hypot(s, q));
  }
  if (["pasos", "odometria"].includes(m.tipo)) {
    const base = punto(zona, m.base);
    const d = numero(m.distancia_m, "distancia recorrida", 0);
    const a = numero(m.rumbo, "rumbo") * Math.PI / 180;
    const sd = positivo(m.sigma_distancia_m, "error de distancia");
    const sr = positivo(m.sigma_rumbo_grados, "error de rumbo");
    if (d === 0) return (f, c, q) => pena(distanciaLocal(base, f, c), Math.hypot(sd, q));
    // A incertidumbres grandes se vuelve una restricción radial suave. La
    // distribución angular envuelta conserva rumbos cerca de 0° y 360°.
    return (f, c, q) => {
      const este = (c - base.c) * zona.paso, norte = (base.f - f) * zona.paso;
      const error = angular(Math.atan2(este, norte) * 180 / Math.PI - a * 180 / Math.PI);
      const distancia = Math.hypot(este, norte);
      const angularSigma = Math.hypot(sr, Math.atan2(q, Math.max(q, distancia)) * 180 / Math.PI);
      return pena(distancia - d, Math.hypot(sd, q)) + pena(error, angularSigma);
    };
  }
  if (m.tipo === "reseccion") {
    const hito = punto(zona, m.punto), geoHito = celdaALonLat(zona.meta, hito.f, hito.c);
    const a = numero(m.rumbo, "rumbo al hito"), s = positivo(m.sigma_grados, "error del rumbo al hito");
    const d = m.distancia_m == null ? null : numero(m.distancia_m, "distancia láser", 0);
    if (d !== null) positivo(m.sigma_m, "error del telémetro");
    return (f, c, q) => {
      const geo = celdaALonLat(zona.meta, f, c);
      const metros = distancia(geo.lon, geo.lat, geoHito.lon, geoHito.lat);
      const sr = Math.hypot(s, Math.atan2(q, Math.max(q, metros)) * 180 / Math.PI);
      const log = pena(angular(rumbo(geo.lon, geo.lat, geoHito.lon, geoHito.lat) - a), sr);
      return log + (d === null ? 0 : pena(metros - d, Math.hypot(m.sigma_m, q)));
    };
  }
  if (m.tipo === "sol") {
    numero(m.ms, "fecha y hora UTC");
    numero(m.elevacion, "elevación solar", -90);
    if (m.elevacion > 90) throw new RangeError("Revisá la elevación solar.");
    numero(m.azimut, "azimut solar");
    const s = positivo(m.sigma_grados, "error solar");
    return (f, c) => {
      const p = celdaALonLat(zona.meta, f, c), sol = posicionSol(m.ms, p.lon, p.lat);
      // El azimut pierde información en el cenit. Separación angular de los
      // vectores solares, con componente azimutal proyectada horizontalmente.
      const horizontal = Math.cos(m.elevacion * Math.PI / 180);
      return pena(sol.elevacion - m.elevacion, s) + pena(angular(sol.azimut - m.azimut) * horizontal, s);
    };
  }
  if (["doppler", "estrellas"].includes(m.tipo)) {
    const p = punto(zona, m.posicion), s = positivo(m.sigma_m, "error de posición absoluta");
    return (f, c, q) => pena(distanciaLocal(p, f, c), Math.hypot(s, q));
  }
  throw new RangeError("Medida de geoubicación desconocida.");
}

function previaHorizonte(zona, h) {
  const p = punto(zona, h.mejor), error = positivo(h.error_m, "incertidumbre del horizonte");
  return (f, c, q) => -0.5 * (Math.hypot(f - p.f, c - p.c) * zona.paso / Math.hypot(error / RADIO_95, q)) ** 2;
}

// Cuadrantes adaptativos sin superposición. Se retienen las colas gruesas y se
// afina la masa principal hasta la celda nativa o el presupuesto configurado.
// La máscara válida se consulta en cada muestra; se informa la resolución real.
function distribuir(zona, modelos, cfg) {
  const maximo = parametro(cfg, "celdas_maximas"), inicial = parametro(cfg, "celdas_iniciales");
  const masaRef = parametro(cfg, "masa_refinamiento");
  if (!Number.isInteger(maximo) || !Number.isInteger(inicial) || inicial > maximo || masaRef > 1) throw new RangeError("Revisá el presupuesto de la grilla.");
  let evaluaciones = 0;
  function bloque(f0, c0, alto, ancho) {
    const f = f0 + (alto - 1) / 2, c = c0 + (ancho - 1) / 2;
    const i = Math.round(f) * zona.ancho + Math.round(c), z = zona.elevacion[i];
    const area = alto * ancho * zona.paso ** 2;
    const q = zona.paso * Math.hypot(alto, ancho) / Math.sqrt(12);
    const log = !Number.isFinite(z) || zona.valido && !zona.valido[i] ? -Infinity : modelos.reduce((s, m) => s + m(f, c, q, z), 0);
    evaluaciones++;
    return { f0, c0, alto, ancho, f, c, area, log, p: 0 };
  }
  function normalizar(bloques) {
    let mayor = -Infinity;
    for (const b of bloques) mayor = Math.max(mayor, b.log);
    if (!Number.isFinite(mayor)) throw new RangeError("Las medidas no tienen soporte válido sobre el terreno.");
    let suma = 0;
    for (const b of bloques) { b.p = Math.exp(b.log - mayor) * b.area; suma += b.p; }
    for (const b of bloques) b.p /= suma;
  }
  let paso = Math.max(1, Math.ceil(Math.sqrt(zona.ancho * zona.alto / inicial)), Math.ceil(Math.max(zona.ancho, zona.alto) / inicial));
  while (Math.ceil(zona.ancho / paso) * Math.ceil(zona.alto / paso) > inicial) paso++;
  let bloques = [];
  for (let f = 0; f < zona.alto; f += paso) for (let c = 0; c < zona.ancho; c += paso) {
    bloques.push(bloque(f, c, Math.min(paso, zona.alto - f), Math.min(paso, zona.ancho - c)));
  }
  normalizar(bloques);
  while (bloques.length < maximo) {
    const orden = [...bloques].sort((a, b) => b.p / b.area - a.p / a.area);
    const subdividir = new Set();
    let masa = 0, cantidad = bloques.length;
    for (const b of orden) {
      if (masa >= masaRef) break;
      masa += b.p;
      const hijos = (b.alto > 1 ? 2 : 1) * (b.ancho > 1 ? 2 : 1);
      if (hijos === 1 || cantidad + hijos - 1 > maximo) continue;
      subdividir.add(b); cantidad += hijos - 1;
    }
    if (!subdividir.size) break;
    const nuevos = [];
    for (const b of bloques) {
      if (!subdividir.has(b)) { nuevos.push(b); continue; }
      const h = Math.ceil(b.alto / 2), w = Math.ceil(b.ancho / 2);
      for (let df = 0; df < b.alto; df += h) for (let dc = 0; dc < b.ancho; dc += w) {
        nuevos.push(bloque(b.f0 + df, b.c0 + dc, Math.min(h, b.alto - df), Math.min(w, b.ancho - dc)));
      }
    }
    bloques = nuevos; normalizar(bloques);
  }
  const orden = bloques.filter((b) => b.p > 0).sort((a, b) => b.p / b.area - a.p / a.area);
  const mejor = { f: orden[0].f, c: orden[0].c };
  let masa = 0, area = 0, radio = 0, resolucion = 0;
  const region = [];
  for (const b of orden) {
    if (masa >= MASA) break;
    masa += b.p; area += b.area;
    radio = Math.max(radio, zona.paso * (Math.hypot(b.f - mejor.f, b.c - mejor.c) + Math.hypot(b.alto, b.ancho) / 2));
    resolucion = Math.max(resolucion, zona.paso * Math.max(b.alto, b.ancho));
    region.push([b.f0, b.c0, b.alto, b.ancho]);
  }
  return { mejor, area_m2: area, error_m: radio, region, resolucion_m: resolucion, evaluaciones, bloques: bloques.length };
}

// API: horizonte opcional {mejor:{f,c}, error_m}; medidas con id único y tipo.
// Resultado de cada medida sola y combinado, región HPD 95 % como bloques
// [fila, columna, alto, ancho]. error_m circunscribe esa región desde el MAP.
// aporte_m2 compara cada actualización con la anterior y puede ser negativo
// si las medidas discrepan. No se fuerza una mejora ficticia.
export function fusionar(zona, { horizonte = null, medidas = [], cfg, cfgBarometro } = {}) {
  if (!Number.isInteger(zona?.ancho) || !Number.isInteger(zona?.alto) || zona.ancho < 1 || zona.alto < 1
    || zona.elevacion?.length !== zona.ancho * zona.alto || zona.valido && zona.valido.length !== zona.elevacion.length) throw new RangeError("Revisá la grilla de geoubicación.");
  positivo(zona.paso, "paso de grilla");
  if (!Array.isArray(medidas) || new Set(medidas.map((m) => m.id)).size !== medidas.length) throw new RangeError("Cada medida necesita un identificador único.");
  const modelos = [], individuales = [], aportes = [];
  let combinado = null;
  if (horizonte) {
    modelos.push(previaHorizonte(zona, horizonte));
    combinado = { ...distribuir(zona, modelos, cfg), mejor: punto(zona, horizonte.mejor), error_m: horizonte.error_m };
    individuales.push({ id: "horizonte", tipo: "horizonte", ...combinado });
  }
  for (const m of medidas) {
    if (!m.id || m.id === "horizonte") throw new RangeError("Revisá el identificador de la medida.");
    const funcion = modelo(zona, m, cfgBarometro);
    const individual = distribuir(zona, [funcion], cfg);
    individuales.push({ id: m.id, tipo: m.tipo, ...individual });
    modelos.push(funcion);
    const siguiente = modelos.length === 1 ? individual : distribuir(zona, modelos, cfg);
    aportes.push({ id: m.id, antes_m2: combinado?.area_m2 ?? zona.ancho * zona.alto * zona.paso ** 2, despues_m2: siguiente.area_m2,
      reduccion_m2: (combinado?.area_m2 ?? zona.ancho * zona.alto * zona.paso ** 2) - siguiente.area_m2 });
    combinado = siguiente;
  }
  if (!combinado) throw new RangeError("Sumá una medida o calculá el horizonte.");
  return { ...combinado, individuales, aportes, modelo: "gaussianas_independientes", horizonte_local: Boolean(horizonte) };
}
