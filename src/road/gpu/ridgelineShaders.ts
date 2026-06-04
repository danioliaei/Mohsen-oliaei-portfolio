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
  let cone   = exp(-rad * rad * 1.15);             // broad base flare / shoulders
  let sharp  = max(0.0, 1.0 - rad * 1.35);         // straight-sided SHARP apex
  // a sharp, clearly dominant triangular summit (cone) seated on a broad base
  var h = PEAK_H * (0.30 * cone + 1.00 * sharp);
  // ridged striations clad the faces AND texture the snow with fine erosion
  // gullies — kept moderate so the sharp apex always wins the silhouette, and
  // hugged to the massif so the foreground reads as calm flowing dunes
  let gate = smoothstep(0.06, 0.42, cone);
  let rg  = ridged(vec2<f32>(x * 0.00190, z * 0.00160) + vec2<f32>(13.0, 7.0));
  h = h + rg * 950.0 * gate;
  let rg2 = ridged(vec2<f32>(x * 0.00420, z * 0.00370) + vec2<f32>(29.0, 4.0));
  h = h + rg2 * 360.0 * gate;                      // fine snow / rock micro-texture
  let sh = fbm(vec2<f32>(x * 0.00045, z * 0.00050) + 3.0);
  h = h + (sh - 0.5) * 700.0 * gate;
  // a smooth, low, flowing dune plain flanking the peak (two soft octaves) — well
  // beneath the summit so black sky opens above and to the sides
  let plain  = fbm(vec2<f32>(x * 0.00050, z * 0.00060) + 21.0);
  let plain2 = fbm(vec2<f32>(x * 0.00026, z * 0.00030) + 81.0);
  h = h + plain * 240.0 + plain2 * 290.0;
  // two low, soft secondary ridges for natural company beside the main peak
  let s1 = exp(-((x + 5100.0) * (x + 5100.0) * 1.0 + (z - 6200.0) * (z - 6200.0) * 0.7) / 5.4e6);
  let s2 = exp(-((x - 5800.0) * (x - 5800.0) * 1.0 + (z - 11800.0) * (z - 11800.0) * 0.7) / 6.4e6);
  h = h + s1 * 620.0 + s2 * 560.0;
  // fine foreground ripples for the flowing near weave (gentle → calm dunes)
  let near = 1.0 - smoothstep(ZN, 5600.0, z);
  h = h + sin(x * 0.00130 + z * 0.00100) * 44.0 * near;
  h = h + fbm(vec2<f32>(x * 0.0017, z * 0.0020) + 5.0) * 60.0 * near;
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
  @location(0) wz  : f32,        // world depth → drives the scan-lines
  @location(1) wy  : f32,        // world height → snow / tone
  @location(2) nrm : vec3<f32>,
  @location(3) wpos : vec3<f32>,
};
@vertex fn vs(@location(0) uv : vec2<f32>) -> VsOut {
  let x = -XW + 2.0 * XW * uv.x;
  let z = ZN + (ZF - ZN) * uv.y;
  let y = heightAt(x, z);
  let world = vec3<f32>(x, y, z);
  var o : VsOut;
  o.pos = F.vp * vec4<f32>(world, 1.0);
  o.wz = z;
  o.wy = y;
  let e = 16.0;
  let hx = heightAt(x + e, z) - heightAt(x - e, z);
  let hz = heightAt(x, z + e) - heightAt(x, z - e);
  o.nrm = normalize(vec3<f32>(-hx / (2.0 * e), 1.0, -hz / (2.0 * e)));
  o.wpos = world;
  return o;
}
@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
  // ---- constant-depth iso-lines: the stacked horizontal profiles -----------
  let Z_STEP = 66.0;                          // world units between scan-lines
  let f = i.wz / Z_STEP;
  let dist = 0.5 - abs(fract(f) - 0.5);       // 0 on a line, 0.5 between
  let aa = max(fwidth(f), 1e-5);
  var line = 1.0 - smoothstep(0.0, aa * 1.25, dist);
  // where the projected lines pack tighter than the pixel grid, dissolve them so
  // far/steep faces read as smooth tone instead of a buzzing moiré (eased so the
  // dense snowy summit keeps most of its strokes)
  line = line * (1.0 - smoothstep(0.48, 1.10, aa));

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
  let lineLum = mix(rockBright, 1.02, snow);
  var lum = lineLum * line + rim * 0.50;       // + luminous ridge silhouettes

  // a luminous snowFIELD wash so the summit reads as a bright solid mass that the
  // fine darker striations sit on — the inverse of the dark-rock / bright-line
  // lower slopes, exactly as in the reference still (kept under full white so the
  // erosion texture still reads on the snow rather than blowing out)
  let snowFill = snow * snow * (0.24 + 0.46 * diff);
  let c = vec3<f32>(lum + snowFill);
  return vec4<f32>(c, 1.0);                     // opaque → writes depth, occludes
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
