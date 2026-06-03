/* ============================================================================
   Shared point ShaderMaterial.

   One shader program for every globe layer (ocean shell, land, borders,
   graticule, markers, arcs, clusters, facilities). Per-layer differences are
   uniforms (uSize / uOpacity / uReveal); the theme palette + uTime / uZoom are
   updated each frame. Per-point attributes drive the density ramp and accents:

     aRand    random [0,1]   — size variance + organic drift
     aIn/aOut zoom fade band — point visible while uZoom ∈ [aIn, aOut]
     aCore    0/1            — brightest core points (feed Bloom)
     aLand    0/1            — land points: brighter + larger
     aAccent  0|1|2          — ink | pink | periwinkle
   ========================================================================== */

import {
  AdditiveBlending,
  Color,
  type IUniform,
  MultiplyBlending,
  ShaderMaterial,
} from "three";
import { PALETTE } from "../../theme";
import type { Theme } from "../../data/world";

const vertex = /* glsl */ `
  uniform float uTime;
  uniform float uReveal;     // 0 orbit-ish -> 1 surface (per globe)
  uniform float uZoom;       // 0 world -> 1 surface (density ramp)
  uniform float uSize;
  uniform float uPixelRatio;
  uniform float uMotion;     // 0 reduced-motion, 1 normal
  uniform float uBreathe;    // breathing amplitude scale
  uniform float uSizeMul;    // per-theme size multiplier
  uniform float uFocusCountry; // highlighted country index (0 = none)
  uniform float uFocusAmt;     // 0..1 spotlight strength

  attribute float aRand;
  attribute float aIn;
  attribute float aOut;
  attribute float aCore;
  attribute float aLand;
  attribute float aAccent;
  attribute float aCountry;

  varying float vAlpha;
  varying float vCore;
  varying float vAccent;
  varying float vLand;
  varying float vFocus;

  void main() {
    vec3 pos = position;

    // organic motion — only meaningful at orbit, eased out as we descend
    float orbit = (1.0 - uReveal) * uMotion;
    float breathe = 1.0 + sin(uTime * 0.5 + aRand * 6.2831) * 0.012 * uBreathe * orbit;
    pos *= breathe;
    float drift = 0.010 * orbit;
    pos += vec3(
      sin(uTime * 0.6 + aRand * 40.0),
      sin(uTime * 0.5 + aRand * 55.0),
      cos(uTime * 0.7 + aRand * 30.0)
    ) * drift;

    vec4 worldPos = modelMatrix * vec4(pos, 1.0);
    vec3 worldNormal = normalize((modelMatrix * vec4(normalize(position), 0.0)).xyz);
    vec3 toCam = normalize(cameraPosition - worldPos.xyz);
    float facing = dot(worldNormal, toCam); // 1 front .. -1 back
    float front = smoothstep(-0.35, 0.25, facing);

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);

    // density-ramp fade band
    float appear = smoothstep(aIn - 0.10, aIn + 0.02, uZoom);
    float disappear = 1.0 - smoothstep(aOut, aOut + 0.06, uZoom);
    float band = appear * disappear;

    // depth shading: dim the far hemisphere but keep the sphere legible
    float depthFade = mix(0.16, 1.0, front);

    // focus spotlight: when a country is focused, lift its points and dim the
    // rest, so the focused country reads as a clear, bright shape.
    float isFocus = (uFocusCountry > 0.5 && abs(aCountry - uFocusCountry) < 0.5)
      ? 1.0 : 0.0;
    // dim non-focused geography but keep neighbours readable for context.
    float spotlight = mix(1.0, mix(0.42, 1.0, isFocus), uFocusAmt);
    float lift = isFocus * uFocusAmt;

    vAlpha = band * depthFade * spotlight;
    vCore = aCore;
    vAccent = aAccent;
    vLand = aLand;
    vFocus = lift;

    float sizeBoost = 1.0 + aCore * 1.7 + aLand * 0.35 + lift * 0.8;
    float facingSize = mix(0.62, 1.0, front);
    float variance = 0.7 + aRand * 0.6;
    float s = uSize * uSizeMul * uPixelRatio * sizeBoost * facingSize * variance * (1.0 / max(0.05, -mvPosition.z));
    gl_PointSize = clamp(s, 0.0, 34.0 * uPixelRatio);

    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragment = /* glsl */ `
  precision mediump float;

  uniform vec3 uInk;
  uniform vec3 uPink;
  uniform vec3 uBlue;
  uniform float uCoreAdd;
  uniform float uOpacity;
  uniform float uDark;       // 1 dark (additive glow) / 0 light (dark dots)

  varying float vAlpha;
  varying float vCore;
  varying float vAccent;
  varying float vLand;
  varying float vFocus;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float disc = smoothstep(0.5, 0.16, d);

    vec3 base = uInk;
    if (vAccent > 1.5) base = uBlue;
    else if (vAccent > 0.5) base = uPink;

    // focused land glows pink so the country pops; focused borders stay blue.
    base = mix(base, uPink, vFocus * vLand * 0.8);

    // On dark we brighten toward a hot, bloom-feeding core. On light we must NOT
    // lighten the dark dots (that kills contrast); instead we drive density via
    // alpha so land + cores read as crisp dark stippling on the light page.
    float bright = 1.0 + vLand * 0.22 + vCore * uCoreAdd + vFocus * 0.9;
    vec3 color = base * mix(1.0, bright, uDark);
    color += base * vCore * uCoreAdd * (1.0 - d) * 0.7 * uDark;

    float alpha = vAlpha * disc * uOpacity;
    alpha *= 1.0 + (vLand * 0.95 + vCore * 0.7) * (1.0 - uDark);
    alpha += vFocus * disc * uOpacity * 0.2 * uDark; // focus glow (dark)
    alpha = min(alpha, 1.0);
    if (alpha < 0.01) discard;

    if (uDark > 0.5) {
      // additive glow: dst + color * alpha
      gl_FragColor = vec4(color, alpha);
    } else {
      // multiply: dark dots darken the light page and accumulate; faint
      // (low-alpha) points stay near white so the ocean reads as faint.
      gl_FragColor = vec4(mix(vec3(1.0), color, alpha), 1.0);
    }
  }
`;

export interface PointsMaterialOpts {
  size?: number;
  opacity?: number;
  reveal?: number;
  breathe?: number;
}

export interface SharedUniforms {
  uTime: IUniform<number>;
  uInk: IUniform<Color>;
  uPink: IUniform<Color>;
  uBlue: IUniform<Color>;
  uCoreAdd: IUniform<number>;
  uPixelRatio: IUniform<number>;
  uMotion: IUniform<number>;
  uDark: IUniform<number>;
  uSizeMul: IUniform<number>;
}

export function createSharedUniforms(
  theme: Theme,
  pixelRatio: number,
): SharedUniforms {
  const p = PALETTE[theme];
  const dark = theme === "dark";
  return {
    uTime: { value: 0 },
    uInk: { value: new Color(p.ink) },
    uPink: { value: new Color(p.pink) },
    uBlue: { value: new Color(p.blue) },
    uCoreAdd: { value: dark ? 1.0 : 0.25 },
    uPixelRatio: { value: pixelRatio },
    uMotion: { value: 1 },
    uDark: { value: dark ? 1 : 0 },
    uSizeMul: { value: dark ? 1.0 : 2.0 },
  };
}

export function blendingFor(theme: Theme) {
  // Additive glow on dark; multiplicative darkening on light so dark dots
  // accumulate into legible continents (mirroring additive on dark).
  return theme === "dark" ? AdditiveBlending : MultiplyBlending;
}

export function createPointsMaterial(
  shared: SharedUniforms,
  theme: Theme,
  opts: PointsMaterialOpts = {},
): ShaderMaterial {
  const { size = 2.2, opacity = 1, reveal = 0, breathe = 1 } = opts;
  return new ShaderMaterial({
    uniforms: {
      ...shared,
      uSize: { value: size },
      uOpacity: { value: opacity },
      uReveal: { value: reveal },
      uZoom: { value: 0 },
      uBreathe: { value: breathe },
      uFocusCountry: { value: 0 },
      uFocusAmt: { value: 0 },
    },
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: blendingFor(theme),
  });
}

/** Update palette + blending across all live materials on a theme change. */
export function applyThemeToShared(shared: SharedUniforms, theme: Theme) {
  const p = PALETTE[theme];
  const dark = theme === "dark";
  shared.uInk.value.set(p.ink);
  shared.uPink.value.set(p.pink);
  shared.uBlue.value.set(p.blue);
  shared.uCoreAdd.value = dark ? 1.0 : 0.25;
  shared.uDark.value = dark ? 1 : 0;
  shared.uSizeMul.value = dark ? 1.0 : 2.0;
}
