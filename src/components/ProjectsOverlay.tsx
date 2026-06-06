import { forwardRef, useLayoutEffect, useRef } from "react";
import { motion } from "motion/react";
import { PROJECTS, formatMonthYearLong } from "../data/projects";

/* =========================================================================
   ProjectsOverlay — "The Dial".

   NOT a frosted modal. A transparent layer welded over the LIVE globe: as the
   Projects view opens, the GPU globe parks to the LEFT and its chaotic filaments
   CALM, while ~20 organized project lines fan OUT to the right from its rim — the
   selected project resting horizontally at 3 o'clock, neighbours arcing up/down,
   the far ones wrapping around the back and hidden. Dragging the globe (a rotary
   knob) scrolls projects through the selected slot.

   This component renders only a STATIC skeleton (the masthead, the close control,
   the 20 spoke/label nodes, the mobile list, an aria-live region). All per-frame
   geometry — the spoke endpoints, label transforms/opacity, the selected highlight,
   the live readout — is written imperatively by the rAF loop in RidgelineStage
   (`updateDial`), exactly like the survey callouts and the letter cloud, so nothing
   re-renders React during interaction and the fan stays welded to the projected
   (panned) globe. The loop reaches our DOM through `domRef`; selecting a project
   (click / mobile tap / the loop's keyboard stepping) routes through `onSelect`.

   Same Inter / --mono / tracked-caps grammar as the site headers; warm-dusk ink,
   amber only as the sparing "you-are-here" accent on the selected node + date.
   ========================================================================= */

const EASE = [0.22, 1, 0.36, 1] as const;
const TOTAL = PROJECTS.length;

/** the live DOM handles the RidgelineStage rAF loop welds each frame */
export type ProjectsDialDom = {
  root: HTMLDivElement | null;
  lines: SVGLineElement[];
  nodes: SVGCircleElement[];
  glows: SVGCircleElement[];
  labels: HTMLElement[];
  listItems: HTMLElement[];
  plate: HTMLElement | null;
  live: HTMLElement | null; // masthead "title · place" readout
  liveRegion: HTMLElement | null; // visually-hidden aria-live announcer
};

type Props = {
  onClose: () => void;
  /** the loop reads this each frame to weld the spokes/labels to the globe */
  domRef: React.MutableRefObject<ProjectsDialDom | null>;
  /** select a project (click a label / tap a list row) — routed into the loop */
  onSelect: (i: number) => void;
};

const yy = (date: string) => `'${date.slice(2, 4)}`; // "2025-04" → "'25"

const ProjectsOverlay = forwardRef<HTMLButtonElement, Props>(
  function ProjectsOverlay({ onClose, domRef, onSelect }, closeButtonRef) {
    const rootRef = useRef<HTMLDivElement>(null);
    const svgRef = useRef<SVGSVGElement>(null);
    const labelsRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const plateRef = useRef<HTMLSpanElement>(null);
    const liveRef = useRef<HTMLSpanElement>(null);
    const announceRef = useRef<HTMLDivElement>(null);

    // hand the rAF loop our live DOM nodes once mounted (mirrors the charEls wiring);
    // detach on unmount so the loop stops welding a vanished tree.
    useLayoutEffect(() => {
      const svg = svgRef.current;
      const labelsWrap = labelsRef.current;
      if (!svg || !labelsWrap) return;
      domRef.current = {
        root: rootRef.current,
        lines: Array.from(svg.querySelectorAll<SVGLineElement>(".dial-line")),
        nodes: Array.from(svg.querySelectorAll<SVGCircleElement>(".dial-node")),
        glows: Array.from(svg.querySelectorAll<SVGCircleElement>(".dial-node-glow")),
        labels: Array.from(labelsWrap.querySelectorAll<HTMLElement>(".dial-label")),
        listItems: listRef.current
          ? Array.from(listRef.current.querySelectorAll<HTMLElement>(".dial-list-item"))
          : [],
        plate: plateRef.current,
        live: liveRef.current,
        liveRegion: announceRef.current,
      };
      return () => {
        domRef.current = null;
      };
    }, [domRef]);

    // trap Tab inside the dialog (the focusable set is just the close control + the
    // single roving-tabbable selected label, or the mobile list rows); arrows / Home /
    // End / Escape are owned by the RidgelineStage window key handler (they step the knob).
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
        className="projects-dial-root"
        role="dialog"
        aria-modal="true"
        aria-labelledby="projects-dial-title"
        onKeyDown={onRootKeyDown}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.4, ease: EASE }}
      >
        {/* the whisper-soft top+bottom scrim (keeps the live globe clear in the middle) */}
        <div className="projects-dial-frost" aria-hidden="true" />

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
        <div className="projects-dial-masthead">
          <p className="projects-dial-eyebrow">Selected work · 2014–2026</p>
          <h2 id="projects-dial-title" className="projects-dial-title">
            Projects
          </h2>
          <p className="projects-dial-coords">
            <span className="plate" ref={plateRef}>
              PLATE 01 / {String(TOTAL).padStart(2, "0")}
            </span>
            <span> · </span>
            <span className="live" ref={liveRef}>
              {PROJECTS[0].title.toUpperCase()} · {PROJECTS[0].place.toUpperCase()}
            </span>
          </p>
        </div>

        {/* the spoke layer — geometry welded each frame (desktop fan) */}
        <svg className="projects-dial-svg" ref={svgRef} aria-hidden="true">
          {PROJECTS.map((p) => (
            <g key={p.id}>
              <line className="dial-line" x1="0" y1="0" x2="0" y2="0" />
              <circle className="dial-node-glow" cx="0" cy="0" r="9" />
              <circle className="dial-node" cx="0" cy="0" r="3" />
            </g>
          ))}
        </svg>

        {/* the label layer — each project is a positioned button (its own hit target).
            The compact name shows at rest; the selected one blooms to the full record. */}
        <div className="projects-dial-labels" ref={labelsRef}>
          {PROJECTS.map((p, i) => (
            <button
              type="button"
              className="dial-label"
              key={p.id}
              // the rAF loop is the SOLE owner of the desktop roving tabindex (it sets the
              // selected label to 0 and the rest to -1 every frame), so start them all at -1 —
              // that way reopening to a non-zero selection never tab-targets project 1 for a frame.
              tabIndex={-1}
              aria-label={`Project ${i + 1} of ${TOTAL}: ${p.title}, ${formatMonthYearLong(p.date)}, ${p.place}`}
              onClick={() => onSelect(i)}
            >
              <span className="dial-label-short">
                {p.short} {yy(p.date)}
              </span>
              <span className="dial-label-title">{p.title}</span>
              <span className="dial-label-desc">{p.descriptor}</span>
              <span className="dial-label-meta">
                <span className="place">{p.place}</span>
                <span className="dot">·</span>
                <span className="date">{formatMonthYearLong(p.date)}</span>
              </span>
            </button>
          ))}
        </div>

        {/* the mobile fallback — a compact vertical list (the fan needs width). Tapping
            a row still spins the GPU globe via the same selection path. */}
        <div className="dial-list" ref={listRef} role="list" aria-label="Projects, 2014 to 2026">
          {PROJECTS.map((p, i) => (
            <button
              type="button"
              className="dial-list-item"
              key={p.id}
              onClick={() => onSelect(i)}
              aria-label={`Project ${i + 1} of ${TOTAL}: ${p.title}, ${formatMonthYearLong(p.date)}, ${p.place}`}
            >
              <span className="short">{p.short}</span>
              <span className="year">{yy(p.date)}</span>
            </button>
          ))}
        </div>

        {/* polite screen-reader announcement of the selected project (loop-written) */}
        <div className="dial-live" aria-live="polite" ref={announceRef} />
      </motion.div>
    );
  },
);

export default ProjectsOverlay;
