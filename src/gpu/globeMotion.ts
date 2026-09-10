/* =========================================================================
   globeMotion — pure JS twins of the shared WGSL clock / rigid motion that live in
   RIDGE_FRAME_WGSL + RIDGE_FILAMENT_WGSL (ridgelineShaders.ts).

   No DOM, no GPU: loadable by tests/globe.test.mjs (ts.transpileModule + vm) and by the
   stage (RidgelineStage imports globeNutation; updateCloud inlines tiltH so its per-letter
   loop stays allocation-free). Every constant here MUST equal its WGSL twin — the ball's
   heart (the backdrop body), the skin arcs, the pressure wave and the DOM letter cloud all
   read the same 4-second beat and the same rigid tilt from these numbers, and the tests
   guard the pairing (a mismatch would un-weld the letters from the crust).
   ========================================================================= */

// ---- THE BEAT: one 4-second organic pulse (gamma-shaped: onset at phase 0, peak 1.0 at
// BEAT_PEAK, long decay). BEAT_MEAN is the period average; reduced motion freezes the GPU
// beatMix() AT the mean so every (beat - BEAT_MEAN) term sits at its average look. ----
export const BEAT_PERIOD = 4;          // s  == BEAT_PERIOD (WGSL)
export const BEAT_PEAK = 0.20;         //    == BEAT_PEAK
export const BEAT_MEAN = 0.368;        //    == BEAT_MEAN (measured 0.3684 over a period)
export const TAU = Math.PI * 2;
/** fract(t / BEAT_PERIOD) — 0 = the pulse ONSET; robust for negative t. */
export const beatPhase = (t: number): number => (((t / BEAT_PERIOD) % 1) + 1) % 1;
/** The gamma pulse: x^2 e^(2 - 2x) with x = ph / BEAT_PEAK; exactly 1 at ph == BEAT_PEAK, 0 at onset. */
export const beatPulse = (ph: number): number => { const x = ph / BEAT_PEAK; return x * x * Math.exp(2 - 2 * x); };

// ---- AXIS LEAN (nutation): the spin axis leans NUT_OBLIQUITY and the lean's direction walks
// once around per NUT_PRECESS_BEATS beats — a gyroscope, never a wobble (no breath). ----
export const NUT_OBLIQUITY = 0.10;     // rad — the spin axis leans 5.7 deg; 0 removes the idea at zero cost
export const NUT_PRECESS_BEATS = 12;   // the lean's direction walks once around per 48 s
export type V3 = [number, number, number];
const sstep = (e0: number, e1: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
/** The rigid tilt the GPU ball, the terrain sphere skin and the DOM letters ALL apply last.
 *  angle is EXACTLY +0 for mc >= 0.30, projAmt >= 0.15, or reduced motion — so the terrain VS's
 *  uniform "F.x2.z != 0.0" branch is skipped and the morph / Projects / still frames stay byte-identical. */
export function globeNutation(t: number, mc: number, projAmt: number, still: boolean): { ax: number; az: number; angle: number } {
  const phi = (TAU * t) / (NUT_PRECESS_BEATS * BEAT_PERIOD);
  const gate = (1 - sstep(0, 0.30, mc)) * (1 - sstep(0, 0.15, projAmt)) * (still ? 0 : 1);
  return { ax: Math.cos(phi), az: Math.sin(phi), angle: NUT_OBLIQUITY * gate };
}
/** Rodrigues about the unit HORIZONTAL axis (ax, 0, az); c = cos(angle), s = sin(angle) hoisted by the caller.
 *  Identical to the WGSL one-liner: v*c + cross(k,v)*s + k*dot(k,v)*(1-c). */
export function tiltH(v: V3, ax: number, az: number, c: number, s: number): V3 {
  const om = 1 - c, kd = ax * v[0] + az * v[2];
  return [v[0] * c + (-az * v[1]) * s + ax * kd * om,
          v[1] * c + (az * v[0] - ax * v[2]) * s,
          v[2] * c + (ax * v[1]) * s + az * kd * om];
}

// ---- per-vertex tangent angle (the 8th vertex float) — ONE convention, twice (TS builder + WGSL decode) ----
const norm3 = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Basis of the tangent plane at unit d. The threshold is tested in f32 (Math.fround) because the VS decides
 *  step(0.99, abs(normalize(mdir).y)) on the f32 VBO value. == WGSL: up = mix((0,1,0),(1,0,0),step(0.99,|d.y|)). */
export function tangentBasis(d: V3): [V3, V3] {
  const up: V3 = Math.abs(Math.fround(d[1])) >= 0.99 ? [1, 0, 0] : [0, 1, 0];
  const e1 = norm3(cross3(up, d));
  return [e1, cross3(d, e1)];
}
/** Angle of tangent T (perpendicular to d) in the basis; 0 when T is degenerate (a zero-length chord). */
export function tangentAngle(d: V3, T: V3): number {
  if (Math.hypot(T[0], T[1], T[2]) < 1e-12) return 0;
  const [e1, e2] = tangentBasis(d);
  return Math.atan2(dot3(T, e2), dot3(T, e1));
}
export function tangentFromAngle(d: V3, a: number): V3 {
  const [e1, e2] = tangentBasis(d); const c = Math.cos(a), s = Math.sin(a);
  return [e1[0] * c + e2[0] * s, e1[1] * c + e2[1] * s, e1[2] * c + e2[2] * s];
}
/** The chord of a segment, projected into the tangent plane of endpoint d, as a unit vector (zero if degenerate). */
export function chordTangent(d: V3, other: V3): V3 {
  const c: V3 = [other[0] - d[0], other[1] - d[1], other[2] - d[2]];
  const k = dot3(c, d); const p: V3 = [c[0] - d[0] * k, c[1] - d[1] * k, c[2] - d[2] * k];
  return Math.hypot(p[0], p[1], p[2]) < 1e-12 ? [0, 0, 0] : norm3(p);
}
