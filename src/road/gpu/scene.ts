/* =========================================================================
   WebGPUScene — the homepage background, on the GPU.

   The homepage draws a single static fullscreen pass: the original warm sunset
   gradient (see shaders.ts), straight to the swap-chain. The 3D world (contour
   terrain, fibre road, embers, waypoints) and the bloom / tilt-shift / tonemap
   post chain were removed — the GPU is kept purely as the background renderer.

   The public surface (create / attach / resize / render / dispose + FrameState)
   is unchanged so RoadStage's render loop keeps working untouched.
   ========================================================================= */

import { createGPU, configureCanvas, compileModule, type GPUCtx } from "./device";
import { GRADIENT_WGSL } from "./shaders";

/**
 * Dynamic per-frame inputs handed in by RoadStage. The background gradient is
 * static, so these are currently ignored — the interface is retained so the
 * render loop (and any future motion) needs no changes.
 */
export interface FrameState {
  vp: Float32Array;
  camX: number;
  camZ: number;
  time: number;
  speed: number;
  W: number;
  H: number;
  dpr: number;
  lensX: number;
  vpU: number;
  vpV: number;
  eyeY: number;
  connector: Float32Array | null;
}

export class WebGPUScene {
  private g: GPUCtx;
  private canvas: HTMLCanvasElement;
  private context!: GPUCanvasContext;
  private pipe!: GPURenderPipeline;

  private constructor(g: GPUCtx, canvas: HTMLCanvasElement) {
    this.g = g;
    this.canvas = canvas;
  }

  static async create(canvas: HTMLCanvasElement): Promise<WebGPUScene | null> {
    const g = await createGPU();
    if (!g) return null;
    try {
      const scene = new WebGPUScene(g, canvas);
      await scene.init();
      return scene;
    } catch (e) {
      console.error("[webgpu] scene init failed:", e);
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

  /** Compile + validate the gradient pipeline (does NOT touch the canvas). */
  private async init(): Promise<void> {
    const d = this.g.device;
    d.addEventListener("uncapturederror", (ev) => {
      console.error("[webgpu] uncaptured:", (ev as GPUUncapturedErrorEvent).error.message);
    });
    const mod = await compileModule(d, "gradient", GRADIENT_WGSL);
    this.pipe = await d.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: mod, entryPoint: "vs" },
      fragment: { module: mod, entryPoint: "fs", targets: [{ format: this.g.format }] },
      primitive: { topology: "triangle-list" },
    });
  }

  resize(W: number, H: number, dpr: number): void {
    this.canvas.width = Math.max(1, Math.round(W * dpr));
    this.canvas.height = Math.max(1, Math.round(H * dpr));
  }

  /** Draw the gradient straight to the swap-chain. (FrameState is ignored.) */
  render(_s: FrameState): void {
    const d = this.g.device;
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.pipe);
    pass.draw(3);
    pass.end();
    d.queue.submit([enc.finish()]);
  }

  dispose(): void {
    this.g.device.destroy();
  }
}
