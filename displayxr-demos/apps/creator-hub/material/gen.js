// Material Forge's texture engine. Everything here is tileable and runs on the CPU at N x N:
// generators make a pattern value v in [0, 1] per texel, and the compositor stacks layers into
// base colour, roughness, metalness, height and emission, then bakes normal and AO maps.

const TAU = Math.PI * 2;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a || 1e-6)); return t * t * (3 - 2 * t); };
const fract = (x) => x - Math.floor(x);
const mod = (a, n) => ((a % n) + n) % n;

function hash(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const GX = new Float32Array(256), GY = new Float32Array(256);
for (let i = 0; i < 256; i++) { GX[i] = Math.cos((i / 256) * TAU); GY[i] = Math.sin((i / 256) * TAU); }

/** Periodic gradient noise, roughly in [-0.7, 0.7]; period (px, py) in lattice cells. */
function perlin(x, y, px, py, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const ax = mod(x0, px), bx = mod(x0 + 1, px), ay = mod(y0, py), by = mod(y0 + 1, py);
  const g = (ix, iy, dx, dy) => { const k = (hash(ix, iy, seed) * 256) | 0; return GX[k] * dx + GY[k] * dy; };
  const n00 = g(ax, ay, fx, fy), n10 = g(bx, ay, fx - 1, fy), n01 = g(ax, by, fx, fy - 1), n11 = g(bx, by, fx - 1, fy - 1);
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  return n00 + u * (n10 - n00) + v * (n01 - n00) + u * v * (n00 - n10 - n01 + n11);
}

/** Tileable fBm in about [-1, 1]. (u, v) in [0, 1); sx, sy are integer base frequencies. */
function fbm(u, v, sx, sy, oct, seed, ridged = false) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < oct; o++) {
    let n = perlin(u * sx * f, v * sy * f, sx * f, sy * f, seed + o * 31);
    if (ridged) { n = 1 - Math.abs(n) * 2; n = n * n * 2 - 1; } else n *= 1.4;
    sum += n * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

function normalize(a) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < a.length; i++) { const x = a[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
  const k = hi - lo > 1e-6 ? 1 / (hi - lo) : 0;
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) * k;
  return a;
}

/** Wrapping separable box blur (radius r texels), run `passes` times. */
export function blur(src, N, r, passes = 2) {
  r = Math.max(1, Math.round(r));
  let a = Float32Array.from(src), b = new Float32Array(N * N);
  const inv = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < N; y++) {
      const row = y * N;
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[row + mod(k, N)];
      for (let x = 0; x < N; x++) {
        b[row + x] = s * inv;
        s += a[row + mod(x + r + 1, N)] - a[row + mod(x - r, N)];
      }
    }
    for (let x = 0; x < N; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += b[mod(k, N) * N + x];
      for (let y = 0; y < N; y++) {
        a[y * N + x] = s * inv;
        s += b[mod(y + r + 1, N) * N + x] - b[mod(y - r, N) * N + x];
      }
    }
  }
  return a;
}

// ---------------------------------------------------------------------------------------------
// Generators. Each takes (N, p, seed, layer) and returns { v: Float32Array, rnd?: Float32Array }.
// `p` holds the generator's own parameters (see GENERATORS[...].params).

function warpCoords(u, v, p, seed) {
  if (!p.warp) return [u, v];
  const w = p.warp * 0.08;
  return [u + w * fbm(u, v, 3, 3, 3, seed + 7), v + w * fbm(u, v, 3, 3, 3, seed + 13)];
}

function perTexel(N, fn) {
  const v = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) v[y * N + x] = fn((x + 0.5) / N, (y + 0.5) / N);
  return v;
}

function voronoi(N, s, seed, p, out) {
  const v = new Float32Array(N * N), rnd = new Float32Array(N * N);
  const jit = p.jitter ?? 1;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let [u, w] = warpCoords((x + 0.5) / N, (y + 0.5) / N, p, seed);
    const gx = u * s, gy = w * s, cx = Math.floor(gx), cy = Math.floor(gy);
    let f1 = 9, f2 = 9, id = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const ix = cx + i, iy = cy + j, hx = mod(ix, s), hy = mod(iy, s);
      const px = ix + 0.5 + (hash(hx, hy, seed) - 0.5) * jit, py = iy + 0.5 + (hash(hx, hy, seed + 1) - 0.5) * jit;
      const d = Math.hypot(px - gx, py - gy);
      if (d < f1) { f2 = f1; f1 = d; id = hash(hx, hy, seed + 2); } else if (d < f2) f2 = d;
    }
    const k = y * N + x;
    v[k] = out === 'f1' ? f1 : f2 - f1;
    rnd[k] = id;
  }
  return { v, rnd };
}

function bricksGen(N, p, seed, offset) {
  let rows = Math.max(1, Math.round(p.scale));
  if (offset && rows % 2) rows++;
  const cols = Math.max(1, Math.round(rows / (p.ratio ?? 2)));
  const v = new Float32Array(N * N), rnd = new Float32Array(N * N);
  const m = (p.mortar ?? 0.06) * 0.5, bev = Math.max(0.001, p.bevel ?? 0.1);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x + 0.5) / N, w = (y + 0.5) / N;
    const gy = w * rows, row = Math.floor(gy);
    const gx = u * cols + (offset && row % 2 ? 0.5 : 0), col = Math.floor(gx);
    const fx = gx - col, fy = gy - row;
    // distance to the brick edge, in units of brick height
    const dx = Math.min(fx, 1 - fx) * (rows / cols), dy = Math.min(fy, 1 - fy);
    const e = Math.min(dx, dy);
    const k = y * N + x;
    v[k] = smooth(m, m + bev * 0.5, e);
    rnd[k] = hash(mod(col, cols), row, seed);
  }
  return { v, rnd };
}

function scratchesGen(N, p, seed) {
  const v = new Float32Array(N * N);
  const count = Math.round((p.density ?? 0.5) * 220);
  const len = (p.length ?? 0.3) * N;
  const angle = (p.angle ?? 0) * Math.PI / 180, spread = (p.spread ?? 1) * Math.PI;
  for (let i = 0; i < count; i++) {
    const x0 = hash(i, 1, seed) * N, y0 = hash(i, 2, seed) * N;
    const a = angle + (hash(i, 3, seed) - 0.5) * spread;
    const L = len * (0.3 + hash(i, 4, seed) * 0.7), b = 0.35 + hash(i, 5, seed) * 0.65;
    const steps = Math.ceil(L * 2), dx = Math.cos(a) * 0.5, dy = Math.sin(a) * 0.5;
    const bend = (hash(i, 6, seed) - 0.5) * 0.004;
    let x = x0, y = y0, ddx = dx, ddy = dy;
    for (let t = 0; t < steps; t++) {
      const k = mod(Math.round(y), N) * N + mod(Math.round(x), N);
      const fade = Math.sin((t / steps) * Math.PI);
      v[k] = Math.max(v[k], b * fade);
      const c = Math.cos(bend), s = Math.sin(bend);
      [ddx, ddy] = [ddx * c - ddy * s, ddx * s + ddy * c];
      x += ddx; y += ddy;
    }
  }
  const soft = blur(v, N, 1, 1);
  for (let i = 0; i < v.length; i++) v[i] = clamp01(Math.max(v[i] * 0.8, soft[i] * 1.6));
  return { v };
}

export const GENERATORS = {
  solid: { name: 'Solid fill', params: [] , run: (N) => ({ v: new Float32Array(N * N) }) },
  noise: {
    name: 'Noise (fBm)',
    params: [['scale', 'Scale', 1, 32, 1, 4], ['detail', 'Detail', 1, 8, 1, 5], ['warp', 'Warp', 0, 3, 0.05, 0]],
    run: (N, p, seed) => ({ v: normalize(perTexel(N, (u, v) => { [u, v] = warpCoords(u, v, p, seed); return fbm(u, v, p.scale, p.scale, p.detail, seed); })) }),
  },
  ridged: {
    name: 'Ridged noise',
    params: [['scale', 'Scale', 1, 32, 1, 3], ['detail', 'Detail', 1, 8, 1, 5], ['warp', 'Warp', 0, 3, 0.05, 0.3]],
    run: (N, p, seed) => ({ v: normalize(perTexel(N, (u, v) => { [u, v] = warpCoords(u, v, p, seed); return fbm(u, v, p.scale, p.scale, p.detail, seed, true); })) }),
  },
  grunge: {
    name: 'Grunge',
    params: [['scale', 'Scale', 1, 32, 1, 3], ['detail', 'Detail', 1, 8, 1, 6], ['spots', 'Spots', 0, 1, 0.01, 0.5]],
    run: (N, p, seed) => ({
      v: normalize(perTexel(N, (u, v) => {
        const big = fbm(u, v, p.scale, p.scale, p.detail, seed);
        const fine = fbm(u, v, p.scale * 8, p.scale * 8, 3, seed + 5);
        return smooth(-0.1, 0.5, big) * (0.6 + 0.4 * fine) + p.spots * smooth(0.55, 0.75, fbm(u, v, p.scale * 4, p.scale * 4, 2, seed + 9));
      })),
    }),
  },
  cells: {
    name: 'Cells (Voronoi)',
    params: [['scale', 'Scale', 1, 48, 1, 8], ['jitter', 'Jitter', 0, 1, 0.01, 1], ['warp', 'Warp', 0, 3, 0.05, 0]],
    run: (N, p, seed) => { const r = voronoi(N, p.scale, seed, p, 'f1'); normalize(r.v); return r; },
  },
  crackle: {
    name: 'Crackle',
    params: [['scale', 'Scale', 1, 48, 1, 6], ['width', 'Crack width', 0.01, 0.5, 0.01, 0.08], ['warp', 'Warp', 0, 3, 0.05, 0.4]],
    run: (N, p, seed) => {
      const r = voronoi(N, p.scale, seed, p, 'f2');
      for (let i = 0; i < r.v.length; i++) r.v[i] = smooth(0, p.width, r.v[i]);
      return r;
    },
  },
  bricks: {
    name: 'Bricks',
    params: [['scale', 'Rows', 2, 40, 1, 8], ['ratio', 'Width / height', 1, 8, 0.1, 2.2], ['mortar', 'Mortar', 0, 0.4, 0.01, 0.08], ['bevel', 'Bevel', 0.01, 0.6, 0.01, 0.12]],
    run: (N, p, seed) => bricksGen(N, p, seed, true),
  },
  tiles: {
    name: 'Tiles / panels',
    params: [['scale', 'Rows', 1, 40, 1, 4], ['ratio', 'Width / height', 0.25, 4, 0.05, 1], ['mortar', 'Grout', 0, 0.4, 0.01, 0.04], ['bevel', 'Bevel', 0.01, 0.6, 0.01, 0.06]],
    run: (N, p, seed) => bricksGen(N, p, seed, false),
  },
  checker: {
    name: 'Checker',
    params: [['scale', 'Squares', 1, 32, 1, 8]],
    run: (N, p) => ({ v: perTexel(N, (u, v) => ((Math.floor(u * p.scale) + Math.floor(v * p.scale)) & 1)) }),
  },
  dots: {
    name: 'Dots / rivets',
    params: [['scale', 'Per row', 1, 48, 1, 12], ['radius', 'Radius', 0.05, 0.5, 0.01, 0.18], ['stagger', 'Stagger', 0, 1, 1, 0]],
    run: (N, p) => ({
      v: perTexel(N, (u, v) => {
        const gy = v * p.scale, row = Math.floor(gy);
        const gx = u * p.scale + (p.stagger && row % 2 ? 0.5 : 0);
        const d = Math.hypot(fract(gx) - 0.5, fract(gy) - 0.5) / p.radius;
        return d < 1 ? Math.sqrt(1 - d * d) : 0;
      }),
    }),
  },
  wood: {
    name: 'Wood grain',
    params: [['scale', 'Rings', 1, 40, 1, 10], ['warp', 'Figure', 0, 3, 0.05, 1], ['grain', 'Fine grain', 0, 1, 0.01, 0.4]],
    run: (N, p, seed) => ({
      v: normalize(perTexel(N, (u, v) => {
        const t = v * p.scale + p.warp * 0.6 * fbm(u, v, 2, 3, 4, seed);
        const ring = Math.pow(0.5 + 0.5 * Math.sin(t * TAU), 3);
        const fine = fbm(u, v, 48, 2, 2, seed + 3);
        return ring * (1 - p.grain * 0.5) + p.grain * 0.5 * (0.5 + 0.5 * fine);
      })),
    }),
  },
  marble: {
    name: 'Marble',
    params: [['scale', 'Veins', 1, 12, 1, 2], ['warp', 'Turbulence', 0, 4, 0.05, 2], ['sharp', 'Vein sharpness', 1, 12, 0.5, 5]],
    run: (N, p, seed) => ({
      v: perTexel(N, (u, v) => {
        const t = (u + v) * p.scale + p.warp * 0.5 * fbm(u, v, 3, 3, 6, seed);
        return 1 - Math.pow(Math.abs(Math.sin(t * Math.PI)), 1 / p.sharp);
      }),
    }),
  },
  weave: {
    name: 'Weave / carbon',
    params: [['scale', 'Threads', 4, 96, 2, 32]],
    run: (N, p) => ({
      v: perTexel(N, (u, v) => {
        const gx = u * p.scale, gy = v * p.scale, cx = Math.floor(gx), cy = Math.floor(gy);
        const horiz = mod(cx + cy, 4) < 2;
        const f = horiz ? fract(gy) : fract(gx), along = horiz ? fract((gx + mod(cy, 2)) / 2) : fract((gy + mod(cx, 2)) / 2);
        return Math.sin(f * Math.PI) * (0.55 + 0.45 * Math.sin(along * Math.PI)) * (horiz ? 1 : 0.8);
      }),
    }),
  },
  scratches: {
    name: 'Scratches',
    params: [['density', 'Density', 0, 1, 0.01, 0.5], ['length', 'Length', 0.02, 1, 0.01, 0.25], ['angle', 'Angle', 0, 180, 1, 0], ['spread', 'Spread', 0, 1, 0.01, 1]],
    run: scratchesGen,
  },
  gradient: {
    name: 'Gradient',
    params: [['dir', 'Direction (0 = up)', 0, 1, 1, 0]],
    run: (N, p) => ({ v: perTexel(N, (u, v) => (p.dir ? u : 1 - v)) }),
  },
  image: { name: 'Image (photo)', params: [['tile', 'Make tileable', 0, 1, 1, 1], ['detail', 'Height detail', 1, 64, 1, 16]], run: imageGen },
};

/** A layer's image source re-sampled to N x N: RGB (sRGB 0..1) + luminance. */
function rasterImage(src, N, tile) {
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  // centre-crop to a square
  const s = Math.min(src.width, src.height);
  g.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, N, N);
  const d = g.getImageData(0, 0, N, N).data;
  const rgb = new Float32Array(N * N * 3);
  for (let i = 0; i < N * N; i++) { rgb[i * 3] = d[i * 4] / 255; rgb[i * 3 + 1] = d[i * 4 + 1] / 255; rgb[i * 3 + 2] = d[i * 4 + 2] / 255; }
  if (!tile) return rgb;
  // Cross-fade with a half-offset copy near the edges so the result wraps seamlessly.
  const out = new Float32Array(rgb.length), h = N / 2;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const ex = Math.min(x, N - 1 - x) / h, ey = Math.min(y, N - 1 - y) / h;
    const w = 1 - smooth(0, 0.55, Math.min(ex, ey));
    const k = (y * N + x) * 3, k2 = (mod(y + h, N) * N + mod(x + h, N)) * 3;
    for (let c = 0; c < 3; c++) out[k + c] = rgb[k + c] * (1 - w) + rgb[k2 + c] * w;
  }
  return out;
}

function imageGen(N, p, seed, layer) {
  if (!layer.src) return { v: new Float32Array(N * N) };
  const rgb = rasterImage(layer.src, N, !!p.tile);
  const lum = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) lum[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
  // High-pass the luminance so big lighting gradients in the photo do not become slopes.
  const low = blur(lum, N, Math.max(2, (N / 512) * p.detail), 2);
  const v = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) v[i] = lum[i] - low[i];
  normalize(v);
  return { v, rgb };
}

// ---------------------------------------------------------------------------------------------
// Layers

let nextId = 1;
export function makeLayer(gen = 'noise', over = {}) {
  const p = {};
  for (const [k, , , , , def] of GENERATORS[gen].params) p[k] = def;
  return {
    id: nextId++,
    name: GENERATORS[gen].name,
    gen,
    p: { ...p, ...(over.p || {}) },
    seed: 1,
    invert: false,
    visible: true,
    colorA: '#7d7f84',
    colorB: '#c9cbd0',
    vary: 0,
    roughA: 0.5, roughB: 0.5,
    metalA: 0, metalB: 0,
    height: 0,
    heightMode: 'add',
    emissive: 0,
    blend: 'normal',
    opacity: 1,
    ch: { color: true, rough: true, metal: true, height: true },
    mask: 'none',
    cover: 0.5,
    edge: 0.1,
    maskScale: 4,
    maskInvert: false,
    paint: null,
    src: null,
    ...over,
    ...(over.p ? { p: { ...p, ...over.p } } : {}),
  };
}

export function cloneLayer(l) {
  return { ...structuredClone({ ...l, src: null, paint: null }), id: nextId++, src: l.src, paint: l.paint ? Float32Array.from(l.paint) : null, ch: { ...l.ch } };
}

const hex3 = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

// ---------------------------------------------------------------------------------------------
// Compositing

export class Compositor {
  constructor(N = 512) {
    this.cache = new Map();
    this.setSize(N);
  }

  setSize(N) {
    this.N = N;
    this.cache.clear();
    const mk = () => { const c = document.createElement('canvas'); c.width = c.height = N; return c; };
    this.canvases ??= {};
    for (const k of ['base', 'normal', 'orm', 'height', 'emissive']) {
      const c = this.canvases[k] ?? mk();
      c.width = c.height = N;
      this.canvases[k] = c;
    }
  }

  pattern(layer) {
    const key = JSON.stringify([layer.gen, layer.p, layer.seed, this.N, layer.gen === 'image' ? layer.srcId : 0]);
    let hit = this.cache.get(layer.id);
    if (!hit || hit.key !== key) {
      hit = { key, out: GENERATORS[layer.gen].run(this.N, layer.p, layer.seed, layer) };
      this.cache.set(layer.id, hit);
    }
    return hit.out;
  }

  maskNoise(layer) {
    const key = 'm' + JSON.stringify([layer.maskScale, layer.seed, this.N]);
    let hit = this.cache.get('m' + layer.id);
    if (!hit || hit.key !== key) {
      const s = Math.max(1, Math.round(layer.maskScale));
      hit = { key, out: normalize(perTexel(this.N, (u, v) => fbm(u, v, s, s, 6, layer.seed + 101))) };
      this.cache.set('m' + layer.id, hit);
    }
    return hit.out;
  }

  /** Stack the layers (bottom first) and write every output canvas. Returns the raw channels. */
  composite(layers, settings) {
    const N = this.N, T = N * N;
    const col = new Float32Array(T * 3).fill(0.5), rough = new Float32Array(T).fill(0.5), metal = new Float32Array(T);
    const height = new Float32Array(T), emis = new Float32Array(T * 3);
    for (const L of layers) {
      if (!L.visible || L.opacity <= 0) continue;
      const pat = this.pattern(L);
      const pv = pat.v, rnd = pat.rnd, rgb = pat.rgb;
      const A = hex3(L.colorA), B = hex3(L.colorB);
      let maskSrc = null, curv = null;
      if (L.mask === 'noise') maskSrc = this.maskNoise(L);
      if (L.mask === 'cavity' || L.mask === 'peaks') {
        const b = blur(height, N, Math.max(2, N / 96), 2);
        curv = new Float32Array(T);
        let m = 1e-6;
        for (let i = 0; i < T; i++) { curv[i] = height[i] - b[i]; m = Math.max(m, Math.abs(curv[i])); }
        for (let i = 0; i < T; i++) curv[i] = 0.5 + 0.5 * (curv[i] / m) * (L.mask === 'cavity' ? -1 : 1);
      }
      const t = 1 - L.cover, e = Math.max(0.005, L.edge);
      for (let i = 0; i < T; i++) {
        let v = pv[i];
        if (L.invert) v = 1 - v;
        let a;
        switch (L.mask) {
          case 'self': a = smooth(t - e, t + e, v); break;
          case 'noise': a = smooth(t - e, t + e, maskSrc[i]); break;
          case 'cavity': case 'peaks': a = smooth(t - e, t + e, curv[i]); break;
          case 'paint': a = L.paint ? L.paint[i] : 0; break;
          default: a = 1;
        }
        if (L.maskInvert && L.mask !== 'none') a = 1 - a;
        a *= L.opacity;
        if (a <= 0) continue;
        const j = i * 3;
        let r, g, b;
        if (rgb) { r = rgb[j]; g = rgb[j + 1]; b = rgb[j + 2]; const k = 0.5 + 0.5 * (A[0] + A[1] + A[2]) / 3; if (L.tint) { r *= A[0] / k; g *= A[1] / k; b *= A[2] / k; } }
        else { r = A[0] + (B[0] - A[0]) * v; g = A[1] + (B[1] - A[1]) * v; b = A[2] + (B[2] - A[2]) * v; }
        if (L.vary && rnd) { const k = 1 + (rnd[i] - 0.5) * L.vary; r *= k; g *= k; b *= k; }
        if (L.ch.color) {
          const cr = col[j], cg = col[j + 1], cb = col[j + 2];
          let br = r, bg = g, bb = b;
          switch (L.blend) {
            case 'multiply': br = cr * r; bg = cg * g; bb = cb * b; break;
            case 'screen': br = 1 - (1 - cr) * (1 - r); bg = 1 - (1 - cg) * (1 - g); bb = 1 - (1 - cb) * (1 - b); break;
            case 'overlay':
              br = cr < 0.5 ? 2 * cr * r : 1 - 2 * (1 - cr) * (1 - r);
              bg = cg < 0.5 ? 2 * cg * g : 1 - 2 * (1 - cg) * (1 - g);
              bb = cb < 0.5 ? 2 * cb * b : 1 - 2 * (1 - cb) * (1 - b);
              break;
            case 'add': br = cr + r; bg = cg + g; bb = cb + b; break;
          }
          col[j] = cr + (br - cr) * a; col[j + 1] = cg + (bg - cg) * a; col[j + 2] = cb + (bb - cb) * a;
          const em = L.emissive;
          emis[j] = emis[j] * (1 - a) + r * em * a; emis[j + 1] = emis[j + 1] * (1 - a) + g * em * a; emis[j + 2] = emis[j + 2] * (1 - a) + b * em * a;
        }
        if (L.ch.rough) rough[i] += (L.roughA + (L.roughB - L.roughA) * v - rough[i]) * a;
        if (L.ch.metal) metal[i] += (L.metalA + (L.metalB - L.metalA) * v - metal[i]) * a;
        if (L.ch.height && L.height) {
          const hl = v * L.height;
          if (L.heightMode === 'replace') height[i] += (hl - height[i]) * a;
          else if (L.heightMode === 'max') height[i] += (Math.max(height[i], hl) - height[i]) * a;
          else height[i] += hl * a;
        }
      }
    }
    this.write(col, rough, metal, height, emis, settings);
    return { col, rough, metal, height, emis };
  }

  write(col, rough, metal, height, emis, s) {
    const N = this.N, T = N * N;
    const put = (name, fn) => {
      const c = this.canvases[name], g = c.getContext('2d');
      const img = g.createImageData(N, N), d = img.data;
      for (let i = 0; i < T; i++) fn(i, d, i * 4);
      g.putImageData(img, 0, 0);
    };
    const b8 = (x) => (x <= 0 ? 0 : x >= 1 ? 255 : (x * 255 + 0.5) | 0);
    put('base', (i, d, o) => { d[o] = b8(col[i * 3]); d[o + 1] = b8(col[i * 3 + 1]); d[o + 2] = b8(col[i * 3 + 2]); d[o + 3] = 255; });

    // Normal map (OpenGL convention: +Y is up in UV). Canvas rows run top-down, so row+1 is v-down.
    const k = (s.normal ?? 1) * N / 64;
    let hmin = Infinity, hmax = -Infinity, emax = 0;
    for (let i = 0; i < T; i++) { if (height[i] < hmin) hmin = height[i]; if (height[i] > hmax) hmax = height[i]; }
    for (let i = 0; i < T * 3; i++) if (emis[i] > emax) emax = emis[i];
    this.emissiveScale = Math.max(1, emax);
    put('normal', (i, d, o) => {
      const x = i % N, y = (i / N) | 0;
      const dx = (height[y * N + mod(x + 1, N)] - height[y * N + mod(x - 1, N)]) * k;
      const dy = (height[mod(y + 1, N) * N + x] - height[mod(y - 1, N) * N + x]) * k;
      const nx = -dx, ny = dy, inv = 1 / Math.hypot(nx, ny, 1);
      d[o] = b8(nx * inv * 0.5 + 0.5); d[o + 1] = b8(ny * inv * 0.5 + 0.5); d[o + 2] = b8(inv * 0.5 + 0.5); d[o + 3] = 255;
    });
    // AO from how far each texel sits below its blurred neighbourhood.
    const range = Math.max(1e-6, hmax - hmin);
    const wide = blur(height, N, Math.max(2, N / 48), 2);
    const aoK = (s.ao ?? 1) * 2.2 / range;
    put('orm', (i, d, o) => {
      const ao = 1 - Math.max(0, wide[i] - height[i]) * aoK;
      d[o] = b8(ao); d[o + 1] = b8(rough[i]); d[o + 2] = b8(metal[i]); d[o + 3] = 255;
    });
    put('height', (i, d, o) => { const h = b8((height[i] - hmin) / range); d[o] = d[o + 1] = d[o + 2] = h; d[o + 3] = 255; });
    const es = 1 / this.emissiveScale;
    put('emissive', (i, d, o) => { d[o] = b8(emis[i * 3] * es); d[o + 1] = b8(emis[i * 3 + 1] * es); d[o + 2] = b8(emis[i * 3 + 2] * es); d[o + 3] = 255; });
    this.hasEmission = emax > 0.001;
    this.heightRange = range;
  }
}

/** Paint a soft round dab into a layer's paint mask at (u, v). */
export function stamp(layer, N, u, v, { size = 0.04, hardness = 0.5, flow = 0.5, erase = false }) {
  layer.paint ??= new Float32Array(N * N);
  const m = layer.paint, cx = u * N, cy = (1 - v) * N, r = size * N, r2 = r * r;
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r), y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    const d = Math.sqrt(d2) / r;
    const fall = d < hardness ? 1 : 1 - smooth(hardness, 1, d);
    const k = mod(y, N) * N + mod(x, N);
    m[k] = erase ? Math.max(0, m[k] - flow * fall) : Math.min(1, m[k] + flow * fall * (1 - m[k]));
  }
}

/** k-means palette of an image (k colours, as hex strings sorted by luminance). */
export function extractPalette(img, k = 6) {
  const c = document.createElement('canvas'), S = 64;
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, S, S);
  const d = g.getImageData(0, 0, S, S).data, px = [];
  for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
  let cent = Array.from({ length: k }, (_, i) => px[Math.floor(((i + 0.5) / k) * px.length)].slice());
  for (let it = 0; it < 12; it++) {
    const sum = cent.map(() => [0, 0, 0, 0]);
    for (const p of px) {
      let best = 0, bd = Infinity;
      cent.forEach((c, j) => { const dd = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2; if (dd < bd) { bd = dd; best = j; } });
      const s = sum[best]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    }
    cent = sum.map((s, j) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : cent[j]));
  }
  const toHex = (c) => '#' + c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
  return cent.sort((a, b) => (a[0] * 0.3 + a[1] * 0.59 + a[2] * 0.11) - (b[0] * 0.3 + b[1] * 0.59 + b[2] * 0.11)).map(toHex);
}
