import { forwardRef, useLayoutEffect, useRef } from "react";
import { motion } from "motion/react";
import { PROJECTS, formatMonthYearLong, TIMELINE_TICKS } from "../data/projects";

/* =========================================================================
   ProjectsOverlay — "The Survey Line" (WiFi-SSID data-art reference).

   NOT a frosted modal. A transparent layer welded over the LIVE globe: as the
   Projects view opens, the chaotic GPU globe FOLDS INTO a single horizontal line
   and DISAPPEARS — every thread collapses onto the baseline, glows, then dissolves,
   leaving a MINIMAL line low on the screen. From that line the whole career rises as
   STRAIGHT vertical hairlines — one per project, rooted at its TRUE date (x), with a
   small organic jitter so the spacing reads like events at different times (req 5).
   Every line is a hairline, the SAME mono off-white as the globe filaments (req 2); a small
   SQUARE nub sits at each line's foot and an identical one at its tip (req 4). The names run
   HORIZONTAL + LEFT-ALIGNED, grouped into date CLUSTERS: each cluster's names share one left
   edge just to the RIGHT of the cluster's right-most line, so a name never crosses a clustered
   line — the line + tip nub + highlight carry which name maps to which line (req 3). A few
   projects genuinely hang BELOW the baseline (the central valley), so the skyline still reads
   as a sinus. On mobile the same timeline runs, zoomed, dragged left/right to pan. The selected
   name lights to the amber you-are-here accent.

   This component renders only a STATIC skeleton (the close control, the baseline, the
   ~80 straight branch lines, the foot + tip nubs, the name labels, the year ruler, an
   aria-live region). All per-frame geometry — the line wipe, every
   branch's straight draw-on, the nubs, the stacked labels, the year ruler placement,
   the mobile zoom + pan, the selection emphasis — is written imperatively by the rAF
   loop in RidgelineStage (`updateTimeline`), so nothing re-renders React during
   interaction. The loop reaches our DOM through `domRef`; selecting a project (click /
   mobile tap / the loop's keyboard stepping) routes through `onSelect`.
   ========================================================================= */

const EASE = [0.22, 1, 0.36, 1] as const;
const TOTAL = PROJECTS.length;

/** the live DOM handles the RidgelineStage rAF loop welds each frame */
export type ProjectsDialDom = {
  root: HTMLDivElement | null;
  /** the minimal baseline (loop sets its x-extent + y as it wipes in) */
  axis: SVGLineElement | null;
  /** the DASHED future continuation of the baseline (SPLIT "now" → right edge) */
  axisFuture: SVGLineElement | null;
  /** the "now" horizon marker (a faint vertical tick + caption, loop-placed at the SPLIT) */
  now: HTMLElement | null;
  /** one straight vertical branch line per project, in PROJECTS order */
  branches: SVGPathElement[];
  /** a small square foot nub per project, in PROJECTS order (req 4) */
  nubs: HTMLElement[];
  /** an identical square nub at each line's TIP (the far end of the branch), in PROJECTS order */
  tips: HTMLElement[];
  /** the name label per project (a button / hit target) */
  labels: HTMLElement[];
  /** the year ruler ticks (loop-positioned so they track the mobile zoom + pan) */
  years: HTMLElement[];
  /** the year ruler wrapper (loop sets its opacity with the baseline wipe) */
  yearsRoot: HTMLElement | null;
  listItems: HTMLElement[];
  liveRegion: HTMLElement | null; // visually-hidden aria-live announcer
  /** the focus scrim — a soft legibility wash + a static centre vignette */
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
  /** a desktop mouse over a name (or −1 on leave) — lets the loop light that name's line (req 3) */
  onHover: (i: number) => void;
};

const yy = (date: string) => `'${date.slice(2, 4)}`; // "2025-04" → "'25"

// the year ticks (TIMELINE_TICKS — every year across the dense past, then sparse future milestones)
// are POSITIONED by the rAF loop each frame (so they track the mobile zoom + pan); we only render the
// labels here. TL_PAD_FRAC is the shared left/right padding (single source of truth with
// RidgelineStage's stem placement).
const TL_PAD_FRAC = 0.06;

const ProjectsOverlay = forwardRef<HTMLButtonElement, Props>(
  function ProjectsOverlay({ onClose, domRef, onSelect, onHover }, closeButtonRef) {
    const rootRef = useRef<HTMLDivElement>(null);
    const svgRef = useRef<SVGSVGElement>(null);
    const axisRef = useRef<SVGLineElement>(null);
    const axisFutureRef = useRef<SVGLineElement>(null);
    const nowRef = useRef<HTMLDivElement>(null);
    const nubsRef = useRef<HTMLDivElement>(null);
    const tipsRef = useRef<HTMLDivElement>(null);
    const labelsRef = useRef<HTMLDivElement>(null);
    const yearsRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
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
        axisFuture: axisFutureRef.current,
        now: nowRef.current,
        branches: Array.from(svg.querySelectorAll<SVGPathElement>(".tl-branch")),
        nubs: nubsRef.current
          ? Array.from(nubsRef.current.querySelectorAll<HTMLElement>(".tl-nub"))
          : [],
        tips: tipsRef.current
          ? Array.from(tipsRef.current.querySelectorAll<HTMLElement>(".tl-tip"))
          : [],
        labels: Array.from(labelsWrap.querySelectorAll<HTMLElement>(".tl-label")),
        years: yearsRef.current
          ? Array.from(yearsRef.current.querySelectorAll<HTMLElement>(".tl-year"))
          : [],
        yearsRoot: yearsRef.current,
        listItems: listRef.current
          ? Array.from(listRef.current.querySelectorAll<HTMLElement>(".dial-list-item"))
          : [],
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
        {/* the dialog name — kept for assistive tech only; the visible top-left masthead
            (eyebrow + plate + live readout) is intentionally gone (req 1). */}
        <h2 id="projects-tl-title" className="sr-only">
          Selected work, 2014 to 2040
        </h2>

        {/* the focus scrim — a soft top/bottom legibility wash plus a spotlight pool the
            rAF loop holds static at centre (no moon to track now). */}
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

        {/* the plot layer — the minimal baseline, then one straight vertical branch per project,
            welded each frame by the loop. All hairline mono off-white, like the globe filaments
            (req 2/4). pointer-events off so the canvas stays a drag surface. */}
        <svg className="projects-tl-svg" ref={svgRef} aria-hidden="true">
          <defs>
            {/* the line fades to nothing at both ends so the baseline bleeds into the dark
                rather than stopping at a hard cap. userSpaceOnUse needs ABSOLUTE coords
                (percentages are out of spec here), so the rAF loop sets x2 to the live canvas
                width each frame and the 8%/92% stops track the viewport. */}
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
              <stop offset="0.18" stopColor="var(--c-line)" stopOpacity="1" />
              <stop offset="0.82" stopColor="var(--c-line)" stopOpacity="1" />
              <stop offset="1" stopColor="var(--c-line)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* the minimal baseline (the fixed horizon) — solid across the delivered past */}
          <line className="tl-axis" ref={axisRef} x1="0" y1="0" x2="0" y2="0" />
          {/* the DASHED future continuation — the calm road ahead (SPLIT "now" → 2040). Dashed +
              faint so the delivered past reads solid and the future reads "yet to be drawn". */}
          <line className="tl-axis-future" ref={axisFutureRef} x1="0" y1="0" x2="0" y2="0" />
          {/* one straight vertical branch per project */}
          <g>
            {PROJECTS.map((p) => (
              <path className="tl-branch" key={`branch-${p.id}`} d="" />
            ))}
          </g>
        </svg>

        {/* the "now" horizon — a faint vertical tick + caption the loop places at the SPLIT, marking
            where the dense delivered past hands off to the forward-looking 2040 tail. */}
        <div className="tl-now" ref={nowRef} aria-hidden="true">
          <span className="tl-now-cap">now</span>
        </div>

        {/* the foot nubs — a small SQUARE node at each line's root on the baseline, the same as the
            tip nubs (no glow, no screen-blend). Loop-positioned (req 4). */}
        <div className="tl-nubs" ref={nubsRef} aria-hidden="true">
          {PROJECTS.map((p) => (
            <span className="tl-nub" key={`nub-${p.id}`} />
          ))}
        </div>

        {/* the TIP nubs — an identical small square at the far END of each branch (req 4), loop-
            positioned at the line's live tip, so each hairline is terminated by a tiny node. */}
        <div className="tl-tips" ref={tipsRef} aria-hidden="true">
          {PROJECTS.map((p) => (
            <span className="tl-tip" key={`tip-${p.id}`} />
          ))}
        </div>

        {/* the year ruler — a faint date legend, positioned by the loop each frame (so it tracks
            the mobile zoom + pan), sitting just below the baseline. */}
        <div className="tl-years" ref={yearsRef} aria-hidden="true">
          {TIMELINE_TICKS.map((y) => (
            <span className={y > 2026 ? "tl-year is-future" : "tl-year"} key={`year-${y}`}>
              {y}
            </span>
          ))}
        </div>

        {/* the label layer — each project is a positioned button (its own hit target). NAME ONLY:
            the short label the rAF loop lays out HORIZONTAL + LEFT-ALIGNED, in a per-cluster column to
            the RIGHT of that cluster's lines, stacked at the line tip heights (req 2/3). The selected
            one brightens to the amber accent; a mouse over EITHER the line or its name lights both
            together (req 3), so the far-right name's line is discoverable. The full record (date,
            place) stays in the aria-label. */}
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
              // mouse-only: lighting the line follows the cursor over the name (touch uses selection)
              onPointerEnter={(e) => e.pointerType === "mouse" && onHover(i)}
              onPointerLeave={(e) => e.pointerType === "mouse" && onHover(-1)}
            >
              <span className="tl-label-name">{p.short}</span>
            </button>
          ))}
        </div>

        {/* a compact vertical list — kept in the DOM as a non-visual fallback, but hidden now
            that the timeline itself runs on mobile (req 7). Tapping a row still routes a selection
            through the same path. */}
        <div className="dial-list" ref={listRef} role="list" aria-label="Projects, 2014 to 2040">
          {PROJECTS.map((p, i) => (
            <button
              type="button"
              className="dial-list-item"
              key={p.id}
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
