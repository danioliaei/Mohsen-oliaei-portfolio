/* =========================================================================
   GPU terrain — topographic contour map rendered on the GPU (WebGL2).

   The land is a displaced grid mesh: a vertex shader evaluates the SAME valley
   height field as engine.ts (ported to GLSL) and lifts each vertex, while a
   fragment shader draws crisp, anti-aliased iso-lines analytically from the
   interpolated relief using screen-space derivatives (`fwidth`). Because the
   lines are computed per-pixel rather than rasterised from CPU polylines, they
   stay hairline-sharp at any resolution and any camera angle — and the whole
   field is drawn in a single GPU draw call, so we can push a far denser, higher-
   quality mesh than the old marching-squares path could afford on the CPU.

   Depth-testing the displaced surface gives true occlusion: nearer hills hide
   the contours behind them, which (with the isometric camera) reads as a solid
   miniature tabletop map rather than a flat overlay.

   The view-projection matrix and lateral lens shift come straight from
   engine.ts, so the GPU land and the 2-D road/station overlay share one camera.
   ========================================================================= */

import { VIEW_DEPTH, getViewProj, getLensX } from "./engine";

// world sampling region (mirrors the old CPU terrain extents)
const HALF_W = 13000; // lateral half-range, centred on the camera
const NEAR_AHEAD = -1600; // first grid row (just behind cam → fills the foreground)

// mesh density — generous; this is one GPU draw, not a CPU loop
const NX = 360;
const NZ = 300;

// contour levels — world units between successive iso-lines. Tight → the dense,
// closely-stacked organic isolines of the reference.
const LMIN = 0;
const LSTEP = 42;

// shared GLSL: the terrain height field, identical to engine.ts
const FIELD_GLSL = /* glsl */ `
  float turnf(float z, float c, float w, float d){
    return d * smoothstep(c - w, c + w, z);
  }
  // road centreline — a route that changes direction (layered swings)
  float latz(float z){
    return 560.0 * sin(z * 0.0001 + 0.4)
         + 200.0 * sin(z * 0.00024 + 1.6);
  }
  // organic hills — domain-warped ridges (bent coords → braided, eroded look)
  float organic(float x, float z){
    float wx = x + 760.0 * sin(z * 0.00042 + 0.3) + 420.0 * sin(z * 0.00097 + 2.1);
    float wz = z + 760.0 * sin(x * 0.00038 + 1.7) + 420.0 * sin(x * 0.00091 + 0.4);
    return 900.0 * sin(wx * 0.00115 + wz * 0.00080)
         + 520.0 * sin(wz * 0.00175 - wx * 0.00135 + 1.3)
         + 300.0 * sin(wx * 0.00255 + wz * 0.00210 + 0.6)
         + 175.0 * sin(wz * 0.00360 + wx * 0.00330 + 2.1)
         + 100.0 * sin(wx * 0.00470 - wz * 0.00430 + 0.9);
  }
  // the road's smooth vertical grade, and the carved bed below the hills
  float roadFloor(float z){
    return 520.0 * sin(z * 0.00012 + 0.5) + 240.0 * sin(z * 0.00026 + 2.1);
  }
  // surface height — INDEPENDENT rolling hills (organic) with a shallow corridor
  // lowered along the road, so real hills rise around the route and can stand
  // between the camera and a far stretch of road. The road rides a smooth grade.
  float terrainH(float x, float z){
    float d = abs(x - latz(z));
    float t = 0.12 + 0.88 * smoothstep(120.0, 1300.0, d); // 0.12 near road .. 1 hills
    return roadFloor(z) * (1.0 - t) + organic(x, z) * t;
  }
`;

const VERT = /* glsl */ `#version 300 es
  precision highp float;
  in vec2 aUV;
  uniform mat4 uVP;
  uniform float uCamX, uCamZ, uLens, uNear, uFar, uHalfW;
  out float vRelief;
  out float vDepthT;
  out vec3 vNormal;
  ${FIELD_GLSL}
  void main(){
    float x = uCamX - uHalfW + 2.0 * uHalfW * aUV.x;
    float tz = aUV.y;
    // bias rows toward the near field — fine foreground, compressed distance
    float z = uNear + (uFar - uNear) * (tz * tz * 0.62 + tz * 0.38);
    float y = terrainH(x, z);
    vec4 clip = uVP * vec4(x, y, z, 1.0);
    clip.x += (uLens - 0.5) * 2.0 * clip.w; // lateral lens shift
    gl_Position = clip;
    vRelief = y;
    vDepthT = clamp((z - uCamZ) / ${VIEW_DEPTH.toFixed(1)}, 0.0, 1.0);
    // smooth surface normal from finite differences of the height field — gives
    // the terrain soft tonal shading (volume / depth) between the contour lines
    float e = 7.0;
    float hx = terrainH(x + e, z) - terrainH(x - e, z);
    float hz = terrainH(x, z + e) - terrainH(x, z - e);
    vNormal = normalize(vec3(-hx / (2.0 * e), 1.0, -hz / (2.0 * e)));
  }
`;

const FRAG = /* glsl */ `#version 300 es
  precision highp float;
  in float vRelief;
  in float vDepthT;
  in vec3 vNormal;
  out vec4 frag;
  uniform float uLMin, uLStep;
  void main(){
    // analytic iso-line distance, in PIXELS, via screen-space derivatives
    float f = (vRelief - uLMin) / uLStep;
    float d = 0.5 - abs(fract(f) - 0.5);   // 0 exactly on a contour
    float w = max(fwidth(f), 1e-4);        // level-units per pixel
    float dpx = d / w;                     // pixels to nearest contour
    // a fine crisp core with a faint soft halo — thin, delicate isolines
    float core = 1.0 - smoothstep(0.0, 1.4, dpx);
    float glow = exp(-dpx * dpx / 9.0);
    float line = clamp(core + glow * 0.4, 0.0, 1.0);
    // where contours pack closer than the pixel grid (w large) they can no longer
    // be resolved — fade them out instead of merging into a blown-out solid mass
    line *= 1.0 - smoothstep(0.45, 1.15, w);

    // atmospheric depth fade — gentle, so the contour map fills the frame and
    // only the most distant ridges dissolve toward the horizon
    float t = vDepthT;
    float fade = t < 0.74 ? 1.0 : max(0.0, 1.0 - (t - 0.74) / 0.26);

    // ---- lighting from a key light: the surface AND its contour lines catch it ----
    vec3 nrm = normalize(vNormal);
    vec3 L = normalize(vec3(-0.45, 0.80, -0.34)); // key light (upper-left, raking)
    float diff = clamp(dot(nrm, L), 0.0, 1.0);
    float lit = 0.42 + 0.58 * diff;                // deep-shadow .. fully-lit
    // a soft specular sheen so ridge lines facing the light flare a touch brighter
    vec3 V = normalize(vec3(0.0, 0.58, -0.82));    // toward the elevated camera
    float spec = pow(clamp(dot(nrm, normalize(L + V)), 0.0, 1.0), 9.0);

    // surface base shading (smooth tonal volume beneath the lines)
    float shade = 0.30 + 0.70 * diff;
    vec3 baseCol = vec3(0.155, 0.098, 0.052) * (0.5 + 1.1 * shade);
    float baseA = (0.12 + 0.20 * diff) * fade;

    // contour lines RENDERED by the light — brighter on lit slopes, dimmer in
    // shadow, with a sheen on faces turned to the key light → a 3-D modelled read
    vec3 warm = vec3(1.0, (250.0 - t * 30.0) / 255.0, (242.0 - t * 78.0) / 255.0);
    vec3 lineCol = warm * (lit + 0.5 * spec);
    float lineA = line * (0.5 + 0.45 * fade) * (0.7 + 0.42 * lit);

    vec3 col = mix(baseCol, lineCol, line);
    float a = max(baseA, lineA);
    frag = vec4(col, a);
  }
`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("terrain shader: " + log);
  }
  return sh;
}

export class TerrainGL {
  readonly canvas: HTMLCanvasElement = document.createElement("canvas");
  private gl: WebGL2RenderingContext | null;
  private prog: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private count = 0;
  private u: Record<string, WebGLUniformLocation | null> = {};

  constructor() {
    const gl = this.canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: true,
    });
    this.gl = gl;
    if (!gl) return;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, "aUV");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error("terrain link: " + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    for (const name of ["uVP", "uCamX", "uCamZ", "uLens", "uNear", "uFar", "uHalfW", "uLMin", "uLStep"]) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }

    // ---- build the static (u,v) grid + triangle indices once ----
    const verts = new Float32Array((NX + 1) * (NZ + 1) * 2);
    let p = 0;
    for (let j = 0; j <= NZ; j++) {
      for (let i = 0; i <= NX; i++) {
        verts[p++] = i / NX;
        verts[p++] = j / NZ;
      }
    }
    const idx = new Uint32Array(NX * NZ * 6);
    let q = 0;
    const stride = NX + 1;
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const tl = j * stride + i;
        const tr = tl + 1;
        const bl = tl + stride;
        const br = bl + 1;
        idx[q++] = tl; idx[q++] = bl; idx[q++] = tr;
        idx[q++] = tr; idx[q++] = bl; idx[q++] = br;
      }
    }
    this.count = idx.length;

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.vao = vao;

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  get ok(): boolean {
    return !!this.gl && !!this.prog;
  }

  resize(W: number, H: number, sc: number): void {
    this.canvas.width = Math.max(1, Math.round(W * sc));
    this.canvas.height = Math.max(1, Math.round(H * sc));
  }

  /** Render the contour land for a camera at (camX, camZ). */
  render(camX: number, camZ: number): void {
    const gl = this.gl;
    if (!gl || !this.prog || !this.vao) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.uVP, false, getViewProj());
    gl.uniform1f(this.u.uCamX, camX);
    gl.uniform1f(this.u.uCamZ, camZ);
    gl.uniform1f(this.u.uLens, getLensX());
    gl.uniform1f(this.u.uNear, camZ + NEAR_AHEAD);
    gl.uniform1f(this.u.uFar, camZ + VIEW_DEPTH);
    gl.uniform1f(this.u.uHalfW, HALF_W);
    gl.uniform1f(this.u.uLMin, LMIN);
    gl.uniform1f(this.u.uLStep, LSTEP);

    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }
}
