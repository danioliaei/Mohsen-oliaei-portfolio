/* =========================================================================
   Tilt-shift bokeh compositor.

   Renders a layer (the topographic contour land) into an offscreen buffer, then
   composites it back onto the main canvas as a FULLY-BLURRED base overlaid with
   a SHARP, feathered focal band. That shallow depth-of-field — crisp through a
   narrow horizontal slice, melting to soft bokeh above and below — is exactly
   what makes a full-size landscape read like a photographed MINIATURE model
   (the "miniature app" look of the reference image).

   PERF: all compositing runs at a CAPPED internal resolution (≤ 1 device px per
   CSS px). The output is intentionally soft, so retina density there is wasted —
   capping it keeps the per-frame GPU blur cheap. The blur itself is done once,
   at buffer resolution, into its own canvas; the main thread only blits.
   ========================================================================= */

export interface TiltShiftOpts {
  /** Blur radius (CSS px) of the out-of-focus base. */
  blur: number;
  /** Screen-height fraction (0..1) at the centre of the sharp band. */
  focusY: number;
  /** Half-height (0..1) of the fully-sharp core of the band. */
  focusH: number;
  /** Soft falloff (0..1) above & below the core. */
  feather: number;
}

export class TiltShift {
  private buf: HTMLCanvasElement = document.createElement("canvas");
  private bctx: CanvasRenderingContext2D = this.buf.getContext("2d")!;
  private blur: HTMLCanvasElement = document.createElement("canvas");
  private blctx: CanvasRenderingContext2D = this.blur.getContext("2d")!;
  private mask: HTMLCanvasElement = document.createElement("canvas");
  private mctx: CanvasRenderingContext2D = this.mask.getContext("2d")!;
  private W = 0;
  private H = 0;
  private sc = 1; // internal device-px-per-CSS-px (capped)

  resize(W: number, H: number, dpr: number): void {
    this.W = W;
    this.H = H;
    // Internal resolution. The blurred base is soft so it wouldn't benefit, but
    // the SHARP focal band is the hero of the miniature look — render it at full
    // device density (capped at 2×) so its hairline isolines stay crisp and
    // anti-aliased rather than softened by a 1× upscale.
    this.sc = Math.min(dpr, 2);
    const pw = Math.max(1, Math.round(W * this.sc));
    const ph = Math.max(1, Math.round(H * this.sc));
    for (const c of [this.buf, this.blur, this.mask]) {
      c.width = pw;
      c.height = ph;
    }
  }

  /** Paint `render` into the buffer, then composite the tilt-shift onto `ctx`. */
  draw(
    ctx: CanvasRenderingContext2D,
    render: (c: CanvasRenderingContext2D) => void,
    o: TiltShiftOpts,
  ): void {
    const { W, H, sc } = this;
    if (W <= 0 || H <= 0) return;
    const pw = this.buf.width;
    const ph = this.buf.height;

    // 1. sharp source into the buffer (terrain.draw works in CSS px → scale sc)
    this.bctx.setTransform(sc, 0, 0, sc, 0, 0);
    this.bctx.clearRect(0, 0, W, H);
    render(this.bctx);

    // 2. blurred base — blur once at buffer resolution, then blit up to main
    this.blctx.setTransform(1, 0, 0, 1, 0, 0);
    this.blctx.clearRect(0, 0, pw, ph);
    this.blctx.filter = `blur(${o.blur * sc}px)`;
    this.blctx.drawImage(this.buf, 0, 0);
    this.blctx.filter = "none";
    ctx.drawImage(this.blur, 0, 0, W, H);

    // 3. sharp focal band — mask a crisp copy of the buffer to a feathered
    //    horizontal window, then lay it over the blurred base
    this.mctx.setTransform(1, 0, 0, 1, 0, 0);
    this.mctx.clearRect(0, 0, pw, ph);
    this.mctx.globalCompositeOperation = "source-over";
    this.mctx.drawImage(this.buf, 0, 0);

    this.mctx.globalCompositeOperation = "destination-in";
    const g = this.mctx.createLinearGradient(0, 0, 0, ph);
    const cy = o.focusY;
    const core = o.focusH;
    const fth = Math.max(0.001, o.feather);
    const stop = (p: number, a: number): void =>
      g.addColorStop(Math.min(1, Math.max(0, p)), `rgba(255,255,255,${a})`);
    stop(0, 0);
    stop(cy - core - fth, 0);
    stop(cy - core, 1);
    stop(cy + core, 1);
    stop(cy + core + fth, 0);
    stop(1, 0);
    this.mctx.fillStyle = g;
    this.mctx.fillRect(0, 0, pw, ph);
    this.mctx.globalCompositeOperation = "source-over";

    ctx.drawImage(this.mask, 0, 0, W, H);
  }
}
