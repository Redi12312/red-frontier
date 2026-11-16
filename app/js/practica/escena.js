// Escena low-poly del modo práctica: terreno real (DTM HiRISE), cielo, bases, ruta con balizas, rocas,
// y el cuerpo del astronauta (brazos, guantes y herramientas) en espacio de cámara.
import { Malla, subirMalla } from "./gl.js";

// Azar reproducible.
export function azarSemilla(s) {
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Terreno: alturas en metros respecto del hábitat; x este, y norte (en el mundo: X = x, Z = −y).
export function crearTerreno(info, buf) {
  const { ancho, alto, paso_m: paso, x0, y0 } = info;
  const n = ancho * alto;
  const alt16 = new Int16Array(buf, 0, n);
  const bytes = new Uint8Array(buf, n * 2);
  const h = new Float32Array(n);
  for (let i = 0; i < n; i++) h[i] = alt16[i] / 10;
  const pend = bytes.subarray(0, n), rug = bytes.subarray(n, 2 * n), vedado = bytes.subarray(2 * n, 3 * n);
  const celda = (x, y) => ({ q: (x - x0) / paso, r: (y0 - y) / paso });
  const altura = (x, y) => {
    const { q, r } = celda(x, y);
    const q0 = Math.max(0, Math.min(ancho - 2, Math.floor(q))), r0 = Math.max(0, Math.min(alto - 2, Math.floor(r)));
    const fq = Math.max(0, Math.min(1, q - q0)), fr = Math.max(0, Math.min(1, r - r0));
    const a = h[r0 * ancho + q0], b = h[r0 * ancho + q0 + 1], c = h[(r0 + 1) * ancho + q0], d = h[(r0 + 1) * ancho + q0 + 1];
    return (a * (1 - fq) + b * fq) * (1 - fr) + (c * (1 - fq) + d * fq) * fr;
  };
  const indice = (x, y) => {
    const { q, r } = celda(x, y);
    const qi = Math.round(q), ri = Math.round(r);
    return qi < 0 || ri < 0 || qi >= ancho || ri >= alto ? -1 : ri * ancho + qi;
  };
  const dentro = (x, y, margen = 20) => x > x0 + margen && x < x0 + (ancho - 1) * paso - margen && y < y0 - margen && y > y0 - (alto - 1) * paso + margen;
  return { ancho, alto, paso, x0, y0, h, pend, rug, vedado, altura, indice, dentro };
}

// Malla del terreno con color por vértice: tono marciano modulado por el orto HiRISE y la pendiente.
export function mallaTerreno(gl, t, brillo) {
  const { ancho, alto, paso, x0, y0, h, pend } = t;
  const pos = new Float32Array(ancho * alto * 3), col = new Float32Array(ancho * alto * 4);
  for (let r = 0; r < alto; r++) for (let q = 0; q < ancho; q++) {
    const i = r * ancho + q;
    pos[i * 3] = x0 + q * paso; pos[i * 3 + 1] = h[i]; pos[i * 3 + 2] = -(y0 - r * paso);
    const b = brillo ? brillo[i] : 0.5;
    const p = Math.min(1, pend[i] / 2 / 25);
    const k = 0.55 + 0.75 * b;
    col[i * 4] = Math.min(1, (0.72 - 0.12 * p) * k);
    col[i * 4 + 1] = Math.min(1, (0.42 - 0.1 * p) * k);
    col[i * 4 + 2] = Math.min(1, (0.27 - 0.06 * p) * k);
    col[i * 4 + 3] = 0;
  }
  const idx = new Uint32Array((ancho - 1) * (alto - 1) * 6);
  let k = 0;
  for (let r = 0; r < alto - 1; r++) for (let q = 0; q < ancho - 1; q++) {
    const a = r * ancho + q, b = a + 1, c = a + ancho, d = c + 1;
    // Diagonal alternada para que se note el facetado low-poly.
    if ((q + r) & 1) { idx.set([a, c, b, b, c, d], k); } else { idx.set([a, c, d, a, d, b], k); }
    k += 6;
  }
  return subirMalla(gl, pos, col, idx);
}

// Cielo de Marte de día: caramelo/beige, más claro y polvoriento en el horizonte; Sol pequeño (≈ 2/3 del
// diámetro visto desde la Tierra) con halo; con el Sol bajo, el halo se vuelve azulado (atardecer marciano).
export const HORIZONTE = [0.86, 0.72, 0.58];
export function mallaCielo(gl, solDir) {
  const m = new Malla();
  const L = 48, P = 18, R = 2000;
  const bajo = Math.max(0, Math.min(1, (0.35 - solDir[1]) / 0.3)); // 0 con el Sol alto, 1 cerca del horizonte
  const v = (i, j) => {
    const fi = -0.2 + (j / P) * (Math.PI / 2 + 0.2), t = (i / L) * Math.PI * 2;
    return [Math.cos(t) * Math.cos(fi), Math.sin(fi), Math.sin(t) * Math.cos(fi)];
  };
  const color = (d) => {
    const alt = Math.pow(Math.max(0, d[1]), 0.6);
    const s = Math.max(0, d[0] * solDir[0] + d[1] * solDir[1] + d[2] * solDir[2]);
    const halo = Math.pow(s, 18), aureola = Math.pow(s, 4) * 0.35;
    const base = [HORIZONTE[0] - 0.2 * alt, HORIZONTE[1] - 0.22 * alt, HORIZONTE[2] - 0.2 * alt];
    const tinte = [0.62 + 0.38 * (1 - bajo), 0.72 + 0.26 * (1 - bajo), 0.95];
    const k = Math.min(1, halo * 0.85 + aureola * (0.5 + bajo));
    return [base[0] * (1 - k) + tinte[0] * k, base[1] * (1 - k) + tinte[1] * k, base[2] * (1 - k) + tinte[2] * k, 1];
  };
  for (let j = 0; j < P; j++) for (let i = 0; i < L; i++) {
    const a = v(i, j), b = v(i + 1, j), c = v(i + 1, j + 1), d = v(i, j + 1);
    const ca = color([(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2]);
    m.quad(a.map((x) => x * R), b.map((x) => x * R), c.map((x) => x * R), d.map((x) => x * R), ca);
  }
  // Disco solar: radio angular ≈ 0,18° (2/3 del terrestre), agrandado al doble para que se vea en pantalla.
  const cS = solDir.map((x) => x * (R * 0.95));
  const ref = Math.abs(solDir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [solDir[1] * ref[2] - solDir[2] * ref[1], solDir[2] * ref[0] - solDir[0] * ref[2], solDir[0] * ref[1] - solDir[1] * ref[0]];
  const lu = Math.hypot(...u); u = u.map((x) => x / lu);
  const w = [solDir[1] * u[2] - solDir[2] * u[1], solDir[2] * u[0] - solDir[0] * u[2], solDir[0] * u[1] - solDir[1] * u[0]];
  const anillo = (rad, t) => [cS[0] + (u[0] * Math.cos(t) + w[0] * Math.sin(t)) * rad, cS[1] + (u[1] * Math.cos(t) + w[1] * Math.sin(t)) * rad, cS[2] + (u[2] * Math.cos(t) + w[2] * Math.sin(t)) * rad];
  const rs = R * 0.95 * Math.tan((0.18 * 2 * Math.PI) / 180);
  const cHalo = bajo > 0.3 ? [0.78, 0.86, 1, 1] : [1, 0.96, 0.88, 1];
  for (let k = 0; k < 16; k++) {
    const t1 = (k / 16) * Math.PI * 2, t2 = ((k + 1) / 16) * Math.PI * 2;
    // Halo: abanico de la luz del Sol al color del cielo.
    const h1 = anillo(rs * 6, t1), h2 = anillo(rs * 6, t2);
    const c1 = color(h1.map((x) => x / (R * 0.95)));
    const mid1 = anillo(rs * 1.6, t1), mid2 = anillo(rs * 1.6, t2);
    m.quad(mid1, h1, h2, mid2, [(cHalo[0] + c1[0]) / 2, (cHalo[1] + c1[1]) / 2, (cHalo[2] + c1[2]) / 2, 1]);
    m.quad(anillo(rs, t1), mid1, mid2, anillo(rs, t2), cHalo);
    m.tri(cS, anillo(rs, t1), anillo(rs, t2), [1, 0.99, 0.95, 1]);
  }
  return m.subir(gl);
}

const BLANCO = [0.9, 0.9, 0.87], GRIS = [0.55, 0.56, 0.58], OSCURO = [0.2, 0.21, 0.24], NARANJA = [0.95, 0.5, 0.15];
const LUZ_V = [0.4, 1, 0.6, 1], LUZ_A = [1, 0.75, 0.2, 1], LUZ_R = [1, 0.25, 0.2, 1];

// Bases, ruta, balizas y rocas en una sola malla estática.
export function mallaObjetos(gl, t, datos) {
  const m = new Malla();
  const H = (x, y) => t.altura(x, y);
  const W = (x, y, dy = 0) => [x, H(x, y) + dy, -y];

  // Hábitat de salida en (0, 0): dos cúpulas, módulos, túnel, antena, paneles y luces.
  const hab = (dx, dy) => [dx, H(dx, dy), -dy];
  const zc = H(0, 0);
  m.caja(0, zc - 1, 0, 34, 2.4, 30, [0.5, 0.36, 0.27]); // plataforma nivelada
  m.cupula(-7, zc + 0.2, 4, 6.5, BLANCO, 12, 4);
  m.cilindro(-7, zc + 0.2, 4, 6.6, 0.6, NARANJA, 12);
  m.cupula(8, zc + 0.2, 5, 5, BLANCO, 12, 4);
  m.cilindro(8, zc + 0.2, 5, 5.1, 0.5, NARANJA, 12);
  m.segmento([-1, zc + 1.7, 4.5], [4, zc + 1.7, 5], 1.4, GRIS, 8); // túnel entre cúpulas
  m.caja(0, zc + 1.6, -6, 10, 3.2, 4, BLANCO); // módulo de esclusa
  m.caja(0, zc + 3.3, -6, 10.4, 0.25, 4.4, NARANJA);
  m.caja(0, zc + 1.2, -8.2, 2.2, 2.4, 0.4, OSCURO); // escotilla
  m.caja(-1.6, zc + 2.6, -8.45, 0.4, 0.4, 0.1, LUZ_V);
  m.caja(1.6, zc + 2.6, -8.45, 0.4, 0.4, 0.1, LUZ_V);
  m.segmento([12, zc, -4], [12, zc + 11, -4], 0.15, GRIS, 6); // antena
  m.segmento([12, zc + 9, -4], [13.8, zc + 10.5, -4], 0.08, GRIS, 4);
  m.cupula(12, zc + 10.6, -4, 1.4, BLANCO, 8, 2);
  m.caja(12, zc + 11.4, -4, 0.35, 0.35, 0.35, LUZ_R);
  for (let k = 0; k < 4; k++) { // paneles solares
    const px = -16 + k * 4.2, pz = -10;
    m.segmento([px, zc, pz], [px, zc + 1.4, pz], 0.08, GRIS, 4);
    m.quad([px - 1.8, zc + 1.2, pz - 1.2], [px + 1.8, zc + 1.2, pz - 1.2], [px + 1.8, zc + 2.2, pz + 1.2], [px - 1.8, zc + 2.2, pz + 1.2], [0.15, 0.2, 0.38]);
  }
  for (const [lx, lz] of [[-15, 13], [15, 13], [-15, -13], [15, -13]]) {
    m.segmento([lx, zc, lz], [lx, zc + 3, lz], 0.07, GRIS, 4);
    m.caja(lx, zc + 3.1, lz, 0.4, 0.3, 0.4, LUZ_A);
  }
  void hab;

  // Base de campo en el boxwork: módulo-carpa, bandera, rover estacionado y luces.
  const cx = datos.ciencia.x, cy = datos.ciencia.y;
  const bx = cx + 9, by = cy + 4, zb = H(bx, by);
  m.caja(bx, zb - 0.6, -by, 9, 1.4, 7, [0.48, 0.34, 0.25]);
  m.caja(bx, zb + 1.2, -by, 6, 2.4, 4, BLANCO);
  m.quad([bx - 3.2, zb + 2.4, -by - 2.2], [bx + 3.2, zb + 2.4, -by - 2.2], [bx + 3.2, zb + 3.6, -by], [bx - 3.2, zb + 3.6, -by], NARANJA);
  m.quad([bx - 3.2, zb + 3.6, -by], [bx + 3.2, zb + 3.6, -by], [bx + 3.2, zb + 2.4, -by + 2.2], [bx - 3.2, zb + 2.4, -by + 2.2], NARANJA);
  m.caja(bx - 3.05, zb + 1.8, -by, 0.1, 0.4, 0.4, LUZ_V);
  const fx = cx + 3, fy = cy - 2, zf = H(fx, fy);
  m.segmento([fx, zf, -fy], [fx, zf + 3.4, -fy], 0.05, GRIS, 4);
  m.caja(fx + 0.75, zf + 3.0, -fy, 1.4, 0.8, 0.03, [0.85, 0.85, 0.9]);
  m.caja(fx + 0.4, zf + 3.2, -fy, 0.6, 0.4, 0.04, [0.2, 0.35, 0.75]);
  const rx = cx - 8, ry = cy + 6, zr = H(rx, ry);
  m.caja(rx, zr + 1.1, -ry, 2.6, 0.6, 4, BLANCO); // chasis
  m.caja(rx, zr + 1.6, -ry + 1.2, 2.2, 0.5, 1.2, GRIS);
  for (const [wx, wz] of [[-1.5, -1.4], [1.5, -1.4], [-1.5, 0], [1.5, 0], [-1.5, 1.4], [1.5, 1.4]]) {
    m.segmento([rx + wx - 0.2, zr + 0.45, -ry + wz], [rx + wx + 0.2, zr + 0.45, -ry + wz], 0.45, OSCURO, 8);
  }
  m.segmento([rx + 0.8, zr + 1.4, -ry - 1.6], [rx + 0.8, zr + 3.0, -ry - 1.6], 0.06, GRIS, 4); // mástil
  m.caja(rx + 0.8, zr + 3.1, -ry - 1.6, 0.6, 0.3, 0.3, GRIS);
  m.caja(rx, zr + 1.5, -ry + 2.05, 0.3, 0.2, 0.05, LUZ_A);
  // Crestas del boxwork (marcadas para la ciencia): placas claras bajas.
  const az = azarSemilla(7);
  for (let k = 0; k < 14; k++) {
    const a = az() * Math.PI * 2, d = 6 + az() * 18;
    const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d, z0 = H(x, y);
    const g = az() * Math.PI;
    const L = 2 + az() * 3;
    m.segmento([x - Math.cos(g) * L, z0 + 0.15, -(y - Math.sin(g) * L)], [x + Math.cos(g) * L, z0 + 0.15, -(y + Math.sin(g) * L)], 0.3, [0.78, 0.66, 0.52], 3);
  }

  // La ruta segura no se marca en el terreno: solo la conoce la app.
  const r = datos.ruta;

  // Rocas: donde la rugosidad o la pendiente son altas, más algunas sueltas cerca de la ruta.
  const azr = azarSemilla(23);
  let rocas = 0;
  for (let i = 0; i < t.h.length && rocas < 2600; i += 1) {
    const rug = t.rug[i], p = t.pend[i] / 2;
    const prob = Math.min(0.5, Math.max(0, (rug - 18) / 60) + Math.max(0, (p - 12) / 40));
    if (azr() > prob) continue;
    const q = i % t.ancho, rr = (i / t.ancho) | 0;
    const x = t.x0 + (q + azr() - 0.5) * t.paso, y = t.y0 - (rr + azr() - 0.5) * t.paso;
    if (Math.hypot(x, y) < 22 || Math.hypot(x - cx, y - cy) < 14) continue;
    const tam = 0.3 + azr() * (0.6 + rug / 80);
    const tono = 0.75 + azr() * 0.3;
    m.roca(x, H(x, y) + tam * 0.2, -y, tam, [0.5 * tono, 0.3 * tono, 0.2 * tono], azr);
    rocas++;
  }
  for (let k = 0; k < 900; k++) {
    const seg = r[(azr() * r.length) | 0];
    const x = seg[0] + (azr() - 0.5) * 140, y = seg[1] + (azr() - 0.5) * 140;
    if (Math.hypot(x, y) < 22 || Math.hypot(x - cx, y - cy) < 14) continue;
    const tam = 0.12 + azr() * 0.35;
    const tono = 0.7 + azr() * 0.35;
    m.roca(x, H(x, y) + tam * 0.15, -y, tam, [0.55 * tono, 0.33 * tono, 0.22 * tono], azr);
  }
  return m.subir(gl);
}

// Brazos, guantes y herramientas en espacio de cámara (la cámara mira a −Z).
const TRAJE = [0.92, 0.92, 0.9], GUANTE = [0.78, 0.78, 0.76], DETALLE = [0.85, 0.45, 0.15];
function brazo(m, lado) {
  const s = lado;
  const hombro = [0.46 * s, -0.62, -0.12], codo = [0.3 * s, -0.42, -0.32], muneca = [0.2 * s, -0.27, -0.55];
  m.segmento(hombro, codo, 0.085, TRAJE, 6);
  m.segmento(codo, muneca, 0.07, TRAJE, 6);
  m.segmento([codo[0], codo[1], codo[2] + 0.02], [codo[0] * 0.98, codo[1] + 0.01, codo[2] - 0.05], 0.1, DETALLE, 6); // banda
  m.segmento(muneca, [muneca[0] * 0.95, muneca[1] + 0.02, muneca[2] - 0.05], 0.095, GUANTE, 6); // puño
  m.caja(muneca[0] * 0.92, muneca[1] + 0.02, muneca[2] - 0.12, 0.13, 0.07, 0.12, GUANTE); // mano
  for (let k = 0; k < 4; k++) {
    const fx = muneca[0] * 0.92 - 0.045 * s + k * 0.03 * s;
    m.segmento([fx, muneca[1] + 0.03, muneca[2] - 0.17], [fx, muneca[1] + 0.0, muneca[2] - 0.23], 0.016, GUANTE, 4);
  }
  m.segmento([muneca[0] * 0.92 - 0.07 * s, muneca[1] + 0.02, muneca[2] - 0.1], [muneca[0] * 0.92 - 0.1 * s, muneca[1] + 0.05, muneca[2] - 0.17], 0.02, GUANTE, 4); // pulgar
}

export function mallasCuerpo(gl) {
  const izq = new Malla(); brazo(izq, -1);
  // Pantallita de muñeca en el brazo izquierdo.
  izq.caja(-0.24, -0.28, -0.44, 0.1, 0.03, 0.12, [0.12, 0.13, 0.15]);
  izq.caja(-0.24, -0.262, -0.44, 0.08, 0.01, 0.09, [0.3, 0.9, 0.8, 0.8]);
  const der = new Malla(); brazo(der, 1);
  // Herramientas en la mano derecha (origen cerca de la palma derecha).
  const P = [0.18, -0.2, -0.7];
  const herr = {};
  const baro = new Malla();
  baro.caja(P[0], P[1], P[2], 0.12, 0.18, 0.04, [0.25, 0.26, 0.3]);
  baro.caja(P[0], P[1] + 0.02, P[2] + 0.022, 0.09, 0.1, 0.005, [0.35, 0.95, 0.75, 0.9]);
  baro.caja(P[0], P[1] - 0.065, P[2] + 0.022, 0.06, 0.02, 0.006, DETALLE);
  herr.barometro = baro.subir(gl);
  const cam = new Malla();
  cam.caja(P[0], P[1], P[2], 0.17, 0.11, 0.08, [0.15, 0.15, 0.17]);
  cam.segmento([P[0], P[1], P[2] - 0.04], [P[0], P[1], P[2] - 0.12], 0.035, [0.1, 0.1, 0.12], 8);
  cam.caja(P[0] - 0.05, P[1] + 0.07, P[2], 0.04, 0.03, 0.04, DETALLE);
  cam.caja(P[0] + 0.05, P[1] + 0.035, P[2] + 0.041, 0.04, 0.02, 0.003, [0.9, 0.2, 0.2, 1]);
  herr.camara = cam.subir(gl);
  const bru = new Malla();
  bru.cilindro(P[0], P[1] - 0.02, P[2], 0.09, 0.03, [0.3, 0.3, 0.32], 12);
  bru.cilindro(P[0], P[1] + 0.01, P[2], 0.08, 0.005, [0.95, 0.9, 0.75, 0.6], 12);
  bru.segmento([P[0], P[1] + 0.012, P[2]], [P[0], P[1] + 0.08, P[2]], 0.004, [0.1, 0.1, 0.1], 4); // gnomon
  bru.segmento([P[0], P[1] + 0.017, P[2] + 0.06], [P[0], P[1] + 0.017, P[2] - 0.06], 0.006, [0.9, 0.2, 0.2], 4);
  herr.brujula = bru.subir(gl);
  const rad = new Malla();
  rad.caja(P[0], P[1], P[2], 0.08, 0.2, 0.05, [0.95, 0.65, 0.15]);
  rad.caja(P[0], P[1] + 0.04, P[2] + 0.027, 0.06, 0.06, 0.004, [0.2, 0.8, 1, 0.85]);
  rad.segmento([P[0] + 0.025, P[1] + 0.1, P[2]], [P[0] + 0.025, P[1] + 0.26, P[2]], 0.008, [0.1, 0.1, 0.1], 4);
  rad.caja(P[0] + 0.025, P[1] + 0.265, P[2], 0.02, 0.02, 0.02, [1, 0.25, 0.2, 1]);
  herr.radio = rad.subir(gl);
  return { izq: izq.subir(gl), der: der.subir(gl), herr };
}
