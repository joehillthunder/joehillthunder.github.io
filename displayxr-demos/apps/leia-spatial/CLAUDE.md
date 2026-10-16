# CLAUDE.md — leia-spatial

The Leia Inc. site, reimagined as a scroll story with live woven 3D tiles. Content comes from
Leia's OEM presentation ("Making Any Display Feel Spatial", August 2026, source PDF
`eand-OEM-261002.pdf`) and leiainc.com. The deck's business-model content is deliberately left
out. Read `../../CLAUDE.md` first: its rules apply here too.

**Live:** https://joehillthunder.github.io/displayxr-demos/apps/leia-spatial/
**Branch:** `app/leia-spatial`. Ship through a PR to `main`.

## Files
- `index.html`: all copy. Sections in order: hero, five markets, five hurdles, lessons 1–5 (each
  a `.lesson` with one `figure.tile[data-scene]`), "software now exceeds optical complexity",
  all cleared, the four-layer stack (CSS 3D, no canvas), immersity platform, footer.
- `scenes.js`: one three.js builder per `data-scene` value: `hero`, `lens`, `views`,
  `calibration`, `nanoimprint`, `conversion`. Each returns `{ group, update(t, dt), status() }`.
  `status()` feeds the tile's caption.
- `app.js`: the SDK wiring. One `Tile` per figure, with its own renderer and canvas.
- `style.css`: tokens at the top. Dark only, on purpose.

## Inline 3D (@displayxr/inline3d 1.45.1, three 0.161.0, both pinned on jsDelivr)
- One `createInline3D({ lazy: true })` for the document. Every tile is registered once with
  `addScene` (`virtualDisplayHeight` 0.24, `observe` = the figure), so only near-visible tiles
  hold a weave layer.
- Tiles sit in normal flow. Scrolling is the only thing that moves them. **Never** animate a
  tile or any ancestor (transform, opacity, filter, reveal-on-scroll), and never add
  border/radius/shadow to a canvas. The frame line is an `outline` on `.screen`.
- Each canvas: `will-change: transform` from first paint, 2:1 buffer sized and drawn for two
  frames before `addScene`, `.cover` until `handle.firstWoven` and across a resize until
  `handle.rewoven()` (cut via `hidden`, never faded), validate views before clearing and replay
  the last good matrices, `setPixelRatio(1)`, buffers clamped to GL limits and a 2.4 MP budget.
- The page's own rAF draws a tile only when the session hasn't drawn it in the last 150 ms
  (before activation, or while a lazy layer re-arms), so no canvas is ever left undrawn.
- No `backdrop-filter` anywhere. The sticky header is a solid tint and is picked up by the
  SDK's auto-chrome.

## Authoring scenes
- Units: author in `u`, scaled by `S` (0.06 m per u) into metres. `z = 0` is the glass, `+z` is
  toward the viewer. Keep content within about +6 cm and -6 cm (±1 u) for comfort.
- Display rig only. Turn the subject (rotate the rig group); never fly a camera.
- `prefers-reduced-motion` passes `motion = 0`: the cycles that carry meaning (2D/3D switch,
  sweep, roller, depth lift) keep running, but the decorative sway and pointer parallax stop.
- Artwork is procedural (`drawLandscape`), so there are no asset files and nothing to add to
  `assets/LICENSES.md`.

## Flags and testing
- `?2d` forces the mono path. `?debug` logs `firstWoven` per tile and `handle.stats()` every 5 s,
  and exposes `window.leia`.
- 2D check: serve the repo root (for example `python -m http.server 8793 --bind 127.0.0.1`) and
  screenshot with headless Edge (see the hub `CLAUDE.md`). Headless Edge will not go below
  about 500 px wide, so check phone width inside a 400 px iframe.
- Real 3D can only be judged on the Leia panel in the DisplayXR Browser. Ask the user to look.

## Content notes
- The comparison table in lesson 1 was rebuilt from the PDF's text layer. Re-check the 2D/3D
  brightness rows against the slide if anyone questions them.
- Customer and partner names (Bain, Deloitte, Salesforce, NEC, Duolingo, HP, Google, Samsung,
  Acer, ZTE, zSpace, Barco, Avatar Medical, BOE) are from the deck. Remove any that should not
  be public.
