// Stereo Splat — 3D camera or spatial photo → stereo pair → depth → Gaussian splat (.sog) → 3D tile.
//
//   @displayxr/inline3d/camera            finds the 3D camera, auto-converged self view, raw-pair photo
//   ./cameras.js                          stereo cameras the SDK cannot see by shape (Acer SpatialLabs Eyes)
//   ./heif.js                             iPhone / Vision Pro spatial photos (HEIC stereo pairs)
//   ./stereo.js (in a worker)             disparity → depth → one Gaussian per pixel
//   @playcanvas/splat-transform + sog.js  .sog with a DisplayXR `camera` block in meta.json
//   @displayxr/inline3d/splat/playcanvas  the splat as an inline-3D window (camera rig from the block)

import { sharedInline3D } from '@displayxr/inline3d';
import { openCamera, addCameraView, readJpegStereoMeta } from '@displayxr/inline3d/camera';
import { addSplat } from '@displayxr/inline3d/splat/playcanvas';
import { encodeSog, cameraBlock, zipStored } from './sog.js';
import { buildObj, buildGlb } from './mesh.js';
import { knownStereoCamera, STEREO_HINT, eyeAspectOf, openProfileStream } from './cameras.js';
import { isHeif, decodeSpatialPhoto } from './heif.js';

const ST_URL = 'https://cdn.jsdelivr.net/npm/@playcanvas/splat-transform@3.6.4';
const DEFAULT_BASELINE_MM = 60;
const DEFAULT_FOV_DEG = 70;
// iPhone spatial photos without camera metadata: the lens pair is close together (≈ 2 cm).
const SPATIAL_PHOTO_BASELINE_MM = 20;
const SPATIAL_PHOTO_FOV_DEG = 65;
const MAX_PROC_WIDTH = 640; // per-eye width the stereo matcher runs at (= splat columns)
const NEAREST_M = 0.25; // the closest subject the disparity search reaches

const $ = (id) => document.getElementById(id);
const ui = {
  dot: $('dot'), kind: $('kind'), facts: $('facts'), device: $('device'), layout: $('layout'),
  live: $('live'), liveCover: $('liveCover'), liveBadge: $('liveBadge'), liveStatus: $('liveStatus'),
  capture: $('capture'), file: $('file'),
  splat: $('splat'), splatCover: $('splatCover'), splatCoverTitle: $('splatCoverTitle'),
  splatCoverText: $('splatCoverText'), splatBar: $('splatBar'), splatBadge: $('splatBadge'),
  splatStatus: $('splatStatus'), reset: $('reset'), rebuild: $('rebuild'),
  baseline: $('baseline'), fov: $('fov'),
  results: $('results'), depth: $('depth'), stats: $('stats'), downloads: $('downloads'),
  exportObj: $('exportObj'), exportGlb: $('exportGlb'), meshDetail: $('meshDetail'), meshEdges: $('meshEdges'), meshDepth: $('meshDepth'), exportStatus: $('exportStatus'),
};

const wall = await sharedInline3D(); // one inline-3D session for the whole document
let cam = null;
let view = null;
let ownStream = null; // a stream this page opened (profile / manual layout); stopped on switch
/** What the open camera is: `{ name, format: 'sbs'|'mono', eyeAspect, baselineMm, hfovDeg, how }` */
let profile = null;
let splat = null;
/** `{ bitmap, rawEyeWidth, height, eyeAspect, convergencePx, blob, name, source }` */
let lastPair = null;
/** The last build's depth, for the mesh export: `{ pair, disp, w, h, fx, baselineM, far, subjectZ }` */
let lastResult = null;
let busy = false;

// ── camera: detect, open, auto-converged preview ──────────────────────────────────────────

async function videoInputs() {
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
}

function closeCamera() {
  view?.remove();
  cam?.close();
  ownStream?.getTracks().forEach((t) => t.stop());
  view = cam = ownStream = profile = null;
}

/** Hand a stream this page opened to the SDK as the camera, declared `format`. */
async function adoptStream(stream, format, p) {
  ownStream = stream;
  cam = await openCamera({
    prefer: stream,
    format,
    calibration: format === 'sbs' ? { baselineMm: p.baselineMm ?? undefined, horizontalFovDeg: p.hfovDeg ?? undefined } : undefined,
  });
  profile = p;
}

const LAYOUT_NAMES = { sbs: 'full side-by-side', 'half-sbs': 'half side-by-side', mono: '2D' };

/**
 * `choice`: 'auto' or a deviceId. The layout select can force how the device is read.
 *  1. The SDK opens the best camera (and with it, permission and device labels).
 *  2. A device the SDK read as 2D is upgraded when its label is a known stereo camera — or,
 *     on 'auto', when any connected device is one.
 */
async function startCamera(choice = 'auto') {
  closeCamera();
  ui.capture.disabled = true;
  ui.liveCover.hidden = false;
  const layout = ui.layout.value;
  try {
    cam = await openCamera({ prefer: choice === 'auto' ? 'stereo' : choice });
    const devs = await videoInputs();
    const deviceId = cam.deviceId;
    const label = cam.label;

    if (layout !== 'auto') {
      // Manual: read this device as the chosen layout, at the resolution its profile (or a
      // sensible default for the layout) asks for.
      const known = knownStereoCamera(label);
      const want =
        layout === 'mono'
          ? { width: 1920, height: 1080, frameRate: 30 }
          : (known ?? (layout === 'sbs' ? { width: 3840, height: 1080, frameRate: 30 } : { width: 3840, height: 2160, frameRate: 30 }));
      cam.close();
      cam = null;
      const stream = await openProfileStream(deviceId, want);
      const s = stream.getVideoTracks()[0].getSettings();
      await adoptStream(stream, layout === 'mono' ? 'mono' : 'sbs', {
        name: `${label || 'Camera'} as ${LAYOUT_NAMES[layout]}`,
        format: layout === 'mono' ? 'mono' : 'sbs',
        eyeAspect: layout === 'mono' ? s.width / s.height : eyeAspectOf(s.width, s.height, layout),
        baselineMm: known?.baselineMm ?? null,
        hfovDeg: known?.hfovDeg ?? null,
        how: 'manual',
      });
    } else if (cam.format === 'mono') {
      const pool = choice === 'auto' ? devs : devs.filter((d) => d.deviceId === deviceId);
      const hit = pool.map((d) => ({ d, p: knownStereoCamera(d.label) })).find((x) => x.p);
      if (hit) {
        cam.close();
        cam = null;
        const stream = await openProfileStream(hit.d.deviceId, hit.p);
        const s = stream.getVideoTracks()[0].getSettings();
        await adoptStream(stream, 'sbs', {
          name: hit.p.name,
          format: 'sbs',
          eyeAspect: eyeAspectOf(s.width, s.height, hit.p.layout),
          baselineMm: hit.p.baselineMm,
          hfovDeg: hit.p.hfovDeg,
          how: 'label',
        });
      }
    }
    if (!profile) {
      profile =
        cam.format === 'sbs'
          ? {
              name: cam.stereo?.rectified ? 'DisplayXR 3D Camera' : 'Side-by-side stereo camera',
              format: 'sbs',
              eyeAspect: cam.eyeWidth / cam.height,
              baselineMm: cam.stereo?.baselineMm ?? null,
              hfovDeg: cam.stereo?.horizontalFovDeg ?? null,
              how: cam.stereo?.rectified ? 'runtime' : 'shape',
            }
          : { name: '2D camera', format: 'mono', eyeAspect: cam.width / cam.height, baselineMm: null, hfovDeg: null, how: 'shape' };
    }
  } catch (err) {
    closeCamera();
    ui.dot.className = 'dot warn';
    ui.kind.textContent = err.code === 'permission-denied' ? 'Camera access was refused' : 'No camera found';
    ui.facts.textContent =
      err.code === 'camera-busy' ? 'Every camera is in use by another app.' : 'You can still load a side-by-side photo or an iPhone spatial photo.';
    ui.liveCover.querySelector('.big').textContent = ui.kind.textContent;
    ui.liveCover.lastChild.textContent = ui.facts.textContent;
    return;
  }

  const stereo = profile.format === 'sbs';
  ui.dot.className = `dot ${stereo ? 'ok' : 'warn'}`;
  ui.kind.textContent = stereo ? `3D camera · ${profile.name}` : `2D camera · ${profile.how === 'manual' ? 'set by you' : 'no stereo'}`;
  const how = {
    runtime: 'rectified pair from the DisplayXR runtime',
    shape: stereo ? 'side-by-side frames' : null,
    label: 'recognised by name · half side-by-side',
    manual: null,
  }[profile.how];
  const facts = [cam.label || 'camera'];
  const rawEye = Math.round(cam.width / 2);
  const trueEye = Math.round(cam.height * profile.eyeAspect);
  facts.push(
    !stereo
      ? `${cam.width}×${cam.height}`
      : rawEye === trueEye
        ? `${rawEye}×${cam.height} per eye`
        : `${rawEye}×${cam.height} per eye, shown as ${trueEye}×${cam.height}`,
  );
  if (how) facts.push(how);
  if (profile.baselineMm) facts.push(`baseline ${profile.baselineMm} mm`);
  if (profile.hfovDeg) facts.push(`FOV ${profile.hfovDeg}°`);
  if (!stereo && profile.how !== 'manual' && STEREO_HINT.test(cam.label)) facts.push('the name suggests a stereo camera: pick its layout');
  ui.facts.textContent = facts.join(' · ');
  ui.baseline.value = Math.round(profile.baselineMm ?? (Number(ui.baseline.value) || DEFAULT_BASELINE_MM));
  ui.fov.value = Math.round(profile.hfovDeg ?? (Number(ui.fov.value) || DEFAULT_FOV_DEG));

  ui.live.style.setProperty('--aspect', String(profile.eyeAspect));
  // The splat tile takes the same shape; it is only registered at the first capture.
  if (!splat) ui.splat.style.setProperty('--aspect', String(profile.eyeAspect));

  // `aspect` is the TRUE per-eye shape, so a half side-by-side eye is drawn unsqueezed.
  view = addCameraView(wall, ui.live, cam, {
    mirror: true,
    autoConverge: true, // the face at the display plane
    aspect: profile.eyeAspect,
    onRouteChange: () => setBadge(ui.liveBadge, view?.woven),
  });
  setBadge(ui.liveBadge, view.woven);
  // Cut the cover on the tile's first woven frame (or at once on the flat route).
  if (view.handle) await view.handle.firstWoven;
  ui.liveCover.hidden = true;

  cam.on('ended', () => {
    ui.dot.className = 'dot warn';
    ui.kind.textContent = 'Camera disconnected';
    ui.facts.textContent = 'It was unplugged, revoked, or taken by another app.';
    ui.capture.disabled = true;
  });

  ui.capture.disabled = !stereo;
  ui.liveStatus.textContent = stereo
    ? 'The preview auto-converges: it keeps your face at the screen plane.'
    : 'This camera is 2D, so there is no depth to build a splat from. Connect a stereo camera, pick a side-by-side layout, or load a photo.';
  await listDevices();
}

async function listDevices() {
  const devs = await videoInputs();
  if (devs.length < 2) return;
  const tag = (d) => (knownStereoCamera(d.label) ? ' (3D)' : '');
  ui.device.replaceChildren(
    new Option('Auto (prefer 3D)', 'auto'),
    ...devs.map((d, i) => new Option(`${d.label || `Camera ${i + 1}`}${tag(d)}`, d.deviceId)),
  );
  ui.device.value = cam?.deviceId && devs.some((d) => d.deviceId === cam.deviceId) ? cam.deviceId : 'auto';
  ui.device.hidden = false;
}
ui.device.addEventListener('change', () => startCamera(ui.device.value));
ui.layout.addEventListener('change', () => startCamera(cam?.deviceId ?? 'auto'));

function setBadge(el, woven) {
  el.textContent = woven ? '3D' : '2D';
  el.classList.toggle('on', Boolean(woven));
}

// ── capture / load ────────────────────────────────────────────────────────────────────────

ui.capture.addEventListener('click', async () => {
  if (busy || !cam) return;
  ui.capture.disabled = true;
  try {
    const photo = await cam.capturePhoto({ type: 'image/jpeg', quality: 0.95 });
    lastPair = {
      bitmap: await createImageBitmap(photo.blob),
      rawEyeWidth: photo.width / 2,
      height: photo.height,
      eyeAspect: profile.eyeAspect,
      convergencePx: photo.convergencePx,
      blob: photo.blob,
      name: photo.suggestedName,
      source: profile.name,
    };
    await build();
  } catch (err) {
    fail(err);
  } finally {
    ui.capture.disabled = !(profile?.format === 'sbs');
  }
});

ui.file.addEventListener('change', async () => {
  const f = ui.file.files?.[0];
  ui.file.value = '';
  if (!f || busy) return;
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (isHeif(bytes)) {
      progress('Opening spatial photo', 'Decoding both eyes (HEVC, about 2 MB of decoder on first use)', null);
      const sp = await decodeSpatialPhoto(bytes);
      ui.baseline.value = Math.round((sp.baselineMm ?? SPATIAL_PHOTO_BASELINE_MM) * 10) / 10;
      ui.fov.value = Math.round(sp.hfovDeg ?? SPATIAL_PHOTO_FOV_DEG);
      // keep a side-by-side JPEG of the pair for download
      const c = new OffscreenCanvas(sp.eyeWidth * 2, sp.height);
      c.getContext('2d').drawImage(sp.bitmap, 0, 0);
      const notes = [sp.ordered ? 'stereo pair group' : 'two images with camera positions'];
      notes.push(sp.baselineMm ? `baseline ${sp.baselineMm.toFixed(1)} mm from file` : 'baseline assumed, edit if known');
      notes.push(sp.hfovDeg ? 'lens from file' : 'FOV assumed');
      lastPair = {
        bitmap: sp.bitmap,
        rawEyeWidth: sp.eyeWidth,
        height: sp.height,
        eyeAspect: sp.eyeWidth / sp.height,
        convergencePx: null,
        blob: await c.convertToBlob({ type: 'image/jpeg', quality: 0.95 }),
        name: f.name,
        source: `Spatial photo (${notes.join(', ')})`,
      };
    } else {
      const meta = f.type === 'image/jpeg' || /\.jpe?g$/i.test(f.name) ? readJpegStereoMeta(bytes) : null;
      const bitmap = await createImageBitmap(new Blob([bytes], { type: f.type || 'image/jpeg' }));
      const forced = ui.layout.value === 'sbs' || ui.layout.value === 'half-sbs';
      const sbs = forced || meta?.layout === 'sbs' || /_2x1\./i.test(f.name) || bitmap.width / bitmap.height > 2.5;
      if (!sbs) {
        throw new Error(
          'That photo is not side-by-side. Use a stereo pair with the left eye on the left (or set the layout above), or an iPhone spatial photo (.heic).',
        );
      }
      if (meta?.baselineMm) ui.baseline.value = meta.baselineMm;
      if (meta?.horizontalFovDeg) ui.fov.value = meta.horizontalFovDeg;
      if (!ui.baseline.value) ui.baseline.value = DEFAULT_BASELINE_MM;
      if (!ui.fov.value) ui.fov.value = DEFAULT_FOV_DEG;
      const layout = forced ? ui.layout.value : 'auto';
      const eyeAspect = eyeAspectOf(bitmap.width, bitmap.height, layout);
      const half = eyeAspect === bitmap.width / bitmap.height;
      lastPair = {
        bitmap,
        rawEyeWidth: bitmap.width / 2,
        height: bitmap.height,
        eyeAspect,
        convergencePx: meta?.convergencePx ?? null,
        blob: f,
        name: f.name,
        source: `Side-by-side photo (${half ? 'half' : 'full'} width)`,
      };
    }
    await build();
  } catch (err) {
    fail(err);
  }
});

ui.rebuild.addEventListener('click', () => lastPair && !busy && build().catch(fail));
ui.reset.addEventListener('click', () => splat?.resetPose());

// ── stereo → splat → .sog → tile ──────────────────────────────────────────────────────────

let stPromise = null;
function loadSplatTransform() {
  stPromise ??= import('@playcanvas/splat-transform').then((st) => {
    st.WebPCodec.wasmUrl = `${ST_URL}/lib/webp.wasm`;
    st.WorkerQueue.maxWorkers = 0; // encode on this thread: a cross-origin worker script cannot start
    st.logger.setVerbosity?.('quiet');
    return st;
  });
  return stPromise;
}

function progress(title, text, f) {
  if (!splat) {
    ui.splatCover.hidden = false;
    ui.splatCoverTitle.textContent = title;
    ui.splatCoverText.textContent = text;
    ui.splatBar.hidden = f === null;
    if (f !== null) ui.splatBar.firstChild.style.width = `${Math.round(f * 100)}%`;
  }
  ui.splatStatus.textContent = f === null ? `${title}. ${text}` : `${title}: ${text} (${Math.round(f * 100)}%)`;
}

function fail(err) {
  console.error(err);
  busy = false;
  progress('Could not build the splat', String(err?.message || err), null);
}

async function build() {
  busy = true;
  ui.rebuild.disabled = true;
  const t0 = performance.now();
  const stLoad = loadSplatTransform(); // 5 MB; fetched while the matcher runs

  const { bitmap, rawEyeWidth, height, eyeAspect } = lastPair;
  // The eye's TRUE width: a half side-by-side eye (squeezed to half width) is unsqueezed here.
  const eyeWidth = height * eyeAspect;
  const squeeze = eyeWidth / rawEyeWidth;
  const convergencePx = lastPair.convergencePx > 0 ? lastPair.convergencePx * squeeze : null;
  const baselineM = Math.max(1, Number(ui.baseline.value) || DEFAULT_BASELINE_MM) / 1000;
  const fovDeg = Math.min(170, Math.max(10, Number(ui.fov.value) || DEFAULT_FOV_DEG));
  const fxFull = eyeWidth / 2 / Math.tan((fovDeg * Math.PI) / 360);

  // Both eyes at the matcher's resolution, at their true aspect.
  const w = Math.min(MAX_PROC_WIDTH, Math.round(eyeWidth));
  const h = Math.round((height * w) / eyeWidth);
  const s = w / eyeWidth;
  const eye = (i) => {
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(bitmap, i * rawEyeWidth, 0, rawEyeWidth, height, 0, 0, w, h);
    return g.getImageData(0, 0, w, h).data;
  };
  const L = eye(0);
  const R = eye(1);
  const fx = fxFull * s;
  const maxD = Math.min(192, Math.max(32, Math.ceil((fx * baselineM) / NEAREST_M)));
  // The face the camera converged on gives the subject distance; else the scene's median depth.
  const subjectZ = convergencePx ? (fxFull * baselineM) / convergencePx : null;

  progress('Finding depth', 'Matching the left and right eye', 0);
  const res = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./stereo-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') progress('Finding depth', 'Matching the left and right eye', data.f * 0.7);
      else {
        worker.terminate();
        data.type === 'done' ? resolve(data) : reject(new Error(data.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'The stereo worker failed to start'));
    };
    worker.postMessage({ L, R, w, h, fx, baselineM, subjectZ, minD: -8, maxD }, [L.buffer, R.buffer]);
  });
  const tDepth = performance.now();

  progress('Encoding', `${res.count.toLocaleString()} Gaussians → .sog (PlayCanvas splat-transform)`, 0.75);
  const st = await stLoad;
  const camera = cameraBlock({
    eyeWidth: Math.round(eyeWidth),
    eyeHeight: Math.round(height),
    fx: fxFull,
    baselineM,
    subjectZ: res.depth.subject,
    near: res.depth.near,
    far: res.depth.far,
    source: subjectZ ? 'convergence' : 'auto',
  });
  const sog = await encodeSog(st, res.columns, camera);
  const tSog = performance.now();

  progress('Loading', 'Putting the splat on the 3D tile', 0.95);
  await showSplat(sog);
  drawDepth(res.disp, w, h, res.depth, fx, baselineM);
  report({ res, w, h, baselineM, fovDeg, sog, ms: { depth: tDepth - t0, sog: tSog - tDepth } });
  lastResult = { pair: lastPair, disp: res.disp, w, h, fx, baselineM, far: res.depth.far, subjectZ: res.depth.subject };
  ui.exportObj.disabled = ui.exportGlb.disabled = false;
  ui.exportStatus.textContent = '';
  ui.splatStatus.textContent = 'Drag to look around. Scroll to zoom. Double-click to focus. Space resets focus.';
  ui.rebuild.disabled = false;
  busy = false;
}

async function showSplat(sog) {
  if (!splat) {
    // First splat: give the canvas the photo's shape, let it settle two frames (woven-canvas
    // rule 4), then register the tile — once; later captures swap the source, never the canvas.
    ui.splat.style.setProperty('--aspect', String(lastPair.eyeAspect));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    splat = addSplat(wall, ui.splat, sog, {
      rig: 'auto', // the .sog's camera block → the camera rig at the capture viewpoint
      feather: 24,
      renderScale: 0.6,
      idleSpin: 0,
    });
    const [, woven] = await Promise.all([splat.ready, splat.firstWoven]);
    setBadge(ui.splatBadge, woven.woven);
    ui.splatCover.hidden = true; // hard cut
    ui.reset.disabled = false;
  } else {
    await splat.setSource(sog, { fadeMs: 600, resetPose: true });
  }
}

// ── 2D readouts ───────────────────────────────────────────────────────────────────────────

function drawDepth(disp, w, h, depth, fx, B) {
  ui.results.hidden = false;
  ui.depth.width = w;
  ui.depth.height = h;
  const g = ui.depth.getContext('2d');
  const img = g.createImageData(w, h);
  const zn = Math.log(depth.near);
  const zf = Math.log(depth.far);
  for (let p = 0; p < w * h; p++) {
    const z = disp[p] > 0.5 ? Math.min(depth.far, (fx * B) / disp[p]) : depth.far;
    const t = 1 - Math.min(1, Math.max(0, (Math.log(z) - zn) / (zf - zn || 1))); // near = 1
    const [r, gg, b] = ramp(t);
    img.data[p * 4] = r;
    img.data[p * 4 + 1] = gg;
    img.data[p * 4 + 2] = b;
    img.data[p * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

/** A perceptual-ish ramp: deep blue (far) → teal → yellow → white (near). */
function ramp(t) {
  const stops = [[13, 22, 64], [24, 108, 140], [74, 190, 130], [240, 220, 90], [255, 250, 235]];
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  return stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
}

function report({ res, w, h, baselineM, fovDeg, sog, ms }) {
  const m = (v) => (v >= 1 ? `${v.toFixed(2)} m` : `${Math.round(v * 100)} cm`);
  const rows = [
    ['Source', lastPair.source],
    ['Gaussians', `${res.count.toLocaleString()} (${w}×${h})`],
    ['Subject', m(res.depth.subject)],
    ['Depth range', `${m(res.depth.near)} – ${m(res.depth.far)}`],
    ['Stereo', `baseline ${+(baselineM * 1000).toFixed(1)} mm · eye FOV ${fovDeg}°`],
    ['.sog size', `${(sog.length / 1024).toFixed(0)} KB`],
    ['Time', `depth ${(ms.depth / 1000).toFixed(1)} s · encode ${(ms.sog / 1000).toFixed(1)} s`],
  ];
  ui.stats.replaceChildren(...rows.flatMap(([k, v]) => [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })]));

  for (const a of ui.downloads.querySelectorAll('a')) URL.revokeObjectURL(a.href);
  const base = baseName(lastPair);
  const link = (blob, name, label) => Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name, textContent: label });
  ui.downloads.replaceChildren(
    link(new Blob([sog], { type: 'application/octet-stream' }), `${base}.sog`, `Download splat (${base}.sog)`),
    link(lastPair.blob, `${base}_2x1.jpg`, `Download stereo photo (${base}_2x1.jpg)`),
  );
}

function baseName(pair) {
  return (pair.name || 'photo').replace(/(_2x1)?\.[a-z0-9]+$/i, '').replace(/[^\w.-]+/g, '_') || 'photo';
}

// ── mesh export (.obj / .glb) for the DisplayXR 3D Model Viewer ───────────────────────────

/** The left eye at its true aspect, up to 2048 px wide, as JPEG bytes: the mesh's texture. */
async function textureJpeg(pair) {
  const eyeW = pair.height * pair.eyeAspect;
  const tw = Math.min(2048, Math.round(eyeW));
  const th = Math.round((pair.height * tw) / eyeW);
  const c = new OffscreenCanvas(tw, th);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(pair.bitmap, 0, 0, pair.rawEyeWidth, pair.height, 0, 0, tw, th);
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 })).arrayBuffer());
}

function saveBlob(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function exportMesh(format) {
  const r = lastResult;
  if (!r) return;
  ui.exportObj.disabled = ui.exportGlb.disabled = true;
  try {
    const base = baseName(r.pair);
    const opts = {
      ...r,
      step: Number(ui.meshDetail.value) || 2,
      edgeRatio: ui.meshEdges.value === 'cut' ? 1.08 : Infinity,
      depthScale: Number(ui.meshDepth.value) || 1,
      name: base,
    };
    const jpg = await textureJpeg(r.pair);
    const MB = (n) => `${(n / 1048576).toFixed(1)} MB`;
    if (format === 'glb') {
      const { glb, triangles } = buildGlb(opts, jpg);
      saveBlob(new Blob([glb], { type: 'model/gltf-binary' }), `${base}.glb`);
      ui.exportStatus.textContent =
        `${base}.glb: ${triangles.toLocaleString()} triangles, ${MB(glb.length)}, texture inside. ` +
        'Open it in the DisplayXR 3D Model Viewer (Ctrl+O or drag and drop), or in any glTF viewer.';
    } else {
      const mesh = buildObj(opts);
      const enc = new TextEncoder();
      const zip = zipStored([
        [`${base}.obj`, enc.encode(mesh.obj)],
        [`${base}.mtl`, enc.encode(mesh.mtl)],
        [`${base}.jpg`, jpg],
      ]);
      saveBlob(new Blob([zip], { type: 'application/zip' }), `${base}_obj.zip`);
      ui.exportStatus.textContent =
        `${base}_obj.zip: ${mesh.triangles.toLocaleString()} triangles, ${MB(zip.length)}. ` +
        `Unzip it, then open ${base}.obj in the DisplayXR 3D Model Viewer (Ctrl+O or drag and drop). Keep the three files together.`;
    }
  } catch (err) {
    console.error(err);
    ui.exportStatus.textContent = `Export failed: ${err?.message || err}`;
  } finally {
    ui.exportObj.disabled = ui.exportGlb.disabled = false;
  }
}
ui.exportObj.addEventListener('click', () => exportMesh('obj'));
ui.exportGlb.addEventListener('click', () => exportMesh('glb'));

// ── go ────────────────────────────────────────────────────────────────────────────────────

const q = new URLSearchParams(location.search);
startCamera(q.get('camera') === 'mono' ? 'mono' : 'stereo');
Object.assign(window, { __wall: wall, __cam: () => cam, __view: () => view, __splat: () => splat });
