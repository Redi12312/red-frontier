// Carga una zona generada por el pipeline (proyecto/datos/<id>/) y convierte coordenadas.
// Funciona en el navegador, en un Worker y en Node (recibe la función de lectura).

// Devuelve siempre las capas crudas (enteros, livianas). Con decodificar = true agrega las
// capas en unidades reales (Float32), que necesita el ruteo.
export async function cargarZona(base, leer, decodificar = false) {
  const meta = await leer(`${base}/meta.json`, "json");
  const { ancho, alto, paso_m } = meta.grilla;
  const c = meta.capas;
  // En la versión publicada las capas van comprimidas (gzip) para bajar menos: se descomprimen acá.
  const bin = (archivo) => (meta.comprimido ? leer(`${base}/${archivo}.gz`, "bin").then(descomprimir) : leer(`${base}/${archivo}`, "bin"));
  const [elevQ, pendQ, pendMaxQ, rugQ, valido] = await Promise.all([
    bin(c.elevacion.archivo).then((b) => new Uint16Array(b)),
    bin(c.pendiente.archivo).then((b) => new Uint8Array(b)),
    bin(c.pendiente_max.archivo).then((b) => new Uint8Array(b)),
    bin(c.rugosidad.archivo).then((b) => new Uint8Array(b)),
    bin(c.valido.archivo).then((b) => new Uint8Array(b)),
  ]);
  const n = ancho * alto;
  if (elevQ.length !== n || valido.length !== n) throw new Error("Los archivos de la zona no coinciden con meta.json");
  const zona = { meta, ancho, alto, paso: paso_m, crudo: { elevQ, pendQ, pendMaxQ, rugQ }, valido, blando: null };
  // Suelo blando probable (capa modelada, opcional: la agrega preparar_capas_extra.py).
  if (c.blando) {
    const b = await bin(c.blando.archivo).then((x) => new Uint8Array(x)).catch(() => null);
    if (b && b.length === n) zona.blando = b;
  }
  if (!decodificar) return zona;

  zona.elevacion = new Float32Array(n);
  zona.pendiente = new Float32Array(n);
  zona.rugosidad = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    zona.elevacion[i] = altura(meta, elevQ[i]);
    zona.pendiente[i] = pendQ[i] * c.pendiente.escala;
    zona.rugosidad[i] = rugQ[i] * c.rugosidad.escala;
  }
  return zona;
}

export function altura(meta, q) {
  const e = meta.capas.elevacion;
  return q === e.sin_dato ? NaN : e.z_min + q * e.z_escala;
}

// Valores reales de una celda, leídos de las capas crudas.
export function valoresCelda(zona, i) {
  const c = zona.meta.capas, r = zona.crudo;
  return {
    valido: !!zona.valido[i],
    altura: altura(zona.meta, r.elevQ[i]),
    pendiente: r.pendQ[i] * c.pendiente.escala,
    pendienteMax: r.pendMaxQ[i] * c.pendiente_max.escala,
    rugosidad: r.rugQ[i] * c.rugosidad.escala,
  };
}

async function descomprimir(buffer) {
  const flujo = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(flujo).arrayBuffer();
}

// Lectura con fetch para navegador y Worker. Configuración y metadatos siempre frescos; las capas grandes
// pueden salir de la caché del navegador (así el Worker no las vuelve a bajar en la versión publicada).
export async function leerHttp(url, tipo) {
  const r = await fetch(url, { cache: tipo === "json" ? "no-store" : "default" });
  if (!r.ok) throw new Error(`No se pudo leer ${url} (${r.status})`);
  return tipo === "json" ? r.json() : r.arrayBuffer();
}

// Celda (fila, columna; pueden tener decimales) ↔ longitud este y latitud planetocéntrica.
export function celdaALonLat(meta, f, c) {
  const [a, , x0, , e, y0] = meta.grilla.transform;
  const { radio_m, paralelo_estandar } = meta.proyeccion;
  const k = (radio_m * Math.PI) / 180;
  const x = x0 + (c + 0.5) * a, y = y0 + (f + 0.5) * e;
  return { lon: x / (k * Math.cos((paralelo_estandar * Math.PI) / 180)), lat: y / k };
}

export function lonLatACelda(meta, lon, lat) {
  const [a, , x0, , e, y0] = meta.grilla.transform;
  const { radio_m, paralelo_estandar } = meta.proyeccion;
  const k = (radio_m * Math.PI) / 180;
  const x = lon * k * Math.cos((paralelo_estandar * Math.PI) / 180), y = lat * k;
  return { f: (y - y0) / e - 0.5, c: (x - x0) / a - 0.5 };
}
