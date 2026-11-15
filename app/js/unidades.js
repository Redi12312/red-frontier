// Unidades que elige la tripulación (se guardan en el navegador). Todo el cálculo es en el SI; esto solo
// cambia cómo se muestra: distancia y altura (m/km o ft/mi), pendiente (° o %), temperatura y presión.
import { guardar } from "./guardado.js";

const CLAVE = "rf-unidades";
const POR_DEFECTO = { distancia: "metrico", pendiente: "grados", temperatura: "C", presion: "Pa" };
export const OPCIONES = {
  distancia: [["metrico", "Métrico (m, km)"], ["imperial", "Imperial (ft, mi)"]],
  pendiente: [["grados", "Grados (°)"], ["porcentaje", "Porcentaje (%)"]],
  temperatura: [["C", "Celsius (°C)"], ["F", "Fahrenheit (°F)"]],
  presion: [["Pa", "Pascales (Pa)"], ["mbar", "Milibares (mbar)"], ["psi", "psi"]],
};

let actuales = { ...POR_DEFECTO, ...leer() };
function leer() {
  try { return JSON.parse(localStorage.getItem(CLAVE) || "{}"); } catch { return {}; }
}
export const unidades = () => ({ ...actuales });
export function fijarUnidades(cambios) {
  actuales = { ...actuales, ...cambios };
  guardar(CLAVE, JSON.stringify(actuales));
}

// Formatos con el `num` del idioma activo (coma o punto decimal).
export function crearFormatos(num) {
  const PIE = 3.28084;
  return {
    dist(m) {
      if (!Number.isFinite(m)) return "—";
      if (actuales.distancia === "imperial") {
        const ft = m * PIE;
        return ft < 5280 ? `${num(ft)} ft` : `${num(ft / 5280, ft < 52800 ? 2 : 1)} mi`;
      }
      return m < 1000 ? `${num(m)} m` : `${num(m / 1000, m < 10000 ? 2 : 1)} km`;
    },
    alt(m, dec = 0) { return actuales.distancia === "imperial" ? `${num(m * PIE, dec)} ft` : `${num(m, dec)} m`; },
    pend(g, dec = 1) { return actuales.pendiente === "porcentaje" ? `${num(Math.tan((g * Math.PI) / 180) * 100, 0)} %` : `${num(g, dec)}°`; },
    temp(c) { return actuales.temperatura === "F" ? `${num((c * 9) / 5 + 32)} °F` : `${num(c)} °C`; },
    pres(pa) {
      if (actuales.presion === "mbar") return `${num(pa / 100, 2)} mbar`;
      if (actuales.presion === "psi") return `${num(pa * 0.000145038, 3)} psi`;
      return `${num(pa)} Pa`;
    },
  };
}
