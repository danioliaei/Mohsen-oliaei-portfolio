/* =========================================================================
   Road engine — pure camera / projection math and small render helpers.
   Kept framework-agnostic so the React layer can stay thin and the rAF
   loop can call straight into these without allocations in hot paths.
   ========================================================================= */

// ---- camera / projection tuning ----
// An ELEVATED, looking-down aerial eye (the "tilt-shift miniature" vantage of the
// reference): the eye sits high above the valley floor (large CAM_H) and the
// horizon is pushed up the frame (small HORIZON) so the topographic land fills
// almost the whole view and recedes to a compressed, distant ridge line.
export const FOCAL = 1.04;
export const CAM_H = 3850;
export const HORIZON = 0.24;
export const VIEW_DEPTH = 11000;
export const STEP = 120;

/** World half-width of the tarmac near the camera. Tapered with depth below. */
export const ROAD_W = 13;

/**
 * Horizontal "lens shift" — the screen-space fraction the world's optical axis
 * (the road centreline at the camera) maps to. 0.5 = centred. We push it left
 * so the glowing road rides the LEFT third of the frame, freeing the right side
 * for the floating navigation cards. Set per-frame by the render loop (it eases
 * back toward centre on narrow viewports). The lateral SPREAD is unchanged — we
 * only move the origin, so the road geometry stays exactly as tuned.
 */
let LENS_X = 0.5;
export const setLensX = (v: number): void => {
  LENS_X = v;
};
export const getLensX = (): number => LENS_X;

/** Lateral sway of the road centreline at depth z — a winding mountain route. */
export const LAT = (z: number): number =>
  300 * Math.sin(z * 0.00019) +
  150 * Math.sin(z * 0.00052 + 1.2) +
  78 * Math.sin(z * 0.00091 + 2.4);

/** A localised terrain feature — a smooth hill crest or valley dip. */
const gauss = (z: number, c: number, w: number, a: number): number =>
  a * Math.exp(-(((z - c) / w) ** 2));

/**
 * The ROAD'S OWN vertical profile — the elevation of the tarmac (and the
 * valley floor it sits in) as it travels down its length. Authored to read
 * like a real route across terrain: rolling base undulation plus deliberate
 * features — crest a broad hill, descend into a wide low flat, a gentle late
 * rise, then a dip toward the end. The camera rides this profile, so scrolling
 * genuinely feels like cresting hills and dropping into low land.
 */
export const roadElevation = (z: number): number => {
  const rolling =
    360 * Math.sin(z * 0.00024 + 0.5) + 210 * Math.sin(z * 0.00058 + 1.9);
  const features =
    gauss(z, 5200, 2500, 880) - // climb up and over a broad hill
    gauss(z, 11800, 3300, 1020) + // long descent into wide low flat land
    gauss(z, 17600, 2300, 560) - // gentle rise back up
    gauss(z, 21200, 1700, 380); // a final dip toward the horizon
  return rolling + features;
};

/**
 * Digital terrain — world elevation at (x, z), shaped as a VALLEY built around
 * the road's own profile: the tarmac runs along the low floor while hills rise
 * on both sides. The point cloud and the road read from this same field, so the
 * road genuinely sits in the trough between the hills.
 */
/**
 * Terrain RELIEF above the local valley floor at (x, z), GIVEN the precomputed
 * road centreline `road = LAT(z)`. This is the per-point work only — it contains
 * no z-only terms — so the hot sampling loop can hoist the costly `LAT(z)` and
 * `roadElevation(z)` (sines + exponentials) out to once per depth row.
 */
export const reliefAt = (x: number, z: number, road: number): number => {
  const ad = Math.abs(x - road); // lateral distance from the road centreline
  const side = smoothstep(90, 1700, ad); // 0 on the road .. 1 up the hillsides

  // valley walls climb away from the road — kept close so the glowing land
  // hugs the verge rather than leaving a bare plain between road and hills
  const wall = smoothstep(200, 2500, ad) * 2550;
  // rolling ridges/peaks textured onto the hillsides (muted near the road).
  // Layered octaves — broad swells down to fine crinkle — so the contour field
  // reads as DENSE, organically flowing isolines like the reference.
  const rolling =
    640 * Math.sin(z * 0.00055 + x * 0.0007) +
    430 * Math.sin(z * 0.0011 - x * 0.0009 + 1.3) +
    270 * Math.sin(x * 0.0014 + 0.6) +
    190 * Math.sin(z * 0.0019 + x * 0.0016 + 2.1) +
    125 * Math.sin(x * 0.0027 - z * 0.0009 + 0.9) +
    78 * Math.sin(z * 0.0036 + x * 0.0031 + 3.2);

  return wall + rolling * side;
};

/** Absolute world elevation at (x, z) — the valley floor plus its relief. */
export const terrainHeight = (x: number, z: number): number =>
  roadElevation(z) + reliefAt(x, z, LAT(z));

/** Height of the terrain ABOVE the local road floor (>= 0). Drives the land. */
export const terrainRelief = (x: number, z: number): number =>
  reliefAt(x, z, LAT(z));

/**
 * Half-width of the tarmac at depth `dz` from the camera. The near width is
 * full `ROAD_W` (the size the user likes); it tapers down the road so the far
 * end reads markedly narrower than linear perspective alone — exaggerated depth.
 */
export const roadHalfWidth = (dz: number): number =>
  ROAD_W * (1 - 0.5 * smoothstep(0, VIEW_DEPTH * 0.9, dz));

export interface Projected {
  x: number;
  y: number;
  scale: number;
  dz: number;
}

/**
 * Perspective-project a world point into screen space.
 *   px – lateral world position
 *   pz – depth (down the road)
 *   py – world elevation (terrain height)
 * for a camera at (camX, camZ) whose eye-line sits at elevation camY.
 * Returns null for points behind the camera.
 */
export function project(
  px: number,
  pz: number,
  py: number,
  camX: number,
  camZ: number,
  camY: number,
  W: number,
  H: number,
): Projected | null {
  const dz = pz - camZ;
  if (dz < 1) return null;
  const scale = FOCAL / dz;
  return {
    x: W * LENS_X + scale * (px - camX) * (W / 2),
    // higher terrain (py > camY) lifts the point up the screen
    y: H * HORIZON + scale * (CAM_H - (py - camY)) * (H / 2),
    scale,
    dz,
  };
}

/** Smooth Hermite ramp between a and b. */
export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/**
 * Road colour ramp: t:0 near (warm ivory) → 1 far (deep ember). A single,
 * constant warm road colour — no per-phase tinting.
 */
export function roadColor(t: number, alpha = 1): string {
  const r = 255;
  const g = Math.round(248 + (150 - 248) * t);
  const b = Math.round(236 + (70 - 236) * t);
  return `rgba(${r},${g},${b},${alpha})`;
}
