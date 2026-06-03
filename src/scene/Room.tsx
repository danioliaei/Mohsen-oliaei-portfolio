import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";

import { type SharedUniforms, createPointsMaterial } from "./materials/points";
import { pointsGeometry } from "./buildGeometry";
import { useStore } from "../store";
import { roomAnchor, viewState } from "./viewState";
import { Screen } from "./Screen";

/** TODO: swap this procedural point-cloud interior for public/models/room.glb
 *  (drei useGLTF) once the model is ready — the integration point is this
 *  component; the Screen child stays as-is. */
function buildRoom(): Float32Array {
  const out: number[] = [];
  const X = 1.9;
  const Y = 1.25;
  const Z = 1.5;

  const line = (
    a: [number, number, number],
    b: [number, number, number],
    n: number,
  ) => {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      out.push(
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      );
    }
  };

  const c: [number, number, number][] = [
    [-X, -Y, -Z],
    [X, -Y, -Z],
    [X, -Y, Z],
    [-X, -Y, Z],
    [-X, Y, -Z],
    [X, Y, -Z],
    [X, Y, Z],
    [-X, Y, Z],
  ];
  const edges: [number, number][] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  edges.forEach(([a, b]) => line(c[a], c[b], 70));

  // floor grid
  for (let gx = -X; gx <= X + 0.001; gx += 0.34) line([gx, -Y, -Z], [gx, -Y, Z], 34);
  for (let gz = -Z; gz <= Z + 0.001; gz += 0.34) line([-X, -Y, gz], [X, -Y, gz], 34);

  // desk in front of the screen
  const dx = 1.1,
    dy = -0.35,
    dz = -0.7;
  line([-dx, dy, dz], [dx, dy, dz], 40);
  line([-dx, dy, dz + 0.7], [dx, dy, dz + 0.7], 40);
  line([-dx, dy, dz], [-dx, dy, dz + 0.7], 16);
  line([dx, dy, dz], [dx, dy, dz + 0.7], 16);
  line([-dx, dy, dz], [-dx, -Y, dz], 18);
  line([dx, dy, dz], [dx, -Y, dz], 18);

  // screen frame on the far wall
  const sw = 1.5,
    sh = 0.95,
    sy = 0.12,
    sz = -1.42;
  line([-sw, sy - sh, sz], [sw, sy - sh, sz], 60);
  line([-sw, sy + sh, sz], [sw, sy + sh, sz], 60);
  line([-sw, sy - sh, sz], [-sw, sy + sh, sz], 36);
  line([sw, sy - sh, sz], [sw, sy + sh, sz], 36);

  return new Float32Array(out);
}

export function Room({ shared }: { shared: SharedUniforms }) {
  const theme = useStore((s) => s.theme);
  const group = useRef<Group>(null);

  const geo = useMemo(() => pointsGeometry(buildRoom(), { aCore: 0 }), []);
  const mat = useMemo(
    () => createPointsMaterial(shared, theme, { size: 1.8, opacity: 1, reveal: 1 }),
    [shared, theme],
  );
  useEffect(() => () => mat.dispose(), [mat]);

  useFrame(() => {
    if (group.current) {
      group.current.position.copy(roomAnchor.position);
      group.current.quaternion.copy(roomAnchor.quaternion);
    }
    mat.uniforms.uReveal.value = 1;
    mat.uniforms.uZoom.value = 1;
    mat.uniforms.uOpacity.value = viewState.roomFade;
  });

  return (
    <group ref={group}>
      <points geometry={geo} material={mat} frustumCulled={false} />
      <Screen />
    </group>
  );
}
