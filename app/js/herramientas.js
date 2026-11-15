// Mediciones puras, sin DOM ni red. Esfera IAU 2000: R = 3.396.190 m,
// según ARQUITECTURA.md; no hay parámetros empíricos.
const RADIO = 3396190;
const RAD = Math.PI / 180;
const vuelta = (x) => { const r = x % 360; return r < 0 ? r + 360 : r === 0 ? 0 : r; };
const acotar = (x) => Math.max(-1, Math.min(1, x));

function coordenadas(lon, lat) {
  if (!Number.isFinite(lon) || lon < -180 || lon > 360
      || !Number.isFinite(lat) || Math.abs(lat) > 90) {
    throw new RangeError("Coordenadas inválidas: latitud entre −90 y 90°, longitud entre −180 y 360°.");
  }
}

// Distancia por el arco menor (m), con haversine acotada por redondeo.
export function distancia(lonA, latA, lonB, latB) {
  coordenadas(lonA, latA); coordenadas(lonB, latB);
  const a = latA * RAD, b = latB * RAD;
  const dl = (vuelta(lonB - lonA + 180) - 180) * RAD;
  const h = Math.sin((b - a) / 2) ** 2 + Math.cos(a) * Math.cos(b) * Math.sin(dl / 2) ** 2;
  return 2 * RADIO * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
}

// Grados desde el norte, en sentido horario. Coincidentes y antípodas: null.
export function rumbo(lonA, latA, lonB, latB) {
  coordenadas(lonA, latA); coordenadas(lonB, latB);
  const a = latA * RAD, b = latB * RAD;
  const dl = (vuelta(lonB - lonA + 180) - 180) * RAD;
  const x = Math.sin(dl) * Math.cos(b);
  const y = Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(dl);
  if (Math.hypot(x, y) <= 4 * Number.EPSILON) return null;
  return vuelta(Math.atan2(x, y) / RAD);
}

// Sigue un círculo máximo. Acepta cualquier rumbo finito y devuelve longitud este 0–360°.
export function destino(lon, lat, grados, metros) {
  coordenadas(lon, lat);
  if (!Number.isFinite(grados) || !Number.isFinite(metros) || metros < 0) {
    throw new RangeError("El rumbo debe ser finito y la distancia debe ser no negativa, en metros.");
  }
  if (metros === 0) return { lon: vuelta(lon), lat };
  const l = lon * RAD, p = lat * RAD, r = vuelta(grados) * RAD, d = metros / RADIO;
  const v = vector(lon, lat);
  const norte = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
  const este = [-Math.sin(l), Math.cos(l), 0];
  const fin = v.map((x, i) => x * Math.cos(d)
    + (norte[i] * Math.cos(r) + este[i] * Math.sin(r)) * Math.sin(d));
  return { lon: vuelta(Math.atan2(fin[1], fin[0]) / RAD), lat: Math.atan2(fin[2], Math.hypot(fin[0], fin[1])) / RAD };
}

function vector(lon, lat) {
  const l = lon * RAD, p = lat * RAD;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}
const producto = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cruz = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const restar = (a, b) => a.map((x, i) => x - b[i]);
const norma = (a) => Math.hypot(...a);
const unitario = (a) => { const n = norma(a); return a.map((x) => x / n); };

// Anillo simple, sin agujeros: [[lon, lat], ...] o [{lon, lat}, ...], cerrado o abierto.
// Bordes por arcos menores; devuelve la superficie menor, independiente del sentido.
// Chicos: proyección local de Lambert equivalente + cordones. Grandes: exceso esférico.
export function area(poligono) {
  if (!Array.isArray(poligono)) throw new TypeError("El polígono debe ser una lista de coordenadas.");
  const puntos = poligono.map((p) => {
    const lon = Array.isArray(p) ? p[0] : p?.lon, lat = Array.isArray(p) ? p[1] : p?.lat;
    coordenadas(lon, lat);
    return vector(lon, lat);
  });
  if (puntos.length < 3) return 0;
  const suma = puntos.reduce((s, p) => s.map((x, i) => x + p[i]), [0, 0, 0]);
  // Centro local; para anillos simétricos, normal de un borde no degenerado.
  let centro = norma(suma) > Number.EPSILON * puntos.length ? unitario(suma) : null;
  for (let i = 0; i < puntos.length; i++) {
    const a = puntos[i], b = puntos[(i + 1) % puntos.length];
    if (norma(cruz(a, b)) <= 4 * Number.EPSILON && producto(a, b) < 0) {
      throw new RangeError("Un borde entre antípodas no define un arco único.");
    }
    if (!centro && norma(cruz(a, b)) > 4 * Number.EPSILON) centro = unitario(cruz(a, b));
  }
  if (!centro) return 0;
  const este = unitario(Math.hypot(centro[0], centro[1]) > Number.EPSILON ? [-centro[1], centro[0], 0] : [1, 0, 0]);
  const norte = cruz(centro, este);
  const proyectados = puntos.map((p) => {
    const den = 1 + acotar(producto(centro, p));
    if (den <= Number.EPSILON) return null;
    const k = Math.sqrt(2 / den);
    return [k * producto(p, este), k * producto(p, norte)];
  });
  let exceso = 0, plano = 0;
  for (let i = 0; i < puntos.length; i++) {
    const j = (i + 1) % puntos.length, a = puntos[i], b = puntos[j];
    // Restar el centro evita cancelar productos casi iguales en polígonos pequeños.
    exceso += 2 * Math.atan2(producto(centro, cruz(restar(a, centro), restar(b, centro))),
      1 + producto(centro, a) + producto(a, b) + producto(b, centro));
    const p = proyectados[i], q = proyectados[j];
    if (p && q) plano += p[0] * q[1] - p[1] * q[0];
    else plano = NaN;
  }
  const esfera = 4 * Math.PI;
  const angular = Math.abs(exceso) % esfera;
  const esferica = Math.min(angular, esfera - angular);
  const local = Math.abs(plano) / 2;
  // La proyección solo se usa si coincide al menos a media precisión de coma flotante.
  // Es una tolerancia numérica derivada de EPSILON, no un umbral físico a calibrar.
  const usarLocal = Number.isFinite(local) && Math.abs(local - esferica) <= Math.sqrt(Number.EPSILON) * esferica;
  return (usarLocal ? local : esferica) * RADIO ** 2;
}

// Interpolación bilineal; los vecinos con peso cero no contaminan la muestra.
function interpolar(zona, capa, f, c, alto) {
  const f0 = Math.floor(f), c0 = Math.floor(c), df = f - f0, dc = c - c0;
  let valor = 0;
  for (const [fila, pf] of [[f0, 1 - df], [Math.min(f0 + 1, alto - 1), df]]) {
    for (const [col, pc] of [[c0, 1 - dc], [Math.min(c0 + 1, zona.ancho - 1), dc]]) {
      const peso = pf * pc;
      if (peso === 0) continue;
      const i = fila * zona.ancho + col;
      if ((zona.valido && !zona.valido[i]) || !Number.isFinite(capa[i])) return null;
      valor += peso * capa[i];
    }
  }
  return valor;
}

// Distancias horizontales y alturas en m; pendientes en grados, tal como vienen de la zona.
// {muestras, distancia, desnivel (fin−inicio), desnivel_total (subida+bajada), subida, bajada}.
// Siempre incluye ambos extremos. Si falta altura, los totales son null: no se unen huecos.
export function perfil(zona, a, b, paso_m) {
  if (!zona || !Number.isInteger(zona.ancho) || zona.ancho <= 0
      || !Number.isFinite(zona.paso) || zona.paso <= 0 || !zona.elevacion || !zona.pendiente) {
    throw new TypeError("La zona necesita ancho, paso positivo y capas de elevación y pendiente.");
  }
  const alto = zona.elevacion.length / zona.ancho;
  if (!Number.isInteger(alto) || alto <= 0 || zona.pendiente.length !== zona.elevacion.length
      || (zona.alto !== undefined && zona.alto !== alto)
      || (zona.valido && zona.valido.length !== zona.elevacion.length)) {
    throw new RangeError("Las dimensiones y las capas de la zona no coinciden.");
  }
  for (const p of [a, b]) {
    if (!p || !Number.isFinite(p.f) || !Number.isFinite(p.c) || p.f < 0 || p.c < 0 || p.f > alto - 1 || p.c > zona.ancho - 1) {
      throw new RangeError("Los extremos del perfil deben estar dentro de la grilla.");
    }
  }
  if (!Number.isFinite(paso_m) || paso_m <= 0) throw new RangeError("El paso de muestreo debe ser positivo, en metros.");
  const largo = Math.hypot(b.f - a.f, b.c - a.c) * zona.paso;
  const tramos = Math.ceil(largo / paso_m);
  if (!Number.isSafeInteger(tramos)) throw new RangeError("El paso de muestreo es demasiado pequeño.");
  const muestras = [];
  for (let k = 0; k <= tramos; k++) {
    const d = k === tramos ? largo : k * paso_m, t = largo ? d / largo : 0;
    const f = a.f * (1 - t) + b.f * t, c = a.c * (1 - t) + b.c * t;
    muestras.push({ d, altura: interpolar(zona, zona.elevacion, f, c, alto), pendiente: interpolar(zona, zona.pendiente, f, c, alto) });
  }
  let subida = 0, bajada = 0;
  const completo = muestras.every((m) => m.altura !== null);
  if (completo) {
    for (let k = 1; k < muestras.length; k++) {
      const dz = muestras[k].altura - muestras[k - 1].altura;
      if (dz > 0) subida += dz; else bajada -= dz;
    }
  }
  return {
    muestras, distancia: largo,
    desnivel: completo ? muestras.at(-1).altura - muestras[0].altura : null,
    desnivel_total: completo ? subida + bajada : null,
    subida: completo ? subida : null, bajada: completo ? bajada : null,
  };
}

// Precisión de presentación pedida: cinco decimales; la longitud se expresa siempre al este.
export function formatoCoordenadas(lat, lon) {
  coordenadas(lon, lat);
  const formato = (x) => x.toLocaleString(globalThis.document?.documentElement?.lang === "en" ? "en-US" : "es-UY", { minimumFractionDigits: 5, maximumFractionDigits: 5, useGrouping: false });
  const este = vuelta(lon);
  return `${formato(Math.abs(lat))}° ${lat < 0 ? "S" : "N"}, ${formato(este >= 360 - 0.5e-5 ? 0 : este)}° E`;
}

// Decimal con hemisferios o par lat, lon; también grados/minutos/segundos con N/S/E/O/W.
// Consume todo el texto, verifica los rangos y normaliza longitud a 0–360° este.
export function leerCoordenadas(texto) {
  if (typeof texto !== "string" || !texto.trim()) return null;
  const limpio = texto.trim().toUpperCase().replace(/[−–]/g, "-").replace(/[′’]/g, "'").replace(/[″”]/g, '"');
  const numero = "[+-]?(?:\\d+(?:[.,]\\d+)?|[.,]\\d+)";
  const componente = `(${numero})\\s*(?:°\\s*(?:(\\d+(?:[.,]\\d+)?)\\s*'\\s*(?:(\\d+(?:[.,]\\d+)?)\\s*\")?)?)?\\s*([NSEOW])`;
  const hemisferios = limpio.match(new RegExp(`^${componente}\\s*[,;]?\\s*${componente}$`));
  const valor = (x) => Number(x.replace(",", "."));
  let lat, lon;
  if (hemisferios) {
    const [, g1, m1, s1, h1, g2, m2, s2, h2] = hemisferios;
    if (!/[NS]/.test(h1) || !/[EOW]/.test(h2)) return null;
    const leer = (g, m, s, h) => {
      const grados = valor(g), minutos = m === undefined ? 0 : valor(m), segundos = s === undefined ? 0 : valor(s);
      if (!Number.isFinite(grados) || minutos >= 60 || segundos >= 60 || (m !== undefined && !Number.isInteger(grados))
          || (s !== undefined && !Number.isInteger(minutos))) return NaN;
      // Un signo explícito contrario al hemisferio se rechaza.
      const negativo = /[SOW]/.test(h);
      if ((g.startsWith("-") && !negativo) || (g.startsWith("+") && negativo)) return NaN;
      return (negativo ? -1 : 1) * (Math.abs(grados) + minutos / 60 + segundos / 3600);
    };
    lat = leer(g1, m1, s1, h1); lon = leer(g2, m2, s2, h2);
    // O/W permite hasta 360°, equivalentes a longitudes este 0–360°.
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 360) return null;
  } else {
    // La coma puede separar el par o ser decimal; el patrón exige dos números completos.
    const par = limpio.match(new RegExp(`^(${numero})\\s*(?:[,;]\\s*|\\s+)(${numero})$`));
    if (!par) return null;
    lat = valor(par[1]); lon = valor(par[2]);
    try { coordenadas(lon, lat); } catch { return null; }
  }
  return { lat: lat === 0 ? 0 : lat, lon: vuelta(lon) };
}
