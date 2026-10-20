# CLAUDE.md — physical-ai

A physical-AI training loop (world → demos → train → evaluate) on Lightwheel's LeIsaac pick-orange task.
Plain ES modules, no build step. Read `../../CLAUDE.md` and the hub `CLAUDE.md` first: their rules apply here too.

**Live:** https://joehillthunder.github.io/displayxr-demos/apps/physical-ai/
**Branch:** `app/physical-ai` (or `app/physical-ai-<topic>`). Ship through a PR to `main`, then merge it.
**In DisplayXR HQ:** `physical-ai`, the third room of the AI category (`home/demos.js`), with a
`BUILD['physical-ai']` set piece in `home/office.js`: a voxel arm putting oranges on a plate, an eval board
and a loss-curve screen. Keep its `desc` and `chatter` in step when the app changes.

## Files
| File | Role |
|---|---|
| `index.html`, `style.css` | All DOM and CSS. Import map: three 0.161.0, `@displayxr/inline3d` 1.45.1. Dark only, on purpose. |
| `js/main.js` | Boot, the four chapters, the 30 Hz sim loop, demo replay with video sync, teleop, training/DAgger orchestration, evaluation grid, leaderboard, localStorage (`pal.*`: your demos, last 3 models, board). `window.lab` is the debug handle. |
| `js/stage.js` | One persistent canvas; orbit camera rig (attach pattern, convergence on the target, ipd capped by a disparity budget); 2D mono fallback. |
| `js/world.js` | Loads the GLBs, lights, the asset catalogue and picking, env visuals (`makeEnvView`), the eval grid. `usd` group = the kitchen's Z-up USD frame. |
| `js/robot.js` | SO-101 kinematics (TheRobotStudio `so101_new_calib.urdf` chain), LeRobot motor units ↔ radians (leisaac limits), DLS IK, `solveIKSeeded` (fixed seeds, so posture depends on the target only), the articulated model. |
| `js/task.js` | The pick-orange env in USD world coordinates: robot base (leisaac init pose × the USD-base→URDF offset), first-order joint lag fitted from the demos, grasp/release rules, drops, `task_done()`, subtasks, domain randomisation. |
| `js/data.js` | Demo loading, dynamics fit, gripper events, layout recovery, replay labels (hindsight targets), dataset building (curation, DART noise), synthetic generation, DAgger rounds. |
| `js/policy.js` | Observation (15) and action (6) definitions, MLP inference, controllers: replay, BC policy, the stateless expert, teleop. |
| `js/train-worker.js` | MLP (tanh, Adam, cosine LR) trained on held-out-episode validation. |
| `js/charts.js` | Canvas line charts. |
| `assets/` | `kitchen.glb` (6.7 MB), `so101.glb` / `so101-lod.glb` (Lightwheel's 13 SO-101 part meshes, simplified to 15% / 4%), `pick-orange.bin` (60 episodes, int16 ×100). |
| `tools/` | The converters (see below). Not loaded by the app. |

## Conversion (how the assets were made)
- Lightwheel's USD files are binary crate files from `huggingface.co/LightwheelAI/leisaac_env` (`assets/scenes/kitchen_with_orange`,
  `assets/robots/so101_follower.usd`). They're converted in headless Edge with three.js 0.186.1's USDLoader, patched in
  `tools/usdlib/` (marked "local patch"):
  1. Inlined `double3` values (e.g. scale 1,1,1) read as 65793. Vec2d/3d/4d/3h/4h are now inlined cases.
  2. The PATHS section's encoded-path count can differ from the path count. Using the first one hung on the kitchen.
  3. `ReferenceListOp` / `PayloadListOp` / `Payload` were dropped. Internal references (instanced prims pointing at
     `/Flattened_Prototype_N`) are now composed.
  4. OmniPBR (MDL) shader inputs (diffuse texture and colour, roughness, metallic, ORM, normal, emission, opacity)
     map onto MeshPhysicalMaterial.
  5. A `globalThis.USD_SKIP(path, type)` hook. `convert-kitchen.html` uses it to drop collision prims
     (Sphere/Cube), prototypes, light switches and outlets (their half-precision scale still decodes wrong), and Omniverse cameras.
- The orange and plate USDs are payloads, so they're loaded separately at the poses authored in `scene.usd`. In the GLB their
  holders are named `lightwheel_orange00N` / `lightwheel_plate`, which the app pulls out and animates.
- Textures: JPEG, max 512 px, de-duplicated by source path. Geometry: vertices merged.
- Robot: `convert-robot.html` takes `/meshes/<part>/mesh` from the USD and simplifies it with meshoptimizer 0.22.0.
- Demos: `convert-demos.html` reads the LeRobot parquet with hyparquet. It was packed to `pick-orange.bin` in PowerShell.
- To rerun: mirror the files under a folder, serve it with `tools/serve.ps1` (static + `POST /save?name=` +
  `/__wait`/`__done` to hold headless Edge open), and run headless Edge on the page.

## Facts worth keeping
- The URDF chain reproduces the USD rest pose to 0.1 mm once the USD base → URDF `base_link` offset is applied
  (translation 0.0208, 0.0158, 0.0325, yaw −90°; computed in `task.js`).
- Motor ↔ degrees: leisaac `SO101_FOLLOWER_USD_JOINT_LIMLITS` and `SO101_FOLLOWER_MOTOR_LIMITS` (linear map).
- The demo gripper calibration varies by episode, so grasp and release are relative (a 4-unit close, a 6-unit open
  past the stall point). In the demos the leader arm sits 1–2 cm above the follower (sag), so real-demo labels use the follower's
  state 6 frames ahead, never the leader's action.
- Layout recovery finds 3/3 oranges in most episodes. Replaying the recorded joints puts all three on the plate
  in about 33 of 60 episodes (the rest really are incomplete or rely on physics the kinematic sim doesn't model).
- The expert is a stateless rewrite of leisaac `PickOrangeStateMachine` (same phases, offsets, order and home blend):
  - its phase comes from state, not step counters;
  - joint targets come from `solveIKSeeded` for the phase goal, cached;
  - the joint step is capped at 6 units.
  
  Timer-based versions couldn't be cloned (the same state got "wait" or "go"), and that's also what makes DAgger possible.
- Plain BC (any mix of data) drifts in closed loop. DAgger fixes it. Measured: 40 synthetic demos plus 4 rounds of
  12 rollouts gives 10/10 quick-check and 9/9 in Evaluate.

## Testing on this PC
- Serve the repo root with `tools/serve.ps1 -Root <repo> -Out <dir> -Port 8798`. Load the page through a copy with
  `<base href>`, an error-capturing hook script and `<img src="/__wait">` (inline scripts with `\n` broke when made
  with sed, so keep the hook in its own file). Under SwiftShader the page runs at about 6 fps, which is fine for flow tests.
- Headless Edge profiles grow fast. Use `--disk-cache-size` and delete them afterwards (this PC's disk filled up once).
- Real 3D can only be judged on the Leia panel. Ask the user to look.
