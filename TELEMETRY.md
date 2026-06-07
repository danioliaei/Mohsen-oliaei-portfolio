# On-device iPhone performance telemetry

A closed feedback loop for measuring this WebGPU homepage's render performance on a
**physical iPhone**, and iterating on it empirically. It has three parts:

1. **An HTTPS tunnel** so the phone gets a real secure-context URL (WebGPU is
   `undefined` over plain `http://<lan-ip>` — see [Why HTTPS is mandatory](#why-https-is-mandatory)).
2. **A same-origin collector** mounted on the dev/preview server (`POST /telemetry`)
   that appends each beacon to `telemetry.jsonl`.
3. **An in-app harness + HUD** (gated behind `?perf=1`) that captures per-frame
   timing on the device and beacons rolled-up summaries back.

> **Device requirement.** WebGPU on iPhone needs **iOS 26+ / Safari 26** (where it's
> enabled by default). On earlier iOS there's no `navigator.gpu` at all, so the app
> shows its unsupported notice and the HUD reports `❌ NO WEBGPU` — that's the device,
> not your setup.

> **What this can and cannot see.** iOS Safari exposes **no** Battery Status API,
> **no** `performance.memory`, and **no** GPU/thermal counters to a web app. Power
> and heat can only be **inferred** from frame-time behaviour over a sustained run —
> which is exactly what the per-5-second windows below are for. Don't expect direct
> temperature or battery numbers; they don't exist for web content on iOS.

---

## TL;DR — run the loop

Two terminals on the Mac/PC (same Wi-Fi as the iPhone):

```bash
# ── terminal 1: the app + collector ────────────────────────────────────────
# Accurate profiling uses the PRODUCTION bundle (minified, no dev/StrictMode
# overhead). This builds with the harness included and previews it on :4173.
npm run perf:preview          # → http://localhost:4173  (+ POST /telemetry)

# (for quick iteration instead, `npm run dev` on :5173 also serves the harness)

# ── terminal 2: a trusted HTTPS URL the phone can open ──────────────────────
npm run tunnel:preview        # cloudflared quick tunnel → https://<random>.trycloudflare.com
#   (use `npm run tunnel` if you're on the :5173 dev server)
```

Then on the **iPhone**, open the printed HTTPS URL with the perf flags:

```
https://<random>.trycloudflare.com/?perf=1&reset=1
```

- `?perf=1` activates the harness + HUD (it ships nothing without this flag).
- `?reset=1` truncates `telemetry.jsonl` so the run starts clean (optional; the
  HUD's **Reset** button does the same).
- `?phase=cold` (optional) sets the starting phase label.

Read the results back on the Mac/PC:

```bash
node read-telemetry.mjs          # summary + per-window throttling trend
# …or just open telemetry.jsonl — it's one JSON object per line.
```

---

## Why HTTPS is mandatory

`navigator.gpu` is only exposed in a **secure context**. `localhost` counts as
secure, but a LAN IP (`http://192.168.x.x`) does **not** — so if the phone loads
the app over plain HTTP, `navigator.gpu` is `undefined` and the app falls back to
its "WebGPU unavailable" notice (there is **no** WebGL2 fallback in this renderer).
Any "performance" measured that way is void.

The HUD makes this impossible to miss: if WebGPU isn't live it shows
**`❌ NO WEBGPU`** (with **`⚠ INSECURE CTX`** when the page isn't a secure
context). If you see that on a modern iPhone, **stop and fix the tunnel** before
trusting any numbers.

### Option A — cloudflared quick tunnel (recommended, zero cert install)

A cloudflared "quick tunnel" gives you an instant, **publicly-trusted** HTTPS URL
that proxies to your local server. The iPhone needs **nothing** installed — no
profile, no cert — because the cert chain is already trusted by iOS.

Install cloudflared on Windows (pick one):

```powershell
winget install --id Cloudflare.cloudflared    # or: scoop install cloudflared
# …or zero-install via npx (first run downloads the binary):
npx -y cloudflared --version
```

Run it against whichever local port you're serving:

```powershell
npm run tunnel:preview        # → cloudflared tunnel --url http://localhost:4173
# npm run tunnel              # → …--url http://localhost:5173  (the dev server)
```

cloudflared prints a line like `https://random-words-1234.trycloudflare.com`.
That's the URL to open on the phone. **It changes every run** — fine for dev.

### Option B — mkcert + LAN IP (offline fallback)

If you have no internet for a tunnel, serve the dev server over HTTPS on the LAN
and install a locally-trusted root CA on the iPhone:

1. `mkcert -install` on the computer, then `mkcert <your-lan-ip>` to mint a cert.
2. Point Vite at it (`server.https = { key, cert }`) and keep `server.host = true`
   (already set) so it binds `0.0.0.0`.
3. On the iPhone: AirDrop/email the mkcert **root CA** (`rootCA.pem`), install the
   resulting profile (Settings → Profile Downloaded → Install), **then** enable
   full trust under **Settings → General → About → Certificate Trust Settings**.
   Without that last toggle iOS may withhold secure-context features and silently
   kill WebGPU — which is why Option A is preferred.

> Do **not** use a bare self-signed cert with no trusted root: iOS can refuse to
> grant secure-context features even after you tap through the warning.

---

## What the harness captures

Activated only by `?perf=1` (and only present in dev builds or a `VITE_PERF=1`
build — a plain `npm run build` strips it entirely). It piggybacks on the scene's
existing `requestAnimationFrame`, so it measures the **exact render cadence** with
no second animation loop.

**Per frame (from rAF deltas):**

- Frame time (ms) → **p50 / p95 / p99 / max** over the whole run and a recent
  window. (Averages are useless for stutter — it's a tail-latency problem.)
- **`% frames over 16.7 ms`** (missed 60 fps) and **`% over 33 ms`** (missed 30 fps).
- Frame times bucketed into **per-5-second windows** across the whole run. A rising
  trend in the later windows is the only signal we get for **thermal throttling**.

**Sampled / logged:**

- **Which render path is live** — `navigator.gpu` presence, secure-context flag, and
  the live `RidgelineScene.info()` (`backend: "webgpu"`, adapter `hasF16` /
  `hasTimestamp`). Surfaced prominently; **`❌ NO WEBGPU`** means the run is void.
- **Effective `devicePixelRatio`** in use (after the `min(dpr, 2)` clamp) and the
  internal **supersample** factor + HDR render-target resolution (the real
  fill-rate driver).
- **Draw calls / triangles / filament line-segments** last frame (this renderer's
  `renderer.info`): **6** draws on the finished mountain, **7** during the
  globe/morph phase; ~**638k triangles** (the 760×420 terrain mesh) every frame.
- Viewport size, raw DPR, screen size, `userAgent`, secure-context.
- **`PerformanceObserver` longtask** count + total blocking time — **feature-
  detected**. iOS Safari does **not** support longtask, so the HUD/beacon report
  `lt n/a` there; that's expected, not a bug.

**Two outputs:**

- **On-screen HUD** (top-left, legible on a phone): live FPS, p95 frame time,
  budget-overrun %, active path, DPR + render res, draw/tri/line counts, longtask,
  phase, elapsed, and beacon status. Phase buttons (**Cold / Interact / Soak /
  End**) mark protocol boundaries; **Reset** truncates the collector file. The
  panel lets drags pass through to the canvas — only the buttons capture taps.
- **Beacon**: every ~2 s a rolled-up summary is POSTed via `navigator.sendBeacon`
  (fallback `fetch` keepalive) to `/telemetry`, same-origin behind the one tunnel.
  Each carries a `runId` + `ts` so multiple runs are separable, and is also flushed
  on phase change and on `pagehide`/tab-hide.

---

## On-device test protocol

Follow this on the phone; the harness stamps each phase into the telemetry.

1. **Cold load.** Open `…/?perf=1&reset=1`. **Confirm the HUD shows `✅ WebGPU`.**
   If it shows `❌ NO WEBGPU` / `⚠ INSECURE CTX`, stop — the tunnel/HTTPS setup
   failed (see [Why HTTPS is mandatory](#why-https-is-mandatory)). Leave it on the
   default **Cold** phase for ~15–30 s.
2. **Interaction pass (~30–60 s).** Tap **Interact** on the HUD, then exercise the
   heavy view: drag to orbit the mountain, open **Projects** and spin the dial,
   switch **Home ⇄ CV** to drive the morph. This is the worst case for the line
   animation + per-frame DOM projection.
3. **Soak test (3–5 min).** Tap **Soak** and leave the heavy view running
   **untouched**. This is how throttling shows up: watch the per-5-second windows
   trend upward as the SoC heats. Keep the screen on and the tab foreground.
4. **End.** Tap **End** (flushes a final beacon), then close the tab. The data is
   in `telemetry.jsonl`.

> Keep the iPhone off the charger and at a steady screen brightness across runs, so
> the only variable between iterations is your code change.

---

## How to read `telemetry.jsonl`

One JSON object per line (JSONL). The **last** record for a given `runId` is a
superset of the earlier ones (cumulative whole-run stats + the full window list),
so for a quick read you can just look at the final line per run.

Each record's shape:

```jsonc
{
  "runId": "mq3…",            // stable per page-load
  "ts": 1780840241386,         // client Date.now() at send
  "elapsedS": 30.01,
  "phase": "soak",             // cold | interact | soak | end
  "path": "webgpu",            // "none" ⇒ WebGPU not live ⇒ run is VOID
  "frames": 362,
  "frameMs": { "p50": 16.7, "p95": 18.9, "p99": 24.1, "max": 41.2, "mean": 17.0,
               "recentP95": 17.2 },
  "overBudget": { "over16Pct": 12.4, "over33Pct": 0.6 },
  "windows": [                 // per-5s buckets → the THROTTLING TREND
    { "i": 0, "frames": 300, "mean": 16.7, "p50": 16.7, "p95": 17.0, "max": 18.1 },
    { "i": 1, "frames": 298, "mean": 17.4, "p50": 16.9, "p95": 20.2, "max": 33.0 },
    …                          // later windows materially slower ⇒ THERMAL THROTTLE
  ],
  "longtask": { "supported": false, "count": 0, "totalBlockingMs": 0 },  // false on iOS
  "scene": { "backend": "webgpu", "hasF16": true, "hasTimestamp": true,
             "drawCalls": 6, "triangles": 638405, "lines": 0,
             "renderW": 2208, "renderH": 4784, "supersample": 2,
             "canvasW": 1170, "canvasH": 2532, "dpr": 2 },
  "viewport": { "cssW": 390, "cssH": 844 },
  "device": { "ua": "…iPhone…", "rawDpr": 3, "secureContext": true,
              "hasNavigatorGpu": true },
  "_rcv": "2026-06-07T13:50:41.388Z"   // server receive time (clock-skew check)
}
```

**What to look at, in order:**

1. **`path` / `scene.backend`** — must be `"webgpu"`. The other values: `"webgpu-starting"`
   (the first frames haven't sampled yet — ignore the first beacon or two), `"webgpu-failed"`
   (`navigator.gpu` exists but the device/adapter failed), `"none"` (no WebGPU at all —
   almost always an insecure HTTP context). **Anything but `"webgpu"` in the final record ⇒
   the run is void; fix HTTPS and re-run.** (On an iPhone, `device.rawDpr` is typically 3 but
   `scene.dpr` clamps to 2 — confirm the clamp is taking effect.)
2. **`frameMs.p95` / `.p99` / `.max`** and **`overBudget`** — is the tail within the
   60 fps (16.7 ms) budget? p99/max expose the stutters an average hides.
3. **`windows` trend** — compare the **last few windows to the first few**. If p50/p95
   climb materially over a 3–5 min soak (e.g. 16.7 → 22 → 28 ms), that's **thermal
   throttling**. A flat trend means the workload is sustainable.
4. **`scene`** — `renderW × renderH` is the fill-rate the GPU is pushing. On a DPR-3
   iPhone with `supersample: 2`, the HDR target is enormous relative to the screen —
   the prime suspect for an over-budget frame (see the optimization ladder).
5. **`longtask`** — on platforms that support it, high `totalBlockingMs` points at
   CPU/JS/GC cost rather than GPU fill. On iOS it's `n/a`.

A tiny reader (`read-telemetry.mjs`) is included for a one-glance summary:

```bash
node read-telemetry.mjs            # defaults to ./telemetry.jsonl
```

---

## Iterating: the optimization ladder

Change **one** thing per iteration, then re-run the **same** protocol and compare the
same numbers — so each delta is attributable. Apply in this priority order (highest
expected impact first for *this* workload, which is fill-rate-bound):

1. **DPR / supersample clamp.** This app renders the HDR scene at
   `supersample = min(dpr × 1.4, 2)` on top of a DPR clamped to 2 — so a DPR-3
   iPhone pushes a render target up to ~2× CSS pixels per axis (~4× the pixels),
   plus a half-res bloom. Lowering the clamp (e.g. cap DPR at 1.5, or supersample at
   1.25 on phones) is the biggest single fill-rate lever. → `RidgelineStage.tsx`
   `resize()` and `ridgeline.ts` `resize()`'s `sc`.
2. **Frame cap.** If the device can't hold 60, a stable 30 reads better than a jittery
   45 — cap the rAF cadence and halve the heat.
3. **Visibility pause.** Stop the rAF when the tab/scene isn't visible
   (`visibilitychange` / `IntersectionObserver`) so a backgrounded tab doesn't cook.
4. **Overdraw / pass reduction.** Trim the bloom (downsample further, fewer blur
   taps) and the supersample box-downsample cost.
5. **Geometry / instanced-quad.** 638k triangles every frame for the terrain is a lot;
   consider a coarser mesh on phones, or an LOD on `NX`/`NZ`.
6. **Compute.** Move per-frame CPU work (e.g. the DOM survey/label projection) off the
   main thread or into a compute pass only if the above don't close the gap.

**Stop** when the soak test holds a stable frame time within budget across all
windows. Don't keep optimizing past that.

---

## Manual complement — Safari Web Inspector (deeper GPU look)

The beacon tells you *that* you're slow and *when* (the throttling trend); the Web
Inspector tells you *where* the GPU time goes. **This requires a Mac** — Safari's
Web Inspector (and its Graphics/Timelines view) is macOS-only and cannot be driven
from Windows.

**If you have a Mac on the same network:**

1. iPhone: **Settings → Safari → Advanced → Web Inspector = On**.
2. Mac Safari: **Settings → Advanced → Show features for web developers**. Connect
   the iPhone by USB and trust the computer.
3. Mac Safari **Develop** menu → select the iPhone → the app's tab → **Open Web
   Inspector** → **Timelines** tab → **Record** while reproducing the lag.

   Watch three timelines:
   - **JavaScript & Events / CPU** — long main-thread tasks (our per-frame DOM
     projection, easing math). Healthy: short, evenly-spaced bars at 60 Hz.
     Pathological: fat bars > 16 ms or pile-ups during the interaction pass.
   - **Frames / Rendering** — the actual frame rate and dropped frames. Healthy: a
     steady 60 fps band. Pathological: a sawtooth dipping under 60/30.
   - **Graphics / Canvas (rendering)** — the GPU/compositing cost per frame. For
     this fill-bound workload, this is where a too-high DPR/supersample shows up as
     long per-frame raster time even when JS is idle.

**On Windows (no Mac):** Safari Web Inspector is unavailable. The practical path is:

- **The in-app HUD + `telemetry.jsonl` are your primary tool** — they're
  cross-platform and capture the frame-time tail and throttling trend directly on
  the device.
- iOS remote debugging *from Windows* is possible only via third-party adapters
  (e.g. `ios-webkit-debug-proxy` + `remotedebug-ios-webkit-adapter`, driving Chrome
  DevTools against the iOS WebKit protocol). These surface **DOM / console /
  sources** but **not** the frame-rate or Graphics/Canvas timeline — so the deep
  GPU-cost view stays effectively Mac-only. Borrow a Mac for that step if you need
  it; otherwise iterate against the beacon numbers.

---

## Files

| File | Role |
| --- | --- |
| `src/perf/harness.ts` | The `?perf=1` capture + HUD + beacon (lazy-loaded chunk). |
| `src/perf/types.ts` | Shared `SceneInfo` type (renderer ⇄ harness). |
| `telemetry-collector.ts` | Vite plugin: `POST /telemetry[/reset]` → `telemetry.jsonl`. |
| `read-telemetry.mjs` | One-glance summary + throttling-trend printer. |
| `src/gpu/ridgeline.ts` | `RidgelineScene.info()` — the live render-path snapshot. |
| `telemetry.jsonl` | The captured run data (gitignored). |

**Production safety:** a plain `npm run build` dead-code-eliminates the harness
import entirely — zero perf code in the shipped bundle. `npm run perf:build` /
`perf:preview` (which set `VITE_PERF=1`) emit it as a separate lazy chunk that's
only fetched when the URL carries `?perf=1`.
