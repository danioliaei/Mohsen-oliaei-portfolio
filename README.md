# Mohsèn Oliaei — Portfolio

> _The road so far._ — a scroll-driven 3D road through a professional path, rendered on `<canvas>` with a warm sunset palette.

Built with the 2026 flagship frontend stack:

- **React 19** + **TypeScript** (strict)
- **Vite 6** for dev/build
- **Motion** (Framer Motion) for UI entrance transitions
- A hand-rolled perspective canvas engine for the road, milestones, embers, and light pulses

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production bundle to dist/
npm run preview  # preview the production build
```

## Structure

```
src/
  data/milestones.ts     # the timeline content (edit here)
  road/engine.ts         # camera / perspective projection math (pure)
  road/embers.ts         # drifting sunset ember particle field
  components/
    Header.tsx           # wordmark + nav
    Footer.tsx           # discipline tags
    RoadStage.tsx        # canvas + cards + HUD, the rAF render loop
  App.tsx
  main.tsx
  index.css
```

## Editing the timeline

Open [`src/data/milestones.ts`](src/data/milestones.ts) and edit the `MILESTONES` array.
`z` is distance down the road (smaller = sooner); keep entries in ascending `z` order.

## Enhancements over the original static page

- Frame-rate-independent scroll easing (exponential smoothing on a time constant)
- Drifting ember particle field + breathing, speed-reactive vanishing-point halo
- Light pulses that flow down the road toward the camera
- Depth-of-field blur and subtle float on distant milestone cards
- Animated nav underlines and staggered Motion entrances
- Working `01 → 05` milestone counter (the original never advanced past `01`)
- `prefers-reduced-motion` support and `:focus-visible` styles
- High-DPI canvas rendering capped at 2× for performance
