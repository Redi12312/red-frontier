// Caminata libre sobre el visor de casco. Instrumentos y cálculos viven en los módulos del proyecto.
import { iniciarNavegacion } from "./navegacion-ui.js";
import { prepararRuta, validarArranque } from "./navegacion.js";
import { cargarZona, leerHttp, celdaALonLat } from "./zona.js";
import { posicionSol } from "./luz.js";
import { limitePendientePie } from "./riesgo.js";
import { crearTraductor, locale, t as traducir } from "./idioma.js";
import { crearJuego, pasoJuego, desvioRuta, puntoJuego, celdaJuego, angularJuego, valorJuego, cienciaCompleta, resumenJuego, registrarJuego, corregirJuego, trabajarJuego } from "./juego-caminata.js";
import { crearVistaMarte } from "./vista-marte.js";
import { conectarHerramientas } from "./juego-herramientas.js";

const RAIZ=new URL("../../",import.meta.url),url=(s)=>new URL(s,RAIZ).href,json=(s)=>leerHttp(url(s),"json");
const distancia=(a,b,z)=>Math.hypot(a.f-b.f,a.c-b.c)*z.paso;
const rumbo=(a,b)=>(Math.atan2(b.c-a.c,a.f-b.f)*180/Math.PI+360)%360;
const RADIO95=Math.sqrt(-2*Math.log(0.05));

// Adaptador comprobable en Node: el casco conserva el mismo contrato público.
export function crearAdaptadorJuego(contexto, cfgNav, inicio_ms, controles=()=>({})) {
  const {zona,ruta,cfg,riesgo,consumibles}=contexto,v=(k)=>valorJuego(cfg,k);
  const preparada=prepararRuta(zona,ruta,consumibles,riesgo.pie.tripulacion?.valor??1);
  let e=crearJuego(contexto),activa=preparada,radio=null,habilitado=false;
  let regresoActual=undefined,segura=true;
  const anotar=(tipo,datos)=>{e={...e,bitacora:[...e.bitacora,{t:e.t,tipo,datos:structuredClone(datos)}]};};
  function estado(){
    const completa=cienciaCompleta(e,cfg),volviendo=completa||e.fallas.length>0;
    const fin=preparada.finIda??preparada.d.indexOf(Math.max(...preparada.d));
    const celdas=activa===preparada?(volviendo?preparada.celdas.slice(0,fin+1).reverse():preparada.celdas.slice(0,fin+1)):activa.celdas;
    const corredor=desvioRuta(zona,celdas,e.estimada),k=Math.min(celdas.length-1,corredor.indice+1);
    const objetivo=puntoJuego(zona,celdas[k]),rumboObjetivo=rumbo(e.estimada,objetivo),d=distancia(e.estimada,objetivo,zona);
    const geo=celdaALonLat(zona.meta,e.estimada.f,e.estimada.c),ms=inicio_ms+e.t*1000;
    const avisos=[];
    if(e.veredicto==="ABORTAR")avisos.push({codigo:"aborto",nivel:3});
    if(corredor.lateral_m>v("corredor_m"))avisos.push({codigo:"corredor",nivel:2});
    if(e.estimada.error_m>riesgo.pie.incertidumbre_posicion_m.valor)avisos.push({codigo:"localizar",nivel:2});
    if(radio===false)avisos.push({codigo:"radio",nivel:2});
    const sigma=e.estimada.error_m/RADIO95;
    return {...e,k:desvioRuta(zona,preparada.celdas,e.estimada).indice,celda:celdaJuego(zona,e.real),fin:!!e.fin,enRegreso:volviendo,
      nivel:e.veredicto==="ABORTAR"?"rojo":avisos.length?"ambar":"verde",motivo:e.motivo??"Dentro de todos los márgenes.",
      posicion:{f:e.estimada.f,c:e.estimada.c,error_95_m:e.estimada.error_m,covarianza:[sigma*sigma,0,sigma*sigma],fuente:"estima_simulada"},
      verdad:e.real,rumboObjetivo,giro:angularJuego(rumboObjetivo-e.rumbo),hito:{...objetivo,k,distancia_m:d,tiempo_s:null},
      destino_m:distancia(e.estimada,volviendo?e.base:e.ciencia,zona),destino_s:null,
      corredor:{distancia_m:corredor.lateral_m,indice:corredor.indice},avisos,geo,ms,sol:posicionSol(ms,geo.lon,geo.lat),radio,
      tasa:e.tasa??1,metabolismo_w:e.metabolismo_w??preparada.metabolismo_w[0],
      margen_s:e.regreso_s===null?null:e.o2.primario_s-(riesgo.pie.colchon_regreso.valor*e.regreso_s+riesgo.pie.ingreso_refugio_min.valor*60),
      sensores:{temperatura_traje_c:cfgNav.temperatura_traje_c.valor,presion_traje_pa:cfgNav.presion_traje_pa.valor,pulso_lpm:cfgNav.pulso_reposo_lpm.valor}};
  }
  return {
    get juego(){return e;},set juego(nuevo){e=nuevo;},get estado(){return estado();},get ruta(){return preparada;},get rutaActiva(){return activa;},
    hitos:[0,Math.floor(preparada.celdas.length/4),Math.floor(preparada.celdas.length/2)],
    get cantidadEventos(){return e.bitacora.length;},registrar:anotar,fijarRadio:(r)=>{radio=r;},
    habilitar:(si)=>{habilitado=si;},
    fijarRegreso:(s,dentro=true)=>{regresoActual=s;segura=dentro;},
    avanzar(dt){if(habilitado&&!e.fin){const c=controles();e=pasoJuego(e,{dt:dt*v("reloj"),...c,girar:(c.girar??0)/v("reloj"),regreso_s:regresoActual,segura},contexto);}return estado();},
    corregir(m){e=corregirJuego(e,{mejor:{f:m.f,c:m.c},error_m:m.error_95_m},contexto);return estado().posicion;},
    inyectar(tipo){if(!e.fallas.includes(tipo))e={...e,fallas:[...e.fallas,tipo]};anotar("falla",{tipo});return {};},
    abortar(){return this.inyectar("volver");},
    recibirCamino(camino){if(camino){activa={celdas:Array.from(camino.celdas),t:Array.from(camino.tiempos),d:[]};anotar("camino_regreso",{criterio:camino.criterio});}return estado();},
    exportar(){return {version:1,zona:zona.meta.id,origen:"simulado",registro:e.bitacora,
      ...(e.fin?{resultado:resumenJuego(e,cfg),trayectoria:e.trayectoria,real:e.real,estimada:e.estimada}:{estimada:e.estimada})};}
  };
}

export function conectarBotonJuego(boton,obtenerContexto,alError=(e)=>alert(e.message)){
  const actualizar=()=>{boton.textContent=traducir("Modo práctica (juego)");boton.disabled=!validarArranque(obtenerContexto()).ok;};
  const abrir=async()=>{boton.disabled=true;try{await iniciarJuego(obtenerContexto());}catch(e){alError(e);}finally{actualizar();}};
  boton.addEventListener("click",abrir);const reloj=setInterval(()=>{if(boton.isConnected===false)clearInterval(reloj);else actualizar();},500);actualizar();
  return {actualizar,cerrar(){clearInterval(reloj);boton.removeEventListener("click",abrir);}};
}

export async function iniciarJuego(entrada){
  if(!validarArranque(entrada).ok)throw new Error(traducir("Elegí una zona de caminata y una ruta aprobada con datos de simulación."));
  const [cfg,trajeArchivo,riesgoArchivo,consumibles,cfgNav,diccionario]=await Promise.all(["config/juego.json","config/traje.json","config/riesgo.json","config/consumibles.json","config/navegacion.json","app/i18n/en.json"].map(json));
  const opciones=entrada.opciones??{},idioma=opciones.idioma??(locale().startsWith("en")?"en":"es"),tr=crearTraductor(diccionario,idioma),t=tr.t;
  const zona=entrada.zona.elevacion&&entrada.zona.rugosidad?entrada.zona:await cargarZona(url(`datos/${entrada.zona.meta.id}`),leerHttp,true);
  zona.prohibido=opciones.prohibido??zona.prohibido;
  const riesgo=opciones.riesgo??riesgoArchivo,limite=limitePendientePie(riesgo,zona.meta.validacion?.margen_pendiente_p95_grados);
  const traje={...trajeArchivo,pendiente_max_grados:{...trajeArchivo.pendiente_max_grados,valor:limite.valor}};
  const s=entrada.ruta.sim??entrada.ruta,base=puntoJuego(zona,s.celdas[0]);
  // La parada científica es el punto de la ruta más lejano a la base (finIda puede venir en otra escala).
  let cienciaK;
  if(cienciaK===undefined){let max=-1;s.celdas.forEach((i,k)=>{const d=distancia(base,puntoJuego(zona,i),zona);if(d>max){max=d;cienciaK=k;}});}
  const ruta={...entrada.ruta,sim:{...s,finIda:cienciaK}};
  const contexto={zona,ruta,cfg,riesgo,consumibles,traje,ciencia:puntoJuego(zona,s.celdas[cienciaK])};
  const teclas=new Set(),palanca={avanzar:0,girar:0},v=(k)=>valorJuego(cfg,k);
  const controles=()=>({avanzar:palanca.avanzar+((teclas.has("w")||teclas.has("arrowup"))?1:(teclas.has("s")||teclas.has("arrowdown"))?-1:0),
    girar:palanca.girar+((teclas.has("d")||teclas.has("arrowright"))?1:(teclas.has("a")||teclas.has("arrowleft"))?-1:0),trotar:teclas.has("shift")});
  let motor,control,escena,raiz,limpiar=()=>{},iniciada=false,pausa=false,inicioJuego=Date.now(),herramientas=null;
  const n=(x,d=1)=>Number.isFinite(x)?x.toLocaleString(tr.locale,{maximumFractionDigits:d}):"—";
  const marcadores=[{...base,tipo:"habitat",color:[0.55,0.8,0.9]},{...contexto.ciencia,tipo:"ciencia",color:[0.9,0.7,0.2]},
    ...[1,2,3].map((k)=>({...puntoJuego(zona,s.celdas[Math.floor(cienciaK*k/4)]),color:[0.3,0.8,0.6]}))];
  const juego={
    crearMotor({cfg,inicio_ms}){inicioJuego=inicio_ms;motor=crearAdaptadorJuego(contexto,cfg,inicio_ms,()=>{const c=controles();return {...c,avanzar:Math.max(-1,Math.min(1,c.avanzar)),girar:Math.max(-1,Math.min(1,c.girar))};});return motor;},
    // Misma vista del relieve que el casco (la escena low-poly queda en escena-lowpoly.js para una versión futura).
    crearVista(o){escena=crearVistaMarte(o);return escena;},
    alCuadro(){if(!raiz)return;const e=motor.estado;raiz.querySelector("[data-j=desvio]").textContent=`${t("Desvío lateral estimado")}: ${n(e.corredor.distancia_m)} m · ${t("Error de rumbo")}: ${n(angularJuego(e.rumbo-desvioRuta(zona,s.celdas,e.posicion).rumbo))}°`;
      raiz.querySelector("[data-j=objetivo]").textContent=t(cienciaCompleta(motor.juego,cfg)?"Volvé al hábitat con las muestras.":"Seguí el corredor hasta la parada científica.");
      if(motor.juego.aviso==="terreno")raiz.querySelector("[data-j=mensaje]").textContent=t("Terreno prohibido o sin datos: buscá otro paso.");},
    dibujarCorredor({g,proyectar,escala}){for(const [m,color] of [[v("corredor_ambar_m"),"#d6683455"],[v("corredor_m"),"#51e59b66"]]){g.strokeStyle=color;g.lineWidth=m*2*escala;g.beginPath();s.celdas.forEach((i,k)=>{const p=proyectar(puntoJuego(zona,i));if(k)g.lineTo(...p);else g.moveTo(...p);});g.stroke();}},
    cerrar(){limpiar();}
  };
  control=await iniciarNavegacion({...entrada,zona,ruta,opciones:{...opciones,juego}});raiz=control.elemento;raiz.classList.add("juego-casco");
  const panel=document.createElement("div");panel.className="juego-capa";
  panel.innerHTML=`<p class="juego-honestidad">${t("Práctica simulada: relieve real HiRISE, recursos modelados (a calibrar)")}</p>
    <div class="juego-desvio"><p data-j="desvio"></p><p data-j="objetivo"></p><p data-j="mensaje" role="status"></p></div>
    <div class="juego-joystick" role="group" aria-label="${t("Joystick de caminata")}" tabindex="0"><span>✥</span></div>
    <div class="juego-joystick juego-joystick-mirar" role="group" aria-label="Joystick" tabindex="0" data-no-traducir><span>◐</span></div>
    <div class="juego-brazalete"><button data-j="pausa">${t("Pausa")}</button><button data-j="salir">${t("Volver a la app")}</button></div>
    <section class="juego-inicio"><h1>${t("Caminata de práctica")}</h1><p>${t("Llegá al boxwork, documentá dos crestas, tomá tres muestras y volvé sano. La posición estimada deriva: corregila con tus instrumentos.")}</p>
      <p>${t("W/↑ avanzá · S/↓ retrocedé · A/D o ←/→ girá · Shift trotá · Espacio pausa · Esc salí. En pantalla táctil, usá el joystick.")}</p>
      <button data-j="empezar">${t("Empezar caminata")}</button><button data-j="cerrar">${t("Volver a la app")}</button></section>`;
  raiz.append(panel);
  herramientas=await conectarHerramientas({panel,motor,contexto,zona,cfg,json,url,idioma,inicio_ms:inicioJuego,render:cfgNav.render,raiz}).catch((e)=>{console.warn("herramientas",e);return null;});
  const $=(s)=>panel.querySelector(s);
  const vaciar=()=>{teclas.clear();palanca.avanzar=0;palanca.girar=0;$(".juego-joystick span").style.transform="";};
  const pausar=()=>{pausa=!pausa;vaciar();motor.habilitar(iniciada&&!pausa);$("[data-j=pausa]").textContent=t(pausa?"Seguir":"Pausa");};
  $("[data-j=empezar]").addEventListener("click",()=>{iniciada=true;$(".juego-inicio").hidden=true;motor.habilitar(true);raiz.focus();});
  for(const b of ["salir","cerrar"])$(`[data-j=${b}]`).addEventListener("click",()=>control.cerrar(false));
  $("[data-j=pausa]").addEventListener("click",pausar);
  const teclado=(ev)=>{const k=(ev.key||"").toLowerCase();if(!iniciada||/^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName))return;
    if(["w","s","a","d","arrowup","arrowdown","arrowleft","arrowright","shift"," "].includes(k)){ev.preventDefault();ev.stopImmediatePropagation();if(k===" "){if(ev.type==="keydown"&&!ev.repeat)pausar();}else if(ev.type==="keydown")teclas.add(k);else teclas.delete(k);}};
  window.addEventListener("keydown",teclado,true);window.addEventListener("keyup",teclado,true);window.addEventListener("blur",vaciar);
  // Arrastrar sobre la vista (mouse o dedo) gira al astronauta: la cámara mira hacia donde caminás.
  const vistaCanvas=raiz.querySelector(".nav-vista");let arrastre=null;
  const girarArrastre=(ev)=>{if(arrastre===null||ev.pointerId!==arrastre.id)return;const dx=ev.clientX-arrastre.x;palanca.girar=Math.max(-1,Math.min(1,dx/120));};
  vistaCanvas?.addEventListener("pointerdown",(ev)=>{arrastre={id:ev.pointerId,x:ev.clientX};vistaCanvas.setPointerCapture(ev.pointerId);});
  vistaCanvas?.addEventListener("pointermove",girarArrastre);
  for(const nombre of ["pointerup","pointercancel"])vistaCanvas?.addEventListener(nombre,()=>{arrastre=null;palanca.girar=0;});
  const joy=$(".juego-joystick");let puntero=null;
  const mover=(ev)=>{if(ev.pointerId!==puntero)return;const r=joy.getBoundingClientRect(),x=Math.max(-1,Math.min(1,(ev.clientX-r.left-r.width/2)/(r.width/2))),y=Math.max(-1,Math.min(1,(ev.clientY-r.top-r.height/2)/(r.height/2)));palanca.avanzar=-y;palanca.girar=Math.abs(x)>0.5?x*0.5:0;joy.querySelector("span").style.transform=`translate(${x*30}px,${y*30}px)`;};
  joy.addEventListener("pointerdown",(ev)=>{puntero=ev.pointerId;joy.setPointerCapture(puntero);mover(ev);});joy.addEventListener("pointermove",mover);
  for(const nombre of ["pointerup","pointercancel","lostpointercapture"])joy.addEventListener(nombre,()=>{puntero=null;vaciar();});
  // Joystick derecho (celular): gira al astronauta y la cámara.
  const joy2=$(".juego-joystick-mirar");let puntero2=null;
  const mover2=(ev)=>{if(ev.pointerId!==puntero2)return;const r=joy2.getBoundingClientRect(),x=Math.max(-1,Math.min(1,(ev.clientX-r.left-r.width/2)/(r.width/2)));palanca.girar=x;joy2.querySelector("span").style.transform=`translate(${x*30}px,0)`;};
  joy2.addEventListener("pointerdown",(ev)=>{puntero2=ev.pointerId;joy2.setPointerCapture(puntero2);mover2(ev);});joy2.addEventListener("pointermove",mover2);
  for(const nombre of ["pointerup","pointercancel","lostpointercapture"])joy2.addEventListener(nombre,()=>{puntero2=null;palanca.girar=0;joy2.querySelector("span").style.transform="";});
  // PC: clic en la vista bloquea el puntero y el mouse gira la cámara (Esc lo suelta).
  const mirarMouse=(ev)=>{if(document.pointerLockElement!==vistaCanvas||!iniciada||pausa)return;const e=motor.juego;motor.juego={...e,rumbo:(e.rumbo+ev.movementX*0.15+360)%360};};
  vistaCanvas?.addEventListener("click",()=>{if(iniciada&&matchMedia("(pointer:fine)").matches)vistaCanvas.requestPointerLock?.();});
  document.addEventListener("mousemove",mirarMouse);
  limpiar=()=>{document.removeEventListener("mousemove",mirarMouse);if(document.pointerLockElement)document.exitPointerLock();herramientas?.cerrar();vaciar();window.removeEventListener("keydown",teclado,true);window.removeEventListener("keyup",teclado,true);window.removeEventListener("blur",vaciar);};
  // Solo para pruebas (?depurar=1): acceso al motor desde la consola.
  if(new URL(location.href).searchParams.get("depurar")==="1")globalThis.__rfJuego={motor,contexto,pasoJuego,trabajarJuego};
  return {...control,contexto,get juego(){return motor.juego;},motorJuego:motor};
}
