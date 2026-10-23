// Procedural textures, drawn on canvases at startup. The app ships no image files, so there is
// nothing to add to assets/LICENSES.md. Every texture is made once and cached; a caller that needs
// its own repeat calls tex.clone() (the clone shares the canvas, so it costs nothing).

let THREE = null;
const cache = new Map();

export function initTextures(three) { THREE = three; }

// Deterministic pseudo-random, so the textures look the same every run.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Tileable value noise in [0, 1], summed over octaves.
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

// Fill a canvas pixel by pixel: fn(x, y, i) returns [r, g, b] (0-255) or [r, g, b, a].
function pixels(size, fn) {
  const [c, g] = canvas(size);
  const img = g.createImageData(size, size);
  for (let y = 0, i = 0; y < size; y++) {
    for (let x = 0; x < size; x++, i++) {
      const p = fn(x, y, i);
      img.data[i * 4] = p[0];
      img.data[i * 4 + 1] = p[1];
      img.data[i * 4 + 2] = p[2];
      img.data[i * 4 + 3] = p.length > 3 ? p[3] : 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function tex(c, { color = true, repeat = [1, 1] } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function cached(key, make) {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
}

// ---- ground ------------------------------------------------------------------------------------
// Draw a shape at x, y and at its wrapped copies, so marks that cross an edge still tile.
function wrapped(S, x, y, pad, draw) {
  for (const dx of [0, -S, S]) for (const dy of [0, -S, S]) {
    const px = x + dx, py = y + dy;
    if (px > -pad && px < S + pad && py > -pad && py < S + pad) draw(px, py);
  }
}

// A thin crack: a jittered random walk, drawn wrapped so it tiles.
function crack(g, S, r, x, y, len, width = 1, color = 'rgba(40,40,38,0.6)') {
  let a = r() * Math.PI * 2;
  const pts = [[x, y]];
  for (let k = 0; k < len; k++) {
    a += (r() - 0.5) * 0.9;
    const [px, py] = pts[pts.length - 1];
    pts.push([px + Math.cos(a) * 5, py + Math.sin(a) * 5]);
  }
  g.strokeStyle = color;
  g.lineWidth = width;
  for (const dx of [0, -S, S]) for (const dy of [0, -S, S]) {
    g.beginPath();
    pts.forEach(([px, py], i) => (i ? g.lineTo(px + dx, py + dy) : g.moveTo(px + dx, py + dy)));
    g.stroke();
  }
}

// Grass: clumps of green with dry, sun-bleached patches and individual blades on top.
export const grass = () => cached('grass', () => {
  const S = 512, n = noise(S, 11, 6, 4), d = noise(S, 12, 3, 16), m = noise(S, 14, 4, 32), r = rng(13);
  const dry = hex(0x86794f), green = hex(0x4f6e36), deep = hex(0x34502a), clover = hex(0x3f6b33);
  const [c, g] = canvas(S);
  g.drawImage(pixels(S, (x, y, i) => {
    let col = mix(deep, green, Math.min(1, n[i] * 1.6));
    col = mix(col, dry, Math.max(0, d[i] - 0.52) * 2);
    col = mix(col, clover, Math.max(0, m[i] - 0.68) * 2.5);
    const k = 0.86 + r() * 0.26;
    return [col[0] * k, col[1] * k, col[2] * k];
  }), 0, 0);
  // Blades: short strokes, lighter tips, mostly upright.
  for (let k = 0; k < 14000; k++) {
    const x = r() * S, y = r() * S, len = 2 + r() * 5, a = -Math.PI / 2 + (r() - 0.5) * 1.2;
    const dryBlade = d[(Math.floor(y) % S) * S + (Math.floor(x) % S)] > 0.55 && r() < 0.6;
    const v = 0.75 + r() * 0.5;
    g.strokeStyle = dryBlade ? `rgba(${170 * v},${150 * v},${95 * v},0.55)` : `rgba(${95 * v},${140 * v},${70 * v},0.5)`;
    g.lineWidth = 0.8;
    wrapped(S, x, y, 8, (px, py) => { g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len); g.stroke(); });
  }
  return tex(c);
});

// Soil in the cut face of the base: layered horizons with pebbles and roots.
export const soil = () => cached('soil', () => {
  const S = 256, n = noise(S, 21, 5, 4), r = rng(22);
  const bands = [hex(0x5a4532), hex(0x6e553b), hex(0x4a3a2b), hex(0x7a6045)];
  const [c, g] = canvas(S);
  g.drawImage(pixels(S, (x, y, i) => {
    const b = bands[Math.floor(((y / S) * 4 + n[i] * 0.6) % 4)];
    const k = 0.78 + n[i] * 0.4 + (r() - 0.5) * 0.1;
    return [b[0] * k, b[1] * k, b[2] * k];
  }), 0, 0);
  for (let k = 0; k < 420; k++) {
    const v = 90 + r() * 90, x = r() * S, y = r() * S, rx = 0.8 + r() * 2.4;
    wrapped(S, x, y, 4, (px, py) => {
      g.fillStyle = 'rgba(25,18,12,0.5)';
      g.beginPath(); g.ellipse(px + 0.7, py + 0.7, rx, rx * 0.7, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = `rgb(${v},${v * 0.92},${v * 0.82})`;
      g.beginPath(); g.ellipse(px, py, rx, rx * 0.7, r() * 3, 0, Math.PI * 2); g.fill();
    });
  }
  for (let k = 0; k < 12; k++) crack(g, S, r, r() * S, r() * 40, 8 + r() * 10, 0.7, 'rgba(150,120,80,0.45)');   // roots
  return tex(c);
});

// Substation yard stone: crushed rock with lit tops and shadowed undersides, damp patches,
// a few weeds pushing through.
export const gravel = () => cached('gravel', () => {
  const S = 512, n = noise(S, 31, 4, 8), damp = noise(S, 33, 3, 4), r = rng(32);
  const [c, g] = canvas(S);
  g.drawImage(pixels(S, (x, y, i) => {
    const v = (86 + n[i] * 40) * (1 - Math.max(0, damp[i] - 0.55) * 0.9);
    return [v, v * 1.01, v * 1.03];
  }), 0, 0);
  const tints = [[1, 0.98, 0.95], [1, 1, 1.04], [1.04, 0.97, 0.9], [0.96, 0.98, 1]];
  for (let k = 0; k < 11000; k++) {
    const x = r() * S, y = r() * S, rx = 1 + r() * 2.6, ry = 0.9 + r() * 1.8, rot = r() * 3;
    const wet = damp[(Math.floor(y) % S) * S + (Math.floor(x) % S)] > 0.55 ? 0.72 : 1;
    const v = (70 + r() * 120) * wet, t = tints[Math.floor(r() * 4)];
    wrapped(S, x, y, 5, (px, py) => {
      g.fillStyle = 'rgba(20,20,22,0.55)';                         // contact shadow
      g.beginPath(); g.ellipse(px + 0.9, py + 1.1, rx, ry, rot, 0, Math.PI * 2); g.fill();
      g.fillStyle = `rgb(${v * t[0]},${v * t[1]},${v * t[2]})`;
      g.beginPath(); g.ellipse(px, py, rx, ry, rot, 0, Math.PI * 2); g.fill();
      g.fillStyle = `rgba(255,255,255,${0.12 + r() * 0.12})`;        // lit facet
      g.beginPath(); g.ellipse(px - rx * 0.3, py - ry * 0.35, rx * 0.45, ry * 0.4, rot, 0, Math.PI * 2); g.fill();
    });
  }
  // Weeds: small clusters of green strokes.
  for (let w = 0; w < 26; w++) {
    const cx = r() * S, cy = r() * S;
    for (let k = 0; k < 14; k++) {
      const a = r() * Math.PI * 2, len = 2 + r() * 4, v = 0.7 + r() * 0.4;
      g.strokeStyle = `rgba(${80 * v},${120 * v},${55 * v},0.85)`;
      g.lineWidth = 1;
      wrapped(S, cx, cy, 8, (px, py) => { g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len); g.stroke(); });
    }
  }
  return tex(c);
});

// Cast concrete: aggregate specks, pores, hairline cracks, rain stains and a formed edge.
// `oil` adds the dark, soaked-in stain a transformer leaves on its pad.
function concreteCanvas(seed, oil) {
  const S = 256, n = noise(S, seed, 5, 8), st = noise(S, seed + 1, 3, 4), r = rng(seed + 2);
  const [c, g] = canvas(S);
  g.drawImage(pixels(S, (x, y, i) => {
    let v = 148 + n[i] * 42 + (r() - 0.5) * 16;
    v *= 1 - Math.max(0, st[i] - 0.58) * 0.6;                       // weathering stains
    if (oil) {
      // Oil soaked in around the tank's footprint (the pad's middle is under the tank), patchy.
      const dx = Math.abs(x / S - 0.5), dy = Math.abs(y / S - 0.5);
      const ring = Math.max(0, 0.16 - Math.abs(Math.max(dx * 0.9, dy * 1.3) - 0.27)) / 0.16;
      v *= 1 - ring * (0.25 + st[i] * 0.5) - Math.max(0, st[i] - 0.5) * 0.35;
    }
    return [v, v * 0.995, v * 0.97];
  }), 0, 0);
  for (let k = 0; k < 900; k++) {                                   // aggregate and pores
    const x = r() * S, y = r() * S, dark = r() < 0.45;
    g.fillStyle = dark ? 'rgba(60,58,55,0.45)' : 'rgba(205,200,190,0.35)';
    g.fillRect(x, y, dark ? 1 : 1 + r() * 1.5, dark ? 1 : 1 + r());
  }
  for (let k = 0; k < 4; k++) crack(g, S, r, r() * S, r() * S, 10 + r() * 18, 0.8);
  if (oil) {
    for (let k = 0; k < 9; k++) {                                   // drip marks below the radiators
      const x = S * (0.25 + r() * 0.5), y = S * (r() < 0.5 ? 0.16 + r() * 0.08 : 0.76 + r() * 0.08), rr = 5 + r() * 12;
      const gr = g.createRadialGradient(x, y, 0, x, y, rr);
      gr.addColorStop(0, 'rgba(25,22,18,0.55)');
      gr.addColorStop(1, 'rgba(25,22,18,0)');
      g.fillStyle = gr;
      g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
    }
  }
  g.strokeStyle = 'rgba(70,70,70,0.55)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, S - 2, S - 2);
  return c;
}
export const concrete = () => cached('concrete', () => tex(concreteCanvas(41, false)));
export const oilPad = () => cached('oilpad', () => tex(concreteCanvas(45, true)));

// A road ribbon: u runs along the road, v across it.
export const road = () => cached('road', () => {
  const W = 256, H = 128, n = noise(W, 51, 4, 8), r = rng(52);
  const [c, g] = canvas(W, H);
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, v = 48 + n[(y % W) * W + x] * 22 + r() * 8;
    img.data.set([v, v, v * 1.02, 255], i * 4);
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = '#d8d2b8';
  g.fillRect(0, 6, W, 4);
  g.fillRect(0, H - 10, W, 4);
  g.fillStyle = '#d9b33c';
  g.fillRect(0, H / 2 - 3, W * 0.55, 6);
  return tex(c);
});

export const water = () => cached('water', () => {
  const S = 256, n = noise(S, 61, 5, 4), m = noise(S, 62, 3, 16);
  return tex(pixels(S, (x, y, i) => {
    const t = n[i] * 0.7 + m[i] * 0.3;
    return mix(hex(0x1f3a4c), hex(0x3d6b82), t);
  }));
});

export const crops = () => cached('crops', () => {
  const S = 256, n = noise(S, 71, 4, 4);
  return tex(pixels(S, (x, y, i) => {
    const row = Math.sin((y / S) * Math.PI * 2 * 24) > 0.1;
    const c = row ? mix(hex(0x5d7a3a), hex(0x77904a), n[i]) : mix(hex(0x6b5638), hex(0x7d6747), n[i]);
    return c;
  }));
});

// Treated pole wood: grain along the pole, drying checks (long splits) and the odd knot.
export const wood = () => cached('wood', () => {
  const S = 256, n = noise(S, 81, 4, 4), r = rng(82);
  const [c, g] = canvas(S);
  g.drawImage(pixels(S, (x, y, i) => {
    const grain = 0.5 + 0.5 * Math.sin(x * 0.45 + n[i] * 9);
    const fine = 0.5 + 0.5 * Math.sin(x * 2.3 + n[i] * 4);
    const col = mix(hex(0x4e3a29), hex(0x7a5f45), grain * 0.55 + n[i] * 0.3 + fine * 0.15);
    const k = 0.92 + (r() - 0.5) * 0.08;
    return [col[0] * k, col[1] * k, col[2] * k];
  }), 0, 0);
  for (let k = 0; k < 7; k++) {                                     // checks run along the pole
    const x = r() * S, y = r() * S, len = 40 + r() * 90;
    g.strokeStyle = 'rgba(25,17,10,0.75)';
    g.lineWidth = 0.8 + r() * 1.2;
    for (const dy of [0, -S, S]) {
      g.beginPath(); g.moveTo(x, y + dy);
      g.bezierCurveTo(x + (r() - 0.5) * 6, y + dy + len * 0.33, x + (r() - 0.5) * 6, y + dy + len * 0.66, x + (r() - 0.5) * 4, y + dy + len);
      g.stroke();
    }
  }
  for (let k = 0; k < 3; k++) {                                     // knots
    const x = r() * S, y = r() * S;
    wrapped(S, x, y, 10, (px, py) => {
      const gr = g.createRadialGradient(px, py, 0, px, py, 7);
      gr.addColorStop(0, 'rgba(40,26,15,0.9)');
      gr.addColorStop(1, 'rgba(60,40,25,0)');
      g.fillStyle = gr;
      g.beginPath(); g.ellipse(px, py, 4, 7, 0, 0, Math.PI * 2); g.fill();
    });
  }
  return tex(c);
});

// ---- metal ------------------------------------------------------------------------------------
// Painted steel with weathering (transformer tanks, cabinets, switchgear): rain streaks, grime
// that thickens toward the bottom, chipped paint and rust weeping from the chips.
export const paint = (base = 0x8d969d) => cached('paint' + base, () => {
  const S = 256, n = noise(S, 91, 5, 4), s = noise(S, 92, 3, 32), r = rng(93), b = hex(base);
  const [c, g] = canvas(S);
  g.drawImage(pixels(S, (x, y, i) => {
    const streak = Math.max(0, s[(Math.floor(y / 6) * S + x) % (S * S)] - 0.6) * 0.5;
    const edge = Math.max(0, 1 - Math.min(x, S - 1 - x, y, S - 1 - y) / 16);   // grime in seams and corners
    const k = 0.9 + n[i] * 0.16 - streak - Math.pow(y / S, 2.5) * 0.3 - edge * edge * 0.22;
    return [b[0] * k, b[1] * k, b[2] * k];
  }), 0, 0);
  for (let k = 0; k < 30; k++) {
    const x = r() * S, y = r() * S * 0.85, len = 16 + r() * 70;
    const gr = g.createLinearGradient(x, y, x, y + len);
    gr.addColorStop(0, 'rgba(125,68,30,0.55)');
    gr.addColorStop(0.4, 'rgba(110,65,35,0.3)');
    gr.addColorStop(1, 'rgba(110,65,35,0)');
    g.fillStyle = gr;
    g.fillRect(x - 1.2, y, 2.4 + r() * 1.5, len);                   // rust run
    g.fillStyle = 'rgba(70,50,40,0.6)';
    g.fillRect(x - 1.2, y - 1, 2.4, 2);                             // the chip it runs from
  }
  for (let k = 0; k < 140; k++) {                                   // small scratches and chips
    g.fillStyle = r() < 0.5 ? 'rgba(40,40,40,0.35)' : 'rgba(230,232,235,0.25)';
    g.fillRect(r() * S, r() * S, 1 + r() * 3, 1);
  }
  return tex(c);
});

// Vertical corrugation (shipping-container walls, radiator fins). Returns {map, bump}.
export const corrugated = (base = 0xd6dadc) => cached('corr' + base, () => {
  const S = 256, n = noise(S, 101, 4, 8), b = hex(base);
  const shade = (x) => 0.5 + 0.5 * Math.sin((x / S) * Math.PI * 2 * 16);
  const map = tex(pixels(S, (x, y, i) => {
    const k = 0.82 + shade(x) * 0.22 + n[i] * 0.08 - (y > S * 0.94 ? 0.15 : 0);
    return [b[0] * k, b[1] * k, b[2] * k];
  }));
  const bump = tex(pixels(S, (x) => { const v = shade(x) * 255; return [v, v, v]; }), { color: false });
  return { map, bump };
});

// Hot-dip galvanized steel: the crystalline "spangle" of the zinc coat, dull white-rust bloom,
// and the odd rust stain where the coat is worn through.
export const galvanized = () => cached('galv', () => {
  const S = 256, n = noise(S, 111, 5, 8), w = noise(S, 113, 3, 4), r = rng(112);
  const [c, g] = canvas(S);
  g.drawImage(pixels(S, (x, y, i) => {
    const v = 148 + n[i] * 56 + r() * 12 + Math.max(0, w[i] - 0.6) * 60;
    return [v, v * 1.01, v * 1.03];
  }), 0, 0);
  for (let k = 0; k < 520; k++) {                                   // spangle flakes
    const x = r() * S, y = r() * S, rad = 2 + r() * 6, sides = 5 + Math.floor(r() * 3), rot = r() * 6;
    const v = r() < 0.5 ? 255 : 30;
    g.fillStyle = `rgba(${v},${v},${v},${0.04 + r() * 0.07})`;
    wrapped(S, x, y, 8, (px, py) => {
      g.beginPath();
      for (let s = 0; s < sides; s++) {
        const a = rot + (s / sides) * Math.PI * 2, rr = rad * (0.7 + r() * 0.5);
        s ? g.lineTo(px + Math.cos(a) * rr, py + Math.sin(a) * rr) : g.moveTo(px + Math.cos(a) * rr, py + Math.sin(a) * rr);
      }
      g.fill();
    });
  }
  for (let k = 0; k < 6; k++) {                                     // rust weeping from a worn spot
    const x = r() * S, y = r() * S, len = 10 + r() * 30;
    const gr = g.createLinearGradient(x, y, x, y + len);
    gr.addColorStop(0, 'rgba(135,80,40,0.35)');
    gr.addColorStop(1, 'rgba(135,80,40,0)');
    g.fillStyle = gr;
    g.fillRect(x - 1, y, 2, len);
  }
  return tex(c);
});

// ---- buildings --------------------------------------------------------------------------------
// Facades: {map, emissive}. The emissive map is white where windows are, so a load's windows light
// up when it has power (material.emissive = window colour, emissiveIntensity on/off).
function facadeCanvas(kind) {
  const S = 256, n = noise(S, kind.length * 17, 4, 8);
  const wall = { office: hex(0x6d7880), shop: hex(0x9a8c78), home: hex(0xc9bfae), hospital: hex(0xd7dcdf),
    station: hex(0x9b5a4a) }[kind];
  const [c, g] = canvas(S);
  g.drawImage(pixels(S, (x, y, i) => {
    let k = 0.9 + n[i] * 0.16;
    if (kind === 'home' && y % 12 < 1.5) k -= 0.18;                 // lap siding
    return [wall[0] * k, wall[1] * k, wall[2] * k];
  }), 0, 0);
  const [e, ge] = canvas(S);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, S, S);
  const win = (x, y, w, h, glass = '#2c3a46') => {
    g.fillStyle = glass;
    g.fillRect(x, y, w, h);
    g.strokeStyle = 'rgba(220,225,230,0.8)';
    g.lineWidth = 2;
    g.strokeRect(x, y, w, h);
    ge.fillStyle = '#fff';
    ge.fillRect(x + 2, y + 2, w - 4, h - 4);
  };
  if (kind === 'office' || kind === 'hospital') {
    // 4 floors x 6 bays of ribbon glazing.
    for (let f = 0; f < 4; f++) for (let b = 0; b < 6; b++) win(8 + b * 41, 14 + f * 64, 34, 38, kind === 'office' ? '#33495a' : '#3d5566');
  } else if (kind === 'shop') {
    for (let f = 0; f < 4; f++) for (let b = 0; b < 4; b++) win(14 + b * 60, 18 + f * 64, 44, f === 3 ? 44 : 34);
  } else if (kind === 'home') {
    win(30, 70, 60, 56);
    win(166, 70, 60, 56);
    g.fillStyle = '#5b3f2e';
    g.fillRect(108, 130, 40, 126);                                     // door
  } else if (kind === 'station') {
    g.fillStyle = '#b8bec4';
    for (let b = 0; b < 2; b++) {
      g.fillRect(20 + b * 120, 90, 96, 166);                           // apparatus bay doors
      g.fillStyle = '#9aa2a9';
      for (let k = 0; k < 8; k++) g.fillRect(20 + b * 120, 96 + k * 20, 96, 2);
      g.fillStyle = '#b8bec4';
    }
    win(30, 20, 76, 46);
    win(150, 20, 76, 46);
  }
  return [c, e];
}
export const facade = (kind) => cached('facade' + kind, () => {
  const [c, e] = facadeCanvas(kind);
  return { map: tex(c), emissive: tex(e) };
});

export const shingles = () => cached('shingles', () => {
  const S = 128, n = noise(S, 121, 4, 8), r = rng(122);
  return tex(pixels(S, (x, y, i) => {
    const row = Math.floor(y / 8), off = row % 2 ? 6 : 0;
    const edge = y % 8 < 1 || (x + off) % 12 < 1;
    const v = (edge ? 0.55 : 0.8 + r() * 0.2) * (0.85 + n[i] * 0.3);
    return [92 * v, 66 * v, 56 * v];
  }));
});

export const flatRoof = () => cached('flatroof', () => {
  const S = 128, n = noise(S, 131, 4, 8);
  return tex(pixels(S, (x, y, i) => { const v = 110 + n[i] * 40; return [v, v, v * 1.02]; }));
});

export const helipad = () => cached('helipad', () => {
  const [c, g] = canvas(256);
  g.fillStyle = '#5f666c';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#e8e8e8';
  g.lineWidth = 12;
  g.beginPath();
  g.arc(128, 128, 100, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#e8e8e8';
  g.font = 'bold 150px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('H', 128, 136);
  return tex(c);
});

// ---- equipment --------------------------------------------------------------------------------
// Solar module: 6 x 10 cells, silver busbars, aluminium frame.
export const pvCells = () => cached('pv', () => {
  const [c, g] = canvas(256);
  g.fillStyle = '#c9ced3';
  g.fillRect(0, 0, 256, 256);
  const cw = 248 / 10, ch = 248 / 6;
  for (let i = 0; i < 10; i++) for (let j = 0; j < 6; j++) {
    const grd = g.createLinearGradient(0, 4 + j * ch, 0, 4 + (j + 1) * ch);
    grd.addColorStop(0, '#1d3557');
    grd.addColorStop(1, '#13253f');
    g.fillStyle = grd;
    g.fillRect(5 + i * cw, 5 + j * ch, cw - 2, ch - 2);
    g.fillStyle = 'rgba(200,210,220,0.35)';
    for (let k = 1; k < 3; k++) g.fillRect(5 + i * cw, 5 + j * ch + (k * ch) / 3, cw - 2, 1);
  }
  return tex(c);
});

// Chain-link fence with barbed wire on top (alpha: use with alphaTest).
export const chainLink = () => cached('chain', () => {
  const S = 128;
  const [c, g] = canvas(S);
  g.clearRect(0, 0, S, S);
  g.strokeStyle = 'rgba(190,196,200,1)';
  g.lineWidth = 1.4;
  for (let k = -S; k < S * 2; k += 10) {
    g.beginPath(); g.moveTo(k, 0); g.lineTo(k + S, S); g.stroke();
    g.beginPath(); g.moveTo(k, S); g.lineTo(k + S, 0); g.stroke();
  }
  g.fillStyle = 'rgba(160,166,170,1)';
  g.fillRect(0, 0, S, 3);
  g.fillRect(0, S - 3, S, 3);
  const t = tex(c);
  return t;
});

// ANSI-style safety sign: a coloured header band with a signal word, black text below.
export function sign(word, lines, { header = '#c8102e', w = 256, h = 160 } = {}) {
  return cached('sign' + word + lines.join('|') + header, () => {
    const [c, g] = canvas(w, h);
    g.fillStyle = '#f4f4f0';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#111';
    g.fillRect(0, 0, w, h * 0.36);
    g.fillStyle = header;
    g.beginPath();
    g.ellipse(w / 2, h * 0.18, w * 0.4, h * 0.14, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = `bold ${Math.round(h * 0.2)}px Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(word, w / 2, h * 0.19);
    g.fillStyle = '#111';
    g.font = `bold ${Math.round(h * 0.15)}px Arial, sans-serif`;
    lines.forEach((l, i) => g.fillText(l, w / 2, h * (0.52 + i * 0.2)));
    g.strokeStyle = '#111';
    g.lineWidth = 4;
    g.strokeRect(2, 2, w - 4, h - 4);
    return tex(c);
  });
}

// A stamped equipment nameplate or label.
export function plate(lines, { bg = '#c9cdd0', fg = '#1d2226', w = 256, h = 128 } = {}) {
  return cached('plate' + lines.join('|') + bg, () => {
    const [c, g] = canvas(w, h);
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = fg;
    g.lineWidth = 3;
    g.strokeRect(4, 4, w - 8, h - 8);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    lines.forEach((l, i) => {
      g.font = `${i === 0 ? 'bold ' : ''}${Math.round((h / (lines.length + 1)) * 0.62)}px Arial, sans-serif`;
      g.fillText(l, w / 2, (h * (i + 1)) / (lines.length + 1));
    });
    return tex(c);
  });
}

// Battery rack front: modules with status LEDs (the LEDs are drawn by the scene, not here).
export const rack = () => cached('rack', () => {
  const [c, g] = canvas(128, 256);
  g.fillStyle = '#26292c';
  g.fillRect(0, 0, 128, 256);
  for (let k = 0; k < 10; k++) {
    g.fillStyle = '#3a3f44';
    g.fillRect(8, 6 + k * 25, 112, 21);
    g.fillStyle = '#4a5056';
    g.fillRect(12, 10 + k * 25, 60, 4);
    g.fillStyle = '#7b8288';
    g.fillRect(96, 12 + k * 25, 16, 9);
  }
  return tex(c);
});

// Louvred vent panel (inverters, HVAC units, switchgear).
export const louvre = (base = 0x9aa1a7) => cached('louvre' + base, () => {
  const S = 128, b = hex(base);
  return tex(pixels(S, (x, y) => {
    const k = y % 8 < 3 ? 0.55 : 0.95;
    return [b[0] * k, b[1] * k, b[2] * k];
  }));
});
