import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Quaternion, Vector3 } from "three";
import type { World } from "../../data/world";
import { findNode } from "../../data/world";
import { buildIso } from "../../lib/iso";
import { latLngToVec3 } from "../../lib/geo";
import { concatF32, pointsGeometry } from "../buildGeometry";
import { useStore } from "../../store";
import { type SharedUniforms, createPointsMaterial } from "../materials/points";
import { detectQuality } from "../geoCache";
import { viewState } from "../viewState";
import { PointsLayer } from "./PointsLayer";

const Y = new Vector3(0, 1, 0);
const FACILITY_SCALE = 0.072;

/** A dense disc of ground points so the building reads as sitting on a plot
 *  rather than floating, and the surface stays solid under the bird's-eye view. */
function groundPatch(radius: number, count: number): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius;
    out[i * 3] = Math.cos(a) * r;
    out[i * 3 + 1] = 0;
    out[i * 3 + 2] = Math.sin(a) * r;
  }
  return out;
}

/** The isometric building point cloud at the deepest Built zoom. It is oriented
 *  to the surface normal at the focused leaf and "develops" bottom-up, then fully
 *  resolves into a dense, near-solid scan. Its reveal is driven by an eased local
 *  value (not the globe density ramp), so the camera can pull into a bird's-eye
 *  framing without thinning the model out. */
export function Facility({
  world,
  shared,
}: {
  world: World;
  shared: SharedUniforms;
}) {
  const theme = useStore((s) => s.theme);
  const activeWorld = useStore((s) => s.activeWorld);
  const focusedNodeId = useStore((s) => s.focusedNodeId);

  const node =
    focusedNodeId && activeWorld === world.id
      ? findNode(world, focusedNodeId)
      : null;
  const iso = node?.project?.iso;

  const built = useMemo(() => {
    if (!node || !iso) return null;
    // Density multiplier on top of the already-dense base counts in buildIso.
    const density = detectQuality() < 1 ? 0.6 : 1;
    const raw = buildIso(iso, FACILITY_SCALE, density);
    const ground = groundPatch(1.8 * FACILITY_SCALE, Math.round(2600 * density));
    const rawCount = raw.length / 3;
    const positions = concatF32([raw, ground]);
    const geo = pointsGeometry(positions, {
      aLand: 0,
      aAccent: 0,
      aCore: (i) => (i < rawCount && Math.random() < 0.04 ? 1 : 0),
      // ground plot appears first (aIn 0), structure develops bottom-up and is
      // fully present by reveal ≈ 0.6 — so the eased reveal resolves it completely.
      aIn: (i, _x, y) =>
        i < rawCount ? Math.min(0.6, Math.max(0, y) * 4.2) : 0,
    });

    const dir = new Vector3(...latLngToVec3(node.lat, node.lng, 1));
    const position = dir.clone();
    const quaternion = new Quaternion().setFromUnitVectors(Y, dir.normalize());
    return { geo, position, quaternion };
  }, [node, iso]);

  const mat = useMemo(
    () =>
      createPointsMaterial(shared, theme, { size: 2.3, opacity: 1, reveal: 1 }),
    [shared, theme],
  );
  useEffect(() => () => mat.dispose(), [mat]);

  // Eased reveal: 0 → 1 when a facility is focused, independent of camera dolly.
  const reveal = useRef(0);
  useFrame((_, dtRaw) => {
    const dt = Math.min(0.05, dtRaw);
    const target = built ? 1 : 0;
    reveal.current += (target - reveal.current) * (1 - Math.exp(-5 * dt));
    mat.uniforms.uReveal.value = 1;
    mat.uniforms.uZoom.value = reveal.current;
    mat.uniforms.uOpacity.value = reveal.current * (1 - viewState.roomFade);
  });

  if (!built) return null;

  return (
    <group position={built.position} quaternion={built.quaternion}>
      <PointsLayer geometry={built.geo} material={mat} />
    </group>
  );
}
