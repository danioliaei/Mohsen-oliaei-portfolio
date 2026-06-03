/* ============================================================================
   Heavy geometry, built once and shared.

   Land sampling (geoContains over ~tens of thousands of candidates) is the most
   expensive step, so it runs once during boot and the resulting geometries are
   shared by BOTH globes — the back globe simply keeps uZoom = 0, so its
   density-ramp points stay hidden while the active globe densifies on descent.
   ========================================================================== */

import type { BufferGeometry } from "three";
import type { Feature } from "geojson";
import { GLOBE_RADIUS } from "../theme";
import {
  type GeoData,
  buildCountryTagger,
  fibonacciSphere,
  graticulePoints,
  loadGeo,
  sampleBorderPoints,
  sampleLandPoints,
} from "../lib/geo";
import { pointsGeometry } from "./buildGeometry";

/** Highlight country indices — must match COUNTRY_HL in data/world.ts.
 *  1 = Sweden · 2 = Iran · 3 = USA. */
const NAME_TO_INDEX: Record<string, number> = {
  Sweden: 1,
  Iran: 2,
  "United States of America": 3,
};

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
  const oceanCount = Math.round(22000 * quality);
  // Far denser land sampling — continents read as a solid dot-density texture
  // rather than a scatter, so countries are clearly recognizable and the planet
  // stays legible (in fact sharpens) as you descend.
  const landCandidates = Math.round(680000 * quality);
  // Tighter border spacing → continuous dotted country outlines that make every
  // nation read as a crisp, recognizable shape.
  const borderSpacing = quality < 1 ? 0.6 : 0.35;
  const gratStep = 15;
  const gratDot = quality < 1 ? 3.2 : 2.4;

  // --- ocean shell: faint, sparse, always present ---
  const ocean = pointsGeometry(fibonacciSphere(oceanCount, GLOBE_RADIUS), {
    aLand: 0,
    aAccent: 0,
    aIn: 0,
    aCore: () => (Math.random() < 0.012 ? 1 : 0),
  });

  // Per-country tagger (Sweden / Iran / USA) for the focus spotlight.
  const tagger = buildCountryTagger(geo.countries, NAME_TO_INDEX);
  const indexOf = (f: Feature): number =>
    NAME_TO_INDEX[(f.properties?.name as string) ?? ""] ?? 0;

  // --- continents: hero dot-density land, with a density ramp ---
  const {
    positions: landPos,
    count: landCount,
    country: landCountry,
  } = sampleLandPoints(geo.land, landCandidates, GLOBE_RADIUS, tagger);
  const land = pointsGeometry(landPos, {
    aLand: 1,
    aAccent: 0,
    aCountry: (i) => landCountry[i],
    // ~50% base (already dense from orbit thanks to the high candidate count);
    // the other half streams in across the descent so the surface visibly gains
    // more, finer points the closer you get — denser, not just bigger.
    aIn: () => {
      const r = Math.random();
      return r < 0.5 ? 0 : 0.02 + Math.random() * 0.4;
    },
    aCore: () => (Math.random() < 0.02 ? 1 : 0),
  });

  // --- borders: glowing periwinkle outlines (coastlines + country boundaries).
  // A distinct accent (aAccent = 2) sets them apart from the ink land; a portion
  // are cores so they bloom into bright, near-continuous outlines that make the
  // countries legible. aOut = 2 keeps them visible all the way to the surface. ---
  const borderSamples = sampleBorderPoints(
    geo.countries,
    borderSpacing,
    GLOBE_RADIUS * 1.0025,
    indexOf,
  );
  const borders = pointsGeometry(borderSamples.positions, {
    aLand: 0,
    aAccent: 2,
    aCountry: (i) => borderSamples.country[i],
    aIn: 0.04,
    aOut: 2,
    aCore: () => (Math.random() < 0.05 ? 1 : 0),
  });

  // --- graticule: faint lat/long dots; recede early (gone by COUNTRY) so the
  // close-in views aren't cluttered by the grid. ---
  const graticule = pointsGeometry(
    graticulePoints(gratStep, gratDot, GLOBE_RADIUS * 1.0015),
    { aLand: 0, aAccent: 0, aIn: 0.06, aOut: 0.45 },
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
