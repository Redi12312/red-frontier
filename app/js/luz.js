// Luz modelada sobre el DTM; no son mediciones de iluminación.
// Mars24, Allison y McEwen (2000), ecuaciones B, C-1 y D-1/D-5/D-6:
// https://www.giss.nasa.gov/tools/mars24/help/algorithm.html
// Los coeficientes astronómicos son verificados; no son umbrales operativos.
import { tiempoMarte, horaLocal } from "./clima.js";

const rad = (g) => g * Math.PI / 180;
const grados = (r) => r * 180 / Math.PI;
const modulo = (x, n) => ((x % n) + n) % n;
const acotar = (x) => Math.max(-1, Math.min(1, x));
// Mars24 C-2: duración del sol medio en días terrestres.
const SOL_MS = 1.0274912517 * 86400000;
const cacheRelieve = new WeakMap();

// Mismo contrato del DTM que radio: reemplazo de arreglos o versión nueva
// invalida solo; una edición en el lugar puede invalidarse explícitamente.
export function invalidarCacheSombras(zona) {
  cacheRelieve.delete(zona);
}

function relieveReducido(zona, reduccion, ancho, alto) {
  const anterior = cacheRelieve.get(zona);
  const { elevacion, valido, versionTerreno } = zona;
  if (anterior && anterior.elevacion === elevacion && anterior.valido === valido
    && anterior.versionTerreno === versionTerreno && anterior.reduccion === reduccion
    && anterior.anchoOriginal === zona.ancho && anterior.altoOriginal === zona.alto) return anterior.alturas;
  const alturas = new Float64Array(ancho * alto);
  for (let fr = 0; fr < alto; fr++) {
    const fFin = Math.min(zona.alto, (fr + 1) * reduccion);
    for (let cr = 0; cr < ancho; cr++) {
      const cFin = Math.min(zona.ancho, (cr + 1) * reduccion);
      let mayor = -Infinity;
      for (let f = fr * reduccion; f < fFin; f++) {
        for (let c = cr * reduccion; c < cFin; c++) {
          const i = f * zona.ancho + c, z = elevacion[i];
          mayor = !Number.isFinite(z) || (valido && !valido[i]) ? Infinity : Math.max(mayor, z);
        }
      }
      alturas[fr * ancho + cr] = mayor;
    }
  }
  // Solo se retiene la reducción vigente por zona, aunque cambie el Sol o la escala.
  cacheRelieve.set(zona, { elevacion, valido, versionTerreno, reduccion, anchoOriginal: zona.ancho, altoOriginal: zona.alto, alturas });
  return alturas;
}

function validarLugar(ms, lonEste, lat) {
  if (!Number.isFinite(ms) || !Number.isFinite(lonEste) || !Number.isFinite(lat) || Math.abs(lat) > 90) {
    throw new Error("Fecha o coordenadas solares inválidas");
  }
}

// Grados; horas solares marcianas en [0, 24). Azimut: norte = 0°, este = 90°.
// Se usa la esfera y latitud planetocéntrica del proyecto, sin convertir a elipsoide.
// Se hereda de clima.js TT − UTC = 69,184 s (época moderna); en 2000/2004
// esto adelanta el reloj unos 5 s respecto de los ejemplos históricos de NASA.
export function posicionSol(ms, lonEste, lat) {
  validarLugar(ms, lonEste, lat);
  const { mtc, ls } = tiempoMarte(ms);
  const dt = ms / 86400000 + 2440587.5 + 69.184 / 86400 - 2451545;
  const alfa = 270.3871 + 0.524038496 * dt;
  const centro = modulo(ls - alfa + 180, 360) - 180;
  const ecuacion = 2.861 * Math.sin(rad(2 * ls)) - 0.071 * Math.sin(rad(4 * ls))
    + 0.002 * Math.sin(rad(6 * ls)) - centro;
  const declinacion = grados(Math.asin(0.42565 * Math.sin(rad(ls)))) + 0.25 * Math.sin(rad(ls));
  const lmst = horaLocal(mtc, modulo(lonEste, 360));
  const ltst = modulo(lmst + ecuacion / 15, 24);
  const h = rad(15 * (ltst - 12));
  const phi = rad(lat), delta = rad(declinacion);
  const elevacion = grados(Math.asin(acotar(Math.sin(phi) * Math.sin(delta)
    + Math.cos(phi) * Math.cos(delta) * Math.cos(h))));
  // H crece hacia la tarde: la componente este es negativa después del mediodía.
  const este = -Math.cos(delta) * Math.sin(h);
  const norte = Math.cos(phi) * Math.sin(delta) - Math.sin(phi) * Math.cos(delta) * Math.cos(h);
  const azimut = modulo(grados(Math.atan2(este, norte)), 360);
  return { elevacion, azimut, declinacion, ltst, lmst, ls };
}

// Salida/puesta del centro del Sol sobre horizonte geométrico plano, en LMST.
// No incluye refracción, disco solar ni relieve. Null significa que ese evento
// no ocurre en el sol local [00:00, 24:00) que contiene ms; estado aclara los polos.
export function amanecerAtardecer(ms, lonEste, lat) {
  const { lmst } = posicionSol(ms, lonEste, lat);
  const inicio = ms - lmst * SOL_MS / 24;
  const altura = (h) => posicionSol(inicio + h * SOL_MS / 24, lonEste, lat).elevacion;
  let amanecer = null, atardecer = null;
  let anterior = altura(0), minimo = anterior, maximo = anterior;
  // Muestreo numérico y bisección: la estación y la ecuación del tiempo cambian
  // durante el sol. Cuartos de hora son intervalos de búsqueda, no márgenes EVA.
  for (let k = 1; k <= 96; k++) {
    const fin = k / 4, actual = altura(fin);
    minimo = Math.min(minimo, actual);
    maximo = Math.max(maximo, actual);
    const sale = anterior <= 0 && actual > 0;
    const entra = anterior > 0 && actual <= 0;
    if (sale || entra) {
      let a = fin - 0.25, b = fin;
      // Precisión numérica muy inferior al segundo; sin parámetros de seguridad.
      for (let j = 0; j < 32; j++) {
        const medio = (a + b) / 2;
        if ((altura(medio) > 0) === (anterior > 0)) a = medio;
        else b = medio;
      }
      const hora = (a + b) / 2;
      if (hora < 24) {
        if (sale) amanecer = hora;
        else atardecer = hora;
      }
    }
    anterior = actual;
  }
  const estado = amanecer !== null && atardecer !== null ? "normal"
    : minimo > 0 ? "dia_polar" : maximo <= 0 ? "noche_polar" : "transicion_polar";
  return { amanecer, atardecer, estado };
}

function validarZona(zona) {
  const { ancho, alto, paso } = zona;
  if (!Number.isInteger(ancho) || ancho <= 0 || !Number.isInteger(alto) || alto <= 0
      || !Number.isFinite(paso) || paso <= 0) throw new Error("La grilla de la zona es inválida");
}

// Aproximación visual a resolución reducida: conserva la mayor altura de cada
// bloque para no perder paredes finas. El receptor también queda a esa altura.
// Rayos digitales paralelos por cizallamiento, O(celdas originales + reducidas),
// con horizonte acumulado. La dirección se redondea a la celda más cercana.
// Sin curvatura/refracción ni obstáculos fuera del DTM. No es garantía de luz:
// un bloque con datos faltantes y lo que queda detrás se marcan en sombra por
// precaución (1 puede ser sombra o luz desconocida). reduccion = 4 fue pedida
// por la tarea: propuesta visual, a calibrar; se puede elegir 1 para más detalle.
export function mapaSombras(zona, sol, { reduccion = 4 } = {}) {
  validarZona(zona);
  if (!Number.isInteger(reduccion) || reduccion < 1) throw new Error("La reducción debe ser un entero positivo");
  if (!Number.isFinite(sol?.elevacion) || Math.abs(sol.elevacion) > 90 || !Number.isFinite(sol.azimut)) {
    throw new Error("La posición del Sol es inválida");
  }
  const ancho = Math.ceil(zona.ancho / reduccion), alto = Math.ceil(zona.alto / reduccion);
  const paso = zona.paso * reduccion;
  const sombra = new Uint8Array(ancho * alto);
  if (sol.elevacion <= 0) return { sombra: sombra.fill(1), ancho, alto, paso };
  if (zona.elevacion?.length !== zona.ancho * zona.alto
      || (zona.valido && zona.valido.length !== zona.elevacion.length)) {
    throw new Error("Faltan alturas o celdas de la zona");
  }
  const alturas = relieveReducido(zona, reduccion, ancho, alto);
  const azimut = rad(modulo(sol.azimut, 360));
  // Dirección contraria al Sol: filas al sur, columnas al este.
  const df = Math.cos(azimut), dc = -Math.sin(azimut);
  const vertical = Math.abs(df) >= Math.abs(dc);
  const principal = vertical ? df : dc, lateral = vertical ? dc : df;
  const largo = vertical ? alto : ancho, anchoRayos = vertical ? ancho : alto;
  const deriva = lateral / Math.abs(principal);
  const desplazamiento = Math.round((largo - 1) * deriva);
  const margen = Math.max(0, desplazamiento);
  const horizonte = new Float64Array(anchoRayos + Math.abs(desplazamiento)).fill(-Infinity);
  const caida = paso * Math.tan(rad(sol.elevacion)) / Math.abs(principal);
  for (let t = 0; t < largo; t++) {
    const mayor = principal > 0 ? t : largo - 1 - t;
    const corrimiento = Math.round(t * deriva);
    for (let menor = 0; menor < anchoRayos; menor++) {
      const i = vertical ? mayor * ancho + menor : menor * ancho + mayor;
      const rayo = menor - corrimiento + margen;
      const z = alturas[i], referencia = z + t * caida;
      sombra[i] = !Number.isFinite(z) || horizonte[rayo] > referencia ? 1 : 0;
      horizonte[rayo] = Math.max(horizonte[rayo], referencia);
    }
  }
  return { sombra, ancho, alto, paso };
}

// Longitud horizontal en metros, integrada entre centros de celdas de la ruta.
// Se divide cada segmento en los bordes de la máscara: evita contar celdas
// enteras en los cambios de luz y maneja diagonales y bloques parciales.
export function iluminacionRuta(zona, sombraReducida, ruta) {
  validarZona(zona);
  const { sombra, ancho, alto, paso } = sombraReducida;
  const escala = paso / zona.paso;
  if (!Number.isInteger(escala) || escala < 1 || ancho !== Math.ceil(zona.ancho / escala)
      || alto !== Math.ceil(zona.alto / escala) || sombra?.length !== ancho * alto) {
    throw new Error("La máscara de sombras no corresponde a la zona");
  }
  const celda = (i) => {
    if (!Number.isInteger(i) || i < 0 || i >= zona.ancho * zona.alto) throw new Error("Celda de ruta inválida");
    return { f: Math.floor(i / zona.ancho), c: i % zona.ancho };
  };
  let metros = 0, total = 0;
  let anterior = ruta.length ? celda(ruta[0]) : null;
  for (let k = 1; k < ruta.length; k++) {
    const actual = celda(ruta[k]);
    const df = actual.f - anterior.f, dc = actual.c - anterior.c;
    if (Math.abs(df) > 1 || Math.abs(dc) > 1) throw new Error("La ruta debe tener celdas contiguas");
    const longitud = zona.paso * Math.hypot(df, dc);
    const x = (anterior.c + 0.5) / escala, y = (anterior.f + 0.5) / escala;
    const dx = dc / escala, dy = df / escala;
    const cortes = [0, 1];
    // Con vecinos de 8 direcciones se cruza como máximo un borde por eje.
    for (const [desde, cambio] of [[x, dx], [y, dy]]) {
      if (!cambio) continue;
      const borde = cambio > 0 ? Math.floor(desde) + 1 : Math.ceil(desde) - 1;
      const t = (borde - desde) / cambio;
      if (t > 0 && t < 1) cortes.push(t);
    }
    cortes.sort((a, b) => a - b);
    for (let j = 1; j < cortes.length; j++) {
      const medio = (cortes[j - 1] + cortes[j]) / 2;
      const c = Math.floor(x + dx * medio), f = Math.floor(y + dy * medio);
      if (sombra[f * ancho + c]) metros += longitud * (cortes[j] - cortes[j - 1]);
    }
    total += longitud;
    anterior = actual;
  }
  return { metros, fraccion: total ? metros / total : 0 };
}
