/* ============================================================================
   Geo utilities — turn the world into points.

   Everything here projects lat/lng onto a unit sphere and emits Float32Arrays
   ready to drop into a THREE.BufferGeometry. Land is sampled with d3-geo's
   geoContains against the world-atlas TopoJSON so continents render as a
   dot-density cloud — never vector borders or filled meshes.
   ========================================================================== */

import { geoContains, geoDistance, geoInterpolate } from "d3-geo";
import { feature, merge } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";

const DEG = Math.PI / 180;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Project lat/lng (degrees) to a point on a sphere of the given radius. */
export function latLngToVec3(
  lat: number,
  lng: number,
  radius = 1,
): [number, number, number] {
  const phi = (90 - lat) * DEG; // polar angle from +Y
  const theta = (lng + 180) * DEG;
  const s = Math.sin(phi);
  return [
    -radius * s * Math.cos(theta),
    radius * Math.cos(phi),
    radius * s * Math.sin(theta),
  ];
}

/** Even point distribution over a sphere (used for the ocean shell + candidates). */
export function fibonacciSphere(count: number, radius = 1): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const t = GOLDEN * i;
    out[i * 3] = Math.cos(t) * r * radius;
    out[i * 3 + 1] = y * radius;
    out[i * 3 + 2] = Math.sin(t) * r * radius;
  }
  return out;
}

/** Even lat/lng samples via the fibonacci method, returned as [lng, lat] pairs. */
function fibonacciLngLat(count: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const lat = Math.asin(y) / DEG;
    const lng = ((GOLDEN * i) / DEG) % 360;
    out.push([lng > 180 ? lng - 360 : lng, lat]);
  }
  return out;
}

export interface GeoData {
  land: MultiPolygon;
  countries: FeatureCollection;
}

/** Load + prepare the TopoJSON: merged land for hit-testing, countries for borders. */
export async function loadGeo(
  url = `${import.meta.env.BASE_URL}geo/countries-110m.json`,
): Promise<GeoData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load geo data (${res.status})`);
  const topo = (await res.json()) as Topology;

  const countriesObj = topo.objects.countries as GeometryCollection;
  const countries = feature(topo, countriesObj) as unknown as FeatureCollection;

  // Prefer a dedicated land object if present, else merge all countries.
  const landObj = topo.objects.land as GeometryCollection | undefined;
  const land = landObj
    ? (feature(topo, landObj) as unknown as Feature<MultiPolygon>).geometry
    : (merge(
        topo,
        countriesObj.geometries as Parameters<typeof merge>[1],
      ) as MultiPolygon);

  return { land, countries };
}

export interface LandSamples {
  positions: Float32Array; // xyz on the unit sphere
  count: number;
}

/**
 * Sample land as a dot-density cloud. Generates `candidates` evenly spread
 * lat/lng points and keeps those that fall on land (geoContains). Returns far
 * fewer points than candidates (land is ~29% of the globe), giving glowing
 * dotted continents.
 */
export function sampleLandPoints(
  land: MultiPolygon,
  candidates: number,
  radius = 1,
): LandSamples {
  const pts = fibonacciLngLat(candidates);
  const keep: number[] = [];
  for (const p of pts) {
    if (geoContains(land, p)) {
      const [x, y, z] = latLngToVec3(p[1], p[0], radius);
      keep.push(x, y, z);
    }
  }
  return { positions: new Float32Array(keep), count: keep.length / 3 };
}

/**
 * Resample country boundaries as a trail of dots at a fixed angular spacing.
 * Never a stroked line — a dotted hairline that reads as part of the cloud.
 */
export function sampleBorderPoints(
  countries: FeatureCollection,
  spacingDeg = 0.9,
  radius = 1,
): Float32Array {
  const spacing = spacingDeg * DEG;
  const out: number[] = [];

  const ring = (coords: Position[]) => {
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i] as [number, number];
      const b = coords[i + 1] as [number, number];
      const d = geoDistance(a, b); // radians along the great circle
      const steps = Math.max(1, Math.round(d / spacing));
      const lerp = geoInterpolate(a, b);
      for (let s = 0; s < steps; s++) {
        const [lng, lat] = lerp(s / steps);
        const [x, y, z] = latLngToVec3(lat, lng, radius);
        out.push(x, y, z);
      }
    }
  };

  const polygon = (poly: Polygon["coordinates"]) => poly.forEach(ring);

  for (const f of countries.features) {
    const g = f.geometry;
    if (g.type === "Polygon") polygon(g.coordinates);
    else if (g.type === "MultiPolygon") g.coordinates.forEach(polygon);
  }
  return new Float32Array(out);
}

/** Dotted lat/long graticule. */
export function graticulePoints(
  stepDeg = 15,
  dotDeg = 2.2,
  radius = 1,
): Float32Array {
  const out: number[] = [];
  // meridians
  for (let lng = -180; lng < 180; lng += stepDeg) {
    for (let lat = -88; lat <= 88; lat += dotDeg) {
      out.push(...latLngToVec3(lat, lng, radius));
    }
  }
  // parallels
  for (let lat = -75; lat <= 75; lat += stepDeg) {
    for (let lng = -180; lng < 180; lng += dotDeg) {
      out.push(...latLngToVec3(lat, lng, radius));
    }
  }
  return new Float32Array(out);
}

/**
 * Great-circle arc rendered as a trail of points from `a` to `b`, lifting off
 * the surface mid-span so it reads as a route line over the globe.
 */
export function greatCircleArcPoints(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  segments = 48,
  radius = 1,
  lift = 0.14,
): Float32Array {
  const lerp = geoInterpolate([a.lng, a.lat], [b.lng, b.lat]);
  const out = new Float32Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const [lng, lat] = lerp(t);
    const alt = radius * (1 + Math.sin(t * Math.PI) * lift);
    const [x, y, z] = latLngToVec3(lat, lng, alt);
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return out;
}

/** Tight gaussian-ish patch of points around a lat/lng (city / marker clusters). */
export function clusterPoints(
  lat: number,
  lng: number,
  count: number,
  spreadDeg = 1.4,
  radius = 1,
): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // box-muller for a soft falloff
    const u = Math.max(1e-6, Math.random());
    const v = Math.random();
    const mag = Math.sqrt(-2 * Math.log(u)) * spreadDeg * 0.5;
    const ang = 2 * Math.PI * v;
    const dLat = mag * Math.cos(ang);
    const dLng = (mag * Math.sin(ang)) / Math.cos(lat * DEG);
    const [x, y, z] = latLngToVec3(lat + dLat, lng + dLng, radius);
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return out;
}
