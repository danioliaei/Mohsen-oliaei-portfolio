/* ============================================================================
   Isometric facility point clouds.

   Each project leaf in the Built world resolves, at the deepest zoom, into a
   small point-cloud building that "develops" out of the surface — echoing the
   aviation isometric floor-plan wayfinding. Buildings are generated in a local
   frame (y up, sitting on y=0) and the Facility component orients them to the
   globe surface normal at the node.
   ========================================================================== */

import type { IsoKind } from "../data/world";

type P = number[];

function pushBoxShell(
  out: P,
  cx: number,
  cy: number,
  cz: number,
  w: number,
  h: number,
  d: number,
  n: number,
) {
  // points scattered over the 6 faces of a box (edges weighted by density)
  for (let i = 0; i < n; i++) {
    const face = Math.floor(Math.random() * 6);
    const u = Math.random() - 0.5;
    const v = Math.random() - 0.5;
    let x = 0,
      y = 0,
      z = 0;
    if (face === 0 || face === 1) {
      x = (face === 0 ? 0.5 : -0.5) * w;
      y = v * h;
      z = u * d;
    } else if (face === 2 || face === 3) {
      y = (face === 2 ? 0.5 : -0.5) * h;
      x = u * w;
      z = v * d;
    } else {
      z = (face === 4 ? 0.5 : -0.5) * d;
      x = u * w;
      y = v * h;
    }
    out.push(cx + x, cy + y + h * 0.5, cz + z);
  }
}

function pushGableRoof(
  out: P,
  cx: number,
  cy: number,
  cz: number,
  w: number,
  ridge: number,
  d: number,
  n: number,
) {
  for (let i = 0; i < n; i++) {
    const t = Math.random();
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = side * (0.5 - t * 0.5) * w;
    const y = cy + t * ridge;
    const z = (Math.random() - 0.5) * d;
    out.push(cx + x, y, cz + z);
  }
}

function pushCylinder(
  out: P,
  cx: number,
  cy: number,
  cz: number,
  r: number,
  h: number,
  n: number,
) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const y = Math.random() * h;
    out.push(cx + Math.cos(a) * r, cy + y, cz + Math.sin(a) * r);
  }
}

function pushSawtooth(
  out: P,
  cx: number,
  cy: number,
  cz: number,
  w: number,
  d: number,
  teeth: number,
  th: number,
  n: number,
) {
  const seg = w / teeth;
  for (let i = 0; i < n; i++) {
    const k = Math.floor(Math.random() * teeth);
    const t = Math.random();
    const x = cx - w * 0.5 + k * seg + t * seg;
    const y = cy + (1 - t) * th; // slanted north-light
    const z = cz + (Math.random() - 0.5) * d;
    out.push(x, y, z);
  }
}

/**
 * Build an isometric facility as a dense point cloud. `density` multiplies every
 * point budget so the building resolves into a near-solid scanned model at the
 * deepest zoom; base counts are already high and scale from there.
 */
export function buildIso(kind: IsoKind, scale = 1, density = 1): Float32Array {
  const out: P = [];
  const N = (n: number) => Math.max(1, Math.round(n * density));
  switch (kind) {
    case "steel": {
      // gabled hall + chimney stacks + silos
      pushBoxShell(out, 0, 0, 0, 1.6, 0.7, 1.0, N(3400));
      pushGableRoof(out, 0, 0.7, 0, 1.6, 0.45, 1.0, N(1400));
      pushCylinder(out, 0.55, 0.7, -0.3, 0.07, 1.5, N(1000)); // tall chimney
      pushCylinder(out, 0.72, 0.7, -0.1, 0.06, 1.2, N(760));
      pushCylinder(out, -0.7, 0.0, 0.35, 0.22, 0.8, N(1100)); // silo
      pushCylinder(out, -0.4, 0.0, 0.45, 0.18, 0.7, N(900));
      break;
    }
    case "battery": {
      // long low sawtooth / north-light shed
      pushBoxShell(out, 0, 0, 0, 2.2, 0.4, 1.1, N(3600));
      pushSawtooth(out, 0, 0.4, 0, 2.2, 1.1, 7, 0.28, N(2800));
      pushCylinder(out, -1.0, 0.0, -0.5, 0.05, 0.9, N(420));
      break;
    }
    case "tower": {
      // high-rise slab with floor lines
      pushBoxShell(out, 0, 0, 0, 0.7, 2.4, 0.7, N(4200));
      for (let f = 0; f < 14; f++) {
        const y = (f / 14) * 2.4;
        for (let i = 0; i < N(110); i++) {
          const e = Math.floor(Math.random() * 4);
          const u = (Math.random() - 0.5) * 0.7;
          if (e === 0) out.push(0.35, y, u);
          else if (e === 1) out.push(-0.35, y, u);
          else if (e === 2) out.push(u, y, 0.35);
          else out.push(u, y, -0.35);
        }
      }
      break;
    }
    case "office": {
      // medium block with a stepped wing
      pushBoxShell(out, -0.2, 0, 0, 1.1, 0.9, 0.9, N(3000));
      pushBoxShell(out, 0.7, 0, 0.1, 0.7, 0.55, 0.7, N(1500));
      break;
    }
    case "module":
    default: {
      // abstract stacked cubes — generic "tool" massing
      pushBoxShell(out, -0.3, 0, -0.2, 0.6, 0.6, 0.6, N(1200));
      pushBoxShell(out, 0.35, 0, 0.1, 0.5, 0.9, 0.5, N(1300));
      pushBoxShell(out, 0.0, 0.6, 0.3, 0.45, 0.45, 0.45, N(950));
      break;
    }
  }

  const arr = new Float32Array(out.length);
  for (let i = 0; i < out.length; i++) arr[i] = out[i] * scale;
  return arr;
}
