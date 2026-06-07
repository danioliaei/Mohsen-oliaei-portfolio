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

## Deploy to Cloudflare

This repo deploys as a [Cloudflare Workers static-assets](https://developers.cloudflare.com/workers/static-assets/)
site — the `dist/` bundle is served directly, with no server code. The config
lives in [`wrangler.toml`](wrangler.toml) (the `[assets]` block, including the
SPA fallback via `not_found_handling`) and the Node version in [`.nvmrc`](.nvmrc).

**Option A — Git integration (auto-deploy on push, recommended)**

1. In the Cloudflare dashboard: **Workers & Pages → Create → Workers → Connect to Git**.
2. Pick this repository.
3. Set the build settings:
   - **Build command:** `npm run build`
   - **Deploy command:** `npx wrangler deploy`
4. Save & deploy. Every push to the production branch ships a new build, and each
   pull request gets its own preview URL.

**Option B — Direct upload from your machine (Wrangler CLI)**

```bash
npx wrangler login      # one-time browser auth
npm run cf:preview      # build + preview locally with wrangler dev
npm run deploy          # build + upload to Cloudflare
```

> The first `wrangler deploy` will prompt to create the Worker
> (name `mohsen-oliaei-portfolio`). After that it publishes a live URL like
> `https://mohsen-oliaei-portfolio.<your-subdomain>.workers.dev`.

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
