# Decisions

Running log of choices made while building the "Two Worlds" point-cloud
portfolio, per the brief's instruction to pick sensible defaults and keep moving.

## Content / sensitivity

- **All project & site copy in `src/data/world.ts` is DRAFT placeholder** keyed
  to Mohsèn's history, to be replaced. The engine is fully data-driven from that
  file — edit copy there.
- ⚠️ **NDA review required before any public deploy.** **Stegra** (Boden, green
  steel) and **Northvolt** (Skellefteå, battery gigafactory) are real and used
  at the owner's instruction. Anything potentially NDA-sensitive (client names,
  figures, scope detail) must be reviewed before deploying. Blurbs are kept
  generic on purpose.
- Iran (Tehran, origin) and USA (remote) are intentional lighter nodes.
- **No invented specifics** — no client names, figures, or confidential details
  beyond the draft above.

## Stack / versions

- **Latest 2026 stack: React 19 + react-three-fiber v9 + drei v10 +
  postprocessing v3, on three r0.184, Vite 8, TypeScript 6 and Zustand 5.** The
  whole toolchain is current as of 2026; the build + typecheck pass clean and the
  app was smoke-tested headlessly (WebGL render + full navigation, no runtime
  errors — only an upstream `THREE.Clock` deprecation warning from R3F).
- TS 6 deprecates `baseUrl`; the `@/*` path alias now resolves relative to the
  tsconfig dir (no `baseUrl`), mirrored by the Vite alias.
- **Plain CSS with custom properties** for the HUD (not Tailwind). The
  editorial/instrument aesthetic wants precise, hand-tuned hairlines, grain and
  tabular numerics; tokens live in `src/styles/tokens.css` and are mirrored as
  shader uniforms in `src/theme.ts` (the two MUST stay in sync).
- **Custom wheel/pinch controller, not Lenis.** Zoom here is a true 3D camera
  dolly toward the cursor, not smooth page scroll, so a bespoke controller in
  the render loop is the right tool. (`src/scene/camera/useDescent.ts`.)

## Scene / camera architecture

- **Navigation = rotate the active globe so the focus point faces the camera
  (+Z), then dolly in along +Z.** Zoom-to-cursor eases the picked sphere point
  toward centre as you dolly.
- **Descent framing (2026 pass).** WORLD frames the whole globe (a recognisable
  dotted Earth). COUNTRY / CITY / TOWN then **fly down toward the focused surface
  point** and look at it from an oblique aerial angle, so the focused region
  fills the frame and its land + borders become legible instead of a distant
  speckle. The camera rig interpolates an **up-vector** alongside position / look
  / fov.
- **Bird's-eye projects.** A Built leaf (FACILITY) is framed from the sky: the
  building's vertical axis is world +Z after focus, so the camera rises along it
  and swings to a 3/4 corner with +Z as camera-up — a high aerial that reads the
  isometric building from above. The facility's reveal is **decoupled** from the
  globe density ramp (its own eased reveal), so this tight framing never thins
  the model; building counts are ~4× denser so it resolves into a near-solid
  point-cloud scan.
- **The active world's globe always sits at the origin**; the inactive one sits
  in a smaller, offset "back" slot. The world switch animates the two trading
  slots (depth swap) and arcs the camera.
- **Hybrid motion model:** a critically-damped rig eases the camera for discrete
  navigation (clicks, breadcrumb, keys), while **GSAP tweens only scalars**
  (`swap.t`, `roomFade`) that the frame loop reads for the cinematic set-pieces
  (world switch, room match-cut). This avoids GSAP/three object-ownership
  conflicts and stays frame-rate independent, while still giving choreographed,
  `power3.inOut`-eased transitions.
- **Reduced motion:** organic shader motion freezes (`uMotion → 0`) and all
  set-piece durations shrink; navigation stays fully usable.

## Geometry / "everything is points"

- **One `ShaderMaterial`** (`src/scene/materials/points.ts`) backs every layer.
  Per-point attributes `aIn/aOut` (density-ramp fade band), `aRand`, `aCore`,
  `aLand`, `aAccent` drive the look; per-layer uniforms set size/opacity/reveal.
- **Land is sampled once with `geoContains`** over a fibonacci candidate set and
  shared by BOTH globes (the back globe just keeps `uZoom = 0`, so its
  density-ramp points stay hidden). This halves the most expensive work.
- **Density / legibility (2026 pass).** Land is sampled far denser (~320k
  candidates → tens of thousands of land points) with ~60% "base" visible from
  orbit and the rest filling in fast, so the continents read as solid dot-density
  texture rather than a sparse scatter. Country outlines (coastlines + borders)
  are a distinct **periwinkle accent** (`aAccent = 2`), denser, and `aOut = 2` so
  they **never fade out on zoom** — countries stay legible all the way in. The
  graticule recedes early to de-clutter close-in views.
- **Focus spotlight.** Land + border points are tagged per country (`aCountry`,
  Sweden/Iran/USA via `world-atlas` `properties.name`); a `uFocusCountry` +
  eased `uFocusAmt` uniform lights the focused country (pink land, bright
  outline) and dims the rest — only on the geography layers, so markers/arcs stay
  full strength. This is what makes "which country am I in" obvious up close.
- **`world-atlas` `countries-110m.json`** provides both land (merged into one
  MultiPolygon for hit-testing) and per-country boundaries (resampled as dotted
  point trails). Copied to `public/geo/`.
- **Blending is theme-dependent:** additive on dark (luminous glow + Bloom),
  normal on light (dark dots on a soft light page). Bloom is gentle and only
  catches the brightest core points.
- **Quality tiers** (`detectQuality`) scale every point budget for mobile/low
  core counts; `PerformanceMonitor` + `AdaptiveDpr` degrade DPR under load.

## Placeholders / TODO slots

- **`public/models/room.glb`** is not yet present; the Digital room is a clean
  procedural point-cloud interior. Swap point is `src/scene/Room.tsx`.
- **Per-project live demos** on the Digital screen are clearly-marked TODO slots
  in `src/scene/Screen.tsx`.
- **Contact link** points to LinkedIn (no email was specified); change in
  `src/ui/TopRail.tsx`.

## Mobile / touch

- **Phones hold up.** DPR is capped (1.5 on coarse/low-power; AdaptiveDpr still
  degrades under load) and MSAA is dropped there, since dense additive points +
  bloom get expensive at retina DPR; bloom is also eased back. Point budgets
  already scale via `detectQuality`.
- **Touch:** one finger rotates, two fingers pinch to zoom/descend (custom
  controller; `touch-action: none` + `user-scalable=no` so the browser doesn't
  hijack the gestures). Marker hit-spheres grow on coarse pointers so they're
  easy to tap; the +/−/⌂ cluster and world switch get larger targets too.
- **Layout:** `env(safe-area-inset-*)` keeps the HUD clear of notches / home
  indicators (`viewport-fit=cover`); the title plate, controls and world switch
  reflow on small screens, the room gallery collapses to one column, and the
  project card goes near-full-width.

## Misc

- Default theme follows `prefers-color-scheme`; toggle recolors HUD + shaders +
  Bloom live. (No localStorage persistence wired, per brief — easy to add.)
