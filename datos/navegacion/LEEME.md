# Navegación T21

Todo lo creado por T21 está en archivos nuevos. No se editaron `index.html`, `estilos.css`, `en.json`, la guía,
`app.js`, `plan.js`, `riesgo.js`, `ruteo.js`, `ruteo-worker.js` ni `beta/`. No se hicieron commits.

## Archivos

- `app/js/navegacion.js`: EKF local, sensores reproducibles, guía, avisos, bitácora, adaptación del motor existente.
- `app/js/navegacion-ui.js`: HUD accesible, cámara y cargas, medidas T18, comunicación con ambos Workers,
  controles, orientación del teléfono solo para mirar, JSON y GeoJSON.
- `app/js/voz.js`: parser bilingüe puro y adaptador opcional Web Speech.
- `app/js/vista-marte.js`: ray casting Canvas 2D con LOD, relieve cercano y regional, ortoimagen y Sol.
- `app/css/navegacion.css`, `app/i18n/navegacion.en.json`, `config/navegacion.json`.
- `pipeline/preparar_navegacion.js`: deriva el ejemplo sin descargas ni modificaciones de los datos fuente.
- `datos/navegacion/gale.json`: ruta, regresos seguros y rápidos, máscaras compactas, radios y archivo DONKI.
- `datos/navegacion/sensores.json`: serie simulada de referencia, reproducible con la semilla configurada.
- `pruebas/navegacion.test.js`, `pruebas/navegacion-ui.test.js`, `pruebas/navegacion-gale.bench.js`,
  `pruebas/navegacion-vista.html`, `pruebas/navegacion-suite.log`.

## Qué representa

El EKF mantiene posición este/norte y covarianza completa 2 × 2 en metros sobre la grilla. Integra pasos e IMU,
con sesgos y difusión configurados. Corrige mediante presión diferencial contra el DTM, distancias a balizas y
posiciones del horizonte. La referencia solar simulada corrige la actitud; no pretende ubicar con precisión usando
solo el Sol. El Worker de T18 admite además resección, odometría, UWB, posiciones Doppler y astronómicas externas.
El filtro es local y gaussiano: su círculo del 95 % requiere calibración y no representa todos los máximos ópticos.
La media no se pega a la ruta ni a la verdad del escenario. La fuente de la última corrección se conserva durante
la navegación a estima. Cada lectura tiene un identificador único dentro del filtro.

Oxígeno, CO₂, batería, agua y fallas usan `motor-simulacion.js` y `consumibles.js`. Los plazos y el radio de decisión
salen de `riesgo.json`, incluidos los valores efectivos de Opciones si la app los pasa. La temperatura y la presión
del traje son indicadores simulados constantes, sin modelo térmico. El pulso es simulado. No hay dosímetro.
Los tiempos de regreso son los de la ruta y los campos del motor existente; la desviación y la incertidumbre se
avisan por separado y requieren localizarse. La caminata siempre es simulada; no se conecta un traje real.

Los datos reales ya estaban en el proyecto: DTM y orto HiRISE, contexto MOLA-HRSC, fotos Navcam y sus horizontes,
y el archivo DONKI. Este último conserva fecha de descarga y período del archivo: no es un parte nuevo ni una
medición de dosis. H1 y las balizas son infraestructura ficticia. No se añadieron fuentes ajenas ni descargas, por
lo que no se modificó `CREDITOS.md`.

La foto real del escenario se habilita solamente cerca de su parada conocida. La verdad se usa para situar la
demostración y sintetizar instrumentos; nunca se manda al Worker óptico. El botón Foto usa el horizonte precalculado
desde las fotos originales y vuelve a correr la búsqueda. Para fotos nuevas se requieren `imageid`,
`camera_model_component_list` y `attitude`, como en T18. El reconocimiento puede necesitar internet según el
navegador; todos los comandos tienen botones y teclado. La síntesis offline necesita una voz local instalada.

## Integración exacta

En `app/index.html`, dentro de `head`:

```html
<link rel="stylesheet" href="css/navegacion.css">
```

En el grupo de acciones del plan:

```html
<button id="btn-navegar" type="button" disabled>Iniciar navegación</button>
```

En los imports de `app/js/app.js`:

```js
import { iniciarNavegacion, conectarBotonNavegacion } from "./navegacion-ui.js";
import { instanteSalidaNavegacion } from "./navegacion.js";
```

Luego de crear `planZona` y definir `rutaActual`, agregar:

```js
function contextoNavegacion(ruta = rutaActual(), evaluacion = null) {
  const zona = estado.zona;
  const ev = evaluacion ?? ruta?.evaluacion ??
    (estado.plan === "itinerario" ? planZona.ultimoItinerario()?.evaluacion : null);
  return {
    zona, ruta, aprobada: !!ev && evaluacionCompleta(ev).decision === "SI",
    plan: { marcas: planZona.bases() },
    opciones: {
      riesgo: estado.riesgo, worker: estado.worker, perfil: estado.perfiles[0],
      region: estado.region, prohibido: estado.prohibido,
      inicio_ms: zona && ruta?.sim?.celdas?.length
        ? instanteSalidaNavegacion(zona, ruta, estado.salida.hora_salida, Date.now()) : Date.now(),
      antenas: estado.marcas.base ? [
        { ...estado.marcas.base.celda, tipo: "base" }, ...planZona.balizas(),
      ] : [],
      vigente: () => estado.zona === zona,
    },
  };
}
conectarBotonNavegacion($("#btn-navegar"), () => contextoNavegacion(), (e) => avisar(e.message));
```

En el caso `data.tipo === "manual"`, inmediatamente después de `estado.ultimoManual = data.ruta;`:

```js
if (estado.ultimoManual) estado.ultimoManual.evaluacion = data.evaluacion;
```

Cada tramo aprobado por bases/días de T20 ya contiene `sim` y `evaluacion`. Se navega como una EVA independiente;
no se concatenan recargas y noches como si fueran caminata continua. Para agregar su botón, dentro del
`forEach` existente de `caja.querySelectorAll("[data-tramo]")` en `mostrarRutaBases`, junto al botón Simular:

```js
const tramoNavegable = c.tramos[+b.dataset.tramo];
const botonNavegable = document.createElement("button");
botonNavegable.type = "button";
b.after(botonNavegable);
conectarBotonNavegacion(botonNavegable,
  () => contextoNavegacion(tramoNavegable, tramoNavegable.evaluacion), (e) => avisar(e.message));
```

También se puede invocar directamente:

```js
await iniciarNavegacion(contextoNavegacion(tramo, tramo.evaluacion));
```

El adaptador del Worker usa `addEventListener`, conserva el `onmessage` de la app y separa pedidos con identificadores
propios. Al cerrar retira sus escuchas. No hace falta modificar el protocolo del Worker. El módulo propio carga su
diccionario y marca el HUD `data-no-traducir`, de modo que el observador de T19 no vuelve a traducirlo.

## Comandos y teclado

| Español | Inglés | Tecla |
|---|---|---|
| estado | status | S |
| oxígeno / oxigeno | oxygen | O |
| ¿dónde estoy? | where am I | P |
| próximo punto | next waypoint | N |
| regreso | return | R |
| pausa | pause | Espacio |
| seguir | resume | Espacio |
| más rápido | faster | + |
| abortar | abort | A |
| foto | photo | F |
| marcar peligro | mark hazard | M |
| ayuda | help | H |
| terminar navegación | end navigation | Esc |

Mantené V o el botón Hablar para escuchar; soltalos para finalizar la captura. También se acepta la activación del
botón con teclado. Las flechas miran alrededor, sin cambiar la posición. Los factores de reloj son ×1, ×10 y ×60.
El parser tolera mayúsculas, tildes, signos y «por favor» / «please», y rechaza frases ambiguas como «no abortar».

## Verificación

Desde `proyecto/`, en este entorno restringido:

```powershell
$env:NODE_OPTIONS='--preserve-symlinks --preserve-symlinks-main'
node pipeline/preparar_navegacion.js
node --test pruebas/navegacion.test.js pruebas/navegacion-ui.test.js
node pruebas/navegacion-gale.bench.js
node --test pruebas/
```

Las 23 pruebas propias verifican convergencia, deriva, límites, abortos, regreso, recursos, sensores, parser,
permisos diferidos, coordenadas, coherencia del escenario, apertura/cierre bilingüe, formulario, foto, respuestas
viejas y el contrato del Worker. La prueba de DOM no equivale a una captura real del HUD.

Medición del motor en este equipo: 802,7 s de salida simulada, 803 pasos de integración, 105 correcciones,
927 eventos, fin `A_SALVO`; alrededor de 359 ms de cómputo. Radio máximo modelado: 26,8 m; final: 16,7 m.
Todos los ruidos, corredor, indicadores simulados y parámetros de render son propuestas «a calibrar».

La suite general tiene una incompatibilidad de inventario con T19: `pruebas/idioma.test.js` solo consulta
`app/i18n/en.json` para todos los módulos, incluida T21. T21 sí traduce con su propio diccionario y su prueba pasa.
No se editaron ese test ni `en.json` para evitar interferir con T19. El ajuste para quien integra es usar
`navegacion.en.json` al inventariar los cuatro módulos nuevos y `config/navegacion.json`; el resto conserva el
diccionario global. No hay que copiar las traducciones al archivo compartido.

La revisión visual y los fps reales quedaron bloqueados: el control de computadora rechazó el acceso a Opera GX
(«Computer Use was not approved to use Navegador Opera GX»), sin otro motivo. No se declara alcanzado el objetivo
de 30 fps. Con el servidor local, abrí `http://127.0.0.1:8770/pruebas/navegacion-vista.html`; el botón de medición
ejecuta 20 s de `requestAnimationFrame` con DTM de Gale, orto y contexto regional a 1280 × 720 de salida y registra
fps, tiempo por cuadro y resolución interna LOD. El HUD incluye además un contador de rendimiento.
