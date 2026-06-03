/** Drive the descent engine's wheel pathway from buttons / keyboard, so every
 *  zoom affordance moves toward the crosshair exactly like a scroll does. */
export function nudgeZoom(dir: -1 | 1) {
  const canvas = document.querySelector("canvas");
  if (!canvas) return;
  canvas.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY: dir * 520,
      clientX: window.innerWidth / 2,
      clientY: window.innerHeight / 2,
      bubbles: true,
      cancelable: true,
    }),
  );
}
