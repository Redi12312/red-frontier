// Localización modelada por presión diferencial y navegación a estima. Sin DOM ni red.
// Los ruidos y las constantes físicas se reciben de config/barometro.json.

const MASA_CREDIBLE = 0.95; // Contrato del área solicitada, no un umbral de seguridad.

function numero(x, nombre, minimo = -Infinity) {
  if (!Number.isFinite(x) || x < minimo) throw new RangeError(`${nombre}: ingresá un número válido.`);
  return x;
}

function parametro(cfg, nombre, positivo = false) {
  const x = numero(cfg?.[nombre]?.valor, `Configuración ${nombre}`, 0);
  if (positivo && x === 0) throw new RangeError(`Configuración ${nombre}: tiene que ser mayor que cero.`);
  return x;
}

function validarZona(zona) {
  if (!zona || !Number.isSafeInteger(zona.ancho) || !Number.isSafeInteger(zona.alto)
    || zona.ancho <= 0 || zona.alto <= 0 || !Number.isSafeInteger(zona.ancho * zona.alto)
    || zona.elevacion?.length !== zona.ancho * zona.alto || zona.valido?.length !== zona.ancho * zona.alto) {
    throw new RangeError("Zona inválida: revisá las dimensiones, elevación y máscara de datos.");
  }
  numero(zona.paso, "Paso de la grilla", Number.MIN_VALUE);
}

function celda(zona, punto) {
  return punto && Number.isInteger(punto.f) && Number.isInteger(punto.c)
    && punto.f >= 0 && punto.f < zona.alto && punto.c >= 0 && punto.c < zona.ancho;
}

function conDato(zona, i) {
  return Boolean(zona.valido[i]) && Number.isFinite(zona.elevacion[i]);
}

// T es la temperatura media del aire en K; p y pBase son simultáneas, en Pa.
// El ruido diferencial ya incluye ambos sensores. Se mantiene pBase como referencia
// y se propaga δ(p − pBase): ∂z/∂δp = −RT/(g·p), ∂z/∂T = R/g·ln(pBase/p).
// No incluye gradientes meteorológicos espaciales ni error del modelo de atmósfera.
export function desnivel({ p, pBase, T, cfg }) {
  numero(p, "Presión del traje", Number.MIN_VALUE);
  numero(pBase, "Presión de la base", Number.MIN_VALUE);
  numero(T, "Temperatura del aire en K", Number.MIN_VALUE);
  const R = parametro(cfg, "gas_marciano_j_kg_k", true);
  const g = parametro(cfg, "gravedad_m_s2", true);
  const sp = parametro(cfg, "sigma_presion_diferencial_pa");
  const st = parametro(cfg, "sigma_temperatura_k");
  const log = Math.log1p((pBase - p) / p);
  const dz = R * T / g * log;
  const sigma = Math.hypot(R * T / (g * p) * sp, R / g * log * st);
  numero(dz, "Desnivel calculado");
  numero(sigma, "Incertidumbre calculada", 0);
  return { dz, sigma };
}

// Actualización bayesiana en logaritmos; evita perder todas las probabilidades
// cuando la lectura está lejos del relieve. sigma = 0 exige coincidencia exacta.
function pesarAltura(zona, previa, altura, sigma) {
  const errores = new Map();
  let minimo = Infinity;
  for (const [i, p] of previa) {
    if (!(p > 0)) continue;
    const e = Math.abs(zona.elevacion[i] - altura);
    errores.set(i, e);
    minimo = Math.min(minimo, e);
  }
  const logs = new Map();
  let maximo = -Infinity;
  for (const [i, e] of errores) {
    if (sigma === 0 && e !== 0) continue;
    // Restar el error mínimo no cambia el posterior normalizado.
    const pena = sigma === 0 || e === minimo ? 0 : ((e - minimo) / sigma) * ((e + minimo) / sigma) / 2;
    const log = Math.log(previa.get(i)) - pena;
    logs.set(i, log);
    maximo = Math.max(maximo, log);
  }
  const posterior = new Map();
  let suma = 0;
  for (const [i, log] of logs) {
    const p = Math.exp(log - maximo);
    if (p > 0) { posterior.set(i, p); suma += p; }
  }
  for (const [i, p] of posterior) posterior.set(i, p / suma);
  return posterior;
}

function resumen(zona, pesos) {
  if (!pesos.size) return { mejor: null, media: null, area_m2: 0, sigma_m: null };
  let maximo = -1, indice = -1, f = 0, c = 0;
  for (const [i, p] of pesos) {
    if (p > maximo) { maximo = p; indice = i; }
    f += Math.floor(i / zona.ancho) * p;
    c += (i % zona.ancho) * p;
  }
  let varianza = 0;
  for (const [i, p] of pesos) {
    varianza += p * ((Math.floor(i / zona.ancho) - f) ** 2 + (i % zona.ancho - c) ** 2);
  }
  let masa = 0, cantidad = 0;
  for (const p of [...pesos.values()].sort((a, b) => b - a)) {
    masa += p; cantidad++;
    if (masa >= MASA_CREDIBLE) break;
  }
  return {
    mejor: { f: Math.floor(indice / zona.ancho), c: indice % zona.ancho },
    media: { f, c },
    area_m2: cantidad * zona.paso ** 2,
    sigma_m: Math.sqrt(varianza) * zona.paso,
  };
}

function ventanaProb(zona, f0, c0, ancho, alto) {
  return { datos: new Float64Array(ancho * alto), f0, c0, ancho, alto, anchoZona: zona.ancho, longitud: zona.ancho * zona.alto };
}

function probDensa(prob) {
  const densa = new Float64Array(prob.longitud);
  for (let f = 0; f < prob.alto; f++) {
    densa.set(prob.datos.subarray(f * prob.ancho, (f + 1) * prob.ancho), (prob.f0 + f) * prob.anchoZona + prob.c0);
  }
  return densa;
}

// Acepta la API densa original y la ventana compacta. Fuera del soporte: masa 0.
export function probabilidadEn(prob, i) {
  if (!Number.isInteger(i) || i < 0) return 0;
  if (prob instanceof Float64Array) return prob[i] ?? 0;
  if (i >= prob.longitud) return 0;
  const f = Math.floor(i / prob.anchoZona) - prob.f0, c = i % prob.anchoZona - prob.c0;
  return f >= 0 && f < prob.alto && c >= 0 && c < prob.ancho ? prob.datos[f * prob.ancho + c] : 0;
}

function grillaProb(zona, pesos, compacta = false) {
  if (!compacta) {
    const prob = new Float64Array(zona.ancho * zona.alto);
    for (const [i, p] of pesos) prob[i] = p;
    return prob;
  }
  let f0 = zona.alto, c0 = zona.ancho, f1 = -1, c1 = -1;
  for (const i of pesos.keys()) {
    const f = Math.floor(i / zona.ancho), c = i % zona.ancho;
    f0 = Math.min(f0, f); c0 = Math.min(c0, c); f1 = Math.max(f1, f); c1 = Math.max(c1, c);
  }
  const prob = pesos.size ? ventanaProb(zona, f0, c0, c1 - c0 + 1, f1 - f0 + 1) : ventanaProb(zona, 0, 0, 0, 0);
  for (const [i, p] of pesos) prob.datos[(Math.floor(i / zona.ancho) - f0) * prob.ancho + i % zona.ancho - c0] = p;
  return prob;
}

// Previa uniforme sobre centros de celda dentro del círculo (radio en metros).
// prob[i] es masa de probabilidad, suma 1; las celdas sin DTM quedan en 0.
// area_m2 cuenta el mínimo de celdas que reúne el 95 %, incluso en varios parches.
// Sin candidatas/compatibles: mejor = null, área 0 y error explícito.
// compacta conserva resolución y masas en una ventana, sin reservar toda la zona.
export function localizarPorPresion(zona, { zBase, dz, sigma, previa, compacta = false }) {
  validarZona(zona);
  numero(zBase, "Altura de la base");
  numero(dz, "Desnivel");
  numero(zBase + dz, "Altura estimada");
  numero(sigma, "Incertidumbre del desnivel", 0);
  numero(previa?.f, "Fila previa");
  numero(previa?.c, "Columna previa");
  numero(previa?.radio_m, "Radio previo", 0);
  const radio = previa.radio_m / zona.paso;
  const f0 = Math.max(0, Math.ceil(previa.f - radio)), c0 = Math.max(0, Math.ceil(previa.c - radio));
  const f1 = Math.min(zona.alto - 1, Math.floor(previa.f + radio)), c1 = Math.min(zona.ancho - 1, Math.floor(previa.c + radio));
  const prob = f1 < f0 || c1 < c0 ? ventanaProb(zona, 0, 0, 0, 0) : ventanaProb(zona, f0, c0, c1 - c0 + 1, f1 - f0 + 1);
  // La previa es uniforme: dos pasadas numéricas reemplazan los mapas de errores,
  // logaritmos y posterior. La resta del error mínimo conserva el mismo modelo.
  prob.datos.fill(-1);
  let minimo = Infinity, candidatas = 0;
  for (let f = f0; f <= f1; f++) {
    for (let c = c0; c <= c1; c++) {
      const i = f * zona.ancho + c;
      if (Math.hypot(f - previa.f, c - previa.c) > radio || !conDato(zona, i)) continue;
      const e = Math.abs(zona.elevacion[i] - (zBase + dz));
      prob.datos[(f - f0) * prob.ancho + c - c0] = e;
      minimo = Math.min(minimo, e); candidatas++;
    }
  }
  let suma = 0, maximo = 0, indice = -1;
  for (let k = 0; k < prob.datos.length; k++) {
    const e = prob.datos[k];
    const pena = sigma === 0 || e === minimo ? 0 : ((e - minimo) / sigma) * ((e + minimo) / sigma) / 2;
    const p = e < 0 || (sigma === 0 && e !== 0) ? 0 : Math.exp(-pena);
    prob.datos[k] = p; suma += p;
    if (p > maximo) { maximo = p; indice = k; }
  }
  for (let k = 0; k < prob.datos.length; k++) if (prob.datos[k] > 0) prob.datos[k] /= suma;
  let masa = 0, cantidad = 0, umbral95 = null;
  for (const p of prob.datos.filter((p) => p > 0).sort((a, b) => b - a)) {
    masa += p; cantidad++; umbral95 = p;
    if (masa >= MASA_CREDIBLE) break;
  }
  const mejor = indice < 0 ? null : { f: f0 + Math.floor(indice / prob.ancho), c: c0 + indice % prob.ancho };
  return {
    mejor, area_m2: cantidad * zona.paso ** 2, umbral95, prob: compacta ? prob : probDensa(prob),
    ...(indice < 0 ? { error: candidatas ? "sin_compatibles" : "sin_candidatas" } : {}),
  };
}

// Transición común a toda la grilla: rumbo desde el norte hacia el este.
// Gaussianas independientes de distancia y rumbo, linealizadas; varianza de
// cuantización paso²/12 por eje cuando hay ruido. Sin ruido: traslado bilineal.
function nucleoMovimiento(distancia, rumbo, paso, pasos, angular, corte) {
  const a = (rumbo % 360) * Math.PI / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const df = -distancia * cos / paso, dc = distancia * sin / paso;
  const longitudinal = (distancia * pasos / paso) ** 2;
  const transversal = (distancia * angular / paso) ** 2;
  const nucleo = [];
  if (longitudinal === 0 && transversal === 0) {
    const f0 = Math.floor(df), c0 = Math.floor(dc);
    for (let f = f0; f <= f0 + 1; f++) {
      for (let c = c0; c <= c0 + 1; c++) {
        const p = (1 - Math.abs(f - df)) * (1 - Math.abs(c - dc));
        if (p > 0) nucleo.push({ f, c, p });
      }
    }
    return nucleo;
  }
  const ff = longitudinal * cos ** 2 + transversal * sin ** 2 + 1 / 12;
  const cc = longitudinal * sin ** 2 + transversal * cos ** 2 + 1 / 12;
  const fc = (transversal - longitudinal) * cos * sin;
  const det = ff * cc - fc * fc;
  const rf = corte * Math.sqrt(ff), rc = corte * Math.sqrt(cc);
  let suma = 0;
  for (let f = Math.floor(df - rf); f <= Math.ceil(df + rf); f++) {
    for (let c = Math.floor(dc - rc); c <= Math.ceil(dc + rc); c++) {
      const x = f - df, y = c - dc;
      const d2 = (cc * x * x - 2 * fc * x * y + ff * y * y) / det;
      if (d2 > corte ** 2) continue;
      const p = Math.exp(-d2 / 2);
      nucleo.push({ f, c, p }); suma += p;
    }
  }
  if (!suma) throw new RangeError("El corte del ruido no alcanza ningún centro de celda; aumentá corte_sigma.");
  for (const v of nucleo) v.p /= suma;
  return nucleo;
}

function predecir(zona, pesos, nucleo) {
  const predicha = new Map();
  for (const [i, p] of pesos) {
    const f0 = Math.floor(i / zona.ancho), c0 = i % zona.ancho;
    for (const v of nucleo) {
      const f = f0 + v.f, c = c0 + v.c;
      if (f < 0 || c < 0 || f >= zona.alto || c >= zona.ancho) continue;
      const j = f * zona.ancho + c;
      if (conDato(zona, j)) predicha.set(j, (predicha.get(j) || 0) + p * v.p);
    }
  }
  return predicha;
}

// inicio = {f, c, zBase?}: posición conocida. Por defecto la base está en inicio.
// distancia_m es INCREMENTAL por lectura; rumbo en grados (0 norte, 90 este).
// Devuelve {trayectoria, prob}, con una entrada por lectura: mejor, media,
// area_m2 (95 %), sigma_m (RMS horizontal), dz y sigma (vertical).
// Conserva el posterior completo en una grilla dispersa, sin reemplazarlo por su MAP.
// prob final tiene resolución original. La trayectoria no implica transitabilidad.
// Si se pierde todo el soporte, devuelve error e índice de lectura, sin inventar posición.
// La opción compacta del quinto argumento evita expandir el posterior final.
export function filtroRecorrido(zona, inicio, lecturas, cfg, { compacta = false } = {}) {
  validarZona(zona);
  if (!celda(zona, inicio) || !conDato(zona, inicio.f * zona.ancho + inicio.c)) {
    throw new RangeError("Inicio inválido: elegí una celda con datos dentro de la zona.");
  }
  if (!Array.isArray(lecturas)) throw new TypeError("Lecturas inválidas: usá un arreglo.");
  const pasos = parametro(cfg, "sigma_pasos_fraccion");
  const angular = parametro(cfg, "sigma_rumbo_grados") * Math.PI / 180;
  const corte = parametro(cfg, "corte_sigma", true);
  const zBase = numero(inicio.zBase ?? zona.elevacion[inicio.f * zona.ancho + inicio.c], "Altura de la base");
  let pesos = new Map([[inicio.f * zona.ancho + inicio.c, 1]]);
  const trayectoria = [];
  for (let k = 0; k < lecturas.length; k++) {
    const lectura = lecturas[k];
    const d = numero(lectura?.distancia_m, "Distancia recorrida", 0);
    const rumbo = numero(lectura?.rumbo, "Rumbo");
    const { dz, sigma } = desnivel({ ...lectura, cfg });
    numero(zBase + dz, "Altura estimada");
    const nucleo = nucleoMovimiento(d, rumbo, zona.paso, pasos, angular, corte);
    const predicha = predecir(zona, pesos, nucleo);
    pesos = pesarAltura(zona, predicha, zBase + dz, sigma);
    if (!pesos.size) {
      return { trayectoria, prob: grillaProb(zona, pesos, compacta), error: predicha.size ? "sin_compatibles" : "fuera_de_mapa", lectura: k };
    }
    trayectoria.push({ ...resumen(zona, pesos), dz, sigma });
  }
  return { trayectoria, prob: grillaProb(zona, pesos, compacta) };
}
