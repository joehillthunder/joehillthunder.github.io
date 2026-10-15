# Stereo Splat — rules for all agents

Live: https://joehillthunder.github.io/stereo-splat/. Pushing to `main` publishes it (GitHub Pages, about 30 s).

- No build step and no package.json. These are plain ES modules. CDN libraries go through the import map in `index.html`;
  workers import CDN libraries by full URL, because import maps do not apply in workers. Pin exact versions.
- `vendor/inline3d/` is an UNMODIFIED copy of `@displayxr/inline3d` 1.37.1. Never edit it. Work around SDK bugs in
  `app.js` and note them in README.md. Read github.com/DisplayXR/displayxr-web docs and `.d.ts` files before using an SDK
  API. Never guess APIs.
- Woven-canvas rules (displayxr-web `docs/woven-canvas-rules.md`): one `sharedInline3D()` per document; register the
  splat tile once and swap with `setSource`; never remount the canvas; cover the canvas until `firstWoven`; no CSS
  effects on the canvas or its ancestors.
- Everything runs in the browser. Never send the user's photos or video to a server.
- The page must still work in a plain browser (flat/2D) and without WebGPU (fall back to the stereo per-pixel splat).
- The main checkout of this repo is shared with other sessions, which switch its branch. Work in your own worktree
  (`git worktree add ../<dir> -b <branch> origin/main`). Commit only `stereo-splat/` files.
- Keep README.md in step with the pipeline, and with the "How it works" note at the bottom of `index.html`.

## Layout

```
stereo-splat/
  index.html        ← page, styles, import map
  app.js            ← camera, capture/load, 3D video, build pipeline, splat tile, report, mesh export
  cameras.js        ← stereo cameras the SDK cannot detect by shape (Acer SpatialLabs Eyes, half side-by-side)
  heif.js           ← iPhone / Vision Pro spatial photos (.heic) through libheif (jsDelivr)
  stereo.js         ← census + SGM disparity, the per-pixel splat (runs in stereo-worker.js)
  sharp.js          ← page side of Apple SHARP: load once, run, scale to stereo depth
  sharp-worker.js   ← SHARP on ONNX Runtime Web (WebGPU): int8 weight pack, NDC → metric unprojection
  sog.js            ← .sog via PlayCanvas splat-transform, with the DisplayXR `camera` block; zip writer
  mesh.js           ← .glb / .obj export for the DisplayXR 3D Model Viewer
  vendor/inline3d/  ← DisplayXR SDK, vendored as is
```

## Pipeline

A stereo pair (camera photo, side-by-side JPEG/PNG, .heic, or a frame from a 3D video) goes through these steps:

1. The stereo matcher (CPU worker) produces disparity, which gives metric depth, the depth view and the mesh export.
2. At the same time, SHARP runs on the left eye (GPU).
3. SHARP's Gaussians are rescaled by the median ratio against the stereo depth (`alignToStereo`).
4. The result is encoded as `.sog` and shown with `addSplat` / `setSource`.
5. 3D video plays on the same tile through `splat.setVideo()`. Call `setVideo(null)` before any `setSource`.

## Gotchas

- Call `splat.setStereo()` only after `await splat.ready`. inline3d 1.37.1 throws a TDZ error on `stereoOverride`
  otherwise.
- The SHARP weights come from HF `sm079/sharp-onnx-webgpu` (0.66 GB, kept in Cache Storage `stereo-splat-sharp-v1`). They
  are under Apple's research-only model license, so this is a demo, not a product.
- SHARP output is in NDC: positions scale by `diag(W/2f, H/2f, 1)` and covariances must be re-split (`eigenSym3`). Its
  colours are linear RGB, so convert to sRGB before `f_dc`.
- MediaRecorder WebMs have no duration: `openVideo()` seeks to the end once to learn it.
- Half side-by-side clips play squeezed: `setVideo` sizes each eye from the frame. Splats from them are fine.

## Testing

There are no unit tests, Node or Python on this PC. Test in a real browser:

- Serve the repo root locally (any static server; port 8765 is taken by the Muse bridge). Open
  `/stereo-splat/?camera=mono`.
- Drive Chrome or the DisplayXR Browser (`C:\Program Files\DisplayXR\Browser\chrome.exe`) over CDP with
  `--remote-debugging-port`, `--disable-backgrounding-occluded-windows` and a scratch `--user-data-dir`. A hidden
  page never reaches `firstWoven`.
- 3D checks: `#splatBadge` reads `3D`, `window.__splat()`, and `window.__video()?.stats()` frames/uploads increasing.
  Woven pixels do not show in page screenshots.
- The DisplayXR Browser's virtual "DisplayXR 3D Camera" is enough to test capture and Record 3D video.
- Finish with: what works, what was tested where (plain Chrome / DisplayXR Browser / live site), and what needs Leia
  hardware or a real camera.
