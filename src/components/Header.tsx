const NAV = [
  // Home = the spinning globe of lines & letters; CV = the mountain it assembles
  // into. RidgelineStage listens for these two hashes and morphs between the views.
  { label: "Home", href: "#home" },
  { label: "CV", href: "#cv" },
  { label: "Projects", href: "#projects" },
  { label: "About", href: "#about" },
  { label: "Contact", href: "#contact" },
];

/* The header carries no `motion` import on purpose: it's the first thing painted, so its
   entrance (header fade/slide + staggered nav links) is plain CSS (see index.css
   `header` / `nav a` animations). Keeping `motion` out of the eager path lets it live only
   in the lazy RidgelineStage chunk — the initial bundle paints the wordmark/nav without
   downloading the animation library (see HYBRID.md, "code-split"). The per-link stagger is
   the one dynamic bit, set inline to mirror the old `delay: 0.35 + i * 0.08`. */
export default function Header() {
  return (
    <header>
      <a
        className="wordmark"
        href="https://www.linkedin.com/in/daniol/"
        target="_blank"
        rel="noopener"
      >
        Mohsèn Oliaei
      </a>
      <nav>
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
    </header>
  );
}
