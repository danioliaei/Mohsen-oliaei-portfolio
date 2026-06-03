import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { AdaptiveDpr, PerformanceMonitor } from "@react-three/drei";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import type { Group } from "three";

import { BUILT, DIGITAL } from "../data/world";
import { PALETTE } from "../theme";
import { getState, useStore } from "../store";
import { type GlobeGeometries, detectQuality } from "./geoCache";
import {
  applyThemeToShared,
  createSharedUniforms,
} from "./materials/points";
import { Globe } from "./Globe";
import { Room } from "./Room";
import { useDescent } from "./camera/useDescent";
import { SLOT } from "../theme";

function SceneRoot({
  geo,
  lowPower,
}: {
  geo: GlobeGeometries;
  lowPower: boolean;
}) {
  const theme = useStore((s) => s.theme);
  const mode = useStore((s) => s.mode);
  const gl = useThree((s) => s.gl);

  const shared = useMemo(
    () => createSharedUniforms(theme, gl.getPixelRatio()),
    // create once; theme + dpr are updated below without rebuilding materials
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    applyThemeToShared(shared, theme);
  }, [shared, theme]);

  const builtRef = useRef<Group>(null);
  const digitalRef = useRef<Group>(null);

  useDescent({ built: builtRef, digital: digitalRef });

  useFrame(({ clock }) => {
    shared.uTime.value = clock.elapsedTime;
    shared.uMotion.value = getState().reducedMotion ? 0 : 1;
    shared.uPixelRatio.value = gl.getPixelRatio();
  });

  return (
    <>
      <color attach="background" args={[PALETTE[theme].bg]} />

      <group ref={builtRef}>
        <Globe world={BUILT} shared={shared} geo={geo} />
      </group>
      <group
        ref={digitalRef}
        position={[...SLOT.back.position]}
        scale={SLOT.back.scale}
      >
        <Globe world={DIGITAL} shared={shared} geo={geo} />
      </group>

      {mode === "room" && <Room shared={shared} />}

      {/* Bloom only on dark — on light the bright page would itself bloom and
          wash out the dark dots; light theme has nothing to glow. */}
      {theme === "dark" && (
        <EffectComposer multisampling={0}>
          <Bloom
            intensity={lowPower ? 0.62 : 0.85}
            luminanceThreshold={0.55}
            luminanceSmoothing={0.25}
            mipmapBlur
            radius={lowPower ? 0.5 : 0.62}
          />
        </EffectComposer>
      )}

      <PerformanceMonitor />
      <AdaptiveDpr pixelated />
    </>
  );
}

export function Stage({ geo }: { geo: GlobeGeometries }) {
  // Cap the pixel ratio on phones/low-power GPUs — dense additive points + bloom
  // get expensive at retina DPR. AdaptiveDpr still degrades further under load.
  const lowPower = detectQuality() < 1;
  return (
    <Canvas
      flat
      dpr={[1, lowPower ? 1.5 : 2]}
      gl={{
        antialias: !lowPower,
        alpha: false,
        powerPreference: "high-performance",
        stencil: false,
      }}
      camera={{ position: [0.15, 0.28, 4.4], fov: 42, near: 0.02, far: 200 }}
    >
      <SceneRoot geo={geo} lowPower={lowPower} />
    </Canvas>
  );
}
