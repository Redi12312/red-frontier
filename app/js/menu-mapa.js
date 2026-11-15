// Menú contextual del mapa (clic derecho o toque largo): junta las herramientas para no llenar el panel.
// Cada elemento: { texto, accion, ayuda?, deshabilitado? }, un título { titulo }, una fila de botones
// { fila: [{ letra, color, texto, accion }] } o "-" para separar.

export function crearMenuMapa(mapa) {
  const el = document.createElement("div");
  el.className = "menu-mapa";
  el.hidden = true;
  el.setAttribute("role", "menu");
  document.body.append(el);

  function cerrar() {
    if (el.hidden) return;
    el.hidden = true;
    el.innerHTML = "";
  }

  function boton(texto, accion, { ayuda, deshabilitado, clase } = {}) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    if (clase) b.className = clase;
    b.innerHTML = texto;
    if (ayuda) b.title = ayuda;
    b.disabled = !!deshabilitado;
    b.addEventListener("click", () => { cerrar(); accion(); });
    return b;
  }

  function abrir(x, y, items) {
    el.innerHTML = "";
    for (const it of items.filter(Boolean)) {
      if (it === "-") { el.append(document.createElement("hr")); continue; }
      if (it.titulo) {
        const t = document.createElement("div");
        t.className = "menu-titulo";
        t.innerHTML = it.titulo;
        el.append(t);
        continue;
      }
      if (it.fila) {
        const fila = document.createElement("div");
        fila.className = "menu-fila";
        for (const f of it.fila) {
          fila.append(boton(`<i style="--c:${f.color}">${f.letra}</i>`, f.accion, { ayuda: f.texto, clase: "menu-icono" }));
        }
        el.append(fila);
        continue;
      }
      el.append(boton(it.texto, it.accion, it));
    }
    el.hidden = false;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 6))}px`;
    el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 6))}px`;
    el.querySelector("button:not([disabled])")?.focus({ preventScroll: true });
  }

  document.addEventListener("pointerdown", (e) => { if (!el.hidden && !el.contains(e.target)) cerrar(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") cerrar(); });
  mapa.on("movestart zoomstart", cerrar);
  return { abrir, cerrar };
}
