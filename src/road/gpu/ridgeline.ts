/* =========================================================================
   RidgelineScene — the monochrome "Unknown Pleasures" mountain experiment.

   A self-contained WebGPU renderer, intentionally decoupled from the warm-dusk
   road scene (scene.ts): its own eye-level camera, its own height field, and a
   tiny pass chain. One HDR target is drawn (backdrop halo → solid contour mesh
   that writes depth for hidden-line removal); a faint bloom adds a snow-glow;
   the composite box-AA's, grades and grains it to the swap-chain.

   Reuses device.ts for the GPU bootstrap and the generic BRIGHT/BLUR post
   shaders from shaders.ts, so this stays focused on the look.
   ========================================================================= */

import {
  createGPU,
  configureCanvas,
  compileModule,
  makeTarget,
  type GPUCtx,
} from "./device";
import {
  RIDGE_BACKDROP_WGSL,
  RIDGE_TERRAIN_WGSL,
  RIDGE_COMPOSITE_WGSL,
} from "./ridgelineShaders";
import { BRIGHT_WGSL, BLUR_WGSL } from "./shaders";

const HDR: GPUTextureFormat = "rgba16float";

// ---- camera (eye-level, looking across the dune plain toward the summit) ----
// Set high enough above the dunes that the foreground reads as densely-packed
// constant-depth profiles, with a gentle up-tilt that drops the horizon below
// mid-frame so the halo has sky to breathe in and the peak towers through it.
const FOVY = (34 * Math.PI) / 180;
const NEAR = 60;
const FAR = 60000;
// a fairly low eye set back from the dune field, looking UP toward the summit so
// the horizon drops below mid-frame and the peak towers into black sky (where the
// halo breathes). Eye sits well above the low plain → dense foreground profiles.
const EYE: [number, number, number] = [0, 1720, -3000];
const TGT: [number, number, number] = [0, 2280, 8200];
const WORLD_H_MAX = 5000; // height that normalises to "full snow" in the shader

// ---- mesh density: fine enough for crisp ridge silhouettes + rock striations.
// The scan-LINES themselves are analytic (per-fragment from world depth), so this
// only governs surface fidelity, not how many contour lines appear.
const NX = 760;
const NZ = 420;

/** Per-frame inputs from the stage (orbit offsets + clock). */
export interface RidgeFrame {
  time: number;
  /** Orbit YAW offset about the summit (radians); 0 = the authored rest framing.
   *  Unbounded — the viewer can spin a full turn (and beyond) around the peak. */
  yaw: number;
  /** Orbit PITCH offset (radians); 0 = rest. The scene clamps the ABSOLUTE
   *  elevation to ELEV_RANGE so the eye never dips under the dunes nor tips past
   *  a high survey angle. */
  pitch: number;
}

/* ---- orbit camera: drag to spin a full turn around the summit -------------
   The authored EYE→TGT framing is re-expressed as spherical coordinates about
   the summit pivot (TGT). At yaw = pitch = 0 the eye lands back on EYE exactly —
   the rest composition is untouched — and the stage then layers a free YAW (a
   full 360°) and a clamped PITCH from the viewer's pointer drag on top. */
export const ORBIT = (() => {
  const rx = EYE[0] - TGT[0];
  const ry = EYE[1] - TGT[1];
  const rz = EYE[2] - TGT[2];
  const radius = Math.hypot(rx, ry, rz);
  return {
    radius,
    azim: Math.atan2(rx, rz), // yaw about +y; rest looks down the dune field
    elev: Math.asin(ry / radius), // the rest framing's gentle up-tilt
  };
})();

/** Absolute elevation clamp (rad): the floor keeps the eye above the dune plain
 *  when tilting up under the peak; the ceiling stops shy of a top-down survey so
 *  the silhouette never flattens out. The stage maps these to pitch-offset walls. */
export const ELEV_RANGE: readonly [number, number] = [-0.12, 1.0];

/** The ELEV_RANGE clamp expressed as pitch-OFFSET walls (since pitch is added to
 *  ORBIT.elev). Exported so the stage's inertia stops dead at the same walls. */
export const PITCH_LO = ELEV_RANGE[0] - ORBIT.elev;
export const PITCH_HI = ELEV_RANGE[1] - ORBIT.elev;

/* ---- tiny column-major mat4 helpers (dependency-free) ------------------- */
type Mat4 = Float32Array;
function persp(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}
function lookAt(
  ex: number, ey: number, ez: number,
  cx: number, cy: number, cz: number,
  ux: number, uy: number, uz: number,
): Mat4 {
  let zx = ex - cx, zy = ey - cy, zz = ez - cz;
  let rl = 1 / Math.hypot(zx, zy, zz);
  zx *= rl; zy *= rl; zz *= rl;
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  rl = 1 / Math.hypot(xx, xy, xz);
  xx *= rl; xy *= rl; xz *= rl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx; m[1] = yx; m[2] = zx; m[3] = 0;
  m[4] = xy; m[5] = yy; m[6] = zy; m[7] = 0;
  m[8] = xz; m[9] = yz; m[10] = zz; m[11] = 0;
  m[12] = -(xx * ex + xy * ey + xz * ez);
  m[13] = -(yx * ex + yy * ey + yz * ez);
  m[14] = -(zx * ex + zy * ey + zz * ez);
  m[15] = 1;
  return m;
}
function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

export class RidgelineScene {
  private g: GPUCtx;
  private canvas: HTMLCanvasElement;
  private context!: GPUCanvasContext;

  private uBuf: GPUBuffer;
  private uArr = new Float32Array(64); // 256-byte uniform block

  private samp: GPUSampler;

  private scene!: GPUTexture;
  private depth!: GPUTexture;
  private sceneView!: GPUTextureView;
  private depthView!: GPUTextureView;

  private bloomA!: GPUTexture;
  private bloomB!: GPUTexture;
  private bloomAV!: GPUTextureView;
  private bloomBV!: GPUTextureView;
  private brightU: GPUBuffer;
  private blurHU: GPUBuffer;
  private blurVU: GPUBuffer;

  private frameBGL!: GPUBindGroupLayout;
  private postBGL!: GPUBindGroupLayout;
  private frameBG!: GPUBindGroup;

  private backdropPipe!: GPURenderPipeline;
  private terrainPipe!: GPURenderPipeline;
  private brightPipe!: GPURenderPipeline;
  private blurPipe!: GPURenderPipeline;
  private compositePipe!: GPURenderPipeline;

  private bgBright!: GPUBindGroup;
  private bgBloomH!: GPUBindGroup;
  private bgBloomV!: GPUBindGroup;
  private compositeBG!: GPUBindGroup;

  private gridVBO: GPUBuffer;
  private gridIBO: GPUBuffer;
  private indexCount = 0;

  private rw = 1;
  private rh = 1;
  private sc = 1;

  private constructor(g: GPUCtx, canvas: HTMLCanvasElement) {
    this.g = g;
    this.canvas = canvas;
    const d = g.device;

    this.uBuf = d.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const passBuf = () =>
      d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.brightU = passBuf();
    this.blurHU = passBuf();
    this.blurVU = passBuf();

    this.samp = d.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // ---- static terrain grid (uv + indices), built once ----
    const verts = new Float32Array((NX + 1) * (NZ + 1) * 2);
    let p = 0;
    for (let j = 0; j <= NZ; j++)
      for (let i = 0; i <= NX; i++) {
        verts[p++] = i / NX;
        verts[p++] = j / NZ;
      }
    const idx = new Uint32Array(NX * NZ * 6);
    let q = 0;
    const stride = NX + 1;
    for (let j = 0; j < NZ; j++)
      for (let i = 0; i < NX; i++) {
        const tl = j * stride + i, tr = tl + 1, bl = tl + stride, br = bl + 1;
        idx[q++] = tl; idx[q++] = bl; idx[q++] = tr;
        idx[q++] = tr; idx[q++] = bl; idx[q++] = br;
      }
    this.indexCount = idx.length;
    this.gridVBO = d.createBuffer({
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    d.queue.writeBuffer(this.gridVBO, 0, verts);
    this.gridIBO = d.createBuffer({
      size: idx.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    d.queue.writeBuffer(this.gridIBO, 0, idx);
  }

  static async create(canvas: HTMLCanvasElement): Promise<RidgelineScene | null> {
    const g = await createGPU();
    if (!g) return null;
    try {
      const scene = new RidgelineScene(g, canvas);
      await scene.init();
      return scene;
    } catch (e) {
      console.error("[ridgeline] scene init failed — falling back:", e);
      return null;
    }
  }

  /** Claim the canvas context (separate from create() so a discarded scene under
   *  StrictMode/HMR never reconfigures the canvas onto a dead device). */
  attach(): boolean {
    const ctx = configureCanvas(this.g.device, this.canvas, this.g.format);
    if (!ctx) return false;
    this.context = ctx;
    return true;
  }

  private async init(): Promise<void> {
    const d = this.g.device;
    d.addEventListener("uncapturederror", (ev) => {
      console.error("[ridgeline] uncaptured:", (ev as GPUUncapturedErrorEvent).error.message);
    });

    const [backdrop, terrain, composite, bright, blur] = await Promise.all([
      compileModule(d, "ridge-backdrop", RIDGE_BACKDROP_WGSL),
      compileModule(d, "ridge-terrain", RIDGE_TERRAIN_WGSL),
      compileModule(d, "ridge-composite", RIDGE_COMPOSITE_WGSL),
      compileModule(d, "bright", BRIGHT_WGSL),
      compileModule(d, "blur", BLUR_WGSL),
    ]);

    // explicit {F} layout shared by backdrop + terrain
    this.frameBGL = d.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });
    const framePL = d.createPipelineLayout({ bindGroupLayouts: [this.frameBGL] });

    // {PassU, sampler, tex} for bright/blur
    this.postBGL = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const postPL = d.createPipelineLayout({ bindGroupLayouts: [this.postBGL] });

    [this.backdropPipe, this.terrainPipe] = await Promise.all([
      d.createRenderPipelineAsync({
        layout: framePL,
        vertex: { module: backdrop, entryPoint: "vs" },
        fragment: { module: backdrop, entryPoint: "fs", targets: [{ format: HDR }] },
        primitive: { topology: "triangle-list" },
        // never write depth; the terrain (cleared depth 1.0) always draws over it
        depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "always" },
      }),
      d.createRenderPipelineAsync({
        layout: framePL,
        vertex: {
          module: terrain,
          entryPoint: "vs",
          buffers: [
            { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
          ],
        },
        // OPAQUE (no blend): the solid black fill writes depth so nearer ridges
        // occlude farther lines — the hidden-line removal that builds the mountain
        fragment: { module: terrain, entryPoint: "fs", targets: [{ format: HDR }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
      }),
    ]);

    [this.brightPipe, this.blurPipe] = await Promise.all([
      d.createRenderPipelineAsync({
        layout: postPL,
        vertex: { module: bright, entryPoint: "vs" },
        fragment: { module: bright, entryPoint: "fs", targets: [{ format: HDR }] },
        primitive: { topology: "triangle-list" },
      }),
      d.createRenderPipelineAsync({
        layout: postPL,
        vertex: { module: blur, entryPoint: "vs" },
        fragment: { module: blur, entryPoint: "fs", targets: [{ format: HDR }] },
        primitive: { topology: "triangle-list" },
      }),
    ]);

    this.compositePipe = await d.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: composite, entryPoint: "vs" },
      fragment: { module: composite, entryPoint: "fs", targets: [{ format: this.g.format }] },
      primitive: { topology: "triangle-list" },
    });

    this.frameBG = d.createBindGroup({
      layout: this.frameBGL,
      entries: [{ binding: 0, resource: { buffer: this.uBuf } }],
    });
  }

  resize(W: number, H: number, dpr: number): void {
    const d = this.g.device;
    this.canvas.width = Math.max(1, Math.round(W * dpr));
    this.canvas.height = Math.max(1, Math.round(H * dpr));
    // supersample the HDR scene so the composite box-downsample yields clean,
    // un-aliased hairlines and ridge silhouettes
    this.sc = Math.min(dpr * 1.4, 2);
    const fit = (d.limits.maxTextureDimension2D - 16) / Math.max(W, H, 1);
    this.sc = Math.max(1, Math.min(this.sc, fit));
    this.rw = Math.max(1, Math.round(W * this.sc));
    this.rh = Math.max(1, Math.round(H * this.sc));

    this.scene?.destroy();
    this.depth?.destroy();
    this.bloomA?.destroy();
    this.bloomB?.destroy();

    this.scene = makeTarget(d, this.rw, this.rh, HDR);
    this.depth = d.createTexture({
      size: { width: this.rw, height: this.rh },
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.sceneView = this.scene.createView();
    this.depthView = this.depth.createView();

    const hw = Math.max(1, this.rw >> 1);
    const hh = Math.max(1, this.rh >> 1);
    this.bloomA = makeTarget(d, hw, hh, HDR);
    this.bloomB = makeTarget(d, hw, hh, HDR);
    this.bloomAV = this.bloomA.createView();
    this.bloomBV = this.bloomB.createView();

    const tx = 1 / hw;
    const ty = 1 / hh;
    const SPREAD = 2.2;
    // bloom threshold near the snow-white level so only the genuinely bright
    // summit strokes + the halo's defined circle pick up a soft glow
    const BLOOM_THRESH = 0.82;
    d.queue.writeBuffer(this.brightU, 0, new Float32Array([tx, ty, 0, 0, BLOOM_THRESH, 0, 0, 0]));
    d.queue.writeBuffer(this.blurHU, 0, new Float32Array([tx, ty, 1, 0, SPREAD, 0, 0, 0]));
    d.queue.writeBuffer(this.blurVU, 0, new Float32Array([tx, ty, 0, 1, SPREAD, 0, 0, 0]));

    const post = (passU: GPUBuffer, view: GPUTextureView): GPUBindGroup =>
      d.createBindGroup({
        layout: this.postBGL,
        entries: [
          { binding: 0, resource: { buffer: passU } },
          { binding: 1, resource: this.samp },
          { binding: 2, resource: view },
        ],
      });
    this.bgBright = post(this.brightU, this.sceneView);
    this.bgBloomH = post(this.blurHU, this.bloomAV);
    this.bgBloomV = post(this.blurVU, this.bloomBV);

    this.compositeBG = d.createBindGroup({
      layout: this.compositePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uBuf } },
        { binding: 1, resource: this.samp },
        { binding: 2, resource: this.sceneView },
        { binding: 3, resource: this.bloomAV },
      ],
    });
  }

  private writeUniforms(s: RidgeFrame): void {
    const aspect = this.rw / this.rh;
    // orbit about the summit: rest framing + the viewer's drag (yaw/pitch), plus
    // a whisper of breathing so an untouched mountain still feels alive — view-
    // relative and sub-degree, so it never fights the drag.
    const azim = ORBIT.azim + s.yaw + Math.sin(s.time * 0.05) * 0.0045;
    const pitch = Math.min(Math.max(s.pitch, PITCH_LO), PITCH_HI);
    const elev = ORBIT.elev + pitch + Math.sin(s.time * 0.037) * 0.0035;
    const ce = Math.cos(elev);
    const se = Math.sin(elev);
    const ex = TGT[0] + ORBIT.radius * ce * Math.sin(azim);
    const ey = TGT[1] + ORBIT.radius * se;
    const ez = TGT[2] + ORBIT.radius * ce * Math.cos(azim);
    const proj = persp(FOVY, aspect, NEAR, FAR);
    const view = lookAt(ex, ey, ez, TGT[0], TGT[1], TGT[2], 0, 1, 0);
    const vp = mul(proj, view);

    const u = this.uArr;
    u.set(vp, 0);
    u[16] = s.time; u[17] = this.rw; u[18] = this.rh; u[19] = aspect;
    u[20] = NEAR; u[21] = FAR; u[22] = WORLD_H_MAX; u[23] = s.time * 0.012; // haloSpin
    u[24] = 0.34; u[25] = 0.34; u[26] = 0.03; u[27] = 1.0; // bloomAmt, vignette, grain, exposure
    u[28] = ex; u[29] = ey; u[30] = ez; u[31] = 0;
    this.g.device.queue.writeBuffer(this.uBuf, 0, u.buffer, 0, 256);
  }

  render(s: RidgeFrame): void {
    const d = this.g.device;
    this.writeUniforms(s);
    const enc = d.createCommandEncoder();

    // ---- HDR scene: backdrop halo, then the solid contour mesh ----
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: this.sceneView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" },
      ],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setBindGroup(0, this.frameBG);
    pass.setPipeline(this.backdropPipe);
    pass.draw(3);
    pass.setPipeline(this.terrainPipe);
    pass.setVertexBuffer(0, this.gridVBO);
    pass.setIndexBuffer(this.gridIBO, "uint32");
    pass.drawIndexed(this.indexCount);
    pass.end();

    // ---- bloom: bright-pass then one separable blur iteration (→ bloomA) ----
    this.blit(enc, this.brightPipe, this.bgBright, this.bloomAV);
    this.blit(enc, this.blurPipe, this.bgBloomH, this.bloomBV);
    this.blit(enc, this.blurPipe, this.bgBloomV, this.bloomAV);

    // ---- composite → swap-chain ----
    const cpass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    cpass.setPipeline(this.compositePipe);
    cpass.setBindGroup(0, this.compositeBG);
    cpass.draw(3);
    cpass.end();

    d.queue.submit([enc.finish()]);
  }

  private blit(
    enc: GPUCommandEncoder,
    pipe: GPURenderPipeline,
    bg: GPUBindGroup,
    out: GPUTextureView,
  ): void {
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: out, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" },
      ],
    });
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
  }

  dispose(): void {
    this.scene?.destroy();
    this.depth?.destroy();
    this.bloomA?.destroy();
    this.bloomB?.destroy();
    this.uBuf.destroy();
    this.brightU.destroy();
    this.blurHU.destroy();
    this.blurVU.destroy();
    this.gridVBO.destroy();
    this.gridIBO.destroy();
    this.g.device.destroy();
  }
}
