import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MILESTONES, TRAVEL } from "../data/milestones";
import {
  LAT,
  VIEW_DEPTH,
  STEP,
  clamp,
  project,
  roadColor,
  roadElevation,
  roadHalfWidth,
  smoothstep,
} from "../road/engine";
import { Terrain } from "../road/terrain";
import { EmberField } from "../road/embers";
import Footer from "./Footer";

const ease = [0.22, 1, 0.36, 1] as const;
const TAU = 0.16; // smoothing time-constant for the scroll camera (seconds)

/** How far ahead (world units) a station sits when the camera "arrives" at it. */
const ARRIVE_DZ = 1300;

/** Per-kind accent for station markers — echoes the tag colour. */
const KIND_RGB: Record<string, string> = {
  education: "255,196,92",
  career: "255,126,56",
  teaching: "84,233,222",
};

/** Scroll-Y for each station's resting camera position. */
const SNAP_Z = MILESTONES.map((m) => clamp(m.z - ARRIVE_DZ, 0, TRAVEL));

/** Sampled road cross-section at one depth slice. */
interface RoadPt {
  cx: number;
  cy: number;
  lx: number;
  ly: number;
  rx: number;
  ry: number;
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
  const activeRef = useRef(0);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const cvs = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cvs || !wrap) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const embers = reduce ? null : new EmberField(64);
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

      const camZ = p * TRAVEL;
      const camX = LAT(camZ);
      const camY = roadElevation(camZ); // eye rides the valley floor

      ctx.clearRect(0, 0, W, H);

      // digital land: dense organic point cloud forming the valley
      terrain.draw(ctx, W, H, camX, camZ, camY);

      // atmosphere: drifting embers
      embers?.draw(ctx, W, H, dt, t);

      // sample the road ahead, following the valley floor, tapering with depth
      const pts: RoadPt[] = [];
      for (let z = camZ + 40; z < camZ + VIEW_DEPTH; z += STEP) {
        const el = roadElevation(z);
        const dz = z - camZ;
        const half = roadHalfWidth(dz);
        const c = project(LAT(z), z, el, camX, camZ, camY, W, H);
        if (!c) continue;
        const l = project(LAT(z) - half, z, el, camX, camZ, camY, W, H);
        const r = project(LAT(z) + half, z, el, camX, camZ, camY, W, H);
        if (!l || !r) continue;
        pts.push({
          cx: c.x,
          cy: c.y,
          lx: l.x,
          ly: l.y,
          rx: r.x,
          ry: r.y,
          scale: c.scale,
          dz: c.dz,
          depthT: Math.min(c.dz / VIEW_DEPTH, 1),
        });
      }

      if (pts.length > 1) {
        const vp = pts[pts.length - 1];

        // breathing warm halo at the vanishing point (the destination glow)
        const pulse = 1 + 0.05 * Math.sin(t * 1.3);
        const haloR = Math.max(W, H) * 0.22 * pulse;
        const halo = ctx.createRadialGradient(vp.cx, vp.cy, 0, vp.cx, vp.cy, haloR);
        halo.addColorStop(0, `rgba(255,214,140,${0.4 + speed * 0.24})`);
        halo.addColorStop(0.4, `rgba(255,150,60,${0.12 + speed * 0.1})`);
        halo.addColorStop(1, "rgba(255,150,60,0)");
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, W, H);

        // wide soft bloom underlay along the centreline
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(pts[0].cx, pts[0].cy);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].cx, pts[i].cy);
        ctx.strokeStyle = "rgba(255,236,200,0.26)";
        ctx.lineWidth = 18;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.shadowColor = "rgba(255,150,60,0.9)";
        ctx.shadowBlur = 30 + speed * 22;
        ctx.stroke();
        ctx.restore();

        // tarmac body — perspective ribbon with a softly lit crown
        ctx.lineJoin = "round";
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          ctx.beginPath();
          ctx.moveTo(a.lx, a.ly);
          ctx.lineTo(b.lx, b.ly);
          ctx.lineTo(b.rx, b.ry);
          ctx.lineTo(a.rx, a.ry);
          ctx.closePath();
          const grad = ctx.createLinearGradient(a.lx, a.ly, a.rx, a.ry);
          grad.addColorStop(0, roadColor(a.depthT, 0.34));
          grad.addColorStop(0.5, roadColor(a.depthT, 0.95));
          grad.addColorStop(1, roadColor(a.depthT, 0.34));
          ctx.fillStyle = grad;
          ctx.fill();
        }

        // luminous tapering edge rails for a crisp, modern definition
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.lineCap = "round";
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const lw = 0.6 + (1 - a.depthT) * 2.6;
          const al = 0.62 * (1 - a.depthT) + 0.1;
          ctx.strokeStyle = `rgba(255,242,218,${al})`;
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.moveTo(a.lx, a.ly);
          ctx.lineTo(b.lx, b.ly);
          ctx.moveTo(a.rx, a.ry);
          ctx.lineTo(b.rx, b.ry);
          ctx.stroke();
        }
        ctx.restore();

        // transverse rungs + a centre seam — WORLD-ANCHORED, so they stream
        // toward the camera exactly when the camera advances: motion always
        // matches scroll direction. Reads like a precise, lit architectural ribbon.
        if (!reduce) {
          const RUNG_SP = 230;
          const startZ = Math.ceil((camZ + 70) / RUNG_SP) * RUNG_SP;
          const endZ = camZ + VIEW_DEPTH * 0.8;
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          ctx.lineCap = "round";
          for (let zc = startZ; zc < endZ; zc += RUNG_SP) {
            const dz = zc - camZ;
            const half = roadHalfWidth(dz);
            const el = roadElevation(zc);
            const L = project(LAT(zc) - half, zc, el, camX, camZ, camY, W, H);
            const R = project(LAT(zc) + half, zc, el, camX, camZ, camY, W, H);
            if (!L || !R) continue;
            const dt2 = Math.min(dz / VIEW_DEPTH, 1);
            const fade = 1 - dt2;
            // transverse rung
            ctx.strokeStyle = `rgba(255,236,206,${fade * 0.3 + 0.03})`;
            ctx.lineWidth = Math.max(0.5, fade * 1.5);
            ctx.beginPath();
            ctx.moveTo(L.x, L.y);
            ctx.lineTo(R.x, R.y);
            ctx.stroke();
            // bright centre node where the seam crosses the rung
            const cx = (L.x + R.x) * 0.5;
            const cy = (L.y + R.y) * 0.5;
            ctx.fillStyle = `rgba(255,248,228,${fade * 0.55 + 0.05})`;
            const nr = Math.max(0.6, fade * 1.8);
            ctx.fillRect(cx - nr * 0.5, cy - nr * 0.5, nr, nr);
          }
          ctx.restore();
        }
      }

      // ---- station markers + active-station detection ----
      let nearest = 0;
      let nearestD = Infinity;
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
        const s = clamp(pr.scale * 3600, 0.45, 2.4);
        const rgb = KIND_RGB[m.kind] ?? "255,224,180";

        // a soft vertical beam rising from the station — a glowing landmark
        const beamH = clamp(pr.scale * 130000, 36, H * 0.46) * (0.5 + prox * 0.8);
        const beamW = Math.max(1.4, s * 2.4);
        const beam = ctx.createLinearGradient(pr.x, pr.y, pr.x, pr.y - beamH);
        const beamA = vis * (0.12 + prox * 0.5);
        beam.addColorStop(0, `rgba(${rgb},${beamA})`);
        beam.addColorStop(1, `rgba(${rgb},0)`);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = beam;
        ctx.fillRect(pr.x - beamW * 0.5, pr.y - beamH, beamW, beamH);

        // node dot — warm, glowing
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, Math.max(1.6, 3.4 * s), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,250,240,${vis * (0.5 + prox * 0.5)})`;
        ctx.shadowColor = `rgba(${rgb},${vis})`;
        ctx.shadowBlur = 16 * s;
        ctx.fill();
        ctx.restore();
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
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -14 }}
                transition={{ duration: 0.5, ease }}
              >
                <div className={`station-tag ${m.kind}`}>{m.tag}</div>
                <h2 className="station-title">{m.title}</h2>
                <p className="station-summary">{m.summary}</p>
                <div className="station-points">
                  {m.sub.map((s) => (
                    <span key={s}>{s}</span>
                  ))}
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
