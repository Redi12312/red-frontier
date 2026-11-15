// Respaldo Canvas 2D: ray casting de altura con LOD geométrico y oclusión por columna.
// DTM nativo cerca, contexto regional lejos. El color de orto es ilustrativo, sin colorimetría.
import { alturaEn, parametro, angular } from "./navegacion.js";
import { celdaALonLat, lonLatACelda } from "./zona.js";

export function crearVistaMarte({ canvas, zona, cfg, contexto = null, textura = null, movimientoReducido = false }) {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D no está disponible.");
  const ancho = parametro(cfg, "ancho"), alto = parametro(cfg, "alto"), columnas = parametro(cfg, "columnas");
  canvas.width = ancho; canvas.height = alto;
  const muestras = parametro(cfg, "muestras"), distanciaMax = parametro(cfg, "distancia_m");
  const fov = parametro(cfg, "campo_grados") * Math.PI / 180, focal = ancho / (2 * Math.tan(fov / 2));
  const distancias = Float32Array.from({ length: muestras }, (_, k) => zona.paso * (distanciaMax / zona.paso) ** (k / (muestras - 1)));
  const estadisticas = { cuadros: 0, total_ms: 0, max_ms: 0, fps: 0, ancho, alto, salida: "Canvas2D" };
  let giro = 0, cabeceo = 0, ultimo = null, primerTiempo = null;
  function muestra(z, f, c) {
    if (f < 0 || c < 0 || f >= z.alto - 1 || c >= z.ancho - 1) return NaN;
    const ff = Math.floor(f), cc = Math.floor(c), u = c - cc, v = f - ff, i = ff * z.ancho + cc;
    return alturaEn(z, i) * (1 - u) * (1 - v) + alturaEn(z, i + 1) * u * (1 - v)
      + alturaEn(z, i + z.ancho) * (1 - u) * v + alturaEn(z, i + z.ancho + 1) * u * v;
  }
  function dibujar(estado, ahora = performance.now()) {
    const inicio = performance.now(), p = estado.verdad, rumbo = (estado.rumbo + giro) * Math.PI / 180;
    const z0 = muestra(zona, p.f, p.c);
    const geo = celdaALonLat(zona.meta, p.f, p.c);
    const lejos = contexto ? lonLatACelda(contexto.meta, geo.lon, geo.lat) : null;
    const dia = Math.max(0.1, Math.min(1, (estado.sol.elevacion + 8) / 40));
    const cielo = ctx.createLinearGradient(0, 0, 0, alto);
    cielo.addColorStop(0, `rgb(${Math.round(55 * dia)},${Math.round(59 * dia)},${Math.round(65 * dia)})`);
    cielo.addColorStop(0.65, `rgb(${Math.round(194 * dia)},${Math.round(133 * dia)},${Math.round(91 * dia)})`);
    cielo.addColorStop(1, "#332820"); ctx.fillStyle = cielo; ctx.fillRect(0, 0, ancho, alto);
    const balanceo = movimientoReducido ? 0 : parametro(cfg, "balanceo_m") * Math.sin(estado.t * parametro(cfg, "balanceo_hz") * Math.PI * 2);
    const horizonte = alto * 0.48 + cabeceo;
    const dxSol = angular(estado.sol.azimut - estado.rumbo - giro) * Math.PI / 180;
    const sx = ancho / 2 + Math.tan(dxSol) * focal;
    if (Math.abs(dxSol) < fov && estado.sol.elevacion > 0) {
      ctx.fillStyle = "#f7dfab"; ctx.beginPath(); ctx.arc(sx, horizonte - Math.tan(estado.sol.elevacion * Math.PI / 180) * focal, ancho / 140, 0, 2 * Math.PI); ctx.fill();
    }
    if (Number.isFinite(z0)) for (let col = 0; col < columnas; col++) {
      const pantalla = (col + 0.5) / columnas * ancho, ang = rumbo + Math.atan((pantalla - ancho / 2) / focal);
      const sin = Math.sin(ang), cos = Math.cos(ang), correccion = Math.cos(ang - rumbo);
      let techo = alto;
      for (const dist of distancias) {
        const f = p.f - cos * dist / zona.paso, c = p.c + sin * dist / zona.paso;
        let z = muestra(zona, f, c), remoto = false;
        if (!Number.isFinite(z) && contexto) { z = muestra(contexto, lejos.f - cos * dist / contexto.paso, lejos.c + sin * dist / contexto.paso); remoto = true; }
        if (!Number.isFinite(z)) continue;
        const curvatura = dist * dist / (2 * zona.meta.proyeccion.radio_m);
        const y = Math.max(0, Math.min(alto, horizonte - (z - z0 - parametro(cfg, "altura_ojos_m") - balanceo - curvatura) * focal / (dist * correccion)));
        if (y >= techo) continue;
        let gris = 0.58;
        if (textura && !remoto) {
          const tx = Math.max(0, Math.min(textura.ancho - 1, Math.floor(c / zona.ancho * textura.ancho)));
          const ty = Math.max(0, Math.min(textura.alto - 1, Math.floor(f / zona.alto * textura.alto)));
          gris = textura.datos[(ty * textura.ancho + tx) * 4] / 255;
        }
        // Sombreado local aproximado: normal de la pendiente, sin garantía de visibilidad solar.
        const vecina = muestra(zona, f - Math.cos(estado.sol.azimut * Math.PI / 180), c + Math.sin(estado.sol.azimut * Math.PI / 180));
        const luz = Number.isFinite(vecina) ? Math.max(0.3, Math.min(1, 0.65 - (vecina - z) / zona.paso)) : 0.6;
        const neblina = Math.min(0.85, dist / distanciaMax), brillo = (0.45 + gris * 0.6) * luz * dia;
        const rgb = [165, 112, 76].map((v, k) => Math.round(v * brillo * (1 - neblina) + [170, 122, 88][k] * dia * neblina));
        ctx.fillStyle = `rgb(${rgb.join(",")})`; ctx.fillRect(col * ancho / columnas, y, Math.ceil(ancho / columnas), techo - y + 1); techo = y;
        if (techo <= 0) break;
      }
    }
    const ms = performance.now() - inicio;
    estadisticas.cuadros++; estadisticas.total_ms += ms; estadisticas.max_ms = Math.max(estadisticas.max_ms, ms);
    primerTiempo ??= ahora; if (ultimo !== null && ahora > primerTiempo) estadisticas.fps = (estadisticas.cuadros - 1) * 1000 / (ahora - primerTiempo);
    ultimo = ahora;
    return { ...estadisticas, promedio_ms: estadisticas.total_ms / estadisticas.cuadros };
  }
  return { dibujar, mirar: (azimut, elevacion = 0) => { giro = azimut; cabeceo = elevacion; }, estadisticas };
}

export async function leerTextura(url, anchoMax = 640) {
  const imagen = new Image(); imagen.src = url; await imagen.decode();
  const c = document.createElement("canvas"); c.width = Math.min(anchoMax, imagen.width); c.height = Math.round(imagen.height * c.width / imagen.width);
  const g = c.getContext("2d"); g.drawImage(imagen, 0, 0, c.width, c.height);
  return { ancho: c.width, alto: c.height, datos: g.getImageData(0, 0, c.width, c.height).data };
}
