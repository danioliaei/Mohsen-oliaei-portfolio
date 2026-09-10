/* =========================================================================
   Shared perf-telemetry types.

   Type-only module (no runtime code) so it can be imported with `import type`
   from BOTH the browser renderer (gpu/ridgeline.ts) and the perf harness
   without coupling their bundles. `tsc` erases the imports entirely.
   ========================================================================= */

/** A per-frame snapshot of the live render path — this app's `renderer.info`.
 *  `backend` is always "webgpu": the RidgelineScene only exists when a WebGPU
 *  device was acquired (there is NO WebGL2 fallback — see RidgelineStage's
 *  `unsupported` notice). If the harness can't read a SceneInfo at all, WebGPU
 *  never came up — the run is void (almost always an insecure HTTP context). */
export interface SceneInfo {
  /** The live render path. Only ever "webgpu" here — see the note above. */
  backend: "webgpu";
  /** Adapter advertised a 16-bit-float shader path. */
  hasF16: boolean;
  /** Adapter advertised timestamp queries (GPU-time telemetry capable). */
  hasTimestamp: boolean;
  /** Draw calls submitted last frame: 6 on Home/CV; 7 during the morph. */
  drawCalls: number;
  /** Triangles rasterised last frame (terrain mesh + the full-screen passes). */
  triangles: number;
  /** Additive filament line segments drawn last frame (globe phase only; 0 on
   *  the finished mountain). The closest thing this app has to an instance count. */
  lines: number;
  /** Supersampled HDR scene-target width in device px (the real fill-rate driver). */
  renderW: number;
  /** Supersampled HDR scene-target height in device px. */
  renderH: number;
  /** Internal supersample multiplier applied on top of DPR (`sc` in resize()). */
  supersample: number;
  /** Canvas backing-store width in device px (cssW × effective DPR). */
  canvasW: number;
  /** Canvas backing-store height in device px. */
  canvasH: number;
  /** Effective (clamped) devicePixelRatio in use — min(window.devicePixelRatio, 2). */
  dpr: number;
}
