import type { BufferGeometry, ShaderMaterial } from "three";
import { PointsLayer } from "./PointsLayer";

/** Dotted country borders + a faint dotted graticule. Both are trails of points
 *  (never stroked lines) that fade in around COUNTRY level. */
export function Borders(props: {
  borders: BufferGeometry;
  graticule: BufferGeometry;
  borderMat: ShaderMaterial;
  graticuleMat: ShaderMaterial;
}) {
  return (
    <>
      <PointsLayer geometry={props.graticule} material={props.graticuleMat} />
      <PointsLayer geometry={props.borders} material={props.borderMat} />
    </>
  );
}
