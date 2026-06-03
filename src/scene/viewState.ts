/* ============================================================================
   Per-frame view state.

   A tiny mutable singleton written once per frame by the camera engine
   (useDescent) and read by the point layers + crosshair. Keeping this out of
   React means the render loop never triggers re-renders.
   ========================================================================== */

import { Quaternion, Vector3 } from "three";
import { CAM_DIST, DOLLY } from "../theme";

export interface ViewState {
  time: number;
  /** Current camera distance to the active globe centre. */
  camDist: number;
  /** 0 at WORLD framing → 1 at the surface. Drives continent density ramp. */
  zoom: number;
  /** 0 when reduced-motion, else 1. */
  motion: number;
  /** 0..1 fade used for the room match-cut handoff (1 = fully in room). */
  roomFade: number;
}

export const viewState: ViewState = {
  time: 0,
  camDist: CAM_DIST.ORBIT,
  zoom: 0,
  motion: 1,
  roomFade: 0,
};

/**
 * Where the room sits for the match-cut: the camera engine drops this just in
 * front of the frozen camera as the dense Partille cluster dissolves, so the
 * room appears exactly where the point cloud was. The Room scene reads it.
 */
export const roomAnchor = {
  position: new Vector3(0, 0, 0),
  quaternion: new Quaternion(),
};

/** Distance at which the density ramp begins (just beyond the WORLD framing), so
 *  continents + borders are already filling in by the time we enter a world. */
const ZOOM_FAR = 3.0;

/** Map a camera distance to a 0..1 closeness used by the shaders. */
export function distToZoom(dist: number): number {
  const z = (ZOOM_FAR - dist) / (ZOOM_FAR - DOLLY.min);
  return Math.min(1, Math.max(0, z));
}
