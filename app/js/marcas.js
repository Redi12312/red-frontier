// Marcas e itinerarios de planificación; sin DOM, reloj, azar ni estado global mutable.
import configuracion from "../../config/marcas.json" with { type: "json" };

const esObjeto = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const texto = (v) => typeof v === "string" && v.trim().length > 0;

// Las operaciones de escritura modifican solo el plan recibido; las lecturas devuelven copias.
// datos es información del usuario: no se completa con reservas ni capacidades supuestas.
export function crearPlan() {
  return { version: 1, marcas: [], itinerarios: [] };
}

function comprobarPlan(plan) {
  if (!esObjeto(plan) || plan.version !== 1 || !Array.isArray(plan.marcas) || !Array.isArray(plan.itinerarios)) {
    throw new Error("El plan debe tener versión 1, marcas e itinerarios.");
  }
}

function comprobarTipo(tipo) {
  if (!Object.hasOwn(configuracion.tipos, tipo)) throw new Error(`Tipo de marca desconocido: ${String(tipo)}.`);
}

function coordenadas(lon, lat) {
  if (!Number.isFinite(lon) || lon < -180 || lon > 360) {
    throw new Error("La longitud debe ser un número entre −180 y 360 grados este.");
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error("La latitud debe ser un número entre −90 y 90 grados.");
  }
  return { lon: lon < 0 ? lon + 360 : lon === 360 || Object.is(lon, -0) ? 0 : lon, lat };
}

// Rechaza valores que JSON perdería, en vez de corromper silenciosamente el plan guardado.
function copiar(valor, vistos = new Set()) {
  if (valor === null || typeof valor === "string" || typeof valor === "boolean") return valor;
  if (typeof valor === "number" && Number.isFinite(valor)) return valor;
  if (typeof valor !== "object" || vistos.has(valor)
    || (!Array.isArray(valor) && ![Object.prototype, null].includes(Object.getPrototypeOf(valor)))) {
    throw new Error("Los datos deben contener valores JSON finitos, sin referencias circulares.");
  }
  vistos.add(valor);
  const resultado = Array.isArray(valor)
    ? Array.from(valor, (v) => copiar(v, vistos))
    : Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, copiar(v, vistos)]));
  vistos.delete(valor);
  return resultado;
}

function contenidoMarca({ tipo, nombre, lon, lat, datos = {} } = {}) {
  comprobarTipo(tipo);
  if (!texto(nombre)) throw new Error("La marca necesita un nombre no vacío.");
  if (!esObjeto(datos)) throw new Error("Los datos de la marca deben ser un objeto.");
  return { tipo, nombre, ...coordenadas(lon, lat), datos: copiar(datos) };
}

function nuevoId(plan, clase) {
  const usados = new Set([...plan.marcas, ...plan.itinerarios].map((v) => v.id));
  let contador = plan.contadores?.[clase] ?? 0;
  do {
    contador++;
    if (!Number.isSafeInteger(contador)) throw new Error("Se agotaron los identificadores del plan.");
  } while (usados.has(`${clase}-${contador}`));
  plan.contadores = { ...plan.contadores, [clase]: contador };
  return `${clase}-${contador}`;
}

export function agregarMarca(plan, opciones) {
  comprobarPlan(plan);
  const contenido = contenidoMarca(opciones);
  const marca = { id: nuevoId(plan, "marca"), ...contenido };
  plan.marcas.push(marca);
  return copiar(marca);
}

function indiceMarca(plan, id) {
  comprobarPlan(plan);
  const i = plan.marcas.findIndex((m) => m.id === id);
  if (i < 0) throw new Error(`No existe la marca ${String(id)}.`);
  return i;
}

// Firma: editarMarca(plan, id, cambios). datos se combina por clave; el id se conserva.
export function editarMarca(plan, id, cambios) {
  const i = indiceMarca(plan, id);
  if (!esObjeto(cambios) || Object.keys(cambios).some((k) => !["tipo", "nombre", "lon", "lat", "datos"].includes(k))) {
    throw new Error("Elegí cambios de tipo, nombre, lon, lat o datos; el id no se puede editar.");
  }
  if (Object.hasOwn(cambios, "datos") && !esObjeto(cambios.datos)) throw new Error("Los datos de la marca deben ser un objeto.");
  const actual = plan.marcas[i];
  const contenido = contenidoMarca({ ...actual, ...cambios, datos: { ...actual.datos, ...cambios.datos } });
  plan.marcas[i] = { id, ...contenido };
  return copiar(plan.marcas[i]);
}

export function moverMarca(plan, id, lon, lat) {
  return editarMarca(plan, id, { lon, lat });
}

// Devuelve la marca borrada y los ids de todos los itinerarios afectados (incluso si quedan vacíos).
export function borrarMarca(plan, id) {
  const i = indiceMarca(plan, id);
  const itinerariosAfectados = [];
  for (const it of plan.itinerarios) {
    if (it.paradas.some((p) => p.marca === id)) {
      it.paradas = it.paradas.filter((p) => p.marca !== id);
      itinerariosAfectados.push(it.id);
    }
  }
  const [marca] = plan.marcas.splice(i, 1);
  return { marca: copiar(marca), itinerariosAfectados };
}

export function marcasPorTipo(plan, tipo) {
  comprobarPlan(plan);
  comprobarTipo(tipo);
  return copiar(plan.marcas.filter((m) => m.tipo === tipo));
}

// Haversine en la esfera marciana. distancia_km es distancia superficial, no una ruta transitable.
export function masCercanas(plan, lon, lat, { tipos, n = plan.marcas.length } = {}) {
  comprobarPlan(plan);
  const origen = coordenadas(lon, lat);
  if (tipos !== undefined) {
    if (!Array.isArray(tipos)) throw new Error("Los tipos deben ser una lista.");
    tipos.forEach(comprobarTipo);
  }
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("La cantidad de marcas debe ser un entero no negativo.");
  const rad = Math.PI / 180;
  return plan.marcas.filter((m) => tipos === undefined || tipos.includes(m.tipo)).map((m) => {
    const a = Math.sin((m.lat - origen.lat) * rad / 2) ** 2
      + Math.cos(origen.lat * rad) * Math.cos(m.lat * rad) * Math.sin((m.lon - origen.lon) * rad / 2) ** 2;
    const distancia_km = 2 * configuracion.radio_marte_m.valor / 1000 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
    return { ...copiar(m), distancia_km };
  }).sort((a, b) => a.distancia_km - b.distancia_km).slice(0, n);
}

function problemasEstructura(it) {
  const problemas = [];
  if (!esObjeto(it)) return ["El itinerario debe ser un objeto."];
  if (!texto(it.nombre)) problemas.push("El itinerario necesita un nombre no vacío.");
  if (!["pie", "rover"].includes(it.vehiculo)) problemas.push("El vehículo debe ser pie o rover.");
  if (!Array.isArray(it.paradas)) return [...problemas, "Las paradas deben ser una lista."];
  it.paradas.forEach((p, i) => {
    if (!esObjeto(p) || !texto(p.marca)) problemas.push(`Parada ${i + 1}: indicá el id de una marca.`);
    if (!esObjeto(p) || !Number.isFinite(p.minutos) || p.minutos < 0) problemas.push(`Parada ${i + 1}: los minutos deben ser un número no negativo.`);
  });
  return problemas;
}

export function validarItinerario(plan, it) {
  comprobarPlan(plan);
  const problemas = problemasEstructura(it);
  if (!esObjeto(it) || !Array.isArray(it.paradas)) return problemas;
  if (it.paradas.length < 2) problemas.push("El itinerario necesita al menos dos paradas.");
  const marcas = new Map(plan.marcas.map((m) => [m.id, m]));
  it.paradas.forEach((p, i) => {
    if (!esObjeto(p) || !texto(p.marca)) return;
    if (!marcas.has(p.marca)) problemas.push(`Parada ${i + 1}: no existe la marca ${p.marca}.`);
    if (i > 0 && it.paradas[i - 1]?.marca === p.marca) problemas.push(`Parada ${i + 1}: dos paradas iguales seguidas.`);
  });
  for (const [indice, extremo] of [[0, "empezar"], [it.paradas.length - 1, "terminar"]]) {
    if (!["habitat", "refugio"].includes(marcas.get(it.paradas[indice]?.marca)?.tipo)) {
      problemas.push(`El itinerario debe ${extremo} en un hábitat o refugio.`);
    }
  }
  return problemas;
}

export function crearItinerario(plan, { nombre, vehiculo, paradas } = {}) {
  const it = { nombre, vehiculo, paradas };
  const problemas = validarItinerario(plan, it);
  if (problemas.length) throw new Error(problemas.join(" "));
  const contenido = copiar(it);
  const itinerario = { id: nuevoId(plan, "itinerario"), ...contenido };
  plan.itinerarios.push(itinerario);
  return copiar(itinerario);
}

// properties conserva versión, contadores e itinerarios, incluidos borradores tras un borrado.
// Las coordenadas son marcianas; no se reproyectan a la Tierra ni a WGS84.
export function aGeoJSON(plan) {
  comprobarPlan(plan);
  return {
    type: "FeatureCollection",
    properties: copiar({ version: plan.version, ...(plan.contadores ? { contadores: plan.contadores } : {}), itinerarios: plan.itinerarios }),
    features: plan.marcas.map(({ lon, lat, ...properties }) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: copiar(properties),
    })),
  };
}

// Importa elementos válidos sin abortar por uno defectuoso. problemas contiene textos en español.
export function desdeGeoJSON(geojson) {
  const plan = crearPlan(), problemas = [];
  if (!esObjeto(geojson) || geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { plan, problemas: ["Se esperaba una colección GeoJSON FeatureCollection con features."] };
  }
  const propiedades = geojson.properties ?? {};
  if (!esObjeto(propiedades) || (propiedades.version !== undefined && propiedades.version !== 1)) {
    return { plan, problemas: ["Las propiedades o la versión de la colección no son compatibles."] };
  }
  if (propiedades.contadores !== undefined) {
    const c = propiedades.contadores;
    if (!esObjeto(c) || Object.entries(c).some(([k, v]) => !["marca", "itinerario"].includes(k) || !Number.isSafeInteger(v) || v < 0)) {
      problemas.push("Los contadores del plan no son válidos.");
    } else plan.contadores = copiar(c);
  }
  const ids = new Set();
  geojson.features.forEach((f, i) => {
    try {
      if (f?.type !== "Feature" || f.geometry?.type !== "Point" || !Array.isArray(f.geometry.coordinates) || f.geometry.coordinates.length < 2) {
        throw new Error("La marca debe ser un Feature con geometría Point.");
      }
      const p = f.properties;
      if (!esObjeto(p) || !texto(p.id)) throw new Error("La marca necesita un id de texto.");
      if (ids.has(p.id)) throw new Error(`El id ${p.id} está repetido.`);
      const [lon, lat] = f.geometry.coordinates;
      const contenido = contenidoMarca({ ...p, lon, lat });
      plan.marcas.push({ id: p.id, ...contenido });
      ids.add(p.id);
    } catch (error) { problemas.push(`Marca ${i + 1}: ${error.message}`); }
  });
  const itinerarios = propiedades.itinerarios ?? [];
  if (!Array.isArray(itinerarios)) problemas.push("Los itinerarios de la colección deben ser una lista.");
  else itinerarios.forEach((it, i) => {
    try {
      if (!esObjeto(it) || !texto(it.id)) throw new Error("El itinerario necesita un id de texto.");
      if (ids.has(it.id)) throw new Error(`El id ${it.id} está repetido.`);
      const errores = problemasEstructura(it);
      if (errores.length) throw new Error(errores.join(" "));
      const contenido = copiar({ id: it.id, nombre: it.nombre, vehiculo: it.vehiculo, paradas: it.paradas });
      plan.itinerarios.push(contenido);
      ids.add(it.id);
      problemas.push(...validarItinerario(plan, contenido).map((p) => `Itinerario ${i + 1}: ${p}`));
    } catch (error) { problemas.push(`Itinerario ${i + 1}: ${error.message}`); }
  });
  return { plan, problemas };
}
