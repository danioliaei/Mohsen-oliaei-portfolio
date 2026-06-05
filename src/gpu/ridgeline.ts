/* =========================================================================
   RidgelineScene — the monochrome "Unknown Pleasures" mountain, the homepage hero.

   A self-contained WebGPU renderer: its own eye-level camera, its own height
   field, and a tiny pass chain. One HDR target is drawn (backdrop halo → solid contour mesh
   that writes depth for hidden-line removal); a faint bloom adds a snow-glow;
   the composite box-AA's, grades and grains it to the swap-chain.

   Reuses device.ts for the GPU bootstrap; all of its WGSL (the ridge passes plus
   the generic BRIGHT/BLUR post chain) lives in ridgelineShaders.ts, so this file
   stays focused on the look.
   ========================================================================= */

import {
  createGPU,
  configureCanvas,
  compileModule,
  makeTarget,
  type GPUCtx,
} from "./device";
import {
  RIDGE_BACKDROP_WGSL,
  RIDGE_TERRAIN_WGSL,
  RIDGE_COMPOSITE_WGSL,
  BRIGHT_WGSL,
  BLUR_WGSL,
} from "./ridgelineShaders";

const HDR: GPUTextureFormat = "rgba16float";

// ---- camera (eye-level, looking across the dune plain toward the summit) ----
// Set high enough above the dunes that the foreground reads as densely-packed
// constant-depth profiles, with a gentle up-tilt that drops the horizon below
// mid-frame so the halo has sky to breathe in and the peak towers through it.
const FOVY = (34 * Math.PI) / 180;
const NEAR = 60;
const FAR = 60000;
// a fairly low eye set back from the dune field, looking UP toward the summit so
// the horizon drops below mid-frame and the peak towers into black sky (where the
// halo breathes). Eye sits well above the low plain → dense foreground profiles.
const EYE: [number, number, number] = [0, 1720, -3000];
const TGT: [number, number, number] = [0, 2280, 8200];
const WORLD_H_MAX = 5000; // height that normalises to "full snow" in the shader

// ---- mesh density: fine enough for crisp ridge silhouettes + rock striations.
// The scan-LINES themselves are analytic (per-fragment from world depth), so this
// only governs surface fidelity, not how many contour lines appear.
const NX = 760;
const NZ = 420;

/** Per-frame inputs from the stage (orbit offsets + clock). */
export interface RidgeFrame {
  time: number;
  /** Orbit YAW offset about the summit (radians); 0 = the authored rest framing.
   *  Unbounded — the viewer can spin a full turn (and beyond) around the peak. */
  yaw: number;
  /** Orbit PITCH offset (radians); 0 = rest. The scene clamps the ABSOLUTE
   *  elevation to ELEV_RANGE so the eye never dips under the dunes nor tips past
   *  a high survey angle. */
  pitch: number;
  /** Hovered career slice index (0 = the tight summit ring … 6 = the wide dune
   *  ring), or -1 when the pointer rests on no callout. Lights that slice's band. */
  hoverBand?: number;
  /** Hover pulse amplitude 0..1 (eased on enter, gently breathing, eased out on
   *  leave); 0 leaves every slice at rest. */
  hoverGlow?: number;
  /** SELECTED (clicked) career slice 0..6, or -1 when nothing is focused. While a
   *  slice is focused every OTHER band recedes toward black so the chosen ring reads
   *  as the lit hero. Held sticky through the fade-out so the dim eases off the right
   *  band rather than snapping. */
  focusBand?: number;
  /** Focus / isolation amount 0..1 (eased on select, eased out on dismiss). Drives
   *  both the dim of the un-selected bands and the camera dolly via `radiusScale`. */
  focusAmt?: number;
  /** Orbit-radius multiplier: 1 at rest, ~0.84 when a slice is focused (a gentle
   *  dolly-in toward the summit). MUST match the value the survey overlay projects
   *  with, or the callouts slide off the mountain during the zoom. */
  radiusScale?: number;
  /** Horizontal lens shift in NDC: 0 at rest, eased to ~+0.42 while a slice is
   *  focused (desktop only) so the massif pans into the clear RIGHT of the dossier.
   *  MUST match the value the survey overlay projects with (same vp). */
  focusShift?: number;
  /** VERTICAL lens shift in NDC: 0 at rest, eased to a positive value while a slice
   *  is focused so the SELECTED ring lifts to a comfortable framing height — without
   *  it the dolly-in keeps aiming at the summit and the low (early-career) rings near
   *  the dune plain fall off the bottom of the frame. Mirror of focusShift; MUST match
   *  the value the survey overlay projects with (same vp). */
  focusShiftY?: number;
}

/* ---- orbit camera: drag to spin a full turn around the summit -------------
   The authored EYE→TGT framing is re-expressed as spherical coordinates about
   the summit pivot (TGT). At yaw = pitch = 0 the eye lands back on EYE exactly —
   the rest composition is untouched — and the stage then layers a free YAW (a
   full 360°) and a clamped PITCH from the viewer's pointer drag on top. */
const ORBIT = (() => {
  const rx = EYE[0] - TGT[0];
  const ry = EYE[1] - TGT[1];
  const rz = EYE[2] - TGT[2];
  const radius = Math.hypot(rx, ry, rz);
  return {
    radius,
    azim: Math.atan2(rx, rz), // yaw about +y; rest looks down the dune field
    elev: Math.asin(ry / radius), // the rest framing's gentle up-tilt
  };
})();

/** Absolute elevation clamp (rad): the floor keeps the eye above the dune plain
 *  when tilting up under the peak; the ceiling stops shy of a top-down survey so
 *  the silhouette never flattens out. The stage maps these to pitch-offset walls. */
const ELEV_RANGE: readonly [number, number] = [-0.12, 1.0];

/** The ELEV_RANGE clamp expressed as pitch-OFFSET walls (since pitch is added to
 *  ORBIT.elev). Exported so the stage's inertia stops dead at the same walls. */
export const PITCH_LO = ELEV_RANGE[0] - ORBIT.elev;
export const PITCH_HI = ELEV_RANGE[1] - ORBIT.elev;

/* ---- tiny column-major mat4 helpers (dependency-free) ------------------- */
type Mat4 = Float32Array;
function persp(fovy: number, aspect: number, near: number, far: number): Mat4 {
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
function lookAt(
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
function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

/* ---- survey-station geometry: where a ring's callout pins to the massif ------
   The index contours are concentric RINGS (the RINGS array in
   ridgelineShaders.ts) — each career station is the plan RADIUS of one surveyed
   ring about the summit axis. RidgelineStage (its STATIONS array) carries the
   radii and pins a DOM callout to where each ring crosses the mountain's near,
   camera-facing face; ringAnchor() below resolves that world point. */
const PEAK_Z = 8200; // summit depth (mirrors TGT.z and the shader's PEAK_Z)
const PEAK_H = 3300; // summit height (mirrors the shader's PEAK_H)
const RING_ANISO_Z = Math.sqrt(0.58); // on x = 0, baseR = |dz|·√0.58 (shader anisotropy)

/** Dominant ridge height on the central axis (x = 0) at depth z — the smooth cone
 *  part of heightAt(); the painted index contour sits ~here. The small ridged /
 *  fbm relief is folded in as a mean lift so the leader tip grazes the lit band. */
function ridgeCrestHeight(z: number): number {
  const dz = z - PEAK_Z;
  const rad = Math.sqrt(dz * dz * 0.58) / 3300;
  const sharp = Math.max(0, 1 - rad * 1.3);
  const coneB = Math.exp(-rad * rad * 0.95);
  return PEAK_H * (0.34 * coneB + sharp) + 300;
}

/** World anchor for a ring's callout: the point where the ring of plan radius R
 *  crosses the mountain's near, camera-facing face on the central axis (x = 0).
 *  There the plan radius reduces to |dz|·√0.58, so dz = −R/√0.58; the leader tip
 *  then grazes the lit ring on the slope that faces the viewer at the rest pose. */
export function ringAnchor(radius: number): { x: number; y: number; z: number } {
  const z = Math.max(700, PEAK_Z - radius / RING_ANISO_Z);
  return { x: 0, y: ridgeCrestHeight(z), z };
}

/** The exact eye + view-projection the scene renders for a given orbit, re-exposed
 *  so the stage can project survey anchors to screen in lock-step with the GPU
 *  (breathing included, so the labels never drift off the mountain). */
export function ridgeCamera(
  yaw: number,
  pitch: number,
  aspect: number,
  time = 0,
  radiusScale = 1,
  shiftX = 0,
  shiftY = 0,
): { vp: Float32Array; eye: [number, number, number] } {
  const azim = ORBIT.azim + yaw + Math.sin(time * 0.05) * 0.0045;
  const p = Math.min(Math.max(pitch, PITCH_LO), PITCH_HI);
  const elev = ORBIT.elev + p + Math.sin(time * 0.037) * 0.0035;
  const ce = Math.cos(elev);
  const se = Math.sin(elev);
  // a focus dolly scales the orbit radius (eye → summit) without touching the
  // azim/elev, so it's a pure lean-in that never re-frames or risks the pitch walls.
  const R = ORBIT.radius * radiusScale;
  const ex = TGT[0] + R * ce * Math.sin(azim);
  const ey = TGT[1] + R * se;
  const ez = TGT[2] + R * ce * Math.cos(azim);
  const view = lookAt(ex, ey, ez, TGT[0], TGT[1], TGT[2], 0, 1, 0);
  const vp = mul(persp(FOVY, aspect, NEAR, FAR), view);
  // off-axis LENS SHIFT: add `shiftX` to clip-x (cx += shiftX·cw), i.e. NDC_x += shiftX
  // at every depth — slides the whole image horizontally with NO rotation or
  // perspective distortion. Used while a slice is focused to pan the massif into the
  // clear right of the dossier (positive = image moves right). pickBand + the survey
  // projection consume this same vp, so the labels stay welded through the slide.
  if (shiftX !== 0) {
    vp[0] += shiftX * vp[3];
    vp[4] += shiftX * vp[7];
    vp[8] += shiftX * vp[11];
    vp[12] += shiftX * vp[15];
  }
  // the VERTICAL twin: add `shiftY` to clip-y (NDC_y += shiftY at every depth) — the
  // same pure image translation, used while focused to lift the selected ring up to a
  // comfortable framing height (positive = image moves UP). Same vp, so projection +
  // pick stay welded.
  if (shiftY !== 0) {
    vp[1] += shiftY * vp[3];
    vp[5] += shiftY * vp[7];
    vp[9] += shiftY * vp[11];
    vp[13] += shiftY * vp[15];
  }
  return { vp, eye: [ex, ey, ez] };
}

/** Project a world point through `vp` to CSS-pixel screen coords. `visible` is
 *  false only when the point is behind the camera (no terrain-occlusion test). */
export function projectToScreen(
  vp: Float32Array,
  x: number,
  y: number,
  z: number,
  W: number,
  H: number,
): { x: number; y: number; visible: boolean } {
  const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
  const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
  const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
  if (cw <= 1e-6) return { x: 0, y: 0, visible: false };
  return { x: ((cx / cw) * 0.5 + 0.5) * W, y: (1 - ((cy / cw) * 0.5 + 0.5)) * H, visible: true };
}

/* ---- pointer → career SLICE (terrain pick) ---------------------------------
   A JS twin of the WGSL height field (RIDGE_FIELD_WGSL), kept in lock-step with
   the shader, so the stage can cast the camera ray through the pointer, intersect
   the very mountain it renders, and read the world (x,z) — hence the plan RADIUS,
   hence which surveyed ring band the pointer is resting on. This is what lets a
   hover anywhere on a slice's whole face light it, not just a disc by the anchor. */
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const fract1 = (x: number) => x - Math.floor(x);
const smoothstep01 = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
function hash2(x: number, y: number): number {
  let p3x = fract1(x * 0.1031), p3y = fract1(y * 0.1031), p3z = fract1(x * 0.1031);
  const d = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33);
  p3x += d; p3y += d; p3z += d;
  return fract1((p3x + p3y) * p3z);
}
function vnoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return lerp(
    lerp(hash2(ix, iy), hash2(ix + 1, iy), ux),
    lerp(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), ux),
    uy,
  );
}
function fbm2(x: number, y: number): number {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < 5; i++) { s += a * vnoise(x * f, y * f); f *= 2; a *= 0.5; }
  return s;
}
function ridged(x: number, y: number): number {
  let s = 0, a = 0.5, f = 1, prev = 1;
  for (let i = 0; i < 6; i++) {
    let n = vnoise(x * f, y * f);
    n = 1 - Math.abs(2 * n - 1);
    n = n * n;
    s += a * n * prev; prev = n; f *= 2; a *= 0.5;
  }
  return s;
}
const ZN = 500; // near edge (mirrors the shader)
function heightAtJS(x: number, z: number): number {
  const dx = x - 0; // PEAK_X = 0
  const dz = z - PEAK_Z;
  const rad = Math.sqrt(dx * dx * 1.05 + dz * dz * 0.58) / 3300;
  const sharp = Math.max(0, 1 - rad * 1.3);
  const coneB = Math.exp(-rad * rad * 0.95);
  let h = PEAK_H * (0.34 * coneB + 1.0 * sharp);
  const gate = smoothstep01(0.05, 0.46, coneB);
  const spur = ridged(x * 0.00072 + 13.0, z * 0.0006 + 7.0);
  h += (spur - 0.35) * 1450 * gate;
  const gully = ridged(x * 0.003 + 41.0, z * 0.00118 + 9.0);
  h += gully * 520 * gate;
  const gully2 = ridged(x * 0.0068 + 5.0, z * 0.0025 + 23.0);
  h += gully2 * 195 * gate;
  const plain = fbm2(x * 0.00042 + 21.0, z * 0.00052 + 21.0);
  const plain2 = fbm2(x * 0.00022 + 81.0, z * 0.00026 + 81.0);
  h += plain * 220 + plain2 * 300;
  const s1 = Math.exp(-(((x + 5400) * (x + 5400) + (z - 6000) * (z - 6000) * 0.7)) / 6.0e6);
  const s2 = Math.exp(-(((x - 6000) * (x - 6000) + (z - 12200) * (z - 12200) * 0.7)) / 7.0e6);
  h += s1 * 600 + s2 * 520;
  const near = 1 - smoothstep01(ZN, 6000, z);
  h += Math.sin(x * 0.0012 + z * 0.00094) * 38 * near;
  h += fbm2(x * 0.0015 + 5.0, z * 0.00175 + 5.0) * 50 * near;
  return h;
}

/** Cast the camera ray through pointer pixel (px,py) and return the index of the
 *  career SLICE (0 = tight summit ring … 6 = wide dune ring) the ray's terrain hit
 *  falls on — matching RINGS in the shader and STATIONS in RidgelineStage — or -1
 *  when the ray misses the mountain or lands past the widest surveyed ring. */
export function pickBand(
  yaw: number,
  pitch: number,
  aspect: number,
  time: number,
  px: number,
  py: number,
  W: number,
  H: number,
  radiusScale = 1,
): number {
  // the exact rendered eye (mirror ridgeCamera, breathing + focus dolly included)
  const azim = ORBIT.azim + yaw + Math.sin(time * 0.05) * 0.0045;
  const p = Math.min(Math.max(pitch, PITCH_LO), PITCH_HI);
  const elev = ORBIT.elev + p + Math.sin(time * 0.037) * 0.0035;
  const ce = Math.cos(elev), se = Math.sin(elev);
  const R = ORBIT.radius * radiusScale;
  const ex = TGT[0] + R * ce * Math.sin(azim);
  const ey = TGT[1] + R * se;
  const ez = TGT[2] + R * ce * Math.cos(azim);

  // camera basis aimed at the summit pivot
  let fx = TGT[0] - ex, fy = TGT[1] - ey, fz = TGT[2] - ez;
  const fl = 1 / Math.hypot(fx, fy, fz); fx *= fl; fy *= fl; fz *= fl;
  // right = normalize(cross(forward, worldUp(0,1,0))) = normalize(-fz, 0, fx)
  let rx = -fz, rz = fx;
  const rl = 1 / Math.hypot(rx, rz); rx *= rl; rz *= rl;
  // camUp = cross(right, forward)
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;

  const ndcX = (px / W) * 2 - 1;
  const ndcY = 1 - (py / H) * 2;
  const tanY = Math.tan(FOVY / 2);
  const tanX = tanY * aspect;
  let dx = fx + rx * (ndcX * tanX) + ux * (ndcY * tanY);
  let dy = fy + uy * (ndcY * tanY);
  let dz = fz + rz * (ndcX * tanX) + uz * (ndcY * tanY);
  const dl = 1 / Math.hypot(dx, dy, dz); dx *= dl; dy *= dl; dz *= dl;

  // march the ray until it drops below the terrain, then bisect to the surface
  const STEP = 140, TMAX = 44000;
  let tPrev = NEAR;
  let dPrev = (ey + dy * tPrev) - heightAtJS(ex + dx * tPrev, ez + dz * tPrev);
  let hit = -1;
  for (let t = NEAR + STEP; t <= TMAX; t += STEP) {
    const diff = (ey + dy * t) - heightAtJS(ex + dx * t, ez + dz * t);
    if (dPrev > 0 && diff <= 0) {
      let lo = tPrev, hi = t;
      for (let it = 0; it < 14; it++) {
        const tm = (lo + hi) * 0.5;
        if ((ey + dy * tm) - heightAtJS(ex + dx * tm, ez + dz * tm) > 0) lo = tm;
        else hi = tm;
      }
      hit = (lo + hi) * 0.5;
      break;
    }
    dPrev = diff; tPrev = t;
  }
  if (hit < 0) return -1;

  // plan radius at the hit (mirrors the shader's baseR + warp), then nearest ring
  const hx = ex + dx * hit, hz = ez + dz * hit;
  const dxp = hx, dzp = hz - PEAK_Z;
  const baseR = Math.sqrt(dxp * dxp * 1.05 + dzp * dzp * 0.58);
  const warp =
    (fbm2(hx * 0.00026 + 47.0, hz * 0.00023 + 47.0) - 0.5) * 980 +
    (fbm2(hx * 0.0009 + 12.0, hz * 0.00078 + 12.0) - 0.5) * 210;
  const rw = baseR + warp;

  const RINGS = [720, 1300, 1980, 2750, 3600, 4550, 5600]; // newest → oldest (STATIONS order)
  if (rw > RINGS[6] + 700) return -1; // past the widest ring → foreground dunes, no slice
  let best = -1, bestD = Infinity;
  for (let k = 0; k < 7; k++) {
    const d = Math.abs(rw - RINGS[k]);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

export class RidgelineScene {
  private g: GPUCtx;
  private canvas: HTMLCanvasElement;
  private context!: GPUCanvasContext;

  private uBuf: GPUBuffer;
  private uArr = new Float32Array(64); // 256-byte uniform block

  private samp: GPUSampler;

  private scene!: GPUTexture;
  private depth!: GPUTexture;
  private sceneView!: GPUTextureView;
  private depthView!: GPUTextureView;

  private bloomA!: GPUTexture;
  private bloomB!: GPUTexture;
  private bloomAV!: GPUTextureView;
  private bloomBV!: GPUTextureView;
  private brightU: GPUBuffer;
  private blurHU: GPUBuffer;
  private blurVU: GPUBuffer;

  private frameBGL!: GPUBindGroupLayout;
  private postBGL!: GPUBindGroupLayout;
  private frameBG!: GPUBindGroup;

  private backdropPipe!: GPURenderPipeline;
  private terrainPipe!: GPURenderPipeline;
  private brightPipe!: GPURenderPipeline;
  private blurPipe!: GPURenderPipeline;
  private compositePipe!: GPURenderPipeline;

  private bgBright!: GPUBindGroup;
  private bgBloomH!: GPUBindGroup;
  private bgBloomV!: GPUBindGroup;
  private compositeBG!: GPUBindGroup;

  private gridVBO: GPUBuffer;
  private gridIBO: GPUBuffer;
  private indexCount = 0;

  private rw = 1;
  private rh = 1;
  private sc = 1;

  private constructor(g: GPUCtx, canvas: HTMLCanvasElement) {
    this.g = g;
    this.canvas = canvas;
    const d = g.device;

    this.uBuf = d.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const passBuf = () =>
      d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.brightU = passBuf();
    this.blurHU = passBuf();
    this.blurVU = passBuf();

    this.samp = d.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // ---- static terrain grid (uv + indices), built once ----
    const verts = new Float32Array((NX + 1) * (NZ + 1) * 2);
    let p = 0;
    for (let j = 0; j <= NZ; j++)
      for (let i = 0; i <= NX; i++) {
        verts[p++] = i / NX;
        verts[p++] = j / NZ;
      }
    const idx = new Uint32Array(NX * NZ * 6);
    let q = 0;
    const stride = NX + 1;
    for (let j = 0; j < NZ; j++)
      for (let i = 0; i < NX; i++) {
        const tl = j * stride + i, tr = tl + 1, bl = tl + stride, br = bl + 1;
        idx[q++] = tl; idx[q++] = bl; idx[q++] = tr;
        idx[q++] = tr; idx[q++] = bl; idx[q++] = br;
      }
    this.indexCount = idx.length;
    this.gridVBO = d.createBuffer({
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    d.queue.writeBuffer(this.gridVBO, 0, verts);
    this.gridIBO = d.createBuffer({
      size: idx.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    d.queue.writeBuffer(this.gridIBO, 0, idx);
  }

  static async create(canvas: HTMLCanvasElement): Promise<RidgelineScene | null> {
    const g = await createGPU();
    if (!g) return null;
    try {
      const scene = new RidgelineScene(g, canvas);
      await scene.init();
      return scene;
    } catch (e) {
      console.error("[ridgeline] scene init failed — falling back:", e);
      return null;
    }
  }

  /** Claim the canvas context (separate from create() so a discarded scene under
   *  StrictMode/HMR never reconfigures the canvas onto a dead device). */
  attach(): boolean {
    const ctx = configureCanvas(this.g.device, this.canvas, this.g.format);
    if (!ctx) return false;
    this.context = ctx;
    return true;
  }

  private async init(): Promise<void> {
    const d = this.g.device;
    d.addEventListener("uncapturederror", (ev) => {
      console.error("[ridgeline] uncaptured:", (ev as GPUUncapturedErrorEvent).error.message);
    });

    const [backdrop, terrain, composite, bright, blur] = await Promise.all([
      compileModule(d, "ridge-backdrop", RIDGE_BACKDROP_WGSL),
      compileModule(d, "ridge-terrain", RIDGE_TERRAIN_WGSL),
      compileModule(d, "ridge-composite", RIDGE_COMPOSITE_WGSL),
      compileModule(d, "bright", BRIGHT_WGSL),
      compileModule(d, "blur", BLUR_WGSL),
    ]);

    // explicit {F} layout shared by backdrop + terrain
    this.frameBGL = d.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });
    const framePL = d.createPipelineLayout({ bindGroupLayouts: [this.frameBGL] });

    // {PassU, sampler, tex} for bright/blur
    this.postBGL = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const postPL = d.createPipelineLayout({ bindGroupLayouts: [this.postBGL] });

    [this.backdropPipe, this.terrainPipe] = await Promise.all([
      d.createRenderPipelineAsync({
        layout: framePL,
        vertex: { module: backdrop, entryPoint: "vs" },
        fragment: { module: backdrop, entryPoint: "fs", targets: [{ format: HDR }] },
        primitive: { topology: "triangle-list" },
        // never write depth; the terrain (cleared depth 1.0) always draws over it
        depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "always" },
      }),
      d.createRenderPipelineAsync({
        layout: framePL,
        vertex: {
          module: terrain,
          entryPoint: "vs",
          buffers: [
            { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
          ],
        },
        // OPAQUE (no blend): the solid black fill writes depth so nearer ridges
        // occlude farther lines — the hidden-line removal that builds the mountain
        fragment: { module: terrain, entryPoint: "fs", targets: [{ format: HDR }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
      }),
    ]);

    [this.brightPipe, this.blurPipe] = await Promise.all([
      d.createRenderPipelineAsync({
        layout: postPL,
        vertex: { module: bright, entryPoint: "vs" },
        fragment: { module: bright, entryPoint: "fs", targets: [{ format: HDR }] },
        primitive: { topology: "triangle-list" },
      }),
      d.createRenderPipelineAsync({
        layout: postPL,
        vertex: { module: blur, entryPoint: "vs" },
        fragment: { module: blur, entryPoint: "fs", targets: [{ format: HDR }] },
        primitive: { topology: "triangle-list" },
      }),
    ]);

    this.compositePipe = await d.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: composite, entryPoint: "vs" },
      fragment: { module: composite, entryPoint: "fs", targets: [{ format: this.g.format }] },
      primitive: { topology: "triangle-list" },
    });

    this.frameBG = d.createBindGroup({
      layout: this.frameBGL,
      entries: [{ binding: 0, resource: { buffer: this.uBuf } }],
    });
  }

  resize(W: number, H: number, dpr: number): void {
    const d = this.g.device;
    this.canvas.width = Math.max(1, Math.round(W * dpr));
    this.canvas.height = Math.max(1, Math.round(H * dpr));
    // supersample the HDR scene so the composite box-downsample yields clean,
    // un-aliased hairlines and ridge silhouettes
    this.sc = Math.min(dpr * 1.4, 2);
    const fit = (d.limits.maxTextureDimension2D - 16) / Math.max(W, H, 1);
    this.sc = Math.max(1, Math.min(this.sc, fit));
    this.rw = Math.max(1, Math.round(W * this.sc));
    this.rh = Math.max(1, Math.round(H * this.sc));

    this.scene?.destroy();
    this.depth?.destroy();
    this.bloomA?.destroy();
    this.bloomB?.destroy();

    this.scene = makeTarget(d, this.rw, this.rh, HDR);
    this.depth = d.createTexture({
      size: { width: this.rw, height: this.rh },
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.sceneView = this.scene.createView();
    this.depthView = this.depth.createView();

    const hw = Math.max(1, this.rw >> 1);
    const hh = Math.max(1, this.rh >> 1);
    this.bloomA = makeTarget(d, hw, hh, HDR);
    this.bloomB = makeTarget(d, hw, hh, HDR);
    this.bloomAV = this.bloomA.createView();
    this.bloomBV = this.bloomB.createView();

    const tx = 1 / hw;
    const ty = 1 / hh;
    const SPREAD = 2.2;
    // bloom threshold near the snow-white level so only the genuinely bright
    // summit strokes + the halo's defined circle pick up a soft glow
    const BLOOM_THRESH = 0.82;
    d.queue.writeBuffer(this.brightU, 0, new Float32Array([tx, ty, 0, 0, BLOOM_THRESH, 0, 0, 0]));
    d.queue.writeBuffer(this.blurHU, 0, new Float32Array([tx, ty, 1, 0, SPREAD, 0, 0, 0]));
    d.queue.writeBuffer(this.blurVU, 0, new Float32Array([tx, ty, 0, 1, SPREAD, 0, 0, 0]));

    const post = (passU: GPUBuffer, view: GPUTextureView): GPUBindGroup =>
      d.createBindGroup({
        layout: this.postBGL,
        entries: [
          { binding: 0, resource: { buffer: passU } },
          { binding: 1, resource: this.samp },
          { binding: 2, resource: view },
        ],
      });
    this.bgBright = post(this.brightU, this.sceneView);
    this.bgBloomH = post(this.blurHU, this.bloomAV);
    this.bgBloomV = post(this.blurVU, this.bloomBV);

    this.compositeBG = d.createBindGroup({
      layout: this.compositePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uBuf } },
        { binding: 1, resource: this.samp },
        { binding: 2, resource: this.sceneView },
        { binding: 3, resource: this.bloomAV },
      ],
    });
  }

  private writeUniforms(s: RidgeFrame): void {
    const aspect = this.rw / this.rh;
    // orbit about the summit, derived through ridgeCamera() so the survey overlay
    // in RidgelineStage projects its anchors from the exact same eye — the labels
    // stay welded to the mountain as it spins. (Breathing lives inside the helper:
    // a whisper of sub-degree drift so an untouched mountain still feels alive.)
    const { vp, eye } = ridgeCamera(
      s.yaw, s.pitch, aspect, s.time, s.radiusScale ?? 1, s.focusShift ?? 0, s.focusShiftY ?? 0,
    );
    const [ex, ey, ez] = eye;

    const u = this.uArr;
    u.set(vp, 0);
    u[16] = s.time; u[17] = this.rw; u[18] = this.rh; u[19] = aspect;
    u[20] = NEAR; u[21] = FAR; u[22] = WORLD_H_MAX; u[23] = s.time * 0.012; // haloSpin
    u[24] = 0.34; u[25] = 0.34; u[26] = 0.03; u[27] = 1.0; // bloomAmt, vignette, grain, exposure
    u[28] = ex; u[29] = ey; u[30] = ez; u[31] = 0;
    // hov = (hoverBand, hoverGlow, focusBand, focusAmt): x/y light a hovered slice,
    // z/w recede every OTHER band so the focused (clicked) slice reads as the hero.
    u[32] = s.hoverBand ?? -1; u[33] = s.hoverGlow ?? 0;
    u[34] = s.focusBand ?? -1; u[35] = s.focusAmt ?? 0;
    this.g.device.queue.writeBuffer(this.uBuf, 0, u.buffer, 0, 256);
  }

  render(s: RidgeFrame): void {
    const d = this.g.device;
    this.writeUniforms(s);
    const enc = d.createCommandEncoder();

    // ---- HDR scene: backdrop halo, then the solid contour mesh ----
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: this.sceneView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" },
      ],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setBindGroup(0, this.frameBG);
    pass.setPipeline(this.backdropPipe);
    pass.draw(3);
    pass.setPipeline(this.terrainPipe);
    pass.setVertexBuffer(0, this.gridVBO);
    pass.setIndexBuffer(this.gridIBO, "uint32");
    pass.drawIndexed(this.indexCount);
    pass.end();

    // ---- bloom: bright-pass then one separable blur iteration (→ bloomA) ----
    this.blit(enc, this.brightPipe, this.bgBright, this.bloomAV);
    this.blit(enc, this.blurPipe, this.bgBloomH, this.bloomBV);
    this.blit(enc, this.blurPipe, this.bgBloomV, this.bloomAV);

    // ---- composite → swap-chain ----
    const cpass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    cpass.setPipeline(this.compositePipe);
    cpass.setBindGroup(0, this.compositeBG);
    cpass.draw(3);
    cpass.end();

    d.queue.submit([enc.finish()]);
  }

  private blit(
    enc: GPUCommandEncoder,
    pipe: GPURenderPipeline,
    bg: GPUBindGroup,
    out: GPUTextureView,
  ): void {
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: out, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" },
      ],
    });
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
  }

  dispose(): void {
    this.scene?.destroy();
    this.depth?.destroy();
    this.bloomA?.destroy();
    this.bloomB?.destroy();
    this.uBuf.destroy();
    this.brightU.destroy();
    this.blurHU.destroy();
    this.blurVU.destroy();
    this.gridVBO.destroy();
    this.gridIBO.destroy();
    this.g.device.destroy();
  }
}
