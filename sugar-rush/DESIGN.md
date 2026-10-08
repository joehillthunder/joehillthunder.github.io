# Sugar Rush: design

A candy-factory 3D platformer, rebuilt from scratch from a game designed in Google Labs
Playground. The code, shapes and sounds are all new. Nothing was exported or copied from
Playground. It plays in 2D in any browser and with real depth on a glasses-free 3D display through
the DisplayXR web SDK (`@displayxr/inline3d`).

## Rules

- **Goal:** collect all **4 Golden Confection Seals**, then reach the **Grand Sugar Fountain**.
  The fountain stays shut until you have all four.
- **Moves:** run, jump, bounce off gummy pads (a big launch), and a **Fizzy Dash** (a short burst,
  once per jump in the air).
- **Hazards:** spinning candy saws and rolling gumballs. Falling off the course costs a life too.
- **Lives:** Easy 5, Normal 3, Hard 2. Hard also speeds up the hazards. Each seal you collect becomes
  your respawn point.
- **Timer:** a run timer. Your best time is kept in this browser.

## Depth map (approved)

The camera follows behind the player. On a 3D display it is a **camera rig**, as in the SDK's
`samples/camera-rig`: the runtime offsets the eyes and skews each frustum so the convergence
distance lands on the screen plane. Convergence is set to the distance from the camera to the
player, every frame.

| Game element | Where it sits in 3D | How |
|---|---|---|
| Sky, far candy towers, Grand Sugar Fountain | Deep behind the screen | Placed 10–140 m out, softened by fog |
| Platforms, seals and hazards ahead | Behind the screen, receding | Course runs along −Z, away from the camera |
| **The player** | **On the screen plane** | `convergence` = camera→player distance |
| Your platform and nearby candy-cane posts | Slightly in front of the screen | Posts fade out before they come within half the convergence distance, so nothing pops out at the edges |
| Seal collected | Sparkle burst toward the viewer, centre | Particles fly toward the camera and vanish at 55 % of the convergence distance |
| Gummy-pad launch | Brief push of the whole view toward the viewer | Convergence rises 18 % and eases back over about 0.5 s |
| Score, timer, lives, menus | Flat 2D, always crisp | Plain DOM over the canvas, never woven |

**Comfort.** The runtime's rule is ipdFactor × metersToVirtual × convergence-diopters × 0.5 ≤ 1.
With ipdFactor 1, metres as world units and convergence about 8 m, that's about 0.06, well inside the
limit. Nothing fast crosses the screen plane at the edges: the posts fade, sparkles are aimed at the
centre and culled early, and the end arch stands behind the fountain.

## Page rules followed (DisplayXR `docs/woven-canvas-rules.md`)

- One inline-3D session and one persistent canvas (`will-change: transform` from the first paint).
- An opaque cover over the canvas until `handle.firstWoven`, then cut, not faded.
- No CSS effects on the canvas or its ancestors. The HUD and menus are small plates with a plain
  translucent tint, never `backdrop-filter`, and smaller than the canvas.
- The 2D/3D switch uses `wall.setStereoEnabled()` and listens for `renderingmodechange`, as in
  `samples/display-modes`.
