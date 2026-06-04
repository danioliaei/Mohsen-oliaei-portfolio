import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MILESTONES, TRAVEL } from "../data/milestones";
import {
  CAM_LIMITS,
  LAT,
  VIEW_DEPTH,
  clamp,
  getCamEye,
  getViewProj,
  project,
  roadBedY,
  setCamOffsets,
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

/** Experience boards — the floating milestone read-outs and the connector line
 *  that ties each to its waypoint — are hidden for now. The camera still journeys
 *  through every station (scroll-snapping is unchanged); only the cards are gone.
 *  Flip to true to bring the read-outs back. */
const SHOW_BOARDS = false;

const easeInOut = (x: number): number =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/** Free-look camera offsets, layered on the scroll-driven base framing. */
type CamOff = { azim: number; elev: number; zoom: number; panX: number; panZ: number };
const CAM_NEUTRAL: CamOff = { azim: 0, elev: 0, zoom: 1, panX: 0, panZ: 0 };
/** Smoothing time-constant (s) for easing the free-look camera to its target. */
const CAM_TAU = 0.11;

export default function RoadStage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(0);
  const [active, setActive] = useState(0);
  const [unsupported, setUnsupported] = useState(false);

  // ---- free-look camera (orbit / zoom / pan) layered on the scroll journey ----
  const camTarget = useRef<CamOff>({ ...CAM_NEUTRAL }); // where the viewer wants it
  const camCur = useRef<CamOff>({ ...CAM_NEUTRAL }); // eased current → pushed to GPU
  const [camMoved, setCamMoved] = useState(false); // drives the recenter affordance

  const recenter = (): void => {
    camTarget.current = { ...CAM_NEUTRAL };
    setCamMoved(false);
  };
  const nudgeZoom = (factor: number): void => {
    const t = camTarget.current;
    t.zoom = clamp(t.zoom * factor, CAM_LIMITS.zoom[0], CAM_LIMITS.zoom[1]);
    setCamMoved(true);
  };

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
      const onWheel = (e: WheelEvent) => {
        if (e.ctrlKey || e.metaKey) return; // ⌘/ctrl-scroll (& pinch) zooms instead
        onInput(Math.sign(e.deltaY));
      };
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

      // ---- free-look: drag to orbit, shift/right-drag to pan, ⌘/ctrl-scroll
      // (or trackpad pinch) to zoom. Mouse/pen only — touch keeps the one-finger
      // scroll journey. All inputs feed camTarget; the frame loop eases toward it.
      let dragging: null | "orbit" | "pan" = null;
      let sx = 0;
      let sy = 0;
      let startOff: CamOff = { ...CAM_NEUTRAL };
      const AZIM_PER_W = 1.15; // a full-width drag ≈ this many radians of yaw
      const ELEV_PER_H = 0.95;
      const PAN_PER_PX = 16; // world units per pixel, scaled by zoom

      const onPointerDown = (e: PointerEvent) => {
        if (e.pointerType === "touch" || (e.button !== 0 && e.button !== 1)) return;
        dragging = e.shiftKey || e.button === 1 ? "pan" : "orbit";
        sx = e.clientX;
        sy = e.clientY;
        startOff = { ...camTarget.current };
        try {
          cvs.setPointerCapture(e.pointerId);
        } catch {
          /* capture is best-effort */
        }
        cvs.style.cursor = "grabbing";
        setCamMoved(true);
      };
      const onPointerMove = (e: PointerEvent) => {
        if (!dragging) return;
        const dx = e.clientX - sx;
        const dy = e.clientY - sy;
        const t = camTarget.current;
        if (dragging === "orbit") {
          t.azim = clamp(
            startOff.azim - (dx / Math.max(W, 1)) * AZIM_PER_W,
            CAM_LIMITS.azim[0], CAM_LIMITS.azim[1],
          );
          t.elev = clamp(
            startOff.elev + (dy / Math.max(H, 1)) * ELEV_PER_H,
            CAM_LIMITS.elev[0], CAM_LIMITS.elev[1],
          );
        } else {
          const k = PAN_PER_PX * camCur.current.zoom;
          t.panX = clamp(startOff.panX - dx * k, CAM_LIMITS.panX[0], CAM_LIMITS.panX[1]);
          t.panZ = clamp(startOff.panZ + dy * k, CAM_LIMITS.panZ[0], CAM_LIMITS.panZ[1]);
        }
      };
      const onPointerUp = (e: PointerEvent) => {
        if (!dragging) return;
        dragging = null;
        cvs.style.cursor = "grab";
        try {
          cvs.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
      };
      const onZoomWheel = (e: WheelEvent) => {
        if (!(e.ctrlKey || e.metaKey)) return; // plain wheel still drives the journey
        e.preventDefault();
        const t = camTarget.current;
        // pinch-open / scroll-up (deltaY < 0) dollies IN (smaller orbit); pinch-close
        // / scroll-down dollies OUT — the natural direction for a trackpad pinch
        t.zoom = clamp(
          t.zoom * Math.exp(e.deltaY * 0.0016),
          CAM_LIMITS.zoom[0], CAM_LIMITS.zoom[1],
        );
        setCamMoved(true);
      };
      const onCtxMenu = (e: Event) => e.preventDefault(); // right-drag pans, no menu

      cvs.addEventListener("pointerdown", onPointerDown);
      cvs.addEventListener("pointermove", onPointerMove);
      cvs.addEventListener("pointerup", onPointerUp);
      cvs.addEventListener("pointercancel", onPointerUp);
      cvs.addEventListener("wheel", onZoomWheel, { passive: false });
      cvs.addEventListener("contextmenu", onCtxMenu);
      cvs.style.cursor = "grab";
      cvs.style.touchAction = "pan-y"; // let vertical touch-scroll the journey
      teardown.push(() => {
        cvs.removeEventListener("pointerdown", onPointerDown);
        cvs.removeEventListener("pointermove", onPointerMove);
        cvs.removeEventListener("pointerup", onPointerUp);
        cvs.removeEventListener("pointercancel", onPointerUp);
        cvs.removeEventListener("wheel", onZoomWheel);
        cvs.removeEventListener("contextmenu", onCtxMenu);
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
        // With the experience boards hidden, the road no longer yields the right
        // of the frame to a card — centre it so the winding route sits balanced in
        // the diorama. (When boards return, it eases back left on wide viewports.)
        const lensX = SHOW_BOARDS && wide ? 0.43 : 0.5;
        setLensX(lensX);

        // ease the free-look offsets toward the viewer's target, then hand them to
        // the engine so orbit/zoom/pan ride smoothly on top of the scroll journey
        const ck = 1 - Math.exp(-dt / CAM_TAU);
        const cc = camCur.current;
        const ct = camTarget.current;
        cc.azim += (ct.azim - cc.azim) * ck;
        cc.elev += (ct.elev - cc.elev) * ck;
        cc.zoom += (ct.zoom - cc.zoom) * ck;
        cc.panX += (ct.panX - cc.panX) * ck;
        cc.panZ += (ct.panZ - cc.panZ) * ck;
        setCamOffsets(cc);

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
        if (SHOW_BOARDS && wide && card && am.z - camZ > 60) {
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

          {SHOW_BOARDS && (
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
          )}

          <div className="scrollhint" ref={hintRef}>
            <span className="scroll-label">Scroll</span>
            <span className="scroll-line" aria-hidden="true" />
          </div>

          <div className={`camhint${camMoved ? " is-hidden" : ""}`} aria-hidden="true">
            Drag to orbit · ⌘/Ctrl-scroll zoom · Shift-drag pan
          </div>

          <div className="camnav" role="group" aria-label="View controls">
            <button
              type="button"
              className="camnav-btn"
              onClick={() => nudgeZoom(1 / 1.18)}
              aria-label="Zoom in"
              title="Zoom in"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5.5v13M5.5 12h13" />
              </svg>
            </button>
            <button
              type="button"
              className="camnav-btn"
              onClick={() => nudgeZoom(1.18)}
              aria-label="Zoom out"
              title="Zoom out"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5.5 12h13" />
              </svg>
            </button>
            <button
              type="button"
              className={`camnav-btn camnav-reset${camMoved ? " is-active" : ""}`}
              onClick={recenter}
              aria-label="Recenter view"
              title="Recenter view"
              disabled={!camMoved}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="3.1" />
                <path d="M12 2.6v3.5M12 17.9v3.5M2.6 12h3.5M17.9 12h3.5" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <Footer ref={footerRef} />
    </>
  );
}
