/* =========================================================================
   Road engine — pure camera / projection math and small render helpers.
   Kept framework-agnostic so the React layer can stay thin and the rAF
   loop can call straight into these without allocations in hot paths.
   ========================================================================= */

// ---- camera / projection tuning (faithful to the original) ----
export const FOCAL = 1.1;
export const CAM_H = 2200;
export const HORIZON = 0.4;
export const VIEW_DEPTH = 11000;
export const STEP = 170;
export const TRAVEL = 15600;

/** Lateral sway of the road centreline at depth z (two stacked sines). */
export const LAT = (z: number): number =>
  720 * Math.sin(z * 0.0002) + 300 * Math.sin(z * 0.00052 + 1.2);

export interface Projected {
  x: number;
  y: number;
  scale: number;
  dz: number;
}

/**
 * Perspective-project a world point (px lateral, pz depth) into screen space
 * for a camera at (camX, camZ). Returns null for points behind the camera.
 */
export function project(
  px: number,
  pz: number,
  camX: number,
  camZ: number,
  W: number,
  H: number,
): Projected | null {
  const dz = pz - camZ;
  if (dz < 1) return null;
  const scale = FOCAL / dz;
  return {
    x: W / 2 + scale * (px - camX) * (W / 2),
    y: H * HORIZON + scale * CAM_H * (H / 2),
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
 * Road colour ramp: t:0 near (warm white) → 1 far (ember).
 * `alpha` lets callers fade segments without rebuilding the string.
 */
export function roadColor(t: number, alpha = 1): string {
  const r = 255;
  const g = Math.round(250 + (143 - 250) * t);
  const b = Math.round(240 + (51 - 240) * t);
  return `rgba(${r},${g},${b},${alpha})`;
}
