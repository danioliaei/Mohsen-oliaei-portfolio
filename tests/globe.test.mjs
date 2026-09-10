import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Load the real TypeScript math/geometry without a browser or GPU. GPU API calls
// remain inside functions and are not invoked by these geometry regressions.
const cache = new Map();
function load(url) {
  if (cache.has(url.href)) return cache.get(url.href);
  const exports = {};
  cache.set(url.href, exports);
  const { outputText } = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  vm.runInNewContext(outputText, {
    exports,
    require: (path) => load(new URL(path + ".ts", url)),
  });
  return exports;
}
const { globePointerStrength } = load(new URL("../src/gpu/globePointer.ts", import.meta.url));
const { buildFilamentGeometry, MORPH_DUR, GLOBE_SPIN_RATE, ridgeCamera, globeFitRadiusScale, GLOBE } =
  load(new URL("../src/gpu/ridgeline.ts", import.meta.url));
const {
  BEAT_PERIOD, BEAT_PEAK, BEAT_MEAN, NUT_OBLIQUITY, NUT_PRECESS_BEATS, TAU,
  beatPhase, beatPulse, globeNutation, tiltH, tangentFromAngle, chordTangent,
} = load(new URL("../src/gpu/globeMotion.ts", import.meta.url));
const shadersSrc = readFileSync(new URL("../src/gpu/ridgelineShaders.ts", import.meta.url), "utf8");
const sceneSrc = readFileSync(new URL("../src/gpu/ridgeline.ts", import.meta.url), "utf8");
const stageSrc = readFileSync(new URL("../src/components/RidgelineStage.tsx", import.meta.url), "utf8");
const shaderMods = load(new URL("../src/gpu/ridgelineShaders.ts", import.meta.url));

// one line SEGMENT = two 8-float vertices (dir xyz, t, seed, brightness, radial, tangent angle)
const STRIDE = 16;
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
// mulberry32 (the same family the geometry builder uses) — seeded, so every sample below is reproducible
const prng = (seed) => {
  let st = seed >>> 0;
  return () => {
    st = (st + 0x6d2b79f5) >>> 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
/** Independent Rodrigues rotation of v about the UNIT axis k by angle a (not the tiltH formula). */
const rodrigues = (v, k, a) => {
  const c = Math.cos(a), s = Math.sin(a), kd = dot3(k, v);
  const kx = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  return [0, 1, 2].map((i) => v[i] * c + kx[i] * s + k[i] * kd * (1 - c));
};
/** The WGSL rotY(v, c, s) one-liner, verbatim. */
const rotY = (v, c, s) => [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];

test("pointer influence is local, with a soft rim and no activation outside the globe", () => {
  assert.equal(globePointerStrength(200, 200, 200, 200, 100), 1);
  assert.equal(globePointerStrength(301, 200, 200, 200, 100), 0);
  assert.equal(globePointerStrength(-1, -1, 200, 200, 100), 0);
  assert.equal(globePointerStrength(200, 200, 200, 200, 0), 0);
  const rim = globePointerStrength(291, 200, 200, 200, 100);
  assert.ok(rim > 0 && rim < 1);
});

for (const phone of [false, true]) {
  const label = phone ? "phone" : "desktop";
  test(`${label} nucleus: finite skin arcs above the body, ONE orbital halo, the vertex budget`, () => {
    const geometry = buildFilamentGeometry(phone);
    assert.equal(geometry.length % STRIDE, 0);
    assert.ok(geometry.every(Number.isFinite));
    // the line-vertex budget only ever goes DOWN: 31,536 desktop (was 38,184) / 24,872 phone (was 25,672)
    assert.equal(geometry.length / 8, phone ? 24872 : 31536, "filament vertex budget");
    let arcs = 0, halo = 0;
    for (let i = 0; i < geometry.length; i += STRIDE) {
      const seed = geometry[i + 4], brightness = geometry[i + 5], radius = geometry[i + 6];
      if (seed < 2) continue;                      // not the nucleus class
      if (radius >= 0.10) {                        // == HALO_FLAG in the VS
        assert.ok(radius <= 0.13, "the halo rides just outside the body");
        assert.ok(brightness <= 1.05, "the halo is quiet next to the 0.62 body");
        halo++;
        continue;
      }
      const dot = geometry[i] * geometry[i + 8] + geometry[i + 1] * geometry[i + 9] + geometry[i + 2] * geometry[i + 10];
      assert.ok(dot > 0.95, "a core chord must stay near its surface, not cut through its centre");
      assert.ok(radius >= 0.077 && radius <= 0.09, "skin arcs sit 0.078..0.086: above the 0.075 body, under the halo flag");
      assert.ok(brightness < 0.5, "core stroke intensity stays under the bloom knee — skin detail, not glow");
      arcs++;
    }
    assert.ok(arcs >= 100);
    assert.equal(halo, 96, "one orbital halo ring");
  });

  test(`${label} tangent CONTRACT: every stored angle decodes to the segment's own forward chord`, () => {
    const g = buildFilamentGeometry(phone);
    let checked = 0, spokes = 0;
    for (let i = 0; i < g.length; i += STRIDE) {
      const a = [g[i], g[i + 1], g[i + 2]], b = [g[i + 8], g[i + 9], g[i + 10]];
      const seed = g[i + 4];
      const isSpoke = seed >= 1 && seed < 2 && seed - 1 < 0.9;
      // both endpoints: the first carries the chord a -> b, the second the same forward direction (negated b -> a)
      for (const [d, other, tang, forward] of [[a, b, g[i + 7], 1], [b, a, g[i + 15], -1]]) {
        const T = tangentFromAngle(d, tang);
        assert.ok(Math.abs(dot3(T, d)) < 1e-6, "a tangent is perpendicular to its direction");
        if (isSpoke) { assert.equal(tang, 0, "spokes store 0 (the VS substitutes the radial direction)"); spokes++; continue; }
        const c = chordTangent(d, other);
        const C = [c[0] * forward, c[1] * forward, c[2] * forward];
        if (Math.hypot(C[0], C[1], C[2]) > 0) {
          assert.ok(dot3(T, C) > 0.999, `tangent must follow the chord (dot ${dot3(T, C)})`);
          checked++;
        }
      }
    }
    assert.ok(checked > 20000 && spokes > 0, `checked ${checked} tangents, ${spokes} spoke ends`);
  });
}

test("beat twin: the gamma pulse peaks at exactly 1, averages BEAT_MEAN over a period, and the phase wraps", () => {
  assert.equal(BEAT_PERIOD, 4);
  assert.equal(BEAT_PEAK, 0.2);
  assert.ok(Math.abs(beatPulse(BEAT_PEAK) - 1) < 1e-12);
  assert.equal(beatPulse(0), 0, "onset is dark");
  // stratified sampling of one period (deterministic; the same integral a Monte-Carlo run estimates)
  let s = 0; const n = 100000;
  for (let i = 0; i < n; i++) s += beatPulse((i + 0.5) / n);
  assert.ok(Math.abs(s / n - BEAT_MEAN) < 0.002, `mean ${s / n} vs BEAT_MEAN ${BEAT_MEAN}`);
  assert.ok(beatPhase(4) < 1e-12);
  assert.equal(beatPhase(1), 0.25);
  assert.ok(beatPulse(1) < 0.01, "the wrap at phase 1 is invisible (8.4e-3)");
});

test("nutation twin: tiltH is Rodrigues, identity at angle 0, and the gate is EXACTLY +0 off the globe", () => {
  const rnd = prng(0x51ed);
  for (let i = 0; i < 20000; i++) {
    const phi = rnd() * TAU, ax = Math.cos(phi), az = Math.sin(phi), ang = (rnd() - 0.5) * 0.8;
    const v = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
    const a = tiltH(v, ax, az, Math.cos(ang), Math.sin(ang));
    const b = rodrigues(v, [ax, 0, az], ang);
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-12);
  }
  // Array.from: the module runs in its own vm realm, so its arrays carry another Array.prototype
  assert.deepEqual(Array.from(tiltH([0.3, -0.2, 0.9], 0.6, 0.8, 1, 0)), [0.3, -0.2, 0.9], "angle 0 is the identity");
  assert.equal(NUT_OBLIQUITY, 0.10);
  assert.equal(NUT_PRECESS_BEATS, 12);
  for (const [mc, projAmt, still] of [[0.30, 0, false], [0.5, 0, false], [1, 0, false], [0, 0.15, false], [0, 0, true]]) {
    assert.ok(Object.is(globeNutation(7.3, mc, projAmt, still).angle, 0), `mc ${mc} proj ${projAmt} still ${still} must be +0`);
  }
  assert.equal(globeNutation(7.3, 0, 0, false).angle, 0.10);
  const n = globeNutation(3.1, 0, 0, false);
  assert.ok(Math.abs(Math.hypot(n.ax, n.az) - 1) < 1e-12, "the tilt axis is unit");
  // the lean's direction walks once around per 48 s
  const n0 = globeNutation(0, 0, 0, false), n48 = globeNutation(NUT_PRECESS_BEATS * BEAT_PERIOD, 0, 0, false);
  assert.ok(Math.abs(n0.ax - n48.ax) < 1e-12 && Math.abs(n0.az - n48.az) < 1e-12);
});

test("co-rotation identity: the crust chain rotY(spin) then the lean equals a generic Y rotation then a generic Rodrigues", () => {
  const rnd = prng(0xc0de);
  for (let i = 0; i < 500; i++) {
    const v = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
    const spin = rnd() * TAU, phi = rnd() * TAU, ang = (rnd() - 0.5) * 0.4;
    const ax = Math.cos(phi), az = Math.sin(phi);
    const chain = tiltH(rotY(v, Math.cos(spin), Math.sin(spin)), ax, az, Math.cos(ang), Math.sin(ang));
    const generic = rodrigues(rodrigues(v, [0, 1, 0], spin), [ax, 0, az], ang);
    assert.ok(Math.hypot(chain[0] - generic[0], chain[1] - generic[1], chain[2] - generic[2]) < 1e-12);
  }
});

test("source-literal guards: the shared windows, gates and the uniform layout are spelled as the contract says", () => {
  for (const lit of [
    "const FIL_SKIP : f32 = 0.72;",
    "const DRAIN_A : f32 = 0.10;  const DRAIN_B : f32 = 0.40;",
    "const POUR_A  : f32 = 0.36;  const POUR_B  : f32 = 0.64;",
    "const LIFT_A  : f32 = 0.40;  const LIFT_B  : f32 = 0.64;",
    "const CORE_FADE_A : f32 = 0.55;  const CORE_FADE_B : f32 = 0.70;",
    "const HALO_A : f32 = 0.70;   const HALO_B : f32 = 0.94;",
    "const HALO_FLAG : f32 = 0.10;",
    "smoothstep(0.40, 0.52, vmF) * (1.0 - smoothstep(0.52, 0.72, vmF))",
    "if (F.mph.x < 0.87)",
    "smoothstep(HALO_A, HALO_B, F.mph.x)",
    "if (F.mph.x <= HALO_A)",
    "fn beatPhase() -> f32 { return fract(F.a.x / BEAT_PERIOD); }",
    "@builtin(frag_depth) depth : f32",
    "@location(2) tang : f32",
  ]) assert.ok(shadersSrc.includes(lit), `ridgelineShaders.ts must contain: ${lit}`);
  assert.ok(!shadersSrc.includes("gdir"), "the dead gdir varying is gone");
  for (const lit of [
    "(s.morph ?? 1) < 0.72",
    'depthWriteEnabled: true, depthCompare: "always"',
    "u[46] = s.theme ?? 0;",
    "u[52] = s.nutAxisX ?? 1;", "u[53] = s.nutAxisZ ?? 0;", "u[54] = s.nutAngle ?? 0;", "u[55] = 0;",
    "arrayStride: 32,",
    "{ shaderLocation: 2, offset: 28, format: \"float32\" }",
  ]) assert.ok(sceneSrc.includes(lit), `ridgeline.ts must contain: ${lit}`);
  assert.equal(MORPH_DUR, 2.6);
  assert.ok(Math.abs(GLOBE_SPIN_RATE - (Math.PI * 2) / 72) < 1e-6, "18 beats per revolution");
  // the WGSL frame block and the JS twin carry the same beat constants
  const wgslConst = (name) => Number(shadersSrc.match(new RegExp(`const ${name}\\s*:\\s*f32\\s*=\\s*([0-9.]+);`))[1]);
  assert.equal(wgslConst("BEAT_PERIOD"), BEAT_PERIOD);
  assert.equal(wgslConst("BEAT_PEAK"), BEAT_PEAK);
  assert.equal(wgslConst("BEAT_MEAN"), BEAT_MEAN);
  // the frame block is prepended to backdrop, terrain, filament AND composite
  assert.equal((shadersSrc.match(/= RIDGE_FRAME_WGSL \+/g) || []).length, 4);
  // a stray backtick inside a WGSL comment TRUNCATES its template literal (and can swallow the next one) while the
  // file may still parse: every exported module must end with its closing brace and carry no backtick, and the
  // filament VS must still reach its lean line
  for (const name of ["RIDGE_BACKDROP_WGSL", "RIDGE_TERRAIN_WGSL", "RIDGE_FILAMENT_WGSL", "RIDGE_COMPOSITE_WGSL", "BRIGHT_WGSL", "BLUR_WGSL"]) {
    const code = shaderMods[name];
    assert.equal(typeof code, "string", name);
    assert.ok(code.trimEnd().endsWith("}"), name + " is truncated");
    assert.ok(!code.includes(String.fromCharCode(96)), name + " carries a backtick");
  }
  assert.ok(shaderMods.RIDGE_FILAMENT_WGSL.includes("sd = sd * nc + cross(nk, sd) * ns"));
  // rigid-motion ORDER on the real sources (the contract the co-rotation identity assumes): the GPU crust spins
  // (rotY) BEFORE it leans, and the DOM letters in updateCloud do the same (inlined rotY, then the Rodrigues tilt)
  assert.ok(shadersSrc.indexOf("var sd = rotY(d, cs, sn);") < shadersSrc.indexOf("sd = sd * nc + cross(nk, sd) * ns"));
  assert.ok(stageSrc.indexOf("const rx0 = bx * cs + bz * ss") < stageSrc.indexOf("const kd = kx * rx0 + kz * rz0"));
  // struct Frame: mat4 + ten vec4 = 224 B inside the 256 B buffer; x2 is the 11th member -> float index 52
  const frame = shadersSrc.match(/struct Frame \{([\s\S]*?)\};/)[1];
  const members = [...frame.matchAll(/^\s*(\w+)\s*:\s*(mat4x4<f32>|vec4<f32>)/gm)].map((m) => m[1]);
  assert.deepEqual(members, ["vp", "a", "b", "post", "eye", "hov", "mph", "lod", "drs", "ptr", "x2"]);
  assert.equal(64 + 16 * (members.length - 1), 224);
  assert.equal((64 + 16 * (members.indexOf("x2") - 1)) / 4, 52);
  assert.equal((64 + 16 * (members.indexOf("drs") - 1)) / 4 + 2, 46);
});

test("emergence front: never crosses the bloom knee and is exactly 0 at both ends and on the landed mountain", () => {
  const emergeF = (v) => sstep(0.40, 0.52, v) * (1 - sstep(0.52, 0.72, v));
  let mx = 0, at = 0;
  for (let i = 0; i <= 1000; i++) {
    const v = i / 1000;
    const lum = 0.64 * (1 + 0.40 * emergeF(v)) * sstep(0, 0.72, v);   // the brightest lit-rock hairline
    if (lum > mx) { mx = lum; at = v; }
  }
  assert.ok(mx < 0.82, `max lit-rock hairline ${mx} at vmF ${at} must stay under the 0.82 bloom threshold`);
  for (const v of [0.40, 0.72, 0.9, 1]) assert.equal(emergeF(v), 0);
  // the uniform gate F.mph.x < 0.87 only closes once the summit (key 1: vm = ss(0.6, 1.0, morph)) has passed 0.72
  assert.ok(sstep(0.6, 1.0, 0.87) >= 0.72);
});

test("nucleus ray-sphere: the perpendicular form holds in f32 at the silhouette and the skin arcs sit in front of the body", () => {
  const f = Math.fround;
  const R = 270, C = [GLOBE.cx, GLOBE.cy, GLOBE.cz];
  // f32 vector arithmetic (rounded after every op, the way the GPU evaluates the shader)
  const sub = (a, b) => [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])];
  const dot = (a, b) => f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
  const cross = (a, b) => [f(f(a[1] * b[2]) - f(a[2] * b[1])), f(f(a[2] * b[0]) - f(a[0] * b[2])), f(f(a[0] * b[1]) - f(a[1] * b[0]))];
  const scale = (a, s) => [f(a[0] * s), f(a[1] * s), f(a[2] * s)];
  const norm = (a) => { const l = f(Math.sqrt(dot(a, a))); return [f(a[0] / l), f(a[1] / l), f(a[2] / l)]; };
  const project = (V, p) => {
    const cx = f(f(f(f(V[0] * p[0]) + f(V[4] * p[1])) + f(V[8] * p[2])) + V[12]);
    const cy = f(f(f(f(V[1] * p[0]) + f(V[5] * p[1])) + f(V[9] * p[2])) + V[13]);
    const cz = f(f(f(f(V[2] * p[0]) + f(V[6] * p[1])) + f(V[10] * p[2])) + V[14]);
    const cw = f(f(f(f(V[3] * p[0]) + f(V[7] * p[1])) + f(V[11] * p[2])) + V[15]);
    return { nx: cx / cw, ny: cy / cw, depth: f(cz / cw) };
  };
  // the shader's ray: rows 0, 1, 3 of vp (F.vp[c][r] == V[c * 4 + r]), D = normalize(cross(r1 - ny r3, r0 - nx r3))
  const ray = (V, nx, ny) => {
    const r0 = [V[0], V[4], V[8]], r1 = [V[1], V[5], V[9]], r3 = [V[3], V[7], V[11]];
    return norm(cross(sub(r1, scale(r3, f(ny))), sub(r0, scale(r3, f(nx)))));
  };
  for (const [label, aspect] of [["desktop", 1440 / 900], ["phone", 390 / 844]]) {
    const cam = ridgeCamera(0, 0, aspect, 0, globeFitRadiusScale(aspect), 0, 0);
    const V = Float32Array.from(cam.vp), E = [f(cam.eye[0]), f(cam.eye[1]), f(cam.eye[2])];   // copy: shared scratch
    const oc = sub(E, C);
    const dist = Math.hypot(oc[0], oc[1], oc[2]);
    // (1) the ray points forward and re-projects onto the pixel it was cast from
    const cc = project(V, C);
    const D0 = ray(V, cc.nx, cc.ny);
    assert.ok(dot(D0, norm(scale(oc, -1))) > 0.99, `${label}: the reconstructed ray looks at the body`);
    const re = project(V, [f(E[0] + D0[0] * 1000), f(E[1] + D0[1] * 1000), f(E[2] + D0[2] * 1000)]);
    assert.ok(Math.abs(re.nx - cc.nx) < 1e-4 && Math.abs(re.ny - cc.ny) < 1e-4, `${label}: ray re-projects onto its pixel`);
    // (2) find the silhouette in f64 (exact rho = 1 along +x from the centre pixel), then evaluate the f32 perp form there
    const rho64 = (nx, ny) => {
      const D = ray(V, nx, ny); const b = dot3(oc, D);
      const perp = [oc[0] - b * D[0], oc[1] - b * D[1], oc[2] - b * D[2]];
      return Math.hypot(perp[0], perp[1], perp[2]) / R;
    };
    let lo = 0, hi = 0.5;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (rho64(cc.nx + m, cc.ny) < 1) lo = m; else hi = m; }
    const sx = cc.nx + (lo + hi) / 2;
    const D = ray(V, sx, cc.ny);
    const b = dot(oc, D);
    const perp = sub(oc, scale(D, b));
    const rho32 = f(Math.sqrt(dot(perp, perp))) / R;
    assert.ok(Math.abs(rho32 - 1) < 1e-5, `${label}: perp-form rho at the silhouette = ${rho32} (eye distance ${dist.toFixed(0)})`);
    // the naive form subtracts two ~1e8..1e9 squares: its error is what the perpendicular form avoids
    const naive = f(Math.sqrt(Math.max(0, f(dot(oc, oc) - f(b * b))))) / R;
    assert.ok(Math.abs(naive - 1) > Math.abs(rho32 - 1), `${label}: the naive form (${naive}) is worse than the perp form`);
    // (3) depth ordering at the centre pixel: the body's front surface vs a skin arc 280.8 units out vs a line 1000 behind
    const bc = dot(oc, D0);
    const perpC = sub(oc, scale(D0, bc));
    const t = f(-bc - f(Math.sqrt(Math.max(f(f(R * R) - dot(perpC, perpC)), 0))));
    const P = [f(E[0] + f(D0[0] * t)), f(E[1] + f(D0[1] * t)), f(E[2] + f(D0[2] * t))];
    const n = scale(sub(P, C), 1 / R);
    const depthBody = project(V, P).depth;
    const depthArc = project(V, [f(C[0] + n[0] * 280.8), f(C[1] + n[1] * 280.8), f(C[2] + n[2] * 280.8)]).depth;
    const depthBehind = project(V, [f(C[0] - n[0] * 1000), f(C[1] - n[1] * 1000), f(C[2] - n[2] * 1000)]).depth;
    const steps = (depthBody - depthArc) * 16777216;   // depth24 quanta
    assert.ok(depthArc < depthBody && steps >= 8, `${label}: the arc floor is ${steps.toFixed(1)} depth24 steps in front of the body`);
    assert.ok(depthBehind > depthBody, `${label}: a line behind the body is hidden by its depth`);
    assert.ok(depthBody > 0 && depthBody < 1);
  }
});

test("theme: currentTheme() follows the stamped document even when storage throws (a late subscriber agrees with the screen)", () => {
  // src/theme.ts touches document / window / localStorage only inside functions; stub them in a fresh vm context
  const { outputText } = ts.transpileModule(readFileSync(new URL("../src/theme.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const listeners = {};
  const html = { dataset: {}, classList: { add() {}, remove() {} } };
  const ctx = {
    exports: {},
    require: () => ({}),
    document: { documentElement: html, querySelector: () => null },
    window: {
      addEventListener: (n, f) => { (listeners[n] ||= []).push(f); },
      removeEventListener: () => {},
      dispatchEvent: (e) => { (listeners[e.type] || []).forEach((f) => f(e)); return true; },
    },
    localStorage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } },
    matchMedia: () => ({ matches: true }), // reduced motion -> the transition-class timer path is skipped
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  vm.runInNewContext(outputText, ctx);
  const th = ctx.exports;
  assert.equal(th.currentTheme(), "dark");   // nothing stamped, storage blocked -> the default
  let seen = null;
  th.subscribeTheme((v) => { seen = v; });
  th.setTheme("light");                       // storage throws, the document is still stamped + the event fires
  assert.equal(html.dataset.theme, "light");
  assert.equal(seen, "light");
  assert.equal(th.storedTheme(), null);
  assert.equal(th.currentTheme(), "light");  // the stamp wins over the (unavailable) storage
  th.setTheme(null);
  assert.equal(th.currentTheme(), "dark");
});
