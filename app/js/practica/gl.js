// WebGL2 mínimo para el modo práctica: matrices, un único programa con sombreado plano y armado de mallas low-poly.

export const mat = {
  perspectiva(fov, asp, cerca, lejos) {
    const f = 1 / Math.tan(fov / 2), nf = 1 / (cerca - lejos);
    return new Float32Array([f / asp, 0, 0, 0, 0, f, 0, 0, 0, 0, (lejos + cerca) * nf, -1, 0, 0, 2 * lejos * cerca * nf, 0]);
  },
  mult(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  },
  // Vista en primera persona: yaw 0 mira al norte (−Z), crece hacia el este; pitch positivo mira arriba.
  vista(ojo, yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const f = [sy * cp, sp, -cy * cp];
    const d = [cy, 0, sy];
    const u = [d[1] * f[2] - d[2] * f[1], d[2] * f[0] - d[0] * f[2], d[0] * f[1] - d[1] * f[0]];
    const p = (v) => v[0] * ojo[0] + v[1] * ojo[1] + v[2] * ojo[2];
    return new Float32Array([d[0], u[0], -f[0], 0, d[1], u[1], -f[1], 0, d[2], u[2], -f[2], 0, -p(d), -p(u), p(f), 1]);
  },
  trasladar(x, y, z) {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  },
  identidad() { return mat.trasladar(0, 0, 0); },
  // Rotación alrededor de X (para levantar la herramienta) seguida de traslación.
  // Giro alrededor de Y (rumbo: 0 = norte, crece al este) y traslación.
  rotYTras(rumbo, x, y, z) {
    const c = Math.cos(rumbo), s = Math.sin(rumbo);
    return new Float32Array([c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, x, y, z, 1]);
  },
  rotXTras(a, x, y, z) {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, x, y, z, 1]);
  },
};

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aCol;
uniform mat4 uVP, uM;
out vec3 vPos; out vec4 vCol;
void main(){ vec4 p = uM * vec4(aPos,1.0); vPos = p.xyz; vCol = aCol; gl_Position = uVP * p; }`;
const FS = `#version 300 es
precision highp float;
in vec3 vPos; in vec4 vCol;
uniform vec3 uSol, uNiebla, uOjo; uniform float uDens, uT, uLuz;
out vec4 color;
void main(){
  vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
  float dif = max(dot(n, uSol), 0.0);
  vec3 lit = vCol.rgb * (0.36 + 0.78 * dif * uLuz + 0.1 * n.y);
  float e = vCol.a;
  float pulso = e < 0.95 ? 0.2 * sin(uT * 4.0) : 0.0;
  vec3 c = mix(lit, vCol.rgb * (1.0 + pulso), clamp(e, 0.0, 1.0));
  float d = length(vPos - uOjo);
  float f = 1.0 - exp(-pow(d * uDens, 1.4));
  color = vec4(mix(c, uNiebla, clamp(f, 0.0, 1.0)), 1.0);
}`;

// Fragmento del cielo: color por dirección de vista con el modelo de cielo marciano (GLSL que se recibe).
export const fsCielo = (glsl) => `#version 300 es
precision highp float;
in vec3 vPos; in vec4 vCol;
uniform vec3 uSol, uOjo;
out vec4 color;
${glsl}
void main(){ color = vec4(cieloMarte(normalize(vPos - uOjo), normalize(uSol)), 1.0); }`;

export function crearPrograma(gl, fsFuente = FS) {
  const sh = (t, src) => {
    const s = gl.createShader(t);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsFuente));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  for (const n of ["uVP", "uM", "uSol", "uNiebla", "uOjo", "uDens", "uT", "uLuz"]) u[n] = gl.getUniformLocation(p, n);
  return { p, u };
}

// Sube una malla (posiciones xyz, colores rgba, índices opcionales) a la GPU.
export function subirMalla(gl, pos, col, idx = null) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const b = (datos, loc, n) => {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, datos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 0, 0);
  };
  b(pos instanceof Float32Array ? pos : new Float32Array(pos), 0, 3);
  b(col instanceof Float32Array ? col : new Float32Array(col), 1, 4);
  let n = pos.length / 3;
  if (idx) {
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    n = idx.length;
  }
  gl.bindVertexArray(null);
  return { vao, n, indexada: !!idx };
}

export function dibujar(gl, m) {
  gl.bindVertexArray(m.vao);
  if (m.indexada) gl.drawElements(gl.TRIANGLES, m.n, gl.UNSIGNED_INT, 0);
  else gl.drawArrays(gl.TRIANGLES, 0, m.n);
}

// Acumulador de triángulos con color por vértice (rgb + brillo propio en a).
export class Malla {
  constructor() { this.pos = []; this.col = []; }
  tri(a, b, c, col) {
    this.pos.push(...a, ...b, ...c);
    for (let k = 0; k < 3; k++) this.col.push(col[0], col[1], col[2], col[3] ?? 0);
  }
  quad(a, b, c, d, col) { this.tri(a, b, c, col); this.tri(a, c, d, col); }
  // Caja alineada a los ejes con centro (x, y, z) y tamaño (sx, sy, sz).
  caja(x, y, z, sx, sy, sz, col) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const v = (i, j, k) => [x + i * hx, y + j * hy, z + k * hz];
    this.quad(v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1), col);
    this.quad(v(1, -1, -1), v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1), col);
    this.quad(v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1), v(-1, 1, -1), col);
    this.quad(v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1), col);
    this.quad(v(1, -1, 1), v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), col);
    this.quad(v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1), col);
  }
  // Prisma de sección cuadrada (o de n lados) entre dos puntos.
  segmento(a, b, r, col, lados = 4) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L = Math.hypot(...d) || 1;
    const n = d.map((x) => x / L);
    const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let u = [n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2], n[0] * ref[1] - n[1] * ref[0]];
    const lu = Math.hypot(...u); u = u.map((x) => x / lu);
    const w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const anillo = (p) => Array.from({ length: lados }, (_, k) => {
      const t = (k / lados) * Math.PI * 2 + Math.PI / lados, c = Math.cos(t) * r, s = Math.sin(t) * r;
      return [p[0] + u[0] * c + w[0] * s, p[1] + u[1] * c + w[1] * s, p[2] + u[2] * c + w[2] * s];
    });
    const A = anillo(a), B = anillo(b);
    for (let k = 0; k < lados; k++) {
      const k2 = (k + 1) % lados;
      this.quad(A[k], A[k2], B[k2], B[k], col);
      this.tri(a, A[k2], A[k], col);
      this.tri(b, B[k], B[k2], col);
    }
  }
  // Cilindro vertical (base en y).
  cilindro(x, y, z, r, h, col, lados = 8) { this.segmento([x, y, z], [x, y + h, z], r, col, lados); }
  // Cúpula: media esfera low-poly apoyada en y.
  cupula(x, y, z, r, col, lados = 10, pisos = 4) {
    const p = (i, j) => {
      const fi = (j / pisos) * Math.PI / 2, t = (i / lados) * Math.PI * 2;
      return [x + Math.cos(t) * Math.cos(fi) * r, y + Math.sin(fi) * r, z + Math.sin(t) * Math.cos(fi) * r];
    };
    for (let j = 0; j < pisos; j++) for (let i = 0; i < lados; i++) {
      this.quad(p(i, j), p(i, j + 1), p(i + 1, j + 1), p(i + 1, j), col);
    }
  }
  // Roca: octaedro deformado.
  roca(x, y, z, r, col, azar) {
    const e = () => 0.7 + azar() * 0.6;
    const v = [[r * e(), 0, 0], [-r * e(), 0, 0], [0, r * 0.8 * e(), 0], [0, -r * 0.4, 0], [0, 0, r * e()], [0, 0, -r * e()]]
      .map((p) => [x + p[0], y + p[1], z + p[2]]);
    const caras = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]];
    for (const [a, b, c] of caras) this.tri(v[a], v[b], v[c], col);
  }
  subir(gl) { return subirMalla(gl, new Float32Array(this.pos), new Float32Array(this.col)); }
}
