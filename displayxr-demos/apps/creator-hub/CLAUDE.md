# CLAUDE.md — Creator Hub (displayxr-demos/apps/creator-hub)

Three pro-style creator tools for DisplayXR (glasses-free 3D on Leia displays, 2D in any browser),
each able to upload or create 3D content and **Push to DisplayXR HQ**. Plain ES modules, no build
step. Served at https://joehillthunder.github.io/displayxr-demos/apps/creator-hub/ . Branch: `app/creator-hub`.
Read `../../CLAUDE.md` (demos rules) and `docs/woven-canvas-rules.md` in DisplayXR/displayxr-web first.

## Tools

| Folder | Tool | In the spirit of | Status |
|---|---|---|---|
| `material/` | Material Forge: layer stacks of tileable procedural generators or photos bake to PBR maps (base, normal, AO·rough·metal, height, emissive); image sampler and palette; 3D painting into layer masks; object builder (primitives, transform gizmo, GLB/OBJ/STL upload) | Adobe Substance | working, tested headless |
| `vehicle/` | Vehicle Studio: procedural coupe/sedan/SUV or uploaded GLB, paint finishes, rims, calipers, glass, interior, variant sets, environments, camera viewpoints, turntable, render | Autodesk VRED | not built yet |
| `terra/` | Terra Studio: terrain from Terrarium elevation tiles + imagery basemap, layers (contours, hypsometric tint, water level), GeoJSON/CSV/heightmap upload, OSM buildings, sketch/measure/profile tools | Esri ArcGIS | not built yet |
| `view/` | Viewer for a pushed creation (`?id=`) | — | not built yet |

## Shared (`shared/`)

- `stage.js` — `Stage`: one persistent canvas, three r161 + `@displayxr/inline3d@1.45.1` (jsDelivr import
  map). Orbit camera rig: `cameraRigFromCamera` with `attach: true`, convergence = distance to the orbit
  target × `pop`, IPD scaled by that distance × depth gain. `addScene` after a 2:1 backing store and two
  rAFs, `rectCover: 'auto'`; returns `firstWoven`. `?mono` forces 2D, `?depth=0-2`.
  `snapshot()` is async (taken inside the woven frame when woven). `wireDepthChip()` wires the 2D/3D chip.
- `hq.js` — Push to HQ: IndexedDB `displayxr-hq` / store `creations` on the joehillthunder.github.io origin,
  record `{ id, app, appName, name, notes, created, thumb, glb (Blob), size, meta }`, plus a
  BroadcastChannel `displayxr-hq`. The HQ homepage is meant to read this store for a Creator Gallery.
  Per-browser only: nothing is uploaded to a server.
- `ui.js` — DOM helpers, tabs/sections, slider rows, toast/modal, file pick/drop, GLB export/import,
  and `pushDialog()`.
- `style.css` — dark pro-app shell; each app sets `--accent`.

## Woven-canvas rules to keep (DisplayXR SDK)

- One `createInline3D()` per document; never remount the canvas.
- `will-change: transform` on the canvas from first paint (in `style.css`); no border/shadow/filter/opacity
  on the canvas or its ancestors; no `backdrop-filter` over it.
- TODO: an opaque cover over the viewport until `firstWoven` resolves (hard cut), and
  `data-inline3d-overlay` on every chrome element over the canvas (tools, chip, toasts, busy chip);
  keep overlays smaller than the tile. Replay the last good views on an unusable frame.

## Testing on this PC

- Portable Node: `C:\Users\4kDemo\tools\node-v24.11.1-win-x64\node.exe`. `node --check` modules (copy to `.mjs`).
- Serve `C:\Users\4kDemo\dev` with a tiny Node static server and open
  `/creator-hub-wt/displayxr-demos/apps/creator-hub/material/`.
- Headless Chrome over CDP with `--use-angle=swiftshader --enable-unsafe-swiftshader` for console + screenshots.
  `window.forge` exposes `{ stage, materials, objects, addPrim, addMaterial, setTool, importFiles }`.
- Real 3D can only be checked in the DisplayXR Browser on the Leia panel.

## Still to do

Vehicle Studio, Terra Studio, viewer, landing page `index.html`, the woven TODOs above, HQ Creator Gallery
section + rooms in `home/demos.js` / `home/office.js`, README, then PR to `main`.
