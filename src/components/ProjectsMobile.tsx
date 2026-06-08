import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { PROJECTS, formatMonthYearLong } from "../data/projects";

/* =========================================================================
   ProjectsMobile — the phone-native Projects view: a TUNING DIAL.

   The desktop "Survey Line" is a wide horizontal skyline scrubbed with a cursor —
   unreadable squeezed onto a portrait phone. So on a narrow screen we don't shrink
   it; we turn it into an instrument you spin with your thumb: every project is a
   TICK fanned along one graceful arc (the timeline, curved), the whole dial rotating
   left/right under your finger with flick-momentum and a detent at each project. The
   project that rides up to the APEX (top-centre) is selected — its tick grows and
   lights amber, rising toward its NAME above the dial; its full record (date · place ·
   what it was · the stack) reads in a panel pinned at the very bottom. Same dark +
   hairline + amber language as the rest of the site, re-cut for the thumb.

   Mounted INSTEAD of ProjectsOverlay below the 860px breakpoint (RidgelineStage picks
   which). Self-contained — its own rAF spins the dial; no globe/skyline bridge (the
   desktop loop's updateTimeline self-guards on the now-null dialDomRef), it simply
   covers the folded globe with its own dark sheet.
   ========================================================================= */

const N = PROJECTS.length;
const EASE = [0.22, 1, 0.36, 1] as const;

// ---- dial geometry / physics --------------------------------------------------
const STEP = (8.5 * Math.PI) / 180; // angular gap between neighbouring projects
const CULL = (47 * Math.PI) / 180; // hide ticks past this angle from the apex
const WIN = Math.ceil(CULL / STEP) + 1; // index half-window kept positioned each frame
const MAX_VEL = 17; // cap on a release flick (projects/sec)
const V_SNAP = 0.55; // below this speed the dial eases to the nearest detent
const MOM_TAU = 0.52; // momentum decay time-constant
const SNAP_TAU = 0.12; // detent / goto ease time-constant

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// the R&D probes carry a "Below-axis …" descriptor — that's the DESKTOP plot's
// language (studies hanging below the skyline). Meaningless on a card, so strip it.
const cleanDescriptor = (d: string): string => {
  const s = d.replace(/^below-axis\s+/i, "").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// the newest flagship — a strong project to open the dial on (≈ "now")
const OPEN_INDEX = (() => {
  for (let i = N - 1; i >= 0; i--) if (PROJECTS[i].major) return i;
  return N - 1;
})();

type Props = {
  onClose: () => void;
};

const ProjectsMobile = forwardRef<HTMLButtonElement, Props>(
  function ProjectsMobile({ onClose }, closeRef) {
    const reduce = useReducedMotion();
    const rootRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const ticksRef = useRef<HTMLDivElement>(null);
    const arcPathRef = useRef<SVGPathElement>(null);
    const arcGradRef = useRef<SVGLinearGradientElement>(null);

    const [selected, setSelected] = useState(OPEN_INDEX);
    const p = PROJECTS[selected];

    // ---- imperative loop state (refs so spinning never re-renders React) ----
    const angle = useRef(OPEN_INDEX); // fractional selected index (the rotation)
    const vel = useRef(0); // projects/sec
    const goal = useRef<number | null>(null); // a prev/next/keyboard target to ease to
    const selIdx = useRef(OPEN_INDEX); // last committed detent (mirrors `selected`)
    const ppp = useRef(46); // px of horizontal drag per project (set from R each frame)
    const drag = useRef({ active: false, startX: 0, startAngle: 0, lastX: 0, lastT: 0 });
    const win = useRef({ lo: -1, hi: -1 });
    const lastW = useRef(-1);
    const lastDrawn = useRef(NaN); // skip the per-tick rewrite when nothing moved

    // a soft detent tick on selection change (mobile only, never under reduced motion)
    const buzz = () => {
      if (!reduce && typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(7);
    };

    useEffect(() => {
      const stage = stageRef.current;
      const ticksWrap = ticksRef.current;
      if (!stage || !ticksWrap) return;
      const tickEls = Array.from(ticksWrap.querySelectorAll<HTMLElement>(".pmd-tick"));
      if (tickEls.length !== N) return;

      let raf = 0;
      let prev = performance.now();
      let started = false;

      const applySelClass = (next: number, prevSel: number) => {
        tickEls[prevSel]?.classList.remove("is-selected");
        tickEls[next]?.classList.add("is-selected");
      };
      applySelClass(selIdx.current, selIdx.current);

      const frame = (now: number) => {
        const dt = Math.min((now - prev) / 1000, 0.05);
        prev = now;

        const W = stage.clientWidth;
        const H = stage.clientHeight;
        if (!W || !H) {
          raf = requestAnimationFrame(frame);
          return;
        }
        // wheel geometry: a big circle centred far below the stage, its TOP arc the
        // visible curve. Apex (selection point) sits low in the stage so the ticks
        // have room to rise UP toward the name above.
        const R = clamp(W * 0.96, 320, 520);
        const apexY = H * 0.82;
        const cx = W / 2;
        const cy = apexY + R;
        ppp.current = R * STEP;
        const selLen = clamp(H * 0.34, 120, 184); // the selected tick's reach toward the name

        // publish the apex + selected-reach to CSS so the name / year / needle line up
        stage.style.setProperty("--apex-x", `${cx.toFixed(1)}px`);
        stage.style.setProperty("--apex-y", `${apexY.toFixed(1)}px`);
        stage.style.setProperty("--sel-len", `${selLen.toFixed(1)}px`);

        // redraw the arc curve only when the width changes (it's angle-independent)
        if (W !== lastW.current) {
          lastW.current = W;
          let d = "";
          for (let sx = -24; sx <= W + 24; sx += 12) {
            const under = R * R - (sx - cx) * (sx - cx);
            const sy = under > 0 ? cy - Math.sqrt(under) : apexY;
            d += (d ? " L" : "M") + `${sx.toFixed(1)},${sy.toFixed(1)}`;
          }
          arcPathRef.current?.setAttribute("d", d);
          arcGradRef.current?.setAttribute("x2", `${W.toFixed(0)}`);
        }

        // ---- dynamics: drag is applied in the pointer handlers; here we run the
        // release momentum, then the detent (or a prev/next/keyboard goal) ease.
        let a = angle.current;
        if (!drag.current.active) {
          if (goal.current != null) {
            const g = goal.current;
            a += (g - a) * (1 - Math.exp(-dt / SNAP_TAU));
            if (Math.abs(g - a) < 0.001) {
              a = g;
              goal.current = null;
            }
            vel.current = 0;
          } else if (Math.abs(vel.current) > V_SNAP) {
            a += vel.current * dt;
            vel.current *= Math.exp(-dt / MOM_TAU);
          } else {
            vel.current = 0;
            const target = clamp(Math.round(a), 0, N - 1);
            a += (target - a) * (1 - Math.exp(-dt / SNAP_TAU));
            if (Math.abs(target - a) < 0.0006) a = target;
          }
          a = clamp(a, 0, N - 1);
          angle.current = a;
        }

        // commit the detent → React (only on change: drives the name / year / panel)
        const sel = clamp(Math.round(a), 0, N - 1);
        if (sel !== selIdx.current) {
          applySelClass(sel, selIdx.current);
          selIdx.current = sel;
          setSelected(sel);
          buzz();
        }

        // idle: nothing moved and we've drawn this pose — skip the tick rewrite
        if (started && a === lastDrawn.current && !drag.current.active && goal.current == null) {
          raf = requestAnimationFrame(frame);
          return;
        }
        lastDrawn.current = a;
        started = true;

        // ---- lay the visible window of ticks along the arc; hide the ones that left
        const lo = clamp(Math.floor(a) - WIN, 0, N - 1);
        const hi = clamp(Math.ceil(a) + WIN, 0, N - 1);
        const prevWin = win.current;
        if (prevWin.lo >= 0) {
          for (let i = prevWin.lo; i <= prevWin.hi; i++) {
            if (i < lo || i > hi) tickEls[i].style.display = "none";
          }
        }
        for (let i = lo; i <= hi; i++) {
          const theta = (i - a) * STEP;
          const ad = Math.abs(theta);
          const el = tickEls[i];
          if (ad > CULL) {
            el.style.display = "none";
            continue;
          }
          const x = cx + R * Math.sin(theta);
          const y = cy - R * Math.cos(theta);
          const u = ad / CULL; // 0 at apex → 1 at the cull edge
          const s = lerp(1, 0.46, u * u); // perspective shrink toward the rim
          const op = Math.max(0, 1 - u * u * 1.08);
          const deg = (theta * 180) / Math.PI;
          el.style.display = "";
          el.style.opacity = op.toFixed(3);
          el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${deg.toFixed(2)}deg) scale(${s.toFixed(3)})`;
        }
        win.current = { lo, hi };

        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      return () => cancelAnimationFrame(raf);
      // run once: the loop owns its own state via refs
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ---- pointer: drag to spin (pointer capture keeps the gesture if it leaves) ----
    const onPointerDown = (e: React.PointerEvent) => {
      try {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        /* some pointer types reject capture — the gesture still works without it */
      }
      drag.current = {
        active: true,
        startX: e.clientX,
        startAngle: angle.current,
        lastX: e.clientX,
        lastT: performance.now(),
      };
      vel.current = 0;
      goal.current = null;
    };
    const onPointerMove = (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d.active) return;
      const dx = e.clientX - d.startX;
      angle.current = clamp(d.startAngle - dx / ppp.current, 0, N - 1);
      const now = performance.now();
      const dtt = (now - d.lastT) / 1000;
      if (dtt > 0) {
        const inst = -((e.clientX - d.lastX) / ppp.current) / dtt;
        vel.current = vel.current * 0.6 + inst * 0.4;
        d.lastX = e.clientX;
        d.lastT = now;
      }
    };
    const onPointerUp = () => {
      const d = drag.current;
      if (!d.active) return;
      d.active = false;
      vel.current = clamp(vel.current, -MAX_VEL, MAX_VEL);
    };

    // prev (older) / next (newer) — eased steps; also the keyboard arrows
    const goTo = (i: number) => {
      goal.current = clamp(i, 0, N - 1);
      vel.current = 0;
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        goTo(selIdx.current + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goTo(selIdx.current - 1);
      } else if (e.key === "Tab") {
        // trap focus inside the dialog
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
      }
    };

    const year = useMemo(() => p.date.slice(0, 4), [p.date]);

    return (
      <motion.div
        ref={rootRef}
        className="pmd-root"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pmd-title"
        onKeyDown={onKeyDown}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.32, ease: EASE }}
      >
        <h2 id="pmd-title" className="sr-only">
          Selected work, 2014 to 2026 — turn the dial to choose a project
        </h2>

        {/* head — sits below the site header (wordmark + Menu stay live above it) */}
        <div className="pmd-head">
          <div className="pmd-eyebrow">
            <span className="pmd-kicker">Selected work</span>
            <span className="pmd-count">
              {N} projects · 2014–26
            </span>
          </div>
          <button
            type="button"
            className="pmd-close"
            ref={closeRef}
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
        </div>

        {/* the dial stage — the drag surface; ticks are positioned imperatively */}
        <div
          className="pmd-stage"
          ref={stageRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {/* the year, big and ghostly, sitting behind the selected name */}
          <span className="pmd-ghost-year" aria-hidden="true">
            {year}
          </span>

          {/* the selected project NAME, pinned above the apex where the lit tick points.
              The wrapper owns the centring transform; the inner span owns the entrance
              (so Motion's animated transform never clobbers the −50% centring). */}
          <div className="pmd-selname" aria-hidden="true">
            <motion.span
              key={selected}
              className="pmd-selname-text"
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.34, ease: EASE }}
            >
              {p.title}
            </motion.span>
          </div>

          {/* the curve + the fanned ticks */}
          <svg className="pmd-arc" aria-hidden="true">
            <defs>
              <linearGradient
                id="pmd-arc-fade"
                ref={arcGradRef}
                gradientUnits="userSpaceOnUse"
                x1="0"
                y1="0"
                x2="0"
                y2="0"
              >
                <stop offset="0" stopColor="var(--ink)" stopOpacity="0" />
                <stop offset="0.16" stopColor="var(--ink)" stopOpacity="0.5" />
                <stop offset="0.84" stopColor="var(--ink)" stopOpacity="0.5" />
                <stop offset="1" stopColor="var(--ink)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path className="pmd-arc-path" ref={arcPathRef} d="" />
          </svg>

          <div className="pmd-ticks" ref={ticksRef} aria-hidden="true">
            {PROJECTS.map((pr) => (
              <span
                className={pr.major ? "pmd-tick is-major" : "pmd-tick"}
                key={pr.id}
                style={{ display: "none" }}
              >
                <i className="pmd-spoke" />
                <i className="pmd-dot" />
              </span>
            ))}
          </div>

          {/* the fixed selection needle at the apex (the "you are here" of the dial) */}
          <span className="pmd-needle" aria-hidden="true" />

          <span className="pmd-hint" aria-hidden="true">
            drag to spin
          </span>
        </div>

        {/* the record of the selected project — pinned at the very bottom, under the dial */}
        <div className="pmd-panel">
          <div className="pmd-panel-nav">
            <button
              type="button"
              className="pmd-step"
              onClick={() => goTo(selIdx.current - 1)}
              disabled={selected === 0}
              aria-label="Older project"
            >
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <span className="pmd-counter" aria-live="off">
              {String(selected + 1).padStart(3, "0")}
              <span className="pmd-counter-sep"> / {N}</span>
            </span>
            <button
              type="button"
              className="pmd-step"
              onClick={() => goTo(selIdx.current + 1)}
              disabled={selected === N - 1}
              aria-label="Newer project"
            >
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <motion.div
            key={selected}
            className="pmd-record"
            initial={reduce ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.36, ease: EASE }}
          >
            <div className="pmd-meta">
              <span className={p.major ? "pmd-meta-date is-major" : "pmd-meta-date"}>
                {formatMonthYearLong(p.date)}
              </span>
              <span className="pmd-meta-sep" aria-hidden="true">
                ·
              </span>
              <span className="pmd-meta-place">{p.place}</span>
              {p.major && <span className="pmd-flag">✦ Flagship</span>}
            </div>
            <p className="pmd-desc">{cleanDescriptor(p.descriptor)}</p>
            <ul className="pmd-tags">
              {p.tags.map((t) => (
                <li className="pmd-tag" key={t}>
                  {t}
                </li>
              ))}
            </ul>
          </motion.div>
        </div>

        {/* polite SR announcement of the selected project */}
        <div className="pmd-live" aria-live="polite">
          {p.title}, {formatMonthYearLong(p.date)}, {p.place}
        </div>
      </motion.div>
    );
  },
);

export default ProjectsMobile;
