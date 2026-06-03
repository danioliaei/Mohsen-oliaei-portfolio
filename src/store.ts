/* ============================================================================
   App state — Zustand.

   Holds the navigation/LOD state machine, the active world, theme, and the
   currently open project card. The camera engine (scene/camera/useDescent)
   subscribes to this and animates; UI dispatches the actions below.
   ========================================================================== */

import { create } from "zustand";
import type { Theme } from "./data/world";
import { WORLDS, findNode, pathToNode } from "./data/world";
import type { LodState } from "./theme";

export type SceneMode = "orbit" | "globe" | "room";
export type WorldId = "built" | "digital";

interface AppState {
  /* presentation */
  theme: Theme;
  reducedMotion: boolean;
  booted: boolean;

  /* navigation */
  mode: SceneMode;
  activeWorld: WorldId;
  focusedNodeId: string | null;
  lod: LodState;

  /* transient */
  transitioning: boolean; // camera mid set-piece; gates wheel input
  worldSwitching: boolean; // depth-swap in progress
  selectedProjectId: string | null;

  /* token bumped whenever the camera should re-evaluate its target. */
  navToken: number;

  /* actions */
  initEnvironment: () => void;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  setBooted: (b: boolean) => void;

  setActiveWorld: (id: WorldId) => void;
  beginWorldSwitch: () => void;
  endWorldSwitch: () => void;

  enterWorld: () => void; // ORBIT -> WORLD on the active globe
  focusNode: (id: string) => void; // drill to a node
  ascend: () => void; // step up one LOD
  goHome: () => void; // back to ORBIT
  enterRoom: () => void; // digital room handoff
  enterScreen: () => void; // focus the screen inside the room

  openProject: (id: string) => void;
  closeProject: () => void;

  setTransitioning: (b: boolean) => void;
  bumpNav: () => void;
}

function prefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Coarse LOD label from the current navigation state (drives readout + camera). */
export function deriveLod(
  worldId: WorldId,
  mode: SceneMode,
  focusedNodeId: string | null,
): LodState {
  if (mode === "orbit") return "ORBIT";
  if (mode === "room") return "ROOM";
  if (!focusedNodeId) return "WORLD";

  const world = WORLDS[worldId];
  const node = findNode(world, focusedNodeId);
  const depth = pathToNode(world, focusedNodeId).length;

  if (worldId === "built") {
    return node && !node.children ? "FACILITY" : "COUNTRY";
  }
  // digital — linear descent
  const byDepth: Record<number, LodState> = {
    1: "COUNTRY",
    2: "COUNTRY",
    3: "CITY",
    4: "TOWN",
    5: "ROOM",
  };
  return byDepth[depth] ?? "WORLD";
}

export const useStore = create<AppState>((set, get) => ({
  theme: "dark",
  reducedMotion: false,
  booted: false,

  mode: "orbit",
  activeWorld: "built",
  focusedNodeId: null,
  lod: "ORBIT",

  transitioning: false,
  worldSwitching: false,
  selectedProjectId: null,

  navToken: 0,

  initEnvironment: () => {
    const theme: Theme = prefersDark() ? "dark" : "light";
    const reducedMotion = prefersReducedMotion();
    document.documentElement.setAttribute("data-theme", theme);
    set({ theme, reducedMotion });
  },

  setTheme: (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#08080a" : "#eceef4");
    set({ theme });
  },

  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),

  setBooted: (booted) => set({ booted }),

  setActiveWorld: (activeWorld) =>
    set((s) => ({
      activeWorld,
      lod: deriveLod(activeWorld, s.mode, s.focusedNodeId),
      navToken: s.navToken + 1,
    })),

  beginWorldSwitch: () => set({ worldSwitching: true, transitioning: true }),
  endWorldSwitch: () => set({ worldSwitching: false, transitioning: false }),

  enterWorld: () =>
    set((s) => ({
      mode: "globe",
      focusedNodeId: null,
      selectedProjectId: null,
      lod: deriveLod(s.activeWorld, "globe", null),
      navToken: s.navToken + 1,
    })),

  focusNode: (id) =>
    set((s) => {
      const world = WORLDS[s.activeWorld];
      const node = findNode(world, id);
      if (!node) return {};
      const isLeaf = !node.children;
      // Digital leaf is the room; built leaf is a facility (opens a card).
      if (s.activeWorld === "digital" && id === "room") {
        return {
          mode: "room",
          focusedNodeId: id,
          lod: "ROOM",
          navToken: s.navToken + 1,
        };
      }
      return {
        mode: "globe",
        focusedNodeId: id,
        selectedProjectId:
          s.activeWorld === "built" && isLeaf && node.project
            ? node.project.id
            : null,
        lod: deriveLod(s.activeWorld, "globe", id),
        navToken: s.navToken + 1,
      };
    }),

  ascend: () =>
    set((s) => {
      // Inside the room: step back to the globe leaf.
      if (s.mode === "room") {
        return {
          mode: "globe",
          focusedNodeId: "partille",
          lod: deriveLod(s.activeWorld, "globe", "partille"),
          selectedProjectId: null,
          navToken: s.navToken + 1,
        };
      }
      if (s.mode === "globe") {
        if (!s.focusedNodeId) {
          // WORLD -> ORBIT
          return {
            mode: "orbit",
            lod: "ORBIT",
            selectedProjectId: null,
            navToken: s.navToken + 1,
          };
        }
        const world = WORLDS[s.activeWorld];
        const path = pathToNode(world, s.focusedNodeId);
        const parent = path.length >= 2 ? path[path.length - 2] : null;
        const nextId = parent ? parent.id : null;
        return {
          focusedNodeId: nextId,
          selectedProjectId: null,
          lod: deriveLod(s.activeWorld, "globe", nextId),
          navToken: s.navToken + 1,
        };
      }
      return {};
    }),

  goHome: () =>
    set((s) => ({
      mode: "orbit",
      focusedNodeId: null,
      selectedProjectId: null,
      lod: "ORBIT",
      navToken: s.navToken + 1,
    })),

  enterRoom: () =>
    set((s) => ({
      mode: "room",
      focusedNodeId: "room",
      lod: "ROOM",
      navToken: s.navToken + 1,
    })),

  enterScreen: () => set({ lod: "SCREEN" }),

  openProject: (selectedProjectId) => set({ selectedProjectId }),
  closeProject: () => set({ selectedProjectId: null }),

  setTransitioning: (transitioning) => set({ transitioning }),
  bumpNav: () => set((s) => ({ navToken: s.navToken + 1 })),
}));

/** Non-reactive snapshot for use inside the render loop. */
export const getState = useStore.getState;
