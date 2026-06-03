import type { BufferGeometry, ShaderMaterial } from "three";
import { PointsLayer } from "./PointsLayer";

/** Faint, sparse point sphere over the whole globe so it reads even over water. */
export function CloudShell(props: {
  geometry: BufferGeometry;
  material: ShaderMaterial;
}) {
  return <PointsLayer {...props} />;
}
