import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { MILESTONES } from "../data/milestones";
import {
  LAT,
  STEP,
  TRAVEL,
  VIEW_DEPTH,
  clamp,
  project,
  roadColor,
  smoothstep,
  type Projected,
} from "../road/engine";
import { EmberField } from "../road/embers";
import Footer from "./Footer";

const ease = [0.22, 1, 0.36, 1] as const;
const TAU = 0.18; // smoothing time-constant for the scroll camera (seconds)

export default function RoadStage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const introRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const hudIdxRef = useRef<HTMLDivElement>(null);
  const hudBarRef = useRef<HTMLElement>(null);
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

    // sample a polyline at fractional index (0 = near .. last = far)
    const sampleAt = (pts: Projected[], f: number) => {
      const i = clamp(f, 0, 1) * (pts.length - 1);
      const lo = Math.floor(i);
      const hi = Math.min(lo + 1, pts.length - 1);
      const t = i - lo;
      const a = pts[lo];
      const b = pts[hi];
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        scale: a.scale + (b.scale - a.scale) * t,
      };
    };

    let displayed = 0;
    let prevDisplayed = 0;
    let lastIdx = -1;
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

      ctx.clearRect(0, 0, W, H);

      // atmosphere: drifting embers behind everything
      embers?.draw(ctx, W, H, dt, t);

      // sample the road ahead
      const pts: Projected[] = [];
      for (let z = camZ + 50; z < camZ + VIEW_DEPTH; z += STEP) {
        const pr = project(LAT(z), z, camX, camZ, W, H);
        if (pr) pts.push(pr);
      }

      if (pts.length > 1) {
        const vp = pts[pts.length - 1];

        // breathing warm halo at the vanishing point (brighter when moving)
        const pulse = 1 + 0.05 * Math.sin(t * 1.3);
        const haloR = Math.max(W, H) * 0.28 * pulse;
        const halo = ctx.createRadialGradient(vp.x, vp.y, 0, vp.x, vp.y, haloR);
        halo.addColorStop(0, `rgba(255,210,130,${0.5 + speed * 0.28})`);
        halo.addColorStop(0.4, `rgba(255,150,60,${0.16 + speed * 0.12})`);
        halo.addColorStop(1, "rgba(255,150,60,0)");
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, W, H);

        // wide soft bloom underlay
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.strokeStyle = "rgba(255,236,200,0.30)";
        ctx.lineWidth = 18;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.shadowColor = "rgba(255,150,60,0.9)";
        ctx.shadowBlur = 30 + speed * 22;
        ctx.stroke();
        ctx.restore();

        // crisp colored core, segment by segment (white near -> ember far)
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const c = Math.min(a.dz / VIEW_DEPTH, 1);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = roadColor(c);
          ctx.lineWidth = Math.max(0.6, Math.min(a.scale * 2600, 22));
          ctx.stroke();
        }

        // light pulses flowing toward the camera along the road
        if (!reduce) {
          const COUNT = 5;
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          for (let n = 0; n < COUNT; n++) {
            // f goes 1 (far) -> 0 (near); offset each pulse, loop on time
            let f = 1 - ((t * 0.22 + n / COUNT) % 1);
            f = clamp(f, 0, 1);
            const s = sampleAt(pts, f);
            const r = Math.max(2, Math.min(s.scale * 5200, 26)) * (0.5 + (1 - f) * 0.8);
            const a = 0.6 * (1 - f) + 0.12; // brighter as it nears the camera
            const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
            g.addColorStop(0, `rgba(255,245,225,${a})`);
            g.addColorStop(1, "rgba(255,170,80,0)");
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }
      }

      // milestones: nodes + connectors on canvas, cards as positioned HTML
      let reached = 0;
      MILESTONES.forEach((m, i) => {
        // count milestones we've reached (or are passing) — climbs 01 -> 05
        if (m.z <= camZ + 1800) reached++;

        const pr = project(LAT(m.z), m.z, camX, camZ, W, H);
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

        // node dot
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

        // far cards drift slightly + blur for depth of field
        const float = reduce ? 0 : Math.sin(t * 0.8 + i) * 4 * (1 - s);
        const blur = reduce ? 0 : clamp((pr.dz - 2600) / 2600, 0, 1) * 2.4;
        card.style.opacity = op.toFixed(3);
        card.style.transform = `translate3d(${cx}px, ${cy + float}px, 0) scale(${s.toFixed(3)})`;
        card.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none";
        card.style.zIndex = String(1000 - Math.round(pr.dz));
      });

      // intro / hud / footer driven by scroll progress
      const f = 1 - smoothstep(0.015, 0.07, p);
      if (introRef.current) {
        introRef.current.style.opacity = String(f);
        introRef.current.style.transform = `translateY(${(1 - f) * -24}px) scale(${(1 + (1 - f) * 0.03).toFixed(4)})`;
      }
      if (hintRef.current) hintRef.current.style.opacity = String(f);
      if (footerRef.current) footerRef.current.style.opacity = String(f);
      if (hudRef.current) hudRef.current.style.opacity = String(smoothstep(0.04, 0.1, p));

      const idx = clamp(reached, 1, MILESTONES.length);
      if (idx !== lastIdx && hudIdxRef.current) {
        hudIdxRef.current.textContent =
          String(idx).padStart(2, "0") + " / " + String(MILESTONES.length).padStart(2, "0");
        lastIdx = idx;
      }
      if (hudBarRef.current) hudBarRef.current.style.width = (p * 100).toFixed(1) + "%";

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
                className="mk"
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

          <div className="hud" ref={hudRef} style={{ opacity: 0 }}>
            <div className="idx" ref={hudIdxRef}>
              01 / {String(MILESTONES.length).padStart(2, "0")}
            </div>
            <div className="bar">
              <i ref={hudBarRef} />
            </div>
          </div>
        </div>
      </div>

      <Footer ref={footerRef} />
    </>
  );
}
