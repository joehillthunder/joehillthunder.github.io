# splat-call

**Splat Call 3D** turns an ordinary 2D webcam into a live 3D Gaussian-splat hologram, one frame at
a time, in the browser. Look around the person you're talking to. On a glasses-free 3D display,
opened in the [DisplayXR Browser](https://github.com/DisplayXR/displayxr-browser), the caller sits in
real depth on the glass. In any other WebGPU browser it runs in 2D with a gentle sway.

**Live:** https://joehillthunder.github.io/displayxr-demos/apps/splat-call/

Static files only: no build, no keys, no server. Nothing is uploaded, because the models run on your
GPU. Rules: [`../../CLAUDE.md`](../../CLAUDE.md). Branch: `app/splat-call`. Architecture:
[`CLAUDE.md`](CLAUDE.md).

## How it works

After [VoluMe: Authentic 3D Video Calls from Live Gaussian Splat Prediction](https://microsoft.github.io/VoluMe/)
(Microsoft, 2025), which trains a small UNet to predict per-pixel Gaussians for the head in every
frame. VoluMe's weights aren't public, so this demo builds the same per-pixel Gaussians from open
models:

1. **Track:** MediaPipe face landmarks (478, with irises) and a person mask.
2. **Depth:** [Depth Anything V2](https://huggingface.co/onnx-community/depth-anything-v2-small) on a
   head-and-shoulders crop, on WebGPU.
3. **Scale:** the iris (about 11.7 mm) gives the camera distance, and a least-squares fit to the
   landmark depths turns the network's relative depth into metres, every frame.
4. **Splat:** each pixel becomes a flat Gaussian oriented by the surface, a mirrored back layer
   gives the head volume, and a temporal filter keeps still areas steady.

About 25 fps with about 45k splats on an RTX 5070 Ti laptop-class GPU (HQ preset).

## Use it

| Source | How |
|---|---|
| Webcam | **Use my camera**. The Leia display's eye-tracking camera is skipped (using it can break the 3D), so plug in a USB webcam. |
| Video | **Open a video…**, drag and drop, or `?src=<url>` |
| Sample | **Play the sample clip** (`?sample`): Ward Cunningham, Wikimedia Commons, CC BY-SA 3.0 |
| Call | **Call** → *Start a room* and share the link (`?join=<code>`). Each PC sends normal video, and the other side rebuilds you in 3D. |

Keys: <kbd>drag</kbd> orbit · <kbd>right-drag</kbd> pan · <kbd>wheel</kbd> zoom · <kbd>R</kbd> reset ·
<kbd>B</kbd> volume (back layer) · <kbd>D</kbd> depth colours · <kbd>S</kbd> sway ·
<kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> Fast / HQ / Ultra · <kbd>P</kbd> self view.

URL options: `?sample`, `?src=`, `?camera`, `?cam=<label>`, `?join=<code>`, `?q=fast|hq|ultra`,
`?fov=<deg>`, `?back=0`, `?depthcolor`, `?sway` / `?nosway`, `?depth=<gain>`.

## Licences

Depth Anything V2 Small: Apache-2.0. **Base (the Ultra preset): CC BY-NC 4.0, non-commercial.**
MediaPipe: Apache-2.0. transformers.js, three.js, PeerJS: Apache-2.0 / MIT. The sample clip is
hotlinked, not redistributed.
