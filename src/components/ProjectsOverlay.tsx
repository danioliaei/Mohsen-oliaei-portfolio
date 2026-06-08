import { forwardRef, useLayoutEffect, useRef } from "react";
import { motion } from "motion/react";
import { PROJECTS, formatMonthYearLong, TIME_MIN, TIME_MAX } from "../data/projects";

/* =========================================================================
   ProjectsOverlay — "The Filament".

   NOT a frosted modal, and no longer the vertical-stem ridgeline. A transparent
   layer welded over the LIVE globe: as the Projects view opens, the chaotic GPU
   globe CALMS and collapses onto a single horizontal GLOWING LINE — a warm, bloomed
   filament with light PULSES travelling along it — that the calmed globe rides as a
   luminous MOON. From that line the whole career STRAYS OUT: one organic, curving
   BRANCH per project, rooted on the line at its date (x), splaying up or down and
   gently floating, with the more important (flagship) work reaching FURTHER. The
   points where the branches leave the line are the BOLD nodes; a name floats at each
   branch tip. The moon TRANSITS the line left↔right as you scrub; the branch it sits
   over is the selection. (Reference: the organic data-art "filament" still.)

   This component renders only a STATIC skeleton (the masthead, the close control,
   the glowing line + its bloom + the travelling pulses, the ~80 branch/origin/tip/
   label nodes, the year ruler, the mobile list, an aria-live region). All per-frame
   geometry — the line wipe, the pulses, every branch curve, its draw-on and organic
   float, the bold origin nodes, the label emphasis, the moon-following focus
   spotlight, the live readout — is written imperatively by the rAF loop in
   RidgelineStage (`updateTimeline`), exactly like the survey callouts and the letter
   cloud, so nothing re-renders React during interaction and the plot stays welded to
   the projected (transiting) globe. The loop reaches our DOM through `domRef`;
   selecting a project (click / mobile tap / the loop's keyboard stepping) routes
   through `onSelect`.

   Same Inter / --mono / tracked-caps grammar as the site headers; warm-dusk ink,
   amber only as the sparing "you-are-here" accent on the selected branch + name.
   ========================================================================= */

const EASE = [0.22, 1, 0.36, 1] as const;
const TOTAL = PROJECTS.length;
// a few light pulses that travel the glowing line (rAF-driven; cheap). Phase-offset so
// they ripple down the filament rather than marching in lock-step.
const PULSES = [0, 1, 2, 3] as const;

/** the live DOM handles the RidgelineStage rAF loop welds each frame */
export type ProjectsDialDom = {
  root: HTMLDivElement | null;
  /** the crisp glowing line (loop sets its x-extent + y as it wipes in) */
  axis: SVGLineElement | null;
  /** the wide blurred bloom under the crisp line (same geometry, soft halo) */
  axisGlow: SVGLineElement | null;
  /** the light pulses travelling along the line */
  pulses: SVGCircleElement[];
  /** one organic branch curve per project, in PROJECTS order */
  branches: SVGPathElement[];
  /** the BOLD node where each branch leaves the line (rooted on the line) */
  origins: SVGCircleElement[];
  /** the faint node at each branch tip */
  tips: SVGCircleElement[];
  /** the name label floating at each branch tip (a button / hit target) */
  labels: HTMLElement[];
  listItems: HTMLElement[];
  plate: HTMLElement | null;
  live: HTMLElement | null; // masthead "title · place" readout
  liveRegion: HTMLElement | null; // visually-hidden aria-live announcer
  /** the focus scrim — the loop slides its spotlight (--fx/--fy) under the moon */
  frost: HTMLElement | null;
  /** the line's fade gradient — the loop sets its x-extent to the live canvas width
      (userSpaceOnUse needs absolute coords, so the end-fades track the viewport) */
  axisGrad: SVGLinearGradientElement | null;
};

type Props = {
  onClose: () => void;
  /** the loop reads this each frame to weld the timeline to the globe */
  domRef: React.MutableRefObject<ProjectsDialDom | null>;
  /** select a project (click a label / tap a list row) — routed into the loop */
  onSelect: (i: number) => void;
};

const yy = (date: string) => `'${date.slice(2, 4)}`; // "2025-04" → "'25"

// the integer year ticks spanning the plotted window — placed by the SAME fractional
// x-map the loop uses for the stems (see TL_PAD_FRAC in RidgelineStage), so the labels
// sit under their stems with no per-frame work. left% = (PAD + frac·(1-2·PAD))·100.
const TL_PAD_FRAC = 0.06;
const yearFrac = (year: number) =>
  (TL_PAD_FRAC + ((year - TIME_MIN) / (TIME_MAX - TIME_MIN)) * (1 - 2 * TL_PAD_FRAC)) * 100;
const YEARS: number[] = [];
for (let y = Math.ceil(TIME_MIN); y <= Math.floor(TIME_MAX); y++) YEARS.push(y);

const ProjectsOverlay = forwardRef<HTMLButtonElement, Props>(
  function ProjectsOverlay({ onClose, domRef, onSelect }, closeButtonRef) {
    const rootRef = useRef<HTMLDivElement>(null);
    const svgRef = useRef<SVGSVGElement>(null);
    const axisRef = useRef<SVGLineElement>(null);
    const axisGlowRef = useRef<SVGLineElement>(null);
    const labelsRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const plateRef = useRef<HTMLSpanElement>(null);
    const liveRef = useRef<HTMLSpanElement>(null);
    const announceRef = useRef<HTMLDivElement>(null);
    const frostRef = useRef<HTMLDivElement>(null);
    const axisGradRef = useRef<SVGLinearGradientElement>(null);

    // hand the rAF loop our live DOM nodes once mounted (mirrors the charEls wiring);
    // detach on unmount so the loop stops welding a vanished tree.
    useLayoutEffect(() => {
      const svg = svgRef.current;
      const labelsWrap = labelsRef.current;
      if (!svg || !labelsWrap) return;
      domRef.current = {
        root: rootRef.current,
        axis: axisRef.current,
        axisGlow: axisGlowRef.current,
        pulses: Array.from(svg.querySelectorAll<SVGCircleElement>(".tl-pulse")),
        branches: Array.from(svg.querySelectorAll<SVGPathElement>(".tl-branch")),
        origins: Array.from(svg.querySelectorAll<SVGCircleElement>(".tl-origin")),
        tips: Array.from(svg.querySelectorAll<SVGCircleElement>(".tl-tip")),
        labels: Array.from(labelsWrap.querySelectorAll<HTMLElement>(".tl-label")),
        listItems: listRef.current
          ? Array.from(listRef.current.querySelectorAll<HTMLElement>(".dial-list-item"))
          : [],
        plate: plateRef.current,
        live: liveRef.current,
        liveRegion: announceRef.current,
        frost: frostRef.current,
        axisGrad: axisGradRef.current,
      };
      return () => {
        domRef.current = null;
      };
    }, [domRef]);

    // trap Tab inside the dialog (the focusable set is just the close control + the
    // single roving-tabbable selected label, or the mobile list rows); arrows / Home /
    // End / Escape are owned by the RidgelineStage window key handler (they scrub the moon).
    const onRootKeyDown = (e: React.KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const root = rootRef.current;
      if (!root) return;
      const f = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    return (
      <motion.div
        ref={rootRef}
        className="projects-tl-root"
        role="dialog"
        aria-modal="true"
        aria-labelledby="projects-tl-title"
        onKeyDown={onRootKeyDown}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.4, ease: EASE }}
      >
        {/* the focus scrim — a soft top/bottom legibility wash plus a spotlight pool the
            rAF loop slides under the transiting moon (CSS vars --fx/--fy, in %). */}
        <div className="projects-tl-frost" ref={frostRef} aria-hidden="true" />

        {/* close — the predictable top-right control (Escape also closes) */}
        <button
          type="button"
          className="role-close"
          ref={closeButtonRef}
          onClick={onClose}
          aria-label="Close projects"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>

        {/* masthead — the surveyor spine, in the shared site grammar. The plate index +
            the live title · place readout are written each frame by the loop. */}
        <div className="projects-tl-masthead">
          <p className="projects-tl-eyebrow">Selected work · 2014–2026</p>
          <h2 id="projects-tl-title" className="projects-tl-title">
            Projects
          </h2>
          <p className="projects-tl-coords">
            <span className="plate" ref={plateRef}>
              PLATE 01 / {String(TOTAL).padStart(2, "0")}
            </span>
            <span> · </span>
            <span className="live" ref={liveRef}>
              {PROJECTS[0].title.toUpperCase()}
            </span>
          </p>
        </div>

        {/* the filament layer — line, pulses + branch geometry welded each frame (desktop).
            Painted back-to-front: the soft bloom, the crisp line, the branch curves, their
            tip nodes, then the BOLD origin nodes and the travelling pulses on top so the
            line reads brightest where the work leaves it. */}
        <svg className="projects-tl-svg" ref={svgRef} aria-hidden="true">
          <defs>
            {/* the line fades to nothing at both ends so the filament bleeds into the dark
                rather than stopping at a hard cap. userSpaceOnUse needs ABSOLUTE coords
                (percentages are out of spec here), so the rAF loop sets x2 to the live canvas
                width each frame and the 10%/90% stops track the viewport. */}
            <linearGradient
              id="tl-axis-fade"
              ref={axisGradRef}
              gradientUnits="userSpaceOnUse"
              x1="0"
              y1="0"
              x2="0"
              y2="0"
            >
              <stop offset="0" stopColor="var(--c-line)" stopOpacity="0" />
              <stop offset="0.1" stopColor="var(--c-line)" stopOpacity="1" />
              <stop offset="0.9" stopColor="var(--c-line)" stopOpacity="1" />
              <stop offset="1" stopColor="var(--c-line)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* the glowing line — a wide blurred bloom beneath a crisp bright core */}
          <line className="tl-axis-glow" ref={axisGlowRef} x1="0" y1="0" x2="0" y2="0" />
          <line className="tl-axis" ref={axisRef} x1="0" y1="0" x2="0" y2="0" />
          {/* one organic branch curve per project */}
          {PROJECTS.map((p) => (
            <path className="tl-branch" key={`branch-${p.id}`} d="" />
          ))}
          {/* the faint tip node at each branch end */}
          {PROJECTS.map((p) => (
            <circle className="tl-tip" key={`tip-${p.id}`} cx="0" cy="0" />
          ))}
          {/* the BOLD origin node where each branch leaves the line (req: bolder points) */}
          {PROJECTS.map((p) => (
            <circle className="tl-origin" key={`origin-${p.id}`} cx="0" cy="0" />
          ))}
          {/* the light pulses that travel the line */}
          {PULSES.map((k) => (
            <circle className="tl-pulse" key={`pulse-${k}`} cx="0" cy="0" />
          ))}
        </svg>

        {/* the year ruler — static, placed by the same fractional x-map as the branch roots */}
        <div className="tl-years" aria-hidden="true">
          {YEARS.map((y) => (
            <span className="tl-year" key={`year-${y}`} style={{ left: `${yearFrac(y)}%` }}>
              {y}
            </span>
          ))}
        </div>

        {/* the label layer — each project is a positioned button (its own hit target). NAME
            ONLY: the short label the rAF loop floats at the branch tip (horizontal, centred on
            the tip), the selected one brightening to the amber accent. The full record (date,
            place) stays in the aria-label so screen readers lose nothing. */}
        <div className="projects-tl-labels" ref={labelsRef}>
          {PROJECTS.map((p, i) => (
            <button
              type="button"
              className="tl-label"
              key={p.id}
              // the rAF loop is the SOLE owner of the desktop roving tabindex (it sets the
              // selected label to 0 and the rest to -1 every frame), so start them all at -1.
              tabIndex={-1}
              aria-label={`Project ${i + 1} of ${TOTAL}: ${p.title}, ${formatMonthYearLong(p.date)}, ${p.place}`}
              onClick={() => onSelect(i)}
            >
              <span className="tl-label-name">{p.short}</span>
            </button>
          ))}
        </div>

        {/* the mobile fallback — a compact vertical list (the trace needs width). Tapping
            a row still glides the moon via the same selection path. */}
        <div className="dial-list" ref={listRef} role="list" aria-label="Projects, 2014 to 2026">
          {PROJECTS.map((p, i) => (
            <button
              type="button"
              className="dial-list-item"
              key={p.id}
              // the rAF loop owns the roving tabindex here too (selected row → 0, the rest → -1),
              // so the whole list isn't a ~80-stop tab trap; start them all at -1.
              tabIndex={-1}
              onClick={() => onSelect(i)}
              aria-label={`Project ${i + 1} of ${TOTAL}: ${p.title}, ${formatMonthYearLong(p.date)}, ${p.place}`}
            >
              <span className="short">{p.short}</span>
              <span className="year">{yy(p.date)}</span>
            </button>
          ))}
        </div>

        {/* polite screen-reader announcement of the selected project (loop-written) */}
        <div className="tl-live" aria-live="polite" ref={announceRef} />
      </motion.div>
    );
  },
);

export default ProjectsOverlay;

// re-exported so RidgelineStage can place stems with the SAME fractional x-map the year
// ticks use here (single source of truth for the plot's left/right padding).
export { TL_PAD_FRAC };
