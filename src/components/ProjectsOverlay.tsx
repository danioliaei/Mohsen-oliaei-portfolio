import { forwardRef, useLayoutEffect, useRef } from "react";
import { motion } from "motion/react";
import { PROJECTS, formatMonthYearLong, TIME_MIN, TIME_MAX } from "../data/projects";

/* =========================================================================
   ProjectsOverlay — "The Transit".

   NOT a frosted modal, and no longer the radial dial. A transparent layer welded
   over the LIVE globe: as the Projects view opens, the chaotic GPU globe CALMS,
   shrinks to a luminous MOON and lifts into the sky, while the whole career plots
   itself as a horizontal RIDGELINE TIMELINE along an ember baseline — ~80 vertical
   "signal" stems, one per project, placed by date (x) and significance/elevation
   (height), tracing two massifs with a central R&D valley exactly like the WiFi-SSID
   data-art reference. The moon then TRANSITS the range left↔right as you scrub,
   riding the cresting skyline; the project under it is the selection.

   This component renders only a STATIC skeleton (the masthead, the close control,
   the baseline axis, the ~80 stem/node/label nodes, the year ticks, the mobile
   list, an aria-live region). All per-frame geometry — the stem endpoints, the
   draw-on of the trace, the label emphasis, the moon-following focus spotlight,
   the live readout — is written imperatively by the rAF loop in RidgelineStage
   (`updateTimeline`), exactly like the survey callouts and the letter cloud, so
   nothing re-renders React during interaction and the plot stays welded to the
   projected (transiting) globe. The loop reaches our DOM through `domRef`;
   selecting a project (click / mobile tap / the loop's keyboard stepping) routes
   through `onSelect`.

   Same Inter / --mono / tracked-caps grammar as the site headers; warm-dusk ink,
   amber only as the sparing "you-are-here" accent on the selected stem + date.
   ========================================================================= */

const EASE = [0.22, 1, 0.36, 1] as const;
const TOTAL = PROJECTS.length;

/** the live DOM handles the RidgelineStage rAF loop welds each frame */
export type ProjectsDialDom = {
  root: HTMLDivElement | null;
  /** the ember baseline (loop sets its x-extent + y) */
  axis: SVGLineElement | null;
  /** one vertical stem per project, in PROJECTS order */
  stems: SVGLineElement[];
  /** the tip node riding each stem head */
  nodes: SVGCircleElement[];
  /** the name label at each stem tip (a button / hit target) */
  labels: HTMLElement[];
  listItems: HTMLElement[];
  plate: HTMLElement | null;
  live: HTMLElement | null; // masthead "title · place" readout
  liveRegion: HTMLElement | null; // visually-hidden aria-live announcer
  /** the focus scrim — the loop slides its spotlight (--fx/--fy) under the moon */
  frost: HTMLElement | null;
  /** the baseline's fade gradient — the loop sets its x-extent to the live canvas width
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
        stems: Array.from(svg.querySelectorAll<SVGLineElement>(".tl-stem")),
        nodes: Array.from(svg.querySelectorAll<SVGCircleElement>(".tl-node")),
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

        {/* the trace layer — stem geometry welded each frame (desktop ridgeline) */}
        <svg className="projects-tl-svg" ref={svgRef} aria-hidden="true">
          <defs>
            {/* the baseline fades to nothing at both ends so the ember axis bleeds into the
                dark rather than stopping at a hard cap. userSpaceOnUse needs ABSOLUTE coords
                (percentages are out of spec here), so the rAF loop sets x2 to the live canvas
                width each frame and the 12%/88% stops track the viewport. */}
            <linearGradient
              id="tl-axis-fade"
              ref={axisGradRef}
              gradientUnits="userSpaceOnUse"
              x1="0"
              y1="0"
              x2="0"
              y2="0"
            >
              <stop offset="0" stopColor="var(--c-education)" stopOpacity="0" />
              <stop offset="0.12" stopColor="var(--c-education)" stopOpacity="0.85" />
              <stop offset="0.88" stopColor="var(--c-education)" stopOpacity="0.85" />
              <stop offset="1" stopColor="var(--c-education)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* the ember baseline (the "red line" of the reference) */}
          <line className="tl-axis" ref={axisRef} x1="0" y1="0" x2="0" y2="0" />
          {/* stems + tip nodes, one per project */}
          {PROJECTS.map((p) => (
            <line className="tl-stem" key={`stem-${p.id}`} x1="0" y1="0" x2="0" y2="0" />
          ))}
          {PROJECTS.map((p) => (
            <circle className="tl-node" key={`node-${p.id}`} cx="0" cy="0" r="1.6" />
          ))}
        </svg>

        {/* the year axis — static, placed by the same fractional x-map as the stems */}
        <div className="tl-years" aria-hidden="true">
          {YEARS.map((y) => (
            <span className="tl-year" key={`year-${y}`} style={{ left: `${yearFrac(y)}%` }}>
              {y}
            </span>
          ))}
        </div>

        {/* the label layer — each project is a positioned button (its own hit target). NAME
            ONLY: the short label the rAF loop stands the tip on, rotated to read upward like
            the reference's SSID columns; the selected one brightens to the amber accent. The
            full record (date, place) stays in the aria-label so screen readers lose nothing. */}
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
