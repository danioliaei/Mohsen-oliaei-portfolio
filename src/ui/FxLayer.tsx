/** Film-grain + faint carbon stripe + vignette overlays (above canvas, below HUD). */
export function FxLayer() {
  return (
    <div aria-hidden="true">
      <div className="fx-layer fx-stripe" />
      <div className="fx-layer fx-grain" />
      <div className="fx-layer fx-vignette" />
    </div>
  );
}
