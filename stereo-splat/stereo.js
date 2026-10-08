// stereo.js — a rectified side-by-side pair in, a Gaussian splat table out.
//
// Pure: typed arrays in, typed arrays out. No DOM, so it runs in the worker (stereo-worker.js)
// and under Node for tests.
//
//   1. disparity: 7×7 census → Hamming cost volume → semi-global aggregation (4 paths) →
//      winner-takes-all with a sub-pixel parabola → left/right consistency → hole fill
//      (occlusions take the background side) → 3×3 median.
//   2. splats: every pixel of the left eye becomes one Gaussian, back-projected through the
//      pinhole Z = f·B / d in OpenCV camera space (+x right, +y down, +z forward) — the frame the
//      .sog `camera` block declares, so the DisplayXR viewer reopens it at the capture camera.

const C0 = 0.28209479177387814; // SH band-0 basis: colour = 0.5 + C0 · f_dc

/** RGBA bytes → luma bytes. */
export function toGray(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return g;
}

/** 7×7 census, split in two 24-bit words (rows 0–3 minus centre / rows 3–6). */
function census(g, w, h) {
  const a = new Uint32Array(w * h);
  const b = new Uint32Array(w * h);
  for (let y = 3; y < h - 3; y++) {
    for (let x = 3; x < w - 3; x++) {
      const c = g[y * w + x];
      let lo = 0;
      let hi = 0;
      let n = 0;
      for (let dy = -3; dy <= 3; dy++) {
        const row = (y + dy) * w + x;
        for (let dx = -3; dx <= 3; dx++) {
          if (dy === 0 && dx === 0) continue;
          const bit = g[row + dx] < c ? 1 : 0;
          if (n < 24) lo = (lo << 1) | bit;
          else hi = (hi << 1) | bit;
          n++;
        }
      }
      a[y * w + x] = lo;
      b[y * w + x] = hi;
    }
  }
  return [a, b];
}

function popcnt(v) {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Disparity of the LEFT eye, in pixels (left x − right x), NaN where unknown.
 *
 * Two independent semi-global passes — left-referenced, and right-referenced (the same pass on
 * both eyes mirrored and swapped) — then a left/right consistency check. The right pass has to
 * be its own: read off the left volume, a wrong match in an occlusion confirms itself.
 *
 * @param {Uint8Array} gl  left luma, w×h
 * @param {Uint8Array} gr  right luma, w×h
 * @param {{ minD?: number, maxD?: number, P1?: number, P2?: number, onProgress?: (f: number) => void }} [o]
 */
export function computeDisparity(gl, gr, w, h, o = {}) {
  const cfg = { minD: o.minD ?? -8, maxD: o.maxD ?? 96, P1: o.P1 ?? 7, P2: o.P2 ?? 60 };
  const progress = o.onProgress ?? (() => {});
  const dispL = sgm(gl, gr, w, h, cfg, (f) => progress(f * 0.45));
  const dispRf = sgm(flipX(gr, w, h), flipX(gl, w, h), w, h, cfg, (f) => progress(0.45 + f * 0.45));

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const d = dispL[row + x];
      if (Number.isNaN(d)) continue;
      const xr = Math.round(x - d);
      // right pixel xr is mirrored pixel (w − 1 − xr) of the right-referenced pass
      if (xr < 0 || xr >= w || !(Math.abs(dispRf[row + w - 1 - xr] - d) <= 1)) dispL[row + x] = NaN;
    }
  }
  progress(0.92);
  fillHoles(dispL, w, h);
  const out = median3(dispL, w, h);
  progress(1);
  return out;
}

function flipX(g, w, h) {
  const o = new Uint8Array(g.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) o[row + x] = g[row + w - 1 - x];
  }
  return o;
}

/** One semi-global pass referenced to `gl`: WTA disparity with sub-pixel, NaN where ambiguous. */
function sgm(gl, gr, w, h, { minD, maxD, P1, P2 }, progress) {
  const nd = maxD - minD + 1;
  const N = w * h;
  const BAD = 48;

  // ── matching cost C(p, d) ────────────────────────────────────────────────────────────────
  const [la, lb] = census(gl, w, h);
  const [ra, rb] = census(gr, w, h);
  const C = new Uint8Array(N * nd);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const base = p * nd;
      const border = y < 3 || y >= h - 3 || x < 3 || x >= w - 3;
      for (let k = 0; k < nd; k++) {
        const xr = x - (k + minD);
        if (border || xr < 3 || xr >= w - 3) {
          C[base + k] = BAD;
          continue;
        }
        const q = p - (k + minD);
        C[base + k] = popcnt(la[p] ^ ra[q]) + popcnt(lb[p] ^ rb[q]);
      }
    }
  }
  progress(0.2);

  // ── aggregation, 4 paths ────────────────────────────────────────────────────────────────
  const S = new Uint16Array(N * nd);
  const prev = new Uint16Array(nd);
  const cur = new Uint16Array(nd);
  // One path: walk `len` pixels from `start` by `step`, carrying L(p−r, ·).
  const walk = (start, step, len) => {
    let p = start;
    let base = p * nd;
    let prevMin = 65535;
    for (let k = 0; k < nd; k++) {
      prev[k] = C[base + k];
      S[base + k] += prev[k];
      if (prev[k] < prevMin) prevMin = prev[k];
    }
    for (let i = 1; i < len; i++) {
      p += step;
      base = p * nd;
      let curMin = 65535;
      const jump = prevMin + P2;
      for (let k = 0; k < nd; k++) {
        let best = prev[k];
        if (k > 0 && prev[k - 1] + P1 < best) best = prev[k - 1] + P1;
        if (k < nd - 1 && prev[k + 1] + P1 < best) best = prev[k + 1] + P1;
        if (jump < best) best = jump;
        const v = C[base + k] + best - prevMin;
        cur[k] = v;
        S[base + k] += v;
        if (v < curMin) curMin = v;
      }
      prev.set(cur);
      prevMin = curMin;
    }
  };
  for (let y = 0; y < h; y++) walk(y * w, 1, w);
  progress(0.35);
  for (let y = 0; y < h; y++) walk(y * w + w - 1, -1, w);
  progress(0.5);
  for (let x = 0; x < w; x++) walk(x, w, h);
  progress(0.65);
  for (let x = 0; x < w; x++) walk((h - 1) * w + x, -w, h);
  progress(0.8);

  // ── winner-takes-all + sub-pixel + uniqueness ───────────────────────────────────────────
  const disp = new Float32Array(N).fill(NaN);
  for (let p = 0; p < N; p++) {
    const base = p * nd;
    let bk = 0;
    let bv = 65535;
    for (let k = 0; k < nd; k++) {
      if (S[base + k] < bv) {
        bv = S[base + k];
        bk = k;
      }
    }
    // uniqueness: the runner-up away from the winner's neighbourhood must be clearly worse
    let second = 65535;
    for (let k = 0; k < nd; k++) {
      if (Math.abs(k - bk) > 1 && S[base + k] < second) second = S[base + k];
    }
    if (second * 0.95 < bv) continue;
    let d = bk;
    if (bk > 0 && bk < nd - 1) {
      const a = S[base + bk - 1];
      const c = S[base + bk + 1];
      const den = a - 2 * bv + c;
      if (den > 0) d += (a - c) / (2 * den);
    }
    disp[p] = d + minD;
  }
  progress(1);
  return disp;
}

/** Occlusions belong to the FARTHER surface: fill each run with its smaller-disparity side. */
function fillHoles(d, w, h) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      if (!Number.isNaN(d[row + x])) {
        x++;
        continue;
      }
      const s = x;
      while (x < w && Number.isNaN(d[row + x])) x++;
      const left = s > 0 ? d[row + s - 1] : NaN;
      const right = x < w ? d[row + x] : NaN;
      const v = Number.isNaN(left) ? right : Number.isNaN(right) ? left : Math.min(left, right);
      if (!Number.isNaN(v)) for (let i = s; i < x; i++) d[row + i] = v;
    }
  }
  // rows that had nothing valid: copy from the nearest valid row
  for (let y = 1; y < h; y++) {
    for (let x = 0; x < w; x++) if (Number.isNaN(d[y * w + x])) d[y * w + x] = d[(y - 1) * w + x];
  }
  for (let y = h - 2; y >= 0; y--) {
    for (let x = 0; x < w; x++) if (Number.isNaN(d[y * w + x])) d[y * w + x] = d[(y + 1) * w + x];
  }
}

function median3(d, w, h) {
  const out = new Float32Array(d.length);
  const v = new Float32Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const s = d[yy * w + xx];
          if (!Number.isNaN(s)) v[n++] = s;
        }
      }
      out[y * w + x] = n ? v.subarray(0, n).sort()[n >> 1] : NaN;
    }
  }
  return out;
}

/**
 * Back-project the left eye into Gaussians.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba  left eye, w×h RGBA
 * @param {Float32Array} disp  left disparity at the same size
 * @param {{ fx: number, baselineM: number, subjectZ?: number | null }} cam
 *        fx in THIS image's pixels; subjectZ (m) caps the background at a comfortable depth
 * @returns {{ columns: Record<string, Float32Array>, count: number, depth: { near: number, far: number, median: number } }}
 */
export function buildSplats(rgba, disp, w, h, cam) {
  const { fx, baselineM } = cam;
  const cx = w / 2;
  const cy = h / 2;
  const N = w * h;

  // depth per pixel; a disparity at or below 0.5 px is "far" and lands on the back plane
  const Z = new Float32Array(N);
  const finite = [];
  for (let p = 0; p < N; p++) {
    const d = disp[p];
    if (d > 0.5) {
      Z[p] = (fx * baselineM) / d;
      finite.push(Z[p]);
    } else Z[p] = Infinity;
  }
  finite.sort((a, b) => a - b);
  const pct = (f) => (finite.length ? finite[Math.min(finite.length - 1, Math.floor(f * finite.length))] : 1);
  const near = pct(0.01);
  const median = pct(0.5);
  const subject = cam.subjectZ > 0 ? cam.subjectZ : median;
  const far = Math.min(pct(0.99), subject * 6, (fx * baselineM) / 0.5);
  for (let p = 0; p < N; p++) if (!(Z[p] <= far)) Z[p] = far;

  const cols = {};
  for (const n of ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity']) {
    cols[n] = new Float32Array(N);
  }
  const logit = (a) => Math.log(a / (1 - a));
  const OPAQUE = logit(0.97);
  const EDGE = logit(0.45);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const z = Z[p];
      cols.x[p] = ((x + 0.5 - cx) * z) / fx;
      cols.y[p] = ((y + 0.5 - cy) * z) / fx;
      cols.z[p] = z;

      // one pixel's footprint at this depth; 0.65σ per pixel keeps neighbours overlapping
      const foot = z / fx;
      const sigma = foot * 0.65;
      // a depth step to a neighbour: stretch along z to close the tear, and soften it
      const zr = x < w - 1 ? Z[p + 1] : z;
      const zd = y < h - 1 ? Z[p + w] : z;
      const zl = x > 0 ? Z[p - 1] : z;
      const zu = y > 0 ? Z[p - w] : z;
      const step = Math.max(Math.abs(zr - z), Math.abs(zd - z), Math.abs(zl - z), Math.abs(zu - z));
      const edge = step > z * 0.06;
      const sz = edge ? Math.min(step * 0.5, sigma * 6) : sigma * 0.4;
      cols.scale_0[p] = Math.log(sigma);
      cols.scale_1[p] = Math.log(sigma);
      cols.scale_2[p] = Math.log(Math.max(sz, sigma * 0.2));
      cols.rot_0[p] = 1; // w (PLY order: rot_0 = w)

      const j = p * 4;
      cols.f_dc_0[p] = (rgba[j] / 255 - 0.5) / C0;
      cols.f_dc_1[p] = (rgba[j + 1] / 255 - 0.5) / C0;
      cols.f_dc_2[p] = (rgba[j + 2] / 255 - 0.5) / C0;
      cols.opacity[p] = edge ? EDGE : OPAQUE;
    }
  }
  return { columns: cols, count: N, depth: { near, far, median, subject } };
}
