import { WORLDS } from "../data/world";
import { useStore } from "../store";

/** Large world title + role subtitle, shown at ORBIT and WORLD; fades out as we
 *  drill deeper. The role names ("BIM Coordination" / "BIM Development") live in
 *  each world's subtitle. */
export function TitlePlate() {
  const mode = useStore((s) => s.mode);
  const activeWorld = useStore((s) => s.activeWorld);
  const focusedNodeId = useStore((s) => s.focusedNodeId);

  const world = WORLDS[activeWorld];
  const show = mode === "orbit" || (mode === "globe" && !focusedNodeId);
  const index = activeWorld === "built" ? "01" : "02";

  const hint =
    mode === "orbit"
      ? "Scroll to descend · click the far globe to switch worlds"
      : "Scroll in, or tap a marker, to drill down";

  return (
    <div
      className="title-plate"
      style={{ opacity: show ? 1 : 0 }}
      aria-hidden={!show}
    >
      <div className="title-plate__index label">
        {index} / TWO WORLDS
      </div>
      <h1 className="title-plate__title">{world.title}</h1>
      <div className="title-plate__sub label">{world.subtitle}</div>
      <div className="title-plate__hint label">
        <span className="rail__dot" /> {hint}
      </div>
    </div>
  );
}
