/* ============================================================================
   BufferGeometry builder for point layers.

   Fills the per-point attributes the shared shader expects. Each spec is either
   a constant or a per-point function (i, x, y, z) => value.
   ========================================================================== */

import { BufferAttribute, BufferGeometry } from "three";

type AttrSpec =
  | number
  | ((i: number, x: number, y: number, z: number) => number);

export interface AttrSpecs {
  aRand?: AttrSpec;
  aIn?: AttrSpec;
  aOut?: AttrSpec;
  aCore?: AttrSpec;
  aLand?: AttrSpec;
  aAccent?: AttrSpec;
  /** highlight country index (0 = none) — drives the focus spotlight. */
  aCountry?: AttrSpec;
}

const DEFAULTS: Required<AttrSpecs> = {
  aRand: () => Math.random(),
  aIn: 0,
  aOut: 2, // effectively "always visible" past appear
  aCore: 0,
  aLand: 0,
  aAccent: 0,
  aCountry: 0,
};

export function pointsGeometry(
  positions: Float32Array,
  specs: AttrSpecs = {},
): BufferGeometry {
  const count = positions.length / 3;
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));

  const merged = { ...DEFAULTS, ...specs };
  for (const key of Object.keys(merged) as (keyof AttrSpecs)[]) {
    const spec = merged[key];
    const arr = new Float32Array(count);
    if (typeof spec === "function") {
      for (let i = 0; i < count; i++) {
        arr[i] = spec(
          i,
          positions[i * 3],
          positions[i * 3 + 1],
          positions[i * 3 + 2],
        );
      }
    } else {
      arr.fill(spec);
    }
    geo.setAttribute(key, new BufferAttribute(arr, 1));
  }
  geo.computeBoundingSphere();
  return geo;
}

/** Concatenate several position arrays into one. */
export function concatF32(arrays: Float32Array[]): Float32Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
