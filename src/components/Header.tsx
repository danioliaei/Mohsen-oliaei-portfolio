import { useEffect, useRef, useState } from "react";

/* =========================================================================
   Header — a fixed top bar over the black hero, and the expanding FULL-SCREEN
   menu it opens.

   RESPONSIVE (req 1): on DESKTOP the bar is a normal header — the name wordmark
   left, the three primary links (CV · Projects · Book me) inline on the right, and
   NO menu button. On PHONES / narrow screens (≤760px) the inline nav collapses and
   a single "Menu" button opens the full-screen overlay, where EVERYTHING lives. The
   swap is pure CSS (`.header-nav` vs `.menu-btn` at the 760px breakpoint, see
   index.css) — the same markup serves both, so there's no JS branch on width.

   The bar carries no `motion` import on purpose: it's the first thing painted, so
   its entrance is plain CSS (see index.css `header` animation) and the menu's
   open/close + staggered reveal are CSS transitions driven by React state — the
   no-`motion` budget that keeps the eager bundle tiny holds (see HYBRID.md).

   Typography is Hanken Grotesk (--nav), light/regular weights, tight negative
   tracking — see index.css. The menu opens a black overlay that fades + slides
   down, locks page scroll, mirrors the bar (wordmark · Close), and stacks: a few
   LARGE primary links, a search field, a grid of secondary link groups, and the
   © footer. Close via the Close button, the backdrop, or Escape.

   Link targets are wired to the site's real routes: the three large primary links
   are the interactive experiences (#cv / #projects / #book); the secondary groups
   point at the home globe, the about/contact anchors, the CV (where the BIM /
   computational / software / architecture work lives), and external profiles. */

type Link = { label: string; href: string; external?: boolean };

// the primary links — Home (back to the globe) + the site's interactive experiences (req 4)
const PRIMARY: Link[] = [
  { label: "Home", href: "#home" },
  { label: "CV", href: "#cv" },
  { label: "Projects", href: "#projects" },
  { label: "Book me", href: "#book" },
];

// returning Home can't rely on the hash alone: an in-canvas globe tap grows the mountain without
// persisting #cv, so the URL can sit on #home while the CV shows — a #home click then fires no
// hashchange and nothing resets. RidgelineStage listens for this idempotent event and always eases
// back to the globe (closing any overlay). Fired alongside the normal href so the URL stays correct.
const goHome = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("site:home"));
};

// the secondary link groups (one column on mobile, three across on wider screens)
const GROUPS: { title: string; links: Link[] }[] = [
  {
    title: "General",
    // Home now lives in PRIMARY (rendered in both the bar and the overlay), so it's not repeated here
    links: [
      { label: "About", href: "#about" },
      { label: "Contact", href: "#contact" },
    ],
  },
  {
    title: "Focus",
    links: [
      // thematic entry points into the CV mountain, where that work is surveyed
      { label: "Architecture", href: "#cv" },
      { label: "BIM", href: "#cv" },
      { label: "Computational Design", href: "#cv" },
      { label: "Software", href: "#cv" },
    ],
  },
  {
    title: "Connect",
    links: [
      { label: "LinkedIn", href: "https://www.linkedin.com/in/daniol/", external: true },
      { label: "Email", href: "mailto:mohsenoliaei@outlook.com", external: true },
      { label: "Book a session", href: "#book" },
    ],
  },
];

export default function Header() {
  const [open, setOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const openMenu = () => setOpen(true);
  // Close and hand focus back to the bar's "Menu" button — the canonical disclosure
  // dismiss contract, so a keyboard user is never stranded on a link that just went inert.
  const closeMenu = () => {
    setOpen(false);
    menuBtnRef.current?.focus();
  };

  // on open: lock page scroll and move focus into the overlay (its Close control).
  // on close: the effect cleanup restores scroll; closeMenu restores focus.
  useEffect(() => {
    if (!open) return;
    const { style } = document.body;
    const prevOverflow = style.overflow;
    style.overflow = "hidden";
    closeBtnRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
      // trap Tab inside the overlay so focus can't wander onto the inert page beneath
      if (e.key === "Tab") {
        const root = overlayRef.current;
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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // clicking the backdrop (the overlay's own black field, not a link/button) closes it
  const onBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) closeMenu();
  };

  // a staggered fade-up on open; instant on close (delays only apply while open). The
  // running `seq` keeps the increments in document order across the primary links, the
  // search, the groups and the footer.
  let seq = 0;
  const stagger = (): React.CSSProperties => ({
    transitionDelay: open ? `${(0.06 + seq++ * 0.045).toFixed(3)}s` : "0s",
  });
  const tab = open ? 0 : -1;

  return (
    <>
      <header>
        {/* the wordmark IS the home control (req 4) — clicking it eases back to the globe */}
        <a className="wordmark" href="#home" onClick={goHome}>
          Daniel Oliaei
        </a>
        {/* the right cluster: an inline nav on desktop (the three primary experiences),
            and the hamburger "Menu" on phones. CSS hides one or the other at the 760px
            breakpoint — desktop never shows the button, phones never show the inline nav,
            and everything still lives in the full-screen overlay for the phone menu. */}
        <div className="header-right">
          <nav className="header-nav" aria-label="Primary">
            {PRIMARY.map((item) => (
              <a
                key={item.href + item.label}
                href={item.href}
                onClick={item.href === "#home" ? goHome : undefined}
              >
                {item.label}
              </a>
            ))}
          </nav>
          <button
            ref={menuBtnRef}
            type="button"
            className="menu-btn"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls="site-menu"
            onClick={openMenu}
          >
            Menu
          </button>
        </div>
      </header>

      {/* the expanding full-screen menu. aria-hidden + inert tabindex when closed so it
          never traps focus or catches taps behind the live hero. */}
      <div
        ref={overlayRef}
        id="site-menu"
        className={`menu-overlay${open ? " is-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Site menu"
        aria-hidden={!open}
        onClick={onBackdrop}
      >
        {/* onBackdrop on the inner column too: clicks landing on its own padding / the gaps
            between sections (target === the column) close; clicks on a link/button don't */}
        <div className="menu-inner" onClick={onBackdrop}>
          {/* the overlay top bar mirrors the header */}
          <div className="menu-bar">
            <a
              className="wordmark"
              href="#home"
              tabIndex={tab}
              onClick={() => { goHome(); closeMenu(); }}
            >
              Daniel Oliaei
            </a>
            <button
              ref={closeBtnRef}
              type="button"
              className="menu-btn"
              tabIndex={tab}
              onClick={closeMenu}
            >
              Close
            </button>
          </div>

          {/* the large primary links */}
          <nav className="menu-primary" aria-label="Primary">
            {PRIMARY.map((item) => (
              <a
                key={item.href + item.label}
                href={item.href}
                tabIndex={tab}
                style={stagger()}
                onClick={() => { if (item.href === "#home") goHome(); closeMenu(); }}
              >
                {item.label}
              </a>
            ))}
          </nav>

          {/* a transparent, underlined search field (a visual element — no search backend
              yet; the form just no-ops on submit so Enter never reloads the page) */}
          <form
            className="menu-search"
            style={stagger()}
            onSubmit={(e) => e.preventDefault()}
            role="search"
          >
            <input
              type="search"
              placeholder="Search"
              aria-label="Search"
              tabIndex={tab}
              autoComplete="off"
            />
          </form>

          {/* the secondary link groups — one column on mobile, three across when wide */}
          <div className="menu-grid">
            {GROUPS.map((group) => (
              <div className="menu-group" key={group.title} style={stagger()}>
                <h2 className="menu-group-title">{group.title}</h2>
                <ul>
                  {group.links.map((item) => (
                    <li key={item.href + item.label}>
                      <a
                        href={item.href}
                        tabIndex={tab}
                        onClick={() => { if (item.href === "#home") goHome(); closeMenu(); }}
                        {...(item.external
                          ? { target: "_blank", rel: "noopener" }
                          : null)}
                      >
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <p className="menu-foot" style={stagger()}>
            © Daniel Oliaei 2026
          </p>
        </div>
      </div>
    </>
  );
}
