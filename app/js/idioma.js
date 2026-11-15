// Traducción por texto. Sin red ni dependencias; el DOM solo se usa si se lo recibe.
const normalizar = (texto) => texto.trim().replace(/\s+/gu, " ");
const originales = new WeakMap();
const atributos = ["title", "placeholder", "aria-label", "alt"];
let activo = null;

export function elegirIdioma({ url, guardado, navegador } = {}) {
  try {
    const lang = new URL(String(url), "https://local.invalid/").searchParams.get("lang");
    if (lang === "es" || lang === "en") return lang;
  } catch { /* URL inválida: sigue la preferencia local. */ }
  if (guardado === "es" || guardado === "en") return guardado;
  return /^es/i.test(String(navegador ?? "")) ? "es" : "en";
}

// Conserva bordes y separadores del original, incluso en registros multilínea.
function conEspacios(original, traducido) {
  const borde = original.match(/^(\s*)[\s\S]*?(\s*)$/u);
  const separadores = [...original.trim().matchAll(/\s+/gu)].map((m) => m[0]);
  let i = 0;
  const centro = traducido.replace(/ /g, () => separadores[i++] ?? " ");
  // Una frase inglesa más corta también debe conservar sus saltos de línea.
  const resto = separadores.slice(i).filter((s) => s !== " ").join("");
  return borde[1] + centro + resto + borde[2];
}

export function crearTraductor(diccionario, idioma = "es") {
  idioma = idioma === "en" ? "en" : "es";
  const frases = new Map(Object.entries(diccionario?.frases ?? {})
    .filter(([, valor]) => typeof valor === "string").map(([clave, valor]) => [normalizar(clave), valor]));
  const patrones = [];
  for (const par of Array.isArray(diccionario?.patrones) ? diccionario.patrones : []) {
    try {
      if (!Array.isArray(par) || typeof par[0] !== "string" || typeof par[1] !== "string") continue;
      if (!par[0].startsWith("^") || !par[0].endsWith("$")) continue;
      patrones.push([new RegExp(par[0], "u"), par[1]]);
    } catch { /* Un patrón roto no impide usar el resto del diccionario. */ }
  }
  const faltantes = new Set(), memoria = new Map();
  function buscar(texto, pila = new Set()) {
    if (frases.has(texto)) return frases.get(texto);
    if (pila.has(texto)) return null;
    const siguientes = new Set(pila).add(texto);
    for (const [regex, plantilla] of patrones) {
      const grupos = regex.exec(texto);
      if (!grupos) continue;
      return plantilla.replace(/\$(\d+)/g, (_, n) => {
        const grupo = grupos[Number(n)] ?? "";
        const traduccion = buscar(normalizar(grupo), siguientes);
        return traduccion === null ? grupo : conEspacios(grupo, traduccion);
      });
    }
    return null;
  }
  function traducir(texto) {
    if (typeof texto !== "string" || idioma === "es" || !texto.trim()) return texto;
    if (memoria.has(texto)) {
      const resultado = memoria.get(texto);
      if (!resultado.encontrado) faltantes.add(normalizar(texto));
      return resultado.texto;
    }
    // Cada línea del registro tiene su propio instante y mensaje.
    if (texto.includes("\n") && /^\s*\[[\d., ]+ s\]/mu.test(texto)) {
      const salida = texto.split("\n").map((linea) => traducir(linea)).join("\n");
      memoria.set(texto, { texto: salida, encontrado: true });
      return salida;
    }
    const clave = normalizar(texto);
    const traduccion = buscar(clave);
    const encontrado = traduccion !== null;
    const salida = encontrado ? conEspacios(texto, traduccion) : texto;
    if (!encontrado) faltantes.add(clave);
    memoria.set(texto, { texto: salida, encontrado });
    return salida;
  }
  return { idioma, locale: idioma === "en" ? "en-US" : "es-UY", t: traducir, faltantes };
}

export function usarTraductor(tr) { activo = typeof tr?.t === "function" ? tr : null; }
export function t(texto) { return activo ? activo.t(texto) : texto; }
// Formato de números y fechas del idioma activo (es-UY si no hay traductor).
export function locale() { return activo?.locale || "es-UY"; }

function excluido(nodo) {
  for (let el = nodo?.nodeType === 1 ? nodo : nodo?.parentNode; el; el = el.parentNode) {
    if (el.nodeType === 1 && (/^(SCRIPT|STYLE|TEXTAREA)$/i.test(el.tagName) || el.hasAttribute("data-no-traducir"))) return true;
  }
  return false;
}

function traducirValor(nodo, clave, valor, escribir, traducir) {
  let registro = originales.get(nodo);
  if (!registro) { registro = new Map(); originales.set(nodo, registro); }
  if (valor === null) { registro.delete(clave); return; }
  let entrada = registro.get(clave);
  // Si la aplicación escribió algo nuevo, ese es el nuevo original.
  if (entrada && valor !== entrada.salida && entrada.salida && valor.startsWith(entrada.salida)) {
    entrada = { original: entrada.original + valor.slice(entrada.salida.length), salida: valor };
  } else if (!entrada || valor !== entrada.salida) entrada = { original: valor, salida: valor };
  const salida = traducir(entrada.original);
  entrada.salida = typeof salida === "string" ? salida : entrada.original;
  registro.set(clave, entrada);
  if (valor !== entrada.salida) escribir(entrada.salida);
}

export function traducirNodo(raiz, traducir = t) {
  if (!raiz || typeof traducir !== "function" || excluido(raiz)) return;
  function visitar(nodo) {
    if (excluido(nodo)) return;
    if (nodo.nodeType === 3) {
      traducirValor(nodo, "texto", nodo.nodeValue, (s) => { nodo.nodeValue = s; }, traducir);
    } else {
      if (nodo.nodeType === 1) for (const nombre of atributos) {
        traducirValor(nodo, nombre, nodo.getAttribute(nombre), (s) => nodo.setAttribute(nombre, s), traducir);
      }
      for (const hijo of Array.from(nodo.childNodes ?? [])) visitar(hijo);
    }
  }
  visitar(raiz);
}

export function observarTraduccion(raiz, traducir = t) {
  const Observador = raiz?.ownerDocument?.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  traducirNodo(raiz, traducir);
  if (!raiz || !Observador) return () => {};
  const opciones = { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: [...atributos, "data-no-traducir"] };
  const observador = new Observador((cambios) => {
    observador.disconnect();
    try {
      const nodos = new Set();
      for (const cambio of cambios) {
        if (cambio.type === "childList") for (const nodo of cambio.addedNodes) nodos.add(nodo);
        else nodos.add(cambio.target);
      }
      for (const nodo of nodos) if (nodo === raiz || raiz.contains(nodo)) traducirNodo(nodo, traducir);
    } finally { observador.observe(raiz, opciones); }
  });
  observador.observe(raiz, opciones);
  return () => observador.disconnect();
}
