/* =========================================================================
   WebGPUScene — the homepage background, on the GPU.

   Renders a single static fullscreen pass: the warm sunset gradient
   (see shaders.ts), straight to the swap-chain.
   ========================================================================= */

import { createGPU, configureCanvas, compileModule, type GPUCtx } from "./device";
import { GRADIENT_WGSL } from "./shaders";

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

  attach(): boolean {
    const ctx = configureCanvas(this.g.device, this.canvas, this.g.format);
    if (!ctx) return false;
    this.context = ctx;
    return true;
  }

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

  render(): void {
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
