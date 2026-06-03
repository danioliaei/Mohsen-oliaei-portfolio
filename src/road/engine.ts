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

/**
 * Lateral position of the road centreline at depth z — a route that genuinely
 * CHANGES DIRECTION as it travels: layered swings of different wavelengths give
 * long sweeping bends with shorter kinks on top, so the road heads left, then
 * right, then back, rather than holding one gentle curve.
 */
export const LAT = (z: number): number =>
  620 * Math.sin(z * 0.00012 + 0.4) +
  300 * Math.sin(z * 0.00033 + 1.6) +
  120 * Math.sin(z * 0.00062 + 0.5);

/**
 * Organic hill field (domain-warped ridges) — the EXACT JS twin of `organic()`
 * in the WGSL terrain field (gpu/shaders.ts). The low-frequency waves bend the
 * coordinates before the higher octaves sample, giving the braided, swirling
 * topography of real eroded land. The road and terrain read this same field so
 * the route genuinely sits in the trough between the hills.
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

/**
 * Terrain surface height at (x, z) — INDEPENDENT rolling hills (the organic
 * field) with a shallow corridor lowered along the road, so the route travels
 * the low ground while real hills rise around it and can stand BETWEEN the
 * camera and a far stretch of road (which still shows, drawn on top). The road
 * itself rides a smooth grade, so it never folds over a crest. EXACT twin of
 * `terrainH()` in the WGSL terrain field (gpu/shaders.ts).
 */
export const surfaceY = (x: number, z: number): number => {
  const d = Math.abs(x - LAT(z));
  const t = 0.12 + 0.88 * smoothstep(120, 1300, d); // 0.12 near road .. 1 in hills
  return roadFloor(z) * (1 - t) + organic(x, z) * t;
};

/** The road, stations and camera ride a smooth grade just above the low ground. */
export const roadBedY = (z: number): number => roadFloor(z) + 25;

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
const _eye = new Float32Array(3);

/**
 * Build the frame's view-projection matrix for a forward-looking camera riding
 * the road at (camX, camZ). Crucially the camera AIMS AT THE ROAD AHEAD
 * (`LAT(camZ + LOOK_AHEAD)`) rather than straight down the depth axis — so as the
 * route bends the camera yaws to follow it, and the road visibly sweeps left and
 * right through the frame. (Aiming straight ahead made the winding road collapse
 * to a dead-straight vertical streak.) Call once per frame before `project()` /
 * before drawing the GPU terrain.
 */
export function setCamera(
  camX: number, camZ: number, W: number, H: number,
): void {
  _W = W;
  _H = H;
  _f = 1 / Math.tan(FOVY / 2);
  const cz = camZ + LOOK_AHEAD;
  const cx = LAT(cz); // aim along the road's heading → bends actually read
  const cy = roadBedY(cz) + 200; // aim a touch above the road grade ahead
  const ex = camX;
  const ey = roadBedY(camZ) + EYE_DIST * Math.sin(PITCH); // eye rides the road grade
  const ez = camZ - EYE_DIST * Math.cos(PITCH);
  _eye[0] = ex; _eye[1] = ey; _eye[2] = ez;
  const proj = mPerspective(FOVY, W / H, NEAR, FAR);
  const view = mLookAt(ex, ey, ez, cx, cy, cz, 0, 1, 0);
  _vp = mMul(proj, view);
}

/** The current frame's view-projection matrix (column-major) — for the GPU. */
export const getViewProj = (): Mat4 => _vp;

/** The current frame's camera eye position [x, y, z] in world units. */
export const getCamEye = (): Float32Array => _eye;

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
