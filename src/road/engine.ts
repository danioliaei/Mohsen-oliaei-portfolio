/* =========================================================================
   Road engine — pure camera / projection math and small render helpers.
   Kept framework-agnostic so the React layer can stay thin and the rAF
   loop can call straight into these without allocations in hot paths.
   ========================================================================= */

// ---- camera / projection tuning ----
export const FOCAL = 1.1;
export const CAM_H = 2200;
export const HORIZON = 0.42;
export const VIEW_DEPTH = 11000;
export const STEP = 120;

/** World half-width of the tarmac near the camera. Tapered with depth below. */
export const ROAD_W = 13;

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
export const terrainHeight = (x: number, z: number): number => {
  const road = LAT(z);
  const ad = Math.abs(x - road); // lateral distance from the road centreline
  const side = smoothstep(90, 1700, ad); // 0 on the road .. 1 up the hillsides

  // valley walls climb away from the road — kept close so the glowing cloud
  // hugs the verge rather than leaving a bare plain between road and hills
  const wall = smoothstep(200, 2400, ad) * 2300;
  // rolling ridges/peaks textured onto the hillsides (muted near the road)
  const rolling =
    560 * Math.sin(z * 0.00055 + x * 0.0007) +
    360 * Math.sin(z * 0.0011 - x * 0.0009 + 1.3) +
    240 * Math.sin(x * 0.0014 + 0.6);

  return roadElevation(z) + wall + rolling * side;
};

/** Height of the terrain ABOVE the local road floor (>= 0). Drives the cloud. */
export const terrainRelief = (x: number, z: number): number =>
  terrainHeight(x, z) - roadElevation(z);

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
    x: W / 2 + scale * (px - camX) * (W / 2),
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
