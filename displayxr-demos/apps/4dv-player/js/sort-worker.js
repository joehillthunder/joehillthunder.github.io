// Sort worker: for a time t and a camera, keep the splats alive at t (temporal weight × opacity
// above the cut) and order them back to front with a 16-bit counting sort. Both eyes share one
// order, sorted from the centre camera; the parallax between eyes is far too small to matter.

const segs = new Map(); // key → { N, posT, velT, alpha }
let depth = new Float32Array(0);
let keys = new Uint32Array(0);
let buckets = new Uint16Array(0);
const counts = new Uint32Array(65536);

const MIN_ALPHA = 1 / 255;
const MIN_TEMPORAL = 0.05; // 4DV's own TEMPORAL_FILTER_MIN_OPACITY
const HALF_LIFE = Math.sqrt(-2 * Math.log(MIN_TEMPORAL)); // |dt|·√(1/σt²) beyond this, w < MIN_TEMPORAL
const BIN = 0.25; // seconds per time bin
const LONG = 1.0; // splats visible longer than this go in the always-scanned list

/**
 * Index splats by when they are visible, so a sort only scans the ones alive near t: long-lived
 * splats in one list, short-lived ones in every BIN-second bin their window touches. Splats never
 * visible inside the segment are dropped.
 */
function buildIndex(seg, duration) {
  const { N, posT, velT, alpha } = seg;
  const t0 = -BIN;
  const nb = Math.ceil((duration + 2 * BIN) / BIN);
  const lo = new Int32Array(N);
  const hi = new Int32Array(N);
  const counts = new Uint32Array(nb + 1);
  let always = 0;
  for (let i = 0; i < N; i++) {
    lo[i] = -1;
    if (alpha[i] < MIN_ALPHA) continue;
    const hw = HALF_LIFE / Math.sqrt(velT[i * 4 + 3]);
    const tm = posT[i * 4 + 3];
    if (tm + hw < t0 || tm - hw > duration + BIN) continue;
    if (2 * hw > LONG) { lo[i] = -2; always++; continue; }
    lo[i] = Math.max(0, Math.floor((tm - hw - t0) / BIN));
    hi[i] = Math.min(nb - 1, Math.floor((tm + hw - t0) / BIN));
    for (let b = lo[i]; b <= hi[i]; b++) counts[b + 1]++;
  }
  for (let b = 0; b < nb; b++) counts[b + 1] += counts[b];
  const bins = new Uint32Array(counts[nb]);
  const fill = counts.slice(0, nb);
  const longList = new Uint32Array(always);
  let a = 0;
  for (let i = 0; i < N; i++) {
    if (lo[i] === -2) longList[a++] = i;
    else if (lo[i] >= 0) for (let b = lo[i]; b <= hi[i]; b++) bins[fill[b]++] = i;
  }
  seg.index = { t0, nb, starts: counts, bins, longList };
}

function sort(seg, t, cam, dir, out) {
  const { posT, velT, alpha } = seg;
  const [cx, cy, cz] = cam;
  const [dx, dy, dz] = dir;
  let n = 0;
  let lo = Infinity, hi = -Infinity;
  const { t0, nb, starts, bins, longList } = seg.index;
  const b = Math.min(nb - 1, Math.max(0, Math.floor((t - t0) / BIN)));
  const visit = (i) => {
    const j = i * 4;
    const dt = t - posT[j + 3];
    const w = Math.exp(-0.5 * dt * dt * velT[j + 3]);
    if (w < MIN_TEMPORAL || w * alpha[i] < MIN_ALPHA) return;
    const d = (posT[j] + velT[j] * dt - cx) * dx + (posT[j + 1] + velT[j + 1] * dt - cy) * dy + (posT[j + 2] + velT[j + 2] * dt - cz) * dz;
    if (d <= 0) return; // behind the camera
    depth[n] = d;
    keys[n] = i;
    n++;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  };
  for (let k = 0; k < longList.length; k++) visit(longList[k]);
  for (let k = starts[b], e = starts[b + 1]; k < e; k++) visit(bins[k]);
  counts.fill(0);
  const scale = hi > lo ? 65535 / (hi - lo) : 0;
  // Far first: bucket = 65535 − quantised depth.
  for (let k = 0; k < n; k++) {
    const b = 65535 - (((depth[k] - lo) * scale) | 0);
    buckets[k] = b;
    counts[b]++;
  }
  let sum = 0;
  for (let b = 0; b < 65536; b++) {
    const c = counts[b];
    counts[b] = sum;
    sum += c;
  }
  for (let k = 0; k < n; k++) out[counts[buckets[k]]++] = keys[k];
  return n;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'segment') {
    const { N, posT, velT, color } = m;
    const alpha = new Float32Array(N);
    for (let i = 0; i < N; i++) alpha[i] = color[i * 4 + 3] / 255;
    const seg = { N, posT, velT, alpha };
    buildIndex(seg, m.duration);
    segs.set(m.key, seg);
    if (depth.length < N) {
      depth = new Float32Array(N);
      keys = new Uint32Array(N);
      buckets = new Uint16Array(N);
    }
  } else if (m.type === 'drop') {
    segs.delete(m.key);
  } else if (m.type === 'clear') {
    segs.clear();
  } else if (m.type === 'sort') {
    const seg = segs.get(m.key);
    if (!seg) {
      self.postMessage({ type: 'sorted', key: m.key, count: -1, buf: m.buf }, [m.buf]);
      return;
    }
    let out = new Float32Array(m.buf);
    if (out.length < seg.N) out = new Float32Array(seg.N);
    const t0 = performance.now();
    const count = sort(seg, m.t, m.cam, m.dir, out);
    self.postMessage({ type: 'sorted', key: m.key, count, ms: performance.now() - t0, buf: out.buffer }, [out.buffer]);
  }
};
