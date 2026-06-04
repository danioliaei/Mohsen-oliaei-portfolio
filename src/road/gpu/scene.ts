/* =========================================================================
   WebGPUScene — the whole homepage scene on the GPU.

   One HDR pass draws sky → contour terrain → road → embers → waypoints into a
   linear rgba16float target; a small post chain (bloom + tilt-shift DoF) and a
   composite pass tone-map it to the swap-chain. The legacy WebGL2 + 2-D canvas
   path in RoadStage stays as a fallback for browsers without WebGPU.
   ========================================================================= */

import {
  createGPU,
  configureCanvas,
  compileModule,
  makeTarget,
  type GPUCtx,
} from "./device";
import {
  SKY_WGSL,
  TERRAIN_WGSL,
  COMPOSITE_WGSL,
  BRIGHT_WGSL,
  BLUR_WGSL,
  ROAD_WGSL,
  EMBER_WGSL,
  WAYPOINT_WGSL,
  CONNECTOR_WGSL,
} from "./shaders";
import { LAT, surfaceY } from "../engine";
import { MILESTONES } from "../../data/milestones";

const EMBER_COUNT = 0;
/** Floating kind-coloured glints at each milestone. Disabled per request
 *  ("remove those embers") — the DOM cards + connector line still mark every
 *  station, so nothing navigational is lost. Flip to true to bring them back. */
const SHOW_WAYPOINTS = false;

/** Per-kind glint colour (linear-ish RGB), echoing the card accents. */
const KIND_COL: Record<string, [number, number, number]> = {
  education: [1.0, 0.77, 0.36],
  career: [1.0, 0.59, 0.31],
  teaching: [0.47, 0.91, 0.88],
};

// ---- terrain sampling region + mesh density (mirrors gl.ts) ----
// The mesh is an axis-aligned patch anchored to the camera; under the oblique
// 45° bird's-eye view it projects to a ROTATED quad, so the footprint must be
// generously larger than the screen or its straight edges show as hard cuts
// (an empty wedge in the lower-left, and terrain clipping in/out as you scroll).
// HALF_W gives lateral overscan; NEAR_AHEAD pushes the near edge well behind the
// camera so it falls below the frame; the far edge already dissolves via depthT.
const HALF_W = 17000;
const NEAR_AHEAD = -8200;
const VIEW_DEPTH = 13000;
const NX = 430;
const NZ = 416;
const L_MIN = 0;
// Vertical spacing (height units) between iso-contour lines. A touch coarser than
// before so the lines read as elegant, evenly-spaced survey strokes rather than a
// moiré-dense tangle on the steep slopes.
const L_STEP = 60;

/** Dynamic per-frame inputs handed in by RoadStage (which owns engine.ts). */
export interface FrameState {
  vp: Float32Array; // column-major view-projection
  camX: number;
  camZ: number;
  time: number;
  speed: number; // 0..1 motion energy
  W: number;
  H: number;
  dpr: number;
  lensX: number;
  vpU: number; // vanishing-point screen position (0..1)
  vpV: number;
  eyeY: number;
  /** Connector line [x0,y0,x1,y1 (NDC), r,g,b,a]; null when hidden. */
  connector: Float32Array | null;
}

const HDR: GPUTextureFormat = "rgba16float";

export class WebGPUScene {
  private g: GPUCtx;
  private canvas: HTMLCanvasElement;
  private context!: GPUCanvasContext;
  private uBuf: GPUBuffer;
  private uArr = new Float32Array(64); // 256-byte uniform block

  private scene!: GPUTexture;
  private depth!: GPUTexture;
  private sceneView!: GPUTextureView;
  private depthView!: GPUTextureView;

  private samp: GPUSampler;

  private skyPipe!: GPURenderPipeline;
  private terrainPipe!: GPURenderPipeline;
  private compositePipe!: GPURenderPipeline;
  private brightPipe!: GPURenderPipeline;
  private blurPipe!: GPURenderPipeline;

  private frameBGL!: GPUBindGroupLayout; // explicit {F} layout shared by world passes
  private postBGL!: GPUBindGroupLayout; // {PassU, sampler, tex} for bright/blur
  private frameBG!: GPUBindGroup; // group0 {F} for sky/terrain

  // half-res bloom + DoF ping-pong targets and their bind groups
  private bloomA!: GPUTexture;
  private bloomB!: GPUTexture;
  private dofA!: GPUTexture;
  private dofB!: GPUTexture;
  private bloomAV!: GPUTextureView;
  private bloomBV!: GPUTextureView;
  private dofAV!: GPUTextureView;
  private dofBV!: GPUTextureView;
  private brightU!: GPUBuffer;
  private blurHU!: GPUBuffer;
  private blurVU!: GPUBuffer;
  private bgBright!: GPUBindGroup;
  private bgBloomH!: GPUBindGroup;
  private bgBloomV!: GPUBindGroup;
  private bgDofH0!: GPUBindGroup; // scene → dofB
  private bgDofV!: GPUBindGroup; // dofB → dofA
  private bgDofH!: GPUBindGroup; // dofA → dofB
  private compositeBG!: GPUBindGroup;

  private gridVBO: GPUBuffer;
  private gridIBO: GPUBuffer;
  private indexCount = 0;
  private roadPipe!: GPURenderPipeline;
  private roadVBO: GPUBuffer;
  private roadCount = 0;
  private emberPipe!: GPURenderPipeline;
  private wpPipe!: GPURenderPipeline;
  private wpBuf: GPUBuffer;
  private wpCount = 0;
  private wpBG!: GPUBindGroup;
  private connPipe!: GPURenderPipeline;
  private connU: GPUBuffer;
  private connBG!: GPUBindGroup;
  private connArr = new Float32Array(12); // p(4) + c(4) + aspect(4)

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
        const tl = j * stride + i,
          tr = tl + 1,
          bl = tl + stride,
          br = bl + 1;
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

    // ---- static road ribbon (a triangle strip following the centreline) ----
    // Placed on the actual terrain surface along the route (+ a little lift) so
    // it sits planted on the ground and is correctly occluded by nearer hills.
    const ZMAX = 38000;
    const DZ = 80;
    const LIFT = 20;
    // half-width of the fibre ribbon (world units). Widened so the hero career
    // road reads clearly as a glowing thread through the valley at this far,
    // bird's-eye framing instead of a hairline lost in the contours.
    const HALFW = 48;
    const steps = Math.floor(ZMAX / DZ);
    const rv = new Float32Array((steps + 1) * 2 * 5);
    let rp = 0;
    let arc = 0;
    let pcx = LAT(0);
    let pcz = 0;
    for (let kz = 0; kz <= steps; kz++) {
      const z = kz * DZ;
      const cx = LAT(z);
      const cy = surfaceY(cx, z) + LIFT;
      if (kz > 0) arc += Math.hypot(cx - pcx, z - pcz);
      pcx = cx;
      pcz = z;
      const a = LAT(z - DZ * 0.5);
      const b = LAT(z + DZ * 0.5);
      const tx = b - a;
      const tz = DZ;
      const il = 1 / Math.hypot(tx, tz);
      const nx = tz * il;
      const nz = -tx * il;
      rv[rp++] = cx + nx * HALFW; rv[rp++] = cy; rv[rp++] = z + nz * HALFW; rv[rp++] = 1; rv[rp++] = arc;
      rv[rp++] = cx - nx * HALFW; rv[rp++] = cy; rv[rp++] = z - nz * HALFW; rv[rp++] = -1; rv[rp++] = arc;
    }
    this.roadCount = (steps + 1) * 2;
    this.roadVBO = d.createBuffer({
      size: rv.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    d.queue.writeBuffer(this.roadVBO, 0, rv);

    // ---- static waypoint instances (one glint per career station) ----
    this.wpCount = MILESTONES.length;
    const wp = new Float32Array(this.wpCount * 8);
    MILESTONES.forEach((m, i) => {
      const x = LAT(m.z);
      const y = surfaceY(x, m.z) + 40;
      const c = KIND_COL[m.kind] ?? [1, 0.85, 0.6];
      const o = i * 8;
      wp[o] = x; wp[o + 1] = y; wp[o + 2] = m.z; wp[o + 3] = 0;
      wp[o + 4] = c[0]; wp[o + 5] = c[1]; wp[o + 6] = c[2]; wp[o + 7] = 0;
    });
    this.wpBuf = d.createBuffer({
      size: wp.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    d.queue.writeBuffer(this.wpBuf, 0, wp);

    this.connU = d.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  static async create(canvas: HTMLCanvasElement): Promise<WebGPUScene | null> {
    const g = await createGPU();
    if (!g) return null;
    try {
      const scene = new WebGPUScene(g, canvas);
      await scene.init();
      return scene;
    } catch (e) {
      console.error("[webgpu] scene init failed — falling back:", e);
      return null;
    }
  }

  /**
   * Claim the <canvas>'s WebGPU context. Kept SEPARATE from create() so the
   * caller only configures the canvas on the scene it actually keeps — under
   * React StrictMode / HMR a discarded scene must never reconfigure the canvas
   * (which would bind the swap-chain to a dead device and break rendering).
   */
  attach(): boolean {
    const ctx = configureCanvas(this.g.device, this.canvas, this.g.format);
    if (!ctx) return false;
    this.context = ctx;
    return true;
  }

  /** Compile + validate all pipelines (does NOT touch the canvas — see attach). */
  private async init(): Promise<void> {
    const d = this.g.device;
    d.addEventListener("uncapturederror", (ev) => {
      console.error("[webgpu] uncaptured:", (ev as GPUUncapturedErrorEvent).error.message);
    });

    const [sky, terrain, road, ember, waypoint, connector, composite, bright, blur] =
      await Promise.all([
        compileModule(d, "sky", SKY_WGSL),
        compileModule(d, "terrain", TERRAIN_WGSL),
        compileModule(d, "road", ROAD_WGSL),
        compileModule(d, "ember", EMBER_WGSL),
        compileModule(d, "waypoint", WAYPOINT_WGSL),
        compileModule(d, "connector", CONNECTOR_WGSL),
        compileModule(d, "composite", COMPOSITE_WGSL),
        compileModule(d, "bright", BRIGHT_WGSL),
        compileModule(d, "blur", BLUR_WGSL),
      ]);

    // {PassU, sampler, tex} layout for the half-res bloom/DoF passes
    this.postBGL = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const postPL = d.createPipelineLayout({ bindGroupLayouts: [this.postBGL] });

    const overAlpha: GPUBlendState = {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };

    // explicit {F} layout so one bind group works across every world pass
    // (with layout:"auto" each pipeline gets its own incompatible layout)
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

    [this.skyPipe, this.terrainPipe, this.compositePipe] = await Promise.all([
      d.createRenderPipelineAsync({
        layout: framePL,
        vertex: { module: sky, entryPoint: "vs" },
        fragment: { module: sky, entryPoint: "fs", targets: [{ format: HDR }] },
        primitive: { topology: "triangle-list" },
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
        fragment: { module: terrain, entryPoint: "fs", targets: [{ format: HDR, blend: overAlpha }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
      }),
      d.createRenderPipelineAsync({
        layout: "auto",
        vertex: { module: composite, entryPoint: "vs" },
        fragment: { module: composite, entryPoint: "fs", targets: [{ format: this.g.format }] },
        primitive: { topology: "triangle-list" },
      }),
    ]);

    const addBlend: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
    };
    this.roadPipe = await d.createRenderPipelineAsync({
      layout: framePL,
      vertex: {
        module: road,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 20,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x2" },
            ],
          },
        ],
      },
      fragment: { module: road, entryPoint: "fs", targets: [{ format: HDR, blend: addBlend }] },
      primitive: { topology: "triangle-strip", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less" },
    });

    this.emberPipe = await d.createRenderPipelineAsync({
      layout: framePL,
      vertex: { module: ember, entryPoint: "vs" },
      fragment: { module: ember, entryPoint: "fs", targets: [{ format: HDR, blend: addBlend }] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less" },
    });

    // waypoints: {F uniform, WP storage} → glints in the HDR scene
    const wpBGL = d.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    this.wpPipe = await d.createRenderPipelineAsync({
      layout: d.createPipelineLayout({ bindGroupLayouts: [wpBGL] }),
      vertex: { module: waypoint, entryPoint: "vs" },
      fragment: { module: waypoint, entryPoint: "fs", targets: [{ format: HDR, blend: addBlend }] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less" },
    });
    this.wpBG = d.createBindGroup({
      layout: wpBGL,
      entries: [
        { binding: 0, resource: { buffer: this.uBuf } },
        { binding: 1, resource: { buffer: this.wpBuf } },
      ],
    });

    // connector: a single glowing line over the composite (its own uniform)
    const connBGL = d.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });
    this.connPipe = await d.createRenderPipelineAsync({
      layout: d.createPipelineLayout({ bindGroupLayouts: [connBGL] }),
      vertex: { module: connector, entryPoint: "vs" },
      fragment: {
        module: connector,
        entryPoint: "fs",
        targets: [{ format: this.g.format, blend: addBlend }],
      },
      primitive: { topology: "triangle-list" },
    });
    this.connBG = d.createBindGroup({
      layout: connBGL,
      entries: [{ binding: 0, resource: { buffer: this.connU } }],
    });

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

    // group0 {F} shared by sky + terrain (both use the explicit frame layout)
    this.frameBG = d.createBindGroup({
      layout: this.frameBGL,
      entries: [{ binding: 0, resource: { buffer: this.uBuf } }],
    });
  }

  resize(W: number, H: number, dpr: number): void {
    const d = this.g.device;
    this.canvas.width = Math.max(1, Math.round(W * dpr));
    this.canvas.height = Math.max(1, Math.round(H * dpr));
    // supersample the HDR scene a touch above the display buffer → cleaner
    // contour/silhouette edges once the DoF blit downsamples it
    this.sc = Math.min(dpr * 1.4, 2);
    this.rw = Math.max(1, Math.round(W * this.sc));
    this.rh = Math.max(1, Math.round(H * this.sc));

    this.scene?.destroy();
    this.depth?.destroy();
    this.bloomA?.destroy();
    this.bloomB?.destroy();
    this.dofA?.destroy();
    this.dofB?.destroy();

    this.scene = makeTarget(d, this.rw, this.rh, HDR);
    this.depth = d.createTexture({
      size: { width: this.rw, height: this.rh },
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.sceneView = this.scene.createView();
    this.depthView = this.depth.createView();

    // bloom + DoF run at half resolution (soft anyway → cheap & still lush)
    const hw = Math.max(1, this.rw >> 1);
    const hh = Math.max(1, this.rh >> 1);
    this.bloomA = makeTarget(d, hw, hh, HDR);
    this.bloomB = makeTarget(d, hw, hh, HDR);
    this.dofA = makeTarget(d, hw, hh, HDR);
    this.dofB = makeTarget(d, hw, hh, HDR);
    this.bloomAV = this.bloomA.createView();
    this.bloomBV = this.bloomB.createView();
    this.dofAV = this.dofA.createView();
    this.dofBV = this.dofB.createView();

    // PassU buffers: [texel.xy, dir.xy, params(spread/threshold)]
    const tx = 1 / hw;
    const ty = 1 / hh;
    const SPREAD = 2.1;
    // bloom threshold raised well above 1.0 so ONLY the genuinely hot features
    // (the road seam/core + the brightest contour cores) bloom into a soft halo,
    // instead of the whole emissive terrain flooding the frame with golden haze.
    const BLOOM_THRESH = 1.35;
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
    this.bgDofH0 = post(this.blurHU, this.sceneView);
    this.bgDofV = post(this.blurVU, this.dofBV);
    this.bgDofH = post(this.blurHU, this.dofAV);

    this.compositeBG = d.createBindGroup({
      layout: this.compositePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uBuf } },
        { binding: 1, resource: this.samp },
        { binding: 2, resource: this.sceneView },
        { binding: 3, resource: this.bloomAV },
        { binding: 4, resource: this.dofAV },
      ],
    });
  }

  private writeUniforms(s: FrameState): void {
    const u = this.uArr;
    u.set(s.vp, 0); // mat4 → 0..15
    u[16] = s.camX; u[17] = s.camZ; u[18] = s.time; u[19] = s.speed;
    u[20] = this.rw; u[21] = this.rh; u[22] = this.sc; u[23] = s.dpr;
    u[24] = s.lensX; u[25] = s.camZ + NEAR_AHEAD; u[26] = s.camZ + VIEW_DEPTH; u[27] = HALF_W;
    // tilt-shift miniature: a narrow sharp band across the middle, the near (lower)
    // and far (upper) reaches falling quickly into blur — the core "toy" cue
    u[28] = L_MIN; u[29] = L_STEP; u[30] = 0.54; u[31] = 0.12; // focusY, focusH (wider sharp band)
    u[32] = 0.18; u[33] = 0.22; u[34] = 0.014; u[35] = 1.16; // feather, vignette, grain, exposure
    u[36] = s.vpU; u[37] = s.vpV; u[38] = 0.05; u[39] = 0.02; // halo glow, r (muted for the diorama)
    u[40] = 0.50; u[41] = 0.0016; u[42] = 1.0; u[43] = s.eyeY; // bloomAmt, caAmt, dofMax, eyeY
    this.g.device.queue.writeBuffer(this.uBuf, 0, u.buffer, 0, 256);
  }

  render(s: FrameState): void {
    const d = this.g.device;
    this.writeUniforms(s);
    if (s.connector && s.connector[7] > 0.004) {
      const c = s.connector;
      const a = this.connArr;
      a[0] = c[0]; a[1] = c[1]; a[2] = c[2]; a[3] = c[3];
      a[4] = c[4]; a[5] = c[5]; a[6] = c[6]; a[7] = c[7];
      a[8] = this.rw / this.rh; a[9] = 0.0042; a[10] = 0; a[11] = 0; // aspect, half-width
      d.queue.writeBuffer(this.connU, 0, a.buffer, 0, 48);
    }
    const enc = d.createCommandEncoder();

    // ---- HDR scene pass: sky, then terrain ----
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.sceneView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setBindGroup(0, this.frameBG);
    pass.setPipeline(this.skyPipe);
    pass.draw(3);
    pass.setPipeline(this.terrainPipe);
    pass.setVertexBuffer(0, this.gridVBO);
    pass.setIndexBuffer(this.gridIBO, "uint32");
    pass.drawIndexed(this.indexCount);
    // road fibre — additive, depth-tested so nearer hills occlude far stretches
    pass.setPipeline(this.roadPipe);
    pass.setVertexBuffer(0, this.roadVBO);
    pass.draw(this.roadCount);
    // drifting embers — instanced, procedural, additive (the "moving" cue)
    pass.setPipeline(this.emberPipe);
    pass.draw(6, EMBER_COUNT);
    // station waypoint glints ("embers") — disabled; see SHOW_WAYPOINTS
    if (SHOW_WAYPOINTS) {
      pass.setPipeline(this.wpPipe);
      pass.setBindGroup(0, this.wpBG);
      pass.draw(6, this.wpCount);
    }
    pass.end();

    // ---- bloom: bright-pass then two separable blur iterations (→ bloomA) ----
    this.blit(enc, this.brightPipe, this.bgBright, this.bloomAV);
    this.blit(enc, this.blurPipe, this.bgBloomH, this.bloomBV);
    this.blit(enc, this.blurPipe, this.bgBloomV, this.bloomAV);
    this.blit(enc, this.blurPipe, this.bgBloomH, this.bloomBV);
    this.blit(enc, this.blurPipe, this.bgBloomV, this.bloomAV);

    // ---- tilt-shift DoF: downsample-blur the whole scene twice (→ dofA) ----
    this.blit(enc, this.blurPipe, this.bgDofH0, this.dofBV); // scene → dofB (H)
    this.blit(enc, this.blurPipe, this.bgDofV, this.dofAV); //  dofB → dofA (V)
    this.blit(enc, this.blurPipe, this.bgDofH, this.dofBV); //  dofA → dofB (H)
    this.blit(enc, this.blurPipe, this.bgDofV, this.dofAV); //  dofB → dofA (V)

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
    // connector line from the active waypoint to the floating card
    if (s.connector && s.connector[7] > 0.004) {
      cpass.setPipeline(this.connPipe);
      cpass.setBindGroup(0, this.connBG);
      cpass.draw(6);
    }
    cpass.end();

    d.queue.submit([enc.finish()]);
  }

  /** One fullscreen draw of `pipe`+`bg` into `out` (post-processing helper). */
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
    this.dofA?.destroy();
    this.dofB?.destroy();
    this.uBuf.destroy();
    this.brightU.destroy();
    this.blurHU.destroy();
    this.blurVU.destroy();
    this.gridVBO.destroy();
    this.gridIBO.destroy();
    this.roadVBO.destroy();
    this.wpBuf.destroy();
    this.connU.destroy();
    this.g.device.destroy();
  }
}
