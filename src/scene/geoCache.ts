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
  const oceanCount = Math.round(9000 * quality);
  const landCandidates = Math.round(110000 * quality);
  const borderSpacing = quality < 1 ? 1.8 : 1.1;
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
    // ~42% base (visible at orbit), rest fades in as we descend
    aIn: () => {
      const r = Math.random();
      return r < 0.42 ? 0 : 0.2 + Math.random() * 0.42;
    },
    aCore: () => (Math.random() < 0.03 ? 1 : 0),
  });

  // --- borders: dotted hairline, fades in at COUNTRY ---
  const borders = pointsGeometry(
    sampleBorderPoints(geo.countries, borderSpacing, GLOBE_RADIUS * 1.001),
    { aLand: 0, aAccent: 0, aIn: 0.12, aOut: 0.9 },
  );

  // --- graticule: faint lat/long dots ---
  const graticule = pointsGeometry(
    graticulePoints(gratStep, gratDot, GLOBE_RADIUS * 1.001),
    { aLand: 0, aAccent: 0, aIn: 0.06, aOut: 0.85 },
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
