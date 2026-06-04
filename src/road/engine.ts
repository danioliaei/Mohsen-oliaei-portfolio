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

// ---- Phase 2: bird's-eye isometric "diorama" camera ----
// A high, obliquely-angled eye looks down on the land as a tilt-shift miniature.
// The view azimuth is FIXED in world space (it does not yaw to follow the road),
// so the route — which travels broadly along +z — reads as a diagonal threading
// the frame from the LOWER-LEFT to the UPPER-RIGHT, weaving around that diagonal
// as it winds. A longer lens flattens the perspective toward an isometric model.
/** Vertical field of view (rad) — a long lens → flat, model-like perspective. */
const FOVY = (28 * Math.PI) / 180;
/** World-fixed view azimuth (rad) — yaws the land so the road runs ↗ (BL→TR). */
const AZIM = (45 * Math.PI) / 180;
/** Eye elevation above the ground plane (rad) — high & looking down, but oblique
 *  enough to read the relief as a 3-D model (the classic diorama / iso angle). */
const ELEV = (44 * Math.PI) / 180;
/** Eye→target distance (world units) — sets the zoom for the chosen lens.
 *  Pulled well back to a high, wide bird's-eye framing: the whole winding land
 *  reads as a distant diorama, with a long reach of the road threading across it
 *  and more of the surrounding hills and contour detail in view. */
const ORBIT = 25200;
/** How far along the road (world units) the framed centre sits ahead of the cam. */
const LOOK_AHEAD = 1600;
const NEAR = 120;
const FAR = VIEW_DEPTH * 2.4;

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
 *
 * IMPORTANT: this MUST stay an exact twin of `latz()` in the WGSL terrain field
 * (gpu/shaders.ts). The terrain lowers its corridor along `latz`; the road rides
 * `LAT`. If the two drift apart the road no longer sits in the trough and appears
 * to float over / sink into the hills — so any change here must be mirrored there.
 */
export const LAT = (z: number): number =>
  1180 * Math.sin(z * 0.00017 + 0.4) +
  680 * Math.sin(z * 0.00049 + 1.6) +
  320 * Math.sin(z * 0.00094 + 0.5);

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
 * Build the frame's view-projection matrix for the bird's-eye diorama camera.
 * The eye looks at a point on the road a little ahead of the current position
 * (`LAT(camZ + LOOK_AHEAD)`) from a FIXED world-space direction (azimuth AZIM,
 * elevation ELEV), so scrolling PANS the model diagonally rather than yawing it —
 * the winding road keeps reading lower-left → upper-right. Call once per frame
 * before `project()` / before drawing the GPU terrain.  (`_camX` is unused: the
 * frame is anchored to the road ahead, not the camera's lateral position.)
 */
export function setCamera(
  _camX: number, camZ: number, W: number, H: number,
): void {
  _W = W;
  _H = H;
  _f = 1 / Math.tan(FOVY / 2);
  // framed centre: a point on the road just ahead of the current position
  const tx = LAT(camZ + LOOK_AHEAD);
  const ty = roadBedY(camZ + LOOK_AHEAD);
  const tz = camZ + LOOK_AHEAD;
  // fixed world-space view direction (down ELEV, yawed by AZIM) → eye sits back
  // along it; the road's +z travel then projects to the upper-right of the frame
  const fx = Math.cos(ELEV) * Math.sin(AZIM);
  const fy = -Math.sin(ELEV);
  const fz = Math.cos(ELEV) * Math.cos(AZIM);
  const ex = tx - ORBIT * fx;
  const ey = ty - ORBIT * fy;
  const ez = tz - ORBIT * fz;
  _eye[0] = ex; _eye[1] = ey; _eye[2] = ez;
  const proj = mPerspective(FOVY, W / H, NEAR, FAR);
  const view = mLookAt(ex, ey, ez, tx, ty, tz, 0, 1, 0);
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
