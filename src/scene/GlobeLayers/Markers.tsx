import { useMemo } from "react";
import type { ShaderMaterial } from "three";
import type { World } from "../../data/world";
import { findNode } from "../../data/world";
import { clusterPoints, greatCircleArcPoints, latLngToVec3 } from "../../lib/geo";
import { pointsGeometry } from "../buildGeometry";
import { useStore } from "../../store";
import { PointsLayer } from "./PointsLayer";

// Bigger invisible hit-spheres on touch devices so markers are easy to tap.
const COARSE_POINTER =
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(pointer: coarse)").matches;
const HIT_RADIUS = COARSE_POINTER ? 0.12 : 0.07;

/** Glowing pink point clusters at place centroids + great-circle arcs (drawn as
 *  trails of points) from the hub to each country. Deeper nodes carry a higher
 *  aIn so cities fade in only as you descend. Invisible hit-spheres drive the
 *  click-to-drill navigation. */
function buildMarkers(world: World) {
  const pos: number[] = [];
  const aIn: number[] = [];
  const aCore: number[] = [];
  const arcs: number[] = [];

  const walk = (nodes: World["nodes"], depth: number) => {
    for (const n of nodes) {
      const inv = depth <= 1 ? 0.02 : Math.min(0.7, 0.18 + depth * 0.12);
      const [cx, cy, cz] = latLngToVec3(n.lat, n.lng, 1.014);
      pos.push(cx, cy, cz);
      aIn.push(inv);
      aCore.push(1);
      const cl = clusterPoints(n.lat, n.lng, 24, 0.7, 1.012);
      for (let i = 0; i < cl.length; i += 3) {
        pos.push(cl[i], cl[i + 1], cl[i + 2]);
        aIn.push(inv);
        aCore.push(Math.random() < 0.05 ? 1 : 0);
      }
      if (depth === 1) {
        const arc = greatCircleArcPoints(
          world.hub,
          { lat: n.lat, lng: n.lng },
          56,
          1.0,
          0.16,
        );
        for (let i = 0; i < arc.length; i += 3)
          arcs.push(arc[i], arc[i + 1], arc[i + 2]);
      }
      if (n.children) walk(n.children, depth + 1);
    }
  };
  walk(world.nodes, 1);

  return {
    markerGeo: pointsGeometry(new Float32Array(pos), {
      aAccent: 1,
      aIn: (i) => aIn[i],
      aCore: (i) => aCore[i],
    }),
    arcGeo: pointsGeometry(new Float32Array(arcs), {
      aAccent: 2,
      aIn: 0.04,
      aCore: 0,
    }),
  };
}

export function Markers({
  world,
  markerMat,
  arcMat,
}: {
  world: World;
  markerMat: ShaderMaterial;
  arcMat: ShaderMaterial;
}) {
  const activeWorld = useStore((s) => s.activeWorld);
  const mode = useStore((s) => s.mode);
  const focusedNodeId = useStore((s) => s.focusedNodeId);
  const focusNode = useStore((s) => s.focusNode);

  const { markerGeo, arcGeo } = useMemo(() => buildMarkers(world), [world]);

  if (activeWorld !== world.id || mode === "orbit") return null;

  const parent = focusedNodeId ? findNode(world, focusedNodeId) : null;
  const targets = parent ? (parent.children ?? []) : world.nodes;

  return (
    <>
      <PointsLayer geometry={arcGeo} material={arcMat} />
      <PointsLayer geometry={markerGeo} material={markerMat} />
      {targets.map((n) => {
        const [x, y, z] = latLngToVec3(n.lat, n.lng, 1.01);
        return (
          <mesh
            key={n.id}
            position={[x, y, z]}
            onPointerOver={(e) => {
              e.stopPropagation();
              document.body.style.cursor = "pointer";
            }}
            onPointerOut={() => {
              document.body.style.cursor = "";
            }}
            onClick={(e) => {
              e.stopPropagation();
              document.body.style.cursor = "";
              focusNode(n.id);
            }}
          >
            <sphereGeometry args={[HIT_RADIUS, 12, 12]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        );
      })}
    </>
  );
}
