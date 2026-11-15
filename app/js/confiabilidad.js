// Confiabilidad modelada de una salida. Sin DOM, red ni estado compartido.
// Las tasas de ejemplo y las hipótesis están en config/confiabilidad.json.

const TIPOS = ["fuga", "mochila", "companero", "tormenta", "radio", "rover"];
const valor = (p) => p !== null && typeof p === "object" ? p.valor : p;
const acotar = (p) => Math.max(0, Math.min(1, p));
const interpolar = (a, b, x) => a + (b - a) * x;

function numero(p, nombre, positivo = false) {
  const n = valor(p);
  if (!Number.isFinite(n) || n < 0 || (positivo && n === 0)) {
    throw new Error(`${nombre} debe ser un número finito ${positivo ? "positivo" : "no negativo"}.`);
  }
  return n;
}

function arreglo(a, n, nombre) {
  if ((!Array.isArray(a) && !ArrayBuffer.isView(a)) || a.length !== n) {
    throw new Error(`${nombre} debe tener un valor por punto de la ruta.`);
  }
}

function validarRuta(ruta) {
  const n = ruta?.celdas?.length;
  if (!n) throw new Error("La ruta debe tener al menos una celda.");
  arreglo(ruta.celdas, n, "ruta.celdas");
  for (const campo of ["t", "d", "regreso"]) arreglo(ruta[campo], n, `ruta.${campo}`);
  if (ruta.rescate != null) arreglo(ruta.rescate, n, "ruta.rescate");
  if (ruta.tasaO2 != null) arreglo(ruta.tasaO2, n, "ruta.tasaO2");
  for (let k = 0; k < n; k++) {
    if (!Number.isSafeInteger(ruta.celdas[k]) || ruta.celdas[k] < 0) {
      throw new Error("ruta.celdas debe contener índices enteros no negativos.");
    }
    numero(ruta.t[k], "ruta.t");
    numero(ruta.d[k], "ruta.d");
    if (ruta.tasaO2 != null) numero(ruta.tasaO2[k], "ruta.tasaO2", true);
    // null o infinito: sin camino. NaN y negativos: datos corruptos, no un camino seguro.
    for (const campo of ["regreso", "rescate"]) {
      const r = ruta[campo]?.[k];
      if (r !== null && !(campo === "rescate" && ruta.rescate == null) && r !== Infinity) {
        numero(r, `ruta.${campo}`);
      }
    }
    if (k && (ruta.t[k] < ruta.t[k - 1] || ruta.d[k] < ruta.d[k - 1])) {
      throw new Error("Los tiempos y las distancias acumuladas no pueden decrecer.");
    }
    if (k && ruta.t[k] === ruta.t[k - 1] && ruta.d[k] !== ruta.d[k - 1]) {
      throw new Error("No puede haber desplazamiento con duración cero.");
    }
  }
  if (ruta.t[0] !== 0 || ruta.d[0] !== 0) {
    throw new Error("Los tiempos y las distancias acumuladas deben empezar en cero.");
  }
  return n;
}

// Interseca el intervalo seguro con el semiplano lineal margen(x) >= 0.
function recortar(intervalo, a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error("Los márgenes de regreso son demasiado grandes para calcularlos.");
  }
  if (!intervalo || (a < 0 && b < 0)) return null;
  let [desde, hasta] = intervalo;
  const escala = Math.max(Math.abs(a), Math.abs(b));
  if (a < 0) desde = Math.max(desde, (-a / escala) / (b / escala - a / escala));
  if (b < 0) hasta = Math.min(hasta, (a / escala) / (a / escala - b / escala));
  return hasta > desde ? [desde, hasta] : null;
}

function tramoSeguro(tipo, ruta, k, dt, gastado, limites, mochila) {
  const campo = tipo === "companero" ? "rescate" : "regreso";
  const a = ruta[campo]?.[k], b = ruta[campo]?.[k + 1];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { intervalo: null, motivo: `Sin camino de ${campo} informado en el tramo.` };
  const r0 = limites.colchon * a + limites.ingreso_s;
  const r1 = limites.colchon * b + limites.ingreso_s;
  if (!Number.isFinite(r0) || !Number.isFinite(r1)) {
    throw new Error("El tiempo de regreso con colchón e ingreso es demasiado grande.");
  }
  const tasa = ruta.tasaO2?.[k] ?? 1;
  const topes = {
    fuga: limites.secundario_s,
    mochila,
    companero: limites.rescate_max_s,
    tormenta: limites.tormenta_refugio_s,
    radio: Infinity,
    rover: limites.caminata_max_s,
  };
  let intervalo = [0, 1];
  const tope = topes[tipo];
  // El secundario se expresa en segundos de O₂ nominal. Los demás topes son de reloj.
  const factor = tipo === "fuga" ? tasa : 1;
  if (tope !== Infinity) intervalo = recortar(intervalo, tope - r0 * factor, tope - r1 * factor);
  if (tipo !== "fuga" && tipo !== "mochila") {
    intervalo = recortar(intervalo, limites.primario_s - gastado - r0 * tasa,
      limites.primario_s - gastado - (dt + r1) * tasa);
  }
  return { intervalo, motivo: `El regreso por ${campo}, con colchón e ingreso, supera el límite de ${tipo} o el oxígeno disponible.` };
}

/**
 * ruta: formato de la tarea 9; t/d acumulados desde cero, incluye trabajo y vuelta
 * si corresponden. No agrega minutosDestino ni duplica idaYVuelta. Arreglos por
 * punto de ruta, no por índice de celda. Una espera se representa repitiendo celda/d.
 *
 * limites: { vehiculo: "pie"|"rover", primario_s, secundario_s, ingreso_s, colchon,
 * rescate_max_s, tormenta_refugio_s, caminata_max_s (solo rover), mochila_s? }.
 * Acepta números o parámetros {valor,...}. mochila_s usa cfg si no se informa.
 * En rover, ruta.regreso debe contener el tiempo de caminata, como en el Worker.
 *
 * Probabilidades en [0,1]. Integra S(t)·lambda_i(t) sobre los intervalos seguros,
 * con S(t)=exp(-riesgo acumulado). supervivencia = sin incidentes + primer
 * incidente recuperable. No simula incidentes posteriores ni garantiza seguridad.
 * Una probabilidad condicional sin exposición es null (no definida).
 */
export function evaluarConfiabilidad({ ruta, cfg, limites } = {}) {
  const n = validarRuta(ruta);
  if (!cfg || !limites) throw new Error("Faltan cfg o limites de confiabilidad.");
  if (!["pie", "rover"].includes(limites.vehiculo)) throw new Error("Elegí vehiculo pie o rover.");
  const lim = { vehiculo: limites.vehiculo };
  for (const campo of ["primario_s", "secundario_s", "ingreso_s", "colchon", "rescate_max_s", "tormenta_refugio_s"]) {
    lim[campo] = numero(limites[campo], `limites.${campo}`, campo === "colchon");
  }
  if (lim.colchon < 1) throw new Error("El colchón de regreso debe ser al menos uno.");
  lim.caminata_max_s = lim.vehiculo === "rover" ? numero(limites.caminata_max_s, "limites.caminata_max_s") : null;
  const mochila = numero(limites.mochila_s === undefined ? cfg.mochila_s : limites.mochila_s, "mochila_s");
  const tasas = {};
  for (const tipo of TIPOS) {
    tasas[tipo] = tipo === "rover"
      ? numero(cfg.tasa_rover_por_km, "cfg.tasa_rover_por_km")
      : numero(cfg.tasas_por_hora?.[tipo], `cfg.tasas_por_hora.${tipo}`);
  }
  const duracion = ruta.t[n - 1], distancia = ruta.d[n - 1];
  const porFalla = Object.fromEntries(TIPOS.map((tipo) => [tipo, {
    activo: tipo !== "rover" || lim.vehiculo === "rover",
    tasa: tasas[tipo], unidad: tipo === "rover" ? "km^-1" : "h^-1",
    tiempo_fuera_s: 0, fraccion_tiempo_fuera: 0, exposicion: 0,
    riesgo_acumulado: 0, probabilidad_primera_falla: 0,
    probabilidad_regreso_si_falla: null, probabilidad_no_regreso: 0,
  }]));
  const masaSegura = Object.fromEntries(TIPOS.map((tipo) => [tipo, 0]));
  const puntosDebiles = [];
  let riesgo = 0, gastado = 0, perdida = 0, recuperable = 0;

  for (let k = 0; k < n - 1; k++) {
    const dt = ruta.t[k + 1] - ruta.t[k];
    if (!dt) continue;
    const dd = ruta.d[k + 1] - ruta.d[k];
    const peligros = {}, seguros = {}, cortes = new Set([0, 1]);
    let peligroTotal = 0;
    for (const tipo of TIPOS) {
      const f = porFalla[tipo];
      const exposicion = !f.activo ? 0 : tipo === "rover" ? dd / 1000 : dt / 3600;
      const h = tasas[tipo] * exposicion;
      peligros[tipo] = h;
      peligroTotal += h;
      f.exposicion += exposicion;
      f.riesgo_acumulado += h;
      if (!f.activo) continue;
      const seguro = tramoSeguro(tipo, ruta, k, dt, gastado, lim, mochila);
      seguros[tipo] = seguro;
      const [desde, hasta] = seguro.intervalo ?? [0, 0];
      f.tiempo_fuera_s += dt * (1 - (hasta - desde));
      cortes.add(desde); cortes.add(hasta);
    }
    if (!Number.isFinite(riesgo + peligroTotal)) throw new Error("La exposición acumulada es demasiado grande.");
    const orden = [...cortes].sort((a, b) => a - b);
    for (let j = 1; j < orden.length; j++) {
      const desde = orden[j - 1], hasta = orden[j], medio = (desde + hasta) / 2;
      const masa = peligroTotal === 0 ? 0
        : Math.exp(-riesgo - peligroTotal * desde) * -Math.expm1(-peligroTotal * (hasta - desde));
      for (const tipo of TIPOS) {
        const f = porFalla[tipo];
        if (!f.activo) continue;
        const p = peligroTotal === 0 ? 0 : masa * (peligros[tipo] / peligroTotal);
        f.probabilidad_primera_falla += p;
        const seguro = seguros[tipo];
        if (seguro.intervalo && medio >= seguro.intervalo[0] && medio <= seguro.intervalo[1]) {
          masaSegura[tipo] += p;
          recuperable += p;
        } else {
          perdida += p;
          f.probabilidad_no_regreso += p;
          puntosDebiles.push({
            tipo, desde_k: k, hasta_k: k + 1,
            desde_celda: ruta.celdas[k], hasta_celda: ruta.celdas[k + 1],
            desde_s: interpolar(ruta.t[k], ruta.t[k + 1], desde),
            hasta_s: interpolar(ruta.t[k], ruta.t[k + 1], hasta),
            desde_m: interpolar(ruta.d[k], ruta.d[k + 1], desde),
            hasta_m: interpolar(ruta.d[k], ruta.d[k + 1], hasta),
            probabilidad_no_regreso: p, motivo: seguro.motivo,
          });
        }
      }
    }
    riesgo += peligroTotal;
    gastado += dt * (ruta.tasaO2?.[k] ?? 1);
    if (!Number.isFinite(gastado)) throw new Error("El consumo acumulado de oxígeno es demasiado grande.");
  }
  for (const tipo of TIPOS) {
    const f = porFalla[tipo];
    f.fraccion_tiempo_fuera = duracion ? acotar(f.tiempo_fuera_s / duracion) : 0;
    f.probabilidad_regreso_si_falla = f.probabilidad_primera_falla > 0
      ? acotar(masaSegura[tipo] / f.probabilidad_primera_falla) : null;
  }
  const incidente = -Math.expm1(-riesgo);
  return {
    duracion_s: duracion, distancia_m: distancia, riesgo_acumulado: riesgo,
    probabilidad_completar_sin_incidentes: Math.exp(-riesgo),
    probabilidad_incidente: incidente,
    probabilidad_regreso_si_falla: incidente > 0 ? acotar(recuperable / incidente) : null,
    probabilidad_supervivencia: acotar(1 - perdida),
    probabilidad_no_regreso: acotar(perdida),
    por_falla: porFalla, puntos_debiles: puntosDebiles,
    base: "modelado",
    aviso: "Estimación condicionada al modelo de primera falla y a un plan nominal viable. "
      + "No incluye fallas encadenadas ni incidentes durante el regreso de emergencia. "
      + "Las tasas de ejemplo son propuestas, a calibrar; no son probabilidades medidas en Marte.",
  };
}
