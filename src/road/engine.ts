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

/* ---- user free-look camera offsets (orbit / zoom / pan) ------------------ */
// The scroll journey drives the BASE framing (azimuth AZIM, elevation ELEV,
// distance ORBIT, looking at the road ahead). On top of that the viewer can
// orbit, dolly and pan within bounds to inspect the diorama from any angle —
// then a "recenter" control eases these back to zero. All five are world-fixed
// offsets so the winding road keeps reading lower-left → upper-right at rest.
interface CamOffsets {
  azim: number; // yaw offset (rad)
  elev: number; // pitch offset (rad)
  zoom: number; // distance multiplier (1 = default)
  panX: number; // screen-right pan of the framed centre (world units)
  panZ: number; // screen-forward pan of the framed centre (world units)
}
const _off: CamOffsets = { azim: 0, elev: 0, zoom: 1, panX: 0, panZ: 0 };

/** Hard travel limits for the free-look camera — generous enough to roam the
 *  plan and drop to a near-top-down "survey" view, tight enough that the scene
 *  always stays composed and you can never fly under the ground or behind it. */
export const CAM_LIMITS = {
  azim: [-0.95, 0.95] as const, // ≈ ±54°
  elev: [-0.42, 0.66] as const, // base 44° → ≈ 20°..82° absolute
  zoom: [0.52, 1.75] as const, // dolly in to inspect, out to the wide finite plan
  panX: [-7000, 7000] as const,
  panZ: [-7000, 7000] as const,
} as const;

/** Push the current free-look offsets (already eased + clamped by the caller). */
export const setCamOffsets = (o: CamOffsets): void => {
  _off.azim = o.azim;
  _off.elev = o.elev;
  _off.zoom = o.zoom;
  _off.panX = o.panX;
  _off.panZ = o.panZ;
};

/** The neutral offsets — the "default mode" the recenter button returns to. */
export const CAM_DEFAULT: CamOffsets = { azim: 0, elev: 0, zoom: 1, panX: 0, panZ: 0 };

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
  const natural = roadFloor(z) * (1 - t) + organic(x, z) * t;
  // flatten the organic land into the engineered Stegra terrace (see TERRACE)
  const m = terraceMask(x, z);
  return natural * (1 - m) + TERRACE.y * m;
};

/** The road, stations and camera ride a smooth grade just above the low ground. */
export const roadBedY = (z: number): number => roadFloor(z) + 25;

/* ---- Stegra site: a graded terrace cut into the hillside ----------------- */
/**
 * The gigafactory does not sit on the raw rolling land — it stands on an
 * engineered platform bulldozed into it (exactly like Stegra/Northvolt in
 * reality: a vast flat terrace cut-and-filled into forested hills). We carve
 * that platform straight into the height field so the ground is GENUINELY flat
 * where the plant stands, with embankment slopes blending back into the organic
 * hills — the contour iso-lines then wrap those slopes, reading as real graded
 * earthworks. The factory geometry (factory.ts) stands on this exact `y`, so it
 * can never float or be pierced by a stray ridge.
 *
 * `x,z` centre the terrace beside the road at the Stegra milestone (z≈21080,
 * road offset −1700). `hw,hd` are the flat-top half-extents, `r` the corner
 * radius, `emb` the embankment blend width (slope reach). Verified: the road
 * corridor stays >500u clear, so grading the land here never disturbs it.
 *
 * IMPORTANT: these numbers + the maths in `siteGradeY()` MUST stay an exact twin
 * of the terrace block in the WGSL `terrainH()` (gpu/shaders.ts). The GPU land
 * and the JS height field (road, factory pad) read the same surface — if the two
 * drift, the plant floats or the road sinks. Mirror any change in both places.
 */
export const TERRACE = {
  x: -2667,
  z: 21080,
  y: 560,
  hw: 860,
  hd: 1000,
  r: 230,
  emb: 440,
} as const;

/** Terrace influence at (x,z): 1 on the flat top, easing to 0 past the
 *  embankment. A rounded-box signed distance keeps the slope width uniform. */
const terraceMask = (x: number, z: number): number => {
  const qx = Math.abs(x - TERRACE.x) - (TERRACE.hw - TERRACE.r);
  const qz = Math.abs(z - TERRACE.z) - (TERRACE.hd - TERRACE.r);
  const ox = Math.max(qx, 0);
  const oz = Math.max(qz, 0);
  const sdf = Math.hypot(ox, oz) + Math.min(Math.max(qx, qz), 0) - TERRACE.r;
  return 1 - smoothstep(0, TERRACE.emb, sdf);
};

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
  // base framing + the user's free-look offsets (yaw, pitch, dolly, pan)
  const azim = AZIM + _off.azim;
  const elev = clamp(ELEV + _off.elev, 0.32, 1.5);
  const orbit = ORBIT * _off.zoom;
  // pan slides the framed centre along the SCREEN axes projected onto the ground,
  // so dragging moves the model the way it looks like it should regardless of yaw
  const rightX = Math.cos(azim);
  const rightZ = -Math.sin(azim);
  const fwdX = Math.sin(azim);
  const fwdZ = Math.cos(azim);
  // framed centre: a point on the road just ahead of the current position, panned
  const baseZ = camZ + LOOK_AHEAD;
  const tx = LAT(baseZ) + _off.panX * rightX + _off.panZ * fwdX;
  const tz = baseZ + _off.panX * rightZ + _off.panZ * fwdZ;
  const ty = roadBedY(baseZ);
  // fixed world-space view direction (down elev, yawed by azim) → eye sits back
  // along it; the road's +z travel then projects to the upper-right of the frame
  const fx = Math.cos(elev) * Math.sin(azim);
  const fy = -Math.sin(elev);
  const fz = Math.cos(elev) * Math.cos(azim);
  const ex = tx - orbit * fx;
  const ey = ty - orbit * fy;
  const ez = tz - orbit * fz;
  _eye[0] = ex; _eye[1] = ey; _eye[2] = ez;
  // The far plane must clear the scene at ANY dolly distance: when the viewer
  // zooms out (orbit grows) the whole plan would otherwise fall behind a fixed
  // far plane and vanish. Pad the eye→target distance by the scene's own depth.
  const far = orbit + FAR;
  const proj = mPerspective(FOVY, W / H, NEAR, far);
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
