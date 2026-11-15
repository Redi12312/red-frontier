// Expediciones modeladas, sin DOM ni estado compartido. La ruta describe SOLO la ida.
// La vuelta repite el camino y sus tiempos en sentido inverso; la ciencia se hace en la ida.
// Los km de tramos, depósitos, refugios y sueño son posiciones desde la base sobre la ida.
// Cada sol tiene manejo {desde_km, hasta_km, horas, tramos}, paradas y duerme (null al volver).
// Los tramos separan ida y vuelta cuando ambas ocurren en el mismo sol.
// Depósitos: recarga completa en cada visita, también al regresar, para cada rover.
// Refugios: separación conservadora <= alejamiento máximo, medida sobre el camino.
// No se modelan consumos de soporte vital, ciencia, descanso ni fallas simultáneas.

const numero = (x) => typeof x === "number" && Number.isFinite(x);
const formato = (x) => x.toLocaleString("es-UY", { maximumFractionDigits: 2 });
const iguales = (a, b) => Math.abs(a - b) <= Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 16;

function parametro(p, nombre, admiteCero = false) {
  if (!numero(p?.valor) || (admiteCero ? p.valor < 0 : p.valor <= 0)) {
    throw new RangeError(`Revisá ${nombre}: debe tener un valor ${admiteCero ? "no negativo" : "positivo"} y finito.`);
  }
  return p.valor;
}

function validarRuta(ruta) {
  const d = ruta?.distancias_m, t = ruta?.tiempos_s;
  const arreglo = (x) => Array.isArray(x) || (ArrayBuffer.isView(x) && !(x instanceof DataView));
  if (!arreglo(d) || !arreglo(t) || !d.length || d.length !== t.length) {
    throw new TypeError("La ruta debe tener distancias y tiempos acumulados de igual longitud, con al menos un punto.");
  }
  if (d[0] !== 0 || t[0] !== 0) throw new RangeError("La ruta debe empezar en distancia y tiempo cero.");
  for (let i = 0; i < d.length; i++) {
    if (!numero(d[i]) || !numero(t[i]) || d[i] < 0 || t[i] < 0
      || (i && (d[i] <= d[i - 1] || t[i] <= t[i - 1]))) {
      throw new RangeError("Las distancias y los tiempos deben ser finitos y estrictamente crecientes.");
    }
  }
  if (!numero(2 * d.at(-1)) || !numero(2 * t.at(-1))) {
    throw new RangeError("La ida y vuelta supera el rango numérico disponible.");
  }
  return { d, t };
}

// Interpolación lineal entre muestras; la validación garantiza abscisas crecientes.
function interpolar(x, xs, ys) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs.at(-1)) return ys.at(-1);
  let a = 0, b = xs.length - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (xs[m] <= x) a = m; else b = m;
  }
  return ys[a] + (ys[b] - ys[a]) * (x - xs[a]) / (xs[b] - xs[a]);
}

// Se conserva energía para llegar al destino Y volver al último depósito.
function ubicarDepositos(km, autonomiaUtil, intervalo) {
  const puntos = [];
  let ultimo = 0;
  while (2 * (km - ultimo) > autonomiaUtil && !iguales(2 * (km - ultimo), autonomiaUtil)) {
    const siguiente = Math.min(ultimo + intervalo, km - autonomiaUtil / 2);
    if (siguiente <= ultimo) throw new RangeError("La separación de depósitos es demasiado pequeña para esta ruta.");
    puntos.push({ km: siguiente, requerido: true, visitas: ["ida", "vuelta"], recarga: "completa_por_rover" });
    ultimo = siguiente;
  }
  return puntos;
}

function ubicarRefugios(km, maximo) {
  const puntos = [];
  for (let i = 1; i * maximo < km && !iguales(i * maximo, km); i++) {
    puntos.push({ km: i * maximo, requerido: true });
  }
  return puntos;
}

/**
 * planificarExpedicion(ruta, cfg, { rovers = 1, paradas = [] })
 * ruta: {distancias_m, tiempos_s} acumulados de ida; admite arreglos tipados.
 * Las paradas tienen {distancia_m, minutos?}; se ordenan sin modificar la entrada.
 * Devuelve {soles, depositos, refugios, totales, avisos, supuestos}.
 * Es infraestructura propuesta: los avisos no certifican que una salida sea segura.
 */
export function planificarExpedicion(ruta, cfg, { rovers = 1, paradas = [] } = {}) {
  const { d, t } = validarRuta(ruta);
  if (rovers !== 1 && rovers !== 2) throw new RangeError("Elegí uno o dos rovers.");
  if (!Array.isArray(paradas)) throw new TypeError("Las paradas deben ser una lista.");
  const r = cfg?.rover_presurizado;
  parametro(r?.velocidad_kmh, "velocidad de referencia"); // No reemplaza los tiempos del ruteo.
  const manejoMax = parametro(r?.horas_manejo_por_sol, "horas de manejo por sol") * 3600;
  const actividadMax = parametro(cfg?.horas_actividad_por_sol, "horas de actividad por sol") * 3600;
  const descanso = parametro(cfg?.descanso_nocturno_h, "descanso nocturno", true);
  const porDefecto = parametro(cfg?.trabajo_por_parada_min, "trabajo por parada", true);
  const autonomia = parametro(r?.autonomia_km, "autonomía");
  const reserva = parametro(r?.reserva_fraccion, "reserva de energía", true);
  if (reserva >= 1) throw new RangeError("La reserva de energía debe ser menor que uno.");
  const autonomiaUtil = autonomia * (1 - reserva);
  const intervalo = Math.min(parametro(r?.intervalo_depositos_km, "intervalo de depósitos"), autonomiaUtil);
  const alejamiento = parametro(r?.alejamiento_max_km?.[rovers === 1 ? "uno" : "dos"], "alejamiento máximo");
  const solesMax = parametro(r?.duracion_max_soles, "duración máxima en soles");
  if (!numero(manejoMax) || !numero(actividadMax) || !autonomiaUtil) {
    throw new RangeError("La configuración supera el rango numérico disponible.");
  }

  const distancia = d.at(-1), tiempo = t.at(-1), km = distancia / 1000;
  const trabajos = paradas.map((p, indice) => {
    if (!numero(p?.distancia_m) || p.distancia_m < 0 || p.distancia_m > distancia) {
      throw new RangeError(`La parada ${indice + 1} debe estar dentro de la ruta.`);
    }
    const minutos = p.minutos === undefined ? porDefecto : p.minutos;
    if (!numero(minutos) || minutos < 0 || !numero(minutos * 60)) {
      throw new RangeError(`Revisá los minutos de la parada ${indice + 1}: deben ser finitos y no negativos.`);
    }
    return { indice, distancia_m: p.distancia_m, minutos, tiempo_s: interpolar(p.distancia_m, d, t) };
  }).sort((a, b) => a.distancia_m - b.distancia_m || a.indice - b.indice);

  const depositos = ubicarDepositos(km, autonomiaUtil, intervalo);
  const refugios = ubicarRefugios(km, alejamiento);
  const avisos = [];
  if (depositos.length) avisos.push(`La reserva de energía exige ${depositos.length === 1 ? "1 depósito" : `${formato(depositos.length)} depósitos`}: prepará recargas completas para cada rover en la ida y en la vuelta.`);
  if (refugios.length) avisos.push(`La ruta supera el alejamiento de ${formato(alejamiento)} km con ${rovers === 1 ? "un rover" : "dos rovers"}: ${refugios.length === 1 ? "hace falta 1 refugio operativo" : `hacen falta ${formato(refugios.length)} refugios operativos`}.`);

  const soles = [];
  let actual = null, manejado = 0, actividad = 0, reloj = 0;
  const posicion = (s) => interpolar(s <= tiempo ? s : 2 * tiempo - s, t, d) / 1000;
  function nuevoSol() {
    if (actual) actual.duerme = { km: posicion(reloj), tipo: "rover_presurizado", horas: descanso };
    const inicio = posicion(reloj);
    actual = { sol: soles.length + 1, manejo: { desde_km: inicio, hasta_km: inicio, horas: 0, tramos: [] }, paradas: [], duerme: null };
    soles.push(actual);
    manejado = 0; actividad = 0;
  }

  function manejarHasta(fin) {
    while (reloj < fin && !iguales(reloj, fin)) {
      if (!actual || manejado >= manejoMax || iguales(manejado, manejoMax)
        || actividad >= actividadMax || iguales(actividad, actividadMax)) nuevoSol();
      // El punto de giro también delimita un tramo, aunque no termine la jornada.
      const giro = reloj < tiempo ? tiempo : 2 * tiempo;
      const segundos = Math.min(fin - reloj, giro - reloj, manejoMax - manejado, actividadMax - actividad);
      const desde = posicion(reloj), hasta = posicion(reloj + segundos);
      actual.manejo.tramos.push({ sentido: reloj < tiempo ? "ida" : "vuelta", desde_km: desde, hasta_km: hasta, horas: segundos / 3600 });
      reloj += segundos; manejado += segundos; actividad += segundos;
      actual.manejo.hasta_km = hasta;
      actual.manejo.horas = manejado / 3600;
    }
    reloj = fin;
  }

  function trabajar(p) {
    let pendiente = p.minutos * 60;
    if (pendiente > actividadMax) avisos.push(`La parada ${p.indice + 1} necesita varias jornadas de ciencia; su trabajo se reparte entre soles.`);
    // Una parada de cero minutos queda registrada sin añadir un sol si ya hay jornada.
    if (!actual) nuevoSol();
    do {
      if (pendiente > 0 && (actividad >= actividadMax || iguales(actividad, actividadMax))) nuevoSol();
      const segundos = Math.min(pendiente, actividadMax - actividad);
      pendiente -= segundos; actividad += segundos;
      actual.paradas.push({ indice: p.indice, distancia_km: p.distancia_m / 1000, minutos: segundos / 60, completa: iguales(pendiente, 0) });
    } while (pendiente > 0 && !iguales(pendiente, 0));
  }

  for (const p of trabajos) { manejarHasta(p.tiempo_s); trabajar(p); }
  manejarHasta(2 * tiempo);
  if (soles.length > solesMax) avisos.push(`La expedición requiere ${formato(soles.length)} soles y supera el límite propuesto de ${formato(solesMax)} soles, a calibrar.`);

  return {
    soles, depositos, refugios,
    totales: {
      km_ida: km, km_ida_vuelta: 2 * km, horas_manejo: 2 * tiempo / 3600,
      horas_ciencia: trabajos.reduce((s, p) => s + p.minutos / 60, 0),
      horas_descanso: Math.max(0, soles.length - 1) * descanso, soles: soles.length,
    },
    avisos,
    supuestos: [
      "Plan modelado: regreso por la misma ruta con los mismos tiempos; la velocidad de configuración es solo una referencia.",
      "Ciencia solo en la ida; comparte la ventana de actividad con el manejo. El descanso ocurre entre jornadas, dentro del rover presurizado.",
      "Depósitos y refugios requeridos, todavía no existentes: hay que instalarlos antes de salir. Cada rover conserva su propia reserva; dos rovers no duplican la autonomía.",
      "Energía proporcional a la distancia, con recarga completa en cada visita a un depósito. No incluye soporte vital ni consumo durante ciencia y descanso.",
      "Alejamiento medido por el camino al último refugio; referencias lunares trasladadas, sin fallas apiladas. Los parámetros propuestos están a calibrar.",
    ],
  };
}

// Redondeo hacia arriba: cantidad de pasos necesarios para cubrir la distancia.
export function contarPasos(distancia_m, cfg) {
  if (!numero(distancia_m) || distancia_m < 0) throw new RangeError("La distancia para contar pasos debe ser finita y no negativa.");
  const p = cfg?.a_pie?.largo_paso_m;
  const largo = parametro(p, "largo del paso");
  const cociente = distancia_m / largo;
  const pasos = distancia_m === 0 ? 0 : Math.max(1,
    Math.ceil(iguales(cociente, Math.round(cociente)) ? Math.round(cociente) : cociente));
  if (!Number.isSafeInteger(pasos)) throw new RangeError("La cantidad de pasos supera el rango de enteros seguros.");
  return { pasos, largo_paso_m: largo, base: p.base, fuente: p.fuente };
}
