/* ============================================================================
   Heavy geometry, built once and shared.

   Land sampling (geoContains over ~tens of thousands of candidates) is the most
   expensive step, so it runs once during boot and the resulting geometries are
   shared by BOTH globes — the back globe simply keeps uZoom = 0, so its
   density-ramp points stay hidden while the active globe densifies on descent.
   ========================================================================== */

import type { BufferGeometry } from "three";
import { GLOBE_RADIUS } from "../theme";
import {
  type GeoData,
  fibonacciSphere,
  graticulePoints,
  loadGeo,
  sampleBorderPoints,
  sampleLandPoints,
} from "../lib/geo";
import { pointsGeometry } from "./buildGeometry";

export interface GlobeGeometries {
  ocean: BufferGeometry;
  land: BufferGeometry;
  borders: BufferGeometry;
  graticule: BufferGeometry;
  landCount: number;
}

/** Coarse device tier — scales every point budget. */
export function detectQuality(): number {
  if (typeof window === "undefined") return 1;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 760;
  const lowCores = (navigator.hardwareConcurrency ?? 8) <= 4;
  if (coarse || small || lowCores) return 0.5;
  return 1;
}

let cache: GlobeGeometries | null = null;
let pending: Promise<GlobeGeometries> | null = null;

export function buildGeometries(
  geo: GeoData,
  quality: number,
): GlobeGeometries {
  const oceanCount = Math.round(13000 * quality);
  // Far denser land sampling — continents read as a solid dot-density texture
  // rather than a scatter, so the planet stays legible as you descend.
  const landCandidates = Math.round(320000 * quality);
  // Tighter border spacing → near-continuous dotted country outlines.
  const borderSpacing = quality < 1 ? 1.0 : 0.55;
  const gratStep = 15;
  const gratDot = quality < 1 ? 3.2 : 2.4;

  // --- ocean shell: faint, sparse, always present ---
  const ocean = pointsGeometry(fibonacciSphere(oceanCount, GLOBE_RADIUS), {
    aLand: 0,
    aAccent: 0,
    aIn: 0,
    aCore: () => (Math.random() < 0.012 ? 1 : 0),
  });

  // --- continents: hero dot-density land, with a density ramp ---
  const { positions: landPos, count: landCount } = sampleLandPoints(
    geo.land,
    landCandidates,
    GLOBE_RADIUS,
  );
  const land = pointsGeometry(landPos, {
    aLand: 1,
    aAccent: 0,
    // ~50% base (visible at orbit); the rest fills in quickly so the continents
    // are fully dense by the COUNTRY framing — nothing stays sparse up close.
    aIn: () => {
      const r = Math.random();
      return r < 0.5 ? 0 : 0.05 + Math.random() * 0.33;
    },
    aCore: () => (Math.random() < 0.022 ? 1 : 0),
  });

  // --- borders: dotted periwinkle hairline. A distinct accent (aAccent = 2) so
  // country outlines stand apart from the ink land, and aOut = 2 keeps them
  // visible all the way to the surface — borders never fade out on zoom. ---
  const borders = pointsGeometry(
    sampleBorderPoints(geo.countries, borderSpacing, GLOBE_RADIUS * 1.0025),
    { aLand: 0, aAccent: 2, aIn: 0.1, aOut: 2 },
  );

  // --- graticule: faint lat/long dots; recede before the surface to de-clutter ---
  const graticule = pointsGeometry(
    graticulePoints(gratStep, gratDot, GLOBE_RADIUS * 1.0015),
    { aLand: 0, aAccent: 0, aIn: 0.06, aOut: 0.72 },
  );

  return { ocean, land, borders, graticule, landCount };
}

/** Load + build once; subsequent calls return the cached result. */
export function prepareGlobe(quality: number): Promise<GlobeGeometries> {
  if (cache) return Promise.resolve(cache);
  if (pending) return pending;
  pending = loadGeo()
    .then((geo) => {
      cache = buildGeometries(geo, quality);
      return cache;
    })
    .catch((err) => {
      pending = null;
      throw err;
    });
  return pending;
}

export function getGlobeGeometries(): GlobeGeometries | null {
  return cache;
}
