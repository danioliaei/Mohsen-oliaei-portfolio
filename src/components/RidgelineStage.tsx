import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import {
  RidgelineScene,
  PITCH_LO,
  PITCH_HI,
  ridgeCamera,
  projectToScreen,
  ringAnchor,
  pickBand,
} from "../gpu/ridgeline";
import RoleOverlay from "./RoleOverlay";
import AssignmentOverlay from "./AssignmentOverlay";
import { STATIONS } from "../data/stations";

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
// The seven stations (radii — the source of truth synced with the shader RINGS —
// plus the callout labels and the focused-overlay dossier copy) now live in
// ../data/stations.ts, shared with RoleOverlay. `radius`/`label`/`short` drive the
// survey overlay below; the rest feeds the click-to-focus dossier.

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

// ---- apex beacon anchor: a world point on the orbit AXIS (x = 0, z = PEAK_Z),
// floating just above the summit crest. Because it sits directly above the camera
// pivot (TGT), it projects to the HORIZONTAL CENTRE of the frame for every yaw — so
// the beacon stays welded over the peak through a full orbit, riding only its
// screen-Y with pitch (no FACING fade like the near-face ring callouts). z mirrors
// the shader's PEAK_Z (8200); y floats it just above the rendered crest into the
// dotted halo. The crest at x = 0 sits at world-y ≈ 5019 (silhouette tip ~11% down
// the frame at rest), so y ≈ 5230 floats the disc a short hair above the snowy tip,
// in the halo, in the header's empty centre column. (Verified by projecting the JS
// height field; tune against a live capture if the float gap reads wrong.)
const APEX = { x: 0, y: 5230, z: 8200 };
const BEACON_TAU = 0.3; // s — how the beacon eases in / out (overlay open, off-screen)

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

  // ---- click-to-focus state -------------------------------------------------
  // `selected` (React) drives the focused panel; `selectedRef` is the same value the
  // imperative rAF loop + pointer handlers read each frame (they live in a one-time
  // effect and would otherwise close over a stale value). `selectRef` lets that loop
  // reach the LATEST setter without re-subscribing. A single `select()` keeps the two
  // handles in lock-step.
  const [selected, setSelected] = useState<number | null>(null);
  const selectedRef = useRef<number | null>(null);
  const selectRef = useRef<(i: number | null) => void>(() => {});
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // ---- apex beacon → "Your Assignment?" overlay ----------------------------
  // A second focused surface, parallel to `selected`: the floating "?" datum at the
  // summit opens it. `assignmentOpenRef` is the value the imperative rAF loop reads
  // each frame (to hide the beacon and recede the survey while it's up); `closeAssignRef`
  // lets the once-registered window keydown handler reach the close setter through a
  // stable ref — the same defensive indirection as `selectRef` (these setters are
  // useCallback([]) and never change identity, so the ref-sync effect isn't load-bearing).
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const assignmentOpenRef = useRef(false);
  const closeAssignRef = useRef<() => void>(() => {});
  const assignCloseBtnRef = useRef<HTMLButtonElement>(null);
  const beaconRef = useRef<HTMLButtonElement>(null);
  const assignLastFocusRef = useRef<HTMLElement | null>(null);
  const assignWasOpenRef = useRef(false);
  // set when the brief is dismissed VIA its CTA (which routes to #contact): the close
  // effect then leaves focus for the contact target rather than yanking it to the beacon.
  const assignNavigatingRef = useRef(false);

  const openAssignment = useCallback(() => {
    // drop focus off the beacon BEFORE the next commit makes it aria-hidden, so the
    // focused element is never momentarily inside an aria-hidden subtree; the
    // close-restore falls back to the beacon (prev === body), so nothing is lost.
    beaconRef.current?.blur();
    assignmentOpenRef.current = true;
    setAssignmentOpen(true);
  }, []);
  const closeAssignment = useCallback(() => {
    assignmentOpenRef.current = false;
    setAssignmentOpen(false);
  }, []);
  // the CTA dismissal: a normal close, flagged so the restore skips the beacon refocus
  const closeAssignmentNavigating = useCallback(() => {
    assignNavigatingRef.current = true;
    assignmentOpenRef.current = false;
    setAssignmentOpen(false);
  }, []);

  const select = useCallback((i: number | null) => {
    selectedRef.current = i;
    setSelected(i);
  }, []);
  // keep the loop's escape hatches pointed at the freshest setters every render
  useEffect(() => {
    selectRef.current = select;
    closeAssignRef.current = closeAssignment;
  });

  // focus management: on open, remember what was focused and move focus into the
  // dialog; on close (only after an actual open), restore it to the trigger. The
  // wasOpenRef guard keeps the initial mount from stealing focus to the hint.
  useEffect(() => {
    if (selected !== null) {
      lastFocusRef.current = document.activeElement as HTMLElement | null;
      closeBtnRef.current?.focus();
      wasOpenRef.current = true;
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      (lastFocusRef.current ?? hintRef.current)?.focus?.();
    }
  }, [selected]);

  // the same focus dance for the assignment panel: remember what was focused (the
  // beacon), move focus to its close control on open, restore it on close.
  useEffect(() => {
    if (assignmentOpen) {
      assignLastFocusRef.current = document.activeElement as HTMLElement | null;
      assignCloseBtnRef.current?.focus();
      assignWasOpenRef.current = true;
    } else if (assignWasOpenRef.current) {
      assignWasOpenRef.current = false;
      if (assignNavigatingRef.current) {
        // dismissed via the CTA → #contact: leave focus for the contact target
        assignNavigatingRef.current = false;
      } else {
        // return focus to whatever opened the brief — but if nothing meaningful held
        // it (e.g. the page body), fall back to the beacon, the logical anchor
        const prev = assignLastFocusRef.current;
        (prev && prev !== document.body ? prev : beaconRef.current)?.focus?.();
      }
    }
  }, [assignmentOpen]);

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

      // ---- click-to-focus: a press that barely moves and releases quickly is a
      // CLICK (focus the slice under it), not a drag-orbit. downX/Y/T anchor the
      // gesture; `moved` latches the moment it travels past CLICK_SLOP so a real
      // orbit never trips the pick. ------------------------------------------------
      const CLICK_SLOP = 6; // px of travel still counted as a click
      const CLICK_TIME = 350; // ms — longer presses read as a deliberate hold/drag
      let downX = 0, downY = 0, downT = 0, moved = false;

      // ---- focus dolly + isolation: eased toward the selected state. radiusScale
      // leans the camera in; focusAmt drives the dim of the un-selected bands.
      // focusBand stays sticky through the fade-out so the dim eases off the band
      // that was selected rather than snapping. lastFrameT caches the loop clock so a
      // click can pick against the exact frame the eye is on. ----------------------
      const FOCUS_TAU = 0.16; // s — snappier than the hover ease, still smooth
      // ---- the framing line the SELECTED ring is lifted to while focused (NDC_y; +up).
      // ~upper third — clear of the site header, and inside the dossier's clear flank
      // (the open right on desktop, the open top band on mobile). The lift is CLAMPED so
      // the mountain's foot never rises past the bottom: NEAR_EDGE is the front-centre of
      // the terrain (x = 0 on the z = ZN near row; y ≈ heightAt(0, ZN) ≈ 340, see
      // gpu/ridgeline.ts), pinned to FOCUS_FOOT (just below the bottom) so the widest
      // dune ring still lifts into view without baring black sky beneath the massif.
      const FOCUS_AIM_Y = 0.2; // NDC_y the selected ring rises toward
      const NEAR_EDGE = { x: 0, y: 340, z: 500 }; // world front-centre foot of the massif
      const FOCUS_FOOT = -1.04; // NDC_y the foot pins to (a hair below the frame bottom)
      let radiusScale = 1; // 1 at rest → ~0.84 focused
      let focusAmt = 0; // 0 at rest → 1 focused
      let focusBand = -1; // the band the dim is centred on (sticky during fade-out)
      let focusShiftY = 0; // eased vertical lens shift that lifts the selected ring
      let lastFrameT = 0;
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
      let beaconOp = 0; // eased apex-beacon opacity 0..1 (fades on overlay-open / off-screen)
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
        // anchor the click test — a release near here, soon, with no real travel
        // focuses the slice instead of orbiting
        downX = e.clientX;
        downY = e.clientY;
        downT = e.timeStamp;
        moved = false;
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
        // once the press travels past the slop it's a drag, not a click
        if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_SLOP) {
          moved = true;
        }
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

        // a click (no real travel, released quickly, left button) focuses the slice
        // it lands on. Cast the same camera ray the hover uses, at the live focus
        // dolly so the pick matches what's on screen. While a panel is already open
        // the scrim covers the canvas, so this only ever OPENS a focus.
        const isClick =
          !moved &&
          e.timeStamp - downT < CLICK_TIME &&
          (e.pointerType !== "mouse" || e.button === 0);
        if (isClick) {
          const r = cvs.getBoundingClientRect();
          const px = e.clientX - r.left;
          const py = e.clientY - r.top;
          const b = pickBand(
            yaw, pitch, cvs.clientWidth / Math.max(cvs.clientHeight, 1),
            lastFrameT, px, py, cvs.clientWidth, cvs.clientHeight, radiusScale,
          );
          if (b >= 0) {
            selectRef.current(b);
            hideHint();
          }
        }
      };

      const onKey = (e: KeyboardEvent) => {
        // Escape dismisses an open surface before any orbit handling — the summit
        // brief first, then a focused career slice
        if (e.key === "Escape" && assignmentOpenRef.current) {
          closeAssignRef.current();
          e.preventDefault();
          return;
        }
        if (e.key === "Escape" && selectedRef.current != null) {
          selectRef.current(null);
          e.preventDefault();
          return;
        }
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
      // the callout is a title + company stack, so we track its full HEIGHT (for the
      // hover hit-test) and the TITLE line's height separately: the leader meets the
      // SIDE of the title, so the block is offset up by half the title height to put
      // the title's centre on the leader's horizontal run.
      const labelH = new Array<number>(STATIONS.length).fill(0);
      const titleH = new Array<number>(STATIONS.length).fill(0);
      let measured = false;
      // per-frame layout scratch (hoisted so the rAF loop never allocates): each
      // station's projected anchor, computed leader path, label origin, and how
      // visible (front-facing + on-screen) it is this frame. Pass 1 fills these and
      // resolves the hovered station; pass 2 writes opacity with the highlight applied.
      const visA = new Array<number>(STATIONS.length).fill(0);
      const ptsA = new Array<string>(STATIONS.length).fill("");
      const lxA = new Array<number>(STATIONS.length).fill(0);
      const eyA = new Array<number>(STATIONS.length).fill(0);
      // block TOP (translateY): the title centre is pulled onto the leader's run, so
      // the block hangs a half-title-height below eyA.
      const tyA = new Array<number>(STATIONS.length).fill(0);
      // which side each callout splays to this frame (even → left, odd → right,
      // flipped near an edge). Pass 2 right-aligns left-splayed blocks so their
      // lines hug the leader, and left-aligns right-splayed ones.
      const toLeftA = new Array<boolean>(STATIONS.length).fill(false);
      // the eased, currently-DISPLAYED opacity of each callout — pass 2 nudges these
      // toward their target (highlight / dim / rest) every frame so the survey never
      // snaps; the lit slice rises and its neighbours recede over a beat.
      const dispOp = new Array<number>(STATIONS.length).fill(0);

      // re-measure label widths on a viewport change — crossing the mobile breakpoint
      // swaps the full ORG·CITY·YEAR label for the compact ORG 'YY, so their pixel
      // widths (used to lay out the leaders) differ and must be re-read.
      const remeasure = () => { measured = false; };
      window.addEventListener("resize", remeasure);
      teardown.push(() => window.removeEventListener("resize", remeasure));

      const updateSurvey = (
        yaw: number,
        pitch: number,
        t: number,
        dt: number,
        radiusScale: number,
        focusShift: number,
        focusShiftY: number,
      ) => {
        const overlay = overlayRef.current;
        if (!overlay) return;
        // while a slice is focused the survey words recede behind the panel — only
        // the selected callout stays lit, and the per-frame hover pick is skipped.
        const focusActive = selectedRef.current != null || assignmentOpenRef.current;
        const fsel = selectedRef.current ?? -1;
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
        // the mobile flank uses the compact labels + a shorter header, so they can
        // sit higher and splay a touch further up to clear the dense contour lines
        const mobile = W < 760;
        const headerSafe = mobile ? 58 : HEADER_SAFE;

        // measure the (static) label widths once the font has laid out
        if (!measured) {
          measured = true;
          for (let k = 0; k < STATIONS.length; k++) {
            labelW[k] = labels[k].offsetWidth;
            labelH[k] = labels[k].offsetHeight;
            // the visible title line — the desktop .sc-title, or (when it's hidden on
            // the mobile flank) the whole compact label
            const t = labels[k].querySelector<HTMLElement>(".sc-title");
            titleH[k] = t && t.offsetHeight > 0 ? t.offsetHeight : labelH[k];
            if (labelW[k] <= 0) measured = false; // fonts not ready — retry next frame
          }
        }

        const { vp } = ridgeCamera(yaw, pitch, W / H, t, radiusScale, focusShift, focusShiftY);
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

          // splay the block to one side and run a leader from the ring anchor UP to
          // the SIDE of the role title (a short horizontal tick meeting the title's
          // inner edge — no underline beneath the block). Alternate the splay side by
          // parity (even → left, odd → right) so vertically-stacked neighbours never
          // collide; fall back to whichever side fits when the column nears an edge.
          const pad = mobile ? 12 : 16;
          const outX = mobile ? W * 0.16 : Math.min(W * 0.12, 150);
          const outY = mobile ? 92 : Math.min(H * 0.1, 78);
          const stub = 14; // short horizontal tick that meets the title's side
          const fitLeft = a.x - outX >= pad + labelW[k];
          const fitRight = a.x + outX <= W - pad - labelW[k];
          const preferLeft = (k % 2) === 0;
          const toLeft = preferLeft ? fitLeft || !fitRight : !(fitRight || !fitLeft);
          // innerX = the title edge the leader meets (right edge when splaying left,
          // left edge when splaying right), clamped so the block stays on screen
          let innerX = a.x + (toLeft ? -outX : outX);
          innerX = toLeft
            ? Math.max(innerX, pad + labelW[k])
            : Math.min(innerX, W - pad - labelW[k]);
          const half = titleH[k] / 2;
          // ey is the TITLE's vertical centre — the height the leader meets it at —
          // held below the site header (block top = ey - half must clear it)
          const ey = Math.max(a.y - outY, headerSafe + half);
          const elbowX = innerX + (toLeft ? stub : -stub); // corner on the anchor side
          const ty = ey - half; // block top, so the title centre sits on the leader
          const lx = toLeft ? innerX - labelW[k] : innerX; // text hugs the inner edge
          ptsA[k] = `${a.x.toFixed(1)},${a.y.toFixed(1)} ${elbowX.toFixed(1)},${ey.toFixed(1)} ${innerX.toFixed(1)},${ey.toFixed(1)}`;
          lxA[k] = lx;
          eyA[k] = ey;
          tyA[k] = ty;
          toLeftA[k] = toLeft;

          // a hover over the callout text lights its slice directly (the words are
          // the one thing the terrain pick can't see). The slope itself is handled
          // after the loop by the camera-ray pick, so resting anywhere on a slice's
          // whole face lights it — not just a disc by the anchor.
          if (!dragging && hx >= 0 && vis > 0.12) {
            const inLabel =
              hx >= lx - 14 && hx <= lx + labelW[k] + 14 &&
              hy >= ty - 8 && hy <= ty + labelH[k] + 8;
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
        // while focused the selected band IS the highlight — skip the per-frame ray
        // pick entirely. Otherwise a label hit wins, else cast the camera ray.
        let foundHover = labelHover;
        if (focusActive) {
          foundHover = fsel;
        } else if (foundHover < 0 && !dragging && hx >= 0) {
          const cand = pickBand(yaw, pitch, W / H, t, hx, hy, W, H, radiusScale);
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
          // focused: every callout recedes — the words now live in the panel, and the
          // lit slice's own GPU glow + the dim + the dolly are what mark the selection,
          // so a floating label here would only duplicate the panel eyebrow.
          // resting: the lit slice rises, neighbours dim, the rest sit at REST_OP.
          const tier = focusActive
            ? 0
            : k === foundHover ? 1 : anyHover ? DIM_OP : REST_OP;
          const target = laidOut ? visA[k] * tier : 0;
          dispOp[k] += (target - dispOp[k]) * opK;
          const op = dispOp[k].toFixed(3);
          if (laidOut) {
            leader.setAttribute("points", ptsA[k]);
            // place the block so the title's centre sits on the leader's horizontal
            // run, and align the lines to the leader side (right-align when the block
            // splays left, left-align when it splays right)
            label.style.transform =
              `translate(${lxA[k].toFixed(1)}px, ${tyA[k].toFixed(1)}px)`;
            label.style.textAlign = toLeftA[k] ? "right" : "left";
          }
          leader.style.opacity = op;
          label.style.opacity = op;
        }
        hoverBand = foundHover;

        // ---- apex beacon: weld the "Your Assignment?" datum above the summit. The
        // apex lives on the orbit AXIS (x = 0, z = PEAK_Z), so it projects to the
        // frame's horizontal centre for EVERY yaw and stays put through a full orbit
        // — only its screen-Y rides with pitch. No FACING fade (unlike the near-face
        // ring callouts, the summit never rounds out of view). It eases out while an
        // overlay is open, off-screen, or at an extreme tilt that would tuck it under
        // the site header. Transform is written imperatively (never a CSS transition).
        const beacon = beaconRef.current;
        if (beacon) {
          const ap = projectToScreen(vp, APEX.x, APEX.y, APEX.z, W, H);
          const inFrame =
            ap.visible && ap.x > -80 && ap.x < W + 80 && ap.y > -80 && ap.y < H + 120;
          // the summit floats high in the frame (tip ~11% down), so the disc lives in
          // the header band — but in its empty CENTRE column, clear of the wordmark
          // (left) and nav (right). Only fade if it would ride right up under the very
          // top edge (an extreme tilt the bounded pitch never actually reaches).
          const clearHeader = ap.y > (mobile ? 20 : 28);
          const open = selectedRef.current != null || assignmentOpenRef.current;
          const target = open || !inFrame || !clearHeader ? 0 : 1;
          const bk = reduceMotion ? 1 : 1 - Math.exp(-dt / BEACON_TAU);
          beaconOp += (target - beaconOp) * bk;
          beacon.style.transform =
            `translate3d(${ap.x.toFixed(1)}px, ${ap.y.toFixed(1)}px, 0) translate(-50%, -50%)`;
          beacon.style.opacity = (beaconOp * 0.9).toFixed(3);
          beacon.style.pointerEvents = !open && beaconOp > 0.5 ? "auto" : "none";
        }
      };

      let raf = 0;
      let prev = performance.now();
      const startT = prev;
      const frame = (now: number) => {
        const dt = Math.min((now - prev) / 1000, 0.05);
        prev = now;
        const t = (now - startT) / 1000;
        lastFrameT = t; // so a click can pick against the exact frame on screen

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

        // focus dolly + isolation: ease the camera lean-in and the dim toward the
        // selected state. focusBand is held sticky until the dim has fully faded so
        // it eases off the right band on dismiss rather than snapping to none.
        const focused = selectedRef.current != null;
        // on a tall/narrow phone, hold the camera a touch further back so the whole
        // massif and its survey labels breathe instead of cropping at the edges; wide
        // (desktop) viewports keep the authored framing (zoomBase = 1). The focus
        // dolly then leans in from whatever the resting base is.
        const aspectNow = cvs.clientWidth / Math.max(cvs.clientHeight, 1);
        const zoomBase = 1 + 0.22 * smooth(1.0, 0.5, aspectNow);
        const rTgt = focused ? zoomBase * 0.85 : zoomBase;
        const fk = reduceMotion ? 1 : 1 - Math.exp(-dt / FOCUS_TAU);
        radiusScale += (rTgt - radiusScale) * fk;
        focusAmt += ((focused ? 1 : 0) - focusAmt) * fk;
        if (focused) focusBand = selectedRef.current as number;
        else if (focusAmt < 0.01) focusBand = -1;

        // pan the massif into the clear RIGHT of the dossier while focused — but only
        // on a wide (desktop) viewport, where the overlay is a left column beside the
        // mountain; on a tall phone the overlay stacks vertically, so keep it centred.
        // Eased by focusAmt so the slide tracks the dolly in and out.
        const wide = smooth(1.0, 1.4, aspectNow);
        const focusShift = focusAmt * 0.42 * wide;

        // lift the SELECTED ring to a comfortable framing height. The dolly-in keeps
        // aiming at the summit, so without this the low (early-career) rings near the
        // dune plain dolly off the bottom of the frame and the clicked station can't be
        // seen. Project BOTH the chosen ring anchor and the massif's near-edge foot
        // through the LIVE focused camera (this frame's dolly + pan + breathing,
        // shiftY = 0): lift the ring toward FOCUS_AIM_Y, but never by more than what
        // keeps the foot at FOCUS_FOOT — so the widest dune rings (whose foot is right
        // at the mesh edge) rise into view without baring black sky below the mountain.
        // max(0, …) pulls only UP, leaving the high summit rings already-framed.
        let shiftYTarget = 0;
        const selBand = selectedRef.current;
        if (selBand != null) {
          const { vp } = ridgeCamera(yaw, pitch, aspectNow, t, radiusScale, focusShift);
          const anc = ringAnchor(STATIONS[selBand].radius);
          const rcy = vp[1] * anc.x + vp[5] * anc.y + vp[9] * anc.z + vp[13];
          const rcw = vp[3] * anc.x + vp[7] * anc.y + vp[11] * anc.z + vp[15];
          const fcy = vp[1] * NEAR_EDGE.x + vp[5] * NEAR_EDGE.y + vp[9] * NEAR_EDGE.z + vp[13];
          const fcw = vp[3] * NEAR_EDGE.x + vp[7] * NEAR_EDGE.y + vp[11] * NEAR_EDGE.z + vp[15];
          if (rcw > 1e-6 && fcw > 1e-6) {
            const liftToAim = FOCUS_AIM_Y - rcy / rcw; // raise the ring to the framing line
            const footCap = FOCUS_FOOT - fcy / fcw; // …but not past the foot at the bottom
            shiftYTarget = Math.max(0, Math.min(liftToAim, footCap));
          }
        }
        focusShiftY += (shiftYTarget - focusShiftY) * fk;

        gpu.render({
          time: t,
          yaw,
          pitch,
          hoverBand: shownBand,
          hoverGlow,
          focusBand,
          focusAmt,
          radiusScale,
          focusShift,
          focusShiftY,
        });
        updateSurvey(yaw, pitch, t, dt, radiusScale, focusShift, focusShiftY);
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

  const overlayOpen = selected !== null || assignmentOpen;

  return (
    <div
      className={`ridge-stage${overlayOpen ? " is-overlay-open" : ""}`}
      id="home"
    >
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
            // both forms render; CSS shows the full stacked record on desktop and the
            // compact ORG 'YY on the narrow mobile flank. offsetWidth/Height (measured
            // for the leader layout) reflect whichever variant is visible.
            <li className="survey-callout" key={`callout-${k}`}>
              {/* desktop: the role title with the company beneath it; a leader runs
                  from the ring to the SIDE of the title */}
              <span className="survey-full">
                <span className="sc-title">{s.role}</span>
                <span className="sc-org">{s.company}</span>
              </span>
              {/* narrow flank: the compact single-line annotation */}
              <span className="survey-short">{s.short}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* apex beacon — the floating "?" survey datum welded above the summit. Its
          transform + opacity are written each frame by the rAF loop (projected from
          the orbit axis); clicking it opens the "Your Assignment?" brief. Made inert
          (aria-hidden + tabindex -1) while any overlay is up so focus can't land on
          it behind the dialog. */}
      <button
        type="button"
        className="ridge-beacon"
        ref={beaconRef}
        onClick={openAssignment}
        aria-label="Open: Your Assignment — the projects I can take on"
        aria-haspopup="dialog"
        aria-expanded={assignmentOpen}
        aria-hidden={overlayOpen || undefined}
        tabIndex={overlayOpen ? -1 : 0}
      >
        <span className="beacon-core" aria-hidden="true">
          <span className="beacon-glyph">?</span>
        </span>
        <span className="beacon-leader" aria-hidden="true" />
        <span className="beacon-label" aria-hidden="true">
          Your assignment?
        </span>
      </button>

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

      {/* focused experience: clicking a slice dims the rest of the massif and dollies
          the camera in (GPU), while this full-screen liquid-glass dossier grows in —
          the lit slice reads through a light-frost plate on the left, the written
          record scrolls on the heavy frost to the right. Escape, ✕, or a click on the
          plate dismiss; prev/next walk the career. */}
      <AnimatePresence>
        {selected !== null && (
          <RoleOverlay
            key="role-overlay"
            ref={closeBtnRef}
            index={selected}
            onClose={() => select(null)}
            onNavigate={(i) => select(i)}
          />
        )}
      </AnimatePresence>

      {/* the summit brief — "Your Assignment?", opened by the apex beacon */}
      <AnimatePresence>
        {assignmentOpen && (
          <AssignmentOverlay
            key="assignment-overlay"
            ref={assignCloseBtnRef}
            onClose={closeAssignment}
            onNavigate={closeAssignmentNavigating}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
