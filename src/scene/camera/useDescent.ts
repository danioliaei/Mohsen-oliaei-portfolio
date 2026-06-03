/* ============================================================================
   Descent engine.

   Owns the camera and both globe orientations. Navigation works by rotating the
   active globe so the focus point faces the camera (+Z) and dollying in — the
   limb of the sphere therefore always stays in frame, so descending reads as
   dropping out of the sky toward a curved planet rather than panning a flat map.

   - Continuous wheel / pinch dolly with zoom-to-cursor (raycast against an
     analytic sphere; the picked point eases toward centre as you zoom).
   - Crossing thresholds commits a LOD change (enter world / drill to the node
     under the crosshair / ascend).
   - Discrete nav (clicks, breadcrumb, keys) just retargets; a critically-damped
     rig eases the camera there (frame-rate independent).
   - World switch = a scalar GSAP tween the frame loop reads to swap globe depth
     and arc the camera. Room = a match-cut crossfade with the camera frozen.

   See DECISIONS.md for the rationale behind the damped-rig + GSAP-scalar hybrid.
   ========================================================================== */

import { useEffect, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import {
  type Group,
  type PerspectiveCamera,
  Quaternion,
  Raycaster,
  Sphere,
  Vector2,
  Vector3,
} from "three";
import gsap from "gsap";

import {
  CAM_DIST,
  DOLLY,
  FOV,
  GLOBE_RADIUS,
  type LodState,
  SLOT,
} from "../../theme";
import { WORLDS, findNode } from "../../data/world";
import { latLngToVec3 } from "../../lib/geo";
import { getState, type WorldId } from "../../store";
import { distToZoom, roomAnchor, viewState } from "../viewState";

const Z = new Vector3(0, 0, 1);
const Y = new Vector3(0, 1, 0);
const ORIGIN = new Vector3(0, 0, 0);
const ORBIT_LOOK = new Vector3(0.42, 0.0, -0.5);

interface GroupRefs {
  built: React.RefObject<Group | null>;
  digital: React.RefObject<Group | null>;
}

function fovFor(lod: LodState): number {
  switch (lod) {
    case "ORBIT":
      return FOV.ORBIT;
    case "WORLD":
      return 40;
    case "COUNTRY":
      return 38;
    case "CITY":
      return 36;
    default:
      return FOV.SURFACE;
  }
}

/** Quaternion that rotates a local direction onto +Z (brings a node to front). */
function quatToFront(localDir: Vector3): Quaternion {
  return new Quaternion().setFromUnitVectors(localDir.clone().normalize(), Z);
}

function nodeLocalDir(worldId: WorldId, id: string): Vector3 | null {
  const node = findNode(WORLDS[worldId], id);
  if (!node) return null;
  const [x, y, z] = latLngToVec3(node.lat, node.lng, 1);
  return new Vector3(x, y, z);
}

/** critically-damped approach factor for a given response time. */
function k(dt: number, lambda: number): number {
  return 1 - Math.exp(-lambda * dt);
}

export function useDescent(groups: GroupRefs) {
  const camera = useThree((st) => st.camera) as PerspectiveCamera;
  const gl = useThree((st) => st.gl);

  // --- mutable engine state -------------------------------------------------
  const cam = useRef({
    pos: new Vector3(0.15, 0.28, CAM_DIST.ORBIT),
    look: ORBIT_LOOK.clone(),
    fov: FOV.ORBIT,
  });
  const goalDist = useRef<number>(CAM_DIST.ORBIT);
  const wheelVel = useRef(0);
  const focusQuat = useRef(new Quaternion());
  const spin = useRef({ built: 0, digital: 0 });
  const pointerNDC = useRef(new Vector2(0, 0));
  const cursorAim = useRef(false);
  const drag = useRef({ active: false, x: 0, y: 0, moved: false });
  const pinch = useRef({ active: false, dist: 0 });
  const cooldown = useRef(0);
  const lastNav = useRef<number>(-1);
  const swap = useRef({ running: false, t: 0, from: "built" as WorldId });
  const room = useRef({ in: false });
  const ray = useRef(new Raycaster());
  const tmp = useRef(new Vector3());
  const tmpQ = useRef(new Quaternion());

  // --- input listeners ------------------------------------------------------
  useEffect(() => {
    const el = gl.domElement;

    const setNDC = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      pointerNDC.current.set(
        ((cx - r.left) / r.width) * 2 - 1,
        -((cy - r.top) / r.height) * 2 + 1,
      );
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = getState();
      if (s.transitioning || room.current.in) return;
      setNDC(e.clientX, e.clientY);
      cursorAim.current = true;
      const d = Math.max(-130, Math.min(130, e.deltaY));
      wheelVel.current += d * 0.0009;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      drag.current = { active: true, x: e.clientX, y: e.clientY, moved: false };
    };
    const onPointerMove = (e: PointerEvent) => {
      setNDC(e.clientX, e.clientY);
      if (!drag.current.active) return;
      const dx = (e.clientX - drag.current.x) / el.clientWidth;
      const dy = (e.clientY - drag.current.y) / el.clientHeight;
      drag.current.x = e.clientX;
      drag.current.y = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 0.001) drag.current.moved = true;
      applyDragRotate(dx, dy);
    };
    const endDrag = () => {
      drag.current.active = false;
    };

    // touch: one finger rotate (via pointer events above), two finger pinch
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const a = e.touches[0];
      const b = e.touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      setNDC((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      if (!pinch.current.active) {
        pinch.current = { active: true, dist };
        return;
      }
      const s = getState();
      if (s.transitioning || room.current.in) return;
      cursorAim.current = true;
      wheelVel.current += (pinch.current.dist - dist) * 0.004;
      pinch.current.dist = dist;
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch.current.active = false;
    };

    function applyDragRotate(dx: number, dy: number) {
      const s = getState();
      if (s.transitioning || room.current.in) return;
      const yaw = -dx * 3.2;
      const pitch = -dy * 2.4;
      const right = new Vector3().setFromMatrixColumn(camera.matrix, 0);
      tmpQ.current.setFromAxisAngle(Y, yaw);
      focusQuat.current.premultiply(tmpQ.current);
      tmpQ.current.setFromAxisAngle(right, pitch);
      focusQuat.current.premultiply(tmpQ.current);
    }

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [camera, gl]);

  // --- nav helpers ----------------------------------------------------------
  function activeGroup(): Group | null {
    const s = getState();
    return groups[s.activeWorld].current;
  }

  function clampsFor(lod: LodState): [number, number] {
    switch (lod) {
      case "ORBIT":
        return [CAM_DIST.WORLD + 0.34, DOLLY.max];
      case "WORLD":
        return [CAM_DIST.COUNTRY + 0.04, CAM_DIST.WORLD + 0.5];
      case "COUNTRY":
        return [CAM_DIST.CITY + 0.02, CAM_DIST.WORLD + 0.05];
      case "CITY":
        return [CAM_DIST.FACILITY + 0.02, CAM_DIST.COUNTRY + 0.05];
      case "TOWN":
        return [DOLLY.min, CAM_DIST.CITY + 0.05];
      default: // FACILITY / ROOM / SCREEN
        return [DOLLY.min, CAM_DIST.COUNTRY + 0.05];
    }
  }

  /** Pick the navigable child nearest the crosshair (screen centre). */
  function nearestChild(): string | null {
    const s = getState();
    const grp = activeGroup();
    if (!grp) return null;
    const world = WORLDS[s.activeWorld];
    const candidates = s.focusedNodeId
      ? (findNode(world, s.focusedNodeId)?.children ?? [])
      : world.nodes;
    let best: string | null = null;
    let bestScore = Infinity;
    for (const c of candidates) {
      const [x, y, z] = latLngToVec3(c.lat, c.lng, GLOBE_RADIUS);
      tmp.current.set(x, y, z).applyQuaternion(grp.quaternion);
      const toCam = tmp.current.clone().normalize().dot(Z); // front-facing?
      if (toCam < 0.1) continue;
      const ndc = tmp.current.clone().project(camera);
      const score = ndc.x * ndc.x + ndc.y * ndc.y;
      if (score < bestScore) {
        bestScore = score;
        best = c.id;
      }
    }
    return best ?? candidates[0]?.id ?? null;
  }

  function tryDescend() {
    const s = getState();
    if (s.mode === "orbit") {
      s.enterWorld();
      return;
    }
    if (s.mode === "globe") {
      const world = WORLDS[s.activeWorld];
      const focus = s.focusedNodeId ? findNode(world, s.focusedNodeId) : null;
      // deepest built leaf — nothing deeper
      if (focus && !focus.children) return;
      const child = nearestChild();
      if (child) s.focusNode(child);
    }
  }

  function tryAscend() {
    const s = getState();
    if (s.mode === "room") {
      s.ascend();
      return;
    }
    if (s.mode === "globe") {
      if (!s.focusedNodeId) s.goHome();
      else s.ascend();
    }
  }

  // --- set-pieces -----------------------------------------------------------
  function startWorldSwap() {
    const s = getState();
    swap.current.from = s.activeWorld === "built" ? "digital" : "built";
    swap.current.t = 0;
    swap.current.running = true;
    gsap.to(swap.current, {
      t: 1,
      duration: getState().reducedMotion ? 0.5 : 1.4,
      ease: "power3.inOut",
      onComplete: () => {
        swap.current.running = false;
        getState().endWorldSwitch();
      },
    });
  }

  function enterRoom() {
    room.current.in = true;
    // drop the room just in front of the frozen camera (match-cut anchor)
    const fwd = new Vector3();
    camera.getWorldDirection(fwd);
    roomAnchor.position.copy(camera.position).addScaledVector(fwd, 2.7);
    roomAnchor.quaternion.copy(camera.quaternion);
    gsap.to(viewState, {
      roomFade: 1,
      duration: getState().reducedMotion ? 0.3 : 0.75,
      ease: "power2.inOut",
    });
  }

  function exitRoom() {
    room.current.in = false;
    gsap.to(viewState, {
      roomFade: 0,
      duration: getState().reducedMotion ? 0.3 : 0.7,
      ease: "power2.inOut",
    });
  }

  function onNavChange() {
    const s = getState();
    goalDist.current = (CAM_DIST as Record<string, number>)[s.lod] ?? CAM_DIST.WORLD;
    cooldown.current = 0.45;
    wheelVel.current = 0;
    if (s.mode !== "orbit" && s.focusedNodeId) {
      const dir = nodeLocalDir(s.activeWorld, s.focusedNodeId);
      if (dir) focusQuat.current.copy(quatToFront(dir));
    } else if (s.mode === "globe" && !s.focusedNodeId) {
      // entering a world: face the hub (Sweden for Built) — the richest content
      const hub = WORLDS[s.activeWorld].hub;
      const [x, y, z] = latLngToVec3(hub.lat, hub.lng, 1);
      focusQuat.current.copy(quatToFront(new Vector3(x, y, z)));
    }
  }

  // --- per-frame ------------------------------------------------------------
  useFrame((_, dtRaw) => {
    const dt = Math.min(0.05, dtRaw);
    const s = getState();
    viewState.time += dt;
    viewState.motion = s.reducedMotion ? 0 : 1;
    cooldown.current = Math.max(0, cooldown.current - dt);

    const gBuilt = groups.built.current;
    const gDigital = groups.digital.current;
    if (!gBuilt || !gDigital) return;

    // detect discrete nav / set-piece edges
    if (s.navToken !== lastNav.current) {
      lastNav.current = s.navToken;
      onNavChange();
    }
    if (s.worldSwitching && !swap.current.running) startWorldSwap();
    if (s.mode === "room" && !room.current.in) enterRoom();
    if (s.mode !== "room" && room.current.in) exitRoom();

    // ---- continuous dolly + commit checks (not during set-pieces) ----
    if (!s.transitioning && !room.current.in) {
      goalDist.current += wheelVel.current;
      wheelVel.current *= 0.82;
      const [lo, hi] = clampsFor(s.lod);
      if (cooldown.current <= 0) {
        if (goalDist.current < lo) {
          tryDescend();
        } else if (goalDist.current > hi) {
          tryAscend();
        }
      }
      goalDist.current = Math.max(lo - 0.2, Math.min(hi + 0.2, goalDist.current));

      // zoom-to-cursor: ease the picked point toward centre while dollying
      if (cursorAim.current && Math.abs(wheelVel.current) > 0.0004) {
        const grp = activeGroup();
        if (grp) {
          ray.current.setFromCamera(pointerNDC.current, camera);
          const hit = ray.current.ray.intersectSphere(
            new Sphere(ORIGIN, GLOBE_RADIUS),
            tmp.current,
          );
          if (hit) {
            const local = hit.clone().applyQuaternion(
              grp.quaternion.clone().invert(),
            );
            focusQuat.current.slerp(quatToFront(local), 0.12);
          }
        }
      } else {
        cursorAim.current = false;
      }
    }

    // ---- globe transforms ----
    const activeId = s.activeWorld;
    const orbit = s.mode === "orbit" && !swap.current.running;

    // gentle auto-advance of the front globe at orbit
    if (orbit && viewState.motion > 0) {
      tmpQ.current.setFromAxisAngle(Y, dt * 0.05);
      focusQuat.current.premultiply(tmpQ.current);
    }

    applyGlobe(gBuilt, "built", activeId, orbit, dt);
    applyGlobe(gDigital, "digital", activeId, orbit, dt);

    // ---- camera ----
    const goal = computeCamGoal(s.lod, s.mode);
    if (!room.current.in) {
      const ka = k(dt, s.transitioning ? 6.5 : 9);
      cam.current.pos.lerp(goal.pos, ka);
      cam.current.look.lerp(goal.look, ka);
      cam.current.fov += (goal.fov - cam.current.fov) * ka;
    }
    camera.position.copy(cam.current.pos);
    camera.lookAt(cam.current.look);
    if (Math.abs(camera.fov - cam.current.fov) > 0.01) {
      camera.fov = cam.current.fov;
      camera.updateProjectionMatrix();
    }

    // ---- shared view state for the shaders ----
    viewState.camDist = camera.position.distanceTo(ORIGIN);
    viewState.zoom = room.current.in ? 1 : distToZoom(viewState.camDist);
  });

  // -------- helpers that need refs (declared after to use closures) --------
  function applyGlobe(
    g: Group,
    id: WorldId,
    activeId: WorldId,
    orbit: boolean,
    dt: number,
  ) {
    const isFront = id === activeId;

    // ---- position / scale (slot layout, or swap interpolation) ----
    if (swap.current.running) {
      // interpolate between old and new slot with an arc
      const t = swap.current.t;
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const newFront = isFront;
      const from = newFront ? BACK_POS : FRONT_POS;
      const to = newFront ? FRONT_POS : BACK_POS;
      g.position.lerpVectors(from, to, e);
      const arc = Math.sin(Math.PI * t) * (newFront ? 0.7 : -0.7);
      g.position.x += arc;
      const fromS = newFront ? SLOT_BACK_SCALE : 1;
      const toS = newFront ? 1 : SLOT_BACK_SCALE;
      const sc = fromS + (toS - fromS) * e;
      g.scale.setScalar(sc);
    } else {
      const targetPos = isFront ? FRONT_POS : BACK_POS;
      const targetScale = isFront ? 1 : SLOT_BACK_SCALE;
      g.position.lerp(targetPos, k(dt, 6));
      const sc = g.scale.x + (targetScale - g.scale.x) * k(dt, 6);
      g.scale.setScalar(sc);
    }

    // ---- orientation ----
    if (isFront) {
      // damp toward focus orientation (orbit auto-advance already applied)
      g.quaternion.slerp(focusQuat.current, k(dt, orbit ? 4 : 7));
    } else {
      // back globe free-spins on its own axis
      spin.current[id] += dt * (id === "built" ? 0.05 : -0.06);
      g.quaternion.setFromAxisAngle(SPIN_AXIS, spin.current[id]);
    }
  }

  function computeCamGoal(lod: LodState, mode: string) {
    if (mode === "orbit") {
      return {
        pos: tmpGoalPos.set(0.15, 0.28, goalDist.current),
        look: ORBIT_LOOK,
        fov: fovFor("ORBIT"),
      };
    }
    // descent: camera on +Z, globe rotates focus to front, slight tilt
    const d = goalDist.current;
    return {
      pos: tmpGoalPos.set(0, d * 0.05, d),
      look: ORIGIN,
      fov: fovFor(lod),
    };
  }
}

// module-scope constants reused across frames (avoid per-frame allocation).
// Back-slot geometry comes from theme.SLOT so it stays the single source.
const SLOT_BACK_SCALE = SLOT.back.scale;
const FRONT_POS = new Vector3(0, 0, 0);
const BACK_POS = new Vector3(
  SLOT.back.position[0],
  SLOT.back.position[1],
  SLOT.back.position[2],
);
const SPIN_AXIS = new Vector3(-0.18, 1, 0.08).normalize();
const tmpGoalPos = new Vector3();
