// WebGL sin dependencias. Geometría del DTM, caras planas; adornos ilustrativos.
import { valorJuego } from "./juego-caminata.js";

const rad = Math.PI / 180;
const v3 = (x, y, z) => [x, y, z];
export function recortarCerca(puntos, cerca = 0.1) {
  const salida=[];
  for(let k=0;k<puntos.length;k++){
    const a=puntos[k],b=puntos[(k+1)%puntos.length],dentro=a[2]>=cerca,siguiente=b[2]>=cerca;
    if(dentro)salida.push(a);
    if(dentro!==siguiente){const u=(cerca-a[2])/(b[2]-a[2]);salida.push(a.map((x,i)=>x+(b[i]-x)*u));}
  }
  return salida;
}
function normal(a, b, c) {
  const u = b.map((v, i) => v - a[i]), v = c.map((x, i) => x - a[i]);
  let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1; n = n.map((x) => x / l);
  return n[1] < 0 ? n.map((x) => -x) : n;
}
function triangulo(salida, a, b, c, color) {
  const n = normal(a, b, c);
  for (const p of [a, b, c]) salida.push(...p, ...n, ...color);
}

export function crearMallaLowpoly({ zona: z, centro, cfg, ruta = [], corredor_m, corredor_ambar_m, marcadores = [] }) {
  const v = (k) => valorJuego(cfg, k), salida = [], base = Math.round(centro.f) * z.ancho + Math.round(centro.c), z0 = z.elevacion[base];
  const origen = { f: centro.f, c: centro.c, z: z0 };
  function punto(f, c, elevar = 0) {
    if (f < 0 || c < 0 || f >= z.alto || c >= z.ancho) return null;
    const i = Math.round(f) * z.ancho + Math.round(c);
    if (!z.valido[i] || !Number.isFinite(z.elevacion[i])) return null;
    return v3((c - centro.c) * z.paso, z.elevacion[i] - z0 + elevar, (f - centro.f) * z.paso);
  }
  const paleta = v("paleta"), radio = v("radio_m") / z.paso, cercano = v("radio_cerca_m") / z.paso;
  const detalle = Math.max(1, Math.round(v("cerca_m") / z.paso)), grueso = Math.max(detalle, Math.round(v("lejos_m") / z.paso));
  const f0 = Math.floor((centro.f - radio) / grueso) * grueso, c0 = Math.floor((centro.c - radio) / grueso) * grueso;
  for (let f = f0; f < centro.f + radio; f += grueso) for (let c = c0; c < centro.c + radio; c += grueso) {
    const cerca = Math.abs(f + grueso / 2 - centro.f) < cercano && Math.abs(c + grueso / 2 - centro.c) < cercano;
    const paso = cerca ? detalle : grueso;
    for (let df = 0; df < grueso; df += paso) for (let dc = 0; dc < grueso; dc += paso) {
      const ff = f + df, cc = c + dc, p = [punto(ff, cc), punto(ff, Math.min(c + grueso, cc + paso)), punto(Math.min(f + grueso, ff + paso), cc), punto(Math.min(f + grueso, ff + paso), Math.min(c + grueso, cc + paso))];
      if (p.some((a) => !a)) continue;
      for (const [a, b, d] of [[0, 2, 1], [1, 2, 3]]) {
        const n = normal(p[a], p[b], p[d]), indice = Math.min(paleta.length - 1, Math.floor((1 - n[1]) * paleta.length * 4));
        triangulo(salida, p[a], p[b], p[d], paleta[indice]);
      }
      const i = Math.round(ff) * z.ancho + Math.round(cc);
      if (cerca && z.rugosidad?.[i] > v("roca_rugosidad_m")) piramide(p[0], v("roca_m"), [0.36, 0.25, 0.2]);
    }
  }
  function piramide(p, tam, color) {
    const superior = [p[0], p[1] + tam * 2, p[2]], esquinas = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([x, y]) => [p[0] + x * tam, p[1], p[2] + y * tam]);
    for (let i = 0; i < 4; i++) triangulo(salida, esquinas[i], superior, esquinas[(i + 1) % 4], color);
  }
  function refugio(p,tam,color){
    const lados=6,centro=[p[0],p[1]+tam*2,p[2]];
    for(let k=0;k<lados;k++){
      const a=k/lados*Math.PI*2,b=(k+1)/lados*Math.PI*2;
      const q=[p[0]+Math.cos(a)*tam,p[1],p[2]+Math.sin(a)*tam],r=[p[0]+Math.cos(b)*tam,p[1],p[2]+Math.sin(b)*tam];
      const s=[q[0],centro[1],q[2]],t=[r[0],centro[1],r[2]];
      triangulo(salida,q,r,s,color);triangulo(salida,r,t,s,color);triangulo(salida,s,t,centro,color);
    }
  }
  // Tres bandas permiten distinguir el núcleo verde, el borde ámbar y la exclusión roja.
  for (const [ancho, color, alto] of [[corredor_ambar_m, [0.7,0.17,0.1],0.15], [(corredor_m + corredor_ambar_m) / 2,[0.8,0.53,0.1],0.2], [corredor_m,[0.12,0.55,0.36],0.25]]) {
    if (!(ancho > 0)) continue;
    for (let k = 1; k < ruta.length; k++) {
      const a = { f: Math.floor(ruta[k-1] / z.ancho), c: ruta[k-1] % z.ancho }, b = { f: Math.floor(ruta[k] / z.ancho), c: ruta[k] % z.ancho };
      if (Math.hypot(a.f-centro.f,a.c-centro.c) > radio) continue;
      const df = b.f-a.f, dc = b.c-a.c, l = Math.hypot(df,dc); if (!l) continue;
      const nf = dc/l*ancho/z.paso, nc = -df/l*ancho/z.paso;
      const p = [punto(a.f+nf,a.c+nc,alto),punto(a.f-nf,a.c-nc,alto),punto(b.f+nf,b.c+nc,alto),punto(b.f-nf,b.c-nc,alto)];
      if (p.some((q)=>!q)) continue;
      triangulo(salida,p[0],p[1],p[2],color); triangulo(salida,p[1],p[3],p[2],color);
    }
  }
  for (const m of marcadores) { const p = punto(m.f,m.c); if (p) {
    const color=m.color??[0.4,0.8,0.9];
    if(["habitat","refugio"].includes(m.tipo))refugio(p,v("marcador_m"),color);
    else piramide(p,v("marcador_m"),color);
  } }
  return { vertices: new Float32Array(salida), origen, triangulos: salida.length / 27 };
}

export function crearEscenaLowpoly({ canvas, zona, cfg, ruta, corredor_m, corredor_ambar_m, marcadores = [], movimientoReducido = false }) {
  const v = (k) => valorJuego(cfg,k);
  canvas.width=v("ancho"); canvas.height=v("alto");
  const gl=canvas.getContext("webgl",{alpha:false,antialias:true,preserveDrawingBuffer:true});
  const ctx=gl?null:canvas.getContext("2d",{alpha:false});
  if (!gl && !ctx) throw new Error("No hay renderer disponible.");
  const estadisticas={salida:gl?"WebGL":"Canvas2D",cuadros:0,total_ms:0,fps:0,triangulos:0,ancho:canvas.width,alto:canvas.height};
  let malla=null, comienzo=null, programa, buffer, bufferCielo, cerrado=false;
  let lugares;
  if (gl) {
    const compilar=(tipo,fuente)=>{const s=gl.createShader(tipo); gl.shaderSource(s,fuente);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
    const vs=compilar(gl.VERTEX_SHADER,`attribute vec3 p;attribute vec3 n;attribute vec3 color;uniform vec3 cam;uniform vec2 giro;uniform float aspecto;uniform float focal;uniform float lejos;uniform bool esCielo;varying vec3 tono;varying vec3 norma;varying float distancia;
      void main(){vec3 q=p-cam;float x=q.x*giro.y+q.z*giro.x;float d=q.x*giro.x-q.z*giro.y;gl_Position=esCielo?vec4(p.xy,0.9999,1.):vec4(x*focal/aspecto,q.y*focal,((lejos+0.1)/(lejos-0.1))*d-0.2*lejos/(lejos-0.1),d);tono=color;norma=n;distancia=d;}`);
    const fs=compilar(gl.FRAGMENT_SHADER,`precision mediump float;varying vec3 tono;varying vec3 norma;varying float distancia;uniform vec3 sol;uniform float niebla;uniform float dia;uniform bool esCielo;uniform float alto;
      void main(){if(esCielo){gl_FragColor=vec4(mix(vec3(0.75,0.52,0.35),vec3(0.22,0.21,0.25),gl_FragCoord.y/alto)*dia,1.);return;}float luz=0.35+0.65*max(0.,dot(normalize(norma),sol));float f=clamp(distancia*niebla,0.,0.92);vec3 cielo=vec3(0.68,0.45,0.3)*dia;gl_FragColor=vec4(mix(tono*luz*dia,cielo,f),1.);}`);
    programa=gl.createProgram();gl.attachShader(programa,vs);gl.attachShader(programa,fs);gl.linkProgram(programa);
    if(!gl.getProgramParameter(programa,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(programa));
    gl.deleteShader(vs);gl.deleteShader(fs); buffer=gl.createBuffer();
    bufferCielo=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,bufferCielo);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,0,0,1,0,0,0,0,1,-1,0,0,1,0,0,0,0,-1,1,0,0,1,0,0,0,0,-1,1,0,0,1,0,0,0,0,1,-1,0,0,1,0,0,0,0,1,1,0,0,1,0,0,0,0]),gl.STATIC_DRAW);
    lugares=Object.fromEntries(["cam","giro","aspecto","focal","lejos","sol","niebla","dia","esCielo","alto"].map((k)=>[k,gl.getUniformLocation(programa,k)]));
    gl.enable(gl.DEPTH_TEST);
  }
  function dibujar(e, ahora=performance.now()) {
    if(cerrado)return estadisticas;
    const inicio=performance.now(), p=e.verdad??e.real;
    if (!malla || Math.hypot(p.f-malla.origen.f,p.c-malla.origen.c)*zona.paso>v("lejos_m")) {
      malla=crearMallaLowpoly({zona,centro:p,cfg,ruta,corredor_m,corredor_ambar_m,marcadores});
      estadisticas.triangulos=malla.triangulos;
      if(gl){gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,malla.vertices,gl.STATIC_DRAW);}
    }
    // Apoya la cámara en la misma cara decimada: evita atravesar una cresta suavizada.
    const grueso=Math.max(1,Math.round(v("lejos_m")/zona.paso)),detalle=Math.max(1,Math.round(v("cerca_m")/zona.paso));
    const f0=Math.floor(p.f/grueso)*grueso,c0=Math.floor(p.c/grueso)*grueso;
    const ff=f0+Math.floor((p.f-f0)/detalle)*detalle,cc=c0+Math.floor((p.c-c0)/detalle)*detalle;
    const f1=Math.min(f0+grueso,ff+detalle),c1=Math.min(c0+grueso,cc+detalle),u=(p.c-cc)/(c1-cc),w=(p.f-ff)/(f1-ff);
    const z=(f,c)=>zona.elevacion[Math.round(f)*zona.ancho+Math.round(c)];
    const suelo=u+w<=1?z(ff,cc)+(z(ff,c1)-z(ff,cc))*u+(z(f1,cc)-z(ff,cc))*w:z(f1,c1)+(z(f1,cc)-z(f1,c1))*(1-u)+(z(ff,c1)-z(f1,c1))*(1-w);
    const a=(e.rumbo??0)*rad, cam=[(p.c-malla.origen.c)*zona.paso,(Number.isFinite(suelo)?suelo:z(p.f,p.c))-malla.origen.z+v("ojos_m"),(p.f-malla.origen.f)*zona.paso];
    const sol=e.sol??{azimut:0,elevacion:0}, az=sol.azimut*rad, el=sol.elevacion*rad, luz=[Math.sin(az)*Math.cos(el),Math.sin(el),-Math.cos(az)*Math.cos(el)], dia=Math.max(0.12,Math.min(1,(sol.elevacion+8)/40));
    const focal=1/Math.tan(v("campo_grados")*rad/2), niebla=(e.polvo?4:1)/v("radio_m");
    if(gl){
      gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0.68*dia,0.45*dia,0.3*dia,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.useProgram(programa);
      function atributos(b){gl.bindBuffer(gl.ARRAY_BUFFER,b);for(const [k,nombre] of ["p","n","color"].entries()){const l=gl.getAttribLocation(programa,nombre);gl.enableVertexAttribArray(l);gl.vertexAttribPointer(l,3,gl.FLOAT,false,36,k*12);}}
      gl.uniform3fv(lugares.cam,cam);gl.uniform2f(lugares.giro,Math.sin(a),Math.cos(a));gl.uniform1f(lugares.aspecto,canvas.width/canvas.height);
      gl.uniform1f(lugares.focal,focal);gl.uniform1f(lugares.lejos,v("radio_m")*2);gl.uniform3fv(lugares.sol,luz);gl.uniform1f(lugares.niebla,niebla);gl.uniform1f(lugares.dia,dia);
      gl.uniform1f(lugares.alto,canvas.height);gl.uniform1i(lugares.esCielo,1);atributos(bufferCielo);gl.disable(gl.DEPTH_TEST);gl.drawArrays(gl.TRIANGLES,0,6);
      gl.uniform1i(lugares.esCielo,0);atributos(buffer);gl.enable(gl.DEPTH_TEST);
      gl.drawArrays(gl.TRIANGLES,0,malla.vertices.length/9);
    }else{
      const cielo=ctx.createLinearGradient(0,0,0,canvas.height);cielo.addColorStop(0,"#40383a");cielo.addColorStop(1,"#bf8860");ctx.fillStyle=cielo;ctx.fillRect(0,0,canvas.width,canvas.height);
      const caras=[],vertices=malla.vertices, f=canvas.height*focal/2;
      for(let k=0;k<vertices.length;k+=27){const camara=[];
        for(let j=0;j<3;j++){const x=vertices[k+j*9]-cam[0],y=vertices[k+j*9+1]-cam[1],z=vertices[k+j*9+2]-cam[2];camara.push([x*Math.cos(a)+z*Math.sin(a),y,x*Math.sin(a)-z*Math.cos(a)]);}
        const poligono=recortarCerca(camara);if(poligono.length<3)continue;
        const prof=poligono.map((p)=>p[2]),puntos=poligono.map(([x,y,d])=>[canvas.width/2+x*f/d,canvas.height/2-y*f/d]);
        if(puntos.every((p)=>p[0]<0)||puntos.every((p)=>p[0]>canvas.width)||puntos.every((p)=>p[1]<0)||puntos.every((p)=>p[1]>canvas.height))continue;
        const d=prof.reduce((x,y)=>x+y)/3,l=0.35+0.65*Math.max(0,vertices[k+3]*luz[0]+vertices[k+4]*luz[1]+vertices[k+5]*luz[2]),fog=Math.min(0.92,d*niebla);
        const color=[0.68,0.45,0.3].map((c,i)=>Math.round(255*dia*(vertices[k+6+i]*l*(1-fog)+c*fog)));
        caras.push({d,puntos,color});
      }
      caras.sort((a,b)=>b.d-a.d);for(const c of caras){ctx.fillStyle=`rgb(${c.color.join(",")})`;ctx.beginPath();ctx.moveTo(...c.puntos[0]);for(const p of c.puntos.slice(1))ctx.lineTo(...p);ctx.closePath();ctx.fill();}
    }
    comienzo??=ahora;estadisticas.cuadros++;estadisticas.total_ms+=performance.now()-inicio;
    estadisticas.fps=ahora>comienzo?(estadisticas.cuadros-1)*1000/(ahora-comienzo):0;
    estadisticas.promedio_ms=estadisticas.total_ms/estadisticas.cuadros;
    // Sin balanceo de cámara: también respeta prefers-reduced-motion.
    void movimientoReducido;
    return estadisticas;
  }
  return {dibujar,estadisticas,cerrar(){cerrado=true;if(gl){gl.deleteBuffer(buffer);gl.deleteBuffer(bufferCielo);gl.deleteProgram(programa);}}};
}
