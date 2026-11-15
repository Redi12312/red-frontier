// Worker: tiene su propia copia de la zona, calcula la zona segura desde la base y los refugios, las rutas,
// la decisión de salida, itinerarios, expediciones, radio, sombras y perfiles sin trabar la interfaz.
import { cargarZona, leerHttp } from "./zona.js";
import { prepararGrilla, buscarRuta, tiemposIda, resumen, bajarCampo, distanciaA } from "./ruteo.js";
import { zonaSegura, evaluarSalida, verificarTramos, prepararPlanSeguro, planificarBases, diaRuta } from "./riesgo.js";
import { muestreador, localizar, horizonte, DISTANCIAS } from "./localizador.js";
import { horizonteMedido } from "./horizonte-fotos.js";
import { coberturaVarias, tramosSinCobertura, sugerirBaliza } from "./radio.js";
import { mapaSombras, iluminacionRuta } from "./luz.js";
import { perfil as perfilLinea } from "./herramientas.js";
import { desnivel, localizarPorPresion, probabilidadEn } from "./barometro.js";
import { sirveDeRefugio } from "./consumibles.js";

let zona = null, grilla = null, grillaTerreno = null, cfg = null, seguro = null, claveSeguro = "", refugiosUltimos = [];
// Una comparación por bases y un origen de emergencia vigentes; no se acumulan pedidos anteriores.
let cacheBases = null, cacheRegreso = null;

self.onmessage = async ({ data }) => {
  try {
    if (data.tipo === "cargar") {
      zona = await cargarZona(data.base, leerHttp, true);
      cfg = data; // traje (vehículo), pie, riesgo, vehiculo, limitePendiente
      grilla = grillaTerreno = prepararGrilla(zona, cfg.traje);
      invalidarSeguro(); refugiosUltimos = [];
      let prohibidas = 0;
      for (let i = 0; i < grilla.prohibido.length; i++) prohibidas += grilla.prohibido[i];
      const prohibido = grilla.prohibido.slice();
      self.postMessage({ tipo: "listo", prohibidas, prohibido }, [prohibido.buffer]);
    } else if (data.tipo === "config") {
      // Consumibles de la salida cambiados en Opciones: la zona segura se rehace con los límites nuevos.
      cfg = { ...cfg, riesgo: data.riesgo };
      invalidarSeguro();
      self.postMessage({ tipo: "config" });
    } else if (data.tipo === "region") {
      refugiosUltimos = data.refugios || [];
      asegurar(data.inicio);
      let celdas = 0;
      for (let i = 0; i < seguro.permitido.length; i++) celdas += seguro.permitido[i];
      const limites = queLimita();
      const region = seguro.permitido.slice();
      self.postMessage({ tipo: "region", inicio: data.inicio, refugios: refugiosUltimos.length, celdas, limites, region }, [region.buffer]);
    } else if (data.tipo === "manual") {
      // Plan trazado a mano: se verifica cada tramo y el plan completo con las mismas reglas.
      asegurar(data.inicio);
      const verif = verificarTramos(zona, seguro, cfg.traje, data.tramos);
      const celdas = [];
      const finTramo = [];
      verif.forEach((t, k) => { celdas.push(...(k ? t.celdas.slice(1) : t.celdas)); finTramo.push(celdas.length - 1); });
      const tIda = tiemposIda(zona, cfg.traje.velocidad, celdas);
      // Paradas intermedias: su tiempo de trabajo se suma a todo lo que viene después.
      let paradas = 0;
      data.paradasMin.slice(0, -1).forEach((min, k) => {
        paradas += min * 60;
        for (let j = finTramo[k] + 1; j < tIda.length; j++) tIda[j] += min * 60;
      });
      const ruta = { celdas, ...resumen(zona, cfg.traje, celdas) };
      const malos = verif.filter((t) => !t.ok).length;
      const extra = [{ id: "tramos", nombre: "Tramos trazados dentro de lo permitido", valor: verif.length - malos, umbral: verif.length,
        ok: malos === 0, unidad: "tramos", base: "calculo", detalle: "",
        fuente: "Cada celda de cada tramo se compara con el terreno prohibido y la zona segura" }];
      const destinoMin = data.paradasMin.at(-1) ?? (cfg.vehiculo === "rover" ? cfg.riesgo.rover : cfg.riesgo.pie).tiempo_en_destino_min.valor;
      ruta.paradasMin = paradas / 60;
      Object.assign(ruta, paraSimular(celdas, tIda, destinoMin));
      const evaluacion = evaluarSalida({ ruta, tIda, seguro, riesgo: cfg.riesgo, vehiculo: cfg.vehiculo,
        limitePendiente: cfg.limitePendiente, tiempoDestinoMin: destinoMin, extra, zona, recorrido: ruta.sim });
      self.postMessage({ tipo: "manual", version: data.version, tramos: verif, ruta, evaluacion });
    } else if (data.tipo === "exclusiones") {
      // Peligros marcados con radio: se vuelven terreno prohibido para todas las rutas.
      const { ancho, alto, paso } = zona;
      if (!data.lista.length) grilla = grillaTerreno;
      else {
        const prohibido = grillaTerreno.prohibido.slice(), excluido = new Uint8Array(ancho * alto);
        for (const e of data.lista) {
          const r = Math.ceil(e.radio_celdas);
          for (let f = Math.max(0, e.f - r); f <= Math.min(alto - 1, e.f + r); f++) {
            for (let c = Math.max(0, e.c - r); c <= Math.min(ancho - 1, e.c + r); c++) {
              if ((f - e.f) ** 2 + (c - e.c) ** 2 <= e.radio_celdas ** 2) prohibido[f * ancho + c] = excluido[f * ancho + c] = 1;
            }
          }
        }
        grilla = { prohibido, excluido, distBorde: distanciaA(prohibido, ancho, alto, paso) };
      }
      invalidarSeguro();
      let prohibidas = 0;
      for (let i = 0; i < grilla.prohibido.length; i++) prohibidas += grilla.prohibido[i];
      const copia = grilla.prohibido.slice();
      self.postMessage({ tipo: "exclusiones", prohibidas, prohibido: copia }, [copia.buffer]);
    } else if (data.tipo === "itinerario") {
      // Varias paradas (marcas del plan): ruta segura entre cada par y evaluación del recorrido completo.
      if (data.refugios) refugiosUltimos = data.refugios;
      asegurar(data.paradas[0]);
      const plan = planSeguro();
      const celdas = [], tramos = [];
      for (let k = 1; k < data.paradas.length; k++) {
        const a = data.paradas[k - 1], b = data.paradas[k];
        const r = a.f === b.f && a.c === b.c ? { celdas: [a.f * zona.ancho + a.c] } : buscarRuta(zona, plan, cfg.traje, data.perfil, a, b);
        tramos.push({ desde: k - 1, hasta: k, ok: !!r.celdas, error: r.error || null, metros: r.celdas ? resumen(zona, cfg.traje, r.celdas).distancia : 0 });
        if (!r.celdas) continue;
        celdas.push(...(celdas.length ? r.celdas.slice(1) : r.celdas));
        tramos.at(-1).fin = celdas.length - 1;
      }
      const malos = tramos.filter((t) => !t.ok).length;
      if (!celdas.length) {
        self.postMessage({ tipo: "itinerario", version: data.version, tramos, ruta: null, evaluacion: null });
        return;
      }
      const tIda = tiemposIda(zona, cfg.traje.velocidad, celdas);
      // El trabajo en cada parada intermedia se suma a todo lo que viene después.
      tramos.forEach((t, k) => {
        if (!t.ok || k === tramos.length - 1) return;
        const min = data.paradas[t.hasta].minutos || 0;
        for (let j = t.fin + 1; j < tIda.length; j++) tIda[j] += min * 60;
      });
      const ruta = { celdas, ...resumen(zona, cfg.traje, celdas) };
      ruta.paradasMin = data.paradas.slice(1, -1).reduce((s, p) => s + (p.minutos || 0), 0);
      const extra = [{ id: "tramos", nombre: "Tramos del itinerario con ruta segura", valor: tramos.length - malos, umbral: tramos.length,
        ok: malos === 0, unidad: "tramos", base: "calculo", detalle: "",
        fuente: "Cada tramo entre paradas se busca dentro del terreno apto y de la zona segura de los refugios" }];
      Object.assign(ruta, paraSimular(celdas, tIda, data.paradas.at(-1).minutos || 0));
      const evaluacion = evaluarSalida({ ruta, tIda, seguro, riesgo: cfg.riesgo, vehiculo: cfg.vehiculo,
        limitePendiente: cfg.limitePendiente, tiempoDestinoMin: data.paradas.at(-1).minutos || 0, extra, zona, recorrido: ruta.sim });
      self.postMessage({ tipo: "itinerario", version: data.version, tramos, ruta, evaluacion });
    } else if (data.tipo === "expedicion") {
      // Expedición larga en rover presurizado: el rover es el refugio, así que la ruta solo respeta el terreno.
      const r = buscarRuta(zona, grilla, cfg.traje, data.perfil, data.inicio, data.fin);
      if (!r.celdas) { self.postMessage({ tipo: "expedicion", error: r.error || "sin_camino" }); return; }
      const t = tiemposIda(zona, cfg.traje.velocidad, r.celdas);
      const d = new Float64Array(r.celdas.length);
      for (let k = 1; k < r.celdas.length; k++) {
        const i = r.celdas[k - 1], j = r.celdas[k];
        const diag = (i % zona.ancho) !== (j % zona.ancho) && ((i / zona.ancho) | 0) !== ((j / zona.ancho) | 0);
        d[k] = d[k - 1] + (diag ? zona.paso * Math.SQRT2 : zona.paso);
      }
      self.postMessage({ tipo: "expedicion", celdas: r.celdas, distancias_m: Array.from(d), tiempos_s: Array.from(t), ...resumen(zona, cfg.traje, r.celdas) });
    } else if (data.tipo === "camino_regreso") {
      // Regreso de emergencia: siempre el camino MÁS SEGURO al refugio (mismas penalizaciones que la ruta segura:
      // pendiente, suelo áspero, bordes del terreno prohibido, suelo blando). Solo si ese no llega a tiempo con el
      // límite de la falla se usa el más rápido (el que baja por el campo de tiempo), y se avisa.
      asegurar(data.inicio);
      const { rapida, segura } = caminosDeRegreso(data);
      const elegido = segura && (!Number.isFinite(data.limite) || segura.segundos <= data.limite) ? segura : rapida;
      self.postMessage({ tipo: "camino_regreso", pedido: data.pedido, campo: data.campo, celdas: elegido?.celdas || null, tiempos: elegido?.tiempos || null,
        segundos: elegido?.segundos ?? null, criterio: elegido?.criterio || null, seguraSegundos: segura?.segundos ?? null, rapidaSegundos: rapida?.segundos ?? null });
    } else if (data.tipo === "radio") {
      // Cobertura de radio: base y balizas; si hay una ruta, sus tramos sin enlace y dónde poner una baliza.
      const cob = coberturaVarias(zona, data.antenas, data.cfg);
      let tramos = null, baliza = null;
      if (data.ruta?.length) {
        tramos = tramosSinCobertura(zona, cob.visible, data.ruta, data.tiempos || undefined);
        if (tramos.tramos.length) baliza = sugerirBaliza(zona, cob.visible, data.ruta, data.cfg);
      }
      const visible = cob.visible;
      self.postMessage({ tipo: "radio", pedido: data.pedido, fraccion: cob.fraccion, tramos, baliza, visible }, [visible.buffer]);
    } else if (data.tipo === "sombras") {
      const s = mapaSombras(zona, data.sol, { reduccion: data.reduccion || 4 });
      const ruta = data.ruta?.length ? iluminacionRuta(zona, s, data.ruta) : null;
      self.postMessage({ tipo: "sombras", pedido: data.pedido, sol: data.sol, ancho: s.ancho, alto: s.alto, paso: s.paso, ruta, sombra: s.sombra }, [s.sombra.buffer]);
    } else if (data.tipo === "barometro") {
      // Ubicación por barómetro: desnivel con la base (presiones simultáneas) cruzado con el relieve.
      // En la prueba a ciegas el motor elige un punto oculto, sintetiza la presión con ruido y lo busca.
      const { ancho, alto, paso, elevacion, valido } = zona;
      const c = data.cfg, R = c.gas_marciano_j_kg_k.valor, g = c.gravedad_m_s2.valor, sp = c.sigma_presion_diferencial_pa.valor;
      const zBase = elevacion[data.base.f * ancho + data.base.c];
      let p = data.p, verdad = null;
      if (data.prueba) {
        let semilla = data.semilla >>> 0 || 1;
        const azar = () => ((semilla = (Math.imul(semilla, 1664525) + 1013904223) >>> 0) / 4294967296);
        const rad = data.radio_m / paso;
        for (let intento = 0; intento < 5000 && !verdad; intento++) {
          const ang = azar() * 2 * Math.PI, dist = Math.sqrt(azar()) * rad;
          const f = Math.round(data.previa.f + dist * Math.sin(ang)), cc = Math.round(data.previa.c + dist * Math.cos(ang));
          if (f < 0 || cc < 0 || f >= alto || cc >= ancho) continue;
          const i = f * ancho + cc;
          if (valido[i] && !grilla.prohibido[i] && Number.isFinite(elevacion[i])) verdad = { f, c: cc, z: elevacion[i] };
        }
        if (!verdad) throw new Error("No hay terreno caminable dentro de ese radio para la prueba");
        const ruido = Math.sqrt(-2 * Math.log(azar() || 1e-12)) * Math.cos(2 * Math.PI * azar()) * sp;
        p = data.pBase * Math.exp((-g * (verdad.z - zBase)) / (R * data.T)) + ruido;
        verdad.ruido_pa = ruido;
      }
      const { dz, sigma } = desnivel({ p, pBase: data.pBase, T: data.T, cfg: c });
      const r = localizarPorPresion(zona, { zBase, dz, sigma, previa: { ...data.previa, radio_m: data.radio_m }, compacta: true });
      // Probabilidad solo en la ventana del círculo previo, en 0–255 (el resto de la zona es 0).
      const { f0, c0, ancho: w, alto: h } = r.prob;
      let max = 0;
      for (let f = 0; f < h; f++) for (let cc = 0; cc < w; cc++) max = Math.max(max, probabilidadEn(r.prob, (f0 + f) * ancho + c0 + cc));
      // ¿El punto oculto quedó dentro de la zona que junta el 95 % de la probabilidad?
      let dentro95 = null;
      if (verdad && r.mejor) {
        dentro95 = probabilidadEn(r.prob, verdad.f * ancho + verdad.c) >= r.umbral95;
      }
      const prob = new Uint8Array(w * h);
      if (max > 0) for (let f = 0; f < h; f++) for (let cc = 0; cc < w; cc++) prob[f * w + cc] = Math.round((255 * probabilidadEn(r.prob, (f0 + f) * ancho + c0 + cc)) / max);
      self.postMessage({ tipo: "barometro", pedido: data.pedido, p, dz, sigma, zBase, mejor: r.mejor, area_m2: r.area_m2, error: r.error || null,
        verdad, dentro95, ventana: { f0, c0, w, h }, prob }, [prob.buffer]);
    } else if (data.tipo === "perfil") {
      const p = perfilLinea(zona, data.a, data.b, data.paso || zona.paso);
      self.postMessage({ tipo: "perfil", pedido: data.pedido, ...p });
    } else if (data.tipo === "localizar" || data.tipo === "localizar_fotos") {
      // Localización a ciegas por horizonte: solo el horizonte medido por la cámara y el relieve.
      // Todo el cálculo se informa en vivo (fotos, lotes de candidatos, mejores por etapa) para auditarlo.
      const t0 = performance.now();
      const ev = (evento, datos) => self.postMessage({ tipo: "evento", evento, t: (performance.now() - t0) / 1000, datos });
      let lineas = null;
      if (data.tipo === "localizar_fotos") {
        ev("inicio_fotos", { fotos: data.fotos.length });
        // Fotos subidas: primero se extrae el horizonte de cada una, igual que el pipeline.
        const med = horizonteMedido(data.fotos, 0.25, 6, (fr, informe) => {
          self.postMessage({ tipo: "localizando", fraccion: 0.15 * fr, texto: "Leyendo el horizonte de las fotos" });
          ev("foto", informe);
        });
        data.medido = { azimut: med.az, elevacion: med.el.map((v) => (Number.isFinite(v) ? v : null)) };
        lineas = med.lineas;
      }
      const ctx = await contextoLocalizacion(data);
      const conDato = ctx.medido.el.filter(Number.isFinite).length;
      ev("medido", { az: ctx.medido.az, el: ctx.medido.el.map((v) => (Number.isFinite(v) ? v : null)), conDato, total: ctx.medido.el.length });
      const m = zona.meta;
      ev("parametros", {
        zona: m.nombre, km2: (zona.ancho * zona.alto * zona.paso * zona.paso) / 1e6, relieveCercano: `${m.id} (${zona.paso} m)`,
        relieveLejano: `${data.relieveLejano} (200 m)`, sesgo: data.sesgo, alturaCamara: data.alturaCamara, radio: m.proyeccion.radio_m,
      });
      const [a, , x0, , e, y0] = m.grilla.transform;
      const lim = { xMin: x0, xMax: x0 + zona.ancho * a, yMax: y0, yMin: y0 + zona.alto * e };
      let ultimo = 0;
      const base = data.tipo === "localizar_fotos" ? 0.15 : 0, parte = 1 - base;
      const az = ctx.medido.az;
      const r = localizar(ctx, lim, (fraccion, texto) => {
        if (fraccion - ultimo >= 0.01) { ultimo = fraccion; self.postMessage({ tipo: "localizando", fraccion: base + parte * fraccion, texto }); }
      }, (tipo, datos) => {
        ev(tipo, datos);
        if (tipo === "mejor") {
          // Horizonte calculado en el mejor candidato de la etapa, para compararlo con el medido.
          const calc = horizonte(ctx.cerca, ctx.lejos, datos.x, datos.y, az.map((v) => v + (datos.giro || 0)), DISTANCIAS.fina, ctx.geo);
          ev("horizonte_mejor", { etapa: datos.etapa, calculado: Array.from(calc) });
        }
      });
      const calculado = Array.from(horizonte(ctx.cerca, ctx.lejos, r.x, r.y, az.map((v) => v + r.giro), DISTANCIAS.fina, ctx.geo));
      ev("fin", { segundos: (performance.now() - t0) / 1000, candidatos: r.candidatos });
      self.postMessage({ tipo: "ubicacion", parada: data.parada, ...r, calculado, medido: ctx.medido, lineas });
    } else if (data.tipo === "tramo") {
      // Ajusta un tramo trazado a mano: mejor camino seguro entre sus dos puntos.
      asegurar(data.inicio);
      const r = buscarRuta(zona, planSeguro(), cfg.traje, data.perfil, data.desde, data.hasta);
      self.postMessage({ tipo: "tramo", indice: data.indice, celdas: r.celdas || null, error: r.error || null });
    } else if (data.tipo === "rutas") {
      const porDias = cfg.vehiculo === "pie" && data.planificacion && data.consumibles;
      const stockRefugio = (n) => {
        try { return sirveDeRefugio(n.datos || {}, cfg.riesgo.pie.tripulacion?.valor ?? 2, data.consumibles); }
        catch (err) { return { ok: false, motivo: err.message }; }
      };
      if (porDias) refugiosUltimos = (data.nodos || []).filter((n) => ["habitat", "refugio"].includes(n.tipo) && stockRefugio(n).ok);
      else if (data.refugios) refugiosUltimos = data.refugios;
      const baseReal = porDias && (data.nodos || []).find((n) => n.id === data.baseId || (n.f === data.inicio.f && n.c === data.inicio.c));
      const stockBase = baseReal ? stockRefugio(baseReal) : null;
      const controlesBase = stockBase ? [{ id: "stock_base", nombre: "Plazas y stock de la base de salida", ok: stockBase.ok,
        valor: stockBase.ok ? 1 : 0, umbral: 1, unidad: "", base: data.consumibles.refugio_minimo_h.base,
        fuente: data.consumibles.refugio_minimo_h.fuente, detalle: stockBase.motivo }] : [];
      asegurar(data.inicio);
      const plan = planSeguro(!!porDias);
      for (const perfil of data.perfiles) {
        const t0 = performance.now();
        const r = buscarRuta(zona, plan, cfg.traje, perfil, data.inicio, data.fin);
        if (r.celdas) {
          const tIda = tiemposIda(zona, cfg.traje.velocidad, r.celdas);
          const llegaARefugio = seguro.regreso[r.celdas.at(-1)] === 0; // destino = otra base: solo ida
          const destinoMin = porDias && llegaARefugio ? 0 : (cfg.vehiculo === "rover" ? cfg.riesgo.rover : cfg.riesgo.pie).tiempo_en_destino_min.valor;
          Object.assign(r, paraSimular(r.celdas, tIda, destinoMin, !llegaARefugio));
          r.evaluacion = evaluarSalida({ ruta: r, tIda, seguro, riesgo: cfg.riesgo, vehiculo: cfg.vehiculo,
            limitePendiente: cfg.limitePendiente, tiempoDestinoMin: destinoMin, extra: controlesBase, zona, recorrido: r.sim });
        }
        self.postMessage({ tipo: "ruta", perfil: perfil.id, ms: performance.now() - t0, ...r });
      }
      // ¿Conviene pasar por otra base? Se compara la ruta directa con cadenas de bases (recargando en cada una).
      if (porDias) {
        const firma = JSON.stringify({ ...data, instante: diaRuta(zona, data.inicio, data.instante) });
        if (cacheBases?.plan !== plan || cacheBases.firma !== firma) {
          cacheBases = { plan, firma, resultado: planificarBases({ zona, grilla, cfg, data,
            contextoInicial: { seguro, plan, bases: [data.inicio, ...refugiosUltimos] } }) };
        }
        self.postMessage({ tipo: "ruta_bases", ...cacheBases.resultado });
      } else if (data.nodos?.length) self.postMessage({ tipo: "ruta_bases", ...porBases(plan, data) });
      self.postMessage({ tipo: "rutas_fin" });
    }
  } catch (err) {
    self.postMessage({ tipo: "error", mensaje: String(err && err.message || err) });
  }
};

// Las rutas de emergencia se reutilizan aunque cambie el plazo de la falla: se elige después.
function caminosDeRegreso(data) {
  const rescate = data.campo === "rescate" && !!seguro.rescate;
  const destinos = [data.inicio, ...refugiosUltimos].filter(Boolean);
  const clave = JSON.stringify([data.desde.f, data.desde.c, rescate, data.perfil, destinos.map((d) => [d.f, d.c])]);
  if (cacheRegreso?.seguro === seguro && cacheRegreso.clave === clave) return cacheRegreso;
  const campo = rescate ? seguro.rescate : seguro.regreso;
  const r = cfg.riesgo.pie, factor = rescate ? r.rescate_factor_velocidad.valor : 1;
  const pendienteMax = rescate ? r.rescate_pendiente_max_grados.valor : Infinity;
  const rapido = bajarCampo(zona, campo, data.desde, { prohibido: seguro.prohibidoRegreso,
    pendienteMax, vel: cfg.pie.velocidad, factor });
  const i0 = data.desde.f * zona.ancho + data.desde.c;
  const rapida = rapido ? { celdas: rapido, tiempos: rapido.map((j) => campo[j]), segundos: campo[i0], criterio: "rapida" } : null;
  let segura = null;
  if (rapido && cfg.vehiculo !== "rover") {
    let prohibido = grilla.prohibido;
    if (rescate) {
      prohibido = prohibido.slice();
      for (let i = 0; i < prohibido.length; i++) if (zona.pendiente[i] > pendienteMax) prohibido[i] = 1;
      prohibido[i0] = 0;
    }
    const plan = { prohibido, distBorde: grilla.distBorde };
    for (const destino of destinos) {
      const ruta = buscarRuta(zona, plan, cfg.traje, data.perfil, data.desde, destino);
      if (!ruta.celdas) continue;
      const t = tiemposIda(zona, cfg.traje.velocidad, ruta.celdas), total = t.at(-1) / factor;
      if (!segura || total < segura.segundos) segura = { celdas: ruta.celdas,
        tiempos: Array.from(t, (x) => (t.at(-1) - x) / factor), segundos: total, criterio: "segura" };
    }
  }
  cacheRegreso = { seguro, clave, rapida, segura };
  return cacheRegreso;
}

// Ruta por bases: cada tramo entre dos bases es una salida aparte (se recarga el traje en la base o depósito).
// Busca, entre la salida directa y las cadenas de bases, la de menor tiempo total cuyos tramos se aprueban todos.
// nodos: [{ id, nombre, tipo, f, c }] (hábitats, refugios y depósitos del plan, sin la base de salida).
function porBases(plan, data) {
  const r = cfg.vehiculo === "rover" ? cfg.riesgo.rover : cfg.riesgo.pie;
  const recarga = (r.recarga_refugio_min ?? cfg.riesgo.pie.recarga_refugio_min).valor * 60;
  const destinoMin = r.tiempo_en_destino_min.valor;
  const inicio = { id: "_inicio", nombre: data.nombreInicio || "Base", f: data.inicio.f, c: data.inicio.c };
  const fin = { id: "_fin", nombre: data.nombreFin || "Destino", f: data.fin.f, c: data.fin.c, final: true };
  const dist = (a, b) => Math.hypot(a.f - b.f, a.c - b.c);
  const directa = dist(inicio, fin);
  // Solo bases que no desvían demasiado (camino en línea recta ≤ 2 veces el directo + 1 km).
  const medio = data.nodos.filter((n) => dist(inicio, n) + dist(n, fin) <= 2 * directa + 1000 / zona.paso && dist(n, inicio) > 0);
  const nodos = [inicio, ...medio, fin];
  const firma = JSON.stringify([data.perfiles[0], nodos.map((n) => [n.id, n.f, n.c])]);
  // Conserva un único grafo de bases: a lo sumo sus pares, sin crecer al mover destinos por el mapa.
  if (cacheBases?.plan !== plan || cacheBases.firma !== firma) cacheBases = { plan, firma, rutas: new Map() };
  const cache = new Map();
  const tramo = (a, b) => {
    const clave = `${a.id}>${b.id}`;
    if (cache.has(clave)) return cache.get(clave);
    let res = null;
    let ruta = cacheBases.rutas.get(clave);
    if (!ruta) {
      ruta = buscarRuta(zona, plan, cfg.traje, data.perfiles[0], a, b);
      cacheBases.rutas.set(clave, ruta);
    }
    if (ruta.celdas) {
      const tIda = tiemposIda(zona, cfg.traje.velocidad, ruta.celdas);
      const simulacion = paraSimular(ruta.celdas, tIda, b.final ? destinoMin : 0,
        b.final && seguro.regreso[b.f * zona.ancho + b.c] !== 0);
      const ev = evaluarSalida({ ruta, tIda, seguro, riesgo: cfg.riesgo, vehiculo: cfg.vehiculo, limitePendiente: cfg.limitePendiente,
        tiempoDestinoMin: b.final ? destinoMin : 0, zona, recorrido: simulacion.sim });
      const cons = ev.controles.find((c) => c.id === "consumibles" || c.id === "duracion");
      const margen = cons ? (cons.unidad === "h" ? (cons.umbral - cons.valor) * 60 : cons.umbral - cons.valor) : null;
      res = { desde: a.id, hasta: b.id, nombreDesde: a.nombre, nombreHasta: b.nombre, celdas: ruta.celdas, tiempo: ruta.tiempo, distancia: ruta.distancia,
        evaluacion: ev, ok: ev.decision === "SI", margenMin: margen, ...simulacion };
    }
    cache.set(clave, res);
    return res;
  };
  // Dijkstra sobre las bases: costo = tiempo de marcha + recarga en cada base intermedia; solo tramos aprobados.
  const costo = new Map([[inicio.id, 0]]), previo = new Map(), hecho = new Set();
  for (;;) {
    let u = null;
    for (const n of nodos) if (!hecho.has(n.id) && costo.has(n.id) && (!u || costo.get(n.id) < costo.get(u.id))) u = n;
    if (!u || u.id === fin.id) break;
    hecho.add(u.id);
    for (const v of nodos) {
      if (v.id === u.id || v.id === inicio.id || hecho.has(v.id)) continue;
      const t = tramo(u, v);
      if (!t || !t.ok) continue;
      const c = costo.get(u.id) + t.tiempo + (v.final ? destinoMin * 60 : recarga);
      if (!costo.has(v.id) || c < costo.get(v.id)) { costo.set(v.id, c); previo.set(v.id, u.id); }
    }
  }
  const directo = tramo(inicio, fin);
  let cadena = null;
  if (costo.has(fin.id)) {
    const ids = [fin.id];
    while (ids[0] !== inicio.id) ids.unshift(previo.get(ids[0]));
    const tramos = [];
    for (let k = 1; k < ids.length; k++) tramos.push(tramo(nodos.find((n) => n.id === ids[k - 1]), nodos.find((n) => n.id === ids[k])));
    cadena = { paradas: ids.map((id) => nodos.find((n) => n.id === id).nombre), tramos, total_s: costo.get(fin.id),
      recargas: ids.length - 2, margenMin: Math.min(...tramos.map((t) => t.margenMin ?? Infinity)) };
  }
  // Recomendación: la directa si se aprueba con margen; si no, la cadena de bases; si ninguna, se informa.
  const margenMin = cfg.riesgo.pie.margen_terminar_min?.valor ?? 30;
  let recomendada = "ninguna", motivo = "";
  const pasaPorBases = cadena && cadena.recargas > 0;
  if (directo?.ok && (!pasaPorBases || directo.margenMin >= margenMin || cadena.margenMin <= directo.margenMin)) {
    recomendada = "directa";
    motivo = pasaPorBases ? "La ruta directa se aprueba con margen: pasar por otra base solo agrega tiempo." : "Ninguna base del plan mejora la ruta directa.";
  } else if (pasaPorBases) {
    recomendada = "bases";
    motivo = directo?.ok
      ? `Conviene pasar por ${cadena.paradas.slice(1, -1).join(", ")}: la directa se aprueba con poco margen (${Math.round(directo.margenMin)} min).`
      : `La ruta directa no se aprueba${directo ? ` (${directo.evaluacion.controles.filter((c) => !c.ok && !c.aviso).map((c) => c.nombre.toLowerCase()).join(", ")})` : " (no hay camino seguro)"}: pasando por ${cadena.paradas.slice(1, -1).join(", ")} y recargando, sí.`;
  } else if (cadena) {
    recomendada = "directa";
    motivo = "La ruta directa es la mejor.";
  } else {
    motivo = "Ni directo ni pasando por las bases del plan hay una salida aprobada: agregá un refugio o un depósito en el camino.";
  }
  return { recomendada, motivo, cadena, directo: directo ? { ok: directo.ok, tiempo: directo.tiempo, margenMin: directo.margenMin } : null,
    consideradas: medio.length, recargaMin: recarga / 60 };
}

// Qué marca el borde de la zona segura: terreno prohibido, pendiente donde no se puede arrastrar a un compañero
// (regla de rescate) o tiempo de regreso. Cuenta los vecinos de afuera de cada celda del borde.
function queLimita() {
  const { ancho, alto, pendiente } = zona;
  const p = seguro.permitido, cuenta = { terreno: 0, rescate: 0, tiempo: 0 };
  const limRescate = cfg.riesgo.pie.rescate_pendiente_max_grados.valor;
  for (let f = 1; f < alto - 1; f++) {
    for (let c = 1; c < ancho - 1; c++) {
      const i = f * ancho + c;
      if (!p[i]) continue;
      for (const j of [i - 1, i + 1, i - ancho, i + ancho]) {
        if (p[j]) continue;
        if (grilla.prohibido[j]) cuenta.terreno++;
        else if (cfg.vehiculo !== "rover" && pendiente[j] > limRescate) cuenta.rescate++;
        else cuenta.tiempo++;
      }
    }
  }
  return cuenta;
}

// Zona segura para la base y los refugios del plan (se recalcula solo si cambiaron).
function invalidarSeguro() {
  seguro = null; claveSeguro = ""; planCache = null; cacheBases = null; cacheRegreso = null;
}

function asegurar(inicio) {
  const bases = [inicio, ...refugiosUltimos].filter(Boolean);
  const clave = bases.map((b) => `${b.f},${b.c}`).sort().join(";");
  if (seguro && clave === claveSeguro) return;
  seguro = zonaSegura(zona, grilla, cfg.vehiculo, cfg.pie, cfg.riesgo, bases);
  claveSeguro = clave;
  planCache = null; cacheBases = null; cacheRegreso = null;
}

// Lo que necesita la simulación de la salida en cada punto de la ruta: tiempo de ida, tiempo de regreso
// de emergencia y de rescate hasta el refugio más cercano. Con `idaYVuelta`, la ruta se recorre de vuelta
// (después del trabajo en el destino) por el mismo camino.
function paraSimular(celdas, tIda, minutosDestino, idaYVuelta = false) {
  let c = celdas, t = Array.from(tIda);
  if (idaYVuelta && celdas.length > 1) {
    const vuelta = celdas.slice(0, -1).reverse();
    const tv = tiemposIda(zona, cfg.traje.velocidad, [celdas.at(-1), ...vuelta]);
    const base = t.at(-1) + minutosDestino * 60;
    c = [...celdas, ...vuelta];
    t = [...t, ...Array.from(tv).slice(1).map((x) => base + x)];
  }
  return {
    sim: {
      celdas: c, t,
      regreso: c.map((i) => (Number.isFinite(seguro.regreso[i]) ? seguro.regreso[i] : null)),
      rescate: seguro.rescate ? c.map((i) => (Number.isFinite(seguro.rescate[i]) ? seguro.rescate[i] : null)) : null,
      idaYVuelta, minutosDestino, finIda: celdas.length - 1,
    },
  };
}

// La ruta solo pasa por celdas permitidas: terreno apto Y dentro de los límites de regreso y rescate.
// Además guarda, para cada celda, cuán lejos (en tiempo) está del refugio más cercano: las rutas lo usan para
// preferir pasar cerca de los refugios (peso_refugio en config/rutas.json).
let planCache = null;
function planSeguro(conMargen = false) {
  if (planCache?.clave === claveSeguro && planCache.grilla === grilla && planCache.conMargen === conMargen) return planCache.plan;
  const plan = prepararPlanSeguro(zona, grilla, seguro, cfg, conMargen);
  planCache = { clave: claveSeguro, grilla, conMargen, plan };
  return plan;
}

// Relieve lejano (200 m) para el horizonte: se carga una vez por zona.
let relieveLejano = null;
async function contextoLocalizacion(data) {
  if (!relieveLejano || relieveLejano.id !== data.relieveLejano) {
    const lejos = await cargarZona(`${data.raizDatos}/${data.relieveLejano}`, leerHttp, true);
    relieveLejano = { id: data.relieveLejano, m: muestreador(lejos.elevacion, lejos.ancho, lejos.alto, lejos.meta.grilla.transform) };
  }
  const m = zona.meta;
  const lat = (m.limites.lat_sur + m.limites.lat_norte) / 2;
  const medido = data.medido || await leerHttp(data.medidoUrl, "json");
  const lejosM = relieveLejano.m;
  return {
    cerca: muestreador(zona.elevacion, zona.ancho, zona.alto, m.grilla.transform),
    lejos: (x, y) => lejosM(x, y) + data.sesgo,
    medido: { az: medido.azimut, el: medido.elevacion.map((v) => (v === null ? NaN : v)) },
    geo: { fe: Math.cos((lat * Math.PI) / 180), radio: m.proyeccion.radio_m, alturaCamara: data.alturaCamara },
  };
}
