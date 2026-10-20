// Loader worker: opens a .4dv archive and decodes one segment of 4D Gaussians into GPU-ready
// arrays, off the main thread.
//
// The 4dv-sog codec (meta.json "codec": "4dv-sog", version 2), as 4DV.ai's own web viewer decodes it:
//   means      16-bit (means_u << 8 | means_l) per axis, linear in [min, max], then signed exp:
//              x = sign(q) * (exp(|q|) - 1)
//   motion     16-bit, linear: the velocity in units per second
//   time       time_l/u RED = the splat's centre in time (s); BLUE = its log time scale (σt)
//   covar      six 14-bit values, low bytes in covar_0/1 RGB and high 6 bits in covar_2/3 RGB:
//              the upper triangle of L = logm(Σ). Σ = expm(L), via a symmetric eigensolve.
//   sh0        10-bit (sh0_u << 8 | sh0_l): RGB = the DC colour coefficient, A = linear opacity
//   shN        view-dependent colour (spherical harmonics bands 1..3, k = 3/8/15 coefficients): a shared
//              codebook of `count` entries, 64 entries per row of k pixels each, RGB = channel, 10-bit
//              ((u & 3) << 8 | l) / 1023 · 8 − 4; shN_labels R | G << 8 = the splat's codebook entry.
//              (shN_mask/shN_res carry per-splat corrections for ≤ 5% of splats; not applied.)
// At time t a splat sits at mean + motion·(t − time) with opacity × exp(−½ (t − time)² / σt²).

import { Zip } from './zip.js';

const TEX_W = 2048;
const SH_C0 = 0.28209479177387814;
const COV_SCALE = 1e4; // Σ is stored ×1e4 so that small splats survive half-float precision

let zip = null;
let gl = null;

function glContext() {
  if (gl) return gl;
  gl = new OffscreenCanvas(1, 1).getContext('webgl2', { premultipliedAlpha: false });
  if (!gl) throw new Error('WebGL2 is not available in a worker in this browser.');
  return gl;
}

/** Lossless WebP → exact RGBA bytes. A 2D canvas would zero RGB under alpha 0, so go through WebGL. */
async function readImage(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const g = glContext();
  const tex = g.createTexture();
  g.bindTexture(g.TEXTURE_2D, tex);
  g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  g.pixelStorei(g.UNPACK_COLORSPACE_CONVERSION_WEBGL, g.NONE);
  g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, g.RGBA, g.UNSIGNED_BYTE, bmp);
  const fb = g.createFramebuffer();
  g.bindFramebuffer(g.FRAMEBUFFER, fb);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
  const out = new Uint8Array(bmp.width * bmp.height * 4);
  g.readPixels(0, 0, bmp.width, bmp.height, g.RGBA, g.UNSIGNED_BYTE, out);
  g.bindFramebuffer(g.FRAMEBUFFER, null);
  g.deleteFramebuffer(fb);
  g.deleteTexture(tex);
  bmp.close();
  return out;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const s = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 112;
  let m = x & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return s;
    m = (m | 0x800000) >>> (1 - e);
    return s | ((m + 0x1000) >>> 13);
  }
  if (e > 30) return s | 0x7c00;
  return (s | (e << 10)) + ((m + 0x1000) >>> 13);
}

const signedExp = (x) => (x < 0 ? -(Math.exp(-x) - 1) : Math.exp(x) - 1);

// Scratch for the eigensolve: a = symmetric matrix (row-major 3×3), v = eigenvectors (columns).
const A = new Float64Array(9);
const V = new Float64Array(9);
/** Σ = expm(L) for symmetric L, written as [s00 s01 s02 s11 s12 s22] into out at o. */
function expmSym(l0, l1, l2, l3, l4, l5, out, o) {
  A[0] = l0; A[1] = l1; A[2] = l2;
  A[3] = l1; A[4] = l3; A[5] = l4;
  A[6] = l2; A[7] = l4; A[8] = l5;
  V.fill(0); V[0] = V[4] = V[8] = 1;
  for (let sweep = 0; sweep < 8; sweep++) {
    const off = Math.abs(A[1]) + Math.abs(A[2]) + Math.abs(A[5]);
    if (off < 1e-9) break;
    for (let pair = 0; pair < 3; pair++) {
      const p = pair === 2 ? 1 : 0;
      const q = pair === 0 ? 1 : 2;
      const apq = A[p * 3 + q];
      if (Math.abs(apq) < 1e-12) continue;
      const app = A[p * 3 + p], aqq = A[q * 3 + q];
      const tau = (aqq - app) / (2 * apq);
      const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
      const c = 1 / Math.sqrt(1 + t * t), s = t * c;
      for (let k = 0; k < 3; k++) {
        if (k !== p && k !== q) {
          const akp = A[k * 3 + p], akq = A[k * 3 + q];
          const np = c * akp - s * akq, nq = s * akp + c * akq;
          A[k * 3 + p] = A[p * 3 + k] = np;
          A[k * 3 + q] = A[q * 3 + k] = nq;
        }
        const vp = V[k * 3 + p], vq = V[k * 3 + q];
        V[k * 3 + p] = c * vp - s * vq;
        V[k * 3 + q] = s * vp + c * vq;
      }
      A[p * 3 + p] = c * c * app - 2 * c * s * apq + s * s * aqq;
      A[q * 3 + q] = s * s * app + 2 * c * s * apq + c * c * aqq;
      A[p * 3 + q] = A[q * 3 + p] = 0;
    }
  }
  const d0 = Math.exp(A[0]), d1 = Math.exp(A[4]), d2 = Math.exp(A[8]);
  // Σ_ij = Σ_k V_ik d_k V_jk
  const S = (i, j) => V[i * 3] * d0 * V[j * 3] + V[i * 3 + 1] * d1 * V[j * 3 + 1] + V[i * 3 + 2] * d2 * V[j * 3 + 2];
  out[o] = S(0, 0); out[o + 1] = S(0, 1); out[o + 2] = S(0, 2);
  out[o + 3] = S(1, 1); out[o + 4] = S(1, 2); out[o + 5] = S(2, 2);
}

async function open(blob) {
  zip = await new Zip(blob).open();
  let segments, audioPath = null, root;
  if (zip.has('manifest.json')) {
    const man = await zip.json('manifest.json');
    const src = Object.values(man.sources)[0];
    const rep = src.representationOrder?.[0] ?? 'default';
    segments = src.segments.map((s) => ({ start: s.start, duration: s.duration, path: s.paths[rep] + '/' }));
    audioPath = man.audioPath ?? null;
  } else if (zip.has('meta.json')) {
    root = await zip.json('meta.json');
    segments = [{ start: 0, duration: root.duration, path: '' }];
    audioPath = root.audioPath ?? null;
  } else {
    throw new Error('This .4dv file has neither meta.json nor manifest.json.');
  }
  const first = root ?? (await zip.json(segments[0].path + 'meta.json'));
  if (first.codec !== '4dv-sog') throw new Error(`Unsupported 4DV codec "${first.codec}".`);
  const camPath = segments[0].path + (first.cameraPath ?? 'cameras.json');
  const cameras = zip.has(camPath) ? (await zip.json(camPath)).cameras : null;
  let audio = null;
  if (audioPath && zip.has(audioPath)) audio = await zip.blobOf(audioPath, 'audio/wav');
  const last = segments[segments.length - 1];
  return { segments, duration: last.start + last.duration, fps: first.fps ?? 30, cameras, audio };
}

async function decodeSegment(seg, onStage) {
  const meta = await zip.json(seg.path + 'meta.json');
  const N = meta.count;
  const rows = Math.ceil(N / TEX_W);
  const T = TEX_W * rows;
  const img = async (f, label) => {
    onStage(label);
    return readImage(await zip.blobOf(seg.path + f, 'image/webp'));
  };
  const range = (block, c) => [block.mins[c], block.maxs[c] - block.mins[c]];

  const posT = new Float32Array(T * 4); // xyz = mean, w = time centre
  const velT = new Float32Array(T * 4); // xyz = velocity, w = 1/σt²
  const covA = new Uint16Array(T * 4); // half: s00 s01 s02 s11 (×COV_SCALE)
  const covB = new Uint16Array(T * 2); // half: s12 s22
  const color = new Uint8Array(T * 4); // DC colour + opacity, 8-bit (the sort worker and framing read alpha)
  const colorH = new Uint16Array(T * 4); // half: unclamped DC colour + opacity, for the GPU

  // means
  {
    const [ml, mu] = [await img(meta.means.files[0], 'Positions'), await img(meta.means.files[1], 'Positions')];
    const r = [0, 1, 2].map((c) => range(meta.means, c));
    for (let i = 0; i < N; i++) {
      const j = i * 4;
      for (let c = 0; c < 3; c++) posT[j + c] = signedExp(r[c][0] + (((mu[j + c] << 8) | ml[j + c]) / 65535) * r[c][1]);
    }
  }
  // motion
  {
    const [ml, mu] = [await img(meta.motion.files[0], 'Motion'), await img(meta.motion.files[1], 'Motion')];
    const r = [0, 1, 2].map((c) => range(meta.motion, c));
    for (let i = 0; i < N; i++) {
      const j = i * 4;
      for (let c = 0; c < 3; c++) velT[j + c] = r[c][0] + (((mu[j + c] << 8) | ml[j + c]) / 65535) * r[c][1];
    }
  }
  // time + time scale
  {
    const [tl, tu] = [await img(meta.time.files[0], 'Timing'), await img(meta.time.files[1], 'Timing')];
    const [t0, tr] = range(meta.time, 0);
    const [s0, sr] = range(meta.time_scale, 0);
    for (let i = 0; i < N; i++) {
      const j = i * 4;
      posT[j + 3] = t0 + (((tu[j] << 8) | tl[j]) / 65535) * tr;
      const logS = Math.max(s0 + (((tu[j + 2] << 8) | tl[j + 2]) / 65535) * sr, -20);
      velT[j + 3] = Math.exp(-2 * logS);
    }
  }
  // colour + opacity
  {
    const [sl, su] = [await img(meta.sh0.files[0], 'Colour'), await img(meta.sh0.files[1], 'Colour')];
    const r = [0, 1, 2].map((c) => range(meta.sh0, c));
    for (let i = 0; i < N; i++) {
      const j = i * 4;
      for (let c = 0; c < 3; c++) {
        const dc = r[c][0] + (((su[j + c] & 3) << 8 | sl[j + c]) / 1023) * r[c][1];
        const v = 0.5 + SH_C0 * dc;
        color[j + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
        colorH[j + c] = toHalf(v);
      }
      const a = Math.min(1 - 1e-6, Math.max(1e-6, ((su[j + 3] & 3) << 8 | sl[j + 3]) / 1023));
      color[j + 3] = Math.round(a * 255);
      colorH[j + 3] = toHalf(a);
    }
  }
  // covariance
  {
    const f = meta.covar.files;
    const lo0 = await img(f[0], 'Shapes'), lo1 = await img(f[1], 'Shapes');
    const hi0 = await img(f[2], 'Shapes'), hi1 = await img(f[3], 'Shapes');
    onStage('Shapes');
    const r = [0, 1, 2, 3, 4, 5].map((c) => range(meta.covar, c));
    const l = new Float64Array(6);
    const s = new Float64Array(6);
    for (let i = 0; i < N; i++) {
      const j = i * 4;
      for (let c = 0; c < 3; c++) {
        l[c] = r[c][0] + ((((hi0[j + c] & 63) << 8) | lo0[j + c]) / 16383) * r[c][1];
        l[c + 3] = r[c + 3][0] + ((((hi1[j + c] & 63) << 8) | lo1[j + c]) / 16383) * r[c + 3][1];
      }
      expmSym(l[0], l[1], l[2], l[3], l[4], l[5], s, 0);
      covA[j] = toHalf(s[0] * COV_SCALE);
      covA[j + 1] = toHalf(s[1] * COV_SCALE);
      covA[j + 2] = toHalf(s[2] * COV_SCALE);
      covA[j + 3] = toHalf(s[3] * COV_SCALE);
      covB[i * 2] = toHalf(s[4] * COV_SCALE);
      covB[i * 2 + 1] = toHalf(s[5] * COV_SCALE);
    }
  }

  // view-dependent colour: codebook + per-splat labels
  let sh = null;
  if (meta.shN?.files?.length >= 3 && meta.shN.bands >= 1) {
    const k = (meta.shN.bands + 1) ** 2 - 1;
    const [cl, cu, lab] = [
      await img(meta.shN.files[0], 'Lighting'), await img(meta.shN.files[1], 'Lighting'), await img(meta.shN.files[2], 'Lighting'),
    ];
    const entries = meta.shN.count;
    const w = 64 * k;
    const h = Math.ceil(entries / 64);
    if (cl.length < w * h * 4) throw new Error(`shN codebook is ${cl.length / 4} pixels, expected ${w * h}`);
    const book = new Uint16Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      const j = p * 4;
      for (let c = 0; c < 3; c++) book[j + c] = toHalf((((cu[j + c] & 3) << 8) | cl[j + c]) / 1023 * 8 - 4);
    }
    const labels = new Float32Array(T);
    for (let i = 0; i < N; i++) labels[i] = lab[i * 4] | (lab[i * 4 + 1] << 8);
    sh = { k, w, h, book, labels };
  }

  // Samples of solid splats near mid-segment, for framing: all of them, and the dynamic ones (short
  // lived or moving), which are the performers rather than the set around them.
  const mid = seg.duration / 2; // splat times are local to the segment
  const all = [];
  const dyn = [];
  const shortLived = 1 / (seg.duration * 0.25) ** 2; // 1/σt² above this = lives under a quarter of the segment
  const step = Math.max(1, Math.floor(N / 300000));
  for (let i = 0; i < N; i += step) {
    const j = i * 4;
    const dt = mid - posT[j + 3];
    if (color[j + 3] < 128 || Math.exp(-0.5 * dt * dt * velT[j + 3]) < 0.5) continue;
    const p = [posT[j] + velT[j] * dt, posT[j + 1] + velT[j + 1] * dt, posT[j + 2] + velT[j + 2] * dt];
    if (all.length < 180000) all.push(...p);
    const speed2 = velT[j] ** 2 + velT[j + 1] ** 2 + velT[j + 2] ** 2;
    if ((velT[j + 3] > shortLived || speed2 > 0.0025) && dyn.length < 180000) dyn.push(...p);
  }
  const sample = new Float32Array(dyn.length > 6000 ? dyn : all);
  const tr = [meta.time.mins[0], meta.time.maxs[0]];
  return { N, texW: TEX_W, rows, posT, velT, covA, covB, color, colorH, sh, sample, timeRange: tr };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'open') {
      const info = await open(m.blob);
      self.postMessage({ type: 'info', id: m.id, info });
    } else if (m.type === 'segment') {
      const t0 = performance.now();
      const d = await decodeSegment(m.seg, (stage) => self.postMessage({ type: 'stage', id: m.id, stage }));
      d.ms = Math.round(performance.now() - t0);
      self.postMessage({ type: 'segment', id: m.id, index: m.index, data: d }, [
        d.posT.buffer, d.velT.buffer, d.covA.buffer, d.covB.buffer, d.color.buffer, d.colorH.buffer, d.sample.buffer,
        ...(d.sh ? [d.sh.book.buffer, d.sh.labels.buffer] : []),
      ]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: err?.message ?? String(err) });
  }
};
