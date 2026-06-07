import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import {
  RidgelineScene,
  PITCH_LO,
  PITCH_HI,
  GLOBE_PITCH_LO,
  GLOBE_PITCH_HI,
  ridgeCamera,
  projectToScreen,
  ringAnchor,
  pickBand,
  GLOBE,
  GLOBE_SPIN_RATE,
  MORPH_DUR,
  CLOUD_CHARS,
  CHAR_CLOUD,
} from "../gpu/ridgeline";
import RoleOverlay from "./RoleOverlay";
import AssignmentOverlay from "./AssignmentOverlay";
import ProjectsOverlay, { type ProjectsDialDom } from "./ProjectsOverlay";
import { STATIONS } from "../data/stations";
import { PROJECTS, formatMonthYearLong } from "../data/projects";

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

// ---- Projects "Dial" (see ProjectsOverlay) -------------------------------------
// The Projects view parks the globe LEFT and zooms into its RIGHT hemisphere, then fans the
// ~80 project spokes out to the right as a DENSE, tight radial chart (a career almanac) — the
// selected one resting at 3 o'clock; dragging the globe (a knob) scrolls the selection. These
// constants drive the screen-space fan the rAF loop welds to the projected globe each frame.
// SLOT is the dial rotation per project (the selection wheel — NOT the orbit DETENT); the visible
// window is ±DIAL_VIS spokes mapped LINEARLY across ±DIAL_FAN_HALF, so the fill stays dense no
// matter the count. Each spoke roots JUST OUTSIDE the globe's clearly-defined rim (req 3) so the
// bordered ball stays clear inside; major projects reach further (DIAL_L_MAJOR) than minor ones
// (DIAL_L_MINOR). The fan now renders on mobile too (req 4), tuned tighter (taller + shorter) for
// the narrow portrait frame — the same look as desktop, no vertical-list fallback.
const DIAL_N = PROJECTS.length; // the project count (>= 1; DIAL_SLOT divides by it)
const DIAL_SLOT = TWO_PI / DIAL_N; // selection-wheel step
// a deterministic 0..1 jitter per spoke (FNV-1a over the id) so the dense fan's lengths read
// hand-plotted rather than mechanical — stable across frames, no Math.random in the loop.
const DIAL_JIT = PROJECTS.map((p) => {
  let h = 2166136261;
  for (let j = 0; j < p.id.length; j++) {
    h ^= p.id.charCodeAt(j);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
});
const DIAL_FAN_HALF = (32 * Math.PI) / 180; // visible half-window — a focused rightward WEDGE off the big globe's
// right hemisphere (a wider window throws the long spokes off the top/bottom of a globe this size)
const DIAL_VIS = 26; // spokes drawn on EACH side of the detent (≈53 live at once; the rest wrap to the back & hide)
const DIAL_ARC_FADE = (7 * Math.PI) / 180; // fade band before the cull at the window edge
const DIAL_L_MAJOR = 0.92; // flagship spoke reach past the rim (× the globe screen radius) — reaches well out
const DIAL_L_MINOR = 0.34; // minor / study spoke reach (kept short → strong length contrast, tight near the rim)
const DIAL_L_SEL_BONUS = 0.14; // extra reach lent to the selected (detent) spoke
const DIAL_L_JIT = 0.1; // ± per-spoke length jitter (× Rs) — the organic, hand-plotted reference texture
const DIAL_DRAW_STAGGER = 0.16; // projAmt span between the centre spoke drawing out and the outermost
const DIAL_PAN = 0.6; // NDC_x left-pan of the globe when the dial opens (wide screens only) — parks it further left
const DIAL_ZOOM = 0.92; // globe camera-radius mult at full dial (smaller = closer = bigger → its right side fills).
// raised from 0.8 to ABSORB the bigger home globe (req 5 lowered globeStart) so the dial globe stays the
// same size it was tuned at: 1.45·0.92 ≈ 1.66·0.80 (wide). Only the dial is affected (pCam = 0 elsewhere).
const DIAL_SENS = 1.7; // rad of dial per canvas-height of horizontal drag
const DIAL_SMOOTH_TAU = 0.15; // s — ease displayed angle → target (a heavier, weightier knob)
const DIAL_INERTIA_TAU = 0.6; // s — release-flick decay
const DIAL_MAX_VEL = 3.4; // rad/s — inertia cap
const DIAL_SNAP_VEL = 0.06; // rad/s — below this (and not dragging) settle to the detent
const DIAL_SNAP_TAU = 0.18; // s — detent settle ease
const PROJ_OPEN_TAU = 0.36; // s — projAmt 0→1
const PROJ_CLOSE_TAU = 0.24; // s — projAmt 1→0

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export default function RidgelineStage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
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

  // ---- Home (globe) ⇄ CV (mountain) view + morph ----------------------------
  // The homepage opens as a slowly-spun "globe of lines & letters" (Home); the mountain
  // is the CV view it assembles into. `view` (React) toggles the globe-phase chrome; the
  // imperative rAF loop reads `morphTargetRef` each frame and EASES the morph toward it
  // (0 = globe, 1 = mountain), so the transition runs smoothly in BOTH directions — a real
  // tab switch, not a one-shot intro. Clicking anywhere on the ball, the "CV" nav link, or
  // a #cv deep-link grows the mountain; "Home" (or a #home hash) dissolves it back.
  const [view, setViewState] = useState<"home" | "cv">("home");
  const morphTargetRef = useRef(0);
  const cloudRef = useRef<HTMLDivElement>(null);

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

  // ---- Projects timeline overlay -------------------------------------------
  // A third focused surface, a sibling of the assignment brief: the "Projects" nav
  // link / #projects route opens the survey-line timeline OVER whichever scene
  // (globe or mountain) is live — no morph change. `projectsOpenRef` is the value
  // the rAF loop reads each frame to quiet the scene behind it; `closeProjectsRef`
  // is the stable handle the once-registered window keydown listener reaches the
  // close setter through (same indirection as closeAssignRef).
  const [projectsOpen, setProjectsOpen] = useState(false);
  const projectsOpenRef = useRef(false);
  const closeProjectsRef = useRef<() => void>(() => {});
  const projectsCloseBtnRef = useRef<HTMLButtonElement>(null);
  const projectsLastFocusRef = useRef<HTMLElement | null>(null);
  const projectsWasOpenRef = useRef(false);
  // the Projects DIAL bridge: the overlay writes its live DOM nodes into dialDomRef
  // (the rAF loop reads it each frame to weld the spokes/labels to the projected globe),
  // and selecting a project (click / mobile-list tap) routes through dialGotoRef, which
  // the imperative loop assigns so it can mutate the loop-local dial angle.
  const dialDomRef = useRef<ProjectsDialDom | null>(null);
  const dialGotoRef = useRef<(i: number) => void>(() => {});
  const onDialSelect = useCallback((i: number) => dialGotoRef.current(i), []);

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

  const openProjects = useCallback(() => {
    // drop focus off the beacon first (same defensiveness as openAssignment) so it
    // never sits inside an aria-hidden subtree once the overlay commits.
    beaconRef.current?.blur();
    // the Dial IS a globe experience — if the mountain (CV) is showing, dissolve it back
    // to the globe first; the rAF loop holds projAmt at 0 until the morph clears (mc<0.15),
    // so the dial fans in only once the globe is actually present.
    if (morphTargetRef.current !== 0) {
      morphTargetRef.current = 0;
      setViewState("home");
    }
    projectsOpenRef.current = true;
    setProjectsOpen(true);
  }, []);
  const closeProjects = useCallback(() => {
    projectsOpenRef.current = false;
    setProjectsOpen(false);
    // restore the route to whatever scene sits behind the timeline (globe or mountain)
    if (typeof location !== "undefined" && location.hash === "#projects") {
      const hash = morphTargetRef.current === 1 ? "#cv" : "#home";
      history.replaceState(null, "", hash);
    }
  }, []);

  const select = useCallback((i: number | null) => {
    selectedRef.current = i;
    setSelected(i);
  }, []);

  // switch views: CV assembles the mountain out of the globe; Home dissolves it back and
  // closes any open dossier/brief (those career slices don't exist on the globe). Drives the
  // morph target the rAF loop eases toward, and keeps the URL hash in sync so the header
  // links and the browser back/forward stay authoritative.
  const navTo = useCallback(
    (v: "home" | "cv") => {
      morphTargetRef.current = v === "cv" ? 1 : 0;
      setViewState(v);
      if (v === "home") {
        select(null);
        closeAssignment();
      }
      const hash = v === "cv" ? "#cv" : "#home";
      if (typeof location !== "undefined" && location.hash !== hash) {
        // replaceState (not location.hash =) so we don't re-fire our own hashchange listener
        history.replaceState(null, "", hash);
      }
    },
    [select, closeAssignment],
  );
  const navToRef = useRef(navTo);

  // keep the loop's escape hatches pointed at the freshest setters every render
  useEffect(() => {
    selectRef.current = select;
    closeAssignRef.current = closeAssignment;
    closeProjectsRef.current = closeProjects;
    navToRef.current = navTo;
  });

  // hash routing: the header's Home/CV/Projects links (and the browser back/forward button)
  // drive the view through the URL hash. #cv assembles the mountain, #home returns to the
  // globe, #projects opens the timeline OVER whichever scene is live. A #cv or #projects
  // deep-link on mount lands straight on it; an empty hash stays the clean globe landing.
  // Other hashes (#about/#contact) are left untouched here.
  useEffect(() => {
    if (location.hash === "#cv") {
      morphTargetRef.current = 1;
      setViewState("cv");
    } else if (location.hash === "#projects") {
      projectsOpenRef.current = true;
      setProjectsOpen(true);
    }
    const onHash = () => {
      const h = location.hash;
      if (h === "#projects") openProjects();
      else if (h === "#cv") {
        closeProjects();
        navTo("cv");
      } else if (h === "#home" || h === "") {
        closeProjects();
        navTo("home");
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [navTo, openProjects, closeProjects]);

  // focus management: on open, remember what was focused and move focus into the
  // dialog; on close (only after an actual open), restore it to the trigger. The
  // wasOpenRef guard keeps the initial mount from stealing focus to the rotate arrow.
  useEffect(() => {
    if (selected !== null) {
      lastFocusRef.current = document.activeElement as HTMLElement | null;
      closeBtnRef.current?.focus();
      wasOpenRef.current = true;
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      lastFocusRef.current?.focus?.();
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

  // the same focus dance for the Projects timeline: remember what held focus (the
  // Projects nav link), move focus to its close control on open, restore on close —
  // falling back to the nav link when nothing meaningful held it.
  useEffect(() => {
    if (projectsOpen) {
      projectsLastFocusRef.current = document.activeElement as HTMLElement | null;
      projectsCloseBtnRef.current?.focus();
      projectsWasOpenRef.current = true;
    } else if (projectsWasOpenRef.current) {
      projectsWasOpenRef.current = false;
      const prev = projectsLastFocusRef.current;
      const navLink =
        typeof document !== "undefined"
          ? document.querySelector<HTMLElement>('nav a[href="#projects"]')
          : null;
      (prev && prev !== document.body ? prev : navLink)?.focus?.();
    }
  }, [projectsOpen]);

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
      // live pitch walls — updated each frame from the morph clock: the WIDE globe range
      // (look over the top / under the bottom of the ball) eases to the TIGHT authored mountain
      // range, pinned exactly at the endpoints (mEase 0 = globe walls, 1 = mountain walls).
      let pLo = GLOBE_PITCH_LO, pHi = GLOBE_PITCH_HI;
      const clampPitch = (p: number) => Math.min(Math.max(p, pLo), pHi);
      // add a pitch delta with a soft, direction-aware cushion: within PITCH_SOFT
      // of the limit you're heading toward, the step is scaled down to zero so the
      // tilt glides to rest instead of slamming. Returns the new (still-bounded)
      // target — never overshoots, and reverses cleanly with no dead zone.
      const addPitch = (cur: number, delta: number) => {
        const head = delta > 0 ? pHi - cur : delta < 0 ? cur - pLo : 1;
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

      // ---- Home (globe) ⇄ CV (mountain) morph (loop-locals; read by frame + the pointer
      // handlers, which all live in this one closure so they share the live values) ----
      const SPIN = reduceMotion ? 0 : GLOBE_SPIN_RATE; // idle planet spin (held still on reduced-motion)
      // The morph is a constant-DURATION clock: mClock is driven LINEARLY in time toward the view
      // target (0 = globe/Home, 1 = mountain/CV) at 1/MORPH_DUR per second, then shaped ONCE by a
      // smootherstep into the perceptual clock `mc` every VISUAL consumer reads (the GPU uniform, the
      // cloud, the survey, the dolly). One ease (not the old compounded exponential×smootherstep) plays
      // the whole assembly at a steady, readable pace and lands crisply. mEase mirrors mClock and stays
      // the phase latch the pointer/arrow handlers test (mEase < 0.04 ⇒ still the globe).
      let mClock = 0;           // 0 = globe (Home), 1 = mountain (CV) — LINEAR time toward morphTargetRef
      let mEase = 0;            // = mClock; kept as the phase latch the pointer/arrow handlers read
      let prevMorphTarget = 0;  // last frame's view target — detects a fresh →CV switch (reduced-motion snap)
      let globeSpin = 0;        // radians about Y; advances whenever the globe shows, eased to rest as terrain forms
      const mix01 = (a: number, b: number, t: number) => a + (b - a) * t;
      let hintOpacity = 0;      // eased opacity of the bottom "drag to rotate" cue (globe-only, loop-owned)

      // ---- Projects "Dial" loop state (shared by the frame + the projects-mode pointer/key
      // handlers + updateDial, all in this one closure). projAmt eases the whole dial in/out;
      // dialAngle is the eased displayed knob angle (tDialAngle its target); selecting reads the
      // project nearest the 3-o'clock detent. The globe's idle spin fades out as projAmt rises and
      // the dial drives the spin instead, so the ball turns 1:1 with the knob.
      let projAmt = 0;            // 0 = no dial … 1 = dial fully open (globe parked left, calmed)
      let dialAngle = 0;          // eased displayed knob angle (rad)
      let tDialAngle = 0;         // target knob angle the drag/keys/snap steer
      let velDial = 0;            // rad/s — release-flick inertia
      let dialSelected = 0;       // project index nearest the 3-o'clock detent
      let dialPrevSelected = -1;  // last frame's selection (roving tabindex / announce on change)
      let dialDragging = false;
      let dialStartAngle = 0, dialStartX = 0; // drag anchor
      let dialLastNotch = 0;      // detent-tick bookkeeping during a drag
      // snap the dial to project i the SHORT way round (fold the delta to ±π)
      const dialGoto = (i: number) => {
        let delta = (i * DIAL_SLOT - tDialAngle) % TWO_PI;
        if (delta > Math.PI) delta -= TWO_PI;
        if (delta < -Math.PI) delta += TWO_PI;
        tDialAngle += delta;
        velDial = 0;
        stopInviting();
      };
      dialGotoRef.current = dialGoto;

      // letter-cloud geometry: the protagonists' Fibonacci dirs + the DECOMPOSED character cloud
      // (even dirs, per-char radial depth, and the ring each char rains toward — all built once in
      // ridgeline.ts), plus cached DOM node lists. On a narrow flank / reduced motion the char
      // count is trimmed (charCount) to keep the per-frame DOM writes light.
      const charDirs = CHAR_CLOUD.dirs;
      const charRadii = CHAR_CLOUD.radii;
      const charRings = CHAR_CLOUD.rings;
      const charCount =
        reduceMotion || cvs.clientWidth < 760
          ? Math.min(CLOUD_CHARS.length, 68)
          : CLOUD_CHARS.length;
      let charEls: NodeListOf<HTMLElement> | null = null;
      // rotate a base dir about Y by `spin`, matching the shader's lon += globeSpin (a point at
      // base-longitude φ ends at φ+spin, measured from +z toward +x) so letters weld to the lines.
      const rotY = (dx: number, dy: number, dz: number, spin: number): [number, number, number] => {
        const s = Math.sin(spin), c = Math.cos(spin);
        return [dx * c + dz * s, dy, -dx * s + dz * c];
      };

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

      // ---- the breathing "you can drag this" invitation on the bottom hint retires the
      // moment the viewer first rotates by any means (drag or arrow keys) — stopInviting()
      // fades the bottom cue out for good.
      let invited = true;
      const stopInviting = () => {
        if (!invited) return;
        invited = false;
        if (hintRef.current) hintRef.current.style.opacity = "0";
      };
      // one rotate path for the arrow keys, in BOTH phases. dir = +1 (left) / -1 (right),
      // matching the drag sign (a leftward drag is +). It nudges the SAME camera orbit target
      // the drag steers (globe and mountain alike) and seeds velYaw so it glides out on the
      // existing inertia. The globe's idle Y-spin (globeSpin) is independent ambient motion and
      // is NOT touched here — so a nudge orbits the viewpoint, never jolts the ball.
      const rotateNudge = (dir: number) => {
        tYaw += dir * 0.32;
        velYaw = Math.max(-MAX_VEL, Math.min(MAX_VEL, velYaw + dir * 0.9));
        velPitch = 0;
        stopInviting();
        haptic(8, performance.now());
      };

      const onDown = (e: PointerEvent) => {
        if (e.pointerType === "mouse" && e.button !== 0) return; // left only
        // PROJECTS DIAL: a drag spins the knob (scrolls the project selection), never the orbit.
        if (projectsOpenRef.current) {
          dialDragging = true;
          pid = e.pointerId;
          dialStartAngle = tDialAngle;
          dialStartX = e.clientX;
          lastT = e.timeStamp;
          velDial = 0;
          dialLastNotch = Math.round(tDialAngle / DIAL_SLOT);
          stopInviting();
          try { cvs.setPointerCapture(pid); } catch { /* capture optional */ }
          cvs.style.cursor = "grabbing";
          haptic(10, e.timeStamp);
          e.preventDefault();
          return;
        }
        dragging = true;
        // a drag ORBITS the camera in both phases now (globe and mountain share one orbit path);
        // the globe's idle Y-spin is independent ambient motion, never driven by the drag.
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
        // PROJECTS DIAL drag → spin the knob (the globe + the fan follow dialAngle)
        if (projectsOpenRef.current && dialDragging && e.pointerId === pid) {
          const ddt = Math.min(Math.max((e.timeStamp - lastT) / 1000, 1 / 240), 1 / 30);
          lastT = e.timeStamp;
          const rot = ((2 * Math.PI) / Math.max(cvs.clientHeight, 1)) * DIAL_SENS;
          const prev = tDialAngle;
          tDialAngle = dialStartAngle + (e.clientX - dialStartX) * rot; // drag right → next project
          velDial = Math.max(
            -DIAL_MAX_VEL,
            Math.min(DIAL_MAX_VEL, velDial * 0.5 + ((tDialAngle - prev) / ddt) * 0.5),
          );
          const notch = Math.round(tDialAngle / DIAL_SLOT);
          if (notch !== dialLastNotch) { dialLastNotch = notch; haptic(6, e.timeStamp); }
          e.preventDefault();
          return;
        }
        if (!dragging || e.pointerId !== pid) return;
        // once the press travels past the slop it's a drag, not a click — a real rotation
        // (spin OR orbit) retires the arrows' breathing invitation, leaving them as controls
        if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_SLOP) {
          moved = true;
          stopInviting();
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
        // PROJECTS DIAL release — the knob settles to its detent via the frame loop's inertia
        if (dialDragging && e.pointerId === pid) {
          dialDragging = false;
          pid = -1;
          try { cvs.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
          cvs.style.cursor = "grab";
          e.preventDefault();
          return;
        }
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
          // globe phase: a tap ANYWHERE on the ball assembles the mountain (navigates to the
          // CV view) — and never tries to pick a career slice that isn't there yet.
          if (mEase < 0.985) { navToRef.current("cv"); return; }
          const r = cvs.getBoundingClientRect();
          const px = e.clientX - r.left;
          const py = e.clientY - r.top;
          // a click on a survey CALLOUT (the floating role title + company) opens that
          // station directly. The words sit off the slope in the air, so the terrain
          // ray-pick below can't see them — test their projected boxes first (the same
          // geometry updateSurvey lays out each frame, in canvas px; mirrors the hover
          // hit-test), then fall back to the ray-pick for a click on the bare slope.
          let b = -1;
          for (let k = 0; k < STATIONS.length; k++) {
            if (visA[k] <= 0.12 || !ptsA[k]) continue;
            if (
              px >= lxA[k] - 14 && px <= lxA[k] + labelW[k] + 14 &&
              py >= tyA[k] - 8 && py <= tyA[k] + labelH[k] + 8
            ) { b = k; break; }
          }
          if (b < 0) {
            b = pickBand(
              yaw, pitch, cvs.clientWidth / Math.max(cvs.clientHeight, 1),
              lastFrameT, px, py, cvs.clientWidth, cvs.clientHeight, radiusScale,
            );
          }
          if (b >= 0) {
            selectRef.current(b);
            stopInviting();
          }
        }
      };

      const onKey = (e: KeyboardEvent) => {
        // Escape dismisses an open surface before any orbit handling — the Projects
        // timeline first, then the summit brief, then a focused career slice
        if (e.key === "Escape" && projectsOpenRef.current) {
          closeProjectsRef.current();
          e.preventDefault();
          return;
        }
        // the Projects DIAL owns arrow / Home / End while it's open (they step the knob);
        // never let those leak to the canvas orbit / globe-spin beneath. Up/Left = previous,
        // Down/Right = next (matching a drag-right → next); Home/End jump to the first/last.
        if (
          projectsOpenRef.current &&
          (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End")
        ) {
          if (e.key === "ArrowUp" || e.key === "ArrowLeft") tDialAngle -= DIAL_SLOT;
          else if (e.key === "ArrowDown" || e.key === "ArrowRight") tDialAngle += DIAL_SLOT;
          else if (e.key === "Home") dialGoto(0);
          else if (e.key === "End") dialGoto(DIAL_N - 1);
          velDial = 0;
          stopInviting();
          haptic(8, e.timeStamp);
          e.preventDefault();
          return;
        }
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
        // both phases: left/right orbit-yaw via the shared rotateNudge; up/down step the pitch
        // directly (now allowed on the globe too — the wide globe pitch walls let you look over
        // the top / under the bottom of the ball, the same gesture as on the mountain).
        if (e.key === "ArrowLeft") { rotateNudge(1); e.preventDefault(); return; }
        if (e.key === "ArrowRight") { rotateNudge(-1); e.preventDefault(); return; }
        const step = 0.2; // rad per press (~11°) — eased in by the smoothing
        if (e.key === "ArrowUp") tPitch = addPitch(tPitch, -step);
        else if (e.key === "ArrowDown") tPitch = addPitch(tPitch, step);
        else return;
        stopInviting();
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
        m: number, // the perceptual morph clock (mc) — passed in so the survey/beacon arrive
                   // in lock-step with the GPU geometry rather than reading a stale closure value
      ) => {
        const overlay = overlayRef.current;
        if (!overlay) return;
        // suppress the whole survey + apex beacon through the globe + the assembly, then fade
        // them in over the last stretch — picking up the baton just as the flying protagonist
        // labels land and fade out (~0.85), so the words arrive with the finished mountain.
        if (m < 0.80) {
          if (labelEls) labelEls.forEach((el) => { el.style.opacity = "0"; });
          if (leaderEls) leaderEls.forEach((el) => { (el as SVGElement).style.opacity = "0"; });
          if (beaconRef.current) {
            // also kill pointer events so the rAF loop — not just React's aria-hidden
            // / tabindex — is authoritative for the hidden beacon (no stray click-through
            // behind an overlay opened during the globe phase)
            beaconRef.current.style.opacity = "0";
            beaconRef.current.style.pointerEvents = "none";
          }
          return;
        }
        const surveyFade = smooth(0.80, 1.0, m);
        // while a slice is focused the survey words recede behind the panel — only
        // the selected callout stays lit, and the per-frame hover pick is skipped.
        const focusActive =
          selectedRef.current != null ||
          assignmentOpenRef.current ||
          projectsOpenRef.current;
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
          const op = (dispOp[k] * surveyFade).toFixed(3);
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
          const open =
            selectedRef.current != null ||
            assignmentOpenRef.current ||
            projectsOpenRef.current;
          const target = open || !inFrame || !clearHeader ? 0 : 1;
          const bk = reduceMotion ? 1 : 1 - Math.exp(-dt / BEACON_TAU);
          beaconOp += (target - beaconOp) * bk;
          beacon.style.transform =
            `translate3d(${ap.x.toFixed(1)}px, ${ap.y.toFixed(1)}px, 0) translate(-50%, -50%)`;
          beacon.style.opacity = (beaconOp * 0.9 * surveyFade).toFixed(3);
          beacon.style.pointerEvents = !open && beaconOp > 0.5 ? "auto" : "none";
        }
      };

      // ---- letter cloud: the "ball of letters". Individual characters from the real career
      // record (data/stations.ts), scattered THROUGH the globe volume and co-rotated (rotY) in
      // lock-step with the GPU filament lines. As the mountain forms they rain toward their ring
      // band and fade — the decomposed record settling onto the contour bands. Projected from the
      // SAME live vp/eye the GPU rendered with, so nothing drifts. (The old whole-word role·company
      // labels were removed — the globe is purely a tangle of lines + loose letters now.) ----
      const updateCloud = (
        vp: Float32Array,
        eye: [number, number, number],
        spin: number,
        m: number,
        W: number,
        H: number,
      ) => {
        const wrap = cloudRef.current;
        if (!wrap) return;
        if (wrap.style.visibility === "hidden") wrap.style.visibility = "visible";
        if (!charEls) charEls = wrap.querySelectorAll<HTMLElement>(".cloud-char");

        // CHARS: individual glyphs scattered THROUGH the volume at many radii (cr) — deep glyphs sit
        // near the core, outer ones near the rim, so the letters are MIXED IN among the filaments at
        // every depth. As the mountain forms they rain toward their ring anchor and fade — the
        // decomposed "ball of letters" settling onto the contour bands.
        // fade the glyphs out a touch EARLIER than they rain home (fall completes ~0.62), so they
        // are mostly gone before the GPU drain funnel peaks → the additive climax stays one source.
        const charVis = 1 - smooth(0.52, 0.72, m); // hold the glyphs legible until the funnel peak, then clear just before the halo blooms
        const fall = smooth(0.30, 0.66, m); // 0 on the globe → 1 raining onto the ring band, in step with the funnel/emerge
        for (let i = 0; i < charEls.length; i++) {
          const el = charEls[i];
          // trimmed on a narrow flank / reduced motion → drop the layer entirely (not just opacity 0)
          if (i >= charCount) { el.style.display = "none"; continue; }
          if (charVis <= 0.002) { el.style.opacity = "0"; continue; }
          const cr = charRadii[i];
          const [rx, ry, rz] = rotY(charDirs[i * 3], charDirs[i * 3 + 1], charDirs[i * 3 + 2], spin);
          const Px = GLOBE.cx + GLOBE.r * cr * rx, Py = GLOBE.cy + GLOBE.r * cr * ry, Pz = GLOBE.cz + GLOBE.r * cr * rz;
          const vx = eye[0] - Px, vy = eye[1] - Py, vz = eye[2] - Pz;
          const vl = Math.hypot(vx, vy, vz) || 1;
          const facing = (rx * vx + ry * vy + rz * vz) / vl; // outward normal · view (>0 = front)
          const faceFade = 0.22 + 0.78 * smooth(-0.25, 0.45, facing); // back glyphs DISSOLVE (no muddy floor)
          const cw = vp[3] * Px + vp[7] * Py + vp[11] * Pz + vp[15];
          if (cw <= 1e-6) { el.style.opacity = "0"; continue; }
          const depth = smooth(0.0, 1.0, ((2 * GLOBE.r) / cw) * 0.85); // 0 far → 1 near (the globe
          // sits dollied back at rest, so this is boosted to keep the front glyphs clearly legible)
          const op = charVis * faceFade * (0.5 + 0.5 * depth) * (0.52 + 0.48 * cr);
          if (op < 0.04) { el.style.opacity = "0"; continue; } // soft cull → thins the far smear AND skips the write
          const cx = vp[0] * Px + vp[4] * Py + vp[8] * Pz + vp[12];
          const cy = vp[1] * Px + vp[5] * Py + vp[9] * Pz + vp[13];
          let sx = ((cx / cw) * 0.5 + 0.5) * W;
          let sy = (1 - ((cy / cw) * 0.5 + 0.5)) * H;
          // rain toward this char's ring anchor (the same anchors the survey callouts use)
          if (fall > 0.001) {
            const a = ringAnchor(STATIONS[charRings[i]].radius);
            const tp = projectToScreen(vp, a.x, a.y, a.z, W, H);
            if (tp.visible) { sx += (tp.x - sx) * fall; sy += (tp.y - sy) * fall; }
          }
          const scale = 0.55 + 0.62 * depth * (0.6 + 0.4 * cr);
          el.style.transform =
            `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
          el.style.opacity = op.toFixed(3);
        }
      };

      // ---- Projects DIAL welder: project the globe centre + a rim point through the LIVE vp,
      // then lay out the project spokes as a screen-space fan on the globe's right hemisphere —
      // the selected project horizontal at 3 o'clock, neighbours arcing up/down, the rest wrapping
      // around the back (hidden). Mirrors updateCloud/updateSurvey: imperative DOM writes only, so
      // nothing re-renders React and the fan stays welded to the (panned) globe. The fan now runs on
      // EVERY viewport (req 4); mobile just tunes it tighter (taller + shorter) for the narrow frame.
      const updateDial = (
        vp: Float32Array,
        W: number,
        H: number,
        amt: number,
        sel: number,
        pDraw: number,
        pLabel: number,
      ) => {
        const dom = dialDomRef.current;
        if (!dom) return;
        const mobile = W < 760; // the fan now runs on mobile too (req 4) — just tuned tighter below
        // masthead readout tracks every frame (a cheap text write). NAME only (req 5).
        if (dom.plate) dom.plate.textContent = `PLATE ${String(sel + 1).padStart(2, "0")} / ${DIAL_N}`;
        if (dom.live) dom.live.textContent = PROJECTS[sel].title.toUpperCase();

        const { lines, nodes, glows, labels } = dom;
        if (labels.length === DIAL_N) {
          const c = projectToScreen(vp, GLOBE.cx, GLOBE.cy, GLOBE.cz, W, H);
          const ed = projectToScreen(vp, GLOBE.cx + GLOBE.r, GLOBE.cy, GLOBE.cz, W, H);
          const Rs = Math.hypot(ed.x - c.x, ed.y - c.y) || 1; // projected globe radius (px)
          // weld the clearly-defined rim circle to the projected ball (req 3) — the crisp border the
          // organized rays stay INSIDE of, and the project chart fans OUTSIDE of.
          if (dom.rim) {
            if (c.visible && Rs >= 8 && Rs <= W * 3) {
              dom.rim.setAttribute("cx", c.x.toFixed(1));
              dom.rim.setAttribute("cy", c.y.toFixed(1));
              dom.rim.setAttribute("r", Rs.toFixed(1));
              dom.rim.style.opacity = (amt * 0.85).toFixed(3);
            } else {
              dom.rim.style.opacity = "0";
            }
          }
          // mobile fans a TALLER, SHORTER chart (more vertical room, less width) so it fits the narrow
          // portrait frame; desktop keeps the wide reaching wedge.
          const fanHalf = mobile ? (52 * Math.PI) / 180 : DIAL_FAN_HALF;
          const lMajor = mobile ? 0.66 : DIAL_L_MAJOR;
          const lMinor = mobile ? 0.26 : DIAL_L_MINOR;
          // skip the fan layout on a degenerate projection (hold the last-good transforms); the
          // SR announce below still runs so selection stays accessible.
          if (c.visible && Rs >= 8 && Rs <= W * 3) {
            const fadeStart = fanHalf - DIAL_ARC_FADE;
            for (let i = 0; i < DIAL_N; i++) {
              // signed wheel distance from the selected detent, folded to the nearest wrap
              let k = (((i - sel) % DIAL_N) + DIAL_N) % DIAL_N;
              if (k > DIAL_N / 2) k -= DIAL_N;
              const ak = Math.abs(k);
              const line = lines[i], node = nodes[i], glow = glows[i], label = labels[i];
              if (ak > DIAL_VIS) {
                // beyond the visible window → wrapped round the back of the dial, hidden
                line.style.display = "none";
                node.style.display = "none";
                if (glow) glow.style.display = "none";
                label.style.display = "none";
                (label as HTMLElement).tabIndex = -1;
                continue;
              }
              const isSel = k === 0;
              // map k LINEARLY onto the right-hemisphere arc so the fill stays dense at any count
              // (screen y is down → negate sin for a +up angle)
              const a = (k / DIAL_VIS) * fanHalf;
              const aa = Math.abs(a);
              const ca = Math.cos(a), sa = Math.sin(a);

              // every spoke roots JUST OUTSIDE the rim (req 3) — the bordered globe stays clear inside;
              // the whole project chart lives outside it. The selected spoke lifts a hair further out.
              const innerR = Rs * (isSel ? 1.07 : 1.03);
              const ix = c.x + innerR * ca, iy = c.y - innerR * sa;

              // OUTER reach: major reaches further than minor, plus a stable per-spoke jitter for
              // the organic texture and a bump for the selected spoke; tapered as it nears the cull.
              const base = PROJECTS[i].major ? lMajor : lMinor;
              const jit = (DIAL_JIT[i] - 0.5) * 2 * DIAL_L_JIT;
              const edgeShorten = aa > fadeStart ? 1 - 0.55 * smooth(fadeStart, fanHalf, aa) : 1;
              const Lf = (base + jit + (isSel ? DIAL_L_SEL_BONUS : 0)) * edgeShorten;
              const fullOutR = Rs + Rs * Math.max(0.12, Lf); // final tip radius (px from centre)

              // staggered OUTWARD draw (req 6): the centre spoke leads, outer ones trail by an
              // angular fraction — the fan unfurls from the detent outward, out of the globe.
              const delay = (ak / DIAL_VIS) * DIAL_DRAW_STAGGER;
              const grow = smooth(delay, Math.min(1, delay + 0.42), pDraw); // 0→1 for this spoke
              const headR = innerR + (fullOutR - innerR) * grow;
              const hx = c.x + headR * ca, hy = c.y - headR * sa; // the live head / node ride this

              // opacity: edge fade × master amt × this spoke's draw progress
              const edgeFade = aa > fadeStart ? 1 - smooth(fadeStart, fanHalf, aa) : 1;
              const op = (edgeFade * amt * grow).toFixed(3);

              line.style.display = "";
              node.style.display = "";
              label.style.display = "";
              line.setAttribute("x1", ix.toFixed(1));
              line.setAttribute("y1", iy.toFixed(1));
              line.setAttribute("x2", hx.toFixed(1));
              line.setAttribute("y2", hy.toFixed(1));
              line.style.opacity = op;
              node.setAttribute("cx", hx.toFixed(1));
              node.setAttribute("cy", hy.toFixed(1));
              node.style.opacity = op;
              if (glow) {
                glow.setAttribute("cx", hx.toFixed(1));
                glow.setAttribute("cy", hy.toFixed(1));
                glow.style.display = isSel ? "" : "none";
              }

              // RADIAL TEXT along the spoke (req 3): rotate the label to the spoke's screen angle.
              // CSS rotate is clockwise-positive and our `a` is +up ⇒ deg = −a·180/π. The whole fan
              // lives on the RIGHT hemisphere (|a| ≤ 80° ⇒ cos a > 0), so text always reads outward
              // and never inverts — no flip needed. The label's transform-origin is its box top-left
              // (CSS), so the trailing translateY(-50%) drops the text's vertical centre onto the
              // spoke line; it slides out a touch as it resolves, trailing the drawn head.
              const deg = (-a * 180) / Math.PI;
              const labelGrow = smooth(delay, Math.min(1, delay + 0.5), pLabel);
              const tipX = c.x + (fullOutR + 10) * ca, tipY = c.y - (fullOutR + 10) * sa;
              const slide = (1 - labelGrow) * 8;
              label.style.transform =
                `translate(${tipX.toFixed(1)}px, ${tipY.toFixed(1)}px) rotate(${deg.toFixed(2)}deg)` +
                ` translate(${slide.toFixed(1)}px, 0) translateY(-50%)`;
              label.style.opacity = (edgeFade * amt * labelGrow).toFixed(3);
              (label as HTMLElement).tabIndex = isSel ? 0 : -1;

              // only the selected (amber accent) + major (heavier weight) classes survive — no
              // near/far tiers now (name-only, req 5)
              line.classList.toggle("is-selected", isSel);
              node.classList.toggle("is-selected", isSel);
              if (glow) glow.classList.toggle("is-selected", isSel);
              label.classList.toggle("is-selected", isSel);
              label.classList.toggle("is-major", PROJECTS[i].major);
            }
          }
        }

        // roving focus + a polite SR announcement when the selection changes
        if (sel !== dialPrevSelected) {
          dialPrevSelected = sel;
          if (dom.liveRegion)
            // mirror the button aria-label (title · date · place) so the polite announcement loses
            // nothing — the name-only rule (req 5) governs the VISIBLE dial, not the SR readout
            dom.liveRegion.textContent =
              `${PROJECTS[sel].title}, ${formatMonthYearLong(PROJECTS[sel].date)}, ${PROJECTS[sel].place}`;
          const act = typeof document !== "undefined" ? document.activeElement : null;
          if (act && act.classList?.contains("dial-label")) {
            labels[sel]?.focus?.();
          }
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

        // ease the morph toward the current view target (0 = Home/globe, 1 = CV/mountain)
        // every frame, so the assembly runs smoothly in BOTH directions — grow the mountain
        // on a switch to CV, dissolve it back into the spinning globe on a return Home. The
        // planet's idle spin runs whenever the globe is present, easing to rest as the terrain
        // takes over so a switch reads as a settle rather than a slide.
        // ---- the morph clock: ONE linear-time parameter driven toward the view target at a fixed
        // rate (1/MORPH_DUR per second), then shaped ONCE by smootherstep. The old compounded
        // exponential×smootherstep had an unpredictable, front-loaded velocity (a rush, then a mushy
        // crawl); a constant-DURATION clock plays the whole assembly at a steady, readable pace and
        // lands crisply. reduceMotion jumps straight to the target. Endpoints pinned: smootherstep
        // (0)=0, (1)=1, and mClock hard-clamps to the target ⇒ mc≡1 when landed ⇒ the morph=1
        // mountain is byte-identical.
        const mTarget = morphTargetRef.current;
        const mDir = mClock < mTarget ? 1 : mClock > mTarget ? -1 : 0; // 0 at the target → rests at 0/1 exactly
        const mRate = reduceMotion ? 1e9 : 1 / MORPH_DUR;
        mClock = Math.max(0, Math.min(1, mClock + mDir * mRate * dt));
        if (Math.abs(mTarget - mClock) < 5e-4) mClock = mTarget;
        mEase = mClock; // the phase latch (mEase < 0.04 ⇒ still globe); a linear ramp crosses it cleanly
        const mc = reduceMotion
          ? mClock
          : mClock * mClock * mClock * (mClock * (mClock * 6 - 15) + 10);

        // ---- Projects DIAL clocks. projAmt eases in only once the globe is actually present
        // (mc<0.15), so opening from CV waits for the mountain to dissolve. The knob angle eases
        // toward its target with a release-flick + a detent snap; while closed it unwinds to rest.
        const projTarget = projectsOpenRef.current && mc < 0.15 ? 1 : 0;
        const projTau = projTarget > projAmt ? PROJ_OPEN_TAU : PROJ_CLOSE_TAU;
        projAmt += (projTarget - projAmt) * (reduceMotion ? 1 : 1 - Math.exp(-dt / projTau));
        if (projTarget === 0 && projAmt < 1e-3) projAmt = 0;
        // ---- mesmerizing transition phase windows (req 6): sub-ranges of the SAME monotonic
        // projAmt, so the close reverses the open exactly. pCam LEADS (the camera pans the globe
        // further left + zooms into its right hemisphere); pDraw unfurls the spokes OUT of the
        // globe; pLabel resolves the radial labels last, trailing the drawn heads. (The shell
        // straighten + DoF blur ride F.mph.w = projAmt directly in the shaders, shaped there.)
        const pCam = smooth(0.0, 0.55, projAmt);
        const pDraw = smooth(0.34, 1.0, projAmt);
        const pLabel = smooth(0.62, 1.0, projAmt);
        if (projectsOpenRef.current) {
          if (!dialDragging) {
            velDial *= Math.exp(-dt / DIAL_INERTIA_TAU);
            tDialAngle += velDial * dt;
            if (Math.abs(velDial) < DIAL_SNAP_VEL) {
              const snap = Math.round(tDialAngle / DIAL_SLOT) * DIAL_SLOT; // settle to the nearest detent
              tDialAngle += (snap - tDialAngle) * (reduceMotion ? 1 : 1 - Math.exp(-dt / DIAL_SNAP_TAU));
              if (Math.abs(velDial) < 1e-4) velDial = 0;
            }
            if (Math.abs(tDialAngle) > 6 * Math.PI) { // unwind a many-flick spin without a visible jump
              const fold = Math.round(tDialAngle / TWO_PI) * TWO_PI;
              tDialAngle -= fold; dialAngle -= fold;
            }
          }
          dialAngle += (tDialAngle - dialAngle) * (reduceMotion ? 1 : 1 - Math.exp(-dt / DIAL_SMOOTH_TAU));
        } else if (projAmt > 0) {
          tDialAngle = 0; velDial = 0; // closing: unwind to rest so a reopen starts fresh
          dialAngle += (0 - dialAngle) * (reduceMotion ? 1 : 1 - Math.exp(-dt / DIAL_SMOOTH_TAU));
        }
        dialSelected = ((Math.round(dialAngle / DIAL_SLOT) % DIAL_N) + DIAL_N) % DIAL_N;

        // tighten the pitch walls from the wide GLOBE range to the authored MOUNTAIN range as the
        // morph runs; re-clamp the target so a wide globe tilt eases inside the new walls instead of
        // snapping. Endpoints pinned: mEase 0 ⇒ globe walls, 1 ⇒ mountain walls.
        pLo = mix01(GLOBE_PITCH_LO, PITCH_LO, mEase);
        pHi = mix01(GLOBE_PITCH_HI, PITCH_HI, mEase);
        tPitch = clampPitch(tPitch);
        // idle planet spin — eases out as the mountain forms; during the Projects dial it keeps a SLOW
        // ordered drift (req 2: mesmerizing movement) rather than freezing, so the organized rays keep
        // turning. The knob (dialAngle) adds on top when the viewer drags.
        globeSpin += SPIN * (1 - smooth(0.15, 0.6, mc)) * (1 - 0.62 * smooth(0.0, 0.45, projAmt)) * dt;
        // the GPU globe + the DOM letter-cloud both read this summed spin, so the ball turns 1:1
        // with the knob (dialAngle) while the dial is open and resumes its idle drift when closed.
        const spinOut = globeSpin + dialAngle * projAmt;
        const landed = mc > 0.985;

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

        // reduced motion has no morph window to resolve the camera in, so snap the orbit to the
        // authored hero pose the instant a fresh →CV switch is requested.
        if (reduceMotion && morphTargetRef.current === 1 && prevMorphTarget !== 1) {
          tYaw = 0; tPitch = 0; yaw = 0; pitch = 0; velYaw = 0; velPitch = 0;
        }
        prevMorphTarget = morphTargetRef.current;

        // HERO-RESOLVE: while the mountain is forming (forward →CV morph only, not yet landed),
        // unwind whatever orbit the globe was left at back to the authored rest pose (yaw=pitch=0
        // ⇒ ORBIT.azim/elev), so the massif always crystallizes into the byte-identical hero framing
        // and the survey lands facing the viewer. Resolved by ~mid-morph (well before the 0.80 survey
        // reveal); inertia killed so it lands clean. The instant it lands (mEase===1) this stops — so
        // the finished mountain orbits freely — and it never runs on the globe or the return Home.
        if (!reduceMotion && morphTargetRef.current === 1 && mEase < 1) {
          // fold any spun-up yaw to its nearest turn in (−π, π], shifting the DISPLAYED yaw by the
          // same multiple of 2π so the orientation never jumps — it then resolves the SHORT way (≤180°).
          const turns = Math.round(tYaw / TWO_PI);
          tYaw -= turns * TWO_PI;
          yaw -= turns * TWO_PI;
          const reso = smooth(0.04, 0.55, mc);
          tYaw *= 1 - reso;
          tPitch *= 1 - reso;
          velYaw *= 1 - reso;
          velPitch *= 1 - reso;
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
        // the dossier focus pans the massif RIGHT (wide screens only). The Projects dial pans the globe
        // LEFT on EVERY viewport (req 4: the fan shows on mobile too), a touch further on desktop, so its
        // right hemisphere faces the open space where the spokes fan.
        const dialPan = DIAL_PAN * pCam * (0.6 + 0.4 * wide);
        const focusShift = focusAmt * 0.42 * wide - dialPan;

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

        // a cinematic dolly: the globe sits whole in the middle of the frame, then the camera
        // flies in as it assembles, settling to the authored mountain framing exactly at mc = 1
        // (globeRadius → 1, so the end framing is untouched). The START radius is aspect-aware:
        // FOVY is vertical, so on a tall/narrow phone (aspect → 0.5) a landscape-tuned globe
        // overflows the width — pull the camera further back there so the ball fits comfortably.
        // mirrors the mountain's own zoomBase (radiusScale) aspect term. smooth(0,1,mc)=1 at mc=1
        // ⇒ mix01(globeStart, 1.0, 1) === 1.0 for ANY start, so the mountain dolly is byte-identical.
        const globeStart = 1.45 + 1.00 * smooth(1.0, 0.5, aspectNow); // ~1.45 wide … ~2.45 portrait — a bit BIGGER home globe (req 5)
        // the Projects dial leans the camera a touch closer (DIAL_ZOOM<1) to emphasise the globe's
        // right part; mix01(1, DIAL_ZOOM, 0) === 1 so the Home/CV framing is byte-identical at projAmt 0.
        const globeRadius = mix01(globeStart, 1.0, smooth(0.0, 0.70, mc)) * mix01(1.0, DIAL_ZOOM, pCam);
        const rscale = radiusScale * globeRadius;
        gpu.render({
          time: t,
          yaw,
          pitch,
          morph: mc,
          globeSpin: spinOut,
          motion: reduceMotion ? 0 : 1,
          hoverBand: landed ? shownBand : -1,
          hoverGlow: landed ? hoverGlow : 0,
          focusBand: landed ? focusBand : -1,
          focusAmt: landed ? focusAmt : 0,
          radiusScale: rscale,
          focusShift,
          focusShiftY,
          projAmt,
        });

        // bottom drag hint: shown only on the whole globe (mc≈0) and only until the first rotate
        // (invited). Loop-owned opacity, eased so it never pops; mc<0.05 fades it the instant the
        // morph starts. CSS owns only the resting look + the breathing drift (transform, not opacity).
        const hint = hintRef.current;
        if (hint) {
          const hintTarget = invited && mc < 0.05 && morphTargetRef.current === 0 ? 1 : 0;
          hintOpacity += (hintTarget - hintOpacity) * (reduceMotion ? 1 : 0.12);
          hint.style.opacity = hintOpacity < 0.002 ? "0" : hintOpacity.toFixed(3);
        }

        // the letter cloud projects through the EXACT camera the GPU just rendered with this
        // frame (same rscale / breathing), so the glyphs never drift off the ball. Shown
        // whenever the globe is at all present (mc < 1) — including while DISSOLVING back
        // from the mountain on a return Home — and dropped once the mountain is whole.
        const aspect = cvs.clientWidth / Math.max(cvs.clientHeight, 1);
        if (mc < 0.999) {
          const cam = ridgeCamera(yaw, pitch, aspect, t, rscale, focusShift, focusShiftY);
          // the chaotic letter-cloud is part of "the mess" — it fades out as the dial organises, so once
          // the dial is (nearly) fully open skip its ~128 per-glyph DOM writes entirely (req 6 perf).
          if (projAmt < 0.985) {
            // spinOut (idle + dial) so the cloud co-rotates with the GPU ball in BOTH phases
            updateCloud(cam.vp, cam.eye, spinOut, mc, cvs.clientWidth, cvs.clientHeight);
          }
          if (cloudRef.current) cloudRef.current.style.opacity = (1 - projAmt).toFixed(3);
          // weld the Projects dial spokes + labels to the SAME projected (panned) globe
          if (projAmt > 0.002)
            updateDial(cam.vp, cvs.clientWidth, cvs.clientHeight, projAmt, dialSelected, pDraw, pLabel);
        } else if (cloudRef.current && cloudRef.current.style.visibility !== "hidden") {
          cloudRef.current.style.visibility = "hidden"; // mountain is whole — drop the cloud
        }
        updateSurvey(yaw, pitch, t, dt, rscale, focusShift, focusShiftY, mc);
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

  const overlayOpen = selected !== null || assignmentOpen || projectsOpen;

  return (
    <div
      className={`ridge-stage${overlayOpen ? " is-overlay-open" : ""}${view === "home" ? " is-globe" : ""}`}
      id="home"
    >
      <canvas id="ridge" ref={canvasRef} />

      {/* the intro "ball of lines & letters" — the career record DECOMPOSED into individual
          characters scattered through the spinning globe's volume at every depth, co-rotated with
          the GPU filament lines and written imperatively from the rAF loop. As the mountain forms
          the glyphs rain onto their ring bands and fade. aria-hidden: the survey carries the
          readable copy once the mountain forms. */}
      <div className="ridge-cloud" ref={cloudRef} aria-hidden="true">
        <ul className="cloud-char-list">
          {CLOUD_CHARS.map((ch, k) => (
            <li className="cloud-char" key={`cc-${k}`}>{ch}</li>
          ))}
        </ul>
      </div>
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

      {/* bottom drag hint — a tracked small-caps cue flanked by two little curved arrows that hug the
          globe's lower limb, each arrowhead aligned TANGENT to its arc so it clearly reads as a
          left/right spin (req 1: heads rotated to the curve, no CSS mirror). Globe-only: opacity is
          driven from the rAF loop (1 while mc≈0 & still inviting, else 0) and retired by stopInviting on
          the first rotate. aria-hidden + pointer-events:none so a drag passes straight through to the
          canvas beneath. */}
      <div className="globe-hint" ref={hintRef} aria-hidden="true">
        <svg className="globe-hint-arrow" viewBox="0 0 26 14" fill="none" aria-hidden="true">
          <path d="M23 5 Q13 10 3 6" />
          <path d="M3 6 L5.6 9.7 M3 6 L7.4 5.1" />
        </svg>
        <span className="globe-hint-text">drag to rotate</span>
        <svg className="globe-hint-arrow" viewBox="0 0 26 14" fill="none" aria-hidden="true">
          <path d="M3 5 Q13 10 23 6" />
          <path d="M23 6 L20.4 9.7 M23 6 L18.6 5.1" />
        </svg>
      </div>

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

      {/* the Projects "Dial" — opened by the Projects nav link / #projects route. A
          transparent layer over the live globe: the spokes + labels are welded each
          frame by the rAF loop via dialDomRef; selecting routes through onDialSelect. */}
      <AnimatePresence>
        {projectsOpen && (
          <ProjectsOverlay
            key="projects-overlay"
            ref={projectsCloseBtnRef}
            onClose={closeProjects}
            domRef={dialDomRef}
            onSelect={onDialSelect}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
