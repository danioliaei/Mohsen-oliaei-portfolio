import { forwardRef, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import {
  PROJECTS,
  decimalYear,
  formatMonthYear,
  formatMonthYearLong,
  TIME_MIN,
  TIME_MAX,
} from "../data/projects";

/* =========================================================================
   ProjectsOverlay — "The Survey Line".

   A full-screen liquid-glass dialog (a true sibling of AssignmentOverlay): an
   ember datum line drawn across the middle of the frame, from which a wall of
   thin ivory lines rises to art-directed heights — the project record plotted
   on a time axis, the tips tracing a mountain range exactly like the WiFi-SSID
   data-art reference, re-voiced into the warm-dusk surveyor identity.

   The signature interaction: hovering (or focusing) a line lights it, dims its
   neighbours, and drops a 1px amber plumb-line under the point with the date —
   MONTH + YEAR — set VERTICALLY beneath it, reading down the page; the masthead
   coordinate line live-swaps to the same reading. Hover and keyboard focus feed
   one `active` index, so the whole instrument is operable from the keyboard.

   Decoupling, so motion and CSS never fight over the same property:
     · motion owns the ENTRANCE only — the line draw (pathLength) + the staggered
       per-project group fade + the masthead spine.
     · CSS classes (.is-lit / .is-dim) own every HOVER/FOCUS state (stroke, width,
       opacity, node radius) — motion never writes those inline, so the classes win.
   ========================================================================= */

const EASE = [0.22, 1, 0.36, 1] as const;

// the plotted geometry of one project, in measured pixels
type Plot = {
  i: number;
  id: string;
  title: string;
  short: string;
  date: string;
  descriptor: string;
  place: string;
  x: number;
  tipY: number;
  below: boolean;
  stripW: number; // hit-strip width, capped to the nearer neighbour gap (no overlap)
  labelY: number; // resting-label anchor y (tiered apart in dense clusters)
  labelRot: number; // resting-label rotation: 0 upright, ±34 fanned when dense
  labelAnchor: "start" | "middle" | "end";
};

type Geom = {
  w: number;
  h: number;
  padX: number;
  axisY: number;
  pts: Plot[];
  years: number[];
};

type Props = { onClose: () => void };

const ProjectsOverlay = forwardRef<HTMLButtonElement, Props>(
  function ProjectsOverlay({ onClose }, closeButtonRef) {
    const reduce = useReducedMotion();
    const rootRef = useRef<HTMLDivElement>(null);
    const timelineRef = useRef<HTMLDivElement>(null);
    const hitRefs = useRef<Array<HTMLButtonElement | null>>([]);

    const [size, setSize] = useState({ w: 0, h: 0 });
    // hover (pointer) and focus (keyboard) are separate inputs that resolve to a
    // single `active` index, so the lit line + vertical date read identically
    // whether you mouse over a line or tab to it.
    const [hovered, setHovered] = useState<number | null>(null);
    const [focused, setFocused] = useState<number | null>(null);
    const [focusIdx, setFocusIdx] = useState(0); // roving tabindex anchor
    const active = hovered !== null ? hovered : focused;

    // measure the timeline plate (the geometry is all in real pixels — no viewBox
    // scaling, which would shear the strokes and labels) and recompute on resize.
    // useLayoutEffect measures before paint, so the wall never flashes empty.
    useLayoutEffect(() => {
      const el = timelineRef.current;
      if (!el) return;
      const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    // build every project's pixel geometry from the measured size. The tip heights
    // trace the mountain range: positives rise above the ember axis, the two study
    // years hang below it (the central valley).
    const geom: Geom | null = useMemo(() => {
      const { w, h } = size;
      if (!w || !h) return null;
      const padX = Math.max(64, Math.min(0.06 * w, 120));
      const axisY = Math.round(h * 0.5);
      const TOP_PAD = 70;
      const BOT_PAD = 132; // room below the axis for the dropped vertical date
      const AXIS_GAP = 14; // even the shortest tip clears the baseline
      const UP = 0.6 * (axisY - TOP_PAD);
      const DOWN = 0.42 * (h - axisY - BOT_PAD);
      const span = w - 2 * padX;

      const base = PROJECTS.map((p, i) => {
        const frac = (decimalYear(p.date) - TIME_MIN) / (TIME_MAX - TIME_MIN);
        const x = Math.round(padX + frac * span);
        const below = p.elevation < 0;
        const tipY = below
          ? axisY + (AXIS_GAP + -p.elevation * DOWN)
          : axisY - (AXIS_GAP + p.elevation * UP);
        return { ...p, i, x, tipY, below };
      });

      const pts: Plot[] = base.map((p, i) => {
        const gl = i > 0 ? p.x - base[i - 1].x : Infinity;
        const gr = i < base.length - 1 ? base[i + 1].x - p.x : Infinity;
        const nearer = Math.min(gl, gr);
        // hit strip capped to 0.92× the nearer neighbour gap, so two adjacent
        // strips can never overlap (½ + ½ = 0.92·gap < gap); floored so it stays hittable
        const stripW = Math.max(12, Math.min(30, (nearer === Infinity ? 30 : nearer) * 0.92));
        // a "dense" point fans its short label up-diagonally (the reference's
        // overlapping textwall). Flip the fan toward the plate near the right edge,
        // and tier alternate dense neighbours apart so they don't overprint.
        const dense = nearer < 64;
        const rightish = p.x > w - padX - 150;
        const tier = dense ? i % 2 : 0;
        const labelRot = dense ? (rightish ? 34 : -34) : 0;
        const labelAnchor: "start" | "middle" | "end" = labelRot
          ? rightish
            ? "end"
            : "start"
          : "middle";
        const labelY = p.below
          ? p.tipY + 15 + tier * 12
          : p.tipY - 8 - tier * 12;
        return {
          i: p.i,
          id: p.id,
          title: p.title,
          short: p.short,
          date: p.date,
          descriptor: p.descriptor,
          place: p.place,
          x: p.x,
          tipY: p.tipY,
          below: p.below,
          stripW,
          labelY,
          labelRot,
          labelAnchor,
        };
      });

      const years: number[] = [];
      for (let y = Math.ceil(TIME_MIN); y <= Math.floor(TIME_MAX); y++) years.push(y);

      return { w, h, padX, axisY, pts, years };
    }, [size]);

    const yearX = (geom: Geom, y: number) =>
      Math.round(
        geom.padX +
          ((y - TIME_MIN) / (TIME_MAX - TIME_MIN)) * (geom.w - 2 * geom.padX),
      );

    // the imperative "you-are-here" ember pool — a soft amber brightening of the
    // baseline that follows the pointer along the axis. Written straight to a CSS
    // custom property so it never triggers a React render per pointer move.
    const onPointerMove = (e: React.PointerEvent) => {
      const el = timelineRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--pool-x", `${e.clientX - r.left}px`);
      el.style.setProperty("--pool-o", "1");
    };
    const onPointerLeave = () => {
      timelineRef.current?.style.setProperty("--pool-o", "0");
    };

    // roving keyboard navigation across the wall, in date order. Focus drives the
    // same reveal as hover, so Arrow / Home / End walk the survey and the vertical
    // date slides along with the selection.
    const moveFocus = (next: number) => {
      if (!geom) return;
      const n = geom.pts.length;
      const idx = Math.max(0, Math.min(n - 1, next));
      setFocusIdx(idx);
      hitRefs.current[idx]?.focus();
    };

    // Tab is trapped inside the dialog (mirror of AssignmentOverlay); the arrows /
    // Home / End drive the roving selection and are stopped from leaking to the
    // canvas orbit handler beneath. Escape is handled by the parent's key ladder.
    const onKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Tab") {
        const root = rootRef.current;
        if (!root) return;
        const f = root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
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
        return;
      }
      if (!geom) return;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        moveFocus(focusIdx + 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        moveFocus(focusIdx - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        e.stopPropagation();
        moveFocus(0);
      } else if (e.key === "End") {
        e.preventDefault();
        e.stopPropagation();
        moveFocus(geom.pts.length - 1);
      }
    };

    // ---- entrance variants (motion owns these only) -------------------------
    const sheet = {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
    };
    const spine = {
      hide: {},
      show: { transition: { staggerChildren: 0.055, delayChildren: 0.14 } },
    };
    const spineItem = reduce
      ? { hide: { opacity: 0 }, show: { opacity: 1, transition: { duration: 0.4 } } }
      : {
          hide: { opacity: 0, y: 14, filter: "blur(6px)" },
          show: {
            opacity: 1,
            y: 0,
            filter: "blur(0px)",
            transition: { duration: 0.55, ease: EASE },
          },
        };
    const wall = {
      hide: {},
      show: {
        transition: {
          staggerChildren: reduce ? 0 : 0.04,
          delayChildren: reduce ? 0 : 0.5,
        },
      },
    };
    const groupV = reduce
      ? { hide: { opacity: 0 }, show: { opacity: 1, transition: { duration: 0.3 } } }
      : {
          hide: { opacity: 0 },
          show: { opacity: 1, transition: { duration: 0.5, ease: EASE } },
        };
    const drawV = reduce
      ? { hide: { pathLength: 1 }, show: { pathLength: 1 } }
      : {
          hide: { pathLength: 0 },
          show: {
            pathLength: 1,
            transition: { type: "spring", stiffness: 240, damping: 26, mass: 0.7 },
          },
        };

    const total = PROJECTS.length;
    // resolve the active point once; everything (readout, date drop) degrades to the
    // rest state when geometry isn't ready rather than rendering "undefined".
    const ap = active != null && geom ? geom.pts[active] : null;
    const readoutHead =
      active != null
        ? `PLATE ${String(active + 1).padStart(2, "0")} / ${total}`
        : `PLATE — / ${total}`;
    const readoutTail = ap
      ? `${ap.title.toUpperCase()} · ${ap.place.toUpperCase()}`
      : `${total} SURVEYS · 59.33°N 18.07°E`;

    // vertical-date placement for the active point (px, in timeline coords)
    const datePlot = ap;
    const dateY0 = datePlot ? (datePlot.below ? datePlot.tipY : geom!.axisY) : 0;

    return (
      <motion.div
        ref={rootRef}
        className="role-overlay projects-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="projects-title"
        onKeyDown={onKeyDown}
        transition={{ duration: reduce ? 0.3 : 0.5, ease: EASE }}
        {...sheet}
      >
        {/* top + bottom vignette frost (centred timeline → NOT the left-masked
            role-frost). Delayed ramp so the baseline draws over a near-clear scene. */}
        <div className="projects-frost" aria-hidden="true" />

        {/* close — the predictable top-right control (Escape also closes) */}
        <button
          type="button"
          className="role-close"
          ref={closeButtonRef}
          onClick={onClose}
          aria-label="Close"
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

        {/* masthead — the surveyor spine, top-left, in the shared role-* grammar */}
        <motion.div
          className="projects-masthead"
          variants={spine}
          initial="hide"
          animate="show"
        >
          <motion.button
            type="button"
            className="role-back"
            variants={spineItem}
            onClick={onClose}
            aria-label="Back to the mountain"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M11 5l-6 7 6 7M5 12h14"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Back to the mountain
          </motion.button>
          <motion.p className="projects-eyebrow" variants={spineItem}>
            Selected work · 2014–2026
          </motion.p>
          <motion.h2 id="projects-title" className="projects-title" variants={spineItem}>
            Projects
          </motion.h2>
          <motion.p className="projects-coords" variants={spineItem}>
            <span className="projects-coords-head">{readoutHead}</span>
            <span className="projects-coords-sep"> · </span>
            <span className="projects-coords-live" key={active ?? "rest"}>
              {readoutTail}
            </span>
          </motion.p>
        </motion.div>

        {/* the timeline plate — vertically centred (the hero in the middle of the
            screen), with surveyor corner ticks */}
        <div className="projects-stage">
          <div
            className="projects-timeline"
            ref={timelineRef}
            onPointerMove={onPointerMove}
            onPointerLeave={onPointerLeave}
          >
            <span className="tick tl" aria-hidden="true" />
            <span className="tick tr" aria-hidden="true" />
            <span className="tick bl" aria-hidden="true" />
            <span className="tick br" aria-hidden="true" />

            {/* the ember "you-are-here" pool that trails the pointer along the axis */}
            {geom && (
              <div
                className="projects-pool"
                aria-hidden="true"
                style={{ top: geom.axisY - 7 }}
              />
            )}

            {geom && (
              <svg
                className="projects-svg"
                width={geom.w}
                height={geom.h}
                aria-hidden="true"
              >
                {/* ember baseline — the reference's red datum, warm-dusk amber */}
                <motion.line
                  className="projects-baseline"
                  x1={geom.padX}
                  y1={geom.axisY}
                  x2={geom.w - geom.padX}
                  y2={geom.axisY}
                  initial={{ pathLength: reduce ? 1 : 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{
                    duration: reduce ? 0 : 0.6,
                    ease: EASE,
                    delay: reduce ? 0 : 0.15,
                  }}
                />
                {!reduce && (
                  <motion.circle
                    className="projects-baseline-head"
                    cy={geom.axisY}
                    r={3}
                    initial={{ cx: geom.padX, opacity: 0.9 }}
                    animate={{ cx: [geom.padX, geom.w - geom.padX], opacity: [0.9, 0.9, 0] }}
                    transition={{ duration: 0.6, ease: EASE, delay: 0.15 }}
                  />
                )}

                {/* year ticks — the only persistent text below the axis; the lane
                    the vertical date drops into */}
                <motion.g
                  className="projects-axis-ticks"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.6, ease: EASE, delay: reduce ? 0 : 0.7 }}
                >
                  {geom.years.map((y) => (
                    <text
                      key={y}
                      className={`projects-axis-tick${
                        active != null && geom.pts[active]
                          ? Math.abs(yearX(geom, y) - geom.pts[active].x) < 26
                            ? " is-near"
                            : ""
                          : ""
                      }`}
                      x={yearX(geom, y)}
                      y={geom.axisY + 22}
                      textAnchor="middle"
                    >
                      {y}
                    </text>
                  ))}
                </motion.g>

                {/* the wall of lines — staggered draw-on, left → right */}
                <motion.g variants={wall} initial="hide" animate="show">
                  {geom.pts.map((p) => {
                    const lit = active === p.i;
                    const dim = active != null && active !== p.i;
                    const cls = `${lit ? " is-lit" : ""}${dim ? " is-dim" : ""}`;
                    return (
                      <motion.g
                        key={p.id}
                        className={`projects-line-group${cls}`}
                        variants={groupV}
                      >
                        <motion.line
                          className={`projects-line-glow${cls}`}
                          x1={p.x}
                          y1={geom.axisY}
                          x2={p.x}
                          y2={p.tipY}
                          variants={drawV}
                        />
                        <motion.line
                          className={`projects-line${cls}`}
                          x1={p.x}
                          y1={geom.axisY}
                          x2={p.x}
                          y2={p.tipY}
                          variants={drawV}
                        />
                        <circle
                          className={`projects-node-ring${cls}`}
                          cx={p.x}
                          cy={p.tipY}
                          r={6}
                        />
                        <circle
                          className={`projects-node${cls}`}
                          cx={p.x}
                          cy={p.tipY}
                          r={2.5}
                        />
                        <text
                          className={`projects-label${cls}`}
                          x={p.x}
                          y={p.labelY}
                          textAnchor={p.labelAnchor}
                          transform={
                            p.labelRot
                              ? `rotate(${p.labelRot} ${p.x} ${p.labelY})`
                              : undefined
                          }
                        >
                          {p.short}
                        </text>
                      </motion.g>
                    );
                  })}
                </motion.g>

                {/* the plumb-line + the vertical date drop for the active point */}
                <AnimatePresence>
                  {datePlot && (
                    <motion.line
                      key={`leader-${datePlot.id}`}
                      className="projects-date-leader"
                      x1={datePlot.x}
                      y1={dateY0}
                      x2={datePlot.x}
                      y2={dateY0 + 40}
                      initial={{ pathLength: reduce ? 1 : 0, opacity: 0 }}
                      animate={{ pathLength: 1, opacity: 0.65 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: reduce ? 0.2 : 0.3, ease: EASE }}
                    />
                  )}
                </AnimatePresence>
              </svg>
            )}

            {/* the vertical MONTH+YEAR date — DOM, so the rotated mono tracking +
                blur resolve crisply. Only one shows at a time; moving between lines
                cross-dissolves (keyed by the active index). */}
            <AnimatePresence>
              {datePlot && (
                <motion.div
                  key={datePlot.id}
                  className="projects-date-anchor"
                  style={{ left: datePlot.x, top: dateY0 + 48 }}
                  // x:"-50%" centres the column on the line (motion owns transform,
                  // so centring lives here, not in CSS); y/blur play on top.
                  initial={
                    reduce
                      ? { opacity: 0, x: "-50%" }
                      : { opacity: 0, x: "-50%", y: -6, filter: "blur(5px)" }
                  }
                  animate={
                    reduce
                      ? { opacity: 1, x: "-50%" }
                      : { opacity: 1, x: "-50%", y: 0, filter: "blur(0px)" }
                  }
                  exit={
                    reduce
                      ? { opacity: 0, x: "-50%" }
                      : { opacity: 0, x: "-50%", y: -6 }
                  }
                  transition={{ duration: reduce ? 0.2 : 0.34, ease: EASE }}
                >
                  <span className="projects-date">
                    {formatMonthYear(datePlot.date)}
                  </span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* the interaction + accessibility layer: one focusable strip per
                project. Hover and focus both drive `active`; roving tabindex keeps
                tab order short, arrows walk the survey. */}
            {geom && (
              <ul
                className="projects-hits"
                role="list"
                aria-label="Projects, 2014 to 2026, earliest to latest"
              >
                {geom.pts.map((p) => {
                  const top = Math.min(geom.axisY, p.tipY) - 10;
                  const bottom = Math.max(geom.axisY, p.tipY) + 78;
                  return (
                    <li key={p.id} role="listitem">
                      <button
                        type="button"
                        className="projects-hit"
                        ref={(el) => {
                          hitRefs.current[p.i] = el;
                        }}
                        tabIndex={focusIdx === p.i ? 0 : -1}
                        style={{
                          left: p.x - p.stripW / 2,
                          width: p.stripW,
                          top,
                          height: bottom - top,
                        }}
                        aria-label={`Plate ${p.i + 1} of ${total}: ${p.title}, ${formatMonthYearLong(p.date)} — ${p.descriptor}, ${p.place}`}
                        onPointerEnter={() => setHovered(p.i)}
                        onPointerLeave={() => setHovered(null)}
                        onFocus={() => {
                          // most-recent input wins: clear any lingering pointer hover so
                          // keyboard focus drives the lit line + vertical date
                          setHovered(null);
                          setFocused(p.i);
                          setFocusIdx(p.i);
                        }}
                        onBlur={() => setFocused(null)}
                        onClick={() => {
                          setFocused(p.i);
                          setFocusIdx(p.i);
                        }}
                      />
                    </li>
                  );
                })}
              </ul>
            )}

            {/* the survey counter — bottom-right benchmark */}
            <span className="projects-counter" aria-hidden="true">
              {active != null ? String(active + 1).padStart(2, "0") : "—"} / {total}
            </span>
          </div>
        </div>
      </motion.div>
    );
  },
);

export default ProjectsOverlay;
