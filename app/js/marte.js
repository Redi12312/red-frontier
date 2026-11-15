// Vista de todo Marte: fondo global y zonas candidatas para misiones humanas (JPL Mars Trek).
// En esta vista el mapa usa grados: x = longitud (-180..180), y = latitud.
import { leerHttp } from "./zona.js";

const R_KM = 3396.19;
const KM_POR_GRADO = (R_KM * Math.PI) / 180;

export async function cargarMarte(raiz) {
  const meta = await leerHttp(`${raiz}/datos/marte/meta.json`, "json");
  const candidatas = await leerHttp(`${raiz}/datos/marte/${meta.candidatas.archivo}`, "json");
  return { meta, candidatas };
}

export function metrosPorGrado() { return KM_POR_GRADO * 1000; }

// Distancia sobre la esfera entre dos puntos (grados), en km.
export function distanciaKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Círculo de `km` alrededor de un punto, en grados (se ensancha en longitud según la latitud).
function circulo(lat, lon, km) {
  const puntos = [];
  for (let k = 0; k <= 72; k++) {
    const t = (k / 72) * 2 * Math.PI;
    const dlat = (km / KM_POR_GRADO) * Math.sin(t);
    const dlon = (km / KM_POR_GRADO) * Math.cos(t) / Math.max(Math.cos(((lat + dlat) * Math.PI) / 180), 0.05);
    puntos.push([lat + dlat, lon + dlon]);
  }
  return puntos;
}

// Zonas detalladas generadas que caen dentro de una zona candidata.
export function zonasDentro(candidata, zonas, radioKm) {
  const { lat, lon_este } = candidata.properties;
  return zonas
    .map((z) => ({ ...z, km: distanciaKm(lat, lon_este, z.centro.lat, z.centro.lon_este) }))
    .filter((z) => z.km <= radioKm)
    .sort((a, b) => a.km - b.km);
}

// Región generada para la candidata número `indice` (mismo orden que candidatas.geojson).
export function regionDe(indice, zonas) {
  const prefijo = `region_${String(indice).padStart(2, "0")}_`;
  return zonas.find((z) => z.id.startsWith(prefijo)) || null;
}

// Capas Leaflet de la vista. `alElegir({ lat, lon, region, nombre })` se llama al tocar una zona.
export function capasMarte(datos, zonas, raiz, num, alElegir) {
  const { meta, candidatas } = datos;
  const radio = meta.candidatas.radio_zona_km.valor;
  const fondo = L.imageOverlay(`${raiz}/datos/marte/${meta.fondo.archivo}`, [[-90, -180], [90, 180]]);
  const puntos = L.layerGroup();
  const radios = L.layerGroup();
  const caminata = zonas.filter((z) => z.nivel === "salida");

  candidatas.features.forEach((ft, indice) => {
    const [lon180, lat] = ft.geometry.coordinates;
    const p = ft.properties;
    const region = regionDe(indice, zonas);
    const detalle = zonasDentro(ft, caminata, radio);
    const color = detalle.length ? "#4cc488" : region ? "#ffd25a" : "#9a8f87";
    L.polygon(circulo(lat, lon180, radio), { color, weight: 1, fillOpacity: 0.08, interactive: false }).addTo(radios);
    const ayuda = region ? "tocá para abrir su región" : "región todavía no generada";
    L.circleMarker([lat, lon180], { radius: 6, color: "#1a100b", weight: 1.5, fillColor: color, fillOpacity: 1 })
      .bindTooltip(`${p.nombre}<br><span style="opacity:.75">${num(Math.abs(lat), 2)}° ${lat < 0 ? "S" : "N"}, ${num(p.lon_este, 2)}° E · ${ayuda}${detalle.length ? " · con mapa de caminata" : ""}</span>`)
      .on("click", () => alElegir({ lat, lon: lon180, region, nombre: p.nombre }))
      .addTo(puntos);
  });

  return [
    { id: "marte_fondo", nombre: `Relieve de Marte (${meta.fondo.misiones})`, activa: true, capa: fondo },
    { id: "marte_candidatas", nombre: `Zonas candidatas para humanos (${meta.candidatas.cantidad})`, activa: true, capa: puntos },
    { id: "marte_radios", nombre: `Radio de exploración de ${num(radio)} km`, activa: false, capa: radios },
  ];
}
