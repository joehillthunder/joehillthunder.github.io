// Reconstruction worker: one webcam frame in, one cloud of 3D Gaussians out.
//
// This is a training-free stand-in for VoluMe (Microsoft, 2025), which predicts per-pixel
// Gaussians for the head region of every frame with a small UNet. We get the same per-pixel
// structure from parts that ship today:
//
//   1. Depth Anything V2 (ONNX, WebGPU) predicts relative inverse depth for a square head crop.
//   2. The 478 MediaPipe face landmarks pin that relative depth to metres: the iris (about
//      11.7 mm across) gives the distance to the camera, the landmark z values give the face's
//      relief, and a least-squares fit maps the network's disparity onto them, every frame. This
//      plays the part of VoluMe's scale correction.
//   3. Every crop pixel inside the person mask becomes a flat Gaussian (a surfel) spanning its
//      cell, oriented by the depth gradient, with a mirrored back layer so the head has volume
//      when you look around it.
//   4. A per-pixel temporal filter steadies depth where the image has not changed (VoluMe's
//      stability loss does this at training time).
//
// The worker also sorts splats back to front for the main thread, on request.

import { AutoModel, Tensor, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;

// Live depth models. `depth: true` marks a model that outputs depth (far = larger) rather than
// disparity; infer() negates it, so everything downstream can keep "larger = nearer", and the
// linear metric fit stays exact for affine depth. `views` = the extra view axis Depth Anything 3
// takes ([1, views, 3, H, W]). `dtype` pins the only precision a repo ships.
const MODELS = {
  small: { id: 'onnx-community/depth-anything-v2-small', license: 'Apache-2.0' },
  da3s: { id: 'onnx-community/depth-anything-v3-small', license: 'Apache-2.0', depth: true, views: true, dtype: 'fp32' },
  base: { id: 'onnx-community/depth-anything-v2-base', license: 'CC-BY-NC-4.0' },
};

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const IRIS_MM = 11.7;

let model = null;
let modelName = '';
let device = 'wasm';
let dtype = 'q8';
let inputHalf = false;
let loading = null;

const canvas = new OffscreenCanvas(16, 16);
const ctx2d = canvas.getContext('2d', { willReadFrequently: true });

// State kept between frames.
const st = {
  zIris: 0,          // damped camera distance to the eyes (m)
  center: null,      // damped head centre in camera coordinates [x, y, z]
  fit: null,         // last good disparity → depth fit { p, q }
  prevZ: null, prevM: null, prevC: null, prevRoi: null, prevG: 0,
  lastT: 0,
};

const pool = [];
let current = null; // { id, N, xyz } of the last frame sent, for re-sorts

// ---------------------------------------------------------------------------------------------
// Model

async function pickDevice() {
  if (!self.navigator?.gpu) return { device: 'wasm', dtype: 'q8' };
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { device: 'wasm', dtype: 'q8' };
    return { device: 'webgpu', dtype: adapter.features.has('shader-f16') ? 'fp16' : 'fp32' };
  } catch {
    return { device: 'wasm', dtype: 'q8' };
  }
}

async function load(name) {
  if (model && modelName === name) return;
  if (model) { await model.dispose?.(); model = null; }
  const pick = await pickDevice();
  device = pick.device;
  dtype = MODELS[name].dtype || pick.dtype;
  const id = MODELS[name].id;
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.file?.endsWith('.onnx')) {
      files.set(p.file, p);
      let loaded = 0, total = 0;
      for (const f of files.values()) { loaded += f.loaded || 0; total += f.total || 0; }
      postMessage({ type: 'progress', loaded, total, file: p.file });
    }
  };
  // Downloads from the Hugging Face CDN sometimes drop part-way; retry a few times. Once a file
  // has loaded, transformers.js keeps it in Cache Storage, so later visits start instantly.
  const fetchModel = async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await AutoModel.from_pretrained(id, { device, dtype, progress_callback });
      } catch (e) {
        const network = /fetch|network|connection|load|Failed/i.test(String(e?.message ?? e));
        if (!network || attempt >= 4) throw e;
        console.warn(`[recon] model download failed (attempt ${attempt}), retrying`, e);
        postMessage({ type: 'retry', attempt });
        files.clear();
      }
    }
  };
  try {
    model = await fetchModel();
  } catch (e) {
    if (device !== 'webgpu') throw e;
    console.warn('[recon] WebGPU load failed, falling back to WASM', e);
    device = 'wasm';
    dtype = MODELS[name].dtype || 'q8';
    model = await fetchModel();
  }
  modelName = name;
  inputHalf = false;
  postMessage({ type: 'ready', model: name, device, dtype, license: MODELS[name].license });
}

// float32 → float16 bits, for models whose input is half precision.
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 112;
  if (e <= 0) return sign;
  if (e >= 31) return sign | 0x7c00;
  return sign | (e << 10) | ((x >>> 13) & 0x3ff);
}
function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >>> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

async function infer(rgba, S) {
  const n = S * S;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    input[i] = (rgba[k] / 255 - MEAN[0]) / STD[0];
    input[n + i] = (rgba[k + 1] / 255 - MEAN[1]) / STD[1];
    input[2 * n + i] = (rgba[k + 2] / 255 - MEAN[2]) / STD[2];
  }
  const spec = MODELS[modelName];
  const shape = spec.views ? [1, 1, 3, S, S] : [1, 3, S, S];
  const run = (half) => {
    const t = half ? new Tensor('float16', Uint16Array.from(input, toHalf), shape) : new Tensor('float32', input, shape);
    return model({ pixel_values: t });
  };
  let out;
  try {
    out = await run(inputHalf);
  } catch (e) {
    if (!/float16|type|tensor\(float/i.test(String(e?.message ?? e))) throw e;
    inputHalf = !inputHalf;
    out = await run(inputHalf);
  }
  const pd = out.predicted_depth;
  const dims = pd.dims;
  const h = dims[dims.length - 2], w = dims[dims.length - 1];
  let data = pd.data;
  if (data instanceof Uint16Array) data = Float32Array.from(data, fromHalf);
  else if (!(data instanceof Float32Array)) data = Float32Array.from(data);
  for (const k of Object.keys(out)) out[k]?.dispose?.();
  if (spec.depth) {
    data = Float32Array.from(data);
    for (let i = 0; i < data.length; i++) data[i] = -data[i];
  }
  return { disp: data, dw: w, dh: h };
}

// ---------------------------------------------------------------------------------------------
// Sampling helpers

/** Bilinear sample of a single-channel w×h grid at pixel-centre coordinates (x, y). */
function bilin(a, w, h, x, y, outside = 0) {
  if (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5) return outside;
  x = Math.min(Math.max(x, 0), w - 1);
  y = Math.min(Math.max(y, 0), h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0, fy = y - y0;
  const r0 = y0 * w, r1 = y1 * w;
  return (a[r0 + x0] * (1 - fx) + a[r0 + x1] * fx) * (1 - fy) + (a[r1 + x0] * (1 - fx) + a[r1 + x1] * fx) * fy;
}

/** Bilinear RGB sample of an RGBA S×S image into out[o..o+2] (0-255). */
function bilinRGB(a, S, x, y, out, o) {
  x = Math.min(Math.max(x, 0), S - 1);
  y = Math.min(Math.max(y, 0), S - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, S - 1), y1 = Math.min(y0 + 1, S - 1);
  const fx = x - x0, fy = y - y0;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  const i00 = (y0 * S + x0) * 4, i10 = (y0 * S + x1) * 4, i01 = (y1 * S + x0) * 4, i11 = (y1 * S + x1) * 4;
  for (let c = 0; c < 3; c++) out[o + c] = a[i00 + c] * w00 + a[i10 + c] * w10 + a[i01 + c] * w01 + a[i11 + c] * w11;
}

const smoothstep = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Turbo colormap (Google, polynomial fit), t in 0..1 → 0..255.
function turbo(t, out, o) {
  t = Math.min(1, Math.max(0, t));
  const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  out[o] = Math.min(255, Math.max(0, r * 255));
  out[o + 1] = Math.min(255, Math.max(0, g * 255));
  out[o + 2] = Math.min(255, Math.max(0, b * 255));
}

// ---------------------------------------------------------------------------------------------
// Metric scale from the face landmarks

/** Camera distance to the eyes from the iris diameter, or 0 when the iris is not visible. */
function irisDistance(lm, W, H, f) {
  if (!lm || lm.length < 478 * 3) return 0;
  const d = (a, b) => Math.hypot((lm[a * 3] - lm[b * 3]) * W, (lm[a * 3 + 1] - lm[b * 3 + 1]) * H);
  // Right iris ring 469-472, left 474-477. The larger of width and height resists foreshortening.
  const r = Math.max(d(469, 471), d(470, 472));
  const l = Math.max(d(474, 476), d(475, 477));
  const px = Math.max(r, l);
  if (!(px > 2)) return 0;
  return (f * IRIS_MM * 1e-3) / px;
}

const FIT_IDS = [];
for (let i = 0; i < 468; i += 2) FIT_IDS.push(i);

/** Least-squares z = p + q·d over the landmarks; null when the fit is not trustworthy. */
function fitDepth(lm, zEyes, disp, dw, dh, roi, W, H, f) {
  const zRefLm = (lm[468 * 3 + 2] + lm[473 * 3 + 2]) / 2;
  const metresPerUnit = (W * zEyes) / f; // landmark z is in image-width units
  const ds = [], zs = [];
  for (const k of FIT_IDS) {
    const u = (lm[k * 3] * W - roi.x0) / roi.size;
    const v = (lm[k * 3 + 1] * H - roi.y0) / roi.size;
    if (u < 0.02 || v < 0.02 || u > 0.98 || v > 0.98) continue;
    ds.push(bilin(disp, dw, dh, u * dw - 0.5, v * dh - 0.5));
    zs.push(zEyes + (lm[k * 3 + 2] - zRefLm) * metresPerUnit);
  }
  const solve = (w) => {
    let sw = 0, sd = 0, sz = 0, sdd = 0, sdz = 0;
    for (let i = 0; i < ds.length; i++) {
      const wi = w ? w[i] : 1;
      sw += wi; sd += wi * ds[i]; sz += wi * zs[i]; sdd += wi * ds[i] * ds[i]; sdz += wi * ds[i] * zs[i];
    }
    const den = sw * sdd - sd * sd;
    if (sw < 30 || Math.abs(den) < 1e-12) return null;
    const q = (sw * sdz - sd * sz) / den;
    return { p: (sz - q * sd) / sw, q };
  };
  let fit = solve(null);
  if (!fit) return null;
  // One round of outlier rejection (hair over the forehead, glasses, hands).
  let ss = 0;
  const res = ds.map((d, i) => zs[i] - (fit.p + fit.q * d));
  for (const r of res) ss += r * r;
  const sigma = Math.sqrt(ss / res.length) + 1e-4;
  fit = solve(res.map((r) => (Math.abs(r) < 2.5 * sigma ? 1 : 0))) || fit;
  if (!(fit.q < 0)) return null; // more disparity must mean closer
  fit.rms = sigma;
  return fit;
}

// ---------------------------------------------------------------------------------------------
// Gaussians

function takeBuffers(cap) {
  let b = pool.pop();
  while (b && b.cap < cap) b = pool.pop();
  if (!b) {
    b = {
      cap,
      pos: new Float32Array(cap * 4),
      covA: new Float32Array(cap * 4),
      covB: new Float32Array(cap * 2),
      color: new Uint8Array(cap * 4),
      order: new Float32Array(cap),
    };
  }
  return b;
}

function build(m, disp, dw, dh, rgba) {
  const { W, H, f, roi, lm, opts } = m;
  const G = opts.G;
  const S = m.S;
  const cx = W / 2, cy = H / 2;
  const now = m.t;
  const dt = st.lastT ? Math.min(0.5, Math.max(0.001, (now - st.lastT) / 1000)) : 1 / 30;
  st.lastT = now;

  // 1. Distance and head centre from the landmarks.
  const zMeas = irisDistance(lm, W, H, f);
  if (zMeas > 0.2 && zMeas < 3) {
    st.zIris = st.zIris ? st.zIris + (zMeas - st.zIris) * (1 - Math.exp(-2.5 * dt)) : zMeas;
  }
  const zEyes = st.zIris || opts.defaultDist;
  if (lm) {
    const ex = ((lm[468 * 3] + lm[473 * 3]) / 2) * W, ey = ((lm[468 * 3 + 1] + lm[473 * 3 + 1]) / 2) * H;
    const ny = lm[1 * 3 + 1] * H;
    const zc = zEyes + 0.07;
    const c = [((ex - cx) / f) * zc, ((ny * 0.6 + ey * 0.4 - cy) / f) * zc, zc];
    if (!st.center) st.center = c;
    else {
      const k = 1 - Math.exp(-3 * dt);
      for (let i = 0; i < 3; i++) st.center[i] += (c[i] - st.center[i]) * k;
    }
  }
  if (!st.center) {
    const zc = zEyes + 0.07;
    st.center = [((roi.x0 + roi.size / 2 - cx) / f) * zc, ((roi.y0 + roi.size * 0.42 - cy) / f) * zc, zc];
  }
  const [cX, cY, cZ] = st.center;

  // 2. Disparity → metres.
  let fit = lm ? fitDepth(lm, zEyes, disp, dw, dh, roi, W, H, f) : null;
  let fitOk = !!fit;
  if (!fit) fit = st.fit;
  else st.fit = fit;

  const n = G * G;
  const dG = new Float32Array(n), mG = new Float32Array(n), cG = new Float32Array(n * 3), zG = new Float32Array(n);
  const cell = roi.size / G;
  for (let j = 0; j < G; j++) {
    const v = (j + 0.5) / G;
    for (let i = 0; i < G; i++) {
      const u = (i + 0.5) / G;
      const k = j * G + i;
      dG[k] = bilin(disp, dw, dh, u * dw - 0.5, v * dh - 0.5);
      const px = roi.x0 + u * roi.size, py = roi.y0 + v * roi.size;
      mG[k] = bilin(m.mask, m.mw, m.mh, (px / W) * m.mw - 0.5, (py / H) * m.mh - 0.5);
      bilinRGB(rgba, S, u * S - 0.5, v * S - 0.5, cG, k * 3);
    }
  }
  if (fit) {
    for (let k = 0; k < n; k++) zG[k] = fit.p + fit.q * dG[k];
  } else {
    // No face yet: spread the person's disparity over a plausible 25 cm of relief.
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < n; k++) if (mG[k] > 0.5) { lo = Math.min(lo, dG[k]); hi = Math.max(hi, dG[k]); }
    const span = hi > lo ? hi - lo : 1;
    for (let k = 0; k < n; k++) zG[k] = zEyes - 0.03 + (1 - (dG[k] - lo) / span) * 0.25;
  }
  const zMin = zEyes - 0.3, zMax = zEyes + 0.9;
  for (let k = 0; k < n; k++) zG[k] = Math.min(zMax, Math.max(zMin, zG[k]));

  // 3. Temporal filter: where the pixel's colour held still, ease depth and mask toward the new
  //    values instead of jumping. A moved crop or a big change resets the pixel.
  const pr = st.prevRoi;
  const sameGrid = st.prevZ && st.prevG === G && pr && Math.abs(pr.x0 - roi.x0) < cell * 0.25 && Math.abs(pr.y0 - roi.y0) < cell * 0.25 && Math.abs(pr.size - roi.size) < cell * 0.25;
  if (sameGrid && opts.smooth > 0) {
    const a = 1 - opts.smooth;
    for (let k = 0; k < n; k++) {
      const dc = Math.abs(cG[k * 3] - st.prevC[k * 3]) + Math.abs(cG[k * 3 + 1] - st.prevC[k * 3 + 1]) + Math.abs(cG[k * 3 + 2] - st.prevC[k * 3 + 2]);
      const dz = zG[k] - st.prevZ[k];
      const still = dc < 36 && Math.abs(dz) < 0.04;
      if (still) {
        zG[k] = st.prevZ[k] + dz * a;
        mG[k] = st.prevM[k] + (mG[k] - st.prevM[k]) * Math.min(1, a * 1.5);
      }
    }
  }
  st.prevZ = zG; st.prevM = mG; st.prevC = cG; st.prevRoi = { ...roi }; st.prevG = G;

  // 4. World positions: x right, y up, z toward the viewer, head centre at the origin.
  const sx = opts.mirror ? -1 : 1;
  const wp = new Float32Array(n * 3);
  for (let j = 0; j < G; j++) {
    const py = roi.y0 + ((j + 0.5) / G) * roi.size;
    for (let i = 0; i < G; i++) {
      const k = j * G + i;
      const px = roi.x0 + ((i + 0.5) / G) * roi.size;
      const z = zG[k];
      wp[k * 3] = sx * (((px - cx) / f) * z - cX);
      wp[k * 3 + 1] = -(((py - cy) / f) * z - cY);
      wp[k * 3 + 2] = -(z - cZ);
    }
  }

  // 5. One surfel per kept cell, plus a mirrored back layer.
  const cap = n * 2;
  const B = takeBuffers(cap);
  const { pos, covA, covB, color } = B;
  const keep = (k) => mG[k] > 0.3;
  const t1 = [0, 0, 0], t2 = [0, 0, 0], col = [0, 0, 0];
  const sideTangent = (k, kf, kb, okF, okB, out) => {
    let best = Infinity;
    for (const [a, b, ok] of [[kf, k, okF], [k, kb, okB]]) {
      if (!ok) continue;
      const x = wp[a * 3] - wp[b * 3], y = wp[a * 3 + 1] - wp[b * 3 + 1], z = wp[a * 3 + 2] - wp[b * 3 + 2];
      const l = x * x + y * y + z * z;
      if (l < best) { best = l; out[0] = x; out[1] = y; out[2] = z; }
    }
    return best < Infinity ? Math.sqrt(best) : -1;
  };

  // Silhouette depth per row, for the back layer.
  const rowSil = new Float32Array(G).fill(NaN);
  if (opts.back) {
    for (let j = 0; j < G; j++) {
      let l = -1, r = -1;
      for (let i = 0; i < G; i++) if (mG[j * G + i] > 0.5) { if (l < 0) l = i; r = i; }
      if (l >= 0 && r - l > 2) {
        // Look a couple of cells inside the edge, where depth is not yet smeared into the background.
        const li = Math.min(r, l + 2), ri = Math.max(l, r - 2);
        rowSil[j] = (zG[j * G + li] + zG[j * G + ri]) / 2;
      }
    }
  }

  let N = 0;
  const zSpan = 0.32;
  const back = [];
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const k = j * G + i;
      if (!keep(k)) continue;
      const z = zG[k];
      const s = (cell / f) * z; // cell footprint (m)
      const l1 = sideTangent(k, i + 1 < G ? k + 1 : -1, i > 0 ? k - 1 : -1, i + 1 < G && keep(k + 1), i > 0 && keep(k - 1), t1);
      const l2 = sideTangent(k, j + 1 < G ? k + G : -1, j > 0 ? k - G : -1, j + 1 < G && keep(k + G), j > 0 && keep(k - G), t2);
      if (l1 < 0) { t1[0] = sx * s; t1[1] = 0; t1[2] = 0; }
      if (l2 < 0) { t2[0] = 0; t2[1] = -s; t2[2] = 0; }
      const r1 = (l1 < 0 ? s : l1) / s, r2 = (l2 < 0 ? s : l2) / s;
      const fade = Math.min(1, Math.max(0, 1 - (Math.max(r1, r2) - 2.5) / 3));
      // Clamp stretched tangents so depth jumps do not smear into long streaks.
      const cl = (t, r) => { if (r > 3) { const q = 3 / r; t[0] *= q; t[1] *= q; t[2] *= q; } };
      cl(t1, r1); cl(t2, r2);
      // Normal = t1 × t2.
      let nx = t1[1] * t2[2] - t1[2] * t2[1], ny = t1[2] * t2[0] - t1[0] * t2[2], nz = t1[0] * t2[1] - t1[1] * t2[0];
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const sn = 0.18 * s;
      const c = 0.3;
      const xx = c * (t1[0] * t1[0] + t2[0] * t2[0]) + sn * sn * nx * nx;
      const xy = c * (t1[0] * t1[1] + t2[0] * t2[1]) + sn * sn * nx * ny;
      const xz = c * (t1[0] * t1[2] + t2[0] * t2[2]) + sn * sn * nx * nz;
      const yy = c * (t1[1] * t1[1] + t2[1] * t2[1]) + sn * sn * ny * ny;
      const yz = c * (t1[1] * t1[2] + t2[1] * t2[2]) + sn * sn * ny * nz;
      const zz = c * (t1[2] * t1[2] + t2[2] * t2[2]) + sn * sn * nz * nz;
      // Feather where the bust is cut off: the crop's sides and bottom, and the video frame's edges.
      const u = (i + 0.5) / G, v = (j + 0.5) / G;
      const fx = (roi.x0 + u * roi.size) / W, fy = (roi.y0 + v * roi.size) / H;
      const edge = smoothstep(0, 0.1, 1 - v) * smoothstep(0, 0.05, u) * smoothstep(0, 0.05, 1 - u) *
        smoothstep(0, 0.08, 1 - fy) * smoothstep(0, 0.03, fx) * smoothstep(0, 0.03, 1 - fx);
      const alpha = smoothstep(0.3, 0.75, mG[k]) * fade * edge;
      if (alpha < 0.02) continue;

      if (opts.depthColor) turbo((z - (zEyes - 0.08)) / zSpan, col, 0);
      else { col[0] = cG[k * 3]; col[1] = cG[k * 3 + 1]; col[2] = cG[k * 3 + 2]; }

      const o = N * 4, o2 = N * 2;
      pos[o] = wp[k * 3]; pos[o + 1] = wp[k * 3 + 1]; pos[o + 2] = wp[k * 3 + 2]; pos[o + 3] = alpha;
      covA[o] = xx * 1e6; covA[o + 1] = xy * 1e6; covA[o + 2] = xz * 1e6; covA[o + 3] = yy * 1e6;
      covB[o2] = yz * 1e6; covB[o2 + 1] = zz * 1e6;
      color[o] = col[0]; color[o + 1] = col[1]; color[o + 2] = col[2]; color[o + 3] = 255;
      N++;

      const zs = rowSil[j];
      if (opts.back && zs === zs && mG[k] > 0.5) {
        const zb = Math.max(z + s, zs + 1.15 * (zs - z));
        back.push(k, zb, alpha);
      }
    }
  }
  // Back layer: same footprint, pushed behind the silhouette plane, a little darker.
  for (let b = 0; b < back.length && N < cap; b += 3) {
    const k = back[b], zb = back[b + 1], alpha = back[b + 2];
    const o = N * 4, o2 = N * 2;
    pos[o] = wp[k * 3]; pos[o + 1] = wp[k * 3 + 1]; pos[o + 2] = -(zb - cZ); pos[o + 3] = alpha;
    const s = (cell / f) * zb;
    const v = 0.3 * s * s;
    covA[o] = v * 1e6; covA[o + 1] = 0; covA[o + 2] = 0; covA[o + 3] = v * 1e6;
    covB[o2] = 0; covB[o2 + 1] = v * 0.6e6;
    if (opts.depthColor) turbo((zb - (zEyes - 0.08)) / zSpan, col, 0);
    else { col[0] = cG[k * 3] * 0.78; col[1] = cG[k * 3 + 1] * 0.78; col[2] = cG[k * 3 + 2] * 0.78; }
    color[o] = col[0]; color[o + 1] = col[1]; color[o + 2] = col[2]; color[o + 3] = 255;
    N++;
  }

  return { B, N, fitOk, fit, zEyes };
}

// ---------------------------------------------------------------------------------------------
// Sorting (16-bit counting sort, far first), shared by both eyes

let depthBuf = new Float32Array(0);
let keyBuf = new Uint32Array(0);
let bucketBuf = new Uint16Array(0);
const counts = new Uint32Array(65536);

function sortInto(xyz, N, cam, dir, out) {
  if (depthBuf.length < N) {
    depthBuf = new Float32Array(N);
    keyBuf = new Uint32Array(N);
    bucketBuf = new Uint16Array(N);
  }
  const [cx, cy, cz] = cam;
  const [dx, dy, dz] = dir;
  let n = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < N; i++) {
    const d = (xyz[i * 4] - cx) * dx + (xyz[i * 4 + 1] - cy) * dy + (xyz[i * 4 + 2] - cz) * dz;
    if (d <= 0) continue;
    depthBuf[n] = d;
    keyBuf[n] = i;
    n++;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  counts.fill(0);
  const scale = hi > lo ? 65535 / (hi - lo) : 0;
  for (let k = 0; k < n; k++) {
    const b = 65535 - (((depthBuf[k] - lo) * scale) | 0);
    bucketBuf[k] = b;
    counts[b]++;
  }
  let sum = 0;
  for (let b = 0; b < 65536; b++) { const c = counts[b]; counts[b] = sum; sum += c; }
  for (let k = 0; k < n; k++) out[counts[bucketBuf[k]]++] = keyBuf[k];
  return n;
}

// ---------------------------------------------------------------------------------------------
// Ready-made Gaussians (Apple SHARP via the helper): camera space in, our world space out

/**
 * m.means / m.cov / m.rgba: N splats in OpenCV camera space (metres; covariance in mm², as
 * xx xy xz yy yz zz; sRGB + alpha). Re-centred on the head like a live frame, mirrored for a
 * local camera, and optionally cut to the person mask.
 */
function buildExternal(m) {
  const { means, cov, rgba, W, H, f, lm, opts } = m;
  const n = rgba.length / 4;
  const cx = W / 2, cy = H / 2;
  const sx = opts.mirror ? -1 : 1;
  // Head centre: the median depth of the splats seen through the eyes, 7 cm further in.
  let ex = cx, ey = H * 0.4, ny = H * 0.45;
  if (lm) {
    ex = ((lm[468 * 3] + lm[473 * 3]) / 2) * W;
    ey = ((lm[468 * 3 + 1] + lm[473 * 3 + 1]) / 2) * H;
    ny = lm[1 * 3 + 1] * H;
  }
  const r2 = (W * 0.03) ** 2;
  const zs = [];
  for (let i = 0; i < n; i++) {
    const z = means[i * 3 + 2];
    if (!(z > 0.05)) continue;
    const u = (f * means[i * 3]) / z + cx, v = (f * means[i * 3 + 1]) / z + cy;
    if ((u - ex) ** 2 + (v - ey) ** 2 < r2 && rgba[i * 4 + 3] > 128) zs.push(z);
  }
  zs.sort((a, b) => a - b);
  const zEyes = zs.length ? zs[zs.length >> 1] : st.zIris || opts.defaultDist;
  const zc = zEyes + 0.07;
  const cX = ((ex - cx) / f) * zc, cY = ((ny * 0.6 + ey * 0.4 - cy) / f) * zc, cZ = zc;

  const B = takeBuffers(n);
  const { pos, covA, covB, color } = B;
  let N = 0;
  for (let i = 0; i < n; i++) {
    const x = means[i * 3], y = means[i * 3 + 1], z = means[i * 3 + 2];
    if (!(z > 0.05 && z < 50)) continue;
    const a = rgba[i * 4 + 3];
    if (a < 4) continue;
    if (opts.personOnly && m.mask) {
      const u = (f * x) / z + cx, v = (f * y) / z + cy;
      const mk = bilin(m.mask, m.mw, m.mh, (u / W) * m.mw - 0.5, (v / H) * m.mh - 0.5);
      if (mk < 0.35 || z > zc + 0.5) continue;
    }
    const o = N * 4, o2 = N * 2, c = i * 6;
    pos[o] = sx * (x - cX); pos[o + 1] = -(y - cY); pos[o + 2] = -(z - cZ); pos[o + 3] = a / 255;
    // D Σ D with D = diag(sx, -1, -1).
    covA[o] = cov[c]; covA[o + 1] = -sx * cov[c + 1]; covA[o + 2] = -sx * cov[c + 2]; covA[o + 3] = cov[c + 3];
    covB[o2] = cov[c + 4]; covB[o2 + 1] = cov[c + 5];
    color[o] = rgba[i * 4]; color[o + 1] = rgba[i * 4 + 1]; color[o + 2] = rgba[i * 4 + 2]; color[o + 3] = 255;
    N++;
  }
  return { B, N, zEyes };
}

// ---------------------------------------------------------------------------------------------

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      loading = load(m.model);
      await loading;
    } else if (m.type === 'recycle') {
      if (m.bufs) pool.push(m.bufs);
    } else if (m.type === 'reset') {
      Object.assign(st, { zIris: 0, center: null, fit: null, prevZ: null, prevRoi: null, lastT: 0 });
    } else if (m.type === 'frame') {
      await loading;
      const t0 = performance.now();
      const S = m.S;
      if (canvas.width !== S) { canvas.width = S; canvas.height = S; }
      ctx2d.drawImage(m.bitmap, 0, 0, S, S);
      m.bitmap.close();
      const rgba = ctx2d.getImageData(0, 0, S, S).data;
      // A snapshot can bring its own disparity (Immersity AI, via the helper): larger = nearer.
      const { disp, dw, dh } = m.disp ? { disp: m.disp, dw: m.dw, dh: m.dh } : await infer(rgba, S);
      const t1 = performance.now();
      const { B, N, fitOk, fit, zEyes } = build(m, disp, dw, dh, rgba);
      const count = sortInto(B.pos, N, m.cam, m.dir, B.order);
      // Keep positions for re-sorts while the main thread owns the buffers.
      if (!current || current.xyz.length < N * 4) current = { xyz: new Float32Array(B.cap * 4) };
      current.xyz.set(B.pos.subarray(0, N * 4));
      current.id = m.id;
      current.N = N;
      const t2 = performance.now();
      postMessage(
        {
          type: 'splats', id: m.id, N, count, bufs: B, snap: !!m.snap,
          stats: { modelMs: t1 - t0, buildMs: t2 - t1, fitOk, rms: fit?.rms ?? 0, zEyes, device, dtype },
        },
        [B.pos.buffer, B.covA.buffer, B.covB.buffer, B.color.buffer, B.order.buffer],
      );
    } else if (m.type === 'external') {
      const t0 = performance.now();
      const { B, N, zEyes } = buildExternal(m);
      const count = sortInto(B.pos, N, m.cam, m.dir, B.order);
      if (!current || current.xyz.length < N * 4) current = { xyz: new Float32Array(B.cap * 4) };
      current.xyz.set(B.pos.subarray(0, N * 4));
      current.id = m.id;
      current.N = N;
      postMessage(
        {
          type: 'splats', id: m.id, N, count, bufs: B, snap: true,
          stats: { modelMs: 0, buildMs: performance.now() - t0, fitOk: true, rms: 0, zEyes, device, dtype },
        },
        [B.pos.buffer, B.covA.buffer, B.covB.buffer, B.color.buffer, B.order.buffer],
      );
    } else if (m.type === 'sort') {
      let out = new Float32Array(m.buf);
      if (!current || current.id !== m.id) {
        postMessage({ type: 'sorted', id: m.id, count: -1, buf: out.buffer }, [out.buffer]);
        return;
      }
      if (out.length < current.N) out = new Float32Array(current.N);
      const count = sortInto(current.xyz, current.N, m.cam, m.dir, out);
      postMessage({ type: 'sorted', id: m.id, count, buf: out.buffer }, [out.buffer]);
    }
  } catch (err) {
    console.error('[recon]', err);
    postMessage({ type: 'error', stage: m.type, id: m.id, message: String(err?.message ?? err) });
  }
};
