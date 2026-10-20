# CLAUDE.md — DisplayXR HQ (joehillthunder.github.io)

The hub site for Joe Hill's DisplayXR demos (glasses-free 3D on Leia displays). The homepage is "DisplayXR HQ": an animated isometric voxel office where each demo is a room. GitHub Pages serves `main` from the repo root.

## Repo layout and policy
- **Hub only.** New demos get their own `displayxr-<name>` repo, served at `joehillthunder.github.io/displayxr-<name>/`, and the hub just links to them. Some older demos still live in folders here (`sugar-rush/`, `stereo-splat/`, `displayxr-demos/apps/energy-grid`, …). They're being split out with `git subtree split` plus redirect stubs; don't add new demos as folders.
- `index.html`: the hero canvas, then the directory: one column per category (name, `blurb`, plain list of demo links; `tagline` is the link tooltip). The Creator Gallery section stays hidden until something is pushed.
- `home/demos.js`: `WINGS`, the single source for both the office and the cards. Each wing is one category: `{ id, name, blurb, quad, floor[2], accent, demos[] }`, and each demo has `{ id, name, tagline, desc, url, source, chatter[4] }`. Keep `blurb` and `tagline` to one short plain sentence.
- `home/office.js`: the three.js 0.161 scene, loaded through the jsDelivr import map. The building is 40 × 28 m with four quadrants (`quad` 0 back-left, 1 back-right, 2 front-left, 3 front-right). Wings sharing a quadrant sit side by side, and all its rooms split its 18 m evenly. Only a wing's first room plaque names the wing.
  - `BUILD[demo.id](g, r)` is the room's set piece. Use `box`, `sphere` and `glow` and push per-frame animation to `animators`.
  - Set pieces are sized for rooms about 4.5 m wide and shrink automatically in narrower rooms. About 6–7 rooms per quadrant is the practical maximum.
- `home/vendor/inline3d/`: DisplayXR inline-3D SDK 1.45.1, vendored. In the DisplayXR Browser the office becomes a woven 3D scene (display rig, VDH 0.3). `?mono` forces 2D and `?depth=0.1-0.8` sets the depth.

## Current categories (wings)
1. Gaming (quad 0): Sugar Rush, Playground, Battle School, Battleship 3D, Aetherfall, Street Brawl 3D, 3D Game Guide. The guide is `displayxr-demos/apps/3d-games/` at the user's request.
2. Learning & Simulation (quad 1): Energy Grid, Aviation Coach, Mission Planner, Solar System 3D, STEM Lab 3D, Underwater Worlds, Flight Lines (7 rooms, so set pieces render at about 4/7 scale).
3. AI (quad 2, left): Muse Voice, Dot Voice, Physical AI Lab. Physical AI Lab is `displayxr-demos/apps/physical-ai/` (Lightwheel assets and data) at the user's request.
4. Future Media (quad 2, right): Stereo Splat, 4DV Player, Splat Call 3D, Music Visualizer. Splat Call is `displayxr-demos/apps/splat-call/` at the user's request.
5. Creator Tools (quad 3, left): Material Forge, Vehicle Studio, Terra Studio. All three are `displayxr-demos/apps/creator-hub`, whose Push to HQ feeds the Creator Gallery section of `index.html`.
6. Spatial UI (quad 3, right): Future OS Lab, Dual View, Leia Spatial. Leia Spatial is `displayxr-demos/apps/leia-spatial/` at the user's request.

## Adding a demo
1. Add an entry to the right category in `home/demos.js`, with a short `tagline`. If a quadrant passes ~7 rooms, move a small wing to a lighter quadrant.
2. Add a `BUILD['<id>']` set piece in `home/office.js`. Without one, the room only gets desks.
3. Check it locally, then ship it through a PR to `main`.

## Testing on this PC
- There's no python or node. Serve with a PowerShell `HttpListener` script. Port 8765 is the Muse bridge and 8791 is Battle School, so avoid both.
- Screenshot with headless Edge (`--headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --virtual-time-budget=… --screenshot=…`). Launch it from PowerShell `Start-Process -Wait` with its own `--user-data-dir`.
- GDI screenshots of the woven panel come out blank, and the DisplayXR Browser exits when given `--remote-debugging-port`. To check real 3D, ask the user to look at the Leia panel.

## Git etiquette
- Several Claude sessions edit this repo at the same time. Never work in the main checkout if it has someone else's uncommitted changes. Use your own worktree (`git worktree add ../<name>-wt -b <branch> origin/main`) and never use bare `git stash`.
- Make changes on a branch and merge them through a PR. End commit messages with the Co-Authored-By trailer.
- The gh token has no `workflow` scope, so don't add GitHub Actions.
