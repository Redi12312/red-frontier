// Localización a ciegas por horizonte: busca en toda la zona el punto cuyo horizonte calculado sobre el
// relieve coincide con el horizonte medido por la cámara. Misma lógica que pipeline/localizar_horizonte.py.
// Sin dependencias del navegador: corre en el Worker y en Node.

// Muestreo bilineal de una grilla en coordenadas proyectadas (x, y en metros de la proyección).
export function muestreador(elev, ancho, alto, transform) {
  const [a, , x0, , e, y0] = transform;
  return (x, y) => {
    const c = (x - x0) / a - 0.5, f = (y - y0) / e - 0.5;
    const c0 = Math.floor(c), f0 = Math.floor(f);
    if (c0 < 0 || f0 < 0 || c0 >= ancho - 1 || f0 >= alto - 1) return NaN;
    const u = c - c0, w = f - f0, i = f0 * ancho + c0;
    return elev[i] * (1 - u) * (1 - w) + elev[i + 1] * u * (1 - w) + elev[i + ancho] * (1 - u) * w + elev[i + ancho + 1] * u * w;
  };
}

function rango(desde, hasta, paso) { const r = []; for (let v = desde; v < hasta; v += paso) r.push(v); return r; }
function geom(desde, hasta, n) { const r = [], k = Math.log(hasta / desde) / (n - 1); for (let i = 0; i < n; i++) r.push(desde * Math.exp(k * i)); return r; }

export const DISTANCIAS = {
  gruesa: Float64Array.from([...rango(10, 400, 10), ...geom(400, 70000, 260)]),
  fina: Float64Array.from([...rango(4, 400, 2), ...geom(400, 70000, 900)]),
};

// Elevación del horizonte (°) en cada azimut desde (x, y), sobre el relieve cercano y, donde falte, el lejano.
export function horizonte(cerca, lejos, x, y, azimuts, d, { fe, radio, alturaCamara }) {
  const z0 = cerca(x, y);
  if (!Number.isFinite(z0)) return null;
  const zc = z0 + alturaCamara;
  const salida = new Float64Array(azimuts.length);
  for (let k = 0; k < azimuts.length; k++) {
    const a = (azimuts[k] * Math.PI) / 180, sx = Math.sin(a) / fe, sy = Math.cos(a);
    let max = -90;
    for (let j = 0; j < d.length; j++) {
      const dist = d[j], X = x + sx * dist, Y = y + sy * dist;
      let z = cerca(X, Y);
      if (!Number.isFinite(z)) z = lejos(X, Y);
      if (!Number.isFinite(z)) continue;
      const ang = Math.atan2(z - zc - (dist * dist) / (2 * radio), dist);
      if (ang > max) max = ang;
    }
    salida[k] = max === -90 ? -90 : (max * 180) / Math.PI;
  }
  return salida;
}

// Diferencia típica (°) entre el horizonte medido y el calculado, robusta (cada diferencia se topa en 3°).
function puntaje(ctx, x, y, paso, d, giro = 0) {
  const { az, el } = ctx.medido;
  const idx = [];
  const salto = Math.max(1, Math.round(paso / (az[1] - az[0])));
  for (let i = 0; i < az.length; i += salto) if (Number.isFinite(el[i])) idx.push(i);
  const pred = horizonte(ctx.cerca, ctx.lejos, x, y, idx.map((i) => az[i] + giro), d, ctx.geo);
  if (!pred) return Infinity;
  let s = 0;
  idx.forEach((i, k) => { s += Math.min(Math.abs(el[i] - pred[k]), 3); });
  return s / idx.length;
}

// Búsqueda gruesa (100 m) → media (20 m alrededor de los 8 mejores) → fina (8 m, con ajuste de rumbo ±1°).
// `avance(fraccion, texto)` informa el progreso. Devuelve estimación, incertidumbre y mapa de puntajes.
// `evento(tipo, datos)` muestra el cálculo en vivo: "etapa", "lote" (candidatos ya puntuados) y "mejor".
export function localizar(ctx, limites, avance = () => {}, evento = () => {}) {
  const { fe } = ctx.geo;
  const { xMin, xMax, yMin, yMax } = limites;
  const valido = (x, y) => Number.isFinite(ctx.cerca(x, y));

  const gruesa = [];
  const pasoG = 100;
  const total = Math.ceil((yMax - yMin) / pasoG) * Math.ceil(((xMax - xMin) * fe) / pasoG);
  evento("etapa", { nombre: "gruesa", detalle: `toda la zona cada ${pasoG} m, azimut cada 2°, ${DISTANCIAS.gruesa.length} distancias por rayo hasta 70 km`, total });
  let n = 0, lote = [], mejor = null;
  const enviarLote = (etapa) => { if (lote.length) { evento("lote", { etapa, puntos: lote, mejor }); lote = []; } };
  for (let y = yMin + pasoG / 2; y < yMax; y += pasoG) {
    for (let x = xMin + pasoG / 2 / fe; x < xMax; x += pasoG / fe) {
      if (valido(x, y)) {
        const c = { s: puntaje(ctx, x, y, 2, DISTANCIAS.gruesa), x, y };
        gruesa.push(c);
        lote.push([x, y, c.s]);
        if (!mejor || c.s < mejor.s) mejor = c;
      }
      if (++n % 250 === 0) { avance(0.6 * (n / total), "Búsqueda gruesa en toda la zona"); enviarLote("gruesa"); }
    }
  }
  enviarLote("gruesa");
  gruesa.sort((a, b) => a.s - b.s);
  evento("mejor", { etapa: "gruesa", ...gruesa[0], candidatos: gruesa.length, top: gruesa.slice(0, 8) });

  const media = [];
  evento("etapa", { nombre: "media", detalle: "alrededor de los 8 mejores: ±150 m cada 20 m, azimut cada 1°" });
  gruesa.slice(0, 8).forEach((c, k) => {
    for (let dy = -150; dy <= 150; dy += 20) {
      for (let dx = -150; dx <= 150; dx += 20) {
        const x = c.x + dx / fe, y = c.y + dy;
        if (valido(x, y)) {
          const m = { s: puntaje(ctx, x, y, 1, DISTANCIAS.gruesa), x, y };
          media.push(m);
          lote.push([x, y, m.s]);
          if (m.s < mejor.s) mejor = m;
        }
      }
    }
    enviarLote("media");
    avance(0.6 + 0.2 * ((k + 1) / 8), "Búsqueda media alrededor de los mejores");
  });
  media.sort((a, b) => a.s - b.s);
  evento("mejor", { etapa: "media", ...media[0], candidatos: media.length });

  const fina = [];
  const c = media[0];
  let k = 0;
  evento("etapa", { nombre: "fina", detalle: "±48 m cada 8 m, azimut cada 0,5°, 1100 distancias por rayo, ajuste de rumbo ±1°" });
  for (let dy = -48; dy <= 48; dy += 8) {
    for (let dx = -48; dx <= 48; dx += 8) {
      const x = c.x + dx / fe, y = c.y + dy;
      if (valido(x, y)) {
        let mejor = { s: Infinity, giro: 0 };
        for (let g = -1; g <= 1.0001; g += 0.5) {
          const s = puntaje(ctx, x, y, 0.5, DISTANCIAS.fina, g);
          if (s < mejor.s) mejor = { s, giro: g };
        }
        fina.push({ ...mejor, x, y });
        lote.push([x, y, mejor.s]);
      }
      if (++k % 13 === 0) enviarLote("fina");
      avance(0.8 + 0.2 * (k / 169), "Búsqueda fina");
    }
  }
  enviarLote("fina");
  fina.sort((a, b) => a.s - b.s);
  const best = fina[0];
  evento("mejor", { etapa: "fina", ...best, candidatos: fina.length });
  const cercanos = fina.filter((f) => f.s <= best.s * 1.1 + 0.02).map((f) => Math.hypot((f.x - best.x) * fe, f.y - best.y)).sort((a, b) => a - b);
  const incertidumbre = cercanos.length > 1 ? cercanos[Math.min(cercanos.length - 1, Math.floor(0.95 * cercanos.length))] : 4;
  // Segundo mejor lugar lejano: mide si el resultado es único o ambiguo.
  const lejano = gruesa.find((g) => Math.hypot((g.x - best.x) * fe, g.y - best.y) > 500);
  return {
    x: best.x, y: best.y, puntaje: best.s, giro: best.giro, incertidumbre: Math.max(incertidumbre, 8),
    candidatos: gruesa.length + media.length + fina.length,
    segundoLejano: lejano ? lejano.s : null,
    mapa: gruesa.map((g) => [g.x, g.y, g.s]),
  };
}
