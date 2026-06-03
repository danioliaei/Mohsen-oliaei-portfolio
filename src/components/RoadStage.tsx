import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MILESTONES, TRAVEL } from "../data/milestones";
import {
  LAT,
  VIEW_DEPTH,
  clamp,
  getCamEye,
  getViewProj,
  project,
  roadBedY,
  setCamera,
  setLensX,
  smoothstep,
  surfaceY,
} from "../road/engine";
import { WebGPUScene } from "../road/gpu/scene";
import Footer from "./Footer";

const ease = [0.22, 1, 0.36, 1] as const;
const TAU = 0.16; // smoothing time-constant for the scroll camera (seconds)

/** How far ahead (world units) a station sits when the camera "arrives" at it. */
const ARRIVE_DZ = 1300;

/** Per-kind accent (normalised 0..1) for the connector + glints. */
const KIND_RGB_N: Record<string, [number, number, number]> = {
  education: [1.0, 0.769, 0.361],
  career: [1.0, 0.588, 0.314],
  teaching: [0.471, 0.91, 0.878],
};

/** Scroll-Y for each station's resting camera position. */
const SNAP_Z = MILESTONES.map((m) => clamp(m.z - ARRIVE_DZ, 0, TRAVEL));

const easeInOut = (x: number): number =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

export default function RoadStage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(0);
  const [active, setActive] = useState(0);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    const cvs = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cvs || !wrap) return;

    let disposed = false;
    const teardown: Array<() => void> = [];

    (async () => {
      const gpu = await WebGPUScene.create(cvs);
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

      let W = 0;
      let H = 0;
      let dpr = 1;
      let snapYs: number[] = [];
      const computeSnaps = () => {
        const total = Math.max(wrap.offsetHeight - window.innerHeight, 1);
        snapYs = SNAP_Z.map((z) => clamp(z / TRAVEL, 0, 1) * total);
      };
      const resize = () => {
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        W = cvs.clientWidth;
        H = cvs.clientHeight;
        gpu.resize(W, H, dpr);
        computeSnaps();
      };
      resize();
      window.addEventListener("resize", resize);
      teardown.push(() => window.removeEventListener("resize", resize));

      const scrollProgress = () => {
        const total = wrap.offsetHeight - window.innerHeight;
        const passed = clamp(-wrap.getBoundingClientRect().top, 0, total);
        return total > 0 ? passed / total : 0;
      };

      // ---- scroll snapping: settle on the nearest station after each gesture ---
      let snapRAF = 0;
      let snapping = false;
      let idleT: number | undefined;
      let lastDir = 0;

      const animateTo = (ty: number) => {
        cancelAnimationFrame(snapRAF);
        const sy = window.scrollY;
        const dist = ty - sy;
        if (Math.abs(dist) < 2) {
          snapping = false;
          return;
        }
        const dur = clamp(Math.abs(dist) * 0.55, 300, 820);
        const t0 = performance.now();
        snapping = true;
        const step = (now: number) => {
          const e = clamp((now - t0) / dur, 0, 1);
          window.scrollTo(0, sy + dist * easeInOut(e));
          if (e < 1) snapRAF = requestAnimationFrame(step);
          else snapping = false;
        };
        snapRAF = requestAnimationFrame(step);
      };

      const snapToNearest = () => {
        if (snapping || snapYs.length < 2) return;
        const y = window.scrollY;
        const last = snapYs.length - 1;
        let best: number;
        if (y <= snapYs[0]) best = 0;
        else if (y >= snapYs[last]) best = last;
        else {
          best = 0;
          for (let i = 0; i < last; i++) {
            if (y >= snapYs[i] && y <= snapYs[i + 1]) {
              const f = (y - snapYs[i]) / (snapYs[i + 1] - snapYs[i]);
              const thresh = lastDir > 0 ? 0.3 : lastDir < 0 ? 0.7 : 0.5;
              best = f < thresh ? i : i + 1;
              break;
            }
          }
        }
        animateTo(snapYs[best]);
      };

      const onInput = (dir: number) => {
        if (dir) lastDir = dir;
        cancelAnimationFrame(snapRAF);
        snapping = false;
        if (idleT) clearTimeout(idleT);
        idleT = window.setTimeout(snapToNearest, 160);
      };
      const onWheel = (e: WheelEvent) => onInput(Math.sign(e.deltaY));
      const onTouch = () => onInput(0);
      const onKey = (e: KeyboardEvent) => {
        const k = e.key;
        if (k === "ArrowDown" || k === "PageDown" || k === " " || k === "End")
          onInput(1);
        else if (k === "ArrowUp" || k === "PageUp" || k === "Home") onInput(-1);
      };
      window.addEventListener("wheel", onWheel, { passive: true });
      window.addEventListener("touchmove", onTouch, { passive: true });
      window.addEventListener("keydown", onKey);
      teardown.push(() => {
        window.removeEventListener("wheel", onWheel);
        window.removeEventListener("touchmove", onTouch);
        window.removeEventListener("keydown", onKey);
        cancelAnimationFrame(snapRAF);
        if (idleT) clearTimeout(idleT);
      });

      let displayed = 0;
      let prevDisplayed = 0;
      let raf = 0;
      let last = performance.now();
      const startT = last;
      const connScratch = new Float32Array(8); // reused per frame, no allocation

      const frame = (now: number) => {
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        const t = (now - startT) / 1000;

        const target = scrollProgress();
        const k = 1 - Math.exp(-dt / TAU);
        displayed += (target - displayed) * k;
        const p = displayed;

        const vel = Math.abs((displayed - prevDisplayed) / Math.max(dt, 1e-4));
        prevDisplayed = displayed;
        const speed = clamp(vel * 9, 0, 1); // 0..1 motion energy

        const wide = W >= 760;
        // road biases a little left of centre on wide viewports so the weaving
        // route and the right-hand card share the frame; centred when narrow
        const lensX = wide ? 0.43 : 0.5;
        setLensX(lensX);

        const camZ = p * TRAVEL;
        const camX = LAT(camZ);
        setCamera(camX, camZ, W, H); // one shared camera for GPU + overlay

        // vanishing point (a far road point) in screen space — drives the halo
        const zf = camZ + VIEW_DEPTH * 0.88;
        const vpP = project(LAT(zf), zf, roadBedY(zf));
        const vpU = vpP ? clamp(vpP.x / W, -0.5, 1.5) : 0.5;
        const vpV = vpP ? clamp(vpP.y / H, 0, 1) : 0.3;

        // active-station detection (drives the DOM card)
        let nearest = 0;
        let nearestD = Infinity;
        for (let i = 0; i < MILESTONES.length; i++) {
          const d = Math.abs(SNAP_Z[i] - camZ);
          if (d < nearestD) {
            nearestD = d;
            nearest = i;
          }
        }

        // connector: active waypoint → floating card (NDC endpoints + colour)
        let connector: Float32Array | null = null;
        const am = MILESTONES[activeRef.current];
        const card = cardRef.current;
        if (wide && card && am.z - camZ > 60) {
          const pr = project(LAT(am.z), am.z, surfaceY(LAT(am.z), am.z) + 40);
          if (pr) {
            const settle =
              1 - clamp(Math.abs(camZ - SNAP_Z[activeRef.current]) / 1000, 0, 1);
            const ca = (0.22 + settle * 0.78) * (1 - speed * 0.55);
            if (ca > 0.02) {
              const r = card.getBoundingClientRect();
              const tx = r.left - 6;
              const ty = r.top + r.height * 0.5;
              const rgb = KIND_RGB_N[am.kind] ?? [1, 0.85, 0.6];
              connScratch[0] = (pr.x / W) * 2 - 1;
              connScratch[1] = 1 - (pr.y / H) * 2;
              connScratch[2] = (tx / W) * 2 - 1;
              connScratch[3] = 1 - (ty / H) * 2;
              connScratch[4] = rgb[0];
              connScratch[5] = rgb[1];
              connScratch[6] = rgb[2];
              connScratch[7] = ca;
              connector = connScratch;
            }
          }
        }

        gpu.render({
          vp: getViewProj(),
          camX,
          camZ,
          time: t,
          speed,
          W,
          H,
          dpr,
          lensX,
          vpU,
          vpV,
          eyeY: getCamEye()[1],
          connector,
        });

        // commit the active station (with a little hysteresis to avoid flutter)
        if (nearest !== activeRef.current) {
          const dCur = Math.abs(SNAP_Z[activeRef.current] - camZ);
          if (dCur - nearestD > 140) {
            activeRef.current = nearest;
            setActive(nearest);
          }
        }

        // scroll hint + footer fade out once the journey begins
        const fade = 1 - smoothstep(0.01, 0.06, p);
        if (hintRef.current) hintRef.current.style.opacity = String(fade);
        if (footerRef.current)
          footerRef.current.style.opacity = String(0.55 + fade * 0.45);

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
        <Footer ref={footerRef} />
      </>
    );
  }

  const m = MILESTONES[active];
  const idx = String(active + 1).padStart(2, "0");
  const total = String(MILESTONES.length).padStart(2, "0");

  return (
    <>
      <div className="scrollwrap" ref={wrapRef} id="scrollwrap">
        <div className="stage" id="home">
          <canvas id="road" ref={canvasRef} />

          <div className="station-layer">
            <AnimatePresence mode="wait">
              <motion.div
                key={active}
                className="station"
                initial={{ opacity: 0, x: 26, filter: "blur(6px)" }}
                animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, x: 18, filter: "blur(6px)" }}
                transition={{ duration: 0.5, ease }}
              >
                <div className={`station-card ${m.kind}`} ref={cardRef}>
                  <div className="station-head">
                    <span className="station-index">
                      {idx}<i>/{total}</i>
                    </span>
                    <span className="station-kind">{m.kind}</span>
                  </div>
                  <div className="station-tag">{m.tag}</div>
                  <h2 className="station-title">{m.title}</h2>
                  <p className="station-summary">{m.summary}</p>
                  <div className="station-points">
                    {m.sub.map((s) => (
                      <span key={s}>{s}</span>
                    ))}
                  </div>
                </div>
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="scrollhint" ref={hintRef}>
            Scroll<span className="arrow">↓</span>
          </div>
        </div>
      </div>

      <Footer ref={footerRef} />
    </>
  );
}
