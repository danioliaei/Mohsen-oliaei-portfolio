import { LADDER, LOD_LABEL } from "../theme";
import { useStore } from "../store";
import { nudgeZoom } from "./zoomNudge";

export function ZoomControls() {
  const activeWorld = useStore((s) => s.activeWorld);
  const lod = useStore((s) => s.lod);
  const goHome = useStore((s) => s.goHome);

  const ladder = LADDER[activeWorld];
  const current = Math.max(0, ladder.indexOf(lod));

  return (
    <div className="controls">
      <div className="lod-readout" aria-label="Zoom level">
        {ladder.map((step, i) => (
          <span key={step}>
            {i > 0 && <span aria-hidden="true"> → </span>}
            <span
              className={
                "lod-readout__step" +
                (i === current
                  ? " lod-readout__step--active"
                  : i < current
                    ? " lod-readout__step--passed"
                    : "")
              }
            >
              {LOD_LABEL[step]}
            </span>
          </span>
        ))}
      </div>

      <div className="btn-cluster" role="group" aria-label="Zoom controls">
        <button onClick={() => nudgeZoom(-1)} aria-label="Zoom in" title="Zoom in">
          +
        </button>
        <button onClick={() => nudgeZoom(1)} aria-label="Zoom out" title="Zoom out">
          −
        </button>
        <button onClick={goHome} aria-label="Reset to orbit" title="Home">
          ⌂
        </button>
      </div>
    </div>
  );
}
