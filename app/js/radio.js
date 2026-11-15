// Cobertura geométrica modelada, sin refracción ni presupuesto de enlace RF.
// R2 discreto: rayos de Bresenham al perímetro, O(r²), sin rayo independiente por celda.
// El relieve se representa por centros de celda: el borde de una sombra tiene error de grilla.

const cacheCobertura = new WeakMap();

// El DTM cargado es inmutable. Si se edita en el lugar, invalidar explícitamente
// o incrementar zona.versionTerreno; reemplazar sus arreglos invalida solo.
export function invalidarCacheRadio(zona) {
  cacheCobertura.delete(zona);
}

function estadoCobertura(zona) {
  let estado = cacheCobertura.get(zona);
  const { ancho, alto, paso, elevacion, valido, versionTerreno } = zona;
  if (!estado || estado.ancho !== ancho || estado.alto !== alto || estado.paso !== paso
    || estado.elevacion !== elevacion || estado.valido !== valido || estado.versionTerreno !== versionTerreno) {
    let datos = 0;
    for (let i = 0; i < valido.length; i++) if (conDato(zona, i)) datos++;
    estado = { ancho, alto, paso, elevacion, valido, versionTerreno, datos, antenas: new Map(), bytes: 0, union: null };
    cacheCobertura.set(zona, estado);
  }
  return estado;
}

function claveAntena(origen, p) {
  return `${origen.f},${origen.c}|${p.altura}|${p.receptor}|${p.alcance}|${p.radio}`;
}

function bitsAntena(zona, origen, p, estado, clave) {
  let bits = estado.antenas.get(clave);
  if (bits) {
    estado.antenas.delete(clave); estado.antenas.set(clave, bits);
    return bits;
  }
  const n = zona.ancho * zona.alto;
  bits = new Uint32Array(Math.ceil(n / 32));
  barrer(zona, origen, p, (i) => { bits[i >>> 5] |= 1 << (i & 31); });
  // Presupuesto derivado: las antenas retenidas ocupan como máximo una máscara
  // Uint8 de la zona (sin umbral operativo ni crecimiento con pedidos históricos).
  while (estado.bytes + bits.byteLength > n && estado.antenas.size) {
    const primera = estado.antenas.keys().next().value;
    estado.bytes -= estado.antenas.get(primera).byteLength;
    estado.antenas.delete(primera);
  }
  if (bits.byteLength <= n) {
    estado.antenas.set(clave, bits); estado.bytes += bits.byteLength;
  }
  return bits;
}

function unirAntenas(zona, antenas) {
  const estado = estadoCobertura(zona);
  const claves = antenas.map(({ origen, p }) => claveAntena(origen, p));
  const firma = [...new Set(claves)].sort().join(";");
  if (estado.union?.firma === firma) {
    return { visible: estado.union.visible.slice(), fraccion: estado.union.fraccion };
  }
  const n = zona.ancho * zona.alto, union = new Uint32Array(Math.ceil(n / 32));
  antenas.forEach(({ origen, p }, k) => {
    const bits = bitsAntena(zona, origen, p, estado, claves[k]);
    for (let i = 0; i < union.length; i++) union[i] |= bits[i];
  });
  const visible = new Uint8Array(n);
  let vistas = 0;
  for (let i = 0; i < n; i++) { visible[i] = (union[i >>> 5] >>> (i & 31)) & 1; vistas += visible[i]; }
  const fraccion = estado.datos ? vistas / estado.datos : 0;
  estado.union = { firma, visible, fraccion };
  // Nunca se expone la máscara retenida: el llamador puede modificar/transferir la suya.
  return { visible: visible.slice(), fraccion };
}

function parametro(cfg, nombre) {
  const x = cfg?.[nombre]?.valor ?? cfg?.[nombre];
  if (!Number.isFinite(x) || x < 0) throw new Error(`Parámetro de radio inválido: ${nombre}.`);
  return x;
}

function validarZona(zona) {
  const { ancho, alto, paso, elevacion, valido } = zona ?? {};
  if (!Number.isSafeInteger(ancho) || !Number.isSafeInteger(alto) || ancho < 1 || alto < 1
    || !Number.isFinite(paso) || paso <= 0 || elevacion?.length !== ancho * alto
    || valido?.length !== ancho * alto) throw new Error("La grilla de radio no es válida.");
}

function conDato(zona, i) {
  return !!zona.valido[i] && Number.isFinite(zona.elevacion[i]);
}

function validarOrigen(zona, origen) {
  if (!Number.isInteger(origen?.f) || !Number.isInteger(origen?.c)
    || origen.f < 0 || origen.f >= zona.alto || origen.c < 0 || origen.c >= zona.ancho
    || !conDato(zona, origen.f * zona.ancho + origen.c)) {
    throw new Error("La antena tiene que estar en una celda con altura válida.");
  }
}

function parametrosCobertura(cfg, altura) {
  const radio = parametro(cfg, "radio_m");
  if (radio === 0) throw new Error("El radio de Marte tiene que ser positivo.");
  return { altura, receptor: parametro(cfg, "altura_radio_m"), alcance: parametro(cfg, "alcance_max_m"), radio };
}

// registrar recibe celdas visibles; puede recibir la misma más de una vez.
// Un hueco del DTM corta el rayo: no se supone terreno plano donde faltan datos.
function barrer(zona, origen, p, registrar) {
  const { ancho, alto, paso, elevacion } = zona;
  const { f: f0, c: c0 } = origen;
  const z0 = elevacion[f0 * ancho + c0] + p.altura;
  const r = Math.ceil(p.alcance / paso);
  const fMin = Math.max(0, f0 - r), fMax = Math.min(alto - 1, f0 + r);
  const cMin = Math.max(0, c0 - r), cMax = Math.min(ancho - 1, c0 + r);
  const alcance2 = p.alcance * p.alcance;
  registrar(f0 * ancho + c0);

  function rayo(ff, cc) {
    let f = f0, c = c0, horizonte = -Infinity;
    const df = Math.abs(ff - f0), dc = Math.abs(cc - c0);
    const sf = Math.sign(ff - f0), sc = Math.sign(cc - c0);
    let error = dc - df;
    while (f !== ff || c !== cc) {
      const doble = 2 * error;
      if (doble > -df) { error -= df; c += sc; }
      if (doble < dc) { error += dc; f += sf; }
      const d2 = ((f - f0) ** 2 + (c - c0) ** 2) * paso * paso;
      if (d2 > alcance2) break;
      const i = f * ancho + c;
      if (!conDato(zona, i)) break;
      const d = Math.sqrt(d2);
      const suelo = (elevacion[i] - z0 - d2 / (2 * p.radio)) / d;
      if (suelo + p.receptor / d >= horizonte) registrar(i);
      // El casco del receptor no es un obstáculo para los puntos siguientes.
      horizonte = Math.max(horizonte, suelo);
    }
  }

  // En grillas de una sola fila/columna bastan dos rayos (evita O(r²) en 1D).
  if (fMin === fMax) { rayo(fMin, cMin); rayo(fMax, cMax); return; }
  if (cMin === cMax) { rayo(fMin, cMin); rayo(fMax, cMax); return; }
  for (let c = cMin; c <= cMax; c++) { rayo(fMin, c); rayo(fMax, c); }
  for (let f = fMin + 1; f < fMax; f++) { rayo(f, cMin); rayo(f, cMax); }
}

// fraccion: celdas visibles / celdas con altura válida de toda la zona.
export function cobertura(zona, origen, cfg) {
  validarZona(zona);
  validarOrigen(zona, origen);
  const p = parametrosCobertura(cfg, parametro(cfg, "altura_base_m"));
  return unirAntenas(zona, [{ origen, p }]);
}

// Primera antena: base; siguientes: balizas. tipo: "base" | "baliza" lo sobreescribe.
// Es la unión geométrica; el llamador debe garantizar el enlace entre las antenas.
export function coberturaVarias(zona, origenes, cfg) {
  validarZona(zona);
  if (!Array.isArray(origenes)) throw new Error("Indicá una lista de antenas.");
  const antenas = origenes.map((origen, k) => {
    validarOrigen(zona, origen);
    const tipo = origen.tipo ?? (k === 0 ? "base" : "baliza");
    if (tipo !== "base" && tipo !== "baliza") throw new Error("Tipo de antena desconocido.");
    const altura = parametro(cfg, tipo === "base" ? "altura_base_m" : "altura_baliza_m");
    return { origen, p: parametrosCobertura(cfg, altura) };
  });
  return unirAntenas(zona, antenas);
}

function validarVisible(zona, visible) {
  if (visible?.length !== zona.ancho * zona.alto) throw new Error("La cobertura no coincide con la grilla.");
}

function distanciasRuta(zona, ruta, tiempos) {
  if (!ruta || typeof ruta.length !== "number") throw new Error("La ruta no es válida.");
  if (tiempos != null && tiempos.length !== ruta.length) throw new Error("Faltan tiempos acumulados de la ruta.");
  const distancias = new Float64Array(ruta.length);
  for (let k = 0; k < ruta.length; k++) {
    const i = ruta[k];
    if (!Number.isInteger(i) || i < 0 || i >= zona.ancho * zona.alto) throw new Error("La ruta sale de la grilla.");
    if (tiempos != null && (!Number.isFinite(tiempos[k]) || tiempos[k] < 0
      || (k && tiempos[k] < tiempos[k - 1]))) throw new Error("Los tiempos tienen que ser finitos y acumulados.");
    if (!k) continue;
    const j = ruta[k - 1];
    const df = Math.abs(Math.floor(i / zona.ancho) - Math.floor(j / zona.ancho));
    const dc = Math.abs(i % zona.ancho - j % zona.ancho);
    if (df > 1 || dc > 1) throw new Error("La ruta tiene celdas que no son contiguas.");
    distancias[k] = distancias[k - 1] + Math.hypot(df, dc) * zona.paso;
  }
  return distancias;
}

// Conservador: un segmento sin ambos extremos cubiertos se cuenta entero sin enlace.
// Un punto cubierto separa dos cortes. Sin tiempos, minutos se omite y max_minutos es null.
export function tramosSinCobertura(zona, visible, ruta, tiempos_s) {
  validarZona(zona);
  validarVisible(zona, visible);
  const d = distanciasRuta(zona, ruta, tiempos_s);
  const cubierto = (k) => !!visible[ruta[k]] && conDato(zona, ruta[k]);
  const tramos = [];
  let inicio = null;
  function cerrar(fin) {
    const tramo = { desde_m: d[inicio], hasta_m: d[fin] };
    if (tiempos_s != null) tramo.minutos = (tiempos_s[fin] - tiempos_s[inicio]) / 60;
    tramos.push(tramo);
    inicio = null;
  }
  for (let k = 1; k < ruta.length; k++) {
    if (cubierto(k - 1) && cubierto(k)) continue;
    if (inicio === null) inicio = k - 1;
    if (cubierto(k)) cerrar(k);
  }
  if (inicio !== null) cerrar(ruta.length - 1);
  const max_minutos = tiempos_s == null ? null : tramos.reduce((max, t) => Math.max(max, t.minutos), 0);
  return { tramos, max_minutos };
}

// Búsqueda exhaustiva cerca de la ruta, con poda por alcance (cota sin obstáculos).
// Solo propone celdas ya enlazadas, transitables y con datos. Devuelve {f,c,metros} o null.
// metros: segmentos antes sin enlace cuyos DOS extremos quedarían cubiertos por la unión.
export function sugerirBaliza(zona, visible, ruta, cfg) {
  validarZona(zona);
  validarVisible(zona, visible);
  const d = distanciasRuta(zona, ruta);
  const radioBusqueda = parametro(cfg, "radio_busqueda_baliza_m");
  const pendienteMax = parametro(cfg, "pendiente_max_grados");
  const rugosidadMax = parametro(cfg, "rugosidad_max_m");
  const p = parametrosCobertura(cfg, parametro(cfg, "altura_baliza_m"));
  const n = zona.ancho * zona.alto;
  if (zona.pendiente?.length !== n || zona.rugosidad?.length !== n) {
    throw new Error("Faltan pendiente y rugosidad para instalar la baliza.");
  }
  const cubierto = (i) => !!visible[i] && conDato(zona, i);
  const segmentos = [];
  const objetivos = new Set();
  for (let k = 1; k < ruta.length; k++) {
    const a = ruta[k - 1], b = ruta[k], metros = d[k] - d[k - 1];
    if (metros && (!cubierto(a) || !cubierto(b))) {
      segmentos.push({ a, b, metros });
      if (!cubierto(a)) objetivos.add(a);
      if (!cubierto(b)) objetivos.add(b);
    }
  }
  if (!segmentos.length) return null;
  const candidatos = new Set();
  const r = Math.floor(radioBusqueda / zona.paso);
  for (const i of new Set(ruta)) {
    const f0 = Math.floor(i / zona.ancho), c0 = i % zona.ancho;
    for (let f = Math.max(0, f0 - r); f <= Math.min(zona.alto - 1, f0 + r); f++) {
      for (let c = Math.max(0, c0 - r); c <= Math.min(zona.ancho - 1, c0 + r); c++) {
        if (Math.hypot(f - f0, c - c0) * zona.paso > radioBusqueda) continue;
        const j = f * zona.ancho + c;
        if (cubierto(j) && !zona.prohibido?.[j]
          && Number.isFinite(zona.pendiente[j]) && zona.pendiente[j] <= pendienteMax
          && Number.isFinite(zona.rugosidad[j]) && zona.rugosidad[j] <= rugosidadMax) candidatos.add(j);
      }
    }
  }
  const distancia2 = (i, j) => ((Math.floor(i / zona.ancho) - Math.floor(j / zona.ancho)) ** 2
    + (i % zona.ancho - j % zona.ancho) ** 2) * zona.paso ** 2;
  const alcance2 = p.alcance ** 2;
  const ordenados = [];
  for (const i of candidatos) {
    let cota = 0;
    for (const { a, b, metros } of segmentos) {
      if ((cubierto(a) || distancia2(i, a) <= alcance2)
        && (cubierto(b) || distancia2(i, b) <= alcance2)) cota += metros;
    }
    if (cota) ordenados.push({ i, cota });
  }
  ordenados.sort((a, b) => b.cota - a.cota || a.i - b.i);
  let mejor = null, max = 0;
  for (const { i, cota } of ordenados) {
    if (cota <= max) break;
    const origen = { f: Math.floor(i / zona.ancho), c: i % zona.ancho };
    const nuevas = new Set();
    barrer(zona, origen, p, (j) => { if (objetivos.has(j)) nuevas.add(j); });
    let metros = 0;
    for (const s of segmentos) {
      if ((cubierto(s.a) || nuevas.has(s.a)) && (cubierto(s.b) || nuevas.has(s.b))) metros += s.metros;
    }
    if (metros > max) { max = metros; mejor = { ...origen, metros }; }
  }
  return mejor;
}
