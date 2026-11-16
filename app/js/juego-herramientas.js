// Herramientas del astronauta en el modo práctica: cada una da una lectura armada con datos reales del proyecto
// (relieve HiRISE, último parte REMS, posición del Sol, fotos Navcam de Curiosity) más un error de instrumento
// propuesto, y puede corregir la posición estimada. También la tarea de ciencia y la pantalla final.
import { pasoJuego, corregirJuego, trabajarJuego, cienciaCompleta, resumenJuego, valorJuego, puntoJuego } from "./juego-caminata.js";
import { muestraAltura, proyectarHito } from "./vista-marte.js";
import { posicionSol } from "./luz.js";
import { lonLatACelda, celdaALonLat } from "./zona.js";

const R_MARTE = 3396190;
// Errores 1σ de cada instrumento en el juego (propuesta, a calibrar). Foto: el error mediano medido con 12 paradas
// de Curiosity fue 20 m, de ahí σ ≈ 8 m.
const SIGMA_M = { barometro: 35, sol: 45, baliza: 8, foto: 8 };
const RADIO95 = Math.sqrt(-2 * Math.log(0.05));

function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export async function conectarHerramientas({ panel, motor, contexto, zona, cfg, json, url, idioma, inicio_ms, render, raiz }) {
  const en = idioma === "en", L = (es, ing) => (en ? ing : es);
  const v = (k) => valorJuego(cfg, k);
  const num = (x, d = 1) => (Number.isFinite(x) ? x.toLocaleString(en ? "en-US" : "es-UY", { maximumFractionDigits: d }) : "—");
  const [clima, baro, indice, panos] = await Promise.all([
    json("datos/clima/clima.json").catch(() => null), json("config/barometro.json"),
    json(`datos/${zona.meta.id}/localizacion/indice.json`).catch(() => ({ paradas: [] })),
    json(`datos/${zona.meta.id}/panoramicas.json`).catch(() => []),
  ]);
  // Último parte REMS guardado: presión y temperatura del aire (referencia en el hábitat).
  const parte = clima?.rems?.soles?.find((s) => Number.isFinite(Number(s.pressure)) && Number.isFinite(Number(s.min_temp)));
  const pRef = Number(parte?.pressure ?? 750), tAire = (Number(parte?.min_temp ?? -60) + Number(parte?.max_temp ?? -10)) / 2 + 273.15;
  const gas = baro.gas_marciano_j_kg_k.valor, g = baro.gravedad_m_s2.valor, H = (gas * tAire) / g;
  const base = motor.juego.base, zBase = muestraAltura(zona, base.f, base.c);
  // Paradas con fotos Navcam guardadas, en celdas de la zona (con el desfase medido corregido).
  const paradas = indice.paradas.map((p) => {
    const pano = panos.find((x) => x.sitio === p.sitio && x.tramo === p.tramo)?.verdad;
    if (!pano) return null;
    const corr = pano.corrimiento_m ?? { este: 0, norte: 0 }, lat = pano.lat;
    const lon = pano.lon_este + (corr.este / (R_MARTE * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
    const c = lonLatACelda(zona.meta, lon, lat + (corr.norte / R_MARTE) * (180 / Math.PI));
    return { ...p, f: c.f, c: c.c };
  }).filter(Boolean);

  const caja = document.createElement("div");
  caja.className = "juego-herramientas";
  caja.setAttribute("data-no-traducir", "");
  caja.innerHTML = `<div class="juego-instrumentos" role="toolbar" aria-label="${L("Instrumentos", "Instruments")}">
      <button data-h="barometro"><b>1</b>${L("Barómetro", "Barometer")}</button><button data-h="foto"><b>2</b>${L("Cámara", "Camera")}</button>
      <button data-h="sol"><b>3</b>${L("Rumbo al Sol", "Sun bearing")}</button><button data-h="baliza"><b>4</b>${L("Baliza del hábitat", "Habitat beacon")}</button></div>
    <div class="juego-ciencia" hidden><strong>${L("Parada científica: boxwork", "Science stop: boxwork")}</strong>
      <span data-v="ciencia"></span>
      <div>${[0, 1].map((k) => `<button data-foto="${k}">${L("Foto cresta", "Photo ridge")} ${k + 1}</button>`).join("")}
      ${[0, 1, 2].map((k) => `<button data-muestra="${k}">${L("Muestra", "Sample")} ${k + 1}${k === 2 ? L(" (hueco)", " (hollow)") : ""}</button>`).join("")}</div></div>
    <section class="juego-lectura" hidden role="dialog" aria-live="polite"><h2></h2><div data-v="cuerpo"></div><button data-cerrar>${L("Seguir caminando", "Keep walking")}</button></section>
    <section class="juego-final" hidden role="dialog"><h2></h2><div data-v="final"></div><button data-otra>${L("Jugar de nuevo", "Play again")}</button></section>`;
  panel.append(caja);
  const $ = (s) => caja.querySelector(s);

  // Pantalla de inicio: misión y controles explicados con dibujos de teclas.
  const inicio = panel.querySelector(".juego-inicio");
  if (inicio) {
    inicio.setAttribute("data-no-traducir", "");
    const botones = [...inicio.querySelectorAll("button")];
    inicio.innerHTML = `<h1>${L("Caminata de práctica en Monte Sharp", "Practice walk on Mount Sharp")}</h1>
      <p>${L("Sos un astronauta en Marte. Tu misión: caminar del hábitat a las crestas del <b>boxwork</b>, sacar 2 fotos y 3 muestras, y <b>volver sano</b>. No hay GPS: tu posición estimada se va corriendo y la tenés que corregir con tus instrumentos.", "You are an astronaut on Mars. Your mission: walk from the habitat to the <b>boxwork</b> ridges, take 2 photos and 3 samples, and <b>return safely</b>. There is no GPS: your estimated position drifts and you must correct it with your instruments.")}</p>
      <div class="juego-controles">
        <div><kbd>W</kbd> <kbd>↑</kbd> ${L("caminar hacia adelante", "walk forward")}</div>
        <div><kbd>S</kbd> <kbd>↓</kbd> ${L("retroceder", "step back")}</div>
        <div><kbd>A</kbd> <kbd>D</kbd> <kbd>←</kbd> <kbd>→</kbd> ${L("girar (la cámara mira hacia donde caminás)", "turn (the camera looks where you walk)")}</div>
        <div>🖱️ ${L("o arrastrá el mouse / el dedo sobre la vista para girar", "or drag the mouse / your finger on the view to turn")}</div>
        <div><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> ${L("instrumentos: barómetro, cámara, Sol, baliza", "instruments: barometer, camera, Sun, beacon")} · <kbd>Enter</kbd> ${L("cierra la lectura", "closes the reading")}</div>
        <div>🖱️ ${L("PC: hacé clic en la vista y mové el mouse para mirar (Esc suelta el mouse)", "PC: click the view and move the mouse to look (Esc releases it)")}</div>
        <div><kbd>Shift</kbd> ${L("trotar (gasta más oxígeno)", "jog (uses more oxygen)")} · <kbd>Espacio</kbd> ${L("pausa", "pause")}</div>
        <div>📱 ${L("Celular: joystick izquierdo para caminar, derecho para mirar", "Phone: left joystick to walk, right one to look")}</div>
      </div>
      <p>${L("Seguí el <b>rombo</b> del centro y la línea verde del mapa. A la derecha tenés los instrumentos. Arriba a la izquierda, la lista de pasos te guía.", "Follow the <b>diamond</b> in the center and the green line on the map. Instruments are on the right. Top left, the step list guides you.")}</p>`;
    const fila = document.createElement("div"); fila.className = "juego-inicio-botones"; fila.append(...botones); inicio.append(fila);
    botones[0].textContent = L("Empezar caminata", "Start walk"); if (botones[1]) botones[1].textContent = L("Volver a la app", "Back to the app");
  }
  // Tutorial guiado: pasos que se tachan solos según lo que hacés.
  const tutorial = document.createElement("ol");
  tutorial.className = "juego-tutorial"; tutorial.setAttribute("data-no-traducir", "");
  panel.append(tutorial);
  const pasos = [
    { id: "caminar", txt: L("Caminá: mantené <kbd>W</kbd> o <kbd>↑</kbd> apretada.", "Walk: hold <kbd>W</kbd> or <kbd>↑</kbd>."), hecho: (e) => e.distancia_m > 8 },
    { id: "girar", txt: L("Girá con <kbd>A</kbd>/<kbd>D</kbd> (o arrastrando) hasta que el <b>rombo</b> quede en el centro y la flecha apunte arriba.", "Turn with <kbd>A</kbd>/<kbd>D</kbd> (or drag) until the <b>diamond</b> is centered and the arrow points up."), hecho: (e, x) => x.alineado > 4 },
    { id: "corredor", txt: L("Quedate dentro del corredor verde del mapa (desvío &lt; 8 m).", "Stay inside the green corridor on the map (deviation &lt; 8 m)."), hecho: (e) => e.distancia_m > 60 },
    { id: "instrumento", txt: L("Tu posición se corre: usá la <b>Baliza del hábitat</b> (tecla <kbd>4</kbd>) o el <b>Barómetro</b> (<kbd>1</kbd>) para corregirla.", "Your position drifts: use the <b>Habitat beacon</b> (key <kbd>4</kbd>) or the <b>Barometer</b> (<kbd>1</kbd>) to correct it."), hecho: (e) => e.utiles > 0 },
    { id: "llegar", txt: L("Llegá a la parada científica (destino del rombo amarillo).", "Reach the science stop (yellow diamond destination)."), hecho: (e) => Math.hypot(e.real.f - e.ciencia.f, e.real.c - e.ciencia.c) * zona.paso <= v("radio_accion_m") || cienciaCompleta(e, cfg) },
    { id: "ciencia", txt: L("Hacé la ciencia: 2 fotos de crestas (girá al rumbo indicado) y 3 muestras.", "Do the science: 2 ridge photos (turn to the given heading) and 3 samples."), hecho: (e) => cienciaCompleta(e, cfg) },
    { id: "volver", txt: L("Volvé al hábitat siguiendo la ruta.", "Return to the habitat along the route."), hecho: (e) => e.fin === "victoria" },
  ];
  const progreso = { alineado: 0 };
  function dibujarTutorial() {
    const e = motor.juego;
    tutorial.hidden = !!inicio && !inicio.hidden;
    caja.querySelector(".juego-instrumentos").style.visibility = tutorial.hidden ? "hidden" : "";
    const giro = motor.estado?.giro;
    if (Number.isFinite(giro) && Math.abs(giro) < 15 && e.distancia_m > 2) progreso.alineado++;
    let actual = pasos.findIndex((p) => !p.hecho(e, progreso));
    if (actual < 0) actual = pasos.length;
    tutorial.innerHTML = `<li class="titulo">${L("Pasos de la misión", "Mission steps")}</li>` + pasos.map((p, k) => `<li class="${k < actual ? "hecho" : k === actual ? "actual" : ""}">${k < actual ? "✔" : k === actual ? "▶" : "·"} ${p.txt}</li>`).join("");
  }

  function mostrar(titulo, html) { $(".juego-lectura h2").textContent = titulo; $("[data-v=cuerpo]").innerHTML = html; $(".juego-lectura").hidden = false; }
  $("[data-cerrar]").addEventListener("click", () => { $(".juego-lectura").hidden = true; panel.closest(".nav-casco")?.focus(); });

  // Usar un instrumento lleva tiempo de caminata (y gasta recursos) como en una EVA real.
  function gastarTiempo() { motor.juego = pasoJuego(motor.juego, { dt: v("instrumento_s"), regreso_s: motor.juego.regreso_s }, contexto); }
  // Corrige la estimada con una posición medida alrededor de la real; solo si achica el error.
  function corregir(herramienta, sigma) {
    const e = motor.juego, antes = e.estimada.error_m, err = sigma * RADIO95;
    if (err >= antes) return L(`No achica tu error actual (±${num(antes, 0)} m): esta medida es menos precisa.`, `Does not reduce your current error (±${num(antes, 0)} m): this reading is less precise.`);
    const mejor = { f: e.real.f + (gauss() * sigma) / zona.paso, c: e.real.c + (gauss() * sigma) / zona.paso };
    motor.juego = corregirJuego(e, { mejor, error_m: err }, contexto, herramienta);
    return L(`Posición corregida: el error pasó de ±${num(antes, 0)} m a ±${num(err, 0)} m (95 %).`, `Position corrected: error went from ±${num(antes, 0)} m to ±${num(err, 0)} m (95%).`);
  }
  const geoReal = () => celdaALonLat(zona.meta, motor.juego.real.f, motor.juego.real.c);

  const acciones = {
    barometro() {
      const z = muestraAltura(zona, motor.juego.real.f, motor.juego.real.c);
      const p = pRef * Math.exp(-(z - zBase) / H) + gauss() * baro.sigma_presion_diferencial_pa.valor;
      const dz = -H * Math.log(p / pRef);
      gastarTiempo();
      return [L("Barómetro del traje", "Suit barometer"), `<p class="lectura">${num(p, 1)} Pa <small>± ${num(baro.sigma_presion_diferencial_pa.valor)} Pa</small></p>
        <p>${L("Altura respecto del hábitat", "Height relative to habitat")}: <b>${dz >= 0 ? "+" : ""}${num(dz, 0)} m</b> (${L("referencia: parte REMS de Curiosity", "reference: Curiosity REMS report")}, ${num(pRef, 0)} Pa, sol ${parte?.sol ?? "—"}).</p>
        <p>${L("Para qué sirve: la altura limita dónde podés estar sobre el relieve HiRISE, aun con polvo y sin ver el horizonte.", "Why: height limits where you can be on the HiRISE terrain, even in dust with no horizon in sight.")}</p>
        <p class="ok">${corregir("barometro", SIGMA_M.barometro)}</p>`];
    },
    async foto() {
      const r = motor.juego.real;
      const cerca = paradas.map((p) => ({ ...p, d: Math.hypot(p.f - r.f, p.c - r.c) * zona.paso })).sort((a, b) => a.d - b.d)[0];
      gastarTiempo();
      if (!cerca) return [L("Cámara", "Camera"), `<p>${L("No hay fotos guardadas para esta zona.", "No stored photos for this area.")}</p>`];
      const fotos = await json(`datos/${zona.meta.id}/localizacion/${cerca.id}/fotos.json`).catch(() => []);
      const sol = posicionSol(inicio_ms + motor.juego.t * 1000, geoReal().lon, geoReal().lat);
      // La foto que mira más o menos hacia donde mirás vos.
      const elegida = fotos.slice().sort((a, b) => Math.abs(((a.azimut - motor.juego.rumbo + 540) % 360) - 180) - Math.abs(((b.azimut - motor.juego.rumbo + 540) % 360) - 180)).at(-1) ?? fotos[0];
      const util = cerca.d <= v("foto_cercana_m");
      return [L("Cámara · foto real de Curiosity", "Camera · real Curiosity photo"), `${elegida ? `<img src="${url(`datos/${zona.meta.id}/localizacion/${cerca.id}/${elegida.archivo}`)}" alt="Navcam" loading="lazy">
        <p class="credito">${L("Foto real", "Real photo")} NASA/JPL-Caltech · Curiosity Navcam · sol ${elegida.sol} · ${L("parada", "stop")} ${cerca.sitio}/${cerca.tramo} · ${L("a", "at")} ${num(cerca.d, 0)} m ${L("de tu posición", "from your position")}</p>` : ""}
        <p>${util ? L("El horizonte de la foto coincide con el calculado desde el relieve: te ubica (error mediano medido 20 m en 12 paradas).", "The photo skyline matches the one computed from the terrain: it locates you (measured median error 20 m over 12 stops).")
          : L(`Estás lejos de las paradas con fotos guardadas: en una EVA real tu cámara vería este tipo de paisaje; para ubicarte por horizonte necesitás fotos tomadas aquí. Sol: azimut ${num(sol.azimut, 0)}°, elevación ${num(sol.elevacion, 0)}°.`,
            `You are far from the stops with stored photos: on a real EVA your camera would see this kind of landscape; skyline location needs photos taken here. Sun: azimuth ${num(sol.azimut, 0)}°, elevation ${num(sol.elevacion, 0)}°.`)}</p>
        ${util ? `<p class="ok">${corregir("foto", SIGMA_M.foto)}</p>` : ""}`];
    },
    sol() {
      const geo = geoReal(), s = posicionSol(inicio_ms + motor.juego.t * 1000, geo.lon, geo.lat);
      gastarTiempo();
      const rumboVisto = (s.azimut + gauss() * 0.5 + 360) % 360;
      return [L("Rumbo al Sol", "Sun bearing"), `<p class="lectura">${L("Azimut", "Azimuth")} ${num(rumboVisto, 1)}° · ${L("elevación", "elevation")} ${num(s.elevacion, 1)}° <small>± 0,5°</small></p>
        <p>${L("Para qué sirve: Marte no tiene un campo magnético útil para la brújula; el Sol (con la hora de Mars24) fija el rumbo verdadero y corta la deriva de la IMU.", "Why: Mars has no useful magnetic field for a compass; the Sun (with Mars24 time) gives true heading and stops IMU drift.")}</p>
        <p class="ok">${corregir("sol", SIGMA_M.sol)}</p>`];
    },
    baliza() {
      const d = Math.hypot(motor.juego.real.f - base.f, motor.juego.real.c - base.c) * zona.paso + gauss();
      gastarTiempo();
      return [L("Baliza de radio del hábitat", "Habitat radio beacon"), `<p class="lectura">${num(d, 1)} m <small>± 1 m</small></p>
        <p>${L("Para qué sirve: la distancia por tiempo de vuelo (UWB) dibuja un anillo alrededor del hábitat; con la estima, te ubica con pocos metros de error.", "Why: time-of-flight range (UWB) draws a ring around the habitat; with dead reckoning it locates you within a few meters.")}</p>
        <p class="ok">${corregir("baliza", SIGMA_M.baliza)}</p>`];
    },
  };
  caja.querySelectorAll("[data-h]").forEach((b) => b.addEventListener("click", async () => {
    if (motor.juego.fin) return;
    b.disabled = true;
    try { const [titulo, html] = await acciones[b.dataset.h](); mostrar(titulo, html); }
    catch (err) { mostrar(L("Instrumento", "Instrument"), `<p>${err.message}</p>`); }
    finally { b.disabled = false; }
  }));

  // Ciencia: fotos de las crestas (apuntando el rumbo) y muestras.
  const trabajar = (tipo, k) => {
    try { motor.juego = trabajarJuego(motor.juego, tipo, k, contexto); }
    catch (err) {
      const objetivo = (k * v("separacion_crestas_grados") + 360) % 360;
      mostrar(L("Parada científica", "Science stop"), `<p>${err.message === "Apuntá la retícula a la cresta marcada." ? L(`Girá hasta el rumbo ${num(objetivo, 0)}° (±${v("reticula_grados")}°) para encuadrar la cresta ${k + 1}.`, `Turn to heading ${num(objetivo, 0)}° (±${v("reticula_grados")}°) to frame ridge ${k + 1}.`) : err.message}</p>`);
    }
  };
  caja.querySelectorAll("[data-foto]").forEach((b) => b.addEventListener("click", () => trabajar("foto", Number(b.dataset.foto))));
  caja.querySelectorAll("[data-muestra]").forEach((b) => b.addEventListener("click", () => trabajar("muestra", Number(b.dataset.muestra))));

  // Teclas 1–4: cambiar de instrumento y usarlo (como un selector en el antebrazo del traje).
  const ordenTeclas = ["barometro", "foto", "sol", "baliza"];
  const alTecla = (ev) => {
    if (tutorial.hidden || motor.juego.fin || /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target?.tagName ?? "")) return;
    const k = Number(ev.key);
    if (k >= 1 && k <= 4) { ev.preventDefault(); if (!$(".juego-lectura").hidden) $(".juego-lectura").hidden = true; caja.querySelector(`[data-h=${ordenTeclas[k - 1]}]`).click(); }
    else if (ev.key === "Enter" && !$(".juego-lectura").hidden) { ev.preventDefault(); $(".juego-lectura").hidden = true; }
  };
  window.addEventListener("keydown", alTecla);

  // Estructuras sobre el terreno: hábitat en la salida y base de campo en la parada científica.
  const lienzo = document.createElement("canvas");
  lienzo.className = "juego-estructuras";
  const anchoR = render?.ancho?.valor ?? 1280, altoR = render?.alto?.valor ?? 720;
  lienzo.width = anchoR; lienzo.height = altoR;
  (raiz ?? panel).prepend(lienzo);
  const g2 = lienzo.getContext("2d");
  const fov = ((render?.campo_grados?.valor ?? 70) * Math.PI) / 180, focal = anchoR / (2 * Math.tan(fov / 2));
  const marcaAlto = render?.marcador_altura_m?.valor ?? 0;
  const estructuras = [
    { p: motor.juego.base, nombre: L("Hábitat (salida)", "Habitat (start)"), color: "#d9e4ea", tipo: "habitat" },
    { p: motor.juego.ciencia, nombre: L("Base de campo · boxwork", "Field base · boxwork"), color: "#f0c860", tipo: "campo" },
  ];
  function dibujarEstructura(x, ySuelo, esc, est, dist) {
    const w = Math.max(6, 14 * esc), h = Math.max(4, 7 * esc);
    g2.save(); g2.translate(x, ySuelo);
    g2.fillStyle = "#0006"; g2.beginPath(); g2.ellipse(0, 0, w * 0.9, h * 0.18, 0, 0, Math.PI * 2); g2.fill();
    if (est.tipo === "habitat") {
      g2.fillStyle = "#9aa7ad"; g2.fillRect(-w * 0.9, -h * 0.35, w * 0.5, h * 0.35);           // módulo de acceso
      g2.fillStyle = est.color; g2.beginPath(); g2.ellipse(0, 0, w * 0.55, h, 0, Math.PI, 0); g2.fill(); // cúpula
      g2.strokeStyle = "#5c6b72"; g2.lineWidth = Math.max(1, esc * 0.4);
      for (const r of [0.35, 0.7]) { g2.beginPath(); g2.ellipse(0, 0, w * 0.55 * r, h * r, 0, Math.PI, 0); g2.stroke(); }
      g2.fillStyle = "#37474f"; g2.fillRect(w * 0.45, -h * 1.6, Math.max(1, esc * 0.3), h * 1.6);   // antena
      g2.fillStyle = "#e53935"; g2.beginPath(); g2.arc(w * 0.47, -h * 1.6, Math.max(2, esc * 0.6), 0, Math.PI * 2); g2.fill();
    } else {
      g2.fillStyle = "#c58f3c"; g2.beginPath(); g2.moveTo(-w * 0.6, 0); g2.lineTo(0, -h * 0.9); g2.lineTo(w * 0.6, 0); g2.closePath(); g2.fill(); // carpa
      g2.fillStyle = "#7a5520"; g2.beginPath(); g2.moveTo(-w * 0.15, 0); g2.lineTo(0, -h * 0.45); g2.lineTo(w * 0.15, 0); g2.closePath(); g2.fill();
      g2.fillStyle = "#37474f"; g2.fillRect(w * 0.7, -h * 1.3, Math.max(1, esc * 0.3), h * 1.3);    // mástil con bandera
      g2.fillStyle = est.color; g2.fillRect(w * 0.7, -h * 1.3, w * 0.35, h * 0.3);
    }
    g2.restore();
    g2.font = "600 15px ui-monospace,Consolas,monospace"; g2.textAlign = "center";
    g2.fillStyle = "#000a"; g2.fillText(`${est.nombre} · ${num(dist, 0)} m`, x + 1, ySuelo - h * 1.9 - 7);
    g2.fillStyle = est.color; g2.fillText(`${est.nombre} · ${num(dist, 0)} m`, x, ySuelo - h * 1.9 - 8);
  }
  let rafEst = 0;
  function cuadroEstructuras() {
    if (!lienzo.isConnected) return;
    g2.clearRect(0, 0, anchoR, altoR);
    const e = motor.juego;
    for (const est of estructuras) {
      const pr = proyectarHito({ zona, posicion: e.real, hito: est.p, rumbo: e.rumbo, cfg: render });
      if (!pr || pr.distancia_m < 3) continue;
      const esc = focal / pr.distancia_m, ySuelo = pr.y + marcaAlto * esc;
      dibujarEstructura(pr.x, ySuelo, esc, est, pr.distancia_m);
    }
    rafEst = requestAnimationFrame(cuadroEstructuras);
  }
  rafEst = requestAnimationFrame(cuadroEstructuras);

  let terminado = false;
  const reloj = setInterval(() => {
    if (!caja.isConnected) { clearInterval(reloj); return; }
    try { dibujarTutorial(); } catch { /* el tutorial no frena el juego */ }
    const e = motor.juego, cerca = Math.hypot(e.real.f - e.ciencia.f, e.real.c - e.ciencia.c) * zona.paso <= v("radio_accion_m");
    $(".juego-ciencia").hidden = !cerca || cienciaCompleta(e, cfg);
    caja.querySelectorAll("[data-foto]").forEach((b) => { b.disabled = e.fotos.includes(Number(b.dataset.foto)); });
    caja.querySelectorAll("[data-muestra]").forEach((b) => { b.disabled = e.muestras.includes(Number(b.dataset.muestra)); });
    $("[data-v=ciencia]").textContent = ` · ${L("fotos", "photos")} ${e.fotos.length}/${v("fotos_ciencia")} · ${L("muestras", "samples")} ${e.muestras.length}/${v("muestras_ciencia")}`;
    if (e.fin && !terminado) {
      terminado = true;
      const r = resumenJuego(e, cfg), gano = e.fin === "victoria";
      const usadas = [...new Set(e.bitacora.filter((x) => ["barometro", "foto", "sol", "baliza", "geoubicacion"].includes(x.tipo) && x.despues_m).map((x) => x.tipo))];
      const nombres = { barometro: L("barómetro", "barometer"), foto: L("cámara (horizonte)", "camera (skyline)"), sol: L("rumbo al Sol", "Sun bearing"), baliza: L("baliza", "beacon"), geoubicacion: L("geoubicación", "geolocation") };
      $(".juego-final h2").textContent = gano ? `${L("Volviste sano", "You made it back safely")} ${"★".repeat(r.estrellas)}${"☆".repeat(3 - r.estrellas)}` : L("Caminata terminada", "Walk ended");
      $("[data-v=final]").innerHTML = `<p>${gano ? L("Hiciste la ciencia en el boxwork y volviste al hábitat.", "You did the science at the boxwork and returned to the habitat.") : (e.motivo ?? "")}</p>
        <ul><li>${L("Puntaje", "Score")}: <b>${r.puntaje}</b></li><li>${L("Tiempo", "Time")}: ${num(r.tiempo_s / 60, 0)} min · ${L("distancia", "distance")}: ${num(r.distancia_m, 0)} m</li>
        <li>${L("Desvío medio de la ruta", "Mean deviation from route")}: ${num(r.desvio_medio_m, 1)} m · ${L("fuera del corredor", "outside corridor")}: ${num(r.fuera_s / 60, 1)} min</li>
        <li>${L("Error final de tu posición estimada", "Final error of your estimated position")}: ${num(Math.hypot(e.estimada.f - e.real.f, e.estimada.c - e.real.c) * zona.paso, 0)} m</li>
        <li>${L("Herramientas que te corrigieron la posición", "Tools that corrected your position")}: ${usadas.length ? usadas.map((u) => nombres[u]).join(", ") : L("ninguna (la deriva quedó sin corregir)", "none (drift left uncorrected)")}</li></ul>`;
      $(".juego-final").hidden = false;
    }
  }, 400);
  $("[data-otra]").addEventListener("click", () => location.reload());
  return { cerrar() { clearInterval(reloj); cancelAnimationFrame(rafEst); window.removeEventListener("keydown", alTecla); lienzo.remove(); caja.remove(); tutorial.remove(); } };
}
