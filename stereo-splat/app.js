// Stereo Splat — 3D camera → stereo photo → depth → Gaussian splat (.sog) → woven 3D tile.
//
//   @displayxr/inline3d/camera            finds the 3D camera, auto-converged self view, raw-pair photo
//   ./stereo.js (in a worker)             disparity → depth → one Gaussian per pixel
//   @playcanvas/splat-transform + sog.js  .sog with a DisplayXR `camera` block in meta.json
//   @displayxr/inline3d/splat/playcanvas  the splat as an inline-3D window (camera rig from the block)

import { sharedInline3D } from '@displayxr/inline3d';
import { openCamera, addCameraView, readJpegStereoMeta } from '@displayxr/inline3d/camera';
import { addSplat } from '@displayxr/inline3d/splat/playcanvas';
import { encodeSog, cameraBlock } from './sog.js';

const ST_URL = 'https://cdn.jsdelivr.net/npm/@playcanvas/splat-transform@3.6.4';
const DEFAULT_BASELINE_MM = 60;
const DEFAULT_FOV_DEG = 70;
const MAX_PROC_WIDTH = 640; // per-eye width the stereo matcher runs at (= splat columns)
const NEAREST_M = 0.25; // the closest subject the disparity search reaches

const $ = (id) => document.getElementById(id);
const ui = {
  dot: $('dot'), kind: $('kind'), facts: $('facts'), device: $('device'),
  live: $('live'), liveCover: $('liveCover'), liveBadge: $('liveBadge'), liveStatus: $('liveStatus'),
  capture: $('capture'), file: $('file'),
  splat: $('splat'), splatCover: $('splatCover'), splatCoverTitle: $('splatCoverTitle'),
  splatCoverText: $('splatCoverText'), splatBar: $('splatBar'), splatBadge: $('splatBadge'),
  splatStatus: $('splatStatus'), reset: $('reset'), rebuild: $('rebuild'),
  baseline: $('baseline'), fov: $('fov'),
  results: $('results'), depth: $('depth'), stats: $('stats'), downloads: $('downloads'),
};

const wall = await sharedInline3D(); // one inline-3D session for the whole document
let cam = null;
let view = null;
let splat = null;
let lastPair = null; // { bitmap, eyeWidth, height, convergencePx, blob, name }
let busy = false;

// ── camera: detect, open, auto-converged preview ──────────────────────────────────────────

function describe(c) {
  if (c.format === 'sbs' && c.stereo?.rectified) return { kind: '3D camera · rectified stereo pair', level: 'ok' };
  if (c.format === 'sbs') return { kind: '3D camera · side-by-side pair (not rectified)', level: 'warn' };
  return { kind: '2D camera · no stereo', level: 'warn' };
}

async function startCamera(prefer) {
  if (view) view.remove();
  if (cam) cam.close();
  view = null;
  cam = null;
  ui.capture.disabled = true;
  ui.liveCover.hidden = false;
  try {
    cam = await openCamera({ prefer });
  } catch (err) {
    ui.dot.className = 'dot warn';
    ui.kind.textContent = err.code === 'permission-denied' ? 'Camera access was refused' : 'No camera found';
    ui.facts.textContent = err.code === 'camera-busy' ? 'Every camera is in use by another app.' : 'You can still load a side-by-side photo.';
    ui.liveCover.querySelector('.big').textContent = ui.kind.textContent;
    ui.liveCover.lastChild.textContent = ui.facts.textContent;
    return;
  }

  const d = describe(cam);
  ui.dot.className = `dot ${d.level}`;
  ui.kind.textContent = d.kind;
  const facts = [cam.label || 'camera', `${cam.format === 'sbs' ? `${cam.eyeWidth}×${cam.height} per eye` : `${cam.width}×${cam.height}`}`];
  if (cam.stereo?.baselineMm) facts.push(`baseline ${cam.stereo.baselineMm} mm`);
  if (cam.stereo?.horizontalFovDeg) facts.push(`FOV ${cam.stereo.horizontalFovDeg}°`);
  if (cam.skipped.length) facts.push(`skipped ${cam.skipped.length} busy/other device${cam.skipped.length > 1 ? 's' : ''}`);
  ui.facts.textContent = facts.join(' · ');
  ui.baseline.value = cam.stereo?.baselineMm ?? (ui.baseline.value || DEFAULT_BASELINE_MM);
  ui.fov.value = cam.stereo?.horizontalFovDeg ?? (ui.fov.value || DEFAULT_FOV_DEG);

  const eyeAspect = (cam.format === 'sbs' ? cam.eyeWidth : cam.width) / cam.height;
  ui.live.style.setProperty('--aspect', String(eyeAspect));
  // The splat tile takes the same shape; it is only registered at the first capture.
  if (!splat) ui.splat.style.setProperty('--aspect', String(eyeAspect));

  view = addCameraView(wall, ui.live, cam, {
    mirror: true,
    autoConverge: true, // the face at the display plane
    aspect: eyeAspect,
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

  if (cam.format === 'sbs') {
    ui.capture.disabled = false;
    ui.liveStatus.textContent = 'The preview auto-converges: it keeps your face at the screen plane.';
  } else {
    ui.liveStatus.textContent = 'This camera is 2D, so there is no depth to build a splat from. Connect a stereo camera or load a side-by-side photo.';
  }
  await listDevices();
}

async function listDevices() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  if (devs.length < 2) return;
  ui.device.replaceChildren(new Option('Auto (prefer 3D)', 'auto'), ...devs.map((d, i) => new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  ui.device.value = cam?.deviceId && devs.some((d) => d.deviceId === cam.deviceId) ? cam.deviceId : 'auto';
  ui.device.hidden = false;
}
ui.device.addEventListener('change', () => startCamera(ui.device.value));

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
    const bitmap = await createImageBitmap(photo.blob);
    lastPair = {
      bitmap,
      eyeWidth: photo.width / 2,
      height: photo.height,
      convergencePx: photo.convergencePx,
      blob: photo.blob,
      name: photo.suggestedName,
    };
    await build();
  } catch (err) {
    fail(err);
  } finally {
    ui.capture.disabled = !(cam?.format === 'sbs');
  }
});

ui.file.addEventListener('change', async () => {
  const f = ui.file.files?.[0];
  ui.file.value = '';
  if (!f || busy) return;
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const meta = f.type === 'image/jpeg' ? readJpegStereoMeta(bytes) : null;
    const bitmap = await createImageBitmap(f);
    const sbs = meta?.layout === 'sbs' || /_2x1\./i.test(f.name) || bitmap.width / bitmap.height > 2.5;
    if (!sbs) throw new Error('That photo is not side-by-side. Use a stereo pair with the left eye on the left, like the _2x1.jpg files this page saves.');
    if (meta?.baselineMm) ui.baseline.value = meta.baselineMm;
    if (meta?.horizontalFovDeg) ui.fov.value = meta.horizontalFovDeg;
    if (!ui.baseline.value) ui.baseline.value = DEFAULT_BASELINE_MM;
    if (!ui.fov.value) ui.fov.value = DEFAULT_FOV_DEG;
    lastPair = {
      bitmap,
      eyeWidth: bitmap.width / 2,
      height: bitmap.height,
      convergencePx: meta?.convergencePx ?? null,
      blob: f,
      name: f.name,
    };
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

  const { bitmap, eyeWidth, height, convergencePx } = lastPair;
  const baselineM = Math.max(1, Number(ui.baseline.value) || DEFAULT_BASELINE_MM) / 1000;
  const fovDeg = Math.min(170, Math.max(10, Number(ui.fov.value) || DEFAULT_FOV_DEG));
  const fxFull = eyeWidth / 2 / Math.tan((fovDeg * Math.PI) / 360);

  // Both eyes at the matcher's resolution.
  const w = Math.min(MAX_PROC_WIDTH, Math.round(eyeWidth));
  const h = Math.round((height * w) / eyeWidth);
  const s = w / eyeWidth;
  const eye = (i) => {
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(bitmap, i * eyeWidth, 0, eyeWidth, height, 0, 0, w, h);
    return g.getImageData(0, 0, w, h).data;
  };
  const L = eye(0);
  const R = eye(1);
  const fx = fxFull * s;
  const maxD = Math.min(192, Math.max(32, Math.ceil((fx * baselineM) / NEAREST_M)));
  // The face the camera converged on gives the subject distance; else the scene's median depth.
  const subjectZ = convergencePx > 0 ? (fxFull * baselineM) / convergencePx : null;

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
  ui.splatStatus.textContent = 'Drag to look around. Scroll to zoom. Double-click to focus. Space resets focus.';
  ui.rebuild.disabled = false;
  busy = false;
}

async function showSplat(sog) {
  if (!splat) {
    // First splat: register the tile (once — later captures swap the source, never the canvas).
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
    ['Gaussians', `${res.count.toLocaleString()} (${w}×${h})`],
    ['Subject', m(res.depth.subject)],
    ['Depth range', `${m(res.depth.near)} – ${m(res.depth.far)}`],
    ['Stereo', `baseline ${Math.round(baselineM * 1000)} mm · eye FOV ${fovDeg}°`],
    ['.sog size', `${(sog.length / 1024).toFixed(0)} KB`],
    ['Time', `depth ${(ms.depth / 1000).toFixed(1)} s · encode ${(ms.sog / 1000).toFixed(1)} s`],
  ];
  ui.stats.replaceChildren(...rows.flatMap(([k, v]) => [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })]));

  for (const a of ui.downloads.querySelectorAll('a')) URL.revokeObjectURL(a.href);
  const base = (lastPair.name || 'photo').replace(/(_2x1)?\.[a-z0-9]+$/i, '');
  const link = (blob, name, label) => Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name, textContent: label });
  ui.downloads.replaceChildren(
    link(new Blob([sog], { type: 'application/octet-stream' }), `${base}.sog`, `Download splat (${base}.sog)`),
    link(lastPair.blob, `${base}_2x1.jpg`, `Download stereo photo (${base}_2x1.jpg)`),
  );
}

// ── go ────────────────────────────────────────────────────────────────────────────────────

const q = new URLSearchParams(location.search);
startCamera(q.get('camera') === 'mono' ? 'mono' : 'stereo');
Object.assign(window, { __wall: wall, __cam: () => cam, __view: () => view, __splat: () => splat });
