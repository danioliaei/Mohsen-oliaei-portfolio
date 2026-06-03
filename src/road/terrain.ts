/* =========================================================================
   Digital terrain — a DENSE POINT CLOUD of the hills the road runs through.
   The same `terrainHeight` field that lifts the road is sampled on a fine
   grid and each sample is projected through the shared camera and stamped as
   a glowing mote. The field is a VALLEY, so the cloud forms hills rising on
   both sides while the road sits in the low trough between them.

   Point size scales with viewport width so the cloud stays dense and fills
   the full pan — from a laptop up to a 4K landscape display.

   The motes are a luminous warm cream, brightened on the ridges, so they read
   clearly against the sunset without ever leaving the warm theme.
   ========================================================================= */

import { VIEW_DEPTH, project, terrainHeight } from "./engine";

const NX = 214; // lateral samples
const NZ = 150; // depth samples
const HALF_W = 9000; // world lateral half-range — wide enough to fill 4K sides

export class Terrain {
  /** Sample + project the grid, stamping a mote at every point. */
  draw(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    camX: number,
    camZ: number,
    camY: number,
  ): void {
    const near = camZ + 120;
    const far = camZ + VIEW_DEPTH;
    const sizeK = W * 0.42; // point size scales with viewport → 4K stays dense

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (let j = 0; j <= NZ; j++) {
      const z = near + (far - near) * (j / NZ);
      const depthT = (z - camZ) / VIEW_DEPTH;
      const nearness = 1 - depthT;

      // luminous cream, a touch warmer with distance. Alpha is set ONCE per
      // row (cheap) — hill/valley contrast comes from point size + additive
      // overlap, so there's no costly per-point state change.
      const g = Math.round(244 - depthT * 24);
      const b = Math.round(224 - depthT * 60);
      ctx.fillStyle = `rgb(255,${g},${b})`;
      ctx.globalAlpha = 0.26 + nearness * 0.26;

      for (let i = 0; i <= NX; i++) {
        const wx = -HALF_W + 2 * HALF_W * (i / NX);
        const e = terrainHeight(wx, z);

        // hillsides (high terrain) glow bright; skip the dim valley floor
        let ridge = e / 2500; // ~0 on the road floor .. ~1 on the hilltops
        if (ridge < 0.05) continue;
        if (ridge > 1) ridge = 1;

        const pr = project(wx, z, e, camX, camZ, camY, W, H);
        if (!pr) continue;
        // hills rise above the horizon — only skip what's genuinely off-screen
        if (pr.x < -40 || pr.x > W + 40 || pr.y < -60 || pr.y > H + 60) continue;

        const r = Math.max(1.1, pr.scale * sizeK) * (0.4 + ridge * 1.7);
        ctx.fillRect(pr.x - r * 0.5, pr.y - r * 0.5, r, r);
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }
}
