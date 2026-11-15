// Trazado manual: la tripulación pone los puntos y el motor de riesgo verifica cada tramo.
// Un tramo que cruza terreno prohibido o sale de la zona segura queda en rojo con su motivo y se
// puede ajustar al camino seguro entre sus dos puntos. El plan pasa por la misma decisión sí / no.

export function crearManual(ctx) {
  const { mapa, estado, $, num, aMapa, deMapa, avisar, decisionHtml, dibujarPerfil, duracion, animarTrazo } = ctx;
  const m = { puntos: [], tramos: [], lineas: [], version: 0, ultimo: null };

  const icono = (n) => L.divIcon({ className: "", html: `<div class="marca punto">${n}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
  const minutosDestino = () => estado.riesgo[estado.zona.meta.vehiculo === "rover" ? "rover" : "pie"].tiempo_en_destino_min.valor;

  function borrarLineas() {
    m.lineas.forEach((l) => l.remove());
    m.lineas = [];
  }

  function limpiar() {
    borrarLineas();
    m.puntos.forEach((p) => p.marker.remove());
    m.puntos = [];
    m.tramos = [];
    m.ultimo = null;
    m.version++;
    $("#manual-plan").innerHTML = "";
    $("#perfil").hidden = true;
    dibujarLista();
  }

  function renumerar() {
    m.puntos.forEach((p, k) => p.marker.setIcon(icono(k + 1)));
  }

  // Al mover o borrar un punto, los tramos que lo tocan vuelven a ser rectas sin ajustar.
  function soltarTramos(k) {
    if (m.tramos[k]) m.tramos[k].celdas = null;
    if (m.tramos[k + 1]) m.tramos[k + 1].celdas = null;
  }

  function agregar(celda) {
    const p = { celda, paradaMin: 0 };
    p.marker = L.marker(aMapa(celda.f, celda.c), { icon: icono(m.puntos.length + 1), draggable: true, keyboard: true, title: "Punto del plan" }).addTo(mapa);
    p.marker.on("dragend", () => {
      const nueva = deMapa(p.marker.getLatLng());
      if (!nueva) { p.marker.setLatLng(aMapa(p.celda.f, p.celda.c)); return; }
      p.celda = nueva;
      soltarTramos(m.puntos.indexOf(p));
      verificar();
    });
    p.marker.on("contextmenu", () => quitar(m.puntos.indexOf(p)));
    m.puntos.push(p);
    m.tramos.push({ celdas: null });
    renumerar();
    verificar();
  }

  function quitar(k) {
    if (k < 0) return;
    m.puntos[k].marker.remove();
    m.puntos.splice(k, 1);
    m.tramos.splice(k, 1);
    if (m.tramos[k]) m.tramos[k].celdas = null; // el tramo siguiente ahora sale de otro punto
    renumerar();
    verificar();
  }

  // Pide la verificación del plan completo al worker. Sin base o sin zona segura, espera.
  function verificar() {
    dibujarLista();
    const base = estado.marcas.base?.celda;
    if (!base || !estado.region || !m.puntos.length) {
      borrarLineas();
      $("#manual-plan").innerHTML = "";
      return;
    }
    const desde = (k) => (k === 0 ? base : m.puntos[k - 1].celda);
    const paradas = m.puntos.map((p, k) => (k === m.puntos.length - 1 ? (p.paradaMin || minutosDestino()) : p.paradaMin));
    estado.worker.postMessage({
      tipo: "manual", version: ++m.version, inicio: base, paradasMin: paradas,
      tramos: m.puntos.map((p, k) => ({ desde: desde(k), hasta: p.celda, celdas: m.tramos[k].celdas })),
    });
  }

  function ajustar(k) {
    const base = estado.marcas.base.celda;
    avisar(`Buscando el camino seguro del tramo ${k + 1}…`);
    estado.worker.postMessage({
      tipo: "tramo", indice: k, inicio: base, perfil: estado.perfiles[0],
      desde: k === 0 ? base : m.puntos[k - 1].celda, hasta: m.puntos[k].celda,
    });
  }

  function alResponderTramo(data) {
    if (!data.celdas) {
      const motivo = { inicio: "el inicio del tramo está en terreno prohibido o fuera de la zona segura",
        destino: "el punto final está en terreno prohibido o fuera de la zona segura",
        sin_camino: "no existe un camino seguro entre esos dos puntos" }[data.error] || data.error;
      avisar(`No se pudo ajustar el tramo ${data.indice + 1}: ${motivo}. Mové el punto.`);
      return;
    }
    m.tramos[data.indice].celdas = data.celdas;
    avisar(`Tramo ${data.indice + 1} ajustado al camino seguro.`);
    verificar();
  }

  function alResponder(data) {
    if (data.version !== m.version) return; // respuesta vieja
    m.ultimo = data;
    borrarLineas();
    const z = estado.zona;
    data.tramos.forEach((t, k) => {
      const color = t.ok ? "#4cc488" : "#d33a2c";
      const motivos = t.motivos.map((x) => `${x.texto} (${num(x.metros)} m)`).join("; ");
      const linea = L.polyline(t.celdas.map((i) => aMapa(Math.floor(i / z.ancho), i % z.ancho)),
        { color, weight: 5, opacity: 0.95, dashArray: t.ok ? null : "8 6" })
        .bindTooltip(t.ok ? `Tramo ${k + 1}: apto${t.ajustado ? " (ajustado)" : ""}` : `Tramo ${k + 1}: ${motivos}. Tocá para ajustarlo al camino seguro.`)
        .addTo(mapa);
      if (!t.ok) linea.on("click", (e) => { L.DomEvent.stop(e); ajustar(k); });
      if (t.ajustado || !m.ultimoDibujado?.has(k)) animarTrazo(linea);
      m.lineas.push(linea);
    });
    m.ultimoDibujado = new Set(data.tramos.map((_, k) => k));
    const r = data.ruta, ev = data.evaluacion;
    $("#manual-plan").innerHTML = `${decisionHtml(ev)}
      <div class="datos resumen">
        <span>${num(r.distancia / 1000, 2)} km de ida</span><span>${duracion(r.tiempo)} de marcha</span>
        <span>Sube ${num(r.sube)} m</span><span>Baja ${num(r.baja)} m</span>
        <span>Paradas intermedias: ${num(r.paradasMin)} min</span><span>Pendiente máx. ${num(r.pendMax, 1)}°</span>
      </div>
      <p class="ayuda">La vuelta se calcula por el camino seguro más corto hasta la base.</p>`;
    dibujarPerfil(r, ev.decision === "SI" ? "#4cc488" : "#d33a2c");
    dibujarLista();
  }

  // Lista de puntos: tiempo de parada en cada uno y estado del tramo que llega a él.
  function dibujarLista() {
    const ul = $("#puntos");
    ul.innerHTML = "";
    m.puntos.forEach((p, k) => {
      const t = m.ultimo?.tramos?.[k];
      const li = document.createElement("li");
      const ultimo = k === m.puntos.length - 1;
      li.innerHTML = `<span class="num">${k + 1}</span>
        <span class="estado-tramo ${t ? (t.ok ? "ok" : "falla") : ""}">${t ? (t.ok ? "✔ tramo apto" : `✖ ${t.motivos[0].texto}`) : "…"}</span>
        <label>parada <input type="number" min="0" max="480" step="5" value="${ultimo && !p.paradaMin ? minutosDestino() : p.paradaMin}"> min</label>
        <button type="button" class="chico" title="Quitar el punto">✕</button>`;
      li.querySelector("input").addEventListener("change", (e) => {
        p.paradaMin = Math.max(0, Number(e.target.value) || 0);
        verificar();
      });
      li.querySelector("button").addEventListener("click", () => quitar(k));
      if (t && !t.ok) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chico primario";
        b.textContent = "Ajustar tramo";
        b.addEventListener("click", () => ajustar(k));
        li.append(b);
      }
      ul.append(li);
    });
    $("#deshacer").disabled = !m.puntos.length;
  }

  $("#deshacer").addEventListener("click", () => quitar(m.puntos.length - 1));

  return { agregar, limpiar, verificar, alResponder, alResponderTramo, hayPuntos: () => m.puntos.length > 0 };
}
