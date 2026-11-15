// Guardado del trabajo de la tripulación (plan, bases, sesión, opciones). Se escribe en el navegador y, si la app
// corre con su servidor local (servidor.py), también en un archivo del proyecto (guardado/estado.json): así no se
// pierde aunque el navegador borre su almacenamiento. En un hosting estático queda solo el navegador.
const API = "../api/guardado";
let servidor = true, espera = null;

function todo() {
  const datos = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith("rf-")) datos[k] = localStorage.getItem(k);
    }
  } catch { /* sin almacenamiento */ }
  return datos;
}

async function subir() {
  if (!servidor) return;
  try {
    const r = await fetch(API, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(todo()) });
    if (!r.ok) servidor = false; // hosting estático: no insistir
  } catch {
    servidor = false;
  }
}
const programar = () => { clearTimeout(espera); espera = setTimeout(subir, 700); };

export function guardar(clave, valor) {
  try { localStorage.setItem(clave, valor); } catch { /* sigue en el servidor */ }
  programar();
}
export function borrar(clave) {
  try { localStorage.removeItem(clave); } catch { /* nada */ }
  programar();
}
// ¿El último guardado llegó también al archivo del proyecto?
export const enServidor = () => servidor;
