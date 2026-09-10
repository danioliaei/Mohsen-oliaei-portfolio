/* =========================================================================
   On-device WebGPU perf telemetry harness + HUD.

   Self-contained and toggleable: RidgelineStage dynamically imports `startPerf`
   ONLY when the URL carries `?perf=1` AND the build included it (dev, or a build
   made with VITE_PERF=1). A plain `vite build` dead-code-eliminates the import,
   so production ships nothing.

   It piggybacks on the scene's existing rAF: RidgelineStage calls `frame(now)`
   once per rendered frame with the rAF timestamp, so we measure the EXACT render
   cadence — no second rAF, no double-scheduling. From those deltas we compute the
   only signals an iOS web app can actually see (Safari exposes no battery, no
   thermal, no GPU counters): frame-time tail latency, budget overruns, and the
   per-5-second trend that betrays thermal throttling over a soak.

   Two outputs: a legible on-screen HUD (read state directly on the phone) and a
   ~2s `sendBeacon` roll-up POSTed same-origin to /telemetry (the dev/preview
   server's collector appends it to telemetry.jsonl).
   ========================================================================= */

import type { SceneInfo } from "./types";

export interface PerfOptions {
  /** Pull the live render-path snapshot (sampled, not every frame). */
  getSceneInfo?: () => SceneInfo | null;
  /** True when the WebGPU scene FAILED to initialise (no `navigator.gpu`, or the
   *  adapter/device/attach step failed). Lets the HUD/beacon report "init failed"
   *  distinctly from "still starting". The harness is started even in this case so
   *  the HUD can diagnose the secure-context trap (insecure HTTP → no WebGPU). */
  sceneFailed?: boolean;
  /** Collector endpoint. Default "/telemetry" (same-origin behind the tunnel). */
  endpoint?: string;
  /** Beacon cadence in ms. Default 2000. */
  beaconMs?: number;
  /** Frame-time bucket window in ms. Default 5000 (the throttling trend grain). */
  windowMs?: number;
  /** Sample getSceneInfo every N frames. Default 30. */
  sampleInfoEveryFrames?: number;
}

export interface PerfHandle {
  /** Call once per rendered frame with the rAF high-res timestamp. */
  frame(now: number): void;
  /** Mark a test-protocol phase boundary (also settable via the HUD buttons). */
  setPhase(phase: string): void;
  /** Tear down: flush a final beacon, disconnect observers, remove the HUD. */
  stop(): void;
}

const BUDGET_60 = 1000 / 60; // 16.667 ms
const BUDGET_30 = 1000 / 30; // 33.333 ms
const RECENT_CAP = 600; // ~10 s of frames for the live HUD percentiles
const PHASES = ["cold", "interact", "soak", "end"] as const;

/** ascending-sorted percentile (linear pick); arr must be pre-sorted. */
function pctOf(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

interface WindowAgg {
  i: number;
  t: number[]; // frame times (ms) within this 5 s window
}

function summarizeWindow(w: WindowAgg) {
  const s = [...w.t].sort((a, b) => a - b);
  const n = s.length;
  let sum = 0;
  for (const v of s) sum += v;
  return {
    i: w.i,
    frames: n,
    mean: n ? +(sum / n).toFixed(2) : 0,
    p50: +pctOf(s, 50).toFixed(2),
    p95: +pctOf(s, 95).toFixed(2),
    p99: +pctOf(s, 99).toFixed(2),
    max: n ? +s[n - 1].toFixed(2) : 0,
  };
}

export function startPerf(opts: PerfOptions = {}): PerfHandle {
  const endpoint = opts.endpoint ?? "/telemetry";
  const beaconMs = opts.beaconMs ?? 2000;
  const windowMs = opts.windowMs ?? 5000;
  const sampleEvery = opts.sampleInfoEveryFrames ?? 30;

  const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // ---- run state ----------------------------------------------------------
  const t0 = performance.now();
  let prev = -1; // last frame timestamp; -1 until the first frame
  let started = false;
  let frames = 0;
  let over16 = 0;
  let over33 = 0;
  let sumMs = 0;
  let maxMs = 0;
  let phase: string = (params.get("phase") || "cold").toLowerCase();

  // whole-run frame times for percentiles, bounded by a ring so a very long run (left
  // running for an hour) can't grow the beacon's sort cost without bound and start
  // polluting the very measurement it takes. Holds the last MAX_ALL frames (~10 min
  // @60fps); the 3–5 min protocol never wraps, so it's the whole run. The ring writes
  // in place (no per-frame shift).
  const MAX_ALL = 36000;
  const all: number[] = [];
  let allIdx = 0;
  // per-5s windows for the throttling trend. Only the CURRENT window keeps its raw frame
  // times; each window is summarised the instant it closes and its raw array dropped — so
  // memory + per-beacon cost stay flat regardless of run length.
  const closedWindows: ReturnType<typeof summarizeWindow>[] = [];
  let curWindow: WindowAgg | null = null;
  // recent ring for the live HUD percentiles
  const recent: number[] = [];

  let lastInfo: SceneInfo | null = null;
  let lastBeaconOk: boolean | null = null;

  // ---- longtask observer (feature-detected; iOS Safari does NOT support it) --
  let longtaskSupported = false;
  let longtaskCount = 0;
  let longtaskBlockingMs = 0;
  let observer: PerformanceObserver | null = null;
  try {
    const PO = typeof PerformanceObserver !== "undefined" ? PerformanceObserver : null;
    const supported = PO && (PO as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes;
    if (PO && Array.isArray(supported) && supported.includes("longtask")) {
      longtaskSupported = true;
      observer = new PO((list) => {
        for (const e of list.getEntries()) {
          longtaskCount++;
          longtaskBlockingMs += Math.max(0, e.duration - 50); // blocking time over the 50ms bar
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    }
  } catch {
    /* observer is a bonus; never required */
  }

  // ---- static device context (logged with every beacon) ------------------
  const device = {
    ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
    rawDpr: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
    screenW: typeof screen !== "undefined" ? screen.width : 0,
    screenH: typeof screen !== "undefined" ? screen.height : 0,
    secureContext: typeof isSecureContext !== "undefined" ? isSecureContext : false,
    hasNavigatorGpu: typeof navigator !== "undefined" && "gpu" in navigator && !!navigator.gpu,
  };

  // The render-path state, shared by the HUD label and the beacon so they never disagree:
  //   live     → WebGPU up and rendering (we have a SceneInfo snapshot)
  //   failed   → navigator.gpu present but the scene failed to initialise
  //   starting → navigator.gpu present, no snapshot yet (still booting)
  //   none     → no navigator.gpu at all — almost always an INSECURE HTTP context
  const pathState = (): "live" | "failed" | "starting" | "none" => {
    if (!device.hasNavigatorGpu) return "none";
    if (lastInfo) return "live";
    if (opts.sceneFailed) return "failed";
    return "starting";
  };

  // =========================================================================
  // HUD
  // =========================================================================
  const hud = document.createElement("div");
  hud.id = "perf-hud";
  hud.setAttribute("role", "status");
  hud.style.cssText = [
    "position:fixed",
    "top:max(8px,env(safe-area-inset-top))",
    "left:max(8px,env(safe-area-inset-left))",
    "z-index:2147483647",
    "font:600 12px/1.32 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
    "color:#eafff0",
    "background:rgba(6,10,9,0.82)",
    "border:1px solid rgba(120,255,180,0.28)",
    "border-radius:9px",
    "padding:8px 9px",
    "min-width:188px",
    "max-width:62vw",
    "letter-spacing:0.02em",
    "backdrop-filter:blur(6px)",
    "-webkit-backdrop-filter:blur(6px)",
    "pointer-events:none", // let drags pass THROUGH the panel to the canvas…
    "user-select:none",
    "white-space:pre",
    "box-shadow:0 6px 22px rgba(0,0,0,0.45)",
  ].join(";");

  const readout = document.createElement("div");
  readout.style.cssText = "pointer-events:none";
  hud.appendChild(readout);

  // …except the buttons, which re-enable pointer events
  const buttonRow = document.createElement("div");
  buttonRow.style.cssText =
    "pointer-events:auto;display:flex;flex-wrap:wrap;gap:4px;margin-top:7px";
  hud.appendChild(buttonRow);

  const mkBtn = (label: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText = [
      "font:600 11px/1 ui-monospace,Menlo,Consolas,monospace",
      "color:#dffff0",
      "background:rgba(20,40,34,0.9)",
      "border:1px solid rgba(120,255,180,0.34)",
      "border-radius:6px",
      "padding:5px 7px",
      "cursor:pointer",
      "touch-action:manipulation",
      "-webkit-tap-highlight-color:transparent",
    ].join(";");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  };

  const renderPhaseButtons = () => {
    for (const p of PHASES) {
      const b = mkBtn(p === "interact" ? "Interact" : p[0].toUpperCase() + p.slice(1), () => setPhase(p));
      b.dataset.phase = p;
      buttonRow.appendChild(b);
    }
    buttonRow.appendChild(
      mkBtn("Reset", () => {
        resetCollector();
      }),
    );
  };
  renderPhaseButtons();

  const highlightPhase = () => {
    for (const b of Array.from(buttonRow.children) as HTMLButtonElement[]) {
      if (!b.dataset.phase) continue;
      const on = b.dataset.phase === phase;
      b.style.background = on ? "rgba(120,255,180,0.92)" : "rgba(20,40,34,0.9)";
      b.style.color = on ? "#04140d" : "#dffff0";
    }
  };

  document.body.appendChild(hud);
  highlightPhase();

  let lastHudT = -1e9;
  const updateHud = (now: number) => {
    const sorted = [...recent].sort((a, b) => a - b);
    const p95 = pctOf(sorted, 95);
    const p50 = pctOf(sorted, 50);
    const fps = p50 > 0 ? 1000 / p50 : 0;
    const over16Pct = frames ? (over16 / frames) * 100 : 0;
    const over33Pct = frames ? (over33 / frames) * 100 : 0;
    const elapsed = (now - t0) / 1000;

    const ps = pathState();
    const path =
      ps === "live" ? "✅ WebGPU"
      : ps === "failed" ? "❌ WEBGPU INIT FAILED"
      : ps === "starting" ? "⏳ WebGPU (starting)"
      : "❌ NO WEBGPU";
    const secure = device.secureContext ? "" : "  ⚠ INSECURE CTX";

    const info = lastInfo;
    const res = info ? `${info.renderW}×${info.renderH}  ss${info.supersample.toFixed(2)}` : "—";
    const draws = info ? `${info.drawCalls} draw / ${(info.triangles / 1000).toFixed(0)}k tri${info.lines ? ` / ${info.lines} ln` : ""}` : "—";
    const dpr = info ? info.dpr.toFixed(2) : device.rawDpr.toFixed(2);

    readout.textContent =
      `${path}${secure}\n` +
      `fps ${fps.toFixed(0).padStart(3)}   p95 ${p95.toFixed(1)}ms\n` +
      `>16.7ms ${over16Pct.toFixed(1)}%  >33ms ${over33Pct.toFixed(1)}%\n` +
      `dpr ${dpr}   ${res}\n` +
      `${draws}\n` +
      `lt ${longtaskSupported ? `${longtaskCount} / ${longtaskBlockingMs.toFixed(0)}ms` : "n/a"}\n` +
      `phase ${phase}   ${elapsed.toFixed(0)}s   #${frames}\n` +
      `beacon ${lastBeaconOk === null ? "—" : lastBeaconOk ? "ok" : "FAIL"}   ${runId}`;
  };
  // paint once immediately, so the path/secure-context verdict shows even when the
  // scene failed to start and no frames will ever drive the loop (the diagnosis case)
  updateHud(performance.now());

  // =========================================================================
  // beacon
  // =========================================================================
  const BEACON_PATH = { live: "webgpu", failed: "webgpu-failed", starting: "webgpu-starting", none: "none" } as const;
  const buildSample = (now: number) => {
    const sortedAll = [...all].sort((a, b) => a - b);
    const sortedRecent = [...recent].sort((a, b) => a - b);
    const winList = curWindow ? [...closedWindows, summarizeWindow(curWindow)] : [...closedWindows];
    return {
      runId,
      ts: Date.now(),
      elapsedS: +((now - t0) / 1000).toFixed(2),
      phase,
      path: BEACON_PATH[pathState()],
      frames,
      frameMs: {
        p50: +pctOf(sortedAll, 50).toFixed(2),
        p95: +pctOf(sortedAll, 95).toFixed(2),
        p99: +pctOf(sortedAll, 99).toFixed(2),
        max: +maxMs.toFixed(2),
        mean: frames ? +(sumMs / frames).toFixed(2) : 0,
        recentP95: +pctOf(sortedRecent, 95).toFixed(2),
      },
      overBudget: {
        over16Pct: frames ? +((over16 / frames) * 100).toFixed(2) : 0,
        over33Pct: frames ? +((over33 / frames) * 100).toFixed(2) : 0,
      },
      windows: winList,
      longtask: {
        supported: longtaskSupported,
        count: longtaskCount,
        totalBlockingMs: +longtaskBlockingMs.toFixed(1),
      },
      scene: lastInfo,
      viewport: {
        cssW: typeof window !== "undefined" ? window.innerWidth : 0,
        cssH: typeof window !== "undefined" ? window.innerHeight : 0,
      },
      device,
    };
  };

  const send = (payload: unknown) => {
    const body = JSON.stringify(payload);
    try {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        const ok = navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
        lastBeaconOk = ok;
        if (ok) return;
      }
    } catch {
      /* fall through to fetch */
    }
    try {
      fetch(endpoint, {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
        keepalive: true,
      })
        .then((r) => {
          lastBeaconOk = r.ok;
        })
        .catch(() => {
          lastBeaconOk = false;
        });
    } catch {
      lastBeaconOk = false;
    }
  };

  const resetCollector = () => {
    try {
      fetch(endpoint + "/reset", { method: "POST", keepalive: true }).catch(() => {});
    } catch {
      /* ignore */
    }
  };

  // optional run-start reset (the protocol calls /telemetry/reset before a run)
  if (params.get("reset") === "1") resetCollector();

  const beaconTimer: ReturnType<typeof setInterval> = setInterval(() => {
    send(buildSample(performance.now()));
  }, beaconMs);

  // flush on tab hide / unload — iOS fires `pagehide`, not always `beforeunload`
  const onHide = () => send(buildSample(performance.now()));
  const onVisibility = () => {
    if (document.visibilityState === "hidden") onHide();
    prev = -1; // a intentional rendering pause is not a dropped frame
  };
  window.addEventListener("pagehide", onHide);
  window.addEventListener("visibilitychange", onVisibility);

  // =========================================================================
  // the per-frame hook
  // =========================================================================
  function frame(now: number): void {
    if (prev < 0) {
      prev = now;
      started = true;
      return; // skip the first delta (no baseline yet)
    }
    const dt = now - prev; // raw inter-frame interval = frame time (ms)
    prev = now;
    if (!started) return;

    frames++;
    sumMs += dt;
    if (dt > maxMs) maxMs = dt;
    if (dt > BUDGET_60) over16++;
    if (dt > BUDGET_30) over33++;

    if (all.length < MAX_ALL) all.push(dt);
    else { all[allIdx] = dt; allIdx = (allIdx + 1) % MAX_ALL; } // ring write — no per-frame shift
    recent.push(dt);
    if (recent.length > RECENT_CAP) recent.shift();

    const wi = Math.floor((now - t0) / windowMs);
    if (!curWindow || curWindow.i !== wi) {
      if (curWindow) closedWindows.push(summarizeWindow(curWindow)); // finalise + drop the raw frames
      curWindow = { i: wi, t: [] };
    }
    curWindow.t.push(dt);

    if (opts.getSceneInfo && frames % sampleEvery === 0) {
      try {
        lastInfo = opts.getSceneInfo();
      } catch {
        /* leave the previous snapshot */
      }
    }

    if (now - lastHudT > 250) {
      lastHudT = now;
      updateHud(now);
    }
  }

  function setPhase(p: string): void {
    if (phase === p) return;
    // flush the OUTGOING phase so a window boundary is captured in the file
    send(buildSample(performance.now()));
    phase = p;
    highlightPhase();
    if (p === "end") send(buildSample(performance.now()));
  }

  function stop(): void {
    clearInterval(beaconTimer);
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("visibilitychange", onVisibility);
    try {
      observer?.disconnect();
    } catch {
      /* ignore */
    }
    send(buildSample(performance.now())); // final flush
    hud.remove();
  }

  return { frame, setPhase, stop };
}
