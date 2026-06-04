/* =========================================================================
   Stegra plant — a procedural, low-poly "green-steel" gigafactory built beside
   the career road at the Stegra milestone. The real plant in Boden reads as a
   line of long production halls flanked by a tall direct-reduction (DRI) shaft
   tower, hydrogen/gas tanks and slender stacks; this captures that silhouette
   as a cluster of lit solids on a graded pad so the journey arrives at a place,
   not just a label.

   One interleaved vertex buffer (position, normal, colour, emissive) is built
   once on the CPU and drawn by the SOLID pass in scene.ts, depth-tested against
   the terrain so nearer hills occlude it like any other world geometry.
   ========================================================================= */
import { LAT, surfaceY } from "../engine";
import { MILESTONES } from "../../data/milestones";

export const FACTORY_FLOATS_PER_VERT = 10; // pos(3) nrm(3) col(3) emis(1)

type V3 = [number, number, number];

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Accumulates triangles (flat-shaded) into one interleaved float array. */
class Mesh {
  data: number[] = [];

  private vert(p: V3, n: V3, col: V3, emis: number): void {
    this.data.push(p[0], p[1], p[2], n[0], n[1], n[2], col[0], col[1], col[2], emis);
  }
  private tri(a: V3, b: V3, c: V3, n: V3, col: V3, emis: number): void {
    this.vert(a, n, col, emis);
    this.vert(b, n, col, emis);
    this.vert(c, n, col, emis);
  }
  private quad(a: V3, b: V3, c: V3, d: V3, n: V3, col: V3, emis: number): void {
    this.tri(a, b, c, n, col, emis);
    this.tri(a, c, d, n, col, emis);
  }

  /** Axis-aligned box: base at y, centred on (cx,cz), height sy. */
  box(cx: number, y: number, cz: number, sx: number, sy: number, sz: number, col: V3, emis = 0): void {
    const x0 = cx - sx / 2, x1 = cx + sx / 2;
    const y0 = y, y1 = y + sy;
    const z0 = cz - sz / 2, z1 = cz + sz / 2;
    const P = (x: number, yy: number, z: number): V3 => [x, yy, z];
    this.quad(P(x1, y0, z0), P(x1, y0, z1), P(x1, y1, z1), P(x1, y1, z0), [1, 0, 0], col, emis);
    this.quad(P(x0, y0, z1), P(x0, y0, z0), P(x0, y1, z0), P(x0, y1, z1), [-1, 0, 0], col, emis);
    this.quad(P(x1, y0, z1), P(x0, y0, z1), P(x0, y1, z1), P(x1, y1, z1), [0, 0, 1], col, emis);
    this.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0), [0, 0, -1], col, emis);
    this.quad(P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1), [0, 1, 0], col, emis);
    this.quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y0, z0), P(x0, y0, z0), [0, -1, 0], col, emis);
  }

  /** A low gabled roof slab sitting on top of a hall (two slanted faces). */
  gable(cx: number, y: number, cz: number, sx: number, ridge: number, sz: number, col: V3): void {
    const x0 = cx - sx / 2, x1 = cx + sx / 2;
    const z0 = cz - sz / 2, z1 = cz + sz / 2;
    // two long slanted planes meeting at the ridge line (run along z)
    const rA: V3 = [cx, y + ridge, z0], rB: V3 = [cx, y + ridge, z1];
    const nL = norm([-ridge, sx / 2, 0]);
    const nR = norm([ridge, sx / 2, 0]);
    this.quad([x0, y, z0], [x0, y, z1], rB, rA, nL, col, 0);
    this.quad([x1, y, z1], [x1, y, z0], rA, rB, nR, col, 0);
    // gable end triangles
    this.tri([x0, y, z0], rA, [x1, y, z0], [0, 0, -1], col, 0);
    this.tri([x1, y, z1], rB, [x0, y, z1], [0, 0, 1], col, 0);
  }

  /** Upright cylinder (tank / silo / stack): base at y, height h. */
  cyl(cx: number, y: number, cz: number, r: number, h: number, segs: number, col: V3, emis = 0, dome = false): void {
    const y0 = y, y1 = y + h;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const x0 = cx + c0 * r, z0 = cz + s0 * r, x1 = cx + c1 * r, z1 = cz + s1 * r;
      this.quad([x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0], norm([c0 + c1, 0, s0 + s1]), col, emis);
      if (dome) {
        // shallow domed cap (gas-holder look) — a ring of triangles up to the apex
        const dh = r * 0.5;
        this.tri([x0, y1, z0], [x1, y1, z1], [cx, y1 + dh, cz], norm([c0 + c1, 1.4, s0 + s1]), col, emis);
      } else {
        this.tri([cx, y1, cz], [x0, y1, z0], [x1, y1, z1], [0, 1, 0], col, emis);
      }
    }
  }
}

/** Linear-ish dusk palette for the plant — cool steel + a few warm/teal lights. */
const STEEL: V3 = [0.40, 0.42, 0.45];
const STEEL_DK: V3 = [0.20, 0.22, 0.26];
const CLAD: V3 = [0.52, 0.47, 0.40]; // warm metal cladding
const CONCRETE: V3 = [0.34, 0.31, 0.28];
const WARM_LIGHT: V3 = [1.0, 0.66, 0.32]; // window / interior glow
const TEAL: V3 = [0.40, 0.92, 0.86]; // Stegra accent (echoes the station colour)
const RED_TIP: V3 = [1.0, 0.36, 0.26]; // stack warning light

/**
 * Build the plant geometry, sited beside the road at the Stegra milestone.
 * Returns the interleaved vertex array + vertex count, plus the world centre &
 * radius so the renderer can cull/skip it when far from view if needed.
 */
export function buildFactory(): {
  verts: Float32Array<ArrayBuffer>;
  count: number;
  center: V3;
  z: number;
} {
  const stegra = MILESTONES.find((m) => m.title.includes("Stegra")) ?? MILESTONES[MILESTONES.length - 1];
  const zF = stegra.z;
  // sit the plant off to the camera-facing (−x) side of the road, on its own pad
  const SIDE = -1450;
  const xC = LAT(zF) + SIDE;
  const padY = surfaceY(xC, zF);

  const m = new Mesh();

  // ---- graded site pad (a flat platform so nothing floats on the hillside) ----
  const padW = 2600, padD = 1900, padT = 34;
  m.box(xC, padY - padT, zF, padW, padT, padD, CONCRETE, 0);
  const base = padY; // everything else stands on the pad top
  m.box(xC, base, zF, padW - 60, 6, padD - 60, [0.30, 0.28, 0.25], 0); // apron slab

  // ---- main production halls: a row of long, tall sheds along z ----
  const hallW = 470; // across (x)
  const hallH = 360;
  const halls: Array<[number, number, number]> = [
    [xC - 520, zF - 130, 1180], // [centre x, centre z, length(z)]
    [xC, zF + 40, 1500],
    [xC + 540, zF - 80, 1240],
  ];
  for (const [hx, hz, hl] of halls) {
    m.box(hx, base, hz, hallW, hallH, hl, CLAD, 0);
    m.gable(hx, base + hallH, hz, hallW, 120, hl, STEEL);
    // emissive clerestory window bands down both long sides
    m.box(hx - hallW / 2 - 1, base + hallH * 0.62, hz, 4, 40, hl * 0.92, WARM_LIGHT, 1.1);
    m.box(hx + hallW / 2 + 1, base + hallH * 0.62, hz, 4, 40, hl * 0.92, WARM_LIGHT, 1.1);
    // roof vents / monitors
    for (let k = -1; k <= 1; k++) {
      m.box(hx, base + hallH + 110, hz + k * hl * 0.28, hallW * 0.5, 26, hl * 0.12, STEEL_DK, 0);
    }
  }

  // ---- the DRI shaft tower: the tall slender centrepiece ----
  const tx = xC - 980, tz = zF + 560;
  m.box(tx, base, tz, 250, 250, 250, STEEL_DK, 0); // base plinth
  m.box(tx, base + 250, tz, 170, 560, 170, STEEL, 0); // shaft
  m.box(tx, base + 250 + 560, tz, 220, 90, 220, STEEL_DK, 0); // top works
  m.box(tx, base + 250 + 560 + 90, tz, 80, 70, 80, CLAD, 0); // cap house
  // a few emissive process bands up the shaft
  for (let b = 0; b < 3; b++) {
    m.box(tx, base + 330 + b * 170, tz, 174, 12, 174, TEAL, 0.9);
  }

  // ---- hydrogen / gas storage: domed cylinders in a cluster ----
  const tanks: Array<[number, number, number, number]> = [
    [xC + 1020, zF + 540, 150, 300], // [x, z, r, h]
    [xC + 1180, zF + 250, 120, 250],
    [xC + 980, zF + 230, 95, 210],
    [xC + 1200, zF + 760, 110, 230],
  ];
  for (const [px, pz, r, h] of tanks) {
    m.cyl(px, base, pz, r, h, 22, STEEL, 0, true);
    m.box(px, base + h * 0.5, pz - r, r * 0.5, 8, 8, TEAL, 0.8); // gauge strip
  }

  // ---- slender stacks / flare with warning-light tips ----
  const stacks: Array<[number, number, number, number]> = [
    [xC - 1180, zF - 360, 26, 720],
    [xC - 1050, zF - 460, 20, 600],
    [xC + 760, zF - 560, 22, 660],
  ];
  for (const [px, pz, r, h] of stacks) {
    m.cyl(px, base, pz, r, h, 14, STEEL_DK, 0);
    m.cyl(px, base + h, pz, r * 0.7, 24, 12, RED_TIP, 1.4); // glowing tip
  }
  // a flare stack with a small emissive flame
  const fx = xC + 980, fz = zF - 360;
  m.cyl(fx, base, fz, 24, 560, 14, STEEL_DK, 0);
  m.cyl(fx, base + 560, fz, 18, 70, 10, [1.0, 0.55, 0.2], 1.8);

  // ---- low pipe-racks / conveyors linking the halls (thin long boxes) ----
  m.box(xC - 250, base + 70, zF - 700, 1500, 26, 40, STEEL_DK, 0);
  m.box(xC + 120, base + 90, zF + 760, 1700, 26, 40, STEEL_DK, 0);
  m.box(xC - 760, base + 60, zF + 200, 40, 26, 900, STEEL_DK, 0);

  // ---- a scatter of warm site lights along the perimeter ----
  const lamps = 8;
  for (let i = 0; i < lamps; i++) {
    const a = (i / lamps) * Math.PI * 2;
    const lx = xC + Math.cos(a) * 1150;
    const lz = zF + Math.sin(a) * 820;
    m.box(lx, base, lz, 10, 150, 10, STEEL_DK, 0);
    m.box(lx, base + 150, lz, 26, 10, 26, WARM_LIGHT, 1.5);
  }

  return {
    verts: new Float32Array(m.data),
    count: m.data.length / FACTORY_FLOATS_PER_VERT,
    center: [xC, padY, zF],
    z: zF,
  };
}

export const ARROW_FLOATS_PER_VERT = 6; // pos(3) nrm(3), coloured per-frame on the GPU side

/**
 * A unit "you-are-here" arrow template (position + normal only), pointing +z
 * (the travel direction) and lying flat in the x-z plane with a little extruded
 * thickness. scene.ts transforms this into world space along the road each frame
 * (it bobs + glows), so the colour/emissive are applied at upload time, not here.
 */
export function buildArrowTemplate(): { verts: Float32Array<ArrayBuffer>; count: number } {
  const t = 0.26; // extrude thickness (y)
  // outline as [x, 0, z], traversed in order, pointing +z (forward is the z slot)
  const o: V3[] = [
    [0, 0, 1.0], [0.64, 0, 0.28], [0.26, 0, 0.28], [0.26, 0, -0.6],
    [-0.26, 0, -0.6], [-0.26, 0, 0.28], [-0.64, 0, 0.28],
  ];
  const d: number[] = [];
  const push = (p: V3, n: V3): void => {
    d.push(p[0], p[1], p[2], n[0], n[1], n[2]);
  };
  const tri = (a: V3, b: V3, c: V3, n: V3): void => {
    push(a, n);
    push(b, n);
    push(c, n);
  };
  // cap faces: an arrowhead triangle + a shaft quad, emitted top (+y) and bottom (−y)
  const caps: number[][] = [
    [0, 1, 6], // head (tip, right base, left base)
    [2, 3, 4, 5], // shaft quad
  ];
  for (const f of caps) {
    for (let i = 1; i < f.length - 1; i++) {
      const a = o[f[0]], b = o[f[i]], c = o[f[i + 1]];
      tri([a[0], t, a[2]], [b[0], t, b[2]], [c[0], t, c[2]], [0, 1, 0]); // top
      tri([a[0], 0, a[2]], [c[0], 0, c[2]], [b[0], 0, b[2]], [0, -1, 0]); // bottom
    }
  }
  // side walls around the perimeter
  for (let i = 0; i < o.length; i++) {
    const a = o[i], b = o[(i + 1) % o.length];
    const ex = b[0] - a[0], ez = b[2] - a[2];
    const n = norm([ez, 0, -ex]); // outward edge normal
    const a0: V3 = [a[0], 0, a[2]], a1: V3 = [a[0], t, a[2]];
    const b0: V3 = [b[0], 0, b[2]], b1: V3 = [b[0], t, b[2]];
    tri(a0, b0, b1, n);
    tri(a0, b1, a1, n);
  }
  return { verts: new Float32Array(d), count: d.length / ARROW_FLOATS_PER_VERT };
}
