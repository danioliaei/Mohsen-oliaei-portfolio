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
   the summit. No road / factory / embers / warm grade — this is a separate look.
   ========================================================================= */

/** Shared per-frame uniform block. Field order MUST match ridgeline.ts's writer. */
export const RIDGE_FRAME_WGSL = /* wgsl */ `
struct Frame {
  vp   : mat4x4<f32>,
  a    : vec4<f32>,   // x time, y Wpx(render), z Hpx(render), w aspect
  b    : vec4<f32>,   // x zNear, y zFar, z worldHeightMax, w haloSpin
  post : vec4<f32>,   // x bloomAmt, y vignette, z grain, w exposure
  eye  : vec4<f32>,   // xyz camera eye (world), w unused
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
  h = h + gully2 * 195.0 * gate;                   // finer micro-texture

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
  let ring = 1.0 - smoothstep(0.0, raa * 1.5, rd);

  // tangential dashes whose count scales with radius → near-constant arc length,
  // i.e. a field of small dots marching around each ring (the radar / vinyl look)
  let phase = ang * r * 130.0;
  let dotWave = 0.5 + 0.5 * cos(phase * TWO_PI);
  let dots = smoothstep(0.16, 0.60, dotWave);

  // radial envelope — a broad, bold halo band that fades in from the centre and
  // out to the rim, so the dotted texture glows as a large disc behind the peak
  let env = smoothstep(0.035, 0.14, r) * (1.0 - smoothstep(0.42, 0.66, r));

  // one crisp defined circle near the inner edge (the bright ring hugging the peak)
  let circ = (1.0 - smoothstep(0.0, raa * 2.2, abs(rings - 8.4))) * smoothstep(0.0, 0.02, r);

  let halo = ring * dots * env * 0.66 + circ * 0.58 + env * dots * 0.07;
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
struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) wy  : f32,        // world height → snow / tone
  @location(1) nrm : vec3<f32>,
  @location(2) wpos : vec3<f32>, // world position → terrain-locked scan-lines + shading
};
@vertex fn vs(@location(0) uv : vec2<f32>) -> VsOut {
  let x = -XW + 2.0 * XW * uv.x;
  let z = ZN + (ZF - ZN) * uv.y;
  let y = heightAt(x, z);
  let world = vec3<f32>(x, y, z);
  var o : VsOut;
  o.pos = F.vp * vec4<f32>(world, 1.0);
  o.wy = y;
  let e = 16.0;
  let hx = heightAt(x + e, z) - heightAt(x - e, z);
  let hz = heightAt(x, z + e) - heightAt(x, z - e);
  o.nrm = normalize(vec3<f32>(-hx / (2.0 * e), 1.0, -hz / (2.0 * e)));
  o.wpos = world;
  return o;
}
@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
  // ---- base hairlines: constant-DEPTH iso-lines (the stacked horizontal weave) -
  // UNCHANGED in direction — keyed to world Z, a FIXED plane in the terrain, so the
  // signature stacked profiles stay painted on the surface and glued to the same
  // ground as the camera orbits. These are the quiet texture the survey RINGS are
  // cut across (head-on they read as horizontal bands; from the flank, obliquely).
  let Z_STEP = 66.0;                          // world units between scan-lines
  let f = i.wpos.z / Z_STEP;
  let dist = 0.5 - abs(fract(f) - 0.5);       // 0 on a line, 0.5 between
  let aa = max(fwidth(f), 1e-5);
  var hair = 1.0 - smoothstep(0.0, aa * 1.25, dist);
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
  // bend and pinch but never cross. Keep RINGS in sync with RING_RADII (ridgeline.ts).
  let dxp = i.wpos.x - PEAK_X;
  let dzp = i.wpos.z - PEAK_Z;
  // the height field's own anisotropy (a touch wider in depth) so the rings are the
  // mountain's planted ellipses, not perfect circles laid on top
  let baseR = sqrt(dxp * dxp * 1.05 + dzp * dzp * 0.58);
  let warp = (fbm(vec2<f32>(i.wpos.x * 0.00026, i.wpos.z * 0.00023) + 47.0) - 0.5) * 980.0
           + (fbm(vec2<f32>(i.wpos.x * 0.00090, i.wpos.z * 0.00078) + 12.0) - 0.5) * 210.0;
  let rw = baseR + warp;
  // screen-space line AA: the distance to each ring is measured in PIXELS (world
  // delta ÷ per-pixel gradient), with the gradient clamped so a near-silhouette fold
  // fades the line out cleanly instead of smearing it into a fat blur. With only
  // seven well-separated rings there is no moiré to fight, so — unlike the dense
  // hairlines — the rings are NEVER dissolved: each stays a continuous unbroken loop
  // wrapping the massif, thinning only where its slope turns edge-on to the eye.
  let aaR = clamp(fwidth(rw), 1e-4, 100.0);
  var RINGS = array<f32, 7>(720.0, 1300.0, 1980.0, 2750.0, 3600.0, 4550.0, 5600.0);
  var ring = 0.0;
  var moat = 0.0;
  for (var k = 0; k < 7; k = k + 1) {
    let dPix = abs(rw - RINGS[k]) / aaR;                  // distance to this ring, in px
    ring = max(ring, 1.0 - smoothstep(1.6, 3.2, dPix));   // ~3 px bold survey stroke
    moat = max(moat, 1.0 - smoothstep(3.2, 10.0, dPix));  // its flanking dark band
  }
  // each ring clears a dark band of breathing room out of the hairline weave on its
  // flanks (the survey "moat"), so the bright cut is bracketed by black and can't be
  // mistaken for one more hairline — the contrast that lets it read as a ring
  hair = hair * (1.0 - 0.9 * clamp(moat - ring, 0.0, 1.0));

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
  var c = lum + snowFill;                          // the base surface

  // ---- the seven SURVEY RINGS as a bold high-contrast cut ------------------
  // luminous on the dark rock / dune (riding above the bloom line so it glows) and
  // an incised DARK line where it crosses the bright snow — so each contour reads
  // on every part of the massif instead of dissolving into a matching tone. This
  // is the same dark-on-snow / bright-on-rock inversion the weave already uses.
  let ringTone = mix(2.05, 0.02, snow);
  c = mix(c, ringTone, ring);
  return vec4<f32>(vec3<f32>(c), 1.0);                     // opaque → writes depth, occludes
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

  col = col + textureSample(bloomTex, samp, uv).rgb * F.post.x;   // snow glow
  col = col * F.post.w;                                           // exposure
  col = col / (1.0 + col * 0.55);                                 // soft shoulder

  // vignette — elliptical, pooling the corners to black like the reference
  let toC = uv - vec2<f32>(0.5, 0.5);
  let vig = dot(toC * vec2<f32>(1.06, 1.0), toC);
  col = col * (1.0 - F.post.y * smoothstep(0.16, 0.95, vig * 2.3));

  // a breath of animated grain so the blacks read as film, not flat void
  let g = hash12(uv * F.a.yz + fract(F.a.x) * 131.0) - 0.5;
  col = col + vec3<f32>(g * F.post.z);

  col = max(col, vec3<f32>(0.0));
  return vec4<f32>(col, 1.0);
}
`;
