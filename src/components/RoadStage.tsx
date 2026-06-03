import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { MILESTONES } from "../data/milestones";
import { TRAVEL } from "../data/milestones";
import {
  LAT,
  ROAD_W,
  STEP,
  VIEW_DEPTH,
  clamp,
  project,
  roadColor,
  smoothstep,
  terrainHeight,
} from "../road/engine";
import { Terrain } from "../road/terrain";
import { EmberField } from "../road/embers";
import Footer from "./Footer";

const ease = [0.22, 1, 0.36, 1] as const;
const TAU = 0.16; // smoothing time-constant for the scroll camera (seconds)

/** Sampled road cross-section: centre, both edges, depth fraction. */
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

export default function RoadStage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const introRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const cvs = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cvs || !wrap) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const embers = reduce ? null : new EmberField(70);
    const terrain = new Terrain();

    let W = 0;
    let H = 0;
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = cvs.clientWidth;
      H = cvs.clientHeight;
      cvs.width = W * dpr;
      cvs.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const scrollProgress = () => {
      const total = wrap.offsetHeight - window.innerHeight;
      const passed = clamp(-wrap.getBoundingClientRect().top, 0, total);
      return total > 0 ? passed / total : 0;
    };

    // sample the road centreline at fractional index (0 = near .. 1 = far)
    const sampleAt = (pts: RoadPt[], f: number) => {
      const i = clamp(f, 0, 1) * (pts.length - 1);
      const lo = Math.floor(i);
      const hi = Math.min(lo + 1, pts.length - 1);
      const t = i - lo;
      const a = pts[lo];
      const b = pts[hi];
      return {
        x: a.cx + (b.cx - a.cx) * t,
        y: a.cy + (b.cy - a.cy) * t,
        scale: a.scale + (b.scale - a.scale) * t,
      };
    };

    let displayed = 0;
    let prevDisplayed = 0;
    let raf = 0;
    let last = performance.now();
    let startT = last;

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
      const camY = terrainHeight(camX, camZ); // eye rides the valley floor

      ctx.clearRect(0, 0, W, H);

      // digital hills: dense point cloud forming the valley walls
      terrain.draw(ctx, W, H, camX, camZ, camY);

      // atmosphere: drifting embers
      embers?.draw(ctx, W, H, dt, t);

      // sample the road ahead, following the valley floor
      const pts: RoadPt[] = [];
      for (let z = camZ + 40; z < camZ + VIEW_DEPTH; z += STEP) {
        const el = terrainHeight(LAT(z), z);
        const c = project(LAT(z), z, el, camX, camZ, camY, W, H);
        if (!c) continue;
        const l = project(LAT(z) - ROAD_W, z, el, camX, camZ, camY, W, H);
        const r = project(LAT(z) + ROAD_W, z, el, camX, camZ, camY, W, H);
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
        const haloR = Math.max(W, H) * 0.24 * pulse;
        const halo = ctx.createRadialGradient(vp.cx, vp.cy, 0, vp.cx, vp.cy, haloR);
        halo.addColorStop(0, `rgba(255,210,130,${0.42 + speed * 0.26})`);
        halo.addColorStop(0.4, `rgba(255,150,60,${0.14 + speed * 0.1})`);
        halo.addColorStop(1, "rgba(255,150,60,0)");
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, W, H);

        // wide soft bloom underlay along the centreline
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(pts[0].cx, pts[0].cy);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].cx, pts[i].cy);
        ctx.strokeStyle = "rgba(255,236,200,0.30)";
        ctx.lineWidth = 16;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.shadowColor = "rgba(255,150,60,0.9)";
        ctx.shadowBlur = 28 + speed * 22;
        ctx.stroke();
        ctx.restore();

        // tarmac body — a true perspective ribbon, single warm colour
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
          ctx.fillStyle = roadColor(a.depthT, 0.92);
          ctx.fill();
        }

        // soft road edges for definition
        for (const side of ["l", "r"] as const) {
          ctx.beginPath();
          ctx.moveTo(side === "l" ? pts[0].lx : pts[0].rx, side === "l" ? pts[0].ly : pts[0].ry);
          for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(side === "l" ? pts[i].lx : pts[i].rx, side === "l" ? pts[i].ly : pts[i].ry);
          }
          ctx.strokeStyle = "rgba(255,238,210,0.22)";
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }

        // light pulses flowing toward the camera (forward-motion cue)
        if (!reduce) {
          const COUNT = 5;
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          for (let n = 0; n < COUNT; n++) {
            let f = 1 - ((t * 0.22 + n / COUNT) % 1);
            f = clamp(f, 0, 1);
            const s = sampleAt(pts, f);
            const rad = Math.max(2, Math.min(s.scale * 5200, 26)) * (0.5 + (1 - f) * 0.8);
            const a = 0.6 * (1 - f) + 0.12;
            const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, rad);
            g.addColorStop(0, `rgba(255,245,225,${a})`);
            g.addColorStop(1, "rgba(255,170,80,0)");
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(s.x, s.y, rad, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }
      }

      // milestones: nodes + connectors on canvas, cards as positioned HTML
      MILESTONES.forEach((m, i) => {
        const el = terrainHeight(LAT(m.z), m.z);
        const pr = project(LAT(m.z), m.z, el, camX, camZ, camY, W, H);
        const card = cardRefs.current[i];
        if (!card) return;
        if (!pr) {
          card.style.opacity = "0";
          return;
        }

        const fadeIn = 1 - smoothstep(VIEW_DEPTH * 0.72, VIEW_DEPTH, pr.dz);
        const fadeOut = smoothstep(350, 1300, pr.dz);
        const op = fadeIn * fadeOut;
        const s = Math.max(0.5, Math.min(pr.scale * 3500, 1.2));

        // node dot — warm, glowing
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, 4 * s, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,250,240,${op})`;
        ctx.shadowColor = `rgba(255,180,90,${op})`;
        ctx.shadowBlur = 14 * s;
        ctx.fill();
        ctx.shadowBlur = 0;

        // connector from node up-right to the card anchor
        const cx = pr.x + 26 * s;
        const cy = pr.y - 64 * s;
        ctx.beginPath();
        ctx.moveTo(pr.x, pr.y);
        ctx.lineTo(cx, cy);
        ctx.strokeStyle = `rgba(255,250,240,${op * 0.5})`;
        ctx.lineWidth = 1;
        ctx.stroke();

        const float = reduce ? 0 : Math.sin(t * 0.8 + i) * 4 * (1 - s);
        const blur = reduce ? 0 : clamp((pr.dz - 2600) / 2600, 0, 1) * 2.4;
        card.style.opacity = op.toFixed(3);
        card.style.transform = `translate3d(${cx}px, ${cy + float}px, 0) scale(${s.toFixed(3)})`;
        card.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none";
        card.style.zIndex = String(1000 - Math.round(pr.dz));
      });

      // intro / footer driven by scroll progress
      const fade = 1 - smoothstep(0.015, 0.07, p);
      if (introRef.current) {
        introRef.current.style.opacity = String(fade);
        introRef.current.style.transform = `translateY(${(1 - fade) * -24}px) scale(${(1 + (1 - fade) * 0.03).toFixed(4)})`;
      }
      if (hintRef.current) hintRef.current.style.opacity = String(fade);
      if (footerRef.current) footerRef.current.style.opacity = String(fade);

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <>
      <div className="scrollwrap" ref={wrapRef} id="scrollwrap">
        <div className="stage" id="home">
          <canvas id="road" ref={canvasRef} />
          <div className="markers">
            {MILESTONES.map((m, i) => (
              <div
                className={`mk ${m.kind}`}
                key={m.tag}
                ref={(el) => {
                  cardRefs.current[i] = el;
                }}
                style={{ opacity: 0 }}
              >
                <div className="tag">{m.tag}</div>
                <div className="title">{m.title}</div>
                {m.sub.map((s) => (
                  <div className="sub" key={s}>
                    {s}
                  </div>
                ))}
              </div>
            ))}
          </div>

          <motion.div
            className="intro"
            ref={introRef}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, ease, delay: 0.25 }}
          >
            <div className="kicker">( Professional Path )</div>
            <h1>
              The road
              <br />
              so far.
            </h1>
          </motion.div>

          <div className="scrollhint" ref={hintRef}>
            Scroll<span className="arrow">↓</span>
          </div>
        </div>
      </div>

      <Footer ref={footerRef} />
    </>
  );
}
