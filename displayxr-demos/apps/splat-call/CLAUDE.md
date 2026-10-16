# Splat Call 3D

A live 3D video call from one ordinary webcam. Every frame becomes a fresh cloud of up to 131k
3D Gaussians: no pre-scan, no avatar. It's a training-free browser take on Microsoft's
[VoluMe](https://microsoft.github.io/VoluMe/) (arXiv 2507.21311), whose code and weights aren't
public. Woven 3D on Leia displays in the DisplayXR Browser, 2D (with a gentle sway) in any WebGPU
browser. Plain ES modules, no build step. Served at
https://joehillthunder.github.io/displayxr-demos/apps/splat-call/ . Rules for the whole folder:
[`../../CLAUDE.md`](../../CLAUDE.md). Branch: `app/splat-call`. There is no CI, so test before you
push.

## Pipeline (per frame)

| Step | Where | What |
|---|---|---|
| Track | `perception.js` (main thread) | MediaPipe Tasks 0.10.21, GPU delegate: FaceLandmarker (478 points incl. irises) + ImageSegmenter `selfie_multiclass_256x256` (person = 1 − background confidence). |
| Crop | `main.js` `cropFromFace` / `updateRoi` | Square head-and-shoulders crop, 2.6× the face box. Damped, and only re-committed when it drifts more than 5% (a moved crop resets the temporal filter). |
| Depth | `recon-worker.js` `infer` | Depth Anything V2 via transformers.js 3.8.1 on WebGPU (fp16 if `shader-f16`, else fp32; WASM q8 fallback). Input is the crop at S×S (S multiple of 14), and output is relative inverse depth. |
| Scale | `recon-worker.js` `irisDistance` / `fitDepth` | Iris diameter 11.7 mm → camera distance. Landmark z (image-width units) → metric relief. Least-squares `z = p + q·disparity` over every 2nd landmark, with one outlier-rejection pass. Requires `q < 0`, otherwise it keeps the last fit. |
| Splat | `recon-worker.js` `build` | G×G grid over the crop. One surfel per kept cell (mask > 0.3): covariance `0.3(t1t1ᵀ + t2t2ᵀ) + (0.18s)² nnᵀ` from the smaller one-sided neighbour differences, so depth jumps don't smear. Tangents clamped at 3 cells, and opacity fades with stretch and toward the crop's sides and bottom. The back layer mirrors each row behind its silhouette depth (`zb = zs + 1.15(zs − z)`), 0.78× darker. |
| Steady | `recon-worker.js` | Per-cell EMA on depth and mask where the colour held still (`opts.smooth`, default 0.55). |
| Draw | `splats.js` | EWA splatting adapted from the 4DV player: data in float textures, one sort for both eyes (16-bit counting sort in the worker). |

Quality presets (`main.js` `QUALITY`, keys 1/2/3) set the depth input and the splat grid: Fast =
S 266, G 160 · **HQ (default)** = S 392, G 224 · Ultra = S 518, G 256. The live depth model is a
separate choice (`opts.model`, `?model=`, the model dropdown):

| id | Model | Licence | Live speed (RTX 5070 Ti, HQ) |
|---|---|---|---|
| `small` (default) | Depth Anything V2 Small, fp16, 47 MB | Apache-2.0 | ~23 fps, depth ~17 ms |
| `da3s` | Depth Anything 3 Small, fp32, 105 MB | Apache-2.0 | ~16 fps, depth ~36-47 ms |
| `base` | Depth Anything V2 Base | **CC BY-NC 4.0** | slower |

Depth Anything 3 takes a view axis (`[1, 1, 3, S, S]`) and outputs **depth**, not disparity: the
worker negates it (`MODELS[x].depth`), so "larger = nearer" holds everywhere and the linear metric
fit stays exact. Models download from the Hugging Face CDN with retries and are cached by
transformers.js. Don't commit model files: the hub is under 1 MB.

## Snapshots (helper/splat_helper.py)

**T** or **Snapshot** freezes one frame through a model too big to run live, served by a small
local helper (`python helper/splat_helper.py`, port 8830, `?helper=` to move it). The live loop
pauses (`state.snap`) and a second, larger cloud (`snapSplats`, 1M capacity, made on first use)
replaces the live one until **Live** / **L**.

- **Apple SHARP** (apple/ml-sharp, arXiv 2512.10685): one image to ~1.2M metric 3D Gaussians.
  The helper runs the community fp16 ONNX export (pearsonkyle/Sharp-onnx, 1.3 GB, downloaded to
  `~/.cache/splat-call/` on first use) through ONNX Runtime + **DirectML** (no CUDA needed; falls
  back to CPU). The page sends the frame stretched to 1536×1536 RGB plus W, H and f; the helper
  applies Apple's `unproject_gaussians` (NDC → camera is `diag(W/2f, H/2f, 1)`, covariance
  `A R S² Rᵀ A`) and returns camera-space means, covariances in mm² and sRGB+alpha. The worker
  (`buildExternal`) re-centres on the head, mirrors for local cameras, and optionally keeps the
  person mask only. **Apple's model licence is research only (non-commercial).**
- **Immersity AI** (Leia, docs-api.immersity.ai): token (client credentials) → `get-upload-url`
  → PUT the 1024² head-crop JPEG → `POST /api/v1/disparity` (`outputBitDepth: uint16`) → GET the
  PNG. The disparity goes through the normal splat build (`frame` message with `disp`, G 320).
  Keys `IMMERSITY_CLIENT_ID` / `IMMERSITY_CLIENT_SECRET` in `displayxr-demos/.env`; 10 credits a call.
- `--mock-sharp --mock-immersity` serve fake results so the whole flow can be tested without the
  model or keys (that is how it was tested: the real SHARP download didn't fit on the demo PC's
  disk, and there were no Immersity keys).
- CORS: the helper allows https://joehillthunder.github.io and localhost origins
  (`--allow-origin` for more) and answers Private Network Access preflights.

### Other models worth exploring

- **LAM** (aigc3d/LAM, Apache-2.0, SIGGRAPH 2025): one photo → animatable Gaussian head, with a
  WebGL renderer; drive it with MediaPipe blendshapes for an avatar call (not "authentic" like
  VoluMe, but very light to stream).
- **GAGAvatar** (xg-chu/GAGAvatar, MIT, NeurIPS 2024): one-shot generalizable Gaussian head,
  real-time reenactment.
- **LHM** (aigc3d/LHM, Apache-2.0, ICCV 2025): full-body animatable Gaussian human from one image.
- **GPS-Gaussian** (MIT, CVPR 2024): live pixel-wise Gaussians from 2+ cameras: the multi-camera
  route to true volumetric calls.
- **Depth Pro** (Apple, metric depth; onnx-community/DepthPro-ONNX, 600 MB+) and **Sapiens depth**
  (Meta, human-specific; 0.3B runs ~750 ms in the browser): snapshot-grade depth.
- **Splatter Image**, **DepthSplat**, **TRELLIS**: single/multi-view Gaussian reconstruction;
  object-centric or offline.

## Coordinates

Worker output is world space in metres. The head centre (between the eyes, 7 cm behind them) is at
the origin, with x right, y up and z toward the viewer. The source camera has x right, y down and z
forward, with `f = (W/2)/tan(fov/2)`, `fov` 60° by default (`?fov=`). Local cameras are mirrored
(`opts.mirror`). Files, URLs and remote callers are not. Covariances are stored in mm²
(`×1e6` in the worker, `×1e-6` in the shader).

## Cameras (`cameras.js`)

- `recognise(label)` matches a device label against `PROFILES` (first match wins, so specific
  models come before a maker's catch-all, and depth/IR streams before the same camera's RGB). Names
  are matched without Chromium's `(vid:pid)` suffix, and ids with it. About 65 profiles: Logitech,
  Razer, Elgato, Microsoft, Dell, Anker, AVerMedia, EMEET, NexiGo, Lenovo, HP, laptop cameras, phones
  (Continuity Camera, DroidCam, Camo, Iriun, …), HDMI capture cards, virtual cameras (OBS, NVIDIA
  Broadcast, …), auto-framing cameras (Insta360, OBSBOT, PanaCast), RealSense, Kinect, Orbbec and
  ZED / generic side-by-side stereo.
- **The FOV is load-bearing:** the iris → distance step goes through the focal length. Profiles
  hold the maker's **diagonal** FOV (`dfov`) or a horizontal one (`hfov`, `hfovEye`); `hfovFor()`
  converts for the stream's aspect. Order of precedence: `?fov=` > the user's override (Cameras
  dialog, `localStorage` per label) > profile > 60°.
- `KINDS` sets the dropdown groups and the auto-pick rank. Depth/IR streams and Windows Hello IR
  cameras are listed but disabled. The eye tracker is never auto-picked.
- Stereo: `openCamera` returns the **left eye** of a side-by-side camera (profile kind `stereo`,
  or any frame wider than 3:1) as a canvas `captureStream`, so the PiP, the reconstruction and
  the call all see a mono camera. `stopStream` calls the stream's `release()`.
- Hot-plug: `watchDevices` (debounced `devicechange`) refreshes the list and toasts **Use it** /
  **Switch to it** for a newly plugged camera. An unplugged camera (`track.ended`) falls back to the
  next best one.
- Calls send `{type:'camera', fov, name}` over a PeerJS data connection, so the receiver rebuilds
  the caller with the sender's FOV (`state.remoteCam`).
- Testing without hardware: Edge with `--use-fake-device-for-media-stream
  --use-fake-ui-for-media-stream` (label `fake_device_0`). Check `recognise()` on a label table via
  `import('./js/cameras.js')` in the page, and fake a hot-plug by clearing `state.knownIds` and
  dispatching `devicechange`.

## Sources and calls (`sources.js`)

- Camera picker skips the Leia **eye-tracking camera** ("SR Camera"). Opening it can starve the
  eye tracker and break the weave, so the app asks first (`#srDlg`). The demo PC's only camera
  is that one, so use a USB webcam there.
- Video file (picker or drag and drop), `?src=<url>`, or the sample clip (`?sample`). The sample is
  hotlinked from Wikimedia Commons ("Ward Cunningham, Inventor of the Wiki", **CC BY-SA 3.0**,
  credited on screen) and isn't committed, so it has no `assets/LICENSES.md` row. Swap it for a CC0
  or CC-BY clip if one turns up.
- Calls: PeerJS 1.5.5 on the public broker, with peer id `dxr-splat-call-<code>`. Each side sends
  plain video, and the receiver reconstructs. `?join=<code>` opens the join dialog.

## Gotchas

- **Splat quads need `side: DoubleSide`.** The EWA basis `(dir, (dir.y, −dir.x))` is left-handed,
  so with default culling nothing draws at all (cost an hour on 2026-10-16).
- three 0.161 ShaderMaterial with GLSL3 has no `gl_FragColor` alias here: declare
  `layout(location = 0) out vec4 fragColor`.
- Woven-canvas rules (DisplayXR/displayxr-web `docs/woven-canvas-rules.md`): one persistent canvas,
  `#cover` until `firstWoven`, and **no `backdrop-filter`** on anything over the canvas.
- MediaPipe masks are only valid inside the `segmentForVideo` callback, so copy them there.
- Only one frame is in flight: `kick()` sends the next frame when the worker returns, and
  `requestVideoFrameCallback` marks frames pending.

## Testing (demo PC)

- Python 3.12 is on PATH. Serve the folder with a small `http.server` subclass that forces
  `text/javascript` for `.js` (the Windows registry can map it to `text/plain`). Port 8817 has
  been free.
- Playwright (in a venv) with `channel='msedge'`, headless, `--enable-unsafe-webgpu`, and a
  persistent profile so the model is cached: `?sample&nosway` gives about **25 fps
  reconstruction, depth about 17 ms, build about 5 ms, ~45k splats, metric fit at 51 cm** on the
  RTX 5070 Ti. `window.splatCall` exposes `{ stage, splats, state, opts, worker, perception,
  call, setQuality, useClip, useCamera }`, and `state.stats` holds the HUD numbers.
- Check side views with `splatCall.stage.yaw = ±0.8` and depth colours with `opts.depthColor = true`.
- Woven 3D can only be judged in the DisplayXR Browser on the Leia panel.
