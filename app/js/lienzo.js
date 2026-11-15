// Capas raster dibujadas directo en un <canvas> sobre el mapa, sin pasar por PNG.
// Antes cada capa (12,5 M de celdas) se codificaba como PNG en cada cambio: era lo que más trababa la interfaz.

// Como L.ImageOverlay, pero el elemento es un lienzo ya dibujado (Leaflet lo estira a los bordes).
export const CapaLienzo = L.ImageOverlay.extend({
  _initImage() {
    const el = (this._image = this._url);
    L.DomUtil.addClass(el, "leaflet-image-layer");
    L.DomUtil.addClass(el, "capa-lienzo");
    if (this._zoomAnimated) L.DomUtil.addClass(el, "leaflet-zoom-animated");
    if (this.options.className) L.DomUtil.addClass(el, this.options.className);
    el.onselectstart = L.Util.falseFn;
    el.onmousemove = L.Util.falseFn;
    this._updateOpacity?.();
  },
});

export const capaLienzo = (lienzo, bordes, opciones = {}) => new CapaLienzo(lienzo, bordes, { interactive: false, ...opciones });

// Colorea una grilla (valores enteros 0–255) con una tabla de colores, reducida `k` veces por lado.
// Cada píxel toma el valor MÁS ALTO de su bloque: un peligro chico no desaparece al reducir.
export function lienzoDesdeLut(valores, valido, lut, ancho, alto, k = 2) {
  const w = Math.ceil(ancho / k), h = Math.ceil(alto / k);
  const lienzo = document.createElement("canvas");
  lienzo.width = w; lienzo.height = h;
  const ctx = lienzo.getContext("2d");
  const img = ctx.createImageData(w, h);
  const px = img.data;
  for (let fy = 0; fy < h; fy++) {
    const f0 = fy * k, f1 = Math.min(alto, f0 + k);
    for (let fx = 0; fx < w; fx++) {
      const c0 = fx * k, c1 = Math.min(ancho, c0 + k);
      let max = -1;
      for (let f = f0; f < f1; f++) {
        const fila = f * ancho;
        for (let c = c0; c < c1; c++) {
          const i = fila + c;
          if (valido && !valido[i]) continue;
          if (valores[i] > max) max = valores[i];
        }
      }
      if (max < 0) continue;
      const o = lut[max];
      if (!o || !o[3]) continue;
      const j = (fy * w + fx) * 4;
      px[j] = o[0]; px[j + 1] = o[1]; px[j + 2] = o[2]; px[j + 3] = o[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  return lienzo;
}
