import { forwardRef, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";

/* =========================================================================
   AssignmentOverlay — "Your Assignment?", the client-facing brief.

   The floating "?" datum at the very summit (RidgelineStage's apex beacon) opens
   this panel: a true sibling of RoleOverlay (same two-tier liquid-glass frost, the
   left-anchored editorial column, the surveyor voice — corner-square benchmark
   bullets, mono coordinate line, pill chips, the masthead title scale). Where the
   seven career plates log roles already surveyed, this is PLATE 00 — the blank
   plate above them all, the reading the visitor brings.

   It is the only piece of first-person sales copy on the site, so the words live
   here as static content (not in stations.ts). The single call-to-action routes to
   the site's Contact area and closes the panel; a quiet email line is the fallback.
   ========================================================================= */

const EASE = [0.22, 1, 0.36, 1] as const;

const EMAIL = "mohsenoliaei@outlook.com";

// the six commissions, sourced verbatim from the real roles (stations.ts)
const CAPABILITIES = [
  "BIM strategy & ISO 19650 information management",
  "Revit & Navisworks API automation — custom add-ins in C# / .NET & Python",
  "Clash detection & multidiscipline coordination",
  "Power BI dashboards built from live model data",
  "Computational design — Rhino / Grasshopper, energy & daylight studies",
  "BIM team training & enablement",
];

// the stacks + standards, as hairline pill chips (the instrument read)
const STACK = [
  "C# / .NET",
  "Python",
  "Revit API",
  "Navisworks API",
  "ISO 19650",
  "Power BI",
  "Rhino / Grasshopper",
  "BIM strategy",
];

type Props = {
  onClose: () => void;
  // the CTA uses this instead of onClose: it routes to #contact, so the parent skips
  // pulling focus back to the beacon and lets the contact target own it. Falls back to
  // onClose when not provided.
  onNavigate?: () => void;
};

const AssignmentOverlay = forwardRef<HTMLButtonElement, Props>(
  function AssignmentOverlay({ onClose, onNavigate }, closeButtonRef) {
    const reduce = useReducedMotion();
    const rootRef = useRef<HTMLDivElement>(null);

    // trap Tab inside the dialog so focus can't wander onto the dimmed scene behind
    // (mirror of RoleOverlay's trap).
    const onKeyDown = (e: React.KeyboardEvent) => {
      if (e.key !== "Tab") return;
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
    };

    // the sheet fades up while the masthead spine staggers down — identical grammar
    // to RoleOverlay so the two panels read as one instrument.
    const sheet = {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
    };
    const stagger = {
      hide: {},
      show: { transition: { staggerChildren: 0.055, delayChildren: 0.14 } },
    };
    const groupItem = reduce
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

    return (
      <motion.div
        key="assignment-overlay"
        ref={rootRef}
        className="role-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="assign-title"
        onKeyDown={onKeyDown}
        transition={{ duration: reduce ? 0.3 : 0.5, ease: EASE }}
        {...sheet}
      >
        {/* heavy frost, masked to the LEFT so the lit summit on the open RIGHT stays
            the least-blurred thing on screen (shared with RoleOverlay) */}
        <div className="role-frost" aria-hidden="true" />

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

        <div className="role-scroll">
          <motion.article
            className="role-doc"
            variants={stagger}
            initial="hide"
            animate="show"
          >
            <motion.button
              type="button"
              className="role-back"
              variants={groupItem}
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

            <motion.p className="role-eyebrow" variants={groupItem}>
              Field brief · open commission
            </motion.p>
            <motion.h2 id="assign-title" className="role-title" variants={groupItem}>
              Your Assignment?
            </motion.h2>
            <motion.p className="role-coords" variants={groupItem}>
              PLATE 00/07 · SUMMIT · 59.33°N 18.07°E · STATUS — AWAITING BRIEF
            </motion.p>

            <motion.p className="role-summary" variants={groupItem}>
              You found the benchmark at the very top of the climb. The seven plates
              below it log where I've already surveyed — more than a decade of it,
              Tehran to Gothenburg to Stockholm. This one is still blank, because the
              next reading is yours. Tell me the ground you're standing on and I'll
              tell you what we can build on it. In short: I help teams turn the model
              into the project's most trusted instrument.
            </motion.p>

            <motion.div className="role-section" variants={groupItem}>
              <h3 className="role-h">What I take on</h3>
              <p className="assign-lead">
                Pick the brief that fits. Each one is something I do hands-on, in live
                projects today — not a service page borrowed from somewhere.
              </p>
              <ul className="role-highlights">
                {CAPABILITIES.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <ul className="role-tools" aria-label="Tools and standards">
                {STACK.map((t) => (
                  <li className="role-chip" key={t}>
                    {t}
                  </li>
                ))}
              </ul>
            </motion.div>

            <motion.div className="role-section" variants={groupItem}>
              <h3 className="role-h">How I work</h3>
              <p className="assign-body">
                I start from the decision you're trying to make, then build the
                shortest path from model to answer. I write the standard, build the
                tool that enforces it, and put a dashboard on top so the data argues
                for itself — then I hand it over in a form your team will actually keep
                using. The automation that survives me leaving the room is the only
                kind worth building.
              </p>
            </motion.div>

            <motion.div className="role-section" variants={groupItem}>
              <h3 className="role-h">Where I've done it</h3>
              <p className="assign-body">
                Today I author BIM strategy and Power BI decision dashboards at Stegra,
                a greenfield green-steel megaproject outside Stockholm. Through my own
                studio, Neobuilt AB, I build the bespoke Revit and Navisworks tooling
                that takes the grind out of clash workflows and model QA. Before that I
                held the ISO 19650 information line and led clash coordination at
                Northvolt, and modelled healthcare and energy projects through to IFC
                delivery. M.Sc. Architectural Engineering, Chalmers — based in Sweden,
                working wherever the model lives.
              </p>
            </motion.div>

            <motion.div className="role-section" variants={groupItem}>
              <h3 className="role-h">A good-fit brief</h3>
              <p className="assign-body">
                I'm at my most useful on greenfield or fast-moving builds where the
                information has outgrown the spreadsheet — gigafactories, healthcare,
                green-steel, anywhere dozens of disciplines feed one model. If your
                team is drowning in manual QA, fighting clashes by hand, or flying
                blind without project data, that's squarely what I'm built for.
              </p>
            </motion.div>

            <motion.div className="assign-cta-wrap" variants={groupItem}>
              {/* one action does both: native anchor reaches the (forthcoming)
                  #contact area, and onClose dismisses the panel on the way there */}
              <a className="assign-cta" href="#contact" onClick={onNavigate ?? onClose}>
                Bring me a brief
                <span className="assign-cta-arrow" aria-hidden="true">
                  →
                </span>
              </a>
              <p className="assign-foot">
                No pitch deck required — a sketch and a deadline are enough to start.
                Or reach me directly at{" "}
                <a href={`mailto:${EMAIL}`}>{EMAIL}</a>.
              </p>
            </motion.div>
          </motion.article>
        </div>
      </motion.div>
    );
  },
);

export default AssignmentOverlay;
