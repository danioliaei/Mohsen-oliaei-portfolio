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
  globeFitRadiusScale,
  MORPH_DUR,
  CLOUD_CHARS,
  CHAR_CLOUD,
} from "../gpu/ridgeline";
import RoleOverlay from "./RoleOverlay";
import AssignmentOverlay from "./AssignmentOverlay";
import BookOverlay from "./BookOverlay";
import ProjectsOverlay, { type ProjectsDialDom, TL_PAD_FRAC } from "./ProjectsOverlay";
import type { PerfHandle } from "../perf/harness";
import type { SceneInfo } from "../perf/types";
import { STATIONS } from "../data/stations";
import { PROJECTS, formatMonthYearLong, decimalYear, timeFrac, TIMELINE_TICKS, SPLIT_YEAR } from "../data/projects";

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

// ---- Projects "Filament" line (see ProjectsOverlay) -----------------------------
// The Projects view CALMS the globe and collapses it onto a single horizontal GLOWING LINE — a
// warm, bloomed filament with light PULSES travelling along it — which the calmed globe rides as
// a luminous MOON. From that line the whole career STRAYS OUT: one organic, curving BRANCH per
// project, rooted on the line at its date (x), splaying up or down and gently floating, the more
// important (flagship) work reaching FURTHER. The points where branches leave the line are the
// BOLD nodes; a name floats at each tip. The moon then TRANSITS the line left↔right as you scrub;
// the branch under it is the selection. These constants drive the screen-space plot the rAF loop
// welds each frame (`updateTimeline`) + the moon's flight. The branches are desktop-only (mobile
// uses the list).
const DIAL_N = PROJECTS.length; // the project count (>= 1; DIAL_SLOT divides by it)
const DIAL_SLOT = TWO_PI / DIAL_N; // scrub step — `dialAngle` is reused as the (eased) scrub knob
const DIAL_MAX_ANGLE = (DIAL_N - 1) * DIAL_SLOT; // LINEAR clamp — a timeline doesn't wrap like the old dial
// per-project plot inputs, precomputed once: xFrac (0..1 along the date axis). The authored
// elevation (−0.4..1.0) drives the per-year peak height below; its envelope traces two massifs +
// a central valley (see projects.ts), so the year peaks read as a sinus skyline.
// 0..1 along the axis via the SHARED piecewise map (dense past + compressed future tail) — single
// source of truth with the year ruler, so lines + ticks always agree.
const TL_XFRAC = PROJECTS.map((p) => timeFrac(decimalYear(p.date)));

const TL_PAD = TL_PAD_FRAC; // left/right padding as a fraction of width (matches the year ruler)
const TL_BASE_Y = 0.55; // FALLBACK baseline height (fraction of H); the loop WELDS it to where the
// folding globe collapses (the projected globe centre), so the line lands on the glowing fold.

// ---- straight-line plot geometry (px unless noted). The WiFi-survey look: one vertical hairline
// per project, rooted at its TRUE date x (a small organic jitter added so the spacing reads like
// events at genuinely different times — req 5). Within a (year, direction) group the LATEST
// project's line is tallest and the earlier ones step DOWN by a row, so the tips form a staircase and
// each line's VERTICAL name (req 1) starts at a distinct height — keeping year-mates' names apart.
// Each year-peak traces the elevation envelope → a sinus skyline; the below-axis studies hang DOWN,
// and a faint MIRROR clone reflects everything below the baseline so the skyline continues (req 6).
const TL_STACK = 15; // px a line steps down per earlier project == one stacked label row
const TL_FLOOR = 18; // px shortest line in a group (keeps even the earliest readable)
const TL_PEAK_MIN = 0.05; // a year-peak's floor (fraction of H)
const TL_PEAK_RANGE = 0.3; // …+ this × the group's max |elevation| → the sinus envelope height
const TL_MAJOR_BONUS = 0.045; // a flagship-bearing year reaches a touch further (fraction of H)
const TL_TOP_MARGIN = 0.12; // up-lines never rise above this (× H) — the skyline cap below the header
// the names are HORIZONTAL in right-hand columns now (not vertical above the tips), so a tall up-tip
// only needs to clear the fixed header chrome (~86px) — this absolute reserve floors the tallest up-tip
// just below it on a short viewport (whichever is lower / further from the top: TL_TOP_MARGIN·H or this).
const TL_TOP_RESERVE_PX = 100;
const TL_BOT_MARGIN = 0.09; // down-lines never drop past (1 − this) × H — clear of the year ruler
const TL_DRAW_SPAN = 0.45; // draw clock span between the leftmost line rising and the rightmost
const TL_DRAW_RISE = 0.5; // how long each individual line takes to grow out (in the draw clock)
// the names are HORIZONTAL + LEFT-ALIGNED again: grouped into date CLUSTERS, each cluster's names
// share one left edge just to the RIGHT of the cluster's right-most line, so a horizontal name (far
// wider than the ~15px line spacing) never crosses a line in its own cluster (req 3). The line + tip
// nub + selection/hover highlight carry which name maps to which line.
const TL_LABEL_GAP = 12; // px from a cluster's right-most line to its left-aligned name column
const TL_CLUSTER_GAP = 0.016; // xFrac gap (~2.4 months) that starts a NEW cluster
const TL_CLUSTER_MAX = 4; // cap members so a long even run breaks into local groups ("a few lines")
const TL_JITTER = 0.006; // max |x jitter| as a fraction of the plot width (req 5 — organic spacing)
const TL_MOBILE_ZOOM = 3.2; // narrow: widen the plot MORE so the names read large; drag pans it (req 3)
const TL_PAN_MAX_VEL = 4200; // px/s — release-flick cap for the mobile pan
// desktop mouse-hover pick (req 2): a line + its name lights when the cursor is within TL_HOVER_X px of
// the line's x AND inside the line's vertical span (a small margin past the tip). Geometric (off the
// loop's hx/hy), so the thin paths need no pointer-events that would swallow the scrub drag. Mouse-only:
// hx/hy stay −1 on touch, so the highlight never sticks on a phone.
const TL_HOVER_X = 15;

// the HOVER FOCUS-LENS (req: hovering a cluster spreads the overlapping lines so the title reads, and
// the timeline locally "extends"). A push-lens centred on the cursor: within TL_LENS_R the line spacing
// MAGNIFIES; beyond it everything rigidly shifts outward by the width the lens added — so neighbours are
// PUSHED apart (and the right side eased into the future tail) rather than merely redistributed. Eased
// in/out by lensAmt so it never snaps.
const TL_LENS_R = 160;        // px — lens radius (a local "cluster"); or TL_LENS_R_FRAC·width if larger
const TL_LENS_R_FRAC = 0.12;  // fraction-of-plot-width floor for the radius on wide screens
const TL_LENS_PUSH = 0.6;     // peak one-side push as a fraction of R (centre line-spacing ≈ ×1.9)
const TL_LENS_DIM = 0.5;      // far lines/names recede to (1 − this) under the lens → the focus reads "forward"

// the names sit to the RIGHT of the lines again (req 2/3), so the date axis can't run to the right
// edge or the latest cluster's column would clip off-screen. Reserve a right gutter sized to the
// widest name (+ the column gap), and map the lines / ruler across the remaining span. The reserve
// is also capped to a fraction of W and the span floored at 1px so the math stays POSITIVE on a
// pathologically narrow viewport (the baseline horizon — the .tl-axis — is drawn across the full
// padded width, independent of this gutter).
const tlLabelReserve = (W: number) =>
  Math.min(180, W * 0.4, Math.max(100, W * (1 - 2 * TL_PAD) * 0.14));
const tlAxisSpan = (W: number) =>
  Math.max(1, W * (1 - TL_PAD) - tlLabelReserve(W) - TL_LABEL_GAP);

// the year ticks (the SHARED TIMELINE_TICKS — dense past + sparse future milestones) as 0..1
// fractions via the same piecewise map — the rAF loop positions the ruler from these each frame so
// it tracks the mobile zoom + pan, and they always line up with the project x-placement above.
const TL_YEAR_FRAC = TIMELINE_TICKS.map((y) => timeFrac(y));
// the "now" SPLIT as a 0..1 fraction (where the dense past hands off to the future tail) — drives the
// now-marker + the solid/dashed baseline handoff.
const TL_SPLIT_FRAC = timeFrac(SPLIT_YEAR);

// a deterministic ±TL_JITTER hash per project index (no Math.random → stable across reloads/SSR)
const tlJitter = (i: number) => {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return ((s - Math.floor(s)) * 2 - 1) * TL_JITTER;
};
// the jittered TRUE-date x for every project (0..1 along the axis)
const TL_XFRAC_J = PROJECTS.map((_, i) => TL_XFRAC[i] + tlJitter(i));

// per-project plot inputs, precomputed once (W/H-independent fractions). For each project: its
// jittered true-date x, up/down direction (below-axis studies go DOWN), and — within its (year,
// direction) sub-group ordered by date — its stack rank, the group size, whether the group carries
// flagship work, and the group's max |elevation| (the envelope driver).
type TlPlot = {
  xFrac: number;
  down: boolean;
  stackRank: number;
  groupCount: number;
  groupMajor: boolean;
  groupMaxAbs: number;
};
const TL_PLOT: TlPlot[] = (() => {
  const out: TlPlot[] = new Array(PROJECTS.length);
  // PROJECTS is pre-sorted oldest→newest, so each year's index list (and each sub-group) is in
  // date order — the last entry in a (year, direction) group is that year's latest.
  const byYear = new Map<number, number[]>();
  PROJECTS.forEach((p, i) => {
    const y = Number(p.date.slice(0, 4));
    const arr = byYear.get(y);
    if (arr) arr.push(i);
    else byYear.set(y, [i]);
  });
  for (const idxs of byYear.values()) {
    const sub: Record<"up" | "down", number[]> = { up: [], down: [] };
    for (const i of idxs) sub[PROJECTS[i].elevation < 0 ? "down" : "up"].push(i);
    for (const dir of ["up", "down"] as const) {
      const g = sub[dir];
      const groupMaxAbs = g.reduce((m, i) => Math.max(m, Math.abs(PROJECTS[i].elevation)), 0.18);
      const groupMajor = g.some((i) => PROJECTS[i].major);
      g.forEach((i, rank) => {
        out[i] = {
          xFrac: TL_XFRAC_J[i],
          down: dir === "down",
          stackRank: rank,
          groupCount: g.length,
          groupMajor,
          groupMaxAbs,
        };
      });
    }
  }
  return out;
})();

// DATE CLUSTERS for the name columns (req 3). Walk the projects in date order and break a new cluster
// on a big enough x-gap OR once a cluster is full — so near-in-time lines group together and a long,
// evenly-spaced run still splits into local groups of "a few lines". Every cluster's names then share
// one left edge just past the cluster's right-most line, so no name crosses a clustered line.
const TL_CLUSTERS: number[][] = (() => {
  const order = PROJECTS.map((_, i) => i).sort((a, b) => TL_XFRAC_J[a] - TL_XFRAC_J[b]);
  const clusters: number[][] = [];
  let cur: number[] = [];
  let prevX = -Infinity;
  for (const i of order) {
    const x = TL_XFRAC_J[i];
    if (cur.length && (x - prevX > TL_CLUSTER_GAP || cur.length >= TL_CLUSTER_MAX)) {
      clusters.push(cur);
      cur = [];
    }
    cur.push(i);
    prevX = x;
  }
  if (cur.length) clusters.push(cur);
  return clusters;
})();
// per-project: the right-most jittered date-x in its cluster — the line the name column left-aligns past
const TL_CLUSTER_MAXX = new Array<number>(PROJECTS.length);
for (const c of TL_CLUSTERS) {
  const maxX = c.reduce((m, i) => Math.max(m, TL_XFRAC_J[i]), 0);
  for (const i of c) TL_CLUSTER_MAXX[i] = maxX;
}

const DIAL_SENS = 1.7; // rad of scrub per canvas-height of horizontal drag
const DIAL_SMOOTH_TAU = 0.16; // s — ease displayed scrub → target (a weighty glide)
const DIAL_INERTIA_TAU = 0.6; // s — release-flick decay
const DIAL_MAX_VEL = 3.4; // rad/s — inertia cap
const DIAL_SNAP_VEL = 0.06; // rad/s — below this (and not dragging) settle to the nearest project
const DIAL_SNAP_TAU = 0.18; // s — detent settle ease
const PROJ_OPEN_TAU = 0.36; // s — projAmt 0→1
const PROJ_CLOSE_TAU = 0.24; // s — projAmt 1→0
const LENS_TAU = 0.15; // s — hover focus-lens spread ease in/out (gentle, never snaps)

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// the header control to hand focus back to when a flat overlay (Projects / Book me) closes
// and nothing else meaningful held it. On phones that's the hamburger "Menu"; on DESKTOP —
// where the hamburger is display:none and the inline nav shows instead (req 1) — it's the
// first nav link, falling through to the wordmark. The offsetParent guard skips a
// display:none candidate (its offsetParent is null) so .focus() always lands on something
// actually visible at the current breakpoint, rather than a no-op on a hidden button.
const headerFallbackTarget = (): HTMLElement | null => {
  if (typeof document === "undefined") return null;
  for (const sel of ["header .menu-btn", "header .header-nav a", "header .wordmark"]) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
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
  // hovering a NAME (in its far-right column) lights its line + nub + name (req 3): the overlay's
  // label buttons route the mouse-enter/leave through dialHoverRef into the loop's hover state, so the
  // relation between a far-right name and its line is discoverable, not just on selection.
  const dialHoverRef = useRef<(i: number) => void>(() => {});
  const onDialHover = useCallback((i: number) => dialHoverRef.current(i), []);

  // ---- "Book me" session menu overlay --------------------------------------
  // A fourth focused surface, a flat sibling of the assignment brief: the "Book me"
  // nav link / #book route opens the liquid-glass session cards OVER whichever scene
  // (globe or mountain) is live — no morph change. `bookOpenRef` is the value the rAF
  // loop reads each frame to quiet the scene/beacon behind it; `closeBookRef` is the
  // stable handle the once-registered window keydown listener reaches the close setter
  // through (same indirection as closeProjectsRef).
  const [bookOpen, setBookOpen] = useState(false);
  const bookOpenRef = useRef(false);
  const closeBookRef = useRef<() => void>(() => {});
  const bookCloseBtnRef = useRef<HTMLButtonElement>(null);
  const bookLastFocusRef = useRef<HTMLElement | null>(null);
  const bookWasOpenRef = useRef(false);

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

  const openBook = useCallback(() => {
    // book is a flat overlay over whatever scene is live (like the assignment brief),
    // so it never touches the morph. Drop focus off the beacon first (same defensiveness
    // as openProjects) so it never sits inside an aria-hidden subtree once book commits.
    beaconRef.current?.blur();
    bookOpenRef.current = true;
    setBookOpen(true);
  }, []);
  const closeBook = useCallback(() => {
    bookOpenRef.current = false;
    setBookOpen(false);
    // restore the route to whatever scene sits behind the cards (globe or mountain)
    if (typeof location !== "undefined" && location.hash === "#book") {
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
  // syncHash defaults true (an explicit navigation OWNS the URL). The in-canvas globe TAP passes
  // false so a casual tap grows the mountain WITHOUT persisting #cv — that way a reload returns to
  // the clean globe landing instead of re-opening straight on the CV. Genuine deep-links (the header
  // CV/Home links, or a typed/shared #cv) still flow through the hash, so they stay addressable and
  // browser back/forward stays authoritative.
  const navTo = useCallback(
    (v: "home" | "cv", syncHash = true) => {
      morphTargetRef.current = v === "cv" ? 1 : 0;
      setViewState(v);
      if (v === "home") {
        select(null);
        closeAssignment();
      }
      if (syncHash) {
        const hash = v === "cv" ? "#cv" : "#home";
        if (typeof location !== "undefined" && location.hash !== hash) {
          // replaceState (not location.hash =) so we don't re-fire our own hashchange listener
          history.replaceState(null, "", hash);
        }
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
    closeBookRef.current = closeBook;
    navToRef.current = navTo;
  });

  // hash routing: the header's Home/CV/Projects/Book me links (and the browser back/forward
  // button) drive the view through the URL hash. #cv assembles the mountain, #home returns to
  // the globe, #projects opens the timeline and #book the session menu OVER whichever scene is
  // live. A #cv / #projects / #book deep-link on mount lands straight on it; an empty hash stays
  // the clean globe landing. The two flat overlays (#projects, #book) are mutually exclusive —
  // switching between them (or to #cv/#home) closes the other. Other hashes (#about/#contact)
  // are left untouched here.
  useEffect(() => {
    if (location.hash === "#cv") {
      morphTargetRef.current = 1;
      setViewState("cv");
    } else if (location.hash === "#projects") {
      projectsOpenRef.current = true;
      setProjectsOpen(true);
    } else if (location.hash === "#book") {
      bookOpenRef.current = true;
      setBookOpen(true);
    }
    const onHash = () => {
      const h = location.hash;
      if (h === "#projects") {
        closeBook();
        closeAssignment();
        openProjects();
      } else if (h === "#book") {
        closeProjects();
        closeAssignment();
        openBook();
      } else if (h === "#cv") {
        closeBook();
        closeProjects();
        navTo("cv");
      } else if (h === "#home" || h === "") {
        closeBook();
        closeProjects();
        navTo("home");
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [navTo, openProjects, closeProjects, openBook, closeBook, closeAssignment]);

  // the wordmark + the header "Home" link fire a `site:home` event (req 4). A plain href="#home"
  // can't be trusted here: an in-canvas globe TAP grows the mountain WITHOUT persisting #cv (so a
  // reload stays on the clean globe — see navTo's syncHash note), which leaves the URL on #home while
  // the CV is showing; clicking a #home link then changes no hash, fires no hashchange, and the
  // mountain would never dissolve. This explicit, idempotent handler always returns Home — closing any
  // open overlay and easing the morph back to the globe — regardless of the current hash.
  useEffect(() => {
    const goHome = () => {
      closeBook();
      closeProjects();
      closeAssignment();
      navTo("home");
    };
    window.addEventListener("site:home", goHome);
    return () => window.removeEventListener("site:home", goHome);
  }, [navTo, closeProjects, closeBook, closeAssignment]);

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

  // the same focus dance for the Projects timeline: remember what held focus, move focus
  // to its close control on open, restore on close — falling back to a VISIBLE header
  // control (the hamburger on phones, the inline nav on desktop) when nothing meaningful
  // held it. (See headerFallbackTarget: the old fallback hard-coded the Menu button, which
  // is now display:none on desktop and would make .focus() a no-op there.)
  useEffect(() => {
    if (projectsOpen) {
      projectsLastFocusRef.current = document.activeElement as HTMLElement | null;
      projectsCloseBtnRef.current?.focus();
      projectsWasOpenRef.current = true;
    } else if (projectsWasOpenRef.current) {
      projectsWasOpenRef.current = false;
      const prev = projectsLastFocusRef.current;
      (prev && prev !== document.body ? prev : headerFallbackTarget())?.focus?.();
    }
  }, [projectsOpen]);

  // the same focus dance for the "Book me" session menu: remember what held focus, move
  // focus to its close control on open, restore on close — falling back to a visible header
  // control (see the Projects effect note above) when nothing held it.
  useEffect(() => {
    if (bookOpen) {
      bookLastFocusRef.current = document.activeElement as HTMLElement | null;
      bookCloseBtnRef.current?.focus();
      bookWasOpenRef.current = true;
    } else if (bookWasOpenRef.current) {
      bookWasOpenRef.current = false;
      const prev = bookLastFocusRef.current;
      (prev && prev !== document.body ? prev : headerFallbackTarget())?.focus?.();
    }
  }, [bookOpen]);

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;

    let disposed = false;
    const teardown: Array<() => void> = [];

    (async () => {
      // ---- ?perf=1 on-device telemetry harness (hoisted above scene creation). It is
      // started in BOTH outcomes so the HUD also appears when WebGPU FAILS — the
      // secure-context trap the task warns about: over plain http://<lan-ip>,
      // navigator.gpu is undefined, the scene never initialises, and the HUD must still
      // scream "❌ NO WEBGPU / ⚠ INSECURE CTX" so the operator fixes the HTTPS tunnel
      // instead of trusting a void run.
      //
      // A plain `vite build` dead-code-eliminates the whole block (and the dynamic
      // import): `import.meta.env.DEV` folds to `false` in prod, and `=== "1"` folds the
      // VITE_PERF term to `false` — the `&&` short-circuits and esbuild drops it. These
      // comparisons are load-bearing for that fold; do NOT loosen them (=== not ==).
      let perf: PerfHandle | null = null;
      const perfEnabled =
        (import.meta.env.DEV || import.meta.env.VITE_PERF === "1") &&
        typeof location !== "undefined" &&
        new URLSearchParams(location.search).has("perf");
      const startHarness = async (
        getSceneInfo: () => SceneInfo | null,
        sceneFailed = false,
      ) => {
        if (!perfEnabled || perf) return;
        const { startPerf } = await import("../perf/harness");
        if (disposed) return;
        perf = startPerf({ getSceneInfo, sceneFailed });
        teardown.push(() => perf?.stop());
      };

      const gpu = await RidgelineScene.create(cvs);
      if (disposed) {
        gpu?.dispose();
        return;
      }
      if (!gpu || !gpu.attach()) {
        gpu?.dispose();
        setUnsupported(true);
        await startHarness(() => null, true); // WebGPU unavailable/failed — HUD still diagnoses it
        return;
      }
      teardown.push(() => gpu.dispose());

      const resize = () => {
        // Phone profile: render at a HIGHER DPR (2.5 vs 2) for sharper hairlines — the
        // lighter terrain mesh + thinner globe + wider contour spacing (see ridgeline.ts
        // PHONE_* profile) pay back the fill budget. Desktop keeps the 2× cap.
        const phone =
          matchMedia("(pointer: coarse)").matches || matchMedia("(max-width: 860px)").matches;
        const dpr = Math.min(window.devicePixelRatio || 1, phone ? 2.5 : 2);
        gpu.resize(cvs.clientWidth, cvs.clientHeight, dpr);
      };
      resize();
      window.addEventListener("resize", resize);
      teardown.push(() => window.removeEventListener("resize", resize));

      // start the telemetry harness for the LIVE scene (see the hoisted helper above). It
      // piggybacks on this component's rAF — one perf.frame(now) call in the loop below —
      // so it measures the exact render cadence with no second animation loop.
      await startHarness(() => gpu.info());
      // unmounted during the harness dynamic import? cleanup already ran gpu.dispose() —
      // bail before registering listeners or the rAF loop on a disposed scene (mirrors
      // the post-create() guard above). Only reachable on the ?perf=1 import path.
      if (disposed) return;

      // Dynamic resolution scaling holds a steady 60fps by shrinking the internal render-scale only
      // under sustained load (full quality with headroom). Pin it OFF under ?perf so the harness
      // measures a stationary worst-case fill rather than a moving target.
      gpu.setDrsEnabled(!perfEnabled);

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

      // ---- ONE-SHOT mountain reveal (req 1): the contour-model → realistic sweep used to ping-pong
      // forever in the shader (cos(time)), so the finished mountain kept flickering between the two
      // looks. revealClock is a monotonic 0→1 progress this loop advances EXACTLY ONCE, after the
      // massif lands, then latches at 1 — so the seam sweeps a single time and the detailed render
      // stays put. It is shaped (smootherstep) into `reveal` (lod.w) each frame for a graceful sweep.
      const REVEAL_DUR = 4.0;   // s — the one-time contour→realistic sweep
      let revealClock = 0;      // 0 = contour model … 1 = fully revealed (latched; never decreases)

      // ---- Projects "Transit" loop state (shared by the frame + the projects-mode pointer/key
      // handlers + updateTimeline, all in this one closure). projAmt eases the whole timeline in/out;
      // dialAngle is the eased displayed scrub position (tDialAngle its target); selecting reads the
      // project nearest the scrub detent. The globe's idle spin fades out as projAmt rises and the
      // scrub drives a gentle roll instead, so the moon turns as it travels the range.
      let projAmt = 0;            // 0 = no timeline … 1 = fully open (globe calmed → moon, trace plotted)
      // opens settled on the LATEST project (2026); the moon sweeps IN from the left across the
      // whole range to land there (see the entry sweep in the frame loop).
      let dialAngle = DIAL_MAX_ANGLE;  // eased displayed scrub position (rad; 0 = first project … DIAL_MAX_ANGLE = last)
      let tDialAngle = DIAL_MAX_ANGLE; // target scrub the drag/keys/snap steer (clamped 0..DIAL_MAX_ANGLE)
      let velDial = 0;            // rad/s — release-flick inertia
      let dialSelected = 0;       // project index nearest the scrub detent
      let dialPrevSelected = -1;  // last frame's selection (roving tabindex / announce on change)
      let dialDragging = false;
      let dialStartAngle = 0, dialStartX = 0; // drag anchor
      let dialLastNotch = 0;      // detent-tick bookkeeping during a drag
      // MOBILE PAN (req 7): on a narrow screen the timeline is zoomed wider than the viewport and a
      // drag scrolls it left/right (instead of the desktop scrub). panX is the eased px offset.
      let panX = 0, tPanX = 0, panVel = 0;
      let panDragging = false, panStartX = 0, panStartOff = 0;
      let panFollowSel = -1; // last selection the pan auto-scrolled to (-1 ⇒ next open jumps to it)
      let panMoved = false;  // a pan drag travelled past the click slop → swallow the trailing click
      let panLastSel = -1;   // the project a mobile drag last highlighted (haptic ticks on change, req 3)
      let tlHover = -1;      // the project a desktop mouse hover currently lights (req 2), or −1
      let nameHover = -1;    // a project whose NAME button the mouse is over (req 3) — overrides the
                             // geometric line pick so hovering a far-right name lights its own line
      let lensAmt = 0;       // eased focus-lens strength 0..1 — the hover spread that parts overlapping
                             // lines so the title reads + the timeline locally "extends" (desktop only)
      let lensFocusX = -1;   // lens centre in canvas px; tracks the cursor, held while easing out
      let tlLastSig = "";    // settle-gate: last frame's geometry signature, so the ~130-line rewrite is
                             // skipped on an idle, settled, un-hovered timeline (cheap when nothing moves)
      // per-project SETTLED tip y, stashed by the geometry loop so the name-column pass can de-collide
      // names off a STABLE height (not the one still animating in during the draw-on).
      const tlTipY = new Float64Array(DIAL_N);
      const dialMobile = () =>    // narrow → the timeline zooms + pans (req 7) instead of scrubbing
        typeof matchMedia === "function" && matchMedia("(max-width: 860px)").matches;
      // the most-negative pan offset for the current width (panMin..0); 0 on desktop (zoom 1 ⇒ no pan)
      const tlPanMin = (W: number) => tlAxisSpan(W) * (1 - TL_MOBILE_ZOOM);
      // glide the moon to project i — LINEAR (clamped to the range; a timeline never wraps)
      const dialGoto = (i: number) => {
        tDialAngle = Math.min(DIAL_MAX_ANGLE, Math.max(0, i * DIAL_SLOT));
        velDial = 0;
        stopInviting();
      };
      dialGotoRef.current = dialGoto;
      // the overlay's label buttons set which NAME the mouse is over (or −1 on leave); the loop reads
      // it as a hover override so a far-right name lights its own line + nub (req 3).
      dialHoverRef.current = (i: number) => { nameHover = i; };

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
      // The Y-rotation that welds a letter to the spinning lines (lon += globeSpin) is inlined in
      // updateCloud's hot loop with the per-frame sin/cos(spin) hoisted out (rx = dx·c + dz·s, ry =
      // dy, rz = −dx·s + dz·c). The station ring anchors a glyph rains toward are LOOP-INVARIANT, so
      // precompute the seven world points once and project them ONCE per frame (not per glyph) into
      // the reused scratch below — turning up to ~128 ringAnchor()+projectToScreen() object allocs
      // per frame into seven inline scalar projections.
      const stationAnchors = STATIONS.map((s) => ringAnchor(s.radius));
      const tpx = new Float32Array(STATIONS.length);
      const tpy = new Float32Array(STATIONS.length);
      const tpVis = new Uint8Array(STATIONS.length);

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
        // PROJECTS: a drag never orbits. On MOBILE it PANS the zoomed timeline (req 7); on desktop
        // it spins the knob (scrolls the project selection).
        if (projectsOpenRef.current) {
          if (dialMobile()) {
            panDragging = true;
            panMoved = false;
            panLastSel = -1; // each drag's highlight ratchet starts fresh
            pid = e.pointerId;
            panStartOff = tPanX;
            panStartX = e.clientX;
            lastT = e.timeStamp;
            panVel = 0;
            stopInviting();
            try { cvs.setPointerCapture(pid); } catch { /* capture optional */ }
            cvs.style.cursor = "grabbing";
            haptic(10, e.timeStamp);
            e.preventDefault();
            return;
          }
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
        // PROJECTS MOBILE drag → pan the zoomed timeline left/right (req 7)
        if (projectsOpenRef.current && panDragging && e.pointerId === pid) {
          const ddt = Math.min(Math.max((e.timeStamp - lastT) / 1000, 1 / 240), 1 / 30);
          lastT = e.timeStamp;
          const panMin = tlPanMin(cvs.clientWidth);
          const prev = tPanX;
          // drag right → reveal EARLIER work (offset toward 0); clamped to [panMin, 0]
          tPanX = Math.min(0, Math.max(panMin, panStartOff + (e.clientX - panStartX)));
          panVel = Math.max(
            -TL_PAN_MAX_VEL,
            Math.min(TL_PAN_MAX_VEL, panVel * 0.5 + ((tPanX - prev) / ddt) * 0.5),
          );
          // a pan that travels past the click slop must swallow the trailing click, so a drag that
          // STARTED on a name label doesn't also fire that label's onSelect (see onPanDownCapture).
          if (Math.abs(e.clientX - panStartX) > CLICK_SLOP) panMoved = true;
          // HIGHLIGHT WHILE DRAGGING (req 3): once the press is an actual drag (past the slop — so a
          // genuine TAP never enters this path and never fires a stray haptic / wrong-selection flick),
          // select the project nearest screen-centre and tick a haptic when it changes, so dragging
          // feels like ratcheting through the work, each one lighting up under the thumb. The selection
          // drives the same is-selected emphasis (line + nub + name). The follow-pan block is skipped
          // while panDragging, so setting the scrub here never fights the drag.
          if (panMoved) {
            const W = cvs.clientWidth;
            const padPx = TL_PAD * W;
            const plotW = tlAxisSpan(W) * TL_MOBILE_ZOOM;
            const centreFrac = (W * 0.5 - tPanX - padPx) / plotW; // the date-fraction under screen centre
            let best = 0, bestD = Infinity;
            for (let i = 0; i < DIAL_N; i++) {
              const d = Math.abs(TL_XFRAC_J[i] - centreFrac);
              if (d < bestD) { bestD = d; best = i; }
            }
            if (best !== panLastSel) { panLastSel = best; haptic(7, e.timeStamp); }
            tDialAngle = best * DIAL_SLOT; // drive the selection (mobile has no scrub knob)
            velDial = 0;
          }
          e.preventDefault();
          return;
        }
        // PROJECTS DIAL drag → spin the knob (the globe + the fan follow dialAngle)
        if (projectsOpenRef.current && dialDragging && e.pointerId === pid) {
          const ddt = Math.min(Math.max((e.timeStamp - lastT) / 1000, 1 / 240), 1 / 30);
          lastT = e.timeStamp;
          const rot = ((2 * Math.PI) / Math.max(cvs.clientHeight, 1)) * DIAL_SENS;
          const prev = tDialAngle;
          // drag right → moon glides to a LATER project; clamped to the linear range (no wrap)
          tDialAngle = Math.min(
            DIAL_MAX_ANGLE,
            Math.max(0, dialStartAngle + (e.clientX - dialStartX) * rot),
          );
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
        // PROJECTS MOBILE pan release — the pan drifts to rest on the frame loop's inertia
        if (panDragging && e.pointerId === pid) {
          panDragging = false;
          pid = -1;
          try { cvs.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
          cvs.style.cursor = "grab";
          e.preventDefault();
          return;
        }
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

        // a CANCELLED pointer is NEVER a deliberate tap: the browser fires pointercancel when it
        // claims the gesture for a scroll/pinch, the touch is interrupted, or the window loses the
        // pointer — and the very FIRST touch landing on the canvas is often cancelled this way. Bail
        // here (after the drag-state cleanup above) so a cancel can't reach the click test and
        // auto-assemble the mountain. This was the "the site opens straight into the CV by itself on
        // first visit" bug; a real tap still arrives as pointerup and navigates as intended.
        if (e.type === "pointercancel") return;

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
          if (mEase < 0.985) { navToRef.current("cv", false); return; }
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
        // Escape dismisses an open surface before any orbit handling — the "Book me"
        // menu first, then the Projects timeline, then the summit brief, then a focused
        // career slice
        if (e.key === "Escape" && bookOpenRef.current) {
          closeBookRef.current();
          e.preventDefault();
          return;
        }
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
          if (e.key === "ArrowUp" || e.key === "ArrowLeft")
            tDialAngle = Math.max(0, tDialAngle - DIAL_SLOT);
          else if (e.key === "ArrowDown" || e.key === "ArrowRight")
            tDialAngle = Math.min(DIAL_MAX_ANGLE, tDialAngle + DIAL_SLOT);
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

      // MOBILE PAN from the name labels (req 7): onDown only sees EMPTY-space presses (it's on the
      // canvas; the labels sit above it with their own hit area). So a drag that starts ON a name
      // would be swallowed as a tap and never pan. This capture-phase listener catches those
      // label-originated presses (target ≠ canvas) and arms the same pan — strictly gated to the
      // mobile Projects view, so it's inert everywhere else. Empty-space presses still go to onDown
      // (we skip target === cvs here to avoid double-arming). The trailing click is swallowed below
      // only if the press actually became a drag, so a genuine TAP still selects.
      const onPanDownCapture = (e: PointerEvent) => {
        if (!projectsOpenRef.current || !dialMobile()) return;
        if (e.target === cvs || panDragging || dialDragging) return;
        if (e.pointerType === "mouse" && e.button !== 0) return;
        panDragging = true;
        panMoved = false;
        panLastSel = -1; // each drag's highlight ratchet starts fresh
        pid = e.pointerId;
        panStartOff = tPanX;
        panStartX = e.clientX;
        lastT = e.timeStamp;
        panVel = 0;
        stopInviting();
        try { cvs.setPointerCapture(pid); } catch { /* capture optional */ }
        // don't preventDefault: a genuine tap must still reach the label's click to select.
      };
      // swallow the click that trails a label-originated pan drag (so the pan doesn't also select)
      const onPanClickCapture = (e: MouseEvent) => {
        if (panMoved) { panMoved = false; e.stopPropagation(); e.preventDefault(); }
      };

      cvs.addEventListener("pointerdown", onDown);
      window.addEventListener("pointerdown", onPanDownCapture, true);
      window.addEventListener("click", onPanClickCapture, true);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointermove", onHover);
      window.addEventListener("pointerout", onHoverOut);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("keydown", onKey);
      teardown.push(() => {
        cvs.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointerdown", onPanDownCapture, true);
        window.removeEventListener("click", onPanClickCapture, true);
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
          if (leaderEls) leaderEls.forEach((el) => { el.style.opacity = "0"; });
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
          projectsOpenRef.current ||
          bookOpenRef.current;
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
            projectsOpenRef.current ||
            bookOpenRef.current;
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
        eye: Float32Array,
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
        // per-frame hoists: the globe spin's sin/cos (the inlined rotY) and the seven ring anchors
        // projected ONCE (each glyph rains toward one of these — identical math to projectToScreen).
        const ss = Math.sin(spin), cs = Math.cos(spin);
        if (fall > 0.001) {
          for (let k = 0; k < stationAnchors.length; k++) {
            const a = stationAnchors[k];
            const acw = vp[3] * a.x + vp[7] * a.y + vp[11] * a.z + vp[15];
            if (acw <= 1e-6) { tpVis[k] = 0; continue; }
            const acx = vp[0] * a.x + vp[4] * a.y + vp[8] * a.z + vp[12];
            const acy = vp[1] * a.x + vp[5] * a.y + vp[9] * a.z + vp[13];
            tpx[k] = ((acx / acw) * 0.5 + 0.5) * W;
            tpy[k] = (1 - ((acy / acw) * 0.5 + 0.5)) * H;
            tpVis[k] = 1;
          }
        }
        for (let i = 0; i < charEls.length; i++) {
          const el = charEls[i];
          // trimmed on a narrow flank / reduced motion → drop the layer entirely (not just opacity 0)
          if (i >= charCount) { el.style.display = "none"; continue; }
          if (charVis <= 0.002) { el.style.opacity = "0"; continue; }
          const cr = charRadii[i];
          // inlined rotY (Y-rotation by `spin`, sin/cos hoisted): rx = dx·c + dz·s, ry = dy, rz = −dx·s + dz·c
          const bx = charDirs[i * 3], by = charDirs[i * 3 + 1], bz = charDirs[i * 3 + 2];
          const rx = bx * cs + bz * ss, ry = by, rz = -bx * ss + bz * cs;
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
          // rain toward this char's ring anchor (projected once above; the same anchors the survey uses)
          if (fall > 0.001) {
            const k = charRings[i];
            if (tpVis[k]) { sx += (tpx[k] - sx) * fall; sy += (tpy[k] - sy) * fall; }
          }
          const scale = 0.55 + 0.62 * depth * (0.6 + 0.4 * cr);
          el.style.transform =
            `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
          el.style.opacity = op.toFixed(3);
        }
      };

      // ---- Projects SURVEY-LINE welder: lay the career out in pure screen space — a minimal mono
      // baseline (the fixed horizon) and one STRAIGHT vertical line per project, rooted at its TRUE
      // date x with a small organic jitter so the spacing reads like events at different times (req
      // 5). Within a (year, direction) group the latest project's line is tallest and the earlier
      // ones step DOWN by one row; year peaks trace the elevation envelope (a sinus skyline) and the
      // below-axis studies hang DOWN. A glowing NUB sits at each line's foot (close nubs blend into a
      // bigger glow — req 3) and a small nub caps each tip (req 1); each project's name runs VERTICAL
      // along its OWN line, anchored beyond the tip and reading away from the baseline (req 1), and a
      // faint MIRROR clone reflects everything below the baseline so the skyline continues (req 6).
      // Everything is the SAME mono off-white as the globe filaments (req 2); the selected line + nub
      // brighten and the selected name lights amber; a mouse hover blooms the line + name (req 2).
      // On MOBILE the plot is zoomed wider than the viewport and `panX` scrolls it (req 7). `baseY`
      // is welded by the frame loop to the projected globe centre, so the plot lands exactly where
      // the globe folds. Imperative DOM writes only — nothing re-renders React.
      const updateTimeline = (
        W: number,
        H: number,
        amt: number,
        sel: number,
        pDraw: number,
        pLabel: number,
        baseY: number,
        panX: number,
        mobile: boolean,
      ) => {
        const dom = dialDomRef.current;
        if (!dom) return;
        // share the live baseline with CSS (the year ruler sits just below it via --tl-base)
        if (dom.root) dom.root.style.setProperty("--tl-base", `${baseY.toFixed(1)}px`);

        const { branches, labels, nubs, tips, axis } = dom;
        // ---- settle-gate: a quantised signature of everything that can MOVE a line this frame. When it
        // matches last frame (idle, settled, mouse still) the ~130-line geometry rewrite is skipped —
        // the DOM already holds the right positions. Quantised so projAmt's asymptotic creep toward 1
        // still settles to a stable key. (The selection-change tail below self-guards on its own.)
        const qd = (v: number, p: number) => Math.round(v * p);
        const sig =
          `${qd(amt, 1e3)},${qd(pDraw, 1e3)},${qd(pLabel, 1e3)},${qd(panX, 2)},${qd(baseY, 2)},` +
          `${W},${H},${sel},${qd(lensAmt, 1e3)},${qd(lensFocusX, 1)},${qd(hx, 1)},${qd(hy, 1)},${nameHover}`;
        const dirty = sig !== tlLastSig;
        tlLastSig = sig;
        if (dirty && branches.length === DIAL_N) {
          // desktop mouse hover is a geometric pick off the loop's hx/hy (no pointer-events on the
          // thin paths, which would eat the scrub drag). Track the nearest line/name under the cursor
          // as we lay each branch out, then apply the is-hover emphasis once after the loop (req 2).
          // Gated to a SETTLED timeline (amt > 0.9, draw-on done) so the hovered line's drop-shadow
          // isn't re-rasterised each frame while the geometry `d` is still growing.
          const hoverOn = !mobile && hx >= 0 && !dialDragging && amt > 0.9;
          let hoverBest = -1, hoverBestD = TL_HOVER_X;
          const padPx = TL_PAD * W;
          const viewW = W - 2 * padPx; // the baseline horizon width (full minus both pads)
          const zoom = mobile ? TL_MOBILE_ZOOM : 1; // mobile widens the plot so names aren't tiny
          // the date axis maps across axisSpan (≤ viewW): it stops short of the right edge so the
          // latest cluster's name column (which sits to the RIGHT of its lines, req 3) stays on-screen.
          // On mobile it's widened by the zoom.
          const plotW = tlAxisSpan(W) * zoom; // the virtual (possibly off-screen) date axis width
          const pan = mobile ? panX : 0; // desktop never pans
          const baseYs = baseY.toFixed(1);
          // vertical room each direction (kept clear of the top edge / the year ruler). Up-lines floor
          // their tip at max(TL_TOP_MARGIN·H, TL_TOP_RESERVE_PX) from the top so the tallest tip clears
          // the header even on a short viewport; never below TL_FLOOR so the math stays valid.
          const upRoom = Math.max(TL_FLOOR, baseY - Math.max(TL_TOP_MARGIN * H, TL_TOP_RESERVE_PX));
          const downRoom = (1 - TL_BOT_MARGIN) * H - baseY;

          // ---- the hover FOCUS-LENS warp (a push-lens). Identity at rest and at the focus centre, so
          // the line under the cursor stays put while its neighbours are PUSHED apart and the right side
          // eases into the future tail — the timeline "extends" locally so an overlapping title reads
          // (req). Only the data lines + their names warp; the baseline, ruler and now-marker stay put as
          // a calm reference.
          const lensOn = lensAmt > 0.001 && lensFocusX >= 0 && !mobile;
          const lensR = Math.max(TL_LENS_R, viewW * TL_LENS_R_FRAC);
          const lensExtra = lensAmt * lensR * TL_LENS_PUSH;
          const warpX = (x: number): number => {
            if (!lensOn) return x;
            const t = (x - lensFocusX) / lensR;
            if (t <= -1) return x - lensExtra;
            if (t >= 1) return x + lensExtra;
            // odd smootherstep: s(±1)=±1, s'(±1)=0, s'(0)=1.5 → centre spacing ×(1 + 1.5·extra/R)
            return x + lensExtra * (t * (1.5 - 0.5 * t * t));
          };
          // depth falloff: under the open lens, lines/names far from the cursor recede a touch so the
          // focused cluster reads "forward" (req). Full at the centre; eased to (1 − lensAmt·DIM) past ~1.5R.
          const focusDim = (x: number): number => {
            if (!lensOn) return 1;
            const t = Math.min(1, Math.abs(x - lensFocusX) / (lensR * 1.5));
            return 1 - lensAmt * TL_LENS_DIM * (t * t * (3 - 2 * t));
          };

          // the baseline is the FIXED horizon (it never pans on desktop); it wipes in left→right as the
          // fold lands. SOLID across the delivered past (→ the "now" SPLIT), then a faint DASHED future
          // continuation runs on to the 2040 edge. The fade gradient is userSpaceOnUse → its x-vector
          // tracks the live canvas width, so the solid line still bleeds to nothing at the left edge.
          const pAxis = smooth(0.3, 0.62, amt);
          const wipeX = padPx + pAxis * viewW;                 // the left→right reveal front
          const splitX = padPx + TL_SPLIT_FRAC * plotW + pan;  // the "now" handoff x (unwarped)
          if (axis) {
            axis.setAttribute("x1", padPx.toFixed(1));
            axis.setAttribute("y1", baseYs);
            axis.setAttribute("x2", Math.min(splitX, wipeX).toFixed(1));
            axis.setAttribute("y2", baseYs);
            axis.style.opacity = smooth(0.3, 0.66, amt).toFixed(3);
          }
          if (dom.axisGrad) dom.axisGrad.setAttribute("x2", W.toFixed(0));
          // the dashed future: from the split out to the revealed front (≤ the right edge), fainter and
          // resolving a touch later, so the past reads first and the road ahead whispers in behind it.
          if (dom.axisFuture) {
            const f = dom.axisFuture;
            f.setAttribute("x1", splitX.toFixed(1));
            f.setAttribute("y1", baseYs);
            f.setAttribute("x2", Math.max(splitX, wipeX).toFixed(1));
            f.setAttribute("y2", baseYs);
            f.style.opacity = (smooth(0.55, 0.9, amt) * 0.55).toFixed(3);
          }
          // the "now" marker rides the split (unwarped), fading in just after the baseline lands
          if (dom.now) {
            dom.now.style.transform = `translateX(${splitX.toFixed(1)}px)`;
            dom.now.style.opacity = smooth(0.62, 0.92, amt).toFixed(3);
          }

          // the year ruler — placed from the same date map (so it tracks the mobile zoom + pan),
          // fading in with the baseline.
          if (dom.years.length === TL_YEAR_FRAC.length)
            for (let k = 0; k < dom.years.length; k++) {
              const yx = padPx + TL_YEAR_FRAC[k] * plotW + pan;
              dom.years[k].style.transform = `translateX(${yx.toFixed(1)}px) translateX(-50%)`;
            }
          if (dom.yearsRoot) dom.yearsRoot.style.opacity = smooth(0.34, 0.7, amt).toFixed(3);

          for (let i = 0; i < DIAL_N; i++) {
            const pl = TL_PLOT[i];
            const branch = branches[i], label = labels[i], nub = nubs[i], tip = tips[i];
            const isSel = i === sel;
            const major = PROJECTS[i].major;
            const lineX = warpX(padPx + pl.xFrac * plotW + pan); // jittered date-x + pan, then hover lens
            const dirY = pl.down ? 1 : -1;

            // the year-peak (group-level, identical for every member): the elevation envelope,
            // floored so the whole stack fits and capped to the available room so nothing clips.
            const room = pl.down ? downRoom : upRoom;
            // the stack must FIT within `room` (clear of the top edge / the year ruler): if a year is
            // too populous for the available height, COMPRESS the per-row step so the tallest line
            // stays inside room. In the common (tall-enough) case this is a no-op — fitStack ===
            // TL_STACK. room is always > TL_FLOOR (baseY clamped to [0.46H,0.58H] ⇒ room stays positive).
            const fitStack =
              pl.groupCount > 1
                ? Math.min(TL_STACK, (room - TL_FLOOR) / (pl.groupCount - 1))
                : TL_STACK;
            const stackReq = (pl.groupCount - 1) * fitStack + TL_FLOOR; // ≤ room by construction
            const envel =
              (TL_PEAK_MIN + pl.groupMaxAbs * TL_PEAK_RANGE + (pl.groupMajor ? TL_MAJOR_BONUS : 0)) * H;
            const peak = Math.min(Math.max(envel, stackReq), room);
            // the latest in the group reaches `peak` (≤ room); each earlier one steps down one
            // (fitted) row, so the shortest is ≥ TL_FLOOR and the names stay clear of the chrome.
            const fullLen = peak - (pl.groupCount - 1 - pl.stackRank) * fitStack;
            const fullTipY = baseY + dirY * fullLen; // SETTLED tip — drives the name column + hover pick
            tlTipY[i] = fullTipY;

            // staggered straight draw-on: the leftmost line rises first, the rightmost trails
            const delay = pl.xFrac * TL_DRAW_SPAN;
            const grow = smooth(delay, Math.min(1, delay + TL_DRAW_RISE), pDraw);
            const tipY = baseY + dirY * fullLen * grow;
            const lx = lineX.toFixed(1);
            const fd = isSel ? 1 : focusDim(lineX); // the selected you-are-here line never recedes
            branch.setAttribute("d", `M${lx},${baseYs} L${lx},${tipY.toFixed(1)}`);
            branch.style.opacity = (amt * grow * fd).toFixed(3);

            // a small SQUARE nub sits at the line's root on the baseline (req 4)…
            nub.style.transform = `translate(${lx}px, ${baseYs}px)`;
            nub.style.opacity = (amt * grow * fd).toFixed(3);
            // …and an identical square nub caps the line's live TIP — it rides the growing end (req 4).
            tip.style.transform = `translate(${lx}px, ${tipY.toFixed(1)}px)`;
            tip.style.opacity = (amt * grow * fd).toFixed(3);

            // the NAME itself (horizontal + left-aligned, grouped into a cluster column, req 2/3) is
            // positioned in a SECOND pass below — once every line's settled tip is stashed — so the
            // column can de-collide off stable heights. Here we only keep the selected label tabbable.
            label.tabIndex = isSel ? 0 : -1;

            branch.classList.toggle("is-selected", isSel);
            branch.classList.toggle("is-major", major);
            nub.classList.toggle("is-selected", isSel);
            tip.classList.toggle("is-selected", isSel);
            label.classList.toggle("is-selected", isSel);
            label.classList.toggle("is-major", major);

            // hover pick: nearest line within TL_HOVER_X px of x, inside the line's own vertical span
            // (a small margin past the tip). The name now lives far to the right, so the pick tracks the
            // LINE — lighting its line + far name together is what shows the relation. Closest x wins.
            if (hoverOn) {
              const dx = Math.abs(hx - lineX);
              if (dx <= hoverBestD) {
                const yLo = Math.min(baseY, fullTipY) - 8;
                const yHi = Math.max(baseY, fullTipY) + 8;
                if (hy >= yLo && hy <= yHi) { hoverBestD = dx; hoverBest = i; }
              }
            }
          }

          // ---- the NAME columns (req 2/3). Each date cluster's names share ONE left edge just to the
          // RIGHT of the cluster's right-most line (TL_CLUSTER_MAXX → px), so a horizontal name never
          // crosses a line in its own cluster. Within the column each name sits at its line's settled
          // tip height (the staircase the per-year step-down already traces) and is nudged DOWN only if
          // two would overlap (dense, but legible) — keyed off the stashed tip so it never jitters as
          // the lines draw in. Resolves last (pLabel) with a tiny settle slide outward.
          const rowMin = mobile ? 16 : 12; // min px between stacked names (≥ the live name height)
          for (const cluster of TL_CLUSTERS) {
            // the column left-aligns just past the cluster's right-most line — warped with the lines so the
            // names track their (spread) cluster, then the fixed GAP added in screen space.
            const colX = warpX(padPx + TL_CLUSTER_MAXX[cluster[0]] * plotW + pan) + TL_LABEL_GAP;
            // order rows top→bottom (up-names above the baseline first, down-names below) then push down
            // to keep a min gap; the staircase already separates same-year names so this rarely fires.
            const rows = cluster.slice().sort((a, b) => tlTipY[a] - tlTipY[b]);
            let prevY = -Infinity;
            for (const i of rows) {
              const y = Math.max(tlTipY[i], prevY + rowMin);
              prevY = y;
              const delay = TL_PLOT[i].xFrac * TL_DRAW_SPAN;
              const labelGrow = smooth(delay, Math.min(1, delay + 0.5), pLabel);
              const slide = (1 - labelGrow) * 6; // a small outward settle as the name resolves
              labels[i].style.transform =
                `translate(${(colX + slide).toFixed(1)}px, ${y.toFixed(1)}px) translate(0, -50%)`;
              labels[i].style.opacity = (amt * labelGrow * (i === sel ? 1 : focusDim(colX))).toFixed(3);
            }
          }

          // hovering a NAME button (req 3) takes precedence over the geometric line pick, so a far-
          // right name lights its OWN line + nub — the relation made discoverable on a desktop mouse.
          // (Gated like the geometric pick: settled timeline, desktop only — nameHover stays −1 on touch.)
          if (!mobile && amt > 0.9 && nameHover >= 0) hoverBest = nameHover;

          // apply the hover emphasis only on a CHANGE (not 75 classList writes/frame): clear the old
          // line/name/nubs, light the new (req 2). is-hover is the loop's own class — the per-frame
          // is-selected/is-major toggles above never touch it, so it persists between selection ticks.
          if (hoverBest !== tlHover) {
            if (tlHover >= 0) {
              branches[tlHover]?.classList.remove("is-hover");
              labels[tlHover]?.classList.remove("is-hover");
              nubs[tlHover]?.classList.remove("is-hover");
              tips[tlHover]?.classList.remove("is-hover");
            }
            if (hoverBest >= 0) {
              branches[hoverBest]?.classList.add("is-hover");
              labels[hoverBest]?.classList.add("is-hover");
              nubs[hoverBest]?.classList.add("is-hover");
              tips[hoverBest]?.classList.add("is-hover");
            }
            tlHover = hoverBest;
          }
        }

        // selection-change-only work (NOT per frame): the polite SR announcement, roving focus, and
        // the hidden mobile-list fallback's class + roving tabindex (it's display:none on every
        // viewport now, so this only needs to track the selection, never run each frame).
        if (sel !== dialPrevSelected) {
          dialPrevSelected = sel;
          if (dom.listItems.length === DIAL_N)
            for (let i = 0; i < DIAL_N; i++) {
              const it = dom.listItems[i];
              it.classList.toggle("is-selected", i === sel);
              it.tabIndex = i === sel ? 0 : -1;
            }
          if (dom.liveRegion)
            // mirror the button aria-label (title · date · place) so the polite announcement loses
            // nothing — the name-only rule governs the VISIBLE dial, not the SR readout
            dom.liveRegion.textContent =
              `${PROJECTS[sel].title}, ${formatMonthYearLong(PROJECTS[sel].date)}, ${PROJECTS[sel].place}`;
          const act = typeof document !== "undefined" ? document.activeElement : null;
          // the timeline labels are the hit targets on both desktop and mobile now; move focus to
          // the selected one if focus was already on a label (keyboard stepping), never steal it.
          if (act && act.classList?.contains("tl-label")) labels[sel]?.focus?.();
        }
      };

      let raf = 0;
      let prev = performance.now();
      const startT = prev;
      const frame = (now: number) => {
        perf?.frame(now); // ?perf=1 telemetry: raw frame cadence (no-op when perf is off)
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

        // ---- Projects TIMELINE clocks. projAmt eases in only once the globe is actually present
        // (mc<0.15), so opening from CV waits for the mountain to dissolve. The scrub eases toward
        // its target with a release-flick + a per-project detent snap, clamped to the linear range.
        const projTarget = projectsOpenRef.current && mc < 0.15 ? 1 : 0;
        const projTau = projTarget > projAmt ? PROJ_OPEN_TAU : PROJ_CLOSE_TAU;
        projAmt += (projTarget - projAmt) * (reduceMotion ? 1 : 1 - Math.exp(-dt / projTau));
        if (projTarget === 0 && projAmt < 1e-3) projAmt = 0;
        // a closed timeline clears its mobile pan state; panFollowSel = -1 marks the NEXT open so the
        // pan jumps straight to the live selection (so the highlighted project is on-screen at open,
        // and a reopen lands on the same project the viewer left — see the follow block below).
        // a closed timeline clears its mobile pan + the desktop hover index. tlHover must reset here:
        // the overlay unmounts on close (its is-hover-bearing nodes destroyed), and under reduced
        // motion the projAmt jump skips the settle frame that would otherwise clear it — so a reopen
        // could leave the line at the stale index un-lit when the cursor rests on it.
        if (projAmt === 0) { panX = 0; tPanX = 0; panVel = 0; panFollowSel = -1; panLastSel = -1; tlHover = -1; nameHover = -1; lensAmt = 0; lensFocusX = -1; }
        // ---- transition phase windows: sub-ranges of the SAME monotonic projAmt, so the close
        // reverses the open exactly. The globe FOLD leads (the threads collapse onto the baseline +
        // dissolve — shaped in the shader off F.mph.w = projAmt, fully gone by ~0.72); pDraw then
        // rises the straight lines left→right out of the landed baseline; pLabel resolves the names
        // last. (The shader fold + the line wipe overlap so the line is there as the globe vanishes.)
        const pDraw = smooth(0.42, 1.0, projAmt);
        const pLabel = smooth(0.68, 1.0, projAmt);
        // read the narrow-screen breakpoint ONCE per frame (matchMedia allocates a MediaQueryList per
        // call) and thread it to the pan block + updateTimeline below.
        const mobile = dialMobile();
        // ---- the hover FOCUS-LENS strength. Eases toward 1 only on a SETTLED desktop timeline with the
        // mouse over the field and not dragging — so the spread fades in/out and never fights the scrub.
        // lensFocusX tracks the live cursor (held at its last value while the lens eases back out).
        const lensTarget =
          !mobile && projectsOpenRef.current && projAmt > 0.9 && !dialDragging && hx >= 0 ? 1 : 0;
        lensAmt += (lensTarget - lensAmt) * (reduceMotion ? 1 : 1 - Math.exp(-dt / LENS_TAU));
        if (lensTarget === 0 && lensAmt < 1e-3) lensAmt = 0;
        if (hx >= 0) lensFocusX = hx;
        if (projectsOpenRef.current) {
          // MOBILE: ease the zoomed-timeline pan toward its target with a release-flick (req 7),
          // clamped to [panMin, 0] for the live width. Desktop keeps panX === 0 (zoom 1 ⇒ no pan).
          if (mobile) {
            const W = cvs.clientWidth;
            const panMin = tlPanMin(W);
            // FOLLOW THE SELECTION (req 7): the zoomed plot shows only a slice, so a selection made by
            // tap / keyboard (which moves the scrub, not the pan) must scroll its line into view —
            // otherwise the highlighted "you-are-here" line opens off-screen. Drive off the TARGET
            // selection (round of tDialAngle); never fight an in-progress free drag.
            const tSel = Math.min(DIAL_N - 1, Math.max(0, Math.round(tDialAngle / DIAL_SLOT)));
            if (!panDragging && tSel !== panFollowSel) {
              const opening = panFollowSel === -1; // first frame after open/reset
              panFollowSel = tSel;
              const padPx = TL_PAD * W;
              const plotW = tlAxisSpan(W) * TL_MOBILE_ZOOM;
              const selX = padPx + TL_XFRAC_J[tSel] * plotW; // the selected line's UN-panned x
              const centered = Math.min(0, Math.max(panMin, W * 0.5 - selX)); // pan that centres it
              if (opening) {
                panX = tPanX = centered; // jump, so the timeline draws on already showing the selection
              } else {
                const curX = selX + tPanX; // where it sits at the current target pan
                if (curX < W * 0.16 || curX > W * 0.84) tPanX = centered; // only re-pan near/off an edge
              }
            }
            if (!panDragging) {
              panVel *= Math.exp(-dt / DIAL_INERTIA_TAU);
              tPanX += panVel * dt;
              if (tPanX > 0) { tPanX = 0; if (panVel > 0) panVel = 0; }
              else if (tPanX < panMin) { tPanX = panMin; if (panVel < 0) panVel = 0; }
            } else {
              tPanX = Math.min(0, Math.max(panMin, tPanX)); // a rotate/resize can shrink the range
            }
            panX += (tPanX - panX) * (reduceMotion ? 1 : 1 - Math.exp(-dt / DIAL_SMOOTH_TAU));
          }
          if (!dialDragging) {
            velDial *= Math.exp(-dt / DIAL_INERTIA_TAU);
            tDialAngle += velDial * dt;
            // a timeline doesn't wrap: clamp to the linear range and kill the flick at the ends
            if (tDialAngle <= 0) { tDialAngle = 0; if (velDial < 0) velDial = 0; }
            else if (tDialAngle >= DIAL_MAX_ANGLE) { tDialAngle = DIAL_MAX_ANGLE; if (velDial > 0) velDial = 0; }
            if (Math.abs(velDial) < DIAL_SNAP_VEL) {
              const snap = Math.min(
                DIAL_MAX_ANGLE,
                Math.max(0, Math.round(tDialAngle / DIAL_SLOT) * DIAL_SLOT),
              ); // settle to the nearest project
              tDialAngle += (snap - tDialAngle) * (reduceMotion ? 1 : 1 - Math.exp(-dt / DIAL_SNAP_TAU));
              if (Math.abs(velDial) < 1e-4) velDial = 0;
            }
          }
          dialAngle += (tDialAngle - dialAngle) * (reduceMotion ? 1 : 1 - Math.exp(-dt / DIAL_SMOOTH_TAU));
        }
        // closing keeps the scrub where the viewer left it, so a reopen lands on the same project.
        dialSelected = Math.min(DIAL_N - 1, Math.max(0, Math.round(dialAngle / DIAL_SLOT)));

        // tighten the pitch walls from the wide GLOBE range to the authored MOUNTAIN range as the
        // morph runs; re-clamp the target so a wide globe tilt eases inside the new walls instead of
        // snapping. Endpoints pinned: mEase 0 ⇒ globe walls, 1 ⇒ mountain walls.
        pLo = mix01(GLOBE_PITCH_LO, PITCH_LO, mEase);
        pHi = mix01(GLOBE_PITCH_HI, PITCH_HI, mEase);
        tPitch = clampPitch(tPitch);
        // idle planet spin — fades out EARLY as the dial opens (the ball parks calm before the
        // spokes finish drawing, req 2; the knob then drives the spin instead, below)
        globeSpin += SPIN * (1 - smooth(0.15, 0.6, mc)) * (1 - smooth(0.0, 0.45, projAmt)) * dt;
        // the GPU globe + the DOM letter-cloud both read this summed spin, so the ball turns 1:1
        // with the knob (dialAngle) while the dial is open and resumes its idle drift when closed.
        const spinOut = globeSpin + dialAngle * projAmt;
        const landed = mc > 0.985;

        // advance the one-shot reveal once the mountain has landed, then hold at 1 (req 1). Latched so
        // it plays a single time per session; reduced motion snaps straight to the revealed render.
        if (landed && morphTargetRef.current === 1) {
          revealClock = Math.min(1, revealClock + (reduceMotion ? 1 : dt / REVEAL_DUR));
        }
        // smootherstep the linear progress so the sweep eases in and out gracefully
        const reveal =
          revealClock <= 0
            ? 0
            : revealClock >= 1
              ? 1
              : revealClock * revealClock * revealClock * (revealClock * (revealClock * 6 - 15) + 10);

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
        const sel = selectedRef.current;
        const focused = sel != null;
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
        if (sel != null) focusBand = sel;
        else if (focusAmt < 0.01) focusBand = -1;

        const wide = smooth(1.0, 1.4, aspectNow);

        // a cinematic dolly: the globe sits whole and LARGE — its silhouette nearly reaching the
        // screen SIDES (aspect-aware, see globeFitRadiusScale) — then the camera settles to the
        // authored mountain framing exactly at mc = 1. globeRadius eases globeStart → 1.0 by
        // mc ≈ 0.70, and mix01(globeStart, 1.0, 1) === 1.0 for ANY start, so the finished-mountain
        // dolly is byte-identical no matter how big the globe is framed. While Projects opens the
        // globe holds its full framing and FOLDS in place into the baseline (no moon, no shrink).
        const tlActive = projAmt > 0.001; // the timeline now runs on mobile too (req 7)
        const globeStart = globeFitRadiusScale(aspectNow);
        const globeRadius = mix01(globeStart, 1.0, smooth(0.0, 0.70, mc));
        const rscale = radiusScale * globeRadius;

        // pan: the dossier focus (mountain) slides the massif RIGHT into the clear flank; zero while
        // Projects is up. The Projects baseline is instead WELDED to where the globe folds — the
        // projected globe centre — so the red line lands exactly on the glowing line the threads
        // collapse onto, and the straight branches rise from it. focusShiftY stays 0 so the globe
        // folds in place (no vertical lens shift). The DoF focal + frost spotlight stay centred.
        let focusShift = focusAmt * 0.42 * wide;
        let projBaseY = TL_BASE_Y * cvs.clientHeight;
        const focalX = 0.5, focalY = 0.5;
        if (tlActive) {
          const W = cvs.clientWidth, H = cvs.clientHeight;
          const cu = projectToScreen(
            ridgeCamera(yaw, pitch, aspectNow, t, rscale, 0, 0).vp,
            GLOBE.cx, GLOBE.cy, GLOBE.cz, W, H,
          );
          // clamp to a sensible band so an extreme tilt can never shove the line off-screen. The band
          // is centred-ish (≈0.46–0.58 H) so the now-dense BELOW-axis massif gets as much room as the
          // delivered work above — the survey reads balanced top/bottom like the reference.
          if (cu.visible) projBaseY = Math.min(0.58 * H, Math.max(0.46 * H, cu.y));
          const frost = dialDomRef.current?.frost;
          if (frost) {
            frost.style.setProperty("--fx", "50%");
            frost.style.setProperty("--fy", "50%");
          }
        }

        // lift the SELECTED ring to a comfortable framing height. The dolly-in keeps
        // aiming at the summit, so without this the low (early-career) rings near the
        // dune plain dolly off the bottom of the frame and the clicked station can't be
        // seen. Project BOTH the chosen ring anchor and the massif's near-edge foot
        // through the LIVE focused camera (this frame's dolly + pan + breathing,
        // shiftY = 0): lift the ring toward FOCUS_AIM_Y, but never by more than what
        // keeps the foot at FOCUS_FOOT — so the widest dune rings (whose foot is right
        // at the mesh edge) rise into view without baring black sky below the mountain.
        // max(0, …) pulls only UP, leaving the high summit rings already-framed. (Mountain
        // focus only — selBand is null while Projects is open.)
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

        // the vertical shift the globe/mountain renders with: 0 while the desktop timeline is open
        // (the globe folds in place), otherwise the eased mountain ring-lift.
        const fShiftY = tlActive ? 0 : focusShiftY;

        // feed this frame's delta to the DRS controller (dt is seconds, already clamped to 0.05 above,
        // so a resume/GC spike can't pollute the EWMA) — it adjusts the render-scale BEFORE we render.
        gpu.tickScale(dt * 1000);

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
          focusShiftY: fShiftY,
          focalX,
          focalY,
          projAmt,
          reveal,
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
        if (mc < 0.999) {
          // reuse aspectNow from the top of the frame — the canvas can't resize
          // mid-frame, so a second clientWidth/clientHeight read would be redundant.
          const cam = ridgeCamera(yaw, pitch, aspectNow, t, rscale, focusShift, fShiftY);
          // spinOut (idle + scrub roll) so the cloud co-rotates with the GPU ball in BOTH phases
          updateCloud(cam.vp, cam.eye, spinOut, mc, cvs.clientWidth, cvs.clientHeight);
          // the chaotic letter-cloud is part of "the mess" — fade it out as the trace organises
          if (cloudRef.current) cloudRef.current.style.opacity = (1 - projAmt).toFixed(3);
          // plot the Projects survey line — pure screen space, its baseline welded to the folding globe
          if (projAmt > 0.002)
            updateTimeline(cvs.clientWidth, cvs.clientHeight, projAmt, dialSelected, pDraw, pLabel, projBaseY, panX, mobile);
        } else if (cloudRef.current && cloudRef.current.style.visibility !== "hidden") {
          cloudRef.current.style.visibility = "hidden"; // mountain is whole — drop the cloud
        }
        updateSurvey(yaw, pitch, t, dt, rscale, focusShift, fShiftY, mc);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      teardown.push(() => cancelAnimationFrame(raf));

      // ---- visibility gating: a backgrounded tab paints zero pixels, so rendering it is pure wasted
      // SoC/GPU heat (the single biggest "free" win on a phone — see HYBRID.md/TELEMETRY.md). Pause the
      // rAF while hidden and re-arm on return. The raf===0 guard makes hide/show idempotent (no double
      // schedule). prev=performance.now() on resume is LOAD-BEARING: it makes the first post-resume dt≈0
      // so no time-accumulator (the morph clock, inertia, the eases) lurches by the elapsed hidden span.
      // (No IntersectionObserver: the stage is position:fixed inset:0 and the page can't scroll, so the
      // canvas is always 100% on-screen when the tab is visible.)
      const pauseLoop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
      const resumeLoop = () => {
        if (raf || disposed || document.visibilityState === "hidden") return;
        prev = performance.now();
        raf = requestAnimationFrame(frame);
      };
      const onVisibility = () => {
        if (document.visibilityState === "hidden") pauseLoop();
        else resumeLoop();
      };
      document.addEventListener("visibilitychange", onVisibility);
      // pageshow re-arms after a back/forward-cache restore (where the document was already "visible"
      // when pagehide froze it, so no visibilitychange fires); pagehide pauses on bfcache freeze/unload.
      window.addEventListener("pageshow", resumeLoop);
      window.addEventListener("pagehide", pauseLoop);
      teardown.push(() => {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pageshow", resumeLoop);
        window.removeEventListener("pagehide", pauseLoop);
      });
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
          <p className="gpu-notice-title">A mountain, drawn in light.</p>
          <p className="gpu-notice-body">
            This piece is rendered in real time with WebGPU. Open it in a recent
            Chrome, Edge, Safari, or Firefox to see it.
          </p>
        </div>
      </div>
    );
  }

  const overlayOpen = selected !== null || assignmentOpen || projectsOpen || bookOpen;

  return (
    <div
      className={`ridge-stage${overlayOpen ? " is-overlay-open" : ""}${view === "home" ? " is-globe" : ""}`}
      id="home"
    >
      {/* the live WebGPU render is decorative: the readable CV is mirrored in the survey
          callouts + overlays and the page's sr-only <h1>, and orbit is keyboard-operable
          via the window-level arrow-key handler — so it's hidden from assistive tech. */}
      <canvas id="ridge" ref={canvasRef} aria-hidden="true" />

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

      {/* bottom drag hint — a tracked small-caps cue flanked by two little CURVED arrows
          (curving outward, one pointing left, one right) signalling the globe can be spun.
          Globe-only: opacity is driven from the rAF loop (1 while mc≈0 & still inviting, else
          0) and retired by stopInviting on the first rotate. aria-hidden + pointer-events:none
          so a drag passes straight through to the canvas beneath. */}
      <div className="globe-hint" ref={hintRef} aria-hidden="true">
        <svg className="globe-hint-arrow" viewBox="0 0 24 20" fill="none" aria-hidden="true">
          <path d="M21 13.5 Q12 6.5 3 10.5" />
          <path d="M3 10.5 L6 6.9 M3 10.5 L7.4 11.4" />
        </svg>
        <span className="globe-hint-text">drag to rotate</span>
        <svg className="globe-hint-arrow" viewBox="0 0 24 20" fill="none" aria-hidden="true">
          <path d="M3 13.5 Q12 6.5 21 10.5" />
          <path d="M21 10.5 L18 6.9 M21 10.5 L16.6 11.4" />
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
            onHover={onDialHover}
          />
        )}
      </AnimatePresence>

      {/* the "Book me" session menu — opened by the Book me nav link / #book route.
          A flat liquid-glass spread over whichever scene is live (like the brief),
          with the session cards reproduced in the site's own voice. */}
      <AnimatePresence>
        {bookOpen && (
          <BookOverlay
            key="book-overlay"
            ref={bookCloseBtnRef}
            onClose={closeBook}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
