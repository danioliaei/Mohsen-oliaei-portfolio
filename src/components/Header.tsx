import { useEffect, useRef, useState } from "react";

const NAV = [
  // Home = the spinning globe of lines & letters; CV = the mountain it assembles
  // into. RidgelineStage listens for these two hashes and morphs between the views.
  { label: "Home", href: "#home" },
  { label: "CV", href: "#cv" },
  { label: "Projects", href: "#projects" },
  { label: "Book me", href: "#book" },
  { label: "About", href: "#about" },
  { label: "Contact", href: "#contact" },
];

/* The header carries no `motion` import on purpose: it's the first thing painted, so its
   entrance (header fade/slide + staggered nav links) is plain CSS (see index.css
   `header` / `nav a` animations). Keeping `motion` out of the eager path lets it live only
   in the lazy RidgelineStage chunk — the initial bundle paints the wordmark/nav without
   downloading the animation library (see HYBRID.md, "code-split"). The per-link stagger is
   the one dynamic bit, set inline to mirror the old `delay: 0.35 + i * 0.08`.

   On phones the inline link row is replaced by a glass "+" disc (the same liquid-glass
   logic as the role-close / beacon controls). It morphs + → × and drops a frosted menu
   panel — all driven by React state + CSS transitions, so the no-`motion` budget holds. */
export default function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Close, and hand focus back to the "+" disc — the canonical menu-button dismiss
  // contract, so a keyboard user is never stranded on a link that just went inert.
  // (For mouse/touch closes this is a harmless no-op; :focus-visible won't paint a ring.)
  const closeMenu = () => {
    setMenuOpen(false);
    toggleRef.current?.focus();
  };

  // Escape closes the menu — mirrors the role overlay's dismissal contract.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <header>
      <a
        className="wordmark"
        href="https://www.linkedin.com/in/daniol/"
        target="_blank"
        rel="noopener"
      >
        Daniel Oliaei
      </a>

      {/* desktop: the inline tracked-caps link row (hidden on phones) */}
      <nav className="nav-desktop">
        {NAV.map((item, i) => (
          <a
            key={item.href}
            href={item.href}
            style={{ animationDelay: `${(0.35 + i * 0.08).toFixed(2)}s` }}
          >
            {item.label}
          </a>
        ))}
      </nav>

      {/* phones: the glass "+" disc + its frosted drop panel (hidden on desktop) */}
      <div className={`nav-mobile${menuOpen ? " is-open" : ""}`}>
        <button
          ref={toggleRef}
          type="button"
          className="menu-toggle"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span className="menu-toggle-icon" aria-hidden="true">
            <span />
            <span />
          </span>
        </button>

        {/* a barely-there frost behind the panel — taps here (outside the panel) close it,
            while the highlighted mountain still reads through */}
        <div className="menu-scrim" aria-hidden="true" onClick={closeMenu} />

        {/* a disclosure panel, not an application menu — so the links stay plain <a>
            (no role="menu"/"menuitem", which would promise arrow-key nav we don't ship).
            aria-hidden when closed drops the inert links out of the accessibility tree. */}
        <div className="menu-panel" id="mobile-menu" aria-hidden={!menuOpen}>
          {NAV.map((item, i) => (
            <a
              key={item.href}
              href={item.href}
              tabIndex={menuOpen ? 0 : -1}
              style={{
                transitionDelay: menuOpen
                  ? `${(0.08 + i * 0.05).toFixed(2)}s`
                  : "0s",
              }}
              onClick={closeMenu}
            >
              {item.label}
            </a>
          ))}
        </div>
      </div>
    </header>
  );
}
