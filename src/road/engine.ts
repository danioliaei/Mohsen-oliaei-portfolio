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
export const STEP = 140;

/** World half-width of the tarmac — perspective narrows it to a point far off. */
export const ROAD_W = 13;

/** Lateral sway of the road centreline at depth z — a gentle mountain curve. */
export const LAT = (z: number): number =>
  240 * Math.sin(z * 0.00021) + 110 * Math.sin(z * 0.00058 + 1.2);

/**
 * Digital terrain — world elevation at (x, z), shaped as a VALLEY: the road
 * runs along the low floor while hills rise on both sides. The point cloud
 * and the road read from this same field, so the road genuinely sits in the
 * trough between the hills.
 */
export const terrainHeight = (x: number, z: number): number => {
  const road = LAT(z);
  const ad = Math.abs(x - road); // lateral distance from the road centreline
  const side = smoothstep(300, 3200, ad); // 0 on the road .. 1 up the hillsides

  // valley walls climb away from the road
  const wall = smoothstep(520, 4600, ad) * 2300;
  // rolling ridges/peaks textured onto the hillsides (muted near the road)
  const rolling =
    560 * Math.sin(z * 0.00055 + x * 0.0007) +
    360 * Math.sin(z * 0.0011 - x * 0.0009 + 1.3) +
    240 * Math.sin(x * 0.0014 + 0.6);
  // the whole valley floor gently rises and falls down its length
  const floor = 300 * Math.sin(z * 0.00035) + 150 * Math.sin(z * 0.00082 + 1.1);

  return floor + wall + rolling * side;
};

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
 * Road colour ramp: t:0 near (warm white) → 1 far (ember). A single, constant
 * road colour — no per-phase tinting.
 */
export function roadColor(t: number, alpha = 1): string {
  const r = 255;
  const g = Math.round(250 + (143 - 250) * t);
  const b = Math.round(240 + (51 - 240) * t);
  return `rgba(${r},${g},${b},${alpha})`;
}
