// Consumibles modelados. Funciones puras, sin red ni DOM; parámetros en config/consumibles.json.
const v = (p) => p && typeof p === "object" ? p.valor : p;
const formato = (x) => x.toLocaleString("es-UY", { maximumFractionDigits: 2 });
const RECURSOS = { oxigeno_kg: "kg", agua_l: "L", comida_kcal: "kcal", energia_kwh: "kWh", filtros_co2_h: "persona·h" };

function numero(x, nombre, positivo = false) {
  if (!Number.isFinite(x) || (positivo ? x <= 0 : x < 0)) {
    throw new Error(`${nombre}: usá un número finito ${positivo ? "mayor que cero" : "no negativo"}.`);
  }
  return x;
}

function parametro(grupo, clave, positivo = true) {
  return numero(v(grupo?.[clave]), `Configuración ${clave}`, positivo);
}

function tripulacion(personas) {
  numero(personas, "Personas", true);
  if (!Number.isSafeInteger(personas)) throw new Error("Personas: usá un entero positivo.");
}

function registro(obj, nombre) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`${nombre}: falta un objeto.`);
}

// Acepta inventarios planos o los parámetros con procedencia de la configuración.
function disponible(inventario, clave) {
  const dato = v(inventario[clave]);
  if (dato == null) return null;
  numero(dato, `Inventario ${clave}`);
  if (clave === "capacidad_personas" && !Number.isSafeInteger(dato)) {
    throw new Error("Inventario capacidad_personas: usá un entero no negativo.");
  }
  return dato;
}

function nominal(cfg) {
  return parametro(cfg?.metabolismo, "apollo_promedio_kcal_h") * parametro(cfg?.conversiones, "julios_por_kcal") / 3600;
}

// pendiente = Δz / distancia horizontal, con signo; gravedad en m/s², masa total en kg.
// No es una fórmula validada para Marte: el anclaje de Apollo y la adaptación están separados.
export function tasaMetabolica({ velocidad_ms, pendiente, masa_kg, gravedad, cfg }) {
  numero(velocidad_ms, "Velocidad");
  if (!Number.isFinite(pendiente)) throw new Error("Pendiente: usá un número finito (desnivel/distancia).");
  numero(masa_kg, "Masa", true);
  numero(gravedad, "Gravedad", true);
  const m = cfg?.metabolismo;
  const reposo = parametro(m, "reposo_w");
  const referencia = nominal(cfg);
  if (reposo > referencia) throw new Error("Configuración: el reposo supera la tasa nominal.");
  const eficiencia = parametro(m, "eficiencia_subida");
  if (eficiencia > 1) throw new Error("Configuración: la eficiencia de subida supera uno.");
  const marcha = (referencia - reposo) * (gravedad / parametro(m, "gravedad_referencia_ms2"))
    * (velocidad_ms / parametro(m, "velocidad_referencia_ms")) ** 2;
  const subida = masa_kg * gravedad * velocidad_ms * Math.max(0, pendiente) / eficiencia;
  return numero((masa_kg / parametro(m, "masa_referencia_kg")) * (reposo + marcha) + subida, "Tasa metabólica");
}

function lista(a, nombre) {
  if (!Array.isArray(a) && !(ArrayBuffer.isView(a) && typeof a.length === "number")) {
    throw new Error(`Ruta ${nombre}: usá un arreglo o un arreglo tipado.`);
  }
}

// t y d acumulados desde cero, en s y m horizontales. elevaciones está alineado con la
// ruta (no con toda la grilla), en m. Repetí celda y distancia para describir una parada.
// tasaO2[k] rige [t[k], t[k+1]); el último valor repite el anterior y no agrega consumo.
// personas multiplica los totales, no la tasa individual. No se agrega una vuelta implícita.
export function perfilRuta({ celdas, t, d, elevaciones, cfg, personas }) {
  tripulacion(personas);
  for (const [nombre, a] of Object.entries({ celdas, t, d, elevaciones })) lista(a, nombre);
  const n = celdas.length;
  if ([t, d, elevaciones].some((a) => a.length !== n)) throw new Error("Ruta: los arreglos deben tener igual largo.");
  for (let k = 0; k < n; k++) {
    if (!Number.isSafeInteger(celdas[k]) || celdas[k] < 0) throw new Error("Ruta: celda inválida.");
    numero(t[k], "Ruta tiempo"); numero(d[k], "Ruta distancia");
    if (!Number.isFinite(elevaciones[k])) throw new Error("Ruta: elevación sin informar o inválida.");
    if (k === 0 && (t[k] !== 0 || d[k] !== 0)) throw new Error("Ruta: tiempo y distancia deben empezar en cero.");
    if (k > 0) {
      const dt = t[k] - t[k - 1], dd = d[k] - d[k - 1], dz = elevaciones[k] - elevaciones[k - 1];
      if (dt < 0 || dd < 0) throw new Error("Ruta: tiempo y distancia deben ser crecientes.");
      if (dd > 0 && dt === 0) throw new Error("Ruta: un desplazamiento necesita tiempo positivo.");
      if (dd === 0 && dz !== 0) throw new Error("Ruta: hay desnivel sin distancia horizontal.");
    }
  }
  const m = cfg?.metabolismo;
  const referencia = nominal(cfg);
  const masa = parametro(m, "masa_referencia_kg"), gravedad = parametro(m, "gravedad_referencia_ms2");
  const o2Nominal = parametro(m, "apollo_promedio_kcal_h") / parametro(m, "kcal_por_litro_o2") * parametro(m, "o2_kg_por_litro");
  const co2PorO2 = parametro(m, "co2_kg_por_kg_o2");
  const aguaFria = parametro(m, "agua_enfriamiento_nominal_kg_h", false);
  const aguaBebida = parametro(m, "agua_potable_nominal_kg_h", false);
  const electricaBase = parametro(m, "potencia_electrica_base_w", false);
  const electricaFraccion = parametro(m, "potencia_electrica_fraccion", false);
  const tasaO2 = new Float64Array(n), metabolismo_w = new Float64Array(n);
  const totales = { oxigeno_kg: 0, agua_kg: 0, energia_wh: 0, co2_kg: 0 };
  for (let k = 0; k < n; k++) {
    const dt = k + 1 < n ? t[k + 1] - t[k] : 0;
    const dd = k + 1 < n ? d[k + 1] - d[k] : 0;
    metabolismo_w[k] = k === n - 1 && k > 0 ? metabolismo_w[k - 1] : tasaMetabolica({
      velocidad_ms: dt > 0 ? dd / dt : 0,
      pendiente: dd > 0 ? (elevaciones[k + 1] - elevaciones[k]) / dd : 0,
      masa_kg: masa, gravedad, cfg,
    });
    tasaO2[k] = metabolismo_w[k] / referencia;
    const horasPersona = dt / 3600 * personas;
    const oxigeno = tasaO2[k] * o2Nominal * horasPersona;
    totales.oxigeno_kg += oxigeno;
    totales.agua_kg += tasaO2[k] * (aguaFria + aguaBebida) * horasPersona;
    totales.energia_wh += (electricaBase + electricaFraccion * metabolismo_w[k]) * horasPersona;
    totales.co2_kg += oxigeno * co2PorO2;
  }
  for (const [clave, dato] of Object.entries(totales)) numero(dato, `Total ${clave}`);
  return { tasaO2, metabolismo_w, totales, supuestos: [
    "Consumo modelado, a calibrar para Marte; Apollo aporta una referencia lunar de tareas EVA.",
    "Masa y gravedad tomadas de la configuración; cada intervalo usa velocidad media, incluso si incluye trabajo.",
    "Agua total = enfriamiento expendible + bebida. Energía = electricidad del traje, sin confundirla con metabolismo.",
  ] };
}

function tasasRefugio(cfg) {
  const r = cfg?.refugio;
  return {
    oxigeno_kg: parametro(r, "oxigeno_kg_dia") / 24,
    agua_l: parametro(r, "agua_potable_kg_dia") / parametro(cfg?.conversiones, "agua_kg_por_litro") / 24,
    comida_kcal: parametro(r, "comida_mj_dia") * 1e6 / parametro(cfg?.conversiones, "julios_por_kcal") / 24,
    energia_kwh: parametro(r, "energia_kwh_dia") / 24,
    filtros_co2_h: 1,
  };
}

// Autonomía de consumibles acreditada, sin reciclaje. null/ausente no se presume lleno:
// aporta cero horas y se identifica como sin informar. No es una predicción de supervivencia.
// Capacidad y botiquín se evalúan en sirveDeRefugio, no son consumos por hora.
export function autonomia(inventario, personas, cfg) {
  registro(inventario, "Inventario"); tripulacion(personas);
  const tasas = tasasRefugio(cfg), detalle = {};
  let horas = Infinity, limitante = null;
  for (const [recurso, tasa] of Object.entries(tasas)) {
    const cantidad = disponible(inventario, recurso);
    const consumo = numero(tasa * personas, `Consumo ${recurso}`, true);
    const h = cantidad === null ? 0 : numero(cantidad / consumo, `Autonomía ${recurso}`);
    detalle[recurso] = { cantidad, unidad: RECURSOS[recurso], consumo_por_h: consumo, horas: h,
      motivo: cantidad === null ? "Sin informar: no aporta autonomía acreditada." : "Inventario informado, sin reposición." };
    if (h < horas) { horas = h; limitante = recurso; }
  }
  return { horas, limitante, detalle };
}

// necesidad: cantidades POR PERSONA con claves de inventario, no totales del grupo.
// null/ausente = necesidad desconocida: impide afirmar ok; cero = no se pide ese recurso.
// Sin necesidad (null/undefined), recarga completa: ambos tanques, agua, batería y sorbente.
// filtros_co2_h convierte masa capturable en horas-persona equivalentes del refugio.
// Verifica existencias utilizables; no descuenta inventario ni acredita hardware compatible.
export function alcanzaParaRecargar(inventario, necesidad, personas, cfg) {
  registro(inventario, "Inventario"); tripulacion(personas);
  if (necesidad == null) {
    const traje = cfg?.traje;
    necesidad = {
      oxigeno_kg: parametro(traje, "oxigeno_primario_kg") + parametro(traje, "oxigeno_secundario_kg"),
      agua_l: (parametro(traje, "agua_enfriamiento_kg") + parametro(traje, "agua_potable_kg"))
        / parametro(cfg?.conversiones, "agua_kg_por_litro"),
      comida_kcal: 0,
      energia_kwh: parametro(traje, "bateria_wh") / 1000,
      filtros_co2_h: parametro(traje, "absorcion_co2_kg") / (parametro(cfg?.refugio, "co2_kg_dia") / 24),
    };
  }
  registro(necesidad, "Necesidad");
  for (const clave of Object.keys(necesidad)) {
    if (!Object.hasOwn(RECURSOS, clave)) throw new Error(`Necesidad: recurso desconocido ${clave}.`);
  }
  const faltan = [];
  for (const [recurso, unidad] of Object.entries(RECURSOS)) {
    const pedido = v(necesidad[recurso]);
    if (pedido == null) {
      faltan.push({ recurso, falta: null, unidad, motivo: "Necesidad sin informar: no se puede acreditar la recarga." });
      continue;
    }
    const total = numero(numero(pedido, `Necesidad ${recurso}`) * personas, `Necesidad total ${recurso}`);
    const cantidad = disponible(inventario, recurso);
    if (total === 0) continue;
    if (cantidad === null || cantidad < total) faltan.push({ recurso, falta: total - (cantidad ?? 0), unidad,
      motivo: cantidad === null ? "Inventario sin informar: no cuenta para recargar." : "Inventario insuficiente." });
  }
  return { ok: faltan.length === 0, faltan };
}

// Solo evalúa consumibles y plazas. Botiquín se informa, sin certificar aptitud médica.
export function sirveDeRefugio(inventario, personas, cfg) {
  const a = autonomia(inventario, personas, cfg);
  const capacidad = disponible(inventario, "capacidad_personas");
  const minimo = parametro(cfg, "refugio_minimo_h");
  const problemas = [];
  if (capacidad === null) problemas.push("Capacidad sin informar: no cuenta como plazas disponibles.");
  else if (capacidad < personas) problemas.push(`Capacidad insuficiente: ${formato(capacidad)} plazas para ${formato(personas)} personas.`);
  const desconocidos = Object.entries(a.detalle).filter(([, x]) => x.cantidad === null).map(([r]) => r);
  if (desconocidos.length) problemas.push(`Recursos sin informar: ${desconocidos.join(", ")}; no cuentan para la autonomía.`);
  if (a.horas < minimo) problemas.push(`Autonomía de ${formato(a.horas)} h, menor a ${formato(minimo)} h; limita ${a.limitante}.`);
  const botiquin = v(inventario.botiquin);
  if (botiquin != null && typeof botiquin !== "boolean") throw new Error("Inventario botiquin: usá sí/no (booleano) o null.");
  const aviso = botiquin === true ? "" : botiquin == null ? " Botiquín sin informar." : " Sin botiquín informado disponible.";
  return { ok: problemas.length === 0, horas: a.horas, motivo: (problemas.join(" ")
    || `Consumibles para ${formato(a.horas)} h y capacidad suficiente; mínimo propuesto ${formato(minimo)} h, a calibrar.`)
    + aviso + " Evaluación modelada de consumibles y plazas; no acredita protección ambiental ni atención médica." };
}
