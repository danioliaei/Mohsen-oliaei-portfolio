/* =========================================================================
   Digital terrain — flowing TOPOGRAPHIC CONTOUR LINES of the land the road
   runs through (the look of reference 2.jpg): crisp vector isolines of the
   elevation field, not a dot raster. The same valley field that lifts the road
   is sampled on a grid; we run MARCHING SQUARES over it for a set of constant-
   elevation levels and stroke the resulting polylines as true vector paths.

   Why this reads "high quality / vector / server-side-clean": every line is a
   real isoline of the height field, interpolated on cell edges and stroked with
   anti-aliasing and round joins — so curves stay smooth and hairline-crisp at
   any DPR, with none of the shimmer of a point cloud. A depth-of-field fade
   (a soft focus band in the near-mid field, falling off toward the horizon and
   the very foreground) mimics the lens blur in the reference.

   PERF: the scalar field + screen projection are computed ONCE per node into
   reused typed arrays. Marching squares only visits the contour levels that
   actually cross each cell (via a per-cell min/max test), and segments are
   batched into one Path2D per depth band — a handful of stroke() calls total.
   ========================================================================= */

import { LAT, VIEW_DEPTH, project, reliefAt, roadElevation } from "./engine";

const NX = 232; // lateral grid cells (fine, for smooth dense isolines)
const NZ = 168; // depth grid cells
const HALF_W = 8200; // world lateral half-range, centred on the camera
const NODES = (NX + 1) * (NZ + 1);

// contour levels — relief (height above the local road floor) in world units.
// Tight spacing + many levels → the dense, closely-stacked topographic isolines
// of the reference (a fine survey map, not a few sparse rings).
const LMIN = 46;
const LSTEP = 60;
const NLEV = 56; // LMIN .. LMIN+(NLEV-1)*LSTEP  → up to ~3346

// depth bands: segments are grouped by depth so each band strokes once with its
// own focus/alpha/width — gives the depth-of-field fade cheaply.
const NB = 14;

/** Edge → its two corner offsets (TL,TR,BR,BL order). */
// corner indices within a cell: 0=TL 1=TR 2=BR 3=BL
// edges: 0=top(TL,TR) 1=right(TR,BR) 2=bottom(BR,BL) 3=left(BL,TL)
const EDGE_A = [0, 1, 2, 3];
const EDGE_B = [1, 2, 3, 0];

/** Marching-squares case table: mask(TL=1,TR=2,BR=4,BL=8) → edge pairs to join. */
const CASES: number[][][] = [
  [], // 0
  [[0, 3]], // 1  TL
  [[0, 1]], // 2  TR
  [[1, 3]], // 3  TL TR
  [[1, 2]], // 4  BR
  [[0, 3], [1, 2]], // 5  TL BR (saddle)
  [[0, 2]], // 6  TR BR
  [[2, 3]], // 7  TL TR BR
  [[2, 3]], // 8  BL
  [[0, 2]], // 9  TL BL
  [[0, 1], [2, 3]], // 10 TR BL (saddle)
  [[1, 2]], // 11 TL TR BL
  [[1, 3]], // 12 BR BL
  [[0, 1]], // 13 TL BR BL
  [[0, 3]], // 14 TR BR BL
  [], // 15
];

export class Terrain {
  // reused per-frame buffers (no per-frame allocation in the hot path)
  private SX = new Float32Array(NODES);
  private SY = new Float32Array(NODES);
  private F = new Float32Array(NODES);
  private OK = new Uint8Array(NODES);
  private paths: Path2D[] = [];

  /** Sample + project the grid, march the contours, stroke them by depth band. */
  draw(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    camX: number,
    camZ: number,
    camY: number,
  ): void {
    const { SX, SY, F, OK } = this;
    const near = camZ + 220;
    const far = camZ + VIEW_DEPTH;

    // ---- 1. sample the height field + project every node once ----
    let idx = 0;
    for (let j = 0; j <= NZ; j++) {
      const tz = j / NZ;
      // bias rows toward the near field so foreground contours are finely sampled
      const z = near + (far - near) * (tz * tz * 0.62 + tz * 0.38);
      const rz = roadElevation(z); // valley-floor elevation (z-only) — hoisted
      const road = LAT(z); // road centreline (z-only) — hoisted
      for (let i = 0; i <= NX; i++, idx++) {
        const x = camX - HALF_W + ((2 * HALF_W) * i) / NX;
        const relief = reliefAt(x, z, road);
        F[idx] = relief; // relief above the valley floor
        const pr = project(x, z, rz + relief, camX, camZ, camY, W, H);
        if (!pr) {
          OK[idx] = 0;
          continue;
        }
        SX[idx] = pr.x;
        SY[idx] = pr.y;
        OK[idx] = 1;
      }
    }

    // ---- 2. prepare one Path2D per depth band ----
    const paths = this.paths;
    for (let b = 0; b < NB; b++) paths[b] = new Path2D();

    // ---- 3. marching squares — only the levels that cross each cell ----
    const stride = NX + 1;
    const margin = 90;
    for (let j = 0; j < NZ; j++) {
      const band = Math.min(NB - 1, (j * NB / NZ) | 0);
      const path = paths[band];
      const rowTL = j * stride;
      const rowBL = (j + 1) * stride;
      for (let i = 0; i < NX; i++) {
        const tl = rowTL + i;
        const tr = tl + 1;
        const bl = rowBL + i;
        const br = bl + 1;
        if (!OK[tl] || !OK[tr] || !OK[br] || !OK[bl]) continue;

        // node screen coords (TL,TR,BR,BL)
        const ax = SX[tl], ay = SY[tl];
        const bx = SX[tr], by = SY[tr];
        const cx = SX[br], cy = SY[br];
        const dx = SX[bl], dy = SY[bl];

        // cull cells fully offscreen
        if (
          (ax < -margin && bx < -margin && cx < -margin && dx < -margin) ||
          (ax > W + margin && bx > W + margin && cx > W + margin && dx > W + margin) ||
          (ay < -margin && by < -margin && cy < -margin && dy < -margin) ||
          (ay > H + margin && by > H + margin && cy > H + margin && dy > H + margin)
        )
          continue;

        const fa = F[tl], fb = F[tr], fc = F[br], fd = F[bl];
        let mn = fa, mx = fa;
        if (fb < mn) mn = fb; else if (fb > mx) mx = fb;
        if (fc < mn) mn = fc; else if (fc > mx) mx = fc;
        if (fd < mn) mn = fd; else if (fd > mx) mx = fd;

        let lo = Math.ceil((mn - LMIN) / LSTEP);
        let hi = Math.floor((mx - LMIN) / LSTEP);
        if (lo < 0) lo = 0;
        if (hi > NLEV - 1) hi = NLEV - 1;

        for (let li = lo; li <= hi; li++) {
          const L = LMIN + li * LSTEP;
          // classify corners (TL=1,TR=2,BR=4,BL=8)
          let mask = 0;
          if (fa >= L) mask |= 1;
          if (fb >= L) mask |= 2;
          if (fc >= L) mask |= 4;
          if (fd >= L) mask |= 8;
          const segs = CASES[mask];
          if (segs.length === 0) continue;

          // corner field + screen, indexed 0=TL 1=TR 2=BR 3=BL
          // edge crossing helper inlined for speed
          for (let s = 0; s < segs.length; s++) {
            const e0 = segs[s][0];
            const e1 = segs[s][1];

            // edge e0
            let na = EDGE_A[e0], nb = EDGE_B[e0];
            let fA = na === 0 ? fa : na === 1 ? fb : na === 2 ? fc : fd;
            let fB = nb === 0 ? fa : nb === 1 ? fb : nb === 2 ? fc : fd;
            let xA = na === 0 ? ax : na === 1 ? bx : na === 2 ? cx : dx;
            let yA = na === 0 ? ay : na === 1 ? by : na === 2 ? cy : dy;
            let xB = nb === 0 ? ax : nb === 1 ? bx : nb === 2 ? cx : dx;
            let yB = nb === 0 ? ay : nb === 1 ? by : nb === 2 ? cy : dy;
            let denom = fB - fA;
            let t = denom > 1e-6 || denom < -1e-6 ? (L - fA) / denom : 0.5;
            const px0 = xA + (xB - xA) * t;
            const py0 = yA + (yB - yA) * t;

            // edge e1
            na = EDGE_A[e1];
            nb = EDGE_B[e1];
            fA = na === 0 ? fa : na === 1 ? fb : na === 2 ? fc : fd;
            fB = nb === 0 ? fa : nb === 1 ? fb : nb === 2 ? fc : fd;
            xA = na === 0 ? ax : na === 1 ? bx : na === 2 ? cx : dx;
            yA = na === 0 ? ay : na === 1 ? by : na === 2 ? cy : dy;
            xB = nb === 0 ? ax : nb === 1 ? bx : nb === 2 ? cx : dx;
            yB = nb === 0 ? ay : nb === 1 ? by : nb === 2 ? cy : dy;
            denom = fB - fA;
            t = denom > 1e-6 || denom < -1e-6 ? (L - fA) / denom : 0.5;
            const px1 = xA + (xB - xA) * t;
            const py1 = yA + (yB - yA) * t;

            path.moveTo(px0, py0);
            path.lineTo(px1, py1);
          }
        }
      }
    }

    // ---- 4. stroke each band with a gentle atmospheric depth fade ----
    // The sharp/soft FOCUS (tilt-shift bokeh) is applied by the compositor in
    // RoadStage; here we only grade brightness + warmth with depth so distant
    // ridges dissolve into the golden horizon while the near land stays luminous.
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let b = 0; b < NB; b++) {
      const t = b / (NB - 1); // 0 near .. 1 far
      const fade = t < 0.42 ? 1 : Math.max(0, 1 - (t - 0.42) / 0.52);
      const alpha = 0.12 + 0.52 * fade;
      const width = 0.5 + (1 - t) * 0.58;
      // luminous warm-ivory near → warm amber as it recedes into the sunset
      const g = Math.round(248 - t * 34);
      const bch = Math.round(236 - t * 96);
      ctx.strokeStyle = `rgba(255,${g},${bch},${alpha})`;
      ctx.lineWidth = width;
      ctx.stroke(this.paths[b]);
    }
    ctx.restore();
  }
}
