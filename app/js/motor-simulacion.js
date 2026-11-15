// Motor determinista, sin DOM, reloj ni red. Los límites vienen del llamador (cfg).
// t ya incluye las paradas: minutosDestino y finIda son metadatos, no agregan tiempo.
// O₂ se expresa en segundos nominales; margen_s y limite_s, en segundos a la tasa actual.
// ruta.recursos (opcional) agrega otros consumibles del traje (CO₂, batería, agua): cada uno
// { id, nombre, capacidad, tasa[k] } en su unidad y unidad/s por persona. El que se agote
// primero limita igual que el oxígeno: entra en margen_s, limite_s y NO_ALCANZA.
const TIPOS = new Set(["fuga", "companero", "tormenta", "radio", "rover", "volver"]);
const MOTIVOS = {
  fuga: "Fuga en el traje: primario perdido; regreso con oxígeno secundario.",
  companero: "Compañero incapacitado: regreso por el campo de rescate con arrastre.",
  tormenta: "Partículas solares: hay que entrar al refugio dentro del plazo de la tormenta.",
  radio: "Pérdida de radio: se termina la salida y se vuelve al refugio.",
  rover: "Rover averiado: caminata de regreso al refugio.",
  volver: "Regreso ordenado al refugio.",
};
// Tolerancia de representación binaria, no un margen físico de seguridad.
const noSupera = (valor, limite) => valor <= limite
  || valor - limite <= Number.EPSILON * Math.max(1, Math.abs(valor), Math.abs(limite));

function numero(x, nombre, minimo = 0) {
  if (!Number.isFinite(x) || x < minimo) throw new Error(`${nombre}: se esperaba un número finito mayor o igual a ${minimo}.`);
  return x;
}

function lista(x, nombre, n) {
  if ((!Array.isArray(x) && !ArrayBuffer.isView(x)) || !x.length || (n !== undefined && x.length !== n)) {
    throw new Error(`${nombre}: arreglo vacío o longitud incompatible.`);
  }
  return Array.from(x);
}

function celdasValidas(x, nombre, n) {
  return lista(x, nombre, n).map((i) => {
    if (!Number.isSafeInteger(i) || i < 0) throw new Error(`${nombre}: índice de celda inválido.`);
    return i;
  });
}

function acumulados(x, nombre, n) {
  const a = lista(x, nombre, n);
  a.forEach((v, k) => {
    numero(v, nombre);
    if ((!k && v !== 0) || (k && v < a[k - 1])) throw new Error(`${nombre}: debe empezar en cero y no decrecer.`);
  });
  return a;
}

function campo(x, nombre, n) {
  return lista(x, nombre, n).map((v) => v === null ? null : numero(v, nombre));
}

/**
 * crearMotor({ ruta, cfg }) → { estado, avanzar, inyectar, recibirCamino }.
 * estado es una copia; avanzar/recibirCamino también devuelven una copia.
 * Mientras espera, estado.pedirCamino informa { campo, limite_s }, incluso al
 * terminar automáticamente una ruta lejos del refugio. El visor pide el camino
 * desde estado.celda y debe descartar respuestas viejas usando su pedido del Worker.
 * La espera consume O₂ y plazo: el llamador puede pausar el reloj mientras calcula.
 * Un nuevo evento invalida el camino anterior y conserva todos los plazos activos.
 */
export function crearMotor({ ruta, cfg } = {}) {
  if (!ruta || !cfg) throw new Error("Faltan ruta y configuración de la simulación.");
  const celdas = celdasValidas(ruta.celdas, "ruta.celdas"), n = celdas.length;
  const tiempos = acumulados(ruta.t, "ruta.t", n), distancias = acumulados(ruta.d, "ruta.d", n);
  const regreso = campo(ruta.regreso, "ruta.regreso", n);
  const rescate = ruta.rescate == null ? Array(n).fill(null) : campo(ruta.rescate, "ruta.rescate", n);
  const tasas = ruta.tasaO2 == null ? Array(n).fill(1) : lista(ruta.tasaO2, "ruta.tasaO2", n);
  tasas.forEach((v) => {
    numero(v, "ruta.tasaO2");
    if (v === 0) throw new Error("ruta.tasaO2: el consumo relativo debe ser positivo.");
  });
  const ids = new Set(["o2"]);
  const recursos = (ruta.recursos ?? []).map((r) => {
    if (typeof r?.id !== "string" || !r.id || r.id.startsWith("plazo:") || ids.has(r.id)) throw new Error("ruta.recursos: id vacío, reservado o repetido.");
    ids.add(r.id);
    const tasa = lista(r.tasa, `ruta.recursos.${r.id}.tasa`, n);
    tasa.forEach((v) => numero(v, `ruta.recursos.${r.id}.tasa`));
    const capacidad = numero(r.capacidad, `ruta.recursos.${r.id}.capacidad`);
    return { id: r.id, nombre: typeof r.nombre === "string" && r.nombre ? r.nombre : r.id, capacidad, tasa, restante: capacidad };
  });
  const p = { ...cfg };
  for (const clave of ["primario_s", "secundario_s", "ingreso_s", "margen_terminar_s", "rescate_max_s", "tormenta_refugio_s"]) {
    numero(p[clave], `cfg.${clave}`);
  }
  numero(p.colchon, "cfg.colchon", 1);
  if (p.vehiculo !== "pie" && p.vehiculo !== "rover") throw new Error("cfg.vehiculo: elegí pie o rover.");
  if (p.vehiculo === "rover") numero(p.caminata_max_s, "cfg.caminata_max_s");
  else if (p.caminata_max_s != null) throw new Error("cfg.caminata_max_s: debe ser null para una salida a pie.");
  // Rechazar desbordes también cuando todas las entradas por separado son finitas.
  for (const v of tasas) {
    numero(p.primario_s / v, "Autonomía primaria a la tasa indicada");
    numero(p.secundario_s / v, "Autonomía secundaria a la tasa indicada");
  }
  for (const R of regreso) if (R !== null) numero(p.colchon * R + p.ingreso_s, "Reserva de regreso");

  let t = 0, k = 0, primario = p.primario_s, secundario = p.secundario_s;
  let enRegreso = false, esperando = false, camino = null, tasaRegreso = null, tasasRecursos = null;
  let final = null;
  const fallas = new Set(), plazos = new Map();

  const tasa = () => tasaRegreso ?? tasas[k];
  const celda = () => camino ? camino.celdas[camino.k] : celdas[k];
  const oxigeno = () => fallas.has("fuga") ? secundario : primario;
  const campoActual = () => fallas.has("companero") ? "rescate" : "regreso";
  const emergencia = () => ["fuga", "companero", "tormenta", "rover"].some((f) => fallas.has(f));
  const textoFallas = () => Array.from(fallas, (f) => MOTIVOS[f]).join(" ");
  const tasaDe = (r, j) => tasasRecursos ? tasasRecursos[j] : r.tasa[k];
  const autonomiaDe = (r, j) => { const v = tasaDe(r, j); return v > 0 ? r.restante / v : Infinity; };
  // Lo que se acaba primero a la tasa actual: oxígeno, otro recurso del traje o el plazo de una falla.
  // En un empate gana el oxígeno y después el orden de ruta.recursos.
  function limitante() {
    let id = "o2", s = oxigeno() / tasa(), nombre = null;
    recursos.forEach((r, j) => { const a = autonomiaDe(r, j); if (a < s) { s = a; id = r.id; nombre = r.nombre; } });
    for (const [tipo, restante] of plazos) if (restante < s) { s = restante; id = `plazo:${tipo}`; nombre = null; }
    return { id, s, nombre };
  }
  const disponible = () => limitante().s;
  const limita = () => { const l = limitante(); return l.nombre ? ` Limita: ${l.nombre}.` : ""; };
  const limite = () => Math.max(0, disponible() - p.ingreso_s);
  const pedido = () => ({ campo: campoActual(), limite_s: limite() });

  function regresoActual() {
    if (camino) return camino.falta;
    return (campoActual() === "rescate" ? rescate : regreso)[k];
  }

  function terminar(veredicto, motivo) {
    final = { veredicto, motivo };
    esperando = false;
  }

  // El ingreso se reserva en la comprobación; no se agrega otra etapa al camino.
  // A_SALVO indica que llegó al refugio con tiempo y O₂ para ingresar.
  function aSalvo() {
    if (!noSupera(p.ingreso_s, disponible())) terminar("NO_ALCANZA", `No alcanza el tiempo o el oxígeno para ingresar al refugio.${limita()}`);
    else terminar("A_SALVO", "A salvo en el refugio, con reserva para el ingreso.");
  }

  function estado() {
    const R = regresoActual();
    const lim = limitante();
    // Sin fallas no hay plazos: lim.s es la autonomía del recurso que se acaba primero.
    const margen = R === null ? null : lim.s - ((enRegreso ? R : p.colchon * R) + p.ingreso_s);
    let veredicto = "CONTINUAR", nivel = "verde", motivo = "Dentro de todos los márgenes.";
    if (final) {
      ({ veredicto, motivo } = final);
      nivel = veredicto === "A_SALVO" ? "verde" : "rojo";
    } else if (esperando) {
      veredicto = "ESPERANDO_CAMINO";
      nivel = emergencia() || margen === null || margen <= 0 ? "rojo" : "ambar";
      motivo = `${textoFallas()} Esperando el camino al refugio; los plazos siguen corriendo.`;
    } else if (R === null || margen <= 0) {
      veredicto = "ABORTAR"; nivel = "rojo";
      motivo = R === null ? "Sin regreso conocido al refugio." : `Sin margen para volver e ingresar al refugio.${limita()}`;
    } else if (emergencia()) {
      veredicto = "ABORTAR"; nivel = "rojo"; motivo = textoFallas();
    } else if (enRegreso || margen <= p.margen_terminar_s) {
      veredicto = "TERMINAR"; nivel = "ambar";
      motivo = enRegreso ? textoFallas() : `Margen de regreso bajo: terminá la salida y emprendé la vuelta.${limita()}`;
    }
    return {
      t, k: camino ? camino.k : k, celda: celda(), enRegreso, fin: !!final,
      nivel, veredicto, motivo, o2: { primario_s: primario, secundario_s: secundario },
      regreso_s: R, margen_s: margen,
      // El Worker no entrega distancias del camino de emergencia: no se inventan.
      distancia_m: enRegreso ? null : distancias[k], fallas: [...fallas],
      // tasa: consumo de O₂ relativo al nominal; plazos: segundos que quedan de cada falla con plazo.
      tasa: tasa(), plazos: Object.fromEntries(plazos), limitante: lim.id,
      recursos: recursos.map((r, j) => ({ id: r.id, nombre: r.nombre, restante: r.restante, capacidad: r.capacidad, autonomia_s: autonomiaDe(r, j) })),
      ...(esperando ? { pedirCamino: pedido() } : {}),
    };
  }

  function inyectar(tipo) {
    if (!TIPOS.has(tipo)) return { ignorado: "Tipo de evento desconocido." };
    if (fallas.has(tipo)) return { ignorado: "Ese evento ya fue inyectado; se conserva su plazo original." };
    if (final) return { ignorado: "La simulación ya terminó." };
    if (tipo === "rover" && p.vehiculo !== "rover") return { ignorado: "La salida es a pie: no hay rover." };
    // El refugio se reconoce por tiempo cero, nunca por un umbral de cercanía.
    const enRefugio = (camino ? camino.falta : regresoActual()) === 0;
    const anterior = regresoActual(), campoAnterior = campoActual();
    fallas.add(tipo);
    if (tipo === "fuga") primario = 0;
    if (tipo === "companero") plazos.set(tipo, p.rescate_max_s);
    if (tipo === "tormenta") plazos.set(tipo, p.tormenta_refugio_s);
    if (tipo === "rover") plazos.set(tipo, p.caminata_max_s);
    enRegreso = true;
    if (enRefugio) {
      // Ya está protegido: inyectar en el refugio no pide un camino ni impone ingreso.
      terminar("A_SALVO", "A salvo: el evento ocurrió en el refugio.");
      return { ignorado: "Ya estás a salvo en el refugio." };
    }
    // El Worker no entrega tasaO2 del regreso. Se mantiene la tasa del punto de
    // desvío, incluso fuera de la ruta original; es una estimación, no una medición.
    tasasRecursos = recursos.map(tasaDe);
    tasaRegreso = tasa();
    const actual = celda();
    // Un tiempo sin arrastre no estima el rescate: se informa desconocido.
    const estimacion = campoAnterior === campoActual() ? anterior : null;
    // Se conserva la celda del camino anterior mientras se solicita el nuevo.
    camino = { celdas: [actual], tiempos: [], k: 0, falta: estimacion };
    esperando = true;
    return { pedirCamino: pedido() };
  }

  function recibirCamino(datos) {
    if (final || !esperando) return estado();
    if (datos === null || datos?.celdas === null) {
      terminar("NO_ALCANZA", "No hay camino al refugio dentro de los límites activos.");
      return estado();
    }
    const c = celdasValidas(datos?.celdas, "camino.celdas");
    const ts = lista(datos?.tiempos, "camino.tiempos", c.length);
    ts.forEach((v, j) => {
      numero(v, "camino.tiempos");
      if (j && v > ts[j - 1]) throw new Error("camino.tiempos: deben ser segundos restantes no crecientes.");
    });
    if (c[0] !== celda() || ts.at(-1) !== 0) throw new Error("El camino debe empezar en la celda actual y terminar con tiempo cero en el refugio.");
    esperando = false;
    camino = { celdas: c, tiempos: ts, k: 0, falta: ts[0] };
    if (!noSupera(ts[0], limite())) terminar("NO_ALCANZA", `${textoFallas()} El camino y el ingreso superan el límite más restrictivo.${limita()}`);
    else if (ts[0] === 0) aSalvo();
    return estado();
  }

  function consumir(dt) {
    t += dt;
    recursos.forEach((r, j) => { r.restante = Math.max(0, r.restante - dt * tasaDe(r, j)); });
    if (fallas.has("fuga")) secundario = Math.max(0, secundario - dt * tasa());
    else primario = Math.max(0, primario - dt * tasa());
    for (const [tipo, restante] of plazos) plazos.set(tipo, Math.max(0, restante - dt));
  }

  function avanzar(dt_s) {
    numero(dt_s, "dt_s");
    if (!Number.isFinite(t + dt_s)) throw new Error("dt_s: el tiempo acumulado excede el rango numérico.");
    let restante = dt_s;
    while (!final) {
      if (!enRegreso) {
        while (k < n - 1 && tiempos[k + 1] <= t) k++;
        if (k === n - 1) {
          if (regreso[k] === 0) aSalvo();
          else inyectar("volver");
          continue;
        }
      } else if (!esperando) {
        while (camino.k < camino.celdas.length - 1 && camino.tiempos[camino.k + 1] >= camino.falta) camino.k++;
        if (camino.falta === 0) { aSalvo(); continue; }
      }
      if (restante === 0) break;
      const hastaCelda = esperando ? restante : enRegreso
        ? camino.falta - camino.tiempos[camino.k + 1]
        : tiempos[k + 1] - t;
      const lim = limitante(), autonomia = lim.s;
      const dt = Math.min(restante, hastaCelda, autonomia);
      consumir(dt);
      if (enRegreso && !esperando) camino.falta = Math.max(0, camino.falta - dt);
      restante = Math.max(0, restante - dt);
      // La llegada exacta al refugio con ingreso cero cuenta como éxito.
      const llego = enRegreso && !esperando && camino.falta === 0
        || !enRegreso && t >= tiempos.at(-1) && regreso.at(-1) === 0;
      if (dt === autonomia && !llego) terminar("NO_ALCANZA", lim.nombre
        ? `Se agotó un recurso del traje antes de llegar al refugio: ${lim.nombre}.`
        : "Se agotó el oxígeno o el plazo de una falla antes de llegar al refugio.");
    }
    return estado();
  }

  return { get estado() { return estado(); }, avanzar, inyectar, recibirCamino };
}

// Recursos del traje por persona, además del oxígeno, para ruta.recursos. Usa las mismas tasas que
// consumibles.perfilRuta (tasaO2 y metabolismo_w por celda) y las capacidades de config/consumibles.json.
// CO₂ en kg capturables, batería en Wh, agua de enfriamiento en kg. Modelado, a calibrar.
export function recursosTraje({ tasaO2, metabolismo_w, cfg }) {
  const v = (grupo, clave) => numero(grupo?.[clave]?.valor, `Configuración ${clave}`);
  const m = cfg?.metabolismo, traje = cfg?.traje, n = tasaO2?.length;
  lista(tasaO2, "tasaO2"); lista(metabolismo_w, "metabolismo_w", n);
  const o2_kg_h = v(m, "apollo_promedio_kcal_h") / v(m, "kcal_por_litro_o2") * v(m, "o2_kg_por_litro");
  const co2 = o2_kg_h * v(m, "co2_kg_por_kg_o2"), agua = v(m, "agua_enfriamiento_nominal_kg_h");
  const base = v(m, "potencia_electrica_base_w"), fraccion = v(m, "potencia_electrica_fraccion");
  return [
    { id: "co2", nombre: "absorción de CO₂", unidad: "kg", capacidad: v(traje, "absorcion_co2_kg"), tasa: Array.from(tasaO2, (x) => x * co2 / 3600) },
    { id: "bateria", nombre: "batería del traje", unidad: "Wh", capacidad: v(traje, "bateria_wh"), tasa: Array.from(metabolismo_w, (w) => (base + fraccion * w) / 3600) },
    { id: "agua", nombre: "agua de enfriamiento", unidad: "kg", capacidad: v(traje, "agua_enfriamiento_kg"), tasa: Array.from(tasaO2, (x) => x * agua / 3600) },
  ];
}
