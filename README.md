# Mohsèn Oliaei — Portfolio

> _A mountain, drawn in light._ — a monochrome WebGPU homepage: a single peak
> built from stacked contour lines, orbitable by drag, with surveyor callouts
> that map a professional path up the slope.

Built with the 2026 flagship frontend stack:

- **React 19** + **TypeScript** (strict)
- **Vite 6** for dev/build
- **Motion** (Framer Motion) for the header entrance
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
    device.ts           # WebGPU device bootstrap + resource helpers
    ridgeline.ts        # RidgelineScene renderer, orbit camera, terrain ray-pick
    ridgelineShaders.ts # all WGSL (backdrop halo, terrain, composite, bloom)
  components/
    Header.tsx          # wordmark + nav
    RidgelineStage.tsx  # canvas + survey callouts + orbit controls (the rAF loop)
  App.tsx
  main.tsx
  index.css
```

## Editing the timeline

The surveyor callouts live in the `STATIONS` array in
[`src/components/RidgelineStage.tsx`](src/components/RidgelineStage.tsx). Each
entry pairs a ring `radius` (its plan radius about the summit — keep these in
sync with the `RINGS` array in `ridgelineShaders.ts`) with a `label`, listed
newest (the tight summit ring) → oldest (the wide near-dune ring).

## Highlights

- Drag (mouse / touch) or the arrow keys orbit the summit, with eased motion and
  a capped release-flick
- Hovering a callout (or its slope) lights that career slice with a breathing glow
- Callouts are projected from the exact render camera each frame, so the labels
  stay welded to the mountain as it spins
- Haptic detents on capable phones; a "drag to rotate" affordance that retires
  after first use
- `prefers-reduced-motion` support and `:focus-visible` styles
- High-DPI rendering capped at 2× (with a supersample for clean hairlines)
