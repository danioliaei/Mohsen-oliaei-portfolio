/* =========================================================================
   Road engine — pure camera / projection math and small render helpers.
   Kept framework-agnostic so the React layer can stay thin and the rAF
   loop can call straight into these without allocations in hot paths.
   ========================================================================= */

// ---- camera / projection tuning ----
// A forward-looking "driver" camera: an elevated eye set back behind the current
// position, looking AHEAD and slightly down the road as it threads a VALLEY, so
// the route recedes to a vanishing point with hills rising on either side and we
// feel like we're travelling through the land. The SAME view-projection matrix
// drives both the GPU terrain and the 2-D road/station overlay, so they align.
export const VIEW_DEPTH = 13000;
export const STEP = 120;

/** Vertical field of view (rad) — a fairly normal lens for the travelling view. */
const FOVY = (40 * Math.PI) / 180;
/** Camera pitch DOWN from horizontal (rad) — elevated, looking into the valley. */
const PITCH = (30 * Math.PI) / 180;
/** Eye→target distance (world units): set back behind, riding above the road. */
const EYE_DIST = 3000;
/** How far down the road (world units) the camera aims. */
const LOOK_AHEAD = 2600;
const NEAR = 120;
const FAR = VIEW_DEPTH * 1.7;

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

/**
 * Lateral position of the road centreline at depth z — a route that genuinely
 * CHANGES DIRECTION as it travels: layered swings of different wavelengths give
 * long sweeping bends with shorter kinks on top, so the road heads left, then
 * right, then back, rather than holding one gentle curve.
 */
export const LAT = (z: number): number =>
  560 * Math.sin(z * 0.0001 + 0.4) +
  200 * Math.sin(z * 0.00024 + 1.6);

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
 * Organic hill field (domain-warped ridges) — the EXACT JS twin of `organic()`
 * in gl.ts. The low-frequency waves bend the coordinates before the higher
 * octaves sample, giving the braided, swirling topography of real eroded land.
 */
const organic = (x: number, z: number): number => {
  const wx = x + 760 * Math.sin(z * 0.00042 + 0.3) + 420 * Math.sin(z * 0.00097 + 2.1);
  const wz = z + 760 * Math.sin(x * 0.00038 + 1.7) + 420 * Math.sin(x * 0.00091 + 0.4);
  return (
    900 * Math.sin(wx * 0.00115 + wz * 0.0008) +
    520 * Math.sin(wz * 0.00175 - wx * 0.00135 + 1.3) +
    300 * Math.sin(wx * 0.00255 + wz * 0.0021 + 0.6) +
    175 * Math.sin(wz * 0.0036 + wx * 0.0033 + 2.1) +
    100 * Math.sin(wx * 0.0047 - wz * 0.0043 + 0.9)
  );
};

/** The road's own smooth vertical grade — gentle climbs and descents, the kind a
 *  real road can hold, independent of the surrounding hills' fine relief. */
const roadFloor = (z: number): number =>
  520 * Math.sin(z * 0.00012 + 0.5) + 240 * Math.sin(z * 0.00026 + 2.1);

/** Elevation of the valley FLOOR the road runs along (a gentle road grade). */
export const roadGradeY = (z: number): number => roadFloor(z);

/**
 * Terrain surface height at (x, z) — INDEPENDENT rolling hills (the organic
 * field) with a shallow corridor lowered along the road, so the route travels
 * the low ground while real hills rise around it and can stand BETWEEN the
 * camera and a far stretch of road (which still shows, drawn on top). The road
 * itself rides a smooth grade, so it never folds over a crest. EXACT twin of
 * `terrainH()` in gl.ts.
 */
export const surfaceY = (x: number, z: number): number => {
  const d = Math.abs(x - LAT(z));
  const t = 0.12 + 0.88 * smoothstep(120, 1300, d); // 0.12 near road .. 1 in hills
  return roadFloor(z) * (1 - t) + organic(x, z) * t;
};

/** The road, stations and camera ride a smooth grade just above the low ground. */
export const roadBedY = (z: number): number => roadGradeY(z) + 25;

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

/* ---- mat4 (column-major) helpers — tiny, dependency-free ---------------- */
type Mat4 = Float32Array;

function mPerspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function mLookAt(
  ex: number, ey: number, ez: number,
  cx: number, cy: number, cz: number,
  ux: number, uy: number, uz: number,
): Mat4 {
  let zx = ex - cx, zy = ey - cy, zz = ez - cz;
  let rl = 1 / Math.hypot(zx, zy, zz);
  zx *= rl; zy *= rl; zz *= rl;
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  rl = 1 / Math.hypot(xx, xy, xz);
  xx *= rl; xy *= rl; xz *= rl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx; m[1] = yx; m[2] = zx; m[3] = 0;
  m[4] = xy; m[5] = yy; m[6] = zy; m[7] = 0;
  m[8] = xz; m[9] = yz; m[10] = zz; m[11] = 0;
  m[12] = -(xx * ex + xy * ey + xz * ez);
  m[13] = -(yx * ex + yy * ey + yz * ez);
  m[14] = -(zx * ex + zy * ey + zz * ez);
  m[15] = 1;
  return m;
}

function mMul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

// ---- shared camera state: one view-projection matrix per frame ----
let _vp: Mat4 = new Float32Array(16);
let _W = 1;
let _H = 1;
let _f = 1;

/**
 * Build the frame's view-projection matrix for a forward-looking camera riding
 * the road at (camX, camZ), aimed straight down its own axis. Call once per frame
 * before `project()` / before drawing the GPU terrain.
 */
export function setCamera(
  camX: number, camZ: number, W: number, H: number,
): void {
  _W = W;
  _H = H;
  _f = 1 / Math.tan(FOVY / 2);
  const cz = camZ + LOOK_AHEAD;
  const cx = camX;
  const cy = roadBedY(cz) + 200; // aim a touch above the road grade ahead
  const ex = camX;
  const ey = roadBedY(camZ) + EYE_DIST * Math.sin(PITCH); // eye rides the road grade
  const ez = camZ - EYE_DIST * Math.cos(PITCH);
  const proj = mPerspective(FOVY, W / H, NEAR, FAR);
  const view = mLookAt(ex, ey, ez, cx, cy, cz, 0, 1, 0);
  _vp = mMul(proj, view);
}

/** The current frame's view-projection matrix (column-major) — for the GPU. */
export const getViewProj = (): Mat4 => _vp;

/**
 * Project a world point (px lateral, pz depth, py elevation) to screen space
 * using the frame's shared camera. A horizontal LENS_X shift slides the whole
 * scene so the road can ride the left third. Returns null for points behind the
 * camera.  `scale` = screen px per world unit at this depth; `dz` = view depth.
 */
export function project(px: number, pz: number, py: number): Projected | null {
  const m = _vp;
  const cx = m[0] * px + m[4] * py + m[8] * pz + m[12];
  const cy = m[1] * px + m[5] * py + m[9] * pz + m[13];
  const cw = m[3] * px + m[7] * py + m[11] * pz + m[15];
  if (cw <= 1) return null;
  const ndcx = cx / cw + (LENS_X - 0.5) * 2;
  const ndcy = cy / cw;
  return {
    x: (ndcx * 0.5 + 0.5) * _W,
    y: (1 - (ndcy * 0.5 + 0.5)) * _H,
    scale: _f / cw,
    dz: cw,
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
