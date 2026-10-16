// Six three.js scenes, one per woven tile.
//
// Authored in "u" units and scaled by S into metres for a 0.24 m virtual display (the SDK
// default). z = 0 is the glass, +z is out toward the viewer. Content stays within about +5 cm in
// front and -6 cm behind (6 cm per authoring unit), so every scene is comfortable at the display rig's natural depth.
// Each builder returns { group, update(t, dt), status() }; the tile owns the renderer.

export const S = 0.06;              // 1 u = 6 cm
export const BG = 0x0b1519;         // tile clear colour, matches --tile in style.css

const LEFT = 0xff6a55;              // left-eye red, as in the page palette
const RIGHT = 0x46d9e3;             // right-eye cyan

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

  // Interlaced: alternate 4 px columns from a left-shifted and right-shifted copy, tinted per eye.
  const wc = woven.getContext('2d');
  for (let x = 0, i = 0; x < W; x += 4, i++) {
    const shift = i % 2 ? -6 : 6;
    wc.drawImage(flat, x + shift, 0, 4, H, x, 0, 4, H);
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
  // A glowing orb in the foreground: the nearest thing in the picture.
  const ox = W * 0.3, oy = H * 0.68, r = H * 0.09;
  if (asDepth) { ctx.fillStyle = '#ffffff'; }
  else {
    const og = ctx.createRadialGradient(ox - r * 0.3, oy - r * 0.3, r * 0.1, ox, oy, r);
    og.addColorStop(0, '#ffd2c8'); og.addColorStop(0.5, '#ff6a55'); og.addColorStop(1, '#8a2a20');
    ctx.fillStyle = og;
  }
  ctx.beginPath(); ctx.arc(ox, oy, r, 0, Math.PI * 2); ctx.fill();
}

// ---- helpers -------------------------------------------------------------------------------

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => { const x = clamp((v - a) / (b - a)); return x * x * (3 - 2 * x); };
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

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
      o.userData = { z0, spin };
      objs.push(o); g.add(o);
    };
    add(new THREE.TorusKnotGeometry(0.36, 0.11, 120, 16),
      new THREE.MeshStandardMaterial({ color: 0xf1ece2, metalness: 0.35, roughness: 0.22 }), -0.95, 0.2, 0.95, 0.5);
    add(new THREE.IcosahedronGeometry(0.34, 0),
      new THREE.MeshStandardMaterial({ color: RIGHT, metalness: 0.2, roughness: 0.35, flatShading: true }), 1.05, -0.35, 0.65, -0.4);
    add(new THREE.SphereGeometry(0.2, 32, 16),
      new THREE.MeshStandardMaterial({ color: LEFT, metalness: 0.1, roughness: 0.3 }), 0.35, 0.72, 1.1, 0);
    add(new THREE.BoxGeometry(0.28, 0.28, 0.28),
      new THREE.MeshStandardMaterial({ color: 0xd9e4e2, metalness: 0.6, roughness: 0.3 }), 0.05, -0.62, 0.35, 0.8);
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
  function update(t) {
    for (const o of objs) { o.rotation.y = t * o.userData.spin; o.rotation.x = t * o.userData.spin * 0.6; }
  }
  setDepth(1);
  return { group: g, setDepth, useTexture, update, get depth() { return depth; } };
}

function root(THREE) {
  const r = new THREE.Group();
  r.scale.setScalar(S);
  return r;
}

// ---- scenes --------------------------------------------------------------------------------

function hero(THREE, motion) {
  const group = new THREE.Group();
  lights(THREE, group);
  const r = root(THREE); group.add(r);
  const d = makeDisplay(THREE);
  d.group.position.z = -0.5;
  r.add(d.group);
  return {
    group,
    update(t) {
      d.group.rotation.y = -0.3 + motion * 0.12 * Math.sin(t * 0.35);
      d.group.rotation.x = motion * 0.05 * Math.sin(t * 0.27);
      d.update(t);
    },
    status: () => 'Tracked stereo · objects in front of the glass',
  };
}

function lens(THREE) {
  const group = new THREE.Group();
  lights(THREE, group);
  const r = root(THREE); group.add(r);
  const d = makeDisplay(THREE);
  d.group.rotation.set(-0.12, -0.55, 0);
  d.group.position.set(0.2, 0, -0.6);
  r.add(d.group);
  let cur = 1;
  return {
    group,
    update(t, dt) {
      const target = (t % 6) < 3 ? 1 : 0;
      cur = damp(cur, target, 5, dt);
      d.setDepth(cur);
      d.update(t);
    },
    status: () => (cur > 0.5 ? '3D mode · LC lens active' : '2D mode · lens index-matched, invisible'),
  };
}

function views(THREE, motion) {
  const group = new THREE.Group();
  lights(THREE, group);
  const r = root(THREE); group.add(r);
  const rig = new THREE.Group();
  rig.rotation.set(0.18, -1.05, 0);
  rig.position.set(1.15, -0.15, -1.2);
  r.add(rig);

  const d = makeDisplay(THREE, { pop: false });
  rig.add(d.group);

  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xf4f7f6, roughness: 0.3 });
  const eyes = [0, 1].map(() => {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 12), eyeMat);
    rig.add(e);
    return e;
  });

  const coneGeo = new THREE.ConeGeometry(1, 1, 28, 1, true);
  coneGeo.translate(0, -0.5, 0);
  coneGeo.rotateX(-Math.PI / 2);         // apex at the origin, base at +z = 1
  const coneMat = (color, opacity) => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const tracked = [coneMat(LEFT, 0.22), coneMat(RIGHT, 0.22)].map((mat) => {
    const c = new THREE.Mesh(coneGeo, mat); rig.add(c); return c;
  });
  const fan = [];
  for (let i = 0; i < 9; i++) {
    const col = new THREE.Color().setHSL(i / 9, 0.7, 0.6);
    const c = new THREE.Mesh(coneGeo, coneMat(col, 0.09));
    const target = new THREE.Vector3(-2 + i * 0.5, 0.15, 4.2);
    c.userData.target = target;
    rig.add(c); fan.push(c);
  }

  const v = new THREE.Vector3();
  let isTracked = true;
  return {
    group,
    update(t) {
      isTracked = (t % 7) < 3.5;
      const sway = motion * 0.9 * Math.sin(t * 0.8);
      eyes[0].position.set(-0.32 + sway, 0.15, 4.2);
      eyes[1].position.set(0.32 + sway, 0.15, 4.2);
      d.useTexture(isTracked ? 'woven' : 'coarse');
      for (let i = 0; i < 2; i++) {
        const c = tracked[i];
        c.visible = isTracked;
        c.position.set(0, 0, 0.02);
        eyes[i].getWorldPosition(v);
        c.lookAt(v);
        const dist = eyes[i].position.length();
        c.scale.set(0.16, 0.16, dist);
      }
      for (const c of fan) {
        c.visible = !isTracked;
        c.position.set(0, 0, 0.02);
        v.copy(c.userData.target); rig.localToWorld(v);
        c.lookAt(v);
        c.scale.set(0.24, 0.24, c.userData.target.length());
      }
    },
    status: () => (isTracked
      ? 'Tracked stereo · two views at full resolution, aimed at your eyes'
      : 'Multiview · resolution split across nine fixed views'),
  };
}

function calibration(THREE, motion) {
  const group = new THREE.Group();
  lights(THREE, group);
  const r = root(THREE); group.add(r);
  const rig = new THREE.Group();
  rig.rotation.set(-0.5, -0.42, 0);
  rig.position.set(0, -0.2, -0.9);
  r.add(rig);

  const plate = new THREE.Mesh(new THREE.PlaneGeometry(4.3, 2.8),
    new THREE.MeshStandardMaterial({ color: 0x14242a, roughness: 0.7 }));
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
    ghost.push({ u, x: (i - NX / 2 + 0.5) * cell, y: (j - NY / 2 + 0.5) * cell, g: 0.15 + 0.85 * clamp(g) });
  }

  const zone = new THREE.BoxGeometry(4.5, 3, 1.8);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(zone),
    new THREE.LineBasicMaterial({ color: RIGHT, transparent: true, opacity: 0.4 }));
  const fill = new THREE.Mesh(zone, new THREE.MeshBasicMaterial({ color: RIGHT, transparent: true, opacity: 0.035, depthWrite: false }));
  rig.add(edges, fill);

  const m = new THREE.Matrix4();
  const col = new THREE.Color(), hot = new THREE.Color(LEFT), warm = new THREE.Color(0xffc56b), ok = new THREE.Color(RIGHT);
  let sweep = 0;
  return {
    group,
    update(t) {
      rig.rotation.y = -0.42 + motion * 0.1 * Math.sin(t * 0.3);
      sweep = (t % 8) / 8 * 1.25 - 0.1;
      ghost.forEach((c, k) => {
        const fixed = clamp((sweep - c.u) / 0.08);
        const h = (c.g * 0.9) * (1 - fixed) + 0.025 * fixed;
        m.makeScale(1, 1, Math.max(0.01, h));
        m.setPosition(c.x, c.y, 0.005);
        cells.setMatrixAt(k, m);
        col.copy(warm).lerp(hot, c.g).lerp(ok, fixed);
        cells.setColorAt(k, col);
      });
      cells.instanceMatrix.needsUpdate = true;
      cells.instanceColor.needsUpdate = true;
    },
    status: () => `Calibration sweep · ${Math.round(clamp(sweep) * 100)}% of the ghosting map corrected`,
  };
}

function nanoimprint(THREE, motion) {
  const group = new THREE.Group();
  lights(THREE, group);
  const r = root(THREE); group.add(r);
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

  const m = new THREE.Matrix4();
  let progress = 0;
  return {
    group,
    update(t) {
      rig.rotation.y = -0.5 + motion * 0.08 * Math.sin(t * 0.3);
      const p = (t % 6) / 6;
      const z = -1.7 + p * 3.6;
      progress = clamp((z + 1.3) / 2.6);
      roller.position.set(0, 0.04 + 0.32, z);
      roller.rotation.x = z / 0.32;
      zs.forEach((zi, i) => {
        const grown = clamp((z - zi) / 0.18);
        m.makeScale(3.9, Math.max(0.001, 0.06 * grown), 0.056);
        m.setPosition(0, 0.042, zi);
        ribs.setMatrixAt(i, m);
      });
      ribs.instanceMatrix.needsUpdate = true;
    },
    status: () => `Roll-to-plate · lens layer ${Math.round(progress * 100)}% imprinted`,
  };
}

function conversion(THREE, motion) {
  const a = getArt();
  const group = new THREE.Group();
  lights(THREE, group);
  const r = root(THREE); group.add(r);
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
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.0075, vertexColors: true, sizeAttenuation: true }));
  rig.add(pts);

  let lift = 0;
  return {
    group,
    update(t) {
      const p = (t % 8) / 8;
      lift = smooth(0.05, 0.35, p) * (1 - smooth(0.8, 0.98, p));
      for (let n = 0; n < dep.length; n++) pos[n * 3 + 2] = dep[n] * 1.5 * lift;
      geo.attributes.position.needsUpdate = true;
      rig.rotation.y = motion * 0.42 * Math.sin(t * 0.45);
      rig.rotation.x = -0.1;
    },
    status: () => `2D to 3D · AI depth ${Math.round(lift * 100)}% applied`,
  };
}

const BUILDERS = { hero, lens, views, calibration, nanoimprint, conversion };

/** Build the named scene. `motion` is 1 normally and 0 under prefers-reduced-motion (no sway). */
export function buildScene(THREE, name, motion = 1) {
  const b = BUILDERS[name];
  if (!b) throw new Error(`unknown scene ${name}`);
  return b(THREE, motion);
}
