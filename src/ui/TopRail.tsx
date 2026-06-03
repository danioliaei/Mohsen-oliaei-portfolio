import { ThemeToggle } from "./ThemeToggle";

const LINKEDIN = "https://www.linkedin.com/in/daniol/";

/** Layered-cube mark — a small isometric stack echoing the BIM/wayfinding language. */
function CubeMark() {
  return (
    <svg
      className="brand__mark"
      width="20"
      height="22"
      viewBox="0 0 20 22"
      fill="none"
      aria-hidden="true"
    >
      <path d="M10 1 19 6 10 11 1 6 10 1Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M1 6 10 11 10 21 1 16 1 6Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" opacity="0.7" />
      <path d="M19 6 10 11 10 21 19 16 19 6Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" opacity="0.45" />
    </svg>
  );
}

export function TopRail() {
  return (
    <header className="rail rail--top">
      <a
        className="brand"
        href={LINKEDIN}
        target="_blank"
        rel="noreferrer"
        aria-label="Mohsèn Oliaei on LinkedIn"
      >
        <CubeMark />
        <span className="brand__name">Mohsèn Oliaei</span>
      </a>

      <div className="rail__group">
        <ThemeToggle />
        <a
          className="rail__link label"
          href={LINKEDIN}
          target="_blank"
          rel="noreferrer"
        >
          Contact <span aria-hidden="true">↗</span>
        </a>
      </div>
    </header>
  );
}
