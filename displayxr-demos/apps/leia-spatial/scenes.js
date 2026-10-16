// Seven interactive three.js scenes, one per woven tile.
//
// Authored in "u" units and scaled by S into metres for a 0.24 m virtual display (the SDK
// default). z = 0 is the glass, +z is out toward the viewer. Content stays within about +6 cm in
// front and -6 cm behind, so every scene is comfortable at the display rig's natural depth.
//
// Each builder returns:
//   group          the scene root (the tile wraps it in a drag turntable)
//   update(t, dt)  per frame
//   status()       caption text
//   pick           objects a tap can hit (optional)
//   tap(hit)       a raycast hit on one of them (optional)
//   hover(nx, ny)  pointer over the tile in -1..1, or null when it leaves (optional)
//   actions        [{ label: () => string, run() }] rendered as buttons under the tile (optional)
//   select(i)      external selection, used by the stack list (optional)
// Every scene runs on its own when nobody touches it and goes back to that after ~10 s idle.

export const S = 0.06;              // 1 u = 6 cm
export const BG = 0x0b1519;         // tile clear colour, matches --tile in style.css

const LEFT = 0xff6a55;              // left-eye red, as in the page palette
const RIGHT = 0x46d9e3;             // right-eye cyan
const IDLE = 10;                    // seconds without input before a scene resumes its loop
const FONT_URL = 'https://cdn.jsdelivr.net/npm/three@0.161.0/examples/fonts/helvetiker_bold.typeface.json';

// ---- helpers -------------------------------------------------------------------------------

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => { const x = clamp((v - a) / (b - a)); return x * x * (3 - 2 * x); };
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const easeOutBack = (x) => { const c = 1.6; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; };

// Extruded type: three's FontLoader + TextGeometry, loaded once and shared by every tile.
let fontPromise = null;
function loadFont() {
  if (!fontPromise) {
    fontPromise = (async () => {
      const [{ FontLoader }, { TextGeometry }] = await Promise.all([
        import('three/addons/loaders/FontLoader.js'),
        import('three/addons/geometries/TextGeometry.js'),
      ]);
      const font = await new FontLoader().loadAsync(FONT_URL);
      return { font, TextGeometry };
    })().catch((e) => { console.warn('[leia-spatial] 3D font unavailable', e); return null; });
  }
  return fontPromise;
}
function textGeo(f, str, size, depth) {
  const g = new f.TextGeometry(str, {
    font: f.font, size, height: depth, depth, curveSegments: 5,
    bevelEnabled: true, bevelThickness: depth * 0.15, bevelSize: size * 0.04, bevelSegments: 2,
  });
  g.center();
  return g;
}

// ---- shared procedural artwork -------------------------------------------------------------
// One landscape drawn three ways: flat colour, an interlaced L/R version (what a woven panel
// holds), and a depth map (white is near) that the 2D-to-3D scene lifts into points.

let art = null;
function getArt() {
  if (art) return art;
  const W = 1024, H = 640;
  const make = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const flat = make(), depth = make(), woven = make(), coarse = make();
  drawLandscape(flat.getContext('2d'), W, H, false);
  drawLandscape(depth.getContext('2d'), W, H, true);
  const wc = woven.getContext('2d');
  for (let x = 0, i = 0; x < W; x += 4, i++) {
    wc.drawImage(flat, x + (i % 2 ? -6 : 6), 0, 4, H, x, 0, 4, H);
    wc.fillStyle = i % 2 ? 'rgba(70,217,227,0.16)' : 'rgba(255,106,85,0.16)';
    wc.fillRect(x, 0, 4, H);
  }
  // Coarse: the same picture at a ninth of the resolution, which is what multiview leaves each view.
  const small = document.createElement('canvas'); small.width = W / 9 | 0; small.height = H / 9 | 0;
  small.getContext('2d').drawImage(flat, 0, 0, small.width, small.height);
  const cc = coarse.getContext('2d'); cc.imageSmoothingEnabled = false;
  cc.drawImage(small, 0, 0, W, H);
  art = { W, H, flat, depth, woven, coarse };
  return art;
}

function ridge(x, seed) {
  return 0.5 + 0.5 * Math.sin(x * 0.0061 * (1 + seed * 0.37) + seed * 1.7) * Math.cos(x * 0.0132 + seed * 2.3);
}

function drawLandscape(ctx, W, H, asDepth) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  if (asDepth) { g.addColorStop(0, '#000'); g.addColorStop(1, '#0d0d0d'); }
  else { g.addColorStop(0, '#0d2633'); g.addColorStop(0.55, '#2b6c78'); g.addColorStop(1, '#f0ad78'); }
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = asDepth ? '#141414' : '#ffd9a2';
  ctx.beginPath(); ctx.arc(W * 0.68, H * 0.4, H * 0.1, 0, Math.PI * 2); ctx.fill();
  const layers = [
    { y: 0.6, amp: 0.13, col: '#1e4a58', d: '#404040', seed: 1 },
    { y: 0.72, amp: 0.1, col: '#163640', d: '#808080', seed: 2 },
    { y: 0.86, amp: 0.07, col: '#0a1c21', d: '#c4c4c4', seed: 3 },
  ];
  for (const L of layers) {
    ctx.fillStyle = asDepth ? L.d : L.col;
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) ctx.lineTo(x, H * (L.y - L.amp * ridge(x, L.seed)));
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  }
  const ox = W * 0.3, oy = H * 0.68, r = H * 0.09;
  if (asDepth) ctx.fillStyle = '#ffffff';
  else {
    const og = ctx.createRadialGradient(ox - r * 0.3, oy - r * 0.3, r * 0.1, ox, oy, r);
    og.addColorStop(0, '#ffd2c8'); og.addColorStop(0.5, '#ff6a55'); og.addColorStop(1, '#8a2a20');
    ctx.fillStyle = og;
  }
  ctx.beginPath(); ctx.arc(ox, oy, r, 0, Math.PI * 2); ctx.fill();
}

function lights(THREE, group) {
  group.add(new THREE.HemisphereLight(0xcdefff, 0x0b1416, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(0.15, 0.25, 0.4);
  group.add(key);
  const l = new THREE.PointLight(LEFT, 0.12); l.position.set(-0.22, 0.05, 0.18);
  const r = new THREE.PointLight(RIGHT, 0.12); r.position.set(0.22, 0.05, 0.18);
  group.add(l, r);
}

function texture(THREE, canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function root(THREE, group) {
  const r = new THREE.Group();
  r.scale.setScalar(S);
  group.add(r);
  return r;
}

// Tracks the last input so a scene can fall back to its own loop when left alone.
function idleClock() {
  let last = -1e9, now = 0;
  return {
    tick(t) { now = t; },
    poke() { last = now; },
    get now() { return now; },
    get idle() { return now - last > IDLE; },
  };
}

// A 3D display: bezel, screen and a switchable lens layer of vertical half-cylinder ribs.
// setDepth(0) is 2D (lens index-matched and flat, pop-out objects pressed onto the glass),
// setDepth(1) is full 3D.
function makeDisplay(THREE, { w = 4, h = 2.5, pop = true } = {}) {
  const a = getArt();
  const g = new THREE.Group();
  const bezel = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.18, h + 0.18, 0.14),
    new THREE.MeshStandardMaterial({ color: 0x1a252a, metalness: 0.55, roughness: 0.38 }),
  );
  bezel.position.z = -0.075;
  g.add(bezel);

  const tex = { flat: texture(THREE, a.flat), woven: texture(THREE, a.woven), coarse: texture(THREE, a.coarse) };
  const screenMat = new THREE.MeshBasicMaterial({ map: tex.woven, toneMapped: false });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(w, h), screenMat);
  screen.position.z = 0.002;
  g.add(screen);

  const n = 40, pitch = w / n;
  const ribGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1, true, -Math.PI / 2, Math.PI);
  const ribMat = new THREE.MeshStandardMaterial({
    color: 0xb4ecf4, emissive: 0x0a3a44, transparent: true, opacity: 0.22,
    roughness: 0.12, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false,
  });
  const ribs = new THREE.InstancedMesh(ribGeo, ribMat, n);
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    m.makeScale(pitch, h, pitch * 0.7);
    m.setPosition(-w / 2 + pitch * (i + 0.5), 0, 0);
    ribs.setMatrixAt(i, m);
  }
  const lens = new THREE.Group();
  lens.position.z = 0.012;
  lens.add(ribs);
  g.add(lens);

  const objs = [];
  if (pop) {
    const add = (geo, mat, x, y, z0, spin) => {
      const o = new THREE.Mesh(geo, mat);
      o.position.set(x, y, z0);
      o.userData = { z0, spin, boost: 0 };
      objs.push(o); g.add(o);
    };
    add(new THREE.TorusKnotGeometry(0.36, 0.11, 120, 16),
      new THREE.MeshStandardMaterial({ color: 0xf1ece2, metalness: 0.35, roughness: 0.22 }), -0.95, 0.05, 0.95, 0.5);
    add(new THREE.IcosahedronGeometry(0.34, 0),
      new THREE.MeshStandardMaterial({ color: RIGHT, metalness: 0.2, roughness: 0.35, flatShading: true }), 1.05, -0.45, 0.65, -0.4);
    add(new THREE.SphereGeometry(0.2, 32, 16),
      new THREE.MeshStandardMaterial({ color: LEFT, metalness: 0.1, roughness: 0.3 }), 0.35, 0.55, 1.1, 0);
    add(new THREE.BoxGeometry(0.28, 0.28, 0.28),
      new THREE.MeshStandardMaterial({ color: 0xd9e4e2, metalness: 0.6, roughness: 0.3 }), 0.05, -0.75, 0.35, 0.8);
  }

  let depth = 1;
  function setDepth(d) {
    depth = d;
    lens.scale.z = 0.04 + 0.96 * d;
    ribMat.opacity = 0.05 + 0.19 * d;
    screenMat.map = d > 0.5 ? tex.woven : tex.flat;
    for (const o of objs) {
      o.position.z = 0.06 + o.userData.z0 * d;
      o.scale.set(1, 1, 0.08 + 0.92 * d);
    }
  }
  function useTexture(name) { screenMat.map = tex[name]; }
  function update(t, dt) {
    for (const o of objs) {
      const u = o.userData;
      u.boost = damp(u.boost, 0, 1.5, dt);
      o.rotation.y += (u.spin + u.boost * 9) * dt;
      o.rotation.x += (u.spin * 0.6 + u.boost * 4) * dt;
      o.position.y += Math.sin(t * 1.3 + u.z0 * 5) * 0.0015;
    }
  }
  setDepth(1);
  return { group: g, screen, bezel, objs, setDepth, useTexture, update, get depth() { return depth; } };
}

// ---- scenes --------------------------------------------------------------------------------

// Hero: the panel with objects floating off the glass, and the word SPATIAL in extruded,
// stereo-tinted letters arcing in front of it. Tap a letter to flip it, tap an object to spin
// it; "Scatter" throws the letters into depth and lets them spring home.
function hero(THREE, motion) {
  const group = new THREE.Group();
  lights(THREE, group);
  const r = root(THREE, group);
  const d = makeDisplay(THREE);
  d.group.position.set(0, -0.25, -0.6);
  r.add(d.group);

  const clock = idleClock();
  const letters = [];
  const word = new THREE.Group();
  r.add(word);
  const cL = new THREE.Color(LEFT), cR = new THREE.Color(RIGHT);
  loadFont().then((f) => {
    if (!f) return;
    const str = 'SPATIAL';
    [...str].forEach((ch, i) => {
      const k = i / (str.length - 1);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color().copy(cL).lerp(cR, k), metalness: 0.35, roughness: 0.28,
        emissive: new THREE.Color().copy(cL).lerp(cR, k).multiplyScalar(0.12),
      });
      const m = new THREE.Mesh(textGeo(f, ch, 0.5, 0.2), mat);
      const x = (i - 3) * 0.6;
      m.userData = { home: new THREE.Vector3(x, 1.45 - Math.abs(i - 3) * 0.05, 0.55 - (i - 3) ** 2 * 0.04), i, flip: -1, scatter: new THREE.Vector3() };
      m.position.copy(m.userData.home);
      word.add(m); letters.push(m);
    });
  });

  let depthT = 1, depth = 1, scatterAt = -1e9, lastTapped = '';
  const pick = [...d.objs, word];
  return {
    group,
    pick,
    update(t, dt) {
      clock.tick(t);
      depth = damp(depth, depthT, 4, dt);
      d.setDepth(depth);
      d.group.rotation.y = -0.28 + motion * 0.1 * Math.sin(t * 0.35);
      d.group.rotation.x = motion * 0.04 * Math.sin(t * 0.27);
      d.update(t, dt);
      const sc = t - scatterAt;
      for (const m of letters) {
        const u = m.userData;
        // Scatter: a burst out toward the viewer and sideways, then a springy return home.
        const out = sc < 2.4 ? Math.sin(Math.min(1, sc / 0.35) * Math.PI / 2) * (1 - smooth(0.6, 2.4, sc)) : 0;
        m.position.copy(u.home).addScaledVector(u.scatter, out);
        m.position.y += Math.sin(t * 1.6 + u.i * 0.7) * 0.04 * motion;
        let rx = 0;
        if (u.flip >= 0) {
          const p = clamp((t - u.flip) / 0.9);
          rx = easeOutBack(p) * Math.PI * 2;
          if (p >= 1) u.flip = -1;
        }
        m.rotation.set(rx + out * 2.4 * (u.i % 2 ? 1 : -1), out * 1.5, Math.sin(t * 0.9 + u.i) * 0.04 * motion);
        m.scale.z = depth;
      }
      // Left alone, a letter flips now and then, so the scene invites a tap.
      if (clock.idle && motion && letters.length && Math.random() < dt * 0.35) {
        const m = letters[Math.floor(Math.random() * letters.length)];
        if (m.userData.flip < 0) m.userData.flip = t;
      }
    },
    tap(hit) {
      clock.poke();
      const o = hit.object;
      if (letters.includes(o)) { o.userData.flip = clock.now; lastTapped = 'letter'; return; }
      if (d.objs.includes(o)) { o.userData.boost = 1; lastTapped = 'object'; }
    },
    actions: [
      {
        label: () => 'Scatter the letters',
        run() {
          clock.poke();
          scatterAt = clock.now;
          for (const m of letters) {
            m.userData.scatter.set((Math.random() - 0.5) * 2.4, (Math.random() - 0.3) * 1.6, 0.6 + Math.random() * 0.5);
          }
        },
      },
      { label: () => (depthT > 0.5 ? 'Flatten to 2D' : 'Back to 3D'), run() { clock.poke(); depthT = depthT > 0.5 ? 0 : 1; } },
    ],
    status: () => (depthT < 0.5 ? '2D mode · everything pressed onto the glass'
      : lastTapped === 'letter' ? 'Extruded type · 0.2 u deep, floating 3 cm off the glass'
        : 'Drag to turn the display · tap a letter or an object'),
  };
}

// Lesson 1: the LC lens switches the panel between 2D and 3D. Tap the panel to switch it.
function lens(THREE, motion) {
  const group = new THREE.Group();
  lights(THREE, group);
  const r = root(THREE, group);
  const d = makeDisplay(THREE);
  d.group.rotation.set(-0.12, -0.55, 0);
  d.group.position.set(0.2, 0, -0.6);
  r.add(d.group);
  const clock = idleClock();
  let manual = 1, cur = 1, target = 1;
  const toggle = () => { clock.poke(); manual = target > 0.5 ? 0 : 1; };
  return {
    group,
    pick: [d.screen, d.bezel, ...d.objs],
    update(t, dt) {
      clock.tick(t);
      target = clock.idle ? ((t % 6) < 3 ? 1 : 0) : manual;
      cur = damp(cur, target, 5, dt);
      d.setDepth(cur);
      d.group.rotation.y = -0.55 + motion * 0.06 * Math.sin(t * 0.3);
      d.update(t, dt);
    },
    tap: toggle,
    actions: [{ label: () => (target > 0.5 ? 'Switch to 2D' : 'Switch to 3D'), run: toggle }],
    status: () => (cur > 0.5 ? '3D mode · LC lens active' : '2D mode · lens index-matched, invisible'),
  };
}

// Lesson 2: tracked stereo vs multiview. The viewer's head follows your pointer across the
// tile; tracked cones chase the eyes, multiview cones stay put and the eyes fall between them.
function views(THREE, motion) {
  const group = new THREE.Group();
  lights(THREE, group);
  const r = root(THREE, group);
  const rig = new THREE.Group();
  rig.rotation.set(0.18, -1.05, 0);
  rig.position.set(1.15, -0.15, -1.2);
  r.add(rig);

  const d = makeDisplay(THREE, { pop: false });
  rig.add(d.group);

  const head = new THREE.Group();
  rig.add(head);
  const skin = new THREE.MeshStandardMaterial({ color: 0x2a3a40, roughness: 0.6, transparent: true, opacity: 0.55 });
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.62, 28, 16), skin);
  skull.scale.set(1, 1.15, 1);
  skull.position.set(0, 0.2, 4.75);
  head.add(skull);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xf4f7f6, roughness: 0.3 });
  const eyes = [-0.32, 0.32].map((x) => {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 12), eyeMat);
    e.position.set(x, 0.15, 4.2);
    head.add(e);
    return e;
  });

  const coneGeo = new THREE.ConeGeometry(1, 1, 28, 1, true);
  coneGeo.translate(0, -0.5, 0);
  coneGeo.rotateX(-Math.PI / 2);         // apex at the origin, base at +z = 1
  const coneMat = (color, opacity) => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const tracked = [coneMat(LEFT, 0.24), coneMat(RIGHT, 0.24)].map((mat) => {
    const c = new THREE.Mesh(coneGeo, mat); rig.add(c); return c;
  });
  const fan = [];
  for (let i = 0; i < 9; i++) {
    const c = new THREE.Mesh(coneGeo, coneMat(new THREE.Color().setHSL(i / 9, 0.7, 0.6), 0.09));
    c.userData.target = new THREE.Vector3(-2 + i * 0.5, 0.15, 4.2);
    rig.add(c); fan.push(c);
  }

  const clock = idleClock();
  const v = new THREE.Vector3();
  let manualTracked = true, isTracked = true, hoverX = null, headX = 0;
  const toggle = () => { clock.poke(); manualTracked = !isTracked; };
  return {
    group,
    pick: [d.screen, d.bezel, skull],
    update(t, dt) {
      clock.tick(t);
      isTracked = clock.idle ? (t % 7) < 3.5 : manualTracked;
      const target = hoverX !== null ? hoverX * 1.8 : motion * 0.9 * Math.sin(t * 0.8);
      headX = damp(headX, target, 6, dt);
      head.position.x = headX;
      d.useTexture(isTracked ? 'woven' : 'coarse');
      for (let i = 0; i < 2; i++) {
        const c = tracked[i];
        c.visible = isTracked;
        c.position.set(0, 0, 0.02);
        eyes[i].getWorldPosition(v);
        c.lookAt(v);
        c.scale.set(0.16, 0.16, Math.hypot(eyes[i].position.x + headX, eyes[i].position.y, eyes[i].position.z));
      }
      for (const c of fan) {
        c.visible = !isTracked;
        c.position.set(0, 0, 0.02);
        v.copy(c.userData.target); rig.localToWorld(v);
        c.lookAt(v);
        c.scale.set(0.24, 0.24, c.userData.target.length());
      }
    },
    hover(nx) { hoverX = nx; if (nx !== null) clock.poke(); },
    tap: toggle,
    actions: [{ label: () => (isTracked ? 'Show multiview' : 'Show tracked stereo'), run: toggle }],
    status: () => (isTracked
      ? 'Tracked stereo · move your pointer, the views follow the eyes'
      : 'Multiview · nine fixed views, each at a ninth of the resolution'),
  };
}

// Lesson 3: a per-pixel ghosting map. Tap anywhere on it to calibrate outward from that point,
// or run the factory sweep. Left alone it loops the sweep.
function calibration(THREE, motion) {
  const group = new THREE.Group();
  lights(THREE, group);
  const r = root(THREE, group);
  const rig = new THREE.Group();
  rig.rotation.set(-0.5, -0.42, 0);
  rig.position.set(0, -0.2, -0.9);
  r.add(rig);

  const plate = new THREE.Mesh(new THREE.PlaneGeometry(4.3, 2.8), new THREE.MeshStandardMaterial({ color: 0x14242a, roughness: 0.7 }));
  rig.add(plate);

  const NX = 26, NY = 16, cell = 0.155;
  const boxGeo = new THREE.BoxGeometry(cell * 0.86, cell * 0.86, 1);
  boxGeo.translate(0, 0, 0.5);
  const cells = new THREE.InstancedMesh(boxGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45 }), NX * NY);
  rig.add(cells);
  const ghost = [];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const u = (i + 0.5) / NX, v = (j + 0.5) / NY;
    const g = Math.exp(-((u - 0.78) ** 2 + (v - 0.3) ** 2) * 9)
      + 0.7 * Math.exp(-((u - 0.2) ** 2 + (v - 0.72) ** 2) * 12) + 0.35 * u ** 4;
    ghost.push({ u, v, x: (i - NX / 2 + 0.5) * cell, y: (j - NY / 2 + 0.5) * cell, g: 0.15 + 0.85 * clamp(g), fixed: 0 });
  }

  const zone = new THREE.BoxGeometry(4.5, 3, 1.8);
  rig.add(new THREE.LineSegments(new THREE.EdgesGeometry(zone), new THREE.LineBasicMaterial({ color: RIGHT, transparent: true, opacity: 0.4 })));
  rig.add(new THREE.Mesh(zone, new THREE.MeshBasicMaterial({ color: RIGHT, transparent: true, opacity: 0.035, depthWrite: false })));

  const clock = idleClock();
  const m = new THREE.Matrix4();
  const col = new THREE.Color(), hot = new THREE.Color(LEFT), warm = new THREE.Color(0xffc56b), ok = new THREE.Color(RIGHT);
  let mode = 'loop', t0 = 0, ou = 0.5, ov = 0.5, pct = 0;
  const local = new THREE.Vector3();
  return {
    group,
    pick: [cells, plate],
    update(t, dt) {
      clock.tick(t);
      if (mode !== 'loop' && clock.idle) mode = 'loop';
      rig.rotation.y = -0.42 + motion * 0.1 * Math.sin(t * 0.3);
      const loopSweep = (t % 8) / 8 * 1.25 - 0.1;
      const sweep = (t - t0) * 0.35 - 0.1;
      const radius = (t - t0) * 0.45;
      let sum = 0;
      ghost.forEach((c, k) => {
        let f;
        if (mode === 'loop') f = clamp((loopSweep - c.u) / 0.08);
        else if (mode === 'sweep') f = Math.max(c.fixed, clamp((sweep - c.u) / 0.08));
        else f = Math.max(c.fixed, clamp((radius - Math.hypot((c.u - ou) * 1.6, c.v - ov)) / 0.08));
        c.fixed = mode === 'loop' ? 0 : f;
        sum += f;
        const h = (c.g * 0.9) * (1 - f) + 0.025 * f;
        m.makeScale(1, 1, Math.max(0.01, h));
        m.setPosition(c.x, c.y, 0.005);
        cells.setMatrixAt(k, m);
        col.copy(warm).lerp(hot, c.g).lerp(ok, f);
        cells.setColorAt(k, col);
      });
      pct = sum / ghost.length;
      cells.instanceMatrix.needsUpdate = true;
      cells.instanceColor.needsUpdate = true;
    },
    tap(hit) {
      clock.poke();
      local.copy(hit.point); rig.worldToLocal(local);
      ou = clamp(local.x / (NX * cell) + 0.5); ov = clamp(local.y / (NY * cell) + 0.5);
      if (mode === 'loop') for (const c of ghost) c.fixed = 0;
      mode = 'radial'; t0 = clock.now;
    },
    actions: [
      { label: () => 'Run factory calibration', run() { clock.poke(); for (const c of ghost) c.fixed = 0; mode = 'sweep'; t0 = clock.now; } },
      { label: () => 'Reset ghosting', run() { clock.poke(); for (const c of ghost) c.fixed = 0; mode = 'radial'; t0 = 1e9; } },
    ],
    status: () => (mode === 'loop' ? `Calibration sweep · ${Math.round(pct * 100)}% corrected · tap the map to calibrate from there`
      : `${Math.round(pct * 100)}% of the ghosting map corrected`),
  };
}

// Lesson 4: roll-to-plate nanoimprint. Tap the glass to send the roller there; tap the roller
// to pause it. Left alone it loops.
function nanoimprint(THREE, motion) {
  const group = new THREE.Group();
  lights(THREE, group);
  const r = root(THREE, group);
  const rig = new THREE.Group();
  rig.rotation.set(0.62, -0.5, 0);
  rig.position.set(0, -0.35, -0.8);
  r.add(rig);

  const plate = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.08, 2.8),
    new THREE.MeshStandardMaterial({ color: 0x9fd8e0, transparent: true, opacity: 0.3, roughness: 0.08, metalness: 0.1 }));
  rig.add(plate);

  const rollerGeo = new THREE.CylinderGeometry(0.32, 0.32, 4.5, 48);
  rollerGeo.rotateZ(Math.PI / 2);
  const roller = new THREE.Mesh(rollerGeo, new THREE.MeshStandardMaterial({ color: 0xc8d2d5, metalness: 0.9, roughness: 0.22 }));
  rig.add(roller);
  const bandGeo = new THREE.TorusGeometry(0.325, 0.012, 6, 48);
  bandGeo.rotateY(Math.PI / 2);
  for (const x of [-2.1, 2.1]) {
    const band = new THREE.Mesh(bandGeo, new THREE.MeshBasicMaterial({ color: RIGHT }));
    band.position.x = x; roller.add(band);
  }

  const N = 46;
  const ribGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1, true, -Math.PI / 2, Math.PI);
  ribGeo.rotateZ(Math.PI / 2);
  ribGeo.rotateX(-Math.PI / 2);          // axis along x, curved face up
  const ribs = new THREE.InstancedMesh(ribGeo, new THREE.MeshStandardMaterial({
    color: 0x9becf2, emissive: 0x0d5f68, metalness: 0.3, roughness: 0.18, side: THREE.DoubleSide,
  }), N);
  rig.add(ribs);
  const zs = Array.from({ length: N }, (_, i) => -1.3 + (2.6 * i) / (N - 1));

  const clock = idleClock();
  const m = new THREE.Matrix4();
  const local = new THREE.Vector3();
  let z = -1.7, targetZ = -1.7, reached = -1.7, paused = false, progress = 0, mode = 'loop';
  return {
    group,
    pick: [roller, plate],
    update(t, dt) {
      clock.tick(t);
      if (mode === 'manual' && clock.idle) { mode = 'loop'; paused = false; }
      rig.rotation.y = -0.5 + motion * 0.08 * Math.sin(t * 0.3);
      if (mode === 'loop') {
        z = -1.7 + ((t % 6) / 6) * 3.6;
        reached = z;
      } else if (!paused) {
        z = damp(z, targetZ, 2.5, dt);
        reached = Math.max(reached, z);
      }
      progress = clamp((reached + 1.3) / 2.6);
      roller.position.set(0, 0.04 + 0.32, z);
      roller.rotation.x = z / 0.32;
      zs.forEach((zi, i) => {
        const grown = clamp((reached - zi) / 0.18);
        m.makeScale(3.9, Math.max(0.001, 0.06 * grown), 0.056);
        m.setPosition(0, 0.042, zi);
        ribs.setMatrixAt(i, m);
      });
      ribs.instanceMatrix.needsUpdate = true;
    },
    tap(hit) {
      clock.poke();
      if (mode === 'loop') { mode = 'manual'; reached = z; }
      if (hit.object === roller) { paused = !paused; return; }
      local.copy(hit.point); rig.worldToLocal(local);
      targetZ = clamp(local.z, -1.7, 1.9);
      paused = false;
    },
    actions: [
      { label: () => 'Imprint a fresh plate', run() { clock.poke(); mode = 'manual'; z = -1.7; reached = -1.7; targetZ = 1.9; paused = false; } },
      { label: () => (paused ? 'Resume roller' : 'Pause roller'), run() { clock.poke(); if (mode === 'loop') { mode = 'manual'; reached = z; targetZ = 1.9; } paused = !paused; } },
    ],
    status: () => `Roll-to-plate · lens layer ${Math.round(progress * 100)}% imprinted${mode === 'loop' ? ' · tap the glass to steer the roller' : ''}`,
  };
}

// Lesson 5: a flat picture lifting into a point cloud from its AI depth map. Tap the cloud to
// send a ripple through it from that point.
function conversion(THREE, motion) {
  const a = getArt();
  const group = new THREE.Group();
  lights(THREE, group);
  const r = root(THREE, group);
  const rig = new THREE.Group();
  rig.position.z = -0.7;
  r.add(rig);

  const NX = 150, NY = 94, w = 4.4, h = 2.75;
  const cpx = a.flat.getContext('2d').getImageData(0, 0, a.W, a.H).data;
  const dpx = a.depth.getContext('2d').getImageData(0, 0, a.W, a.H).data;
  const pos = new Float32Array(NX * NY * 3);
  const col = new Float32Array(NX * NY * 3);
  const dep = new Float32Array(NX * NY);
  const c = new THREE.Color();
  let k = 0;
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++, k++) {
    const sx = Math.floor((i + 0.5) / NX * a.W), sy = Math.floor((j + 0.5) / NY * a.H);
    const o = (sy * a.W + sx) * 4;
    c.setRGB(cpx[o] / 255, cpx[o + 1] / 255, cpx[o + 2] / 255, THREE.SRGBColorSpace);
    col.set([c.r, c.g, c.b], k * 3);
    dep[k] = dpx[o] / 255;
    pos[k * 3] = (i / (NX - 1) - 0.5) * w;
    pos[k * 3 + 1] = (0.5 - j / (NY - 1)) * h;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.0075, vertexColors: true, sizeAttenuation: true }));
  rig.add(pts);
  // An invisible plane catches taps (a points raycast is slow and fussy).
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ visible: false }));
  rig.add(catcher);

  const clock = idleClock();
  const local = new THREE.Vector3();
  const ripples = [];
  let lift = 0, liftT = 1;
  return {
    group,
    pick: [catcher],
    update(t, dt) {
      clock.tick(t);
      if (clock.idle) {
        const p = (t % 8) / 8;
        liftT = smooth(0.05, 0.35, p) * (1 - smooth(0.8, 0.98, p));
        lift = liftT;
      } else lift = damp(lift, liftT, 3, dt);
      while (ripples.length && t - ripples[0].t > 3) ripples.shift();
      for (let n = 0; n < dep.length; n++) {
        let zz = dep[n] * 1.5 * lift;
        for (const rp of ripples) {
          const age = t - rp.t;
          const dist = Math.hypot(pos[n * 3] - rp.x, pos[n * 3 + 1] - rp.y);
          zz += 0.32 * Math.sin(dist * 7 - age * 9) * Math.exp(-age * 1.4) * Math.exp(-dist * 0.9) * smooth(0, 0.3, age * 9 - dist * 7 + 3);
        }
        pos[n * 3 + 2] = zz;
      }
      geo.attributes.position.needsUpdate = true;
      rig.rotation.y = motion * 0.42 * Math.sin(t * 0.45);
      rig.rotation.x = -0.1;
    },
    tap(hit) {
      clock.poke();
      local.copy(hit.point); rig.worldToLocal(local);
      ripples.push({ x: local.x, y: local.y, t: clock.now });
      if (ripples.length > 4) ripples.shift();
    },
    actions: [
      { label: () => (liftT > 0.5 ? 'Flatten to 2D' : 'Lift into 3D'), run() { clock.poke(); liftT = liftT > 0.5 ? 0 : 1; } },
      { label: () => 'Drop a ripple', run() { clock.poke(); ripples.push({ x: (Math.random() - 0.5) * 3, y: (Math.random() - 0.5) * 1.8, t: clock.now }); } },
    ],
    status: () => `2D to 3D · AI depth ${Math.round(lift * 100)}% · tap the picture to ripple it`,
  };
}

// The stack: four layers as glass slabs with their names in extruded type. Tap a slab (or a
// row in the list beside it) to pull it out; "Explode" spreads them apart.
function stack(THREE, motion, ctx) {
  const group = new THREE.Group();
  lights(THREE, group);
  const r = root(THREE, group);
  const rig = new THREE.Group();
  rig.position.set(0, -0.15, -0.6);
  rig.rotation.set(0.5, -0.6, 0);
  r.add(rig);

  const layers = [
    { name: 'DISPLAY', color: RIGHT, own: true },
    { name: 'SOFTWARE', color: RIGHT, own: true },
    { name: 'COMPUTE', color: LEFT, own: false },
    { name: 'DEV TOOLS', color: RIGHT, own: true },
  ];
  const slabGeo = new THREE.BoxGeometry(2.6, 0.16, 1.7);
  const slabs = layers.map((L, i) => {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: L.own ? 0x163038 : 0x2a1a18, emissive: L.color, emissiveIntensity: 0.08,
      transparent: true, opacity: L.own ? 0.85 : 0.55, roughness: 0.25, metalness: 0.3,
    });
    const slab = new THREE.Mesh(slabGeo, mat);
    slab.userData.index = i;
    g.add(slab);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(slabGeo), new THREE.LineBasicMaterial({ color: L.color }));
    g.add(edge);
    g.userData = { slab, mat, out: 0 };
    rig.add(g);
    return g;
  });
  loadFont().then((f) => {
    if (!f) return;
    layers.forEach((L, i) => {
      const t = new THREE.Mesh(textGeo(f, `${i + 1} ${L.name}`, 0.2, 0.05),
        new THREE.MeshStandardMaterial({ color: 0xe4eeeb, emissive: L.color, emissiveIntensity: 0.25 }));
      t.rotation.x = -Math.PI / 2;
      t.position.set(0, 0.11, 0.35);
      t.userData.index = i;
      slabs[i].add(t);
      pick.push(t);
    });
  });

  const clock = idleClock();
  let selected = -1, spread = 0.55, spreadT = 0.55, spin = 0;
  const pick = slabs.map((s) => s.userData.slab);
  const select = (i, fromScene) => {
    clock.poke();
    selected = selected === i ? -1 : i;
    if (fromScene && ctx.onSelect) ctx.onSelect(selected);
  };
  return {
    group,
    pick,
    update(t, dt) {
      clock.tick(t);
      spread = damp(spread, spreadT, 4, dt);
      if (clock.idle && motion) spin += dt * 0.25;
      rig.rotation.y = -0.6 + Math.sin(spin) * 0.5;
      slabs.forEach((s, i) => {
        const u = s.userData;
        u.out = damp(u.out, selected === i ? 1 : 0, 6, dt);
        s.position.set(u.out * 1.4, (i - 1.5) * spread + Math.sin(t * 1.2 + i) * 0.03 * motion, u.out * 0.6);
        u.mat.emissiveIntensity = 0.08 + u.out * 0.35;
      });
    },
    tap(hit) { select(hit.object.userData.index ?? -1, true); },
    select(i) { if (i !== selected) select(i, false); },
    actions: [
      { label: () => (spreadT > 0.7 ? 'Collapse the stack' : 'Explode the stack'), run() { clock.poke(); spreadT = spreadT > 0.7 ? 0.55 : 1.05; } },
    ],
    status: () => (selected < 0 ? 'Four layers · tap one to pull it out'
      : `Layer ${selected + 1} · ${layers[selected].name.toLowerCase()} · ${layers[selected].own ? 'Leia' : 'yours'}`),
  };
}

const BUILDERS = { hero, lens, views, calibration, nanoimprint, conversion, stack };

/**
 * Build the named scene. `motion` is 1 normally and 0 under prefers-reduced-motion (no
 * decorative sway). `ctx` carries callbacks from the page, e.g. { onSelect(i) } for the stack.
 */
export function buildScene(THREE, name, motion = 1, ctx = {}) {
  const b = BUILDERS[name];
  if (!b) throw new Error(`unknown scene ${name}`);
  return b(THREE, motion, ctx);
}
