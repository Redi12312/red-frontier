// Guía de exploración: contenido bilingüe local y acciones de la consola existente.
import { guardar } from "./guardado.js";
import { t } from "./idioma.js"; // Solo el cierre de emergencia si falta el archivo de contenido.

export const GANCHOS_GUIA = Object.freeze(["marte", "zona", "menu", "herramienta", "interfaz", "capa", "tema"]);
export const TERMINOS_GUIA = Object.freeze(["eva", "dtm", "hirise", "o2-secundario", "walkback", "mars24", "rems", "donki", "sol"]);

// Texto plano dividido en enlaces seguros. Respeta palabras completas y alias bilingües.
export function segmentarGlosario(texto, glosario, idioma) {
  const terminos = new Map();
  for (const termino of glosario || []) {
    for (const alias of [termino[idioma].termino, ...(termino.alias?.[idioma] || [])]) terminos.set(alias.toLocaleLowerCase(), termino.id);
  }
  if (!terminos.size) return [{ texto }];
  const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patron = [...terminos.keys()].sort((a, b) => b.length - a.length).map(escapar).join("|");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${patron})(?![\\p{L}\\p{N}])`, "giu");
  const partes = [];
  let inicio = 0;
  for (const m of texto.matchAll(re)) {
    if (m.index > inicio) partes.push({ texto: texto.slice(inicio, m.index) });
    const id = terminos.get(m[0].toLocaleLowerCase());
    // En español «Sol» nombra la estrella; «sol» es el día marciano.
    partes.push({ texto: m[0], ...(idioma === "es" && id === "sol" && m[0] === "Sol" ? {} : { id }) });
    inicio = m.index + m[0].length;
  }
  if (inicio < texto.length) partes.push({ texto: texto.slice(inicio) });
  return partes;
}

export function necesitaBienvenida({ url, guardado } = {}) {
  const parametros = new URL(url || "https://local.invalid/", "https://local.invalid/").searchParams;
  return parametros.get("guia") === "inicio" || (!guardado && !parametros.has("lang"));
}

export function validarContenido(contenido) {
  const problemas = [], ids = new Set();
  for (const tema of contenido?.temas || []) {
    if (!tema.id || ids.has(tema.id)) problemas.push(`id_repetido_o_ausente: ${tema.id}`);
    ids.add(tema.id);
    if (!tema.selector) problemas.push(`selector_ausente: ${tema.id}`);
    if (!GANCHOS_GUIA.includes(tema.accion?.gancho)) problemas.push(`gancho_desconocido: ${tema.id}`);
    if (typeof tema.algoritmo !== "boolean") problemas.push(`algoritmo_ausente: ${tema.id}`);
    for (const idioma of ["es", "en"]) for (const campo of ["titulo", "que", "porQue", "utilidad", tema.algoritmo ? "como" : "origen", "probar"]) {
      if (typeof tema[idioma]?.[campo] !== "string" || !tema[idioma][campo].trim()) problemas.push(`texto_ausente: ${idioma}.${campo}: ${tema.id}`);
    }
    if (tema.diagrama) for (const idioma of ["es", "en"]) {
      if (!tema[idioma]?.diagrama?.trim()) problemas.push(`leyenda_ausente: ${tema.id}.${idioma}`);
      if (tema.diagrama === "horizonte" && (tema[idioma]?.pasos?.length !== 6 || tema[idioma].pasos.some((p) => !p.titulo?.trim() || !p.texto?.trim()))) {
        problemas.push(`pasos_ausentes: ${tema.id}.${idioma}`);
      }
    }
  }
  if (!ids.size) problemas.push("temas_ausentes");
  for (const id of TERMINOS_GUIA) {
    const termino = contenido?.glosario?.find((t) => t.id === id);
    for (const idioma of ["es", "en"]) for (const campo of ["termino", "definicion"]) {
      if (!termino?.[idioma]?.[campo]?.trim()) problemas.push(`glosario_ausente: ${id}.${idioma}.${campo}`);
    }
  }
  for (const escena of contenido?.escenas || []) if (!ids.has(escena.tema)) problemas.push(`tema_de_escena_ausente: ${escena.tema}`);
  return problemas;
}

export function crearGuia({ idioma, estado, ganchos }) {
  const $ = (s) => document.querySelector(s), raiz = $("#guia-raiz"), panel = $("#guia-panel");
  const botonAbrir = $("#guia-abrir"), dialogo = $("#guia-bienvenida");
  raiz.lang = idioma === "en" ? "en" : "es-UY";
  let contenido, activa = false, lista = false, retorno = botonAbrir, resaltado = null;
  let raf = null, ejecutando = false, temaActual = null;
  let resolverBienvenida = null;
  const controles = new Map(), botones = new Set();
  const carga = fetch(new URL("../guia/contenido.json", import.meta.url))
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then((c) => { const errores = validarContenido(c); if (errores.length) throw new Error(errores.join("; ")); contenido = c; return c; })
    .catch((error) => { console.warn("guia_contenido", error); return null; });
  const ui = (clave) => contenido?.interfaz[idioma][clave] || clave;
  const texto = (tema) => tema[idioma];
  const nodo = (tag, clase, valor) => {
    const el = document.createElement(tag);
    if (clase) el.className = clase;
    if (valor) el.textContent = valor;
    return el;
  };
  function boton(etiqueta, accion, clase) {
    const b = nodo("button", clase, etiqueta); b.type = "button"; b.addEventListener("click", accion); return b;
  }
  function informar(clave) { $("#guia-estado").textContent = ui(clave); }
  function parrafo(texto) {
    const p = nodo("p");
    for (const parte of segmentarGlosario(texto, contenido.glosario, idioma)) {
      if (parte.id) {
        const b = boton(parte.texto, () => mostrarGlosario(parte.id), "guia-termino");
        b.setAttribute("aria-label", `${ui("glosario")} · ${parte.texto}`);
        p.append(b);
      } else p.append(nodo("span", "", parte.texto));
    }
    return p;
  }
  function quitarResaltado() { resaltado?.classList.remove("guia-resaltado"); resaltado = null; }
  function resaltar(tema, desplazar = true) {
    quitarResaltado();
    const el = $(tema.control || tema.selector);
    if (!el) return;
    // Solo se despliegan secciones; no se simulan elecciones del usuario al leer una ficha.
    const detalles = el.closest("details");
    if (detalles) detalles.open = true;
    if (el.getClientRects().length) {
      resaltado = el.closest("label") || el;
      resaltado.classList.add("guia-resaltado");
      if (desplazar) resaltado.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    }
  }
  function mostrarPanel(foco = true) {
    if (panel.hidden && foco) retorno = document.activeElement;
    panel.hidden = false;
    panel.scrollTop = 0;
    botonAbrir.setAttribute("aria-expanded", "true");
    actualizarIndicadores();
    ajustarPanel();
    const caja = $("#guia-contenido");
    caja.classList.remove("guia-entrada");
    void caja.offsetWidth;
    caja.classList.add("guia-entrada");
    if (foco) $("#guia-titulo").focus({ preventScroll: true });
  }
  function ajustarPanel() {
    const cabecera = document.querySelector("body > header");
    if (cabecera) panel.style.setProperty("--guia-cabecera-alto", `${cabecera.getBoundingClientRect().bottom + 8}px`);
  }
  function cerrar() {
    panel.hidden = true;
    quitarResaltado();
    botonAbrir.setAttribute("aria-expanded", "false");
    actualizarIndicadores();
    if (panel.contains(document.activeElement)) (retorno?.isConnected ? retorno : botonAbrir).focus({ preventScroll: true });
  }
  function desactivar() {
    activa = false; cerrar(); actualizarIndicadores();
    botonAbrir.setAttribute("aria-pressed", "false");
  }
  function activar() {
    activa = true;
    botonAbrir.setAttribute("aria-pressed", "true");
    actualizarIndicadores();
  }
  function navegacion() {
    const nav = $("#guia-navegacion"); nav.replaceChildren();
    nav.append(boton(ui("indice"), () => mostrarIndice()), boton(ui("historia"), mostrarEscenas), boton(ui("glosario"), () => mostrarGlosario()), boton(ui("desactivar"), desactivar));
  }
  function mostrarGlosario(id) {
    quitarResaltado();
    $("#guia-titulo").textContent = ui("glosario"); navegacion();
    const caja = $("#guia-contenido"); caja.replaceChildren();
    if (temaActual) caja.append(boton(ui("volverFicha"), () => mostrarTema(temaActual)));
    let elegido;
    for (const termino of contenido.glosario) {
      const seccion = nodo("section"), titulo = nodo("h3", "", termino[idioma].termino);
      titulo.tabIndex = -1;
      seccion.append(titulo, nodo("p", "", termino[idioma].definicion)); caja.append(seccion);
      if (termino.id === id) elegido = titulo;
    }
    informar("libre"); mostrarPanel();
    if (elegido) { elegido.scrollIntoView({ block: "nearest" }); elegido.focus({ preventScroll: true }); }
  }
  function mostrarIndice() {
    quitarResaltado();
    $("#guia-titulo").textContent = ui("titulo"); navegacion();
    const caja = $("#guia-contenido"); caja.replaceChildren(nodo("p", "guia-intro", ui("introduccion")));
    const lista = nodo("nav", "guia-indice"); lista.setAttribute("aria-label", ui("indice"));
    for (const tema of contenido.temas) lista.append(boton(texto(tema).titulo, () => mostrarTema(tema.id)));
    caja.append(lista); informar("indicadores"); mostrarPanel();
  }
  function mostrarEscenas() {
    quitarResaltado();
    $("#guia-titulo").textContent = ui("historia"); navegacion();
    const caja = $("#guia-contenido"); caja.replaceChildren(nodo("p", "guia-intro", ui("historiaIntro")));
    for (const escena of contenido.escenas) {
      const tema = contenido.temas.find((t) => t.id === escena.tema), tarjeta = nodo("article", "guia-escena");
      tarjeta.append(boton(escena[idioma].titulo, () => mostrarTema(tema.id)), nodo("p", "", escena[idioma].texto), boton(texto(tema).probar, () => { mostrarTema(tema.id); ejecutar(tema); }, "primario"));
      caja.append(tarjeta);
    }
    informar("libre"); mostrarPanel();
  }
  function mostrarTema(id, foco = true) {
    const tema = contenido.temas.find((t) => t.id === id);
    if (!tema || ejecutando) return;
    temaActual = id;
    $("#guia-titulo").textContent = texto(tema).titulo; navegacion();
    const caja = $("#guia-contenido"); caja.replaceChildren();
    for (const clave of ["que", "porQue", tema.algoritmo ? "como" : "origen", "utilidad"]) {
      const seccion = nodo("section"); seccion.append(nodo("h3", "", ui(clave)), parrafo(texto(tema)[clave])); caja.append(seccion);
      if (clave === "como" && tema.diagrama) caja.append(diagrama(tema));
    }
    const seccion = nodo("section"); seccion.append(nodo("h3", "", ui("probar")), boton(texto(tema).probar, () => ejecutar(tema), "primario guia-probar")); caja.append(seccion);
    const relacionados = contenido.temas.filter((t) => t.selector === tema.selector && t.id !== id);
    if (relacionados.length) {
      const nav = nodo("nav", "guia-relacionados"); nav.setAttribute("aria-label", ui("relacionados"));
      nav.append(nodo("h3", "", ui("relacionados")));
      relacionados.forEach((t) => nav.append(boton(texto(t).titulo, () => mostrarTema(t.id)))); caja.append(nav);
    }
    informar("indicadores"); mostrarPanel(foco); resaltar(tema, foco);
  }
  function diagrama(tema) {
    const figura = nodo("figure", `guia-diagrama guia-diagrama-${tema.diagrama}`);
    figura.append(nodo("figcaption", "", texto(tema).diagrama));
    const svg = (tag, atributos, padre) => {
      const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [clave, valor] of Object.entries(atributos)) el.setAttribute(clave, valor);
      padre.append(el); return el;
    };
    const dibujo = svg("svg", { viewBox: "0 0 320 110", "aria-hidden": "true", focusable: "false" }, figura);
    if (tema.diagrama === "segura") {
      svg("ellipse", { cx: 95, cy: 58, rx: 65, ry: 38, class: "guia-area" }, dibujo);
      svg("ellipse", { cx: 215, cy: 58, rx: 65, ry: 38, class: "guia-area guia-ampliacion" }, dibujo);
      svg("path", { d: "M80 65V45L95 33L110 45V65Z M200 65V45L215 33L230 45V65Z", class: "guia-trazo" }, dibujo);
    } else if (tema.diagrama === "ruta") {
      svg("path", { d: "M20 85L65 85L105 55L145 55L185 25L235 25L295 50", class: "guia-ruta-base" }, dibujo);
      svg("path", { d: "M20 85L65 85L105 55L145 55L185 25L235 25L295 50", pathLength: 100, class: "guia-ruta-avance" }, dibujo);
      svg("path", { d: "M95 105L155 75L205 75L245 100", class: "guia-obstaculo" }, dibujo);
    } else if (tema.diagrama === "oxigeno") {
      svg("circle", { cx: 65, cy: 55, r: 36, class: "guia-reloj-base" }, dibujo);
      svg("circle", { cx: 65, cy: 55, r: 36, pathLength: 100, class: "guia-reloj" }, dibujo);
      svg("path", { d: "M125 35H295V75H125Z", class: "guia-reloj-base" }, dibujo);
      svg("rect", { x: 130, y: 40, width: 160, height: 30, class: "guia-oxigeno" }, dibujo);
      const etiqueta = svg("text", { x: 65, y: 61, "text-anchor": "middle" }, dibujo); etiqueta.textContent = "O₂";
    } else {
      svg("path", { d: "M10 80L50 55L85 65L120 28L155 60L195 45L240 70L280 32L310 50", class: "guia-silueta-base" }, dibujo);
      svg("path", { d: "M10 80L50 55L85 65L120 28L155 60L195 45L240 70L280 32L310 50", pathLength: 100, class: "guia-silueta" }, dibujo);
      svg("ellipse", { cx: 160, cy: 85, rx: 48, ry: 18, class: "guia-area guia-fusion" }, dibujo);
    }
    if (texto(tema).pasos) {
      const pasos = nodo("ol", "guia-pasos");
      for (const [i, paso] of texto(tema).pasos.entries()) {
        const item = nodo("li"); item.style.setProperty("--paso", i);
        item.append(nodo("strong", "", paso.titulo), parrafo(paso.texto)); pasos.append(item);
      }
      figura.append(pasos);
    }
    return figura;
  }
  async function ejecutar(tema) {
    if (ejecutando) return;
    const a = tema.accion;
    if (!lista || !estado.indice) { informar("cargando"); return; }
    if (a.necesita && (!estado.zona || estado.vista !== "zona")) { informar("necesitaZona"); return; }
    if (a.necesita === "base" && !estado.marcas.base) { informar("necesitaBase"); return; }
    if (a.necesita === "pie" && estado.zona.meta.vehiculo === "rover") { informar("necesitaPie"); return; }
    if (a.necesita === "rover" && estado.zona.meta.vehiculo !== "rover") { informar("necesitaRover"); return; }
    ejecutando = true;
    const b = $(".guia-probar"); if (b) b.disabled = true;
    try {
      let destino;
      if (a.gancho === "tema") { ejecutando = false; mostrarTema(a.argumento); return; }
      if (a.gancho === "interfaz" || a.gancho === "capa") {
        destino = $(a.argumento);
        if (!destino || destino.disabled || destino.hidden || destino.closest("[hidden]")) { informar("noDisponible"); return; }
        if (a.gancho === "capa") {
          if (!destino.checked) { destino.checked = true; destino.dispatchEvent(new Event("change", { bubbles: true })); }
        } else if (destino.matches("button, [role=button], input[type=file]")) destino.click();
        else if (destino.matches("details")) destino.open = true;
        const detalles = destino.closest("details"); if (detalles) detalles.open = true;
        if (!destino.matches("button, input, select, textarea, a, details")) destino.tabIndex = -1;
        destino.scrollIntoView({ block: "nearest", inline: "nearest" });
      } else {
        // Los ganchos son referencias explícitas del arranque de app.js, nunca código del JSON.
        if (a.gancho === "zona" && !estado.indice.zonas.some((z) => z.id === a.argumento)) { informar("noDisponible"); return; }
        await ganchos[a.gancho](a.argumento);
      }
      informar("hecho"); resaltar(tema);
      // Dejá la herramienta operable y devolvé el foco al control que se acaba de abrir.
      if (["menu", "herramienta", "marte", "zona"].includes(a.gancho) || a.gancho === "interfaz") {
        cerrar();
        (destino || $("#tarjeta-mapa input, .menu-mapa button") || botonAbrir)?.focus({ preventScroll: true });
      }
    } catch (error) { console.warn("guia_accion", error); informar("errorAccion"); }
    finally { ejecutando = false; if (b?.isConnected) b.disabled = false; programarIndicadores(); }
  }
  function actualizarIndicadores() {
    raf = null;
    document.body.classList.remove("guia-explorando");
    if (activa && !panel.hidden) document.body.classList.add("guia-explorando");
    if (!contenido) return;
    const cabezas = [[".hud-cabeza", "visor"]];
    const tarjeta = $("#tarjeta-mapa");
    if (tarjeta) {
      const tema = tarjeta.querySelector(".barometro") ? "barometro" : tarjeta.querySelector("[data-hora]") ? "luz"
        : tarjeta.querySelector(".ir-a") ? "coordenadas" : tarjeta.querySelector("canvas") ? "medir" : "radio";
      cabezas.push([".tarjeta-cabeza", tema]);
    }
    for (const [selector, tema] of cabezas) {
      const cabeza = $(selector);
      if (!cabeza || cabeza.querySelector("[data-guia-tema]")) continue;
      const b = nodo("button", "guia-info", "ⓘ"); b.type = "button";
      b.dataset.guiaTema = tema;
      b.setAttribute("data-no-traducir", ""); b.setAttribute("aria-controls", "guia-panel");
      cabeza.append(b);
    }
    controles.clear();
    for (const tema of contenido.temas) {
      const el = $(tema.control || tema.selector);
      if (!el || el.closest("header, footer") || el.id === "mapa") continue;
      const control = el.closest("label") || el;
      if (controles.has(control)) continue;
      controles.set(control, tema.id); control.classList.add("guia-control");
    }
    for (const b of document.querySelectorAll("[data-guia-tema]")) {
      const tema = contenido.temas.find((t) => t.id === b.dataset.guiaTema);
      if (!tema || botones.has(b)) continue;
      b.setAttribute("aria-label", `${ui("ayuda")} · ${texto(tema).titulo}`);
      b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); activar(); mostrarTema(tema.id); });
      botones.add(b);
    }
  }
  // La captura impide que explorar una ficha active también el control explicado.
  document.addEventListener("click", (e) => {
    if (!activa || panel.hidden || raiz.contains(e.target) || e.target.closest("[data-guia-tema]")) return;
    let el = e.target;
    while (el && !controles.has(el)) el = el.parentElement;
    if (!el) return;
    e.preventDefault(); e.stopImmediatePropagation(); mostrarTema(controles.get(el));
  }, true);
  function programarIndicadores() { if (raf === null) raf = requestAnimationFrame(actualizarIndicadores); }
  // Solo observa cambios de estructura/visibilidad, no el reloj ni cada cuadro del visor.
  new MutationObserver((cambios) => {
    if (cambios.some((c) => !raiz.contains(c.target) && (c.type === "attributes" || [...c.addedNodes, ...c.removedNodes].some((n) => n.nodeType === 1)))) programarIndicadores();
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "open"] });
  window.addEventListener("resize", ajustarPanel);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) { cerrar(); e.preventDefault(); } });
  $("#guia-cerrar").addEventListener("click", cerrar);
  botonAbrir.textContent = idioma === "en" ? "Guide" : "Guía";
  botonAbrir.addEventListener("click", async () => {
    if (!await carga) { location.reload(); return; }
    activar(); mostrarIndice();
  });
  for (const b of dialogo.querySelectorAll("[data-guia-idioma]")) b.addEventListener("click", () => {
    guardar("rf-idioma", b.dataset.guiaIdioma);
    const url = new URL(location.href); url.searchParams.set("lang", b.dataset.guiaIdioma); url.searchParams.set("guia", "inicio"); location.href = url.href;
  });
  function terminarBienvenida(guiada) {
    if (dialogo.open) dialogo.close();
    document.documentElement.classList.remove("guia-bienvenida-pendiente");
    const url = new URL(location.href); url.searchParams.delete("guia"); history.replaceState(null, "", url);
    if (guiada && contenido) { activar(); mostrarEscenas(); } else botonAbrir.focus({ preventScroll: true });
    resolverBienvenida?.(); resolverBienvenida = null;
  }
  dialogo.addEventListener("cancel", (e) => { e.preventDefault(); terminarBienvenida(false); });
  async function bienvenida() {
    let guardado = null; try { guardado = localStorage.getItem("rf-idioma"); } catch { /* preferencia por URL */ }
    const bienvenida = necesitaBienvenida({ url: location.href, guardado });
    const sigue = new URL(location.href).searchParams.get("guia") === "inicio";
    if (bienvenida) dialogo.showModal();
    await carga;
    if (contenido) {
      botonAbrir.textContent = ui("abrir");
      actualizarIndicadores();
      $(".guia-ceja").textContent = ui("marca");
      $("#guia-cerrar").textContent = ui("cerrar");
      if (bienvenida && !sigue) $("#guia-bienvenida-texto").textContent = ui("elegirIdioma");
      if (sigue) {
        $("#guia-bienvenida-titulo").textContent = ui("bienvenida");
        $("#guia-bienvenida-texto").textContent = ui("bienvenidaTexto");
        $("#guia-bienvenida-acciones").replaceChildren(boton(ui("recorrido"), () => terminarBienvenida(true), "primario"), boton(ui("explorar"), () => terminarBienvenida(false)));
        $("#guia-bienvenida-acciones button").focus();
      }
    } else if (bienvenida) {
      $("#guia-bienvenida-texto").textContent = "Error";
      $("#guia-bienvenida-acciones").append(boton(t("Cerrar"), () => terminarBienvenida(false)));
    }
    if (!bienvenida) { document.documentElement.classList.remove("guia-bienvenida-pendiente"); return; }
    if (!dialogo.open) return; // Esc durante la lectura del JSON.
    await new Promise((resolve) => { resolverBienvenida = resolve; });
  }
  return { bienvenida, lista: () => { lista = true; programarIndicadores(); } };
}
