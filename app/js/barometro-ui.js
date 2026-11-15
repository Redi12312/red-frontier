import { capaLienzo } from "./lienzo.js";
// «Geoubicación · barómetro»: la base y el traje miden la presión al mismo tiempo; la diferencia da el
// desnivel (ecuación hipsométrica) y, cruzado con el relieve y la última posición conocida, acota dónde está
// el astronauta. No necesita ver nada: sirve con tormenta de polvo. Incluye una prueba a ciegas.

export function crearBarometro(ctx) {
  const { mapa, estado, num, aMapa, avisar, leerHttp, RAIZ, herramientas } = ctx;
  let cfg = null, rems = null, capa = null, pedido = 0, ultimo = null;

  async function abrir(celda) {
    if (!cfg) {
      [cfg, rems] = await Promise.all([leerHttp(`${RAIZ}/config/barometro.json`, "json"), leerHttp(`${RAIZ}/datos/clima/clima.json`, "json").catch(() => null)]);
    }
    const base = ctx.base();
    if (!base) { avisar("Primero marcá la base (o poné un hábitat): ahí está el barómetro de referencia."); return; }
    const parte = rems?.rems?.soles?.find((s) => Number.isFinite(Number(s.pressure)) && Number.isFinite(Number(s.min_temp)));
    const pBase = parte ? Number(parte.pressure) : 750;
    const T = parte ? (Number(parte.min_temp) + Number(parte.max_temp)) / 2 : -40;
    const cuerpo = herramientas.mostrarTarjeta("Geoubicación · barómetro", `
      <p class="ayuda">Los barómetros exteriores del hábitat y del traje miden al mismo tiempo. La diferencia de presión da el desnivel;
        el relieve de HiRISE dice qué lugares cercanos están a esa altura. Último punto conocido: donde hiciste clic.</p>
      <form class="barometro">
        <label>Presión en la base (Pa)<input type="number" step="0.1" name="pBase" value="${pBase}"></label>
        <label>Presión en el traje (Pa)<input type="number" step="0.1" name="p" value="${pBase}"></label>
        <label>Temperatura del aire (°C)<input type="number" step="1" name="T" value="${Math.round(T)}"></label>
        <label>Radio de búsqueda (m)<input type="number" step="50" min="50" name="radio" value="600"></label>
        <div class="acciones">
          <button type="button" class="primario chico" data-prueba>Prueba a ciegas</button>
          <button type="submit" class="chico">Ubicar con estas presiones</button>
        </div>
      </form>
      <div class="barometro-resultado"></div>
      <p class="ayuda">Presión y temperatura iniciales: último parte de Curiosity (REMS${parte ? `, sol ${parte.sol}` : ""}). Ruido diferencial ${num(cfg.sigma_presion_diferencial_pa.valor)} Pa (propuesta, a calibrar): ≈ ${num((cfg.gas_marciano_j_kg_k.valor * (T + 273.15)) / (cfg.gravedad_m_s2.valor * pBase))} m de altura por Pa.</p>`,
    () => { capa?.remove(); capa = null; });
    const form = cuerpo.querySelector("form");
    const leer = () => ({ pBase: Number(form.pBase.value), p: Number(form.p.value), T: Number(form.T.value) + 273.15, radio_m: Math.max(50, Number(form.radio.value) || 600) });
    const enviar = (prueba) => {
      const v = leer();
      if (![v.pBase, v.p, v.T].every(Number.isFinite)) { avisar("Revisá los números."); return; }
      ultimo = { id: ++pedido, celda, prueba };
      avisar(prueba ? "Prueba a ciegas: el motor elige un punto oculto y lo busca solo con la presión…" : "Buscando dónde está ese desnivel…");
      estado.worker.postMessage({ tipo: "barometro", pedido, cfg, base, previa: celda, radio_m: v.radio_m, pBase: v.pBase, p: v.p, T: v.T, prueba, semilla: Date.now() });
    };
    form.addEventListener("submit", (e) => { e.preventDefault(); enviar(false); });
    form.querySelector("[data-prueba]").addEventListener("click", () => enviar(true));
  }

  async function alResultado(d) {
    if (!ultimo || d.pedido !== ultimo.id) return;
    const caja = document.querySelector(".barometro-resultado");
    capa?.remove();
    capa = L.layerGroup().addTo(mapa);
    const { f0, c0, w, h } = d.ventana;
    // Probabilidad como mancha (más intensa = más probable) sobre la ventana del círculo previo.
    const lienzo = document.createElement("canvas");
    lienzo.width = w; lienzo.height = h;
    const g = lienzo.getContext("2d"), img = g.createImageData(w, h);
    for (let k = 0; k < d.prob.length; k++) {
      const v = d.prob[k];
      if (!v) continue;
      img.data.set([255, 200 - Math.round(v * 0.5), 40, Math.min(220, 40 + v)], k * 4);
    }
    g.putImageData(img, 0, 0);
    capaLienzo(lienzo, [[-(f0 + h), c0], [-f0, c0 + w]], { opacity: 0.85 }).addTo(capa);
    L.circle(aMapa(ultimo.celda.f, ultimo.celda.c), { radius: (Math.max(w, h) / 2), color: "#fff", weight: 1, dashArray: "4 4", fill: false, interactive: false }).addTo(capa);
    if (d.mejor) L.marker(aMapa(d.mejor.f, d.mejor.c), { icon: L.divIcon({ className: "", html: '<div class="estimada" title="Estimación">✕</div>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false }).addTo(capa);
    let error = null;
    if (d.verdad) {
      L.marker(aMapa(d.verdad.f, d.verdad.c), { icon: L.divIcon({ className: "", html: '<div class="verdad" title="Punto oculto">◎</div>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false }).addTo(capa);
      if (d.mejor) error = Math.hypot(d.mejor.f - d.verdad.f, d.mejor.c - d.verdad.c) * estado.zona.paso;
    }
    caja.innerHTML = d.error || !d.mejor
      ? `<p class="falla">Ningún lugar dentro del radio está a esa altura (${num(d.zBase + d.dz)} m ± ${num(2 * d.sigma)} m). Revisá las presiones o agrandá el radio.</p>`
      : `<dl class="dato-ubicacion">
          <dt>Desnivel</dt><dd>${d.dz >= 0 ? "+" : ""}${num(d.dz, 1)} m ± ${num(d.sigma, 1)} m respecto de la base (${num(d.p, 1)} Pa en el traje)</dd>
          <dt>Zona probable</dt><dd>${num(d.area_m2 / 1e4, 2)} ha concentran el 95 % (mancha naranja)</dd>
          ${d.verdad ? `<dt>Punto oculto</dt><dd>${d.dentro95 ? '<span class="ok">dentro de la zona del 95 %</span>' : '<span class="falla">fuera de la zona del 95 %</span>'} · a ${num(error)} m del punto más probable ✕ (ruido simulado ${num(d.verdad.ruido_pa, 2)} Pa)</dd>` : ""}
        </dl>
        <p class="ayuda">El barómetro delimita una franja de altura. Abrí «Geoubicación sin GPS» → «Sumar medidas» para combinar estas presiones con el horizonte, los pasos y otras lecturas.</p>`;
    avisar(d.verdad && d.mejor ? `Barómetro a ciegas: la estimación quedó a ${num(error)} m del punto oculto.` : "Barómetro: zona probable marcada en naranja.");
  }

  function limpiar() { capa?.remove(); capa = null; }
  return { abrir, alResultado, limpiar };
}
