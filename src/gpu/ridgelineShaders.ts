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
  eye  : vec4<f32>,   // xyz camera eye (world), w unused
  hov  : vec4<f32>,   // x hovered slice index (-1 none), y pulse 0..1, zw unused
  mph  : vec4<f32>,   // x morph 0..1 (0 = intro globe, 1 = finished mountain), y globeSpin (rad), z motion, w projAmt (0 = globe chaos … 1 = dial-calm)
  lod  : vec4<f32>,   // x contour-spacing scale (1 = desktop; >1 on phones widens the spacing → fewer lines), yzw unused
};
@group(0) @binding(0) var<uniform> F : Frame;
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
/* Pure black with the concentric dotted halo. Drawn first, full-screen, never
   writes depth — the terrain mesh paints over its lower half, leaving the arcs
   visible only in the sky around the summit (exactly the reference framing). */
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
@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
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
  // so the spinning ball reads as a clean tangle in empty black. morph 0 = globe → no
  // halo; morph 1 = mountain → full halo.
  halo = halo * smoothstep(0.66, 0.92, F.mph.x);  // the sky rises WITH the settling massif and lands before the survey (0.80-1.0) → a continuous crescendo, no halo pop (full halo by 0.92 < 1.0; absent at morph 0)
  return vec4<f32>(vec3<f32>(halo), 1.0);
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
  @location(3) gdir : vec3<f32>, // UNIT sphere dir — seam/pole/morph-stable, independent of wpos
  @location(4) vm  : f32,        // interpolated per-vertex morph → drives the FS globe↔mountain gate
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
  // cheap single-tap lumpiness (NO fbm — this runs per vertex over a 760×420 grid) so the
  // ball reads as a rolled-up piece of terrain rather than a sterile billiard sphere
  let lump = 1.0 + 0.06 * (vnoise(vec2<f32>(uv.x * 40.0, uv.y * 22.0)) - 0.5);
  let sphere = GLOBE_C + GLOBE_R * lump * sphereDir;

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
  let nb = mix(sphereDir, terrainNrm, vm) + vec3<f32>(0.0, 1e-4, 0.0);

  var o : VsOut;
  o.pos = F.vp * vec4<f32>(world, 1.0);
  o.wy = mix(GLOBE_C.y + GLOBE_R * sphereDir.y, y, vm); // height tone follows the morph (snow lands last)
  o.nrm = normalize(nb);
  o.wpos = world;
  o.gdir = sphereDir;
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
  let dxp = i.wpos.x - PEAK_X;
  let dzp = i.wpos.z - PEAK_Z;
  // the height field's own anisotropy (a touch wider in depth) so the rings are the
  // mountain's planted ellipses, not perfect circles laid on top
  let baseR = sqrt(dxp * dxp * 1.05 + dzp * dzp * 0.58);
  let warp = (fbm(vec2<f32>(i.wpos.x * 0.00026, i.wpos.z * 0.00023) + 47.0) - 0.5) * 980.0
           + (fbm(vec2<f32>(i.wpos.x * 0.00090, i.wpos.z * 0.00078) + 12.0) - 0.5) * 210.0;
  let rw = baseR + warp;
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
  let snowFill = snow * snow * (0.24 + 0.46 * diff);
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
  // the reveal sweep stays ALIVE through every state — at rest, behind a focused
  // career dossier, and behind the "Your Assignment?" brief alike — so the mountain
  // keeps breathing under all of them. (It used to park to a frozen contour schematic
  // on focus via F.hov.w; that made the experience overlay static while the assignment
  // overlay — which never raises focusAmt — kept pulsing. Decoupled so they match.
  // The band / halo / slice dimming further down STILL keys off F.hov.w; only the
  // sweep is freed.)
  // the realistic sweep is the FINISHING flourish: absent on the globe, ramped in over the
  // last of the morph, and exactly 1.0 at vmF = 1 → the endpoint equals today's mountain.
  let calm = smoothstep(0.50, 1.0, vmF);         // realistic rock/snow grows WITH the emerging contour model, not bunched in the tail (endpoint pinned: =1 at vmF=1)
  // ping-pong PHASE from unbounded time via cos() (no fract precision drift at large t)
  let SWEEP_W = 0.52;                              // rad/s -> ~12.1s for a full there-and-back cycle
  let ph = 0.5 - 0.5 * cos(F.a.x * SWEEP_W);       // 0 -> 1 -> 0, symmetric, smooth turn-arounds
  let dwelled = smoothstep(0.08, 0.92, ph);        // gentle symmetric ease + a soft rest at BOTH ends (no latch)
  let eased = dwelled * dwelled * (3.0 - 2.0 * dwelled);   // smootherstep S-curve, still symmetric
  // wavefront position: eased 0 -> seam off the RIGHT (all contour model); eased 1 ->
  // seam off the LEFT (all realistic). The seam recedes right->left and the render
  // fills in behind it. Over-scan past both edges (-0.10..1.10) so the seam fully clears.
  let travel = mix(1.10, -0.10, eased);
  let front = mix(1.10, travel, calm);             // calm=0 (focused) parks it at 1.10 = all contour model, frozen
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
  let lnWarp = (fbm(vec2<f32>(i.wpos.x * 0.00095, i.wpos.z * 0.00115) + 5.0) - 0.5) * 150.0
             + (ridged(vec2<f32>(i.wpos.x * 0.0040, i.wpos.z * 0.0030) + 9.0) - 0.40) * 85.0;
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
    let snowNoise = fbm(vec2<f32>(i.wpos.x * 0.0016, i.wpos.z * 0.0014) + 31.0);
    let snowMask = clamp(smoothstep(0.34, 0.60, hN + (snowNoise - 0.5) * 0.14)
                       * smoothstep(0.26, 0.66, slopeUp), 0.0, 1.0);
    // --- HIGH-CONTRAST tonal relief base: near-black rock, brighter snow, shaped by the
    //     key, with deep crevice darkening so gullies pool to black (no soft clay) ---
    let crev = clamp(ridged(vec2<f32>(i.wpos.x * 0.0044, i.wpos.z * 0.0017) + 19.0), 0.0, 1.0);
    let rockTone = 0.03 + 0.15 * ndl;              // dark rock; lit faces lift just a touch
    let snowTone = 0.20 + 0.52 * ndl;              // snow much brighter under the key
    let base = mix(rockTone, snowTone, snowMask) * (0.40 + 0.60 * smoothstep(0.08, 0.55, crev));
    // line luminance: bright, lifted by the key + snow so the weave itself models the relief
    // (brighter where lit, sinking into shadow) — kept mostly under the 0.82 bloom threshold
    // so the lines stay CRISP; only summit snow lines glow a little.
    let lineLum = mix(0.40 + 0.42 * ndl, 0.98, snowMask);
    var surf = base + lines * lineLum + fine * lineLum * 0.18;   // dark tonal relief + bright fine weave (fine weight was 0.35 → calmer micro-detail)
    surf = surf + rim * (0.10 + 0.26 * snowMask);  // grazing ridge light against the black sky
    let depthF = smoothstep(ZN, ZF * 0.9, i.wpos.z);
    let lowF = 1.0 - smoothstep(0.05, 0.30, hN);
    let recess = clamp(depthF * (0.45 + 0.35 * lowF) * (1.0 - snowMask * 0.5), 0.0, 0.75);
    cReal = surf * (1.0 - recess);                 // bright lines may graze >1 -> a touch of bloom
  }

  // ---- BLEND model <-> real + the "edge of creation" wavefront ---------------
  c = mix(c, cReal, real);                          // left of seam = contour model, wake = shaded render, soft band between
  let snowGuard = 1.0 - 0.6 * clamp(cReal, 0.0, 1.0);    // don't over-bloom where the surface is already bright
  // slim bright core (squared -> a tight, clean centre) + a delicate halo; the bloom pass
  // turns the hot core into a soft glow on its own, so the explicit halo stays subtle.
  c = c + (seamLive * seamLive * 0.80 + haloLive * haloLive * 0.09) * snowGuard;

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
    let wash = prof * F.hov.y * (0.34 + 0.52 * lit) * (1.0 - 0.34 * snow);
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
   at = (t along the thread 0..1, per-thread seed, baseline brightness, radial shell scale). */
export const RIDGE_FILAMENT_WGSL = RIDGE_FRAME_WGSL + /* wgsl */ `
// GLOBE centre/radius MUST mirror GLOBE in ridgeline.ts (and GLOBE_C/GLOBE_R in the terrain
// shader) so the threads, the morphing sphere and the DOM letter-cloud all sit on one ball.
const F_TAU : f32 = 6.28318530718;
const F_GLOBE_C : vec3<f32> = vec3<f32>(0.0, 2120.0, 8200.0);
const F_GLOBE_R : f32 = 3600.0;

struct FOut {
  @builtin(position) pos  : vec4<f32>,
  @location(0)       glow : f32,
};

@vertex fn vs(@location(0) mdir : vec3<f32>, @location(1) at : vec4<f32>) -> FOut {
  let morph  = F.mph.x;
  let motion = F.mph.z;                          // 0 on reduced-motion → the web holds still
  let tt     = F.a.x;

  // ---- line CLASS, encoded as a sentinel range in at.y (the seed): [0,1) curl thread / surface
  // spark (organic), [1,2) radial spoke (rigid armature), [2,3) nucleus (the core, lifts to summit).
  // The FRACTIONAL part is the per-line phase seed every flow/twinkle term has always used. ----
  let kindRaw = at.y;
  let sseed   = fract(at.y);
  let isArm   = step(1.0, kindRaw);              // spoke OR nucleus → the rigid armature (flows less)
  let isCore  = step(2.0, kindRaw);              // nucleus only → rises to the summit during the morph
  // sub-class flags decoded from the radial shell + seed (no new attributes): a RING is armature
  // (NOT core) carrying a top-decile seed; a HALO is nucleus sitting OUTSIDE the < 0.10 core sparks.
  let isRing  = isArm * (1.0 - isCore) * step(0.90, sseed); // great-circle gimbal ring
  let isHalo  = isCore * step(0.12, at.w);                  // nucleus orbital halo (not a core spark)
  let depth01 = clamp(at.w, 0.0, 1.0);                      // 0 = deep core … 1 = crust (the parallax key)

  var d = normalize(mdir);
  // CONSTANT MOVEMENT: a flow that travels ALONG each thread (phase keyed to t) and over time,
  // projected onto the tangent plane so the ball keeps its round silhouette. Three offset lobes →
  // an organic, non-repeating shimmer. The rigid armature (spokes/nucleus) flows far less than the
  // organic curl, so the cage reads stable against the silk — the "sophisticated" contrast.
  let ph = at.x * 9.0 + sseed * F_TAU + tt * mix(0.9, 0.35, depth01); // inner silk shimmers faster (more life deep)
  let w = vec3<f32>(
    sin(ph + tt * 0.85),
    sin(ph * 1.27 + tt * 1.10 + 2.1),
    sin(ph * 0.73 + tt * 0.65 + 4.2),
  );
  let tang = w - d * dot(w, d);                  // tangential component only (preserve radius)
  // PROJECTS-DIAL CALM (F.mph.w): as the dial opens the chaotic threads settle toward near-stillness.
  // projGate is 1 on the globe and falls to 0 by morph 0.20, so this is utterly INERT once the mountain
  // forms (and the filament pass itself is skipped at morph>=0.72) — morph=1 stays byte-identical.
  let projGate = smoothstep(0.20, 0.0, morph);
  let dial = F.mph.w * projGate;             // 0..1 dial-open progress, INERT at morph>=0.20 ⇒ morph=1 untouched
  let calmDown = mix(1.0, 0.10, dial);       // deeper rest as the dial opens (was 0.16) — the ball goes slow
  let flowAmt = mix(0.068, 0.020, isArm) * mix(1.35, 1.0, depth01) * motion * calmDown; // interior silk more alive
  d = normalize(d + tang * flowAmt);

  // a tiny BREATHING PUMP so the whole web gently inhales (frozen on reduced motion)
  let pumpR = at.w * (1.0 + 0.01 * sin(tt * 0.4 + at.x * F_TAU) * motion);

  // COUNTER-ROTATING DEPTH: the crust (depth01→1) rides the globe spin (lon += F.mph.y, matching the
  // terrain sphere + the DOM letters); the deep interior (→0) spins BACKWARD a touch faster, so the
  // interior shears against the crust → strong motion-parallax volume. The rigid armature (spokes +
  // nucleus) is pinned to +1× so the cage and core stay welded to the same ball as surface and words.
  let counter = mix(-0.55, 1.0, depth01);        // inner: reversed & 0.55×; crust: +1×
  let spinAng = F.mph.y * mix(counter, 1.0, isArm);
  let cs = cos(spinAng); let sn = sin(spinAng);
  var sd = vec3<f32>(d.x * cs + d.z * sn, d.y, -d.x * sn + d.z * cs);

  // PROJECTS SETTLE: as the timeline opens the globe calms to a MOON — a stable ~40% of lines
  // GENTLY organize toward their radial direction (a faint structuring of the chaos), but do NOT
  // sprout spokes: the reach below is near-zero so the silhouette stays a clean round ball (the
  // career now plots as the DOM ridgeline, not GPU rays). 'dial' gates it ⇒ identity on the mountain.
  // dR is the un-flowed radial ray out of the centre; co-rotate it by the same spin so the organized
  // lines ride the (now slow) ball. straightSel is reused below for the settle glow.
  let straightSel = step(0.60, fract(sseed * 13.0));
  let straightW   = smoothstep(0.0, 1.0, dial) * straightSel * 0.5;
  let dR  = normalize(mdir);
  let sdR = vec3<f32>(dR.x * cs + dR.z * sn, dR.y, -dR.x * sn + dR.z * cs);
  sd = normalize(mix(sd, sdR, straightW));

  // GIMBAL RINGS precess on their own axis, and the nucleus HALO sweeps slowly about Y — both keyed
  // off the sub-class flags, so they are identity (zero angle) for every other vertex. Frozen on
  // reduced motion (motion = 0).
  let prAng = (sseed - 0.95) * 2.0 * tt * 0.12 * motion * isRing; // per-ring signed precession
  let pc = cos(prAng); let ps = sin(prAng);
  sd = vec3<f32>(sd.x, sd.y * pc - sd.z * ps, sd.y * ps + sd.z * pc); // tip the ring plane through the viewer
  let ho = tt * 0.6 * isHalo * motion;           // halo: its own slow orbital spin about Y
  let hc = cos(ho); let hs = sin(ho);
  sd = vec3<f32>(sd.x * hc + sd.z * hs, sd.y, -sd.x * hs + sd.z * hc);

  // a WHISPER of tip reach / inner pull keeps the organized lines from looking dead-flat, but stays
  // tiny so the moon's silhouette stays round (the old 0.55 reach sprouted the radial dial spokes —
  // gone now that the career plots as the DOM ridgeline). Gate by (1 - drainPre) so this stretch and
  // the morph-collapse below never fight. at.x is t along the thread (0 inner → 1 tip). Clamp the radial
  // scale to a small positive so a deep inner end never crosses the centre (NaN-safe direction).
  let drainPre = clamp(smoothstep(0.06, 0.34, morph) * (1.4 - depth01 * 0.8), 0.0, 1.0);
  let reach = mix(0.0, 0.05, dial) * straightSel * (1.0 - drainPre);
  let pull  = mix(0.0, 0.04, dial) * straightSel * (1.0 - at.x) * (1.0 - drainPre);
  let rDial = max(pumpR + reach * at.x - pull, 0.01); // floor below the min pumpR (~0.0198) so it is a
  // no-op at dial=0 (home globe stays byte-identical), yet still keeps rDial positive once pull applies
  var world = F_GLOBE_C + F_GLOBE_R * rDial * sd;

  // ===== MORPH — the globe is not crossfaded out; it FUNNELS down the summit axis and is consumed
  // as the mountain rises through the converging streams. The axis x=0, z=8200 is BOTH the globe
  // centre and the summit axis (PEAK_X = GLOBE_C.x = 0, PEAK_Z = GLOBE_C.z = 8200), so the centre
  // literally becomes the peak. All of this lives inside the filament pass, which is skipped at
  // morph >= 0.72 (and every fade below terminates by 0.70), so the morph = 1 mountain is untouched.
  // DRAIN (0.12→0.45): collapse each vertex horizontally onto the axis at its own height — the
  // interior / near-core lines collapse first, the outer shell follows.
  let drainT = clamp(smoothstep(0.06, 0.34, morph) * (1.4 - clamp(at.w, 0.0, 1.0) * 0.8), 0.0, 1.0);
  world = mix(world, vec3<f32>(0.0, world.y, 8200.0), drainT);
  // POUR (0.32→0.66): the collapsed column now runs DOWN the summit axis and settles onto the
  // band the mountain occupies, so the streams visibly feed the rising peak instead of hanging
  // as a fixed-height pillar that just crossfades out — the literal "the centre becomes the
  // peak" gesture. isCore is EXCLUDED (the nucleus lifts to the apex below). The crust lands low
  // and the interior lands high → a sheet/waterfall rather than a spike. Saturates by 0.66, which
  // is < the 0.70 fade ceiling < the 0.72 draw gate, so morph = 1 (filament pass skipped) is
  // untouched. SIL_Y is the on-axis cone crest, a visual landing target only. No pow / no fwidth.
  let SIL_Y : f32 = 4422.0;
  let pourT = smoothstep(0.30, 0.62, morph) * (1.0 - isCore);
  // landing band kept LOW (≈970..2740) so every shell dissolves onto terrain that has actually
  // emerged by then — the summit crest (y→4422, key→1) emerges LAST, so pouring the deep/interior
  // shells up there would land them on still-black mesh (they'd read as draining into a void). The
  // crust lands lowest, the interior a touch higher → the sheet/waterfall spread is kept.
  let landY = mix(SIL_Y * 0.22, SIL_Y * 0.62, 1.0 - clamp(at.w, 0.0, 1.0));
  world = mix(world, vec3<f32>(0.0, landY, 8200.0), pourT);
  // NUCLEUS LIFT (0.30→0.62): the bright core rises up the axis to the summit seed (APEX =
  // 0,5230,8200 in RidgelineStage), handing off to the apex beacon that fades in at morph 0.85.
  let lift = smoothstep(0.36, 0.66, morph) * isCore;
  world = mix(world, vec3<f32>(0.0, 5230.0, 8200.0), lift);

  // per-vertex, drain-aware FADE (replaces the old flat globeFade): a line fades only AFTER it has
  // drained; inner / lower lines fade first, matching the terrain's bottom-up assembly so the web
  // reads as CONSUMED by the rising mountain. The nucleus holds until its lift completes. Max
  // (fadeStart + width) = 0.70 < the 0.72 draw gate → every vertex is provably gone first.
  var fadeStart = 0.46 + 0.09 * clamp(at.w, 0.0, 1.0);   // 0.46..0.55 — held LATER so a thread survives its descent and dissolves once the rock beneath it has emerged (was 0.30..0.46, which vanished mid-flight)
  fadeStart = mix(fadeStart, 0.55, isCore);               // nucleus unchanged at 0.55, continuous with the crust
  let globeFade = 1.0 - smoothstep(fadeStart, fadeStart + 0.15, morph); // MAX end = 0.55 + 0.15 = 0.70 (the existing ceiling, < the 0.72 draw gate)

  // ---- BRIGHTNESS — all computed here; the FS just emits it (additive over black). ----
  // DEPTH-DIM by frontness: the back of the ball recedes, the front reads crisp → real VOLUME
  // instead of a flat scribble. Uses the spun dir, so it tracks the rotation. NaN-safe: eye is far
  // from the (constant) centre, so the normalize argument is never zero.
  let frontness = 0.5 + 0.5 * dot(sd, normalize(F.eye.xyz - F_GLOBE_C));
  var glow = at.z;
  // TRAVELLING PULSE — a hot bead races along each line (charge flowing), faster as the drain begins.
  // Gaussians use a*a (NOT pow): pow(x, 2.0) NaNs for x < 0 in WGSL.
  let pSpeed = 0.55 * (1.0 + 3.0 * drainT);
  let p  = fract(tt * pSpeed + sseed);
  let pa = (0.5 - abs(fract(at.x - p) - 0.5)) * 14.0;        // wrapped distance to the pulse head
  let pulse = exp(-pa * pa);
  let ta = fract(at.x - p + 0.06) * 9.0;                     // a short comet afterglow trailing behind
  let tail = 0.42 * exp(-ta * ta);
  glow = glow * mix(1.0, 0.55 + 2.2 * (pulse + tail), motion);
  // CONVERGENCE VOLLEY: every ~3.3s a wave makes beads on ~1/3 of the curl threads rush to their node
  // end (at.x → 0) together → you repeatedly see sparks race inward and a node flare. Curl/mote-only
  // (1 - isArm), additive; q*q (never pow on a maybe-negative) keeps it NaN-safe.
  let inVolley = step(0.66, fract(sseed * 7.0));     // ~1/3 of threads join each volley
  let volley   = fract(tt * 0.30);                   // 0..1 every ~3.33s
  let q        = at.x - (1.0 - volley);              // bead racing toward the node end at.x = 0
  let conv     = exp(-q * q * 26.0);
  glow = glow + (1.0 - isArm) * inVolley * conv * 1.3 * motion;
  // NODE / RIM TWINKLE — scintillation, small amplitude to stay tasteful. The deep interior dust
  // (organic + small radial) glitters faster, so the volume sparkles as it counter-rotates.
  let dust = (1.0 - isArm) * (1.0 - smoothstep(0.18, 0.30, depth01)); // ~1 for deep motes / inner silk
  let tw = 0.86 + 0.14 * sin(tt * 3.0 + sseed * 40.0) + dust * 0.18 * sin(tt * 7.0 + sseed * 90.0);
  glow = glow * mix(1.0, tw, motion);
  // depth volume — widen the recession so the back of the deep tangle sinks further, and darken the
  // interior a touch vs the crust (a light-falloff cue that reads as a luminous WELL)
  glow = glow * mix(0.22, 1.14, frontness);
  glow = glow * mix(0.7, 1.0, depth01);
  // SPOKES FIRE OUTWARD — a wave that travels core→rim every few seconds (only for armature lines)
  let aw = (0.5 - abs(fract(tt * 0.4 - at.w) - 0.5)) * 8.0;
  let armWave = exp(-aw * aw);
  glow = mix(glow, glow * (0.5 + 2.0 * armWave), isArm * motion);
  // RING DASH SCROLL: a dash window marches around each gimbal ring (at.x = angle 0..1), each ring at
  // its own rate/direction (sseed), with a brighter head bead racing ahead — a calibrated "scale" cue.
  // mix-gated on isRing so it ONLY rewrites ring verts (spokes / silk / nucleus untouched).
  let rdir   = select(-1.0, 1.0, sseed > 0.95);
  let rrate  = (0.06 + 0.10 * sseed) * rdir;
  let scroll = fract(at.x + tt * rrate * motion + sseed);
  let cells  = fract(scroll * 16.0);                 // 16 dashes around the ring
  let dv     = 0.5 - abs(cells - 0.5);
  let dash   = smoothstep(0.19, 0.5, dv);            // ~0.62 duty
  let headP  = fract(tt * rrate * 4.0 * motion + sseed); // a hot head racing 4× the dash speed
  let hd     = (0.5 - abs(fract(at.x - headP) - 0.5)) * 18.0;
  let ringHead = exp(-hd * hd);
  glow = mix(glow, glow * (0.3 + 1.05 * dash) + ringHead * 1.4, isRing);
  // NUCLEUS SOMA GLOW — the core burns hot and throbs (additive, NOT depth-dimmed, so the heart
  // stays lit from any angle); the bloom pass lifts it into a luminous orb with no extra pass.
  let coreK = clamp((0.18 - at.w) / 0.18, 0.0, 1.0);
  let somaBeat = 0.8 + 0.2 * sin(tt * 1.15) * motion;
  glow = glow + coreK * coreK * 1.5 * somaBeat;        // was 2.6 → a softer, "glooming" core, no longer blown-out at the centre
  // FIRING WAVE — the instant the climb begins, a brightness wave discharges core→shell
  let fr = (at.w - clamp(morph * 2.4, 0.0, 1.4)) * 7.0;
  glow = glow * (1.0 + 0.9 * exp(-fr * fr));           // was 1.6 → calms the over-bright core at home (this term peaks at the centre when morph=0)

  // PROJECTS-DIAL FORMATION (req 6): as the dial opens the straightening armature IGNITES inner→outer
  // (a bead of light travels each ray) while the non-straightened silk RECEDES — the chaos resolves
  // into the organized rays. 'dial' gates it ⇒ identity on the mountain; (x*x) not pow (NaN-safe).
  let fw = (at.x - fract(tt * 0.5)) * 5.0;
  let formWave = exp(-fw * fw);
  glow = glow * mix(1.0, 0.45, dial * (1.0 - straightSel));
  glow = glow + straightSel * dial * (0.4 + 1.3 * formWave) * motion;

  var o : FOut;
  o.pos  = F.vp * vec4<f32>(world, 1.0);
  o.glow = glow * globeFade;
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
  // 4-tap rotated-box downsample of the 2× supersampled scene → clean hairlines
  var s = textureSample(sceneTex, samp, uv + vec2<f32>( 0.5,  0.5) * texel).rgb;
  s = s + textureSample(sceneTex, samp, uv + vec2<f32>(-0.5,  0.5) * texel).rgb;
  s = s + textureSample(sceneTex, samp, uv + vec2<f32>( 0.5, -0.5) * texel).rgb;
  s = s + textureSample(sceneTex, samp, uv + vec2<f32>(-0.5, -0.5) * texel).rgb;
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
    var b = textureSample(sceneTex, samp, uv + vec2<f32>( 1.0,  0.0) * blurR * texel).rgb;
    b = b + textureSample(sceneTex, samp, uv + vec2<f32>(-1.0,  0.0) * blurR * texel).rgb;
    b = b + textureSample(sceneTex, samp, uv + vec2<f32>( 0.0,  1.0) * blurR * texel).rgb;
    b = b + textureSample(sceneTex, samp, uv + vec2<f32>( 0.0, -1.0) * blurR * texel).rgb;
    b = b + textureSample(sceneTex, samp, uv + vec2<f32>( 0.7,  0.7) * blurR * texel).rgb;
    b = b + textureSample(sceneTex, samp, uv + vec2<f32>(-0.7,  0.7) * blurR * texel).rgb;
    b = b + textureSample(sceneTex, samp, uv + vec2<f32>( 0.7, -0.7) * blurR * texel).rgb;
    b = b + textureSample(sceneTex, samp, uv + vec2<f32>(-0.7, -0.7) * blurR * texel).rgb;
    col = mix(col, b * 0.125, edgeK * dof);
  }

  col = col + textureSample(bloomTex, samp, uv).rgb * F.post.x;   // snow glow
  col = col * F.post.w;                                           // exposure
  col = col / (1.0 + col * 0.55);                                 // soft shoulder

  // vignette — elliptical, pooling the corners to black like the reference (reuses the hoisted toC)
  let vig = dot(toC * vec2<f32>(1.06, 1.0), toC);
  col = col * (1.0 - F.post.y * smoothstep(0.16, 0.95, vig * 2.3));

  // a breath of animated grain so the blacks read as film, not flat void
  let g = hash12(uv * F.a.yz + fract(F.a.x) * 131.0) - 0.5;
  col = col + vec3<f32>(g * F.post.z);

  col = max(col, vec3<f32>(0.0));
  return vec4<f32>(col, 1.0);
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
  let c = textureSample(tex, samp, i.uv).rgb;
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
