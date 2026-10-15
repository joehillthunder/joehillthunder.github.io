// Procedural warships. Every model is built along +x, centred on the origin, one metre per grid
// square, waterline at y = 0. Hulls are lofted from cross-sections with vertex colours for the
// red anti-fouling, black boot-top and grey topsides; the superstructure is assembled from parts.

import * as THREE from 'three';

const M = {}; // shared materials
function mats() {
  if (M.steel) return M;
  M.hull = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.55 });
  M.steel = new THREE.MeshStandardMaterial({ color: 0x8a96a3, metalness: 0.45, roughness: 0.5 });
  M.steelDark = new THREE.MeshStandardMaterial({ color: 0x4d5763, metalness: 0.5, roughness: 0.45 });
  M.gun = new THREE.MeshStandardMaterial({ color: 0x3a4048, metalness: 0.7, roughness: 0.35 });
  M.deck = new THREE.MeshStandardMaterial({ color: 0x6b6f72, metalness: 0.2, roughness: 0.85 });
  M.wood = new THREE.MeshStandardMaterial({ color: 0x9a7a55, metalness: 0.0, roughness: 0.8 });
  M.black = new THREE.MeshStandardMaterial({ color: 0x15181c, metalness: 0.3, roughness: 0.6 });
  M.sub = new THREE.MeshStandardMaterial({ color: 0x1b1f24, metalness: 0.4, roughness: 0.45 });
  M.window = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffc070, emissiveIntensity: 1.6 });
  M.red = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2020, emissiveIntensity: 3 });
  M.green = new THREE.MeshStandardMaterial({ color: 0x003300, emissive: 0x20ff40, emissiveIntensity: 3 });
  M.white = new THREE.MeshStandardMaterial({ color: 0x444444, emissive: 0xffffff, emissiveIntensity: 2.5 });
  M.radar = new THREE.MeshStandardMaterial({ color: 0xc9d1d9, metalness: 0.6, roughness: 0.3, side: THREE.DoubleSide });
  return M;
}

const TEAM = [
  { name: 'Blue', color: 0x3d8bff, hull: 0x6c7987 },
  { name: 'Red', color: 0xff4a3d, hull: 0x7d776f },
];
export const teamColor = (t) => TEAM[t].color;

function flagMat(team) {
  const key = 'flag' + team;
  if (!M[key]) M[key] = new THREE.MeshStandardMaterial({ color: TEAM[team].color, emissive: TEAM[team].color, emissiveIntensity: 0.35, side: THREE.DoubleSide });
  return M[key];
}

// ---------------------------------------------------------------------------------------------
// Hull loft

function hullGeometry({ length, beam, free = 0.1, draft = 0.12, bowStart = 0.62, sternRound = 0.06, sheer = 0.06, team = 0 }) {
  const S = 48; // stations bow to stern
  const prof = [ // [width factor, height (fraction of freeboard / draft)] starboard deck edge → keel
    [1.0, 1.0], [1.0, 0.5], [0.99, 0.0], [0.95, -0.35], [0.82, -0.7], [0.5, -0.95], [0.0, -1.0],
  ];
  const K = prof.length;
  const ring = 2 * K - 1; // starboard + port (keel shared)
  const pos = [], col = [], idx = [];
  const topside = new THREE.Color(TEAM[team].hull), boot = new THREE.Color(0x111214), bottom = new THREE.Color(0x7a2318);
  const width = (u) => {
    // u: 0 stern → 1 bow
    let w = 1;
    if (u > bowStart) { const b = (u - bowStart) / (1 - bowStart); w = Math.sqrt(Math.max(0, 1 - b * b * b * 0.98)) * (1 - b * 0.9); w = Math.max(w, 0.0); }
    if (u < sternRound) w *= 0.82 + 0.18 * Math.sin((u / sternRound) * Math.PI / 2);
    return w;
  };
  const deckY = (u) => free + sheer * Math.pow(Math.max(0, u - 0.55) / 0.45, 2);
  for (let i = 0; i <= S; i++) {
    const u = i / S;
    const x = (u - 0.5) * length;
    const w = (width(u) * beam) / 2;
    const top = deckY(u);
    // the keel rises toward the bow and stern
    const kd = draft * (1 - 0.6 * Math.pow(Math.abs(u - 0.45) / 0.55, 4));
    for (let j = 0; j < ring; j++) {
      const k = j < K ? j : 2 * K - 2 - j;
      const side = j < K ? 1 : -1;
      const [wf, hf] = prof[k];
      const y = hf >= 0 ? hf * top : hf * kd;
      pos.push(x, y, side * w * wf);
      const c = y > 0.012 ? topside : y > -0.012 ? boot : bottom;
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < S; i++) {
    for (let j = 0; j < ring - 1; j++) {
      const a = i * ring + j, b = a + ring;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  // transom: fan at the stern
  const base = pos.length / 3;
  pos.push(-length / 2, free * 0.4, 0);
  col.push(topside.r, topside.g, topside.b);
  for (let j = 0; j < ring - 1; j++) idx.push(base, j + 1, j);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();

  // deck: a strip between the two deck edges
  const dp = [], di = [];
  for (let i = 0; i <= S; i++) {
    const u = i / S, x = (u - 0.5) * length, w = (width(u) * beam) / 2 * 0.97, y = deckY(u) - 0.002;
    dp.push(x, y, w, x, y, -w);
    if (i < S) { const a = i * 2; di.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const deck = new THREE.BufferGeometry();
  deck.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3));
  deck.setIndex(di);
  deck.computeVertexNormals();
  return { hull: g, deck, deckY, width: (u) => (width(u) * beam) / 2 };
}

// ---------------------------------------------------------------------------------------------
// Parts

const box = (w, h, d, m) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
const cyl = (rt, rb, h, m, seg = 16) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);

function at(mesh, x, y, z) { mesh.position.set(x, y, z); return mesh; }

function windows(parent, w, y, d, n, x0 = 0) {
  for (const side of [1, -1]) {
    for (let i = 0; i < n; i++) {
      const win = box(w / (n * 2.2), 0.012, 0.004, mats().window);
      win.position.set(x0 - w / 2 + (i + 0.5) * (w / n), y, side * (d / 2 + 0.002));
      parent.add(win);
    }
  }
}

function turret(barrels = 2, size = 1) {
  const g = new THREE.Group();
  const m = mats();
  const base = cyl(0.075 * size, 0.085 * size, 0.035 * size, m.steelDark, 20);
  base.position.y = 0.017 * size;
  g.add(base);
  const body = box(0.17 * size, 0.06 * size, 0.13 * size, m.steel);
  body.position.set(-0.01 * size, 0.06 * size, 0);
  g.add(body);
  const face = box(0.03 * size, 0.055 * size, 0.12 * size, m.steelDark);
  face.position.set(0.08 * size, 0.058 * size, 0);
  face.rotation.z = -0.35;
  g.add(face);
  const guns = new THREE.Group();
  guns.position.set(0.085 * size, 0.06 * size, 0);
  for (let i = 0; i < barrels; i++) {
    const b = cyl(0.009 * size, 0.012 * size, 0.24 * size, m.gun, 8);
    b.rotation.z = -Math.PI / 2;
    b.position.set(0.12 * size, 0, (i - (barrels - 1) / 2) * 0.035 * size);
    guns.add(b);
  }
  g.add(guns);
  g.userData.guns = guns;
  g.userData.gunsX = guns.position.x;
  g.userData.muzzle = new THREE.Vector3(0.33 * size, 0.06 * size, 0);
  return g;
}

function mast(h, team, radar = true) {
  const g = new THREE.Group();
  const m = mats();
  const pole = cyl(0.006, 0.01, h, m.steelDark, 6);
  pole.position.y = h / 2;
  g.add(pole);
  const yard = box(0.004, 0.004, 0.12, m.steelDark);
  yard.position.y = h * 0.78;
  g.add(yard);
  if (radar) {
    const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.006, 20, 1, true, 0, Math.PI), m.radar);
    dish.rotation.z = Math.PI / 2;
    const spinner = new THREE.Group();
    spinner.position.y = h * 0.62;
    spinner.add(dish);
    g.add(spinner);
    g.userData.spinner = spinner;
  }
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.045, 6, 1), flagMat(team));
  flag.position.set(-0.04, h * 0.92, 0);
  g.add(flag);
  g.userData.flag = flag;
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), m.white);
  light.position.y = h + 0.006;
  g.add(light);
  g.userData.beacon = light;
  return g;
}

function funnel(r, h, team) {
  const g = new THREE.Group();
  const m = mats();
  const f = cyl(r * 0.9, r, h, m.steelDark, 16);
  f.scale.z = 0.75;
  f.position.y = h / 2;
  g.add(f);
  const band = cyl(r * 0.92, r * 0.92, h * 0.12, flagMat(team), 16);
  band.scale.z = 0.76;
  band.position.y = h * 0.8;
  g.add(band);
  const cap = cyl(r * 0.88, r * 0.88, 0.006, m.black, 16);
  cap.scale.z = 0.75;
  cap.position.y = h + 0.003;
  g.add(cap);
  g.userData.top = new THREE.Vector3(0, h + 0.01, 0);
  return g;
}

function navLights(g, x, y, half) {
  const m = mats();
  const s = new THREE.SphereGeometry(0.009, 8, 6);
  const red = new THREE.Mesh(s, m.red); red.position.set(x, y, -half);
  const green = new THREE.Mesh(s, m.green); green.position.set(x, y, half);
  g.add(red, green);
}

// ---------------------------------------------------------------------------------------------
// Ship types

function buildCarrier(team) {
  const L = 4.7, B = 0.5;
  const g = new THREE.Group();
  const m = mats();
  const h = hullGeometry({ length: L, beam: B, free: 0.14, draft: 0.13, bowStart: 0.7, team });
  g.add(new THREE.Mesh(h.hull, m.hull));
  // Flight deck: overhanging, with markings painted from a canvas.
  const fd = box(L * 0.97, 0.03, B * 1.5, flightDeckMaterial());
  fd.position.set(0.04, 0.19, -0.03);
  g.add(fd);
  const sponson = box(L * 0.8, 0.05, B * 1.32, m.steelDark);
  sponson.position.set(0.02, 0.155, -0.03);
  g.add(sponson);
  // Island on the starboard side.
  const island = new THREE.Group();
  island.position.set(0.35, 0.205, B * 0.55);
  const i1 = box(0.42, 0.12, 0.09, m.steel); i1.position.y = 0.06; island.add(i1);
  const i2 = box(0.3, 0.08, 0.08, m.steel); i2.position.set(0.04, 0.16, 0); island.add(i2);
  const i3 = box(0.18, 0.04, 0.085, m.steelDark); i3.position.set(0.06, 0.22, 0); island.add(i3);
  windows(island, 0.3, 0.18, 0.08, 6, 0.04);
  windows(island, 0.42, 0.09, 0.09, 8);
  const mm = mast(0.22, team);
  mm.position.set(0.02, 0.24, 0);
  island.add(mm);
  g.add(island);
  g.userData.spinners = [mm.userData.spinner];
  g.userData.flags = [mm.userData.flag];
  g.userData.beacons = [mm.userData.beacon];
  // Parked jets.
  for (let i = 0; i < 5; i++) {
    const jet = buildJet();
    jet.position.set(-1.9 + i * 0.32, 0.207, -0.2);
    jet.rotation.y = 0.55;
    g.add(jet);
  }
  for (let i = 0; i < 3; i++) {
    const jet = buildJet();
    jet.position.set(1.2 + i * 0.3, 0.207, 0.08);
    jet.rotation.y = Math.PI * 0.95;
    g.add(jet);
  }
  g.userData.launch = [new THREE.Vector3(-0.6, 0.3, 0), new THREE.Vector3(1.4, 0.3, -0.1)];
  g.userData.turrets = [];
  navLights(g, 0.4, 0.22, B * 0.76);
  return g;
}

let deckMat;
function flightDeckMaterial() {
  if (deckMat) return deckMat;
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#3d4246'; x.fillRect(0, 0, 1024, 256);
  // wear
  for (let i = 0; i < 900; i++) { x.fillStyle = `rgba(0,0,0,${Math.random() * 0.08})`; x.fillRect(Math.random() * 1024, Math.random() * 256, 6 + Math.random() * 30, 2 + Math.random() * 6); }
  x.strokeStyle = '#f2f2f2'; x.lineWidth = 3;
  x.setLineDash([26, 18]);
  x.beginPath(); x.moveTo(20, 128); x.lineTo(1004, 128); x.stroke();
  // angled landing strip
  x.beginPath(); x.moveTo(40, 200); x.lineTo(640, 70); x.stroke();
  x.setLineDash([]);
  x.strokeStyle = '#ffd23f'; x.lineWidth = 2;
  for (let i = 0; i < 4; i++) { x.beginPath(); x.moveTo(700 + i * 70, 40); x.lineTo(1000, 40 + i * 4); x.stroke(); }
  x.strokeStyle = '#ffffff'; x.lineWidth = 5;
  x.strokeRect(6, 6, 1012, 244);
  x.fillStyle = '#f2f2f2'; x.font = 'bold 110px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.save(); x.translate(880, 150); x.rotate(Math.PI / 2); x.fillText('77', 0, 0); x.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mats6 = new THREE.MeshStandardMaterial({ color: 0x5b6166, metalness: 0.2, roughness: 0.85 });
  const top = new THREE.MeshStandardMaterial({ map: tex, metalness: 0.15, roughness: 0.8 });
  deckMat = [mats6, mats6, top, mats6, mats6, mats6];
  return deckMat;
}

function buildJet() {
  const g = new THREE.Group();
  const m = mats();
  const body = cyl(0.008, 0.014, 0.14, m.steel, 6);
  body.rotation.z = -Math.PI / 2;
  body.position.y = 0.012;
  g.add(body);
  const wing = box(0.05, 0.003, 0.11, m.steel);
  wing.position.set(-0.01, 0.01, 0);
  g.add(wing);
  const tail = box(0.03, 0.03, 0.003, m.steel);
  tail.position.set(-0.06, 0.025, 0);
  g.add(tail);
  return g;
}

function buildGunship(team, cfg) {
  const { L, B, free, turrets: tdef, decks, funnels, masts, wood } = cfg;
  const g = new THREE.Group();
  const m = mats();
  const h = hullGeometry({ length: L, beam: B, free, draft: free * 1.1, team });
  g.add(new THREE.Mesh(h.hull, m.hull));
  g.add(new THREE.Mesh(h.deck, wood ? m.wood : m.deck));
  const turrets = [];
  for (const [x, aft, barrels, size] of tdef) {
    const u = x / L + 0.5;
    const t = turret(barrels, size);
    t.position.set(x, h.deckY(u), 0);
    t.rotation.y = aft ? Math.PI : 0;
    t.userData.home = t.rotation.y;
    g.add(t);
    turrets.push(t);
  }
  const ups = [];
  for (const [x, w, hh, d, y0] of decks) {
    const u = x / L + 0.5;
    const s = box(w, hh, d, m.steel);
    s.position.set(x, h.deckY(u) + (y0 || 0) + hh / 2, 0);
    g.add(s);
    windows(g, w * 0.9, h.deckY(u) + (y0 || 0) + hh * 0.7, d, Math.max(2, Math.round(w * 22)), x);
    ups.push(s);
  }
  const smoke = [];
  for (const [x, r, hh, y0] of funnels) {
    const fn = funnel(r, hh, team);
    fn.position.set(x, h.deckY(x / L + 0.5) + y0, 0);
    g.add(fn);
    smoke.push(fn.position.clone().add(fn.userData.top));
  }
  const spinners = [], flags = [], beacons = [];
  for (const [x, hh, y0] of masts) {
    const ms = mast(hh, team);
    ms.position.set(x, h.deckY(x / L + 0.5) + y0, 0);
    g.add(ms);
    if (ms.userData.spinner) spinners.push(ms.userData.spinner);
    flags.push(ms.userData.flag);
    beacons.push(ms.userData.beacon);
  }
  navLights(g, decks[0] ? decks[0][0] + decks[0][1] / 2 : 0, h.deckY(0.55) + 0.06, (B / 2) * 1.02);
  g.userData.turrets = turrets;
  g.userData.spinners = spinners;
  g.userData.flags = flags;
  g.userData.beacons = beacons;
  g.userData.smoke = smoke;
  g.userData.launch = [new THREE.Vector3(0, h.deckY(0.5) + 0.05, 0)];
  return g;
}

function buildSubmarine(team) {
  const g = new THREE.Group();
  const m = mats();
  const L = 2.75;
  // Cigar hull from a lathe profile, lying along x, riding mostly awash.
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const u = i / 40; // 0 stern → 1 bow
    let r = 0.12;
    if (u < 0.25) r *= Math.pow(u / 0.25, 0.55) * 0.92 + 0.08 * (u / 0.25);
    if (u > 0.85) r *= Math.sqrt(1 - Math.pow((u - 0.85) / 0.15, 2) * 0.96);
    pts.push(new THREE.Vector2(Math.max(r, 0.004), (u - 0.5) * L));
  }
  const lathe = new THREE.LatheGeometry(pts, 28);
  lathe.rotateZ(-Math.PI / 2);
  const hull = new THREE.Mesh(lathe, m.sub);
  hull.position.y = -0.03;
  hull.scale.set(1, 0.85, 1);
  g.add(hull);
  const deck = box(L * 0.55, 0.012, 0.07, m.black);
  deck.position.set(0.15, 0.07, 0);
  g.add(deck);
  // Sail (conning tower) with dive planes.
  const sail = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.18, 4, 12), m.sub);
  sail.rotation.z = Math.PI / 2;
  sail.scale.set(1.4, 1, 0.55);
  sail.position.set(0.45, 0.16, 0);
  g.add(sail);
  const planes = box(0.06, 0.006, 0.26, m.sub);
  planes.position.set(0.47, 0.18, 0);
  g.add(planes);
  const peri = cyl(0.006, 0.006, 0.12, m.steelDark, 6);
  peri.position.set(0.42, 0.28, 0);
  g.add(peri);
  const mm = mast(0.1, team, false);
  mm.position.set(0.52, 0.22, 0);
  g.add(mm);
  // Rudder and stern planes.
  const rud = box(0.12, 0.2, 0.008, m.sub);
  rud.position.set(-L / 2 + 0.08, 0.0, 0);
  g.add(rud);
  const sp = box(0.1, 0.006, 0.3, m.sub);
  sp.position.set(-L / 2 + 0.1, -0.02, 0);
  g.add(sp);
  g.userData.turrets = [];
  g.userData.spinners = [];
  g.userData.flags = [mm.userData.flag];
  g.userData.beacons = [mm.userData.beacon];
  g.userData.launch = [new THREE.Vector3(0.9, 0.05, 0), new THREE.Vector3(-0.3, 0.05, 0)];
  g.userData.ride = -0.05; // sits lower in the water
  return g;
}

const BUILDERS = {
  carrier: buildCarrier,
  battleship: (team) => buildGunship(team, {
    L: 3.75, B: 0.46, free: 0.11, wood: true,
    turrets: [[1.05, false, 3, 1.15], [0.68, false, 3, 1.15], [-1.05, true, 3, 1.15]],
    decks: [[0.05, 0.85, 0.08, 0.3], [0.12, 0.55, 0.07, 0.24, 0.08], [0.18, 0.28, 0.07, 0.18, 0.15]],
    funnels: [[-0.32, 0.06, 0.22, 0.06]],
    masts: [[0.26, 0.36, 0.2], [-0.62, 0.22, 0.02]],
  }),
  cruiser: (team) => buildGunship(team, {
    L: 2.8, B: 0.38, free: 0.1,
    turrets: [[0.8, false, 2, 0.95], [-0.82, true, 2, 0.95]],
    decks: [[0.15, 0.7, 0.07, 0.24], [0.25, 0.32, 0.07, 0.18, 0.07]],
    funnels: [[-0.12, 0.05, 0.17, 0.06], [-0.34, 0.05, 0.15, 0.04]],
    masts: [[0.3, 0.32, 0.14]],
  }),
  submarine: buildSubmarine,
  destroyer: (team) => buildGunship(team, {
    L: 1.85, B: 0.3, free: 0.09,
    turrets: [[0.52, false, 1, 0.8]],
    decks: [[0.08, 0.5, 0.065, 0.19], [0.14, 0.22, 0.06, 0.14, 0.065]],
    funnels: [[-0.22, 0.045, 0.13, 0.05]],
    masts: [[0.16, 0.28, 0.125]],
  }),
};

/** A ship model for fleet `team` (0 blue, 1 red). */
export function buildShip(id, team = 0) {
  const g = BUILDERS[id](team);
  g.name = id;
  g.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  return g;
}

/** Recolour a model as a burnt-out wreck (materials are cloned once and cached). */
const charCache = new Map();
export function charModel(g) {
  g.traverse((o) => {
    if (!o.isMesh) return;
    const swap = (mat) => {
      if (!charCache.has(mat.uuid)) {
        const c = mat.clone();
        if (c.color) c.color.multiplyScalar(0.45);
        if (c.map) c.color = new THREE.Color(0x6a6a6a);
        if (c.emissive) { c.emissive.setHex(0x000000); c.emissiveIntensity = 0; }
        c.roughness = 0.95;
        charCache.set(mat.uuid, c);
      }
      return charCache.get(mat.uuid);
    };
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });
}

/** A translucent placement ghost. */
const ghostMats = {
  ok: new THREE.MeshBasicMaterial({ color: 0x5dffb0, transparent: true, opacity: 0.42, depthWrite: false }),
  bad: new THREE.MeshBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.42, depthWrite: false }),
};
export function ghostModel(id) {
  const g = buildShip(id, 0);
  g.traverse((o) => { if (o.isMesh) o.material = ghostMats.ok; });
  g.userData.setValid = (ok) => g.traverse((o) => { if (o.isMesh) o.material = ok ? ghostMats.ok : ghostMats.bad; });
  return g;
}
