# 4DV Player: rules for agents

Plays 4DV.ai volumetric video (`.4dv`, 4D Gaussian splats) in the browser: woven glasses-free 3D in the
DisplayXR Browser, 2D anywhere else. Plain ES modules, no build step. Served at
https://joehillthunder.github.io/displayxr-demos/apps/4dv-player/ . Read `../../CLAUDE.md` (the
displayxr-demos rules) and the woven-canvas rules in `DisplayXR/displayxr-web` → `docs/woven-canvas-rules.md` first.

## Files

| File | Role |
|---|---|
| `index.html` | All CSS and DOM: canvas, cover, clip panel, transport bar, loading box. Import map: three 0.161.0, `@displayxr/inline3d` 1.45.1 (jsDelivr). |
| `js/main.js` | UI, chunked clip downloads with progress, file open / drag-and-drop, keyboard, `window.fourdv` (debug handle). |
| `js/stage.js` | One persistent canvas; DisplayXR camera rig (attach pattern, convergence on the orbit target, ipd scaled with distance, `depthGain` = the 3D slider); 2D mono loop fallback; orbit / pan / zoom / turntable. |
| `js/player.js` | Opens a `.4dv`, streams segments (keeps 3 resident, prefetches the next), drives the sort worker, the audio-locked clock, and auto-framing from the capture cameras. |
| `js/loader-worker.js` | Zip read + lossless WebP decode (WebGL2 `readPixels`, never a 2D canvas) + the 4dv-sog math → GPU arrays. |
| `js/sort-worker.js` | Per-frame temporal cull + 16-bit counting sort (back to front), from the centre camera, shared by both eyes. Time-binned index so it only scans splats alive near t. |
| `js/splats.js` | `SplatSegment`: data textures + instanced quads; EWA projection and the temporal model in the vertex shader. |
| `js/zip.js` | Minimal Blob zip reader (stored + deflate via `DecompressionStream`). |
| `clips/` | Sample clips as 8 MiB parts + `*.manifest.json`; `clips.json` is the list the panel shows. |

## The 4dv-sog format (reverse-engineered from 4DV.ai's web viewer shaders; verified on all three samples)

- A `.4dv` is a zip. Single clip: `meta.json` + `cameras.json` + WebP images (+ `audio.wav`). Sequence:
  `manifest.json` (segments, timeline, `audioPath`) + `asset/default/<k>/meta.json` etc. per 5 s segment.
- Splat i = pixel i (row-major) of every image. `meta.json` gives `count` and per-channel `mins`/`maxs`.
- `means`: 16-bit `(u << 8) | l`, linear in [min, max], then **signed exp**: `sign(q)·(exp|q| − 1)`.
- `motion`: 16-bit, linear: velocity (units/s). `time_l/u`: RED = time centre, BLUE = log σt (clamp ≥ −20).
- `covar_0/1` RGB = low bytes, `covar_2/3` RGB = high 6 bits of six 14-bit values (÷16383): the upper
  triangle `[l00 l01 l02 l11 l12 l22]` of **L = logm(Σ)**. Σ = expm(L) via a Jacobi eigensolve.
- `sh0_l/u` RGBA: 10-bit `(u & 3) << 8 | l`; RGB = DC colour coeff (colour = 0.5 + 0.28209·dc), A = linear opacity.
- `shN_*` (view-dependent colour codebook + residuals) is **not decoded**: DC colour only.
- At time t: `pos = mean + v·(t − tc)`, `opacity × exp(−½ (t − tc)² / σt²)`; cull below 0.05 temporal weight.
- **Times are local to their segment** (segment k plays global `start + t`).
- Cameras are OpenCV (x right, y down, z forward), `x_cam = R·X + T`. Up = −R row 1; the orbit target is the
  least-squares focus of all optical axes; distance = 1.8 × the capture's own framing.

## Gotchas (each cost a debugging round)

- Splat quad corners must be a **right-handed** basis: minor axis = `(−dir.y, dir.x)`. The mirrored one flips
  winding and three culls every splat (material is DoubleSide now as a belt-and-braces).
- WebP channels with alpha 0 (`time_*` A) lose RGB through a 2D canvas; decode via WebGL with
  `premultiplyAlpha: 'none'` + `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE`.
- Σ is uploaded ×1e4 as half floats (`COV_SCALE`); the shader multiplies back by 1e-4.
- 4DV's CDN (download.4dv.ai) sends no CORS headers, so clips must be hosted here.

## Testing on this PC

Serve the repo root (`python -m http.server 8790 --bind 127.0.0.1`), open
`http://127.0.0.1:8790/displayxr-demos/apps/4dv-player/?clip=cat`. Headless Edge over CDP works for
screenshots and console (`window.fourdv.player` has `time`, `activeCount`, `sortMs`). Real 3D needs the Leia panel:
ask the user to look.

## Adding a clip

Split the `.4dv` into 8 MiB parts (`split -b 8388608 -d -a 3 x.4dv x.part-`), write `x.manifest.json`
(`{ file, size, parts: [{ url, size }] }`), add it to `clips/clips.json`, and add a row to
`../../assets/LICENSES.md`. Anyone can also drop or open their own `.4dv` in the page.

## Fullscreen

`F` / the Fullscreen button calls `requestFullscreen` on the **document** (never the canvas, which must not be
remounted) and adds `body.bare`, which hides `#panel` and `#bar`; Esc removes it. `?fullscreen` (or `?kiosk`)
starts bare and asks for page fullscreen on the first click or key. On the Leia PC the desktop shortcut
**4DV Player (3D web)** runs `C:\Program Files\DisplayXR\Browser\chrome.exe --start-fullscreen
<live url>?fullscreen`; `displayxr-cli status` should then show a ChromiumInline3D client at 3840x2400 with
`weave: render`.
