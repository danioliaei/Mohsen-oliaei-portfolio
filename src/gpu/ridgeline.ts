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
  RIDGE_FILAMENT_WGSL,
  RIDGE_COMPOSITE_WGSL,
  BRIGHT_WGSL,
  BLUR_WGSL,
} from "./ridgelineShaders";
import type { SceneInfo } from "../perf/types";

const HDR: GPUTextureFormat = "rgba16float";

/* ---- INTRO GLOBE: the "ball of lines & letters" the terrain mesh is wrapped onto at
   morph = 0 and unravels from as morph → 1. The centre/radius MUST mirror the GLOBE_C /
   GLOBE_R consts in ridgelineShaders.ts (the GPU sphere) so the DOM letter-cloud, projected
   through the same camera here, sits exactly on the rendered ball. ---------------------- */
export const GLOBE = { cx: 0, cy: 2120, cz: 8200, r: 3600 } as const;
export const GLOBE_SPIN_RATE = 0.16; // rad/s — the planet's slow idle rotation (0 on reduced-motion)
export const MORPH_DUR = 2.35;       // s — globe → mountain assembly, hand-authored constant duration (snapped on reduced-motion)

/* ---- letter-cloud content, drawn from the real career record (data/stations.ts): the record is
   DECOMPOSED into individual CHARACTERS scattered THROUGH the globe volume at many radii (see
   CLOUD_CHARS below) — the "ball of letters" mixed in among the filament lines, rather than whole
   words pasted on the shell. (The old whole-word role·company labels were removed so the globe
   reads purely as a tangle of lines + loose letters.) Deterministic order (a seeded PRNG, never the
   built-in randomness) so the layout is stable across re-measures / StrictMode remounts. ------ */

/** Even unit directions on a sphere (Fibonacci lattice). `phase` spins the whole set so separate
 *  lattices (the filament nodes, the letter cloud, the spokes) interleave rather than overlap.
 *  Returns a flat xyz array. */
function fibSphere(n: number, phase: number): Float32Array {
  const out = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i + 0.5) * (2 / n);
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i + phase;
    out[i * 3] = Math.cos(th) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(th) * r;
  }
  return out;
}

/* ---- DECOMPOSED character cloud: short, curated signatures from the record (companies, cities,
   tools/standards, years), broken into individual CHARACTERS and scattered through the globe's
   VOLUME at many radii so glyphs float in among the filaments at every depth. Each token also
   carries the career station (ring) its characters rain toward as the mountain forms. Curated
   short so the per-frame DOM-write budget stays modest (~128 individual character spans). ------- */
const CLOUD_CHAR_TOKENS: ReadonlyArray<{ text: string; ring: number }> = [
  { text: "STEGRA", ring: 0 }, { text: "STOCKHOLM", ring: 0 }, { text: "2025", ring: 0 },
  { text: "ISO19650", ring: 2 },
  { text: "NEOBUILT", ring: 1 }, { text: "GOTHENBURG", ring: 1 }, { text: "DYNAMO", ring: 1 },
  { text: "PYTHON", ring: 1 }, { text: "C#", ring: 1 },
  { text: "NORTHVOLT", ring: 2 }, { text: "NAVISWORKS", ring: 2 }, { text: "BIM", ring: 2 },
  { text: "RHINO", ring: 3 }, { text: "GIS", ring: 3 },
  { text: "REVIT", ring: 4 }, { text: "WHITE", ring: 4 }, { text: "IFC", ring: 4 },
  { text: "CHALMERS", ring: 5 },
  { text: "TEHRAN", ring: 6 }, { text: "ARCHICAD", ring: 6 }, { text: "2014", ring: 6 },
];

/** Build the decomposed character cloud once: the flat list of single-character strings (for the
 *  DOM spans), their even Fibonacci base directions, a per-char RADIAL depth (0.30..1.02 of the
 *  globe radius, biased outward) so glyphs sit at every depth in the volume, and the ring each
 *  char rains toward. Deterministic (seeded, no Math.random) → identical across StrictMode remounts. */
function buildCharCloud(): {
  chars: string[];
  dirs: Float32Array;
  radii: Float32Array;
  rings: Int16Array;
} {
  const chars: string[] = [];
  const ringList: number[] = [];
  for (const tok of CLOUD_CHAR_TOKENS) {
    for (const ch of tok.text) { chars.push(ch); ringList.push(tok.ring); }
  }
  const n = chars.length;
  const dirs = fibSphere(n, 2.7);
  // a tiny deterministic PRNG for the radial depths (mirrors the filament-geometry style)
  let st = 0x9e3779b9 >>> 0;
  const rnd = (): number => {
    st = (st + 0x6d2b79f5) >>> 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const radii = new Float32Array(n);
  for (let i = 0; i < n; i++) radii[i] = 0.3 + 0.72 * Math.pow(rnd(), 0.65); // 0.30..1.02, biased out
  return { chars, dirs, radii, rings: Int16Array.from(ringList) };
}

export const CHAR_CLOUD = buildCharCloud();
/** The flat list of single characters the DOM renders as `.cloud-char` spans (index-aligned with
 *  CHAR_CLOUD.dirs / radii / rings). */
export const CLOUD_CHARS: string[] = CHAR_CLOUD.chars;

/* ---- INTRO FILAMENT BALL geometry --------------------------------------------
   The transparent tangle the intro globe is "full of": flowing line-threads that
   wrap a spinning sphere plus a few bright sparks at each convergence NODE, built
   ONCE as additive 3-D line-list vertices (drawn by RIDGE_FILAMENT_WGSL — front &
   back overlap into a true see-through ball). Each thread starts at a Fibonacci
   node and walks a curl-bent path across the sphere, so the web reads as turbulent
   silk rather than tidy great circles. Fully deterministic (a seeded PRNG, never
   Math.random) so the tangle is identical across StrictMode remounts / reloads —
   like the letter lattice. Vertex = (x,y,z material dir, t, seed, brightness,
   radial shell) → 7 floats; stride 28 B, matching the pipeline's attributes. ---- */
export const FILAMENT_FLOATS_PER_VERT = 7;
const FIL_NODES = 48;       // bright convergence points (Fibonacci lattice)
const FIL_PER_NODE = 12;    // threads spun out from each node (was 16 → an even calmer, less overdrawn tangle; the dominant segment count, so this is the main complexity lever)
const FIL_STEPS = 28;       // points sampled per thread
const FIL_STEP_ANG = 0.082; // radians advanced per step → a long sweeping arc (~2.2 rad)
const FIL_SPARKS = 4;       // short bright segments crossing each surface node (was 5; slightly calmer node stars to match the lighter tangle)
// nested radial shells the curl threads inhabit (a thread is assigned one by f % FIL_SHELLS.length)
// so the ball reads as a deep, LAYERED VOLUME of filaments — five shells from the deep interior
// (0.34) out to the crust (1.0), the layered "well" the eye can fall into.
const FIL_SHELLS = [0.34, 0.52, 0.7, 0.86, 1.0] as const;
const CORE_TRAIL_FRAC = 0.46; // fraction of curl threads that DIVE inward to the core near their tip
const SPOKE_COUNT = 48;       // radial sight-lines from the nucleus out to the rim (the armature) (was 64 → fewer spokes for a simpler cage)
const SPOKE_DASHES = 8;       // dash segments per spoke (read as travelling measurement ticks)
const NUCLEUS_SPARKS = 64;    // short crossing sparks forming the glowing core AT the centre (was 96 → a simpler, less busy core to match the dimmer "glooming" centre)
// ---- THE DEEP ORRERY additions: interior dust filling the void between shells, counter-precessing
// great-circle gimbal rings, and a slow halo orbiting the nucleus — all riding the EXISTING sentinel
// classes so the morph (drain/lift/fade) is untouched and the morph=1 mountain stays byte-identical.
const MOTE_COUNT = 1600;      // interior dust specks filling the void BETWEEN the shells (class [0,1)) — was 2400; thinner dust reads calmer while still texturing all depths
const RING_COUNT = 7;         // great-circle gimbal rings that counter-precess (armature, class [1,2)) — was 10; fewer interlocking rings = a cleaner orrery cage
const RING_SEGS = 132;        // segments per gimbal ring (smooth at globe scale)
const HALO_SEGS = 96;         // segments per nucleus orbital-halo ring (class [2,3))
// the line CLASS is encoded as a sentinel range in the `seed` float (at.y), read in the VS via
// step()/fract(): curl threads + surface sparks + interior MOTES use seed ∈ [0,1) (organic, flows),
// radial spokes + great-circle RINGS use [1,2) (rigid armature — a ring is flagged by fract ≥ 0.90),
// the nucleus + its orbital HALO use [2,3) (the core that lifts to the summit — the halo flagged by
// radial ≥ 0.12). The FRACTIONAL part stays the per-line phase seed the flow/twinkle math has used.

type V3 = [number, number, number];
const v3norm = (x: number, y: number, z: number): V3 => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};
/** Rodrigues rotation of v about UNIT axis k by angle a. */
function v3rot(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  const dt = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  const cx = k[1] * v[2] - k[2] * v[1];
  const cy = k[2] * v[0] - k[0] * v[2];
  const cz = k[0] * v[1] - k[1] * v[0];
  const om = 1 - c;
  return [
    v[0] * c + cx * s + k[0] * dt * om,
    v[1] * c + cy * s + k[1] * dt * om,
    v[2] * c + cz * s + k[2] * dt * om,
  ];
}

/** Build the filament line-list. Returns the flat vertex buffer. */
export function buildFilamentGeometry(phone = false): Float32Array<ArrayBuffer> {
  // on phones, spin fewer threads per node and fewer interior motes (a lighter tangle,
  // less additive overdraw) — the rest of the armature (nodes, spokes, rings) is untouched
  const perNode = phone ? PHONE_FIL_PER_NODE : FIL_PER_NODE;
  const moteCount = phone ? PHONE_MOTE_COUNT : MOTE_COUNT;
  // mulberry32 — a tiny deterministic PRNG (stable layout, no Math.random)
  let st = 0x1a2b3c4d >>> 0;
  const rnd = (): number => {
    st = (st + 0x6d2b79f5) >>> 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rsym = (): number => rnd() * 2 - 1;

  const nodes = fibSphere(FIL_NODES, 0.0); // flat xyz unit dirs
  // smooth 3-vector noise sampled from a direction (re-uses the JS fbm twin)
  const noiseVec = (d: V3, seed: number): V3 => [
    fbm2(d[0] * 2.3 + seed * 7 + 11, d[1] * 2.3 + 4) - 0.5,
    fbm2(d[1] * 2.3 + 23, d[2] * 2.3 + seed * 3 + 9) - 0.5,
    fbm2(d[2] * 2.3 + 31, d[0] * 2.3 + seed * 5 + 17) - 0.5,
  ];
  // extra glow where a thread point grazes ANY node → threads light up as they weave through
  const nearNodeGlow = (d: V3): number => {
    let g = 0;
    for (let n = 0; n < FIL_NODES; n++) {
      const dd = d[0] * nodes[n * 3] + d[1] * nodes[n * 3 + 1] + d[2] * nodes[n * 3 + 2];
      if (dd > 0.985) g = Math.max(g, (dd - 0.985) / 0.015);
    }
    return g;
  };

  const out: number[] = [];
  const push = (d: V3, t: number, seed: number, bright: number, radial: number): void => {
    out.push(d[0], d[1], d[2], t, seed, bright, radial);
  };

  // ---- CLASS A — curl-bent streamlines fanning out from every node, now layered across three
  // nested shells, and with ~40% of them DIVING inward to the core near their tip (CORE-TRAILS) so
  // the organic tangle physically converges on the centre rather than floating as a hollow crust.
  for (let n = 0; n < FIL_NODES; n++) {
    const base: V3 = [nodes[n * 3], nodes[n * 3 + 1], nodes[n * 3 + 2]];
    for (let f = 0; f < perNode; f++) {
      const seed = rnd();
      const baseShell = FIL_SHELLS[f % FIL_SHELLS.length]; // which depth this thread rides
      const shellR = baseShell + 0.05 * baseShell * rnd(); // jitter ∝ depth → crisp inner shells
      const dive = seed < CORE_TRAIL_FRAC; // a core-trail: plunges toward radial 0.12 over its last steps
      // start at the node with a small jitter so the threads don't perfectly overlap
      let d = v3norm(base[0] + rsym() * 0.045, base[1] + rsym() * 0.045, base[2] + rsym() * 0.045);
      let axis = v3norm(rsym(), rsym(), rsym()); // the thread's dominant swirl axis
      let prev: V3 | null = null;
      let prevB = 0, prevT = 0, prevR = shellR;
      for (let i = 0; i < FIL_STEPS; i++) {
        const t = i / (FIL_STEPS - 1);
        // radial DEPTH: ride the shell, but core-trails ramp the last ~10 steps down to the core so
        // the line spirals inward (direction d still walks the sphere; only the depth collapses)
        const radial = dive
          ? shellR + (0.12 - shellR) * smoothstep01(0, 1, (i - (FIL_STEPS - 10)) / 9)
          : shellR;
        // bright at the node, tapering to a faint wisp; lit again where it grazes another node
        const taper = 0.16 + 0.84 * Math.pow(1 - t, 1.15);
        const bright = (0.34 + 0.4 * seed) * taper + nearNodeGlow(d) * 0.58;
        if (prev) { push(prev, prevT, seed, prevB, prevR); push(d, t, seed, bright, radial); }
        prev = d; prevB = bright; prevT = t; prevR = radial;
        // bend the swirl axis by smooth noise so the path meanders like a real filament
        const nb = noiseVec(d, seed);
        const la = v3norm(axis[0] + nb[0] * 1.3, axis[1] + nb[1] * 1.3, axis[2] + nb[2] * 1.3);
        axis = la;
        d = v3rot(d, la, FIL_STEP_ANG);
      }
    }
  }

  // ---- node sparks: a few short bright crossing segments at each surface node so the convergence
  // point reads as a hot, blooming star (sits on the outer shell with the letters) ----
  for (let n = 0; n < FIL_NODES; n++) {
    const base: V3 = [nodes[n * 3], nodes[n * 3 + 1], nodes[n * 3 + 2]];
    for (let b = 0; b < FIL_SPARKS; b++) {
      const r: V3 = [rsym(), rsym(), rsym()];
      const dp = r[0] * base[0] + r[1] * base[1] + r[2] * base[2];
      const tang = v3norm(r[0] - base[0] * dp, r[1] - base[1] * dp, r[2] - base[2] * dp);
      const e1 = v3norm(base[0] + tang[0] * 0.028, base[1] + tang[1] * 0.028, base[2] + tang[2] * 0.028);
      const e2 = v3norm(base[0] - tang[0] * 0.028, base[1] - tang[1] * 0.028, base[2] - tang[2] * 0.028);
      push(e1, 0, 0.5, 2.2, 1.0);
      push(e2, 1, 0.5, 2.2, 1.0);
    }
  }

  // ---- INTERIOR MOTE DUST: fine suspended specks filling the void BETWEEN the shells, at every
  // interior radius, so the well has texture at ALL depths (not just on the crust). Each is a tiny
  // crossing segment; organic class [0,1) → drains + radial-fades exactly like the silk. The inward
  // bias (pow > 1) packs the deep interior densest → the "fall into the well" feeling. ----
  for (let m = 0; m < moteCount; m++) {
    const dir = v3norm(rsym(), rsym(), rsym());
    const rad = 0.1 + 0.82 * Math.pow(rnd(), 1.35); // 0.10..0.92, biased toward the core
    const seed = rnd();                             // class [0,1), fract = per-mote phase
    const len = 0.012 + 0.016 * rnd();              // half-length of the speck (material units)
    // a tangent crossing axis (Gram–Schmidt against dir) so the speck reads as a tiny crossing
    const ax: V3 = [rsym(), rsym(), rsym()];
    const dp = ax[0] * dir[0] + ax[1] * dir[1] + ax[2] * dir[2];
    const tang = v3norm(ax[0] - dir[0] * dp, ax[1] - dir[1] * dp, ax[2] - dir[2] * dp);
    const e1 = v3norm(dir[0] + tang[0] * len, dir[1] + tang[1] * len, dir[2] + tang[2] * len);
    const e2 = v3norm(dir[0] - tang[0] * len, dir[1] - tang[1] * len, dir[2] - tang[2] * len);
    const b = 0.3 + 0.45 * rnd();                   // faint dust; scintillates in the VS
    push(e1, 0, seed, b, rad);
    push(e2, 1, seed, b, rad);
  }

  // ---- CLASS B — RADIAL SIGHT-LINE SPOKES: a rigid armature of dashed rays from the nucleus
  // (radial 0.06) out to the rim (radial 1.0), brightest at the inner end so light reads as
  // emanating FROM the centre. Their own Fibonacci set (not the node dirs) so they form a distinct
  // cage. seed sentinel ∈ [1,2) marks the class; t runs 0→1 inner→outer to steer the flow outward. */
  const spokeDirs = fibSphere(SPOKE_COUNT, 2.1);
  for (let s = 0; s < SPOKE_COUNT; s++) {
    const dir: V3 = [spokeDirs[s * 3], spokeDirs[s * 3 + 1], spokeDirs[s * 3 + 2]];
    const sentinel = 1.0 + rnd() * 0.9; // class = spoke; fract ∈ [0,0.90) (the ring flag is ≥ 0.90)
    for (let i = 0; i < SPOKE_DASHES; i++) {
      const u0 = i / SPOKE_DASHES;
      const u1 = (i + 0.7) / SPOKE_DASHES; // 70% dash, 30% gap → a measurement-tick rhythm
      const rA = 0.06 + 0.94 * u0;
      const rB = 0.06 + 0.94 * u1;
      push(dir, u0, sentinel, 1.7 + (0.42 - 1.7) * u0, rA);
      push(dir, u1, sentinel, 1.7 + (0.42 - 1.7) * u1, rB);
    }
  }

  // ---- GREAT-CIRCLE GIMBAL RINGS: thin bright circles, each tilted on its own Fibonacci axis
  // (golden angles → they interlock, never co-planar), that COUNTER-PRECESS on their own axis in the
  // VS (no moved geometry — it's a rotation keyed off the ring's seed). Armature class [1,2) → drains
  // with the spokes; fract(seed) ∈ [0.90,1.0) flags "ring"; t = angle 0..1 around the circle (drives
  // the dash scroll). They sit on the crust (radial ≈ 0.97..1.02) so they read as a precise orrery. ----
  const ringAxes = fibSphere(RING_COUNT, 0.6); // distinct phase from spokeDirs(2.1) → cage & orbits don't align
  for (let r = 0; r < RING_COUNT; r++) {
    const nrm = v3norm(ringAxes[r * 3], ringAxes[r * 3 + 1], ringAxes[r * 3 + 2]);
    // orthonormal in-plane basis (u, v) spanning the great-circle plane (robust ref avoids degeneracy)
    const ref: V3 = Math.abs(nrm[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
    const dp = ref[0] * nrm[0] + ref[1] * nrm[1] + ref[2] * nrm[2];
    const u = v3norm(ref[0] - nrm[0] * dp, ref[1] - nrm[1] * dp, ref[2] - nrm[2] * dp);
    const v: V3 = [ // v = nrm × u (already unit)
      nrm[1] * u[2] - nrm[2] * u[1],
      nrm[2] * u[0] - nrm[0] * u[2],
      nrm[0] * u[1] - nrm[1] * u[0],
    ];
    const ringR = 0.97 + 0.05 * rnd();              // 0.97..1.02 — a crisp band of orbits on the crust
    const sentinel = 1.0 + (0.9 + 0.0999 * rnd());  // class = arm, fract ∈ [0.90,1.0) → "ring"
    let prev: V3 | null = null, prevT = 0;
    for (let s = 0; s <= RING_SEGS; s++) {
      const a = (s / RING_SEGS) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const d = v3norm(u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa);
      const t = s / RING_SEGS;                      // 0..1 around the ring → drives the dash scroll
      // a faint base ring with periodic brighter "graduation" marks (a calibrated scale cue)
      const grad = 0.32 + 0.26 * Math.pow(0.5 + 0.5 * Math.cos(t * Math.PI * 2 * 16), 6);
      if (prev) { push(prev, prevT, sentinel, grad, ringR); push(d, t, sentinel, grad, ringR); }
      prev = d; prevT = t;
    }
  }

  // ---- CLASS C — NUCLEUS: short crossing sparks INSIDE radial 0.02..0.10 whose midline passes
  // through the exact globe centre (= F_GLOBE_C = the morph-sphere centre = the summit axis), at a
  // brightness that crosses the 0.82 bloom threshold so the additive heap blooms into a luminous
  // core with no extra pass. seed sentinel ∈ [2,3) marks the class (the VS lifts these to the summit). */
  for (let b = 0; b < NUCLEUS_SPARKS; b++) {
    const dir = v3norm(rsym(), rsym(), rsym());
    const rad = 0.02 + 0.08 * rnd();
    const sentinel = 2.0 + rnd() * 0.999;
    push([-dir[0], -dir[1], -dir[2]], 0, sentinel, 3.0, rad); // one side of the crossing…
    push(dir, 1, sentinel, 3.0, rad);                          // …to the other, through the centre
  }

  // ---- NUCLEUS ORBITAL HALO: a bright slow ring just outside the core (radial ~0.16) — gives the
  // luminous heart visible scale + a spin cue read against the still spokes. Nucleus class [2,3) →
  // lifts to the summit AND fades with the core (never outlives 0.70). Two slightly tilted rings,
  // riding radial ≈ 0.155..0.18 so the VS flags them distinct from the < 0.10 core sparks. ----
  for (let ring = 0; ring < 2; ring++) {
    const axis = v3norm(0.3 + 0.5 * ring, 1.0, 0.2 - 0.4 * ring); // deterministic, distinct tilt per ring
    const ref: V3 = Math.abs(axis[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
    const dp = ref[0] * axis[0] + ref[1] * axis[1] + ref[2] * axis[2];
    const u = v3norm(ref[0] - axis[0] * dp, ref[1] - axis[1] * dp, ref[2] - axis[2] * dp);
    const v: V3 = [
      axis[1] * u[2] - axis[2] * u[1],
      axis[2] * u[0] - axis[0] * u[2],
      axis[0] * u[1] - axis[1] * u[0],
    ];
    const haloR = 0.155 + 0.025 * ring;             // 0.155 / 0.180 — distinct from the <0.10 core sparks
    const sentinel = 2.0 + rnd() * 0.999;           // nucleus class; fract = phase
    let prev: V3 | null = null, prevT = 0;
    for (let s = 0; s <= HALO_SEGS; s++) {
      const a = (s / HALO_SEGS) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      const d = v3norm(u[0] * c + v[0] * sn, u[1] * c + v[1] * sn, u[2] * c + v[2] * sn);
      const t = s / HALO_SEGS;
      if (prev) { push(prev, prevT, sentinel, 1.9, haloR); push(d, t, sentinel, 1.9, haloR); }
      prev = d; prevT = t;
    }
  }

  return new Float32Array(out);
}

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

/* ---- PHONE RENDER PROFILE (tunable) -------------------------------------------------
   Small / touch viewports trade GEOMETRY for SHARPER lines: a lighter terrain mesh +
   thinner globe + wider contour spacing free the GPU budget so the phone can render at a
   higher DPR (set in RidgelineStage.resize + scCap below) without the thermal throttle the
   on-device telemetry caught (see TELEMETRY.md). Detected ONCE at scene construction (a
   phone stays a phone); desktop keeps the full-fat path. Dial these to taste. */
const phoneRender = (): boolean =>
  typeof matchMedia === "function" &&
  (matchMedia("(pointer: coarse)").matches || matchMedia("(max-width: 860px)").matches);
const PHONE_NX = 520, PHONE_NZ = 290;  // terrain mesh LOD (vs 760×420 → ~150k tris, ~76% fewer — TBDR vertex/binning win; contour LINES are shader-drawn so density is unchanged)
const PHONE_FIL_PER_NODE = 10;         // globe curl-threads per node (vs desktop 12 → an even lighter phone tangle, less additive overdraw + smaller init VBO)
const PHONE_MOTE_COUNT = 1100;         // globe interior dust motes (vs desktop 1600 → lighter phone dust, smaller init VBO)
const PHONE_LINE_SCALE = 1.25;         // contour spacing ×: 1 = desktop, 1.25 ≈ 20% fewer lines on the mountain (F.lod.x)
const PHONE_SC_CAP = 2.75;             // HDR scene supersample cap (raised from 2.5 → crisper, more-supersampled hairlines on phone; paid for by the lighter globe/mountain geometry above)

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
  /** Sphere→terrain MORPH 0..1: 0 = the intro "globe of lines & letters", 1 = the
   *  finished mountain. Defaults to 1 everywhere, so any caller that omits it renders
   *  today's mountain byte-identically. */
  morph?: number;
  /** Globe SPIN in radians about Y during the intro (the planet's slow rotation); the
   *  DOM letter-cloud co-rotates with the exact same value. Ignored once morph hits 1. */
  globeSpin?: number;
  /** Motion gate 0..1 for the intro filament flow: 1 = the threads shimmer/stream, 0 =
   *  the web holds still (set to 0 on prefers-reduced-motion). Defaults to 1. */
  motion?: number;
  /** Projects-timeline CALM 0..1 (mph.w): 0 = the chaotic globe; 1 = the filament threads
   *  settle toward near-stillness as the Projects timeline opens (the globe becomes a moon).
   *  INERT unless the globe is showing — the shader gates it by (morph→0) and the filament
   *  pass is skipped at morph>=0.72, so it can never alter the finished mountain. Defaults to 0. */
  projAmt?: number;
  /** Depth-of-field FOCAL POINT in composite UV (0..1, y down): the crisp centre the
   *  Projects DoF keeps in focus while the rest of the frame edges soften. Defaults to
   *  (0.5, 0.5) — frame centre — so at projAmt 0 the dead DoF branch is byte-identical;
   *  while the moon transits, this tracks it so it never blurs. (Packed into lod.y/lod.z.) */
  focalX?: number;
  focalY?: number;
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

/* ---- INTRO GLOBE camera fit -------------------------------------------------
   The mc = 0 end of the morph dolly: a camera radius-scale (× ORBIT.radius) that sizes the
   intro ball so its silhouette nearly reaches the screen SIDES on every aspect, with a
   tasteful cap on how far it may spill past the top/bottom of a WIDE frame (a round ball
   can't reach a wide screen's left/right edges without also exceeding its height). The stage
   eases globeRadius from this → 1.0 by mc ≈ 0.70, so the finished-mountain framing is
   byte-identical regardless of what this returns. The DOM letter-cloud + survey project
   through the SAME ridgeCamera, so the fit stays consistent for free. */
const GLOBE_FILL_W = 0.95;  // silhouette reaches this fraction of the half-WIDTH where it fits (phones / near-square) — raised from 0.9 so the phone globe grows to a tiny margin from the side borders
const GLOBE_BLEED_V = 0.9;  // …but never past this fraction of the half-HEIGHT — LOWERED from 1.24 (which bled off the top/bottom of wide 4k screens) to 0.9 so the whole globe FITS on desktop with a comfortable margin for the header nav + footer/framing scrims (the camera aims a touch above centre, so the silhouette sits slightly low — 0.9 keeps the bottom rim clear of the footer)
export function globeFitRadiusScale(aspect: number): number {
  const vHalf = FOVY / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * Math.max(aspect, 0.2));
  // silhouette half-angle: as wide as the side-fill wants, but clamped by the vertical-bleed cap
  const theta = Math.min(GLOBE_FILL_W * hHalf, GLOBE_BLEED_V * vHalf);
  // asin(R / D) = theta ⇒ D = R / sin(theta); the radius-scale is D / ORBIT.radius (D ≈ ORBIT.radius·gs
  // to < 0.1% — verified by projecting the rim). Clamped so the eye never nears the ball on ultra-wide
  // nor pulls absurdly far on ultra-tall.
  const gs = GLOBE.r / Math.sin(theta) / ORBIT.radius;
  return Math.min(3.6, Math.max(0.85, gs));
}

/** Absolute elevation clamp (rad): the floor keeps the eye above the dune plain
 *  when tilting up under the peak; the ceiling stops shy of a top-down survey so
 *  the silhouette never flattens out. The stage maps these to pitch-offset walls. */
const ELEV_RANGE: readonly [number, number] = [-0.12, 1.0];

/** The ELEV_RANGE clamp expressed as pitch-OFFSET walls (since pitch is added to
 *  ORBIT.elev). Exported so the stage's inertia stops dead at the same walls. */
export const PITCH_LO = ELEV_RANGE[0] - ORBIT.elev;
export const PITCH_HI = ELEV_RANGE[1] - ORBIT.elev;

/** GLOBE pitch walls — a far WIDER absolute-elevation range than the mountain's, so the Home
 *  ball can be looked over the top / under the bottom (the mountain's range is deliberately
 *  tight). Kept clear of the lookAt gimbal singularity at elev = ±π/2. The stage interpolates
 *  between these and PITCH_LO/PITCH_HI by the morph clock, so the walls tighten to the authored
 *  mountain limits exactly at mEase = 1. */
const GLOBE_ELEV_RANGE: readonly [number, number] = [-1.25, 1.4];
export const GLOBE_PITCH_LO = GLOBE_ELEV_RANGE[0] - ORBIT.elev; // ≈ -1.200
export const GLOBE_PITCH_HI = GLOBE_ELEV_RANGE[1] - ORBIT.elev; // ≈  1.450

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
  const p = pitch; // caller (stage) pre-clamps to the active globe/mountain pitch walls
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
  h += gully2 * 120 * gate; // MUST mirror RIDGE_FIELD_WGSL gully2 weight (heightAt) → pickBand parity
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
  const p = pitch; // stage pre-clamps to the active globe/mountain walls (mirror ridgeCamera)
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
  private filamentPipe!: GPURenderPipeline;
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

  private filaVBO: GPUBuffer;
  private filaVertexCount = 0;

  private rw = 1;
  private rh = 1;
  private sc = 1;
  private dprUsed = 1;
  // phone render profile (set once in the constructor from phoneRender()):
  private lineScale = 1; // contour-spacing scale fed to the shader as F.lod.x
  private scCap = 2;     // HDR scene supersample cap (raised on phones for sharper hairlines)

  // ---- perf telemetry counters (read by the ?perf=1 harness via info(); set
  // each render() — three integer writes, no cost when the harness isn't watching)
  private lastDraws = 0;
  private lastTris = 0;
  private lastLines = 0;

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

    // ---- phone render profile: a lighter mesh + thinner globe + wider contours, paid
    // back as a higher render DPR (sharper lines). Resolved once here at construction. ----
    const phone = phoneRender();
    this.lineScale = phone ? PHONE_LINE_SCALE : 1;
    this.scCap = phone ? PHONE_SC_CAP : 2.25; // desktop supersample cap (was 2 → +crispness; the lighter globe/mountain geometry frees the fill budget). Phone stays at PHONE_SC_CAP (fill/thermal-bound).
    const nx = phone ? PHONE_NX : NX;
    const nz = phone ? PHONE_NZ : NZ;

    // ---- static terrain grid (uv + indices), built once at the active LOD ----
    const verts = new Float32Array((nx + 1) * (nz + 1) * 2);
    let p = 0;
    for (let j = 0; j <= nz; j++)
      for (let i = 0; i <= nx; i++) {
        verts[p++] = i / nx;
        verts[p++] = j / nz;
      }
    const idx = new Uint32Array(nx * nz * 6);
    let q = 0;
    const stride = nx + 1;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
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

    // ---- intro filament-ball line geometry, built once (deterministic; lighter on phones) ----
    const fil = buildFilamentGeometry(phone);
    this.filaVertexCount = fil.length / FILAMENT_FLOATS_PER_VERT;
    this.filaVBO = d.createBuffer({
      size: fil.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    d.queue.writeBuffer(this.filaVBO, 0, fil);
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

    const [backdrop, terrain, filament, composite, bright, blur] = await Promise.all([
      compileModule(d, "ridge-backdrop", RIDGE_BACKDROP_WGSL),
      compileModule(d, "ridge-terrain", RIDGE_TERRAIN_WGSL),
      compileModule(d, "ridge-filament", RIDGE_FILAMENT_WGSL),
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

    // intro FILAMENT ball: additive 3-D lines over the (discarded-at-morph-0) sphere — a true
    // see-through tangle. Depth-TESTED against the terrain so the forming mountain occludes it,
    // but never depth-WRITING, so every thread (front AND back) accumulates as light, no z-fight.
    this.filamentPipe = await d.createRenderPipelineAsync({
      layout: framePL,
      vertex: {
        module: filament,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 28, // 7 floats: vec3 dir + vec4 (t, seed, brightness, radial)
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: {
        module: filament,
        entryPoint: "fs",
        targets: [
          {
            format: HDR,
            blend: {
              color: { srcFactor: "one", dstFactor: "one", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "line-list" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less-equal" },
    });

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
    this.dprUsed = dpr; // the effective (already-clamped) DPR — surfaced via info()
    this.canvas.width = Math.max(1, Math.round(W * dpr));
    this.canvas.height = Math.max(1, Math.round(H * dpr));
    // supersample the HDR scene so the composite box-downsample yields clean,
    // un-aliased hairlines and ridge silhouettes (scCap is raised on phones for extra crispness)
    this.sc = Math.min(dpr * 1.4, this.scCap);
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
    // mph = (morph, globeSpin, motion, projAmt). morph DEFAULTS to 1 (full mountain) so any path
    // that forgets the field renders the finished mountain, never a stuck globe. motion gates the
    // filament flow (0 on reduced-motion → the web holds still), defaulting to 1. projAmt calms the
    // filaments as the Projects dial opens (globe-only; defaults to 0 → today's chaotic ball).
    u[36] = s.morph ?? 1; u[37] = s.globeSpin ?? 0; u[38] = s.motion ?? 1; u[39] = s.projAmt ?? 0;
    // lod = (contourScale, focalX, focalY, _) — x widens the mountain's scan-line + fine-contour
    // spacing on phones (1.0 on desktop); y/z carry the Projects depth-of-field FOCAL POINT in
    // composite UV (default frame-centre 0.5,0.5 ⇒ the DoF dead branch stays byte-identical).
    u[40] = this.lineScale;
    u[41] = s.focalX ?? 0.5;
    u[42] = s.focalY ?? 0.5;
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
    // the intro filament ball — additive flowing threads over the sphere. Drawn only while the
    // globe is still showing (it has fully faded by morph 0.70); skipped on the finished mountain.
    const filamentDrew = (s.morph ?? 1) < 0.72;
    if (filamentDrew) {
      pass.setPipeline(this.filamentPipe);
      pass.setVertexBuffer(0, this.filaVBO);
      pass.draw(this.filaVertexCount);
    }
    pass.end();

    // perf counters: backdrop + terrain (+ optional filament) in the HDR pass, then
    // bright + blurH + blurV + composite full-screen passes = 6 draws (7 with filament).
    // Triangles = the terrain mesh (indexCount/3) + the five full-screen-triangle passes.
    this.lastDraws = 6 + (filamentDrew ? 1 : 0);
    this.lastTris = this.indexCount / 3 + 5;
    this.lastLines = filamentDrew ? (this.filaVertexCount / 2) | 0 : 0;

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

  /** Live render-path snapshot for the ?perf=1 telemetry harness (this app's
   *  `renderer.info`). Cheap field reads — only ever called when perf is on. */
  info(): SceneInfo {
    return {
      backend: "webgpu",
      hasF16: this.g.hasF16,
      hasTimestamp: this.g.hasTimestamp,
      drawCalls: this.lastDraws,
      triangles: this.lastTris,
      lines: this.lastLines,
      renderW: this.rw,
      renderH: this.rh,
      supersample: this.sc,
      canvasW: this.canvas.width,
      canvasH: this.canvas.height,
      dpr: this.dprUsed,
    };
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
    this.filaVBO.destroy();
    this.g.device.destroy();
  }
}
