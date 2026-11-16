// Motor puro. EKF de posición local (este, norte), covarianza completa 2×2.
// La grilla aporta alturas y máscaras; no se recorta la media al camino ni a la verdad.
// La aproximación gaussiana local no representa ambigüedades ópticas multimodales.
import { crearMotor, recursosTraje } from "./motor-simulacion.js";
import { perfilRuta } from "./consumibles.js";
import { altura, celdaALonLat, lonLatACelda } from "./zona.js";
import { desnivel } from "./barometro.js";
import { posicionSol } from "./luz.js";

export const angular = (a) => ((a + 180) % 360 + 360) % 360 - 180;
const RADIO95 = Math.sqrt(-2 * Math.log(0.05)); // cuantil de gaussiana 2D, contrato estadístico
export function parametro(cfg, clave) {
  const x = cfg?.[clave]?.valor;
  if (!Number.isFinite(x) || x < 0) throw new Error(`Revisá la configuración de navegación: ${clave}.`);
  return x;
}
const finito = (x, nombre) => { if (!Number.isFinite(x)) throw new Error(`Revisá ${nombre}.`); return x; };
export const puntoCelda = (z, i) => ({ f: Math.floor(i / z.ancho), c: i % z.ancho });
export const alturaEn = (z, i) => z.elevacion ? z.elevacion[i] : altura(z.meta, z.crudo.elevQ[i]);

// Coordenadas continuas: la orto cubre los bordes de la grilla; f/c indican centros.
export function ventanaMapa(zona, posicion, { ancho, alto, alcance_m, rumbo = 0 }) {
  const [a, , , , e] = zona.meta.grilla.transform;
  const escala = ancho / alcance_m, angulo = -rumbo * Math.PI / 180;
  const cos = Math.cos(angulo), sin = Math.sin(angulo);
  const proyectar = (p) => {
    const x = (p.c - posicion.c) * Math.abs(a) * escala;
    const y = (p.f - posicion.f) * Math.abs(e) * escala;
    return [ancho / 2 + x * cos - y * sin, alto / 2 + x * sin + y * cos];
  };
  return { escala, angulo, proyectar, origen: proyectar({ f: -0.5, c: -0.5 }),
    ancho_mapa: zona.ancho * Math.abs(a) * escala, alto_mapa: zona.alto * Math.abs(e) * escala,
    // Rectángulo de origen sin rotar, expresado en fracción de la imagen.
    recorte: { x: (posicion.c + 0.5 - ancho / escala / Math.abs(a) / 2) / zona.ancho,
      y: (posicion.f + 0.5 - alto / escala / Math.abs(e) / 2) / zona.alto,
      ancho: ancho / escala / Math.abs(a) / zona.ancho, alto: alto / escala / Math.abs(e) / zona.alto } };
}

export function cintaRumbo(rumbo, objetivo, sol, campo, paso) {
  const marcas = [];
  for (let v = Math.ceil((rumbo - campo / 2) / paso) * paso; v <= rumbo + campo / 2; v += paso) {
    marcas.push({ grados: ((v % 360) + 360) % 360, x: (v - rumbo) / campo + 0.5 });
  }
  const posicion = (v) => ({ x: angular(v - rumbo) / campo + 0.5, visible: Math.abs(angular(v - rumbo)) <= campo / 2 });
  return { marcas, objetivo: posicion(objetivo), sol: posicion(sol) };
}

export function antenasDelPlan(zona, marcas = [], base = null, balizas = []) {
  const lista = [...marcas.filter((m) => ["habitat", "refugio", "baliza", "base"].includes(m.tipo)), ...balizas];
  if (base) lista.push({ ...base, tipo: "base" });
  const unicas = new Map();
  for (const m of lista) {
    const p = m.celda ?? (Number.isFinite(m.f + m.c) ? m : lonLatACelda(zona.meta, m.lon, m.lat));
    const f = Math.round(p.f), c = Math.round(p.c);
    if (Number.isFinite(f + c) && f >= 0 && c >= 0 && f < zona.alto && c < zona.ancho && zona.valido[f * zona.ancho + c]) {
      unicas.set(`${f},${c}`, { ...m, f, c, tipo: m.tipo === "baliza" ? "baliza" : "base" });
    }
  }
  return [...unicas.values()];
}

export function instanteSalidaNavegacion(zona, ruta, hora, ahora) {
  finito(ahora, "fecha de salida");
  const partes = /^(\d{2}):(\d{2})$/.exec(hora ?? "");
  if (!partes || +partes[1] >= 24 || +partes[2] >= 60) throw new Error("Revisá la hora solar de salida.");
  const p = puntoCelda(zona, (ruta.sim ?? ruta).celdas[0]), geo = celdaALonLat(zona.meta, p.f, p.c);
  const actual = posicionSol(ahora, geo.lon, geo.lat).lmst;
  return ahora + (+partes[1] + partes[2] / 60 - actual) * 1.0274912517 * 86400000 / 24;
}

export function configuracionMotor(riesgo) {
  const p = riesgo.pie;
  return { primario_s: p.consumibles_primarios_h.valor * 3600, secundario_s: p.regreso_emergencia_max_min.valor * 60,
    ingreso_s: p.ingreso_refugio_min.valor * 60, colchon: p.colchon_regreso.valor,
    margen_terminar_s: p.margen_terminar_min.valor * 60, rescate_max_s: p.rescate_max_min.valor * 60,
    tormenta_refugio_s: p.tormenta_refugio_min.valor * 60, caminata_max_s: null, vehiculo: "pie" };
}

export function validarArranque({ zona, ruta, aprobada } = {}) {
  if (!zona || zona.meta?.vehiculo === "rover") return { ok: false, codigo: "zona" };
  if (!(aprobada === true || ruta?.evaluacion?.decision === "SI" || ruta?.decision === "SI")) return { ok: false, codigo: "aprobacion" };
  const s = ruta?.sim ?? ruta;
  if (!s?.celdas?.length || !s.t || !s.regreso) return { ok: false, codigo: "ruta" };
  return { ok: true };
}

export function prepararRuta(zona, ruta, consumibles, personas) {
  const s = ruta.sim ?? ruta, celdas = Array.from(s.celdas), t = Array.from(s.t), n = celdas.length;
  if (!n || t.length !== n || s.regreso?.length !== n) throw new Error("La ruta necesita celdas, tiempos y regreso.");
  const d = [0];
  celdas.forEach((i, k) => {
    if (!Number.isInteger(i) || i < 0 || i >= zona.ancho * zona.alto || !zona.valido[i] || !Number.isFinite(alturaEn(zona, i))) throw new Error("La ruta sale del relieve válido.");
    if (!k) return;
    const a = puntoCelda(zona, celdas[k - 1]), b = puntoCelda(zona, i);
    if (Math.abs(a.f - b.f) > 1 || Math.abs(a.c - b.c) > 1) throw new Error("La ruta contiene saltos entre celdas.");
    d.push(d[k - 1] + Math.hypot(a.f - b.f, a.c - b.c) * zona.paso);
  });
  const perfil = perfilRuta({ celdas, t, d, elevaciones: celdas.map((i) => alturaEn(zona, i)), cfg: consumibles, personas });
  return { ...s, celdas, t, d, regreso: Array.from(s.regreso, (x) => Number.isFinite(x) ? x : null),
    rescate: s.rescate ? Array.from(s.rescate, (x) => Number.isFinite(x) ? x : null) : null,
    tasaO2: perfil.tasaO2, metabolismo_w: perfil.metabolismo_w, recursos: recursosTraje({ ...perfil, cfg: consumibles }) };
}

export function crearFiltro({ zona, inicio, cfg }) {
  let x = finito(inicio.c, "columna") * zona.paso, y = -finito(inicio.f, "fila") * zona.paso;
  let a = parametro(cfg, "sigma_inicial_m") ** 2, b = 0, d = a, fuente = "inicio", secuencia = 0, estima = false;
  const ids = new Set();
  function resumen() {
    const mayor = (a + d + Math.hypot(a - d, 2 * b)) / 2;
    return { f: -y / zona.paso, c: x / zona.paso, error_95_m: RADIO95 * Math.sqrt(Math.max(0, mayor)),
      covarianza: [a, b, d], fuente, secuencia, estima };
  }
  function predecir({ distancia_m, rumbo, dt_s }) {
    finito(distancia_m, "distancia"); finito(rumbo, "rumbo"); finito(dt_s, "tiempo");
    if (dt_s < 0 || distancia_m < 0) throw new Error("Distancia y tiempo deben ser positivos.");
    const r = rumbo * Math.PI / 180;
    x += distancia_m * Math.sin(r); y += distancia_m * Math.cos(r);
    const q = parametro(cfg, "ruido_proceso_m_raiz_s") ** 2 * dt_s
      + parametro(cfg, "deriva_pasos_fraccion") ** 2 * distancia_m * zona.paso;
    // Varianza por longitud, aditiva al dividir un intervalo en varios cuadros.
    a += q; d += q; estima = true;
    return resumen();
  }
  // Actualización escalar de Joseph: preserva covarianza semidefinida positiva.
  function escalar(residuo, hx, hy, sigma) {
    finito(residuo, "medida"); finito(sigma, "error");
    if (sigma <= 0) throw new Error("El error debe ser mayor que cero.");
    const u = a * hx + b * hy, v = b * hx + d * hy, s = hx * u + hy * v + sigma ** 2;
    const kx = u / s, ky = v / s;
    x += kx * residuo; y += ky * residuo;
    a = Math.max(0, a - u * u / s); b -= u * v / s; d = Math.max(0, d - v * v / s);
  }
  function corregir(m) {
    if (!m?.id || ids.has(m.id)) throw new Error("Cada lectura necesita un id único; no repitas medidas.");
    if (["posicion", "horizonte", "fusion"].includes(m.tipo)) {
      finito(m.f, "fila"); finito(m.c, "columna");
      if (m.f < 0 || m.c < 0 || m.f >= zona.alto || m.c >= zona.ancho) throw new Error("La corrección queda fuera de la zona.");
      const sigma = m.error_95_m / RADIO95;
      if (!(sigma > 0) || !Number.isFinite(sigma)) throw new Error("Falta el radio 95 % de la corrección.");
      escalar(m.c * zona.paso - x, 1, 0, sigma);
      escalar(-m.f * zona.paso - y, 0, 1, sigma);
    } else if (m.tipo === "radio" || m.tipo === "uwb") {
      if (!(m.sigma_m > 0) || !Number.isFinite(m.sigma_m) || !(m.distancia_m >= 0)) throw new Error("Revisá distancia y error de radio.");
      const dx = x - finito(m.base?.c, "baliza") * zona.paso, dy = y + finito(m.base?.f, "baliza") * zona.paso;
      const r = Math.hypot(dx, dy);
      if (r > 0) escalar(finito(m.distancia_m, "distancia") - r, dx / r, dy / r, m.sigma_m);
    } else if (m.tipo === "barometro") {
      const p = resumen(), f = Math.round(p.f), c = Math.round(p.c), i = f * zona.ancho + c;
      const z = alturaEn(zona, i), base = alturaEn(zona, Math.round(m.base.f) * zona.ancho + Math.round(m.base.c));
      const dz = desnivel({ ...m, cfg: m.cfgBarometro });
      if (f <= 0 || c <= 0 || f >= zona.alto - 1 || c >= zona.ancho - 1) throw new Error("Sin relieve para corregir presión.");
      const hx = (alturaEn(zona, i + 1) - alturaEn(zona, i - 1)) / (2 * zona.paso);
      const hy = (alturaEn(zona, i - zona.ancho) - alturaEn(zona, i + zona.ancho)) / (2 * zona.paso);
      if (Number.isFinite(hx + hy + z + base)) escalar(base + dz.dz - z, hx, hy, dz.sigma);
      else throw new Error("Sin relieve para corregir presión.");
    } else throw new Error("Usá «Geoubicación sin GPS» para este tipo de medida.");
    ids.add(m.id); fuente = m.fuente ?? m.tipo; secuencia++; estima = false;
    return resumen();
  }
  return { predecir, corregir, get estado() { return resumen(); } };
}

export function distanciaCorredor(zona, ruta, p) {
  let distancia = Infinity, indice = 0;
  for (let k = 1; k < ruta.celdas.length; k++) {
    const a = puntoCelda(zona, ruta.celdas[k - 1]), b = puntoCelda(zona, ruta.celdas[k]);
    const df = b.f - a.f, dc = b.c - a.c, largo = df * df + dc * dc;
    const u = largo ? Math.max(0, Math.min(1, ((p.f - a.f) * df + (p.c - a.c) * dc) / largo)) : 0;
    const d = Math.hypot(p.f - a.f - u * df, p.c - a.c - u * dc) * zona.paso;
    if (d < distancia) { distancia = d; indice = k; }
  }
  if (ruta.celdas.length === 1) {
    const a = puntoCelda(zona, ruta.celdas[0]); distancia = Math.hypot(p.f - a.f, p.c - a.c) * zona.paso;
  }
  return { distancia_m: distancia, indice };
}

export function crearNavegacion({ zona, ruta, cfg, riesgo, consumibles, escenario = {}, inicio_ms }) {
  finito(inicio_ms, "fecha de salida");
  const rutaMotor = prepararRuta(zona, ruta, consumibles, riesgo.pie.tripulacion?.valor ?? 1);
  const motor = crearMotor({ ruta: rutaMotor, cfg: configuracionMotor(riesgo) });
  const filtro = crearFiltro({ zona, inicio: puntoCelda(zona, rutaMotor.celdas[0]), cfg });
  const registro = [], hitos = [], avisados = new Set();
  const anotar = (tipo, datos) => registro.push({ t: motor.estado.t, tipo, datos: structuredClone(datos), posicion: filtro.estado });
  let ultima = puntoCelda(zona, rutaMotor.celdas[0]), rumbo = 0, sensorK = 0, eventosK = 0, distanciaSensor = 0, ruido = parametro(cfg, "semilla") >>> 0;
  let activo = rutaMotor, origenTiempo = 0, coberturaRadio = null, derivaRumbo = parametro(cfg, "deriva_rumbo_grados"), abortoOrdenado = false;
  const eventos = [...(escenario.eventos ?? [])].sort((a, b) => a.t_s - b.t_s);
  const aleatorio = () => { ruido = (1664525 * ruido + 1013904223) >>> 0; return (ruido + 0.5) / 4294967296; };
  const normal = () => Math.sqrt(-2 * Math.log(aleatorio())) * Math.cos(2 * Math.PI * aleatorio());
  let acumulado = parametro(cfg, "separacion_hitos_m");
  for (let k = 1; k < rutaMotor.d.length; k++) if (rutaMotor.d[k] >= acumulado) { hitos.push(k); acumulado += parametro(cfg, "separacion_hitos_m"); }
  if (!hitos.includes(rutaMotor.celdas.length - 1)) hitos.push(rutaMotor.celdas.length - 1);
  // El primer hito termina el primer tramo recto, antes de cualquier curva.
  const inicial = puntoCelda(zona, rutaMotor.celdas[0]);
  const siguiente = rutaMotor.celdas.find((i) => i !== rutaMotor.celdas[0]);
  if (siguiente !== undefined) {
    const p = puntoCelda(zona, siguiente), df = inicial.f - p.f, dc = p.c - inicial.c;
    rumbo = (Math.atan2(dc, df) * 180 / Math.PI + 360) % 360;
    for (let k = 2; k < rutaMotor.celdas.length; k++) {
      const a = puntoCelda(zona, rutaMotor.celdas[k - 1]), b = puntoCelda(zona, rutaMotor.celdas[k]);
      if (b.c === a.c && b.f === a.f) continue;
      if ((b.c - a.c) * df !== (a.f - b.f) * dc) { if (!hitos.includes(k - 1)) hitos.unshift(k - 1); break; }
    }
    hitos.sort((a, b) => a - b);
  }
  function verdad(e) {
    const k = e.k, a = puntoCelda(zona, activo.celdas[k] ?? e.celda), b = puntoCelda(zona, activo.celdas[k + 1] ?? e.celda);
    const t = e.t - origenTiempo, desde = activo.t[k], hasta = activo.t[k + 1];
    const u = hasta > desde ? Math.max(0, Math.min(1, (t - desde) / (hasta - desde))) : 0;
    return { f: a.f + (b.f - a.f) * u, c: a.c + (b.c - a.c) * u };
  }
  function corregir(m) { const p = filtro.corregir(m); anotar("correccion", m); return p; }
  function inyectar(tipo) { const r = motor.inyectar(tipo); anotar("falla", { tipo, ...r }); return r; }
  function estado() {
    const e = motor.estado, p = filtro.estado, corredor = distanciaCorredor(zona, rutaMotor, p);
    const i = Math.round(p.f) * zona.ancho + Math.round(p.c);
    const dentro = p.f >= 0 && p.c >= 0 && p.f < zona.alto && p.c < zona.ancho;
    const avisos = [];
    const aviso = (codigo, nivel) => avisos.push({ codigo, nivel });
    if (["ABORTAR", "NO_ALCANZA"].includes(e.veredicto)) aviso("aborto", 3);
    if (abortoOrdenado && !e.fin) aviso("aborto_ordenado", 3);
    if (e.regreso_s === null || e.regreso_s + riesgo.pie.ingreso_refugio_min.valor * 60 > riesgo.pie.regreso_emergencia_max_min.valor * 60) aviso("regreso", 3);
    if (!dentro || !zona.valido[i] || zona.prohibido?.[i]) {
      // Una media EKF sobre el borde no confirma que se haya pisado terreno prohibido.
      // Si su radio todavía toca la ruta aprobada, exige localizarse y pausar.
      aviso(corredor.distancia_m <= p.error_95_m ? "terreno_incierto" : "terreno", corredor.distancia_m <= p.error_95_m ? 2 : 3);
    }
    if (e.veredicto === "TERMINAR") aviso("terminar", 2);
    if (corredor.distancia_m > parametro(cfg, "corredor_m")) aviso("corredor", 2);
    if (p.error_95_m > riesgo.pie.incertidumbre_posicion_m.valor) aviso("localizar", 2);
    if (zona.blando?.[i]) aviso("blando", 1);
    if (coberturaRadio === false) aviso("radio", 2);
    avisos.sort((a, b) => b.nivel - a.nivel);
    for (const a of avisos) if (!avisados.has(a.codigo)) { avisados.add(a.codigo); anotar("aviso", a); }
    for (const id of [...avisados]) if (!avisos.some((a) => a.codigo === id)) avisados.delete(id);
    const h = e.enRegreso ? Math.min(e.k + 1, activo.celdas.length - 1) : hitos.find((k) => k > e.k) ?? hitos.at(-1);
    const objetivo = puntoCelda(zona, activo.celdas[h]), df = p.f - objetivo.f, dc = objetivo.c - p.c;
    const rumboObjetivo = df || dc ? (Math.atan2(dc, df) * 180 / Math.PI + 360) % 360 : rumbo;
    const recorrido = activo.d[e.k] + Math.hypot(verdad(e).f - puntoCelda(zona, e.celda).f, verdad(e).c - puntoCelda(zona, e.celda).c) * zona.paso;
    const geo = celdaALonLat(zona.meta, p.f, p.c), ms = inicio_ms + e.t * 1000;
    return { ...e, ...(abortoOrdenado && !e.fin && !e.pedirCamino ? { veredicto: "ABORTAR", nivel: "rojo" } : {}), posicion: p, verdad: verdad(e), rumbo, rumboObjetivo, giro: angular(rumboObjetivo - rumbo),
      hito: { k: h, ...objetivo, distancia_m: Math.hypot(df, dc) * zona.paso, tiempo_s: Math.max(0, activo.t[h] - (e.t - origenTiempo)) },
      destino_m: Math.max(0, activo.d.at(-1) - recorrido),
      destino_s: Math.max(0, activo.t.at(-1) - (e.t - origenTiempo)), corredor, avisos,
      sol: posicionSol(ms, geo.lon, geo.lat), geo, ms, radio: coberturaRadio,
      metabolismo_w: rutaMotor.metabolismo_w[Math.min(e.k, rutaMotor.metabolismo_w.length - 1)],
      sensores: { origen: "simulado", temperatura_traje_c: parametro(cfg, "temperatura_traje_c"),
        presion_traje_pa: parametro(cfg, "presion_traje_pa"), pulso_lpm: parametro(cfg, "pulso_reposo_lpm") + parametro(cfg, "pulso_por_tasa_lpm") * e.tasa } };
  }
  function avanzar(dt) {
    finito(dt, "tiempo"); if (dt < 0) throw new Error("Tiempo negativo.");
    let falta = dt;
    const paso = parametro(cfg, "paso_sensor_s"); if (!paso) throw new Error("Intervalo de sensores nulo.");
    while (falta > 0 && !motor.estado.fin && !motor.estado.pedirCamino) {
      const antes = motor.estado, corte = (Math.floor(antes.t / paso) + 1) * paso;
      const siguienteEvento = eventos[eventosK]?.t_s ?? Infinity;
      if (siguienteEvento <= antes.t) { inyectar(eventos[eventosK++].falla); continue; }
      const tramo = Math.min(falta, corte - antes.t, siguienteEvento - antes.t);
      const e = motor.avanzar(tramo), actual = verdad(e), df = ultima.f - actual.f, dc = actual.c - ultima.c;
      const distancia = Math.hypot(df, dc) * zona.paso;
      distanciaSensor += distancia * (1 + parametro(cfg, "deriva_pasos_fraccion"));
      if (distancia) rumbo = (Math.atan2(dc, df) * 180 / Math.PI + 360 + derivaRumbo) % 360;
      filtro.predecir({ distancia_m: distancia * (1 + parametro(cfg, "deriva_pasos_fraccion")), rumbo, dt_s: e.t - antes.t });
      ultima = actual; falta -= tramo;
      if (e.t >= (sensorK + 1) * paso) {
        sensorK = Math.floor(e.t / paso);
        anotar("sensor_imu_pasos", { rumbo, distancia_m: distanciaSensor, origen: "simulado" }); distanciaSensor = 0;
        for (const sensor of escenario.sensores ?? []) {
          if (sensorK % sensor.cada_s !== 0) continue;
          const base = sensor.base;
          if (sensor.tipo === "radio") {
            const d = Math.hypot(base.f - actual.f, base.c - actual.c) * zona.paso;
            corregir({ id: `sim-radio-${sensorK}-${sensor.id}`, tipo: "radio", base, distancia_m: Math.max(0, d + normal() * sensor.sigma_m), sigma_m: sensor.sigma_m, fuente: "radio_simulada" });
          }
          if (sensor.tipo === "barometro") {
            const i = Math.round(actual.f) * zona.ancho + Math.round(actual.c), j = Math.round(base.f) * zona.ancho + Math.round(base.c);
            const R = sensor.cfg.gas_marciano_j_kg_k.valor, g = sensor.cfg.gravedad_m_s2.valor;
            const p = sensor.pBase * Math.exp(-(alturaEn(zona, i) - alturaEn(zona, j)) * g / (R * sensor.T));
            try { corregir({ id: `sim-presion-${sensorK}`, tipo: "barometro", base, p: p + normal() * sensor.cfg.sigma_presion_diferencial_pa.valor,
              pBase: sensor.pBase, T: sensor.T, cfgBarometro: sensor.cfg, fuente: "barometro_simulado" }); } catch (error) { anotar("sensor_sin_dato", { mensaje: error.message }); }
          }
          if (sensor.tipo === "sol") {
            const geo = celdaALonLat(zona.meta, actual.f, actual.c);
            // Referencia solar simulada para la actitud; no pretende resolver posición con un ángulo.
            derivaRumbo = normal() * sensor.sigma_grados;
            anotar("sensor_sol", { ...posicionSol(inicio_ms + e.t * 1000, geo.lon, geo.lat), origen: "simulado" });
          }
        }
      }
      for (const k of hitos) if (antes.k < k && e.k >= k && !e.enRegreso) anotar("hito", { k });
      if (e.t === antes.t) break;
    }
    return estado();
  }
  return { avanzar, corregir, inyectar, ruta: rutaMotor, hitos, get rutaActiva() { return activo; },
    abortar() { abortoOrdenado = true; return inyectar("volver"); },
    get cantidadEventos() { return registro.length; },
    get estado() { return estado(); }, registrar: anotar, fijarRadio: (valor) => { coberturaRadio = valor; },
    recibirCamino(camino) {
      const e = motor.recibirCamino(camino);
      if (camino) {
        activo = { celdas: Array.from(camino.celdas), t: Array.from(camino.tiempos, (s) => camino.tiempos[0] - s), d: [0] };
        for (let k = 1; k < activo.celdas.length; k++) { const a = puntoCelda(zona, activo.celdas[k - 1]), b = puntoCelda(zona, activo.celdas[k]); activo.d.push(activo.d.at(-1) + Math.hypot(a.f - b.f, a.c - b.c) * zona.paso); }
        origenTiempo = e.t; ultima = puntoCelda(zona, e.celda);
      }
      anotar("camino_regreso", { disponible: !!camino }); return estado();
    },
    exportar(formato = "json") {
      if (formato !== "geojson") return { version: 1, zona: zona.meta.id, inicio_ms, origen: "simulado", registro: structuredClone(registro) };
      return { type: "FeatureCollection", properties: { zona: zona.meta.id, origen: "simulado", coordenadas: "planetocéntricas, longitud este, esfera Marte" },
        features: registro.map((r) => { const p = celdaALonLat(zona.meta, r.posicion.f, r.posicion.c); return { type: "Feature", geometry: { type: "Point", coordinates: [((p.lon % 360) + 360) % 360, p.lat] }, properties: r }; }) };
    } };
}
