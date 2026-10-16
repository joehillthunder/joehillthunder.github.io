# leia-spatial

The Leia Inc. story, "Making any display feel spatial", as a scrolling site where every section
has a live 3D scene. On a glasses-free 3D display, opened in the
[DisplayXR Browser](https://github.com/DisplayXR/displayxr-browser), each scene weaves into
real depth; in any other browser the same page runs in 2D and the scenes follow the pointer.

**Live:** https://joehillthunder.github.io/displayxr-demos/apps/leia-spatial/

Static files only: no build, no keys, no server. Rules: [`../../CLAUDE.md`](../../CLAUDE.md) and
[`CLAUDE.md`](CLAUDE.md). Branch: `app/leia-spatial`.

## Scenes

| Section | Scene | What it shows |
|---|---|---|
| Hero | `hero` | A 3D display with objects floating in front of its glass |
| 1 · 2D is sacred | `lens` | The LC lens layer switching between 3D and invisible 2D every 3 s |
| 2 · 3D must stay sharp | `views` | Two tracked view cones following the eyes, then nine fixed multiview cones on a coarser picture |
| 3 · 3D must be comfortable | `calibration` | A per-pixel ghosting map flattening as a calibration sweep passes, inside a comfort-zone box |
| 4 · 3D must be (nearly) free | `nanoimprint` | A roller imprinting lens ribs onto a glass plate (roll-to-plate) |
| 5 · 3D must be easy to make | `conversion` | A flat picture lifting into a point cloud from its AI depth map |

The stack section uses CSS 3D plates (2D page elements, not a woven canvas).

URL flags: `?2d` forces 2D; `?debug` logs `firstWoven` per tile and `handle.stats()`.

## Status

Tested in 2D with headless Edge (SwiftShader) at 1440 px and 400 px: all six scenes render and
animate, and the page has no horizontal overflow at phone width.

Needs Leia hardware to verify: the woven path for six lazy tiles on one session (cover release
on `firstWoven`, re-arming as tiles scroll back in), depth comfort of each scene, and frame rate
with two or three tiles on screen at once.
