import type { BufferGeometry, ShaderMaterial } from "three";

/** A single point-cloud layer. frustumCulled off — the cloud must never pop
 *  out when its bounding sphere leaves the frame during close zoom. */
export function PointsLayer({
  geometry,
  material,
}: {
  geometry: BufferGeometry;
  material: ShaderMaterial;
}) {
  return (
    <points geometry={geometry} material={material} frustumCulled={false} />
  );
}
