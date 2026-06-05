import { forwardRef, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { STATIONS } from "../data/stations";

/* =========================================================================
   RoleOverlay — the focused "surveyor's dossier" that replaces the old glass
   rail when a career slice is clicked.

   A full-screen liquid-glass sheet: the lit mountain slice reads through a LIGHT
   frost on the left (the highlighted plate, framed with corner ticks), while the
   written record sits on a HEAVY frost on the right and scrolls. The clear/frost
   split is a masked backdrop-filter (see .role-frost in index.css), so the
   highlight is genuinely sharper than its surround. Prev / next walk the career
   without returning to the mountain; ✕ / Escape / clicking the plate dismiss.

   It is the canvas for the long-form story — pictures, clips, interactive code —
   so the body is intentionally roomy and easy to extend (see data/stations.ts).
   ========================================================================= */

const EASE = [0.22, 1, 0.36, 1] as const;

type Props = {
  index: number;
  onClose: () => void;
  onNavigate: (i: number) => void;
};

const RoleOverlay = forwardRef<HTMLButtonElement, Props>(function RoleOverlay(
  { index, onClose, onNavigate },
  closeButtonRef,
) {
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const s = STATIONS[index];
  const d = s.detail;
  const plate = String(index + 1).padStart(2, "0");
  const total = String(STATIONS.length).padStart(2, "0");

  // newest sits at the top of the list, so "newer" climbs the index down and
  // "older" walks it up. Guard the ends so the arrows only show where they lead.
  const newer = index > 0 ? index - 1 : null;
  const older = index < STATIONS.length - 1 ? index + 1 : null;

  // trap Tab inside the dialog so focus can't wander onto the dimmed scene behind.
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

  const copyCode = async () => {
    if (!d.code) return;
    try {
      await navigator.clipboard.writeText(d.code.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the code is still selectable */
    }
  };

  // motion: the sheet fades up and the dossier lines stagger down the masthead
  // spine. reduced-motion collapses it all to a plain cross-fade.
  const sheet = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
      };
  const stagger = {
    hide: {},
    show: { transition: { staggerChildren: 0.055, delayChildren: 0.14 } },
  };
  const item = reduce
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
      key="role-overlay"
      ref={rootRef}
      className="role-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="role-title"
      onKeyDown={onKeyDown}
      transition={{ duration: reduce ? 0.3 : 0.5, ease: EASE }}
      {...sheet}
    >
      {/* heavy frost, masked to the LEFT so the highlighted slice on the open RIGHT
          two-fifths stays the least-blurred thing on screen */}
      <div className="role-frost" aria-hidden="true" />

      {/* close — kept as the predictable top-right control (Escape also closes) */}
      <button
        type="button"
        className="role-close"
        ref={closeButtonRef}
        onClick={onClose}
        aria-label="Close"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      {/* the dossier — scrolls independently on the frosted right flank */}
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
            variants={item}
            onClick={onClose}
            aria-label="Back to the ridgeline"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M11 5l-6 7 6 7M5 12h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back to the ridgeline
          </motion.button>
          <motion.p className="role-eyebrow" variants={item}>
            {s.label}
          </motion.p>
          <motion.h2 id="role-title" className="role-title" variants={item}>
            {s.role}
          </motion.h2>
          <motion.p className="role-coords" variants={item}>
            PLATE {plate}/{total} · R{s.radius}
          </motion.p>
          <motion.p className="role-summary" variants={item}>
            {d.summary}
          </motion.p>

          <motion.ul className="role-tools" variants={item} aria-label="Tools and standards">
            {d.tools.map((t) => (
              <li className="role-chip" key={t}>
                {t}
              </li>
            ))}
          </motion.ul>

          {d.highlights.length > 0 && (
            <motion.div className="role-section" variants={item}>
              <h3 className="role-h">What I did</h3>
              <ul className="role-highlights">
                {d.highlights.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </motion.div>
          )}

          {d.media.length > 0 && (
            <motion.div className="role-section role-section--wide" variants={item}>
              <h3 className="role-h">Gallery</h3>
              <div className="role-plates">
                {d.media.map((m, i) => (
                  <figure className="role-media" key={i}>
                    {m.src ? (
                      m.kind === "video" ? (
                        <video className="role-media-fill" src={m.src} poster={m.poster} controls playsInline />
                      ) : (
                        <img className="role-media-fill" src={m.src} alt={m.alt} loading="lazy" />
                      )
                    ) : (
                      <span className="role-media-empty" aria-label={`${m.alt} — coming soon`}>
                        <span className="role-media-frame" aria-hidden="true">
                          <span className="tick tl" />
                          <span className="tick tr" />
                          <span className="tick bl" />
                          <span className="tick br" />
                        </span>
                        <span className="role-media-glyph" aria-hidden="true">
                          {m.kind === "video" ? (
                            <svg viewBox="0 0 24 24" fill="none">
                              <path d="M9 8l8 4-8 4V8z" fill="currentColor" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" fill="none">
                              <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.4" />
                              <circle cx="8.5" cy="10" r="1.6" fill="currentColor" />
                              <path d="M5 17l4.5-4.5L13 16l3-3 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </span>
                        <span className="role-media-tag">
                          {m.kind === "video" ? "VIDEO" : "IMAGE"} · PLATE {plate}-{String(i + 1).padStart(2, "0")}
                        </span>
                      </span>
                    )}
                    <figcaption className="role-media-cap">{m.caption}</figcaption>
                  </figure>
                ))}
              </div>
            </motion.div>
          )}

          {d.code && (
            <motion.div className="role-section" variants={item}>
              <h3 className="role-h">Code</h3>
              <div className="role-code">
                <div className="role-code-bar">
                  <span className="role-code-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="role-code-name">{d.code.filename}</span>
                  <span className="role-code-lang">{d.code.lang}</span>
                  <button type="button" className="role-code-copy" onClick={copyCode}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className="role-code-body">
                  <code>{d.code.code}</code>
                </pre>
                {d.code.note && <p className="role-code-note">{d.code.note}</p>}
              </div>
            </motion.div>
          )}

        </motion.article>

        {/* walk the career without dropping back to the mountain — pinned to the page
            ENDS (Newer far-left, Older far-right) as a full-bleed footer below the
            dossier, outside the left content column so it can span edge to edge. */}
        <motion.nav
          className="role-nav"
          aria-label="Other stations"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
          transition={{ duration: reduce ? 0.4 : 0.55, ease: EASE, delay: 0.3 }}
        >
          <button
            type="button"
            className="role-nav-btn"
            disabled={newer === null}
            onClick={() => newer !== null && onNavigate(newer)}
          >
            <span className="role-nav-dir">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Newer
            </span>
            {newer !== null && <span className="role-nav-role">{STATIONS[newer].role}</span>}
          </button>
          <button
            type="button"
            className="role-nav-btn role-nav-btn--end"
            disabled={older === null}
            onClick={() => older !== null && onNavigate(older)}
          >
            <span className="role-nav-dir">
              Older
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            {older !== null && <span className="role-nav-role">{STATIONS[older].role}</span>}
          </button>
        </motion.nav>
      </div>
    </motion.div>
  );
});

export default RoleOverlay;
