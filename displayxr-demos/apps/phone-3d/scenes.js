// 3D Phone: the phone screen's scene. One builder, 'phone', with five apps that swap in place:
// home, photos (AI 2D-to-3D), game, call and learn, plus a global 2D/3D switch.
//
// Units are metres on a display rig: z = 0 is the glass, +z is toward the viewer. The screen is
// VDH (0.24 m) tall and about 0.135 m wide at the glass. Content stays within about +2.5 cm and
// -3.5 cm so it is comfortable on a hand-held panel. Every texture is drawn procedurally at load
// (no downloads), with lots of fine detail so it reads well in 3D.

export const BG = 0x0d0927;

const W = 0.135, H = 0.24;

// ---- small helpers ---------------------------------------------------------------------------
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

function noise1Factory(seed) {
  const r = mulberry32(seed), tab = Array.from({ length: 256 }, r);
  const n = (x) => { const i = Math.floor(x), f = smooth(x - i); return lerp(tab[i & 255], tab[(i + 1) & 255], f); };
  return (x, oct = 5) => { let s = 0, a = 0.5, f = 1, norm = 0; for (let o = 0; o < oct; o++) { s += a * n(x * f + o * 17.3); norm += a; a *= 0.5; f *= 2; } return s / norm; };
}
function hash3(i, j, k, seed) {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1274126177) + Math.imul(seed, 144665);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise3(x, y, z, seed) {
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
  const u = smooth(x - i), v = smooth(y - j), w = smooth(z - k);
  const a = lerp(lerp(hash3(i, j, k, seed), hash3(i + 1, j, k, seed), u), lerp(hash3(i, j + 1, k, seed), hash3(i + 1, j + 1, k, seed), u), v);
  const b = lerp(lerp(hash3(i, j, k + 1, seed), hash3(i + 1, j, k + 1, seed), u), lerp(hash3(i, j + 1, k + 1, seed), hash3(i + 1, j + 1, k + 1, seed), u), v);
  return lerp(a, b, w);
}
function fbm3(x, y, z, oct, seed) {
  let s = 0, a = 0.5, f = 1, norm = 0;
  for (let o = 0; o < oct; o++) { s += a * noise3(x * f, y * f, z * f, seed + o); norm += a; a *= 0.5; f *= 2.03; }
  return s / norm;
}

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

const FONT = "'DM Sans', 'Segoe UI', system-ui, sans-serif";

// Wallpaper and device looks. 'generic' is the public look; other themes are private variants.
const THEMES = {
  generic: { sky: ['#120c4a', '#482BD9', '#c86fd8', '#ffb38a'], sun: 'rgba(255,214,160,0.9)', ridges: [['#6a5fd0', '#2c2380'], ['#3a2f9c', '#1a1350'], ['#1d1559', '#0b0726']], punch: false },
  camon: { sky: ['#041a17', '#0f5c4f', '#4fae93', '#e2f2d6'], sun: 'rgba(235,255,225,0.9)', ridges: [['#6aa896', '#2a5e52'], ['#2f6e5f', '#163b33'], ['#123a31', '#041210']], punch: true },
};

// A soft studio panorama for reflections on glass and metal (shared by every tile).
let STUDIO = null;
function makeStudio(THREE) {
  if (STUDIO) return STUDIO;
  const c = canvas(1024, 512), g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 512); gr.addColorStop(0, '#2a2560'); gr.addColorStop(0.5, '#141033'); gr.addColorStop(1, '#07050f');
  g.fillStyle = gr; g.fillRect(0, 0, 1024, 512);
  const soft = (x, y, r, a) => { const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, `rgba(255,255,255,${a})`); rg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2); };
  soft(260, 125, 180, 0.55); soft(760, 145, 220, 0.45); soft(480, 50, 120, 0.4);
  g.fillStyle = 'rgba(255,255,255,0.95)'; g.fillRect(190, 95, 150, 60); g.fillRect(650, 125, 220, 44); g.fillRect(430, 32, 110, 34);
  g.fillStyle = 'rgba(196,191,253,0.45)'; g.fillRect(0, 300, 1024, 5);
  STUDIO = new THREE.CanvasTexture(c);
  STUDIO.mapping = THREE.EquirectangularReflectionMapping;
  STUDIO.colorSpace = THREE.SRGBColorSpace;
  return STUDIO;
}

// ---- the builder -----------------------------------------------------------------------------
function buildPhone(THREE, motion = 1, ctx = {}) {
  const theme = THEMES[ctx.theme] || THEMES.generic;
  const env = makeStudio(THREE);
  const tex = (c, { repeat = false } = {}) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
    return t;
  };
  const basic = (map, opts = {}) => new THREE.MeshBasicMaterial({ map, ...opts });
  const plane = (w, h, material, x, y, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    m.position.set(x, y, z);
    return m;
  };
  // A plane at depth z that still fills the screen: the frustum widens behind the glass.
  const fill = (z) => (0.6 - z) / 0.6 * 1.08;

  const group = new THREE.Group();
  const stage = new THREE.Group();          // everything that flattens in 2D
  group.add(stage);
  group.add(new THREE.HemisphereLight(0xe9e5ff, 0x1a1236, 1.4));
  const key = new THREE.DirectionalLight(0xfff1e0, 2.2);
  key.position.set(-0.3, 0.4, 0.8);
  group.add(key);

  // ---- status bar (shared) -----------------------------------------------------------------
  const sbC = canvas(1024, 96), sbT = tex(sbC);
  const statusBar = plane(W * 0.98, W * 0.98 * 96 / 1024, basic(sbT, { transparent: true, depthWrite: false }), 0, H / 2 - 0.009, 0.004);
  statusBar.renderOrder = 10;
  stage.add(statusBar);
  let sbKey = '';
  function drawStatusBar(depthOn) {
    const d = new Date(), hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    const k = hh + mm + depthOn;
    if (k === sbKey) return;
    sbKey = k;
    const g = sbC.getContext('2d');
    g.clearRect(0, 0, 1024, 96);
    const shade = g.createLinearGradient(0, 0, 0, 96); shade.addColorStop(0, 'rgba(13,9,39,0.55)'); shade.addColorStop(1, 'rgba(13,9,39,0)');
    g.fillStyle = shade; g.fillRect(0, 0, 1024, 96);
    g.fillStyle = '#ffffff';
    g.font = `600 44px ${FONT}`;
    g.textBaseline = 'middle';
    g.fillText(`${hh}:${mm}`, 40, 50);
    if (theme.punch) { g.fillStyle = '#000000'; g.beginPath(); g.arc(512, 50, 24, 0, 7); g.fill(); g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 3; g.stroke(); }
    g.fillStyle = depthOn ? '#482BD9' : 'rgba(255,255,255,0.25)';
    g.beginPath(); g.roundRect(theme.punch ? 616 : 452, 22, 120, 56, 28); g.fill();
    g.fillStyle = '#ffffff'; g.font = `700 36px ${FONT}`; g.textAlign = 'center';
    g.fillText(depthOn ? '3D' : '2D', theme.punch ? 676 : 512, 51);
    g.textAlign = 'left'; g.font = `700 38px ${FONT}`;
    g.fillText('5G', 760, 51);
    for (let i = 0; i < 4; i++) g.fillRect(830 + i * 16, 66 - i * 10, 10, 12 + i * 10);
    g.strokeStyle = '#ffffff'; g.lineWidth = 4;
    g.beginPath(); g.roundRect(912, 32, 70, 36, 8); g.stroke();
    g.fillRect(984, 42, 6, 16);
    g.fillRect(918, 38, 48, 24);
    sbT.needsUpdate = true;
  }

  // ---- apps ----------------------------------------------------------------------------------
  const apps = {};
  const built = {};
  const builders = { home: buildHome, photos: buildPhotos, game: buildGame, call: buildCall, learn: buildLearn };
  function app(n) {
    if (!built[n]) { built[n] = builders[n](); built[n].group.visible = false; stage.add(built[n].group); }
    return built[n];
  }

  // ---- HOME: layered mountain wallpaper, a clock and app icons that float off the glass -------
  function buildHome() {
    const g = new THREE.Group();
    const rnd = mulberry32(7), ridge = noise1Factory(11);
    // Sky
    const skyC = canvas(1024, 2048), s = skyC.getContext('2d');
    s.scale(2, 2);
    const sg = s.createLinearGradient(0, 0, 0, 1024);
    sg.addColorStop(0, theme.sky[0]); sg.addColorStop(0.35, theme.sky[1]); sg.addColorStop(0.62, theme.sky[2]); sg.addColorStop(0.8, theme.sky[3]);
    s.fillStyle = sg; s.fillRect(0, 0, 512, 1024);
    for (let i = 0; i < 900; i++) { s.fillStyle = `rgba(255,255,255,${rnd() * 0.8})`; s.fillRect(rnd() * 512, rnd() * 420, 0.4 + rnd(), 0.4 + rnd()); }
    const sun = s.createRadialGradient(330, 690, 10, 330, 690, 220);
    sun.addColorStop(0, 'rgba(255,248,225,1)'); sun.addColorStop(0.15, theme.sun); sun.addColorStop(1, 'rgba(255,180,140,0)');
    s.fillStyle = sun; s.fillRect(0, 400, 512, 600);
    const sky = plane(W * fill(-0.034), H * fill(-0.034), basic(tex(skyC)), 0, 0, -0.034);
    g.add(sky);
    // Three ridges, each a transparent canvas with rock and snow strokes for texture
    const layers = [
      { z: -0.026, base: 560, amp: 170, top: theme.ridges[0][0], bot: theme.ridges[0][1], snow: 0.5, f: 0.006 },
      { z: -0.015, base: 690, amp: 140, top: theme.ridges[1][0], bot: theme.ridges[1][1], snow: 0.15, f: 0.009 },
      { z: -0.004, base: 830, amp: 110, top: theme.ridges[2][0], bot: theme.ridges[2][1], snow: 0, f: 0.013 },
    ];
    layers.forEach((L, li) => {
      const c = canvas(1024, 2048), x = c.getContext('2d');
      x.scale(2, 2);
      const ys = [];
      x.beginPath(); x.moveTo(0, 1024);
      for (let i = 0; i <= 512; i += 2) { const y = L.base - ridge(i * L.f + li * 40) * L.amp * 1.6 + L.amp * 0.4; ys[i] = y; x.lineTo(i, y); }
      x.lineTo(512, 1024); x.closePath();
      const gr = x.createLinearGradient(0, L.base - L.amp, 0, 1024);
      gr.addColorStop(0, L.top); gr.addColorStop(1, L.bot);
      x.fillStyle = gr; x.fill();
      x.save(); x.clip();
      for (let k = 0; k < 8000; k++) {
        const px = rnd() * 512, py = (ys[Math.floor(px / 2) * 2] ?? L.base) + rnd() * 500;
        x.strokeStyle = rnd() < 0.5 ? `rgba(255,255,255,${0.04 + rnd() * 0.06})` : `rgba(0,0,0,${0.08 + rnd() * 0.1})`;
        x.lineWidth = 0.5; x.beginPath(); x.moveTo(px, py); x.lineTo(px + (rnd() - 0.5) * 14, py + 4 + rnd() * 16); x.stroke();
      }
      if (L.snow) for (let k = 0; k < 2600; k++) {
        const px = rnd() * 512, top = ys[Math.floor(px / 2) * 2] ?? L.base;
        if (top > L.base - L.amp * L.snow) continue;
        x.fillStyle = `rgba(255,255,255,${0.35 + rnd() * 0.5})`; x.fillRect(px, top + rnd() * 26, 0.5 + rnd(), 0.5 + rnd() * 2);
      }
      x.restore();
      const m = plane(W * fill(L.z), H * fill(L.z), basic(tex(c), { transparent: true, alphaTest: 0.5 }), 0, 0, L.z);
      g.add(m);
    });
    // Clock
    const clC = canvas(1024, 400), clT = tex(clC);
    const clock = plane(0.11, 0.043, basic(clT, { transparent: true, depthWrite: false }), 0, 0.068, 0.006);
    clock.renderOrder = 5;
    g.add(clock);
    let clKey = '';
    const drawClock = () => {
      const d = new Date(), t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      if (t === clKey) return; clKey = t;
      const x = clC.getContext('2d'); x.clearRect(0, 0, 1024, 400);
      x.textAlign = 'center'; x.fillStyle = '#ffffff'; x.shadowColor = 'rgba(13,9,39,0.6)'; x.shadowBlur = 18;
      x.font = `300 230px ${FONT}`; x.fillText(t, 512, 240);
      x.font = `500 56px ${FONT}`; x.fillText(d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }), 512, 340);
      clT.needsUpdate = true;
    };
    drawClock();
    document.fonts?.ready.then(() => { clKey = ''; drawClock(); });
    // App icons: rounded tiles with a glyph on the face, sitting about 1.4 cm in front of the glass
    const icons = [];
    const defs = [
      { app: 'photos', label: 'Photos', a: '#ff9a62', b: '#e2366f', glyph: 'photo' },
      { app: 'game', label: 'Game', a: '#5ef2ff', b: '#482BD9', glyph: 'game' },
      { app: 'call', label: '3D Call', a: '#6dff9e', b: '#139a6a', glyph: 'call' },
      { app: 'learn', label: 'Learn', a: '#ffd76a', b: '#d9822b', glyph: 'globe' },
    ];
    const shape = new THREE.Shape(), r = 0.24;
    shape.moveTo(r, 0); shape.lineTo(1 - r, 0); shape.quadraticCurveTo(1, 0, 1, r); shape.lineTo(1, 1 - r);
    shape.quadraticCurveTo(1, 1, 1 - r, 1); shape.lineTo(r, 1); shape.quadraticCurveTo(0, 1, 0, 1 - r); shape.lineTo(0, r); shape.quadraticCurveTo(0, 0, r, 0);
    const iconGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 3, curveSegments: 10 });
    iconGeo.translate(-0.5, -0.5, -0.1);
    defs.forEach((d, i) => {
      const c = canvas(256, 256), x = c.getContext('2d');
      const gr = x.createLinearGradient(0, 0, 256, 256); gr.addColorStop(0, d.a); gr.addColorStop(1, d.b);
      x.fillStyle = gr; x.fillRect(0, 0, 256, 256);
      x.fillStyle = '#ffffff'; x.strokeStyle = '#ffffff'; x.lineWidth = 14; x.lineCap = 'round'; x.lineJoin = 'round';
      if (d.glyph === 'photo') { x.beginPath(); x.moveTo(50, 190); x.lineTo(110, 110); x.lineTo(150, 160); x.lineTo(175, 130); x.lineTo(210, 190); x.closePath(); x.fill(); x.beginPath(); x.arc(170, 78, 22, 0, 7); x.fill(); }
      if (d.glyph === 'game') { x.beginPath(); x.roundRect(40, 90, 176, 90, 45); x.fill(); x.fillStyle = d.b; x.fillRect(70, 128, 44, 14); x.fillRect(85, 113, 14, 44); x.beginPath(); x.arc(170, 122, 10, 0, 7); x.arc(190, 148, 10, 0, 7); x.fill(); }
      if (d.glyph === 'call') { x.beginPath(); x.roundRect(40, 80, 120, 96, 18); x.fill(); x.beginPath(); x.moveTo(166, 128); x.lineTo(216, 92); x.lineTo(216, 164); x.closePath(); x.fill(); }
      if (d.glyph === 'globe') { x.beginPath(); x.arc(128, 128, 76, 0, 7); x.stroke(); x.beginPath(); x.ellipse(128, 128, 34, 76, 0, 0, 7); x.stroke(); x.beginPath(); x.moveTo(52, 128); x.lineTo(204, 128); x.stroke(); }
      const face = new THREE.MeshPhysicalMaterial({ map: tex(c), roughness: 0.3, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.08, envMap: env, envMapIntensity: 0.9 });
      const side = new THREE.MeshPhysicalMaterial({ color: d.b, roughness: 0.3, clearcoat: 1, envMap: env, envMapIntensity: 0.9 });
      const m = new THREE.Mesh(iconGeo, [face, side]);
      const col = i % 2, row = Math.floor(i / 2);
      m.scale.setScalar(0.026);
      m.position.set(col ? 0.024 : -0.024, -0.03 - row * 0.042, 0.012);
      m.userData.app = d.app;
      g.add(m);
      // Label under the icon, on the glass
      const lc = canvas(256, 64), lx = lc.getContext('2d');
      lx.fillStyle = '#ffffff'; lx.font = `600 40px ${FONT}`; lx.textAlign = 'center'; lx.fillText(d.label, 128, 46);
      const label = plane(0.03, 0.0075, basic(tex(lc), { transparent: true, depthWrite: false }), m.position.x, m.position.y - 0.019, 0.003);
      label.renderOrder = 6;
      g.add(label);
      icons.push({ m, base: m.position.clone(), i });
    });
    // Drifting motes at many depths, so the space between the layers reads
    const n = 90, pos = new Float32Array(n * 3), seeds = [];
    for (let i = 0; i < n; i++) { seeds.push([rnd() * W - W / 2, rnd() * H - H / 2, -0.03 + rnd() * 0.05, rnd() * 6]); }
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dot = canvas(64, 64), dx = dot.getContext('2d'), dg = dx.createRadialGradient(32, 32, 0, 32, 32, 32);
    dg.addColorStop(0, 'rgba(255,240,220,1)'); dg.addColorStop(1, 'rgba(255,240,220,0)'); dx.fillStyle = dg; dx.fillRect(0, 0, 64, 64);
    const motes = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.0022, map: tex(dot), transparent: true, depthWrite: false, opacity: 0.8 }));
    motes.renderOrder = 4;
    g.add(motes);
    return {
      group: g,
      pick: icons.map((o) => o.m),
      tap(hit) { const a = hit.object.userData.app; if (a) setApp(a); },
      update(t) {
        drawClock();
        for (const o of icons) {
          o.m.position.z = o.base.z + Math.sin(t * 1.3 + o.i) * 0.002 * motion;
          o.m.rotation.y = Math.sin(t * 0.8 + o.i * 1.7) * 0.25 * motion;
          o.m.rotation.x = Math.cos(t * 0.7 + o.i) * 0.12 * motion;
        }
        for (let i = 0; i < n; i++) {
          const [x, y, z, p] = seeds[i];
          pos[i * 3] = x + Math.sin(t * 0.3 + p) * 0.004;
          pos[i * 3 + 1] = ((y + t * 0.004 * motion + H / 2) % H) - H / 2;
          pos[i * 3 + 2] = z;
        }
        pg.attributes.position.needsUpdate = true;
      },
      status: () => 'Home · tap an app icon',
      primary: { label: () => 'Open Photos', run: () => setApp('photos') },
    };
  }

  // ---- PHOTOS: one flat photo, converted to depth by "AI" with a sweep -----------------------
  function buildPhotos() {
    const g = new THREE.Group();
    const PW = 0.14, PH = PW * 1280 / 720;
    const geo = new THREE.PlaneGeometry(PW, PH, 200, 356);
    const mat = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    g.add(mesh);
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    let depth = new Float32Array(pos.count);
    const photos = [paintPhoto(3, 'day'), paintPhoto(19, 'sunset')];
    let idx = 0, converted = false, sweep = 0, k = 0;
    // The sweep line that "scans" the photo while it converts
    const line = plane(PW, 0.0016, new THREE.MeshBasicMaterial({ color: 0xc4bffd, transparent: true, opacity: 0.9 }), 0, 0, 0.012);
    line.visible = false;
    g.add(line);
    function show(i) {
      const p = photos[i];
      mat.map = p.map; mat.needsUpdate = true;
      for (let v = 0; v < pos.count; v++) {
        const px = clamp(Math.round(uv.getX(v) * (p.w - 1)), 0, p.w - 1), py = clamp(Math.round((1 - uv.getY(v)) * (p.h - 1)), 0, p.h - 1);
        depth[v] = p.depth[py * p.w + px];
      }
    }
    show(0);
    function convert(on) { converted = on; sweep = on ? 0 : sweep; }
    return {
      group: g,
      pick: [mesh],
      tap() { idx = (idx + 1) % photos.length; show(idx); convert(false); k = 0; setTimeout(() => convert(true), 500); },
      onShow() { convert(false); k = 0; setTimeout(() => convert(true), 700); },
      update(t, dt) {
        if (converted) { sweep = Math.min(1.25, sweep + dt * 0.7); k = 1; } else k = damp(k, 0, 6, dt);
        line.visible = converted && sweep < 1.2;
        line.position.y = PH / 2 - sweep * PH;
        for (let v = 0; v < pos.count; v++) {
          const vy = 1 - uv.getY(v);
          const f = converted ? clamp((sweep - vy) / 0.08, 0, 1) : k;
          pos.setZ(v, (depth[v] - 0.45) * 0.055 * f);
        }
        pos.needsUpdate = true;
      },
      status: () => converted ? (sweep < 1.2 ? 'AI is adding depth to a flat photo…' : 'One flat photo, now in 3D · tap for the next') : 'The 2D original',
      primary: { label: () => converted ? 'Show the 2D original' : 'Convert to 3D', run: () => convert(!converted) },
    };
  }

  // Paints a landscape and, stroke for stroke, its depth map (white = near).
  function paintPhoto(seed, mood) {
    const Wp = 720, Hp = 1280;
    const K = 1.5, PWX = Wp * K, PHX = Hp * K;           // drawn in 720 x 1280 units at 1.5x
    const cc = canvas(PWX, PHX), c = cc.getContext('2d'); c.scale(K, K);
    const dc = canvas(PWX, PHX), d = dc.getContext('2d'); d.scale(K, K);
    const rnd = mulberry32(seed), ridge = noise1Factory(seed + 5);
    const gray = (v) => { const n = Math.round(clamp(v, 0, 1) * 255); return `rgb(${n},${n},${n})`; };
    const day = mood === 'day';
    // Sky
    let gr = c.createLinearGradient(0, 0, 0, 760);
    if (day) { gr.addColorStop(0, '#3d7fd6'); gr.addColorStop(0.7, '#a9d3f2'); gr.addColorStop(1, '#e8f3fa'); }
    else { gr.addColorStop(0, '#24185e'); gr.addColorStop(0.5, '#b04f7a'); gr.addColorStop(0.85, '#f39a5a'); gr.addColorStop(1, '#ffd29a'); }
    c.fillStyle = gr; c.fillRect(0, 0, Wp, Hp);
    d.fillStyle = gray(0); d.fillRect(0, 0, Wp, Hp);
    const sunX = day ? 540 : 260, sunY = day ? 210 : 600;
    const sg = c.createRadialGradient(sunX, sunY, 6, sunX, sunY, 260);
    sg.addColorStop(0, day ? 'rgba(255,255,240,1)' : 'rgba(255,240,200,1)'); sg.addColorStop(0.12, day ? 'rgba(255,255,230,0.7)' : 'rgba(255,200,140,0.8)'); sg.addColorStop(1, 'rgba(255,220,180,0)');
    c.fillStyle = sg; c.fillRect(0, 0, Wp, 900);
    for (let i = 0; i < 70; i++) {
      const x = rnd() * Wp, y = 80 + rnd() * 360, rx = 60 + rnd() * 140, ry = 14 + rnd() * 26;
      c.fillStyle = day ? `rgba(255,255,255,${0.08 + rnd() * 0.18})` : `rgba(255,200,220,${0.05 + rnd() * 0.12})`;
      c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 7); c.fill();
    }
    // Far mountains, snow-capped
    const farY = [];
    const both = (path, fillC, fillD) => { path(c); c.fillStyle = fillC; c.fill(); path(d); d.fillStyle = fillD; d.fill(); };
    const ridgePath = (base, amp, f, off, bottom, store) => (x) => {
      x.beginPath(); x.moveTo(0, bottom);
      for (let i = 0; i <= Wp; i += 3) { const y = base - Math.pow(ridge(i * f + off), 1.6) * amp; if (store) store[i] = y; x.lineTo(i, y); }
      x.lineTo(Wp, bottom); x.closePath();
    };
    gr = c.createLinearGradient(0, 380, 0, 760);
    gr.addColorStop(0, day ? '#8696c4' : '#6a4e8e'); gr.addColorStop(1, day ? '#4a5d8f' : '#3b2a5e');
    both(ridgePath(760, 520, 0.004, 3, 760, farY), gr, gray(0.14));
    c.save(); ridgePath(760, 520, 0.004, 3, 760)(c); c.clip();
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * Wp, top = farY[Math.floor(x / 3) * 3] ?? 700, y = top + rnd() * (760 - top);
      const snow = y < top + 50 && top < 560;
      c.strokeStyle = snow ? `rgba(255,255,255,${0.5 + rnd() * 0.4})` : (rnd() < 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(20,10,40,0.16)');
      c.lineWidth = snow ? 2 : 1; c.beginPath(); c.moveTo(x, y); c.lineTo(x + (rnd() - 0.5) * 10, y + 6 + rnd() * 18); c.stroke();
    }
    c.restore();
    // Lake with reflections; its depth runs from far to near down the page
    gr = c.createLinearGradient(0, 760, 0, 900);
    gr.addColorStop(0, day ? '#9cc6e6' : '#f2a06a'); gr.addColorStop(1, day ? '#2e6a9a' : '#5b3a72');
    c.fillStyle = gr; c.fillRect(0, 760, Wp, 160);
    for (let i = 0; i < 420; i++) { c.fillStyle = `rgba(255,255,255,${rnd() * 0.25})`; c.fillRect(rnd() * Wp, 760 + rnd() * 160, 10 + rnd() * 60, 1.5); }
    const dg = d.createLinearGradient(0, 760, 0, 920); dg.addColorStop(0, gray(0.2)); dg.addColorStop(1, gray(0.42)); d.fillStyle = dg; d.fillRect(0, 760, Wp, 160);
    // Mid hills with pines
    const midY = [];
    gr = c.createLinearGradient(0, 820, 0, 1000); gr.addColorStop(0, day ? '#4c7d3a' : '#3d3a52'); gr.addColorStop(1, day ? '#2b4f24' : '#231f38');
    both(ridgePath(900, 90, 0.006, 40, Hp, midY), gr, gray(0.48));
    const pines = [];
    for (let i = 0; i < 220; i++) { const x = rnd() * Wp, top = midY[Math.floor(x / 3) * 3] ?? 880; pines.push([x, top + rnd() * 110]); }
    pines.sort((a, b) => a[1] - b[1]);
    for (const [x, y] of pines) {
      const s = 0.6 + (y - 820) / 160, h = 46 * s, w = 15 * s;
      const pine = (k) => { k.beginPath(); k.moveTo(x, y - h); for (let j = 0; j < 4; j++) { const yy = y - h + (j + 1) * h / 4; k.lineTo(x + w * (0.4 + j * 0.2), yy); k.lineTo(x + w * 0.2, yy); } k.lineTo(x + w * 0.2, y); k.lineTo(x - w * 0.2, y); for (let j = 3; j >= 0; j--) { const yy = y - h + (j + 1) * h / 4; k.lineTo(x - w * 0.2, yy); k.lineTo(x - w * (0.4 + j * 0.2), yy); } k.closePath(); };
      const tone = day ? `hsl(${110 + rnd() * 30},${35 + rnd() * 20}%,${12 + rnd() * 12}%)` : `hsl(${250 + rnd() * 20},25%,${10 + rnd() * 8}%)`;
      both(pine, tone, gray(0.5 + (y - 820) / 160 * 0.15));
      for (let j = 0; j < 6; j++) { const yy = y - h + rnd() * h, ww = w * (yy - (y - h)) / h; c.strokeStyle = day ? 'rgba(190,240,160,0.22)' : 'rgba(220,190,255,0.16)'; c.lineWidth = 0.6; c.beginPath(); c.moveTo(x - ww * 0.5, yy); c.lineTo(x + ww * 0.6 * rnd(), yy + 2); c.stroke(); }
    }
    // Foreground meadow, rocks, grass and flowers; depth runs to the nearest at the bottom
    const fgY = [];
    gr = c.createLinearGradient(0, 980, 0, Hp); gr.addColorStop(0, day ? '#6aa043' : '#4a3f5e'); gr.addColorStop(1, day ? '#24461c' : '#1c1530');
    const fgPath = ridgePath(1010, 60, 0.008, 90, Hp, fgY);
    fgPath(c); c.fillStyle = gr; c.fill();
    fgPath(d); const fd = d.createLinearGradient(0, 960, 0, Hp); fd.addColorStop(0, gray(0.66)); fd.addColorStop(1, gray(1)); d.fillStyle = fd; d.fill();
    for (let i = 0; i < 4; i++) {
      const x = 80 + rnd() * 560, y = 1080 + rnd() * 160, rx = 40 + rnd() * 50, ry = rx * 0.6, tilt = (rnd() - 0.5) * 0.4;
      const rock = (k) => { k.beginPath(); k.ellipse(x, y, rx, ry, tilt, Math.PI, 0); k.closePath(); };
      const rg = c.createLinearGradient(x - rx, y - ry, x + rx, y); rg.addColorStop(0, day ? '#b8b2a6' : '#8a7a9a'); rg.addColorStop(1, day ? '#4c463e' : '#2e2540');
      both(rock, rg, gray(0.78 + (y - 1080) / 160 * 0.2 + 0.06));
    }
    for (let i = 0; i < 13000; i++) {
      const x = rnd() * Wp, top = fgY[Math.floor(x / 3) * 3] ?? 1000, y = top + 6 + rnd() * (Hp - top), len = 6 + (y - 980) / 300 * 26;
      c.strokeStyle = day ? `hsl(${80 + rnd() * 40},${40 + rnd() * 30}%,${18 + rnd() * 30}%)` : `hsl(${260 + rnd() * 30},20%,${15 + rnd() * 20}%)`;
      c.lineWidth = 0.6 + (y - 980) / 360; c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + (rnd() - 0.5) * 6, y - len / 2, x + (rnd() - 0.5) * 10, y - len); c.stroke();
    }
    const petals = day ? ['#ffd34d', '#ffffff', '#ff7aa8', '#a77bff'] : ['#ffd0a0', '#ffffff', '#ff9ec4'];
    for (let i = 0; i < 950; i++) {
      const x = rnd() * Wp, top = fgY[Math.floor(x / 3) * 3] ?? 1000, y = top + 10 + rnd() * (Hp - top), r = 2 + (y - 980) / 300 * 6;
      c.fillStyle = petals[Math.floor(rnd() * petals.length)]; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
      c.fillStyle = 'rgba(120,80,0,0.8)'; c.beginPath(); c.arc(x, y, r * 0.35, 0, 7); c.fill();
    }
    // Smooth the depth a little, as a depth model would, then keep it as numbers
    // Film grain, so the photo reads as a photo and gives each eye fine detail to fuse
    const gi = c.getImageData(0, 0, PWX, PHX), gd = gi.data;
    for (let i = 0; i < gd.length; i += 4) { const n = (rnd() - 0.5) * 14; gd[i] += n; gd[i + 1] += n; gd[i + 2] += n; }
    c.putImageData(gi, 0, 0);
    const blur = canvas(PWX, PHX), bx = blur.getContext('2d');
    bx.filter = 'blur(7px)'; bx.drawImage(dc, 0, 0);
    const px = bx.getImageData(0, 0, PWX, PHX).data, depth = new Float32Array(PWX * PHX);
    for (let i = 0; i < depth.length; i++) depth[i] = px[i * 4] / 255;
    return { map: tex(cc), depth, w: PWX, h: PHX };
  }

  // ---- GAME: a lane runner on a track that runs from in front of the glass into the screen ---
  function buildGame() {
    const g = new THREE.Group();
    const rnd = mulberry32(23);
    const F = new THREE.Vector3(0, -0.105, 0.02), B = new THREE.Vector3(0, 0.045, -0.03);
    const along = new THREE.Vector3().subVectors(B, F), L = along.length();
    const a = Math.atan2(F.z - B.z, B.y - F.y);
    const normal = new THREE.Vector3(0, Math.sin(a), Math.cos(a));
    // Sky and a skyline at the far end
    const skC = canvas(512, 1024), s = skC.getContext('2d');
    let gr = s.createLinearGradient(0, 0, 0, 1024); gr.addColorStop(0, '#0d0927'); gr.addColorStop(0.45, '#3a1f8a'); gr.addColorStop(0.62, '#e2366f'); gr.addColorStop(1, '#0d0927');
    s.fillStyle = gr; s.fillRect(0, 0, 512, 1024);
    for (let i = 0; i < 200; i++) { s.fillStyle = `rgba(255,255,255,${rnd() * 0.7})`; s.fillRect(rnd() * 512, rnd() * 400, 1.5, 1.5); }
    const sunG = s.createLinearGradient(0, 380, 0, 600); sunG.addColorStop(0, '#ffe36e'); sunG.addColorStop(1, '#ff4fa3');
    s.fillStyle = sunG; s.beginPath(); s.arc(256, 560, 150, Math.PI, 0); s.fill();
    s.fillStyle = '#0d0927'; for (let i = 0; i < 7; i++) s.fillRect(100, 450 + i * 18, 312, 3 + i * 1.5);
    for (let i = 0; i < 26; i++) {
      const x = i * 20 - 10 + rnd() * 8, w = 14 + rnd() * 22, h = 40 + rnd() * 150;
      s.fillStyle = '#140d3a'; s.fillRect(x, 610 - h, w, h + 400);
      for (let wy = 610 - h + 6; wy < 600; wy += 9) for (let wx = x + 3; wx < x + w - 3; wx += 6) if (rnd() < 0.35) { s.fillStyle = rnd() < 0.7 ? '#ffd76a' : '#5ef2ff'; s.fillRect(wx, wy, 2.5, 3.5); }
    }
    g.add(plane(W * fill(-0.034), H * fill(-0.034), basic(tex(skC)), 0, 0, -0.034));
    // Track
    const trC = canvas(512, 2048), t2 = trC.getContext('2d');
    t2.scale(2, 2);
    t2.fillStyle = '#120b30'; t2.fillRect(0, 0, 256, 1024);
    for (let i = 0; i < 30000; i++) { t2.fillStyle = `rgba(${150 + rnd() * 100},${120 + rnd() * 80},255,${rnd() * 0.14})`; t2.fillRect(rnd() * 256, rnd() * 1024, 0.6, 0.6); }
    for (let i = 0; i < 400; i++) { t2.strokeStyle = 'rgba(0,0,0,0.35)'; t2.lineWidth = 0.5; const x0 = rnd() * 256, y0 = rnd() * 1024; t2.beginPath(); t2.moveTo(x0, y0); t2.lineTo(x0 + (rnd() - 0.5) * 30, y0 + (rnd() - 0.5) * 30); t2.stroke(); }
    for (let y = 0; y < 1024; y += 128) { t2.fillStyle = 'rgba(94,242,255,0.55)'; t2.fillRect(0, y, 256, 3); }
    t2.fillStyle = '#ff4fa3'; t2.fillRect(0, 0, 8, 1024); t2.fillRect(248, 0, 8, 1024);
    t2.fillStyle = 'rgba(94,242,255,0.8)'; for (let y = 0; y < 1024; y += 64) { t2.fillRect(84, y, 4, 36); t2.fillRect(168, y, 4, 36); }
    const trT = tex(trC, { repeat: true }); trT.repeat.set(1, 2);
    const track = new THREE.Mesh(new THREE.PlaneGeometry(0.1, L), new THREE.MeshStandardMaterial({ map: trT, roughness: 0.45, bumpMap: trT, bumpScale: 0.6, emissive: 0xffffff, emissiveMap: trT, emissiveIntensity: 0.45 }));
    track.position.copy(F).addScaledVector(along, 0.5);
    track.rotation.x = -a;
    g.add(track);
    const at = (t, lane, h = 0.006) => new THREE.Vector3(lane * 0.032, 0, 0).add(F).addScaledVector(along, t).addScaledVector(normal, h);
    // Ship
    const ship = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.ConeGeometry(0.0055, 0.02, 12), new THREE.MeshStandardMaterial({ color: 0xe9e5ff, metalness: 0.8, roughness: 0.2, envMap: env }));
    hull.rotation.x = 0; ship.add(hull);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.006, 0.0015), new THREE.MeshStandardMaterial({ color: 0x482bd9, metalness: 0.4, roughness: 0.3 }));
    wing.position.y = -0.004; ship.add(wing);
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 12, 8), new THREE.MeshBasicMaterial({ color: 0x5ef2ff }));
    flame.position.y = -0.012; ship.add(flame);
    ship.rotation.x = -a;   // nose points up the track
    g.add(ship);
    // Pool of crystals and coins
    const crystalGeo = new THREE.OctahedronGeometry(0.0065, 0), coinGeo = new THREE.TorusGeometry(0.0045, 0.0014, 10, 24);
    const crystalMat = new THREE.MeshStandardMaterial({ color: 0xff4fa3, emissive: 0x8a1450, flatShading: true, roughness: 0.2, metalness: 0.3 });
    const coinMat = new THREE.MeshStandardMaterial({ color: 0xffd76a, emissive: 0x6a4a00, metalness: 0.95, roughness: 0.2, envMap: env });
    // Neon pylons along both edges, scrolling with the track: strong depth cues
    const pylonGeo = new THREE.CylinderGeometry(0.0012, 0.0012, 0.012, 10);
    const pylons = [];
    for (let k = 0; k < 16; k++) { const m = new THREE.Mesh(pylonGeo, new THREE.MeshBasicMaterial({ color: k % 2 ? 0x5ef2ff : 0xff4fa3 })); m.rotation.x = Math.PI / 2 - a; g.add(m); pylons.push({ m, side: k % 2 ? 1 : -1, o: Math.floor(k / 2) / 8 }); }
    const side = new THREE.Vector3();
    let scroll = 0;
    const items = Array.from({ length: 12 }, () => { const m = new THREE.Mesh(crystalGeo, crystalMat); m.visible = false; g.add(m); return { m, t: 0, lane: 0, coin: false, live: false }; });
    // An invisible pad over the screen catches taps: left half steers left, right half steers right
    const pad = plane(W, H, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }), 0, 0, 0.022);
    g.add(pad);
    const P = 0.13;
    let lane = 0, laneX = 0, speed = 0.3, spawnIn = 0.5, score = 0, best = 0, crash = 0, lastTap = -1e9, auto = true, paused = false;
    function reset() { for (const it of items) { it.live = false; it.m.visible = false; } speed = 0.3; score = 0; }
    return {
      group: g,
      pick: [pad],
      tap(hit) { lastTap = performance.now(); auto = false; const local = g.worldToLocal(hit.point.clone()); lane = clamp(lane + (local.x < laneX * 0.032 ? -1 : 1), -1, 1); },
      update(t, dt) {
        if (paused) return;
        if (performance.now() - lastTap > 6000) auto = true;
        trT.offset.y = (trT.offset.y - dt * speed * 2.2) % 1;
        scroll = (scroll + dt * speed) % 1;
        for (const p of pylons) { const tt = (p.o - scroll + 1) % 1; p.m.position.copy(F).addScaledVector(along, tt).addScaledVector(normal, 0.006).add(side.set(p.side * 0.055, 0, 0)); }
        speed = Math.min(0.75, speed + dt * 0.01);
        spawnIn -= dt;
        if (spawnIn <= 0) {
          const it = items.find((x) => !x.live);
          if (it) { it.live = true; it.t = 1; it.lane = Math.floor(rnd() * 3) - 1; it.coin = rnd() < 0.45; it.m.geometry = it.coin ? coinGeo : crystalGeo; it.m.material = it.coin ? coinMat : crystalMat; it.m.visible = true; }
          spawnIn = 0.35 + rnd() * 0.5 - speed * 0.2;
        }
        if (auto) {
          const threat = items.find((x) => x.live && !x.coin && x.lane === lane && x.t > P && x.t < P + 0.4);
          if (threat) { const opts = [-1, 0, 1].filter((l) => l !== lane && !items.some((x) => x.live && !x.coin && x.lane === l && x.t > P - 0.05 && x.t < P + 0.35)); if (opts.length) lane = opts[Math.floor(rnd() * opts.length)]; }
        }
        laneX = damp(laneX, lane, 14, dt);
        ship.position.copy(at(P, laneX, 0.007 + Math.sin(t * 6) * 0.0008 * motion));
        ship.rotation.z = (lane - laneX) * 0.6;
        flame.scale.setScalar(0.8 + Math.sin(t * 40) * 0.25);
        crash = Math.max(0, crash - dt);
        hull.material.emissive.setHex(crash > 0 ? 0xff2040 : 0x000000);
        for (const it of items) {
          if (!it.live) continue;
          it.t -= speed * dt;
          it.m.position.copy(at(it.t, it.lane, 0.008));
          it.m.rotation.set(t * 2, t * 3, 0);
          if (Math.abs(it.t - P) < 0.04 && Math.abs(laneX - it.lane) < 0.5) {
            it.live = false; it.m.visible = false;
            if (it.coin) { score++; best = Math.max(best, score); } else { crash = 0.6; reset(); }
          } else if (it.t < -0.05) { it.live = false; it.m.visible = false; }
        }
      },
      onShow() { paused = false; },
      status: () => `${auto ? 'Demo mode · ' : ''}Score ${score} · Best ${best} · tap left or right to steer`,
      primary: { label: () => 'Restart', run: () => { reset(); auto = false; lastTap = performance.now(); } },
    };
  }

  // ---- CALL: a 3D video call, the caller in front of a room, buttons on the glass ------------
  function buildCall() {
    const g = new THREE.Group();
    const rnd = mulberry32(31);
    // The room behind the caller
    const rC = canvas(1080, 1920), r = rC.getContext('2d');
    r.scale(1.5, 1.5);
    let gr = r.createLinearGradient(0, 0, 0, 1280); gr.addColorStop(0, '#e9d8c4'); gr.addColorStop(1, '#a88466');
    r.fillStyle = gr; r.fillRect(0, 0, 720, 1280);
    for (let i = 0; i < 26000; i++) { r.fillStyle = rnd() < 0.5 ? `rgba(80,50,30,${rnd() * 0.06})` : `rgba(255,250,240,${rnd() * 0.06})`; r.fillRect(rnd() * 720, rnd() * 1280, 0.8 + rnd(), 0.8 + rnd()); }
    const win = r.createLinearGradient(0, 200, 0, 700); win.addColorStop(0, '#fff7e6'); win.addColorStop(1, '#ffd9a0');
    r.fillStyle = '#7a5a3e'; r.fillRect(30, 180, 230, 540); r.fillStyle = win; r.fillRect(44, 194, 202, 512);
    r.fillStyle = '#7a5a3e'; r.fillRect(140, 194, 10, 512); r.fillRect(44, 440, 202, 10);
    const grain = (x0, y0, w, h, vertical) => { for (let i = 0; i < (w * h) / 40; i++) { r.strokeStyle = `rgba(40,22,10,${0.1 + rnd() * 0.2})`; r.lineWidth = 0.5; const gx = x0 + rnd() * w, gy = y0 + rnd() * h; r.beginPath(); r.moveTo(gx, gy); if (vertical) r.lineTo(gx + (rnd() - 0.5) * 2, gy + 10 + rnd() * 30); else r.lineTo(gx + 10 + rnd() * 30, gy + (rnd() - 0.5) * 2); r.stroke(); } };
    grain(30, 180, 14, 540, true); grain(246, 180, 14, 540, true); grain(140, 194, 10, 512, true); grain(30, 180, 230, 14, false); grain(30, 706, 230, 14, false);
    const glowW = r.createRadialGradient(150, 450, 20, 150, 450, 420); glowW.addColorStop(0, 'rgba(255,240,200,0.45)'); glowW.addColorStop(1, 'rgba(255,240,200,0)');
    r.fillStyle = glowW; r.fillRect(0, 0, 720, 1280);
    for (let sh = 0; sh < 4; sh++) {
      const y = 240 + sh * 170;
      r.fillStyle = '#5b3d27'; r.fillRect(420, y + 130, 280, 14); grain(420, y + 130, 280, 14, false);
      let x = 430;
      while (x < 690) { const w = 10 + rnd() * 18, h = 70 + rnd() * 55; r.fillStyle = `hsl(${rnd() * 360},${35 + rnd() * 30}%,${30 + rnd() * 30}%)`; r.fillRect(x, y + 130 - h, w, h); r.fillStyle = 'rgba(255,255,255,0.25)'; r.fillRect(x + 2, y + 140 - h, w - 4, 3); r.fillRect(x + 2, y + 125, w - 4, 2); r.fillStyle = 'rgba(0,0,0,0.25)'; r.fillRect(x + w - 2, y + 130 - h, 2, h); x += w + 2; if (rnd() < 0.08) x += 30; }
    }
    g.add(plane(W * fill(-0.03), H * fill(-0.03), basic(tex(rC)), 0, 0, -0.03));
    // A plant between the room and the caller, for a middle depth layer
    const pC = canvas(256, 512), p = pC.getContext('2d');
    p.fillStyle = '#b4532a'; p.beginPath(); p.moveTo(70, 400); p.lineTo(186, 400); p.lineTo(170, 512); p.lineTo(86, 512); p.fill();
    for (let i = 0; i < 46; i++) {
      const ang = -Math.PI / 2 + (rnd() - 0.5) * 2.4, len = 120 + rnd() * 200, x0 = 128, y0 = 400;
      const x1 = x0 + Math.cos(ang) * len, y1 = y0 + Math.sin(ang) * len;
      p.strokeStyle = '#2f5d2a'; p.lineWidth = 3; p.beginPath(); p.moveTo(x0, y0); p.lineTo(x1, y1); p.stroke();
      p.fillStyle = `hsl(${100 + rnd() * 40},${40 + rnd() * 25}%,${22 + rnd() * 22}%)`;
      p.beginPath(); p.ellipse(x1, y1, 30 + rnd() * 16, 10 + rnd() * 6, ang, 0, 7); p.fill();
    }
    g.add(plane(0.05, 0.1, basic(tex(pC), { transparent: true, alphaTest: 0.5 }), -0.05, -0.06, -0.016));
    // The caller: a stylised, lit bust
    const bust = new THREE.Group();
    bust.position.set(0.006, -0.012, -0.004);
    g.add(bust);
    const skC = canvas(512, 512), sk = skC.getContext('2d');
    sk.fillStyle = '#808080'; sk.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 24000; i++) { sk.fillStyle = rnd() < 0.5 ? 'rgba(40,40,40,0.25)' : 'rgba(220,220,220,0.2)'; sk.fillRect(rnd() * 512, rnd() * 512, 1 + rnd(), 1 + rnd()); }
    const skinBump = new THREE.CanvasTexture(skC); skinBump.wrapS = skinBump.wrapT = THREE.RepeatWrapping; skinBump.repeat.set(3, 3);
    const skin = new THREE.MeshPhysicalMaterial({ color: 0x8d5a3b, roughness: 0.5, bumpMap: skinBump, bumpScale: 0.25, sheen: 0.4, sheenColor: 0xffc9a8, envMap: env, envMapIntensity: 0.3 });
    const fC = canvas(256, 256), f = fC.getContext('2d');
    f.fillStyle = '#2a9d8f'; f.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 16) { f.fillStyle = '#f4a261'; f.fillRect(0, y, 256, 5); f.fillStyle = '#e9c46a'; f.fillRect(0, y + 8, 256, 2); }
    for (let i = 0; i < 4000; i++) { f.fillStyle = `rgba(0,0,0,${rnd() * 0.12})`; f.fillRect(rnd() * 256, rnd() * 256, 1, 2); }
    const fabT = tex(fC, { repeat: true }); fabT.repeat.set(3, 2);
    const shoulders = new THREE.Mesh(new THREE.SphereGeometry(0.05, 64, 32), new THREE.MeshStandardMaterial({ map: fabT, bumpMap: fabT, bumpScale: 0.8, roughness: 0.85 }));
    shoulders.scale.set(1.3, 0.62, 0.55); shoulders.position.set(0, -0.072, -0.006); bust.add(shoulders);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.0105, 0.012, 0.03, 24), skin); neck.position.y = -0.032; bust.add(neck);
    const head = new THREE.Group(); head.position.y = 0.002; bust.add(head);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.026, 48, 32), skin); skull.scale.set(0.92, 1.12, 0.96); head.add(skull);
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x1b1210, roughness: 0.9 });
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.0285, 48, 24, 0, Math.PI * 2, 0, 1.45), hairMat); hair.scale.set(1, 1.15, 1); hair.rotation.x = -0.25; head.add(hair);
    for (let i = 0; i < 95; i++) { const u = rnd() * Math.PI * 2, v = rnd() * 1.15; const c = new THREE.Mesh(new THREE.SphereGeometry(0.006 + rnd() * 0.003, 10, 8), hairMat); c.position.set(Math.sin(v) * Math.cos(u) * 0.029, Math.cos(v) * 0.032 + 0.002, Math.sin(v) * Math.sin(u) * 0.026 - 0.004); head.add(c); }
    const eyeW = new THREE.MeshStandardMaterial({ color: 0xf8f4ee, roughness: 0.3 }), eyeD = new THREE.MeshStandardMaterial({ color: 0x1a0f08, roughness: 0.2 });
    const lids = [];
    for (const sx of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.0042, 20, 14), eyeW); e.position.set(sx * 0.0092, 0.004, 0.0215); head.add(e);
      const pu = new THREE.Mesh(new THREE.SphereGeometry(0.0024, 16, 10), eyeD); pu.position.set(sx * 0.0092, 0.004, 0.0252); head.add(pu);
      const lid = new THREE.Mesh(new THREE.SphereGeometry(0.0046, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), skin); lid.position.copy(e.position); lid.rotation.x = 1.2; lid.scale.y = 0.2; head.add(lid); lids.push(lid);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.009, 0.0016, 0.002), hairMat); brow.position.set(sx * 0.0095, 0.0115, 0.0235); brow.rotation.z = -sx * 0.12; head.add(brow);
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.0055, 16, 10), skin); ear.scale.set(0.5, 1, 0.8); ear.position.set(sx * 0.024, 0.002, 0); head.add(ear);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0028, 0.0006, 8, 20), new THREE.MeshStandardMaterial({ color: 0xffd76a, metalness: 1, roughness: 0.15, envMap: env })); ring.position.set(sx * 0.025, -0.0065, 0.001); ring.rotation.y = Math.PI / 2; head.add(ring);
    }
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.0045, 16, 12), skin); nose.scale.set(1, 0.9, 1); nose.position.set(0, -0.0035, 0.026); head.add(nose);
    const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.0062, 0.0013, 8, 24, Math.PI), new THREE.MeshStandardMaterial({ color: 0x5a1e1e, roughness: 0.4 }));
    mouth.rotation.z = Math.PI; mouth.position.set(0, -0.0105, 0.0225); head.add(mouth);
    // Caption with a running timer
    const capC = canvas(1024, 220), capT = tex(capC);
    const cap = plane(0.11, 0.0236, basic(capT, { transparent: true, depthWrite: false }), 0, 0.085, 0.008); cap.renderOrder = 6; g.add(cap);
    let started = performance.now(), capKey = '';
    const drawCap = () => {
      const secs = Math.floor((performance.now() - started) / 1000), k = String(secs);
      if (k === capKey) return; capKey = k;
      const x = capC.getContext('2d'); x.clearRect(0, 0, 1024, 220);
      x.fillStyle = 'rgba(13,9,39,0.55)'; x.beginPath(); x.roundRect(212, 20, 600, 180, 40); x.fill();
      x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.font = `700 72px ${FONT}`; x.fillText('Amara', 512, 105);
      x.fillStyle = '#c4bffd'; x.font = `500 46px ${FONT}`; x.fillText(`3D video call · ${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`, 512, 170);
      capT.needsUpdate = true;
    };
    // Self view in the corner, just in front of the glass
    const sC = canvas(256, 400), sv = sC.getContext('2d');
    gr = sv.createLinearGradient(0, 0, 0, 400); gr.addColorStop(0, '#3b3486'); gr.addColorStop(1, '#141033'); sv.fillStyle = gr; sv.fillRect(0, 0, 256, 400);
    sv.fillStyle = '#c68a5e'; sv.beginPath(); sv.ellipse(128, 170, 52, 64, 0, 0, 7); sv.fill();
    sv.fillStyle = '#2b2a6b'; sv.beginPath(); sv.ellipse(128, 400, 120, 120, 0, Math.PI, 0); sv.fill();
    sv.fillStyle = '#3a2418'; sv.beginPath(); sv.ellipse(128, 130, 56, 36, 0, Math.PI, 0); sv.fill();
    sv.strokeStyle = '#ffffff'; sv.lineWidth = 10; sv.strokeRect(5, 5, 246, 390);
    sv.fillStyle = '#ffffff'; sv.font = `600 34px ${FONT}`; sv.fillText('You', 18, 380);
    g.add(plane(0.03, 0.047, basic(tex(sC)), 0.042, -0.06, 0.012));
    // Buttons: mute, camera, end
    const btns = [];
    [['mic', 0x3a3366, -0.03], ['cam', 0x3a3366, 0], ['end', 0xe0314f, 0.03]].forEach(([kind, col, x]) => {
      const c = canvas(128, 128), b = c.getContext('2d');
      b.fillStyle = `#${col.toString(16).padStart(6, '0')}`; b.fillRect(0, 0, 128, 128);
      b.fillStyle = '#ffffff'; b.strokeStyle = '#ffffff'; b.lineWidth = 8; b.lineCap = 'round';
      if (kind === 'mic') { b.beginPath(); b.roundRect(50, 26, 28, 50, 14); b.fill(); b.beginPath(); b.arc(64, 62, 26, 0, Math.PI); b.stroke(); b.beginPath(); b.moveTo(64, 88); b.lineTo(64, 104); b.stroke(); }
      if (kind === 'cam') { b.beginPath(); b.roundRect(26, 42, 52, 44, 8); b.fill(); b.beginPath(); b.moveTo(82, 64); b.lineTo(104, 46); b.lineTo(104, 82); b.closePath(); b.fill(); }
      if (kind === 'end') { b.save(); b.translate(64, 70); b.rotate(Math.PI * 0.75); b.beginPath(); b.roundRect(-12, -34, 24, 68, 12); b.fill(); b.restore(); }
      const side = new THREE.MeshStandardMaterial({ color: col, roughness: 0.4 });
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.0085, 0.004, 40), [side, new THREE.MeshStandardMaterial({ map: tex(c), roughness: 0.4 }), side]);
      m.rotation.x = Math.PI / 2; m.position.set(x, -0.1, 0.014); m.userData.kind = kind; g.add(m); btns.push(m);
    });
    let muted = false, blinkAt = 2;
    return {
      group: g,
      pick: btns,
      tap(hit) { const k = hit.object.userData.kind; if (k === 'end') setApp('home'); if (k === 'mic') muted = !muted; },
      onShow() { started = performance.now(); capKey = ''; },
      update(t) {
        drawCap();
        head.rotation.y = Math.sin(t * 0.6) * 0.25 * motion;
        head.rotation.x = Math.sin(t * 1.1) * 0.06 * motion;
        head.rotation.z = Math.sin(t * 0.45) * 0.05 * motion;
        mouth.scale.y = 1 + Math.max(0, Math.sin(t * 9) * Math.sin(t * 1.3)) * 1.4 * motion;
        const blink = (t % 4) > blinkAt && (t % 4) < blinkAt + 0.12;
        for (const l of lids) l.scale.y = blink ? 1 : 0.2;
        bust.position.y = -0.012 + Math.sin(t * 1.6) * 0.0008 * motion;
      },
      status: () => (muted ? 'Muted · ' : '') + 'Face to face, in depth · tap the red button to hang up',
      primary: { label: () => muted ? 'Unmute' : 'Mute', run: () => { muted = !muted; } },
    };
  }

  // ---- LEARN: a procedural Earth with clouds, a moon that passes in front, and satellites ----
  function buildLearn() {
    const g = new THREE.Group();
    const rnd = mulberry32(41);
    const stC = canvas(512, 1024), s = stC.getContext('2d');
    const gr = s.createRadialGradient(360, 300, 20, 360, 300, 600); gr.addColorStop(0, '#2a1f6e'); gr.addColorStop(0.5, '#120c3a'); gr.addColorStop(1, '#05030f');
    s.fillStyle = gr; s.fillRect(0, 0, 512, 1024);
    for (let i = 0; i < 1400; i++) { const r = rnd() < 0.96 ? 0.6 + rnd() : 1.6 + rnd() * 1.4; s.fillStyle = `hsla(${200 + rnd() * 80},80%,${80 + rnd() * 20}%,${0.3 + rnd() * 0.7})`; s.beginPath(); s.arc(rnd() * 512, rnd() * 1024, r, 0, 7); s.fill(); }
    g.add(plane(W * fill(-0.034), H * fill(-0.034), basic(tex(stC)), 0, 0, -0.034));
    // Earth texture from 3D noise, so it has no seam
    const ew = 1536, eh = 768, eC = canvas(ew, eh), e = eC.getContext('2d'), img = e.createImageData(ew, eh);
    const bC = canvas(ew, eh), b = bC.getContext('2d'), bimg = b.createImageData(ew, eh);
    const rC2 = canvas(ew, eh), r2 = rC2.getContext('2d'), rimg = r2.createImageData(ew, eh);
    for (let y = 0; y < eh; y++) {
      const lat = (0.5 - y / eh) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
      for (let x = 0; x < ew; x++) {
        const lon = (x / ew) * Math.PI * 2, dx = cl * Math.cos(lon), dz = cl * Math.sin(lon);
        const h = fbm3(dx * 1.8 + 5, sl * 1.8 + 5, dz * 1.8 + 5, 5, 3);
        const i = (y * ew + x) * 4, polar = Math.abs(sl);
        let r, gg, bb;
        if (h < 0.52) { const dd = h / 0.52; r = 10 + dd * 30; gg = 40 + dd * 80; bb = 90 + dd * 110; }
        else {
          const hh = (h - 0.52) / 0.3, dry = clamp(1 - Math.abs(sl - 0.35) * 3, 0, 1) * 0.7;
          r = lerp(lerp(50, 190, dry), 140, hh); gg = lerp(lerp(110, 165, dry), 120, hh); bb = lerp(lerp(45, 100, dry), 100, hh);
          if (hh > 0.7) { r = g2(r); gg = g2(gg); bb = g2(bb); }
        }
        if (polar > 0.88) { const k = clamp((polar - 0.88) / 0.06, 0, 1); r = lerp(r, 240, k); gg = lerp(gg, 245, k); bb = lerp(bb, 250, k); }
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = bb; img.data[i + 3] = 255;
        const bv = h < 0.52 ? 0 : (h - 0.52) * 600; bimg.data[i] = bimg.data[i + 1] = bimg.data[i + 2] = clamp(bv, 0, 255); bimg.data[i + 3] = 255;
        rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = h < 0.52 ? 50 : 215; rimg.data[i + 3] = 255;
      }
    }
    function g2(v) { return lerp(v, 235, 0.5); }
    e.putImageData(img, 0, 0); b.putImageData(bimg, 0, 0); r2.putImageData(rimg, 0, 0);
    const earth = new THREE.Mesh(new THREE.SphereGeometry(0.043, 96, 64), new THREE.MeshStandardMaterial({ map: tex(eC), bumpMap: new THREE.CanvasTexture(bC), bumpScale: 0.8, roughnessMap: new THREE.CanvasTexture(rC2), roughness: 1, metalness: 0, envMap: env, envMapIntensity: 0.5 }));
    earth.position.set(0, 0.005, -0.006); earth.rotation.z = 0.41;
    g.add(earth);
    const cw = 512, ch = 256, cC = canvas(cw, ch), cc = cC.getContext('2d'), cimg = cc.createImageData(cw, ch);
    for (let y = 0; y < ch; y++) {
      const lat = (0.5 - y / ch) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
      for (let x = 0; x < cw; x++) {
        const lon = (x / cw) * Math.PI * 2, n = fbm3(cl * Math.cos(lon) * 3 + 9, sl * 3 + 9, cl * Math.sin(lon) * 3 + 9, 4, 17);
        const i = (y * cw + x) * 4; cimg.data[i] = cimg.data[i + 1] = cimg.data[i + 2] = 255; cimg.data[i + 3] = clamp((n - 0.5) * 900, 0, 220);
      }
    }
    cc.putImageData(cimg, 0, 0);
    const clouds = new THREE.Mesh(new THREE.SphereGeometry(0.0442, 72, 48), new THREE.MeshStandardMaterial({ map: tex(cC), transparent: true, depthWrite: false, roughness: 1 }));
    earth.add(clouds);
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(0.046, 64, 32), new THREE.MeshBasicMaterial({ color: 0x6fa8ff, transparent: true, opacity: 0.12, side: THREE.BackSide }));
    atmo.position.copy(earth.position); g.add(atmo);
    // Moon
    const mC = canvas(1024, 512), mx = mC.getContext('2d');
    mx.scale(2, 2);
    mx.fillStyle = '#9a96a0'; mx.fillRect(0, 0, 512, 256);
    for (let i = 0; i < 9000; i++) { mx.fillStyle = `rgba(${rnd() < 0.5 ? '40,38,48' : '230,228,236'},${rnd() * 0.12})`; mx.fillRect(rnd() * 512, rnd() * 256, 0.6, 0.6); }
    for (let i = 0; i < 650; i++) { const x = rnd() * 512, y = rnd() * 256, r = 2 + Math.pow(rnd(), 3) * 26; mx.fillStyle = `rgba(60,55,70,${0.2 + rnd() * 0.3})`; mx.beginPath(); mx.arc(x, y, r, 0, 7); mx.fill(); mx.strokeStyle = 'rgba(230,228,235,0.35)'; mx.lineWidth = 1.5; mx.beginPath(); mx.arc(x - 1, y - 1, r, Math.PI, Math.PI * 1.6); mx.stroke(); }
    const moonT = tex(mC);
    const moon = new THREE.Mesh(new THREE.SphereGeometry(0.009, 64, 48), new THREE.MeshStandardMaterial({ map: moonT, bumpMap: moonT, bumpScale: 0.6, roughness: 1 }));
    g.add(moon);
    const sats = [0, 1, 2].map((i) => {
      const s2 = new THREE.Group();
      s2.add(new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.003, 0.004), new THREE.MeshStandardMaterial({ color: 0xffd76a, metalness: 0.9, roughness: 0.3 })));
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.0005, 0.003), new THREE.MeshStandardMaterial({ color: 0x482bd9, metalness: 0.5, roughness: 0.3, emissive: 0x1a0f60 }));
      s2.add(panel); g.add(s2);
      return { s2, r: 0.054 + i * 0.004, sp: 0.9 - i * 0.2, tilt: 0.5 + i * 0.6, ph: i * 2.1 };
    });
    // Label
    const lC = canvas(1024, 200), lx = lC.getContext('2d');
    lx.textAlign = 'center'; lx.fillStyle = '#ffffff'; lx.font = `700 76px ${FONT}`; lx.fillText('Our planet', 512, 90);
    lx.fillStyle = '#c4bffd'; lx.font = `500 44px ${FONT}`; lx.fillText('Tap the Earth to spin it', 512, 160);
    const label = plane(0.1, 0.0195, basic(tex(lC), { transparent: true, depthWrite: false }), 0, 0.088, 0.006); label.renderOrder = 6; g.add(label);
    let spin = 0.25;
    return {
      group: g,
      pick: [earth],
      tap() { spin = 3; },
      update(t, dt) {
        spin = damp(spin, 0.25, 0.8, dt);
        earth.rotation.y += spin * dt * motion;
        clouds.rotation.y += 0.03 * dt * motion;
        const ma = t * 0.45 * motion;
        moon.position.set(Math.cos(ma) * 0.058, 0.005 + Math.sin(ma) * 0.012, -0.006 + Math.sin(ma) * 0.03);
        moon.rotation.y = -ma;
        for (const o of sats) {
          const an = t * o.sp * motion + o.ph;
          o.s2.position.set(Math.cos(an) * o.r, 0.005 + Math.sin(an) * Math.sin(o.tilt) * o.r * 0.5, -0.006 + Math.sin(an) * Math.cos(o.tilt) * o.r * 0.55);
          o.s2.rotation.set(an, an * 0.5, 0);
        }
      },
      status: () => 'A planet that floats in front of the glass · the moon passes in front',
      primary: { label: () => 'Spin the Earth', run: () => { spin = 3; } },
    };
  }

  // ---- app switching, the 2D/3D switch, and the tile API ------------------------------------
  let current = null, depthOn = true, depthK = 1, pop = 1;
  const api = {
    group,
    pick: [],
    tap(hit) { current?.tap?.(hit); },
    update(now, dt) {
      depthK = damp(depthK, depthOn ? 1 : 0, 7, dt);
      stage.scale.z = Math.max(0.002, depthK);
      pop = damp(pop, 1, 9, dt);
      if (current) { current.group.scale.set(pop, pop, 1); current.update(now, dt); }
      drawStatusBar(depthOn);
    },
    status() { return `${depthOn ? '' : '2D mode · '}${current ? current.status() : ''}`; },
    actions: [
      { label: () => current?.primary.label() ?? '', run: () => current?.primary.run() },
      { label: () => depthOn ? 'Switch to 2D' : 'Switch to 3D', run: () => { depthOn = !depthOn; } },
      { label: () => 'Home', run: () => setApp('home') },
    ],
    setApp,
    setDepth(on) { depthOn = on; },
  };
  function setApp(n, quiet = false) {
    if (!builders[n]) return;
    const next = app(n);
    if (current && current !== next) current.group.visible = false;
    current = next;
    current.group.visible = true;
    current.onShow?.();
    api.pick = current.pick;
    pop = 0.9;
    if (!quiet) ctx.onApp?.(n);
  }
  setApp('home', true);
  return api;
}

// ---- DEVICE: the phone itself on a turntable --------------------------------------------------
// Real proportions (about 164 x 74 x 7.3 mm), curved edges, a lit screen with the home screen on
// it, and a theme-specific back: 'generic' is graphite with a square two-lens island; 'camon' is
// a frosted green back with a tall three-camera island. No logos or brand marks on either.
function buildDevice(THREE, motion, ctx) {
  const camon = ctx.theme === 'camon';
  const theme = THEMES[ctx.theme] || THEMES.generic;
  const env = makeStudio(THREE);
  const rnd = mulberry32(53);
  const tex = (c) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
  const group = new THREE.Group();
  group.add(new THREE.HemisphereLight(0xe9e5ff, 0x1a1236, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(-0.4, 0.5, 0.8); group.add(key);
  const rim = new THREE.DirectionalLight(camon ? 0x9fffe0 : 0xc4bffd, 1.8); rim.position.set(0.6, -0.2, -0.6); group.add(rim);

  // A soft glow behind the phone, on the far plane, so the silhouette reads against depth
  const gC = canvas(512, 512), gg = gC.getContext('2d'), rg = gg.createRadialGradient(256, 256, 10, 256, 256, 256);
  rg.addColorStop(0, camon ? 'rgba(79,174,147,0.55)' : 'rgba(132,127,234,0.55)'); rg.addColorStop(1, 'rgba(13,9,39,0)');
  gg.fillStyle = rg; gg.fillRect(0, 0, 512, 512);
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), new THREE.MeshBasicMaterial({ map: tex(gC), transparent: true, depthWrite: false }));
  halo.position.z = -0.034; group.add(halo);

  const S = 0.95;                          // 95 % of life size: turning sweeps about +-3.5 cm, inside the comfort budget
  const PW = 0.0743, PH = 0.1644, PD = 0.0073, R = 0.0105, bev = 0.0024;
  const phone = new THREE.Group(); phone.scale.setScalar(S); group.add(phone);
  const rr = (w, h, r) => {
    const s = new THREE.Shape();
    s.moveTo(-w / 2 + r, -h / 2); s.lineTo(w / 2 - r, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    s.lineTo(w / 2, h / 2 - r); s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2); s.lineTo(-w / 2 + r, h / 2);
    s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r); s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
    return s;
  };
  // ShapeGeometry UVs are in metres; remap them to 0..1 over the shape's box
  const flat = (w, h, r) => {
    const geo = new THREE.ShapeGeometry(rr(w, h, r), 24), uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / w + 0.5, uv.getY(i) / h + 0.5);
    return geo;
  };
  const bodyGeo = new THREE.ExtrudeGeometry(rr(PW - 2 * bev, PH - 2 * bev, R - bev), { depth: PD - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 10, curveSegments: 28 });
  bodyGeo.translate(0, 0, -(PD - 2 * bev) / 2);
  const frameMat = new THREE.MeshPhysicalMaterial({ color: camon ? 0x2f6b5c : 0x2a2d36, metalness: 0.9, roughness: 0.26, clearcoat: 0.6, envMap: env, envMapIntensity: 1.2 });
  const body = new THREE.Mesh(bodyGeo, frameMat); phone.add(body);
  for (const [y, h] of [[0.03, 0.022], [0.0, 0.012]]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.0012, h, 0.0028), frameMat); b.position.set(PW / 2 + 0.0002, y, 0); phone.add(b);
  }

  // Screen: the home screen, a centred punch-hole camera, a glass layer that catches reflections
  const sC = canvas(720, 1600), s = sC.getContext('2d');
  const sg = s.createLinearGradient(0, 0, 0, 1600);
  sg.addColorStop(0, theme.sky[0]); sg.addColorStop(0.4, theme.sky[1]); sg.addColorStop(0.68, theme.sky[2]); sg.addColorStop(0.86, theme.sky[3]);
  s.fillStyle = sg; s.fillRect(0, 0, 720, 1600);
  for (let i = 0; i < 500; i++) { s.fillStyle = `rgba(255,255,255,${rnd() * 0.8})`; s.fillRect(rnd() * 720, rnd() * 640, 1.2, 1.2); }
  const ridge = noise1Factory(9);
  theme.ridges.forEach(([top, bot], li) => {
    const base = 980 + li * 200, amp = 260 - li * 50;
    s.beginPath(); s.moveTo(0, 1600);
    for (let x = 0; x <= 720; x += 3) s.lineTo(x, base - ridge(x * 0.006 + li * 30) * amp);
    s.lineTo(720, 1600); s.closePath();
    const lg = s.createLinearGradient(0, base - amp, 0, 1600); lg.addColorStop(0, top); lg.addColorStop(1, bot);
    s.fillStyle = lg; s.fill();
  });
  s.fillStyle = '#ffffff'; s.textAlign = 'center'; s.font = `300 170px ${FONT}`; s.fillText('09:41', 360, 420);
  s.font = `500 40px ${FONT}`; s.fillText('Glasses-free 3D', 360, 490);
  const icons = ['#e2366f', '#482BD9', '#139a6a', '#d9822b'];
  icons.forEach((c, i) => { s.fillStyle = c; s.beginPath(); s.roundRect(110 + i * 135, 1360, 96, 96, 26); s.fill(); });
  s.fillStyle = '#482BD9'; s.beginPath(); s.roundRect(300, 540, 120, 52, 26); s.fill();
  s.fillStyle = '#ffffff'; s.font = `700 32px ${FONT}`; s.fillText('3D', 360, 577);
  s.fillStyle = '#000000'; s.beginPath(); s.arc(360, 52, 20, 0, 7); s.fill();
  const SW = PW - 2 * bev + 0.0012, SH = PH - 2 * bev + 0.0012;
  const screen = new THREE.Mesh(flat(SW, SH, R - bev), new THREE.MeshBasicMaterial({ map: tex(sC) }));
  screen.position.z = PD / 2 + 0.00005; phone.add(screen);
  const glass = new THREE.Mesh(flat(SW, SH, R - bev), new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.16, clearcoat: 1, envMap: env, envMapIntensity: 1.4, depthWrite: false }));
  glass.position.z = PD / 2 + 0.0002; phone.add(glass);

  // Back: frosted, finely textured glass; the camera island sits top-left as seen from behind
  const bC = canvas(720, 1600), b = bC.getContext('2d');
  const bg = b.createLinearGradient(0, 0, 720, 1600);
  if (camon) { bg.addColorStop(0, '#0b3d33'); bg.addColorStop(0.45, '#1f6f5c'); bg.addColorStop(0.75, '#5fae95'); bg.addColorStop(1, '#2c7d68'); }
  else { bg.addColorStop(0, '#1b1d24'); bg.addColorStop(0.5, '#363944'); bg.addColorStop(1, '#202229'); }
  b.fillStyle = bg; b.fillRect(0, 0, 720, 1600);
  for (let i = 0; i < 60000; i++) { b.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${rnd() * 0.07})` : `rgba(0,0,0,${rnd() * 0.08})`; b.fillRect(rnd() * 720, rnd() * 1600, 1, 1); }
  if (camon) {
    // Faint ripples across the frosted green, like wind on a lake
    for (let k = 0; k < 70; k++) {
      const y0 = rnd() * 1600, amp = 6 + rnd() * 14, f = 0.008 + rnd() * 0.01;
      b.strokeStyle = `rgba(220,255,240,${0.04 + rnd() * 0.06})`; b.lineWidth = 1 + rnd() * 1.5; b.beginPath();
      for (let x = 0; x <= 720; x += 6) b.lineTo(x, y0 + Math.sin(x * f + k) * amp + x * 0.25);
      b.stroke();
    }
  } else {
    for (let k = 0; k < 1600; k += 2) { b.fillStyle = `rgba(255,255,255,${rnd() * 0.035})`; b.fillRect(0, k, 720, 1); }
  }
  const back = new THREE.Group(); back.rotation.y = Math.PI; back.position.z = -PD / 2; phone.add(back);
  const backMat = new THREE.MeshPhysicalMaterial({ map: tex(bC), roughness: camon ? 0.42 : 0.3, metalness: 0.1, clearcoat: 1, clearcoatRoughness: camon ? 0.35 : 0.1, envMap: env, envMapIntensity: 1 });
  const backPlate = new THREE.Mesh(flat(SW, SH, R - bev), backMat); backPlate.position.z = 0.00005; back.add(backPlate);

  const metal = new THREE.MeshPhysicalMaterial({ color: camon ? 0xd8e3dc : 0xb9bcc6, metalness: 1, roughness: 0.18, envMap: env, envMapIntensity: 1.3 });
  const lensGlass = new THREE.MeshPhysicalMaterial({ color: 0x04060a, roughness: 0.04, clearcoat: 1, envMap: env, envMapIntensity: 1.5 });
  const coating = new THREE.MeshStandardMaterial({ color: 0x2a4a9a, emissive: 0x0c1a44, metalness: 0.6, roughness: 0.2 });
  const lens = (x, y, rOut) => {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(rOut, rOut, 0.0016, 56), metal); ring.rotation.x = Math.PI / 2; ring.position.set(x, y, 0.0022); back.add(ring);
    const gl = new THREE.Mesh(new THREE.CylinderGeometry(rOut * 0.78, rOut * 0.78, 0.0018, 56), lensGlass); gl.rotation.x = Math.PI / 2; gl.position.set(x, y, 0.0024); back.add(gl);
    const co = new THREE.Mesh(new THREE.TorusGeometry(rOut * 0.42, rOut * 0.05, 8, 40), coating); co.position.set(x, y, 0.0034); back.add(co);
  };
  const island = (w, h, r, x, y, color) => {
    const geo = new THREE.ExtrudeGeometry(rr(w, h, r), { depth: 0.0006, bevelEnabled: true, bevelThickness: 0.0005, bevelSize: 0.0006, bevelSegments: 4, curveSegments: 20 });
    const m = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ color, roughness: 0.12, metalness: 0.3, clearcoat: 1, envMap: env, envMapIntensity: 1.2 }));
    m.position.set(x, y, 0.0002); back.add(m);
  };
  if (camon) {
    const ix = -PW / 2 + 0.0195, iy = PH / 2 - 0.037;
    island(0.027, 0.06, 0.0125, ix, iy, 0x0b1a16);
    lens(ix, iy + 0.0185, 0.0088); lens(ix, iy, 0.0088); lens(ix, iy - 0.0185, 0.0072);
    const flash = new THREE.Mesh(new THREE.CylinderGeometry(0.0026, 0.0026, 0.0008, 28), new THREE.MeshStandardMaterial({ color: 0xfff3d6, emissive: 0x6a5a30, roughness: 0.3 }));
    flash.rotation.x = Math.PI / 2; flash.position.set(ix + 0.0205, iy + 0.02, 0.0006); back.add(flash);
  } else {
    const ix = -PW / 2 + 0.021, iy = PH / 2 - 0.022;
    island(0.03, 0.03, 0.008, ix, iy, 0x15161b);
    lens(ix - 0.0062, iy + 0.0062, 0.0062); lens(ix + 0.0062, iy - 0.0062, 0.0062);
    const flash = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0022, 0.0008, 28), new THREE.MeshStandardMaterial({ color: 0xfff3d6, emissive: 0x6a5a30, roughness: 0.3 }));
    flash.rotation.x = Math.PI / 2; flash.position.set(ix + 0.0062, iy + 0.0062, 0.0012); back.add(flash);
  }

  let turn = 0, target = null, spinning = true;
  return {
    group,
    pick: [body, screen, backPlate],
    tap() { target = (Math.round(turn / Math.PI) + 1) * Math.PI; },
    update(t, dt) {
      if (target !== null) { turn = damp(turn, target, 5, dt); if (Math.abs(turn - target) < 0.002) { turn = target; target = null; } }
      else if (spinning) turn += dt * 0.45 * motion;
      phone.rotation.set(Math.sin(t * 0.5) * 0.1 * motion, turn, Math.sin(t * 0.35) * 0.04 * motion);
      phone.position.y = Math.sin(t * 0.8) * 0.002 * motion;
    },
    status() {
      const front = Math.cos(turn) > 0;
      return camon
        ? (front ? 'Front · curved edges, centred punch-hole camera · tap to flip' : 'Back · frosted green glass, tall three-camera island · tap to flip')
        : (front ? 'Front · a curved 3D screen · tap to flip' : 'Back · camera island · tap to flip');
    },
    actions: [
      { label: () => 'Flip', run: () => { target = (Math.round(turn / Math.PI) + 1) * Math.PI; } },
      { label: () => spinning ? 'Stop turning' : 'Turn', run: () => { spinning = !spinning; } },
    ],
  };
}

export function buildScene(THREE, name, motion = 1, ctx = {}) {
  return name === 'device' ? buildDevice(THREE, motion, ctx) : buildPhone(THREE, motion, ctx);
}
