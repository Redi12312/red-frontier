// Gestión de riesgo de una salida: zona segura desde la base y decisión sí / no con cada control
// a la vista (valor, umbral y fuente). Las reglas y sus fuentes están en config/riesgo.json.
// Sin dependencias del navegador: corre en el Worker y en Node.
import { campoTiempo, prepararGrilla, buscarRuta, tiemposIda, valoresVel, velocidad } from "./ruteo.js";
import { alcanzaParaRecargar, sirveDeRefugio, autonomia } from "./consumibles.js";
import { evaluarConfiabilidad } from "./confiabilidad.js";
import { amanecerAtardecer } from "./luz.js";
import { celdaALonLat } from "./zona.js";
import { tiempoMarte } from "./clima.js";

const v = (p) => p.valor;
const coma = (x, d = 1) => x.toFixed(d).replace(".", ","); // números en formato es-UY

// Límite de pendiente del mapa para caminar: capacidad del traje menos lo que el mapa puede subestimar.
export function limitePendientePie(riesgo, margenMedido) {
  const r = riesgo.pie;
  const margen = Number.isFinite(margenMedido) ? margenMedido : v(r.margen_pendiente_por_defecto_grados);
  return {
    valor: Math.round((v(r.pendiente_capacidad_traje_grados) - margen) * 10) / 10,
    fuente: `${v(r.pendiente_capacidad_traje_grados)}° de capacidad del traje (Artemis) − ${coma(margen)}° de margen `
      + (Number.isFinite(margenMedido) ? "medido contra Curiosity en esta zona" : "por defecto (zona sin validación propia)"),
  };
}

// Campos de seguridad alrededor de la base y celdas permitidas para el plan.
// pie: regreso de emergencia y rescate del compañero dentro de sus límites.
// rover: regreso a pie dentro del límite (estimación a la escala de la zona).
// Devuelve también `prohibidoRegreso`: la máscara con la que se calculó el campo de regreso, para que el
// camino de vuelta (bajarCampo) respete las mismas celdas y esquinas. `grilla.excluido` (opcional) son los
// peligros marcados a mano: en rover también prohíben el regreso a pie.
export function zonaSegura(zona, grilla, vehiculo, pie, riesgo, base) {
  const n = zona.ancho * zona.alto;
  const permitido = new Uint8Array(n);
  if (vehiculo === "rover") {
    // A 200 m la «rugosidad» es la variación del relieve en 1 km, no la del suelo a 2 m: el límite del traje no
    // se aplica a esa escala (por eso el regreso a pie en las regiones es una estimación preliminar).
    const pieRegion = zona.paso > 20 ? { ...pie, rugosidad_max_cm: { ...pie.rugosidad_max_cm, valor: Infinity } } : pie;
    const prohibidoPie = prepararGrilla(zona, pieRegion).prohibido;
    if (grilla.excluido) for (let i = 0; i < n; i++) if (grilla.excluido[i]) prohibidoPie[i] = 1;
    const regreso = campoTiempo(zona, prohibidoPie, pie.velocidad, base, { limite: v(riesgo.rover.regreso_a_pie_max_h) * 3600 });
    for (let i = 0; i < n; i++) permitido[i] = !grilla.prohibido[i] && Number.isFinite(regreso[i]) ? 1 : 0;
    return { permitido, regreso, rescate: null, prohibidoRegreso: prohibidoPie };
  }
  const r = riesgo.pie;
  const ingreso = v(r.ingreso_refugio_min) * 60;
  const regreso = campoTiempo(zona, grilla.prohibido, pie.velocidad, base, { limite: v(r.regreso_emergencia_max_min) * 60 - ingreso });
  const rescate = campoTiempo(zona, grilla.prohibido, pie.velocidad, base, {
    pendienteMax: v(r.rescate_pendiente_max_grados),
    factor: v(r.rescate_factor_velocidad),
    limite: v(r.rescate_max_min) * 60 - ingreso,
  });
  for (let i = 0; i < n; i++) permitido[i] = Number.isFinite(regreso[i]) && Number.isFinite(rescate[i]) ? 1 : 0;
  return { permitido, regreso, rescate, prohibidoRegreso: grilla.prohibido };
}

function control(id, nombre, valor, umbral, ok, unidad, param, detalle = "", aviso = false) {
  return { id, nombre, valor, umbral, ok, unidad, base: param?.base ?? "calculo", fuente: param?.fuente ?? "", detalle, aviso };
}

// Un control de aviso que no se cumple no bloquea la salida: se muestra en ámbar para revisarlo.
export const decidir = (controles) => (controles.every((c) => c.ok || c.aviso) ? "SI" : "NO");

// Clave del sol local para reutilizar un pedido aunque pasen unos segundos de reloj.
export function diaRuta(zona, inicio, ms) {
  const { lon } = celdaALonLat(zona.meta, inicio.f, inicio.c);
  return Math.floor(tiempoMarte(ms).msd + lon / 360);
}

// Costo de regreso Y rescate. La admisión opcional reserva también el error de posición:
// se calcula al visitar una celda, sin recorrer un disco en toda la zona.
export function prepararPlanSeguro(zona, grilla, seguro, cfg, conMargen = false) {
  const n = grilla.prohibido.length, r = cfg.riesgo.pie;
  const prohibido = new Uint8Array(n), cercania = new Float32Array(n);
  const cercaniaRescate = seguro.rescate ? new Float32Array(n) : null;
  const ingreso = v(r.ingreso_refugio_min) * 60;
  const limReg = cfg.vehiculo === "rover" ? v(cfg.riesgo.rover.regreso_a_pie_max_h) * 3600 : v(r.regreso_emergencia_max_min) * 60 - ingreso;
  const limRes = v(r.rescate_max_min) * 60 - ingreso;
  for (let i = 0; i < n; i++) {
    prohibido[i] = grilla.prohibido[i] || !seguro.permitido[i] ? 1 : 0;
    cercania[i] = Math.min(1, seguro.regreso[i] / limReg);
    if (cercaniaRescate) cercaniaRescate[i] = Math.min(1, seguro.rescate[i] / limRes);
  }
  const plan = { prohibido, distBorde: grilla.distBorde, cercania, cercaniaRescate };
  const radio = conMargen && cfg.vehiculo !== "rover" ? Math.floor(v(r.incertidumbre_posicion_m) / zona.paso) : 0;
  if (radio > 0) {
    const vel = valoresVel(cfg.traje.velocidad), lim = cfg.traje.pendiente_max_grados.valor * Math.PI / 180;
    // Cota conservadora: la menor velocidad de Tobler dentro de la pendiente habilitada.
    const vMin = Math.min(velocidad(Math.tan(lim), vel), velocidad(-Math.tan(lim), vel));
    const margen = v(r.incertidumbre_posicion_m) / vMin, factor = v(r.rescate_factor_velocidad);
    // Los campos ya están truncados en sus límites: los vecinos finitos del disco
    // nunca los superan. Falta reservar el término aditivo que usa evaluarSalida.
    plan.admite = (i) => seguro.regreso[i] + margen <= limReg && seguro.rescate[i] + margen / factor <= limRes;
  }
  return plan;
}

// Decide si la salida se puede hacer. `ruta.celdas` y `tIda` (s acumulados) describen el plan;
// `seguro` sale de zonaSegura. Devuelve { decision: "SI" | "NO", controles }.
// Opcionales (el Worker los pasa siempre):
//  - zona: habilita la incertidumbre de posición (peor valor de regreso y rescate en un disco alrededor de
//    cada celda) y el control de datos del terreno. Sin `zona` esos dos no se evalúan.
//  - recorrido: { celdas, t, idaYVuelta } tal como se va a simular (ida, trabajo y vuelta): los controles de
//    consumibles y duración usan esos mismos tiempos, para que lo aprobado y lo simulado coincidan.
export function evaluarSalida({ ruta, tIda, seguro, riesgo, vehiculo, limitePendiente, tiempoDestinoMin, extra = [], zona = null, recorrido = null }) {
  const celdas = ruta.celdas;
  const ultimo = celdas.length - 1;
  const controles = [];
  const rover = vehiculo === "rover";
  const pie = riesgo.pie;
  const r = rover ? riesgo.rover : pie;
  const destinoMin = tiempoDestinoMin ?? v(r.tiempo_en_destino_min);
  const ingreso = v(r.ingreso_refugio_min ?? pie.ingreso_refugio_min);
  const colchon = v(r.colchon_regreso ?? pie.colchon_regreso);

  // Incertidumbre de posición: el astronauta puede estar en cualquier celda del disco, no solo en la de la ruta.
  const pInc = r.incertidumbre_posicion_m ?? pie.incertidumbre_posicion_m;
  const radio = zona && pInc ? Math.floor(v(pInc) / zona.paso) : 0;
  const radioDatos = Math.max(1, radio); // el entorno de datos mira al menos los 8 vecinos
  const disco = [];
  for (let df = -radioDatos; df <= radioDatos; df++) {
    for (let dc = -radioDatos; dc <= radioDatos; dc++) if (df * df + dc * dc <= radioDatos * radioDatos) disco.push(df, dc, df * df + dc * dc <= radio * radio ? 1 : 0);
  }
  const sinDato = (i) => !zona.valido[i] || zona.elevacion[i] !== zona.elevacion[i] || zona.pendiente[i] !== zona.pendiente[i] || zona.rugosidad[i] !== zona.rugosidad[i];
  // Margen de tiempo equivalente a caminar ese radio a la velocidad media de esta ruta (a pie).
  const margenS = radio > 0 && !rover && ruta.tiempo > 0 && ruta.distancia > 0 ? (v(pInc) * ruta.tiempo) / ruta.distancia : 0;
  const factorRescate = pie.rescate_factor_velocidad ? v(pie.rescate_factor_velocidad) : 1;
  const memoria = new Map();
  // Peor regreso y rescate finitos dentro del radio de incertidumbre, y fracción de celdas sin dato alrededor.
  const entorno = (i) => {
    let e = memoria.get(i);
    if (e) return e;
    e = { reg: seguro.regreso[i], res: seguro.rescate ? seguro.rescate[i] : 0, malas: 0, total: 0 };
    if (zona) {
      const f = (i / zona.ancho) | 0, c = i % zona.ancho;
      for (let k = 0; k < disco.length; k += 3) {
        const ff = f + disco[k], cc = c + disco[k + 1];
        if (ff < 0 || cc < 0 || ff >= zona.alto || cc >= zona.ancho) continue;
        const j = ff * zona.ancho + cc;
        e.total++;
        if (sinDato(j)) e.malas++;
        if (!disco[k + 2]) continue;
        if (seguro.regreso[j] < Infinity && seguro.regreso[j] > e.reg) e.reg = seguro.regreso[j];
        if (seguro.rescate && seguro.rescate[j] < Infinity && seguro.rescate[j] > e.res) e.res = seguro.rescate[j];
      }
    }
    // Como mínimo, el tiempo de caminar el radio de incertidumbre (cubre el borde del campo, donde no hay vecinos finitos).
    e.reg = Math.max(e.reg, seguro.regreso[i] + margenS);
    if (seguro.rescate) e.res = Math.max(e.res, seguro.rescate[i] + margenS / factorRescate);
    memoria.set(i, e);
    return e;
  };
  const maxEn = (clave) => {
    let m = -Infinity;
    for (const i of celdas) { const x = entorno(i)[clave]; if (x > m) m = x; }
    return m;
  };
  const textoInc = !zona || !pInc ? ""
    : radio > 0 ? ` Con ${v(pInc)} m de incertidumbre de posición: se toma el peor valor del campo en ese radio alrededor de cada celda y, como mínimo, el tiempo de caminar esa distancia a la velocidad media de la ruta (${coma(margenS, 0)} s; arrastrando a un compañero, ${coma(margenS / factorRescate, 0)} s). Propuesta, a calibrar.`
      : ` La incertidumbre de posición (${v(pInc)} m) es menor que una celda de ${zona.paso} m: no cambia el valor.`;

  // Línea de tiempo completa: ida (con las paradas intermedias ya sumadas), trabajo en el destino y vuelta.
  const finTrabajo = tIda[ultimo] + destinoMin * 60;
  const pc = recorrido?.celdas ?? celdas, pt = recorrido?.t ?? tIda;
  // Peor momento: tiempo transcurrido + colchón × regreso desde ahí (s). Incluye el fin del trabajo en el destino.
  let peorS = finTrabajo + colchon * entorno(celdas[ultimo]).reg;
  let peorConsumibles = celdas[ultimo];
  for (let k = 0; k < pc.length; k++) {
    const exigido = pt[k] + colchon * entorno(pc[k]).reg;
    if (exigido > peorS) { peorS = exigido; peorConsumibles = pc[k]; }
  }
  const finRegreso = seguro.regreso[celdas[ultimo]];
  const textoVuelta = recorrido?.idaYVuelta ? "la vuelta por el mismo camino" : "la vuelta por el mejor camino al refugio más cercano";

  if (rover) {
    const reg = maxEn("reg");
    controles.push(control("regreso_a_pie", "Regreso a pie si falla el rover", reg / 3600, v(r.regreso_a_pie_max_h),
      reg / 3600 <= v(r.regreso_a_pie_max_h), "h", r.regreso_a_pie_max_h, "Peor punto de la ruta. " + r.aviso_resolucion + textoInc));
    // Avería tardía: la caminata de vuelta tiene que caber en los consumibles que quedan en ese momento.
    const peorH = peorS / 3600 + ingreso / 60;
    controles.push(control("regreso_a_pie_consumibles", "Avería del rover: volver a pie con lo que queda", peorH, v(r.consumibles_primarios_h),
      peorH <= v(r.consumibles_primarios_h), "h", r.consumibles_primarios_h,
      `En el peor momento (incluido el fin de los ${destinoMin} min de trabajo en el destino): tiempo transcurrido + ${coma(colchon)} × caminata de regreso + ${ingreso} min de ingreso al refugio. Colchón e ingreso son los de la salida a pie.`));
    const vuelta = recorrido?.idaYVuelta ? pt[pt.length - 1] - finTrabajo : finRegreso === 0 ? 0 : tIda[ultimo];
    const total = (finTrabajo + vuelta + ingreso * 60) / 3600;
    controles.push(control("duracion", "Duración total (ida, trabajo, vuelta e ingreso)", total, v(r.consumibles_primarios_h),
      total <= v(r.consumibles_primarios_h), "h", r.consumibles_primarios_h,
      `Incluye ${destinoMin} min en el destino, ${finRegreso === 0 ? "sin vuelta (el destino es un refugio)" : "la vuelta por el mismo camino"} y ${ingreso} min de ingreso al refugio.`));
    const personas = r.tripulacion?.valor ?? pie.tripulacion?.valor ?? 2;
    controles.push(control("pareja", "Salida en pareja (o más)", personas, 2, personas >= 2, "astronautas", null,
      "Regla de NASA: nunca un astronauta solo. También vale en rover."));
    // Plan de rescate en rover: campo de rescate si existe; si no, volver a pie con el compañero desde cada celda.
    const campo = seguro.rescate || seguro.regreso;
    let conPlan = 0;
    for (const i of celdas) if (campo[i] < Infinity) conPlan++;
    const pct = (100 * conPlan) / celdas.length;
    controles.push(control("plan_rescate", "Plan de rescate en toda la ruta", pct, 100, conPlan === celdas.length && personas >= 2, "%", null,
      (seguro.rescate ? "Celdas de la ruta con rescate del compañero posible." : "Celdas de la ruta con regreso a pie junto al compañero dentro del límite.")
      + " Exige pareja. Un tripulante que no puede caminar necesita otro vehículo: no está modelado (a calibrar)."));
  } else {
    const tReg = maxEn("reg") / 60 + ingreso;
    controles.push(control("regreso_emergencia", "Regreso de emergencia con el oxígeno secundario", tReg, v(r.regreso_emergencia_max_min),
      tReg <= v(r.regreso_emergencia_max_min), "min", r.regreso_emergencia_max_min,
      `Peor punto de la ruta, por el mejor camino de vuelta, más ${ingreso} min de ingreso al refugio.` + textoInc));
    const tRes = maxEn("res") / 60 + ingreso;
    controles.push(control("rescate", "Rescate de un compañero incapacitado", tRes, v(r.rescate_max_min),
      tRes <= v(r.rescate_max_min), "min", r.rescate_max_min,
      `Arrastre a ${v(r.rescate_factor_velocidad) * 100} % de la velocidad y pendiente de mapa ≤ ${v(r.rescate_pendiente_max_grados)}° (propuesta del equipo), más ${ingreso} min de ingreso.` + textoInc));
    const peor = peorS / 60 + ingreso;
    const limiteConsumibles = v(r.consumibles_primarios_h) * 60;
    controles.push(control("consumibles", "Consumibles con colchón de regreso", peor, limiteConsumibles, peor <= limiteConsumibles, "min",
      r.colchon_regreso, `Tiempo transcurrido + ${coma(colchon)} × regreso + ${ingreso} min de ingreso, en el peor momento de la ida, del fin de los ${destinoMin} min de trabajo en el destino${recorrido?.idaYVuelta ? " y de la vuelta" : ""}; la hora de contingencia no se usa.`));
    const vuelta = recorrido?.idaYVuelta ? pt[pt.length - 1] - finTrabajo : finRegreso;
    const total = (finTrabajo + vuelta + ingreso * 60) / 3600;
    controles.push(control("duracion", "Duración total (ida, trabajo, vuelta e ingreso)", total, v(r.consumibles_primarios_h),
      total <= v(r.consumibles_primarios_h), "h", r.consumibles_primarios_h, `Incluye ${destinoMin} min en el destino, ${textoVuelta} y ${ingreso} min de ingreso al refugio.`));
    const personas = r.tripulacion?.valor ?? 2;
    controles.push(control("pareja", "Salida en pareja (o más)", personas, 2, personas >= 2, "astronautas", null,
      "Regla de NASA: nunca un astronauta solo. Los márgenes se calculan para la pareja."));
  }
  controles.push(control("pendiente", "Pendiente máxima del mapa en la ruta", ruta.pendMax, limitePendiente.valor,
    ruta.pendMax <= limitePendiente.valor + 1e-9, "°", { base: "medicion_propia", fuente: limitePendiente.fuente }));

  // Datos del terreno: ninguna celda de la ruta sin dato válido y pocas celdas sin dato alrededor.
  const pDatos = r.sin_dato_max_pct ?? pie.sin_dato_max_pct;
  if (zona && pDatos) {
    let enRuta = 0, peorPct = 0;
    for (const i of celdas) {
      if (sinDato(i)) enRuta++;
      const e = entorno(i);
      if (e.total) peorPct = Math.max(peorPct, (100 * e.malas) / e.total);
    }
    controles.push(control("terreno_datos", "Datos válidos del terreno en la ruta y alrededor", peorPct, v(pDatos), enRuta === 0 && peorPct <= v(pDatos), "%", pDatos,
      `${enRuta} celdas de la ruta sin dato válido (no se admite ninguna). Peor entorno: celdas sin dato a ${coma(radioDatos * zona.paso, 0)} m a la redonda de una celda de la ruta.`));
  }

  // Suelo blando probable (capa modelada): aviso, no bloqueo, porque el dato es indirecto.
  const sb = r.suelo_blando_max_m;
  if (sb && Number.isFinite(ruta.blandoM)) {
    controles.push(control("suelo_blando", "Suelo blando probable en la ruta", ruta.blandoM, v(sb), ruta.blandoM <= v(sb), "m", sb,
      "Térmico de noche (THEMIS) + textura (HiRISE). Revisar en el lugar antes de pisar.", true));
  }

  // Posición exacta del peor control espacial para orientar un desvío o un refugio nuevo.
  for (const [id, clave] of [["regreso_emergencia", "reg"], ["rescate", "res"], ["regreso_a_pie", "reg"]]) {
    const c = controles.find((x) => x.id === id);
    if (!c || !zona) continue;
    let peor = celdas[0];
    for (const i of celdas) if (entorno(i)[clave] > entorno(peor)[clave]) peor = i;
    c.punto = { celda: peor, f: Math.floor(peor / zona.ancho), c: peor % zona.ancho };
  }
  if (zona) for (const id of ["consumibles", "regreso_a_pie_consumibles"]) {
    const c = controles.find((x) => x.id === id);
    if (c) c.punto = { celda: peorConsumibles, f: Math.floor(peorConsumibles / zona.ancho), c: peorConsumibles % zona.ancho };
  }
  controles.push(...extra);
  return { decision: decidir(controles), controles };
}

// Celdas de la recta entre dos celdas (Bresenham, vecinas en 8 direcciones), extremos incluidos.
export function celdasRecta(a, b, ancho) {
  const celdas = [];
  let f = a.f, c = a.c;
  const df = Math.abs(b.f - a.f), dc = Math.abs(b.c - a.c);
  const sf = a.f < b.f ? 1 : -1, sc = a.c < b.c ? 1 : -1;
  let err = dc - df;
  for (;;) {
    celdas.push(f * ancho + c);
    if (f === b.f && c === b.c) break;
    const e2 = 2 * err;
    if (e2 > -df) { err -= df; c += sc; }
    if (e2 < dc) { err += dc; f += sf; }
  }
  return celdas;
}

// Verifica tramos trazados a mano. Cada tramo: { desde, hasta, celdas? } (celdas si ya fue ajustado).
// Devuelve, por tramo, si es apto y por qué no: terreno (pendiente, rugosidad, sin datos), diagonal que
// corta la esquina de terreno prohibido, o fuera de la zona segura (sin regreso de emergencia a tiempo
// o sin rescate posible).
export function verificarTramos(zona, seguro, traje, tramos) {
  const limP = traje.pendiente_max_grados.valor;
  const limR = traje.rugosidad_max_cm.valor / 100;
  const malo = (i) => !zona.valido[i] || !(zona.pendiente[i] <= limP) || !(zona.rugosidad[i] <= limR);
  return tramos.map((t) => {
    const celdas = t.celdas || celdasRecta(t.desde, t.hasta, zona.ancho);
    const motivos = new Map();
    const anotar = (tipo, texto, i) => {
      const m = motivos.get(tipo) || { tipo, texto, celdas: 0, primera: { f: (i / zona.ancho) | 0, c: i % zona.ancho } };
      m.celdas++;
      motivos.set(tipo, m);
    };
    let previa = -1;
    for (const i of celdas) {
      if (!zona.valido[i]) anotar("sin_dato", "sin datos del modelo de terreno", i);
      else if (!(zona.pendiente[i] <= limP)) anotar("pendiente", `pendiente mayor a ${coma(limP)}°`, i);
      else if (!(zona.rugosidad[i] <= limR)) anotar("rugosidad", `suelo más áspero que ${traje.rugosidad_max_cm.valor} cm`, i);
      else if (!seguro.permitido[i]) {
        if (!Number.isFinite(seguro.regreso[i])) anotar("regreso", "fuera del alcance de regreso de emergencia", i);
        else anotar("rescate", "fuera del alcance de rescate del compañero", i);
      }
      // Misma regla que las rutas calculadas: una diagonal no pasa entre dos celdas si alguna está prohibida.
      if (previa >= 0) {
        const fa = (previa / zona.ancho) | 0, ca = previa % zona.ancho, fb = (i / zona.ancho) | 0, cb = i % zona.ancho;
        if (fa !== fb && ca !== cb && (malo(fa * zona.ancho + cb) || malo(fb * zona.ancho + ca))) anotar("esquina", "corta la esquina de terreno prohibido", i);
      }
      previa = i;
    }
    const lista = [...motivos.values()].map((m) => ({ ...m, metros: m.celdas * zona.paso }));
    return { celdas, ok: lista.length === 0, motivos: lista, ajustado: !!t.celdas };
  });
}

// Planificador puro por etiquetas: cada rama conserva su jornada y su propio stock.
// No se colapsan dos llegadas a una base si dejan recursos u horarios diferentes.
// Las aristas son dirigidas (Tobler cambia con el sentido); el último objetivo sin
// refugio vuelve al nodo de salida del tramo. El inventario de entrada no se modifica.
export function planificarBases({ zona, grilla, cfg, data, contextoInicial = null }) {
  const r = cfg.riesgo.pie, cons = data.consumibles, p = data.planificacion;
  if (!cons || !p) throw new Error("Falta la configuración de consumibles o de jornadas.");
  const personas = r.tripulacion?.valor ?? 2, solS = v(p.sol_s);
  const jornada = v(p.jornada_eva_h) * 3600 - v(p.margen_jornada_min) * 60;
  const recargaS = v(r.recarga_refugio_min) * 60, ingresoS = v(r.ingreso_refugio_min) * 60;
  const fecha = data.instante, hora = data.horaSalida ?? v(p.hora_salida_lmst);
  if (!Number.isFinite(fecha) || !Number.isFinite(hora) || hora < 0 || hora >= 24 || !(jornada > 0) || !(solS > 0)) {
    throw new Error("Fecha, hora de salida o jornada inválida.");
  }
  const inventario = (n) => Object.fromEntries(Object.entries(n.datos || {}).map(([k, x]) => [k, x?.valor ?? x]));
  const aptitud = (n, stock) => {
    try {
      return { recarga: alcanzaParaRecargar(stock, null, personas, cons),
        refugio: ["habitat", "refugio"].includes(n.tipo) ? sirveDeRefugio(stock, personas, cons) : null };
    } catch (e) { return { recarga: { ok: false }, refugio: null, error: e.message }; }
  };
  const misma = (a, b) => a.f === b.f && a.c === b.c;
  const originales = data.nodos || [], excluidas = [], aceptadas = [];
  const enZona = (n) => Number.isInteger(n.f) && Number.isInteger(n.c) && n.f >= 0 && n.c >= 0 && n.f < zona.alto && n.c < zona.ancho;
  if (!enZona(data.inicio) || !enZona(data.fin)) throw new Error("Inicio o destino fuera de la zona.");
  const ids = new Set();
  for (const n of originales) {
    if (ids.has(n.id)) throw new Error("Hay bases con identificadores repetidos.");
    ids.add(n.id);
    const stock = inventario(n), e = aptitud(n, stock);
    if (!enZona(n) || !["habitat", "refugio", "deposito"].includes(n.tipo) || (!e.recarga.ok && !e.refugio?.ok)) {
      excluidas.push({ id: n.id, nombre: n.nombre, motivo: !enZona(n) ? "Fuera de la zona." : e.error || e.refugio?.motivo
        || `Stock insuficiente para recargar: ${(e.recarga.faltan || []).map((f) => f.recurso).join(", ")}.` });
    } else aceptadas.push({ ...n, datos: stock });
  }
  const origenReal = originales.find((n) => n.id === data.baseId) || originales.find((n) => misma(n, data.inicio));
  const inicio = { ...(origenReal || {}), ...data.inicio, id: origenReal?.id || "_inicio", nombre: data.nombreInicio || origenReal?.nombre || "Base" };
  const destinoReal = aceptadas.find((n) => (n.id === data.destinoId || misma(n, data.fin)) && aptitud(n, n.datos).refugio?.ok);
  const fin = { ...(destinoReal || {}), ...data.fin, id: destinoReal?.id || "_fin", nombre: data.nombreFin || destinoReal?.nombre || "Destino", final: true };
  if (fin.id === inicio.id) fin.id = "_fin";
  const nodos = [inicio, ...aceptadas.filter((n) => !misma(n, inicio) && !misma(n, fin)), fin];
  const stockInicial = Object.fromEntries(aceptadas.map((n) => [n.id, { ...n.datos }]));
  if (origenReal) stockInicial[inicio.id] = inventario(origenReal);
  const recursos = ["oxigeno_kg", "agua_l", "comida_kcal", "energia_kwh", "filtros_co2_h"];
  const necesidad = {
    oxigeno_kg: v(cons.traje.oxigeno_primario_kg) + v(cons.traje.oxigeno_secundario_kg),
    agua_l: (v(cons.traje.agua_enfriamiento_kg) + v(cons.traje.agua_potable_kg)) / v(cons.conversiones.agua_kg_por_litro),
    comida_kcal: 0, energia_kwh: v(cons.traje.bateria_wh) / 1000,
    filtros_co2_h: v(cons.traje.absorcion_co2_kg) / (v(cons.refugio.co2_kg_dia) / 24),
  };
  const copiar = (s) => Object.fromEntries(Object.entries(s).map(([id, x]) => [id, { ...x }]));
  const descontar = (stock, pedido) => {
    if (!recursos.every((k) => pedido[k] === 0 || (Number.isFinite(stock?.[k]) && stock[k] >= pedido[k]))) return false;
    for (const k of recursos) if (pedido[k]) stock[k] -= pedido[k];
    return true;
  };
  const reserva = (n, stock) => aptitud(n, stock).refugio?.ok === true;
  const cacheLuz = new Map();
  const presupuesto = (n, dia) => {
    const clave = `${n.id}:${dia}`;
    if (cacheLuz.has(clave)) return cacheLuz.get(clave);
    const lugar = celdaALonLat(zona.meta, n.f, n.c);
    const luz = amanecerAtardecer(fecha + (dia - 1) * solS * 1000, lugar.lon, lugar.lat);
    const margen = v(p.margen_luz_min) / 60;
    if (luz.estado === "dia_polar") { const b = { desde: hora, hasta: 24 }; cacheLuz.set(clave, b); return b; }
    if (luz.amanecer === null || luz.atardecer === null) { const b = { desde: 24, hasta: 0 }; cacheLuz.set(clave, b); return b; }
    const desde = Math.max(hora, luz.amanecer + margen), hasta = luz.atardecer - margen;
    const b = { desde, hasta }; cacheLuz.set(clave, b); return b;
  };
  const campos = new Map(), aristas = new Map(), fallos = [];
  const campoPara = (stock) => {
    const refugios = nodos.filter((n) => stock[n.id] && reserva(n, stock[n.id]));
    // La base manual conserva el contrato anterior: se presume punto de salida con trajes cargados.
    if (!origenReal) refugios.push(inicio);
    const clave = refugios.map((n) => n.id).sort().join(";");
    if (!campos.has(clave)) {
      // Se conserva una sola pareja de campos grandes, no una copia por rama del grafo.
      campos.clear();
      const firma = (bases) => [...new Set(bases.map((n) => `${n.f},${n.c}`))].sort().join(";");
      const reutilizar = contextoInicial && firma(contextoInicial.bases) === firma(refugios);
      const seguro = reutilizar ? contextoInicial.seguro : zonaSegura(zona, grilla, "pie", cfg.pie, cfg.riesgo, refugios);
      campos.set(clave, { seguro, plan: reutilizar ? contextoInicial.plan : prepararPlanSeguro(zona, grilla, seguro, cfg, true) });
    }
    return { ...campos.get(clave), clave };
  };
  const fallo = (a, b, motivo, punto = b, controles = []) => ({ desde: a.nombre, hasta: b.nombre, desdeId: a.id, hastaId: b.id, motivo,
    punto: { f: punto.f, c: punto.c, celda: punto.f * zona.ancho + punto.c }, controles,
    sugerencia: "Revisá un hábitat o refugio con plazas, stock y acceso de rescate cerca de este punto; hay que recalcular para confirmarlo." });
  const arista = (a, b, stock) => {
    const { seguro, plan, clave } = campoPara(stock), llave = `${clave}|${a.id}>${b.id}`;
    if (aristas.has(llave)) return aristas.get(llave);
    const ruta = buscarRuta(zona, plan, cfg.traje, data.perfiles[0], a, b);
    let resultado = null;
    if (!ruta.celdas) {
      // Diagnóstico con el terreno apto: ubica la primera celda que la seguridad impide cruzar.
      const terreno = buscarRuta(zona, grilla, cfg.traje, data.perfiles[0], a, b);
      const i = terreno.celdas?.find((j) => plan.prohibido[j] || (plan.admite && !plan.admite(j)));
      const punto = i == null ? b : { f: Math.floor(i / zona.ancho), c: i % zona.ancho };
      const causa = i == null ? "Regreso o rescate sin margen para la incertidumbre de posición."
        : !Number.isFinite(seguro.regreso[i]) ? "Sin regreso de emergencia dentro del límite."
          : !Number.isFinite(seguro.rescate[i]) ? "Sin rescate del compañero dentro del límite."
            : "Rescate o regreso sin margen para la incertidumbre de posición.";
      fallos.push(fallo(a, b, terreno.celdas ? causa : "Terreno prohibido o peligro: un refugio por sí solo no abre un camino.", punto));
    } else {
      const tIda = tiemposIda(zona, cfg.traje.velocidad, ruta.celdas);
      const minutos = b.final && !destinoReal ? v(r.tiempo_en_destino_min) : 0;
      const vuelta = b.final && !destinoReal;
      let celdas = ruta.celdas.slice(), t = Array.from(tIda);
      if (minutos) { celdas.push(celdas.at(-1)); t.push(t.at(-1) + minutos * 60); }
      if (vuelta) {
        const c = ruta.celdas.slice().reverse(), tv = tiemposIda(zona, cfg.traje.velocidad, c), base = t.at(-1);
        celdas.push(...c.slice(1)); t.push(...Array.from(tv).slice(1).map((s) => base + s));
      }
      const sim = { celdas, t, regreso: celdas.map((i) => Number.isFinite(seguro.regreso[i]) ? seguro.regreso[i] : null),
        rescate: celdas.map((i) => Number.isFinite(seguro.rescate[i]) ? seguro.rescate[i] : null), idaYVuelta: vuelta,
        minutosDestino: minutos, finIda: ruta.celdas.length - 1 };
      const evaluacion = evaluarSalida({ ruta, tIda, seguro, riesgo: cfg.riesgo, vehiculo: "pie", limitePendiente: cfg.limitePendiente,
        tiempoDestinoMin: minutos, extra: data.controlesDia || [], zona, recorrido: sim });
      const malos = evaluacion.controles.filter((c) => !c.ok && !c.aviso);
      const d = [0];
      for (let k = 1; k < celdas.length; k++) {
        const i = celdas[k - 1], j = celdas[k];
        d.push(d.at(-1) + zona.paso * Math.hypot(Math.floor(i / zona.ancho) - Math.floor(j / zona.ancho), i % zona.ancho - j % zona.ancho));
      }
      const probabilidad = data.confiabilidad ? evaluarConfiabilidad({ ruta: { ...sim, d }, cfg: data.confiabilidad, limites: {
        vehiculo: "pie", primario_s: v(r.consumibles_primarios_h) * 3600, secundario_s: v(r.regreso_emergencia_max_min) * 60,
        ingreso_s: ingresoS, colchon: v(r.colchon_regreso), rescate_max_s: v(r.rescate_max_min) * 60,
        tormenta_refugio_s: v(r.tormenta_refugio_min) * 60, mochila_s: v(r.regreso_emergencia_max_min) * 60,
      } }) : null;
      const c = evaluacion.controles.find((c) => c.id === "consumibles");
      let exposicion = 0;
      const limReg = v(r.regreso_emergencia_max_min) * 60 - ingresoS, limRes = v(r.rescate_max_min) * 60 - ingresoS;
      for (let k = 1; k < celdas.length; k++) exposicion += (t[k] - t[k - 1])
        * Math.max(seguro.regreso[celdas[k]] / limReg, seguro.rescate[celdas[k]] / limRes);
      resultado = { desde: a.id, hasta: b.id, nombreDesde: a.nombre, nombreHasta: b.nombre,
        celdas: ruta.celdas, sim, evaluacion, controles: evaluacion.controles, probabilidad, ok: evaluacion.decision === "SI",
        distancia: d.at(-1), tiempo: t.at(-1) - minutos * 60, duracion_s: t.at(-1) + ingresoS,
        // Sin tasas de falla se ordena por exposición normalizada, sin inventar probabilidades.
        margenMin: c.umbral - c.valor, riesgo: probabilidad ? -Math.log(Math.max(Number.MIN_VALUE, probabilidad.probabilidad_supervivencia)) : exposicion };
      if (malos.length) fallos.push(fallo(a, b, malos.map((c) => c.nombre).join(", "), malos.find((c) => c.punto)?.punto || b, malos));
    }
    aristas.set(llave, resultado);
    return resultado;
  };
  const primero = { nodo: inicio, dia: 1, usado: 0, stock: stockInicial, visitados: new Set([inicio.id]), tramos: [], pernoctes: [], recargas: [], riesgo: 0, total: 0 };
  const cola = [primero], etiquetas = new Map();
  const menor = (a, b) => a.riesgo < b.riesgo || (a.riesgo === b.riesgo && a.total < b.total);
  let ganador = null, explorados = 0, incompleta = false;
  while (cola.length) {
    if (++explorados > v(p.max_estados)) { incompleta = true; break; }
    let k = 0;
    for (let j = 1; j < cola.length; j++) if (menor(cola[j], cola[k])) k = j;
    const e = cola.splice(k, 1)[0], a = e.nodo;
    if (a.final) { ganador = e; break; }
    for (const b of nodos) {
      if (e.visitados.has(b.id)) continue;
      for (const dormir of [false, true]) {
        if (dormir && (!e.tramos.length || !e.stock[a.id] || !reserva(a, e.stock[a.id]))) continue;
        const stock = copiar(e.stock), dia = e.dia + (dormir ? 1 : 0);
        let usado = dormir ? 0 : e.usado, espera = 0, pernocte = null, recarga = null;
        if (dormir) {
          const h = Math.max(v(cons.refugio_minimo_h), solS / 3600);
          const detalle = autonomia(stock[a.id], personas, cons).detalle;
          const pedido = Object.fromEntries(recursos.map((k) => [k, detalle[k].consumo_por_h * h]));
          if (!descontar(stock[a.id], pedido) || !reserva(a, stock[a.id])) {
            fallos.push(fallo(a, b, "Stock insuficiente para el pernocte y la reserva de rescate posterior.", a)); continue;
          }
          espera = solS - e.usado;
          pernocte = { id: a.id, nombre: a.nombre, dia: e.dia, horas: h, consumo: pedido };
        }
        if (e.tramos.length) {
          const pedido = Object.fromEntries(recursos.map((k) => [k, necesidad[k] * personas]));
          if (!stock[a.id] || !descontar(stock[a.id], pedido) || (["habitat", "refugio"].includes(a.tipo) && !reserva(a, stock[a.id]))) {
            fallos.push(fallo(a, b, `Stock insuficiente para recargar y conservar ${v(cons.refugio_minimo_h)} h de refugio para la tripulación.`, a)); continue;
          }
          usado += recargaS;
          recarga = { id: a.id, nombre: a.nombre, dia, segundos: recargaS, consumo: pedido };
        }
        // La salida inicial usa los trajes cargados. Una base conocida debe tener reserva acreditada.
        if (!e.tramos.length && origenReal && !reserva(a, stock[a.id])) {
          fallos.push(fallo(a, b, "La base elegida no tiene plazas y stock de refugio suficientes.", a)); continue;
        }
        const t = arista(a, b, stock);
        if (!t?.ok) continue;
        const luzA = presupuesto(a, dia), luzB = presupuesto(b, dia);
        const horaDia = dormir || !e.tramos.length ? Math.max(luzA.desde, luzB.desde) : e.horaDia;
        const disponible = Math.max(0, Math.min(jornada, (Math.min(luzA.hasta, luzB.hasta) - horaDia) * solS / 24));
        const luz = control("luz_jornada", "Jornada acumulada y luz de día", (usado + t.duracion_s) / 3600,
          disponible / 3600, horaDia + usado * 24 / solS >= Math.max(luzA.desde, luzB.desde) && usado + t.duracion_s <= disponible, "h", p.margen_luz_min,
          `Día ${dia}. Incluye marcha, trabajo, regreso final, ingreso y recargas; margen de jornada y luz de config/rutas.json. Modelo, a calibrar; no certifica sombras locales.`);
        if (!luz.ok) { fallos.push(fallo(a, b, "El tramo no entra en la jornada o la luz disponible; hace falta pernoctar antes.", a, [luz])); continue; }
        if (!b.final && (!stock[b.id] || !aptitud(b, stock[b.id]).recarga.ok)) {
          fallos.push(fallo(a, b, "El nodo de llegada no tiene stock para la siguiente recarga.", b)); continue;
        }
        const siguiente = { nodo: b, dia, horaDia, usado: usado + t.duracion_s, stock,
          visitados: new Set([...e.visitados, b.id]),
          tramos: [...e.tramos, { ...t, dia, controles: [...t.controles, luz], evaluacion: { ...t.evaluacion, controles: [...t.controles, luz] },
            salida_lmst: horaDia + usado * 24 / solS, llegada_lmst: horaDia + (usado + t.duracion_s) * 24 / solS,
            recarga: recarga?.nombre || null, pernocte: pernocte?.nombre || null }],
          pernoctes: pernocte ? [...e.pernoctes, pernocte] : e.pernoctes,
          recargas: recarga ? [...e.recargas, recarga] : e.recargas,
          riesgo: e.riesgo + t.riesgo, total: e.total + espera + t.duracion_s + (recarga ? recargaS : 0) };
        // Dominancia solo con el mismo stock, día y conjunto de nodos visitados.
        const firma = JSON.stringify([b.id, dia, [...siguiente.visitados].sort(), stock]);
        const anteriores = etiquetas.get(firma) || [];
        if (anteriores.some((x) => x.usado <= siguiente.usado && x.riesgo <= siguiente.riesgo && x.total <= siguiente.total)) continue;
        etiquetas.set(firma, [...anteriores.filter((x) => !(siguiente.usado <= x.usado && siguiente.riesgo <= x.riesgo && siguiente.total <= x.total)), siguiente]);
        cola.push(siguiente);
      }
    }
  }
  const directa = arista(inicio, fin, stockInicial);
  const luzInicio = presupuesto(inicio, 1), luzFin = presupuesto(fin, 1);
  const limiteDirecto = Math.max(0, Math.min(jornada, (Math.min(luzInicio.hasta, luzFin.hasta) - Math.max(luzInicio.desde, luzFin.desde)) * solS / 24));
  const cadena = ganador ? { paradas: [inicio.nombre, ...ganador.tramos.map((t) => t.nombreHasta)], tramos: ganador.tramos,
    dias: ganador.dia, pernoctes: ganador.pernoctes, recargas: ganador.recargas.length, detalleRecargas: ganador.recargas,
    total_s: ganador.total, marcha_s: ganador.tramos.reduce((s, t) => s + t.tiempo, 0),
    distancia: ganador.tramos.reduce((s, t) => s + t.distancia, 0), stockRestante: ganador.stock,
    margenMin: Math.min(...ganador.tramos.map((t) => t.margenMin)),
    probabilidad_supervivencia: data.confiabilidad ? Math.exp(-ganador.riesgo) : null } : null;
  // El primer fallo desde la última base alcanzada es más útil que una arista remota.
  const alcanzadas = new Set([inicio.id, ...[...etiquetas.values()].flat().map((e) => e.nodo.id)]);
  const relevantes = fallos.filter((f) => alcanzadas.has(f.desdeId));
  const distanciaFin = (id) => { const n = nodos.find((n) => n.id === id); return Math.hypot(n.f - fin.f, n.c - fin.c); };
  relevantes.sort((a, b) => distanciaFin(a.desdeId) - distanciaFin(b.desdeId));
  const diagnostico = relevantes.find((f) => f.hastaId === fin.id) || relevantes[0] || null;
  return { recomendada: ganador ? ganador.tramos.length > 1 ? "bases" : "directa" : "ninguna", cadena,
    directo: directa ? { ok: directa.ok && directa.duracion_s <= limiteDirecto && (!origenReal || reserva(inicio, stockInicial[inicio.id])),
      tiempo: directa.tiempo, margenMin: directa.margenMin } : null,
    consideradas: aceptadas.filter((n) => !misma(n, inicio) && !misma(n, fin)).length, recibidas: originales.length, excluidas,
    recargaMin: recargaS / 60, diagnostico, incompleta, explorados,
    motivo: ganador ? `Ruta aprobada en ${ganador.dia} ${ganador.dia === 1 ? "día" : "días"} por: ${[inicio.nombre, ...ganador.tramos.map((t) => `${t.nombreHasta} (día ${t.dia})`)].join(" → ")}.`
      : incompleta ? "Búsqueda incompleta: se agotó el presupuesto configurado de estados. No se descarta que exista una ruta."
        : diagnostico ? `${diagnostico.desde} → ${diagnostico.hasta}: ${diagnostico.motivo}` : "No se encontró una cadena aprobada.",
    aviso: "Terreno NASA/USGS; trayectos, consumos, inventarios, jornadas y probabilidades modelados. Parámetros propuestos, a calibrar. La probabilidad combina solo las EVA y no evalúa la estadía en los refugios. La salida inicial supone trajes cargados." };
}
