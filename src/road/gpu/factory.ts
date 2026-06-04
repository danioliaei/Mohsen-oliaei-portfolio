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
import { LAT, surfaceY, TERRACE } from "../engine";

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

  /** A solid ramp: top slopes from (x0,y0) to (x1,y1) along x, width sz in z
   *  centred on cz, walls dropping to yFloor (set below grade so it never floats).
   *  Used for the access causeway linking the road up to the plant terrace. */
  ramp(x0: number, x1: number, cz: number, sz: number, y0: number, y1: number, yFloor: number, col: V3, emis = 0): void {
    const z0 = cz - sz / 2, z1 = cz + sz / 2;
    const A: V3 = [x0, y0, z0], B: V3 = [x0, y0, z1], C: V3 = [x1, y1, z1], D: V3 = [x1, y1, z0];
    this.quad(A, B, C, D, norm([-(y1 - y0), x1 - x0, 0]), col, emis); // sloped top
    const Af: V3 = [x0, yFloor, z0], Bf: V3 = [x0, yFloor, z1];
    const Cf: V3 = [x1, yFloor, z1], Df: V3 = [x1, yFloor, z0];
    this.quad(A, D, Df, Af, [0, 0, -1], col, emis); // z0 wall
    this.quad(C, B, Bf, Cf, [0, 0, 1], col, emis); // z1 wall
    this.quad(B, A, Af, Bf, [-1, 0, 0], col, emis); // pad-end cap
    this.quad(D, C, Cf, Df, [1, 0, 0], col, emis); // road-end cap
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

/** Warm dusk palette — metal that catches the low key light, with a muted
 *  "green-steel" accent and the emissive lights that feed the bloom. */
const STEEL: V3 = [0.37, 0.38, 0.39];
const STEEL_DK: V3 = [0.17, 0.18, 0.20];
const CLAD: V3 = [0.48, 0.43, 0.36]; // warm zinc cladding
const ROOF: V3 = [0.26, 0.31, 0.31]; // standing-seam roof, faint green-steel cast
const GREEN: V3 = [0.26, 0.50, 0.44]; // green-steel accent band (lit)
const CONCRETE: V3 = [0.30, 0.27, 0.24];
const CONCRETE_DK: V3 = [0.19, 0.17, 0.15];
const GRAVEL: V3 = [0.20, 0.17, 0.15]; // dark graded service yard
const ASPHALT: V3 = [0.14, 0.13, 0.13];
const WARM_LIGHT: V3 = [1.0, 0.66, 0.32]; // window / interior glow
const TEAL: V3 = [0.40, 0.92, 0.86]; // Stegra accent (echoes the station colour)
const RED_TIP: V3 = [1.0, 0.36, 0.26]; // stack warning light
const FLAME: V3 = [1.0, 0.55, 0.2];

/**
 * Build the plant geometry. The land beneath it is already graded flat to
 * `TERRACE.y` by the height field (engine.ts / terrainH), so the plant simply
 * stands on that platform — laid out as a linear green-steel works that fits
 * inside the terrace footprint, with an access causeway ramping down to the
 * road. Nothing floats and no ridge pierces it, because the ground IS flat here.
 */
export function buildFactory(): {
  verts: Float32Array<ArrayBuffer>;
  count: number;
  center: V3;
  z: number;
} {
  const xC = TERRACE.x;
  const zF = TERRACE.z;
  const ground = TERRACE.y; // the flat terrace top (carved into the terrain)

  const m = new Mesh();

  // ---- graded service yard on the platform (dark, so the lit buildings read
  // against it; a low kerb seats it into the terrace and the contour ground
  // shows around the inset edge) ----
  const apW = (TERRACE.hw - 96) * 2, apD = (TERRACE.hd - 96) * 2;
  m.box(xC, ground - 34, zF, apW + 36, 46, apD + 36, CONCRETE_DK, 0); // kerb/footing into grade
  m.box(xC, ground - 4, zF, apW, 16, apD, GRAVEL, 0); // dark graded yard
  const base = ground + 12; // deck top — everything stands here
  // a paved concrete apron by the road-side gate & tank farm (a little variation)
  m.box(xC + 380, base + 1, zF - 420, 480, 4, 560, CONCRETE, 0);

  // ---- main production halls: long sheds running along z (the works' spine) --
  const hallW = 320;
  const hallH = 330;
  const halls: Array<[number, number, number]> = [
    [xC - 430, zF - 40, 1500], // [centre x, centre z, length(z)] — back (hill side)
    [xC - 70, zF + 30, 1640], // middle
    [xC + 300, zF - 90, 1380], // front (road side)
  ];
  for (const [hx, hz, hl] of halls) {
    m.box(hx, base, hz, hallW, hallH, hl, CLAD, 0);
    m.gable(hx, base + hallH, hz, hallW, 110, hl, ROOF);
    // lit clerestory window strip + a green-steel brand band above it, both flanks
    for (const s of [-1, 1]) {
      const wx = hx + s * (hallW / 2 + 1);
      m.box(wx, base + hallH * 0.5, hz, 3, 32, hl * 0.9, WARM_LIGHT, 1.25); // windows
      m.box(wx, base + hallH - 46, hz, 3, 20, hl * 0.84, GREEN, 0.55); // brand band
    }
    // roof monitors / vents
    for (let k = -1; k <= 1; k++) {
      m.box(hx, base + hallH + 96, hz + k * hl * 0.28, hallW * 0.5, 24, hl * 0.12, STEEL_DK, 0);
    }
  }

  // ---- the DRI shaft tower: the tall slender landmark (far road-side corner) --
  const tx = xC + 560, tz = zF + 760;
  m.box(tx, base, tz, 230, 230, 230, STEEL_DK, 0); // base plinth
  m.box(tx, base + 230, tz, 158, 560, 158, STEEL, 0); // shaft
  m.box(tx, base + 230 + 560, tz, 206, 86, 206, STEEL_DK, 0); // top works
  m.box(tx, base + 230 + 560 + 86, tz, 78, 66, 78, TEAL, 0.7); // lit cap beacon
  m.box(tx, base + 230 + 560 + 86 + 66, tz, 18, 16, 18, RED_TIP, 1.3); // aviation light
  for (let b = 0; b < 3; b++) {
    m.box(tx, base + 300 + b * 160, tz, 162, 11, 162, TEAL, 0.9); // process bands
  }

  // ---- hydrogen / gas storage: domed cylinders, front-near corner ----
  const tanks: Array<[number, number, number, number]> = [
    [xC + 560, zF - 560, 140, 280], // [x, z, r, h]
    [xC + 620, zF - 320, 110, 230],
    [xC + 470, zF - 720, 96, 200],
    [xC + 690, zF - 640, 86, 188],
  ];
  for (const [px, pz, r, h] of tanks) {
    m.cyl(px, base, pz, r, h, 22, STEEL, 0, true);
    m.box(px, base + h * 0.5, pz - r, r * 0.5, 8, 8, TEAL, 0.8); // gauge strip
  }

  // ---- slender stacks (back, hill side) with warning-light tips ----
  const stacks: Array<[number, number, number, number]> = [
    [xC - 670, zF - 540, 24, 700],
    [xC - 730, zF - 660, 19, 560],
    [xC - 690, zF + 300, 22, 620],
  ];
  for (const [px, pz, r, h] of stacks) {
    m.cyl(px, base, pz, r, h, 14, STEEL_DK, 0);
    m.cyl(px, base + h, pz, r * 0.7, 22, 12, RED_TIP, 1.4); // glowing tip
  }
  // a flare stack with a small emissive flame
  const fx = xC - 720, fz = zF - 360;
  m.cyl(fx, base, fz, 22, 540, 14, STEEL_DK, 0);
  m.cyl(fx, base + 540, fz, 16, 64, 10, FLAME, 1.8);

  // ---- low pipe-racks / conveyors linking the halls (thin long boxes) ----
  m.box(xC - 250, base + 64, zF - 720, 760, 22, 36, STEEL_DK, 0);
  m.box(xC + 30, base + 84, zF + 800, 700, 22, 36, STEEL_DK, 0);
  m.box(xC - 180, base + 56, zF + 120, 36, 22, 760, STEEL_DK, 0);

  // ---- warm site lights ringing the apron ----
  const lamps = 9;
  for (let i = 0; i < lamps; i++) {
    const a = (i / lamps) * Math.PI * 2;
    const lx = xC + Math.cos(a) * (TERRACE.hw - 130);
    const lz = zF + Math.sin(a) * (TERRACE.hd - 130);
    m.box(lx, base, lz, 9, 140, 9, STEEL_DK, 0);
    m.box(lx, base + 140, lz, 24, 9, 24, WARM_LIGHT, 1.5);
  }

  // ---- access causeway: a graded ramp from the road up onto the terrace ----
  // Starts at the front rim of the platform and descends to road level; built as
  // a filled embankment (walls dropping below grade) so it reads as a real spur
  // road rather than a floating strip. A faint warm centreline echoes the fibre.
  const gz = zF - 280; // gate position along the front edge
  const rimX = xC + TERRACE.hw; // platform front rim
  const roadX = LAT(gz) + 70; // stop just short of the road centreline
  const padTopY = base; // deck height
  const roadTopY = surfaceY(roadX, gz) + 26; // meet the road surface
  m.ramp(rimX + 20, roadX, gz, 150, padTopY, roadTopY, ground - 360, ASPHALT, 0);
  m.ramp(rimX + 20, roadX, gz, 22, padTopY + 3, roadTopY + 3, roadTopY - 40, WARM_LIGHT, 0.5); // centreline
  // small gate posts where the ramp meets the platform
  m.box(rimX + 6, base, gz - 96, 26, 96, 26, STEEL_DK, 0);
  m.box(rimX + 6, base, gz + 96, 26, 96, 26, STEEL_DK, 0);

  return {
    verts: new Float32Array(m.data),
    count: m.data.length / FACTORY_FLOATS_PER_VERT,
    center: [xC, ground, zF],
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
