// Relieve por rayos con alturas y textura bilineales, LOD continuo y niebla.
// La orto HiRISE es real; color, cielo y perspectiva son una representación simulada.
import { alturaEn, parametro, angular } from "./navegacion.js";
import { celdaALonLat, lonLatACelda } from "./zona.js";

export function muestraAltura(z, f, c) {
  if (f < 0 || c < 0 || f > z.alto - 1 || c > z.ancho - 1) return NaN;
  const ff = Math.min(z.alto - 2, Math.floor(f)), cc = Math.min(z.ancho - 2, Math.floor(c));
  const u = c - cc, v = f - ff, i = ff * z.ancho + cc;
  const a = alturaEn(z, i), b = alturaEn(z, i + 1), d = alturaEn(z, i + z.ancho), e = alturaEn(z, i + z.ancho + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + d * (1 - u) * v + e * u * v;
}

export function proyectarHito({ zona, posicion, hito, rumbo, cfg, giro = 0, cabeceo = 0 }) {
  const ancho = parametro(cfg, "ancho"), alto = parametro(cfg, "alto");
  const fov = parametro(cfg, "campo_grados") * Math.PI / 180, focal = ancho / (2 * Math.tan(fov / 2));
  const dx = (hito.c - posicion.c) * Math.abs(zona.meta.grilla.transform[0]), dy = (posicion.f - hito.f) * Math.abs(zona.meta.grilla.transform[4]);
  const dist = Math.hypot(dx, dy), angulo = angular(Math.atan2(dx, dy) * 180 / Math.PI - rumbo - giro) * Math.PI / 180;
  const z = muestraAltura(zona, hito.f, hito.c), z0 = muestraAltura(zona, posicion.f, posicion.c);
  if (!dist || Math.abs(angulo) >= fov / 2 || !Number.isFinite(z + z0)) return null;
  const profundidad = dist * Math.cos(angulo);
  return { x: ancho / 2 + Math.tan(angulo) * focal,
    y: alto * 0.48 + cabeceo - (z + parametro(cfg, "marcador_altura_m") - z0 - parametro(cfg, "altura_ojos_m")) * focal / profundidad, distancia_m: dist };
}

function crearVistaCanvas({ canvas, zona, cfg, contexto = null, textura = null, movimientoReducido = false }) {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D no está disponible.");
  const ancho = parametro(cfg, "ancho"), alto = parametro(cfg, "alto"), columnas = parametro(cfg, "columnas");
  canvas.width = ancho; canvas.height = alto;
  const muestras = parametro(cfg, "muestras"), distanciaMax = parametro(cfg, "distancia_m");
  const ojos = parametro(cfg, "altura_ojos_m"), fov = parametro(cfg, "campo_grados") * Math.PI / 180, focal = ancho / (2 * Math.tan(fov / 2));
  // Muestras geométricas: densas junto a los pies, espaciadas hacia el horizonte.
  const distancias = Float32Array.from({ length: muestras }, (_, k) => zona.paso / 2 * (distanciaMax / (zona.paso / 2)) ** (k / (muestras - 1)));
  const rayos = Float32Array.from({ length: columnas }, (_, k) => Math.atan(((k + 0.5) / columnas * ancho - ancho / 2) / focal));
  const imagen = ctx.createImageData(ancho, alto), pixeles = new Uint32Array(imagen.data.buffer), cieloBase = new Uint32Array(pixeles.length);
  const rgba = (r, g, b) => (255 << 24 | Math.round(b) << 16 | Math.round(g) << 8 | Math.round(r)) >>> 0;
  const estadisticas = { cuadros: 0, total_ms: 0, max_ms: 0, fps: 0, ancho, alto, salida: "Canvas2D", textura: !!textura };
  let giro = 0, cabeceo = 0, primerTiempo = null, primerCuadro = 0, ultimoDia = -1;
  const gris = (f, c) => {
    const x = Math.max(0, Math.min(textura.ancho - 1, (c + 0.5) / zona.ancho * textura.ancho - 0.5));
    const y = Math.max(0, Math.min(textura.alto - 1, (f + 0.5) / zona.alto * textura.alto - 0.5));
    const ix = Math.min(textura.ancho - 2, Math.floor(x)), iy = Math.min(textura.alto - 2, Math.floor(y)), u = x - ix, v = y - iy, i = (iy * textura.ancho + ix) * 4;
    return (textura.datos[i] * (1 - u) * (1 - v) + textura.datos[i + 4] * u * (1 - v)
      + textura.datos[i + textura.ancho * 4] * (1 - u) * v + textura.datos[i + textura.ancho * 4 + 4] * u * v) / 255;
  };
  function dibujar(estado, ahora = performance.now()) {
    const inicio = performance.now(), p = estado.verdad, rumbo = (estado.rumbo + giro) * Math.PI / 180;
    const z0 = muestraAltura(zona, p.f, p.c), geo = contexto ? celdaALonLat(zona.meta, p.f, p.c) : null;
    const lejos = contexto ? lonLatACelda(contexto.meta, geo.lon, geo.lat) : null;
    const dia = Math.max(0.1, Math.min(1, (estado.sol.elevacion + 8) / 40));
    if (Math.round(dia * 255) !== ultimoDia) {
      ultimoDia = Math.round(dia * 255);
      for (let y = 0; y < alto; y++) {
        const u = Math.min(1, y / (alto * 0.65));
        cieloBase.fill(rgba((55 + 139 * u) * dia, (59 + 74 * u) * dia, (65 + 26 * u) * dia), y * ancho, (y + 1) * ancho);
      }
    }
    pixeles.set(cieloBase);
    const balanceo = movimientoReducido ? 0 : parametro(cfg, "balanceo_m") * Math.sin(estado.t * parametro(cfg, "balanceo_hz") * Math.PI * 2);
    const horizonte = alto * 0.48 + cabeceo, solR = estado.sol.azimut * Math.PI / 180;
    const solSin = Math.sin(solR), solCos = Math.cos(solR);
    if (Number.isFinite(z0)) for (let col = 0; col < columnas; col++) {
      const ang = rumbo + rayos[col], sin = Math.sin(ang), cos = Math.cos(ang), correccion = Math.cos(rayos[col]);
      const x0 = Math.floor(col * ancho / columnas), x1 = Math.floor((col + 1) * ancho / columnas);
      let techo = alto;
      for (const dist of distancias) {
        const f = p.f - cos * dist / zona.paso, c = p.c + sin * dist / zona.paso;
        let z = muestraAltura(zona, f, c), remoto = false;
        if (!Number.isFinite(z) && contexto) { z = muestraAltura(contexto, lejos.f - cos * dist / contexto.paso, lejos.c + sin * dist / contexto.paso); remoto = true; }
        if (!Number.isFinite(z)) continue;
        const curvatura = dist * dist / (2 * zona.meta.proyeccion.radio_m);
        const y = Math.max(0, Math.min(alto, Math.floor(horizonte - (z - z0 - ojos - balanceo - curvatura) * focal / (dist * correccion))));
        if (y >= techo) continue;
        const valor = textura && !remoto ? gris(f, c) : 0.58;
        const vecina = remoto ? NaN : muestraAltura(zona, f - solCos, c + solSin);
        const luz = Number.isFinite(vecina) ? Math.max(0.38, Math.min(1, 0.78 - (vecina - z) / zona.paso)) : 0.7;
        const niebla = 1 - Math.exp(-dist / distanciaMax * 3), brillo = (0.55 + valor * 0.8) * luz * dia;
        const color = rgba(185 * brillo * (1 - niebla) + 179 * dia * niebla, 132 * brillo * (1 - niebla) + 133 * dia * niebla, 91 * brillo * (1 - niebla) + 99 * dia * niebla);
        for (let fila = y; fila < techo; fila++) pixeles.fill(color, fila * ancho + x0, fila * ancho + x1);
        techo = y; if (techo <= 0) break;
      }
    }
    ctx.putImageData(imagen, 0, 0);
    const dxSol = angular(estado.sol.azimut - estado.rumbo - giro) * Math.PI / 180;
    if (Math.abs(dxSol) < fov / 2 && estado.sol.elevacion > 0) {
      const sx = ancho / 2 + Math.tan(dxSol) * focal, sy = horizonte - Math.tan(estado.sol.elevacion * Math.PI / 180) * focal;
      const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, ancho / 18);
      halo.addColorStop(0, "#fff8d9cc"); halo.addColorStop(0.2, "#fff0b94a"); halo.addColorStop(1, "#fff0b900"); ctx.fillStyle = halo;
      ctx.fillRect(sx - ancho / 18, sy - ancho / 18, ancho / 9, ancho / 9);
      ctx.fillStyle = "#fff4d7"; ctx.beginPath(); ctx.arc(sx, sy, ancho / 180, 0, Math.PI * 2); ctx.fill();
    }
    const ms = performance.now() - inicio;
    estadisticas.cuadros++; estadisticas.total_ms += ms; estadisticas.max_ms = Math.max(estadisticas.max_ms, ms);
    primerTiempo ??= ahora;
    // Ventana de un segundo: evita que una pausa o carga inicial falsee el fps vivo.
    if (ahora - primerTiempo >= 1000) { estadisticas.fps = (estadisticas.cuadros - primerCuadro) * 1000 / (ahora - primerTiempo); primerTiempo = ahora; primerCuadro = estadisticas.cuadros; }
    return { ...estadisticas, promedio_ms: estadisticas.total_ms / estadisticas.cuadros };
  }
  return { dibujar, mirar: (azimut, elevacion = 0) => { giro = azimut; cabeceo = elevacion; }, estadisticas };
}

export async function leerTextura(url, anchoMax) {
  const imagen = new Image(); imagen.src = url; await imagen.decode();
  const c = document.createElement("canvas"); c.width = Math.min(anchoMax, imagen.width); c.height = Math.round(imagen.height * c.width / imagen.width);
  const g = c.getContext("2d"); g.drawImage(imagen, 0, 0, c.width, c.height);
  return { imagen, ancho: c.width, alto: c.height, datos: g.getImageData(0, 0, c.width, c.height).data };
}

// WebGL nativo: la malla se reconstruye al desplazarse, la GPU mueve la cámara.
export function crearVistaMarte(opciones) {
  const gl = opciones.canvas.getContext("webgl", { alpha: false, antialias: true });
  if (!gl?.createShader) return crearVistaCanvas({ ...opciones, cfg: { ...opciones.cfg, ancho: opciones.cfg.respaldo_ancho, alto: opciones.cfg.respaldo_alto, columnas: opciones.cfg.respaldo_columnas, muestras: opciones.cfg.respaldo_muestras } });
  return crearVistaWebGL({ ...opciones, gl });
}

function crearVistaWebGL({ canvas, gl, zona, cfg, contexto, textura, movimientoReducido }) {
  const ancho = parametro(cfg, "ancho"), alto = parametro(cfg, "alto");
  canvas.width = ancho; canvas.height = alto; gl.viewport(0, 0, ancho, alto);
  const distancia = parametro(cfg, "distancia_m"), lado = parametro(cfg, "malla_lado"), niveles = parametro(cfg, "niveles_malla");
  const cercano = parametro(cfg, "plano_cercano_m"), focal = 1 / Math.tan(parametro(cfg, "campo_grados") * Math.PI / 360);
  const shaders = [], programas = [], buffers = [];
  function programa(vs, fs) {
    const compilar = (tipo, fuente) => { const s = gl.createShader(tipo); shaders.push(s); gl.shaderSource(s, fuente); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("No se pudo crear el visor."); return s; };
    const p = gl.createProgram(); programas.push(p); gl.attachShader(p, compilar(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compilar(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("No se pudo crear el visor."); return p;
  }
  const cielo = programa(
    "attribute vec2 aP; varying vec2 vP; void main(){vP=aP;gl_Position=vec4(aP,0.,1.);}",
    "precision mediump float; varying vec2 vP; uniform float uDia; uniform vec2 uSol; uniform float uVisible; void main(){float u=clamp((1.-vP.y)*.77,0.,1.);vec3 c=mix(vec3(.216,.231,.255),vec3(.761,.522,.357),u)*uDia;float d=length((vP-uSol)*vec2(1.,.5625));c+=vec3(.7,.6,.4)*exp(-d*d*1500.)*uVisible;gl_FragColor=vec4(c,1.);}");
  const terreno = programa(
    "attribute vec3 aP;attribute vec2 aUV;attribute vec3 aN;uniform vec3 uCam;uniform vec2 uDir;uniform vec4 uProy;uniform float uRadio;uniform float uCabeceo;varying vec2 vUV;varying vec3 vN;varying float vDist;void main(){vec3 p=aP-uCam;p.z-=dot(p.xy,p.xy)/(2.*uRadio);float d=dot(p.xy,uDir);float x=p.x*uDir.y-p.y*uDir.x;gl_Position=vec4(x*uProy.x,p.z*uProy.x*uProy.y+(.04+uCabeceo)*d,uProy.z*d+uProy.w,d);vDist=length(p.xy);vUV=aUV;vN=aN;}",
    "precision mediump float;uniform sampler2D uTex;uniform float uTieneTex;uniform vec3 uSol;uniform float uDia;uniform float uDist;varying vec2 vUV;varying vec3 vN;varying float vDist;void main(){float gris=.58;if(uTieneTex>.5&&vUV.x>=0.&&vUV.y>=0.&&vUV.x<=1.&&vUV.y<=1.)gris=texture2D(uTex,vUV).r;float luz=.38+.62*max(0.,dot(normalize(vN),uSol));vec3 c=vec3(.725,.518,.357)*(.55+gris*.8)*luz*uDia;float niebla=1.-exp(-vDist/uDist*3.);gl_FragColor=vec4(mix(c,vec3(.702,.522,.388)*uDia,niebla),1.);}");
  const crearBuffer = (tipo, datos) => { const b = gl.createBuffer(); buffers.push(b); gl.bindBuffer(tipo, b); gl.bufferData(tipo, datos, gl.STATIC_DRAW); return b; };
  const quad = crearBuffer(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]));
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (textura) {
    // WebGL 1 admite texturas no potencia de dos con LINEAR y CLAMP_TO_EDGE.
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (textura.ancho <= max && textura.alto <= max) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, textura.ancho, textura.alto, 0, gl.RGBA, gl.UNSIGNED_BYTE, textura.datos);
    else { const c = document.createElement("canvas"), factor = max / Math.max(textura.ancho, textura.alto); c.width = Math.floor(textura.ancho * factor); c.height = Math.floor(textura.alto * factor); c.getContext("2d").drawImage(textura.imagen, 0, 0, c.width, c.height); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c); }
  } else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([148,148,148,255]));
  let mallas = [], centro = null, zReferencia = 0, giro = 0, cabeceo = 0, inicioVentana = null, cuadrosVentana = 0;
  const estadisticas = { cuadros: 0, total_ms: 0, max_ms: 0, fps: 0, ancho, alto, salida: "WebGL", textura: !!textura, triangulos: 0, malla_ms: 0 };
  function reconstruir(p) {
    for (const m of mallas) { gl.deleteBuffer(m.vertices); gl.deleteBuffer(m.indices); }
    centro = { ...p }; zReferencia = muestraAltura(zona, p.f, p.c); mallas = [];
    const geo = contexto ? celdaALonLat(zona.meta, p.f, p.c) : null, lejos = contexto ? lonLatACelda(contexto.meta, geo.lon, geo.lat) : null;
    const a = Math.abs(zona.meta.grilla.transform[0]), e = Math.abs(zona.meta.grilla.transform[4]);
    const alturaLocal = (x, y) => {
      const local = muestraAltura(zona, p.f - y / e, p.c + x / a);
      if (Number.isFinite(local)) return local;
      return contexto ? muestraAltura(contexto, lejos.f - y / Math.abs(contexto.meta.grilla.transform[4]), lejos.c + x / Math.abs(contexto.meta.grilla.transform[0])) : NaN;
    };
    estadisticas.triangulos = 0;
    for (let nivel = 0; nivel < niveles; nivel++) {
      const paso = zona.paso * 2 ** nivel, n = lado + 1, datos = new Float32Array(n * n * 8), validas = new Uint8Array(n * n), indices = [];
      for (let f = 0; f <= lado; f++) for (let c = 0; c <= lado; c++) {
        const x = (c - lado / 2) * paso, y = (f - lado / 2) * paso, z = alturaLocal(x, y), k = f * n + c;
        if (!Number.isFinite(z)) continue; validas[k] = 1;
        const este = alturaLocal(x + paso, y), norte = alturaLocal(x, y + paso);
        datos.set([x,y,z-zReferencia, (p.c+x/a+.5)/zona.ancho, (p.f-y/e+.5)/zona.alto,
          Number.isFinite(este) ? -(este-z)/paso : 0, Number.isFinite(norte) ? -(norte-z)/paso : 0, 1], k * 8);
      }
      for (let f = 0; f < lado; f++) for (let c = 0; c < lado; c++) {
        if (nivel && Math.abs(c + .5 - lado / 2) < lado / 4 && Math.abs(f + .5 - lado / 2) < lado / 4) continue;
        const k = f * n + c;
        if (validas[k] && validas[k+1] && validas[k+n] && validas[k+n+1]) indices.push(k,k+1,k+n, k+1,k+n+1,k+n);
      }
      mallas.push({ vertices: crearBuffer(gl.ARRAY_BUFFER, datos), indices: crearBuffer(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices)), cantidad: indices.length });
      estadisticas.triangulos += indices.length / 3;
    }
  }
  const uniforme = (p, nombre) => gl.getUniformLocation(p, nombre);
  const atributo = (p, nombre, componentes, paso, desplazamiento) => { const a = gl.getAttribLocation(p, nombre); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, componentes, gl.FLOAT, false, paso, desplazamiento); };
  function dibujar(e, ahora = performance.now()) {
    const t0 = performance.now(), p = e.verdad;
    if (!centro || Math.hypot(p.f - centro.f, p.c - centro.c) * zona.paso > parametro(cfg, "recentrar_m")) { const t = performance.now(); reconstruir(p); estadisticas.malla_ms = performance.now() - t; }
    const rumbo = (e.rumbo + giro) * Math.PI / 180, dia = Math.max(.1, Math.min(1, (e.sol.elevacion + 8) / 40));
    gl.disable(gl.DEPTH_TEST); gl.useProgram(cielo); gl.bindBuffer(gl.ARRAY_BUFFER, quad); atributo(cielo, "aP", 2, 0, 0);
    const ds = angular(e.sol.azimut-e.rumbo-giro)*Math.PI/180;
    gl.uniform1f(uniforme(cielo,"uDia"),dia); gl.uniform2f(uniforme(cielo,"uSol"),Math.tan(ds)*focal, .04-2*cabeceo/alto+Math.tan(e.sol.elevacion*Math.PI/180)*focal*ancho/alto); gl.uniform1f(uniforme(cielo,"uVisible"),Math.abs(ds)<Math.PI/2&&e.sol.elevacion>0?1:0);
    gl.drawArrays(gl.TRIANGLES,0,6); gl.clear(gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST); gl.useProgram(terreno);
    const balanceo = movimientoReducido ? 0 : parametro(cfg,"balanceo_m")*Math.sin(e.t*parametro(cfg,"balanceo_hz")*Math.PI*2);
    gl.uniform3f(uniforme(terreno,"uCam"),(p.c-centro.c)*Math.abs(zona.meta.grilla.transform[0]),(centro.f-p.f)*Math.abs(zona.meta.grilla.transform[4]),muestraAltura(zona,p.f,p.c)-zReferencia+parametro(cfg,"altura_ojos_m")+balanceo);
    gl.uniform1f(uniforme(terreno,"uCabeceo"),-2*cabeceo/alto);gl.uniform2f(uniforme(terreno,"uDir"),Math.sin(rumbo),Math.cos(rumbo));gl.uniform1f(uniforme(terreno,"uRadio"),zona.meta.proyeccion.radio_m);
    gl.uniform4f(uniforme(terreno,"uProy"),focal,ancho/alto,(distancia+cercano)/(distancia-cercano),-2*distancia*cercano/(distancia-cercano));
    const az=e.sol.azimut*Math.PI/180, el=e.sol.elevacion*Math.PI/180;
    gl.uniform3f(uniforme(terreno,"uSol"),Math.sin(az)*Math.cos(el),Math.cos(az)*Math.cos(el),Math.sin(el));gl.uniform1f(uniforme(terreno,"uDia"),dia);gl.uniform1f(uniforme(terreno,"uDist"),distancia);gl.uniform1f(uniforme(terreno,"uTieneTex"),textura?1:0);gl.uniform1i(uniforme(terreno,"uTex"),0);gl.bindTexture(gl.TEXTURE_2D,tex);
    for (const m of mallas) { gl.bindBuffer(gl.ARRAY_BUFFER,m.vertices);atributo(terreno,"aP",3,32,0);atributo(terreno,"aUV",2,32,12);atributo(terreno,"aN",3,32,20);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,m.indices);gl.drawElements(gl.TRIANGLES,m.cantidad,gl.UNSIGNED_SHORT,0); }
    const ms=performance.now()-t0;estadisticas.cuadros++;estadisticas.total_ms+=ms;estadisticas.max_ms=Math.max(estadisticas.max_ms,ms);
    inicioVentana ??= ahora;if(ahora-inicioVentana>=1000){estadisticas.fps=(estadisticas.cuadros-cuadrosVentana)*1000/(ahora-inicioVentana);inicioVentana=ahora;cuadrosVentana=estadisticas.cuadros;}
    return {...estadisticas,promedio_ms:estadisticas.total_ms/estadisticas.cuadros};
  }
  return { dibujar, estadisticas, mirar(azimut,elevacion=0){giro=azimut;cabeceo=elevacion;}, cerrar(){for(const b of buffers)gl.deleteBuffer(b);for(const p of programas)gl.deleteProgram(p);for(const s of shaders)gl.deleteShader(s);gl.deleteTexture(tex);} };
}
