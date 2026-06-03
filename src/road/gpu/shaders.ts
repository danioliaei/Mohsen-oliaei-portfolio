/* =========================================================================
   WGSL shader for the WebGPU homepage background.

   The homepage renders a single static, fullscreen pass on the GPU: the warm
   "sunset" gradient (the original look). No terrain, road, embers, post-FX —
   just the gradient, drawn directly to the swap-chain in display space so the
   colours land exactly on the original CSS values.

   It reproduces, in one fragment, the CSS that lives on `body` in index.css:
     radial-gradient(ellipse 85% 50% at 50% 53%,  #f5c660 0.55 → 0  @62%)
     radial-gradient(ellipse 130% 75% at 50% 108%, #301708 0.95 → 0 @55%)
     radial-gradient(circle  at 8% 100%,           #281206 0.90 → 0)
     radial-gradient(circle  at 95% 100%,          #321808 0.85 → 0)
     linear-gradient(180deg, #c98a2a, #d6962c, #c67c1d, #8a4d18, #5f3211)
   ========================================================================= */

export const GRADIENT_WGSL = /* wgsl */ `
struct VsOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };

@vertex fn vs(@builtin(vertex_index) vid : u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
  var o : VsOut;
  let xy = p[vid];
  o.pos = vec4<f32>(xy, 0.0, 1.0);
  o.uv = vec2<f32>(xy.x * 0.5 + 0.5, 1.0 - (xy.y * 0.5 + 0.5)); // uv.y: 0 top .. 1 bottom
  return o;
}

/** Linear ramp 0..1 as y crosses [a,b] — the default CSS gradient interpolation. */
fn lin(a : f32, b : f32, y : f32) -> f32 {
  return clamp((y - a) / (b - a), 0.0, 1.0);
}

/** A radial layer's alpha at uv: colour at the centre fading linearly to 0 at
    endStop (a fraction of the ellipse radius), then transparent beyond. */
fn radialA(uv : vec2<f32>, c : vec2<f32>, r : vec2<f32>, a0 : f32, endStop : f32) -> f32 {
  let d = length((uv - c) / r);
  return a0 * (1.0 - clamp(d / endStop, 0.0, 1.0));
}

@fragment fn fs(i : VsOut) -> @location(0) vec4<f32> {
  let uv = i.uv;
  let y = uv.y;

  // base: linear-gradient(180deg, #c98a2a 0%, #d6962c 34%, #c67c1d 58%, #8a4d18 80%, #5f3211 100%)
  let c0 = vec3<f32>(0.788, 0.541, 0.165); // #c98a2a
  let c1 = vec3<f32>(0.839, 0.588, 0.173); // #d6962c
  let c2 = vec3<f32>(0.776, 0.486, 0.114); // #c67c1d
  let c3 = vec3<f32>(0.541, 0.302, 0.094); // #8a4d18
  let c4 = vec3<f32>(0.373, 0.196, 0.067); // #5f3211
  var col = c0;
  col = mix(col, c1, lin(0.0, 0.34, y));
  col = mix(col, c2, lin(0.34, 0.58, y));
  col = mix(col, c3, lin(0.58, 0.80, y));
  col = mix(col, c4, lin(0.80, 1.0, y));

  // warm darkening toward the bottom + the two bottom corners (grounds the frame)
  col = mix(col, vec3<f32>(0.188, 0.090, 0.031), radialA(uv, vec2<f32>(0.50, 1.08), vec2<f32>(1.30, 0.75), 0.95, 0.55));
  col = mix(col, vec3<f32>(0.157, 0.071, 0.024), radialA(uv, vec2<f32>(0.08, 1.00), vec2<f32>(0.70, 0.70), 0.90, 0.55));
  col = mix(col, vec3<f32>(0.196, 0.094, 0.031), radialA(uv, vec2<f32>(0.95, 1.00), vec2<f32>(0.72, 0.72), 0.85, 0.55));

  // golden glow seated a touch above centre — the sun low in the haze
  col = mix(col, vec3<f32>(0.961, 0.776, 0.376), radialA(uv, vec2<f32>(0.50, 0.53), vec2<f32>(0.85, 0.50), 0.55, 0.62));

  return vec4<f32>(col, 1.0);
}
`;
