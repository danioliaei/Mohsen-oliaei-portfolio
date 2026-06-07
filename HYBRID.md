# HYBRID.md — should we build a "precompute + live-perturbation bake" pipeline for the hero?

**Verdict: No — don't build it. It is the wrong lever for this scene.** Instead we took the
load-time wins that actually apply here: **code-split the renderer off the critical path** and
**reduce the line geometry** (fewer additive segments + a smaller init buffer). This document
records the invariant/live split, why baking fails the brief's own hard gate, what *did* improve,
and the remaining levers worth doing.

This was produced by reading the live code (`src/gpu/ridgeline.ts`, `src/gpu/ridgelineShaders.ts`,
`src/components/RidgelineStage.tsx`, `TELEMETRY.md`) and an adversarial 2-opinion diagnosis +
critic pass. Both opinions and the critic independently reached "don't build."

---

## Phase 1 — invariant vs. live split

The "line motion" lives in a CPU geometry build (`buildFilamentGeometry`, `ridgeline.ts`) and a GPU
vertex shader (`RIDGE_FILAMENT_WGSL`, `ridgelineShaders.ts`).

**Invariant (precomputable — and already precomputed):**
- The rest-pose geometry of every line: base material direction `mdir`, `t`-along-line, the `seed`
  (which also encodes the class sentinel), base brightness, radial shell.
- The deterministic curl walk that builds it (`fbm2`/`noiseVec`/`nearNodeGlow`, Rodrigues rotation),
  the Fibonacci node/spoke/ring lattices, and the seeded `mulberry32` PRNG (no `Math.random`).
- **This is exactly what `buildFilamentGeometry()` already does — once, at scene construction,
  writing one static VBO.** There is no per-frame geometry rebuild to hoist. The invariant is
  already baked in GPU memory for the lifetime of the scene.

**Live (must stay on device — a function of time/pointer/scroll):**
- Tangential flow shimmer, breathing pump, counter-rotating depth spin (`F.mph.y`), gimbal-ring
  precession, halo orbit — all keyed to `time` (`F.a.x`).
- The whole morph (drain → pour → nucleus-lift) keyed to `F.mph.x`, eased per-frame toward the
  Home/CV target.
- Every per-vertex brightness term (travelling pulse, convergence volley, twinkle, spoke-fire wave,
  ring dash-scroll, soma beat, firing wave) and the Projects-dial straighten/formation (`F.mph.w`).
- The pointer camera (yaw/pitch orbit, focus dolly, lens shift, the aspect-aware `globeStart`).

A "precompute + live-perturbation" architecture would precompute precisely what is already
precomputed, and would still run 100% of the perturbation live. **Net structural win: zero.**

---

## The hard gate — three independent disqualifiers

The brief says to build the pipeline only if per-frame animation/layout **compute** (or asset
**download/parse**) is a material cost; it does not help fill rate; and if the bottleneck is fill
rate (or little is invariant), document that and recommend the local fixes. Applying it honestly:

| Gate condition | Reality |
| --- | --- |
| Per-frame layout/animation **compute** to precompute away? | **No.** The VBO is built once at init; per-frame work is a vertex shader over a static buffer. No per-frame CPU layout, no compute pass. |
| An **asset downloaded/parsed** that baking would replace? | **No.** `buildFilamentGeometry()` runs locally at init. `public/` ships zero geometry blobs; nothing is fetched/parsed. Baking would *add* a download, not replace one. |
| Is the bottleneck **fill rate**? | **Yes.** `TELEMETRY.md` states the workload is fill-rate-bound and ranks DPR/supersample #1, compute/baking last. |
| Is much of the motion **invariant**? | **No.** The base geometry is, but every visible motion is live. The live layer is already minimal. |

### What baking would cost
The filament VBO (`vertex = 7 floats {dir.xyz, t, seed, brightness, radial}`, stride 28 B,
line-list), **after** the simplification below:

| Profile | Vertices | Bytes |
| --- | --- | --- |
| Desktop | ~50,896 | ~1.43 MB |
| Phone | ~41,720 | ~1.17 MB |

It is **computed locally**, not downloaded — ~a few ms warm on desktop, ~25–60 ms one-time on a
phone, and that hitch already overlaps the awaited `createGPU`/`createRenderPipelineAsync` that
dominates startup. Baking would replace that free local compute with a **multi-hundred-KB-to-~1.4 MB
download** on the cold-load critical path (mobile RTT/throttling), plus parse + GPU upload — a
*larger* payload than the few KB of JS that generates it. Quantizing to f16/snorm halves the bytes
but still adds a net-new download + dequant the page doesn't pay today. On iOS the texture-bake
variant is constrained to `rgba16float` (no float32 filtering). **It makes phone load worse.**

### What baking would / would not improve
- **Would not:** per-frame frame time (the build is one-time), fill rate (baking never touches
  fragment cost — the actual bottleneck), cold load (it *adds* bytes).
- **Would (marginally):** the one-time init CPU hitch — but only by trading it for a worse
  network/parse/upload cost. Net loss.

---

## What we did instead (shipped in this change)

1. **Code-split the renderer (the real load win).** `App.tsx` imported `RidgelineStage` eagerly, so
   the WebGPU renderer + all WGSL + `buildFilamentGeometry` + `motion` sat in the initial bundle.
   It is now `React.lazy` behind a bare-black `Suspense` fallback, and `Header` was converted from
   `motion` to CSS entrance animations so `motion` lives **only** in the lazy chunk. Result:

   | | Initial JS (raw / gzip) | Lazy renderer chunk |
   | --- | --- | --- |
   | Before | 441 KB / 145 KB | — (single chunk) |
   | After | **196 KB / 62 KB** | 245 KB / 84 KB |

   The HTML + header (wordmark/nav) now paint after ~62 KB gzip instead of ~145 KB; the renderer
   streams in after. Unlike baking, this **removes** bytes from the critical path.

2. **Reduced the line geometry** (also the visual "simpler globe/mountain" ask): fewer curl threads,
   motes, gimbal rings and node sparks. Filament segments dropped ~32% on desktop / ~27% on phone
   (75,184 → 50,896 verts desktop; 57,232 → 41,720 phone). That trims additive overdraw on the
   fill-bound path **and** shrinks the one-time init build.

3. **Desktop supersample** nudged 2 → 2.25 (crisper desktop lines), paid for by the freed geometry
   budget. Phone supersample/DPR were left unchanged in *this* pass — phone is fill/thermal-bound, so
   phone sharpness came from the (free) AA tightening, not more pixels. (A later pass nudged
   `PHONE_SC_CAP` 2.5 → 2.75 for crisper phone hairlines; the phone DPR cap stays 2.5.)

---

## Remaining levers worth doing (ranked) — recommended follow-ups

These are runtime/thermal wins that need on-device telemetry to tune (per `TELEMETRY.md`), so they
are deliberately left as separate, measurable steps rather than bundled blindly here:

1. **DPR / supersample clamp on phone** — the single biggest fill lever. Lower the `RidgelineStage`
   phone DPR cap (currently 2.5) and `PHONE_SC_CAP` (currently 2.75) and re-run the soak test. A DPR-3 phone
   rasterizes ~4× the pixels; this trades a little hairline crispness for sustained frame time.
2. **Visibility pause** — the rAF runs unconditionally; gate it on `visibilitychange` + an
   `IntersectionObserver` on the canvas so a backgrounded/scrolled-away tab stops cooking the SoC.
   Pure win, no visual cost. (Reset the loop's `dt` clock on resume.)
3. **Frame cap to 30 fps** on throttling phones — the loop already has `dt`; add an accumulator. A
   stable 30 reads better than a jittery 45 and roughly halves heat.
4. **Overdraw / pass reduction** — trim bloom taps/resolution on small viewports.
5. **Throttle per-frame DOM work** (`updateCloud`/`updateSurvey`/`updateTimeline`) when nothing moves.

**Stop** when the soak test holds a stable frame time within budget across all windows. Don't keep
optimizing past that — and don't reach for a bake pipeline: it is not the lever for this scene.
