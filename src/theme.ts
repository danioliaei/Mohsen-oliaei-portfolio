/* =========================================================================
   theme — the site's dark / light mode.
   The dark theme is the art piece (ivory light on black); the light theme is the
   same drawing printed as ink on paper. State lives in ONE place — the
   `data-theme` attribute on <html> (which index.css keys its tokens off) — and
   is persisted under localStorage "do:theme". index.html applies the attribute
   before first paint (inline script, mirroring currentTheme()); this module owns
   every change after that.

   The OS is deliberately NOT followed: the black frame is the piece, so the page
   is dark unless the viewer explicitly chose the print. No matchMedia
   prefers-color-scheme listener exists anywhere (the only media query here is
   the reduced-motion guard on the crossfade). Motion-free, dependency-free —
   this lands in the eager bundle at well under 1 KB.

   The document / window are touched ONLY inside the exported functions and the
   handlers they register, so importing this module is side-effect free (safe
   for SSR-ish tooling and the node test harness).
   ========================================================================= */

export type Theme = "dark" | "light";

const STORAGE_KEY = "do:theme";
const EVENT = "site:theme";
const TRANSITION_CLASS = "theme-transition"; // index.css: enables the 0.3 s colour transitions while set
const TRANSITION_MS = 380; // held a hair past the 0.3 s CSS transitions so the last property lands inside it
const THEME_COLOR: Record<Theme, string> = { dark: "#000000", light: "#f4f1ea" }; // = --bg per theme

const isTheme = (v: unknown): v is Theme => v === "dark" || v === "light";

/** The theme with no stored choice: always the black frame (the OS preference is ignored on purpose —
 *  an explicit toggle is the only way to the print). */
export function defaultTheme(): Theme {
  return "dark";
}

/** The persisted choice, or null when none / invalid / storage unavailable. */
export function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isTheme(v) ? v : null;
  } catch {
    return null; // private mode / sandboxed storage → no stored preference
  }
}

/** What the page should show right now. The stamped document wins when there is one (the <html>
 *  data-theme attribute is the single owner: the index.html pre-paint script stamps it before first
 *  paint and applyTheme() keeps it current) — so a late subscriber (the lazily-mounted stage, which
 *  seeds its GPU crossfade from this after the WebGPU init) always agrees with what is on screen, even
 *  when storage is blocked and a toggle already happened. Falls back to the stored choice, else dark
 *  (the pre-DOM / node / SSR case, and what the pre-paint script mirrors). */
export function currentTheme(): Theme {
  const stamped = typeof document !== "undefined" ? document.documentElement.dataset.theme : undefined;
  return isTheme(stamped) ? stamped : (storedTheme() ?? defaultTheme());
}

/** Stamp the theme on the document: the data-theme attribute (tokens + color-scheme via CSS) and the
 *  browser-chrome colour. Idempotent — safe to call from several subscribers. */
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLOR[t];
}

let transitionTimer = 0;
/** Arm the 0.3 s CSS colour crossfade for one switch by pulsing the transition class on <html>
 *  (skipped under reduced motion, where the switch snaps like every other motion on the site). */
function pulseTransition(): void {
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cls = document.documentElement.classList;
  cls.add(TRANSITION_CLASS);
  window.clearTimeout(transitionTimer);
  transitionTimer = window.setTimeout(() => cls.remove(TRANSITION_CLASS), TRANSITION_MS);
}

/** Persist (null = forget the choice, i.e. back to the default), apply, and notify subscribers. */
export function setTheme(t: Theme | null): void {
  try {
    if (t === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, t);
  } catch {
    /* storage unavailable — the choice still applies for this page */
  }
  const next = t ?? defaultTheme();
  pulseTransition();
  applyTheme(next);
  window.dispatchEvent(new CustomEvent<Theme>(EVENT, { detail: next }));
}

/** Follow every theme change made through setTheme (the only source of change). Returns unsubscribe. */
export function subscribeTheme(cb: (t: Theme) => void): () => void {
  const onEvent = (e: Event) => cb((e as CustomEvent<Theme>).detail);
  window.addEventListener(EVENT, onEvent);
  return () => window.removeEventListener(EVENT, onEvent);
}
