import { useEffect, useRef, useState } from "react";
import {
  RidgelineScene,
  PITCH_LO,
  PITCH_HI,
  ridgeCamera,
  projectToScreen,
  ringAnchor,
} from "../road/gpu/ridgeline";

/* =========================================================================
   RidgelineStage — mounts the monochrome ridgeline experiment.

   A single static hero (no scroll journey, no cards): a black full-screen
   canvas the RidgelineScene draws into on a continuous rAF. Left-drag (mouse or
   touch) — or the arrow keys — orbits the camera a full turn around the summit,
   with a release-flick that keeps it spinning before easing to rest; a whisper
   of breathing keeps an untouched mountain alive. Falls back to a quiet notice
   on browsers without WebGPU.
   ========================================================================= */

/* ---- B1 survey callouts: one per index-contour RING -----------------------
   Listed in REVEAL order — the order you meet them as you orbit away from the
   silent rest pose — newest (the tight summit ring) first, so a single orbit
   walks the career DOWN the mountain, present → past. Each `radius` is the plan
   radius of the ring it pins to and mirrors RING_RADII in ridgeline.ts (720 =
   hugging the summit … 5600 = the wide ring sweeping the near dunes). The labels
   are the only words in the piece: tracked small-caps surveyor annotations —
   ORG · CITY · YEAR — never more than one on screen. */
const STATIONS = [
  { radius: 720, label: "STEGRA · STOCKHOLM · 2025" },
  { radius: 1300, label: "NEOBUILT · GOTHENBURG · 2025" },
  { radius: 1980, label: "NORTHVOLT · SKELLEFTEÅ · 2023" },
  { radius: 2750, label: "COLLECTIVE ARCHITECTURE · LOS ANGELES · 2023" },
  { radius: 3600, label: "WHITE ARKITEKTER · GOTHENBURG · 2022" },
  { radius: 4550, label: "CHALMERS · GOTHENBURG · 2020" },
  { radius: 5600, label: "SHAHID BEHESHTI · TEHRAN · 2014" },
] as const;

// where each station sits on the orbit (wrapped yaw, radians) and how wide its
// reveal window is. REVEAL_BASE leaves the rest pose (yaw 0) in a silent gap; the
// stations then march across the front arc one window apart. HALF < STEP/2 keeps a
// sliver of pure mountain between chapters so the active leader never jumps while
// lit — it fades to black, swaps anchor, fades back in.
const TWO_PI = Math.PI * 2;
const REVEAL_BASE = 0.42;
const REVEAL_STEP = 0.24;
const REVEAL_HALF = 0.11;
const HEADER_SAFE = 110; // px — callouts stay below the full-width site header

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const angDelta = (a: number, b: number) => {
  let d = (a - b) % TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  return Math.abs(d);
};

export default function RidgelineStage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;

    let disposed = false;
    const teardown: Array<() => void> = [];

    (async () => {
      const gpu = await RidgelineScene.create(cvs);
      if (disposed) {
        gpu?.dispose();
        return;
      }
      if (!gpu || !gpu.attach()) {
        gpu?.dispose();
        setUnsupported(true);
        return;
      }
      teardown.push(() => gpu.dispose());

      const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        gpu.resize(cvs.clientWidth, cvs.clientHeight, dpr);
      };
      resize();
      window.addEventListener("resize", resize);
      teardown.push(() => window.removeEventListener("resize", resize));

      // ---- orbit controls — left-drag (mouse / touch) or the arrow keys spin
      // around the summit. The pointer steers a TARGET; the camera EASES toward
      // it every frame, so the motion glides instead of snapping 1:1 — calm and
      // weighty rather than twitchy. A gentle, capped release-flick keeps it
      // drifting before it settles. yaw is free (360°+); pitch is clamped to
      // PITCH_LO..PITCH_HI so the eye never dips under the dunes or tips past a
      // high survey angle. Haptics tick through the turn on capable phones. -----
      const SENS = 0.45; // turns per canvas-height of drag (< 1 = unhurried)
      const SMOOTH_TAU = 0.13; // s — how loosely the camera trails the target
      const INERTIA_TAU = 0.7; // s — a brief, controlled drift, not a runaway spin
      const MAX_VEL = 2.0; // rad/s — cap so even a hard flick stays calm
      const DETENT = 0.5; // rad (~29°) between haptic notches around the turn

      let yaw = 0, pitch = 0; // displayed (eased) — fed to the scene
      let tYaw = 0, tPitch = 0; // the target the input is steering toward
      let velYaw = 0, velPitch = 0; // rad/s — release-flick inertia (on target)
      let dragging = false;
      let pid = -1; // captured pointer id
      let lastX = 0, lastY = 0, lastT = 0;
      const clampPitch = (p: number) => Math.min(Math.max(p, PITCH_LO), PITCH_HI);

      // ---- haptics: the Vibration API (Android/Chrome) plus the iOS-Safari
      // trick — toggling a hidden <input switch> plays the system "tock". Kept
      // off-screen (not display:none, which would mute it) and clicked from
      // inside the touch gesture so iOS actually fires it. ---------------------
      let iosTick: HTMLLabelElement | null = null;
      try {
        const lbl = document.createElement("label");
        lbl.setAttribute("aria-hidden", "true");
        lbl.style.cssText =
          "position:fixed;top:-9999px;left:-9999px;width:0;height:0;opacity:0;pointer-events:none;";
        const inp = document.createElement("input");
        inp.type = "checkbox";
        inp.setAttribute("switch", ""); // Safari renders an iOS switch → haptic
        inp.tabIndex = -1;
        lbl.appendChild(inp);
        document.body.appendChild(lbl);
        iosTick = lbl;
      } catch { /* haptics are a bonus, never required */ }
      const canVibrate =
        typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
      let lastHapticT = -1e9;
      const haptic = (ms: number, now: number) => {
        if (now - lastHapticT < 24) return; // throttle → distinct notches, not a buzz
        lastHapticT = now;
        if (canVibrate) { try { navigator.vibrate(ms); } catch { /* ignore */ } }
        if (iosTick) { try { iosTick.click(); } catch { /* ignore */ } }
      };
      let lastNotch = 0;

      const onDown = (e: PointerEvent) => {
        if (e.pointerType === "mouse" && e.button !== 0) return; // left only
        dragging = true;
        pid = e.pointerId;
        lastX = e.clientX;
        lastY = e.clientY;
        lastT = e.timeStamp;
        velYaw = 0;
        velPitch = 0;
        try { cvs.setPointerCapture(pid); } catch { /* capture optional */ }
        cvs.style.cursor = "grabbing";
        lastNotch = Math.round(tYaw / DETENT); // anchor detents to where we grabbed
        haptic(10, e.timeStamp); // a light tick the moment you grab it
        e.preventDefault();
      };

      const onMove = (e: PointerEvent) => {
        if (!dragging || e.pointerId !== pid) return;
        const rot = ((2 * Math.PI) / Math.max(cvs.clientHeight, 1)) * SENS;
        const dxPix = e.clientX - lastX;
        const dyPix = e.clientY - lastY;
        const dt = Math.min(Math.max((e.timeStamp - lastT) / 1000, 1 / 240), 1 / 30);
        lastX = e.clientX;
        lastY = e.clientY;
        lastT = e.timeStamp;

        const dYaw = -dxPix * rot;
        tYaw += dYaw;
        const reqPitch = dyPix * rot;
        const before = tPitch;
        tPitch = clampPitch(tPitch + reqPitch);
        const dPitch = tPitch - before;

        // velocity feeds the release-flick; clamp the magnitude so it stays gentle
        velYaw = Math.max(-MAX_VEL, Math.min(MAX_VEL, velYaw * 0.5 + (dYaw / dt) * 0.5));
        velPitch = Math.max(-MAX_VEL, Math.min(MAX_VEL, velPitch * 0.5 + (dPitch / dt) * 0.5));

        // a notch each time the turn crosses a detent — fired HERE, inside the
        // touch gesture, so iOS Safari actually plays it (a tick from the rAF
        // loop is outside any gesture and gets silently ignored on iPhone)
        const notch = Math.round(tYaw / DETENT);
        if (notch !== lastNotch) { lastNotch = notch; haptic(6, e.timeStamp); }

        // a firmer bump the instant you push into the top/bottom pitch limit
        if (Math.abs(reqPitch) > 1e-4 && Math.abs(dPitch) < Math.abs(reqPitch) * 0.5) {
          haptic(18, e.timeStamp);
        }
      };

      const onUp = (e: PointerEvent) => {
        if (e.pointerId !== pid) return;
        dragging = false;
        pid = -1;
        try { cvs.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
        cvs.style.cursor = "grab";
      };

      const onKey = (e: KeyboardEvent) => {
        const step = 0.2; // rad per press (~11°) — eased in by the smoothing
        if (e.key === "ArrowLeft") tYaw += step;
        else if (e.key === "ArrowRight") tYaw -= step;
        else if (e.key === "ArrowUp") tPitch = clampPitch(tPitch - step);
        else if (e.key === "ArrowDown") tPitch = clampPitch(tPitch + step);
        else return;
        velYaw = 0;
        velPitch = 0;
        haptic(8, e.timeStamp);
        e.preventDefault();
      };

      cvs.addEventListener("pointerdown", onDown);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("keydown", onKey);
      teardown.push(() => {
        cvs.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("keydown", onKey);
        if (iosTick?.parentNode) iosTick.parentNode.removeChild(iosTick);
      });

      // ---- B1 survey overlay: each frame, project the seven station anchors and
      // reveal at most one callout — the one whose reveal window the orbit is in.
      // Imperative DOM writes (transform / opacity / leader points) straight from
      // the rAF loop, so nothing re-renders React and the labels track the spin.
      let labelEls: NodeListOf<HTMLElement> | null = null;
      let leaderEls: NodeListOf<SVGPolylineElement> | null = null;
      const labelW = new Array<number>(STATIONS.length).fill(0);
      let measured = false;

      const updateSurvey = (yaw: number, pitch: number, t: number) => {
        const overlay = overlayRef.current;
        if (!overlay) return;
        if (!labelEls) {
          labelEls = overlay.querySelectorAll<HTMLElement>(".survey-callout");
          leaderEls = overlay.querySelectorAll<SVGPolylineElement>(".survey-leader");
        }
        const labels = labelEls;
        const leaders = leaderEls;
        if (!leaders || labels.length !== STATIONS.length) return;

        const W = cvs.clientWidth;
        const H = cvs.clientHeight;
        if (!W || !H) return;

        // measure the (static) label widths once the font has laid out
        if (!measured) {
          measured = true;
          for (let k = 0; k < STATIONS.length; k++) {
            labelW[k] = labels[k].offsetWidth;
            if (labelW[k] <= 0) measured = false; // fonts not ready — retry next frame
          }
        }

        const { vp } = ridgeCamera(yaw, pitch, W / H, t);
        // signed orbit folded to its magnitude, so spinning EITHER way surveys the
        // same sequence (the index bands wrap the massif — both flanks read them);
        // the rest pose (yaw 0) sits in the silent gap before the first station
        let phi = yaw % TWO_PI;
        if (phi > Math.PI) phi -= TWO_PI;
        if (phi < -Math.PI) phi += TWO_PI;
        const aphi = Math.abs(phi);

        for (let k = 0; k < STATIONS.length; k++) {
          const label = labels[k];
          const leader = leaders[k];

          // reveal opacity from how near the orbit is to this station's window
          const theta = REVEAL_BASE + k * REVEAL_STEP;
          let op = 1 - smooth(REVEAL_HALF * 0.4, REVEAL_HALF, angDelta(aphi, theta));

          // project the anchor where this ring crosses the mountain's near face
          const anc = ringAnchor(STATIONS[k].radius);
          const a = projectToScreen(vp, anc.x, anc.y, anc.z, W, H);
          if (!a.visible || a.x < -60 || a.x > W + 60 || a.y < -60 || a.y > H + 60) op = 0;

          if (op <= 0.004 || !measured) {
            if (label.style.opacity !== "0") {
              label.style.opacity = "0";
              leader.style.opacity = "0";
            }
            continue;
          }

          // splay the leader up and toward the nearer edge (into open sky), then
          // clamp it clear of the full-width header band and the viewport edges so
          // the type never lands on the logo/nav or runs off-screen
          const shelf = labelW[k] + 14;
          const pad = 16;
          const outX = Math.min(W * 0.12, 150);
          const outY = Math.min(H * 0.1, 78);
          // pick the splay side that fits the label + shelf on-screen without a
          // fold-back; when both fit, lean toward the nearer edge (more open sky)
          const fitLeft = a.x - outX >= pad + shelf;
          const fitRight = a.x + outX <= W - pad - shelf;
          const toLeft = fitLeft && fitRight ? a.x < W * 0.5 : fitLeft || !fitRight;
          let ex = a.x + (toLeft ? -outX : outX); // elbow
          ex = toLeft ? Math.max(ex, pad + shelf) : Math.min(ex, W - pad - shelf);
          const ey = Math.max(a.y - outY, HEADER_SAFE); // sit below the site header
          const sx = ex + (toLeft ? -shelf : shelf); // far end of the underline shelf
          leader.setAttribute(
            "points",
            `${a.x.toFixed(1)},${a.y.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)} ${sx.toFixed(1)},${ey.toFixed(1)}`,
          );
          leader.style.opacity = op.toFixed(3);

          // text rides just above the shelf, hugging the elbow (inner) end
          const lx = toLeft ? ex - labelW[k] : ex;
          label.style.transform = `translate(${lx.toFixed(1)}px, ${(ey - 14).toFixed(1)}px)`;
          label.style.opacity = op.toFixed(3);
        }
      };

      let raf = 0;
      let prev = performance.now();
      const startT = prev;
      const frame = (now: number) => {
        const dt = Math.min((now - prev) / 1000, 0.05);
        prev = now;
        const t = (now - startT) / 1000;

        // after release, inertia drifts the TARGET, eased out until it settles
        if (!dragging && (velYaw !== 0 || velPitch !== 0)) {
          tYaw += velYaw * dt;
          const before = tPitch;
          tPitch = clampPitch(tPitch + velPitch * dt);
          if (tPitch === before) velPitch = 0; // hit a pitch wall → stop pushing
          const damp = Math.exp(-dt / INERTIA_TAU);
          velYaw *= damp;
          velPitch *= damp;
          if (Math.abs(velYaw) < 1e-3) velYaw = 0;
          if (Math.abs(velPitch) < 1e-3) velPitch = 0;
        }

        // the smoothing that makes it feel pleasant: ease the camera → target
        const k = 1 - Math.exp(-dt / SMOOTH_TAU);
        yaw += (tYaw - yaw) * k;
        pitch += (tPitch - pitch) * k;

        gpu.render({ time: t, yaw, pitch });
        updateSurvey(yaw, pitch, t);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      teardown.push(() => cancelAnimationFrame(raf));
    })();

    return () => {
      disposed = true;
      for (const fn of teardown) fn();
    };
  }, []);

  if (unsupported) {
    return (
      <div className="ridge-stage ridge-notice">
        <div className="gpu-notice-inner">
          <p className="gpu-notice-eyebrow">WebGPU required</p>
          <h1 className="gpu-notice-title">A mountain, drawn in light.</h1>
          <p className="gpu-notice-body">
            This piece is rendered in real time with WebGPU. Open it in a recent
            Chrome, Edge, Safari, or Firefox to see it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="ridge-stage" id="home">
      <canvas id="ridge" ref={canvasRef} />
      {/* B1 surveyor callouts — projected + revealed imperatively from the rAF
          loop. pointer-events:none so a drag still orbits the canvas beneath. */}
      <div className="ridge-survey" ref={overlayRef} aria-label="Career stations">
        <svg className="ridge-survey-svg" aria-hidden="true">
          {STATIONS.map((s, k) => (
            <polyline className="survey-leader" key={`leader-${k}`} points="" data-radius={s.radius} />
          ))}
        </svg>
        <ul className="survey-list">
          {STATIONS.map((s, k) => (
            <li className="survey-callout" key={`callout-${k}`}>
              {s.label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
