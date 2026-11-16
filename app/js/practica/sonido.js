// Sonido sintetizado con WebAudio (sin archivos). En Marte el aire es muy fino (≈ 0,6 % de la presión
// terrestre): lo de afuera casi no se oye. Lo que domina es lo de adentro del casco: respiración,
// ventilador del traje y los pasos que llegan por el cuerpo, graves y apagados.
// Si no hay AudioContext, todo es no-op.

const VOLUMEN = 0.45;

export function crearSonido() {
  let ctx = null, maestro = null, ruidoBuf = null;
  let resp = null, filtroResp = null;
  let silenciado = false;
  let fase = 0, ciclo = 4, tPaso = 0, pie = 0;

  const ahora = () => ctx.currentTime;

  // Ruido blanco en bucle, con desfase para que las capas no se correlacionen.
  function ruido() {
    const s = ctx.createBufferSource();
    s.buffer = ruidoBuf; s.loop = true;
    s.start(0, Math.random() * 1.9);
    return s;
  }
  function filtro(tipo, f, q = 0.7) {
    const b = ctx.createBiquadFilter();
    b.type = tipo; b.frequency.value = f; b.Q.value = q;
    return b;
  }
  function ganancia(v, destino = maestro) {
    const g = ctx.createGain(); g.gain.value = v; g.connect(destino); return g;
  }
  // Envolvente corta: ataque y caída exponencial.
  function envolvente(g, t0, pico, ataque, caida) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(pico, t0 + ataque);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ataque + caida);
  }
  function tono(f, t0, dur, vol, tipo = "sine") {
    const o = ctx.createOscillator(); o.type = tipo; o.frequency.value = f;
    const g = ganancia(0); o.connect(g);
    envolvente(g, t0, vol, 0.01, dur);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  // Golpe grave con caída de tono (pasos, aterrizajes).
  function golpe(t0, f0, f1, dur, vol, corte) {
    const o = ctx.createOscillator(); o.type = "sine";
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const lp = filtro("lowpass", corte); const g = ganancia(0);
    o.connect(lp).connect(g);
    envolvente(g, t0, vol, 0.008, dur);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  // Ráfaga de ruido filtrado.
  function rafaga(t0, tipo, f, q, dur, vol, ataque = 0.005) {
    const s = ctx.createBufferSource(); s.buffer = ruidoBuf;
    const b = filtro(tipo, f, q); const g = ganancia(0);
    s.connect(b).connect(g);
    envolvente(g, t0, vol, ataque, dur);
    s.start(t0, Math.random() * 1.5); s.stop(t0 + ataque + dur + 0.05);
  }

  function armar() {
    const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return false;
    ctx = new AC();
    // Maestro → compresor suave para evitar saturación.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 4;
    comp.attack.value = 0.005; comp.release.value = 0.2;
    comp.connect(ctx.destination);
    maestro = ctx.createGain(); maestro.gain.value = silenciado ? 0 : VOLUMEN; maestro.connect(comp);
    ruidoBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = ruidoBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // Respiración: ruido pasabanda; la envolvente se arma en actualizar().
    filtroResp = filtro("bandpass", 900, 0.8);
    resp = ganancia(0);
    ruido().connect(filtro("highpass", 250)).connect(filtroResp).connect(resp);

    // Zumbido del traje: dos osciladores graves + ventilador (ruido muy bajo).
    const zum = ganancia(0.035);
    const lpZ = filtro("lowpass", 380); lpZ.connect(zum);
    for (const [f, tipo] of [[58, "sine"], [116.6, "triangle"], [174, "sine"]]) {
      const o = ctx.createOscillator(); o.type = tipo; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = f > 150 ? 0.25 : 1;
      o.connect(g).connect(lpZ); o.start();
    }
    ruido().connect(filtro("lowpass", 260)).connect(ganancia(0.02));

    // Viento marciano muy tenue: pasabanda con modulación lenta de volumen y frecuencia.
    const viento = ganancia(0.01);
    const bpV = filtro("bandpass", 380, 0.9);
    ruido().connect(bpV).connect(viento);
    const lfoG = ctx.createOscillator(); lfoG.frequency.value = 0.07;
    const profG = ctx.createGain(); profG.gain.value = 0.007;
    lfoG.connect(profG).connect(viento.gain); lfoG.start();
    const lfoF = ctx.createOscillator(); lfoF.frequency.value = 0.043;
    const profF = ctx.createGain(); profF.gain.value = 140;
    lfoF.connect(profF).connect(bpV.frequency); lfoF.start();
    return true;
  }

  // Envolvente de un ciclo de respiración: inhalar (0–0,4), pausa, exhalar (0,5–0,95), pausa.
  function respiracion(p) {
    if (p < 0.4) return { v: 0.09 * Math.sin((Math.PI * p) / 0.4) ** 2, f: 1250 };
    if (p >= 0.5 && p < 0.95) return { v: 0.12 * Math.sin((Math.PI * (p - 0.5)) / 0.45) ** 2, f: 650 };
    return { v: 0, f: p < 0.5 ? 1250 : 650 };
  }

  const api = {
    // Llamar desde un clic o tecla del usuario (política de autoplay).
    iniciar() {
      try {
        if (!ctx && !armar()) return;
        if (ctx.state === "suspended") ctx.resume();
      } catch { ctx = null; }
    },
    // Por cuadro. dt en segundos.
    actualizar({ caminando = false, trotando = false, enAire = false, dt = 1 / 60 } = {}) {
      if (!ctx) return;
      dt = Math.min(Math.max(dt || 0, 0), 0.1);
      const objetivo = trotando ? 2 : caminando ? 3 : 4;
      ciclo += (objetivo - ciclo) * Math.min(1, dt * 0.8);
      fase = (fase + dt / ciclo) % 1;
      const r = respiracion(fase), esfuerzo = trotando ? 1.35 : 1;
      resp.gain.setTargetAtTime(r.v * esfuerzo, ahora(), 0.04);
      filtroResp.frequency.setTargetAtTime(r.f, ahora(), 0.08);
      // Pasos amortiguados.
      if ((caminando || trotando) && !enAire) {
        tPaso += dt;
        const intervalo = trotando ? 0.4 : 0.6;
        if (tPaso >= intervalo) {
          tPaso %= intervalo;
          pie ^= 1;
          const t0 = ahora() + 0.01, v = trotando ? 0.32 : 0.24;
          golpe(t0, pie ? 95 : 85, 42, 0.14, v, 210);
          rafaga(t0, "lowpass", 450, 0.7, 0.08, v * 0.18);
        }
      } else tPaso = 0.3;
    },
    salto() {
      if (!ctx) return;
      const t0 = ahora() + 0.01;
      rafaga(t0, "bandpass", 700, 0.9, 0.3, 0.1, 0.04);   // resoplido
      golpe(t0, 80, 50, 0.1, 0.16, 200);                  // empuje
    },
    aterrizaje(fuerza = 0.5) {
      if (!ctx) return;
      const f = Math.min(Math.max(fuerza, 0), 1), t0 = ahora() + 0.01;
      golpe(t0, 75, 32, 0.3 + 0.15 * f, 0.2 + 0.3 * f, 180);
      // Crujido de polvo: granos cortos de ruido agudo apagado.
      const granos = 4 + Math.round(6 * f);
      for (let i = 0; i < granos; i++) {
        rafaga(t0 + 0.01 + Math.random() * 0.25, "bandpass", 1400 + Math.random() * 1400, 1.4, 0.03 + Math.random() * 0.04, (0.02 + 0.04 * f) * Math.random());
      }
    },
    bip() {
      if (!ctx) return;
      const t0 = ahora() + 0.01;
      tono(1320, t0, 0.07, 0.07); tono(1760, t0 + 0.09, 0.07, 0.07);
    },
    alerta() {
      if (!ctx) return;
      const t0 = ahora() + 0.01;
      [880, 740, 620].forEach((f, i) => tono(f, t0 + i * 0.2, 0.16, 0.09, "triangle"));
    },
    exito() {
      if (!ctx) return;
      const t0 = ahora() + 0.01;
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tono(f, t0 + i * 0.08, 0.7 - i * 0.08, 0.05, "triangle"));
    },
    silenciar(si = true) {
      silenciado = !!si;
      if (ctx) maestro.gain.setTargetAtTime(silenciado ? 0 : VOLUMEN, ahora(), 0.05);
    },
    get silenciado() { return silenciado; },
  };
  return api;
}
