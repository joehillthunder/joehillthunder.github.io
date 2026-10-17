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

**Models.** Live depth: Depth Anything V2 Small (default), Depth Anything 3 Small (both
Apache-2.0) or V2 Base (non-commercial), from the model dropdown or `?model=small|da3s|base`.
**3D snapshots** (<kbd>T</kbd>) freeze one frame through a bigger model via a local helper:
[Apple SHARP](https://github.com/apple/ml-sharp) (about a million metric Gaussians of the whole
scene, on the GPU through DirectML; research licence) or
[Immersity AI](https://docs-api.immersity.ai/) (Leia's cloud depth; needs keys and credits).

```
pip install -r helper/requirements.txt
python helper/splat_helper.py            # --mock-sharp --mock-immersity to try it without either
```

The **filter strip** above the controls switches filters, backgrounds and themes in one tap.
**Look** (<kbd>Y</kbd>, or **More…** on the strip) has everything, plus detail:
- **Avatars and filters:** 13 options. Filters restyle your live 3D self (hologram, transporter
  beam, cel toon, yellow toon, stone age, portal acid, neon 1985, voxel, gold statue). The robot,
  alien and astronaut-helmet avatars are 3D heads that follow your head, blinks and jaw.
- **Backgrounds:** 10 scenes, each with pieces in front of you that come out of the glass.
- **Experiences:** themed presets that are homages to Star Wars (a hologram message on a
  projector), Star Trek, Futurama, The Simpsons, The Flintstones, Rick and Morty and Back to the
  Future. They copy the look and mood only, with no characters, logos, music or quotes.
- **Detail:** up to 3× more splats, with edge-aware upsampling.

## On a phone

Open the page on a phone or tablet and it switches to a compact layout: icons in the control bar,
source and quality under **Settings**, the filter strip above. Prop the phone at about arm's length
with the front camera on your head and shoulders; **Flip** switches to the back camera to put
someone else in 3D. Drag to look around, pinch to zoom, double-tap to reset. On a 3D phone or
tablet with inline-3D support, the call is woven in glasses-free 3D, either way up.

## Use it

| Source | How |
|---|---|
| Webcam | **Use my camera** picks the best one connected. Over 60 third-party cameras are recognised by name or USB id (USB webcams, laptop cameras, phones as webcams, capture cards, virtual cameras, RealSense / Kinect / Orbbec depth cameras, ZED and other side-by-side stereo cameras) and get their real lens FOV, which sets the depth scale. Plug one in at any time and it's offered. **Cameras and FOV…** (<kbd>C</kbd>) shows what was recognised and lets you set the FOV. The Leia display's eye-tracking camera is skipped (using it can break the 3D). |
| Video | **Open a video…**, drag and drop, or `?src=<url>` |
| Sample | **Play the sample clip** (`?sample`): Ward Cunningham, Wikimedia Commons, CC BY-SA 3.0 |
| Call | **Call** → *Start a room* and share the link (`?join=<code>`). Each PC sends normal video, and the other side rebuilds you in 3D. |

Keys: <kbd>drag</kbd> orbit · <kbd>right-drag</kbd> pan · <kbd>wheel</kbd> zoom · <kbd>R</kbd> reset ·
<kbd>B</kbd> volume (back layer) · <kbd>D</kbd> depth colours · <kbd>S</kbd> sway ·
<kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> Fast / HQ / Ultra · <kbd>P</kbd> self view · <kbd>C</kbd> cameras · <kbd>T</kbd> snapshot · <kbd>L</kbd> back to live ·
<kbd>Y</kbd> look · <kbd>V</kbd> avatar · <kbd>G</kbd> background · <kbd>X</kbd> experience.

URL options: `?sample`, `?src=`, `?camera`, `?cam=<label>`, `?join=<code>`, `?q=fast|hq|ultra`,
`?model=small|da3s|base`, `?look=<id>`, `?bg=<id>`, `?exp=<id>`, `?detail=1|1.5|2|3`, `?helper=<url>`, `?scene=1` (SHARP keeps the whole scene), `?fov=<deg>`, `?back=0`, `?depthcolor`, `?sway` / `?nosway`, `?depth=<gain>`.

## Licences

Depth Anything V2 Small and Depth Anything 3 Small: Apache-2.0. **V2 Base: CC BY-NC 4.0, non-commercial.** **Apple SHARP: Apple research licence, non-commercial.** Immersity AI: per its terms (free credits are non-commercial).
MediaPipe: Apache-2.0. transformers.js, three.js, PeerJS: Apache-2.0 / MIT. The sample clip is
hotlinked, not redistributed.
