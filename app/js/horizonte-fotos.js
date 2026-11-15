// Horizonte medido desde fotos Navcam de Curiosity: misma lógica que pipeline/horizonte.py.
// - camera_model_component_list = C;A;H;V;O;R (CAHVOR), ya referido a la foto publicada.
// - attitude = cuaternión (escalar primero) del marco del rover al marco del sitio (norte, este, abajo).
// Sin dependencias del navegador: recibe la foto ya convertida a grises (Float32Array).

const vector = (t) => String(t).replace(/[()]/g, "").split(",").map(Number);
const punto = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const resta = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const escala = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cruz = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function modeloCahvor(foto) {
  const p = foto.camera_model_component_list.split(";").map(vector);
  return { C: p[0], A: p[1], H: p[2], V: p[3], O: p[4], R: p[5] };
}

function proyectar(m, d) {
  const zeta = punto(d, m.O);
  const lam = resta(d, escala(m.O, zeta));
  const tau = punto(lam, lam) / (zeta * zeta);
  const mu = m.R[0] + m.R[1] * tau + m.R[2] * tau * tau;
  const dp = [d[0] + mu * lam[0], d[1] + mu * lam[1], d[2] + mu * lam[2]];
  const den = punto(dp, m.A);
  return [punto(dp, m.H) / den, punto(dp, m.V) / den];
}

function cahv(m, x, y) {
  let r = cruz(resta(m.V, escala(m.A, y)), resta(m.H, escala(m.A, x)));
  if (punto(r, m.A) < 0) r = escala(r, -1);
  const n = Math.hypot(...r);
  return escala(r, 1 / n);
}

// Dirección (marco del rover) del píxel (x, y), corrigiendo la distorsión radial por iteración.
export function rayo(m, x, y, iteraciones = 8) {
  let xx = x, yy = y;
  for (let k = 0; k < iteraciones; k++) {
    const [px, py] = proyectar(m, cahv(m, xx, yy));
    xx += x - px;
    yy += y - py;
  }
  return cahv(m, xx, yy);
}

export function rotar(q, v) {
  const w = q[0], qv = [q[1], q[2], q[3]];
  const t = escala(cruz(qv, v), 2);
  const c = cruz(qv, t);
  return [v[0] + w * t[0] + c[0], v[1] + w * t[1] + c[1], v[2] + w * t[2] + c[2]];
}

// Azimut (° desde el norte hacia el este) y elevación (°) de un píxel de la foto.
export function azEl(foto, m, x, y) {
  const d = rotar(vector(foto.attitude), rayo(m, x, y));
  const az = ((Math.atan2(d[1], d[0]) * 180) / Math.PI + 360) % 360;
  return [az, (Math.asin(-d[2]) * 180) / Math.PI];
}

// ---------- Filtros (equivalentes a scipy.ndimage.gaussian_filter con modo "reflect") ----------
function nucleo(sigma) {
  const r = Math.floor(4 * sigma + 0.5);
  const k = [];
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); s += v; }
  return { k: k.map((v) => v / s), r };
}

const reflejar = (i, n) => {
  while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - i - 1;
  return i;
};

export function gauss(img, ancho, alto, sigma) {
  const { k, r } = nucleo(sigma);
  const tmp = new Float64Array(ancho * alto), out = new Float64Array(ancho * alto);
  for (let f = 0; f < alto; f++) {
    for (let c = 0; c < ancho; c++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += k[j + r] * img[f * ancho + reflejar(c + j, ancho)];
      tmp[f * ancho + c] = s;
    }
  }
  for (let f = 0; f < alto; f++) {
    for (let c = 0; c < ancho; c++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += k[j + r] * tmp[reflejar(f + j, alto) * ancho + c];
      out[f * ancho + c] = s;
    }
  }
  return out;
}

// Percentil con interpolación lineal (como numpy.percentile).
function percentil(valores, p) {
  const v = Float64Array.from(valores).sort();
  if (!v.length) return NaN;
  const pos = (p / 100) * (v.length - 1), i = Math.floor(pos), t = pos - i;
  return i + 1 < v.length ? v[i] * (1 - t) + v[i + 1] * t : v[i];
}

// Fila del horizonte en cada columna y su contraste (−1 si la columna no es válida).
export function lineaCielo(gris, ancho, alto, saltoMax = 2, margen = 8) {
  const img = Float64Array.from(gris);
  for (let c = 0; c < ancho; c++) {
    img[c] = img[ancho + c] = img[2 * ancho + c];                        // primera fila saturada (artefacto)
    img[(alto - 1) * ancho + c] = img[(alto - 2) * ancho + c] = img[(alto - 3) * ancho + c];
  }
  const g = gauss(img, ancho, alto, 1.5);
  const k = 4;
  const contraste = new Float64Array(ancho * alto).fill(-1e9);
  for (let c = 0; c < ancho; c++) {
    for (let f = k; f < alto - k; f++) {
      let arriba = 0, abajo = 0;
      for (let j = 1; j <= k; j++) { arriba += g[(f - j) * ancho + c]; abajo += g[(f + j) * ancho + c]; }
      contraste[f * ancho + c] = (arriba - abajo) / k;
    }
  }
  const tex0 = new Float64Array(ancho * alto);
  for (let f = 0; f < alto; f++) {
    for (let c = 0; c < ancho; c++) {
      const i = f * ancho + c;
      tex0[i] = (c ? Math.abs(g[i] - g[i - 1]) : 0) + (f ? Math.abs(g[i] - g[i - ancho]) : 0);
    }
  }
  const textura = gauss(tex0, ancho, alto, 1.0);
  const banda = [];
  for (let f = margen; f < Math.min(alto, margen + Math.max(8, Math.floor(alto / 10))); f++) {
    for (let c = 0; c < ancho; c++) banda.push(textura[f * ancho + c]);
  }
  const ruido = percentil(banda, 90);
  const encima = new Float64Array(ancho * alto);
  for (let c = 0; c < ancho; c++) {
    let acum = 0;
    for (let f = 0; f < alto; f++) {
      encima[f * ancho + c] = acum;
      acum += Math.max(textura[f * ancho + c] - 2 * ruido, 0);
    }
  }
  const puntaje = new Float64Array(ancho * alto);
  for (let i = 0; i < puntaje.length; i++) {
    const f = Math.floor(i / ancho);
    puntaje[i] = f < margen || f >= alto - margen ? -1e9 : contraste[i] - 2 * encima[i];
  }

  // Programación dinámica: camino continuo (salto de a lo sumo 2 filas por columna) de mayor puntaje.
  let acum = new Float64Array(alto);
  for (let f = 0; f < alto; f++) acum[f] = puntaje[f * ancho];
  const desde = new Int32Array(ancho * alto);
  for (let c = 1; c < ancho; c++) {
    const nuevo = new Float64Array(alto);
    for (let f = 0; f < alto; f++) {
      let mejor = -Infinity, arg = f;
      for (let s = -saltoMax; s <= saltoMax; s++) {
        const fp = f - s;
        if (fp < 0 || fp >= alto) continue;
        if (acum[fp] > mejor) { mejor = acum[fp]; arg = fp; }
      }
      nuevo[f] = mejor + puntaje[f * ancho + c];
      desde[f * ancho + c] = arg;
    }
    acum = nuevo;
  }
  const fila = new Int32Array(ancho);
  let mejorF = 0;
  for (let f = 1; f < alto; f++) if (acum[f] > acum[mejorF]) mejorF = f;
  fila[ancho - 1] = mejorF;
  for (let c = ancho - 1; c > 0; c--) fila[c - 1] = desde[fila[c] * ancho + c];

  // Solo vale si arriba de la línea hay cielo liso de verdad (las fotos sin cielo se descartan).
  const con = new Float64Array(ancho);
  let validas = 0;
  for (let c = 0; c < ancho; c++) {
    const f = fila[c];
    con[c] = contraste[f * ancho + c];
    if (f < margen + 20 || f + 40 >= alto) { con[c] = -1; continue; }
    const arriba = [], abajo = [];
    for (let r = margen; r < f - 4; r++) arriba.push(textura[r * ancho + c]);
    for (let r = f + 6; r < f + 40; r++) abajo.push(textura[r * ancho + c]);
    if (!(percentil(arriba, 95) < 0.6 * percentil(abajo, 50))) con[c] = -1;
    if (con[c] > 0) validas++;
  }
  if (validas / ancho < 0.15) con.fill(-1);
  return { fila, contraste: con };
}

// Une los horizontes de varias fotos en un perfil 0–360° (mediana por intervalo de azimut).
// fotos: [{ foto (metadatos de NASA), gris (Float32Array), ancho, alto }]
// alAvanzar(fraccion, informe) recibe, por cada foto, la línea detectada y por qué se usó o no.
export function horizonteMedido(fotos, pasoGrados = 0.25, contrasteMin = 6, alAvanzar = () => {}) {
  const n = Math.round(360 / pasoGrados);
  const muestras = Array.from({ length: n }, () => []);
  const lineas = [];
  fotos.forEach((p, k) => {
    const { fila, contraste } = lineaCielo(p.gris, p.ancho, p.alto);
    const m = modeloCahvor(p.foto);
    let usadas = 0, azMin = 360, azMax = 0;
    const els = [], puntos = [];
    for (let c = 0; c < p.ancho; c++) {
      if (!(contraste[c] >= contrasteMin)) continue;
      const [az, el] = azEl(p.foto, m, c, fila[c]);
      muestras[Math.floor(az / pasoGrados) % n].push(el);
      usadas++;
      els.push(el);
      if (c % 8 === 0) puntos.push([az, el]);
      azMin = Math.min(azMin, az); azMax = Math.max(azMax, az);
    }
    const bordeSuperior = azEl(p.foto, m, p.ancho / 2, 0)[1];
    const motivo = usadas ? `${usadas} de ${p.ancho} columnas con cielo arriba de la línea`
      : bordeSuperior < -10 ? `descartada: apunta al suelo (borde superior a ${bordeSuperior.toFixed(1).replace(".", ",")}°)`
      : "descartada: no hay cielo liso arriba de ninguna línea";
    els.sort((a, b) => a - b);
    const linea = { fila: Array.from(fila), valida: Array.from(contraste, (v) => v >= contrasteMin), usadas };
    lineas.push(linea);
    alAvanzar((k + 1) / fotos.length, {
      k, imageid: p.foto.imageid, ancho: p.ancho, alto: p.alto, ...linea, motivo, bordeSuperior, puntos,
      azMin: usadas ? azMin : null, azMax: usadas ? azMax : null, elMediana: els.length ? els[els.length >> 1] : null,
    });
  });
  const mediana = (v) => { const s = [...v].sort((a, b) => a - b), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
  return {
    az: Array.from({ length: n }, (_, i) => (i + 0.5) * pasoGrados),
    el: muestras.map((m) => (m.length ? mediana(m) : NaN)),
    lineas,
  };
}

// Sol aproximado de una foto de Curiosity a partir del reloj de la nave que trae su nombre
// (NLB_843227140EDR_... → 843227140). Referencia: SCLK 847853302 en el sol 5073; 1 sol = 88775,244 s.
export function solAproximado(imageid) {
  const sclk = Number((imageid.match(/^[A-Z]{3}_(\d{9})/) || [])[1]);
  return Number.isFinite(sclk) ? Math.round(5073 + (sclk - 847853302) / 88775.244) : null;
}
