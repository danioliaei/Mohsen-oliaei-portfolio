import { useEffect, useRef, useState } from "react";
import { WebGPUScene } from "../road/gpu/scene";
import Footer from "./Footer";

export default function RoadStage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;

    let disposed = false;
    const teardown: Array<() => void> = [];

    (async () => {
      const gpu = await WebGPUScene.create(cvs);
      if (disposed) { gpu?.dispose(); return; }
      if (!gpu || !gpu.attach()) { gpu?.dispose(); setUnsupported(true); return; }
      teardown.push(() => gpu.dispose());

      const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        gpu.resize(cvs.clientWidth, cvs.clientHeight, dpr);
      };
      resize();
      window.addEventListener("resize", resize);
      teardown.push(() => window.removeEventListener("resize", resize));

      let raf = 0;
      const frame = () => {
        gpu.render();
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      teardown.push(() => cancelAnimationFrame(raf));
    })();

    return () => {
      disposed = true;
      for (const fn of teardown) fn();
    };
  }, []);

  if (unsupported) {
    return (
      <>
        <div className="stage gpu-notice" id="home">
          <div className="gpu-notice-inner">
            <p className="gpu-notice-eyebrow">WebGPU required</p>
            <h1 className="gpu-notice-title">A digital world, rendered live.</h1>
            <p className="gpu-notice-body">
              This experience is drawn in real time with WebGPU. Open it in a
              recent Chrome, Edge, Safari, or Firefox to take the journey.
            </p>
          </div>
        </div>
        <Footer />
      </>
    );
  }

  return (
    <>
      <div className="stage" id="home">
        <canvas id="road" ref={canvasRef} />
      </div>
      <Footer />
    </>
  );
}
