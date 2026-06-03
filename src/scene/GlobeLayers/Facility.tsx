import { useMemo } from "react";
import { Quaternion, type ShaderMaterial, Vector3 } from "three";
import type { World } from "../../data/world";
import { findNode } from "../../data/world";
import { buildIso } from "../../lib/iso";
import { latLngToVec3 } from "../../lib/geo";
import { concatF32, pointsGeometry } from "../buildGeometry";
import { useStore } from "../../store";
import { PointsLayer } from "./PointsLayer";

const Y = new Vector3(0, 1, 0);
const FACILITY_SCALE = 0.072;

/** A soft disc of ground points so the building reads as sitting on a plot
 *  rather than floating, and the surface stays legible at extreme zoom. */
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
 *  to the surface normal at the focused leaf and "develops" tier by tier — base
 *  points carry a lower aIn than the upper structure, so it grows upward as the
 *  density ramp reveals it. */
export function Facility({
  world,
  material,
}: {
  world: World;
  material: ShaderMaterial;
}) {
  const activeWorld = useStore((s) => s.activeWorld);
  const focusedNodeId = useStore((s) => s.focusedNodeId);

  const node =
    focusedNodeId && activeWorld === world.id
      ? findNode(world, focusedNodeId)
      : null;
  const iso = node?.project?.iso;

  const built = useMemo(() => {
    if (!node || !iso) return null;
    const raw = buildIso(iso, FACILITY_SCALE);
    const ground = groundPatch(1.5 * FACILITY_SCALE, 520);
    const rawCount = raw.length / 3;
    const positions = concatF32([raw, ground]);
    const geo = pointsGeometry(positions, {
      aLand: 0,
      aAccent: 0,
      aCore: (i) => (i < rawCount && Math.random() < 0.05 ? 1 : 0),
      // building develops bottom-up; the ground plot fades in just before it
      aIn: (i, _x, y) => (i < rawCount ? 0.6 + Math.min(0.24, Math.max(0, y) * 5) : 0.54),
    });

    const dir = new Vector3(...latLngToVec3(node.lat, node.lng, 1));
    const position = dir.clone().multiplyScalar(1.0);
    const quaternion = new Quaternion().setFromUnitVectors(Y, dir.normalize());
    return { geo, position, quaternion };
  }, [node, iso]);

  if (!built) return null;

  return (
    <group position={built.position} quaternion={built.quaternion}>
      <PointsLayer geometry={built.geo} material={material} />
    </group>
  );
}
