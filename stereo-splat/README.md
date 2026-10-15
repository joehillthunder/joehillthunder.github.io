# Stereo Splat

Live: https://joehillthunder.github.io/stereo-splat/

Take a photo with a 3D (stereo) camera and turn it into a Gaussian splat, entirely in the browser.
Built for the [DisplayXR Browser](https://displayxr.org/browser): on a 3D display the camera preview
and the splat are glasses-free 3D. Other browsers show the same page in 2D.

1. **Detect the camera.** `openCamera({ prefer: 'stereo' })` from `@displayxr/inline3d/camera` finds a
   stereo device: the DisplayXR Browser's rectified "3D Camera", or anything sending side-by-side
   frames wider than 2.5:1. `cameras.js` adds cameras that send HALF side-by-side frames, which look like
   ordinary 16:9 webcams. The Acer SpatialLabs Eyes is recognised by name and opened at 3840×2160 with
   63 mm baseline and about 82° FOV. A layout picker can force full side-by-side, half side-by-side or 2D
   for any other device.
2. **Preview.** `addCameraView(..., { mirror: true, autoConverge: true })` shows a mirrored 3D self view
   that keeps the face at the screen plane.
3. **Capture.** `cam.capturePhoto()` saves the raw side-by-side pair (`_2x1.jpg`, with the stereo XMP record).
4. **Depth** (`stereo.js`, in a worker). 7×7 census, semi-global matching (4 paths) run on both eyes,
   a left/right consistency check, occlusion fill and a median filter.
5. **Splat** (`sharp.js`, `sharp-worker.js`). Apple's [SHARP](https://github.com/apple/ml-sharp) predicts about
   1.2 M Gaussians from the left eye, on the GPU with ONNX Runtime Web 1.30.0 (WebGPU), while the stereo matcher runs.
   The model is sm079's int8 ONNX export ([huggingface.co/sm079/sharp-onnx-webgpu](https://huggingface.co/sm079/sharp-onnx-webgpu),
   0.66 GB, kept in Cache Storage after the first download). The page does SHARP's NDC → metric unprojection itself
   (positions × diag(W/2f, H/2f, 1), covariances rebuilt and re-split into rotation and scales). SHARP guesses scale
   from one image, so every opaque Gaussian is projected into the stereo disparity map and the scene is rescaled by
   the median ratio: the splat lands at the distances the pair measured. With **Model: stereo per-pixel**, or
   without WebGPU, or if SHARP fails, each pixel becomes one Gaussian at Z = f·B/d instead. All of this is in
   OpenCV camera space. The SHARP weights are under Apple's Machine Learning Research Model License (research use only).
6. **Encode** (`sog.js`). PlayCanvas `splat-transform` writes the `.sog`. Its `meta.json` gets a
   DisplayXR `camera` block (intrinsics, baseline, focus), so the viewer reopens the splat at the
   capture camera.
7. **View.** `addSplat` from `@displayxr/inline3d/splat/playcanvas`. Later captures swap in with `setSource`.
   On a 3D display the **3D depth** slider (0–200%) calls `setStereo({ ipdScale })`: eye separation
   relative to the capture's own, so 100% is true to the photo. It sticks across captures.

**Export a mesh for the [DisplayXR 3D Model Viewer](https://github.com/DisplayXR/displayxr-demo-modelviewer)** (`mesh.js`).
Two formats, from the same mesh:

- **.glb:** one self-contained file with the texture embedded as JPEG. It is about a third of the size of the
  OBJ zip and passes the Khronos glTF validator with no errors or warnings. Open it in the viewer (Ctrl+O or
  drag and drop), or in any glTF viewer.
- **.obj (zip):** `.obj`, `.mtl` and `.jpg`. Unzip it and open the `.obj`. The viewer looks for the `.mtl` and
  texture next to the `.obj`.

- **Geometry:** the depth map as a grid mesh with UVs and smooth normals, in glTF axes (+Y up, facing +Z),
  with the subject at the origin so the viewer frames and orbits around it.
- **Material:** the photo goes on as emission over a black base colour (glTF `emissiveTexture`, OBJ
  `Ke` / `map_Ke`). The viewer has no unlit material, and this keeps the photo as captured under every lighting mode.
- **Options:** mesh detail (full, half or quarter grid). Depth: as measured, half or quarter. A smaller
  value pulls points toward the subject along their camera rays, so the mesh still lines up with the photo
  from the capture camera. Depth edges: stretch to fill the gaps a single viewpoint cannot see, or cut them.

**3D video.** **Record 3D video** records the 3D camera with `cam.record()` (`@displayxr/inline3d/camera`). That gives a
side-by-side WebM with the stereo record (baseline, FOV, convergence) in its Tags. **Load photo or video…** also takes
side-by-side WebM or MP4 files, read like photos: `_2x1` in the name, a DisplayXR stereo tag, wider than 2.5:1, or the layout
picker. The clip plays in 3D on the splat tile through `splat.setVideo()` (the SDK's screen-locked video plane), with
play/pause and a seek bar. **Splat this frame** turns the frame on screen into a stereo pair and builds a splat from it,
exactly like a photo. **Back to splat** restores the splat. With no splat yet, the clip's first frame is splatted first,
because the tile only exists once a splat is on it. A half side-by-side clip (Acer SpatialLabs Eyes) plays squeezed:
`setVideo` sizes each eye from the frame. Its splats are unsqueezed as usual.

You can also load photos:

- **Side-by-side JPEG or PNG**, full or half width (`_2x1` in the name, or set the layout).
- **iPhone or Vision Pro spatial photos (.heic).** libheif (WebAssembly) decodes both eyes. `heif.js` reads
  the HEIF `ster` group for left and right, `cmex` for the baseline (camera positions in µm) and `cmin` for
  the lens. A HEIC with no stereo group is refused.

Where a file has no stereo metadata, set the baseline and field of view by hand.

`vendor/inline3d/` is an unmodified copy of DisplayXR's `@displayxr/inline3d` 1.37.1 (Apache-2.0).
See `vendor/inline3d/VERSION.txt` for the source commit.

`libheif-js` 1.23.2 (LGPL-3.0) is loaded unmodified from jsDelivr when a .heic is opened.

`onnxruntime-web` 1.30.0 (MIT) is loaded from jsDelivr by the SHARP worker. The int8 weight-pack loader follows
sm079/sharp-rig (MIT).

inline3d 1.37.1 replays `setStereo` calls made before `splat.ready` ahead of its own setup, where they throw
(`Cannot access 'stereoOverride' before initialization`). `app.js` calls `setStereo` only after `ready`.
