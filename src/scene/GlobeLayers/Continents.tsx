import type { BufferGeometry, ShaderMaterial } from "three";
import { PointsLayer } from "./PointsLayer";

/** The hero layer: dot-density land sampled with geoContains. Denser + brighter
 *  than the ocean shell, with a built-in density ramp (aIn) so the continents
 *  visibly thicken as the camera descends. */
export function Continents(props: {
  geometry: BufferGeometry;
  material: ShaderMaterial;
}) {
  return <PointsLayer {...props} />;
}
