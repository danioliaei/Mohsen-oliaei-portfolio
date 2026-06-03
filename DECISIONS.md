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

- **React 18 + react-three-fiber v8 + drei v9 + postprocessing v2** — the most
  stable, well-tested quad at time of writing (v9/v10 R3F requires React 19 and
  is less battle-tested with the wider ecosystem). Easy to bump later.
- **Plain CSS with custom properties** for the HUD (not Tailwind). The
  editorial/instrument aesthetic wants precise, hand-tuned hairlines, grain and
  tabular numerics; tokens live in `src/styles/tokens.css` and are mirrored as
  shader uniforms in `src/theme.ts` (the two MUST stay in sync).
- **Custom wheel/pinch controller, not Lenis.** Zoom here is a true 3D camera
  dolly toward the cursor, not smooth page scroll, so a bespoke controller in
  the render loop is the right tool. (`src/scene/camera/useDescent.ts`.)

## Scene / camera architecture

- **Navigation = rotate the active globe so the focus point faces the camera
  (+Z), then dolly in along +Z.** This guarantees the limb of the sphere stays
  in frame, so descending reads as dropping out of the sky toward a curved
  planet rather than panning a flat map. Zoom-to-cursor is implemented by easing
  the picked sphere point toward centre as you dolly.
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
- **Continents are visible at ORBIT** (the hero dotted Earth) with ~30% "base"
  land points; the remaining land + borders + graticule + city clusters fade in
  via `aIn` as you descend — that is the "gets denser as you approach" ramp.
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

## Misc

- Default theme follows `prefers-color-scheme`; toggle recolors HUD + shaders +
  Bloom live. (No localStorage persistence wired, per brief — easy to add.)
