# leia-spatial

The Leia Inc. story, "Making any display feel spatial", as a scrolling site where every section
has a live 3D scene. On a glasses-free 3D display, opened in the
[DisplayXR Browser](https://github.com/DisplayXR/displayxr-browser), each scene weaves into
real depth; in any other browser the same page runs in 2D and the scenes follow the pointer.

Every scene is hands-on: **drag to turn it, tap things in it**, and use the buttons under it.
The market and hurdle cards flip over, and the big headlines spin letter by letter when touched.

**Live:** https://joehillthunder.github.io/displayxr-demos/apps/leia-spatial/

Static files only: no build, no keys, no server. Rules: [`../../CLAUDE.md`](../../CLAUDE.md) and
[`CLAUDE.md`](CLAUDE.md). Branch: `app/leia-spatial`.

## Scenes

| Section | Scene | Tap / buttons |
|---|---|---|
| Hero | `hero` | 3D "SPATIAL" letters over a panel with floating objects. Tap a letter to flip it, an object to spin it; Scatter, Flatten to 2D |
| 1 · 2D is sacred | `lens` | Tap the panel to switch the LC lens between 3D and invisible 2D |
| 2 · 3D must stay sharp | `views` | The viewer's head follows your pointer; tracked cones chase the eyes, multiview cones don't. Tap to switch |
| 3 · 3D must be comfortable | `calibration` | Tap the ghosting map to calibrate outward from that spot; Run factory calibration, Reset |
| 4 · 3D must be (nearly) free | `nanoimprint` | Tap the glass to steer the roller, tap the roller to pause; Imprint a fresh plate |
| 5 · 3D must be easy to make | `conversion` | Tap the picture to ripple the point cloud; Flatten / Lift, Drop a ripple |
| The stack | `stack` | Tap a slab (or a row in the list) to pull that layer out; Explode the stack |

Keyboard: focus a scene, then arrows turn it and Enter taps its centre.

URL flags: `?2d` forces 2D; `?debug` logs `firstWoven` per tile and `handle.stats()`.

## Status

Tested in 2D with headless Edge (SwiftShader) at 1440 px and 400 px: all seven scenes render and
animate, and the page has no horizontal overflow at phone width.

Needs Leia hardware to verify: the woven path for seven lazy tiles on one session (cover release
on `firstWoven`, re-arming as tiles scroll back in), depth comfort of each scene, and frame rate
with two or three tiles on screen at once.
