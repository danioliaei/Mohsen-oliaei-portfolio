# Daniel Oliaei — Portfolio

> _A mountain, drawn in light._ — a monochrome WebGPU homepage: a single peak
> built from stacked contour lines, orbitable by drag, with surveyor callouts
> that map a professional path up the slope.

Built with the 2026 flagship frontend stack:

- **React 19** + **TypeScript** (strict)
- **Vite 6** for dev/build
- **Motion** (Framer Motion) for the overlay panels and scene transitions — the
  header entrance is plain CSS, so the animation library stays off the first-paint path
- **WebGPU** — a hand-rolled real-time renderer (height-field mesh, hidden-line
  removal, bloom, and a composite grade/grain pass)

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production bundle to dist/
npm run preview  # preview the production build
```

> Requires a WebGPU-capable browser (recent Chrome, Edge, Safari, or Firefox).
> Without it the page shows a graceful notice.

## Structure

```
src/
  gpu/
    device.ts             # WebGPU device bootstrap + resource helpers
    ridgeline.ts          # RidgelineScene renderer, orbit camera, terrain ray-pick
    ridgelineShaders.ts   # all WGSL (backdrop halo, terrain, composite, bloom)
  components/
    Header.tsx            # wordmark + nav
    RidgelineStage.tsx    # canvas + survey callouts + orbit controls (the rAF loop); hosts the overlays
    RoleOverlay.tsx       # focused career-station dossier (per-plate role panel)
    ProjectsOverlay.tsx   # the Projects "transit" timeline
    AssignmentOverlay.tsx # "Your Assignment?" client brief (apex beacon)
    BookOverlay.tsx       # "Book me" 1:1 session menu (#book)
  data/
    stations.ts           # the seven career stations (radii + callout labels) — source of truth
    projects.ts           # the project survey plotted on ProjectsOverlay
  perf/                   # dev / VITE_PERF-only WebGPU telemetry harness (see TELEMETRY.md)
    harness.ts            # ?perf=1 capture + HUD + beacon (lazy-loaded chunk)
    types.ts              # shared SceneInfo type (renderer ⇄ harness)
  App.tsx
  main.tsx
  index.css
```

## Editing the timeline

The surveyor callouts live in the `STATIONS` array in
[`src/data/stations.ts`](src/data/stations.ts) (shared between the ridgeline
scene and the focused role overlay). Each entry pairs a ring `radius` (its plan
radius about the summit — keep these in sync with **both** `RINGS` arrays: the
WGSL `RINGS` in `ridgelineShaders.ts` and the JS `RINGS` in `ridgeline.ts`
(`pickBand`)) with a `label`, listed newest (the tight summit ring) → oldest
(the wide near-dune ring).

## Highlights

- Drag (mouse / touch) or the arrow keys orbit the summit, with eased motion and
  a capped release-flick
- Hovering a callout (or its slope) lights that career slice with a breathing glow
- Callouts are projected from the exact render camera each frame, so the labels
  stay welded to the mountain as it spins
- Haptic detents on capable phones; a "drag to rotate" affordance that retires
  after first use
- `prefers-reduced-motion` support and `:focus-visible` styles
- High-DPI rendering capped at 2× on desktop / 2.5× on phone, with a supersample
  for clean hairlines
