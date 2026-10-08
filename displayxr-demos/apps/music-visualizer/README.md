# music-visualizer

A beat-reactive music visualizer. On a glasses-free 3D display, opened in the
[DisplayXR Browser](https://github.com/DisplayXR/displayxr-browser), the visuals have real depth that pulses
with the music. In any other browser it runs as an ordinary 2D visualizer.

**Live:** https://joehillthunder.github.io/displayxr-demos/apps/music-visualizer/

Static files only: no build, no keys, no server. Rules: [`../../CLAUDE.md`](../../CLAUDE.md). Branch: `app/music-visualizer`.

## Audio sources

| Source | How |
|---|---|
| Demo track | Synthesized live in Web Audio (`demo-track.js`): a 124 BPM loop with an intro, drops, a breakdown and a snare-roll build. No audio files, so nothing to license. |
| Audio file | Pick one, or drag and drop it anywhere on the page. Anything the browser decodes: MP3, WAV, OGG, FLAC, M4A/AAC, Opus. Loops. |
| Tab audio | `getDisplayMedia`: pick a tab (Spotify, YouTube…) and tick **Share tab audio**. The tab keeps playing its own sound; only the analyser listens. |
| Microphone | `getUserMedia` with echo cancellation, noise suppression and AGC off. Not routed to the speakers. |

## Styles

Keys <kbd>1</kbd>–<kbd>6</kbd> (or <kbd>←</kbd>/<kbd>→</kbd>). <kbd>A</kbd> cycles styles on the first beat after 22 s.

| # | Style | Trend it draws from | Depth on a 3D display |
|---|---|---|---|
| 1 | Spectrogram | 3D spectrum bars / waterfall | Newest row on the glass, history scrolls back into the screen; beats push the front row out |
| 2 | Tunnel | Wormhole / tunnel visuals | Spectrum-shaped rings fly from deep behind the glass out toward you; speed follows loudness and beats |
| 3 | Hyperspace | Starfield / particle burst | Particles stream toward you; kicks fire radial bursts |
| 4 | Ridgeline | "Unknown Pleasures" joy plot | Ridges recede into the screen with occluding skirts |
| 5 | Orb | Audio-reactive blob | Noise-displaced sphere straddling the glass, swelling out on the beat, with orbiting satellites |
| 6 | Halo | Radial spectrum ring (music-channel style) | Three ring layers at different depths; back layers echo older spectra; the disc pops out on the beat |

Other keys: <kbd>Space</kbd> play/pause (file and demo), <kbd>F</kbd> fullscreen, <kbd>H</kbd> hide controls,
<kbd>Esc</kbd> back from the source menu. The controls auto-hide after 3 s.

URL flags: `?2d` forces the 2D path; `?debug` shows a HUD (mode, buffer size, fps, levels, beat count,
`handle.stats()` and the `firstWoven` time).

## How it works

- `audio.js`: one `AudioContext` and one `AnalyserNode` (FFT 4096). Per frame: 64 log-spaced bands
  (30 Hz–16 kHz) with auto-gain, a waveform, bass/mid/treble levels, and beat detection by spectral flux
  on the low bands against an adaptive mean + 1.4σ threshold, with a 270 ms refractory gap.
- `styles.js`: six three.js scenes authored in metres for a 0.24 m virtual display. `z = 0` is the
  glass, `+z` is out toward the viewer. Content stays within about +6 cm in front and -32 cm behind.
  All six are built once; switching only toggles visibility.
- `app.js`: the renderer, both render paths and the UI.

### Inline 3D ([`@displayxr/inline3d`](https://github.com/DisplayXR/displayxr-web) 1.37.1)

Loaded from jsDelivr at a pinned version through a dynamic `import()` inside `try/catch`, so a CDN problem
degrades to 2D instead of a blank page. three.js is pinned at 0.161.0. The page follows
`docs/woven-canvas-rules.md` and the three.js porting pitfalls:

- One `createInline3D({ lazy: false })` per document; one full-window canvas that is never remounted.
- `will-change: transform` on the canvas from first paint; the 2:1 side-by-side backing store is sized
  and drawn into for two frames before `addScene`.
- An opaque cover sits on top of the canvas until `handle.firstWoven`, and again across fullscreen or a
  resize until `handle.rewoven()`. It is cut, never faded.
- Every frame checks for two views and a viewport per eye before clearing. On a short frame the last good
  eye matrices (copies, via `EyeCamera.setFromMatrices`) are replayed instead of skipping.
- `setPixelRatio(1)`; the SBS buffer is no wider than the window (each eye gets half), clamped to the GL
  limits and a pixel budget; `preserveDrawingBuffer` on for the full-window woven canvas.
- Display rig (`virtualDisplayHeight` 0.24). The **Depth** slider sets the rig's `ipdFactor` through
  `handle.setViewRig(displayRig(…))`, shown only where `inline3dViewRigSupported()`.
- `onLayerLost` drops back to the mono path. No CSS effects on the canvas or its ancestors; the
  controls use a plain translucent tint (no `backdrop-filter`) and are hidden with `display: none`.
  They carry `data-inline3d-overlay` for older browsers.

## Status

Tested in 2D in Chrome: the demo track, file playback via drag and drop, and all six styles. Tab
capture and the microphone need a person to answer the browser's picker or permission prompt, so they
were not exercised in automated testing.
The beat detector was checked offline against synthetic 120 and 150 BPM kicks, a kick 22 dB down, and
steady tones (no false beats).

Needs Leia hardware to verify: the woven 3D path (cover release on `firstWoven`, depth comfort of each
style, the Depth slider, the fullscreen cover, frame rate of a full-window SBS canvas).
