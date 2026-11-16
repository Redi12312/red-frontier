// Mapa del modo práctica: minimapa orientado con el rumbo y vista ampliada de la zona.
// Coordenadas locales en metros: x hacia el este, y hacia el norte; rumbo en grados (0 = norte, horario).

const RAD = Math.PI / 180;
const FPS_MAX = 15;
const ESCALA_MINI = 0.6; // px por metro en el minimapa
const BARRA_M = 50;

// Punto del mundo → desplazamiento en pantalla (px) desde el centro, con el rumbo hacia arriba.
export function aPantalla(punto, centro, rumbo, escala) {
  const dx = punto.x - centro.x, dy = punto.y - centro.y;
  const s = Math.sin(rumbo * RAD), c = Math.cos(rumbo * RAD);
  const adelante = dx * s + dy * c, derecha = dx * c - dy * s;
  return { x: derecha * escala, y: -adelante * escala };
}

// Inversa: desplazamiento en pantalla (px) desde el centro → punto del mundo.
export function dePantalla(pantalla, centro, rumbo, escala) {
  const derecha = pantalla.x / escala, adelante = -pantalla.y / escala;
  const s = Math.sin(rumbo * RAD), c = Math.cos(rumbo * RAD);
  return { x: centro.x + derecha * c + adelante * s, y: centro.y - derecha * s + adelante * c };
}

// Acepta {x,y} o [x,y,...].
export const aPunto = (p) => (p == null ? null : Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y });

// Fondo de la zona, un píxel por celda: sombreado de relieve (luz del NO) en tonos marcianos,
// modulado por el brillo del orto si existe. Devuelve RGBA.
export function pixelesFondo(t) {
  const { ancho, alto, paso, h } = t;
  const brillo = t.brillo || null, vedado = t.vedado || null;
  const out = new Uint8ClampedArray(ancho * alto * 4);
  const elev = 45 * RAD, az = 315 * RAD;
  const lx = Math.sin(az) * Math.cos(elev), ly = Math.cos(az) * Math.cos(elev), lz = Math.sin(elev);
  const H = (q, r) => h[Math.max(0, Math.min(alto - 1, r)) * ancho + Math.max(0, Math.min(ancho - 1, q))];
  for (let r = 0; r < alto; r++) for (let q = 0; q < ancho; q++) {
    const i = r * ancho + q;
    let luz = 0.75;
    if (h) {
      const gx = (H(q + 1, r) - H(q - 1, r)) / (2 * paso); // hacia el este
      const gy = (H(q, r - 1) - H(q, r + 1)) / (2 * paso); // hacia el norte (fila menor)
      const n = Math.hypot(gx, gy, 1);
      luz = Math.max(0, (-gx * lx - gy * ly + lz) / n);
    }
    let k = 0.35 + 0.75 * luz;
    if (brillo) k *= 0.6 + 0.8 * brillo[i];
    let rr = 196 * k, gg = 112 * k, bb = 72 * k;
    if (vedado && vedado[i]) { rr = rr * 0.7 + 40; gg *= 0.55; bb *= 0.55; }
    out[i * 4] = rr; out[i * 4 + 1] = gg; out[i * 4 + 2] = bb; out[i * 4 + 3] = 255;
  }
  return out;
}

const CSS = `
.rf-mapa-caja{position:fixed;right:16px;bottom:16px;width:180px;height:180px;border-radius:50%;overflow:hidden;
  z-index:30;background:#1d110b;border:2px solid rgba(255,220,190,.55);box-shadow:0 4px 18px rgba(0,0,0,.55);
  cursor:pointer;transition:width .2s,height .2s,border-radius .2s;touch-action:manipulation}
.rf-mapa-caja canvas{display:block;width:100%;height:100%}
.rf-mapa-caja.rf-mapa-grande{right:50%;bottom:50%;transform:translate(50%,50%);width:min(92vw,max(60vw,360px));
  height:min(80vh,max(60vh,320px));border-radius:14px}
.rf-mapa-leyenda{display:none;position:absolute;left:8px;bottom:8px;padding:6px 8px;border-radius:8px;
  background:rgba(20,10,6,.78);color:#f3e2d4;font:12px/1.35 system-ui,sans-serif;pointer-events:none}
.rf-mapa-grande .rf-mapa-leyenda{display:block}
.rf-mapa-leyenda i{display:inline-block;width:14px;height:0;margin-right:6px;vertical-align:middle;border-top:3px solid}
.rf-mapa-leyenda b{display:inline-block;width:10px;height:10px;margin-right:6px;border-radius:50%;vertical-align:middle}
@media (max-width:600px){.rf-mapa-caja{width:140px;height:140px;right:10px;bottom:10px}}
`;

function inyectarCss() {
  if (document.getElementById("rf-mapa-css")) return;
  const s = document.createElement("style");
  s.id = "rf-mapa-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function crearMapa(contenedor, { terreno, ruta = [], bases = [], idioma = "es" }) {
  inyectarCss();
  const EN = idioma === "en";
  const L = (es, en) => (EN ? en : es);
  const t = terreno;
  const caja = document.createElement("div");
  caja.className = "rf-mapa-caja";
  caja.setAttribute("role", "img");
  caja.setAttribute("aria-label", L("Mapa (tocá para ampliar)", "Map (tap to enlarge)"));
  caja.title = L("Tocá para ampliar o achicar el mapa", "Tap to enlarge or shrink the map");
  const lienzo = document.createElement("canvas");
  const leyenda = document.createElement("div");
  leyenda.className = "rf-mapa-leyenda";
  leyenda.innerHTML = [
    `<div><i style="border-color:#ffe9a8;border-top-style:dashed"></i>${L("Ruta segura planificada", "Planned safe route")}</div>`,
    `<div><i style="border-color:#7fd3ff"></i>${L("Tu rastro", "Your track")}</div>`,
    `<div><b style="background:rgba(255,255,255,.25);border:1px solid #fff"></b>${L("Error de posición", "Position error")}</div>`,
    `<div><b style="background:#4ade80"></b>${L("Compañero", "Partner")}</div>`,
    `<div><b style="background:#3b82f6"></b>H ${L("Hábitat", "Habitat")} · <b style="background:#facc15;margin-left:4px"></b>C ${L("Base de campo", "Field camp")}</div>`,
    `<div><b style="background:#ef4444"></b>${L("Desvío de emergencia", "Emergency diversion")}</div>`,
  ].join("");
  caja.append(lienzo, leyenda);
  contenedor.appendChild(caja);
  const ctx = lienzo.getContext("2d");

  // Fondo pre-renderizado una sola vez.
  let fondo = null;
  if (t && t.ancho && t.alto) {
    fondo = document.createElement("canvas");
    fondo.width = t.ancho; fondo.height = t.alto;
    fondo.getContext("2d").putImageData(new ImageData(pixelesFondo(t), t.ancho, t.alto), 0, 0);
  }
  const paso = t?.paso ?? t?.paso_m ?? 1;
  const zona = t ? { x0: t.x0, y0: t.y0, w: t.ancho * paso, h: t.alto * paso } : null;
  const rutaP = ruta.map(aPunto);
  const basesP = bases.map((b) => ({ ...b, ...aPunto(b) }));

  let grande = false, estado = null, ultimo = 0, pendiente = 0, dpr = 1, W = 0, Hh = 0;

  function medir() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = caja.getBoundingClientRect();
    W = Math.max(1, r.width); Hh = Math.max(1, r.height);
    lienzo.width = Math.round(W * dpr); lienzo.height = Math.round(Hh * dpr);
  }

  // Vista actual: centro del mundo, rumbo de la vista y escala (px/m).
  function vista() {
    if (grande && zona) {
      const esc = Math.min((W - 24) / zona.w, (Hh - 24) / zona.h);
      return { centro: { x: zona.x0 + zona.w / 2 - paso / 2, y: zona.y0 - zona.h / 2 + paso / 2 }, rumbo: 0, esc };
    }
    const c = aPunto(estado?.estimada) || { x: 0, y: 0 };
    return { centro: c, rumbo: grande ? 0 : estado?.rumbo || 0, esc: grande ? 1.2 : ESCALA_MINI };
  }

  function dibujar() {
    ultimo = performance.now();
    if (!W) medir();
    const { centro, rumbo, esc } = vista();
    const cx = W / 2, cy = Hh / 2;
    const P = (p) => { const s = aPantalla(p, centro, rumbo, esc); return [cx + s.x, cy + s.y]; };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1d110b";
    ctx.fillRect(0, 0, W, Hh);

    // Fondo girado con el rumbo.
    if (fondo) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-rumbo * RAD);
      ctx.scale(esc, esc);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(fondo, t.x0 - centro.x - paso / 2, centro.y - t.y0 - paso / 2, t.ancho * paso, t.alto * paso);
      ctx.restore();
    }

    const linea = (pts, color, ancho, guiones = []) => {
      if (pts.length < 2) return;
      ctx.beginPath();
      pts.forEach((p, k) => { const [x, y] = P(p); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = color; ctx.lineWidth = ancho; ctx.setLineDash(guiones); ctx.stroke(); ctx.setLineDash([]);
    };
    ctx.lineJoin = ctx.lineCap = "round";
    linea(rutaP, "rgba(255,233,168,.75)", 2, [5, 5]);
    if (estado?.recorrido?.length) linea(estado.recorrido.map(aPunto), "rgba(127,211,255,.85)", 2);

    // Bases.
    for (const b of basesP) {
      const [x, y] = P(b);
      const habitat = /hab|^h$/i.test(b.tipo || "");
      ctx.fillStyle = habitat ? "#3b82f6" : "#facc15";
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.rect(x - 7, y - 7, 14, 14); ctx.fill(); ctx.stroke();
      ctx.fillStyle = habitat ? "#fff" : "#1d110b";
      ctx.font = "bold 10px system-ui,sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(habitat ? "H" : "C", x, y + 0.5);
      if (grande && b.nombre) etiqueta(b.nombre, x + 10, y - 10);
    }

    // Destino con bandera.
    const dest = aPunto(estado?.destino);
    if (dest) {
      const [x, y] = P(dest);
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 16); ctx.stroke();
      ctx.fillStyle = "#4ade80";
      ctx.beginPath(); ctx.moveTo(x, y - 16); ctx.lineTo(x + 11, y - 12); ctx.lineTo(x, y - 8); ctx.fill();
      if (grande && estado.destino.nombre) etiqueta(estado.destino.nombre, x + 12, y - 18);
    }

    // Desvío de emergencia en rojo, con línea desde la posición estimada.
    const desv = aPunto(estado?.desvio), est = aPunto(estado?.estimada);
    if (desv) {
      const [x, y] = P(desv);
      if (est) { const [ex, ey] = P(est); ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 2.5; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]); }
      ctx.fillStyle = "#ef4444"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.font = "bold 10px system-ui,sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("!", x, y + 0.5);
      if (grande && estado.desvio.nombre) etiqueta(estado.desvio.nombre, x + 10, y - 10, "#fecaca");
    }

    // Compañero.
    const comp = aPunto(estado?.companero);
    if (comp) {
      const [x, y] = P(comp);
      ctx.fillStyle = "#4ade80"; ctx.strokeStyle = "#0b2e16"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    }

    // Posición real (solo si se pide, para comparar con la estimada).
    const real = aPunto(estado?.real);
    if (real && estado?.mostrarReal) {
      const [x, y] = P(real);
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5); ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5); ctx.stroke();
    }

    // Jugador: círculo de error y triángulo (al centro y hacia arriba en el minimapa).
    if (est) {
      const [x, y] = P(est);
      const err = Math.max(0, Number(estado.estimada.error) || 0) * esc;
      if (err > 1) {
        ctx.fillStyle = "rgba(255,255,255,.16)"; ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, err, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(((estado.rumbo || 0) - rumbo) * RAD);
      ctx.fillStyle = "#7fd3ff"; ctx.strokeStyle = "#08202e"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(7, 7); ctx.lineTo(0, 3); ctx.lineTo(-7, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    // Escala gráfica de 50 m.
    const largo = BARRA_M * esc;
    const bx = grande ? W - largo - 16 : cx - largo / 2, by = grande ? Hh - 16 : Hh - 22;
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by); ctx.lineTo(bx + largo, by); ctx.lineTo(bx + largo, by - 4); ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = "bold 10px system-ui,sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.shadowColor = "#000"; ctx.shadowBlur = 3;
    ctx.fillText(`${BARRA_M} m`, bx + largo / 2, by - 3);

    // «N» que gira con el rumbo, sobre el borde.
    const rN = Math.min(W, Hh) / 2 - 12;
    const nx = cx - Math.sin(rumbo * RAD) * rN, ny = cy - Math.cos(rumbo * RAD) * rN;
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(20,10,6,.8)";
    ctx.beginPath(); ctx.arc(nx, ny, 9, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = "#ff8a6a"; ctx.font = "bold 11px system-ui,sans-serif"; ctx.textBaseline = "middle";
    ctx.fillText("N", nx, ny + 0.5);
  }

  function etiqueta(texto, x, y, color = "#f3e2d4") {
    ctx.font = "11px system-ui,sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.75)"; ctx.strokeText(texto, x, y);
    ctx.fillStyle = color; ctx.fillText(texto, x, y);
  }

  // Redibujo con tope de FPS: si llega muy seguido, se agenda el último estado.
  function pedirDibujo() {
    const espera = 1000 / FPS_MAX - (performance.now() - ultimo);
    if (espera <= 0) { clearTimeout(pendiente); pendiente = 0; dibujar(); }
    else if (!pendiente) pendiente = setTimeout(() => { pendiente = 0; dibujar(); }, espera);
  }

  function ampliar(si) {
    grande = !!si;
    caja.classList.toggle("rf-mapa-grande", grande);
    caja.setAttribute("aria-label", grande ? L("Mapa de la zona (tocá para achicar)", "Zone map (tap to shrink)") : L("Mapa (tocá para ampliar)", "Map (tap to enlarge)"));
    medir();
    dibujar();
    // Repetir al terminar la transición de tamaño.
    setTimeout(() => { medir(); dibujar(); }, 230);
  }
  const alternar = () => ampliar(!grande);

  caja.addEventListener("click", (ev) => { ev.stopPropagation(); alternar(); });
  window.addEventListener("resize", () => { medir(); pedirDibujo(); });
  medir();
  dibujar();

  return {
    actualizar(nuevo) { estado = nuevo; pedirDibujo(); },
    ampliar,
    alternar,
    get ampliado() { return grande; },
    elemento: caja,
  };
}
