import { forwardRef, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";

/* =========================================================================
   BookOverlay — "Book me", the 1:1 session menu.

   Opened by the "Book me" nav link / #book route. A sibling of AssignmentOverlay:
   the same liquid-glass shell (.role-overlay base frost + the shared .role-close /
   .role-back / .role-* masthead grammar), but laid out as a CENTRED, full-width
   editorial spread rather than the left-anchored dossier — the structure of the
   reference pitch slide reproduced in the site's own voice: a left-set masthead, a
   surveyor "the slow way → one session" instrument axis, then a row of frosted
   session cards. Inter throughout (no second typeface), ivory ink, amber the one
   sparing accent (the entry "Discovery Call" card + every fee), exactly as the rest
   of the piece uses --c-education.

   All copy is first-person sales content, so — like AssignmentOverlay — it lives
   here as static content rather than in a data file. Each card is itself the
   booking affordance: a mailto with the session pre-filled in the subject, so a
   click opens a note already addressed and titled. A quiet email line is the
   fallback.
   ========================================================================= */

const EASE = [0.22, 1, 0.36, 1] as const;

const EMAIL = "mohsenoliaei@outlook.com";

// the four sessions, in the order the visitor reads them. `accent` marks the
// low-commitment entry (the "start here" card) — the one highlighted plate, the
// booking-page answer to the reference slide's singled-out card. `duration` only
// the discovery call carries a clock; the rest are flat-fee deep dives.
type Session = {
  index: string;
  title: string;
  price: string;
  duration?: string;
  desc: string;
  accent?: boolean;
};
const SESSIONS: Session[] = [
  {
    index: "01",
    title: "Discovery Call",
    price: "50",
    duration: "15 min",
    accent: true,
    desc:
      "Not sure which session fits, or whether I'm the right person for your problem? Tell me what you're stuck on and I'll tell you honestly whether and how I can help. No pitch.",
  },
  {
    index: "02",
    title: "Automation Strategy",
    price: "200",
    desc:
      "Wondering what's worth automating and what isn't? A straight, vendor-neutral look at where scripting pays off for your workflow and where it's a time sink.",
  },
  {
    index: "03",
    title: "Tool & Stack Advice",
    price: "200",
    desc:
      "Choosing or rethinking your AEC software? I don't sell any of it, so you get an honest answer on what fits your team and what to skip.",
  },
  {
    index: "04",
    title: "Career Mentoring",
    price: "200",
    desc:
      "For AEC people moving toward computational design or development roles. We'll map what to learn and in what order — and, if you want, sharpen your portfolio and prep you for technical interviews.",
  },
];

// a session click opens an email already addressed + titled with the session name
const mailHref = (title: string) =>
  `mailto:${EMAIL}?subject=${encodeURIComponent(`Booking — ${title}`)}`;

// a small instrument clock glyph for the "slow way" axis (a circle + the two hands)
const Clock = () => (
  <svg className="book-clock" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.2" />
    <path
      d="M8 4.5V8l2.4 1.6"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

type Props = {
  onClose: () => void;
};

const BookOverlay = forwardRef<HTMLButtonElement, Props>(
  function BookOverlay({ onClose }, closeButtonRef) {
    const reduce = useReducedMotion();
    const rootRef = useRef<HTMLDivElement>(null);

    // trap Tab inside the dialog so focus can't wander onto the dimmed scene behind
    // (mirror of AssignmentOverlay's trap).
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
    // to AssignmentOverlay so the two panels read as one instrument.
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
        key="book-overlay"
        ref={rootRef}
        className="role-overlay book-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="book-title"
        onKeyDown={onKeyDown}
        transition={{ duration: reduce ? 0.3 : 0.5, ease: EASE }}
        {...sheet}
      >
        {/* an EVEN heavy frost across the whole frame (not the dossier's left-masked
            split): the content spans the full width here, so the live scene reads as
            a quiet, blurred backdrop behind every card rather than a lit slice. */}
        <div className="book-frost" aria-hidden="true" />

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

        <div className="book-scroll">
          <motion.article
            className="book-doc"
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
              Work with me · one-to-one sessions
            </motion.p>
            <motion.h2 id="book-title" className="role-title" variants={groupItem}>
              Book me
            </motion.h2>
            <motion.p className="role-coords" variants={groupItem}>
              SESSIONS · REMOTE · EUR · BY APPOINTMENT
            </motion.p>

            <motion.p className="role-summary" variants={groupItem}>
              Short, paid, one-to-one sessions — vendor-neutral and to the point. Pick
              the one that fits; if you're not sure, start with a discovery call and
              we'll work out whether I'm the right person for your problem.
            </motion.p>

            {/* the surveyor instrument axis — the reference slide's "many → one"
                scale, reread for booking: hours lost and money spent guessing on the
                left, one short session on the right. Decorative (the lead carries the
                meaning for assistive tech), so the whole strip is aria-hidden. */}
            <motion.div className="book-axis" variants={groupItem} aria-hidden="true">
              <div className="book-axis-stop">
                <div className="book-axis-clocks">
                  <Clock />
                  <Clock />
                  <Clock />
                  <Clock />
                </div>
                <div className="book-axis-coins">€ € € €</div>
                <span className="book-axis-cap">Figuring it out alone</span>
              </div>
              <div className="book-axis-track">
                <span className="book-axis-line" />
                <svg
                  className="book-axis-arrow"
                  viewBox="0 0 12 12"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M3 2l5 4-5 4"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div className="book-axis-stop book-axis-stop--to">
                <div className="book-axis-clocks">
                  <Clock />
                </div>
                <div className="book-axis-coins">€</div>
                <span className="book-axis-cap">One short session</span>
              </div>
            </motion.div>

            <motion.div className="book-section" variants={groupItem}>
              <h3 className="role-h">Sessions</h3>
              <ul className="book-grid">
                {SESSIONS.map((s) => (
                  <li key={s.title}>
                    <a
                      className={`book-card${s.accent ? " book-card--accent" : ""}`}
                      href={mailHref(s.title)}
                      aria-label={`Book the ${s.title} session by email — €${s.price}${
                        s.duration ? `, ${s.duration}` : ""
                      }`}
                    >
                      <div className="book-card-head">
                        {s.accent ? (
                          <span className="book-card-flag">Start here</span>
                        ) : (
                          <span className="book-card-index">{s.index}</span>
                        )}
                        {s.duration && (
                          <span className="book-card-dur">{s.duration}</span>
                        )}
                      </div>
                      <h4 className="book-card-title">{s.title}</h4>
                      <p className="book-card-price">
                        <span className="cur">€</span>
                        {s.price}
                      </p>
                      <p className="book-card-desc">{s.desc}</p>
                      <span className="book-card-cta" aria-hidden="true">
                        Book
                        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path
                            d="M5 12h14M13 6l6 6-6 6"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </motion.div>

            <motion.p className="assign-foot book-foot" variants={groupItem}>
              Sessions are remote and booked over email — pick a card to open a note
              with the session already filled in, or write me directly at{" "}
              <a href={`mailto:${EMAIL}`}>{EMAIL}</a>.
            </motion.p>
          </motion.article>
        </div>
      </motion.div>
    );
  },
);

export default BookOverlay;
