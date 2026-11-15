// Worker exclusivo del horizonte: una búsqueda óptica no ocupa la cola de las rutas.
import { altura, leerHttp } from "./zona.js";
import { muestreador, localizar, horizonte, DISTANCIAS } from "./localizador.js";
import { horizonteMedido } from "./horizonte-fotos.js";
import { fusionar } from "./geoubicacion.js";

// El horizonte necesita solo alturas. No duplica las demás capas del motor de rutas.
async function cargarRelieve(base) {
  const meta = await leerHttp(`${base}/meta.json`, "json");
  const archivo = `${base}/${meta.capas.elevacion.archivo}${meta.comprimido ? ".gz" : ""}`;
  let buffer = await leerHttp(archivo, "bin");
  if (meta.comprimido) {
    const flujo = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    buffer = await new Response(flujo).arrayBuffer();
  }
  const crudo = new Uint16Array(buffer);
  const { ancho, alto, paso_m: paso } = meta.grilla;
  if (crudo.length !== ancho * alto) throw new Error("Los archivos de la zona no coinciden con meta.json");
  const elevacion = Float32Array.from(crudo, (q) => altura(meta, q));
  return { meta, ancho, alto, paso, elevacion };
}

// El servicio también se prueba en Node; cada pedido espera la carga de su propia zona.
export function crearServicioLocalizacion({ enviar, cargar = cargarRelieve }) {
  let carga = null, version = 0, lejano = null, cola = Promise.resolve(), estimacionHorizonte = null;

  function recibir(data) {
    if (data.tipo === "cargar") {
      const actual = ++version;
      lejano = null;
      estimacionHorizonte = null;
      carga = cargar(data.base);
      // Registrar el rechazo enseguida: el pedido siguiente vuelve a recibir el error.
      carga.catch((error) => {
        if (actual === version) enviar({ tipo: "error", mensaje: error.message, pedido: data.pedido });
      });
      cola = Promise.resolve();
      return carga.catch(() => {});
    }
    if (!["localizar", "localizar_fotos", "geoubicar"].includes(data.tipo)) return Promise.resolve();
    const actual = version, pendiente = carga;
    const trabajo = cola.then(async () => {
      const emitir = (m) => { if (actual === version) enviar({ ...m, pedido: data.pedido }); };
      try {
        if (!pendiente) throw new Error("sin datos del terreno");
        const zona = await pendiente;
        if (actual !== version) return;
        const t0 = performance.now();
        if (data.tipo === "geoubicar") {
          const previa = data.horizonte ?? estimacionHorizonte;
          if (data.usarHorizonte && !previa) throw new Error("Calculá de nuevo el horizonte antes de fusionarlo.");
          const resultado = fusionar(zona, { horizonte: data.usarHorizonte ? previa : null,
            medidas: data.medidas, cfg: data.cfg, cfgBarometro: data.cfgBarometro });
          emitir({ tipo: "geoubicacion", resultado, segundos: (performance.now() - t0) / 1000 });
          return;
        }
        estimacionHorizonte = null;
        const ev = (evento, datos) => emitir({ tipo: "evento", evento, t: (performance.now() - t0) / 1000, datos });
        let lineas = null, medido = data.medido;
        if (data.tipo === "localizar_fotos") {
          ev("inicio_fotos", { fotos: data.fotos.length });
          const med = horizonteMedido(data.fotos, 0.25, 6, (fr, informe) => {
            emitir({ tipo: "localizando", fraccion: 0.15 * fr, texto: "Leyendo el horizonte de las fotos" });
            ev("foto", informe);
          });
          medido = { azimut: med.az, elevacion: med.el.map((v) => Number.isFinite(v) ? v : null) };
          lineas = med.lineas;
        }
        const claveLejano = `${data.raizDatos}/${data.relieveLejano}`;
        if (!lejano || lejano.clave !== claveLejano) {
          const lejos = await cargar(claveLejano);
          if (actual !== version) return;
          lejano = { clave: claveLejano, m: muestreador(lejos.elevacion, lejos.ancho, lejos.alto, lejos.meta.grilla.transform) };
        }
        medido ??= await leerHttp(data.medidoUrl, "json");
        if (actual !== version) return;
        const m = zona.meta, lejosM = lejano.m;
        const lat = (m.limites.lat_sur + m.limites.lat_norte) / 2;
        const ctx = {
          cerca: muestreador(zona.elevacion, zona.ancho, zona.alto, m.grilla.transform),
          lejos: (x, y) => lejosM(x, y) + data.sesgo,
          medido: { az: medido.azimut, el: medido.elevacion.map((v) => v === null ? NaN : v) },
          geo: { fe: Math.cos(lat * Math.PI / 180), radio: m.proyeccion.radio_m, alturaCamara: data.alturaCamara },
        };
        if (!ctx.medido.el.some(Number.isFinite)) throw new Error("sin datos del terreno");
        const conDato = ctx.medido.el.filter(Number.isFinite).length;
        ev("medido", { az: ctx.medido.az, el: ctx.medido.el.map((v) => Number.isFinite(v) ? v : null), conDato, total: ctx.medido.el.length });
        ev("parametros", {
          zona: m.nombre, km2: zona.ancho * zona.alto * zona.paso * zona.paso / 1e6,
          relieveCercano: `${m.id} (${zona.paso} m)`, relieveLejano: `${data.relieveLejano} (200 m)`,
          sesgo: data.sesgo, alturaCamara: data.alturaCamara, radio: m.proyeccion.radio_m,
        });
        const [a, , x0, , e, y0] = m.grilla.transform;
        const lim = { xMin: x0, xMax: x0 + zona.ancho * a, yMax: y0, yMin: y0 + zona.alto * e };
        let ultimo = 0;
        const base = data.tipo === "localizar_fotos" ? 0.15 : 0, parte = 1 - base;
        const az = ctx.medido.az;
        const r = localizar(ctx, lim, (fraccion, texto) => {
          if (fraccion - ultimo >= 0.01) {
            ultimo = fraccion;
            emitir({ tipo: "localizando", fraccion: base + parte * fraccion, texto });
          }
        }, (tipo, datos) => {
          ev(tipo, datos);
          if (tipo === "mejor") {
            const calculado = horizonte(ctx.cerca, ctx.lejos, datos.x, datos.y, az.map((v) => v + (datos.giro || 0)), DISTANCIAS.fina, ctx.geo);
            ev("horizonte_mejor", { etapa: datos.etapa, calculado: Array.from(calculado) });
          }
        });
        const calculado = Array.from(horizonte(ctx.cerca, ctx.lejos, r.x, r.y, az.map((v) => v + r.giro), DISTANCIAS.fina, ctx.geo));
        estimacionHorizonte = { mejor: { f: (r.y - y0) / e - 0.5, c: (r.x - x0) / a - 0.5 }, error_m: r.incertidumbre };
        ev("fin", { segundos: (performance.now() - t0) / 1000, candidatos: r.candidatos });
        emitir({ tipo: "ubicacion", parada: data.parada, ...r, calculado, medido: ctx.medido, lineas });
      } catch (error) {
        emitir({ tipo: "error", mensaje: error.message });
      }
    });
    cola = trabajo;
    return trabajo;
  }
  return { recibir };
}

if (typeof self !== "undefined") {
  const servicio = crearServicioLocalizacion({ enviar: (m) => self.postMessage(m) });
  self.onmessage = ({ data }) => { void servicio.recibir(data); };
}
