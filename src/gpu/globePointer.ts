/** Soft boundary for the pointer field, in CSS pixels. Never activates outside the globe. */
export function globePointerStrength(
  x: number, y: number, cx: number, cy: number, radius: number,
): number {
  if (x < 0 || y < 0 || !Number.isFinite(radius) || radius <= 0) return 0;
  const distance = Math.hypot(x - cx, y - cy) / radius;
  const t = Math.max(0, Math.min(1, (1 - distance) / 0.18));
  return t * t * (3 - 2 * t);
}
