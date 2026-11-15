// Herramientas del mapa (menú de clic derecho): medir distancia, rumbo y perfil; ir a coordenadas;
// copiar coordenadas; cobertura de radio desde un punto; luz y sombras a una hora del sol.
// Los resultados se muestran en una tarjeta flotante sobre el mapa, no en el panel.
import { distancia, rumbo, formatoCoordenadas, leerCoordenadas } from "./herramientas.js";
import { posicionSol, amanecerAtardecer } from "./luz.js";
import { contarPasos } from "./expedicion.js";
import { capaLienzo } from "./lienzo.js";

const SOL_MS = 88775244.147; // un sol en milisegundos (Allison y McEwen 2000)
const PUNTOS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];

export function crearHerramientasMapa(ctx) {
  const { mapa, estado, $, num, fmt, aMapa, avisar, celdaALonLat, lonLatACelda, leerHttp, RAIZ, imagenDesdeLut, bordes } = ctx;
  let cfgRadio = null, cfgExp = null;
  let midiendo = null, capaMedida = null, marcaIr = null, capaRadio = null, capaSombras = null;
  let pedido = 0, alCerrarTarjeta = null;
  const tarjeta = $("#tarjeta-mapa");

  // ---------- Tarjeta flotante ----------
  function mostrarTarjeta(titulo, html, alCerrar) {
    alCerrarTarjeta?.();
    alCerrarTarjeta = alCerrar || null;
    tarjeta.innerHTML = `<div class="tarjeta-cabeza"><h3>${titulo}</h3><button type="button" class="mini" data-cerrar title="Cerrar">✕</button></div><div class="tarjeta-cuerpo">${html}</div>`;
    tarjeta.hidden = false;
    tarjeta.querySelector("[data-cerrar]").addEventListener("click", cerrarTarjeta);
    L.DomEvent.disableClickPropagation(tarjeta);
    L.DomEvent.disableScrollPropagation(tarjeta);
    return tarjeta.querySelector(".tarjeta-cuerpo");
  }
  function cerrarTarjeta() {
    alCerrarTarjeta?.();
    alCerrarTarjeta = null;
    tarjeta.hidden = true;
    tarjeta.innerHTML = "";
  }

  const ll = (celda) => celdaALonLat(estado.zona.meta, celda.f, celda.c);
  const texto = (celda) => { const p = ll(celda); return formatoCoordenadas(p.lat, ((p.lon % 360) + 360) % 360); };

  // ---------- Medir ----------
  function medirDesde(celda) {
    cancelarMedida();
    capaMedida = L.layerGroup().addTo(mapa);
    L.circleMarker(aMapa(celda.f, celda.c), { radius: 5, color: "#fff", weight: 2, fillColor: "#e52918", fillOpacity: 1 }).addTo(capaMedida);
    const guia = L.polyline([aMapa(celda.f, celda.c), aMapa(celda.f, celda.c)], { color: "#fff", weight: 2, dashArray: "6 5", interactive: false }).addTo(capaMedida);
    midiendo = { desde: celda, guia };
    mapa.on("mousemove", seguir);
    avisar("Medición: tocá el punto final (Esc para cancelar).");
  }
  function seguir(e) { midiendo?.guia.setLatLngs([aMapa(midiendo.desde.f, midiendo.desde.c), e.latlng]); }
  function cancelarMedida() {
    mapa.off("mousemove", seguir);
    midiendo = null;
    capaMedida?.remove(); capaMedida = null;
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && midiendo) { cancelarMedida(); avisar("Medición cancelada."); } });

  const ocupaClic = () => !!midiendo;
  async function alClic(celda) {
    const a = midiendo.desde;
    mapa.off("mousemove", seguir);
    midiendo.guia.setLatLngs([aMapa(a.f, a.c), aMapa(celda.f, celda.c)]);
    L.circleMarker(aMapa(celda.f, celda.c), { radius: 5, color: "#fff", weight: 2, fillColor: "#e52918", fillOpacity: 1 }).addTo(capaMedida);
    midiendo = null;
    if (!cfgExp) cfgExp = await leerHttp(`${RAIZ}/config/expedicion.json`, "json");
    const pa = ll(a), pb = ll(celda);
    const d = distancia(pa.lon, pa.lat, pb.lon, pb.lat), r = rumbo(pa.lon, pa.lat, pb.lon, pb.lat);
    const id = ++pedido;
    estado.medida = { id, a, b: celda, d, r };
    estado.worker.postMessage({ tipo: "perfil", pedido: id, a, b: celda, paso: estado.zona.paso });
  }

  function alPerfil(p) {
    const m = estado.medida;
    if (!m || p.pedido !== m.id) return;
    const lim = estado.limitePendiente.valor;
    const pendMax = Math.max(...p.muestras.map((s) => s.pendiente).filter(Number.isFinite));
    const empinado = p.muestras.filter((s) => s.pendiente > lim).length;
    const pasos = estado.zona.meta.vehiculo === "rover" ? null : contarPasos(m.d, cfgExp);
    const cuerpo = mostrarTarjeta("Medición", `
      <dl class="dato-ubicacion">
        <dt>Distancia</dt><dd>${fmt.dist(m.d)} en línea recta${pasos ? ` · ≈ ${num(pasos.pasos)} pasos` : ""}</dd>
        <dt>Rumbo</dt><dd>${num(m.r)}° (${PUNTOS[Math.round(m.r / 45) % 8]})</dd>
        <dt>Desnivel</dt><dd>${p.desnivel === null ? "sin datos en parte de la línea" : `${fmt.alt(p.desnivel, 1)} · sube ${fmt.alt(p.subida)}, baja ${fmt.alt(p.bajada)}`}</dd>
        <dt>Pendiente</dt><dd>máx. ${fmt.pend(pendMax)}${empinado ? ` · <span class="falla">${num((empinado / p.muestras.length) * 100)} % de la línea supera ${fmt.pend(lim)}</span>` : " · toda la línea es caminable"}</dd>
        <dt>Desde</dt><dd>${texto(m.a)}</dd><dt>Hasta</dt><dd>${texto(m.b)}</dd>
      </dl>
      <canvas class="perfil" height="100" aria-label="Perfil de altura de la línea medida"></canvas>
      <p class="ayuda">Línea recta, no es una ruta: para caminarla usá «Ruta» o el itinerario.</p>`, cancelarMedida);
    dibujarPerfilLinea(cuerpo.querySelector("canvas"), p.muestras, lim);
  }

  function dibujarPerfilLinea(lienzo, muestras, lim) {
    const dpr = window.devicePixelRatio || 1, w = lienzo.clientWidth || 260, h = lienzo.clientHeight || 100;
    lienzo.width = w * dpr; lienzo.height = h * dpr;
    const g = lienzo.getContext("2d");
    g.scale(dpr, dpr);
    const vals = muestras.filter((s) => Number.isFinite(s.altura));
    if (vals.length < 2) return;
    const zMin = Math.min(...vals.map((s) => s.altura)), zMax = Math.max(...vals.map((s) => s.altura)), dMax = muestras.at(-1).d || 1;
    const X = (d) => 34 + (d / dMax) * (w - 40), Y = (z) => h - 14 - ((z - zMin) / Math.max(zMax - zMin, 1)) * (h - 24);
    g.font = "10px monospace"; g.fillStyle = "#8b95a1";
    g.fillText(`${num(zMax)} m`, 0, 10); g.fillText(`${num(zMin)} m`, 0, h - 14);
    for (let k = 1; k < muestras.length; k++) {
      const a = muestras[k - 1], b = muestras[k];
      if (!Number.isFinite(a.altura) || !Number.isFinite(b.altura)) continue;
      g.strokeStyle = b.pendiente > lim ? "#d33a2c" : "#f74f25";
      g.lineWidth = b.pendiente > lim ? 2.5 : 1.6;
      g.beginPath(); g.moveTo(X(a.d), Y(a.altura)); g.lineTo(X(b.d), Y(b.altura)); g.stroke();
    }
  }

  // ---------- Ir a coordenadas / copiar ----------
  function irACoordenadas() {
    const cuerpo = mostrarTarjeta("Ir a coordenadas", `
      <form class="ir-a"><input type="text" placeholder="4,82234 S 137,38657 E" aria-label="Coordenadas" autocomplete="off">
      <button type="submit" class="primario chico">Ir</button></form>
      <p class="ayuda">Acepta «4,82234 S 137,38657 E», «-4.82234, 137.38657» o «4°49'20" S 137°23'12" E». Longitud este.</p>
      <p class="ir-resultado"></p>`);
    const form = cuerpo.querySelector("form"), entrada = form.querySelector("input");
    entrada.focus();
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const p = leerCoordenadas(entrada.value);
      const salida = cuerpo.querySelector(".ir-resultado");
      if (!p) { salida.textContent = "No entendí esas coordenadas."; salida.className = "ir-resultado falla"; return; }
      const z = estado.zona, c = lonLatACelda(z.meta, p.lon, p.lat);
      const f = Math.round(c.f), cc = Math.round(c.c);
      if (f < 0 || cc < 0 || f >= z.alto || cc >= z.ancho) { salida.textContent = `${formatoCoordenadas(p.lat, p.lon)} queda fuera de esta zona.`; salida.className = "ir-resultado falla"; return; }
      marcaIr?.remove();
      marcaIr = L.marker(aMapa(f, cc), { icon: L.divIcon({ className: "", html: '<div class="pulso"></div>', iconSize: [26, 26], iconAnchor: [13, 13] }), interactive: false }).addTo(mapa);
      mapa.setView(aMapa(f, cc), Math.max(mapa.getZoom(), 1));
      salida.textContent = `Listo: ${formatoCoordenadas(p.lat, p.lon)}.`;
      salida.className = "ir-resultado";
    });
  }

  async function copiar(celda) {
    const t = texto(celda);
    try { await navigator.clipboard.writeText(t); avisar(`Copiado: ${t}`); } catch { avisar(`Coordenadas: ${t}`); }
  }

  // ---------- Radio ----------
  async function radioDesde(celda) {
    if (!cfgRadio) cfgRadio = await leerHttp(`${RAIZ}/config/radio.json`, "json");
    const ruta = ctx.rutaActual();
    estado.radioPedido = { id: ++pedido, celda };
    avisar("Calculando la línea de vista de la radio sobre el relieve…");
    estado.worker.postMessage({
      tipo: "radio", pedido: pedido, cfg: cfgRadio, antenas: [{ ...celda, tipo: "base" }, ...ctx.balizas()],
      ruta: ruta?.sim?.celdas || null, tiempos: ruta?.sim?.t || null,
    });
  }

  async function alRadio(d) {
    const p = estado.radioPedido;
    if (!p || d.pedido !== p.id) return;
    capaRadio?.remove();
    capaRadio = L.layerGroup([
      capaLienzo(imagenDesdeLut(d.visible, null, [[0, 0, 0, 0], [70, 210, 140, 85]]), bordes()),
      L.marker(aMapa(p.celda.f, p.celda.c), { icon: L.divIcon({ className: "", html: '<div class="antena" title="Antena">⌁</div>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false }),
    ]).addTo(mapa);
    const c = cfgRadio, tr = d.tramos;
    const regla = c.max_min_sin_cobertura.valor;
    let rutaHtml = '<p class="ayuda">Calculá una ruta o un itinerario para ver dónde se pierde el enlace.</p>';
    if (tr) {
      rutaHtml = tr.tramos.length
        ? `<p class="${tr.max_minutos > regla ? "falla" : "alerta"}">La ruta queda sin enlace en ${num(tr.tramos.length)} tramos; el más largo dura ${num(tr.max_minutos, 1)} min (regla propuesta: ≤ ${num(regla)} min).</p>`
        : '<p class="ok">Toda la ruta tiene línea de vista con la antena.</p>';
    }
    const cuerpo = mostrarTarjeta("Cobertura de radio", `
      <dl class="dato-ubicacion">
        <dt>Cobertura</dt><dd>${num(d.fraccion * 100, 1)} % de la zona con línea de vista</dd>
        <dt>Supuestos</dt><dd>antena a ${num(c.altura_base_m.valor)} m, radio del traje a ${num(c.altura_radio_m.valor, 1)} m, alcance ${num(c.alcance_max_m.valor / 1000, 1)} km, curvatura de Marte (propuestas, a calibrar)</dd>
      </dl>${rutaHtml}
      ${d.baliza ? `<p>Baliza sugerida: cubriría ${num(d.baliza.metros ?? d.baliza.metros_cubiertos ?? 0)} m de ruta sin enlace.</p><button type="button" class="chico primario" data-baliza>Agregar baliza al plan</button>` : ""}
      <p class="ayuda">Solo geometría (línea de vista sobre el relieve de HiRISE); no modela la potencia ni el ruido de la radio.</p>`,
    () => { capaRadio?.remove(); capaRadio = null; });
    cuerpo.querySelector("[data-baliza]")?.addEventListener("click", () => {
      const b = d.baliza, z = estado.zona;
      const celda = b.celda ?? (Number.isInteger(b.indice) ? { f: Math.floor(b.indice / z.ancho), c: b.indice % z.ancho } : { f: b.f, c: b.c });
      ctx.agregarMarca("baliza", celda);
    });
    avisar(`Radio: ${num(d.fraccion * 100, 1)} % de la zona con línea de vista desde ese punto.`);
  }

  // ---------- Luz y sombras ----------
  function centroZona() {
    const l = estado.zona.meta.limites;
    return { lon: (l.lon_oeste + l.lon_este) / 2, lat: (l.lat_sur + l.lat_norte) / 2 };
  }

  function luzYSombras() {
    const { lon, lat } = centroZona();
    const ahora = Date.now();
    const sol = posicionSol(ahora, lon, lat);
    const dia = amanecerAtardecer(ahora, lon, lat);
    const hh = (h) => (h === null ? "—" : `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`);
    const desde = Math.ceil((dia.amanecer ?? 6) * 4) / 4, hasta = Math.floor((dia.atardecer ?? 18) * 4) / 4;
    const inicial = sol.elevacion > 0 ? sol.lmst : Math.min(Math.max(9, desde), hasta);
    const cuerpo = mostrarTarjeta("Luz y sombras", `
      <p>Hoy en la zona: amanece a las <b>${hh(dia.amanecer)}</b> y anochece a las <b>${hh(dia.atardecer)}</b> (hora solar media local). Ahora son las ${hh(sol.lmst)}${sol.elevacion > 0 ? "" : " y es de noche"}.</p>
      <label class="fila-sel">Hora del sol <input type="range" min="${desde}" max="${hasta}" step="0.25" value="${inicial}" data-hora></label>
      <p class="sol-lectura"></p><p class="ruta-luz"></p>
      <p class="ayuda">Sombras del relieve de HiRISE (bloques de 8 m) con la posición del Sol de Mars24, validada contra 700 amaneceres y atardeceres medidos por Curiosity (error medio 0,6 min).</p>`,
    () => { capaSombras?.remove(); capaSombras = null; });
    const rango = cuerpo.querySelector("[data-hora]");
    const pedir = () => {
      const h = Number(rango.value);
      const ms = ahora + ((h - sol.lmst) / 24) * SOL_MS;
      const s = posicionSol(ms, lon, lat);
      cuerpo.querySelector(".sol-lectura").textContent = `${hh(h)} · Sol a ${num(s.elevacion, 1)}° de altura, azimut ${num(s.azimut)}° (${PUNTOS[Math.round(s.azimut / 45) % 8]}).`;
      const ruta = ctx.rutaActual();
      estado.sombrasPedido = ++pedido;
      estado.worker.postMessage({ tipo: "sombras", pedido, sol: { elevacion: s.elevacion, azimut: s.azimut }, reduccion: 4, ruta: ruta?.celdas || null });
    };
    let espera = null;
    rango.addEventListener("input", () => { clearTimeout(espera); espera = setTimeout(pedir, 120); });
    pedir();
  }

  async function alSombras(d) {
    if (d.pedido !== estado.sombrasPedido) return;
    const lut = [[0, 0, 0, 0], [8, 10, 30, 150]];
    const z = estado.zona;
    const lienzo = document.createElement("canvas");
    lienzo.width = d.ancho; lienzo.height = d.alto;
    const g = lienzo.getContext("2d"), img = g.createImageData(d.ancho, d.alto);
    for (let i = 0; i < d.sombra.length; i++) { const o = lut[d.sombra[i] ? 1 : 0]; img.data.set(o, i * 4); }
    g.putImageData(img, 0, 0);
    const capa = capaLienzo(lienzo, [[-d.alto * (d.paso / z.paso), 0], [0, d.ancho * (d.paso / z.paso)]]);
    capaSombras?.remove();
    capaSombras = capa.addTo(mapa);
    const p = tarjeta.querySelector(".ruta-luz");
    if (p) p.textContent = d.ruta ? `Ruta elegida: ${num((d.ruta.fraccion ?? d.ruta.metros / Math.max(d.ruta.total, 1)) * 100)} % en sombra (${num(d.ruta.metros)} m).` : "";
  }

  function limpiar() {
    cancelarMedida();
    cerrarTarjeta();
    marcaIr?.remove(); marcaIr = null;
    capaRadio?.remove(); capaRadio = null;
    capaSombras?.remove(); capaSombras = null;
  }

  return { medirDesde, ocupaClic, alClic, alPerfil, irACoordenadas, copiar, radioDesde, alRadio, luzYSombras, alSombras, limpiar, mostrarTarjeta, cerrarTarjeta };
}
