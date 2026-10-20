# 4DV Player

Plays [4DV.ai](https://www.4dv.ai/) volumetric video (4D Gaussian splats) in the browser. In the
[DisplayXR Browser](https://github.com/DisplayXR/displayxr-browser) on a Leia display it plays in glasses-free 3D;
in any other browser it plays in 2D.

**Open it:** https://joehillthunder.github.io/displayxr-demos/apps/4dv-player/

- Three sample clips: **Cat** (23 MB), **A2O · Paparazzi** (35 s music video with sound, streamed in 5 s
  segments), **Puppet** (9.5M splats with sound, PC only).
- **Open a .4dv file…** or drag one onto the page to play your own (nothing is uploaded).
- Drag to orbit, right-drag to pan, wheel to zoom; play/pause, seek, speed, loop, turntable, reset view, and a
  **3D** strength slider (0 = flat, 2 = exaggerated). Keys: Space, R, ←/→, ↑/↓, [ ], T, Home, L, V, H, F.
- **Fullscreen** (F, or the button): the page fills the screen with every control hidden and the pointer hides
  when still; Esc brings the controls back. `?fullscreen` starts that way for a hands-off display; on the Leia PC
  the desktop shortcut **4DV Player (3D web)** opens it in the DisplayXR Browser with `--start-fullscreen`.
- `?clip=cat|a2o|puppet` opens a clip directly.

It is its own renderer (three.js + WebGL2), not 4DV.ai's WebGPU player: it decodes the same `.4dv` files and
draws each eye separately, which is what glasses-free 3D needs. View-dependent colour (spherical harmonics) is
not decoded yet, so highlights don't shift as you orbit. How it works: [`CLAUDE.md`](CLAUDE.md).

Sample clips © 4DV.ai.
