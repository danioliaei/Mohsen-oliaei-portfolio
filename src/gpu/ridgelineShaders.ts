/* =========================================================================
   WGSL shaders for the RIDGELINE experiment — a stark monochrome reimagining
   of the homepage in the spirit of the reference still: a single dominant peak
   built from stacked horizontal contour lines (the "Unknown Pleasures" / floating
   -horizon look), white-on-black, with a large concentric dotted halo seated
   behind the summit and a sweeping dune foreground.

   Pipeline (own HDR target → light bloom → composite), kept deliberately small:
     1. BACKDROP — pure black + the dotted concentric halo (drawn first, no depth)
     2. TERRAIN  — a solid height-field mesh that writes depth (so nearer ridges
                   OCCLUDE farther ones — true hidden-line removal) and lights up
                   only along constant-DEPTH iso-lines → the horizontal profiles
     then BRIGHT → BLUR (a faint snow-glow) and COMPOSITE (box-AA + grade + grain).

   Everything is greyscale: black fill, grey rock/dune strokes, near-white snow on
   the summit — no colour and no warm grade, pure light on black.
   ========================================================================= */

/** Shared per-frame uniform block. Field order MUST match ridgeline.ts's writer. */
export const RIDGE_FRAME_WGSL = /* wgsl */ `
struct Frame {
  vp   : mat4x4<f32>,
  a    : vec4<f32>,   // x time, y Wpx(render), z Hpx(render), w aspect
  b    : vec4<f32>,   // x zNear, y zFar, z worldHeightMax, w haloSpin
  post : vec4<f32>,   // x bloomAmt, y vignette, z grain, w exposure
  eye  : vec4<f32>,   // xyz camera eye (world), w phone profile (0 desktop / 1 phone — filament centre/depth trims)
  hov  : vec4<f32>,   // x hovered slice index (-1 none), y pulse 0..1, zw unused
  mph  : vec4<f32>,   // x morph 0..1 (0 = intro globe, 1 = finished mountain), y globeSpin (rad), z motion, w projAmt (0 = globe chaos … 1 = dial-calm)
  lod  : vec4<f32>,   // x contour-spacing scale (1 = desktop; >1 on phones widens the spacing → fewer lines), y/z Projects DoF focal point (composite UV), w one-shot mountain reveal 0..1 (1 = fully realistic; default 1)
  drs  : vec4<f32>,   // x,y = DRS scene sub-rect (fraction of the max HDR target the live scene fills; (1,1) at full quality); z = THEME amount (0 dark ... 1 light, eased by the stage); w unused (0)
  ptr  : vec4<f32>,   // xy mouse NDC, z eased influence, w decaying pointer energy
  x2   : vec4<f32>,   // x,y = nutation tilt axis k = (x, 0, y) (unit, horizontal); z = tilt angle (rad, 0 = identity); w unused (0)
};
@group(0) @binding(0) var<uniform> F : Frame;

// ---- THE BEAT: one 4-second organic pulse shared by the nucleus body, the skin arcs and the ball's
// pressure wave. Gamma-shaped: onset at phase 0 (value 0), peak 1.0 at phase BEAT_PEAK, long decay.
// Mean over a period = BEAT_MEAN. Reduced motion (F.mph.z = 0) freezes beatMix() AT THE MEAN, so
// every term written as (beatMix() - BEAT_MEAN) sits at its average look and nothing dims.
// JS twins: src/gpu/globeMotion.ts (the tests guard the pairing).
const BEAT_PERIOD : f32 = 4.0;
const BEAT_PEAK   : f32 = 0.20;
const BEAT_MEAN   : f32 = 0.368;                     // measured: 0.3684 (judge_numbers.mjs)
fn beatPhase() -> f32 { return fract(F.a.x / BEAT_PERIOD); }                          // 0 = pulse ONSET
fn beatPulse(ph : f32) -> f32 { let x = ph / BEAT_PEAK; return x * x * exp(2.0 - 2.0 * x); }
fn beatMix() -> f32 { return mix(BEAT_MEAN, beatPulse(beatPhase()), F.mph.z); }       // 0..1, motion-gated

// ---- THE ONE KEY LAMP (world space) = the terrain FS literal normalize(-0.34, 0.66, -0.68) at the
// contour shader's shading block. The terrain keeps its own literal so morph = 1 stays byte-identical;
// retune BOTH together. At the rest camera world -x is screen RIGHT, so this lamp sits upper-right-front.
const KEY_L : vec3<f32> = vec3<f32>(-0.33771, 0.65556, -0.67542);

// ---- nucleus geometry shared by the backdrop body and the filament arcs ----
const NUC_C : vec3<f32> = vec3<f32>(0.0, 2120.0, 8200.0);   // = GLOBE_C / F_GLOBE_C / GLOBE in ridgeline.ts
const NUC_R : f32 = 270.0;                                   // body radius, world units (0.075 of the ball)
const APEX  : vec3<f32> = vec3<f32>(0.0, 5230.0, 8200.0);   // the summit seed the nucleus lifts to

// ---- MORPH windows (globe -> mountain), declared ONCE. Filament VS + backdrop read these. The
// filament pass is skipped by ridgeline.ts render() at morph >= 0.72 (== FIL_SKIP; guarded by a test).
const DRAIN_A : f32 = 0.10;  const DRAIN_B : f32 = 0.40;
const POUR_A  : f32 = 0.36;  const POUR_B  : f32 = 0.64;
const LIFT_A  : f32 = 0.40;  const LIFT_B  : f32 = 0.64;
const CORE_FADE_A : f32 = 0.55;  const CORE_FADE_B : f32 = 0.70;
const FIL_SKIP : f32 = 0.72;
const HALO_A : f32 = 0.70;   const HALO_B : f32 = 0.94;   // the sky rises the instant the heart's presence hits 0 (CORE_FADE_B): one light at a time, no dark apex
fn liftAmt(m : f32) -> f32 { return smoothstep(LIFT_A, LIFT_B, m); }

// ---- rigid rotations shared by sd and its tangent T (verbatim the old inline formulas) ----
fn rotY(v : vec3<f32>, c : f32, s : f32) -> vec3<f32> { return vec3<f32>(v.x * c + v.z * s, v.y, -v.x * s + v.z * c); }
fn rotX(v : vec3<f32>, c : f32, s : f32) -> vec3<f32> { return vec3<f32>(v.x, v.y * c - v.z * s, v.y * s + v.z * c); }
`;

/* ----------------------------------------------------- HEIGHT FIELD ------- */
/* A central massif rising to a sharp snowy spire, clad in ridged-multifractal
   rock striations (the woven vertical erosion gullies), set in a field of low
   rolling dunes so the horizon meets the sky as an irregular ridgeline rather
   than a flat cut. Pure procedural — sampled identically by the vertex shader. */
export const RIDGE_FIELD_WGSL = /* wgsl */ `
const XW    : f32 = 11000.0;   // half lateral extent of the plan (world units)
const ZN    : f32 = 500.0;     // near edge (just in front of the dunes)
const ZF    : f32 = 22000.0;   // far edge (beyond the summit)
const PEAK_X : f32 = 0.0;
const PEAK_Z : f32 = 8200.0;   // the summit sits centred, mid-distance
const PEAK_H : f32 = 3300.0;

fn hash2(p : vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn vnoise(p : vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash2(i + vec2<f32>(0.0, 0.0));
  let b = hash2(i + vec2<f32>(1.0, 0.0));
  let c = hash2(i + vec2<f32>(0.0, 1.0));
  let d = hash2(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn fbm(p : vec2<f32>) -> f32 {
  var s = 0.0; var a = 0.5; var f = 1.0;
  for (var i = 0; i < 5; i = i + 1) {
    s = s + a * vnoise(p * f);
    f = f * 2.0; a = a * 0.5;
  }
  return s;
}
// ridged multifractal — sharp crests stacked octave on octave → rocky gullies
fn ridged(p : vec2<f32>) -> f32 {
  var s = 0.0; var a = 0.5; var f = 1.0; var prev = 1.0;
  for (var i = 0; i < 6; i = i + 1) {
    var n = vnoise(p * f);
    n = 1.0 - abs(2.0 * n - 1.0);
    n = n * n;
    s = s + a * n * prev;
    prev = n;
    f = f * 2.0; a = a * 0.5;
  }
  return s;
}
// ---- CHEAP reduced-octave twins of fbm/ridged, for the terrain FS's COSMETIC surface weave only
// (the draped-contour domain-warp, the snow-line raggedness, the crevice darkening). The full
// fbm/ridged stay reserved for heightAt() — the actual geometry, which is mirrored in heightAtJS for
// pick parity and must NOT change. These run per-fragment on the 2× supersampled target, so halving
// their octave count is the dominant fill-cost saving; the slightly smoother result also reads as a
// calmer, less-busy weave (the "a bit less intense" the brief asks for). 3 octaves ≈ half the noise
// ALU of the 5-/6-octave originals, with no visible banding (only the finest crinkle is dropped).
fn fbm3(p : vec2<f32>) -> f32 {
  var s = 0.0; var a = 0.5; var f = 1.0;
  for (var i = 0; i < 3; i = i + 1) {
    s = s + a * vnoise(p * f);
    f = f * 2.0; a = a * 0.5;
  }
  return s;
}
fn ridged3(p : vec2<f32>) -> f32 {
  var s = 0.0; var a = 0.5; var f = 1.0; var prev = 1.0;
  for (var i = 0; i < 3; i = i + 1) {
    var n = vnoise(p * f);
    n = 1.0 - abs(2.0 * n - 1.0);
    n = n * n;
    s = s + a * n * prev;
    prev = n;
    f = f * 2.0; a = a * 0.5;
  }
  return s;
}
fn heightAt(x : f32, z : f32) -> f32 {
  let dx = x - PEAK_X;
  let dz = z - PEAK_Z;
  // anisotropic radius from the summit axis — a touch wider in depth so the
  // mountain has a planted base rather than reading as a spike
  let rad = sqrt(dx * dx * 1.05 + dz * dz * 0.58) / 3300.0;
  // --- elegant dominant form: a sharp straight-sided cone on a broad base ---
  let sharp  = max(0.0, 1.0 - rad * 1.30);         // straight-sided SHARP apex
  let coneB  = exp(-rad * rad * 0.95);             // broad base flare / shoulders
  var h = PEAK_H * (0.34 * coneB + 1.00 * sharp);
  // the rocky relief lives on the massif, fading to a calm plain outside it
  let gate = smoothstep(0.05, 0.46, coneB);

  // a few LARGE smooth spurs descending the peak → elegant flowing shoulders
  // (low frequency, so a handful of big ridges instead of chaotic small bumps)
  let spur = ridged(vec2<f32>(x * 0.00072, z * 0.00060) + vec2<f32>(13.0, 7.0));
  h = h + (spur - 0.35) * 1450.0 * gate;

  // VERTICAL erosion gullies — anisotropic (high frequency across x, lower along
  // z) so the horizontal contour lines weave as they cross them: the reference's
  // woven snow/rock texture, achieved without tall competing peaks
  let gully = ridged(vec2<f32>(x * 0.00300, z * 0.00118) + vec2<f32>(41.0, 9.0));
  h = h + gully * 520.0 * gate;
  let gully2 = ridged(vec2<f32>(x * 0.00680, z * 0.00250) + vec2<f32>(5.0, 23.0));
  h = h + gully2 * 120.0 * gate;                   // finer micro-texture (was 195 → calmer micro-relief; MIRRORED in ridgeline.ts heightAtJS for pickBand parity)

  // a smooth, low, flowing dune plain everywhere (calm flanks + foreground)
  let plain  = fbm(vec2<f32>(x * 0.00042, z * 0.00052) + 21.0);
  let plain2 = fbm(vec2<f32>(x * 0.00022, z * 0.00026) + 81.0);
  h = h + plain * 220.0 + plain2 * 300.0;

  // two very low, soft secondary rises for company beside the peak (no spikes)
  let s1 = exp(-((x + 5400.0) * (x + 5400.0) + (z - 6000.0) * (z - 6000.0) * 0.7) / 6.0e6);
  let s2 = exp(-((x - 6000.0) * (x - 6000.0) + (z - 12200.0) * (z - 12200.0) * 0.7) / 7.0e6);
  h = h + s1 * 600.0 + s2 * 520.0;

  // gentle fine ripples in the near sand → the dense flowing foreground weave
  let near = 1.0 - smoothstep(ZN, 6000.0, z);
  h = h + sin(x * 0.00120 + z * 0.00094) * 38.0 * near;
  h = h + fbm(vec2<f32>(x * 0.00150, z * 0.00175) + 5.0) * 50.0 * near;
  return h;
}
`;

/* ---------------------------------------------------------- BACKDROP ------ */
/* Pure black with (Home) the nucleus EMBER — the ball's heart, a ray-cast sphere that also
   writes its depth so the threads behind it are hidden — and (CV) the concentric dotted halo.
   Drawn first, full-screen, depthCompare "always": outside the body it either discards (Home)
   or writes the clear depth 1.0 (mountain), so the terrain mesh paints over its lower half as
   before, leaving the arcs visible only in the sky around the summit (the reference framing). */
export const RIDGE_BACKDROP_WGSL = RIDGE_FRAME_WGSL + /* wgsl */ `
struct VsOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vid : u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
  var o : VsOut;
  let xy = p[vid];
  o.pos = vec4<f32>(xy, 0.0, 1.0);
  o.uv = vec2<f32>(xy.x * 0.5 + 0.5, 1.0 - (xy.y * 0.5 + 0.5));  // uv.y = 0 at top
  return o;
}
const TWO_PI : f32 = 6.28318530718;
struct Nuc { lum : f32, depth : f32 };
// The nucleus is a self-luminous EMBER: a true sphere of radius NUC_R at the 3-D centre, ray-cast per
// fragment (perspective-exact, lens-shift-safe: the ray comes from the rows of F.vp, no inverse), limb-
// darkened (solar law), lit from within and faintly from the scene's one key lamp, with one crisp
// chromosphere rim. It writes DEPTH for fully-covered pixels so the lines behind it are hidden. Reuses
// the backdrop pass: no new mesh, textures or bloom pass; its projection follows the same camera and
// nucleus lift (liftAmt / APEX) as the filament skin arcs, and its pulse is the shared beat.
fn nucleus(uv : vec2<f32>) -> Nuc {
  var o : Nuc;
  o.lum = 0.0;
  o.depth = 1.0;                                    // = the clear value wherever the body is absent
  let morph = F.mph.x;
  let proj  = smoothstep(0.0, 0.65, F.mph.w);
  let presence = (1.0 - smoothstep(CORE_FADE_A, CORE_FADE_B, morph)) * (1.0 - proj);   // EXACTLY 0 at morph >= 0.70
  if (presence <= 0.0) { return o; }
  let lift = liftAmt(morph);
  let centre = mix(NUC_C, APEX, lift);
  let beat  = beatMix();
  let beatC = beat - BEAT_MEAN;                     // -0.368 .. +0.632; 0 when frozen
  let contract = max(0.045, (1.0 - 0.5 * lift) * (1.0 - proj));   // CONDENSES to half while it lifts (arrives at the apex a visible ~17 px seed, not a dot) and shrinks away with the Projects fold
  let R = NUC_R * contract;                         // no radius breathing: sub-pixel, and it ate the arc clearance
  // ---- cheap screen-space BOUND: the only work > 98 % of pixels do ----
  let cclip = F.vp * vec4<f32>(centre, 1.0);
  let cuv = vec2<f32>(cclip.x / cclip.w * 0.5 + 0.5, 0.5 - cclip.y / cclip.w * 0.5);
  let focal = length(vec3<f32>(F.vp[0].y, F.vp[1].y, F.vp[2].y));
  let dist = max(length(F.eye.xyz - centre), 300.0);
  let radiusUV = R * focal * 0.5 / dist;
  let q = (uv - cuv) * vec2<f32>(F.a.w, 1.0) / max(radiusUV, 1e-4);
  if (dot(q, q) > 6.5) { return o; }
  // ---- exact ray + sphere. PERPENDICULAR form: never subtract two ~1e9 squares in f32 ----
  let nx = uv.x * 2.0 - 1.0;
  let ny = 1.0 - uv.y * 2.0;
  let r0 = vec3<f32>(F.vp[0].x, F.vp[1].x, F.vp[2].x);
  let r1 = vec3<f32>(F.vp[0].y, F.vp[1].y, F.vp[2].y);
  let r3 = vec3<f32>(F.vp[0].w, F.vp[1].w, F.vp[2].w);
  let D = normalize(cross(r1 - ny * r3, r0 - nx * r3));
  let oc = F.eye.xyz - centre;
  let b = dot(oc, D);
  let perp = oc - b * D;
  let d2 = dot(perp, perp);
  let rho = sqrt(d2) / R;                           // 1 on the silhouette
  if (rho > 2.2) { return o; }
  let aaR = 1.0 / max(radiusUV * F.a.z, 1.0);       // one ACTIVE render pixel in rho units (DRS-aware)
  let inside = 1.0 - smoothstep(1.0 - aaR, 1.0 + aaR, rho);
  let phone = F.eye.w;
  var surf = 0.0;
  if (rho < 1.0 + aaR) {
    let t = -b - sqrt(max(R * R - d2, 0.0));
    let P = F.eye.xyz + D * t;
    let n = (P - centre) / R;
    let mu = max(-dot(n, D), 0.0);                  // 1 face-on .. 0 at the limb
    let limb = 1.0 - 0.62 * (1.0 - mu);             // solar limb darkening: centre 1, limb 0.38
    let ndl = clamp((dot(n, KEY_L) + 0.5) / 1.5, 0.0, 1.0);   // a translucent body lit from within that also catches the one key lamp
    let rw = max(0.035, 1.5 * aaR);
    let rr = (rho - 0.985) / rw;
    let rim = exp(-rr * rr);                        // the chromosphere: one crisp wire edge, >= 1.5 px
    let flash = smoothstep(0.0, 0.03, morph) * (1.0 - smoothstep(0.03, 0.14, morph));   // the tap's discharge leaving the body
    let ember = 0.62 * limb * (0.55 + 0.45 * ndl) * (1.0 + 0.16 * beatC + 0.35 * flash)
              + 0.30 * rim * (1.0 + 0.12 * beatC);
    // LIGHT theme: an ink sphere — a light wash on the shadow side + the drawn contour; the arcs hatch it. No beat.
    let ink = min((0.04 + 0.30 * (1.0 - ndl)) * (1.0 + 0.2 * (1.0 - mu)) + 0.55 * rim, 1.0);
    surf = mix(ember, ink, F.drs.z) * inside;
    // OCCLUDER: fully-covered pixels only (the AA fringe accumulates lines under its coverage), and
    // only until the drain starts pulling the threads through the body — the light keeps its radius,
    // the occluding disc shrinks to nothing by DRAIN_A + 0.16 so the funnel stacks additively as before.
    // ...and released with the Projects fold too (proj): the folded streak passes THROUGH the body, so an
    // occluder that outlived the light would notch it. Exactly 1 on the Home globe (proj = 0).
    let occl = (1.0 - smoothstep(DRAIN_A, DRAIN_A + 0.16, morph)) * (1.0 - proj);
    if (rho < occl) { let pc = F.vp * vec4<f32>(P, 1.0); o.depth = pc.z / pc.w; }
  }
  // ---- CORONA: isotropic exponential fall from the silhouette, breathing with the beat ----
  let dr = max(rho - 1.0, 0.0);
  let k = mix(2.9, 2.1, beat);
  let coronaA = mix(0.08 + 0.06 * beatC, 0.03, F.drs.z) * mix(1.0, 0.8, phone);
  let corona = coronaA * exp(-dr * k) * (1.0 - inside) * (1.0 - smoothstep(1.6, 2.2, rho));   // tapered to EXACTLY 0 at the rho 2.2 cut (else a beat-locked disc edge ~2/255 above black)
  o.lum = (surf + corona) * presence;
  return o;
}
struct BOut { @location(0) col : vec4<f32>, @builtin(frag_depth) depth : f32 };
@fragment fn fs(i : VsOut) -> BOut {
  let nuc = nucleus(i.uv);
  var o : BOut;
  o.depth = nuc.depth;
  if (F.mph.x <= HALO_A) {
    // Home (and the whole morph until the heart's presence is 0 at HALO_A == CORE_FADE_B): the halo branch
    // takes over exactly there, continuous (smoothstep(HALO_A, HALO_B, HALO_A) = 0): one light at a time.
    // Outside the body both attachments would receive their clear values — skip the store
    // (on IMR GPUs a fullscreen frag_depth write is a real ~35 MB/frame store). Uniform branch; the
    // per-fragment discard inside it is a demote, so the fwidth work in the halo block below stays
    // in uniform control flow. Home has no mountain halo: its trigonometry is skipped entirely.
    if (nuc.lum <= 0.0 && nuc.depth >= 1.0) { discard; }
    o.col = vec4<f32>(vec3<f32>(nuc.lum), 1.0);
    return o;
  }
  let asp = F.a.w;
  // centre the halo behind the summit, in the upper third; aspect-correct so the
  // rings stay circular regardless of viewport shape
  var p = i.uv - vec2<f32>(0.5, 0.36);
  p.x = p.x * asp;
  let r = length(p);
  let ang = atan2(p.y, p.x) + F.b.w;        // slow spin

  // concentric rings (constant-radius iso-lines), crisp ~1px regardless of scale
  let RING = 0.0190;
  let rings = r / RING;
  let rd = 0.5 - abs(fract(rings) - 0.5);
  let raa = max(fwidth(rings), 1e-4);
  let ring = 1.0 - smoothstep(0.0, raa * 1.15, rd);   // crisper halo rings (was 1.5); kept ≥1.1 so the spinning rings don't crawl

  // tangential dashes whose count scales with radius → near-constant arc length,
  // i.e. a field of small dots marching around each ring (the radar / vinyl look)
  let phase = ang * r * 130.0;
  let dotWave = 0.5 + 0.5 * cos(phase * TWO_PI);
  let dots = smoothstep(0.16, 0.60, dotWave);

  // radial envelope — a broad, bold halo band that fades in from the centre and
  // out to the rim, so the dotted texture glows as a large disc behind the peak
  let env = smoothstep(0.035, 0.14, r) * (1.0 - smoothstep(0.42, 0.66, r));

  // one crisp defined circle near the inner edge (the bright ring hugging the peak)
  let circ = (1.0 - smoothstep(0.0, raa * 1.7, abs(rings - 8.4))) * smoothstep(0.0, 0.02, r);   // crisper hero ring (was 2.2; kept a touch wider than the dotted rings as it crosses the bloom threshold)

  // dim the halo by the focus amount (hov.w) so the sky recedes with the slopes
  // when a slice is selected, keeping the lit ring the sole bright element
  var halo = (ring * dots * env * 0.66 + circ * 0.58 + env * dots * 0.07) * (1.0 - 0.62 * F.hov.w);
  // the dotted halo belongs to the MOUNTAIN (the CV view) only — it is absent on the
  // intro globe (the "Home" ball of lines & letters) and fades in as the massif forms,
  // so the spinning ball reads as a clean tangle in empty black. The sky rises AFTER the
  // core is gone (0.70) and the filament pass has ended (0.72), landing before the survey
  // (0.80-1.0) → a continuous crescendo, no halo pop; full halo by 0.94 < 1.0. In the light
  // theme it is a faint dotted PRINT on paper (x0.4) — exactly x1.0 at theme 0.
  halo = halo * smoothstep(HALO_A, HALO_B, F.mph.x) * mix(1.0, 0.4, F.drs.z);
  o.col = vec4<f32>(vec3<f32>(halo + nuc.lum), 1.0);
  return o;
}
`;

/* ----------------------------------------------------------- TERRAIN ------ */
/* The height-field as a SOLID mesh: it writes depth (opaque), so nearer ridges
   occlude farther ones — the floating-horizon hidden-line removal that makes the
   stacked profiles read as one solid mountain. The surface itself stays black;
   it lights up only along constant-DEPTH iso-lines (the horizontal scan-line
   profiles), brightening to near-white on the high snowy summit and along the
   grazing ridge silhouettes. */
export const RIDGE_TERRAIN_WGSL = RIDGE_FRAME_WGSL + RIDGE_FIELD_WGSL + /* wgsl */ `
// ---- INTRO GLOBE constants: a giant slowly-spun ball the mesh is wrapped onto at
// morph=0, that unravels into the terrain as morph→1. GLOBE_C MUST mirror the GLOBE
// const in ridgeline.ts (the DOM letter-cloud projects against the same sphere). ----
const TAU : f32 = 6.28318530718;
const HALF_PI : f32 = 1.57079632679;
const GLOBE_C : vec3<f32> = vec3<f32>(0.0, 2120.0, 8200.0); // = GLOBE.{cx,cy,cz} in ridgeline.ts
const GLOBE_R : f32 = 3600.0;                                // = GLOBE.r
const MORPH_SPREAD : f32 = 0.6;   // < 1 so EVERY vertex provably reaches vm = 1 at morph = 1

struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) wy  : f32,        // world height → snow / tone (follows the morph)
  @location(1) nrm : vec3<f32>,
  @location(2) wpos : vec3<f32>, // world position → terrain-locked scan-lines + shading
  @location(3) vm  : f32,        // interpolated per-vertex morph → drives the FS globe↔mountain gate
};
@vertex fn vs(@location(0) uv : vec2<f32>) -> VsOut {
  // ---- terrain end state (UNCHANGED from today) ----
  let x = -XW + 2.0 * XW * uv.x;
  let z = ZN + (ZF - ZN) * uv.y;
  let y = heightAt(x, z);
  let terrain = vec3<f32>(x, y, z);
  let e = 16.0;
  let hx = heightAt(x + e, z) - heightAt(x - e, z);
  let hz = heightAt(x, z + e) - heightAt(x, z - e);
  let terrainNrm = normalize(vec3<f32>(-hx / (2.0 * e), 1.0, -hz / (2.0 * e)));

  // ---- sphere end state: uv → lon/lat on a lumpy globe (lat clamped off the exact
  // poles to avoid a fully degenerate top/bottom row). lon carries the spin (F.mph.y). ----
  let lon = uv.x * TAU + F.mph.y;
  let lat = clamp((0.5 - uv.y) * 3.14159265359, -HALF_PI + 0.01, HALF_PI - 0.01);
  let cl = cos(lat); let sl = sin(lat);
  let sphereDir = vec3<f32>(cl * sin(lon), sl, cl * cos(lon));
  // the sphere skin leans WITH the filament ball (the same uniform tilt, applied last). Uniform branch:
  // identity, and byte-identical, whenever the stage sends +0 (every morph >= 0.30 frame, the mountain,
  // reduced motion) — so the emerging shell and the threads never disagree during 0.08..0.30.
  var sDir = sphereDir;
  if (F.x2.z != 0.0) {
    let nk = vec3<f32>(F.x2.x, 0.0, F.x2.y);
    let nc = cos(F.x2.z); let ns = sin(F.x2.z);
    sDir = sDir * nc + cross(nk, sDir) * ns + nk * (dot(nk, sDir) * (1.0 - nc));
  }
  // cheap single-tap lumpiness (NO fbm — this runs per vertex over a 760×420 grid) so the
  // ball reads as a rolled-up piece of terrain rather than a sterile billiard sphere
  let lump = 1.0 + 0.045 * (vnoise(vec2<f32>(uv.x * 40.0, uv.y * 22.0)) - 0.5);   // was 0.06: a calmer shell
  let sphere = GLOBE_C + GLOBE_R * lump * sDir;

  // ---- staggered morph, bottom-up: a vertex's final height keys WHEN it lands, so the
  // mountain assembles from its base to its summit. Compressed (not offset) so the upper
  // smoothstep edge key*SPREAD + (1-SPREAD) ≤ 1 for all key∈[0,1] → vm = 1 everywhere at
  // morph = 1, making the end state byte-identical to today's mountain. ----
  let key = clamp(y / PEAK_H, 0.0, 1.0);
  let lo  = key * MORPH_SPREAD;
  let vm  = smoothstep(lo, lo + (1.0 - MORPH_SPREAD), F.mph.x);

  let world = mix(sphere, terrain, vm);
  // antipodal-safe normal blend (a tiny +y bias means the sum is never exactly zero → no
  // normalize(0) NaN flashes on steep back faces mid-morph)
  let nb = mix(sDir, terrainNrm, vm) + vec3<f32>(0.0, 1e-4, 0.0);

  var o : VsOut;
  o.pos = F.vp * vec4<f32>(world, 1.0);
  o.wy = mix(GLOBE_C.y + GLOBE_R * sDir.y, y, vm); // height tone follows the morph (snow lands last)
  o.nrm = normalize(nb);
  o.wpos = world;
  o.vm = vm;
  return o;
}
@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
  let vmF = clamp(i.vm, 0.0, 1.0);

  // ===== INTRO GLOBE — no longer painted on this OPAQUE sphere (which could only ever show its
  // near hemisphere). The globe is now a separate additive FILAMENT pass (RIDGE_FILAMENT_WGSL):
  // a true see-through tangle of flowing threads + bright nodes, front and back overlapping. So
  // while the surface is still mostly un-formed we simply DISCARD it — writing no colour and,
  // crucially, no DEPTH — so it can't occlude the back of the filament ball; the tangle + the DOM
  // letters ARE the globe. The mountain then rises THROUGH the fading tangle as each vertex lands
  // (vm climbs bottom-up). At vmF → 1 nothing discards and finalC = c, so the finished mountain is
  // byte-identical to before. =====
  if (vmF < 0.035) { discard; }

  // ---- base hairlines: constant-DEPTH iso-lines (the stacked horizontal weave) -
  // UNCHANGED in direction — keyed to world Z, a FIXED plane in the terrain, so the
  // signature stacked profiles stay painted on the surface and glued to the same
  // ground as the camera orbits. These are the quiet texture the survey RINGS are
  // cut across (head-on they read as horizontal bands; from the flank, obliquely).
  let Z_STEP = 100.0 * F.lod.x;               // world units between scan-lines (was 88 → fewer, cleaner hairlines for a simpler mountain; ×F.lod.x — wider still on phone)
  let f = i.wpos.z / Z_STEP;
  let dist = 0.5 - abs(fract(f) - 0.5);       // 0 on a line, 0.5 between
  let aa = max(fwidth(f), 1e-5);
  var hair = 1.0 - smoothstep(0.0, aa * 0.68, dist);   // crisper hairlines (was 0.95 → sharper still, esp. on phone); the moire-dissolve below still guards far/steep faces
  // dissolve where the projected lines pack tighter than the pixel grid so far /
  // steep faces read as smooth tone instead of a buzzing moiré
  hair = hair * (1.0 - smoothstep(0.48, 1.10, aa));

  // ---- INDEX CONTOURS as concentric SURVEYED RINGS -------------------------
  // The career — no longer seven straight planar cuts but seven iso-RADIUS rings
  // wrapping the massif like a topographic survey: oldest is the wide ring sweeping
  // the near dunes (2014); newest is the tight ring hugging the summit (now). The
  // plan radius about the summit axis is domain-warped by low-frequency noise, so
  // each ring wanders like a real cut-line carved into the slope rather than a
  // compass-drawn circle — yet, being level-sets of one single field, the rings
  // bend and pinch but never cross. Keep RINGS in sync with STATIONS (RidgelineStage).
  // The slice plan-radius rw is needed ONLY to centre the hover wash / focus isolation below — both
  // gated on F.hov.* and INACTIVE at rest (no slice hovered or focused, the steady state). So its two
  // fbm taps (~10 octaves of noise per fragment, on the 2× supersampled target) are gated behind
  // ringActive: at rest every terrain fragment skips them and the output is byte-IDENTICAL (rw is
  // unused there). The branch is on UNIFORMS (F.hov.*), so it is uniform across the whole draw — no
  // per-fragment divergence, and the derivative-free fbm inside is safe in non-uniform-looking flow.
  let ringActive = (F.hov.x >= 0.0 && F.hov.y > 0.0001) || (F.hov.w > 0.0001 && F.hov.z >= 0.0);
  var rw = 0.0;
  if (ringActive) {
    let dxp = i.wpos.x - PEAK_X;
    let dzp = i.wpos.z - PEAK_Z;
    // the height field's own anisotropy (a touch wider in depth) so the rings are the
    // mountain's planted ellipses, not perfect circles laid on top
    let baseR = sqrt(dxp * dxp * 1.05 + dzp * dzp * 0.58);
    let warp = (fbm(vec2<f32>(i.wpos.x * 0.00026, i.wpos.z * 0.00023) + 47.0) - 0.5) * 980.0
             + (fbm(vec2<f32>(i.wpos.x * 0.00090, i.wpos.z * 0.00078) + 12.0) - 0.5) * 210.0;
    rw = baseR + warp;
  }
  // The slice plan-radius rw is kept only to centre the HOVER wash below; the
  // dividing ring contours (and their flanking moat) are no longer painted, so
  // the career borders are invisible at rest. A slice surfaces only as a soft glow
  // when the pointer rests anywhere on its band. Radii stay in sync with STATIONS
  // (RidgelineStage) for the hover lookup.
  var RINGS = array<f32, 7>(720.0, 1300.0, 1980.0, 2750.0, 3600.0, 4550.0, 5600.0);

  // ---- monochrome shading: form from a soft key light, snow from elevation --
  let n = normalize(i.nrm);
  let L = normalize(vec3<f32>(-0.34, 0.66, -0.68));
  let diff = clamp(dot(n, L), 0.0, 1.0);
  let lit = 0.42 + 0.58 * diff;
  let V = normalize(F.eye.xyz - i.wpos);
  let rim = pow(1.0 - clamp(abs(dot(n, V)), 0.0, 1.0), 2.3);   // bright ridge edges

  let hN = clamp(i.wy / F.b.z, 0.0, 1.0);
  let snow = smoothstep(0.36, 0.76, hN);
  // bright contour strokes: mid-grey on rock/dune, near-white on the snowy summit
  let rockBright = 0.42 + 0.22 * lit;
  let hairLum = mix(rockBright, 1.02, snow);
  var lum = hairLum * hair + rim * 0.50;         // hairline weave + ridge silhouettes

  // a luminous snowFIELD wash so the summit reads as a bright solid mass that the
  // fine darker striations sit on — the inverse of the dark-rock / bright-line
  // lower slopes, exactly as in the reference still (kept under full white so the
  // erosion texture still reads on the snow rather than blowing out)
  let snowFill = snow * snow * (0.24 + 0.46 * diff) * mix(1.0, 0.45, F.drs.z);   // light theme: the summit wash is a lighter tint of ink (x1.0 exactly at theme 0)
  var c = lum + snowFill;                          // the base surface (the CONTOUR MODEL)

  // ============================================================================
  //  HALF-REALISTIC REVEAL — an animated vertical seam sweeps across the massif,
  //  dissolving the white-on-black CONTOUR MODEL (left / not-yet-reached) into a
  //  lit, greyscale ROCK & SNOW render (right / in the wake): a "digital 3D model
  //  turning into a real mountain", kept on the same black sky. The seam is
  //  SCREEN-LOCKED so it reads as a true vertical line at every framing (drive the
  //  front from i.wpos.x instead of screenX01 to make it track the orbit instead).
  //  SCREEN X is i.pos.x (VsOut.pos IS @builtin(position) = framebuffer pixels) —
  //  do NOT add a @builtin(position) param, that duplicates the builtin and fails
  //  to compile. Designed + adversarially WGSL-reviewed via a fan-out workflow.
  // ----------------------------------------------------------------------------
  let screenX01 = i.pos.x / F.a.y;                 // 0 at the left edge -> 1 at the right edge of the (supersampled) target
  // the reveal seam is NOT keyed off focus (F.hov.w) — it runs the same behind a focused career
  // dossier, the "Your Assignment?" brief, or at rest. The seam position is driven purely by the
  // one-shot eased (F.lod.w) below + the per-vertex landing calm; the band / halo / slice dimming
  // further down still keys off F.hov.w, only the sweep is independent.
  // the realistic render is the FINISHING flourish: absent on the globe, ramped in over the last
  // of the morph (via calm), then swept fully in ONCE by the one-shot reveal — and held there.
  let calm = smoothstep(0.50, 1.0, vmF);         // realistic rock/snow grows WITH the emerging contour model, not bunched in the tail (endpoint pinned: =1 at vmF=1)
  // ONE-SHOT reveal (req 1): the seam used to ping-pong forever off a cos(time) phase, so the
  // finished mountain endlessly flickered between the white-on-black CONTOUR MODEL and the lit
  // rock/snow render — a "coming and going" pulse. It is now driven by F.lod.w, a monotonic 0->1
  // progress the stage advances EXACTLY ONCE after the massif lands and then HOLDS at 1. So the seam
  // sweeps across a single time and the mountain stays on the detailed realistic render thereafter.
  // (lod.w defaults to 1 ⇒ any path that omits it shows the finished, fully-revealed mountain.)
  let eased = clamp(F.lod.w, 0.0, 1.0);            // 0 = all contour model … 1 = fully realistic (held)
  // wavefront position: eased 0 -> seam off the RIGHT (all contour model); eased 1 ->
  // seam off the LEFT (all realistic). The seam recedes right->left and the render
  // fills in behind it. Over-scan past both edges (-0.10..1.10) so the seam fully clears.
  let travel = mix(1.10, -0.10, eased);
  let front = mix(1.10, travel, calm);             // calm=0 (an un-formed vertex) parks it at 1.10 = all contour model
  let band = mix(0.012, 0.090, calm);              // transition half-width; wider while free so the moving seam is soft
  // real = 0 LEFT of the seam (contour model — "left stays the model"), 1 to the RIGHT
  // in its wake (the shaded render); smooth across the band.
  let real = smoothstep(front - band, front + band, screenX01);
  // materialization BEAM: a SLIM crisp core + a faint soft halo, given its OWN narrow width
  // (independent of the wider model<->real blend band) so the light edge stays thin and
  // graphic rather than a broad wash. Both killed when focused.
  let beamDist = abs(screenX01 - front);
  let beamCore = 1.0 - smoothstep(0.0, 0.0075, beamDist);   // crisp slim core (~6px half-width @ 820)
  let beamHalo = 1.0 - smoothstep(0.0, 0.048, beamDist);    // faint, soft halo around the core
  let seamLive = beamCore * calm;
  let haloLive = beamHalo * calm;

  // ---- REALISTIC ROCK & SNOW SURFACE (greyscale scalar cReal) ----------------
  // All heavy noise gated behind (real > 0.001) so pure-contour fragments pay only
  // the cheap sweep math above. Reuses n, L, diff, V, rim, hN already computed.
  // === DENSE FINE TOPOGRAPHIC WEAVE — the crisp detail the soft shaded version lacked.
  //     Constant-elevation contours DRAPED on the 3D form (so they wrap the peak like a
  //     survey map, not flat screen bands), heavily domain-warped by the erosion field so
  //     they weave like the reference, at FINE spacing for dense detail. Crisp via fwidth,
  //     dissolved where they project tighter than a pixel (anti-moire). Computed in UNIFORM
  //     control flow (fwidth requires it) and only USED on the realistic side below. ===
  // cheap reduced-octave warp (fbm3/ridged3): half the noise ALU of the full fbm/ridged, and the
  // ridged amplitude eased 85 → 72 so the contours weave a touch calmer (the "less intense" lines).
  let lnWarp = (fbm3(vec2<f32>(i.wpos.x * 0.00095, i.wpos.z * 0.00115) + 5.0) - 0.5) * 150.0
             + (ridged3(vec2<f32>(i.wpos.x * 0.0040, i.wpos.z * 0.0030) + 9.0) - 0.40) * 72.0;
  let LINE_SP = 32.0 * F.lod.x;                    // world units between fine contour lines (was 24 → calmer, fewer draped contours; ×F.lod.x — fewer still on phone)
  let cv = (i.wy + lnWarp) / LINE_SP;
  let aaw = max(fwidth(cv), 1e-5);
  var lines = (1.0 - smoothstep(0.0, aaw * 0.85, 0.5 - abs(fract(cv) - 0.5)))   // crisp thin AA lines (was 1.05; rendered into the supersampled HDR target)
            * (1.0 - smoothstep(0.55, 1.30, aaw));                              // dissolve where too tight (anti-moire)
  let cv2 = cv * 2.0;                              // a finer harmonic (half spacing) so it reads dense up close
  let aaw2 = aaw * 2.0;                            // = fwidth(cv2); no second derivative call
  var fine = (1.0 - smoothstep(0.0, aaw2 * 0.9, 0.5 - abs(fract(cv2) - 0.5)))   // crisper finer harmonic (was 1.1)
           * (1.0 - smoothstep(0.55, 1.30, aaw2));

  var cReal = 0.0;
  if (real > 0.001) {
    let ndl = clamp(dot(n, L), 0.0, 1.0);          // key light
    let slopeUp = clamp(n.y, 0.0, 1.0);            // 1 on flat/up-faces -> 0 on vertical cliffs
    // --- ragged snow line: high elevation AND shallow up-slope ---
    let snowNoise = fbm3(vec2<f32>(i.wpos.x * 0.0016, i.wpos.z * 0.0014) + 31.0);
    let snowMask = clamp(smoothstep(0.34, 0.60, hN + (snowNoise - 0.5) * 0.14)
                       * smoothstep(0.26, 0.66, slopeUp), 0.0, 1.0);
    // --- HIGH-CONTRAST tonal relief base: near-black rock, brighter snow, shaped by the
    //     key, with deep crevice darkening so gullies pool to black (no soft clay) ---
    let crev = clamp(ridged3(vec2<f32>(i.wpos.x * 0.0044, i.wpos.z * 0.0017) + 19.0), 0.0, 1.0);
    let rockTone = 0.03 + 0.15 * ndl;              // dark rock; lit faces lift just a touch
    let snowTone = 0.20 + 0.52 * ndl;              // snow much brighter under the key
    let base = mix(rockTone, snowTone, snowMask) * (0.40 + 0.60 * smoothstep(0.08, 0.55, crev));
    // line luminance: bright, lifted by the key + snow so the weave itself models the relief
    // (brighter where lit, sinking into shadow) — kept mostly under the 0.82 bloom threshold
    // so the lines stay CRISP; only summit snow lines glow a little.
    let lineLum = mix(0.40 + 0.42 * ndl, 0.98, snowMask);
    var surf = base + lines * lineLum + fine * lineLum * 0.12;   // dark tonal relief + bright fine weave (fine weight 0.35 → 0.18 → 0.12: calmer micro-detail after the reveal, the "less detailed" the brief asks for)
    surf = surf + rim * (0.10 + 0.26 * snowMask);  // grazing ridge light against the black sky
    let depthF = smoothstep(ZN, ZF * 0.9, i.wpos.z);
    let lowF = 1.0 - smoothstep(0.05, 0.30, hN);
    let recess = clamp(depthF * (0.45 + 0.35 * lowF) * (1.0 - snowMask * 0.5), 0.0, 0.75);
    cReal = surf * (1.0 - recess);                 // bright lines may graze >1 -> a touch of bloom
    // ===== LIGHT theme: emit ink DENSITY. Snow = paper; rock = ink shaped by the key light (lit faces
    // near paper, tone in the shadows); gullies pool ink; the weave is DRAWN as ink lines; the silhouette
    // is outlined; distance pales. Reuses ndl / snowMask / crev / lines / fine / rim / recess. Uniform branch. =====
    if (F.drs.z > 0.0) {
      let shade   = 1.0 - ndl;
      let crevInk = 0.30 * (1.0 - smoothstep(0.08, 0.55, crev));
      let rockInk = 0.16 + 0.50 * shade + crevInk;              // lit rock ~#a19f9a on paper, shadow rock inky
      let snowInk = 0.02 + 0.10 * shade + 0.35 * crevInk;
      let baseInk = mix(rockInk, snowInk, snowMask);
      let lineInk = mix(0.50 + 0.22 * shade, 0.30, snowMask);   // heavy on rock, delicate on snow; body + line < 1.4
      var surfInk = baseInk + lines * lineInk + fine * lineInk * 0.12;
      surfInk = surfInk + rim * (0.16 + 0.14 * snowMask);
      cReal = mix(cReal, surfInk * (1.0 - recess), F.drs.z);
    }
  }

  // ---- BLEND model <-> real + the "edge of creation" wavefront ---------------
  c = mix(c, cReal, real);                          // left of seam = contour model, wake = shaded render, soft band between
  // don't over-bloom where the surface is already bright. In the light theme ink snow is LOW (paper), so
  // the guard mirrors; mix(a, b, 0.0) is exactly a at theme 0.
  let snowGuard = mix(1.0 - 0.6 * clamp(cReal, 0.0, 1.0), 1.0 - 0.6 * (1.0 - clamp(cReal, 0.0, 1.0)), F.drs.z);
  // slim bright core (squared -> a tight, clean centre) + a delicate halo; the bloom pass
  // turns the hot core into a soft glow on its own, so the explicit halo stays subtle.
  c = c + (seamLive * seamLive * 0.80 + haloLive * haloLive * 0.09) * snowGuard;

  // ===== EMERGENCE FRONT — the plotter head: the elevation band crystallising right now (vmF 0.40..0.72,
  // ~480 world units tall) lights each contour hairline as it is drawn, bottom-up. Uniform gate: emergeF is
  // provably 0 for every vertex once morph >= 0.8605 (summit key 1 passes vmF 0.72 at ss^-1 = 0.6513), so the
  // landed mountain skips this block outright. Snow-guarded (summit lines already glow), x(1 - real) so a repeat
  // trip never lights scan-lines on the shaded render. Max lit-rock hairline = 0.76 < the 0.82 bloom knee. =====
  if (F.mph.x < 0.87) {
    let emergeF = smoothstep(0.40, 0.52, vmF) * (1.0 - smoothstep(0.52, 0.72, vmF));
    c = c + hair * hairLum * emergeF * 0.40 * (1.0 - 0.6 * snow) * (1.0 - real);
  }

  // ---- hover wash: when the pointer rests on a career callout, ITS slice of the
  // massif lifts in a soft, breathing pulse (amplitude driven from RidgelineStage).
  // Centred on the hovered ring's plan radius and feathered across the whole band,
  // it is additive so the dark rock glows up, and eased back on snow so the summit
  // slice brightens without flattening to white. hov = (slice | -1, pulse, _, _). --
  if (F.hov.x >= 0.0 && F.hov.y > 0.0001) {
    let hbi = clamp(i32(F.hov.x), 0, 6);
    let hc = RINGS[hbi];
    let dn = abs(rw - hc) / 660.0;                  // 0 at the slice centre → 1 at edges
    let prof = 1.0 - smoothstep(0.0, 1.0, dn);      // a smooth bump across the band
    // additive wash, sculpted by the key light so the lit slice keeps its form;
    // eased back on snow so the summit slices brighten without flattening to white.
    // With no painted ring border, this glow IS the slice — broadened a touch so the
    // whole band lifts as one when the pointer rests anywhere on the experience.
    let wash = prof * F.hov.y * (0.34 + 0.52 * lit) * (1.0 - 0.34 * snow) * mix(1.0, 0.55, F.drs.z);   // a lighter lift on paper (x1.0 exactly at theme 0)
    c = c + wash;
  }

  // ---- focus isolation: when a career slice is CLICKED, recede every other band
  // toward black so the chosen ring reads as the lit hero. hov = (hoverBand,
  // hoverGlow, focusBand, focusAmt). Reuses the same plan-radius rw + RINGS as the
  // hover wash, with a feathered boundary so there's no visible ring edge — the
  // un-selected slopes simply dim to a faint structure, never a hard void. -------
  if (F.hov.w > 0.0001 && F.hov.z >= 0.0) {
    let sel = clamp(i32(F.hov.z), 0, 6);
    let sc  = RINGS[sel];
    let dn  = abs(rw - sc) / 660.0;                 // 0 at the slice centre (same width as hover)
    let inBand = 1.0 - smoothstep(0.55, 1.25, dn);  // 1 on the selected band → 0 outside, feathered
    let dim = mix(0.18, 1.0, inBand);               // others fall to 18% — recessed, not deleted
    c = c * mix(1.0, dim, F.hov.w);
  }
  // ===== EMERGE the mountain scalar c from black as each vertex lands. The weight reaches 1
  // by vmF = 0.85 (and calm reaches 1 by vmF = 1), so at vmF = 1 finalC = c EXACTLY — the
  // finished mountain is byte-identical to today. Below that the contour model fades up out of
  // black behind the dissolving filament ball (the separate additive globe pass). =====
  let finalC = c * smoothstep(0.0, 0.72, vmF);   // emerge from black as each vertex lands — knee pulled in so the contour model reads while the funnel still feeds it (endpoint pinned: =c at vmF=1)
  return vec4<f32>(vec3<f32>(finalC), 1.0);                // opaque → writes depth, occludes
}
`;

/* --------------------------------------------------------- FILAMENT ------- */
/* The intro GLOBE itself: a transparent ball "full of lines" — thousands of fine threads
   that flow and shimmer over a slowly spinning sphere, with bright nodes where they converge,
   exactly the reference look. Drawn as ADDITIVE 3-D line-list geometry (built once on the CPU
   in ridgeline.ts) into the HDR scene AFTER the terrain: depth-TESTED so the forming mountain
   occludes it, but never depth-WRITING, so every thread — front AND back of the sphere — simply
   accumulates as light → a genuine see-through tangle (impossible on the old opaque sphere). The
   whole web fades out as the mountain assembles (the terrain rises through it). Greyscale out;
   the bloom pass lifts the hot nodes to a glow and the composite supplies the grade. ----------

   Per-vertex inputs: mdir = the thread point's UNIT direction in MATERIAL space (before spin);
   at = (t along the thread 0..1, per-thread seed, baseline brightness, radial shell scale);
   tang = the thread's tangent at this vertex as an angle in the tangent-plane basis of
   globeMotion.tangentBasis (decoded below with the identical basis, 0 = radial for spokes). */
export const RIDGE_FILAMENT_WGSL = RIDGE_FRAME_WGSL + /* wgsl */ `
// GLOBE centre/radius MUST mirror GLOBE in ridgeline.ts (and GLOBE_C/GLOBE_R in the terrain
// shader) so the threads, the morphing sphere and the DOM letter-cloud all sit on one ball.
const F_TAU : f32 = 6.28318530718;
const F_GLOBE_C : vec3<f32> = vec3<f32>(0.0, 2120.0, 8200.0);
const F_GLOBE_R : f32 = 3600.0;
// ---- the owner's "calmer / dimmer" surface — these five knobs, nothing else ----
const MAT_GAIN : f32 = 1.20;       // crust sphere-average of material == 1.00 (measured, judge_numbers.mjs)
const GLEAM_W : f32 = 0.5;         // Kajiya-Kay sheen weight (0.9 bloomed the crust)
const GLEAM_W_PHONE : f32 = 0.35;
const WAVE_B : f32 = 0.20;         // pressure-wave brightness at the core, falling to x0.45 at the crust
const WAVE_B_PHONE : f32 = 0.12;
const SHADOW_FLOOR : f32 = 0.70;   // the ball's own terminator floor (a world-fixed lamp must not black out a dragged ball)
const RING_GLIDE : f32 = 0.0625;   // dash cells per beat (one cell per beat; the old scroll crawled 4-6x faster)
const HALO_FLAG : f32 = 0.10;      // nucleus radial >= this = the orbital halo (arcs 0.078..0.086; halo 0.118)

struct FOut {
  @builtin(position) pos  : vec4<f32>,
  @location(0)       glow : f32,
};

@vertex fn vs(@location(0) mdir : vec3<f32>, @location(1) at : vec4<f32>, @location(2) tang : f32) -> FOut {
  let morph  = F.mph.x;
  let motion = F.mph.z;                          // 0 on reduced-motion → the web holds still (and never dims)
  let phone  = F.eye.w;
  let tb = F.a.x / BEAT_PERIOD;                  // time in BEATS — every periodic term below is a rational multiple of the heart's 4 s
  let bp = beatPhase();                          // 0 = the heart's onset
  let bl = beatMix();                            // the heart's pulse 0..1 (BEAT_MEAN when frozen)

  // ---- line CLASS, encoded as a sentinel range in at.y (the seed): [0,1) curl thread / surface
  // spark / mote (organic), [1,2) radial spoke + gimbal ring (rigid armature), [2,3) nucleus skin arc +
  // orbital halo (the core, lifts to the summit). The FRACTIONAL part is the per-line phase seed every
  // flow / pulse term has always used. Every flag the later blocks need is decoded here, once. ----
  let kindRaw = at.y;
  let sseed   = fract(at.y);
  let isArm   = step(1.0, kindRaw);
  let isCore  = step(2.0, kindRaw);
  let isRing  = isArm * (1.0 - isCore) * step(0.90, sseed);   // armature carrying a top-decile seed
  let isHalo  = isCore * step(HALO_FLAG, at.w);               // nucleus OUTSIDE the skin-arc band
  let isSpoke = isArm * (1.0 - isCore) * (1.0 - isRing);
  let coreSurface = isCore * (1.0 - isHalo);
  let depth01 = clamp(at.w, 0.0, 1.0);                        // 0 = deep core … 1 = crust (the parallax key)
  // PROJECTS-DIAL CALM (F.mph.w): as the dial opens the threads settle toward near-stillness. projGate is
  // 1 on the globe and 0 by morph 0.20, so this is INERT once the mountain forms (and the pass itself is
  // skipped at morph >= FIL_SKIP) — morph = 1 stays byte-identical.
  let projGate = smoothstep(0.20, 0.0, morph);
  let dial = F.mph.w * projGate;
  let calmDown = mix(1.0, 0.10, dial);                        // deeper rest as the dial opens — the ball goes slow
  let fold = smoothstep(0.0, 0.72, dial);

  // ---- tangent decode from the RAW material direction: the builder (ridgeline.ts seg(), via
  // globeMotion.tangentBasis) stored the chord's angle in THIS basis; e1 / e2 must match it exactly ----
  let dm  = normalize(mdir);
  let upv = mix(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), step(0.99, abs(dm.y)));
  let e1  = normalize(cross(upv, dm));
  let e2  = cross(dm, e1);
  var T   = e1 * cos(tang) + e2 * sin(tang);

  // ---- silk shimmer: a flow ALONG each thread (phase keyed to t) projected onto the tangent plane so
  // the ball keeps its round silhouette. Deliberately INCOMMENSURATE with the beat (the one term that is
  // not a rational multiple of it) so the surface never phase-locks into a visible cycle. The crust
  // shimmers, the interior is nearly still; the rigid armature flows far less than the organic curl. ----
  var d = dm;
  let ph = at.x * 9.0 + sseed * F_TAU + tb * mix(1.3, 2.6, depth01);
  let w = vec3<f32>(sin(ph + tb * 2.2), sin(ph * 1.27 + tb * 2.9 + 2.1), sin(ph * 0.73 + tb * 1.7 + 4.2));
  let tangF = w - d * dot(w, d);                              // tangential component only (preserve radius)
  let flowAmt = mix(0.038, 0.010, isArm) * mix(0.35, 1.0, depth01) * motion * calmDown;
  d = normalize(d + tangF * flowAmt);

  // ---- rigid chain: spin (counter-rotating depth) -> ring precession -> halo orbit -> NUTATION; the
  // tangent T rides along through every rotation so the material sees the thread's true direction.
  // COUNTER-ROTATING DEPTH: the crust (depth01 -> 1) rides the globe spin at 1x (matching the terrain
  // sphere + the DOM letters); the deep interior spins BACKWARD a touch faster -> motion-parallax
  // volume. The armature (spokes + nucleus) is pinned to +1x so cage and core stay welded to the ball. ----
  let counter = mix(-0.55, 1.0, depth01);
  let spinAng = F.mph.y * mix(counter, 1.0, isArm);
  let cs = cos(spinAng); let sn = sin(spinAng);
  var sd = rotY(d, cs, sn);
  T = rotY(T, cs, sn);
  // GIMBAL RINGS precess on their own axis (200 beats per turn, signed per ring) and the HALO orbits
  // about Y (4 beats per orbit). Both are identity (zero angle) for every other vertex; frozen at motion 0.
  let prAng = (sseed - 0.95) * 2.0 * tb * 0.31416 * motion * isRing;
  let pc = cos(prAng); let ps = sin(prAng);
  sd = rotX(sd, pc, ps);  T = rotX(T, pc, ps);
  let ho = tb * 1.5707963 * isHalo * motion;
  let hc = cos(ho); let hs = sin(ho);
  sd = rotY(sd, hc, hs);  T = rotY(T, hc, hs);
  // the LEAN (nutation): Rodrigues about the horizontal axis k = (x2.x, 0, x2.y) by x2.z — applied LAST,
  // after the spin, exactly as the terrain skin and the DOM letters apply it (globeMotion.tiltH). Identity
  // when F.x2.z == 0 (every morph >= 0.30 / Projects / reduced-motion frame).
  let nk = vec3<f32>(F.x2.x, 0.0, F.x2.y);
  let nc = cos(F.x2.z); let ns = sin(F.x2.z);
  sd = sd * nc + cross(nk, sd) * ns + nk * (dot(nk, sd) * (1.0 - nc));
  T  = T  * nc + cross(nk, T)  * ns + nk * (dot(nk, T)  * (1.0 - nc));
  T  = normalize(mix(T, sd, isSpoke));                                 // a spoke's tangent is radial

  // ---- PRESSURE WAVE (replaces the breathing pump, the spoke arm-wave and the convergence volley):
  // one shell leaves the heart at onset (bp 0), reaches the crust at bp 0.5, is gone by 0.70. The
  // radius ripple is INTERIOR only — the crust (the one radius where the letters are welded) stays rigid; the
  // interior glyphs already counter-rotate and shimmer past the interior threads, so a 1 % transient breath there
  // (<= 1.6 px desktop, 0.7 px phone) sits below that existing decoupling; at the crust the wave
  // is brightness alone (below). Gated off by the morph (gone by 0.30), the fold and the dial calm. ----
  let waveGate = (1.0 - smoothstep(0.0, 0.30, morph)) * (1.0 - fold) * calmDown;
  let wf = 0.075 + 1.85 * bp;
  let wd = (at.w - wf) * 9.0;
  let wg = exp(-wd * wd) * smoothstep(0.0, 0.04, bp) * (1.0 - smoothstep(0.55, 0.70, bp));   // born over the first 160 ms (no brightness step at the beat wrap), gone by 0.70
  let rr = at.w * (1.0 + 0.010 * wg * (1.0 - depth01 * depth01) * motion * waveGate);
  // floor at a small positive so a deep inner end never crosses the centre (NaN-safe direction)
  let rDial = max(rr, 0.01);
  var world = F_GLOBE_C + F_GLOBE_R * rDial * sd;

  // PROJECTS FOLD (unchanged): as the dial opens, every thread COLLAPSES onto a single horizontal line
  // through the globe centre — world y,z pinned to the centre, x spread by the thread's MATERIAL x
  // (pre-spin) so the streak is stable regardless of the ball's rotation. The screen Y is additionally
  // pinned to the projected centre in clip space below, so the line is EXACTLY horizontal at the
  // baseline the DOM welds to, for any yaw. The folded streak then fades (dialFade) → the globe folds
  // into one glowing line and DISAPPEARS, handing off to the DOM red baseline. 'fold' gates it ⇒
  // identity on the home globe (dial = 0) and the mountain (dial inert at morph ≥ 0.20).
  let lineX = F_GLOBE_C.x + F_GLOBE_R * 1.25 * mdir.x;
  world = mix(world, vec3<f32>(lineX, F_GLOBE_C.y, F_GLOBE_C.z), fold);

  // ===== MORPH — the globe is not crossfaded out; it FUNNELS down the summit axis and is consumed as
  // the mountain rises through the converging streams. The axis x=0, z=8200 is BOTH the globe centre
  // and the summit axis (PEAK_X = GLOBE_C.x = 0, PEAK_Z = GLOBE_C.z = 8200), so the centre literally
  // becomes the peak. The windows are the shared DRAIN / POUR / LIFT / CORE_FADE constants of the frame
  // block; every fade below terminates by 0.70 < FIL_SKIP, so the morph = 1 mountain is untouched.
  // DRAIN: collapse each vertex horizontally onto the axis at its own height — the interior / near-core
  // lines collapse first, the outer shell follows. The NUCLEUS is EXCLUDED: the heart stays whole until
  // it lifts (the backdrop body's occluder shrinks away over the same window). =====
  let drainT = clamp(smoothstep(DRAIN_A, DRAIN_B, morph) * (1.4 - depth01 * 0.8), 0.0, 1.0) * (1.0 - isCore);
  world = mix(world, vec3<f32>(0.0, world.y, 8200.0), drainT);
  // POUR: the collapsed column now runs DOWN the summit axis and settles onto the band the mountain
  // occupies, so the streams visibly feed the rising peak instead of hanging as a fixed-height pillar.
  // The crust lands low and the interior lands high → a sheet / waterfall rather than a spike, on
  // terrain that has actually emerged by then (the summit crest emerges LAST). SIL_Y is the on-axis
  // cone crest, a visual landing target only. No pow / no fwidth.
  let SIL_Y : f32 = 4422.0;
  let pourT = smoothstep(POUR_A, POUR_B, morph) * (1.0 - isCore);
  let landY = mix(SIL_Y * 0.22, SIL_Y * 0.62, 1.0 - depth01);
  world = mix(world, vec3<f32>(0.0, landY, 8200.0), pourT);
  // NUCLEUS LIFT: the heart (skin arcs + halo) rises up the axis to the summit seed in step with the
  // backdrop body (the same liftAmt), handing off to the apex beacon that fades in at morph 0.85.
  let lift = liftAmt(morph) * isCore;
  world = mix(world, APEX, lift);
  // per-vertex, drain-aware FADE: a line fades only AFTER it has drained; inner / lower lines fade
  // first, matching the terrain's bottom-up assembly so the web reads as CONSUMED by the rising
  // mountain. The nucleus holds until its lift completes (CORE_FADE_A). Max (fadeStart + 0.15) = 0.70
  // < FIL_SKIP → every vertex is provably gone before the pass is skipped.
  var fadeStart = 0.46 + 0.09 * depth01;
  fadeStart = mix(fadeStart, CORE_FADE_A, isCore);
  let globeFade = 1.0 - smoothstep(fadeStart, fadeStart + 0.15, morph);

  // ---- clip + the pointer FIELD (from the FINAL world, as before): a local field, evaluated in this
  // vertex pass, that softly parts the nearby silk and moves the lamp; the core / cage hold their
  // shape. Inert past morph 0.2 and on the dial. ----
  let clip  = F.vp * vec4<f32>(world, 1.0);
  let delta = (F.ptr.xy - clip.xy / max(clip.w, 0.001)) * vec2<f32>(F.a.w, 1.0);
  let distance = length(delta);
  let field = (1.0 - smoothstep(0.04, 0.38, distance)) * F.ptr.z
    * (1.0 - smoothstep(0.0, 0.2, morph)) * (1.0 - dial);

  // ---- BRIGHTNESS — all computed here; the FS just emits it (additive over black). ----
  // NaN-safe: the eye is far from the (constant) centre, so the normalize argument is never zero.
  let toEye = normalize(F.eye.xyz - F_GLOBE_C);
  let frontness = 0.5 + 0.5 * dot(sd, toEye);
  var glow = at.z;
  // TRAVELLING PULSE — a hot bead races along each line (charge flowing), 2 beats per traverse, 3x
  // faster in the drain; quieter deep inside. Gaussians use a*a (NOT pow): pow(x, 2.0) NaNs for x < 0.
  let pSpeed = 0.5 * (1.0 + 2.0 * drainT);
  let p  = fract(tb * pSpeed + sseed);
  let pa = (0.5 - abs(fract(at.x - p) - 0.5)) * 14.0;        // wrapped distance to the pulse head
  let pulse = exp(-pa * pa);
  let ta = fract(at.x - p + 0.06) * 9.0;                     // a short comet afterglow trailing behind
  let tail = 0.42 * exp(-ta * ta);
  let highlight = smoothstep(0.45, 0.85, sseed);
  glow = glow * mix(1.0, 0.72 + highlight * mix(0.5, 1.0, depth01) * 1.1 * (pulse + tail), motion * calmDown);
  // the wave's brightness: attenuates with radius; the core skin arcs carry coreLight instead
  let waveB = mix(WAVE_B, WAVE_B_PHONE, phone) * wg * mix(1.0, 0.45, at.w) * (1.0 - coreSurface);
  glow = glow * mix(1.0, 1.0 + waveB, motion * waveGate);

  // ---- MATERIAL: the ball is a BODY under the scene's one fixed key lamp (KEY_L — blended toward the
  // pointer, which MOVES the lamp), lit from the heart inside, with a hairline (Kajiya-Kay) response —
  // a thread ACROSS the lamp is lit, one ALONG it is dim — a TRUE signed view-depth cue, and an r^2
  // shell normalisation so the packed deep shells do not out-shine the crust by their density alone.
  // A world-fixed lamp means the lit side stays on the lamp's side when the ball is dragged, exactly
  // like the mountain it becomes; SHADOW_FLOOR keeps the far side from blacking out. ----
  let zN = clamp(rDial * dot(sd, toEye), -1.0, 1.0);            // +1 nearest crust .. -1 far crust
  let depthDim = mix(mix(0.20, 0.12, phone), 1.10, smoothstep(-1.0, 1.0, zN));
  let shellFloor = mix(0.28, 0.22, phone);
  let shellNorm = shellFloor + (1.0 - shellFloor) * depth01 * depth01;
  let camR = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), toEye));   // lookAt's x axis (screen right in world)
  let camU = cross(toEye, camR);
  let ptrDir = normalize(toEye + camR * (F.ptr.x * F.a.w * 0.3057) + camU * (F.ptr.y * 0.3057));   // 0.3057 = tan(FOVY/2)
  // the pointer MOVES the lamp, but never through zero: mix() of two unit vectors vanishes when they are antipodal
  // at t = 0.5, and the globe's wide pitch walls can put the eye (hence ptrDir) at KEY_L's antipode, where a
  // per-vertex field ring would flip the lit hemisphere 180 deg. Cap the blend weight only as ptrDir nears the
  // antipode (dot < -0.2): |mix| >= 0.1 everywhere (measured 0.118); the rest pose (dot = +0.65) is untouched.
  let lampCap = mix(0.45, 0.85, smoothstep(-1.0, -0.2, dot(KEY_L, ptrDir)));
  let Lk = normalize(mix(KEY_L, ptrDir, field * lampCap));
  let Hk = normalize(Lk + toEye + vec3<f32>(0.0, 0.02, 0.0));    // finite at the lamp's antipode (min length 0.0157 over the orbit)
  let TL = dot(T, Lk); let TH = dot(T, Hk); let TR = dot(T, sd);
  let sinTL = sqrt(max(0.0, 1.0 - TL * TL));                    // a thread across the lamp is lit, one along it is dim
  let sinTR = sqrt(max(0.0, 1.0 - TR * TR));                    // tangential threads catch the heart; radial ones do not
  let shadow = smoothstep(-0.7, 0.5, dot(sd, Lk));               // the ball's own terminator
  let keyLit  = (0.35 + 0.65 * sinTL) * mix(SHADOW_FLOOR, 1.0, shadow) * mix(0.55, 1.0, depth01);
  let coreLit = sinTR / (1.0 + 8.0 * at.w * at.w) * (0.7 + 0.3 * bl) * mix(1.0, 0.6, phone);
  let lobe = mix(smoothstep(0.1, 0.8, dot(sd, Hk)), 1.0, isRing);   // curl gleam is a BAND, not scattered glitter; rings keep the pure wire term
  let gleam = exp(-14.0 * TH * TH) * shadow * depth01 * depth01 * lobe * (1.0 - fold) * (1.0 - F.drs.z);   // a highlight is never extra ink
  let material = MAT_GAIN * (keyLit + 0.55 * coreLit + mix(GLEAM_W, GLEAM_W_PHONE, phone) * gleam);
  let spokeMat = MAT_GAIN * (0.35 + 0.65 * sinTL) * mix(SHADOW_FLOOR, 1.0, shadow);   // the armature: no shell weight, no interior shade
  var stack = shellNorm * depthDim * material;
  stack = mix(stack, depthDim * spokeMat, isSpoke);
  stack = mix(stack, depthDim, isHalo);                          // the orbital ring keeps only the depth cue
  glow = glow * stack;

  // ring dash: a continuous beat-locked GLIDE, one cell per beat, alternating direction per ring; no
  // head bead (the old racing bead and the escapement tick were events, not a mechanism). mix-gated on
  // isRing so it ONLY rewrites ring verts (spokes / silk / nucleus untouched).
  let rdir   = select(-1.0, 1.0, sseed > 0.95);
  let scroll = fract(at.x + sseed + rdir * tb * RING_GLIDE * motion);
  let cells  = fract(scroll * 16.0);                             // 16 dashes around the ring
  let dv     = 0.5 - abs(cells - 0.5);
  let dash   = smoothstep(0.19, 0.5, dv);                        // ~0.62 duty
  glow = mix(glow, glow * (0.42 + 0.9 * dash), isRing);
  // the nucleus SKIN ARCS: lit by the one lamp, breathing on the shared clock (exactly 1.0 when frozen);
  // in the light theme the hatching goes on the SHADOW side (an ink sphere is hatched where it is dark)
  let somaBeat = 1.0 + 0.10 * (bl - BEAT_MEAN);
  let diffuse  = max(0.0, dot(sd, KEY_L));
  let diffT    = mix(diffuse, 1.0 - diffuse, F.drs.z);
  let coreLight = at.z * (0.25 + 0.75 * diffT) * mix(0.25, 1.0, frontness);
  glow = mix(glow, coreLight * somaBeat, coreSurface);
  // FIRING WAVE — the discharge that leaves the body the instant the climb begins (crust at 0.22, spent by
  // ~0.31). It deliberately overlaps the first beat of the DRAIN (0.10-0.40): the last of the discharge runs out
  // through threads already being pulled to the axis, one continuous ignition -> collapse, not two events.
  let fr = (at.w - clamp(morph * 4.5, 0.0, 1.4)) * 7.0;
  glow = glow * (1.0 + smoothstep(0.0, 0.12, morph) * mix(0.9, 0.5, phone) * exp(-fr * fr));
  // PROJECTS FOLD GLOW (unchanged): the converged streak reads HOT; 'fold' gates it ⇒ identity off the dial
  glow = glow * mix(1.0, 1.5, fold);
  glow = glow * (1.0 + field * 0.5 * frontness);                 // the hover: the lamp has moved; a touch more light
  let knee = 0.08 * (1.0 - fold);
  glow = glow / (1.0 + knee * max(glow, 0.0));                   // per-line soft knee against multiplicative stacking

  var o : FOut;
  // pin the folded verts to the projected globe-centre's NDC-y → an EXACTLY horizontal screen line at
  // the baseline the DOM welds to, for any yaw. At fold = 0 this is byte-identical (clip unchanged).
  let cClip = F.vp * vec4<f32>(F_GLOBE_C, 1.0);
  let pinnedY = (cClip.y / cClip.w) * clip.w;
  o.pos = vec4<f32>(clip.x, mix(clip.y, pinnedY, fold), clip.z, clip.w);
  // the pointer field parts the nearby silk (organic class only; the core / cage hold their shape)
  let tangent = vec2<f32>(-delta.y, delta.x);
  let energy = F.ptr.w;
  let displacement = (-delta * 0.028 + tangent * (0.02 + 0.035 * energy)) /
    (0.12 + distance) * field * (1.0 - isArm) * motion;
  o.pos = vec4<f32>(o.pos.xy + displacement / vec2<f32>(F.a.w, 1.0) * clip.w, o.pos.zw);
  // the folded glowing line dissolves as the fold completes → the globe disappears. dialFade = 1 at
  // dial = 0 (home globe byte-identical) and 0 by dial = 1.
  let dialFade = 1.0 - smoothstep(0.80, 1.0, dial);
  o.glow = glow * globeFade * dialFade;
  return o;
}

@fragment fn fs(i : FOut) -> @location(0) vec4<f32> {
  // straight greyscale light (additive over black); the bloom pass turns the hot nodes to glow.
  let g = max(i.glow, 0.0);
  return vec4<f32>(vec3<f32>(g), g);
}
`;

/* --------------------------------------------------------- COMPOSITE ------ */
/* Resolve the HDR scene to the swap-chain: a 4-tap box downsample of the
   supersampled target (clean lines), a faint additive bloom for the snow glow,
   a gentle Reinhard shoulder to tame hotspots, a vignette that pools the corners
   to true black, and a breath of grain. Greyscale in, greyscale out. */
export const RIDGE_COMPOSITE_WGSL = RIDGE_FRAME_WGSL + /* wgsl */ `
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var sceneTex : texture_2d<f32>;
@group(0) @binding(3) var bloomTex : texture_2d<f32>;

struct VsOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vid : u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
  var o : VsOut;
  let xy = p[vid];
  o.pos = vec4<f32>(xy, 0.0, 1.0);
  o.uv = vec2<f32>(xy.x * 0.5 + 0.5, 1.0 - (xy.y * 0.5 + 0.5));
  return o;
}
fn hash12(p : vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
  let uv = i.uv;
  let texel = vec2<f32>(1.0 / F.a.y, 1.0 / F.a.z);
  // DRS: the live scene fills only the [0,rect] sub-rect of the (max-size) HDR target under load, so
  // every sceneTex tap is remapped by rect. Folding it as (uv + off*texel)*rect keeps the box-tap
  // offset a true HALF-physical-texel at every scale; rect=(1,1) at full quality means byte-identical.
  let rect = F.drs.xy;
  // 4-tap rotated-box downsample of the 2× supersampled scene → clean hairlines
  var s = textureSample(sceneTex, samp, (uv + vec2<f32>( 0.5,  0.5) * texel) * rect).rgb;
  s = s + textureSample(sceneTex, samp, (uv + vec2<f32>(-0.5,  0.5) * texel) * rect).rgb;
  s = s + textureSample(sceneTex, samp, (uv + vec2<f32>( 0.5, -0.5) * texel) * rect).rgb;
  s = s + textureSample(sceneTex, samp, (uv + vec2<f32>(-0.5, -0.5) * texel) * rect).rgb;
  var col = s * 0.25;

  // ---- PROJECTS depth-of-field: while the timeline is open (F.mph.w>0) soften the frame AWAY from
  // the moon's focal point, keeping the moon crisp — the "we've focused" cue. The focal point
  // (F.lod.yz, composite UV) TRACKS the transiting moon so it never blurs as it flies the range.
  // Dead branch at projAmt=0 (Home/CV) ⇒ byte-identical. toC (frame centre) drives the vignette;
  // toF (focal) drives the blur.
  let toC = uv - vec2<f32>(0.5, 0.5);
  let toF = uv - vec2<f32>(F.lod.y, F.lod.z);
  let dof = F.mph.w;
  if (dof > 0.001) {
    let edgeK = smoothstep(0.20, 0.70, dot(toF, toF) * 2.0); // 0 on the moon (focal) → 1 away from it
    let blurR = 2.6 * edgeK * dof;
    var b = textureSample(sceneTex, samp, (uv + vec2<f32>( 1.0,  0.0) * blurR * texel) * rect).rgb;
    b = b + textureSample(sceneTex, samp, (uv + vec2<f32>(-1.0,  0.0) * blurR * texel) * rect).rgb;
    b = b + textureSample(sceneTex, samp, (uv + vec2<f32>( 0.0,  1.0) * blurR * texel) * rect).rgb;
    b = b + textureSample(sceneTex, samp, (uv + vec2<f32>( 0.0, -1.0) * blurR * texel) * rect).rgb;
    b = b + textureSample(sceneTex, samp, (uv + vec2<f32>( 0.7,  0.7) * blurR * texel) * rect).rgb;
    b = b + textureSample(sceneTex, samp, (uv + vec2<f32>(-0.7,  0.7) * blurR * texel) * rect).rgb;
    b = b + textureSample(sceneTex, samp, (uv + vec2<f32>( 0.7, -0.7) * blurR * texel) * rect).rgb;
    b = b + textureSample(sceneTex, samp, (uv + vec2<f32>(-0.7, -0.7) * blurR * texel) * rect).rgb;
    col = mix(col, b * 0.125, edgeK * dof);
  }

  // ---- shared by both grades: the resolved scene, ONE bloom tap, the vignette weight, the grain sample ----
  let base  = col;
  let bloom = textureSample(bloomTex, samp, uv).rgb;
  let vig   = dot(toC * vec2<f32>(1.06, 1.0), toC);              // elliptical (reuses the hoisted toC)
  let vigK  = smoothstep(0.16, 0.95, vig * 2.3);
  let g     = hash12(uv * F.a.yz + fract(F.a.x) * 131.0) - 0.5;  // animated grain
  // ---- DARK grade: the original chain, op for op (byte-identical at theme 0): snow glow, exposure, soft
  // shoulder, the vignette pooling the corners to black like the reference, a breath of film grain ----
  var dark = base + bloom * F.post.x;
  dark = dark * F.post.w;
  dark = dark / (1.0 + dark * 0.55);
  dark = dark * (1.0 - F.post.y * vigK);
  dark = dark + vec3<f32>(g * F.post.z);
  // ---- LIGHT grade: ink on paper. Every pass still emits LIGHT; here it is read as ink DENSITY and printed
  // (Beer-Lambert). The soft TOE hides the whisper layer the dark shoulder hides (lum 0.05 prints #e4e1db, not fog);
  // above 0.3 the greys match k = 3 within two levels. Uniform branch, skipped at 0. ----
  var outC = dark;
  let theme = clamp(F.drs.z, 0.0, 1.0);
  if (theme > 0.0) {
    let PAPER = vec3<f32>(0.957, 0.945, 0.918);   // = CSS --bg light (#f4f1ea); the swap chain is sRGB-encoded
    let INK   = vec3<f32>(0.078, 0.075, 0.071);   // = CSS --ink light (#141312)
    let density = dot(base + bloom * (F.post.x * 0.25), vec3<f32>(0.33333334)) * F.post.w;   // bloom at a quarter weight: a trace of bleed
    let dd = density * density / (density + 0.06);
    let inkAmt = 1.0 - exp(-3.2 * dd);
    var light = mix(PAPER, INK, inkAmt);
    light = light * (1.0 - 0.08 * vigK);          // a paper falloff (corners 0.92 x paper), never toward black
    light = light + vec3<f32>(g * F.post.z * 0.6);// paper tooth
    outC = mix(dark, light, theme);
  }
  outC = max(outC, vec3<f32>(0.0));
  return vec4<f32>(outC, 1.0);
}
`;

/* --------------------------------------------------- POST: BRIGHT/BLUR ---- */
/* Generic half-resolution bright-pass + separable blur, shared by the bloom
   chain. PassU packs the target texel size, the (unit) blur direction, and a
   spread/threshold param. Both passes share the same fullscreen-triangle VS. */
const POST_VS = /* wgsl */ `
struct PassU { texel : vec4<f32>, params : vec4<f32> };  // xy texel, zw dir
@group(0) @binding(0) var<uniform> P : PassU;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var tex : texture_2d<f32>;
struct VsOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vid : u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
  var o : VsOut;
  let xy = p[vid];
  o.pos = vec4<f32>(xy, 0.0, 1.0);
  o.uv = vec2<f32>(xy.x * 0.5 + 0.5, 1.0 - (xy.y * 0.5 + 0.5));
  return o;
}
`;

export const BRIGHT_WGSL = POST_VS + /* wgsl */ `
@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
  // P.params.zw = the DRS scene sub-rect: the bright pass runs full-size but samples only the live
  // [0,rect] region of the scene target and upsamples it across the (full-size) bloom pyramid, so the
  // separable blur chain stays untouched. rect=(1,1) at full quality ⇒ byte-identical.
  let c = textureSample(tex, samp, i.uv * P.params.zw).rgb;
  let l = max(c.r, max(c.g, c.b));
  let t = P.params.x;                       // bloom threshold
  let k = max(l - t, 0.0) / max(l, 1e-4);   // keep colour, soft knee
  return vec4<f32>(c * k, 1.0);
}
`;

export const BLUR_WGSL = POST_VS + /* wgsl */ `
@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
  let step = P.texel.xy * P.texel.zw * P.params.x;   // per-tap uv offset
  var w = array<f32, 5>(0.227, 0.194, 0.121, 0.054, 0.016);
  var col = textureSample(tex, samp, i.uv).rgb * w[0];
  for (var k : i32 = 1; k < 5; k = k + 1) {
    let o = step * f32(k);
    col += textureSample(tex, samp, i.uv + o).rgb * w[k];
    col += textureSample(tex, samp, i.uv - o).rgb * w[k];
  }
  return vec4<f32>(col, 1.0);
}
`;
