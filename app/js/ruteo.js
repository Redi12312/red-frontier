// Ruteo a pie sobre la grilla de la zona: A* con tiempo de marcha según la pendiente (Tobler)
// y penalizaciones por perfil. Sin dependencias del navegador: corre en un Worker y en Node.

const VECINOS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];

// Velocidad en m/s para una pendiente con signo (tan > 0 sube en el sentido de la marcha).
export function velocidad(tan, v) {
  return (v.v_max_kmh / 3.6) * v.factor_traje * Math.exp(-v.k * Math.abs(tan + v.d));
}

// Celdas prohibidas por los límites del traje y distancia (m) de cada celda a la prohibida más cercana.
// Un valor no finito (NaN) en altura, pendiente o rugosidad también prohíbe: sin dato no se pisa.
export function prepararGrilla(zona, traje) {
  const { ancho, alto, paso, pendiente, rugosidad, valido, elevacion } = zona;
  const n = ancho * alto;
  const limP = traje.pendiente_max_grados.valor;
  const limR = traje.rugosidad_max_cm.valor / 100;
  const prohibido = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!valido[i] || !(pendiente[i] <= limP) || !(rugosidad[i] <= limR) || (elevacion && elevacion[i] !== elevacion[i])) prohibido[i] = 1;
  }
  return { prohibido, distBorde: distanciaA(prohibido, ancho, alto, paso) };
}

// Transformada de distancia en dos pasadas (chaflán 3-4), en metros.
export function distanciaA(marca, ancho, alto, paso) {
  const INF = 1e9;
  const d = new Float32Array(ancho * alto);
  const a = paso, b = paso * Math.SQRT2;
  for (let i = 0; i < d.length; i++) d[i] = marca[i] ? 0 : INF;
  for (let f = 0; f < alto; f++) {
    for (let c = 0; c < ancho; c++) {
      const i = f * ancho + c;
      let v = d[i];
      if (c > 0) v = Math.min(v, d[i - 1] + a);
      if (f > 0) {
        v = Math.min(v, d[i - ancho] + a);
        if (c > 0) v = Math.min(v, d[i - ancho - 1] + b);
        if (c < ancho - 1) v = Math.min(v, d[i - ancho + 1] + b);
      }
      d[i] = v;
    }
  }
  for (let f = alto - 1; f >= 0; f--) {
    for (let c = ancho - 1; c >= 0; c--) {
      const i = f * ancho + c;
      let v = d[i];
      if (c < ancho - 1) v = Math.min(v, d[i + 1] + a);
      if (f < alto - 1) {
        v = Math.min(v, d[i + ancho] + a);
        if (c < ancho - 1) v = Math.min(v, d[i + ancho + 1] + b);
        if (c > 0) v = Math.min(v, d[i + ancho - 1] + b);
      }
      d[i] = v;
    }
  }
  return d;
}

// Multiplicador de costo de entrar a una celda según el perfil.
function penalizador(zona, grilla, traje, perfil) {
  const limP = traje.pendiente_max_grados.valor;
  const limR = traje.rugosidad_max_cm.valor / 100;
  const { pendiente, rugosidad, blando } = zona;
  const { distBorde } = grilla;
  const wp = perfil.peso_pendiente, wr = perfil.peso_rugosidad, wb = perfil.peso_borde;
  const ws = blando ? perfil.peso_blando || 0 : 0;
  // Cercanía a refugios: 0 junto a uno, 1 en el límite del regreso de emergencia. Las rutas prefieren ir cerca.
  const valor = (p) => p?.valor ?? p ?? 0;
  const cerca = grilla.cercania, wc = cerca ? valor(perfil.peso_refugio) : 0;
  const rescate = grilla.cercaniaRescate, wRes = rescate ? valor(perfil.peso_rescate) : 0;
  const eb = perfil.escala_borde_m;
  return (i) => {
    const p = pendiente[i] / limP;
    return 1 + wp * p * p + wr * (rugosidad[i] / limR) + wb * Math.exp(-distBorde[i] / eb) + (ws && blando[i] ? ws : 0) + (wc ? wc * cerca[i] : 0)
      + (wRes ? wRes * rescate[i] : 0);
  };
}

// Cola de prioridad mínima (montículo binario) con claves numéricas.
class Monticulo {
  constructor(cap = 1 << 16) {
    this.k = new Float64Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
  }
  poner(clave, valor) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= clave) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = clave; this.v[i] = valor;
  }
  sacar() {
    const top = this.v[0];
    const clave = this.k[--this.n], valor = this.v[this.n];
    let i = 0;
    for (;;) {
      let h = 2 * i + 1;
      if (h >= this.n) break;
      if (h + 1 < this.n && this.k[h + 1] < this.k[h]) h++;
      if (this.k[h] >= clave) break;
      this.k[i] = this.k[h]; this.v[i] = this.v[h]; i = h;
    }
    this.k[i] = clave; this.v[i] = valor;
    return top;
  }
}

// Vecinos en arreglos planos (mismo orden que VECINOS: no cambia los desempates).
const DF = [-1, 1, 0, 0, -1, -1, 1, 1], DC = [0, 0, -1, 1, -1, 1, -1, 1];

// Espacio de trabajo reutilizable. A* y Dijkstra limpian solo las celdas que tocaron, cada uno
// en sus propios búferes: un campo grande no obliga a limpiar g/desde antes de una ruta corta.
let trabajo = null;
function espacio(n) {
  if (!trabajo || trabajo.n !== n) {
    trabajo = { n, g: new Float32Array(n).fill(Infinity), desde: new Int32Array(n), cerrado: new Uint8Array(n),
      tocadas: new Int32Array(1 << 14), nt: 0, cola: new Monticulo() };
  } else {
    const { g, cerrado, tocadas, nt } = trabajo;
    for (let k = 0; k < nt; k++) { const i = tocadas[k]; g[i] = Infinity; cerrado[i] = 0; }
  }
  trabajo.nt = 0;
  trabajo.cola.n = 0;
  return trabajo;
}
function tocar(w, i) {
  if (w.nt === w.tocadas.length) { const t = new Int32Array(w.nt * 2); t.set(w.tocadas); w.tocadas = t; }
  w.tocadas[w.nt++] = i;
}

let trabajoCampo = null;
function espacioCampo(n) {
  if (!trabajoCampo || trabajoCampo.n !== n) {
    trabajoCampo = { n, cerrado: new Uint8Array(n), tocadas: new Int32Array(1 << 14), nt: 0, cola: new Monticulo() };
  } else {
    const { cerrado, tocadas, nt } = trabajoCampo;
    for (let k = 0; k < nt; k++) cerrado[tocadas[k]] = 0;
  }
  trabajoCampo.nt = 0;
  trabajoCampo.cola.n = 0;
  return trabajoCampo;
}
function tocarCampo(w, i) {
  if (w.nt === w.tocadas.length) { const t = new Int32Array(w.nt * 2); t.set(w.tocadas); w.tocadas = t; }
  w.tocadas[w.nt++] = i;
}

// Busca la ruta de menor costo entre dos celdas {f, c}. Devuelve null si no hay camino.
export function buscarRuta(zona, grilla, traje, perfil, inicio, fin) {
  const { ancho, alto, paso, elevacion } = zona;
  const { prohibido } = grilla;
  const vedado = (i) => prohibido[i] || (grilla.admite && !grilla.admite(i));
  const v = valoresVel(traje.velocidad);
  const vMax = velocidad(-v.d, v); // la mayor velocidad posible: mantiene admisible la heurística
  const pena = penalizador(zona, grilla, traje, perfil);
  const n = ancho * alto;
  const ini = inicio.f * ancho + inicio.c, meta = fin.f * ancho + fin.c;
  if (vedado(ini) || vedado(meta)) return { error: vedado(ini) ? "inicio" : "destino" };

  const w = espacio(n);
  const { g, desde, cerrado, cola } = w;
  const finF = fin.f, finC = fin.c, diagonal = paso * Math.SQRT2;
  const h = (i) => {
    const df = (((i / ancho) | 0) - finF) * paso, dc = ((i % ancho) - finC) * paso;
    return Math.sqrt(df * df + dc * dc) / vMax;
  };
  g[ini] = 0;
  desde[ini] = -1;
  tocar(w, ini);
  cola.poner(h(ini), ini);
  let explorados = 0;
  while (cola.n > 0) {
    const i = cola.sacar();
    if (cerrado[i]) continue;
    cerrado[i] = 1;
    explorados++;
    if (i === meta) break;
    const f = (i / ancho) | 0, c = i % ancho;
    for (let k = 0; k < 8; k++) {
      const ff = f + DF[k], cc = c + DC[k];
      if (ff < 0 || cc < 0 || ff >= alto || cc >= ancho) continue;
      const j = ff * ancho + cc;
      if (cerrado[j] || vedado(j)) continue;
      if (k > 3 && (vedado(f * ancho + cc) || vedado(ff * ancho + c))) continue; // no cortar esquinas
      const dist = k > 3 ? diagonal : paso;
      const t = dist / velocidad((elevacion[j] - elevacion[i]) / dist, v);
      const nuevo = g[i] + t * pena(j);
      if (nuevo < g[j]) {
        if (g[j] === Infinity) tocar(w, j);
        g[j] = nuevo;
        desde[j] = i;
        cola.poner(nuevo + h(j), j);
      }
    }
  }
  if (!cerrado[meta]) return { error: "sin_camino", explorados };

  const celdas = [];
  for (let i = meta; i !== -1; i = desde[i]) celdas.push(i);
  celdas.reverse();
  return { celdas, explorados, ...resumen(zona, traje, celdas) };
}

export function valoresVel(vel) {
  return { v_max_kmh: vel.v_max_kmh.valor, k: vel.k.valor, d: vel.d.valor, factor_traje: vel.factor_traje.valor };
}

// Distancia, desnivel, tiempo de marcha puro (sin penalizaciones) y peores valores del tramo.
export function resumen(zona, traje, celdas) {
  const { ancho, paso, elevacion, pendiente, rugosidad, blando } = zona;
  const v = valoresVel(traje.velocidad);
  let distancia = 0, sube = 0, baja = 0, tiempo = 0, pendMax = 0, rugMax = 0, blandoM = 0;
  const perfilAltura = [{ d: 0, z: elevacion[celdas[0]] }];
  for (let k = 1; k < celdas.length; k++) {
    const i = celdas[k - 1], j = celdas[k];
    const diag = (i % ancho) !== (j % ancho) && ((i / ancho) | 0) !== ((j / ancho) | 0);
    const dist = diag ? paso * Math.SQRT2 : paso;
    const dz = elevacion[j] - elevacion[i];
    distancia += dist;
    if (dz > 0) sube += dz; else baja -= dz;
    tiempo += dist / velocidad(dz / dist, v);
    pendMax = Math.max(pendMax, pendiente[j]);
    rugMax = Math.max(rugMax, rugosidad[j]);
    if (blando && blando[j]) blandoM += dist;
    perfilAltura.push({ d: distancia, z: elevacion[j] });
  }
  return { distancia, sube, baja, tiempo, pendMax, rugMax, blandoM: blando ? blandoM : null, perfilAltura };
}

// Celdas alcanzables a pie desde `inicio`, con las mismas reglas que buscarRuta (8 vecinos, sin cortar esquinas).
export function regionAlcanzable(zona, grilla, inicio) {
  const { ancho, alto } = zona;
  const { prohibido } = grilla;
  const region = new Uint8Array(ancho * alto);
  const i0 = inicio.f * ancho + inicio.c;
  if (prohibido[i0]) return { region, celdas: 0 };
  const cola = new Int32Array(ancho * alto);
  let a = 0, b = 0;
  cola[b++] = i0; region[i0] = 1;
  while (a < b) {
    const i = cola[a++];
    const f = (i / ancho) | 0, c = i % ancho;
    for (const [df, dc] of VECINOS) {
      const ff = f + df, cc = c + dc;
      if (ff < 0 || cc < 0 || ff >= alto || cc >= ancho) continue;
      const j = ff * ancho + cc;
      if (region[j] || prohibido[j]) continue;
      if (df && dc && (prohibido[f * ancho + cc] || prohibido[ff * ancho + c])) continue;
      region[j] = 1;
      cola[b++] = j;
    }
  }
  return { region, celdas: b };
}

// Celda de `region` más cercana a {f, c}, buscando en anillos hasta `radioMax` celdas.
export function celdaMasCercana(region, ancho, alto, f0, c0, radioMax) {
  if (region[f0 * ancho + c0]) return { f: f0, c: c0, d: 0 };
  for (let r = 1; r <= radioMax; r++) {
    let mejor = null, mejorD = Infinity;
    for (let df = -r; df <= r; df++) {
      for (const dc of Math.abs(df) === r ? range(-r, r) : [-r, r]) {
        const f = f0 + df, c = c0 + dc;
        if (f < 0 || c < 0 || f >= alto || c >= ancho || !region[f * ancho + c]) continue;
        const d = Math.hypot(df, dc);
        if (d < mejorD) { mejorD = d; mejor = { f, c, d }; }
      }
    }
    if (mejor) return mejor;
  }
  return null;
}

function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }

// Tiempo (s) para llegar desde cada celda hasta `destino` por el mejor camino (Dijkstra hacia atrás).
// Sirve para el regreso de emergencia y el rescate: el sentido de la marcha es celda → destino.
// `destino` puede ser una celda o una lista (varios refugios: vale el más cercano en tiempo).
// opciones: pendienteMax (°, celdas más empinadas no se pisan), factor (multiplica la velocidad),
// limite (s: no se explora más allá; las celdas más lejanas quedan en Infinity).
export function campoTiempo(zona, prohibido, vel, destino, { pendienteMax = Infinity, factor = 1, limite = Infinity } = {}) {
  const { ancho, alto, paso, elevacion, pendiente } = zona;
  const v = vel.v_max_kmh !== undefined && typeof vel.v_max_kmh === "object" ? valoresVel(vel) : vel;
  const n = ancho * alto;
  // La salida densa es independiente: regreso y rescate se retienen a la vez. Su inicialización
  // es parte del contrato Float32Array (Infinity fuera del campo); los búferes internos se reutilizan.
  const T = new Float32Array(n).fill(Infinity);
  const origenes = (Array.isArray(destino) ? destino : [destino]).map((d) => d.f * ancho + d.c).filter((i) => !prohibido[i]);
  if (!origenes.length) return T;
  const w = espacioCampo(n);
  const { cerrado, cola } = w;
  const diagonal = paso * Math.SQRT2;
  for (const i0 of origenes) { if (T[i0] !== 0) tocarCampo(w, i0); T[i0] = 0; cola.poner(0, i0); }
  const libre = (j) => !prohibido[j] && pendiente[j] <= pendienteMax;
  while (cola.n > 0) {
    const i = cola.sacar();
    if (cerrado[i]) continue;
    cerrado[i] = 1;
    const ti = T[i];
    if (ti > limite) break;
    const f = (i / ancho) | 0, c = i % ancho;
    for (let k = 0; k < 8; k++) {
      const ff = f + DF[k], cc = c + DC[k];
      if (ff < 0 || cc < 0 || ff >= alto || cc >= ancho) continue;
      const j = ff * ancho + cc;
      if (cerrado[j] || !libre(j)) continue;
      if (k > 3 && (!libre(f * ancho + cc) || !libre(ff * ancho + c))) continue;
      const dist = k > 3 ? diagonal : paso;
      const t = ti + dist / (velocidad((elevacion[i] - elevacion[j]) / dist, v) * factor);
      if (t < T[j]) {
        if (T[j] === Infinity) tocarCampo(w, j);
        T[j] = t;
        cola.poner(t, j);
      }
    }
  }
  // Solo las celdas tocadas pueden haber quedado más allá del límite.
  if (limite < Infinity) for (let k = 0; k < w.nt; k++) if (T[w.tocadas[k]] > limite) T[w.tocadas[k]] = Infinity;
  return T;
}

// Camino de vuelta desde `inicio` bajando por un campo de tiempo (el de regreso o el de rescate) hasta
// llegar a 0, es decir, al refugio más cercano. Devuelve las celdas, o null si desde ahí no hay regreso.
// Usa las MISMAS reglas que campoTiempo (8 vecinos, sin cortar esquinas, celdas libres):
// opciones.prohibido: la máscara con la que se calculó el campo; pendienteMax: la del campo de rescate.
// Sin `prohibido` se toma por bloqueada toda celda sin tiempo finito (exacto si el campo no tiene límite).
// Con `vel` (y `factor`) se elige el vecino que minimiza tiempo del vecino + tiempo del paso: es el camino
// con el que se calculó el campo, así que su duración coincide con la que usa la decisión.
export function bajarCampo(zona, T, inicio, { prohibido = null, pendienteMax = Infinity, vel = null, factor = 1 } = {}) {
  const { ancho, alto, paso, elevacion, pendiente } = zona;
  const v = vel ? (typeof vel.v_max_kmh === "object" ? valoresVel(vel) : vel) : null;
  const libre = prohibido ? (j) => !prohibido[j] && pendiente[j] <= pendienteMax : (j) => T[j] < Infinity;
  const diagonal = paso * Math.SQRT2;
  let i = inicio.f * ancho + inicio.c;
  if (!Number.isFinite(T[i])) return null;
  const celdas = [i];
  for (let n = 0; T[i] > 0 && n < ancho * alto; n++) {
    const f = (i / ancho) | 0, c = i % ancho;
    let mejor = -1, mejorT = Infinity;
    for (let k = 0; k < 8; k++) {
      const ff = f + DF[k], cc = c + DC[k];
      if (ff < 0 || cc < 0 || ff >= alto || cc >= ancho) continue;
      const j = ff * ancho + cc;
      if (!(T[j] < T[i]) || !libre(j)) continue;
      if (k > 3 && (!libre(f * ancho + cc) || !libre(ff * ancho + c))) continue; // no cortar esquinas
      let t = T[j];
      if (v) { const dist = k > 3 ? diagonal : paso; t += dist / (velocidad((elevacion[j] - elevacion[i]) / dist, v) * factor); }
      if (t < mejorT) { mejorT = t; mejor = j; }
    }
    if (mejor < 0) return null; // sin paso válido hacia el refugio: el camino se rechaza, no se inventa
    i = mejor;
    celdas.push(i);
  }
  return T[i] === 0 ? celdas : null;
}

// Tiempo acumulado de ida en cada punto de la ruta (s), con la velocidad del vehículo.
export function tiemposIda(zona, vel, celdas) {
  const { ancho, paso, elevacion } = zona;
  const v = valoresVel(vel);
  const t = new Float64Array(celdas.length);
  for (let k = 1; k < celdas.length; k++) {
    const i = celdas[k - 1], j = celdas[k];
    const diag = (i % ancho) !== (j % ancho) && ((i / ancho) | 0) !== ((j / ancho) | 0);
    const dist = diag ? paso * Math.SQRT2 : paso;
    t[k] = t[k - 1] + dist / velocidad((elevacion[j] - elevacion[i]) / dist, v);
  }
  return t;
}
