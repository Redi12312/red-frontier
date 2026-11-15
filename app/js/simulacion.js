// Visor (HUD) de la simulación de la salida. Acá no hay reglas: toda la lógica (consumo, plazos, veredictos,
// fallas encadenadas) sale del motor puro de motor-simulacion.js; este módulo arma sus datos, le pasa el
// tiempo, pide al Worker el camino de regreso cuando el motor lo solicita y dibuja el estado.
// Consumo según la trayectoria: consumibles.perfilRuta (modelado, a calibrar) con el relieve de la zona.

import { t } from "./idioma.js";
import { crearMotor, recursosTraje } from "./motor-simulacion.js";
import { perfilRuta } from "./consumibles.js";
import { altura, leerHttp } from "./zona.js";

const VELOCIDADES = [10, 60, 300];
const TEXTO_MS = 200; // el texto del visor se actualiza a 5 Hz como máximo
const AVISO_MS = 5000;
const URL_CONSUMIBLES = new URL("../../config/consumibles.json", import.meta.url).href;
const VEREDICTOS = {
  CONTINUAR: "CONTINUAR", TERMINAR: "TERMINAR", ABORTAR: "ABORTAR",
  ESPERANDO_CAMINO: "CALCULANDO REGRESO", A_SALVO: "A SALVO", NO_ALCANZA: "NO ALCANZA",
};
const FALLAS = {
  fuga: "Fuga en el traje", companero: "Compañero incapacitado", tormenta: "Tormenta solar",
  radio: "Pérdida de radio", rover: "Rover averiado", volver: "Regreso ordenado",
};
const LIMITES = {
  o2: "oxígeno primario", co2: "absorción de CO₂", bateria: "batería del traje", agua: "agua de enfriamiento",
  "plazo:tormenta": "plazo de la tormenta", "plazo:companero": "plazo de rescate", "plazo:rover": "caminata máxima",
};
const RELOJES = { 10: "1 s real = 10 s de salida", 60: "1 s real = 1 min de salida", 300: "1 s real = 5 min de salida" };

const dos = (x) => (x < 10 ? "0" : "") + x;
const hms = (s) => {
  if (!Number.isFinite(s)) return "—";
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 3600)}:${dos(Math.floor((s % 3600) / 60))}:${dos(s % 60)}`;
};
// El motor arma el motivo con oraciones completas: se traduce cada una por separado.
const traducirMotivo = (texto) => texto.split(/(?<=\.)\s+/u).map((frase) => t(frase)).join(" ");

let cfgConsumibles = null; // promesa; se lee una sola vez
function leerConsumibles() {
  cfgConsumibles ??= leerHttp(URL_CONSUMIBLES, "json").catch(() => { cfgConsumibles = null; return null; });
  return cfgConsumibles;
}

export function crearSimulacion(ctx) {
  const { mapa, estado, $, num, fmt, aMapa, avisar } = ctx;
  const hud = $("#hud");
  let sim = null, capa = null, cuadro = null, respaldo = null, ultimo = 0, pedido = 0, turno = 0, cargando = false, relojAviso = null;

  const fc = (i) => [Math.floor(i / estado.zona.ancho), i % estado.zona.ancho];

  // ---------- Datos para el motor ----------

  // Límites del motor desde las reglas efectivas (ya incluyen lo configurado en Opciones).
  function configuracion() {
    const R = estado.riesgo, pie = R.pie, rover = estado.zona.meta.vehiculo === "rover", r = rover ? R.rover : pie;
    return {
      primario_s: r.consumibles_primarios_h.valor * 3600,
      secundario_s: pie.regreso_emergencia_max_min.valor * 60,
      ingreso_s: pie.ingreso_refugio_min.valor * 60,
      colchon: pie.colchon_regreso.valor,
      margen_terminar_s: (r.margen_terminar_min ?? pie.margen_terminar_min).valor * 60,
      rescate_max_s: pie.rescate_max_min.valor * 60,
      // Si la regla todavía no está en config/riesgo.json se usan 30 min, propuesta a calibrar.
      tormenta_refugio_s: (pie.tormenta_refugio_min?.valor ?? 30) * 60,
      caminata_max_s: rover ? R.rover.regreso_a_pie_max_h.valor * 3600 : null,
      vehiculo: rover ? "rover" : "pie",
    };
  }

  // Ruta del Worker → ruta del motor, con el consumo de cada tramo según el relieve.
  function armarRuta(s, cfg, consumibles) {
    const z = estado.zona, n = s.celdas.length;
    const celdas = Array.from(s.celdas), tiempos = Array.from(s.t);
    const finito = (x) => (Number.isFinite(x) ? x : null);
    const d = [0];
    for (let k = 1; k < n; k++) {
      const i = celdas[k - 1], j = celdas[k];
      const diag = (i % z.ancho) !== (j % z.ancho) && ((i / z.ancho) | 0) !== ((j / z.ancho) | 0);
      d.push(d[k - 1] + (i === j ? 0 : diag ? z.paso * Math.SQRT2 : z.paso)); // celda repetida = parada
    }
    const ruta = {
      celdas, t: tiempos, d, regreso: Array.from(s.regreso, finito),
      rescate: s.rescate ? Array.from(s.rescate, finito) : null,
    };
    const notas = [];
    if (!consumibles) {
      notas.push("No se pudo leer config/consumibles.json: oxígeno a tasa nominal, sin CO₂, batería ni agua.");
      return { ruta, notas, plan: null };
    }
    try {
      let tasaO2, metabolismo_w;
      if (cfg.vehiculo === "rover") {
        // El modelo de marcha no vale arriba del rover: se usa la tasa nominal de las reglas.
        const m = consumibles.metabolismo;
        tasaO2 = new Float64Array(n).fill(1);
        metabolismo_w = new Float64Array(n).fill(m.apollo_promedio_kcal_h.valor * consumibles.conversiones.julios_por_kcal.valor / 3600);
        notas.push("En rover no se aplica el modelo de marcha: consumo nominal en todo el recorrido.");
      } else {
        // Altura de cada punto de la ruta; un hueco sin dato repite la altura vecina.
        const elevaciones = celdas.map((i) => altura(z.meta, z.crudo.elevQ[i]));
        let previa = elevaciones.find(Number.isFinite);
        if (previa === undefined) throw new Error("La ruta no tiene alturas.");
        for (let k = 0; k < n; k++) { if (Number.isFinite(elevaciones[k])) previa = elevaciones[k]; else elevaciones[k] = previa; }
        ({ tasaO2, metabolismo_w } = perfilRuta({ celdas, t: tiempos, d, elevaciones, cfg: consumibles,
          personas: estado.riesgo.pie.tripulacion?.valor ?? 2 }));
      }
      ruta.tasaO2 = tasaO2;
      ruta.recursos = recursosTraje({ tasaO2, metabolismo_w, cfg: consumibles });
      // Cuánto de cada recurso pide la ruta completa, por persona (fracción de la capacidad).
      const gasto = (tasa) => { let x = 0; for (let k = 0; k + 1 < n; k++) x += tasa[k] * (tiempos[k + 1] - tiempos[k]); return x; };
      const plan = [{ id: "o2", fraccion: gasto(tasaO2) / cfg.primario_s },
        ...ruta.recursos.map((r) => ({ id: r.id, fraccion: gasto(r.tasa) / r.capacidad }))];
      return { ruta, notas, plan };
    } catch (err) {
      delete ruta.tasaO2; delete ruta.recursos;
      notas.push(`No se pudo calcular el consumo por tramo (${err.message}): oxígeno a tasa nominal, sin CO₂, batería ni agua.`);
      return { ruta, notas, plan: null };
    }
  }

  // ---------- Inicio y fin ----------

  function iniciar(ruta, titulo, inicio) {
    detener();
    if (!ruta?.sim?.celdas?.length) { avisar("Esa ruta no trae los datos para simular."); return; }
    const mio = ++turno, zona = estado.zona;
    cargando = true;
    leerConsumibles().then((consumibles) => {
      if (mio !== turno) return; // se detuvo o se pidió otra simulación mientras cargaba
      cargando = false;
      if (estado.zona !== zona) return;
      try { arrancar(ruta.sim, titulo, inicio, consumibles); } catch (err) {
        detener();
        avisar(`No se pudo simular esta ruta: ${err.message}`);
      }
    });
  }

  function arrancar(s, titulo, inicio, consumibles) {
    const cfg = configuracion();
    const { ruta, notas, plan } = armarRuta(s, cfg, consumibles);
    const motor = crearMotor({ ruta, cfg });
    sim = {
      s, titulo, inicio, cfg, ruta, plan, notas, motor, e: motor.estado, rover: cfg.vehiculo === "rover",
      velocidad: 60, pausa: false, pendiente: null, ultimoK: -1, ultimaCelda: -1, ultimoTexto: 0,
      txt: {}, n: {}, anchos: {}, firmaFallas: null, lineaRegreso: null,
    };
    capa = L.layerGroup().addTo(mapa);
    sim.rastro = L.polyline([], { color: "#ffffff", weight: 3, opacity: 0.9, interactive: false }).addTo(capa);
    sim.astro = L.marker(aMapa(...fc(ruta.celdas[0])), { icon: L.divIcon({ className: "", html: '<div class="astronauta" title="Tripulación">A</div>', iconSize: [24, 24], iconAnchor: [12, 12] }), interactive: false, zIndexOffset: 1000 }).addTo(capa);
    armarHud();
    hud.hidden = false;
    dibujar(true);
    ultimo = performance.now();
    cuadro = requestAnimationFrame(paso);
    clearInterval(respaldo);
    // Si el navegador no entrega cuadros (pestaña oculta o panel fuera de pantalla), el reloj sigue igual.
    respaldo = setInterval(() => { const ahora = performance.now(); if (sim && !sim.e.fin && ahora - ultimo > 150) tic(ahora); }, 100);
    const falta = plan?.find((p) => p.fraccion > 1);
    avisar(falta
      ? `Simulación de la salida (${titulo}). Ojo: la ruta completa pide más ${t(LIMITES[falta.id])} del que lleva el traje.`
      : `Simulación de la salida (${titulo}). Probá inyectar una falla para ver la decisión de aborto.`);
  }

  function detener() {
    turno++;
    cargando = false;
    if (cuadro) cancelAnimationFrame(cuadro);
    cuadro = null;
    clearInterval(respaldo); respaldo = null;
    clearTimeout(relojAviso); relojAviso = null;
    capa?.remove(); capa = null;
    sim = null;
    hud.hidden = true;
    hud.innerHTML = "";
    delete hud.dataset.nivel;
  }

  // ---------- Visor ----------

  function armarHud() {
    const { cfg, rover, plan } = sim;
    const recurso = (id, nombre, detalle) => `<div class="visor-recurso" data-r="${id}"><span>${nombre}${detalle ? ` <small data-no-traducir>${detalle}</small>` : ""}</span>
      <b data-no-traducir data-v="r-${id}">—</b><i class="visor-barra"><u data-b="${id}"></u></i></div>`;
    const capacidad = (r) => `${num(r.capacidad, r.capacidad < 10 ? 1 : 0)} ${r.unidad}`;
    const etiquetas = { co2: "CO₂ por absorber", bateria: "Batería", agua: "Agua de enfriamiento" };
    const previsto = plan ? plan.map((p) => `<span class="${p.fraccion > 1 ? "falla" : ""}"><span>${{ o2: "O₂", co2: "CO₂", bateria: "batería", agua: "agua" }[p.id]}</span> <b data-no-traducir>${num(p.fraccion * 100)} %</b></span>`).join("") : "";
    hud.innerHTML = `
      <div class="visor-cabeza"><span class="visor-lampara"></span><b class="visor-veredicto" data-no-traducir data-v="veredicto"></b>
        <span class="visor-titulo"></span><button type="button" class="mini" data-cerrar title="Terminar la simulación">✕</button></div>
      <div class="visor-motivo" data-no-traducir data-v="motivo"></div>
      <div class="visor-camino" data-no-traducir data-v="camino" hidden></div>
      <div class="visor-aviso" data-no-traducir data-v="aviso" role="status" hidden></div>
      <div class="visor-grilla">
        <div><span>Tiempo afuera (h:min:s reales)</span><b data-no-traducir data-v="t">0:00:00</b></div>
        <div><span>Regreso al refugio <small data-no-traducir>+ ${num(cfg.ingreso_s / 60)} min</small> <small>de ingreso</small></span><b data-no-traducir data-v="regreso"></b></div>
        <div><span>Margen para volver</span><b data-no-traducir data-v="margen"></b></div>
        <div><span>Recorrido</span><b data-no-traducir data-v="dist"></b></div>
        <div><span>Consumo ahora (× nominal)</span><b data-no-traducir data-v="tasa"></b></div>
        <div><span>Lo que limita</span><b data-no-traducir data-v="limita"></b></div>
      </div>
      <div class="visor-recursos">
        ${recurso("o2", rover ? "Consumibles primarios" : "Oxígeno primario", `${num(cfg.primario_s / 3600, 1)} h`)}
        ${recurso("o2s", "Oxígeno secundario", `${num(cfg.secundario_s / 60)} min`)}
        ${(sim.ruta.recursos ?? []).map((r) => recurso(r.id, etiquetas[r.id] ?? r.nombre, capacidad(r))).join("")}
      </div>
      ${previsto ? `<div class="visor-plan"><span>Ruta completa, por persona (modelado, a calibrar):</span>${previsto}</div>` : ""}
      ${sim.notas.map((x) => `<div class="visor-nota">${x}</div>`).join("")}
      <div class="visor-activas" data-v="activas" hidden></div>
      <div class="visor-fallas" role="group" aria-label="Inyectar una falla">
        <span>Inyectar falla:</span>
        ${(rover ? ["rover", "tormenta", "radio"] : ["fuga", "companero", "tormenta", "radio"]).map((f) => `<button type="button" data-falla="${f}">${FALLAS[f]}</button>`).join("")}
      </div>
      <div class="visor-control">
        <button type="button" data-pausa title="Pausa">⏸</button>
        ${VELOCIDADES.map((v) => `<button type="button" data-no-traducir data-vel="${v}" class="${v === sim.velocidad ? "activo" : ""}">×${v}</button>`).join("")}
        <span class="visor-reloj" data-no-traducir data-v="reloj"></span>
        <button type="button" data-falla="volver">Volver ahora</button>
        <button type="button" data-reiniciar>Reiniciar</button>
      </div>`;
    hud.querySelector(".visor-titulo").textContent = sim.titulo;
    hud.querySelectorAll("[data-v]").forEach((x) => { sim.n[x.dataset.v] = x; });
    hud.querySelectorAll("[data-b]").forEach((x) => { sim.n[`b-${x.dataset.b}`] = x; });
    hud.querySelectorAll("[data-r]").forEach((x) => { sim.n[`c-${x.dataset.r}`] = x; });
    L.DomEvent.disableClickPropagation(hud);
    L.DomEvent.disableScrollPropagation(hud);
    hud.querySelector("[data-cerrar]").addEventListener("click", detener);
    hud.querySelector("[data-pausa]").addEventListener("click", (e) => {
      sim.pausa = !sim.pausa;
      e.currentTarget.textContent = sim.pausa ? "▶" : "⏸";
      dibujar(true);
    });
    hud.querySelectorAll("[data-vel]").forEach((b) => b.addEventListener("click", () => {
      sim.velocidad = +b.dataset.vel;
      hud.querySelectorAll("[data-vel]").forEach((x) => x.classList.toggle("activo", x === b));
      dibujar(true);
    }));
    hud.querySelectorAll("[data-falla]").forEach((b) => b.addEventListener("click", () => inyectar(b.dataset.falla)));
    hud.querySelector("[data-reiniciar]").addEventListener("click", () => { const { s, titulo, inicio } = sim; iniciar({ sim: s }, titulo, inicio); });
  }

  // Escribe solo si cambió: el traductor que observa el DOM y el navegador no trabajan de más.
  function poner(clave, texto) {
    if (sim.txt[clave] === texto) return;
    sim.txt[clave] = texto;
    sim.n[clave].textContent = texto;
  }
  function barra(id, fraccion) {
    const ancho = Math.round(Math.max(0, Math.min(1, fraccion)) * 200) / 2; // pasos de 0,5 %
    if (sim.anchos[id] === ancho) return;
    sim.anchos[id] = ancho;
    sim.n[`b-${id}`].style.width = `${ancho}%`;
  }
  const medidor = (id, fraccion, autonomia) => {
    poner(`r-${id}`, `${Math.round(Math.max(0, fraccion) * 100)} % · ${hms(autonomia)}`);
    barra(id, fraccion);
  };

  function mostrarAviso(texto) {
    const nodo = sim.n.aviso;
    nodo.textContent = t(texto);
    nodo.hidden = false;
    clearTimeout(relojAviso);
    relojAviso = setTimeout(() => { if (sim) sim.n.aviso.hidden = true; }, AVISO_MS);
  }

  // Fallas activas con el plazo que le queda a cada una. Los nodos se rehacen solo si cambia la lista.
  function dibujarFallas(e) {
    const firma = e.fallas.join(",");
    const caja = sim.n.activas;
    if (firma !== sim.firmaFallas) {
      sim.firmaFallas = firma;
      caja.hidden = !e.fallas.length;
      caja.innerHTML = e.fallas.length ? `<span>Fallas activas:</span>${e.fallas.map((f) => `<span class="visor-chip" data-tipo="${f}"><span>${FALLAS[f]}</span><b data-no-traducir data-p="${f}"></b></span>`).join("")}` : "";
      sim.plazos = {};
      caja.querySelectorAll("[data-p]").forEach((x) => { sim.plazos[x.dataset.p] = { nodo: x, texto: "" }; });
      hud.querySelectorAll("[data-falla]").forEach((b) => b.classList.toggle("inyectada", e.fallas.includes(b.dataset.falla)));
    }
    for (const f of e.fallas) {
      // La fuga no tiene un plazo fijo: le queda lo que dure el oxígeno secundario a la tasa actual.
      const s = f === "fuga" ? e.o2.secundario_s / e.tasa : e.plazos[f];
      const texto = s === undefined ? "" : hms(s);
      const p = sim.plazos[f];
      if (p && p.texto !== texto) { p.texto = texto; p.nodo.textContent = texto; }
    }
  }

  function dibujar(forzar = false) {
    const e = sim.e;
    if (e.celda !== sim.ultimaCelda) {
      sim.ultimaCelda = e.celda;
      sim.astro.setLatLng(aMapa(...fc(e.celda)));
    }
    if (!e.enRegreso && e.k !== sim.ultimoK) {
      // El rastro solo crece: se agregan las celdas nuevas en vez de rehacer toda la línea.
      for (let j = sim.ultimoK + 1; j <= e.k; j++) sim.rastro.addLatLng(aMapa(...fc(sim.ruta.celdas[j])));
      sim.ultimoK = e.k;
    }
    const ahora = performance.now();
    if (!forzar && !e.fin && ahora - sim.ultimoTexto < TEXTO_MS) return;
    sim.ultimoTexto = ahora;

    if (hud.dataset.nivel !== e.nivel) hud.dataset.nivel = e.nivel;
    if (sim.txt.veredicto !== e.veredicto) { sim.txt.veredicto = e.veredicto; sim.n.veredicto.textContent = t(VEREDICTOS[e.veredicto]); }
    let motivo = e.motivo;
    if (!e.fin && !e.enRegreso && sim.s.idaYVuelta) {
      if (e.k > sim.s.finIda) motivo = `De vuelta por el mismo camino. ${motivo}`;
      else if (e.k === sim.s.finIda) motivo = `Trabajo en el destino. ${motivo}`;
    }
    if (sim.txt.motivo !== motivo) { sim.txt.motivo = motivo; sim.n.motivo.textContent = traducirMotivo(motivo); }

    const fuga = e.fallas.includes("fuga"), esperando = e.veredicto === "ESPERANDO_CAMINO";
    poner("t", hms(e.t));
    poner("regreso", e.regreso_s === null ? t("sin regreso") : hms(e.regreso_s));
    poner("margen", e.margen_s === null || e.fin ? "—" : e.margen_s > 0 ? hms(e.margen_s) : t("sin margen"));
    // num() crea un formateador: se llama solo cuando cambia el valor redondeado.
    const tasa100 = Math.round(e.tasa * 100);
    if (sim.tasa100 !== tasa100) { sim.tasa100 = tasa100; poner("tasa", `× ${num(tasa100 / 100, 2)}`); }
    const claveDist = e.enRegreso ? -1 : e.k;
    if (sim.claveDist !== claveDist) {
      sim.claveDist = claveDist;
      poner("dist", e.distancia_m === null ? t("regreso de emergencia") : `${fmt.dist(e.distancia_m)} / ${fmt.dist(sim.ruta.d.at(-1))}`);
    }
    const limita = e.limitante === "o2" && fuga ? "oxígeno secundario" : LIMITES[e.limitante] ?? e.limitante;
    if (sim.txt.limita !== limita) { sim.txt.limita = limita; sim.n.limita.textContent = t(limita); }
    if (sim.limitante !== e.limitante || sim.fuga !== fuga) {
      const marcado = e.limitante === "o2" ? (fuga ? "o2s" : "o2") : e.limitante;
      for (const id of ["o2", "o2s", ...e.recursos.map((r) => r.id)]) sim.n[`c-${id}`].classList.toggle("limita", id === marcado);
      sim.n["c-o2s"].classList.toggle("en-uso", fuga);
      sim.limitante = e.limitante; sim.fuga = fuga;
    }
    medidor("o2", e.o2.primario_s / sim.cfg.primario_s, e.o2.primario_s / e.tasa);
    medidor("o2s", sim.cfg.secundario_s ? e.o2.secundario_s / sim.cfg.secundario_s : 0, e.o2.secundario_s / e.tasa);
    for (const r of e.recursos) medidor(r.id, r.capacidad ? r.restante / r.capacidad : 0, r.autonomia_s);
    dibujarFallas(e);

    const reloj = e.fin ? "simulación terminada" : esperando ? "reloj detenido: calculando el regreso" : sim.pausa ? "en pausa" : RELOJES[sim.velocidad];
    if (sim.txt.reloj !== reloj) { sim.txt.reloj = reloj; sim.n.reloj.textContent = t(reloj); }
  }

  // ---------- Reloj, fallas y camino de regreso ----------

  // Avanza el motor y dibuja. Lo llama cada cuadro de animación y, con la pestaña oculta (el navegador frena la
  // animación), un reloj de respaldo: así la salida simulada no se congela en segundo plano.
  function tic(ahora) {
    if (!sim) return;
    const dt = Math.min((ahora - ultimo) / 1000, 1);
    ultimo = ahora;
    // Mientras se espera el camino el reloj queda quieto: el cálculo no le cuesta oxígeno a la tripulación.
    if (!sim.pausa && !sim.e.fin && sim.e.veredicto !== "ESPERANDO_CAMINO") {
      try { sim.e = sim.motor.avanzar(dt * sim.velocidad); } catch (err) { avisar(`Simulación detenida: ${err.message}`); detener(); return; }
      if (sim.e.pedirCamino && sim.pendiente === null) pedirCamino();
    }
    dibujar();
  }
  function paso(ahora) {
    if (!sim) return;
    tic(ahora);
    cuadro = sim?.e.fin ? null : requestAnimationFrame(paso);
  }

  // Un mensaje al Worker por cada pedido del motor; un evento nuevo deja viejo al pedido anterior.
  function pedirCamino() {
    const e = sim.e, [f, c] = fc(e.celda), id = ++pedido;
    sim.pendiente = id;
    try {
      estado.worker.postMessage({ tipo: "camino_regreso", pedido: id, campo: e.pedirCamino.campo, limite: e.pedirCamino.limite_s,
        inicio: sim.inicio, perfil: estado.perfiles[0], desde: { f, c } });
    } catch (err) {
      alError(String(err?.message || err));
    }
  }

  function inyectar(tipo) {
    if (!sim) return;
    const r = sim.motor.inyectar(tipo);
    sim.e = sim.motor.estado;
    if (r.ignorado) mostrarAviso(r.ignorado);
    if (r.pedirCamino) {
      sim.lineaRegreso?.remove(); sim.lineaRegreso = null; // el camino anterior ya no vale
      sim.n.camino.hidden = true;
      pedirCamino();
    } else if (sim.e.fin) sim.pendiente = null;
    dibujar(true);
  }

  // Respuesta del Worker: el camino al refugio (o ninguno) para el pedido vigente.
  function alCamino(d) {
    if (!sim || d?.pedido !== sim.pendiente) return; // respuesta vieja o de otra simulación
    sim.pendiente = null;
    try {
      sim.e = sim.motor.recibirCamino(d.celdas ? { celdas: d.celdas, tiempos: d.tiempos } : null);
    } catch (err) {
      mostrarAviso("El camino recibido no sirve: se toma como que no hay regreso.");
      sim.e = sim.motor.recibirCamino(null);
    }
    if (d.celdas) {
      sim.lineaRegreso = L.polyline(Array.from(d.celdas, (i) => aMapa(...fc(i))), { color: sim.e.nivel === "ambar" ? "#e0a020" : "#d33a2c", weight: 4, dashArray: "6 6", interactive: false }).addTo(capa);
      const criterio = d.criterio === "segura" ? "Camino más seguro al refugio."
        : Number.isFinite(d.seguraSegundos) ? "Camino más rápido al refugio: el más seguro no llega a tiempo." : "Camino más rápido al refugio.";
      sim.n.camino.textContent = `${t(criterio)} ${hms(d.tiempos[0])}`;
      sim.n.camino.hidden = false;
    }
    ultimo = performance.now();
    dibujar(true);
  }

  // Si el Worker falla mientras se espera un camino, no se deja al visor calculando para siempre.
  function alError(mensaje) {
    if (!sim || sim.pendiente === null) return;
    sim.pendiente = null;
    sim.e = sim.motor.recibirCamino(null);
    mostrarAviso("No se pudo calcular el regreso.");
    if (mensaje) avisar(`No se pudo calcular el regreso: ${mensaje}`);
    dibujar(true);
  }

  return { iniciar, alCamino, alError, detener, activa: () => !!sim || cargando };
}
