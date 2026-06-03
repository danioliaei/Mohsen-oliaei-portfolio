/* =========================================================================
   Ember field — drifting sunset motes that rise from the horizon.
   Purely atmospheric; sits behind the road glow. Self-contained so it can
   be ticked from the same rAF loop without per-frame allocation.
   ========================================================================= */

interface Ember {
  x: number; // 0..1 of width
  y: number; // 0..1 of height
  r: number; // radius px
  vy: number; // upward speed (fraction of height / sec)
  drift: number; // horizontal sway amplitude
  phase: number; // sway phase
  twk: number; // twinkle speed
  hot: number; // 0..1 colour temperature
}

export class EmberField {
  private embers: Ember[] = [];

  constructor(count = 70) {
    for (let i = 0; i < count; i++) this.embers.push(this.spawn(Math.random()));
  }

  private spawn(y: number): Ember {
    return {
      x: Math.random(),
      y,
      r: 0.6 + Math.random() * 2.2,
      vy: 0.012 + Math.random() * 0.04,
      drift: 0.01 + Math.random() * 0.05,
      phase: Math.random() * Math.PI * 2,
      twk: 0.6 + Math.random() * 2.2,
      hot: Math.random(),
    };
  }

  /** Advance + draw. `dt` in seconds, `t` is elapsed seconds for twinkle. */
  draw(ctx: CanvasRenderingContext2D, W: number, H: number, dt: number, t: number): void {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const e of this.embers) {
      e.y -= e.vy * dt;
      if (e.y < -0.05) {
        // respawn at the bottom
        Object.assign(e, this.spawn(1.05));
      }
      const sway = Math.sin(t * 0.6 + e.phase) * e.drift;
      const px = (e.x + sway) * W;
      const py = e.y * H;

      // fade in from the bottom, out near the top
      const edge = Math.min(e.y, 1 - e.y) * 2.2;
      const twinkle = 0.55 + 0.45 * Math.sin(t * e.twk + e.phase);
      const a = Math.min(Math.max(edge, 0), 1) * twinkle * 0.7;
      if (a <= 0.001) continue;

      const r = e.r * (0.7 + (1 - e.y) * 0.8); // bigger as they near the camera
      const g = ctx.createRadialGradient(px, py, 0, px, py, r * 4);
      const core = e.hot > 0.6 ? "255,228,170" : "255,180,90";
      g.addColorStop(0, `rgba(${core},${a})`);
      g.addColorStop(1, "rgba(255,150,60,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, r * 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
