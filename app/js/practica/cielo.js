// Cielo marciano aproximado: polvo suspendido (cielo caramelo de día), halo amplio alrededor del Sol,
// atardecer azul cerca del Sol bajo (dispersión hacia adelante del polvo) y noche casi negra.
// Modelo visual, no radiativo: los colores son una propuesta a calibrar con imágenes de Curiosity/Perseverance.
// colorCielo (JS) y cieloMarte (GLSL) hacen exactamente la misma cuenta.

// Radio angular del Sol visto desde Marte: ≈ 0,175° (diámetro ≈ 0,35°, unos 2/3 del terrestre).
export const RADIO_SOL_GRADOS = 0.175;

const NOCHE = [0.012, 0.01, 0.016];
const CENIT_DIA = [0.4, 0.26, 0.19];      // marrón rosado
const HORIZ_DIA = [0.8, 0.64, 0.47];      // beige claro con bruma
const CENIT_BAJO = [0.16, 0.12, 0.11];    // cielo oscurecido con el Sol bajo
const HORIZ_BAJO = [0.36, 0.29, 0.25];    // marrón grisáceo
const HALO_DIA = [1.0, 0.88, 0.72];
const HALO_AZUL = [0.3, 0.5, 0.88];
const DISCO = [1.0, 0.99, 0.96];

const sat = (x) => Math.min(1, Math.max(0, x));
const suave = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mezclar = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// dirVista y dirSol: vectores unitarios [x, y, z], y hacia arriba. Devuelve [r, g, b] en 0..1.
export function colorCielo(dirVista, dirSol) {
  const e = dirSol[1];                                   // seno de la elevación del Sol
  const h = Math.max(dirVista[1], 0);
  const c = dirVista[0] * dirSol[0] + dirVista[1] * dirSol[1] + dirVista[2] * dirSol[2];
  const cp = Math.max(c, 0);
  const t = Math.pow(1 - h, 2.5);                        // peso del horizonte
  const k = suave(0.12, 0.35, e);                         // 0: Sol bajo (< ~15°), 1: Sol alto
  const luz = suave(-0.25, 0.02, e);                     // noche → crepúsculo → día
  const base = mezclar(mezclar(CENIT_BAJO, HORIZ_BAJO, t), mezclar(CENIT_DIA, HORIZ_DIA, t), k);
  // Halo: amplio + concentrado; con Sol bajo es azul y un poco más ancho.
  const ancho = Math.pow(cp, 8 - 3 * (1 - k)) * (0.3 + 0.15 * (1 - k));
  const fino = Math.pow(cp, 64 - 34 * (1 - k)) * (0.45 - 0.1 * (1 - k));
  const halo = mezclar(HALO_AZUL, HALO_DIA, k);
  const iHalo = ancho + fino;
  // Disco solar con borde suave; solo sobre el horizonte.
  const r = (RADIO_SOL_GRADOS * Math.PI) / 180;
  const disco = suave(Math.cos(r * 1.4), Math.cos(r * 0.7), c) * suave(-0.01, 0.01, e);
  return [0, 1, 2].map((i) => sat(NOCHE[i] + luz * (base[i] * (1 - 0.35 * iHalo * (1 - k)) + halo[i] * iHalo) + DISCO[i] * disco));
}

// Color de la bruma del horizonte para el terreno: horizonte a 90° del Sol, un poco apagado.
export function colorNiebla(dirSol) {
  let px = -dirSol[2], pz = dirSol[0];
  const l = Math.hypot(px, pz);
  if (l < 1e-6) { px = 1; pz = 0; } else { px /= l; pz /= l; }
  const c = colorCielo([px * 0.9998, 0.02, pz * 0.9998], dirSol);
  return c.map((v) => v * 0.92);
}

// Equivalente GLSL ES 3.0: vec3 cieloMarte(vec3 dir, vec3 sol) y vec3 nieblaMarte(vec3 sol).
// dir y sol deben venir normalizados.
export const GLSL_CIELO = `
const float RADIO_SOL_MARTE = ${(RADIO_SOL_GRADOS * Math.PI / 180).toFixed(7)};
vec3 cieloMarte(vec3 dir, vec3 sol) {
  const vec3 NOCHE = vec3(0.012, 0.01, 0.016);
  const vec3 CENIT_DIA = vec3(0.4, 0.26, 0.19);
  const vec3 HORIZ_DIA = vec3(0.8, 0.64, 0.47);
  const vec3 CENIT_BAJO = vec3(0.16, 0.12, 0.11);
  const vec3 HORIZ_BAJO = vec3(0.36, 0.29, 0.25);
  const vec3 HALO_DIA = vec3(1.0, 0.88, 0.72);
  const vec3 HALO_AZUL = vec3(0.3, 0.5, 0.88);
  const vec3 DISCO = vec3(1.0, 0.99, 0.96);
  float e = sol.y;
  float h = max(dir.y, 0.0);
  float c = dot(dir, sol);
  float cp = max(c, 0.0);
  float t = pow(1.0 - h, 2.5);
  float k = smoothstep(0.12, 0.35, e);
  float luz = smoothstep(-0.25, 0.02, e);
  vec3 base = mix(mix(CENIT_BAJO, HORIZ_BAJO, t), mix(CENIT_DIA, HORIZ_DIA, t), k);
  float ancho = pow(cp, 8.0 - 3.0 * (1.0 - k)) * (0.3 + 0.15 * (1.0 - k));
  float fino = pow(cp, 64.0 - 34.0 * (1.0 - k)) * (0.45 - 0.1 * (1.0 - k));
  vec3 halo = mix(HALO_AZUL, HALO_DIA, k);
  float iHalo = ancho + fino;
  float disco = smoothstep(cos(RADIO_SOL_MARTE * 1.4), cos(RADIO_SOL_MARTE * 0.7), c) * smoothstep(-0.01, 0.01, e);
  return clamp(NOCHE + luz * (base * (1.0 - 0.35 * iHalo * (1.0 - k)) + halo * iHalo) + DISCO * disco, 0.0, 1.0);
}
vec3 nieblaMarte(vec3 sol) {
  vec2 p = vec2(-sol.z, sol.x);
  float l = length(p);
  p = l < 1e-6 ? vec2(1.0, 0.0) : p / l;
  return cieloMarte(vec3(p.x * 0.9998, 0.02, p.y * 0.9998), sol) * 0.92;
}
`;
