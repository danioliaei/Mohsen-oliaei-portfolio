/* =========================================================================
   WebGPU device bootstrap + tiny resource helpers.

   Newest-generation path for the homepage. We request a device, configure the
   canvas swap-chain, and expose a couple of allocation helpers so scene.ts can
   stay focused on the actual passes. If the browser has no `navigator.gpu`,
   `createGPU()` resolves to null and RoadStage shows a graceful notice.
   ========================================================================= */

export interface GPUCtx {
  device: GPUDevice;
  format: GPUTextureFormat;
  /** True when the adapter advertises a 16-bit float shader path. */
  hasF16: boolean;
  /** True when timestamp queries are available (for GPU-time telemetry). */
  hasTimestamp: boolean;
}

/**
 * Request a WebGPU device (no canvas binding yet). Returns null when
 * unsupported. The caller validates its shaders/pipelines BEFORE claiming the
 * canvas context, so a shader failure leaves the <canvas> free for the 2-D
 * fallback to use.
 */
export async function createGPU(): Promise<GPUCtx | null> {
  if (!("gpu" in navigator) || !navigator.gpu) return null;
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch {
    return null;
  }
  if (!adapter) return null;

  const hasF16 = adapter.features.has("shader-f16");
  const hasTimestamp = adapter.features.has("timestamp-query");

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice();
  } catch {
    return null;
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  return { device, format, hasF16, hasTimestamp };
}

/** Configure a canvas's WebGPU context. Call only once pipelines are valid. */
export function configureCanvas(
  device: GPUDevice,
  canvas: HTMLCanvasElement,
  format: GPUTextureFormat,
): GPUCanvasContext | null {
  const context = canvas.getContext("webgpu");
  if (!context) return null;
  context.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT });
  return context;
}

/** Compile a WGSL module and reject (after logging line/col) on any error. */
export async function compileModule(
  device: GPUDevice,
  label: string,
  code: string,
): Promise<GPUShaderModule> {
  const mod = device.createShaderModule({ code, label });
  const info = await mod.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === "error");
  if (errors.length) {
    const detail = errors
      .map((e) => `  ${label}:${e.lineNum}:${e.linePos}  ${e.message}`)
      .join("\n");
    console.error(`[wgsl] compile error in ${label}:\n${detail}`);
    throw new Error(`WGSL compile error in ${label}`);
  }
  return mod;
}

/** Allocate (or re-allocate) a render-target texture. Caller destroys the old. */
export function makeTarget(
  device: GPUDevice,
  w: number,
  h: number,
  format: GPUTextureFormat,
  extraUsage: GPUTextureUsageFlags = 0,
): GPUTexture {
  return device.createTexture({
    size: { width: Math.max(1, w | 0), height: Math.max(1, h | 0) },
    format,
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      extraUsage,
  });
}
