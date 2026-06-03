import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { ShaderMaterial } from "three";

import type { World } from "../data/world";
import { focusCountryIndex } from "../data/world";
import { getState, useStore } from "../store";
import { type SharedUniforms, createPointsMaterial } from "./materials/points";
import type { GlobeGeometries } from "./geoCache";
import { viewState } from "./viewState";
import { CloudShell } from "./GlobeLayers/CloudShell";
import { Continents } from "./GlobeLayers/Continents";
import { Borders } from "./GlobeLayers/Borders";
import { Markers } from "./GlobeLayers/Markers";
import { Facility } from "./GlobeLayers/Facility";

interface MatEntry {
  m: ShaderMaterial;
  base: number;
}

/** One world's globe: ocean shell + dot-density continents + dotted borders /
 *  graticule + markers/arcs + facility. The same shared geometries back both
 *  globes; per-globe uniforms (reveal / zoom / opacity) are updated each frame
 *  from the view-state singleton, so React never re-renders during animation. */
export function Globe({
  world,
  shared,
  geo,
}: {
  world: World;
  shared: SharedUniforms;
  geo: GlobeGeometries;
}) {
  const theme = useStore((s) => s.theme);
  const activeWorld = useStore((s) => s.activeWorld);
  const mode = useStore((s) => s.mode);
  const setActiveWorld = useStore((s) => s.setActiveWorld);
  const beginWorldSwitch = useStore((s) => s.beginWorldSwitch);

  const hover = useRef(false);
  const vis = useRef(1);
  const focusAmt = useRef(0);
  const lastFocus = useRef(0);

  const mats = useMemo(() => {
    const mk = (size: number, opacity: number): MatEntry => ({
      m: createPointsMaterial(shared, theme, { size, opacity }),
      base: opacity,
    });
    return {
      ocean: mk(1.5, 0.34),
      // dense land reads as solid continents (the masses); borders outline them.
      land: mk(2.3, 0.9),
      // borders are clean periwinkle outlines over the land — present, not a wash.
      borders: mk(2.0, 0.78),
      graticule: mk(1.2, 0.22),
      marker: mk(5.2, 1.0),
      arc: mk(1.7, 0.66),
    };
  }, [shared, theme]);

  useEffect(() => {
    const created = mats;
    return () => {
      for (const { m } of Object.values(created)) m.dispose();
    };
  }, [mats]);

  useFrame((_, dtRaw) => {
    const dt = Math.min(0.05, dtRaw);
    const s = getState();
    const isFront = world.id === s.activeWorld;
    const reveal = isFront ? viewState.zoom : 0;
    const visTarget = s.mode === "orbit" ? 1 : isFront ? 1 : 0;
    vis.current += (visTarget - vis.current) * (1 - Math.exp(-6 * dt));

    const hovered = hover.current && !isFront && s.mode === "orbit";
    const hoverMul = hovered ? 1.2 : 1;
    const revealH = reveal + (hovered ? 0.06 : 0);
    const op = vis.current * (1 - viewState.roomFade);

    for (const { m, base } of Object.values(mats)) {
      m.uniforms.uReveal.value = revealH;
      m.uniforms.uZoom.value = reveal;
      m.uniforms.uOpacity.value = base * op * hoverMul;
    }

    // focus spotlight: light the focused country on the geography layers only
    // (markers/arcs stay full strength). Eased so it fades in/out smoothly.
    const idx = isFront ? focusCountryIndex(world, s.focusedNodeId) : 0;
    if (idx > 0) lastFocus.current = idx;
    const amtTarget = idx > 0 ? 1 : 0;
    focusAmt.current += (amtTarget - focusAmt.current) * (1 - Math.exp(-5 * dt));
    for (const m of [mats.land.m, mats.borders.m]) {
      m.uniforms.uFocusCountry.value = lastFocus.current;
      m.uniforms.uFocusAmt.value = focusAmt.current;
    }
  });

  const isFront = world.id === activeWorld;
  const showCollider = !isFront && mode === "orbit";

  return (
    <>
      <CloudShell geometry={geo.ocean} material={mats.ocean.m} />
      <Continents geometry={geo.land} material={mats.land.m} />
      <Borders
        borders={geo.borders}
        graticule={geo.graticule}
        borderMat={mats.borders.m}
        graticuleMat={mats.graticule.m}
      />
      <Markers world={world} markerMat={mats.marker.m} arcMat={mats.arc.m} />
      <Facility world={world} shared={shared} />

      {showCollider && (
        <mesh
          onPointerOver={(e) => {
            e.stopPropagation();
            hover.current = true;
            document.body.style.cursor = "pointer";
          }}
          onPointerOut={() => {
            hover.current = false;
            document.body.style.cursor = "";
          }}
          onClick={(e) => {
            e.stopPropagation();
            const st = getState();
            if (st.transitioning || st.activeWorld === world.id) return;
            document.body.style.cursor = "";
            setActiveWorld(world.id);
            beginWorldSwitch();
          }}
        >
          <sphereGeometry args={[1.06, 24, 24]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
