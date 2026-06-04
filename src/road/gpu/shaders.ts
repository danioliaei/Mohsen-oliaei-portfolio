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
// Stegra terrace — EXACT twin of TERRACE + terraceMask() in engine.ts. The plant
// stands on a flat platform graded into the hills; the contour lines wrap the
// embankment slopes as engineered earthworks. Mirror any change in engine.ts.
const TC_X : f32 = -2667.0;
const TC_Z : f32 = 21080.0;
const TC_Y : f32 = 560.0;
const TC_HW : f32 = 860.0;
const TC_HD : f32 = 1000.0;
const TC_R : f32 = 230.0;
const TC_EMB : f32 = 440.0;
fn terraceMask(x : f32, z : f32) -> f32 {
  let qx = abs(x - TC_X) - (TC_HW - TC_R);
  let qz = abs(z - TC_Z) - (TC_HD - TC_R);
  let o = vec2<f32>(max(qx, 0.0), max(qz, 0.0));
  let sd = length(o) + min(max(qx, qz), 0.0) - TC_R;
  return 1.0 - smoothstep(0.0, TC_EMB, sd);
}
fn terrainH(x : f32, z : f32) -> f32 {
  let d = abs(x - latz(z));
  let t = 0.12 + 0.88 * smoothstep(120.0, 1300.0, d);
  let natural = roadFloor(z) * (1.0 - t) + organic(x, z) * t;
  let m = terraceMask(x, z);
  return natural * (1.0 - m) + TC_Y * m;
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
  @location(4) edge : f32,
};
@vertex fn vs(@location(0) aUV : vec2<f32>) -> VsOut {
  let halfW = F.geo.w;
  let near = F.geo.y;
  let far = F.geo.z;
  let x = F.cam.x - halfW + 2.0 * halfW * aUV.x;
  let tz = aUV.y;
  // milder near-bias than before: the near edge now sits far behind the camera
  // (deep blurred foreground), so we don't want it hoarding mesh rows — keep the
  // density spread toward the sharp focal band rather than piled up at tz=0.
  let z = near + (far - near) * (tz * tz * 0.40 + tz * 0.60);
  let y = terrainH(x, z);
  var clip = F.vp * vec4<f32>(x, y, z, 1.0);
  clip.x += (F.geo.x - 0.5) * 2.0 * clip.w;       // lateral lens shift
  var o : VsOut;
  o.pos = clip;
  o.relief = y;
  o.depthT = clamp((z - F.cam.y) / VIEW_DEPTH, 0.0, 1.0);
  // soft mesh-boundary mask: dissolve the lateral edges and the near edge into
  // the dusk so the rotated patch never shows a hard straight cut on-screen. The
  // far edge keeps its own aerial-perspective fade (depthT), so it's left at 1.
  let exq = min(aUV.x, 1.0 - aUV.x);
  o.edge = smoothstep(0.0, 0.055, exq) * smoothstep(0.0, 0.04, aUV.y);
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
  // delicate hairline iso-lines: a thin core with only the faintest halo, so the
  // contours read as quiet survey strokes rather than a dense, bright tangle
  let core = 1.0 - smoothstep(0.0, 0.55, dpx);
  let halo = exp(-dpx * dpx / 3.0);
  var line = clamp(core + halo * 0.08, 0.0, 1.0);
  line = line * (1.0 - smoothstep(0.34, 0.95, w));  // de-alias over-packed lines sooner

  var fade = 1.0;
  if (t >= 0.70) { fade = max(0.0, 1.0 - (t - 0.70) / 0.30); }

  let nrm = normalize(i.nrm);
  let L = normalize(vec3<f32>(-0.45, 0.80, -0.34));
  let diff = clamp(dot(nrm, L), 0.0, 1.0);
  let lit = 0.42 + 0.58 * diff;
  let V = normalize(vec3<f32>(0.0, 0.58, -0.82));
  let Hh = normalize(L + V);
  let spec = pow(clamp(dot(nrm, Hh), 0.0, 1.0), 9.0);

  // aerial perspective: linework thins and fades into the distance so the far land
  // melts into soft tonal hills. Depth is carried by FORM (light/shade) + haze, not
  // by line density — which lets the contours stay subtle while the scene reads deep.
  let near = 1.0 - smoothstep(0.04, 0.60, t);        // 1 near .. 0 far
  line = line * (0.34 + 0.66 * near);

  let shade = 0.30 + 0.70 * diff;
  // warm sunlit slopes → a deep clean blue-teal in the shadowed troughs. A touch
  // more tonal range than before so the relief itself carries the depth read.
  let warmBase = vec3<f32>(0.158, 0.103, 0.060);
  let coolBase = vec3<f32>(0.025, 0.039, 0.053);
  let baseCol = mix(coolBase, warmBase, shade) * (0.56 + 1.10 * shade);
  // opaque ground; only the far reaches fade out as honest aerial perspective
  let baseA = (0.90 + 0.10 * diff) * fade * i.edge;

  // a slow living shimmer, but the lines are now soft warm strokes — not white wires
  let shimmer = 0.90 + 0.10 * sin(F.cam.z * 0.7 + i.relief * 0.004 + i.world * 0.0003);
  let warm = vec3<f32>(0.95, (232.0 - t * 24.0) / 255.0, (206.0 - t * 40.0) / 255.0);  // softly warm, not stark white
  let emis = (0.52 + 0.40 * core) * shimmer;         // dimmer: subtle, no glare
  let lineCol = warm * (lit + 0.3 * spec) * emis;
  let lineA = line * (0.40 + 0.32 * fade) * (0.72 + 0.4 * lit) * i.edge;

  let col = mix(baseCol, lineCol, line * 0.9);
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
  @location(3) wx : f32,
};
@vertex fn vs(@location(0) p : vec3<f32>, @location(1) sa : vec2<f32>) -> VsOut {
  var clip = F.vp * vec4<f32>(p, 1.0);
  clip.x += (F.geo.x - 0.5) * 2.0 * clip.w;
  var o : VsOut;
  o.pos = clip;
  o.side = sa.x;
  o.arc = sa.y;
  o.wz = p.z;
  o.wx = p.x;
  return o;
}
@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
  let edge = 1.0 - abs(i.side);                 // 1 centre .. 0 rim
  let body = smoothstep(0.0, 0.5, edge);        // clean, soft-edged body
  let core = smoothstep(0.42, 1.0, edge);       // luminous inner core
  let seam = smoothstep(0.88, 1.0, edge);       // crisp bright centre seam
  let t = clamp((i.wz - F.cam.y) / VIEW_DEPTH, 0.0, 1.0);
  let fade = 1.0 - smoothstep(0.82, 1.0, t);    // ribbon dissolves near the horizon

  // ---- footprint mask: dissolve the fibre exactly where the terrain plan is NOT
  // rendered, so the road never floats as a bright streak over the bare sky (e.g.
  // the top-right past the contours). Mirrors the terrain's lateral + far edge fade.
  let lat = (i.wx - F.cam.x) / F.geo.w;         // -1..1 across the plan width
  let uvx = 0.5 + 0.5 * lat;
  let latMask = smoothstep(0.0, 0.06, min(uvx, 1.0 - uvx));
  let farMask = 1.0 - smoothstep(0.70, 0.99, t); // gone by the terrain's far edge
  let footprint = clamp(latMask * farMask, 0.0, 1.0);

  // ---- luminous data packets gliding up the fibre and INTO the horizon glare --
  // Each packet's centre sweeps depth 0→1 on a smooth eased loop, tightening and
  // burning toward white as it climbs — so it reads as light being drawn up the
  // road and through the sun-glow. Two staggered packets keep the fibre alive.
  var packet = 0.0;
  for (var n = 0; n < 2; n = n + 1) {
    let tr = fract(F.cam.z * 0.26 + f32(n) * 0.5);
    let h = tr * tr * (3.0 - 2.0 * tr);         // ease-in-out travel 0..1
    let pd = t - h;
    let sharp = 150.0 - 96.0 * h;               // packet tightens near the top
    packet += exp(-pd * pd * sharp) * (0.45 + 1.7 * h);  // & brightens as it climbs
  }
  // the packet keeps burning right up to the horizon even as the ribbon fades out,
  // so it visibly passes THROUGH the glare instead of dimming away beforehand
  let glareFade = 1.0 - smoothstep(0.95, 1.04, t);
  let burn = clamp(packet, 0.0, 3.0) * glareFade;
  // a calm ambient flow underneath so the fibre feels alive between packets
  let flow = 0.6 + 0.4 * sin(i.arc * 0.010 - F.cam.z * 1.6);

  let amber = vec3<f32>(1.0, 0.55, 0.20);       // refined amber rim
  let gold  = vec3<f32>(1.0, 0.80, 0.48);       // warm gold mid
  let white = vec3<f32>(1.0, 0.98, 0.92);       // near-white seam
  var col = mix(amber, gold, core);
  col = mix(col, white, seam);
  col *= (0.85 + 1.7 * core + 1.5 * seam);      // HDR core feeds the bloom
  col *= (0.90 + 0.10 * flow);
  let bodyGlow = col * (body * fade);
  // packet burns along the seam/core, warming to white-hot at its peak
  let packetCol = mix(gold, white, clamp(burn * 0.5, 0.0, 1.0));
  let packetGlow = packetCol * burn * (0.30 + 0.70 * core) * body;
  let rgb = (bodyGlow + packetGlow) * footprint;
  let a = body * max(fade, burn * 0.5) * footprint;
  return vec4<f32>(rgb, a);                      // additive emission
}
`;

/* --------------------------------------------------------- SOLID MESH ----- */
/* Lit, flat-shaded solid geometry (the Stegra plant + the navigation arrow).
   Interleaved pos/normal/colour/emissive verts, lit with the SAME warm key +
   cool sky fill as the dusk terrain so the buildings sit in the world, with an
   aerial-perspective fade into the distance and emissive windows/lights that
   feed the bloom. Depth-tested so nearer hills occlude it. */
export const SOLID_WGSL = FRAME_WGSL + /* wgsl */ `
const VIEW_DEPTH : f32 = 13000.0;
struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) nrm : vec3<f32>,
  @location(1) col : vec3<f32>,
  @location(2) emis : f32,
  @location(3) depthT : f32,
};
@vertex fn vs(
  @location(0) p : vec3<f32>,
  @location(1) n : vec3<f32>,
  @location(2) c : vec3<f32>,
  @location(3) e : f32,
) -> VsOut {
  var clip = F.vp * vec4<f32>(p, 1.0);
  clip.x += (F.geo.x - 0.5) * 2.0 * clip.w;
  var o : VsOut;
  o.pos = clip;
  o.nrm = n;
  o.col = c;
  o.emis = e;
  o.depthT = clamp((p.z - F.cam.y) / VIEW_DEPTH, 0.0, 1.0);
  return o;
}
@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
  let n = normalize(i.nrm);
  let L = normalize(vec3<f32>(-0.45, 0.80, -0.34));   // key light (matches terrain)
  let diff = clamp(dot(n, L), 0.0, 1.0);
  let up = 0.5 + 0.5 * n.y;                            // 1 skyward .. 0 downward
  let key = vec3<f32>(1.0, 0.82, 0.58);              // warm low sun
  let sky = vec3<f32>(0.30, 0.36, 0.46);             // cool skylight fill from above
  let grnd = vec3<f32>(0.42, 0.22, 0.12);            // warm dusk ground-bounce from below
  // warm key + cool sky from above + warm ground bounce from below → the steel
  // sits in the dusk light instead of reading as a cold grey cut-out
  var lit = i.col * (key * (0.30 + 0.85 * diff) + sky * (0.24 * up) + grnd * (0.32 * (1.0 - up)));
  // soft fresnel rim against a fixed view so silhouettes catch the horizon glow
  let Vv = normalize(vec3<f32>(0.0, 0.52, -0.86));
  let rim = pow(1.0 - clamp(dot(n, Vv), 0.0, 1.0), 3.0);
  lit += mix(i.col, vec3<f32>(1.0, 0.72, 0.42), 0.55) * rim * 0.44; // warm horizon backlight
  lit += i.col * i.emis;                              // emissive windows / lights
  // aerial perspective: dissolve into the dusk with distance, like the contours
  let haze = smoothstep(0.66, 1.0, i.depthT);
  let dusk = vec3<f32>(0.14, 0.10, 0.066);
  let col = mix(lit, dusk, haze * 0.92);
  return vec4<f32>(col, 1.0);
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
  // tilt-shift: 0 sharp in the focal band, 1 fully blurred above & below. The ramp
  // is run through smoothstep TWICE (≈ smootherstep) so the onset out of the sharp
  // band has no hard shoulder — the defocus creeps in gradually, the way a real
  // large-aperture lens rolls off, then deepens to a full creamy blur at the
  // extreme top & bottom. Near/far use slightly different reaches: the lower
  // foreground falls out of focus a touch sooner than the high distance.
  let cy = F.cont.z;
  let core = F.cont.w;
  let fth = max(0.001, F.post.x);
  let dy = uv.y - cy;
  let reach = select(fth, fth * 0.86, dy < 0.0);   // nearer foreground blurs sooner
  let e = smoothstep(core, core + reach, abs(dy));
  return e * e * (3.0 - 2.0 * e);                  // smootherstep shoulders
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

  // god-ray halo seated at the vanishing point (the destination glow). It gently
  // flares as each road packet is drawn up into it — the pulse passing THROUGH the
  // glare — using the same clock/phase as the road shader so the two stay in sync.
  let vp = vec2<f32>(F.vp2.x, F.vp2.y);
  let dvp = (uv - vp) * vec2<f32>(F.res.x / F.res.y, 1.0);
  var flare = 0.0;
  for (var n = 0; n < 2; n = n + 1) {
    let tr = fract(F.cam.z * 0.26 + f32(n) * 0.5);
    flare += exp(-pow(tr - 0.82, 2.0) * 70.0);  // peaks as the packet meets the VP
  }
  let halo = F.vp2.z + flare * 0.055;
  col += vec3<f32>(1.0, 0.76, 0.44) * halo * exp(-dot(dvp, dvp) / max(1e-4, F.vp2.w));

  // exposure + tone-map
  col = aces(col * F.post.w);

  // colour grade — gentle saturation lift + restored contrast so the luminous
  // contours and fibre road read crisply against a deep, honest dusk ground
  // (the old grade flattened everything into one milky golden wash).
  let luma = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
  col = mix(vec3<f32>(luma), col, 1.16);       // gentle colour pop
  col = (col - 0.5) * 1.08 + 0.5;              // contrast — a touch more bite
  col = max(col, vec3<f32>(0.0));
  // black point — draw the very darkest tones down to true black so the dusk
  // reads rich rather than milky. Rescaled by (1 - bp) so midtones, the bright
  // contours and the sun glow keep their level; only the haze in the shadows lifts.
  col = max(col - vec3<f32>(0.011), vec3<f32>(0.0)) / (1.0 - 0.011);

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
