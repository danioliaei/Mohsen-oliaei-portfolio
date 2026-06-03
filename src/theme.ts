/* ============================================================================
   Palette + scene constants.

   The colour values here MUST track src/styles/tokens.css — the same palette
   drives both the CSS HUD and the WebGL point shaders (passed as uniforms).
   ========================================================================== */

import type { Theme } from "./data/world";

export interface Palette {
  bg: string;
  ink: string;
  pink: string;
  blue: string; // periwinkle
}

export const PALETTE: Record<Theme, Palette> = {
  dark: {
    bg: "#08080a",
    ink: "#edf0f6",
    pink: "#ff3eb5",
    blue: "#8fa2ff",
  },
  light: {
    bg: "#eceef4",
    ink: "#23283a",
    pink: "#ff2ea0",
    blue: "#5f76ef",
  },
};

/* ---- Scene geometry --------------------------------------------------------*/

/** Unit radius for every globe; everything else scales off this. */
export const GLOBE_RADIUS = 1;

/** ORBIT layout: which slot a world occupies. FRONT = active/near, BACK = far. */
export const SLOT = {
  front: {
    position: [0, 0, 0] as const,
    scale: 1,
  },
  back: {
    position: [1.06, 0.36, -1.48] as const,
    scale: 0.72,
  },
};

/** Camera distance from the active globe centre for each conceptual level. */
export const CAM_DIST = {
  ORBIT: 4.4,
  WORLD: 2.62,
  COUNTRY: 1.78,
  CITY: 1.42,
  TOWN: 1.28,
  FACILITY: 1.16,
  ROOM: 1.16,
  SCREEN: 1.16,
} as const;

/** Hard clamps for the continuous dolly. */
export const DOLLY = {
  min: 1.1, // closest the user can get to the surface before a handoff
  max: 5.4, // furthest pull-back at ORBIT
};

/** Field of view (deg) eases slightly tighter as we descend. */
export const FOV = {
  ORBIT: 42,
  SURFACE: 34,
};

/* ---- LOD ladders (for the readout + breadcrumb) ----------------------------*/

export type LodState =
  | "ORBIT"
  | "WORLD"
  | "COUNTRY"
  | "CITY"
  | "FACILITY"
  | "TOWN"
  | "ROOM"
  | "SCREEN";

/** Ordered readout chips per world. */
export const LADDER: Record<"built" | "digital", LodState[]> = {
  built: ["ORBIT", "WORLD", "COUNTRY", "CITY", "FACILITY"],
  digital: ["ORBIT", "WORLD", "COUNTRY", "CITY", "TOWN", "ROOM", "SCREEN"],
};

export const LOD_LABEL: Record<LodState, string> = {
  ORBIT: "Orbit",
  WORLD: "World",
  COUNTRY: "Country",
  CITY: "City",
  FACILITY: "Facility",
  TOWN: "Town",
  ROOM: "Room",
  SCREEN: "Screen",
};
