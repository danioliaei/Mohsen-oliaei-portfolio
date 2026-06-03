import { Html } from "@react-three/drei";
import { DIGITAL_PROJECTS } from "../data/world";

/** The screen inside the room — renders the software projects as a live gallery
 *  of real React cards (drei <Html transform>). Each card leaves a clearly
 *  marked slot to embed a live demo per project later (see the TODO below). */
export function Screen() {
  return (
    <Html
      transform
      position={[0, 0.12, -1.32]}
      distanceFactor={1.5}
      occlude={false}
      pointerEvents="auto"
      zIndexRange={[20, 0]}
      className="screen3d"
    >
      <div className="screen">
        <header className="screen__head">
          <span className="label">BIM Development</span>
          <span className="screen__dot" />
          <span className="label screen__muted">tools &amp; automation</span>
        </header>
        <div className="screen__grid">
          {DIGITAL_PROJECTS.map((p) => (
            <article className="screen__card" key={p.id}>
              <div className="screen__card-top">
                <h3>{p.label}</h3>
                <span className="screen__year mono">{p.year}</span>
              </div>
              <p className="screen__role">{p.role}</p>
              <p className="screen__blurb">{p.blurb}</p>
              <div className="screen__stack">{p.stack}</div>
              {/* TODO: embed a live demo per project here (iframe / canvas). */}
              <div className="screen__demo" aria-hidden="true">
                <span>{p.href ? "Open demo ↗" : "Live demo — TODO"}</span>
              </div>
            </article>
          ))}
        </div>
      </div>
    </Html>
  );
}
