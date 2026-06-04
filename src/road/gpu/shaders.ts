/* =========================================================================
   WGSL shaders for the WebGPU homepage renderer.

   The scene is drawn into a linear HDR target (rgba16float):
     1. SKY        — warm dusk gradient + sun bloom behind the vanishing point
     2. TERRAIN    — displaced contour mesh, analytic iso-lines, aerial perspective
     3. ROAD       — emissive fibre ribbon with a travelling data-pulse
     4. EMBERS     — instanced motes drifting toward the camera (volumetric depth)
     5. WAYPOINTS  — instanced glints at the career stations
   then resolved to the swap-chain by the post chain:
     BRIGHT → BLUR → (bloom) , DOWNSAMPLE → BLUR → (DoF) , COMPOSITE (tone-map).

   Every pass shares the `Frame` uniform so the GPU land and the overlays move
   on one camera. The height field is the exact twin of engine.ts / gl.ts.
   ========================================================================= */

/** Shared per-frame uniform block. Field order MUST match scene.ts's writer. */
export const FRAME_WGSL = /* wgsl */ `
struct Frame {
  vp   : mat4x4<f32>,
  cam  : vec4<f32>,   // x camX, y camZ, z time, w speed(0..1)
  res  : vec4<f32>,   // x W, y H (render px), z sc, w dpr
  geo  : vec4<f32>,   // x lensX, y near(world z), z far(world z), w halfW
  cont : vec4<f32>,   // x lMin, y lStep, z focusY, w focusH
  post : vec4<f32>,   // x feather, y vignette, z grain, w exposure
  vp2  : vec4<f32>,   // x vpU, y vpV, z haloGlow, w haloR
  misc : vec4<f32>,   // x bloomAmt, y caAmt, z dofMax, w eyeY
};
@group(0) @binding(0) var<uniform> F : Frame;
`;

/** The terrain height field — identical maths to engine.ts surfaceY(). */
export const FIELD_WGSL = /* wgsl */ `
const VIEW_DEPTH : f32 = 13000.0;
// EXACT twin of LAT() in engine.ts — the terrain corridor is lowered along this
// line, so the road (which rides LAT) sits in the trough. Keep the two in lockstep.
fn latz(z : f32) -> f32 {
  return 1180.0 * sin(z * 0.00017 + 0.4)
       + 680.0 * sin(z * 0.00049 + 1.6)
       + 320.0 * sin(z * 0.00094 + 0.5);
}
fn organic(x : f32, z : f32) -> f32 {
  let wx = x + 760.0 * sin(z * 0.00042 + 0.3) + 420.0 * sin(z * 0.00097 + 2.1);
  let wz = z + 760.0 * sin(x * 0.00038 + 1.7) + 420.0 * sin(x * 0.00091 + 0.4);
  return 900.0 * sin(wx * 0.00115 + wz * 0.00080)
       + 520.0 * sin(wz * 0.00175 - wx * 0.00135 + 1.3)
       + 300.0 * sin(wx * 0.00255 + wz * 0.00210 + 0.6)
       + 175.0 * sin(wz * 0.00360 + wx * 0.00330 + 2.1)
       + 100.0 * sin(wx * 0.00470 - wz * 0.00430 + 0.9);
}
fn roadFloor(z : f32) -> f32 {
  return 520.0 * sin(z * 0.00012 + 0.5) + 240.0 * sin(z * 0.00026 + 2.1);
}
fn terrainH(x : f32, z : f32) -> f32 {
  let d = abs(x - latz(z));
  let t = 0.12 + 0.88 * smoothstep(120.0, 1300.0, d);
  return roadFloor(z) * (1.0 - t) + organic(x, z) * t;
}
`;

/* ---------------------------------------------------------------- SKY ----- */
export const SKY_WGSL = FRAME_WGSL + /* wgsl */ `
struct VsOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vid : u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
  var o : VsOut;
  let xy = p[vid];
  o.pos = vec4<f32>(xy, 0.0, 1.0);
  o.uv = vec2<f32>(xy.x * 0.5 + 0.5, 1.0 - (xy.y * 0.5 + 0.5));
  return o;
}
@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
  let uv = i.uv;
  let horizon = 0.28;
  // a thin bright golden band sits at the horizon; the sky deepens to umber
  // ABOVE it, and the land region BELOW falls quickly into a deep warm dusk so
  // the luminous contour lines read against dark ground (the reference look)
  let aboveT = smoothstep(0.0, horizon, uv.y);       // 0 top .. 1 horizon
  let belowT = smoothstep(horizon, 0.96, uv.y);      // 0 horizon .. 1 lower frame
  let skyTop = vec3<f32>(0.250, 0.128, 0.072);       // deeper, richer dusk top
  let gold   = vec3<f32>(0.94, 0.61, 0.27);          // warm horizon band, less blown
  let valley = vec3<f32>(0.072, 0.052, 0.042);       // deeper warm floor
  var col = mix(skyTop, gold, aboveT);
  col = mix(col, valley, belowT);
  // sun bloom seated behind the vanishing point — a focused glow, not a broad wash
  let sun = vec2<f32>(F.vp2.x, horizon);
  let dd = (uv - sun) * vec2<f32>(1.0, 1.7);
  let glow = exp(-dot(dd, dd) * 9.0);
  col += vec3<f32>(1.0, 0.72, 0.36) * glow * 0.55;
  return vec4<f32>(col, 1.0);
}
`;

/* ------------------------------------------------------------ TERRAIN ----- */
export const TERRAIN_WGSL = FRAME_WGSL + FIELD_WGSL + /* wgsl */ `
struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) relief : f32,
  @location(1) depthT : f32,
  @location(2) nrm : vec3<f32>,
  @location(3) world : f32,
};
@vertex fn vs(@location(0) aUV : vec2<f32>) -> VsOut {
  let halfW = F.geo.w;
  let near = F.geo.y;
  let far = F.geo.z;
  let x = F.cam.x - halfW + 2.0 * halfW * aUV.x;
  let tz = aUV.y;
  let z = near + (far - near) * (tz * tz * 0.62 + tz * 0.38);
  let y = terrainH(x, z);
  var clip = F.vp * vec4<f32>(x, y, z, 1.0);
  clip.x += (F.geo.x - 0.5) * 2.0 * clip.w;       // lateral lens shift
  var o : VsOut;
  o.pos = clip;
  o.relief = y;
  o.depthT = clamp((z - F.cam.y) / VIEW_DEPTH, 0.0, 1.0);
  let e = 7.0;
  let hx = terrainH(x + e, z) - terrainH(x - e, z);
  let hz = terrainH(x, z + e) - terrainH(x, z - e);
  o.nrm = normalize(vec3<f32>(-hx / (2.0 * e), 1.0, -hz / (2.0 * e)));
  o.world = x;
  return o;
}
@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
  let t = i.depthT;
  // analytic iso-line distance in pixels (screen-space derivatives)
  let f = (i.relief - F.cont.x) / F.cont.y;
  let d = 0.5 - abs(fract(f) - 0.5);
  let w = max(fwidth(f), 1e-4);
  let dpx = d / w;
  // thin, delicate iso-lines: a crisp narrow core with only a whisper of halo,
  // so the contours read as fine graceful pen-strokes rather than heavy ribbons
  let core = 1.0 - smoothstep(0.0, 0.58, dpx);
  let halo = exp(-dpx * dpx / 4.0);
  var line = clamp(core + halo * 0.12, 0.0, 1.0);
  line = line * (1.0 - smoothstep(0.40, 1.05, w));  // de-alias over-packed lines

  var fade = 1.0;
  if (t >= 0.74) { fade = max(0.0, 1.0 - (t - 0.74) / 0.26); }

  let nrm = normalize(i.nrm);
  let L = normalize(vec3<f32>(-0.45, 0.80, -0.34));
  let diff = clamp(dot(nrm, L), 0.0, 1.0);
  let lit = 0.42 + 0.58 * diff;
  let V = normalize(vec3<f32>(0.0, 0.58, -0.82));
  let Hh = normalize(L + V);
  let spec = pow(clamp(dot(nrm, Hh), 0.0, 1.0), 9.0);

  let shade = 0.30 + 0.70 * diff;
  // warm sunlit slopes, a deep clean blue-teal in the shadowed troughs → real
  // colour depth and a genuinely DARK ground for the contour lines to glow on.
  let warmBase = vec3<f32>(0.150, 0.099, 0.058);
  let coolBase = vec3<f32>(0.028, 0.042, 0.055);
  let baseCol = mix(coolBase, warmBase, shade) * (0.58 + 1.05 * shade);
  // OPAQUE ground (was a near-transparent 0.16–0.36, which let the bright golden
  // sky flood through the whole lower frame as a milky haze). Only the far reaches
  // fade out, so distant hills melt into the dusk sky as honest aerial perspective.
  let baseA = (0.88 + 0.12 * diff) * fade;

  // slow shimmer travelling through the lines — the land reads as alive/digital
  let shimmer = 0.86 + 0.14 * sin(F.cam.z * 0.8 + i.relief * 0.004 + i.world * 0.0003);
  let warm = vec3<f32>(1.0, (253.0 - t * 12.0) / 255.0, (251.0 - t * 34.0) / 255.0);  // near-white, barely warms with depth
  let emis = (0.90 + 0.64 * core) * shimmer;         // thin but crisp & white-bright
  let lineCol = warm * (lit + 0.4 * spec) * emis;
  let lineA = line * (0.56 + 0.40 * fade) * (0.74 + 0.4 * lit);

  let col = mix(baseCol, lineCol, line);
  let a = max(baseA, lineA);
  return vec4<f32>(col, a);
}
`;

/* --------------------------------------------------------------- ROAD ----- */
/* The career road as an emissive fibre ribbon. Geometry (a static triangle
   strip following the centreline) is built CPU-side; here we light it with a
   bright HDR core + a data-pulse that travels toward the horizon, so the bloom
   pass turns it into a glowing fibre threading the valley. */
export const ROAD_WGSL = FRAME_WGSL + /* wgsl */ `
const VIEW_DEPTH : f32 = 13000.0;
struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) side : f32,
  @location(1) arc : f32,
  @location(2) wz : f32,
};
@vertex fn vs(@location(0) p : vec3<f32>, @location(1) sa : vec2<f32>) -> VsOut {
  var clip = F.vp * vec4<f32>(p, 1.0);
  clip.x += (F.geo.x - 0.5) * 2.0 * clip.w;
  var o : VsOut;
  o.pos = clip;
  o.side = sa.x;
  o.arc = sa.y;
  o.wz = p.z;
  return o;
}
@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
  let edge = 1.0 - abs(i.side);                 // 1 centre .. 0 rim
  let body = smoothstep(0.0, 0.5, edge);        // clean, soft-edged body
  let core = smoothstep(0.42, 1.0, edge);       // luminous inner core
  let seam = smoothstep(0.88, 1.0, edge);       // crisp bright centre seam
  // a gentle band of light gliding toward the horizon — calm, not blinking
  let ph = i.arc * 0.00055 - F.cam.z * 1.0;
  let pulse = exp(-pow(fract(ph) - 0.5, 2.0) * 8.0);
  let flow = 0.6 + 0.4 * sin(i.arc * 0.011 - F.cam.z * 2.0);
  let t = clamp((i.wz - F.cam.y) / VIEW_DEPTH, 0.0, 1.0);
  let fade = 1.0 - smoothstep(0.74, 1.0, t);
  let amber = vec3<f32>(1.0, 0.55, 0.20);       // refined amber rim
  let gold  = vec3<f32>(1.0, 0.80, 0.48);       // warm gold mid
  let white = vec3<f32>(1.0, 0.98, 0.92);       // near-white seam
  var col = mix(amber, gold, core);
  col = mix(col, white, seam);
  col *= (0.85 + 1.7 * core + 1.5 * seam);      // HDR core feeds the bloom
  col += gold * pulse * (0.35 + 0.55 * core);   // soft travelling glow
  col *= (0.88 + 0.12 * flow);
  let a = body * fade;
  return vec4<f32>(col * a, a);                 // additive emission
}
`;

/* ------------------------------------------------------------- EMBERS ----- */
/* Instanced motes that stream through the valley toward the camera. Placement
   is fully procedural from the instance index, anchored to the camera, so the
   field is effectively infinite and parallaxes correctly — the strongest cue
   that you are MOVING through the world. Drawn additively; depth-tested so motes
   behind a near ridge are hidden. */
export const EMBER_WGSL = FRAME_WGSL + /* wgsl */ `
const NEAR_E : f32 = -800.0;
const FAR_E  : f32 = 10500.0;
const SPREAD : f32 = 5200.0;
const LIFE   : f32 = 9.0;
fn hash3(p : f32) -> vec3<f32> {
  var q = fract(vec3<f32>(p * 0.1031, p * 0.1030, p * 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xxy + q.yzz) * q.zyx);
}
struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) local : vec2<f32>,
  @location(1) tint : f32,
  @location(2) glow : f32,
};
@vertex fn vs(@builtin(vertex_index) vid : u32, @builtin(instance_index) iid : u32) -> VsOut {
  var quad = array<vec2<f32>, 6>(
    vec2<f32>(-1.0,-1.0), vec2<f32>(1.0,-1.0), vec2<f32>(-1.0,1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0,-1.0), vec2<f32>( 1.0,1.0));
  let r = hash3(f32(iid) + 1.0);
  let r2 = hash3(f32(iid) + 97.3);
  // travel 0..1 (recycles); nearer as it grows
  let tloc = fract(r.z + F.cam.z / LIFE + r2.x * 0.5);
  let zoff = mix(FAR_E, NEAR_E, tloc);
  let sway = sin(F.cam.z * (0.4 + r2.y) + r.x * 6.28) * 120.0;
  let xoff = (r.x - 0.5) * SPREAD + sway;
  let yoff = F.misc.w - 520.0 + r.y * 1500.0 + tloc * 360.0;
  let world = vec3<f32>(F.cam.x + xoff, yoff, F.cam.y + zoff);

  var clip = F.vp * vec4<f32>(world, 1.0);
  clip.x += (F.geo.x - 0.5) * 2.0 * clip.w;
  // near-edge / far-edge fade + twinkle → no pop on recycle
  let edge = smoothstep(0.0, 0.12, tloc) * (1.0 - smoothstep(0.86, 1.0, tloc));
  let twink = 0.5 + 0.5 * sin(F.cam.z * (2.0 + r2.z * 3.0) + r.y * 6.28);
  let sizePx = (4.0 + r2.z * 9.0) * (0.45 + 0.55 * tloc);
  let q = quad[vid];
  clip.x += q.x * (sizePx / (F.res.x * 0.5)) * clip.w;
  clip.y += q.y * (sizePx / (F.res.y * 0.5)) * clip.w;
  var o : VsOut;
  o.pos = clip;
  o.local = q;
  o.tint = r2.y;
  o.glow = edge * (0.35 + 0.65 * twink);
  return o;
}
@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
  let d = dot(i.local, i.local);
  let fall = exp(-d * 3.2);                 // soft round glow
  let hot = vec3<f32>(1.0, 0.86, 0.55);
  let warm = vec3<f32>(1.0, 0.55, 0.22);
  let col = mix(warm, hot, i.tint) * fall * i.glow * 1.6;
  return vec4<f32>(col, fall * i.glow);
}
`;

/* ---------------------------------------------------------- WAYPOINTS ----- */
/* A glowing navigation glint at each career station, kind-tinted, brightening
   as the camera arrives. Positions are static (storage buffer); visibility is
   derived from the camera depth in the shader. */
export const WAYPOINT_WGSL = FRAME_WGSL + /* wgsl */ `
const VIEW_DEPTH : f32 = 13000.0;
struct WP { pos : vec4<f32>, col : vec4<f32> };
@group(0) @binding(1) var<storage, read> wps : array<WP>;
struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) local : vec2<f32>,
  @location(1) col : vec3<f32>,
  @location(2) a : f32,
};
@vertex fn vs(@builtin(vertex_index) vid : u32, @builtin(instance_index) iid : u32) -> VsOut {
  var quad = array<vec2<f32>, 6>(
    vec2<f32>(-1.0,-1.0), vec2<f32>(1.0,-1.0), vec2<f32>(-1.0,1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0,-1.0), vec2<f32>( 1.0,1.0));
  let wp = wps[iid];
  let ahead = wp.pos.z - F.cam.y;
  let vis = smoothstep(60.0, 1500.0, ahead) * (1.0 - smoothstep(VIEW_DEPTH * 0.72, VIEW_DEPTH, ahead));
  let prox = 1.0 - clamp(abs(ahead - 1300.0) / 2600.0, 0.0, 1.0);
  var o : VsOut;
  o.col = wp.col.rgb;
  if (vis <= 0.002) { o.pos = vec4<f32>(0.0, 0.0, -2.0, 1.0); o.local = vec2<f32>(0.0); o.a = 0.0; return o; }
  var clip = F.vp * vec4<f32>(wp.pos.xyz, 1.0);
  clip.x += (F.geo.x - 0.5) * 2.0 * clip.w;
  let pulse = 0.9 + 0.1 * sin(F.cam.z * 2.2 + f32(iid));
  let sizePx = (7.0 + prox * 17.0) * pulse;
  let q = quad[vid];
  clip.x += q.x * (sizePx / (F.res.x * 0.5)) * clip.w;
  clip.y += q.y * (sizePx / (F.res.y * 0.5)) * clip.w;
  o.pos = clip;
  o.local = q;
  o.a = vis * (0.32 + 0.68 * prox);
  return o;
}
@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
  let r = length(i.local);
  let core = exp(-r * r * 5.5);
  let ring = smoothstep(0.74, 0.9, r) * (1.0 - smoothstep(0.9, 1.05, r));
  let inten = core * 1.7 + ring * 1.0;
  return vec4<f32>(i.col * inten * i.a, inten * i.a);
}
`;

/* ---------------------------------------------------------- CONNECTOR ----- */
/* A fine glowing line from the active waypoint to the floating card. Endpoints
   arrive each frame in NDC; drawn as a soft-edged quad over the composite. */
export const CONNECTOR_WGSL = /* wgsl */ `
struct Conn { p : vec4<f32>, c : vec4<f32>, aspect : vec4<f32> };
@group(0) @binding(0) var<uniform> C : Conn;
struct VsOut { @builtin(position) pos : vec4<f32>, @location(0) s : f32, @location(1) t : f32 };
@vertex fn vs(@builtin(vertex_index) vid : u32) -> VsOut {
  var ts = array<vec2<f32>, 6>(
    vec2<f32>(0.0,-1.0), vec2<f32>(1.0,-1.0), vec2<f32>(0.0,1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0,-1.0), vec2<f32>(1.0,1.0));
  let a = C.p.xy;
  let b = C.p.zw;
  let asp = C.aspect.x;
  // direction in pixel space (correct aspect) so the width is uniform
  var dir = normalize((b - a) * vec2<f32>(asp, 1.0));
  let nrm = vec2<f32>(-dir.y, dir.x) / vec2<f32>(asp, 1.0);
  let halfw = C.aspect.y;
  let e = ts[vid];
  let mid = mix(a, b, e.x);
  var o : VsOut;
  o.pos = vec4<f32>(mid + nrm * e.y * halfw, 0.0, 1.0);
  o.s = e.y;
  o.t = e.x;
  return o;
}
@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
  let edge = 1.0 - abs(i.s);
  let core = smoothstep(0.0, 1.0, edge);
  // taper the ends; the card end glows a touch brighter (the attach point)
  let ends = smoothstep(0.0, 0.05, i.t) * (1.0 - smoothstep(0.97, 1.0, i.t));
  let attach = 1.0 + 0.8 * smoothstep(0.8, 1.0, i.t);
  let glow = (core * 0.7 + pow(core, 3.0) * 1.1) * ends * attach;
  let white = mix(C.c.rgb, vec3<f32>(1.0, 0.97, 0.9), pow(core, 6.0) * 0.6);
  return vec4<f32>(white * glow * C.c.a, glow * C.c.a);
}
`;

/* --------------------------------------------------- POST: BRIGHT/BLUR ---- */
/* Shared by the bloom + tilt-shift-DoF half-resolution chain. PassU packs the
   target texel size, the (unit) blur direction, and a spread/threshold param. */
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

/* ---------------------------------------------------------- COMPOSITE ----- */
/* Tone-maps the HDR scene to the swap-chain. Bloom + DoF inputs are folded in
   once those passes exist; for now it grades + tonemaps the single HDR target. */
export const COMPOSITE_WGSL = FRAME_WGSL + /* wgsl */ `
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var sceneTex : texture_2d<f32>;
@group(0) @binding(3) var bloomTex : texture_2d<f32>;
@group(0) @binding(4) var dofTex   : texture_2d<f32>;

struct VsOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vid : u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
  var o : VsOut;
  let xy = p[vid];
  o.pos = vec4<f32>(xy, 0.0, 1.0);
  o.uv = vec2<f32>(xy.x * 0.5 + 0.5, 1.0 - (xy.y * 0.5 + 0.5));
  return o;
}

// ACES filmic tone-map (Narkowicz approximation)
fn aces(x : vec3<f32>) -> vec3<f32> {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

// hash for animated film grain
fn hash12(p : vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn focusBlend(uv : vec2<f32>) -> f32 {
  // tilt-shift: 0 sharp in the focal band, 1 fully blurred above & below
  let cy = F.cont.z;
  let core = F.cont.w;
  let fth = max(0.001, F.post.x);
  let dy = abs(uv.y - cy);
  return smoothstep(core, core + fth, dy);
}

@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
  let uv = i.uv;
  // chromatic aberration grows toward the frame edge (lens character)
  let toC = uv - vec2<f32>(0.5, 0.52);
  let r2 = dot(toC, toC);
  let ca = F.misc.y * r2;
  let dofT = focusBlend(uv);

  // sharp + DoF-blurred scene, mixed by the tilt-shift band, with CA on RGB
  var sharp : vec3<f32>;
  sharp.r = textureSample(sceneTex, samp, uv - toC * ca).r;
  sharp.g = textureSample(sceneTex, samp, uv).g;
  sharp.b = textureSample(sceneTex, samp, uv + toC * ca).b;
  let blurred = textureSample(dofTex, samp, uv).rgb;
  var col = mix(sharp, blurred, dofT);

  // additive bloom
  col += textureSample(bloomTex, samp, uv).rgb * F.misc.x;

  // god-ray halo seated at the vanishing point (the destination glow)
  let vp = vec2<f32>(F.vp2.x, F.vp2.y);
  let dvp = (uv - vp) * vec2<f32>(F.res.x / F.res.y, 1.0);
  col += vec3<f32>(1.0, 0.74, 0.40) * F.vp2.z * exp(-dot(dvp, dvp) / max(1e-4, F.vp2.w));

  // exposure + tone-map
  col = aces(col * F.post.w);

  // colour grade — gentle saturation lift + restored contrast so the luminous
  // contours and fibre road read crisply against a deep, honest dusk ground
  // (the old grade flattened everything into one milky golden wash).
  let luma = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
  col = mix(vec3<f32>(luma), col, 1.16);       // gentle colour pop
  col = (col - 0.5) * 1.06 + 0.5;              // contrast — punchy darks, no haze
  col = max(col, vec3<f32>(0.0));

  // vignette — elliptical so top/bottom stay open, only corners darken
  let vigC = toC * vec2<f32>(1.0, 0.45);
  let vigR = dot(vigC, vigC);
  col *= 1.0 - F.post.y * smoothstep(0.25, 1.25, vigR * 2.2);

  // animated film grain (kept very subtle)
  let g = hash12(uv * F.res.xy + fract(F.cam.z) * 311.0) - 0.5;
  col += g * F.post.z;

  return vec4<f32>(col, 1.0);
}
`;
