// Antes de que arranque la app: si el servidor local tiene un guardado (guardado/estado.json), completa con él lo que
// le falte al navegador (por ejemplo, después de que el navegador borró su almacenamiento). Es síncrono a propósito:
// los módulos de la app leen sus datos apenas cargan. En un hosting estático la petición falla rápido y no pasa nada.
(function () {
  try {
    var x = new XMLHttpRequest();
    x.open("GET", "../api/guardado", false);
    x.send(null);
    if (x.status !== 200) return;
    var datos = JSON.parse(x.responseText || "{}");
    for (var k in datos) {
      if (Object.prototype.hasOwnProperty.call(datos, k) && k.indexOf("rf-") === 0 && localStorage.getItem(k) === null) {
        localStorage.setItem(k, datos[k]);
      }
    }
  } catch (e) { /* sin servidor o sin almacenamiento: la app sigue igual */ }
})();
