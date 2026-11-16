// Modo práctica en primera persona: caminata corta del hábitat a la base de campo del boxwork y vuelta,
// usando los instrumentos del proyecto para no desviarse. Relieve real, fotos reales, recursos modelados.
import { mat, crearPrograma, dibujar, fsCielo } from "./gl.js";
import { GLSL_CIELO, colorNiebla } from "./cielo.js";
import { crearTerreno, mallaTerreno, mallaCielo, mallaObjetos, mallasCuerpo, azarSemilla, HORIZONTE } from "./escena.js";
import { crearSonido } from "./sonido.js";
import { leerHttp } from "../zona.js";
import { posicionSol } from "../luz.js";
import { velocidad, valoresVel } from "../ruteo.js";
import { desnivel } from "../barometro.js";

const EN = new URLSearchParams(location.search).get("lang") === "en";
const L = (es, en) => (EN ? en : es);
const loc = EN ? "en-US" : "es-UY";
const num = (x, d = 0) => Number(x).toLocaleString(loc, { minimumFractionDigits: d, maximumFractionDigits: d });
const $ = (s) => document.querySelector(s);
const url = (rel) => new URL(`../../../${rel}`, import.meta.url).href;
const v = (p, def) => (p && Number.isFinite(Number(p.valor ?? p)) ? Number(p.valor ?? p) : def);

const azar = azarSemilla(4414);
const gauss = () => {
  let u = 0, w = 0;
  while (u === 0) u = azar();
  while (w === 0) w = azar();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
};

function textos() {
  document.documentElement.lang = EN ? "en" : "es";
  for (const el of document.querySelectorAll("[data-en]")) {
    if (EN) el.innerHTML = el.dataset.en;
  }
}

async function iniciar() {
  textos();
  const lienzo = $("#lienzo");
  const gl = lienzo.getContext("webgl2", { antialias: true });
  if (!gl) {
    $("#carga").innerHTML = `<p>${L("Este navegador no tiene WebGL2: el modo práctica 3D necesita WebGL2. Probá con Chrome, Edge o Firefox actualizados.", "This browser has no WebGL2: the 3D practice mode needs it. Try an up-to-date Chrome, Edge or Firefox.")}</p>`;
    return;
  }
  const json = (rel) => leerHttp(url(rel), "json");
  const [datos, buf, traje, riesgo, baro, juegoCfg, clima] = await Promise.all([
    json("app/ejemplos/ruta_practica.json"),
    leerHttp(url("app/ejemplos/terreno_practica.bin"), "bin"),
    json("config/traje.json"), json("config/riesgo.json"), json("config/barometro.json"),
    json("config/juego.json").catch(() => ({})), json("datos/clima/clima.json").catch(() => null),
  ]);
  const t = crearTerreno(datos.terreno, buf);
  const cfg = {
    reloj: v(juegoCfg.reloj, 8), trote: v(juegoCfg.trote, 1.5), corredor: v(juegoCfg.corredor_m, 8),
    accion: v(juegoCfg.radio_accion_m, 12), derivaPasos: v(juegoCfg.deriva_pasos, 0.04),
    pendMax: datos.pendiente_max_grados, autonomiaH: v(riesgo.pie?.consumibles_primarios_h ?? riesgo.consumibles_primarios_h, 8),
  };
  const vel = valoresVel(traje.velocidad);


  // Brillo del orto HiRISE en la ventana (si no carga, se usa un tono parejo).
  const brillo = await new Promise((ok) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = t.ancho; c.height = t.alto;
        const x = c.getContext("2d", { willReadFrequently: true });
        const T = datos.terreno;
        x.drawImage(img, T.zona_c0, T.zona_f0, T.zona_c1 - T.zona_c0 + 1, T.zona_f1 - T.zona_f0 + 1, 0, 0, t.ancho, t.alto);
        const px = x.getImageData(0, 0, t.ancho, t.alto).data;
        const b = new Float32Array(t.ancho * t.alto);
        let s = 0;
        for (let i = 0; i < b.length; i++) { b[i] = px[i * 4] / 255; s += b[i]; }
        const media = s / b.length;
        for (let i = 0; i < b.length; i++) b[i] = Math.max(0, Math.min(1, 0.5 + (b[i] - media) * 1.6));
        ok(b);
      } catch { ok(null); }
    };
    img.onerror = () => ok(null);
    img.src = url("datos/gale_boxwork/orto.jpg");
  });

  // Hora de la misión: la próxima media mañana solar (≈ 10 h LTST) en Gale.
  const { lon, lat } = datos.origen;
  let inicioMs = Date.now();
  for (let k = 0; k < 160; k++) {
    const ms = Date.now() + k * 10 * 60000, s = posicionSol(ms, lon, lat);
    if (s.ltst >= 9.6 && s.ltst <= 10.4) { inicioMs = ms; break; }
  }
  const solEn = (seg) => posicionSol(inicioMs + seg * 1000, lon, lat);
  const s0 = solEn(0);
  const dirSol = (s) => {
    const az = (s.azimut * Math.PI) / 180, el = (Math.max(s.elevacion, 2) * Math.PI) / 180;
    return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
  };

  const prog = crearPrograma(gl);
  // Cielo marciano calculado por píxel; si el GLSL no compila, queda el cielo por vértice.
  let progCielo = null;
  try { progCielo = crearPrograma(gl, fsCielo(GLSL_CIELO)); } catch (err) { console.warn(err); }
  const dirSolReal = (s) => {
    const az = (s.azimut * Math.PI) / 180, el = (s.elevacion * Math.PI) / 180;
    return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
  };
  const mTerreno = mallaTerreno(gl, t, brillo);
  const mCielo = mallaCielo(gl, dirSol(s0));
  const mObjetos = mallaObjetos(gl, t, datos);
  const cuerpo = mallasCuerpo(gl);

  // REMS: último parte con presión y temperaturas (referencia en el hábitat).
  const parte = clima?.rems?.soles?.find((s) => Number.isFinite(Number(s.pressure)) && Number.isFinite(Number(s.min_temp)));
  const pRef = Number(parte?.pressure ?? 750);
  const tAire = (Number(parte?.min_temp ?? -60) + Number(parte?.max_temp ?? -10)) / 2 + 273.15;
  const Hesc = (baro.gas_marciano_j_kg_k.valor * tAire) / baro.gravedad_m_s2.valor;

  // Ruta acumulada para distancias a lo largo.
  const ruta = datos.ruta;
  const acum = [0];
  for (let k = 1; k < ruta.length; k++) acum.push(acum[k - 1] + Math.hypot(ruta[k][0] - ruta[k - 1][0], ruta[k][1] - ruta[k - 1][1]));
  const largo = acum.at(-1);
  const sobreRuta = (x, y) => {
    let mejor = { d: Infinity, s: 0 };
    for (let k = 1; k < ruta.length; k++) {
      const [ax, ay] = ruta[k - 1], [bx, by] = ruta[k];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
      const d = Math.hypot(x - ax - u * dx, y - ay - u * dy);
      if (d < mejor.d) mejor = { d, s: acum[k - 1] + u * Math.sqrt(L2) };
    }
    return mejor;
  };
  const vPlano = velocidad(0, vel);
  // Punto de la ruta a una distancia s (m) desde el hábitat.
  const puntoEn = (s) => {
    s = Math.max(0, Math.min(largo, s));
    let k = 1;
    while (k < acum.length - 1 && acum[k] < s) k++;
    const u = (s - acum[k - 1]) / ((acum[k] - acum[k - 1]) || 1);
    return [ruta[k - 1][0] + u * (ruta[k][0] - ruta[k - 1][0]), ruta[k - 1][1] + u * (ruta[k][1] - ruta[k - 1][1])];
  };

  // Estado del juego.
  const e = {
    x: 0, y: -18, yaw: (Math.atan2(datos.ruta[6][0], datos.ruta[6][1])), pitch: -0.05,
    t: 0, recorrido: 0, sigma: 1, err: [0, 0], herr: null, usadas: new Set(), lecturas: 0,
    fotos: 0, muestras: 0, llego: false, fin: false, sumaDesvio: 0, nDesvio: 0, maxDesvio: 0,
    paso: 0, uso: 0, yawGirado: 0, aviso: "", avisoT: 0, empezado: false,
    z: 0, vz: 0, enAire: false, hundir: 0, giroCam: 0, pedido: null, nPedido: 0, ultimoPedidoM: 0,
    respuesta: "", respuestaT: 0, lect: {}, fuera: false, appGrande: false,
  };
  // Arranque sobre la ruta, a la salida de la plataforma, mirando hacia donde sigue.
  {
    const a = puntoEn(22), b = puntoEn(52);
    e.x = a[0]; e.y = a[1]; e.yaw = Math.atan2(b[0] - a[0], b[1] - a[1]);
  }
  const G = v(baro.gravedad_m_s2, 3.71);
  // Sonido sintetizado (sonido.js) con la interfaz que usa el juego.
  const adaptarSonido = (son) => ({
    reanudar: () => son.iniciar(),
    alternar: () => { son.silenciar(!son.silenciado); return son.silenciado; },
    actualizar: (o) => son.actualizar(o),
    paso: () => {}, bip: () => son.bip(), obturador: () => son.bip(), alerta: () => son.alerta(),
    salto: () => son.salto(), aterrizaje: (f) => son.aterrizaje(f), exito: () => son.exito(),
  });
  let audio = null;
  const particulas = [];
  const teclas = new Set();
  // El navegador puede negar el bloqueo del puntero (pestaña sin foco): se ignora y se puede mirar con flechas.
  const bloquear = () => { try { lienzo.requestPointerLock?.()?.catch?.(() => {}); } catch { /* sin bloqueo */ } };

  // Tutorial.
  const pasos = [
    { id: "caminar", txt: L("Caminá con W A S D (o el joystick izquierdo).", "Walk with W A S D (or the left joystick)."), ok: () => e.recorrido > 6 },
    { id: "mirar", txt: L("Mirá alrededor con el mouse (o el joystick derecho).", "Look around with the mouse (or the right joystick)."), ok: () => e.yawGirado > 1 },
    { id: "radio", txt: L("Sacá la radio (tecla 4) y usala (clic): te da la distancia al hábitat.", "Take out the radio (key 4) and use it (click): it gives your distance to the habitat."), ok: () => e.usadas.has("radio") },
    { id: "balizas", txt: L("Seguí 100 m las indicaciones de la app Red Frontier (abajo a la izquierda, Tab amplía).", "Follow the Red Frontier app (bottom left, Tab enlarges) for 100 m."), ok: () => sobreRuta(e.x, e.y).s > 100 },
    { id: "llegar", txt: L("Llegá a la base de campo del boxwork (bandera y rover).", "Reach the boxwork field base (flag and rover)."), ok: () => e.llego },
    { id: "ciencia", txt: L("Sacá 2 fotos de crestas (tecla 2) y tomá 3 muestras (E).", "Take 2 ridge photos (key 2) and 3 samples (E)."), ok: () => e.fotos >= 2 && e.muestras >= 3 },
    { id: "volver", txt: L("Volvé al hábitat siguiendo la ruta.", "Return to the habitat along the route."), ok: () => e.fin },
  ];
  const hechos = new Set();
  const listaPasos = () => pasos.map((p) => `<li class="${hechos.has(p.id) ? "hecho" : ""}">${p.txt}</li>`).join("");
  $("#pasos-inicio").innerHTML = listaPasos();

  // Herramientas.
  const NOMBRES = { barometro: L("Barómetro", "Barometer"), camara: L("Cámara", "Camera"), brujula: L("Brújula solar", "Sun compass"), radio: L("Radio / baliza", "Radio / beacon") };
  const ORDEN = ["barometro", "camara", "brujula", "radio"];
  const elegir = (h) => {
    e.herr = e.herr === h ? null : h;
    for (const b of document.querySelectorAll("[data-herr]")) b.classList.toggle("activa", b.dataset.herr === e.herr);
    e.giroCam = 0;
  };
  const lectura = (titulo, html) => {
    $("#lectura").innerHTML = `<h3>${titulo}</h3>${html}`;
    $("#lectura").hidden = false;
  };
  const corregir = (factor, minimo) => {
    e.err = e.err.map((x) => x * factor);
    e.sigma = Math.max(minimo, e.sigma * factor);
  };
  const distHab = () => Math.hypot(e.x, e.y, t.altura(e.x, e.y) - t.altura(0, 0));
  const distCiencia = () => Math.hypot(e.x - datos.ciencia.x, e.y - datos.ciencia.y);
  const fotosCache = new Map();

  async function usar() {
    if (!e.herr || e.fin) { avisar(L("Elegí una herramienta con 1–4.", "Pick a tool with 1–4.")); return; }
    e.uso = 1; e.usadas.add(e.herr); e.lecturas++;
    const h = e.herr;
    if (h === "camara") audio?.obturador(); else audio?.bip();
    if (h === "barometro") {
      const dzReal = t.altura(e.x, e.y) - t.altura(0, 0);
      const p = pRef * Math.exp(-dzReal / Hesc) + gauss() * baro.sigma_presion_diferencial_pa.valor;
      const r = desnivel({ p, pBase: pRef, T: tAire, cfg: baro });
      corregir(0.75, 2);
      e.lect.barometro = [`${num(p, 1)} Pa`, `${r.dz >= 0 ? "+" : ""}${num(r.dz, 1)} m`];
      responder("barometro");
      lectura(NOMBRES.barometro, `<p class="grande">${num(p, 1)} Pa</p>
        <p>${L("Altura respecto del hábitat", "Height relative to habitat")}: <b>${r.dz >= 0 ? "+" : ""}${num(r.dz, 1)} m</b> ± ${num(r.sigma, 1)} m</p>
        <p class="chico">${L("Ecuación hipsométrica con el último parte REMS de Curiosity", "Hypsometric equation with Curiosity's latest REMS report")} (sol ${parte?.sol ?? "—"}, ${num(pRef)} Pa, ${num(tAire - 273.15)} °C). ${L("Presión local simulada desde el relieve HiRISE.", "Local pressure simulated from HiRISE relief.")}</p>`);
    } else if (h === "radio") {
      const d = distHab() + gauss();
      corregir(0.4, 1);
      e.lect.radio = [`${num(d, 0)} m`, L("al hábitat", "to habitat")];
      responder("radio");
      lectura(NOMBRES.radio, `<p class="grande">${num(d, 0)} m</p><p>${L("al hábitat, por tiempo de vuelo de la señal (± 1 m)", "to the habitat, by signal time of flight (± 1 m)")}</p>
        <p class="chico">${L("Corrige tu posición estimada (modelo simple, a calibrar).", "Corrects your estimated position (simple model, to be calibrated).")}</p>`);
    } else if (h === "brujula") {
      const s = solEn(e.t);
      const rumbo = ((e.yaw * 180) / Math.PI % 360 + 360) % 360;
      corregir(0.85, 1);
      responder("brujula");
      lectura(NOMBRES.brujula, `<p class="grande">${L("Rumbo", "Heading")} ${num(rumbo)}°</p>
        <p>${L("Sol", "Sun")}: ${L("azimut", "azimuth")} ${num(s.azimut, 1)}°, ${L("elevación", "elevation")} ${num(s.elevacion, 1)}° · ${L("hora solar local", "local solar time")} ${horaSolar(s.ltst)}</p>
        <p class="chico">${L("Posición del Sol calculada (modelo Mars24 del proyecto). Corrige la deriva del rumbo.", "Sun position computed (project's Mars24 model). Corrects heading drift.")}</p>`);
    } else if (h === "camara") {
      const enCiencia = distCiencia() < cfg.accion * 2;
      if (enCiencia && e.fotos < 2) e.fotos++;
      const cerca = datos.fotos.map((f) => ({ ...f, d: Math.hypot(f.x - e.x, f.y - e.y) })).sort((a, b) => a.d - b.d)[0];
      let html = "";
      if (cerca) {
        if (!fotosCache.has(cerca.id)) fotosCache.set(cerca.id, await leerHttp(url(`datos/gale_boxwork/localizacion/${cerca.id}/fotos.json`), "json").catch(() => []));
        const fotos = fotosCache.get(cerca.id);
        const rumbo = ((e.yaw * 180) / Math.PI % 360 + 360) % 360;
        const dif = (a) => Math.abs(((a - rumbo + 540) % 360) - 180);
        const f = fotos.slice().sort((a, b) => dif(a.azimut) - dif(b.azimut))[0];
        if (f) {
          const img = new Image(); img.src = url(`datos/gale_boxwork/localizacion/${cerca.id}/${f.archivo}`); e.lect.foto = img;
        }
        if (f) html = `<img src="${url(`datos/gale_boxwork/localizacion/${cerca.id}/${f.archivo}`)}" alt="Navcam">
          <p class="chico">${L("Foto real", "Real photo")} ${f.credito ?? "NASA/JPL-Caltech"} · Curiosity Navcam · sol ${f.sol} · ${L("azimut", "azimuth")} ${num(f.azimut)}° · ${L("tomada a", "taken")} ${num(cerca.d)} m ${L("de tu posición", "from your position")}</p>`;
      }
      lectura(NOMBRES.camara, `${enCiencia ? `<p><b>${L("Foto de cresta", "Ridge photo")} ${e.fotos}/2</b></p>` : `<p class="chico">${L("Lejos de la base de campo: no cuenta como foto de cresta. Te mostramos la foto real de Curiosity más cercana.", "Far from the field base: this does not count as a ridge photo. Showing the nearest real Curiosity photo.")}</p>`}${html}`);
    }
  }
  function muestra() {
    if (distCiencia() > cfg.accion * 2) { avisar(L("Las muestras se toman en la base de campo del boxwork.", "Samples are taken at the boxwork field base.")); return; }
    if (e.muestras >= 3) { avisar(L("Ya tenés las 3 muestras.", "You already have 3 samples.")); return; }
    e.muestras++;
    e.uso = 1;
    avisar(`${L("Muestra", "Sample")} ${e.muestras}/3 ${e.muestras === 3 ? L("— ciencia lista, volvé al hábitat.", "— science done, head back.") : ""}`);
  }
  const avisar = (txt) => { e.aviso = txt; e.avisoT = 4; };
  const horaSolar = (h) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`;

  // Entrada: teclado, mouse con pointer lock y joysticks táctiles.
  addEventListener("keydown", (ev) => {
    if (!e.empezado) return;
    teclas.add(ev.code);
    const n = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(ev.code);
    if (n >= 0) elegir(ORDEN[n]);
    if (ev.code === "KeyE") muestra();
    if (ev.code === "KeyF" || ev.code === "Enter") usar();
    if (ev.code === "Escape") $("#lectura").hidden = true;
    if (ev.code === "Space") saltar();
    if (ev.code === "Tab") { e.appGrande = !e.appGrande; $("#app").classList.toggle("grande", e.appGrande); }
    if (ev.code === "KeyM") silenciar();
    if (ev.code.startsWith("Arrow") || ev.code === "Space" || ev.code === "Tab") ev.preventDefault();
  });
  addEventListener("keyup", (ev) => teclas.delete(ev.code));
  addEventListener("blur", () => teclas.clear());
  lienzo.addEventListener("mousedown", (ev) => {
    if (!e.empezado) return;
    if (document.pointerLockElement !== lienzo) { bloquear(); return; }
    if (ev.button === 0) usar();
  });
  addEventListener("mousemove", (ev) => {
    if (document.pointerLockElement !== lienzo) return;
    girar(ev.movementX * 0.0022, -ev.movementY * 0.0022);
  });
  const girar = (dy, dp) => {
    e.yaw += dy; e.yawGirado += Math.abs(dy);
    if (e.herr === "camara" && e.empezado) {
      e.giroCam += Math.abs(dy);
      if (e.giroCam >= Math.PI * 2) {
        e.giroCam = 0; e.usadas.add("camara"); e.lecturas++;
        corregir(0.15, 3);
        audio?.obturador();
        avisar(L("Foto 360 enviada a la app.", "360 photo sent to the app."));
        responder("foto360");
      }
    }
    e.pitch = Math.max(-1.2, Math.min(1.2, e.pitch + dp));
  };
  const joy = { mover: [0, 0], mirar: [0, 0] };
  for (const [id, clave] of [["#joy-izq", "mover"], ["#joy-der", "mirar"]]) {
    const el = $(id), pomo = el.querySelector("span");
    let tid = null, cx = 0, cy = 0;
    el.addEventListener("touchstart", (ev) => {
      const tt = ev.changedTouches[0]; tid = tt.identifier;
      const r = el.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      ev.preventDefault();
    }, { passive: false });
    el.addEventListener("touchmove", (ev) => {
      for (const tt of ev.changedTouches) if (tt.identifier === tid) {
        let dx = (tt.clientX - cx) / 50, dy = (tt.clientY - cy) / 50;
        const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
        joy[clave] = [dx, dy];
        pomo.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`;
      }
      ev.preventDefault();
    }, { passive: false });
    const soltar = (ev) => {
      for (const tt of ev.changedTouches) if (tt.identifier === tid) { tid = null; joy[clave] = [0, 0]; pomo.style.transform = ""; }
    };
    el.addEventListener("touchend", soltar); el.addEventListener("touchcancel", soltar);
  }
  for (const b of document.querySelectorAll("[data-herr]")) b.addEventListener("click", () => elegir(b.dataset.herr));
  $("#btn-usar").addEventListener("click", usar);
  $("#btn-muestra").addEventListener("click", muestra);
  $("#btn-trote").addEventListener("touchstart", () => teclas.add("ShiftLeft"));
  $("#btn-trote").addEventListener("touchend", () => teclas.delete("ShiftLeft"));
  $("#btn-saltar").addEventListener("click", () => saltar());
  $("#btn-mudo").addEventListener("click", () => silenciar());
  $("#app").addEventListener("click", () => { e.appGrande = !e.appGrande; $("#app").classList.toggle("grande", e.appGrande); });
  $("#lectura").addEventListener("click", () => { $("#lectura").hidden = true; });
  $("#empezar").addEventListener("click", () => {
    e.empezado = true;
    try { audio = audio ?? adaptarSonido(crearSonido()); audio.reanudar(); } catch (err) { console.warn(err); audio = null; }
    $("#inicio").hidden = true;
    $("#hud").hidden = false;
    if (!matchMedia("(pointer: coarse)").matches) bloquear();
  });
  $("#otra-vez").addEventListener("click", () => location.reload());
  $("#carga").hidden = true;
  $("#inicio").hidden = false;

  // Obstáculos (x este, y norte, radio en m), según la disposición de escena.js.
  const cx0 = datos.ciencia.x, cy0 = datos.ciencia.y;
  const obstaculos = [[-7, -4, 7], [8, -5, 5.6], [-3, 6, 3], [3, 6, 3], [-1.5, -4.7, 2], [12, 4, 0.8],
    [cx0 + 9, cy0 + 4, 4], [cx0 - 8, cy0 + 6, 2.8], [cx0 + 3, cy0 - 2, 0.4]];
  // Movimiento con Tobler y límite de pendiente.
  function mover(dt) {
    let f = 0, s = 0;
    if (teclas.has("KeyW") || teclas.has("ArrowUp")) f += 1;
    if (teclas.has("KeyS") || teclas.has("ArrowDown")) f -= 1;
    if (teclas.has("KeyD")) s += 1;
    if (teclas.has("KeyA")) s -= 1;
    if (teclas.has("ArrowLeft")) girar(-1.6 * dt, 0);
    if (teclas.has("ArrowRight")) girar(1.6 * dt, 0);
    f -= joy.mover[1]; s += joy.mover[0];
    if (joy.mirar[0] || joy.mirar[1]) girar(joy.mirar[0] * 2.2 * dt, -joy.mirar[1] * 1.6 * dt);
    const m = Math.hypot(f, s);
    if (m < 0.05) return 0;
    if (m > 1) { f /= m; s /= m; }
    const sy = Math.sin(e.yaw), cy = Math.cos(e.yaw);
    const dx = sy * f + cy * s, dy = cy * f - sy * s, dn = Math.hypot(dx, dy) || 1;
    const z0 = t.altura(e.x, e.y), z1 = t.altura(e.x + dx / dn, e.y + dy / dn);
    const trote = teclas.has("ShiftLeft") || teclas.has("ShiftRight") ? cfg.trote : 1;
    const vReal = velocidad(z1 - z0, vel) * trote * Math.min(1, m);
    const d = vReal * cfg.reloj * dt;
    const nx = e.x + (dx / dn) * d, ny = e.y + (dy / dn) * d;
    const i = t.indice(nx, ny);
    const p = i >= 0 ? t.pend[i] / 2 : 90;
    if (!t.dentro(nx, ny)) { avisar(L("Fin del relieve cargado: volvé hacia la ruta.", "Edge of the loaded terrain: head back to the route.")); return 0; }
    if (p > cfg.pendMax || (i >= 0 && t.vedado[i] && p > cfg.pendMax * 0.8)) {
      avisar(`${L("Pendiente", "Slope")} ${num(p, 1)}° > ${num(cfg.pendMax, 1)}°: ${L("el traje no la puede pisar. Rodeala.", "the suit can't take it. Go around.")}`);
      return 0;
    }
    // Choque simple con cúpulas, módulos y rover: no deja acercarse más a su centro (sí alejarse).
    for (const [ox, oy, or] of obstaculos) {
      const dn2 = Math.hypot(nx - ox, ny - oy);
      if (dn2 < or && dn2 < Math.hypot(e.x - ox, e.y - oy)) return 0;
    }
    e.x = nx; e.y = ny; e.recorrido += d;
    // La posición estimada deriva con los pasos (modelo simple, a calibrar).
    e.sigma += d * cfg.derivaPasos;
    e.err[0] += gauss() * d * cfg.derivaPasos; e.err[1] += gauss() * d * cfg.derivaPasos;
    return d;
  }

  // Bucle.
  const bruj = $("#brujula").getContext("2d");
  let previo = performance.now();
  function cuadro(ahora) {
    const dt = Math.min(0.05, (ahora - previo) / 1000); previo = ahora;
    let d = 0;
    if (e.empezado && !e.fin) {
      d = mover(dt);
      e.t += dt * cfg.reloj;
      const pasoAntes = Math.floor(e.paso / Math.PI);
      e.paso += d * 0.85; // zancada lenta y flotante en 0,38 g
      if (!e.enAire && Math.floor(e.paso / Math.PI) !== pasoAntes) audio?.paso();
      guia(dt);
      const r = sobreRuta(e.x, e.y);
      e.sumaDesvio += r.d * d; e.nDesvio += d; e.maxDesvio = Math.max(e.maxDesvio, r.d);
      if (!e.llego && distCiencia() < cfg.accion) { e.llego = true; avisar(L("¡Llegaste a la base de campo! Fotos (2) y muestras (E).", "You reached the field base! Photos (2) and samples (E).")); }
      if (e.llego && e.fotos >= 2 && e.muestras >= 3 && Math.hypot(e.x, e.y) < 16) terminar();
      for (const p of pasos) if (!hechos.has(p.id) && p.ok()) hechos.add(p.id);
    }
    e.uso = Math.max(0, e.uso - dt * 2.5);
    fisica(dt);
    if (audio && e.empezado && !e.fin) audio.actualizar({ caminando: d > 0, trotando: d > 0 && (teclas.has("ShiftLeft") || teclas.has("ShiftRight")), enAire: e.enAire, dt });
    e.avisoT -= dt;
    dibujarEscena(d);
    hud();
    requestAnimationFrame(cuadro);
  }

  function dibujarEscena() {
    const w = lienzo.clientWidth, h = lienzo.clientHeight, dpr = Math.min(2, devicePixelRatio || 1);
    if (lienzo.width !== Math.round(w * dpr) || lienzo.height !== Math.round(h * dpr)) { lienzo.width = Math.round(w * dpr); lienzo.height = Math.round(h * dpr); }
    gl.viewport(0, 0, lienzo.width, lienzo.height);
    const sReal = dirSolReal(solEn(e.t));
    const niebla = progCielo ? colorNiebla(sReal) : HORIZONTE;
    gl.clearColor(...niebla, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(prog.p);
    const ojoZ = t.altura(e.x, e.y) + 1.65 + e.z - e.hundir + Math.abs(Math.sin(e.paso)) * 0.06;
    const ojo = [e.x, ojoZ, -e.y];
    const proy = mat.perspectiva((70 * Math.PI) / 180, w / h, 0.05, 3000);
    const vp = mat.mult(proy, mat.vista(ojo, e.yaw, e.pitch));
    const s = solEn(e.t), sd = dirSol(s);
    const u = prog.u;
    gl.uniform3fv(u.uSol, sd); gl.uniform3fv(u.uNiebla, niebla); gl.uniform1f(u.uT, performance.now() / 1000);
    gl.uniform1f(u.uLuz, Math.max(0.15, Math.min(1, s.elevacion / 25)));
    // Cielo centrado en el ojo, sin niebla.
    gl.uniformMatrix4fv(u.uVP, false, vp);
    gl.uniform3fv(u.uOjo, ojo);
    gl.uniform1f(u.uDens, 0);
    gl.depthMask(false);
    gl.uniformMatrix4fv(u.uM, false, mat.trasladar(ojo[0], ojo[1] - 30, ojo[2]));
    if (progCielo) {
      gl.useProgram(progCielo.p);
      gl.uniformMatrix4fv(progCielo.u.uVP, false, vp);
      gl.uniformMatrix4fv(progCielo.u.uM, false, mat.trasladar(ojo[0], ojo[1], ojo[2]));
      gl.uniform3fv(progCielo.u.uSol, sReal); gl.uniform3fv(progCielo.u.uOjo, ojo);
    }
    dibujar(gl, mCielo);
    gl.useProgram(prog.p);
    gl.depthMask(true);
    gl.uniform1f(u.uDens, 1 / 900);
    gl.uniformMatrix4fv(u.uM, false, mat.identidad());
    dibujar(gl, mTerreno);
    dibujar(gl, mObjetos);
    dibujarPolvo();
    // Cuerpo en espacio de cámara.
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(u.uVP, false, proy);
    gl.uniform3fv(u.uOjo, [0, 0, 0]);
    gl.uniform1f(u.uDens, 0);
    // La luz del Sol en coordenadas de cámara (aprox.: girada por el yaw).
    const cy = Math.cos(e.yaw), sy = Math.sin(e.yaw);
    gl.uniform3fv(u.uSol, [sd[0] * cy + sd[2] * sy, sd[1], -sd[0] * sy + sd[2] * cy]);
    const bx = Math.sin(e.paso) * 0.012, by = Math.abs(Math.cos(e.paso)) * 0.015;
    pintarPantalla(bx, by, e.herr ? 0.06 : -0.05);
    gl.uniformMatrix4fv(u.uM, false, mat.trasladar(-bx, -by, 0));
    dibujar(gl, cuerpo.izq);
    const subir = e.herr ? 0.06 : -0.05;
    gl.uniformMatrix4fv(u.uM, false, mat.rotXTras(e.uso * 0.25, bx, by + subir + e.uso * 0.03, 0));
    dibujar(gl, cuerpo.der);
    if (e.herr) dibujar(gl, cuerpo.herr[e.herr]);
  }

  function hud() {
    if (!e.empezado) return;
    const o2 = Math.max(0, 100 * (1 - e.t / 3600 / cfg.autonomiaH));
    const r = sobreRuta(e.x + e.err[0], e.y + e.err[1]);
    pintarApp(1 / 60);
    const regresoMin = (r.s + r.d) / vPlano / 60;
    const objetivo = e.llego && e.fotos >= 2 && e.muestras >= 3 ? { n: L("hábitat", "habitat"), d: Math.hypot(e.x, e.y) } : { n: L("base de campo", "field base"), d: distCiencia() };
    const est = [e.x + e.err[0], e.y + e.err[1]];
    $("#h-o2").textContent = `${num(o2, 0)} %`;
    $("#h-o2").parentElement.classList.toggle("alerta", o2 < 25);
    $("#h-regreso").textContent = `${num(regresoMin, 0)} min`;
    $("#h-desvio").textContent = `${num(r.d, 0)} m`;
    $("#h-desvio").parentElement.classList.toggle("alerta", r.d > cfg.corredor);
    $("#h-obj").textContent = `${objetivo.n} · ${num(objetivo.d, 0)} m`;
    $("#h-error").textContent = `± ${num(e.sigma, 1)} m`;
    $("#h-error").parentElement.classList.toggle("alerta", e.sigma > 15);
    $("#h-est").textContent = `${num(Math.round(est[0]) + 0, 0)} E · ${num(Math.round(est[1]) + 0, 0)} N`;
    $("#h-herr").textContent = e.herr ? NOMBRES[e.herr] : L("manos libres", "hands free");
    $("#h-hora").textContent = `${horaSolar(solEn(e.t).ltst)} · ×${num(cfg.reloj)}`;
    $("#h-ciencia").textContent = `${L("Fotos", "Photos")} ${e.fotos}/2 · ${L("Muestras", "Samples")} ${e.muestras}/3`;
    const a = $("#aviso");
    a.textContent = e.avisoT > 0 ? e.aviso : "";
    a.hidden = !(e.avisoT > 0);
    $("#pasos").innerHTML = listaPasos();
    // Brújula superior.
    const c = bruj.canvas, W = c.width, Hh = c.height;
    bruj.clearRect(0, 0, W, Hh);
    const rumbo = (e.yaw * 180) / Math.PI;
    bruj.font = "bold 13px system-ui, sans-serif";
    bruj.textAlign = "center";
    for (let g = -90; g <= 90; g += 15) {
      const ang = Math.round(rumbo / 15) * 15 + g;
      const x = W / 2 + (ang - rumbo) * 3;
      const n = ((ang % 360) + 360) % 360;
      bruj.fillStyle = "rgba(255,240,220,.85)";
      bruj.fillRect(x, Hh - 8, 1, 8);
      const nombre = { 0: "N", 90: EN ? "E" : "E", 180: "S", 270: EN ? "W" : "O" }[n];
      if (nombre || n % 45 === 0) {
        bruj.fillStyle = nombre ? "#ffd27a" : "rgba(255,240,220,.85)";
        bruj.fillText(nombre ?? String(n), x, 15);
      }
    }
    // Marcadores del objetivo y el Sol.
    const marca = (az, col) => {
      let dif = ((az - rumbo + 540) % 360) - 180;
      dif = Math.max(-88, Math.min(88, dif));
      bruj.fillStyle = col;
      bruj.beginPath(); const x = W / 2 + dif * 3; bruj.moveTo(x - 6, Hh); bruj.lineTo(x + 6, Hh); bruj.lineTo(x, Hh - 9); bruj.fill();
    };
    const destino = e.llego && e.fotos >= 2 && e.muestras >= 3 ? [0, 0] : [datos.ciencia.x, datos.ciencia.y];
    marca((Math.atan2(destino[0] - e.x, destino[1] - e.y) * 180) / Math.PI, "#5ee6e0");
    bruj.fillStyle = "#fff"; bruj.fillRect(W / 2 - 1, 0, 2, Hh);
  }

  // App «Red Frontier» de la muñeca: trabaja con la posición ESTIMADA, guía con pasos y rumbo y pide datos.
  const PASO_M = 0.7;
  const PEDIDOS = ["foto360", "barometro", "brujula", "radio"];
  const textoPedido = (p) => ({
    foto360: L("Pasame una foto 360: girá sobre tu lugar con la cámara (tecla 2) hasta completar la vuelta.", "Send me a 360 photo: turn in place with the camera (key 2) until you complete the circle."),
    barometro: L("Pasame una lectura del barómetro (1).", "Send me a barometer reading (1)."),
    brujula: L("Usá la brújula solar (3) para corregir el rumbo.", "Use the sun compass (3) to correct your heading."),
    radio: L("Medí la distancia al hábitat con la radio (4).", "Measure the distance to the habitat with the radio (4)."),
  })[p];
  const estimada = () => [e.x + e.err[0], e.y + e.err[1]];
  const vuelta = () => e.fotos >= 2 && e.muestras >= 3;
  const giroTxt = (g, volver = false) => (Math.abs(g) < 10 ? (volver ? L("volvé derecho", "go straight back") : L("seguí derecho", "keep straight"))
    : `${volver ? L("volvé girando", "go back turning") : L("girá", "turn")} ${num(Math.abs(g))}° ${g > 0 ? L("a la derecha", "right") : L("a la izquierda", "left")}`);
  function indicacion() {
    const [x, y] = estimada();
    const r = sobreRuta(x, y);
    const fin = vuelta() ? [0, 0] : [datos.ciencia.x, datos.ciencia.y];
    let obj = vuelta() ? puntoEn(r.s - 25) : puntoEn(r.s + 25);
    if (Math.hypot(fin[0] - x, fin[1] - y) < 30) obj = fin;
    const fuera = r.d > cfg.corredor;
    if (fuera) obj = puntoEn(r.s);
    const d = Math.hypot(obj[0] - x, obj[1] - y);
    const rumbo = ((Math.atan2(obj[0] - x, obj[1] - y) * 180) / Math.PI + 360) % 360;
    const giro = ((rumbo - (e.yaw * 180) / Math.PI) % 360 + 540) % 360 - 180;
    return { r, d, rumbo, giro, fuera, pasos: Math.max(1, Math.round(d / PASO_M)) };
  }
  const textoSeguir = (ind) => `${num(ind.pasos)} ${L("pasos", "steps")} (≈${num(ind.d)} m) ${L("rumbo", "heading")} ${num(ind.rumbo)}°`;
  function responder(tipo) {
    if (!e.pedido) return;
    if (e.pedido !== tipo && !(tipo === "radio" || tipo === "foto360")) return;
    e.pedido = null;
    e.ultimoPedidoM = e.recorrido;
    e.respuesta = `${L("Listo: ubicación corregida a", "Done: position corrected to")} ±${num(e.sigma)} m. ${L("Seguí:", "Go on:")} ${textoSeguir(indicacion())}.`;
    e.respuestaT = 6;
    appT = 0;
  }
  let appT = 0;
  function guia(dt) {
    e.respuestaT -= dt;
    if (!e.pedido && (e.sigma > 15 || e.recorrido - e.ultimoPedidoM > 150)) {
      e.pedido = PEDIDOS[e.nPedido++ % PEDIDOS.length];
      e.ultimoPedidoM = e.recorrido;
      audio?.alerta();
    }
    const ind = indicacion();
    if (ind.fuera && !e.fuera) audio?.alerta();
    e.fuera = ind.fuera;
  }
  function pintarApp(dt) {
    appT -= dt;
    if (appT > 0) return;
    appT = 0.2;
    const ind = indicacion();
    const destino = vuelta() ? L("hábitat", "habitat") : L("base de campo", "field base");
    let principal;
    if (e.fin) principal = L("Misión completa. ¡Bienvenido!", "Mission complete. Welcome back!");
    else if (ind.fuera) principal = `${L("Te saliste de la ruta segura", "You left the safe route by")} ${num(ind.r.d)} m: ${giroTxt(ind.giro, true)}. ${textoSeguir(ind)}.`;
    else principal = `${L("Caminá", "Walk")} ${textoSeguir(ind)} — ${giroTxt(ind.giro)}.`;
    const pedido = e.pedido ? `<p class="app-pide">${L("Mi estimación tiene", "My estimate is")} ±${num(e.sigma)} m. ${textoPedido(e.pedido)}${e.pedido === "foto360" && e.herr === "camara" ? ` <b>${num((e.giroCam * 180) / Math.PI)}°/360°</b>` : ""}</p>` : "";
    const resp = e.respuestaT > 0 ? `<p class="app-ok">${e.respuesta}</p>` : "";
    const ciencia = e.llego && !vuelta() ? `<p>${L("En la base de campo: 2 fotos (2) y 3 muestras (E).", "At the field base: 2 photos (2) and 3 samples (E).")}</p>` : "";
    const sig = pasos.find((p) => !hechos.has(p.id));
    $("#app-cuerpo").innerHTML = `${resp}${pedido}<p class="app-nav">${principal}</p>${ciencia}
      <p class="app-pie">${L("Destino", "Target")}: ${destino} · ±${num(e.sigma)} m · ${L("Gravedad", "Gravity")} ${num(G / 9.81, 2)} g</p>
      ${sig && e.appGrande ? `<p class="app-pie">${L("Paso del tutorial", "Tutorial step")}: ${sig.txt}</p>` : ""}`;
  }

  // Salto con la gravedad de Marte (en tiempo real, no acelerado).
  function saltar() {
    if (!e.empezado || e.fin || e.enAire) return;
    e.enAire = true; e.vz = 1.7;
    audio?.salto();
  }
  function silenciar() {
    if (!audio) return;
    const m = audio.alternar();
    $("#btn-mudo").textContent = m ? L("Sonido: no (M)", "Sound: off (M)") : L("Sonido: sí (M)", "Sound: on (M)");
  }
  function fisica(dt) {
    if (e.enAire) {
      e.vz -= G * dt; e.z += e.vz * dt;
      if (e.z <= 0) {
        e.z = 0; e.enAire = false; e.hundir = 0.12;
        audio?.aterrizaje(0.7);
        const h = t.altura(e.x, e.y);
        for (let k = 0; k < 28; k++) {
          const a = azar() * Math.PI * 2, v0 = 0.4 + azar() * 0.9;
          particulas.push({ x: e.x + Math.cos(a) * 0.3, y: e.y + Math.sin(a) * 0.3, z: h + 0.05, vx: Math.cos(a) * v0, vy: Math.sin(a) * v0, vz: 0.5 + azar() * 1.2, vida: 2.5 + azar() });
        }
      }
    }
    e.hundir = Math.max(0, e.hundir - dt * 0.35);
    for (const p of particulas) {
      p.vz -= G * dt * 0.6; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vx *= 1 - dt * 0.6; p.vy *= 1 - dt * 0.6;
      const piso = t.altura(p.x, p.y);
      if (p.z < piso) { p.z = piso; p.vz = 0; }
      p.vida -= dt;
    }
    while (particulas.length && particulas[0].vida <= 0) particulas.shift();
  }
  const polvoVao = gl.createVertexArray(), polvoPos = gl.createBuffer(), polvoCol = gl.createBuffer();
  gl.bindVertexArray(polvoVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, polvoPos); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, polvoCol); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  function dibujarPolvo() {
    const vivas = particulas.filter((p) => p.vida > 0);
    if (!vivas.length) return;
    const pos = [], col = [];
    for (const p of vivas) {
      const s = 0.05 + 0.04 * Math.min(1, p.vida / 2), X = p.x, Y = p.z, Z = -p.y;
      const tri = [[X - s, Y, Z], [X + s, Y, Z], [X, Y + s * 1.6, Z], [X, Y, Z - s], [X, Y, Z + s], [X, Y + s * 1.6, Z]];
      for (const q of tri) { pos.push(...q); col.push(0.7, 0.5, 0.36, 0); }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, polvoPos); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, polvoCol); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(col), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(polvoVao);
    gl.drawArrays(gl.TRIANGLES, 0, pos.length / 3);
  }

  // Pantallita del instrumento en la mano: muestra lo que marca.
  const pant = $("#pantalla-herr"), pctx = pant.getContext("2d");
  function pintarPantalla(bx, by, subir) {
    if (!e.herr || !e.empezado) { pant.hidden = true; return; }
    pant.hidden = false;
    const w = lienzo.clientWidth, h = lienzo.clientHeight, f = 1 / Math.tan((35 * Math.PI) / 180);
    // Misma transformación que la mano derecha: giro en X por el uso y traslación.
    const ang = e.uso * 0.25, ca = Math.cos(ang), sa = Math.sin(ang), y0 = -0.18, z0 = -0.7;
    const P = [0.18 + bx, ca * y0 - sa * z0 + by + subir + e.uso * 0.03, sa * y0 + ca * z0];
    const sx = (0.5 + (0.5 * f * P[0]) / (-P[2]) / (w / h)) * w, sy = (0.5 - (0.5 * f * P[1]) / (-P[2])) * h;
    const tam = Math.round(h * 0.17);
    pant.style.width = `${tam * 1.3}px`; pant.style.height = `${tam}px`;
    pant.style.left = `${sx - tam * 0.65}px`; pant.style.top = `${sy - tam * 0.85}px`;
    const W = pant.width, H = pant.height, c = pctx;
    c.fillStyle = "#0d1716"; c.fillRect(0, 0, W, H);
    c.strokeStyle = "#5ee6e0"; c.lineWidth = 3; c.strokeRect(2, 2, W - 4, H - 4);
    c.fillStyle = "#bff7f2"; c.textAlign = "center"; c.textBaseline = "middle";
    const rumbo = (((e.yaw * 180) / Math.PI) % 360 + 360) % 360;
    if (e.herr === "brujula") {
      const cx = W * 0.32, cy = H / 2, R = H * 0.36;
      c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
      const a = -e.yaw - Math.PI / 2;
      c.strokeStyle = "#ff5a4a"; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * R * 0.9, cy + Math.sin(a) * R * 0.9); c.stroke();
      c.fillStyle = "#ff5a4a"; c.font = `bold ${H * 0.13}px system-ui`; c.fillText("N", cx + Math.cos(a) * R * 1.18, cy + Math.sin(a) * R * 1.18);
      c.fillStyle = "#bff7f2"; c.font = `bold ${H * 0.24}px system-ui`; c.fillText(`${num(rumbo)}°`, W * 0.72, H * 0.42);
      const s = solEn(e.t);
      c.font = `${H * 0.11}px system-ui`; c.fillText(`${L("Sol", "Sun")} ${num(s.azimut)}° / ${num(s.elevacion)}°`, W * 0.72, H * 0.72);
    } else if (e.herr === "camara") {
      if (e.lect.foto?.complete && e.lect.foto.naturalWidth) c.drawImage(e.lect.foto, 6, 6, W - 12, H - 12);
      else { c.font = `bold ${H * 0.16}px system-ui`; c.fillText(L("CÁMARA", "CAMERA"), W / 2, H * 0.38); }
      c.font = `bold ${H * 0.13}px system-ui`; c.fillStyle = "rgba(13,23,22,.7)"; c.fillRect(6, H - 30, W - 12, 24);
      c.fillStyle = "#bff7f2"; c.fillText(`360: ${num(Math.min(360, (e.giroCam * 180) / Math.PI))}°`, W / 2, H - 18);
    } else {
      const l = e.lect[e.herr] ?? ["—", L("clic para medir", "click to measure")];
      c.font = `bold ${H * 0.26}px system-ui`; c.fillText(l[0], W / 2, H * 0.4);
      c.font = `${H * 0.15}px system-ui`; c.fillText(l[1], W / 2, H * 0.72);
    }
  }

  function terminar() {
    e.fin = true;
    audio?.exito();
    document.exitPointerLock?.();
    const desvio = e.nDesvio ? e.sumaDesvio / e.nDesvio : 0;
    const puntos = Math.max(0, Math.round(1000 - desvio * 25 - Math.max(0, e.maxDesvio - cfg.corredor) * 5 + e.usadas.size * 50 - Math.max(0, e.t / 60 - 120) * 2));
    $("#final-datos").innerHTML = `<p class="grande">${num(puntos)} ${L("puntos", "points")}</p>
      <ul>
        <li>${L("Recorrido", "Distance walked")}: <b>${num(e.recorrido, 0)} m</b> (${L("ruta segura", "safe route")} ${num(largo * 2, 0)} m ${L("ida y vuelta", "round trip")})</li>
        <li>${L("Desvío medio de la ruta", "Mean deviation from route")}: <b>${num(desvio, 1)} m</b> · ${L("máximo", "max")} ${num(e.maxDesvio, 0)} m</li>
        <li>${L("Tiempo de misión", "Mission time")}: <b>${num(e.t / 60, 0)} min</b> (${L("reloj acelerado", "accelerated clock")} ×${num(cfg.reloj)})</li>
        <li>${L("Herramientas usadas", "Tools used")}: <b>${[...e.usadas].map((h) => NOMBRES[h]).join(", ") || "—"}</b> (${e.lecturas} ${L("lecturas", "readings")})</li>
        <li>${L("Ciencia", "Science")}: ${e.fotos}/2 ${L("fotos", "photos")}, ${e.muestras}/3 ${L("muestras", "samples")}</li>
      </ul>`;
    $("#final").hidden = false;
  }

  requestAnimationFrame(cuadro);
  window.__practica = e;
}

iniciar().catch((err) => {
  console.error(err);
  $("#carga").innerHTML = `<p>${L("No se pudo cargar el modo práctica", "Could not load practice mode")}: ${String(err.message ?? err)}</p>`;
});
