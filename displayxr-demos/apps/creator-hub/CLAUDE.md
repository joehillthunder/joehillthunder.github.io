# CLAUDE.md — Creator Hub (displayxr-demos/apps/creator-hub)

Three pro-style creator tools for DisplayXR (glasses-free 3D on Leia displays, 2D in any browser).
Each one lets you upload or create 3D content and **Push to DisplayXR HQ**. Plain ES modules, no build
step. Served at https://joehillthunder.github.io/displayxr-demos/apps/creator-hub/ . Branch: `app/creator-hub`.
Read `../../CLAUDE.md` (demos rules) and `docs/woven-canvas-rules.md` in DisplayXR/displayxr-web first.

## Layout

| Path | What | In the spirit of |
|---|---|---|
| `index.html` | Landing page: the three tools + recent pushes | — |
| `material/` | **Material Forge**. `gen.js`: tileable noise, 14 generators, layer compositor (colour, roughness, metalness, height, emission; masks: pattern, noise, cavity, edges, paint), normal/AO bake, paint stamps, k-means palette. `presets.js`: 10 starter materials. `main.js`: material library, layer stack UI, object builder (12 primitives, TransformControls, GLB/OBJ/STL upload), paint and pick-colour tools, photo sampler. | Adobe Substance |
| `vehicle/` | **Vehicle Studio**. `car.js`: procedural Coupe/Sedan/SUV from extruded side profiles, 5 rim designs, interior; every mesh has `userData.part`. `main.js`: shared material library edited in place by variants (paint × 7 finishes, rims, calipers, glass, interior, lights, ride height, wheel size), variant sets, 5 environments + HDR upload, floors (shadow / glossy / Reflector mirror / turntable), viewpoints, click-a-part material editor, uploaded-car role guessing. | Autodesk VRED |
| `terra/` | **Terra Studio**. `geo.js`: Web Mercator maths, tile stitching, Terrarium decode, Overpass buildings (with a mirror), CSV parser. `main.js`: terrain table model (S = 10 units, north = -z), shader contours + hypsometric tint, water level, layers rebuilt from stored lon/lat on exaggeration change, GeoJSON/CSV/heightmap/drape upload, tools: identify, measure + SVG profile, line of sight, symbols, extruded buildings, routes. | Esri ArcGIS |
| `view/` | **HQ Viewer**: lists every pushed creation and opens one in 3D (`?id=`). | — |
| `shared/` | `stage.js` (DisplayXR rig), `hq.js` (Push to HQ store), `ui.js` (DOM helpers, GLB I/O, push dialog), `style.css`. | — |

## DisplayXR (inline-3D SDK 1.45.1 from jsDelivr, three 0.161)

`shared/stage.js` `Stage` follows the woven-canvas rules:
- one `createInline3D()` per page, one persistent canvas (`will-change: transform` in CSS from first paint);
- backing store sized 2:1 and two rAFs **before** `addScene`; `rectCover: 'auto'` for resizes;
- an opaque `.stage-cover` on top of the canvas until `handle.firstWoven`, removed with a hard cut;
- validate views before clearing; an unusable frame replays the last good views (redraw every frame);
- orbit camera rig: `cameraRigFromCamera(..., { attach: true })`, convergence = distance to the orbit
  target × `pop`, IPD × clamp(distance / 2.2) × depth gain. Per-eye width capped at 1920 px.
- `snapshot()` returns a Promise; when woven it is taken inside the next woven frame (left eye) so
  nothing is drawn to the woven canvas outside `onFrame`.
- Every chrome element over the canvas carries `data-inline3d-overlay` and is smaller than the tile
  (toolbars, chip, busy chip, toasts, drop hint, modals). No backdrop-filter, opacity or filter on the
  canvas or its ancestors.
- `?mono` forces 2D, `?depth=0-2` sets depth; the viewport chip has a depth slider and a lens toggle.

## Push to HQ

IndexedDB `displayxr-hq` / store `creations` on the joehillthunder.github.io origin. Record
`{ id, app, appName, name, notes, created, thumb, glb (Blob), size, meta }`; a BroadcastChannel
`displayxr-hq` announces changes. Readers: the Creator Gallery section of the HQ `index.html`, the
landing page and `view/`. It is per browser profile: nothing goes to a server, and on localhost it is
a different origin from the live HQ.

## External data (all CORS-enabled)

Elevation: AWS Terrain Tiles (Terrarium). Basemaps: Esri World Imagery / World Topo, OpenStreetMap.
Buildings: Overpass API. Credits are shown in Terra Studio's viewport. Terrarium has no-data pixels
(-15 km over the Hudson at z15); `robustRange()` clamps them.

## Testing on this PC

- Portable Node: `C:\Users\4kDemo\tools\node-v24.11.1-win-x64\node.exe` (`node --check` on a `.mjs` copy).
- Serve `C:\Users\4kDemo\dev` with a tiny Node static server; drive headless Chrome over CDP with
  `--use-angle=swiftshader --enable-unsafe-swiftshader`.
- Debug handles: `window.forge`, `window.studio`, `window.terra`, `window.viewer`. Terra takes `?place=<slug>`.
- Real 3D can only be checked in the DisplayXR Browser on the Leia panel.

## Known gaps

- Woven 3D not yet checked on the panel (all testing so far is 2D headless).
- Vehicle Studio's procedural cars are stylised concepts, not production surfaces.
- Material Forge bakes on the main thread; 1024 px maps take a moment per change.
