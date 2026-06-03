# Mohsèn Oliaei — Two Worlds

An interactive WebGL portfolio for **Mohsèn Oliaei**, Swedish BIM developer &
computational designer. The entire experience is a **navigable point cloud**:
two point-cloud globes — **The Built World** (BIM Coordination) and **The
Digital World** (BIM Development) — that you descend into, level by level, until
the cloud resolves into the actual work.

- **Built** → World → Sweden / Iran / USA → city → an isometric point-cloud
  facility (Stegra at Boden, Northvolt at Skellefteå …) → detail card.
- **Digital** → World → Europe → Sweden → Gothenburg → Partille → _my room_ → a
  screen showing the software projects as a live gallery.

Everything — oceans, continents, borders, markers, route arcs, buildings — is
rendered as points. Continents are sampled from real geography with
`d3-geo` + `world-atlas`.

## Tech

Latest 2026 frontend stack:

Vite 8 · React 19 + TypeScript 6 · react-three-fiber v9 + @react-three/drei v10 ·
@react-three/postprocessing v3 (Bloom) · three r0.184 · GSAP · Zustand 5 ·
d3-geo + world-atlas · Inter (self-hosted via `@fontsource/inter`).

The globes are dense dot-density Earths: continents fill in as you approach,
country outlines (coastlines + borders) glow in periwinkle and stay legible at
every zoom, and the country you descend into is **spotlit** — its land lights up
while the rest dims, so you always know where you are. Descending flies the
camera down to an oblique aerial of the focused region; a Built project resolves
into a near-solid point-cloud building viewed **bird's-eye, from the sky**.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build → dist/
npm run preview    # preview the production build
```

## Editing content

All copy and geography is data-driven from **`src/data/world.ts`** — the single
source of truth. Add/rename places, projects, stacks, lat/lng there and the
scene, navigation, breadcrumb, readout and cards all update.

> ⚠️ Project copy is **draft placeholder**. **Stegra** and **Northvolt** are
> real — review anything potentially NDA-sensitive before deploying. See
> `DECISIONS.md`.

## Structure

```
src/
  App.tsx                  boot + HUD composition + keyboard
  store.ts                 Zustand: world, LOD state machine, theme, focus
  theme.ts                 palette (mirrors tokens.css) + scene/LOD constants
  data/world.ts            content — the single source of truth
  lib/
    geo.ts                 latLngToVec3, land sampling, borders, arcs, graticule
    iso.ts                 isometric facility point clouds
  scene/
    Stage.tsx              <Canvas>, camera, theme background, Bloom, perf
    Globe.tsx              one world's globe + per-frame uniform updates
    GlobeLayers/           CloudShell · Continents · Borders · Markers · Facility
    Room.tsx / Screen.tsx  Digital deepest scene + project gallery
    materials/points.ts    the shared point ShaderMaterial
    camera/useDescent.ts   zoom-to-cursor, LOD rig, world swap, room match-cut
    geoCache.ts            heavy land sampling, built once, shared by both globes
    viewState.ts           per-frame view singleton (no React re-renders)
  ui/                      TopRail · BottomRail · Breadcrumb · Crosshair ·
                           ZoomControls · WorldSwitch · ThemeToggle · ProjectCard
public/
  geo/countries-110m.json  world-atlas TopoJSON
  models/                  room.glb goes here (TODO)
```

## Controls

- **Scroll / pinch** — dolly toward the cursor; crossing thresholds descends or
  ascends a level.
- **Click** a country/city marker to fly in; click the **far globe** (or the
  Built/Digital toggle) to switch worlds.
- **Breadcrumb**, **Home (⌂)**, **+ / −**, and **arrow keys / Esc** all navigate.
- **Theme toggle** (top right) recolors everything; default follows the OS.

`prefers-reduced-motion` is respected. On phones the HUD reflows — safe-area
insets for notches, larger tap targets, a single-column room gallery, a
full-width project card — DPR is capped and point budgets scale down. One finger
rotates the globe, two fingers pinch to zoom/descend, and markers are tappable.

See **`DECISIONS.md`** for architecture rationale and content caveats.
