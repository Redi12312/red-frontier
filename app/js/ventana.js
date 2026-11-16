// Panel "Ventana EVA · clima": hora y estación en la zona, último parte de Curiosity, clima espacial de
// NASA y semáforo de salida. Funciona con los datos guardados; con internet se puede actualizar.
import { tiempoMarte, horaLocal, solCuriosity, resumenRems, llegadasMarte, semaforo, franjasDelSol } from "./clima.js";
import { t, t as traducir, locale } from "./idioma.js";

const NIVEL = { verde: "SE PUEDE SALIR", ambar: "SALIR CON PRECAUCIÓN", rojo: "NO SALIR · REFUGIO" };
const UV = { Low: "bajo", Moderate: "moderado", High: "alto", Very_High: "muy alto", Extreme: "extremo" };
const CIELO = { Sunny: "despejado", Cloudy: "nublado", Dusty: "con polvo" };

export function crearVentana({ $, num, fmt, leerHttp, RAIZ, estado }) {
  let cfg = null, datos = null, origen = "";

  async function cargar() {
    try {
      [cfg, datos] = await Promise.all([leerHttp(`${RAIZ}/config/clima.json`, "json"), leerHttp(`${RAIZ}/datos/clima/clima.json`, "json")]);
      origen = `Datos guardados el ${new Date(datos.descargado).toLocaleString(locale())}.`;
      dibujar();
      setInterval(dibujar, 60000);
    } catch (err) {
      $("#clima-semaforo").innerHTML = `<p class="ayuda">No hay datos de clima guardados (${err.message}). Corré el pipeline de clima.</p>`;
    }
  }

  async function actualizar() {
    const b = $("#clima-actualizar");
    b.disabled = true;
    b.textContent = "Pidiendo a NASA…";
    try {
      const hoy = new Date(), desde = new Date(hoy - cfg.fuentes.donki.dias * 86400000);
      const f = (d) => d.toISOString().slice(0, 10);
      const donki = async (tipo) => (await fetch(`${cfg.fuentes.donki.base}${tipo}?startDate=${f(desde)}&endDate=${f(hoy)}&api_key=${cfg.fuentes.donki.clave}`)).json();
      const [rems, enlil, sep] = await Promise.all([(await fetch(cfg.fuentes.rems.url)).json(), donki("WSAEnlilSimulations"), donki("SEP")]);
      datos = { ...datos, rems: { ...datos.rems, soles: rems.soles.slice(0, 700) }, donki: { ...datos.donki, WSAEnlilSimulations: enlil, SEP: sep } };
      origen = `Actualizado desde NASA el ${hoy.toLocaleString(locale())}.`;
      dibujar();
    } catch {
      origen = "No se pudo actualizar (¿sin internet?). Se siguen usando los datos guardados.";
      dibujar();
    } finally {
      b.disabled = false;
      b.textContent = "Actualizar desde NASA";
    }
  }

  function dibujar() {
    if (!datos) return;
    const ahora = Date.now();
    const t = tiempoMarte(ahora);
    const lon = estado.zona ? (estado.zona.meta.limites.lon_oeste + estado.zona.meta.limites.lon_este) / 2 : 137.4;
    const lmst = horaLocal(t.mtc, lon);
    const rems = resumenRems(datos.rems.soles);
    const llegadas = llegadasMarte(datos.donki.WSAEnlilSimulations);
    const sem = semaforo({ ahora, ls: t.ls, llegadas, sep: datos.donki.SEP || [], rems, cfg });
    estado.ventana = sem;

    $("#clima-semaforo").innerHTML = `<div class="decision ${sem.nivel === "verde" ? "si" : sem.nivel === "rojo" ? "no" : "ambar"}">
        <div class="veredicto">${NIVEL[sem.nivel]}</div>
        ${sem.motivos.length ? `<ul class="motivos">${sem.motivos.map((m) => `<li class="${m.nivel}" title="${m.fuente.replace(/"/g, "&quot;")}">${m.texto}</li>`).join("")}</ul>`
          : '<div class="motivo">Sin tormentas solares previstas ni temporada de polvo.</div>'}
      </div>`;

    const hh = (h) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`;
    const rad = cfg.radiacion_superficie_mSv_dia.valor;
    $("#clima-datos").innerHTML = `
      <dt>Hoy en la zona</dt><dd>sol ~${num(solCuriosity(t.msd))} de Curiosity · Ls ${num(t.ls, 1)}° · ${hh(lmst)} hora solar</dd>
      <dt>Último parte</dt><dd>sol ${num(rems.sol)} (${rems.fecha}) · llega con ${num(solCuriosity(t.msd) - rems.sol)} soles de atraso</dd>
      <dt>Aire</dt><dd>${fmt.temp(rems.aire[0])} a ${fmt.temp(rems.aire[1])}</dd>
      <dt>Suelo</dt><dd>${fmt.temp(rems.suelo[0])} a ${fmt.temp(rems.suelo[1])}</dd>
      <dt>Presión</dt><dd>${fmt.pres(rems.presion)}</dd>
      <dt>Cielo / UV</dt><dd>${CIELO[rems.opacidad] || rems.opacidad} · UV ${UV[rems.uv] || rems.uv}</dd>
      <dt>Luz</dt><dd>amanecer ${hh(rems.amanecer)} · atardecer ${hh(rems.atardecer)}</dd>
      <dt>Radiación</dt><dd>${num(rad, 2)} mSv/día de fondo (RAD) → ${num(rad / 24, 3)} mSv por hora afuera</dd>`;

    dibujarSerie(rems.serie);
    dibujarFranjas(franjasDelSol(rems, cfg), lmst);

    const proximas = llegadas.slice(0, 5).map((l) => {
      const dh = (l.llegada - ahora) / 3600000;
      const cuando = dh > 0 ? `en ${num(dh / 24, 1)} días` : `hace ${num(-dh / 24, 1)} días`;
      const tipo = l.directo ? "impacto directo" : l.refilon ? "de refilón" : "menor";
      return `<li><span class="${l.directo ? "falla" : ""}">${new Date(l.llegada).toISOString().slice(0, 16).replace("T", " ")} UTC</span> · ${tipo} · ${cuando}</li>`;
    });
    const sep = (datos.donki.SEP || []).length;
    $("#clima-espacial").innerHTML = `<h3 class="subtitulo-caja">Clima espacial (DONKI, NASA)</h3>
      <ul class="lista-clima">${proximas.join("") || "<li>Sin llegadas de eyecciones a Marte en el período</li>"}</ul>
      <p class="ayuda">${sep ? `${sep} eventos de partículas solares (SEP)` : "Sin eventos de partículas solares (SEP)"} en los últimos ${cfg.fuentes.donki.dias} días.</p>`;
    $("#clima-origen").textContent = `${traducir(origen)} ${traducir(cfg.fuentes.rems.aviso)}`;
  }

  function dibujarSerie(serie) {
    const lienzo = $("#clima-serie");
    const dpr = window.devicePixelRatio || 1, w = lienzo.clientWidth, h = lienzo.clientHeight;
    lienzo.width = w * dpr; lienzo.height = h * dpr;
    const g = lienzo.getContext("2d");
    g.scale(dpr, dpr);
    const vals = serie.flatMap((s) => [s.min, s.max, s.suelo_min, s.suelo_max]).filter((v) => v !== null);
    const yMin = Math.min(...vals) - 5, yMax = Math.max(...vals) + 5;
    const X = (i) => 26 + (i / Math.max(serie.length - 1, 1)) * (w - 32), Y = (v) => h - 14 - ((v - yMin) / (yMax - yMin)) * (h - 22);
    const linea = (campo, color, ancho = 1.4) => {
      g.strokeStyle = color; g.lineWidth = ancho; g.beginPath();
      let empezo = false;
      serie.forEach((s, i) => { if (s[campo] === null) return; if (empezo) g.lineTo(X(i), Y(s[campo])); else { g.moveTo(X(i), Y(s[campo])); empezo = true; } });
      g.stroke();
    };
    linea("suelo_max", "rgba(247,79,37,.45)", 1); linea("suelo_min", "rgba(88,166,255,.45)", 1);
    linea("max", "#f74f25"); linea("min", "#58a6ff");
    g.fillStyle = "#8b95a1"; g.font = "10px monospace";
    g.fillText(`${Math.round(yMax)} °C`, 0, 10); g.fillText(`${Math.round(yMin)} °C`, 0, h - 14);
    g.fillText(t(`soles ${serie[0].sol}–${serie.at(-1).sol} · aire (línea) y suelo (tenue)`), 26, h - 2);
  }

  function dibujarFranjas(franjas, ahoraH) {
    const caja = $("#clima-franjas");
    caja.innerHTML = franjas.map((f) => `<i class="${f.tipo}" style="left:${(f.desde / 24) * 100}%;width:${((f.hasta - f.desde) / 24) * 100}%" title="${f.texto}"></i>`).join("")
      + `<b class="ahora" style="left:${(ahoraH / 24) * 100}%" title="Ahora"></b>`
      + ["00", "06", "12", "18", "24"].map((t, k) => `<span style="left:${k * 25}%">${t}</span>`).join("");
  }

  $("#clima-actualizar").addEventListener("click", actualizar);
  return { cargar, dibujar };
}

// Agrega a una decisión de salida el control "Condiciones del día" (Ventana EVA). Rojo = no se aprueba.
export function conClima(ev, sem) {
  if (!ev || !sem) return ev;
  const control = {
    id: "clima", nombre: "Condiciones del día (Ventana EVA)", valor: { verde: "verde", ambar: "ámbar", rojo: "rojo" }[sem.nivel],
    umbral: "verde", ok: sem.nivel === "verde", aviso: sem.nivel === "ambar", unidad: "", base: "calculo",
    fuente: sem.motivos.map((m) => m.texto).join(" · ") || "Sin alertas", detalle: "",
  };
  const controles = [...ev.controles.filter((c) => c.id !== "clima"), control];
  return { ...ev, controles, decision: controles.every((c) => c.ok || c.aviso) ? "SI" : "NO" };
}
