# Echo-3 Worlds

Real rooms, scanned with an iPhone and rebuilt by SpAItial's **Echo-3** world model, shown as
glasses-free 3D dollhouses on a DisplayXR display. Six worlds from SpAItial's public
[Echo-3 gallery](https://spaitial.ai/gallery), cut away at 1.6 m above the floor and seen from outside.

Live: https://joehillthunder.github.io/displayxr-demos/apps/echo-worlds/

Rules: [`../../CLAUDE.md`](../../CLAUDE.md), and this folder's [`CLAUDE.md`](CLAUDE.md). Branch `app/echo-worlds`.

## What it does

- **Dollhouse view.** The room is cut at 1.6 m above its floor (ceiling and upper walls gone),
  framed from outside at a middle size, looking down 35°, turning slowly. Toggle **Dollhouse** to
  see the uncut capture.
- **Measure.** Click two points: a line and the distance in metres. Echo-3 worlds are metric.
- **Depth −/+ and Reset**, 50–150 % in 25 % steps (100 % = the SDK's display rig default).
- **Full panel** puts the stage in fullscreen (covered until it is woven again).
- **Six worlds:** Kids Playroom, Robotics Workshop, Fireplace Lounge, Vaulted Hall, Game Room,
  School Library. `?world=<id>` opens one; `?pitch=` and `?zoom=` tune the rest pose.

On the DisplayXR Browser with a 3D display the room is in 3D. Any other browser shows it in 2D.
No keys, no server: the page is static.

## How it works

```
SpAItial gallery ─► Streamed SOG (lod-meta.json, ~10 M splats, 3 LODs, CORS *)
                       │
tools/echo3_frame.py ──┤ coarsest LOD → floor height, footprint  ─► worlds.json (clip box, frame)
                       ▼
addSplat (PlayCanvas, display rig, flipY:false) → fitTo + setFocus(frame) → setEffect('clip', box)
```

- **Format.** Each gallery world is a Streamed SOG made with PlayCanvas splat-transform, on
  `echodot.spaitial.io` with open CORS. `@displayxr/inline3d`'s PlayCanvas backend streams it under
  its 600 k splat budget per tile. Nothing is downloaded into this repo.
- **Y-up.** Echo-3 worlds are Y-up with the origin near the first camera (floor about 1.5 m
  below). Most 3DGS exports are Y-down, so the SDK flips by default: this page passes
  `flipY: false`, or every room renders upside down.
- **Framing.** On a Streamed SOG the SDK frames from octree leaf boxes and orbits a default focus,
  which put the room off-centre. The page fits and focuses on the baked cut-room box, and rests
  at zoom 0.75 because the fit box is measured unpitched.
- **Cut.** `handle.setEffect('clip', { box })` in the splat's own space, from the baked floor
  height and footprint.

## Tools (offline, Python + NumPy + Pillow)

| Script | What it does |
|---|---|
| `tools/echo3_frame.py <cache> <out.json> [id…]` | Decodes each world's coarsest LOD (SOG v2 means + opacity) and writes floor, ceiling, footprint. |
| `tools/echo3_views.py <cache> <out> id…` | Orthographic colour views, to check orientation. |
| `tools/echo3_sheet.py <cache> <worlds.json> <out.png>` | A contact sheet of every world, cut at 1.6 m. |

## Status

- Works in 2D (headless Edge) and weaves in the DisplayXR Browser on the Leia panel.
- Needs Leia hardware: the seated depth check (Pass/Fail at 100 %), measure on the panel.
- Open: SpAItial's permission for public use of the gallery captures (credited and streamed, not
  hosted); depth % is not measured, since the Browser doesn't consume the runtime's atlas trigger.
