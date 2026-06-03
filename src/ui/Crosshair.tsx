import { useStore } from "../store";

/** Instrument crosshair — "you are here". Goes hot (pink) once descending. */
export function Crosshair() {
  const mode = useStore((s) => s.mode);
  const hot = mode !== "orbit";
  return (
    <div className={`crosshair${hot ? " crosshair--hot" : ""}`} aria-hidden="true">
      <svg width="46" height="46" viewBox="0 0 46 46" fill="none">
        <circle cx="23" cy="23" r="11" stroke="currentColor" strokeWidth="1" opacity="0.5" />
        <path d="M23 2v9M23 35v9M2 23h9M35 23h9" stroke="currentColor" strokeWidth="1" />
        <circle cx="23" cy="23" r="1.6" fill="currentColor" />
      </svg>
    </div>
  );
}
