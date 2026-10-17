# CLAUDE.md — leia-spatial

The Leia Inc. site, reimagined as a scroll story with live woven 3D tiles. Content comes from
Leia's OEM presentation ("Making Any Display Feel Spatial", August 2026; the PDF is on the user's
PC at `C:\Users\4kDemo\Downloads\eand-OEM-261002.pdf`, extract it with `pdftotext -layout`) and
leiainc.com. The deck's SharePoint link needs email verification, so use the PDF. The deck's business-model content is deliberately left
out. Read `../../CLAUDE.md` first: its rules apply here too.

**Live:** https://joehillthunder.github.io/displayxr-demos/apps/leia-spatial/
**Branch:** `app/leia-spatial` (or `app/leia-spatial-<topic>`). Ship through a PR to `main`.
**In DisplayXR HQ:** the `leia-spatial` entry is the 7th room of the Creator Studio & Spatial UI
wing (`home/demos.js`), with a `BUILD['leia-spatial']` set piece in `home/office.js`: a panel
whose lens ribs switch 2D/3D, floating knot/sphere/icosahedron, and a spinning four-plate stack.
Keep its `desc` and `chatter` in step when the app changes.

## Files
- `index.html`: all copy. Sections in order: hero, five markets (flip cards), five hurdles (flip
  cards), lessons 1–5 (each a `.lesson` with one `figure.tile[data-scene]`), "software now exceeds
  optical complexity", all cleared, the four-layer stack (a woven tile beside the layer list),
  Leia's Platform, footer. No street address anywhere, and never the word "immersity": the user
  asked for both to be removed. Leia's product is always called "Leia's Platform".
- `scenes.js`: one three.js builder per `data-scene` value: `hero`, `lens`, `views`,
  `calibration`, `nanoimprint`, `conversion`, `stack`. Each returns `{ group, update, status }`
  plus optional `pick` + `tap(hit)`, `hover(nx, ny)`, `actions` (buttons under the tile) and
  `select(i)`. Every scene loops on its own and resumes the loop after 10 s without input.
- `app.js`: the SDK wiring and input. One `Tile` per figure, with its own renderer and canvas.
  Drag turns a `turn` group wrapping the scene (eases home after 8 s), tap raycasts with the mono
  camera, arrows/Enter do the same from the keyboard. Also the flip cards (`.flip`) and the
  per-letter spin on `[data-spin]` headlines (hover or click; never automatic, so the page is
  crisp at rest).
- `style.css`: tokens at the top. Dark only, on purpose.

## Interaction ideas already used (don't repeat, build on them)
- Hero: extruded "SPATIAL" (three's TextGeometry, helvetiker bold from jsDelivr); tap a letter to
  flip it, Scatter throws them into depth, Flatten presses everything onto the glass.
- Lens: tap the panel to switch 2D/3D. Views: the viewer's head follows the pointer.
- Calibration: tap the map to correct outward from that point. Nanoimprint: tap the glass to
  steer the roller, tap the roller to pause. Conversion: tap to ripple the point cloud.
- Stack: tap a slab or a list row to pull that layer out; Explode spreads them.

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
  sweep, roller, depth lift) keep running, but the decorative sway, pointer parallax, idle
  letter flips and the CSS letter spin stop.
- Taps raycast against the mono camera even on the woven path. It approximates the tracked eye
  well enough for picking; a precise hit would need the SDK's cursor-depth module.
- Artwork is procedural (`drawLandscape`), so there are no asset files and nothing to add to
  `assets/LICENSES.md`.

## Flags and testing
- `?2d` forces the mono path. `?debug` logs `firstWoven` per tile and `handle.stats()` every 5 s,
  and exposes `window.leia`.
- 2D check: serve the repo root (for example `python -m http.server 8793 --bind 127.0.0.1`) and
  screenshot with headless Edge (see the hub `CLAUDE.md`). Headless Edge will not go below
  about 500 px wide, so check phone width inside a 400 px iframe. Under `--virtual-time-budget`
  the rAF of tiles scrolled into view can stall and CSS animations get caught mid-flight, so test
  a single tile on a scratch page, or use `--timeout` (real time) instead.
- Real 3D can only be judged on the Leia panel in the DisplayXR Browser. Ask the user to look.

## Shipping when git push fails
The repo is large and this PC's connection drops: a full clone and `git push` from a shallow,
blobless clone have both failed ("remote end hung up"). What works:
- Clone with `git clone --depth 1 --filter=blob:none --sparse …` and
  `git sparse-checkout set home displayxr-demos/apps/leia-spatial`.
- Commit locally, then recreate the commit through the API: `POST git/blobs` per changed file,
  `POST git/trees` with `base_tree` = the parent's tree, `POST git/commits`, then
  `POST git/refs` (new branch) or `PATCH git/refs/heads/<branch>`. Check the new tree sha equals
  `git rev-parse HEAD^{tree}`.
- If `main` moved and the PR conflicts (other sessions edit `home/demos.js`, `home/office.js` and
  the hub `CLAUDE.md` constantly), fetch main's copies of those files, re-apply your edits to
  them, and build the commit on main's tree instead.
- Pages takes a minute or two to deploy; poll the live URL with a cache-busting query.

## Content notes
- The comparison table in lesson 1 was rebuilt from the PDF's text layer. Re-check the 2D/3D
  brightness rows against the slide if anyone questions them.
- Customer and partner names (Bain, Deloitte, Salesforce, NEC, Duolingo, HP, Google, Samsung,
  Acer, ZTE, zSpace, Barco, Avatar Medical, BOE) are from the deck. Remove any that should not
  be public.
