// sharp.js — the page's side of Apple SHARP (see sharp-worker.js): one worker kept for the whole
// visit, so the 0.66 GB of weights are downloaded and compiled once, plus the step that puts
// SHARP's single-image scene at the stereo pair's measured scale.

const HF = 'https://huggingface.co/sm079/sharp-onnx-webgpu/resolve/main';
export const SHARP_MODEL = { modelUrl: `${HF}/sharp.onnx`, packUrl: `${HF}/sharp.int8.bin` };
export const SHARP_SIZE = 1536;
const CACHE_NAME = 'stereo-splat-sharp-v1'; // same as sharp-worker.js

export const hasWebGpu = () => typeof navigator !== 'undefined' && 'gpu' in navigator;

/** True when the weights are already in Cache Storage, so loading will not download them. */
export async function sharpCached() {
  try {
    return Boolean(await (await caches.open(CACHE_NAME)).match(SHARP_MODEL.packUrl));
  } catch {
    return false;
  }
}

let worker = null;
let loading = null;
let queue = Promise.resolve();
let onProgress = () => {};

function call(msg, transfer = []) {
  const run = () =>
    new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') onProgress(data.stage, data.f);
        else if (data.type === 'error') reject(new Error(data.message));
        else resolve(data);
      };
      worker.onerror = (e) => reject(new Error(e.message || 'The SHARP worker failed to start'));
      worker.postMessage(msg, transfer);
    });
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/** Download (or read from cache) and compile SHARP. Safe to call again: it loads once. */
export function loadSharp(progress = () => {}) {
  onProgress = progress;
  if (!loading) {
    worker ??= new Worker(new URL('./sharp-worker.js', import.meta.url), { type: 'module' });
    loading = call({ type: 'load', ...SHARP_MODEL }).catch((err) => {
      loading = null; // let a later build try again
      worker?.terminate();
      worker = null;
      throw err;
    });
  }
  return loading;
}

/**
 * Run SHARP on one eye.
 * @param {ImageBitmap} bitmap  the side-by-side photo
 * @param {{ sx: number, sy: number, sw: number, sh: number }} crop  the eye's region of `bitmap`
 * @param {number} width   the eye's TRUE width (a half side-by-side eye is unsqueezed)
 * @param {number} height
 * @param {number} focalPx  focal length in true-eye pixels
 * @returns {Promise<{ columns: Record<string, Float32Array>, count: number, total: number, ms: { run: number, unproject: number } }>}
 */
export async function runSharp(bitmap, crop, width, height, focalPx, progress = () => {}) {
  await loadSharp(progress);
  onProgress = progress;
  // SHARP's own CLI squashes the photo to its square input; the unprojection undoes it.
  const c = new OffscreenCanvas(SHARP_SIZE, SHARP_SIZE);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, SHARP_SIZE, SHARP_SIZE);
  const pixels = g.getImageData(0, 0, SHARP_SIZE, SHARP_SIZE).data;
  return call({ type: 'run', pixels, width, height, focalPx }, [pixels.buffer]);
}

/**
 * SHARP guesses absolute scale from one image; the stereo pair MEASURES it. Each opaque
 * Gaussian is projected into the disparity map and compared with the depth the pair saw there.
 * The median ratio rescales the scene (positions and sizes alike), so the splat matches the
 * baseline, the mesh export and the camera block.
 *
 * @param {Record<string, Float32Array>} cols  SHARP columns (PLY space), changed in place
 * @param {Float32Array} disp  left disparity, w×h
 * @param {number} fx  focal length in disparity-map pixels
 * @returns {{ scale: number, samples: number }}
 */
export function alignToStereo(cols, disp, w, h, fx, baselineM) {
  const n = cols.x.length;
  const stride = Math.max(1, Math.floor(n / 200000));
  const ratios = [];
  for (let i = 0; i < n; i += stride) {
    const z = cols.z[i];
    if (!(z > 0) || cols.opacity[i] < 1.5) continue; // opacity column is a logit: 1.5 ≈ 0.82
    const u = Math.round((fx * cols.x[i]) / z + w / 2 - 0.5);
    const v = Math.round((fx * cols.y[i]) / z + h / 2 - 0.5);
    if (u < 0 || v < 0 || u >= w || v >= h) continue;
    const d = disp[v * w + u];
    if (d > 0.5) ratios.push((fx * baselineM) / d / z);
  }
  if (ratios.length < 500) return { scale: 1, samples: ratios.length };
  ratios.sort((a, b) => a - b);
  const k = ratios[Math.floor(ratios.length / 2)];
  const logK = Math.log(k);
  for (let i = 0; i < n; i++) {
    cols.x[i] *= k;
    cols.y[i] *= k;
    cols.z[i] *= k;
    cols.scale_0[i] += logK;
    cols.scale_1[i] += logK;
    cols.scale_2[i] += logK;
  }
  return { scale: k, samples: ratios.length };
}

/** Depth percentiles of the splat centres (metres), for the camera block. */
export function depthRange(cols) {
  const n = cols.z.length;
  const stride = Math.max(1, Math.floor(n / 100000));
  const z = [];
  for (let i = 0; i < n; i += stride) if (cols.z[i] > 0) z.push(cols.z[i]);
  z.sort((a, b) => a - b);
  const pct = (f) => (z.length ? z[Math.min(z.length - 1, Math.floor(f * z.length))] : 1);
  return { near: pct(0.01), median: pct(0.5), far: pct(0.99) };
}
