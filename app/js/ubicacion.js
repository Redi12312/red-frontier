// Geoubicación de la tripulación y prueba a ciegas con fotos reales de Curiosity.
// La app manda al motor solo el horizonte medido por la cámara; la posición real se lee recién al tocar
// "Revelar", para medir el error.

import { t } from "./idioma.js";
import { solAproximado } from "./horizonte-fotos.js";
import { celdaALonLat } from "./zona.js";
// Carpeta de datos relativa a la app: sirve en localhost y en un subdirectorio (GitHub Pages).
const RAIZ_DATOS = new URL("../../datos", import.meta.url).href;

const API_NASA = "https://mars.nasa.gov/api/v1/raw_image_items/";
const PARADAS_NASA = "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json";
const INSTRUMENTOS = { NLB: "NAV_LEFT_B", NRB: "NAV_RIGHT_B", NLA: "NAV_LEFT_A", NRA: "NAV_RIGHT_A" };

export function crearUbicacion(ctx) {
  const { mapa, estado, $, num, aMapa, lonLatACelda, avisar, leerHttp, RAIZ } = ctx;
  let indice = null, base = null, capas = [], ultimo = null, modo = "parada";
  let workerLocalizador = null, baseWorker = null, secuencia = 0, pedidoActual = null;
  let pedidoFusion = null;
  const tieneFusion = typeof ctx.referencias === "function";
  let configuracionGeo = null, origenGeo = null, resultadoGeo = null, capasGeo = [], posicionGeo = null, verdadGeo = null;
  let referenciasGeo = [], contadorGeo = 0;
  let puntosMedidosGeo = [];
  const subidas = { fotos: [], meta: new Map(), porSol: new Map() };
  // Cálculo en vivo: puntos ya puntuados, mejor provisorio, horizontes y registro de texto.
  const vivo = { puntos: [], extras: null, marca: null, calor: null, medido: null, calculados: [], registro: [], ultimoLog: 0 };
  const lienzoRapido = L.canvas({ padding: 0.2 });

  const icono = (clase, txt) => L.divIcon({ className: "", html: `<div class="marca ${clase}">${txt}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });

  function cancelarLocalizacion() {
    secuencia++;
    pedidoActual = null;
    pedidoFusion = null;
    workerLocalizador?.terminate();
    workerLocalizador = null;
    baseWorker = null;
  }

  function nuevaBusqueda() {
    // Interrumpir un cálculo viejo sí libera enseguida su Worker, incluso durante la búsqueda síncrona.
    if (pedidoActual !== null) cancelarLocalizacion();
    pedidoActual = ++secuencia;
    return pedidoActual;
  }

  function alErrorLocalizacion(mensaje) {
    cancelarLocalizacion();
    $("#ubicar").disabled = false;
    $("#ubicar-subidas").disabled = !subidas.fotos.some((f) => f.foto);
    $("#ubicacion-progreso").hidden = true;
    if (tieneFusion) { $("#geo-calcular").disabled = false; $("#geo-estado").textContent = t(mensaje); }
    avisar(`Error: ${mensaje}`);
  }

  function enviarLocalizacion(datos, pedido, transferibles = []) {
    if (pedido !== pedidoActual) return;
    const raiz = `${RAIZ_DATOS}/${estado.zona.meta.id}`;
    try {
      if (!workerLocalizador || baseWorker !== raiz) {
        workerLocalizador?.terminate();
        const worker = new Worker(new URL("./localizador-worker.js", import.meta.url), { type: "module" });
        workerLocalizador = worker;
        baseWorker = raiz;
        worker.onmessage = ({ data }) => {
          if (worker !== workerLocalizador || data.pedido !== pedidoActual) return;
          if (data.tipo === "localizando") alProgreso(data);
          else if (data.tipo === "evento") alEvento(data);
          else if (data.tipo === "ubicacion") {
            pedidoActual = null;
            alResultado(data);
          } else if (data.tipo === "geoubicacion") {
            pedidoActual = null;
            pedidoFusion = null;
            mostrarGeoubicacion(data.resultado, data.segundos);
          } else if (data.tipo === "error") alErrorLocalizacion(data.mensaje);
        };
        worker.onerror = (error) => {
          if (worker !== workerLocalizador) return;
          error.preventDefault?.();
          alErrorLocalizacion(error.message);
        };
        worker.onmessageerror = () => {
          if (worker === workerLocalizador) alErrorLocalizacion("Error");
        };
        // El servicio espera esta carga antes de atender el pedido que se encola enseguida.
        worker.postMessage({ tipo: "cargar", base: raiz, pedido });
      }
      workerLocalizador.postMessage({ ...datos, pedido }, transferibles);
    } catch (error) {
      alErrorLocalizacion(error.message);
    }
  }

  function limpiarMapa() {
    capas.forEach((c) => c.remove());
    capas = [];
    limpiarVivo();
    document.querySelector("#mapa").classList.remove("modo-ubicacion");
  }

  function limpiarVivo() {
    vivo.extras?.remove(); vivo.marca?.remove(); vivo.calor?.remove();
    Object.assign(vivo, { puntos: [], extras: null, marca: null, calor: null, medido: null, calculados: [] });
  }

  // ---------- Registro ----------
  function registrar(t, texto) {
    const linea = `[${t.toFixed(1).padStart(6)} s] ${texto}`;
    vivo.registro.push(linea);
    const pre = $("#registro");
    // Un nodo por línea: el traductor conserva cada original y no vuelve a traducir los prefijos completos.
    pre.append(document.createTextNode((vivo.registro.length > 1 ? "\n" : "") + linea));
    pre.scrollTop = pre.scrollHeight;
  }

  function empezarRegistro(titulo) {
    vivo.registro = [];
    $("#registro").textContent = "";
    $("#bajar-registro").disabled = false;
    $("#seccion-calculo").hidden = false;
    registrar(0, titulo);
  }

  const latLon = (x, y) => {
    const k = (estado.zona.meta.proyeccion.radio_m * Math.PI) / 180;
    return `${num(Math.abs(y / k), 5)}° S, ${num(x / k, 5)}° E`;
  };

  // Eventos del motor (worker) mientras calcula.
  function alEvento({ evento, t, datos }) {
    if (evento === "inicio_fotos") registrar(t, `Procesando ${datos.fotos} fotos: se busca en cada una la línea cielo/terreno…`);
    else if (evento === "foto") alFoto(t, datos);
    else if (evento === "medido") {
      vivo.medido = datos;
      registrar(t, `Horizonte medido: ${datos.conDato} de ${datos.total} intervalos de 0,25° con dato (${num((100 * datos.conDato) / datos.total)} % de los 360°).`);
      dibujarVivo();
    } else if (evento === "parametros") {
      registrar(t, `Parámetros: zona ${datos.zona} (${num(datos.km2)} km²); relieve cercano ${datos.relieveCercano}; relieve lejano ${datos.relieveLejano}, `
        + `sesgo vertical corregido ${num(datos.sesgo, 1)} m; cámara a ${num(datos.alturaCamara, 1)} m del suelo; curvatura con R = ${num(datos.radio / 1000)} km.`);
    } else if (evento === "etapa") registrar(t, `Etapa ${datos.nombre}: ${datos.detalle}${datos.total ? ` (${num(datos.total)} lugares)` : ""}.`);
    else if (evento === "lote") alLote(t, datos);
    else if (evento === "mejor") {
      registrar(t, `→ Mejor de la etapa ${datos.etapa}: ${latLon(datos.x, datos.y)}, diferencia media ${num(datos.s, 3)}° `
        + `(${num(datos.candidatos)} candidatos${datos.giro ? `, ajuste de rumbo ${num(datos.giro, 1)}°` : ""}).`);
      if (datos.top) datos.top.forEach((c, i) => registrar(t, `   ${i + 1}. ${latLon(c.x, c.y)} · ${num(c.s, 3)}°`));
      moverMejor(datos);
    } else if (evento === "horizonte_mejor") {
      vivo.calculados.push(datos);
      dibujarVivo();
    } else if (evento === "fin") registrar(t, `Fin: ${num(datos.candidatos)} candidatos evaluados en ${num(datos.segundos, 1)} s.`);
  }

  function alFoto(t, d) {
    const zona = d.azMin === null ? "" : `; azimut ${num(d.azMin)}°–${num(d.azMax)}°, horizonte mediano ${num(d.elMediana, 2)}°`;
    registrar(t, `Foto ${d.k + 1} ${d.imageid.slice(0, 16)}…: ${d.motivo}${zona}.`);
    // Puntos del horizonte de esta foto en el gráfico, a medida que llegan.
    vivo.medidoParcial = (vivo.medidoParcial || []).concat(d.puntos);
    dibujarVivo();
    dibujarLineaFoto(d);
  }

  function alLote(t, d) {
    vivo.puntos.push(...d.puntos.map((p) => [...p, d.etapa]));
    if (d.etapa === "gruesa") {
      vivo.calor?.remove();
      vivo.calor = mapaCoincidencia({ mapa: vivo.puntos.filter((p) => p[3] === "gruesa") });
    } else {
      if (!vivo.extras) vivo.extras = L.layerGroup().addTo(mapa);
      const color = d.etapa === "media" ? "#58a6ff" : "#ffffff";
      for (const [x, y] of d.puntos) {
        const c = celdaDeXY(x, y);
        L.circleMarker(aMapa(c.f, c.c), { renderer: lienzoRapido, radius: d.etapa === "media" ? 2 : 2.5, color, weight: 1, fillOpacity: 0.6, interactive: false }).addTo(vivo.extras);
      }
    }
    if (d.mejor) moverMejor(d.mejor);
    if (t - vivo.ultimoLog > 3) {
      vivo.ultimoLog = t;
      registrar(t, `  ${d.etapa}: ${num(vivo.puntos.length)} candidatos puntuados; mejor provisorio ${latLon(d.mejor.x, d.mejor.y)} (${num(d.mejor.s, 3)}°)`);
    }
  }

  function moverMejor(m) {
    const c = celdaDeXY(m.x, m.y);
    if (!vivo.marca) {
      vivo.marca = L.marker(aMapa(c.f, c.c), { icon: icono("provisoria", "✕"), title: "Mejor candidato provisorio", interactive: false }).addTo(mapa);
    } else vivo.marca.setLatLng(aMapa(c.f, c.c));
  }

  // Gráfico en vivo: puntos medidos y horizonte calculado en el mejor candidato de cada etapa.
  function dibujarVivo() {
    const lienzo = $("#perfil-horizonte");
    lienzo.hidden = false;
    const dpr = window.devicePixelRatio || 1;
    const w = lienzo.clientWidth, h = lienzo.clientHeight;
    lienzo.width = w * dpr; lienzo.height = h * dpr;
    const g = lienzo.getContext("2d");
    g.scale(dpr, dpr);
    const medidos = vivo.medido ? vivo.medido.az.map((a, i) => [a, vivo.medido.el[i]]).filter((p) => p[1] !== null) : (vivo.medidoParcial || []);
    const calcs = vivo.calculados;
    const todos = [...medidos.map((p) => p[1]), ...calcs.flatMap((c) => c.calculado)];
    if (!todos.length) return;
    const yMin = Math.floor(Math.min(...todos)) - 1, yMax = Math.ceil(Math.max(...todos)) + 1;
    const m = { i: 26, d: 6, a: 6, b: 16 };
    const X = (v) => m.i + (v / 360) * (w - m.i - m.d);
    const Y = (v) => h - m.b - ((v - yMin) / (yMax - yMin)) * (h - m.a - m.b);
    g.font = "10px monospace"; g.fillStyle = "#8b95a1";
    ["N", "E", "S", t("O"), "N"].forEach((tx, k) => g.fillText(tx, X(k * 90) - 3, h - 4));
    g.fillText(`${yMax}°`, 0, m.a + 8); g.fillText(`${yMin}°`, 0, h - m.b);
    const colores = { gruesa: "rgba(247,79,37,.35)", media: "rgba(88,166,255,.7)", fina: "#f74f25" };
    const az = vivo.medido?.az || [];
    for (const c of calcs) {
      g.strokeStyle = colores[c.etapa] || "#f74f25"; g.lineWidth = c.etapa === "fina" ? 1.6 : 1; g.beginPath();
      c.calculado.forEach((v, k) => (k ? g.lineTo(X(az[k]), Y(v)) : g.moveTo(X(az[k]), Y(v))));
      g.stroke();
    }
    g.fillStyle = "#e8edf2";
    medidos.forEach(([a, v], k) => { if (k % 2 === 0) g.fillRect(X(a) - 0.5, Y(v) - 0.5, 1.5, 1.5); });
    g.fillStyle = "#8b95a1";
    g.fillText(t("· medido   — calculado en el mejor (gruesa, media, fina)"), m.i, m.a + 8);
  }

  function bajarRegistro() {
    const blob = new Blob([vivo.registro.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `registro-ubicacion-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function abrirZona(idZona) {
    cancelarLocalizacion();
    const apertura = secuencia;
    limpiarMapa();
    ultimo = null;
    const zonaAbierta = estado.zona;
    base = `${RAIZ}/datos/${idZona}/localizacion`;
    try {
      const nuevoIndice = await leerHttp(`${base}/indice.json`, "json");
      if (apertura !== secuencia) return;
      indice = nuevoIndice;
    } catch {
      if (apertura !== secuencia) return;
      indice = null;
    }
    $("#seccion-ubicacion").hidden = !tieneFusion && (!indice || !indice.paradas.length);
    if (tieneFusion) {
      $("#geo-horizonte").hidden = !indice?.paradas?.length;
      $("#geo-validacion").textContent = t(indice?.paradas?.length
        ? "Las fotos de Curiosity son una prueba a ciegas con respuesta conocida. Revelá la posición después de estimarla."
        : "La geoubicación usa terreno real y lecturas ingresadas a mano. El resultado es modelado y las precisiones son propuestas a calibrar.");
      iniciarFusion().catch((error) => { if (apertura === secuencia) $("#geo-estado").textContent = t(error.message); });
      leerHttp(`${base}/resumen.json`, "json").then((r) => {
        if (estado.zona !== zonaAbierta || !r.estadistica) return;
        $("#geo-validacion").textContent = t("Prueba a ciegas con Curiosity. Error mediano de $1 m en $2 paradas. $3 quedaron dentro del intervalo declarado. El 95 % del modelo sigue a calibrar.")
          .replace("$1", num(r.estadistica.mediana_m, 1)).replace("$2", num(r.estadistica.n)).replace("$3", num(r.estadistica.dentro_de_incertidumbre));
      }).catch(() => {});
    }
    if (!indice?.paradas?.length) return;
    const sel = $("#parada");
    sel.innerHTML = "";
    for (const p of indice.paradas) sel.append(new Option(`Sitio ${p.sitio}, tramo ${p.tramo} · soles ${p.soles[0]}–${p.soles[1]} · ${p.fotos} fotos`, p.id));
    sel.onchange = () => mostrarParada(sel.value);
    await mostrarParada(indice.paradas[0].id);
  }

  async function mostrarParada(id) {
    cancelarLocalizacion();
    const seleccion = secuencia;
    limpiarMapa();
    ultimo = null;
    if (tieneFusion) invalidarGeo();
    $("#ubicacion-resultado").innerHTML = "";
    $("#perfil-horizonte").hidden = true;
    $("#revelar").disabled = true;
    $("#ubicar").disabled = false;
    const fotos = await leerHttp(`${base}/${id}/fotos.json`, "json");
    if (seleccion !== secuencia) return;
    const tira = $("#fotos-parada");
    tira.innerHTML = "";
    for (const f of fotos) {
      const fig = document.createElement("figure");
      fig.innerHTML = `<img src="${base}/${id}/${f.archivo}" alt="Foto Navcam de Curiosity, azimut ${num(f.azimut)}°, sol ${f.sol}" loading="lazy">
        <figcaption>${num(f.azimut)}°</figcaption>`;
      fig.querySelector("img").addEventListener("click", () => ampliar(`${base}/${id}/${f.archivo}`, f));
      tira.append(fig);
    }
  }

  function ampliar(src, f) {
    const capa = document.createElement("div");
    capa.className = "foto-grande";
    capa.innerHTML = `<div><img src="${src}" alt=""><p>Navcam de Curiosity · sol ${f.sol} · ${f.hora_local} · azimut ${num(f.azimut)}° · ${f.credito}</p></div>`;
    capa.addEventListener("click", () => capa.remove());
    document.body.append(capa);
  }

  function ubicar() {
    modo = "parada";
    ultimo = null;
    if (tieneFusion) invalidarGeo();
    const pedido = nuevaBusqueda();
    const id = $("#parada").value;
    limpiarMapa();
    $("#ubicacion-resultado").innerHTML = "";
    $("#ubicar").disabled = true;
    $("#revelar").disabled = true;
    $("#ubicacion-progreso").hidden = false;
    alProgreso({ fraccion: 0, texto: "Preparando el relieve" });
    document.querySelector("#mapa").classList.add("modo-ubicacion");
    empezarRegistro(`Ubicación a ciegas · parada guardada ${id}. El horizonte de estas fotos lo midió antes el pipeline (mismo algoritmo); la posición real no se usa.`);
    avisar("Buscando a ciegas en toda la zona el punto cuyo horizonte coincide con el de las fotos…");
    enviarLocalizacion({
      tipo: "localizar", parada: id, medidoUrl: `${RAIZ_DATOS}/${estado.zona.meta.id}/localizacion/${id}/medido.json`,
      raizDatos: `${RAIZ_DATOS}`, relieveLejano: indice.relieve_lejano, sesgo: indice.sesgo_vertical_m,
      alturaCamara: indice.altura_camara_m,
    }, pedido);
  }

  function alProgreso({ fraccion, texto }) {
    const barra = $("#ubicacion-progreso");
    barra.querySelector("i").style.width = `${Math.round(fraccion * 100)}%`;
    barra.querySelector("span").textContent = `${texto} · ${Math.round(fraccion * 100)} %`;
  }

  function celdaDeXY(x, y) {
    const [a, , x0, , e, y0] = estado.zona.meta.grilla.transform;
    return { f: (y - y0) / e - 0.5, c: (x - x0) / a - 0.5 };
  }

  function alResultado(r) {
    $("#ubicacion-progreso").hidden = true;
    $("#ubicar").disabled = false;
    $("#ubicar-subidas").disabled = !subidas.fotos.some((f) => f.foto);
    $("#revelar").disabled = false;
    ultimo = r;
    if (tieneFusion) { $("#geo-incluir-horizonte").disabled = false; $("#geo-incluir-horizonte").checked = true; }
    vivo.marca?.remove(); vivo.marca = null;
    vivo.calor?.remove(); vivo.calor = null;
    registrar(vivo.registro.length ? Number(vivo.registro.at(-1).slice(1, 7)) : 0,
      `RESULTADO: ${latLon(r.x, r.y)} ± ${num(r.incertidumbre)} m (95 %); diferencia media ${num(r.puntaje, 3)}°; mejor lugar a más de 500 m: ${r.segundoLejano === null ? "—" : num(r.segundoLejano, 3) + "°"}.`);
    const z = estado.zona;
    const k = (z.meta.proyeccion.radio_m * Math.PI) / 180;
    const lat = r.y / k, lon = r.x / k;
    const c = celdaDeXY(r.x, r.y);
    if (tieneFusion) {
      resultadoGeo = { mejor: { ...c }, error_m: r.incertidumbre };
      $("#geo-usar").disabled = false;
    }
    capas.push(mapaCoincidencia(r));
    const circulo = L.circle(aMapa(c.f, c.c), { radius: r.incertidumbre / z.paso, color: "#f74f25", weight: 2, fillOpacity: 0.12 }).addTo(mapa);
    const marca = L.marker(aMapa(c.f, c.c), { icon: icono("estimacion", "✕"), title: "Estimación a ciegas" }).addTo(mapa);
    capas.push(circulo, marca);
    mapa.flyTo(aMapa(c.f, c.c), Math.max(mapa.getZoom(), 0), { duration: 0.8 });
    const unico = r.segundoLejano !== null
      ? `${num(r.segundoLejano, 2)}° contra ${num(r.puntaje, 2)}°: ${r.segundoLejano - r.puntaje > 0.3 ? "resultado único" : "ojo: hay otro lugar parecido"}`
      : "—";
    $("#ubicacion-resultado").innerHTML = `<dl class="dato-ubicacion">
        <dt>Estimación</dt><dd>${num(Math.abs(lat), 5)}° ${lat < 0 ? "S" : "N"}, ${num(lon, 5)}° E</dd>
        <dt>Incertidumbre</dt><dd>± ${num(r.incertidumbre)} m (95 %)</dd>
        <dt>Coincidencia</dt><dd>${num(r.puntaje, 2)}° de diferencia media</dd>
        <dt>Mejor lugar lejano</dt><dd>${unico}</dd>
        <dt>Búsqueda</dt><dd>${num(r.candidatos)} candidatos en ${num((z.ancho * z.alto * z.paso * z.paso) / 1e6)} km²</dd>
      </dl>`;
    dibujarVivo();
    avisar(`Ubicación estimada a ciegas: ± ${num(r.incertidumbre)} m. Tocá «Revelar posición real» para medir el error.`);
  }

  // Mapa de coincidencia de la búsqueda gruesa: más claro = el horizonte se parece más.
  function mapaCoincidencia(r) {
    const z = estado.zona;
    const fe = Math.cos(((z.meta.limites.lat_sur + z.meta.limites.lat_norte) / 2) * Math.PI / 180);
    const xs = r.mapa.map((p) => p[0]), ys = r.mapa.map((p) => p[1]), ss = r.mapa.map((p) => p[2]);
    const pasoX = 100 / fe, pasoY = 100;
    const xMin = Math.min(...xs), yMax = Math.max(...ys);
    const ancho = Math.round((Math.max(...xs) - xMin) / pasoX) + 1, alto = Math.round((yMax - Math.min(...ys)) / pasoY) + 1;
    const orden = [...ss].sort((a, b) => a - b);
    const bajo = orden[Math.floor(orden.length * 0.01)], alto60 = orden[Math.floor(orden.length * 0.6)];
    const lienzo = document.createElement("canvas");
    lienzo.width = ancho; lienzo.height = alto;
    const g = lienzo.getContext("2d");
    const img = g.createImageData(ancho, alto);
    r.mapa.forEach(([x, y, s]) => {
      const c = Math.round((x - xMin) / pasoX), f = Math.round((yMax - y) / pasoY);
      const t = Math.max(0, Math.min(1, (alto60 - s) / (alto60 - bajo)));
      const i = (f * ancho + c) * 4;
      img.data[i] = 255; img.data[i + 1] = 80 + 170 * t; img.data[i + 2] = 40 * t; img.data[i + 3] = Math.round(200 * t * t);
    });
    g.putImageData(img, 0, 0);
    const a = celdaDeXY(xMin - pasoX / 2, yMax + pasoY / 2), b = celdaDeXY(xMin + (ancho - 0.5) * pasoX, yMax - (alto - 0.5) * pasoY);
    return L.imageOverlay(lienzo.toDataURL(), [aMapa(b.f, a.c), aMapa(a.f, b.c)], { opacity: 0.85 }).addTo(mapa);
  }

  async function revelar() {
    if (!ultimo) return;
    let res;
    if (modo === "subidas") {
      res = await verdadDesdeNasa();
      if (!res) return;
    } else {
      res = await leerHttp(`${base}/${$("#parada").value}/resultado.json`, "json");
    }
    const z = estado.zona, meta = z.meta;
    const mov = meta.capas.curiosity?.corrimiento_m || { este: 0, norte: 0 };
    const [a, , , , e] = meta.grilla.transform;
    const v = lonLatACelda(meta, res.verdad.lon_este, res.verdad.lat);
    const fV = v.f + mov.norte / e, cV = v.c + mov.este / a;
    const est = celdaDeXY(ultimo.x, ultimo.y);
    const error = Math.hypot(fV - est.f, cV - est.c) * z.paso;
    verdadGeo = { f: fV, c: cV };
    if (resultadoGeo) mostrarErrorReal();
    const marca = L.marker(aMapa(fV, cV), { icon: icono("verdad", "+"), title: "Posición real de Curiosity" }).addTo(mapa);
    const linea = L.polyline([aMapa(est.f, est.c), aMapa(fV, cV)], { color: "#fff", weight: 1.5, dashArray: "4 4" }).addTo(mapa);
    capas.push(marca, linea);
    let resumen = "";
    try {
      const r = await leerHttp(`${base}/resumen.json`, "json");
      resumen = `<p class="ayuda">${t("Prueba a ciegas con Curiosity. Error mediano de $1 m en $2 paradas. $3 quedaron dentro del intervalo declarado. El 95 % del modelo sigue a calibrar.")
        .replace("$1", num(r.estadistica.mediana_m, 1)).replace("$2", num(r.estadistica.n)).replace("$3", num(r.estadistica.dentro_de_incertidumbre))}</p>`;
    } catch { /* sin resumen todavía */ }
    $("#ubicacion-resultado").insertAdjacentHTML("beforeend", `<dl class="dato-ubicacion">
        <dt>Posición real</dt><dd>${num(Math.abs(res.verdad.lat), 5)}° S, ${num(res.verdad.lon_este, 5)}° E (${res.verdad.fuente || "NASA/JPL, corregida"})</dd>
        <dt>Error</dt><dd><b>${num(error, 1)} m</b> ${error <= ultimo.incertidumbre ? "(dentro de la incertidumbre)" : "(fuera de la incertidumbre declarada)"}</dd>
      </dl>${resumen}`);
    $("#revelar").disabled = true;
    registrar(Number(vivo.registro.at(-1)?.slice(1, 7) || 0), `REVELADO: posición real ${num(Math.abs(res.verdad.lat), 5)}° S, ${num(res.verdad.lon_este, 5)}° E (${res.verdad.fuente || "NASA/JPL"}); error ${num(error, 1)} m.`);
    avisar(`Error de la ubicación a ciegas: ${num(error, 1)} m.`);
  }

  function dibujarHorizonte(r) {
    const lienzo = $("#perfil-horizonte");
    lienzo.hidden = false;
    const dpr = window.devicePixelRatio || 1;
    const w = lienzo.clientWidth, h = lienzo.clientHeight;
    lienzo.width = w * dpr; lienzo.height = h * dpr;
    const g = lienzo.getContext("2d");
    g.scale(dpr, dpr);
    const az = r.medido.az, med = r.medido.el, cal = r.calculado;
    const todos = [...med.filter(Number.isFinite), ...cal];
    const yMin = Math.floor(Math.min(...todos)) - 1, yMax = Math.ceil(Math.max(...todos)) + 1;
    const m = { i: 26, d: 6, a: 6, b: 16 };
    const X = (v) => m.i + (v / 360) * (w - m.i - m.d);
    const Y = (v) => h - m.b - ((v - yMin) / (yMax - yMin)) * (h - m.a - m.b);
    g.font = "10px monospace"; g.fillStyle = "#8b95a1";
    ["N", "E", "S", t("O"), "N"].forEach((tx, k) => g.fillText(tx, X(k * 90) - 3, h - 4));
    g.fillText(`${yMax}°`, 0, m.a + 8); g.fillText(`${yMin}°`, 0, h - m.b);
    g.strokeStyle = "#f74f25"; g.lineWidth = 1.5; g.beginPath();
    cal.forEach((v, k) => (k ? g.lineTo(X(az[k]), Y(v)) : g.moveTo(X(az[k]), Y(v))));
    g.stroke();
    g.fillStyle = "#e8edf2";
    med.forEach((v, k) => { if (Number.isFinite(v) && k % 2 === 0) g.fillRect(X(az[k]) - 0.5, Y(v) - 0.5, 1.5, 1.5); });
    g.fillStyle = "#8b95a1";
    g.fillText(t("· medido en las fotos   — calculado en la estimación"), m.i, m.a + 8);
  }

  // ---------- Fotos subidas por el usuario ----------
  async function alElegirArchivos(archivos) {
    subidas.fotos = [];
    for (const a of archivos) {
      if (/\.json$/i.test(a.name)) {
        try {
          const d = JSON.parse(await a.text());
          for (const it of Array.isArray(d) ? d : d.items || d.fotos || []) if (it.imageid) subidas.meta.set(it.imageid, { ...it, _origen: "archivo" });
        } catch { avisar(`No se pudo leer ${a.name} como JSON.`); }
      }
    }
    for (const a of archivos) {
      if (!/\.(jpe?g|png)$/i.test(a.name)) continue;
      subidas.fotos.push({ archivo: a, imageid: a.name.replace(/\.[^.]+$/, ""), foto: null, origen: null });
    }
    dibujarSubidas();
    for (const f of subidas.fotos) {
      f.foto = subidas.meta.get(f.imageid) || null;
      f.origen = f.foto ? f.foto._origen : null;
      if (!f.foto) {
        f.origen = "buscando";
        dibujarSubidas();
        f.foto = await metadatosDeNasa(f.imageid);
        f.origen = f.foto ? "NASA" : "sin datos";
      }
      dibujarSubidas();
    }
    const listas = subidas.fotos.filter((f) => f.foto);
    $("#ubicar-subidas").disabled = !listas.length;
    const paradas = new Set(listas.map((f) => `${f.foto.site}/${f.foto.drive}`));
    avisar(`${listas.length} de ${subidas.fotos.length} fotos con metadatos${paradas.size > 1 ? ` · ojo: son de ${paradas.size} paradas distintas` : ""}.`);
  }

  // Busca los metadatos de una foto en la API pública de NASA: el nombre trae el reloj de la nave,
  // de ahí sale el sol aproximado, y se revisan las fotos de ese sol y los vecinos.
  async function metadatosDeNasa(imageid) {
    const sol = solAproximado(imageid), inst = INSTRUMENTOS[imageid.slice(0, 3)];
    if (sol === null || !inst) return null;
    for (const s of [sol, sol - 1, sol + 1]) {
      const clave = `${inst}/${s}`;
      if (!subidas.porSol.has(clave)) {
        const items = [];
        try {
          for (let pag = 0; pag < 20; pag++) {
            const url = `${API_NASA}?order=sol%20asc&per_page=100&page=${pag}&condition_1=msl:mission&condition_2=${inst}:instrument`
              + `&condition_3=${s}:sol:gte&condition_4=${s}:sol:lte&extended=thumbnail::sample_type::noteq`;
            const d = await (await fetch(url)).json();
            items.push(...d.items);
            if (!d.more) break;
          }
        } catch { return null; }
        subidas.porSol.set(clave, items);
        for (const it of items) if (!subidas.meta.has(it.imageid)) subidas.meta.set(it.imageid, { ...it, _origen: "NASA" });
      }
      if (subidas.meta.has(imageid)) return subidas.meta.get(imageid);
    }
    return null;
  }

  function dibujarSubidas() {
    const ul = $("#fotos-subidas");
    ul.innerHTML = "";
    subidas.fotos.forEach((f, k) => {
      const li = document.createElement("li");
      const estadoTxt = f.foto ? `<span class="ok">✔ metadatos (${f.origen})</span> sitio ${f.foto.site}, tramo ${f.foto.drive}`
        : f.origen === "buscando" ? "buscando metadatos en NASA…" : f.origen === "sin datos" ? '<span class="falla">✖ sin metadatos</span>' : "…";
      li.innerHTML = `<canvas data-k="${k}" width="1" height="1" hidden></canvas><span>${f.imageid.slice(0, 16)}… ${estadoTxt}</span>`;
      ul.append(li);
    });
  }

  async function grises(archivo) {
    const bmp = await createImageBitmap(archivo);
    const lienzo = document.createElement("canvas");
    lienzo.width = bmp.width; lienzo.height = bmp.height;
    const g = lienzo.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const gris = new Float32Array(bmp.width * bmp.height);
    // Misma fórmula de luminancia que PIL (ITU-R 601), redondeada a entero como en el pipeline.
    for (let i = 0; i < gris.length; i++) gris[i] = Math.floor((d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000 + 0.5);
    return { gris, ancho: bmp.width, alto: bmp.height };
  }

  async function ubicarSubidas() {
    modo = "subidas";
    ultimo = null;
    if (tieneFusion) invalidarGeo();
    const pedido = nuevaBusqueda();
    const listas = subidas.fotos.filter((f) => f.foto);
    limpiarMapa();
    $("#ubicacion-resultado").innerHTML = "";
    $("#ubicar").disabled = $("#ubicar-subidas").disabled = $("#revelar").disabled = true;
    $("#ubicacion-progreso").hidden = false;
    alProgreso({ fraccion: 0, texto: "Leyendo las fotos" });
    document.querySelector("#mapa").classList.add("modo-ubicacion");
    empezarRegistro(`Ubicación a ciegas con ${listas.length} fotos subidas (metadatos: ${[...new Set(listas.map((f) => f.origen))].join(" y ")}). La posición real no se usa.`);
    const fotos = [];
    try {
      for (const f of listas) {
        fotos.push({ foto: f.foto, ...(await grises(f.archivo)) });
        if (pedido !== pedidoActual) return;
      }
    } catch (error) {
      if (pedido === pedidoActual) alErrorLocalizacion(error.message);
      return;
    }
    subidas.enviadas = listas;
    avisar("Extrayendo el horizonte de tus fotos y buscando a ciegas en toda la zona…");
    enviarLocalizacion({
      tipo: "localizar_fotos", parada: "subidas", fotos, raizDatos: `${RAIZ_DATOS}`,
      relieveLejano: indice.relieve_lejano, sesgo: indice.sesgo_vertical_m, alturaCamara: indice.altura_camara_m,
    }, pedido, fotos.map((f) => f.gris.buffer));
  }

  // Dibuja en miniatura una foto subida con la línea que encontró el motor, apenas termina de procesarla.
  async function dibujarLineaFoto(d) {
    const f = subidas.enviadas?.[d.k];
    if (!f) return;
    const li = [...$("#fotos-subidas").children][subidas.fotos.indexOf(f)];
    const lienzo = li?.querySelector("canvas");
    if (!lienzo) return;
    const bmp = await createImageBitmap(f.archivo);
    const esc = 48 / bmp.height;
    lienzo.width = Math.round(bmp.width * esc); lienzo.height = 48; lienzo.hidden = false;
    const g = lienzo.getContext("2d");
    g.drawImage(bmp, 0, 0, lienzo.width, lienzo.height);
    g.lineWidth = 1.2;
    for (let c = 1; c < d.fila.length; c++) {
      g.strokeStyle = d.valida[c] ? "#e52918" : "rgba(160,160,160,.7)";
      g.beginPath(); g.moveTo((c - 1) * esc, d.fila[c - 1] * esc); g.lineTo(c * esc, d.fila[c] * esc); g.stroke();
    }
    lienzo.title = d.motivo;
    lienzo.onclick = () => ampliarConLinea(f.archivo, d);
    const span = li.querySelector("span");
    if (!d.usadas) span.insertAdjacentHTML("beforeend", ` · <span class="falla">${d.motivo}</span>`);
    else span.insertAdjacentHTML("beforeend", ` · <span class="ok">${d.usadas} columnas usadas</span>`);
  }

  // Foto grande con la línea detectada, para revisarla columna por columna.
  async function ampliarConLinea(archivo, d) {
    const bmp = await createImageBitmap(archivo);
    const lienzo = document.createElement("canvas");
    lienzo.width = bmp.width; lienzo.height = bmp.height;
    const g = lienzo.getContext("2d");
    g.drawImage(bmp, 0, 0);
    g.lineWidth = 2;
    for (let c = 1; c < d.fila.length; c++) {
      g.strokeStyle = d.valida[c] ? "#e52918" : "rgba(160,160,160,.8)";
      g.beginPath(); g.moveTo(c - 1, d.fila[c - 1]); g.lineTo(c, d.fila[c]); g.stroke();
    }
    const capa = document.createElement("div");
    capa.className = "foto-grande";
    capa.innerHTML = `<div><img alt=""><p>${d.imageid} · ${d.motivo}. Rojo: línea usada · gris: descartada (sin cielo liso arriba o poco contraste).</p></div>`;
    capa.querySelector("img").src = lienzo.toDataURL("image/jpeg", 0.9);
    capa.addEventListener("click", () => capa.remove());
    document.body.append(capa);
  }

  // (Se mantiene por compatibilidad: ya no se usa, las líneas se dibujan en vivo.)
  async function dibujarLineasSubidas(lineas) {
    for (let k = 0; k < lineas.length; k++) {
      const f = subidas.enviadas[k];
      const li = [...$("#fotos-subidas").children][subidas.fotos.indexOf(f)];
      const lienzo = li?.querySelector("canvas");
      if (!lienzo) continue;
      const bmp = await createImageBitmap(f.archivo);
      const esc = 34 / bmp.height;
      lienzo.width = Math.round(bmp.width * esc); lienzo.height = 34; lienzo.hidden = false;
      const g = lienzo.getContext("2d");
      g.drawImage(bmp, 0, 0, lienzo.width, lienzo.height);
      g.strokeStyle = lineas[k].usadas ? "#e52918" : "#666";
      g.lineWidth = 1;
      g.beginPath();
      lineas[k].fila.forEach((fila, c) => { if (lineas[k].valida[c]) g.lineTo(c * esc, fila * esc); else g.moveTo(c * esc, fila * esc); });
      g.stroke();
      if (!lineas[k].usadas) li.querySelector("span").insertAdjacentHTML("beforeend", " · sin cielo: no usada");
    }
  }

  // La posición real de las fotos subidas se pide a NASA (recorrido publicado de Curiosity).
  async function verdadDesdeNasa() {
    const f = subidas.enviadas?.[0]?.foto;
    if (!f) return null;
    try {
      const paradas = await (await fetch(PARADAS_NASA)).json();
      const p = paradas.features.find((x) => x.properties.site === Number(f.site) && x.properties.drive === Number(f.drive));
      if (!p) { avisar("NASA no publica la posición de esa parada."); return null; }
      return { verdad: { lon_este: p.geometry.coordinates[0], lat: p.geometry.coordinates[1], fuente: `NASA/JPL MMGIS, sitio ${f.site}, tramo ${f.drive}, corregida al marco del DTM` } };
    } catch {
      avisar("Sin internet no se puede pedir la posición real a NASA: compará con el archivo de la verdad que vino con las fotos.");
      return null;
    }
  }

  $("#subir-fotos").addEventListener("change", (e) => alElegirArchivos([...e.target.files]));
  $("#bajar-registro").addEventListener("click", bajarRegistro);
  $("#ubicar-subidas").addEventListener("click", ubicarSubidas);
  $("#ubicar").addEventListener("click", ubicar);
  $("#revelar").addEventListener("click", revelar);
  // ---------- Medidas de la tripulación ----------
  const nombresGeo = { horizonte: "Horizonte", barometro: "Barómetro", pasos: "Pasos", sol: "Sol", radio: "Radio",
    odometria: "Odometría del rover", reseccion: "Resección", uwb: "Baliza UWB", doppler: "Doppler orbital", estrellas: "Estrellas" };
  const coloresGeo = ["#f74f25", "#58a6ff", "#e5bd58", "#d083f0", "#56d9b4", "#f085b7", "#a6cc65", "#cc9a70", "#829fff", "#eeee88"];
  function textoGeo(clave, ...valores) {
    return valores.reduce((s, v, i) => s.replace(`$${i + 1}`, v), t(clave));
  }
  function campoGeo(nombre, etiqueta, valor = "", tipo = "number") {
    return `<label>${t(etiqueta)}<input name="${nombre}" type="${tipo}" step="any" value="${valor}"></label>`;
  }
  const selectorGeo = (nombre, etiqueta) => `<label>${t(etiqueta)}<select name="${nombre}" data-geo-base><option value="">${t("Elegí una base del plan")}</option></select></label>`;
  function detalleGeo(tipo, instrumento, campos) {
    return `<details class="geo-instrumento" data-geo-tipo="${tipo}"><summary>${t(nombresGeo[tipo])}</summary>
      <label class="geo-activar"><input type="checkbox" name="${tipo}">${t("Sumar esta medida")}</label><p class="ayuda">${instrumento}</p>${campos}</details>`;
  }
  async function iniciarFusion() {
    const zonaAbierta = estado.zona;
    if (!configuracionGeo) {
      const [cfg, barometro, expedicion] = await Promise.all(["geoubicacion", "barometro", "expedicion"].map((n) => leerHttp(`${RAIZ}/config/${n}.json`, "json")));
      configuracionGeo = { cfg, barometro, expedicion };
    }
    if (!estado.zona || estado.zona !== zonaAbierta || estado.vista === "marte") return;
    const { cfg: g, barometro: b, expedicion: e } = configuracionGeo;
    const sigma = (nombre, etiqueta) => campoGeo(nombre, etiqueta, g[nombre].valor);
    const absoluto = (tipo) => detalleGeo(tipo,
      textoGeo(tipo === "doppler" ? "Solución externa de radio UHF con un orbitador. Error típico por eje de $1 m, propuesta a calibrar. Cargá una posición ya resuelta con su error." : "Rastreador estelar con reloj y vertical local. Error típico por eje de $1 m, propuesta a calibrar. Un minuto de arco equivale a unos 988 m en Marte. Control grueso de posición.", num(g[`sigma_${tipo}_m`].valor)),
      campoGeo(`${tipo}_lat`, "Latitud planetocéntrica (°)") + campoGeo(`${tipo}_lon`, "Longitud este (°)") + campoGeo(`${tipo}_sigma`, "Error por eje (m, 1 sigma)", g[`sigma_${tipo}_m`].valor));
    const form = document.createElement("form"); form.id = "geo-form";
    form.innerHTML = `<label class="geo-activar"><input type="checkbox" id="geo-incluir-horizonte" disabled>${t("Incluir el horizonte calculado")}</label>
      <p class="ayuda">${t("El horizonte se aproxima como una distribución circular local. Si hay otro lugar parecido, revisá la ambigüedad antes de combinar.")}</p>
      <label>${t("Último punto conocido")}<select id="geo-origen" name="geo-origen" data-geo-base><option value="">${t("Elegí una base o hacé clic derecho en el mapa")}</option></select></label>
      <p class="ayuda" id="geo-origen-texto"></p>
      ${detalleGeo("barometro", textoGeo("Sensores de presión exterior simultáneos en traje y hábitat. Ruido diferencial típico de $1 Pa, propuesta a calibrar. La presión interna del traje no sirve para medir altura.", num(b.sigma_presion_diferencial_pa.valor)),
        `<p class="ayuda">${t("La presión y la temperatura iniciales son ejemplos editables. Cargá tus mediciones simultáneas.")}</p>` +
        selectorGeo("baro_base", "Hábitat de referencia") + campoGeo("pBase", "Presión exterior en el hábitat (Pa)", g.presion_inicial_pa.valor) + campoGeo("p", "Presión exterior en el traje (Pa)", g.presion_inicial_pa.valor) + campoGeo("T", "Temperatura media del aire (K)", g.temperatura_inicial_k.valor))}
      ${detalleGeo("pasos", textoGeo("Contador de pasos o distancia medida. Largo de paso de $1 m y error relativo de $2 %, propuestas a calibrar. El rumbo se obtiene del Sol, de una IMU o del rover. Marte carece de campo magnético global útil para una brújula.", num(e.a_pie.largo_paso_m.valor, 1), num(b.sigma_pasos_fraccion.valor * 100)),
        campoGeo("pasos_n", "Cantidad de pasos") + campoGeo("pasos_d", "O distancia recorrida (m)") + campoGeo("pasos_r", "Rumbo desde el norte (°)") + campoGeo("pasos_s", "Error del rumbo (°, 1 sigma)", b.sigma_rumbo_grados.valor))}
      ${detalleGeo("sol", textoGeo("Sensor solar y reloj UTC. Error angular típico de $1°, propuesta a calibrar. En 10 km la geometría solar aporta poca información. Las sombras del relieve requieren otra observación y quedan fuera de esta medida.", num(g.sigma_sol_grados.valor, 1)),
        campoGeo("sol_fecha", "Fecha y hora terrestre (UTC)", "", "datetime-local") + campoGeo("sol_el", "Elevación solar medida (°)") + campoGeo("sol_az", "Azimut solar medido (°)") + sigma("sigma_sol_grados", "Error solar (°, 1 sigma)"))}
      ${detalleGeo("radio", textoGeo("Radio de tiempo de vuelo a una base o baliza. Error típico de $1 m, propuesta a calibrar. La distancia forma un anillo y requiere enlace y sincronización.", num(g.sigma_radio_m.valor)),
        selectorGeo("radio_base", "Base o baliza") + campoGeo("radio_d", "Distancia de radio (m)") + sigma("sigma_radio_m", "Error de distancia (m, 1 sigma)"))}
      ${detalleGeo("odometria", textoGeo("Odómetro de ruedas e IMU desde el último punto conocido. Error relativo típico de $1 %, propuesta a calibrar. El deslizamiento puede aumentar el error.", num(g.sigma_odometria_fraccion.valor * 100)),
        campoGeo("odo_d", "Distancia del odómetro (m)") + campoGeo("odo_r", "Rumbo desde el norte (°)") + campoGeo("odo_s", "Error del rumbo (°, 1 sigma)", b.sigma_rumbo_grados.valor))}
      <details class="geo-instrumento"><summary>${t("Resección y telémetro láser")}</summary>
        <p class="ayuda">${textoGeo("Visor óptico e IMU o referencia solar. Error típico de rumbo de $1° y de láser de $2 m, propuestas a calibrar. Marcá 2–3 cerros o bordes de cráter con clic derecho → Agregar referencia de resección aquí. Cada rumbo limita una dirección y cada distancia un anillo. La precisión depende de la geometría y del relieve.", num(g.sigma_reseccion_grados.valor), num(g.sigma_laser_m.valor))}</p>
        <div id="geo-referencias"></div></details>
      <details class="geo-instrumento"><summary>${t("Balizas UWB del plan")}</summary>
        <p class="ayuda">${textoGeo("Radio UWB de tiempo de vuelo en hábitats, refugios o balizas del plan. Error típico de $1 m, propuesta a calibrar. Sumá distancias independientes a varias balizas para trilaterar. Revisá el multitrayecto y las posiciones de las marcas.", num(g.sigma_uwb_m.valor))}</p>
        <div id="geo-balizas"></div><button type="button" id="geo-agregar-baliza">${t("Sumar distancia a una baliza")}</button></details>
      ${absoluto("doppler")}${absoluto("estrellas")}
      <button type="submit" id="geo-calcular" class="primario">${t("Combinar medidas")}</button>`;
    $("#geo-formulario").replaceChildren(form);
    form.addEventListener("submit", calcularGeo);
    form.addEventListener("input", () => invalidarGeo(false));
    form.addEventListener("change", () => invalidarGeo(false));
    form.addEventListener("focusin", (ev) => { if (ev.target.matches("[data-geo-base]")) actualizarReferencias(); });
    $("#geo-origen").addEventListener("change", () => { if ($("#geo-origen").value !== "clic") { origenGeo = null; dibujarPuntosMedidos(); } });
    $("#geo-agregar-baliza").addEventListener("click", agregarBalizaGeo);
    form.querySelector('[data-geo-tipo="odometria"]').hidden = estado.zona.meta.vehiculo !== "rover";
    referenciasGeo = []; origenGeo = null;
    dibujarPuntosMedidos();
    actualizarReferencias();
  }

  function fuentesGeo() {
    const fuentes = ctx.referencias();
    const ruta = estado.marcas.base?.celda;
    if (ruta && !fuentes.some((p) => p.celda.f === ruta.f && p.celda.c === ruta.c)) fuentes.push({ id: `${ruta.f},${ruta.c}`, nombre: t("Base de la ruta"), celda: ruta });
    return fuentes;
  }
  function actualizarReferencias() {
    if (!tieneFusion || !$("#geo-form")) return;
    for (const sel of $("#geo-form").querySelectorAll("[data-geo-base]")) {
      const elegida = sel.value;
      sel.replaceChildren(new Option(t("Elegí una base del plan"), ""));
      if (sel.id === "geo-origen" && origenGeo) sel.append(new Option(t("Punto marcado en el mapa"), "clic"));
      for (const p of fuentesGeo()) sel.append(new Option(p.nombre, p.id));
      sel.value = elegida;
    }
  }
  function invalidarGeo(borrarVerdad = true) {
    if (!tieneFusion) return;
    if (pedidoActual !== null && (borrarVerdad || pedidoFusion === pedidoActual)) {
      cancelarLocalizacion();
      $("#ubicar").disabled = false;
      $("#ubicar-subidas").disabled = !subidas.fotos.some((f) => f.foto);
      $("#ubicacion-progreso").hidden = true;
    }
    capasGeo.forEach((c) => c.remove()); capasGeo = [];
    posicionGeo?.remove(); posicionGeo = null; resultadoGeo = null; estado.posicionActual = null;
    if (borrarVerdad) verdadGeo = null;
    if (!ultimo && $("#geo-incluir-horizonte")) { $("#geo-incluir-horizonte").checked = false; $("#geo-incluir-horizonte").disabled = true; }
    $("#geo-usar").disabled = true;
    $("#geo-resultado").replaceChildren();
    const boton = $("#geo-calcular"); if (boton) boton.disabled = false;
  }
  function dibujarPuntosMedidos() {
    puntosMedidosGeo.forEach((c) => c.remove()); puntosMedidosGeo = [];
    const puntos = referenciasGeo.map((r, i) => ({ p: r.punto, texto: String(i + 1), nombre: "Referencia" }));
    if (origenGeo) puntos.push({ p: origenGeo, texto: "◎", nombre: "Último punto conocido" });
    for (const { p, texto, nombre } of puntos) puntosMedidosGeo.push(L.marker(aMapa(p.f, p.c), {
      icon: icono("provisoria", texto), title: t(nombre), interactive: false,
    }).addTo(mapa));
  }
  async function fijarUltimo(p) {
    if (!tieneFusion) return;
    const zonaAbierta = estado.zona;
    if (!$("#geo-form")) await iniciarFusion();
    if (estado.zona !== zonaAbierta || !$("#geo-form")) return;
    invalidarGeo(false); origenGeo = { ...p }; actualizarReferencias();
    $("#geo-origen").value = "clic";
    const geo = celdaALonLat(estado.zona.meta, p.f, p.c);
    $("#geo-origen-texto").textContent = textoGeo("Punto conocido en $1° de latitud, $2° E.", num(geo.lat, 5), num(geo.lon, 5));
    $("#seccion-ubicacion").open = true;
    dibujarPuntosMedidos();
  }
  async function agregarReferencia(p) {
    if (!tieneFusion) return;
    const zonaAbierta = estado.zona;
    if (!$("#geo-form")) await iniciarFusion();
    if (estado.zona !== zonaAbierta || !$("#geo-form")) return;
    if (referenciasGeo.length >= 3) { avisar(t("Podés usar hasta tres referencias de resección.")); return; }
    invalidarGeo(false);
    const id = `hito${++contadorGeo}`, g = configuracionGeo.cfg;
    referenciasGeo.push({ id, punto: { ...p } });
    const fila = document.createElement("fieldset"); fila.dataset.geoHito = id;
    const geo = celdaALonLat(estado.zona.meta, p.f, p.c);
    fila.innerHTML = `<legend>${t("Referencia")} ${referenciasGeo.length}</legend><p class="ayuda">${num(geo.lat, 5)}°, ${num(geo.lon, 5)}° E</p>
      ${campoGeo(`${id}_r`, "Rumbo al hito (°)")}${campoGeo(`${id}_s`, "Error del rumbo (°, 1 sigma)", g.sigma_reseccion_grados.valor)}
      ${campoGeo(`${id}_d`, "Distancia láser opcional (m)")}${campoGeo(`${id}_sd`, "Error del láser (m, 1 sigma)", g.sigma_laser_m.valor)}
      <button type="button">${t("Quitar medida")}</button>`;
    fila.querySelector("button").addEventListener("click", () => { referenciasGeo = referenciasGeo.filter((r) => r.id !== id); fila.remove(); invalidarGeo(false); dibujarPuntosMedidos(); });
    $("#geo-referencias").append(fila);
    fila.closest("details").open = true; $("#seccion-ubicacion").open = true;
    fila.scrollIntoView({ block: "nearest" });
    dibujarPuntosMedidos();
  }
  function agregarBalizaGeo() {
    invalidarGeo(false);
    const id = `uwb${++contadorGeo}`, fila = document.createElement("fieldset"); fila.dataset.geoUwb = id;
    fila.innerHTML = `<legend>${t("Baliza UWB")}</legend>${selectorGeo(`${id}_base`, "Hábitat, refugio o baliza")}
      ${campoGeo(`${id}_d`, "Distancia de radio (m)")}${campoGeo(`${id}_s`, "Error de distancia (m, 1 sigma)", configuracionGeo.cfg.sigma_uwb_m.valor)}
      <button type="button">${t("Quitar medida")}</button>`;
    fila.querySelector("button").addEventListener("click", () => { fila.remove(); invalidarGeo(false); });
    $("#geo-balizas").append(fila); actualizarReferencias();
  }
  function leerMedidasGeo() {
    const form = $("#geo-form"), { cfg: g, barometro: b, expedicion: e } = configuracionGeo;
    const valor = (n) => form.elements.namedItem(n).value.trim();
    const numero = (n) => { const v = valor(n); if (!v || !Number.isFinite(Number(v))) throw new Error("Completá los números de cada medida seleccionada."); return Number(v); };
    const base = (n) => { const p = fuentesGeo().find((r) => r.id === valor(n)); if (!p) throw new Error("Elegí una base del plan para la medida."); return p.celda; };
    const origen = () => {
      if ($("#geo-origen").value === "clic" && origenGeo) return origenGeo;
      return base("geo-origen");
    };
    const medidas = [], tiene = (n) => form.elements.namedItem(n).checked;
    if (tiene("barometro")) medidas.push({ id: "barometro", tipo: "barometro", base: base("baro_base"), p: numero("p"), pBase: numero("pBase"), T: numero("T") });
    if (tiene("pasos")) {
      if (valor("pasos_d") && valor("pasos_n")) throw new Error("Cargá pasos o distancia en la medida a estima.");
      const d = valor("pasos_d") ? numero("pasos_d") : numero("pasos_n") * e.a_pie.largo_paso_m.valor;
      medidas.push({ id: "pasos", tipo: "pasos", base: origen(), distancia_m: d, rumbo: numero("pasos_r"), sigma_rumbo_grados: numero("pasos_s"), sigma_distancia_m: Math.max(estado.zona.paso, d * b.sigma_pasos_fraccion.valor) });
    }
    if (tiene("odometria") && estado.zona.meta.vehiculo === "rover") {
      const d = numero("odo_d");
      medidas.push({ id: "odometria", tipo: "odometria", base: origen(), distancia_m: d, rumbo: numero("odo_r"), sigma_rumbo_grados: numero("odo_s"), sigma_distancia_m: Math.max(estado.zona.paso, d * g.sigma_odometria_fraccion.valor) });
    }
    if (tiene("sol")) medidas.push({ id: "sol", tipo: "sol", ms: Date.parse(valor("sol_fecha") + "Z"), elevacion: numero("sol_el"), azimut: numero("sol_az"), sigma_grados: numero("sigma_sol_grados") });
    if (tiene("radio")) medidas.push({ id: "radio", tipo: "radio", base: base("radio_base"), distancia_m: numero("radio_d"), sigma_m: numero("sigma_radio_m") });
    for (const tipo of ["doppler", "estrellas"]) if (tiene(tipo)) medidas.push({ id: tipo, tipo, posicion: { lat: numero(`${tipo}_lat`), lon: numero(`${tipo}_lon`) }, sigma_m: numero(`${tipo}_sigma`) });
    for (const r of referenciasGeo) medidas.push({ ...r, tipo: "reseccion", rumbo: numero(`${r.id}_r`), sigma_grados: numero(`${r.id}_s`),
      ...(valor(`${r.id}_d`) ? { distancia_m: numero(`${r.id}_d`), sigma_m: numero(`${r.id}_sd`) } : {}) });
    for (const fila of form.querySelectorAll("[data-geo-uwb]")) {
      const id = fila.dataset.geoUwb;
      medidas.push({ id, tipo: "uwb", base: base(`${id}_base`), distancia_m: numero(`${id}_d`), sigma_m: numero(`${id}_s`) });
    }
    const balizas = medidas.filter((m) => ["radio", "uwb"].includes(m.tipo));
    if (new Set(balizas.map((m) => `${m.base.f},${m.base.c}`)).size !== balizas.length) throw new Error("Usá una sola distancia por baliza para evitar contar la misma lectura dos veces.");
    return medidas;
  }
  function calcularGeo(ev) {
    ev.preventDefault();
    try {
      const medidas = leerMedidasGeo(), usarHorizonte = $("#geo-incluir-horizonte").checked && Boolean(ultimo);
      if (!medidas.length && !usarHorizonte) throw new Error("Sumá una medida o calculá el horizonte.");
      invalidarGeo(false);
      const pedido = nuevaBusqueda();
      pedidoFusion = pedido;
      $("#geo-calcular").disabled = true;
      $("#geo-estado").textContent = t("Combinando medidas en el Worker…");
      enviarLocalizacion({ tipo: "geoubicar", medidas, usarHorizonte,
        horizonte: usarHorizonte ? { mejor: celdaDeXY(ultimo.x, ultimo.y), error_m: ultimo.incertidumbre } : null,
        cfg: configuracionGeo.cfg, cfgBarometro: configuracionGeo.barometro }, pedido);
    } catch (error) { $("#geo-estado").textContent = t(error.message); }
  }
  function dibujarRegionGeo(r, color) {
    const z = estado.zona, max = configuracionGeo.cfg.pixeles_mapa_max.valor;
    let f0 = z.alto, c0 = z.ancho, f1 = 0, c1 = 0;
    for (const [f, c, h, w] of r.region) { f0 = Math.min(f0, f); c0 = Math.min(c0, c); f1 = Math.max(f1, f + h); c1 = Math.max(c1, c + w); }
    const escala = Math.max(1, (f1 - f0) / max, (c1 - c0) / max);
    const lienzo = document.createElement("canvas"); lienzo.width = Math.ceil((c1 - c0) / escala); lienzo.height = Math.ceil((f1 - f0) / escala);
    const g = lienzo.getContext("2d"); g.fillStyle = color;
    for (const [f, c, h, w] of r.region) g.fillRect((c - c0) / escala, (f - f0) / escala, w / escala, h / escala);
    return L.imageOverlay(lienzo.toDataURL(), [[-f1, c0], [-f0, c1]], { opacity: 0.24, interactive: false }).addTo(mapa);
  }
  function mostrarGeoubicacion(r, segundos) {
    resultadoGeo = r;
    $("#geo-calcular").disabled = false; $("#geo-usar").disabled = false;
    $("#geo-estado").textContent = textoGeo("Fusión modelada en $1 s. Resolución máxima de la región del 95 % de $2 m. Errores a calibrar.", num(segundos, 2), num(r.resolucion_m));
    const caja = $("#geo-resultado"); caja.replaceChildren();
    const resumen = document.createElement("p"); resumen.textContent = textoGeo("Estás a unos $1 m de este punto (95 % del modelo). Área combinada de $2 m².", num(r.error_m), num(r.area_m2)); caja.append(resumen);
    const h = r.individuales.find((m) => m.tipo === "horizonte");
    if (h) { const p = document.createElement("p"); p.className = "ayuda"; p.textContent = textoGeo("El horizonte solo daba unos $1 m. Las medidas combinadas dan unos $2 m.", num(h.error_m), num(r.error_m)); caja.append(p); }
    const lista = document.createElement("div"); lista.className = "geo-leyenda";
    r.individuales.forEach((m, i) => {
      const color = coloresGeo[i % coloresGeo.length], capa = dibujarRegionGeo(m, color); capasGeo.push(capa);
      const label = document.createElement("label"), check = document.createElement("input"), muestra = document.createElement("i"), texto = document.createElement("span");
      check.type = "checkbox"; check.checked = true; muestra.style.backgroundColor = color;
      check.addEventListener("change", () => check.checked ? capa.addTo(mapa) : capa.remove());
      texto.textContent = `${t(nombresGeo[m.tipo])} · ${num(m.area_m2)} m² · ${t("95 %")}`;
      label.append(check, muestra, texto); lista.append(label);
    });
    caja.append(lista);
    capasGeo.push(dibujarRegionGeo(r, "#ffffff"));
    const leyenda = document.createElement("p"); leyenda.className = "ayuda"; leyenda.textContent = t("Blanco y cruz indican la región combinada del 95 % y su mejor punto. Las regiones pueden tener varios parches."); caja.append(leyenda);
    const aportes = document.createElement("ul");
    for (const a of r.aportes) {
      const m = r.individuales.find((m) => m.id === a.id), li = document.createElement("li");
      li.textContent = textoGeo("$1 cambió el área de $2 a $3 m². Reducción de $4 m².", t(nombresGeo[m.tipo]), num(a.antes_m2), num(a.despues_m2), num(a.reduccion_m2)); aportes.append(li);
    }
    caja.append(aportes);
    capasGeo.push(L.marker(aMapa(r.mejor.f, r.mejor.c), { icon: icono("estimacion", "✚"), title: t("Geoubicación combinada") }).addTo(mapa));
    mapa.panTo(aMapa(r.mejor.f, r.mejor.c));
    const limite = estado.riesgo[estado.zona.meta.vehiculo || "pie"].incertidumbre_posicion_m.valor, aviso = document.createElement("p"); aviso.className = "ayuda";
    aviso.textContent = textoGeo("La decisión usa $1 m de incertidumbre de posición. Compará con los $2 m obtenidos antes de planificar el regreso.", num(limite), num(r.error_m)); caja.append(aviso);
    mostrarErrorReal();
  }
  function mostrarErrorReal() {
    if (!verdadGeo || !resultadoGeo) return;
    const r = resultadoGeo, error = Math.hypot(r.mejor.f - verdadGeo.f, r.mejor.c - verdadGeo.c) * estado.zona.paso;
    let p = $("#geo-error-real");
    if (!p) { p = document.createElement("p"); p.id = "geo-error-real"; $("#geo-resultado").append(p); }
    p.textContent = textoGeo("Error real de la fusión en la prueba con Curiosity de $1 m.", num(error, 1));
  }
  function usarPosicionGeo() {
    if (!resultadoGeo) return;
    const r = resultadoGeo;
    posicionGeo?.remove();
    posicionGeo = L.marker(aMapa(r.mejor.f, r.mejor.c), { icon: icono("estimacion", "◎"), title: t("Posición actual estimada") }).addTo(mapa);
    estado.posicionActual = { zona: estado.zona.meta.id, celda: { ...r.mejor }, error_95_m: r.error_m, instante: Date.now() };
    $("#geo-estado").textContent = textoGeo("Posición actual marcada con un error estimado de $1 m. La decisión usa $2 m. Revisá esa diferencia antes de regresar.", num(r.error_m), num(estado.riesgo[estado.zona.meta.vehiculo || "pie"].incertidumbre_posicion_m.valor));
  }
  if (tieneFusion) $("#geo-usar").addEventListener("click", usarPosicionGeo);
  return { abrirZona, alProgreso, alResultado, alEvento, fijarUltimo, agregarReferencia, actualizarReferencias,
    cambioPlan: () => { if (tieneFusion) { invalidarGeo(false); actualizarReferencias(); } },
    limpiar: () => { cancelarLocalizacion(); limpiarMapa(); ultimo = null; if (tieneFusion) {
      invalidarGeo(); origenGeo = null; referenciasGeo = []; dibujarPuntosMedidos(); $("#geo-formulario").replaceChildren();
    } } };
}
