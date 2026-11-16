// Metadatos de cámara (CAHVOR y orientación) de una foto Navcam de Curiosity, buscados en la API pública de NASA
// por el nombre del archivo: el nombre trae el reloj de la nave, de ahí sale el sol aproximado y se revisan las fotos
// de ese sol y los vecinos. Necesita conexión; sin ella devuelve null y la foto necesita su JSON.
import { solAproximado } from "./horizonte-fotos.js";

const API_NASA = "https://mars.nasa.gov/api/v1/raw_image_items/";
const INSTRUMENTOS = { NLB: "NAV_LEFT_B", NRB: "NAV_RIGHT_B", NLA: "NAV_LEFT_A", NRA: "NAV_RIGHT_A" };

// cache: { porSol: Map, meta: Map } compartido entre búsquedas para no repetir pedidos.
export function crearCacheMetadatos() { return { porSol: new Map(), meta: new Map() }; }

export async function buscarMetadatosNasa(imageid, cache = crearCacheMetadatos(), pedir = fetch) {
  const sol = solAproximado(imageid), inst = INSTRUMENTOS[imageid.slice(0, 3)];
  if (sol === null || !inst) return null;
  for (const s of [sol, sol - 1, sol + 1]) {
    const clave = `${inst}/${s}`;
    if (!cache.porSol.has(clave)) {
      const items = [];
      try {
        for (let pag = 0; pag < 20; pag++) {
          const url = `${API_NASA}?order=sol%20asc&per_page=100&page=${pag}&condition_1=msl:mission&condition_2=${inst}:instrument`
            + `&condition_3=${s}:sol:gte&condition_4=${s}:sol:lte&extended=thumbnail::sample_type::noteq`;
          const d = await (await pedir(url)).json();
          items.push(...d.items);
          if (!d.more) break;
        }
      } catch { return null; }
      cache.porSol.set(clave, items);
      for (const it of items) if (!cache.meta.has(it.imageid)) cache.meta.set(it.imageid, it);
    }
    if (cache.meta.has(imageid)) return cache.meta.get(imageid);
  }
  return null;
}
