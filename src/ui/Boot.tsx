import type { CSSProperties } from "react";

export function Boot({
  booted,
  progress,
}: {
  booted: boolean;
  progress: number;
}) {
  return (
    <div className={`boot${booted ? " boot--done" : ""}`} aria-hidden={booted}>
      <div className="boot__inner">
        <div className="label" style={{ color: "var(--ink-dim)", fontSize: 12 }}>
          MOHSÈN OLIAEI
        </div>
        <div
          className="label"
          style={{ marginTop: 8, fontSize: 9.5, color: "var(--ink-faint)" }}
        >
          SAMPLING THE WORLD AS POINTS…
        </div>
        <div
          className="boot__bar"
          style={{ ["--p"]: `${Math.round(progress)}%` } as CSSProperties}
        />
      </div>
    </div>
  );
}
