# CLAUDE.md — phone-3d

A generic, unbranded "3D phone" illustration for OEM and operator conversations: what a
switchable glasses-free 3D phone is for. Read `../../CLAUDE.md` first; its rules apply here.

**Public page: never name a Leia customer or prospect** (no phone maker, brand or operator
names), and no pricing. It may say "Leia Inc." and use the Leia palette. Say "3D", never "VR".

**Live:** https://joehillthunder.github.io/displayxr-demos/apps/phone-3d/
**In DisplayXR HQ:** `phone-3d` is a room in the Spatial UI wing (`home/demos.js`), with a
`BUILD['phone-3d']` set piece in `home/office.js`.

## Files
- `index.html`: copy, the phone figure (`.handset` > `.bezel` sibling + `.screen` > canvas) and
  the app dock (`[data-app]` buttons).
- `scenes.js`: one builder, `phone`. Apps (`home`, `photos`, `game`, `call`, `learn`) build
  lazily on first open and swap by visibility. `stage` holds everything; its `scale.z` is the
  2D/3D switch. Each app returns `{ group, pick, tap, update, status, primary, onShow? }`.
- `app.js`: the inline-3D wiring, copied from `../leia-spatial/app.js` (one lazy session, cover
  until `firstWoven`, replay last good eye matrices), plus the dock.
- `style.css`: Leia palette; the bezel is never an ancestor of the canvas.

## Authoring
- Metres on a display rig: screen 0.135 × 0.24 m at the glass (VDH 0.24), content within about
  +2.5 cm and -3.5 cm. Planes behind the glass are scaled by `fill(z)` to cover the frustum.
- Textures are procedural canvases with lots of fine detail (strokes, speckle) so they read in 3D.
