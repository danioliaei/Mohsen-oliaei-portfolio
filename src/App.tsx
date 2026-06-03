import { useEffect, useState } from "react";

import { Stage } from "./scene/Stage";
import {
  type GlobeGeometries,
  detectQuality,
  prepareGlobe,
} from "./scene/geoCache";
import { getState, useStore } from "./store";

import { TopRail } from "./ui/TopRail";
import { BottomRail } from "./ui/BottomRail";
import { Breadcrumb } from "./ui/Breadcrumb";
import { Crosshair } from "./ui/Crosshair";
import { ZoomControls } from "./ui/ZoomControls";
import { WorldSwitch } from "./ui/WorldSwitch";
import { TitlePlate } from "./ui/TitlePlate";
import { ProjectCard } from "./ui/ProjectCard";
import { FxLayer } from "./ui/FxLayer";
import { Boot } from "./ui/Boot";
import { nudgeZoom } from "./ui/zoomNudge";

export default function App() {
  const initEnvironment = useStore((s) => s.initEnvironment);
  const booted = useStore((s) => s.booted);
  const setBooted = useStore((s) => s.setBooted);

  const [geo, setGeo] = useState<GlobeGeometries | null>(null);
  const [progress, setProgress] = useState(8);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initEnvironment();
  }, [initEnvironment]);

  // build the globe geometry (heavy land sampling) behind the boot screen
  useEffect(() => {
    let alive = true;
    const tick = window.setInterval(
      () => setProgress((p) => Math.min(92, p + Math.random() * 11)),
      170,
    );
    prepareGlobe(detectQuality())
      .then((g) => {
        if (!alive) return;
        setGeo(g);
        setProgress(100);
        window.setTimeout(() => alive && setBooted(true), 220);
      })
      .catch((e: unknown) => {
        console.error(e);
        if (alive) setError("Could not load world data.");
      });
    return () => {
      alive = false;
      window.clearInterval(tick);
    };
  }, [setBooted]);

  // keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = getState();
      switch (e.key) {
        case "Escape":
          if (s.selectedProjectId) s.closeProject();
          else s.ascend();
          break;
        case "+":
        case "=":
        case "ArrowUp":
          nudgeZoom(-1);
          break;
        case "-":
        case "_":
        case "ArrowDown":
          nudgeZoom(1);
          break;
        case "Home":
          s.goHome();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {geo && (
        <div className="stage">
          <Stage geo={geo} />
        </div>
      )}

      <FxLayer />

      <div className="hud">
        <div className="hud__top">
          <TopRail />
          <Breadcrumb />
        </div>
        <div />
        <BottomRail />
      </div>

      <TitlePlate />
      <Crosshair />
      <WorldSwitch />
      <ZoomControls />
      <ProjectCard />

      <Boot booted={booted && !error} progress={error ? 0 : progress} />
      {error && (
        <div className="boot-error label" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
