import { WORLDS } from "../data/world";
import { getState, useStore, type WorldId } from "../store";

/** Segmented Built / Digital toggle — the paired control for the "click the far
 *  globe" depth swap. At orbit it triggers the cinematic swap; deeper, it flies
 *  home into the chosen world. */
export function WorldSwitch() {
  const activeWorld = useStore((s) => s.activeWorld);
  const setActiveWorld = useStore((s) => s.setActiveWorld);
  const beginWorldSwitch = useStore((s) => s.beginWorldSwitch);
  const goHome = useStore((s) => s.goHome);

  const choose = (id: WorldId) => {
    const st = getState();
    if (st.transitioning || st.activeWorld === id) return;
    setActiveWorld(id);
    if (st.mode === "orbit") beginWorldSwitch();
    else goHome();
  };

  const ids: WorldId[] = ["built", "digital"];
  return (
    <div className="world-switch" role="tablist" aria-label="Choose world">
      <span
        className={`world-switch__pill${activeWorld === "digital" ? " world-switch__pill--digital" : ""}`}
        aria-hidden="true"
      />
      {ids.map((id) => (
        <button
          key={id}
          role="tab"
          aria-selected={activeWorld === id}
          className={`world-switch__seg label${activeWorld === id ? " world-switch__seg--active" : ""}`}
          onClick={() => choose(id)}
        >
          {id === "built" ? "Built" : "Digital"}
        </button>
      ))}
      <span className="sr-only">{WORLDS[activeWorld].subtitle}</span>
    </div>
  );
}
