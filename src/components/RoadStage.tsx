import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MILESTONES, TRAVEL } from "../data/milestones";
import {
  LAT,
  VIEW_DEPTH,
  STEP,
  clamp,
  project,
  roadElevation,
  setLensX,
  smoothstep,
} from "../road/engine";
import { Terrain } from "../road/terrain";
import { EmberField } from "../road/embers";
import Footer from "./Footer";

const ease = [0.22, 1, 0.36, 1] as const;
const TAU = 0.16; // smoothing time-constant for the scroll camera (seconds)

/** How far ahead (world units) a station sits when the camera "arrives" at it. */
const ARRIVE_DZ = 1300;

/** Per-kind accent for station markers / connectors — echoes the tag colour. */
const KIND_RGB: Record<string, string> = {
  education: "255,196,92",
  career: "255,150,80",
  teaching: "120,232,224",
};

/** Scroll-Y for each station's resting camera position. */
const SNAP_Z = MILESTONES.map((m) => clamp(m.z - ARRIVE_DZ, 0, TRAVEL));

/** Sampled road centreline point at one depth slice. */
interface RoadPt {
  cx: number;
  cy: number;
  scale: number;
  dz: number;
  depthT: number;
}

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

  useEffect(() => {
    const cvs = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cvs || !wrap) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const embers = reduce ? null : new EmberField(48);
    const terrain = new Terrain();

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
      cvs.width = W * dpr;
      cvs.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      computeSnaps();
    };
    resize();
    window.addEventListener("resize", resize);

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
            // bias toward the direction the user was scrolling → "next" station
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

    let displayed = 0;
    let prevDisplayed = 0;
    let raf = 0;
    let last = performance.now();
    const startT = last;

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

      // push the optical axis left on wide viewports so the road rides the left
      // third and the floating cards own the right; ease back to centre on phones
      const wide = W >= 760;
      setLensX(wide ? 0.31 : 0.46);

      const camZ = p * TRAVEL;
      const camX = LAT(camZ);
      const camY = roadElevation(camZ); // eye rides the valley floor

      ctx.clearRect(0, 0, W, H);

      // digital land: flowing topographic contour lines forming the valley
      terrain.draw(ctx, W, H, camX, camZ, camY);

      // atmosphere: a few drifting warm motes
      embers?.draw(ctx, W, H, dt, t);

      // sample the road centreline ahead, following the valley floor
      const pts: RoadPt[] = [];
      for (let z = camZ + 30; z < camZ + VIEW_DEPTH; z += STEP) {
        const el = roadElevation(z);
        const c = project(LAT(z), z, el, camX, camZ, camY, W, H);
        if (!c) continue;
        pts.push({
          cx: c.x,
          cy: c.y,
          scale: c.scale,
          dz: c.dz,
          depthT: Math.min(c.dz / VIEW_DEPTH, 1),
        });
      }

      if (pts.length > 1) {
        const vp = pts[pts.length - 1];

        // breathing warm halo at the vanishing point (the destination glow)
        const pulse = 1 + 0.05 * Math.sin(t * 1.3);
        const haloR = Math.max(W, H) * 0.2 * pulse;
        const halo = ctx.createRadialGradient(vp.cx, vp.cy, 0, vp.cx, vp.cy, haloR);
        halo.addColorStop(0, `rgba(255,196,110,${0.26 + speed * 0.22})`);
        halo.addColorStop(0.45, `rgba(255,140,54,${0.08 + speed * 0.08})`);
        halo.addColorStop(1, "rgba(255,140,54,0)");
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();

        // ---- the road as a single glowing fibre ----
        // one soft cohesive bloom underlay (a single shadow-blurred stroke)
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(pts[0].cx, pts[0].cy);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].cx, pts[i].cy);
        ctx.strokeStyle = `rgba(255,150,60,${0.05 + speed * 0.04})`;
        ctx.lineWidth = 5;
        ctx.shadowColor = "rgba(255,150,60,0.9)";
        ctx.shadowBlur = 22 + speed * 16;
        ctx.stroke();
        ctx.restore();

        // layered tapered strokes → a luminous filament, thick & bright near,
        // thinning to a faint point as it runs to the horizon
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        const PASSES = [
          { w: 15, w0: 1.4, col: "255,148,62", a: 0.05, a1: 0.07 }, // outer amber glow
          { w: 6.0, w0: 1.1, col: "255,196,120", a: 0.1, a1: 0.18 }, // mid warm glow
          { w: 2.6, w0: 0.7, col: "255,232,190", a: 0.22, a1: 0.34 }, // inner warm
          { w: 1.5, w0: 0.45, col: "255,252,245", a: 0.55, a1: 0.42 }, // white-hot core
        ];
        for (const pass of PASSES) {
          for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i];
            const b = pts[i + 1];
            const n = 1 - a.depthT;
            ctx.strokeStyle = `rgba(${pass.col},${pass.a + n * pass.a1})`;
            ctx.lineWidth = pass.w0 + n * pass.w;
            ctx.beginPath();
            ctx.moveTo(a.cx, a.cy);
            ctx.lineTo(b.cx, b.cy);
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      // ---- station waypoints + active-station detection ----
      let nearest = 0;
      let nearestD = Infinity;
      // remember the active station's projected node for the connector
      let activeNode: { x: number; y: number; rgb: string } | null = null;

      MILESTONES.forEach((m, i) => {
        const d = Math.abs(SNAP_Z[i] - camZ);
        if (d < nearestD) {
          nearestD = d;
          nearest = i;
        }
        const el = roadElevation(m.z);
        const pr = project(LAT(m.z), m.z, el, camX, camZ, camY, W, H);
        if (!pr || pr.dz < 50) return;
        const vis = 1 - smoothstep(VIEW_DEPTH * 0.72, VIEW_DEPTH, pr.dz);
        if (vis <= 0.01) return;
        // brighter as this station nears its arrival point
        const prox = 1 - clamp(Math.abs(m.z - (camZ + ARRIVE_DZ)) / 2400, 0, 1);
        const s = clamp(pr.scale * 3200, 0.4, 2.2);
        const rgb = KIND_RGB[m.kind] ?? "255,224,180";

        if (i === activeRef.current) activeNode = { x: pr.x, y: pr.y, rgb };

        ctx.save();
        ctx.globalCompositeOperation = "lighter";

        // a slim waypoint ring sitting on the route — a navigation marker
        const ringR = Math.max(3, 7 * s) * (0.7 + prox * 0.6);
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb},${vis * (0.22 + prox * 0.5)})`;
        ctx.lineWidth = Math.max(0.6, s * 0.9);
        ctx.stroke();

        // glowing node at the centre
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, Math.max(1.4, 2.6 * s), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,250,240,${vis * (0.5 + prox * 0.5)})`;
        ctx.shadowColor = `rgba(${rgb},${vis})`;
        ctx.shadowBlur = 14 * s;
        ctx.fill();
        ctx.restore();
      });

      // ---- connector: a fine line from the active waypoint to the HUD card ----
      const card = cardRef.current;
      if (wide && activeNode && card) {
        const node = activeNode as { x: number; y: number; rgb: string };
        const settle = 1 - clamp(Math.abs(camZ - SNAP_Z[activeRef.current]) / 1000, 0, 1);
        const ca = (0.25 + settle * 0.75) * (1 - speed * 0.55);
        if (ca > 0.02) {
          const r = card.getBoundingClientRect();
          const tx = r.left - 6; // just off the card's left edge
          const ty = r.top + r.height * 0.5;
          // gentle curve leaving the waypoint and sweeping to the card
          const cpx = (node.x + tx) * 0.5;
          const cpy = node.y * 0.5 + ty * 0.5 - 18;

          ctx.save();
          ctx.lineCap = "round";
          ctx.lineJoin = "round";

          // dark occluder under-stroke so the line reads over the bright contours
          ctx.globalCompositeOperation = "source-over";
          ctx.beginPath();
          ctx.moveTo(node.x, node.y);
          ctx.quadraticCurveTo(cpx, cpy, tx, ty);
          ctx.strokeStyle = `rgba(6,7,11,${ca * 0.55})`;
          ctx.lineWidth = 3.8;
          ctx.stroke();

          ctx.globalCompositeOperation = "lighter";
          // soft glow underlay
          ctx.beginPath();
          ctx.moveTo(node.x, node.y);
          ctx.quadraticCurveTo(cpx, cpy, tx, ty);
          ctx.strokeStyle = `rgba(${node.rgb},${ca * 0.28})`;
          ctx.lineWidth = 3;
          ctx.stroke();

          // crisp hairline
          ctx.beginPath();
          ctx.moveTo(node.x, node.y);
          ctx.quadraticCurveTo(cpx, cpy, tx, ty);
          ctx.strokeStyle = `rgba(255,248,236,${ca * 0.85})`;
          ctx.lineWidth = 1;
          ctx.stroke();

          // small attach node on the card edge + short vertical tick
          ctx.beginPath();
          ctx.arc(tx, ty, 2.2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,250,242,${ca})`;
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(tx + 6, ty - 9);
          ctx.lineTo(tx + 6, ty + 9);
          ctx.strokeStyle = `rgba(${node.rgb},${ca * 0.6})`;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.restore();
        }
      }

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
      if (footerRef.current) footerRef.current.style.opacity = String(0.55 + fade * 0.45);

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(snapRAF);
      if (idleT) clearTimeout(idleT);
      window.removeEventListener("resize", resize);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchmove", onTouch);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

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
