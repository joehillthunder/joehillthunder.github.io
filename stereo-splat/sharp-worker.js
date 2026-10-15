// sharp-worker.js — Apple SHARP ("Sharp Monocular View Synthesis in Less Than a Second") in the
// browser: one photo → about 1.2 M Gaussians, with onnxruntime-web on WebGPU.
//
// The ONNX export and its int8 weight pack are sm079's (huggingface.co/sm079/sharp-onnx-webgpu,
// tooling at github.com/sm079/sharp-rig, MIT). The pack loader below follows sharp-rig's
// weightPack.ts. The weights themselves are Apple's, under the Apple Machine Learning Research
// Model License (research use only).
//
// The graph stops before SHARP's NDC → metric unprojection (it needs an SVD, which ONNX cannot
// express). It is done here: positions scale by diag(W/2f, H/2f, 1), and each covariance is
// rebuilt as S·Σ·S and split back into a rotation and three scales (3×3 Jacobi). The result is
// handed back as PLY-space columns (OpenCV camera frame, metres), ready for sog.js.

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
ort.env.wasm.numThreads = 1; // GitHub Pages is not cross-origin isolated; the work is on the GPU anyway

const SHARP_SIZE = 1536; // the graph's square input
const C0 = 0.28209479177387814;
const CACHE_NAME = 'stereo-splat-sharp-v1';
const MAGIC = 'MVSQ8\0\0\0';

let session = null;
const post = (m, transfer = []) => self.postMessage(m, transfer);

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'load') {
      if (!('gpu' in navigator)) throw new Error('SHARP needs WebGPU, and this browser has none');
      const weights = await loadWeightPack(msg.packUrl, (loaded, total, cached) =>
        post({ type: 'progress', stage: `${cached ? 'Loading cached' : 'Downloading'} SHARP weights (${mb(loaded)}${total ? ` / ${mb(total)}` : ''} MB)`, f: total ? loaded / total : null }),
      );
      post({ type: 'progress', stage: 'Compiling SHARP for the GPU', f: null });
      session = await ort.InferenceSession.create(msg.modelUrl, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
        externalData: [{ path: weights.path, data: weights.data }],
      });
      post({ type: 'loaded' });
    } else if (msg.type === 'run') {
      if (!session) throw new Error('SHARP is not loaded');
      post({ type: 'progress', stage: 'Running SHARP on the GPU', f: null });
      const t0 = performance.now();
      const S = SHARP_SIZE;
      const px = msg.pixels;
      const chw = new Float32Array(3 * S * S);
      for (let i = 0; i < S * S; i++) {
        chw[i] = px[i * 4] / 255;
        chw[S * S + i] = px[i * 4 + 1] / 255;
        chw[2 * S * S + i] = px[i * 4 + 2] / 255;
      }
      const out = await session.run({
        image: new ort.Tensor('float32', chw, [1, 3, S, S]),
        disparity_factor: new ort.Tensor('float32', new Float32Array([msg.focalPx / msg.width]), [1]),
      });
      const tRun = performance.now();
      post({ type: 'progress', stage: 'Unprojecting the Gaussians', f: null });
      const g = {
        means: await out.mean_vectors.getData(),
        scales: await out.singular_values.getData(),
        quats: await out.quaternions.getData(),
        colors: await out.colors.getData(),
        opacities: await out.opacities.getData(),
      };
      for (const t of Object.values(out)) t.dispose();
      const { columns, count } = toColumns(g, msg.width / (2 * msg.focalPx), msg.height / (2 * msg.focalPx), msg.minOpacity ?? 0.01);
      post(
        { type: 'result', columns, count, total: g.opacities.length, ms: { run: tRun - t0, unproject: performance.now() - tRun } },
        Object.values(columns).map((a) => a.buffer),
      );
    }
  } catch (err) {
    post({ type: 'error', message: String(err?.message || err) });
  }
};

const mb = (b) => (b / 1e6).toFixed(0);

// ── NDC → metric, as PLY columns ──────────────────────────────────────────────────────────

const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function toColumns(g, sx, sy, minOpacity) {
  const N = g.opacities.length;
  let n = 0;
  for (let i = 0; i < N; i++) if (g.opacities[i] >= minOpacity) n++;
  const names = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity'];
  const c = Object.fromEntries(names.map((k) => [k, new Float32Array(n)]));
  const M = new Float64Array(9);
  const A = new Float64Array(9);
  const V = new Float64Array(9);
  const e = new Float64Array(3);
  const q = new Float64Array(4);
  for (let i = 0, k = 0; i < N; i++) {
    const o = g.opacities[i];
    if (o < minOpacity) continue;
    c.x[k] = g.means[i * 3] * sx;
    c.y[k] = g.means[i * 3 + 1] * sy;
    c.z[k] = g.means[i * 3 + 2];

    // M = diag(sx, sy, 1) · R(q) · diag(s); the metric covariance is M·Mᵀ.
    quatToMat(g.quats[i * 4], g.quats[i * 4 + 1], g.quats[i * 4 + 2], g.quats[i * 4 + 3], M);
    const s0 = g.scales[i * 3], s1 = g.scales[i * 3 + 1], s2 = g.scales[i * 3 + 2];
    for (let r = 0; r < 3; r++) {
      const f = r === 0 ? sx : r === 1 ? sy : 1;
      M[r * 3] *= f * s0;
      M[r * 3 + 1] *= f * s1;
      M[r * 3 + 2] *= f * s2;
    }
    for (let r = 0; r < 3; r++)
      for (let col = r; col < 3; col++)
        A[r * 3 + col] = A[col * 3 + r] = M[r * 3] * M[col * 3] + M[r * 3 + 1] * M[col * 3 + 1] + M[r * 3 + 2] * M[col * 3 + 2];
    eigenSym3(A, e, V);
    matToQuat(V, q);
    c.scale_0[k] = 0.5 * Math.log(Math.max(e[0], 1e-20));
    c.scale_1[k] = 0.5 * Math.log(Math.max(e[1], 1e-20));
    c.scale_2[k] = 0.5 * Math.log(Math.max(e[2], 1e-20));
    c.rot_0[k] = q[0]; // w (PLY order: rot_0 = w)
    c.rot_1[k] = q[1];
    c.rot_2[k] = q[2];
    c.rot_3[k] = q[3];
    c.f_dc_0[k] = (linearToSrgb(Math.min(1, Math.max(0, g.colors[i * 3]))) - 0.5) / C0;
    c.f_dc_1[k] = (linearToSrgb(Math.min(1, Math.max(0, g.colors[i * 3 + 1]))) - 0.5) / C0;
    c.f_dc_2[k] = (linearToSrgb(Math.min(1, Math.max(0, g.colors[i * 3 + 2]))) - 0.5) / C0;
    const oc = Math.min(1 - 1e-6, Math.max(1e-6, o));
    c.opacity[k] = Math.log(oc / (1 - oc));
    k++;
  }
  return { columns: c, count: n };
}

/** Rotation matrix (row-major) of the quaternion (w, x, y, z), normalised. */
function quatToMat(w, x, y, z, m) {
  const l = Math.hypot(w, x, y, z) || 1;
  w /= l; x /= l; y /= l; z /= l;
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y - w * z);     m[2] = 2 * (x * z + w * y);
  m[3] = 2 * (x * y + w * z);     m[4] = 1 - 2 * (x * x + z * z); m[5] = 2 * (y * z - w * x);
  m[6] = 2 * (x * z - w * y);     m[7] = 2 * (y * z + w * x);     m[8] = 1 - 2 * (x * x + y * y);
}

/** Quaternion (w, x, y, z) of a row-major rotation matrix whose COLUMNS are the axes. */
function matToQuat(m, q) {
  const t = m[0] + m[4] + m[8];
  if (t > 0) {
    const s = 0.5 / Math.sqrt(t + 1);
    q[0] = 0.25 / s; q[1] = (m[7] - m[5]) * s; q[2] = (m[2] - m[6]) * s; q[3] = (m[3] - m[1]) * s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[0] - m[4] - m[8]);
    q[0] = (m[7] - m[5]) / s; q[1] = 0.25 * s; q[2] = (m[1] + m[3]) / s; q[3] = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[4] - m[0] - m[8]);
    q[0] = (m[2] - m[6]) / s; q[1] = (m[1] + m[3]) / s; q[2] = 0.25 * s; q[3] = (m[5] + m[7]) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m[8] - m[0] - m[4]);
    q[0] = (m[3] - m[1]) / s; q[1] = (m[2] + m[6]) / s; q[2] = (m[5] + m[7]) / s; q[3] = 0.25 * s;
  }
}

/**
 * Eigen-decomposition of a symmetric 3×3 (row-major `a`, destroyed) by cyclic Jacobi.
 * Eigenvalues → `e`; eigenvectors → the COLUMNS of `v`, a proper rotation (det +1).
 */
function eigenSym3(a, e, v) {
  v.fill(0);
  v[0] = v[4] = v[8] = 1;
  for (let sweep = 0; sweep < 12; sweep++) {
    const off = a[1] * a[1] + a[2] * a[2] + a[5] * a[5];
    if (off < 1e-30 * (a[0] * a[0] + a[4] * a[4] + a[8] * a[8]) || off === 0) break;
    for (let p = 0; p < 2; p++) {
      for (let r = p + 1; r < 3; r++) {
        const apr = a[p * 3 + r];
        if (apr === 0) continue;
        const theta = (a[r * 3 + r] - a[p * 3 + p]) / (2 * apr);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cs = 1 / Math.sqrt(t * t + 1);
        const sn = t * cs;
        // A ← Jᵀ A J, with J the rotation in the (p, r) plane
        for (let k = 0; k < 3; k++) {
          const akp = a[k * 3 + p], akr = a[k * 3 + r];
          a[k * 3 + p] = cs * akp - sn * akr;
          a[k * 3 + r] = sn * akp + cs * akr;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p * 3 + k], ark = a[r * 3 + k];
          a[p * 3 + k] = cs * apk - sn * ark;
          a[r * 3 + k] = sn * apk + cs * ark;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k * 3 + p], vkr = v[k * 3 + r];
          v[k * 3 + p] = cs * vkp - sn * vkr;
          v[k * 3 + r] = sn * vkp + cs * vkr;
        }
      }
    }
  }
  e[0] = a[0]; e[1] = a[4]; e[2] = a[8];
  // Jacobi rotations keep det(V) = +1, so V is already a proper rotation.
}

// ── the int8 weight pack (format: sm079/sharp-rig tools/export_sharp_onnx.py --int8) ─────
//
// SHARP's fp16 external weights stored as int8 + per-output-channel float32 scales, about half
// the download. It is expanded back into the exact bytes of `sharp.onnx.data` as it streams in,
// and the download is kept in Cache Storage so later visits skip it.

async function openStream(url, onProgress) {
  let cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch { /* no Cache Storage: download every time */ }
  let res = cache ? await cache.match(url) : undefined;
  const cached = Boolean(res);
  if (!res) {
    res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Could not download the SHARP weights (${res.status})`);
    if (cache) {
      const [a, b] = res.body.tee();
      cache.put(url, new Response(b, { headers: res.headers })).catch((e) => console.warn('SHARP weights not cached:', e));
      res = new Response(a, { headers: res.headers });
    }
  }
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  let loaded = 0;
  return {
    async read() {
      const r = await reader.read();
      if (r.value) {
        loaded += r.value.byteLength;
        onProgress(loaded, total, cached);
      }
      return r;
    },
  };
}

const q8Size = (c) => {
  const n = c.rows * c.cols;
  return n + ((4 - (n % 4)) % 4) + 4 * (c.axis === 0 ? c.rows : c.cols);
};

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** float32 → float16 bits, round to nearest even (for browsers without Float16Array). */
function toHalfBits(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | ((mant + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  const half = sign | (exp << 10) | (mant >> 13);
  return (mant & 0x1fff) > 0x1000 || ((mant & 0x1fff) === 0x1000 && half & 1) ? half + 1 : half;
}

function dequantize(c, src, out) {
  const n = c.rows * c.cols;
  const q = new Int8Array(src.buffer, src.byteOffset, n);
  const so = src.byteOffset + n + ((4 - (n % 4)) % 4);
  const scales = new Float32Array(src.buffer.slice(so, so + 4 * (c.axis === 0 ? c.rows : c.cols)));
  const F16 = globalThis.Float16Array;
  const dst = F16 ? new F16(out.buffer, out.byteOffset + c.off, n) : new Uint16Array(out.buffer, out.byteOffset + c.off, n);
  const conv = F16 ? (x) => x : toHalfBits;
  for (let r = 0, i = 0; r < c.rows; r++)
    for (let k = 0; k < c.cols; k++, i++) dst[i] = conv(q[i] * scales[c.axis === 0 ? r : k]);
}

async function loadWeightPack(url, onProgress) {
  const stream = await openStream(url, onProgress);
  let parts = [];
  let available = 0;
  let done = false;
  const take = async (n, into) => {
    while (available < n) {
      if (done) throw new Error('The SHARP weight pack is truncated');
      const r = await stream.read();
      if (r.done) done = true;
      else { parts.push(r.value); available += r.value.byteLength; }
    }
    const out = into ?? new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const p = parts[0];
      const k = Math.min(p.byteLength, n - filled);
      out.set(p.subarray(0, k), filled);
      filled += k;
      if (k === p.byteLength) parts.shift();
      else parts[0] = p.subarray(k);
    }
    available -= n;
    return out;
  };

  const prelude = await take(12);
  if (new TextDecoder().decode(prelude.subarray(0, 8)) !== MAGIC) throw new Error('Not a SHARP int8 weight pack');
  const headerLen = new DataView(prelude.buffer).getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(await take(headerLen)));
  await take((16 - ((12 + headerLen) % 16)) % 16);

  const out = new Uint8Array(header.dataLength);
  let scratch = new Uint8Array(0);
  for (const c of header.chunks) {
    if (c.kind === 'raw') {
      await take(c.len, out.subarray(c.off, c.off + c.len));
    } else {
      const size = q8Size(c);
      if (scratch.byteLength < size) scratch = new Uint8Array(size);
      dequantize(c, await take(size, scratch.subarray(0, size)), out);
    }
  }
  parts = [];
  return { path: header.dataFile, data: out };
}
