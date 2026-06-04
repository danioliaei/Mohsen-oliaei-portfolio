import { useEffect, useRef, useState } from "react";
import { RidgelineScene } from "../road/gpu/ridgeline";

/* =========================================================================
   RidgelineStage — mounts the monochrome ridgeline experiment.

   A single static hero (no scroll journey, no cards): a black full-screen
   canvas the RidgelineScene draws into on a continuous rAF, with a whisper of
   pointer parallax so the mountain breathes as you move across it. Falls back
   to a quiet notice on browsers without WebGPU.
   ========================================================================= */

export default function RidgelineStage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;

    let disposed = false;
    const teardown: Array<() => void> = [];

    (async () => {
      const gpu = await RidgelineScene.create(cvs);
      if (disposed) {
        gpu?.dispose();
        return;
      }
      if (!gpu || !gpu.attach()) {
        gpu?.dispose();
        setUnsupported(true);
        return;
      }
      teardown.push(() => gpu.dispose());

      const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        gpu.resize(cvs.clientWidth, cvs.clientHeight, dpr);
      };
      resize();
      window.addEventListener("resize", resize);
      teardown.push(() => window.removeEventListener("resize", resize));

      // pointer parallax — eased toward the cursor, recentred when it leaves
      let tpx = 0, tpy = 0; // target (-1..1)
      let px = 0, py = 0;   // eased
      const onMove = (e: PointerEvent) => {
        tpx = (e.clientX / window.innerWidth) * 2 - 1;
        tpy = (e.clientY / window.innerHeight) * 2 - 1;
      };
      const onLeave = () => { tpx = 0; tpy = 0; };
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerout", onLeave, { passive: true });
      teardown.push(() => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerout", onLeave);
      });

      let raf = 0;
      const startT = performance.now();
      const frame = (now: number) => {
        const t = (now - startT) / 1000;
        px += (tpx - px) * 0.04;
        py += (tpy - py) * 0.04;
        gpu.render({ time: t, px, py });
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
      <div className="ridge-stage ridge-notice">
        <div className="gpu-notice-inner">
          <p className="gpu-notice-eyebrow">WebGPU required</p>
          <h1 className="gpu-notice-title">A mountain, drawn in light.</h1>
          <p className="gpu-notice-body">
            This piece is rendered in real time with WebGPU. Open it in a recent
            Chrome, Edge, Safari, or Firefox to see it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="ridge-stage" id="home">
      <canvas id="ridge" ref={canvasRef} />
    </div>
  );
}
