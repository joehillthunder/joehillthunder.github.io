// textures.js — every texture in the factory, drawn on canvases at startup (no image files).
// Each is made once and cached; callers clone() one to give it its own repeat.

let THREE = null;
const cache = new Map();
export function initTextures(three) { THREE = three; }

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Tileable value noise in [0, 1].
function noise(size, seed, octaves = 5, base = 4) {
  const out = new Float32Array(size * size);
  const r = rng(seed);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const f = base << o;
    const g = new Float32Array(f * f);
    for (let i = 0; i < g.length; i++) g[i] = r();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * f, y0 = Math.floor(fy), y1 = (y0 + 1) % f;
      const ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * f, x0 = Math.floor(fx), x1 = (x0 + 1) % f;
        const tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
        const a = g[y0 * f + x0], b = g[y0 * f + x1], c = g[y1 * f + x0], d = g[y1 * f + x1];
        const top = a + (b - a) * sx, bot = c + (d - c) * sx;
        out[y * size + x] += amp * (top + (bot - top) * sy);
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}
function pixels(w, h, fn) {
  const [c, g] = canvas(w, h);
  const img = g.createImageData(w, h);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const p = fn(x, y, i);
    img.data[i * 4] = p[0];
    img.data[i * 4 + 1] = p[1];
    img.data[i * 4 + 2] = p[2];
    img.data[i * 4 + 3] = p.length > 3 ? p[3] : 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}
function tex(c, color = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const cached = (k, make) => { if (!cache.has(k)) cache.set(k, make()); return cache.get(k); };

// A tangent-space normal map from a height field (wrap-around differences).
function normalFrom(height, S, strength) {
  return tex(pixels(S, S, (x, y) => {
    const h = (xx, yy) => height[((yy + S) % S) * S + ((xx + S) % S)];
    const dx = (h(x + 1, y) - h(x - 1, y)) * strength, dy = (h(x, y + 1) - h(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1);
    return [(-dx / l * 0.5 + 0.5) * 255, (-dy / l * 0.5 + 0.5) * 255, (1 / l * 0.5 + 0.5) * 255];
  }), false);
}

// ---- chocolate ------------------------------------------------------------------------------
// Flowing chocolate: warm brown with ripples; the normal map is what sells the gloss.
export const chocolateFlow = () => cached('flow', () => {
  const S = 256, n = noise(S, 3, 5, 4), m = noise(S, 4, 3, 8);
  const h = new Float32Array(S * S);
  for (let i = 0; i < h.length; i++) h[i] = n[i] * 0.7 + m[i] * 0.3;
  const map = tex(pixels(S, S, (x, y, i) => mix(hex(0x2e140a), hex(0x6b3a1f), h[i] * 1.2)));
  return { map, normal: normalFrom(h, S, 9) };
});

// A chocolate bar seen from above: segments with bevelled grooves (platform tops).
export const chocolateBar = (base = 0x5a2e17) => cached('bar' + base, () => {
  const S = 256, n = noise(S, 7, 4, 8), b = hex(base);
  const seg = 64;
  const h = new Float32Array(S * S);
  const map = tex(pixels(S, S, (x, y, i) => {
    const ex = Math.min(x % seg, seg - (x % seg)), ey = Math.min(y % seg, seg - (y % seg));
    const e = Math.min(ex, ey);
    const bevel = e < 3 ? 0.55 : e < 9 ? 0.75 + (e - 3) * 0.04 : 1;
    h[i] = e < 3 ? 0 : e < 9 ? (e - 3) / 6 : 1;
    const k = bevel * (0.92 + n[i] * 0.14);
    return [b[0] * k, b[1] * k, b[2] * k];
  }));
  return { map, normal: normalFrom(h, S, 3) };
});

// Wafer biscuit: a golden waffle grid.
export const wafer = () => cached('wafer', () => {
  const S = 256, n = noise(S, 11, 4, 8);
  const h = new Float32Array(S * S);
  const map = tex(pixels(S, S, (x, y, i) => {
    const gx = x % 32, gy = y % 32;
    const ridge = gx < 6 || gy < 6;
    h[i] = ridge ? 1 : 0.3;
    return mix(hex(ridge ? 0xd9a35a : 0xb8803d), hex(0xf0c27a), n[i] * 0.4);
  }));
  return { map, normal: normalFrom(h, S, 2.5) };
});

// Fondant / frosting in any pastel, with soft mottling.
export const fondant = (base) => cached('fondant' + base, () => {
  const S = 128, n = noise(S, base & 255, 4, 4), b = hex(base);
  return tex(pixels(S, S, (x, y, i) => { const k = 0.9 + n[i] * 0.18; return [Math.min(255, b[0] * k), Math.min(255, b[1] * k), Math.min(255, b[2] * k)]; }));
});

// Rainbow sprinkles on frosting.
export const sprinkles = (base) => cached('spr' + base, () => {
  const S = 256, r = rng(base);
  const [c, g] = canvas(S);
  g.drawImage(fondant(base).image, 0, 0, S, S);
  const cols = ['#ff5d8f', '#ffd23f', '#3fd2c7', '#8f6bff', '#ffffff', '#6be675'];
  for (let k = 0; k < 420; k++) {
    g.save();
    g.translate(r() * S, r() * S);
    g.rotate(r() * Math.PI);
    g.fillStyle = cols[k % cols.length];
    g.fillRect(-5, -1.5, 10, 3);
    g.restore();
  }
  return tex(c);
});

// ---- candy ----------------------------------------------------------------------------------
export const caneStripe = (a = '#fafafa', b = '#e8344e') => cached('cane' + a + b, () => {
  const [c, g] = canvas(128);
  g.fillStyle = a;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = b;
  for (let k = -128; k < 256; k += 32) {
    g.beginPath(); g.moveTo(k, 0); g.lineTo(k + 14, 0); g.lineTo(k + 14 + 128, 128); g.lineTo(k + 128, 128); g.fill();
  }
  return tex(c);
});

// Lollipop swirl (use on a flat disc).
export const swirl = (cols = ['#ff5d8f', '#fff2f7', '#ffd23f', '#fff2f7', '#3fd2c7', '#fff2f7']) => cached('swirl' + cols.join(), () => {
  const S = 256;
  const [c, g] = canvas(S);
  g.fillStyle = '#fff2f7';
  g.fillRect(0, 0, S, S);
  const arms = cols.filter((x) => x !== '#fff2f7');
  g.lineCap = 'round';
  arms.forEach((col, k) => {
    g.strokeStyle = col;
    g.lineWidth = 16;
    g.beginPath();
    for (let r = 2; r < S * 0.72; r += 2) {
      const t = (k / arms.length) * Math.PI * 2 + r * 0.06;
      const x = S / 2 + Math.cos(t) * r, y = S / 2 + Math.sin(t) * r;
      if (r === 2) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  });
  return tex(c);
});

export const cottonCandy = () => cached('cotton', () => {
  const S = 128, n = noise(S, 21, 5, 4);
  return tex(pixels(S, S, (x, y, i) => mix(hex(0xffc4e1), hex(0xd8c8ff), n[i])));
});

// ---- factory --------------------------------------------------------------------------------
export const brick = () => cached('brick', () => {
  const S = 256, n = noise(S, 31, 5, 8), r = rng(32);
  const tint = [];
  for (let k = 0; k < 64; k++) tint.push(0.8 + r() * 0.35);
  const h = new Float32Array(S * S);
  const map = tex(pixels(S, S, (x, y, i) => {
    const row = Math.floor(y / 32), off = row % 2 ? 32 : 0;
    const bx = Math.floor((x + off) / 64);
    const mortar = y % 32 < 3 || (x + off) % 64 < 3;
    h[i] = mortar ? 0 : 1;
    if (mortar) return mix(hex(0x5c4d44), hex(0x7a6b60), n[i]);
    const k = tint[(row * 5 + bx) % 64] * (0.85 + n[i] * 0.25);
    return [128 * k, 58 * k, 44 * k];
  }));
  return { map, normal: normalFrom(h, S, 2) };
});

export const copper = () => cached('copper', () => {
  const S = 128, n = noise(S, 41, 5, 4), s = noise(S, 42, 2, 16);
  return tex(pixels(S, S, (x, y, i) => {
    const pat = Math.max(0, s[i] - 0.62) * 2.4;                         // verdigris patches
    return mix(mix(hex(0x9a5a2c), hex(0xd99056), n[i]), hex(0x5fa38a), pat);
  }));
});

// Conveyor belt: dark rubber with chevrons; scroll its offset to animate.
export const belt = () => cached('belt', () => {
  const W = 128, H = 128, n = noise(W, 51, 3, 8);
  const [c, g] = canvas(W, H);
  g.drawImage(pixels(W, H, (x, y, i) => { const v = 34 + n[i] * 18; return [v, v, v * 1.05]; }), 0, 0);
  g.strokeStyle = '#4c4f55';
  g.lineWidth = 6;
  for (let x = -32; x < W + 32; x += 32) {
    g.beginPath(); g.moveTo(x, 10); g.lineTo(x + 16, H / 2); g.lineTo(x, H - 10); g.stroke();
  }
  return tex(c);
});

// Polished marble (the plaza and the foyer).
export const marble = () => cached('marble', () => {
  const S = 256, n = noise(S, 61, 6, 2);
  return tex(pixels(S, S, (x, y, i) => {
    const v = Math.abs(Math.sin((x / S) * 8 + n[i] * 9));
    const vein = Math.pow(1 - v, 14);
    return mix(hex(0xf6efe9), hex(0xb79a8a), vein * 0.8 + n[i] * 0.08);
  }));
});

// Warm glowing window panes (sugar glass) for the factory walls.
export const windowGlow = () => cached('win', () => {
  const [c, g] = canvas(128, 256);
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, '#ffe6a8');
  grd.addColorStop(1, '#ff9d5c');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 256);
  g.fillStyle = '#3a2214';
  g.fillRect(60, 0, 8, 256);
  for (let y = 0; y < 256; y += 64) g.fillRect(0, y, 128, 6);
  g.strokeStyle = '#3a2214';
  g.lineWidth = 10;
  g.strokeRect(0, 0, 128, 256);
  return tex(c);
});

// ---- the prize ------------------------------------------------------------------------------
export const goldenTicket = () => cached('ticket', () => {
  const W = 512, H = 256, r = rng(71);
  const [c, g] = canvas(W, H);
  const grd = g.createLinearGradient(0, 0, W, H);
  grd.addColorStop(0, '#b8860b');
  grd.addColorStop(0.35, '#ffe9a3');
  grd.addColorStop(0.5, '#ffd24a');
  grd.addColorStop(0.7, '#fff3c4');
  grd.addColorStop(1, '#c8961e');
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  for (let k = 0; k < 600; k++) { g.fillStyle = `rgba(255,255,255,${r() * 0.25})`; g.fillRect(r() * W, r() * H, 2, 2); }
  g.strokeStyle = '#6b4a00';
  g.lineWidth = 6;
  g.strokeRect(14, 14, W - 28, H - 28);
  g.lineWidth = 2;
  g.strokeRect(26, 26, W - 52, H - 52);
  for (const [x, y] of [[26, 26], [W - 26, 26], [26, H - 26], [W - 26, H - 26]]) {
    g.beginPath(); g.arc(x, y, 14, 0, Math.PI * 2); g.stroke();
  }
  g.fillStyle = '#5a3c00';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 66px Georgia, "Times New Roman", serif';
  g.fillText('GOLDEN TICKET', W / 2, H * 0.44);
  g.font = 'italic 26px Georgia, serif';
  g.fillText('admit one to the Chocolate Fountain', W / 2, H * 0.72);
  return tex(c);
});

// A soft round glow for halos and lantern sprites.
export const glow = () => cached('glow', () => {
  const [c, g] = canvas(128);
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return tex(c);
});

// Wrapper foil for wrapped candies.
export const foil = (a, b) => cached('foil' + a + b, () => {
  const [c, g] = canvas(64);
  g.fillStyle = a;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = b;
  for (let x = 0; x < 64; x += 16) g.fillRect(x, 0, 7, 64);
  return tex(c);
});
