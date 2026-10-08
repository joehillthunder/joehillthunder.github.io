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
5. **Splat.** Each pixel becomes one Gaussian at Z = f·B/d, in OpenCV camera space.
6. **Encode** (`sog.js`). PlayCanvas `splat-transform` writes the `.sog`. Its `meta.json` gets a
   DisplayXR `camera` block (intrinsics, baseline, focus), so the viewer reopens the splat at the
   capture camera.
7. **View.** `addSplat` from `@displayxr/inline3d/splat/playcanvas`. Later captures swap in with `setSource`.

You can also load photos:

- **Side-by-side JPEG or PNG**, full or half width (`_2x1` in the name, or set the layout).
- **iPhone or Vision Pro spatial photos (.heic).** libheif (WebAssembly) decodes both eyes. `heif.js` reads
  the HEIF `ster` group for left and right, `cmex` for the baseline (camera positions in µm) and `cmin` for
  the lens. A HEIC with no stereo group is refused.

Where a file has no stereo metadata, set the baseline and field of view by hand.

`vendor/inline3d/` is an unmodified copy of DisplayXR's `@displayxr/inline3d` 1.37.1 (Apache-2.0).
See `vendor/inline3d/VERSION.txt` for the source commit.

`libheif-js` 1.23.2 (LGPL-3.0) is loaded unmodified from jsDelivr when a .heic is opened.
