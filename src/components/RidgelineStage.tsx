import { useEffect, useRef, useState } from "react";
import {
  RidgelineScene,
  PITCH_LO,
  PITCH_HI,
  ridgeCamera,
  projectToScreen,
  ringAnchor,
  pickBand,
} from "../gpu/ridgeline";

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
   Listed newest (the tight summit ring) first → oldest (the wide ring sweeping the
   near dunes), so the column reads present → past down the mountain. Each `radius`
   is the plan radius of the ring it pins to — the source of truth for the seven
   radii, kept in sync with the RINGS arrays in ridgeline.ts (pickBand) and
   ridgelineShaders.ts (720 = hugging the summit … 5600 = the wide near dunes). The
   labels are the only words in the piece: tracked small-caps surveyor annotations —
   ORG · CITY · YEAR — all of them held on the camera-facing flank at once, the one
   under the pointer lit while the rest recede. */
const STATIONS = [
  { radius: 720, label: "STEGRA · STOCKHOLM · 2025" },
  { radius: 1300, label: "NEOBUILT · GOTHENBURG · 2025" },
  { radius: 1980, label: "NORTHVOLT · SKELLEFTEÅ · 2023" },
  { radius: 2750, label: "COLLECTIVE ARCHITECTURE · LOS ANGELES · 2023" },
  { radius: 3600, label: "WHITE ARKITEKTER · GOTHENBURG · 2022" },
  { radius: 4550, label: "CHALMERS · GOTHENBURG · 2020" },
  { radius: 5600, label: "SHAHID BEHESHTI · TEHRAN · 2014" },
] as const;

// All seven callouts are held on the camera-facing flank together — no per-station
// reveal window. A single FACING fade (FACE_NEAR..FACE_FAR, in radians of orbit off
// the rest pose) carries the whole survey out of view as the orbit swings around to
// the back of the massif, where the anchors would be hidden behind it. The resting
// callouts sit at REST_OP; the one under the pointer rises to full while the others
// recede to DIM_OP, so the highlight reads without ever hiding the rest.
const TWO_PI = Math.PI * 2;
const FACE_NEAR = 1.45; // rad (~83°) — full survey out to here
const FACE_FAR = 2.45; // rad (~140°) — fully faded by here (anchors now round the back)
const REST_OP = 0.46; // resting opacity for an un-hovered, front-facing callout
const DIM_OP = 0.24; // the others recede to this while one is hovered
const HEADER_SAFE = 110; // px — callouts stay below the full-width site header

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export default function RidgelineStage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLButtonElement>(null);
  const demoRef = useRef<(() => void) | null>(null);
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
      // drifting before it settles. yaw is free (360°+). pitch is bounded to
      // PITCH_LO..PITCH_HI (the eye can't dip under the dunes nor tip past a high
      // survey angle), but those limits are CUSHIONED, not hard walls: the tilt
      // decelerates smoothly into them so a drag never stops dead at a point —
      // and yaw keeps spinning freely throughout. The downward floor is naturally
      // shallow (the eye is already low), so vertical input is gentled too, which
      // keeps the headline horizontal spin from tripping it. Haptics tick through
      // the turn on capable phones. ------------------------------------------
      const SENS = 0.45; // turns per canvas-height of drag (< 1 = unhurried)
      const PITCH_SENS = 0.55; // vertical tilt is gentler than the free spin
      const PITCH_SOFT = 0.28; // rad — cushion zone where the tilt eases into a limit
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
      // add a pitch delta with a soft, direction-aware cushion: within PITCH_SOFT
      // of the limit you're heading toward, the step is scaled down to zero so the
      // tilt glides to rest instead of slamming. Returns the new (still-bounded)
      // target — never overshoots, and reverses cleanly with no dead zone.
      const addPitch = (cur: number, delta: number) => {
        const head = delta > 0 ? PITCH_HI - cur : delta < 0 ? cur - PITCH_LO : 1;
        const ease = head < PITCH_SOFT ? Math.max(0, head) / PITCH_SOFT : 1;
        return clampPitch(cur + delta * ease);
      };

      // ---- hover state: the career SLICE the pointer is resting on, and the eased,
      // breathing pulse amplitude that lights it. hx/hy track the mouse in canvas
      // pixels (mouse only — touch has no hover). Nothing here ever snaps: the rAF
      // loop eases hoverAmt up/down, and moving between slices cross-DISSOLVES (the
      // old band's wash eases out, then shownBand adopts the new one and eases in),
      // so the highlight is always a gentle rise/fall, never a jump. The callout
      // opacities are eased per-label in updateSurvey on the same principle. --------
      const HOVER_TAU = 0.28; // s — wash rise/fall + slice-to-slice cross-dissolve (gentle)
      const OP_TAU = 0.22; // s — callout highlight/dim easing, so titles never pop
      let hx = -1, hy = -1; // pointer in canvas px, or -1 when off-canvas
      let hoverBand = -1; // slice under the pointer THIS frame (set in updateSurvey)
      let shownBand = -1; // the slice the wash is CURRENTLY on (cross-dissolve bookkeeping)
      let hoverAmt = 0; // eased presence 0..1
      const reduceMotion =
        typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches;

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

      // ---- the "drag to rotate" affordance: a hint that retires itself the moment
      // the viewer first orbits (drag, arrow keys, or the demo), and a one-shot demo
      // flick so a click on the hint SHOWS the mountain turning — same gentle path a
      // release-flick takes, eased out by the inertia loop below. --------------------
      let hinted = true;
      const hideHint = () => {
        if (!hinted) return;
        hinted = false;
        hintRef.current?.classList.add("is-hidden");
      };
      demoRef.current = () => {
        dragging = false;
        velYaw = -1.5; // a calm leftward drift; the inertia loop settles it
        velPitch = 0;
        haptic(8, performance.now());
        hideHint();
      };

      const onDown = (e: PointerEvent) => {
        if (e.pointerType === "mouse" && e.button !== 0) return; // left only
        dragging = true;
        hideHint();
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
        const before = tPitch;
        tPitch = addPitch(tPitch, dyPix * rot * PITCH_SENS);
        const dPitch = tPitch - before;

        // velocity feeds the release-flick; clamp the magnitude so it stays gentle
        velYaw = Math.max(-MAX_VEL, Math.min(MAX_VEL, velYaw * 0.5 + (dYaw / dt) * 0.5));
        velPitch = Math.max(-MAX_VEL, Math.min(MAX_VEL, velPitch * 0.5 + (dPitch / dt) * 0.5));

        // a notch each time the turn crosses a detent — fired HERE, inside the
        // touch gesture, so iOS Safari actually plays it (a tick from the rAF
        // loop is outside any gesture and gets silently ignored on iPhone)
        const notch = Math.round(tYaw / DETENT);
        if (notch !== lastNotch) { lastNotch = notch; haptic(6, e.timeStamp); }
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
        else if (e.key === "ArrowUp") tPitch = addPitch(tPitch, -step);
        else if (e.key === "ArrowDown") tPitch = addPitch(tPitch, step);
        else return;
        hideHint();
        velYaw = 0;
        velPitch = 0;
        haptic(8, e.timeStamp);
        e.preventDefault();
      };

      // ---- hover tracking: record the mouse in canvas pixels so updateSurvey can
      // test it against the revealed callout (and its anchor on the slope). Touch
      // never fires this, so the slice-glow stays a pointer-device delight. ----------
      const onHover = (e: PointerEvent) => {
        if (e.pointerType !== "mouse") return;
        const r = cvs.getBoundingClientRect();
        hx = e.clientX - r.left;
        hy = e.clientY - r.top;
      };
      const onHoverOut = (e: PointerEvent) => {
        if (!e.relatedTarget) { hx = -1; hy = -1; } // pointer left the window
      };

      cvs.addEventListener("pointerdown", onDown);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointermove", onHover);
      window.addEventListener("pointerout", onHoverOut);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("keydown", onKey);
      teardown.push(() => {
        cvs.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointermove", onHover);
        window.removeEventListener("pointerout", onHoverOut);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("keydown", onKey);
        demoRef.current = null;
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
      // per-frame layout scratch (hoisted so the rAF loop never allocates): each
      // station's projected anchor, computed leader path, label origin, and how
      // visible (front-facing + on-screen) it is this frame. Pass 1 fills these and
      // resolves the hovered station; pass 2 writes opacity with the highlight applied.
      const visA = new Array<number>(STATIONS.length).fill(0);
      const ptsA = new Array<string>(STATIONS.length).fill("");
      const lxA = new Array<number>(STATIONS.length).fill(0);
      const eyA = new Array<number>(STATIONS.length).fill(0);
      // the eased, currently-DISPLAYED opacity of each callout — pass 2 nudges these
      // toward their target (highlight / dim / rest) every frame so the survey never
      // snaps; the lit slice rises and its neighbours recede over a beat.
      const dispOp = new Array<number>(STATIONS.length).fill(0);

      const updateSurvey = (yaw: number, pitch: number, t: number, dt: number) => {
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
        // one FACING fade for the whole survey: all seven anchors live on the x = 0
        // near ridge, so they face the camera together. Fold the signed orbit to its
        // magnitude (spinning either way surveys the same flank) and fade the lot out
        // as the eye swings past FACE_FAR toward the hidden back of the massif.
        let phi = yaw % TWO_PI;
        if (phi > Math.PI) phi -= TWO_PI;
        if (phi < -Math.PI) phi += TWO_PI;
        const face = 1 - smooth(FACE_NEAR, FACE_FAR, Math.abs(phi));

        // which slice the pointer is resting on this frame (never mid-drag): a label
        // hit wins outright; otherwise the camera ray is cast through the pointer to
        // find the slice band its terrain hit lands on (resolved after pass 1).
        let labelHover = -1;

        // ---- pass 1: project + lay out every visible station, resolve the hover ----
        for (let k = 0; k < STATIONS.length; k++) {
          let vis = face;
          // project the anchor where this ring crosses the mountain's near face
          const anc = ringAnchor(STATIONS[k].radius);
          const a = projectToScreen(vp, anc.x, anc.y, anc.z, W, H);
          if (!a.visible || a.x < -60 || a.x > W + 60 || a.y < -60 || a.y > H + 60) vis = 0;
          visA[k] = vis;
          if (vis <= 0.004 || !measured) {
            ptsA[k] = "";
            continue;
          }

          // splay the leader up and out, then clamp it clear of the header band and
          // the viewport edges. Alternate the splay side by parity (even → left, odd
          // → right) so vertically-stacked neighbours never collide; fall back to
          // whichever side fits when the column drifts near an edge.
          const shelf = labelW[k] + 14;
          const pad = 16;
          const outX = Math.min(W * 0.12, 150);
          const outY = Math.min(H * 0.1, 78);
          const fitLeft = a.x - outX >= pad + shelf;
          const fitRight = a.x + outX <= W - pad - shelf;
          const preferLeft = (k % 2) === 0;
          const toLeft = preferLeft ? fitLeft || !fitRight : !(fitRight || !fitLeft);
          let ex = a.x + (toLeft ? -outX : outX); // elbow
          ex = toLeft ? Math.max(ex, pad + shelf) : Math.min(ex, W - pad - shelf);
          const ey = Math.max(a.y - outY, HEADER_SAFE); // sit below the site header
          const sx = ex + (toLeft ? -shelf : shelf); // far end of the underline shelf
          const lx = toLeft ? ex - labelW[k] : ex; // text hugs the elbow (inner) end
          ptsA[k] = `${a.x.toFixed(1)},${a.y.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)} ${sx.toFixed(1)},${ey.toFixed(1)}`;
          lxA[k] = lx;
          eyA[k] = ey;

          // a hover over the callout text lights its slice directly (the words are
          // the one thing the terrain pick can't see). The slope itself is handled
          // after the loop by the camera-ray pick, so resting anywhere on a slice's
          // whole face lights it — not just a disc by the anchor.
          if (!dragging && hx >= 0 && vis > 0.12) {
            const inLabel =
              hx >= lx - 14 && hx <= lx + labelW[k] + 14 && hy >= ey - 32 && hy <= ey + 8;
            if (inLabel) labelHover = k;
          }
        }

        // ---- resolve the hovered slice: a label hit wins; else cast the camera ray
        // through the pointer and take the slice band its terrain hit lands on. The
        // ray-pick (pickBand) is rotation-independent and respects terrain occlusion,
        // and the shader lights the FULL 360° ring by plan-radius — so a hover lights
        // its slice from ANY orbit angle, even after the camera has spun past the rest
        // pose and the callout anchors (pinned to the near face) have rounded out of
        // view. The glow is no longer gated on the label still facing the camera. ----
        let foundHover = labelHover;
        if (foundHover < 0 && !dragging && hx >= 0) {
          const cand = pickBand(yaw, pitch, W / H, t, hx, hy, W, H);
          if (cand >= 0) foundHover = cand;
        }

        // ---- pass 2: EASE each callout toward its target opacity (highlight / dim /
        // rest) so the survey never pops. The lit slice rises and its neighbours
        // recede over OP_TAU instead of snapping; opacity also eases to/from 0 as a
        // station faces in or rounds out of view. Layout (transform / leader points)
        // is refreshed only while the station is laid out this frame.
        // dim the resting callouts only when the lit slice's OWN label is on screen.
        // Hovering a back-flank slice (its callout rounded out of view) still lights the
        // band, but shouldn't make the front-facing labels recede with nothing visibly
        // highlighted — that would read as the survey fading for no reason.
        const anyHover = foundHover >= 0 && visA[foundHover] > 0.004;
        const opK = 1 - Math.exp(-dt / OP_TAU);
        for (let k = 0; k < STATIONS.length; k++) {
          const label = labels[k];
          const leader = leaders[k];
          const laidOut = !(visA[k] <= 0.004 || !measured || !ptsA[k]);
          const tier = k === foundHover ? 1 : anyHover ? DIM_OP : REST_OP;
          const target = laidOut ? visA[k] * tier : 0;
          dispOp[k] += (target - dispOp[k]) * opK;
          const op = dispOp[k].toFixed(3);
          if (laidOut) {
            leader.setAttribute("points", ptsA[k]);
            label.style.transform = `translate(${lxA[k].toFixed(1)}px, ${(eyA[k] - 14).toFixed(1)}px)`;
          }
          leader.style.opacity = op;
          label.style.opacity = op;
        }
        hoverBand = foundHover;
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
          tPitch = addPitch(tPitch, velPitch * dt); // cushions into the limit, no slam
          if (tPitch === before) velPitch = 0; // settled at a pitch limit → stop pushing
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

        // hover pulse — never a jump: the wash CROSS-DISSOLVES between slices. When
        // the pointer wants a different band than the one currently shown (or moves
        // off the mountain), ease the current wash OUT to zero first; once it's faded
        // the displayed band adopts the new target and the wash eases back IN. So a
        // slice-to-slice move slides off one band and onto the next, and a fresh enter
        // (from no band) adopts immediately and rises. Amplitude breathes so the lit
        // slice feels alive. (updateSurvey set hoverBand from the pointer last frame.)
        const amtTarget =
          shownBand !== hoverBand ? 0 : hoverBand >= 0 ? 1 : 0;
        if (shownBand !== hoverBand && hoverAmt < 0.02) shownBand = hoverBand;
        hoverAmt += (amtTarget - hoverAmt) * (1 - Math.exp(-dt / HOVER_TAU));
        const breath = reduceMotion ? 0.66 : 0.64 + 0.22 * Math.sin(t * 2.2);
        const hoverGlow = hoverAmt * breath;

        gpu.render({ time: t, yaw, pitch, hoverBand: shownBand, hoverGlow });
        updateSurvey(yaw, pitch, t, dt);
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

      {/* "drag to rotate" affordance — a curved arrow that rocks back and forth so
          the gesture reads at a glance. Clicking it flicks the mountain into a short
          demo orbit; it retires itself the first time the viewer orbits. */}
      <button
        type="button"
        className="ridge-hint"
        ref={hintRef}
        aria-label="Drag the mountain to rotate the view"
        onClick={() => demoRef.current?.()}
      >
        <svg className="ridge-hint-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          {/* a circular rotation arrow: ~300° ring with a crisp filled head, the
              universal "you can spin this" cue */}
          <path d="M18.7 7.4A7.4 7.4 0 1 0 20.2 12" />
          <path d="M18.4 3.1L19.4 7.9L14.6 8.2Z" fill="currentColor" stroke="none" />
        </svg>
        <span className="ridge-hint-label">Drag to rotate</span>
      </button>
    </div>
  );
}
