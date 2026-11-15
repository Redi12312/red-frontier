// Parser puro y adaptador opcional de Web Speech. El micrófono se abre solo con escuchar().
const FRASES = {
  estado: ["estado", "status", "report status"], oxigeno: ["oxigeno", "oxygen", "nivel de oxigeno"],
  posicion: ["donde estoy", "where am i", "mi posicion"], hito: ["proximo punto", "next waypoint", "siguiente punto"],
  regreso: ["regreso", "return", "volver", "go back"], pausa: ["pausa", "pause", "pausar"],
  seguir: ["seguir", "resume", "continuar"], rapido: ["mas rapido", "faster"], aborto: ["abortar", "abort"],
  foto: ["foto", "photo", "take photo", "sacar foto"], peligro: ["marcar peligro", "mark hazard"],
  ayuda: ["ayuda", "help"], terminar: ["terminar navegacion", "end navigation", "stop navigation"],
};
export const COMANDOS = Object.keys(FRASES);
export function interpretarComando(texto) {
  const limpio = String(texto ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().replace(/\s+/g, " ")
    .replace(/^(?:por favor|please) /, "").replace(/ (?:por favor|please)$/, "");
  return Object.entries(FRASES).find(([, variantes]) => variantes.includes(limpio))?.[0] ?? null;
}
export function crearVoz({ idioma = "es", alComando, alTexto = () => {}, alError = () => {}, entorno = globalThis } = {}) {
  const Reconocer = entorno.SpeechRecognition ?? entorno.webkitSpeechRecognition;
  let reconocimiento = null, cerrado = false, escuchando = false;
  const lang = idioma === "en" ? "en-US" : "es-UY";
  const mensaje = () => idioma === "en" ? "Voice recognition needs browser support and may require internet. Use the buttons or keyboard offline."
    : "El reconocimiento requiere soporte del navegador y puede necesitar internet. Usá botones o teclado sin conexión.";
  function hablar(texto) {
    if (cerrado || !entorno.speechSynthesis || !entorno.SpeechSynthesisUtterance) return;
    const u = new entorno.SpeechSynthesisUtterance(String(texto));
    u.lang = lang;
    const locales = entorno.speechSynthesis.getVoices().filter((v) => v.localService && v.lang.startsWith(idioma));
    if (locales.length) u.voice = locales[0];
    // Acota la cola y prioriza siempre el aviso vigente.
    entorno.speechSynthesis.cancel(); entorno.speechSynthesis.speak(u);
  }
  function escuchar() {
    if (cerrado || escuchando) return false;
    if (!Reconocer || entorno.navigator?.onLine === false) { alError(mensaje()); return false; }
    reconocimiento ??= new Reconocer();
    reconocimiento.lang = lang; reconocimiento.continuous = false; reconocimiento.interimResults = true;
    reconocimiento.onresult = (e) => {
      const r = e.results[e.resultIndex], texto = r[0].transcript;
      alTexto(texto);
      if (r.isFinal) {
        const comando = interpretarComando(texto);
        if (comando) alComando?.(comando, texto);
        else alError(idioma === "en" ? "Command not recognized. Open Help." : "No reconocí el comando. Abrí Ayuda.");
      }
    };
    reconocimiento.onerror = (e) => { escuchando = false; alError(`${mensaje()} (${e.error})`); };
    reconocimiento.onend = () => { escuchando = false; };
    try { reconocimiento.start(); escuchando = true; return true; }
    catch { alError(mensaje()); return false; }
  }
  return { escuchar, hablar, detenerEscucha: () => reconocimiento?.stop(), disponible: !!Reconocer,
    cerrar() { cerrado = true; reconocimiento?.abort(); entorno.speechSynthesis?.cancel(); } };
}
