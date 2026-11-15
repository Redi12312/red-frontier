// Ventana EVA: hora y estación de Marte, parte meteorológico de Curiosity y clima espacial de NASA,
// y el semáforo de salida con cada motivo. Sin dependencias del navegador (se prueba en Node).

const rad = (g) => (g * Math.PI) / 180;

// Fecha juliana TT de un instante (ms desde 1970, UTC). TT − UTC = 69,184 s.
const jdTT = (ms) => ms / 86400000 + 2440587.5 + 69.184 / 86400;

// Mars Sol Date, hora coordinada de Marte (h) y longitud solar Ls (°) — Allison y McEwen 2000 (Mars24).
export function tiempoMarte(ms) {
  const jd = jdTT(ms);
  const dt = jd - 2451545.0;
  const M = 19.3871 + 0.52402073 * dt;
  const alfa = 270.3871 + 0.524038496 * dt;
  const A = [0.0071, 0.0057, 0.0039, 0.0037, 0.0021, 0.002, 0.0018];
  const tau = [2.2353, 2.7543, 1.1177, 15.7866, 2.1354, 2.4694, 32.8493];
  const fi = [49.409, 168.173, 191.837, 21.736, 15.704, 95.528, 49.095];
  let pbs = 0;
  for (let i = 0; i < 7; i++) pbs += A[i] * Math.cos(rad((0.985626 * dt) / tau[i] + fi[i]));
  const ecc = (10.691 + 3.0e-7 * dt) * Math.sin(rad(M)) + 0.623 * Math.sin(rad(2 * M)) + 0.05 * Math.sin(rad(3 * M))
    + 0.005 * Math.sin(rad(4 * M)) + 0.0005 * Math.sin(rad(5 * M)) + pbs;
  const ls = (((alfa + ecc) % 360) + 360) % 360;
  const msd = (jd - 2405522.0028779) / 1.0274912517;
  const mtc = (((msd % 1) + 1) % 1) * 24;
  return { msd, mtc, ls };
}

// Hora solar media local (h) en una longitud este.
export const horaLocal = (mtc, lonEste) => (((mtc + lonEste / 15) % 24) + 24) % 24;

// Sol de Curiosity aproximado para una fecha (sol 0 = aterrizaje, MSD 49268,3).
export const solCuriosity = (msd) => Math.floor(msd - 49268.3);

const numero = (v) => (v === "--" || v === undefined || v === null ? null : Number(v));
const hhmm = (t) => { const [h, m] = String(t).split(":").map(Number); return h + m / 60; };

// Último sol con datos del parte de Curiosity y la serie de los últimos `n` soles.
export function resumenRems(soles, n = 60) {
  const validos = soles.filter((s) => numero(s.min_temp) !== null);
  const ultimo = validos[0];
  const serie = validos.slice(0, n).reverse().map((s) => ({
    sol: Number(s.sol), min: numero(s.min_temp), max: numero(s.max_temp), suelo_min: numero(s.min_gts_temp),
    suelo_max: numero(s.max_gts_temp), presion: numero(s.pressure),
  }));
  return {
    sol: Number(ultimo.sol), fecha: ultimo.terrestrial_date, ls: Number(ultimo.ls),
    aire: [numero(ultimo.min_temp), numero(ultimo.max_temp)], suelo: [numero(ultimo.min_gts_temp), numero(ultimo.max_gts_temp)],
    presion: numero(ultimo.pressure), opacidad: ultimo.atmo_opacity, uv: ultimo.local_uv_irradiance_index,
    amanecer: hhmm(ultimo.sunrise), atardecer: hhmm(ultimo.sunset), serie,
  };
}

// Llegadas a Marte previstas por las simulaciones WSA-ENLIL (una por eyección, la más reciente de cada una).
export function llegadasMarte(simulaciones) {
  const porCme = new Map();
  for (const s of simulaciones || []) {
    for (const i of s.impactList || []) {
      if (!/mars/i.test(i.location || "")) continue;
      const cme = (s.cmeInputs || [])[0]?.cmeStartTime || s.simulationID;
      const previo = porCme.get(cme);
      if (!previo || s.modelCompletionTime > previo.modelo) {
        porCme.set(cme, { cme, llegada: Date.parse(i.arrivalTime), modelo: s.modelCompletionTime, directo: !i.isGlancingBlow && !i.isMinorImpact,
          refilon: !!i.isGlancingBlow, menor: !!i.isMinorImpact, enlace: s.link });
      }
    }
  }
  return [...porCme.values()].sort((a, b) => b.llegada - a.llegada);
}

// Semáforo de la Ventana EVA. Devuelve { nivel: "verde" | "ambar" | "rojo", motivos: [...] }.
export function semaforo({ ahora, ls, llegadas, sep, rems, cfg }) {
  const motivos = [];
  const ts = cfg.tormenta_solar;
  for (const l of llegadas) {
    const dh = (ahora - l.llegada) / 3600000; // horas desde la llegada (negativo: todavía no llegó)
    if (dh >= -ts.horas_antes.valor && dh <= ts.horas_despues.valor) {
      const tipo = l.directo ? "impacto directo" : l.refilon ? "de refilón" : "impacto menor";
      motivos.push({ nivel: l.directo ? "rojo" : "ambar", texto: `Eyección solar con llegada a Marte ${dh < 0 ? `en ${Math.round(-dh)} h` : `hace ${Math.round(dh)} h`} (${tipo}, WSA-ENLIL)`,
        fuente: ts.severidad.fuente, base: ts.severidad.base });
    }
  }
  for (const e of sep || []) {
    const dh = (ahora - Date.parse(e.eventTime)) / 3600000;
    if (dh >= 0 && dh <= ts.sep_horas.valor) motivos.push({ nivel: "rojo", texto: `Evento de partículas solares (SEP) hace ${Math.round(dh)} h`, fuente: ts.sep_horas.fuente, base: ts.sep_horas.base });
  }
  const p = cfg.polvo;
  if (ls >= p.temporada_ls.desde && ls < p.temporada_ls.hasta) {
    const reg = p.tormentas_regionales.find((t) => ls >= t.desde && ls < t.hasta);
    motivos.push({ nivel: "ambar", texto: `Temporada de tormentas de polvo (Ls ${Math.round(ls)}°)${reg ? `, ventana de tormentas regionales tipo ${reg.tipo}` : ""}`,
      fuente: reg ? reg.fuente : p.temporada_ls.fuente, base: "verificado" });
  }
  if (rems && rems.opacidad && !/sunny/i.test(rems.opacidad)) {
    motivos.push({ nivel: "ambar", texto: `Opacidad del cielo "${rems.opacidad}" en el último parte de Curiosity (sol ${rems.sol})`, fuente: "Parte de REMS", base: "verificado" });
  }
  const orden = { verde: 0, ambar: 1, rojo: 2 };
  const nivel = motivos.reduce((n, m) => (orden[m.nivel] > orden[n] ? m.nivel : n), "verde");
  return { nivel, motivos };
}

// Franjas del sol para salir: noche, margen de amanecer/atardecer, remolinos del mediodía y ventana buena.
export function franjasDelSol(rems, cfg) {
  const h = cfg.horario;
  const ini = rems.amanecer + h.margen_amanecer_h.valor, fin = rems.atardecer - h.margen_atardecer_h.valor;
  const r0 = h.remolinos_desde_h.valor, r1 = h.remolinos_hasta_h.valor;
  return [
    { desde: 0, hasta: rems.amanecer, tipo: "noche", texto: "Noche: solo emergencias" },
    { desde: rems.amanecer, hasta: ini, tipo: "margen", texto: "Primera hora de luz: frío y sol bajo" },
    { desde: ini, hasta: r0, tipo: "buena", texto: "Ventana buena" },
    { desde: r0, hasta: r1, tipo: "remolinos", texto: "Pico de remolinos de polvo" },
    { desde: r1, hasta: fin, tipo: "buena", texto: "Ventana buena" },
    { desde: fin, hasta: rems.atardecer, tipo: "margen", texto: "Volver antes de que oscurezca" },
    { desde: rems.atardecer, hasta: 24, tipo: "noche", texto: "Noche: solo emergencias" },
  ].filter((f) => f.hasta > f.desde);
}
