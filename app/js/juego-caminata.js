// Motor de caminata libre. Puro: estado explícito, sin DOM, red ni reloj global.
import { velocidad } from "./ruteo.js";
import { perfilRuta } from "./consumibles.js";
import { crearMotor, recursosTraje } from "./motor-simulacion.js";

export const valorJuego = (cfg, clave) => {
  const v = cfg?.[clave]?.valor;
  if (v === undefined) throw new Error(`Falta configuración: ${clave}.`);
  return v;
};
const grados = Math.PI / 180;
export const angularJuego = (a) => ((a + 180) % 360 + 360) % 360 - 180;
export const celdaJuego = (zona, p) => Math.round(p.f) * zona.ancho + Math.round(p.c);
export const puntoJuego = (zona, i) => ({ f: Math.floor(i / zona.ancho), c: i % zona.ancho });
const distancia = (a, b, paso) => Math.hypot(a.f - b.f, a.c - b.c) * paso;
const rumboEntre = (a, b) => (Math.atan2(b.c - a.c, a.f - b.f) / grados + 360) % 360;
const altura = (z, p) => z.elevacion?.[celdaJuego(z, p)];
const copiado = (e) => ({ ...e, real: { ...e.real }, estimada: { ...e.estimada }, o2: { ...e.o2 },
  recursos: e.recursos.map((r) => ({ ...r })), mediciones: [...e.mediciones], fotos: [...e.fotos], muestras: [...e.muestras],
  fallas: [...e.fallas], plazos: { ...e.plazos }, bitacora: [...e.bitacora], trayectoria: [...e.trayectoria] });

export function desvioRuta(zona, ruta, p) {
  let mejor = { lateral_m: Infinity, indice: 0, rumbo: 0 };
  for (let k = 1; k < ruta.length; k++) {
    const a = puntoJuego(zona, ruta[k - 1]), b = puntoJuego(zona, ruta[k]);
    const df = b.f - a.f, dc = b.c - a.c, l2 = df * df + dc * dc;
    const u = l2 ? Math.max(0, Math.min(1, ((p.f - a.f) * df + (p.c - a.c) * dc) / l2)) : 0;
    const d = distancia(p, { f: a.f + df * u, c: a.c + dc * u }, zona.paso);
    if (d < mejor.lateral_m) mejor = { lateral_m: d, indice: k, rumbo: rumboEntre(a, b) };
  }
  return mejor;
}

export function crearJuego({ zona, ruta, cfg, riesgo, consumibles, ciencia, eventos = false }) {
  const s = ruta.sim ?? ruta;
  if (s.celdas?.length < 2 || !s.regreso || s.regreso.length !== s.celdas.length) throw new Error("Falta una ruta con regreso calculado.");
  const inicio = puntoJuego(zona, s.celdas[0]);
  if (!Number.isFinite(altura(zona, inicio))) throw new Error("El inicio no tiene relieve.");
  const v = (k) => valorJuego(cfg, k);
  const perfil = perfilRuta({ celdas: [s.celdas[0], s.celdas[0]], t: [0, 1], d: [0, 0],
    elevaciones: [altura(zona, inicio), altura(zona, inicio)], cfg: consumibles, personas: 1 });
  return { real: inicio, estimada: { ...inicio, error_m: v("error_inicial_m") }, rumbo: rumboEntre(inicio, puntoJuego(zona, s.celdas[1])),
    t: 0, distancia_m: 0, integral_desvio: 0, fuera_s: 0, semilla: v("semilla") >>> 0,
    proximoEvento: v("evento_desde_s"), eventos, polvo: false, fallas: [], plazos: {},
    o2: { primario_s: riesgo.pie.consumibles_primarios_h.valor * 3600, secundario_s: riesgo.pie.regreso_emergencia_max_min.valor * 60 },
    recursos: recursosTraje({ ...perfil, cfg: consumibles }).map((r) => ({ ...r, restante: r.capacidad })),
    base: inicio, ciencia: ciencia ?? puntoJuego(zona, s.celdas[s.finIda ?? Math.floor(s.celdas.length / 2)]),
    mediciones: [], fotos: [], muestras: [], bitacora: [], trayectoria: [], utiles: 0,
    regreso_s: s.regreso[0], veredicto: "CONTINUAR", aviso: "", fin: null };
}

function transitable(z, p, traje) {
  const f = Math.round(p.f), c = Math.round(p.c), i = f * z.ancho + c;
  return f >= 0 && c >= 0 && f < z.alto && c < z.ancho && z.valido[i] && !z.prohibido?.[i]
    && Number.isFinite(z.elevacion[i]) && z.pendiente[i] <= traje.pendiente_max_grados.valor
    && z.rugosidad[i] <= traje.rugosidad_max_cm.valor / 100;
}

// El motor existente evalúa fallas y descuenta recursos a la tasa del paso actual.
function consumir(e, dt, z, cfg, riesgo, consumibles, anterior, regreso_s) {
  const i = celdaJuego(z, e.real), j = celdaJuego(z, anterior), d = distancia(anterior, e.real, z.paso);
  const perfil = perfilRuta({ celdas: [j, i], t: [0, dt], d: [0, d], elevaciones: [altura(z, anterior), altura(z, e.real)], cfg: consumibles, personas: 1 });
  const r = riesgo.pie;
  const motor = crearMotor({ ruta: { celdas: [i, i], t: [0, dt + 1], d: [0, 0], regreso: [regreso_s, regreso_s],
    rescate: [null, null], tasaO2: perfil.tasaO2,
    recursos: recursosTraje({ ...perfil, cfg: consumibles }).map((a, k) => ({ ...a, capacidad: e.recursos[k].restante })) },
    cfg: { primario_s: e.o2.primario_s, secundario_s: e.o2.secundario_s, ingreso_s: r.ingreso_refugio_min.valor * 60,
      colchon: r.colchon_regreso.valor, margen_terminar_s: r.margen_terminar_min.valor * 60,
      rescate_max_s: e.plazos.companero ?? r.rescate_max_min.valor * 60,
      tormenta_refugio_s: e.plazos.tormenta ?? r.tormenta_refugio_min.valor * 60, caminata_max_s: null, vehiculo: "pie" } });
  for (const falla of e.fallas) motor.inyectar(falla);
  const m = motor.avanzar(dt);
  e.o2 = m.o2; e.recursos = m.recursos.map((r, k) => ({ ...r, capacidad: e.recursos[k].capacidad }));
  e.plazos = m.plazos; e.regreso_s = regreso_s; e.tasa = m.tasa; e.metabolismo_w = perfil.metabolismo_w[0];
  if (m.fin && m.limitante === "o2" && m.veredicto === "NO_ALCANZA") e.o2[e.fallas.includes("fuga") ? "secundario_s" : "primario_s"] = 0;
  e.veredicto = m.veredicto === "ESPERANDO_CAMINO" ? "ABORTAR" : m.veredicto;
  e.motivo = m.motivo;
  if (m.fin && m.veredicto === "NO_ALCANZA") e.fin = "recursos";
  if (m.fin && m.veredicto === "A_SALVO" && e.fallas.length) e.fin = "refugio";
  if (regreso_s === null || regreso_s + r.ingreso_refugio_min.valor * 60 > r.regreso_emergencia_max_min.valor * 60) e.veredicto = "ABORTAR";
  e.t += m.t;
}

export function pasoJuego(estado, { dt, avanzar = 0, girar = 0, trotar = false, regreso_s, segura = true }, contexto) {
  if (!Number.isFinite(dt) || dt < 0 || !Number.isFinite(avanzar + girar) || Math.abs(avanzar) > 1 || Math.abs(girar) > 1) throw new Error("Revisá tiempo y controles.");
  if (estado.fin || dt === 0) return estado;
  const { zona: z, ruta, cfg, riesgo, consumibles, traje } = contexto, v = (k) => valorJuego(cfg, k);
  const e = copiado(estado), celdas = (ruta.sim ?? ruta).celdas;
  let falta = dt;
  while (falta > 0 && !e.fin) {
    const h = Math.min(avanzar || girar ? Math.min(falta, v("paso_s")) : falta,
      e.eventos ? Math.max(v("paso_s"), e.proximoEvento - e.t) : Infinity);
    const anterior = { ...e.real };
    e.rumbo = (e.rumbo + girar * v("giro_grados_s") * h + 360) % 360;
    e.aviso = "";
    if (avanzar) {
      const r = e.rumbo * grados, direccion = avanzar < 0 ? -1 : 1;
      const muestra = { f: e.real.f - Math.cos(r) * direccion, c: e.real.c + Math.sin(r) * direccion };
      const pendiente = Number.isFinite(altura(z, muestra)) ? (altura(z, muestra) - altura(z, e.real)) / z.paso : 0;
      const parametros = Object.fromEntries(Object.entries(traje.velocidad).filter(([, a]) => a?.valor !== undefined).map(([k, a]) => [k, a.valor]));
      const largo = velocidad(pendiente, parametros) * (trotar ? v("trote") : 1) * Math.abs(avanzar) * h;
      const n = Math.max(1, Math.ceil(largo / (z.paso / 2)));
      for (let k = 0; k < n; k++) {
        const p = { f: e.real.f - Math.cos(r) * direccion * largo / n / z.paso, c: e.real.c + Math.sin(r) * direccion * largo / n / z.paso };
        const df = Math.round(p.f) !== Math.round(e.real.f), dc = Math.round(p.c) !== Math.round(e.real.c);
        if (!transitable(z, p, traje) || df && dc && (!transitable(z, { f: p.f, c: e.real.c }, traje) || !transitable(z, { f: e.real.f, c: p.c }, traje))) { e.aviso = "terreno"; break; }
        e.real = p;
      }
    }
    const d = distancia(anterior, e.real, z.paso), rumbo = rumboEntre(anterior, e.real) + v("deriva_rumbo_grados");
    e.estimada.f -= Math.cos(rumbo * grados) * d * (1 + v("deriva_pasos")) / z.paso;
    e.estimada.c += Math.sin(rumbo * grados) * d * (1 + v("deriva_pasos")) / z.paso;
    e.estimada.error_m = Math.sqrt(e.estimada.error_m ** 2 + v("deriva_error_m_raiz_s") ** 2 * h);
    e.distancia_m += d;
    const desvio = desvioRuta(z, celdas, e.real), estimado = desvioRuta(z, celdas, e.estimada);
    if (estimado.lateral_m > v("corredor_m") || !segura) e.aviso ||= "corredor";
    const sobre = desvio.indice, conocido = desvio.lateral_m <= z.paso ? (ruta.sim ?? ruta).regreso[sobre] : null;
    // Fuera de la ruta nunca extrapola un tiempo: exige un campo calculado por el worker.
    const regreso = regreso_s === undefined ? conocido : regreso_s;
    const antes = e.t;
    consumir(e, h, z, cfg, riesgo, consumibles, anterior, Number.isFinite(regreso) ? regreso : null);
    e.integral_desvio += desvio.lateral_m * (e.t - antes);
    if (desvio.lateral_m > v("corredor_m") || !segura) e.fuera_s += e.t - antes;
    if (e.eventos && e.t >= e.proximoEvento) {
      e.proximoEvento += v("evento_intervalo_s");
      e.semilla = (Math.imul(1664525, e.semilla) + 1013904223) >>> 0;
      if (e.semilla / 4294967296 < v("evento_probabilidad")) {
        if (!e.polvo) { e.polvo = true; e.bitacora.push({ t: e.t, tipo: "polvo" }); }
        else if (!e.fallas.includes("fuga")) { e.fallas.push("fuga"); e.bitacora.push({ t: e.t, tipo: "fuga" }); }
      }
    }
    if (!e.trayectoria.length || e.t - e.trayectoria.at(-1).t >= 5) e.trayectoria.push({ t: e.t, real: { ...e.real }, estimada: { ...e.estimada } });
    if (cienciaCompleta(e, cfg) && distancia(e.real, e.base, z.paso) <= v("radio_accion_m") && e.distancia_m > v("radio_accion_m") * 2 && e.veredicto !== "ABORTAR") e.fin = "victoria";
    falta = Math.max(0, falta - h);
  }
  return e;
}

export function corregirJuego(estado, resultado, { zona, cfg }, herramienta = "geoubicacion") {
  const p = resultado?.mejor, error = resultado?.error_m;
  if (!p || !Number.isFinite(p.f + p.c + error) || error <= 0 || p.f < 0 || p.c < 0 || p.f >= zona.alto || p.c >= zona.ancho) throw new Error("La fusión no devolvió una posición válida.");
  const e = copiado(estado), antes = e.estimada.error_m;
  e.estimada = { ...p, error_m: error };
  if (error < antes) e.utiles++;
  e.bitacora.push({ t: e.t, tipo: herramienta, antes_m: antes, despues_m: error, riesgo: "deriva" });
  return e;
}

export function registrarJuego(estado, tipo, datos = {}) {
  const e = copiado(estado);
  const id = datos.id ?? `${tipo}-${e.bitacora.length}`;
  if (e.mediciones.includes(id)) throw new Error("Esa medición ya se registró.");
  e.mediciones.push(id); e.bitacora.push({ t: e.t, tipo, ...structuredClone(datos), id });
  return e;
}

export function cienciaCompleta(e, cfg) { return e.fotos.length === valorJuego(cfg, "fotos_ciencia") && e.muestras.length === valorJuego(cfg, "muestras_ciencia"); }

export function trabajarJuego(estado, tipo, indice, contexto) {
  const { zona, cfg, riesgo } = contexto, v = (k) => valorJuego(cfg, k);
  if (estado.fin || distancia(estado.real, estado.ciencia, zona.paso) > v("radio_accion_m")) throw new Error("Acercate a la parada científica.");
  const limite = tipo === "foto" ? v("fotos_ciencia") : tipo === "muestra" ? v("muestras_ciencia") : 0;
  if (!Number.isInteger(indice) || indice < 0 || indice >= limite) throw new Error("Elegí un objetivo científico válido.");
  const lista = tipo === "foto" ? estado.fotos : estado.muestras;
  if (lista.includes(indice)) throw new Error("Ese objetivo ya está completo.");
  const objetivo = (indice * v("separacion_crestas_grados") + 360) % 360;
  if (tipo === "foto" && Math.abs(angularJuego(estado.rumbo - objetivo)) > v("reticula_grados")) throw new Error("Apuntá la retícula a la cresta marcada.");
  const e = pasoJuego(estado, { dt: riesgo.pie.tiempo_en_destino_min.valor * 60 / (v("fotos_ciencia") + v("muestras_ciencia")), regreso_s: estado.regreso_s }, contexto);
  if (e.fin) return e;
  (tipo === "foto" ? e.fotos : e.muestras).push(indice);
  e.bitacora.push({ t: e.t, tipo, indice, terreno: tipo === "muestra" && indice === limite - 1 ? "hueco" : "cresta" });
  return e;
}

export function resumenJuego(e, cfg) {
  const v = (k) => valorJuego(cfg, k), medio = e.t > 0 ? e.integral_desvio / e.t : 0;
  return { tiempo_s: e.t, distancia_m: e.distancia_m, desvio_medio_m: medio, fuera_s: e.fuera_s,
    puntaje: Math.max(0, Math.round(v("puntaje_base") - medio * v("penalizacion_desvio") - e.fuera_s * v("penalizacion_fuera_s") + e.utiles * v("premio_medida") + (cienciaCompleta(e, cfg) ? v("premio_ciencia") : 0))),
    estrellas: e.fin === "victoria" ? medio < v("estrella_tres_m") ? 3 : medio < v("estrella_dos_m") ? 2 : 1 : 0 };
}
