/* =========================================================================
   Digital terrain — a DENSE, ORGANIC POINT CLOUD of the land the road runs
   through. The same elevation field that lifts the road is sampled on a fine
   grid; every sample is warped by smooth world-space noise (so it never reads
   as a grid), gated by a clumping field (so it scatters into sporadic drifts),
   and projected through the shared camera as a glowing mote.

   The field is a VALLEY, so the cloud builds hills rising on both sides while
   the road sits in the low trough. Crucially the gate lets a SPARSE scatter of
   motes settle right beside the tarmac, so the cloud reads close to the road —
   thin near the verge, thickening up the hillsides.

   PERF: alpha + colour are set ONCE per depth row (cheap). All warping and
   gating is pure trig — no per-point canvas state changes beyond fillRect.
   The motes are a luminous warm cream so they read against the sunset without
   ever leaving the warm theme.
   ========================================================================= */

import { VIEW_DEPTH, project, roadElevation, terrainHeight } from "./engine";

const NX = 288; // lateral samples
const NZ = 208; // depth samples
const HALF_W = 9000; // world lateral half-range — wide enough to fill 4K sides

/** Cheap smooth value-noise in [0,1], a function of world position only. */
function vnoise(x: number, z: number): number {
  const n =
    Math.sin(x * 0.0013 + z * 0.0007) * 0.5 +
    Math.sin(x * 0.0007 - z * 0.0019 + 2.1) * 0.5;
  return n * 0.5 + 0.5;
}

export class Terrain {
  /** Sample + warp + project the grid, stamping a mote at every kept point. */
  draw(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    camX: number,
    camZ: number,
    camY: number,
  ): void {
    const near = camZ + 80;
    const far = camZ + VIEW_DEPTH;
    const sizeK = W * 0.42; // point size scales with viewport → 4K stays dense

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (let j = 0; j <= NZ; j++) {
      // bias rows toward the near field so the cloud is densest close to camera
      const tz = j / NZ;
      const z = near + (far - near) * (tz * tz * 0.55 + tz * 0.45);
      const depthT = (z - camZ) / VIEW_DEPTH;
      const nearness = 1 - depthT;

      // luminous cream, a touch warmer with distance. Alpha is set ONCE per
      // row (cheap) — hill/valley contrast comes from point size + additive
      // overlap, so there's no costly per-point state change.
      const g = Math.round(247 - depthT * 26);
      const b = Math.round(228 - depthT * 64);
      ctx.fillStyle = `rgb(255,${g},${b})`;
      ctx.globalAlpha = 0.26 + nearness * 0.34;

      for (let i = 0; i <= NX; i++) {
        const baseX = -HALF_W + 2 * HALF_W * (i / NX);

        // smooth world-space warp — breaks the grid into an organic drift
        const wx =
          baseX +
          70 * Math.sin(z * 0.0021 + baseX * 0.004) +
          44 * Math.sin(z * 0.0041 - baseX * 0.0017 + 1.7);
        const wz = z + 60 * Math.sin(baseX * 0.0033 + z * 0.0019);

        const el = terrainHeight(wx, wz);
        const relief = el - roadElevation(wz); // height above the road floor
        let ridge = relief / 2500; // ~0 beside the road .. ~1 on the hilltops
        if (ridge > 1) ridge = 1;

        // clumping field: sporadic organic drifts. Beside the road a fair
        // scatter survives (so the cloud reads close to the verge); up the
        // hills almost everything does.
        const clump = vnoise(wx * 0.6 + 17, wz * 0.6);
        const need = 0.4 - ridge * 0.38;
        if (clump < need) continue;

        const pr = project(wx, wz, el, camX, camZ, camY, W, H);
        if (!pr) continue;
        if (pr.x < -40 || pr.x > W + 40 || pr.y < -60 || pr.y > H + 60) continue;

        // hills glow brighter & larger; verge motes stay smaller but clearly
        // present. extra size where clumps overlap → denser, luminous drifts.
        const r =
          Math.max(1.1, pr.scale * sizeK) *
          (0.6 + ridge * 1.5) *
          (0.7 + clump * 0.6);
        ctx.fillRect(pr.x - r * 0.5, pr.y - r * 0.5, r, r);
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }
}
