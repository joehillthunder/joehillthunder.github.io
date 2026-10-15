// The regional grid map: a tabletop diorama built procedurally from the network description.
//
// Units: the network's (x, z) positions span about 1.5 x 0.6 "map units"; heights are in the same
// units. app.js scales the whole diorama into the virtual display, so nothing here knows about
// metres or the screen.
//
// Realism comes from procedural textures (textures.js) and geometry detail (kit.js): terrain,
// roads, trees, three-phase conductors on lattice towers and wood poles, textured buildings whose
// windows light when the customer has power. Colour that carries meaning (ISA-101) is unchanged.

import { T } from './theme.js';
import { Kit } from './kit.js';
import * as TX from './textures.js';

const H_TX = 0.065;     // transmission conductor height
const H_DIST = 0.03;    // distribution conductor height
// Map compaction: bus positions are pulled together so equipment reads larger relative to the map.
export const K = 0.72;
export const MAP_W = 1.26, MAP_D = 0.66;
const SLAB_H = 0.05;    // diorama base thickness (soil cross-section on the sides)

// Deterministic pseudo-random, so the town looks the same every run.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export class GridScene {
  constructor(THREE, net) {
    this.THREE = THREE;
    this.net = net;
    this.root = new THREE.Group();        // the diorama; app.js poses and scales it
    this.kit = new Kit(THREE, this.root);
    this.pickables = this.kit.pickables;
    this.lines = {};                       // branch id -> {curve, tube, mat, len, ...}
    this.markers = {};                     // branch id -> status marker group
    this.fciFlags = {};
    this.loadMats = {};                    // load id -> [window/facade materials]
    this.billboards = [];
    this.spinners = [];
    this.plumes = [];
    this.pvMats = {};
    this.matCache = new Map();
    this.particlePhase = {};
    this.occupied = [];                    // [x, z, r] footprints trees must avoid
    this.selected = null;
    this.riskBars = {};
    this.time = 0;
    this._build();
    this.kit.enableShadows();
  }

  // ---- helpers ------------------------------------------------------------------------------
  mat(color, opts = {}) {
    const key = color + JSON.stringify(opts);
    if (!opts.unique && this.matCache.has(key)) return this.matCache.get(key);
    const { unique, ...rest } = opts;
    const m = new this.THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.1, ...rest });
    if (!unique) this.matCache.set(key, m);
    return m;
  }

  box(w, h, d, material, x = 0, y = 0, z = 0, parent = this.root) {
    const m = new this.THREE.Mesh(new this.THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  cyl(rt, rb, h, material, x = 0, y = 0, z = 0, parent = this.root, seg = 12) {
    const m = new this.THREE.Mesh(new this.THREE.CylinderGeometry(rt, rb, h, seg), material);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  pick(obj, item) {
    obj.userData.item = item;
    this.pickables.push(obj);
    return obj;
  }

  busPos(id) {
    const p = this.net.buses[id].pos;
    return new this.THREE.Vector3(p[0] * K, 0, p[1] * K);
  }

  // A building facade whose windows glow when the load is served.
  facadeMat(kind, repeat = [1, 1], tint = 0xffffff) {
    const F = TX.facade(kind);
    const map = F.map.clone(), em = F.emissive.clone();
    for (const t of [map, em]) { t.repeat.set(repeat[0], repeat[1]); t.needsUpdate = true; }
    const m = new this.THREE.MeshStandardMaterial({ map, emissiveMap: em, emissive: T.window, emissiveIntensity: 0.9,
      color: tint, roughness: 0.8, metalness: 0.05 });
    m.userData.facade = true;
    return m;
  }

  addLoadMat(id, m) {
    (this.loadMats[id] ||= []).push(m);
    return m;
  }

  // A flat strip along a curve: roads, river, banks. u runs along the strip.
  ribbon(points, width, material, y, uPerUnit) {
    const THREE = this.THREE;
    const curve = new THREE.CatmullRomCurve3(points);
    const n = Math.max(8, Math.round(curve.getLength() / 0.006));
    const pos = [], uv = [], idx = [];
    let dist = 0, prev = null;
    for (let i = 0; i <= n; i++) {
      const p = curve.getPointAt(i / n), t = curve.getTangentAt(i / n);
      if (prev) dist += p.distanceTo(prev);
      prev = p;
      const px = -t.z, pz = t.x, l = Math.hypot(px, pz) || 1;
      pos.push(p.x + (px / l) * width / 2, y, p.z + (pz / l) * width / 2, p.x - (px / l) * width / 2, y, p.z - (pz / l) * width / 2);
      uv.push(dist * uPerUnit, 1, dist * uPerUnit, 0);
      if (i) { const a = (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // Strips are built clockwise from above; make sure the normal points up.
    if (g.attributes.normal.getY(0) < 0) {
      g.setIndex(idx.map((v, i) => idx[i - (i % 3) + (2 - (i % 3))]));
      g.computeVertexNormals();
    }
    const mesh = new THREE.Mesh(g, material);
    this.root.add(mesh);
    return mesh;
  }

  // ---- build --------------------------------------------------------------------------------
  _build() {
    this._buildTerrain();
    this._buildBulk();
    this._buildSubstation();
    for (const [id, b] of Object.entries(this.net.branches)) {
      if (b.kind === 'xfmr') continue;
      this._buildBranch(id, b);
    }
    this._buildLoads();
    this._buildPV();
    this._buildMicrogrid();
    this._buildRoads();
    this._buildTrees();
    this._buildParticles();
    this._buildEffects();
  }

  _buildTerrain() {
    const THREE = this.THREE, kit = this.kit;
    // Diorama base: grass on top, a soil cross-section on the sides.
    const soil = kit.surface('soil', [10, 1]);
    const top = kit.surface('grass', [7, 3.6]);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(MAP_W, SLAB_H, MAP_D), [soil, soil, top, soil, soil, soil]);
    slab.position.y = -SLAB_H / 2;
    this.root.add(slab);
    this.box(MAP_W + 0.016, 0.008, MAP_D + 0.016, this.mat(0x23292f, { roughness: 0.6 }), 0, -SLAB_H - 0.004, 0);
    // River across the front, with darker banks.
    const rp = [[-0.63, 0.31], [-0.3, 0.29], [0.0, 0.312], [0.3, 0.305], [0.63, 0.29]].map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.ribbon(rp, 0.05, this.mat(0x4a4030, { roughness: 1 }), 0.0004, 10);
    this.ribbon(rp, 0.03, kit.surface('water', [1, 1]), 0.0009, 12);
    this.occupied.push(...rp.map((p) => [p.x, p.z, 0.04]));
    // Farm fields in the open corners.
    for (const [x0, z0, x1, z1, rot] of [[0.43, -0.31, 0.61, -0.17, 0], [-0.61, 0.1, -0.4, 0.24, 0.3], [-0.31, -0.31, -0.15, -0.21, 1.4]]) {
      const w = x1 - x0, d = z1 - z0;
      const f = new THREE.Mesh(new THREE.PlaneGeometry(w, d), kit.surface('crops', [w * 6, d * 6]));
      f.rotation.set(-Math.PI / 2, 0, rot * 0.1);
      f.position.set((x0 + x1) / 2, 0.0006, (z0 + z1) / 2);
      this.root.add(f);
      this.occupied.push([(x0 + x1) / 2, (z0 + z1) / 2, Math.max(w, d) * 0.6]);
    }
  }

  _buildBulk() {
    const THREE = this.THREE, kit = this.kit;
    const p = this.busPos('bulk');
    const g = new THREE.Group();
    g.position.copy(p);
    this.root.add(g);
    this.occupied.push([p.x, p.z + 0.02, 0.1]);
    const it = 'bulk';
    // Combined-cycle gas plant: pad, turbine hall, two heat-recovery boilers with stacks.
    kit.box(0.15, 0.003, 0.1, kit.surface('concrete', [4, 3]), -0.02, 0.0015, 0.03, it, g);
    const hall = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, 0.035),
      [kit.corrugated(0x9ba4ab, [3, 1]), kit.corrugated(0x9ba4ab, [3, 1]), kit.surface('flatroof', [2, 1]),
        kit.corrugated(0x9ba4ab, [3, 1]), kit.corrugated(0x9ba4ab, [6, 1]), kit.corrugated(0x9ba4ab, [6, 1])]);
    hall.position.set(-0.025, 0.015, 0.032);
    g.add(this.pick(hall, it));
    for (const z of [0.018, 0.046]) {
      kit.box(0.034, 0.04, 0.013, kit.painted(0x7e878e), 0.022, 0.02, z, it, g);
      kit.cyl(0.0045, 0.005, 0.1, kit.painted(0xb4b9bd, [1, 3]), 0.045, 0.05, z, it, g, 14);
      kit.cyl(0.0047, 0.0047, 0.006, this.mat(0xb03a2e), 0.045, 0.094, z, null, g, 14);
      const plume = new THREE.Mesh(new THREE.SphereGeometry(0.008, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0xe9eef2, transparent: true, opacity: 0.0, depthWrite: false, roughness: 1 }));
      plume.position.set(0.045, 0.105, z);
      g.add(plume);
      this.plumes.push({ mesh: plume, x: 0.045, y: 0.105, z, rate: 0.6, size: 0.6 });
    }
    // Hyperbolic cooling tower with a steam plume.
    const prof = [];
    for (let i = 0; i <= 12; i++) {
      const y = (i / 12) * 0.07, t = (y - 0.05) / 0.03;
      prof.push(new THREE.Vector2(0.018 * Math.sqrt(1 + t * t), y));
    }
    const tower = new THREE.Mesh(new THREE.LatheGeometry(prof, 32),
      kit.surface('concrete', [6, 2], { side: THREE.DoubleSide }));
    tower.position.set(-0.085, 0, 0.065);
    g.add(this.pick(tower, it));
    for (let k = 0; k < 4; k++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.016, 12, 10),
        new THREE.MeshStandardMaterial({ color: 0xf2f5f7, transparent: true, opacity: 0.0, depthWrite: false, roughness: 1 }));
      g.add(s);
      this.plumes.push({ mesh: s, x: -0.085, y: 0.075, z: 0.065, rate: 0.35, size: 1, phase: k / 4 });
    }
    // Wind farm on the ridge behind.
    const white = this.mat(0xe4e8ec, { roughness: 0.5 });
    for (let i = 0; i < 4; i++) {
      const t = new THREE.Group();
      t.position.set(-0.05 + i * 0.045, 0, -0.07 + (i % 2) * 0.02);
      g.add(t);
      this.pick(this.cyl(0.0011, 0.0024, 0.1, white, 0, 0.05, 0, t, 10), it);
      this.box(0.004, 0.0035, 0.009, white, 0, 0.101, -0.001, t);
      const hub = new THREE.Group();
      hub.position.set(0, 0.101, 0.0045);
      t.add(hub);
      this.cyl(0.0018, 0.0018, 0.002, white, 0, 0, 0, hub, 10).rotation.x = Math.PI / 2;
      for (let k = 0; k < 3; k++) {
        const arm = new THREE.Group();
        arm.rotation.z = (k * 2 * Math.PI) / 3;
        hub.add(arm);
        const blade = this.cyl(0.0006, 0.0018, 0.045, white, 0, 0.0235, 0, arm, 6);
        blade.scale.z = 0.35;
      }
      this.spinners.push({ obj: hub, speed: 1.6 + i * 0.2 });
    }
  }

  _buildSubstation() {
    const THREE = this.THREE, kit = this.kit;
    const a = this.busPos('sub_hv'), b = this.busPos('sub_lv');
    const c = a.clone().add(b).multiplyScalar(0.5);
    const g = new THREE.Group();
    g.position.copy(c);
    this.root.add(g);
    this.subGroup = g;
    this.occupied.push([c.x, c.z, 0.11]);
    // Gravel yard, chain-link fence and a warning sign at the gate.
    this.pick(kit.box(0.16, 0.004, 0.12, kit.surface('gravel', [3, 2.2]), 0, 0.002, 0, null, g), 'sub_lv');
    const F = 0.013;
    kit.fence([-0.08, -0.06], [0.08, -0.06], F, 'sub_lv', g, 0.02);
    kit.fence([0.08, -0.06], [0.08, 0.06], F, 'sub_lv', g, 0.02);
    kit.fence([0.08, 0.06], [-0.08, 0.06], F, 'sub_lv', g, 0.02);
    kit.fence([-0.08, 0.06], [-0.08, -0.06], F, 'sub_lv', g, 0.02);
    kit.plaque(TX.sign('DANGER', ['HIGH VOLTAGE', 'KEEP OUT']), 0.016, 0.01, 0.03, 0.007, 0.0606, 'sub_lv', g);
    // Power transformer: textured tank on a concrete pad, radiator banks, conservator, bushings.
    kit.box(0.06, 0.003, 0.046, kit.surface('concrete'), -0.01, 0.0055, 0, 'XFMR', g);
    const tank = kit.box(0.04, 0.03, 0.028, kit.painted(0x8d969d), -0.01, 0.022, 0, 'XFMR', g);
    for (const z of [-0.019, 0.019]) kit.box(0.032, 0.024, 0.008, kit.corrugated(0x7f888f, [6, 1]), -0.01, 0.02, z, 'XFMR', g);
    const cons = kit.cyl(0.004, 0.004, 0.026, kit.painted(0x8d969d), -0.016, 0.043, -0.008, 'XFMR', g, 12);
    cons.rotation.z = Math.PI / 2;
    for (let i = 0; i < 3; i++) {
      kit.insulator(-0.022 + i * 0.01, 0.037, 0.004, 0.018, 0.0022, 'XFMR', { parent: g });   // HV bushings
      kit.insulator(-0.002 + i * 0.006, 0.037, -0.006, 0.008, 0.0016, 'XFMR', { parent: g }); // LV bushings
    }
    this.xfmrTank = tank;
    // HV dead-end structure where the line lands (lattice columns + beam).
    const galv = kit.surface('galv');
    kit.lattice(-0.07, -0.06, 0.06, 0.0035, 0.0025, galv, 'sub_hv', g, 3, 0.0012);
    kit.lattice(-0.07, -0.02, 0.06, 0.0035, 0.0025, galv, 'sub_hv', g, 3, 0.0012);
    kit.strut([-0.07, 0.06, -0.064], [-0.07, 0.06, -0.016], 0.002, galv, 'sub_hv', g);
    // LV bus on short steel stands, switchgear lineup, control house.
    for (const x of [0.02, 0.06]) kit.lattice(x, 0.0, 0.026, 0.0025, 0.002, galv, 'sub_lv', g, 2, 0.001);
    kit.strut([0.02, 0.027, 0], [0.06, 0.027, 0], 0.0018, this.mat(0xc8ccd0, { metalness: 0.7, roughness: 0.3 }), 'sub_lv', g);
    kit.box(0.05, 0.022, 0.016, kit.painted(0x9aa2a8, [2, 1]), 0.045, 0.011, 0.025, 'sub_lv', g);
    const house = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.02, 0.025),
      [kit.painted(0xb7ab92), kit.painted(0xb7ab92), kit.surface('flatroof'), kit.painted(0xb7ab92), kit.painted(0xb7ab92), kit.painted(0xb7ab92)]);
    house.position.set(0.05, 0.01, -0.03);
    g.add(this.pick(house, 'sub_lv'));
  }

  _branchCurve(id, b) {
    const THREE = this.THREE;
    const A = this.busPos(b.a), B = this.busPos(b.b);
    const h = b.kind === 'tline' ? H_TX : H_DIST;
    if (id === 'BKR_F1' || id === 'BKR_F2') {
      // Leaves the substation switchgear.
      A.add(new THREE.Vector3(0.11, 0, 0.025));
    }
    if (b.a === 'sub_hv' || b.b === 'sub_hv') {
      const c = this.subGroup.position;
      if (b.b === 'sub_hv') B.set(c.x - 0.07, 0, c.z - 0.04);
    }
    const len = A.distanceTo(B);
    const spans = Math.max(1, Math.round(len / (b.kind === 'tline' ? 0.09 : 0.055)));
    const supports = [];
    for (let i = 0; i <= spans; i++) supports.push(A.clone().lerp(B, i / spans).setY(h));
    const sag = b.kind === 'tline' ? 0.012 : 0.006;
    const along = (off) => {
      const pts = [];
      for (let i = 0; i < spans; i++) {
        pts.push(supports[i].clone().add(off));
        pts.push(supports[i].clone().lerp(supports[i + 1], 0.5).setY(h - sag).add(off));
      }
      pts.push(supports[spans].clone().add(off));
      return new THREE.CatmullRomCurve3(pts);
    };
    const dir = B.clone().sub(A).setY(0).normalize();
    const perp = new THREE.Vector3(-dir.z, 0, dir.x);
    return { curve: along(new THREE.Vector3()), along, supports, len, h, dir, perp };
  }

  _buildBranch(id, b) {
    const THREE = this.THREE, kit = this.kit;
    const { curve, along, supports, len, h, dir, perp } = this._branchCurve(id, b);
    const tint = b.kind === 'tline' ? T.kv115 : T.kv12;
    const mat = this.mat(tint, { unique: true, roughness: 0.4, metalness: 0.5, emissive: tint, emissiveIntensity: 0.15 });
    const r = b.kind === 'tline' ? 0.0014 : 0.001;
    const spread = b.kind === 'tline' ? 0.011 : 0.0055;
    // Three phase conductors; all share the status material so colour still means state.
    let tube = null;
    for (const k of [-1, 0, 1]) {
      const c = k === 0 ? curve : along(perp.clone().multiplyScalar(k * spread));
      const t = new THREE.Mesh(new THREE.TubeGeometry(c, Math.max(16, supports.length * 8), r, 6, false), mat);
      t.userData.noShadow = true;
      this.root.add(t);
      if (k === 0) tube = t;
    }
    // Fat invisible tube for picking: thin wires are hard to hit.
    const hit = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.014, 6, false),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    this.root.add(this.pick(hit, id));
    for (let i = 1; i < 16; i++) {
      const p = curve.getPointAt(i / 16);
      this.occupied.push([p.x, p.z, 0.016]);
    }

    const yaw = -Math.atan2(dir.z, dir.x);
    if (b.kind === 'tline') {
      // Galvanized lattice towers with a crossarm and three insulator strings.
      const galv = kit.surface('galv');
      for (const s of supports.slice(1, -1)) {
        const tw = kit.lattice(s.x, s.z, h + 0.006, 0.006, 0.0018, galv, id, this.root, 4, 0.0011);
        tw.rotation.y = yaw;
        kit.strut([0, h + 0.006, -0.015], [0, h + 0.006, 0.015], 0.0016, galv, id, tw);
        for (const k of [-1, 0, 1]) kit.insulator(0, h, k * spread, 0.006, 0.0011, null, { color: 0x6f8a94, parent: tw, sheds: 5 });
      }
    } else if (b.kind === 'line') {
      // Wood poles with a crossarm, pin insulators, and a pole-top transformer every few spans.
      const wood = kit.surface('wood', [1, 4]);
      supports.slice(1, -1).forEach((s, i) => {
        const pole = new THREE.Group();
        pole.position.set(s.x, 0, s.z);
        pole.rotation.y = yaw;
        this.root.add(pole);
        kit.cyl(0.0011, 0.0015, h + 0.005, wood, 0, (h + 0.005) / 2, 0, id, pole, 8);
        kit.box(0.0014, 0.0014, 0.015, wood, 0, h - 0.0005, 0, id, pole);
        for (const k of [-1, 0, 1]) kit.insulator(0, h - 0.0005, k * spread, 0.0028, 0.0009, null, { color: 0x6f7f74, parent: pole, sheds: 2 });
        if (i % 3 === 1) {
          kit.cyl(0.0022, 0.0022, 0.005, kit.painted(0x8a9399), 0.0025, h - 0.008, 0, id, pole, 10);
        }
      });
    }
    // Switching devices: a status marker. Shape carries state: filled = closed, hollow = open.
    if (b.kind === 'breaker' || b.kind === 'switch') {
      const at = curve.getPointAt(b.kind === 'breaker' ? 0.3 : 0.5);
      const g = new THREE.Group();
      g.position.set(at.x, h + 0.016, at.z);
      this.root.add(g);
      const S = 0.016, W = 0.0028;
      const frameMat = this.mat(T.equip, { unique: true, emissive: T.equip, emissiveIntensity: 0.25 });
      const fillMat = this.mat(0xc9d1d8, { unique: true, emissive: 0xc9d1d8, emissiveIntensity: 0.25 });
      const frame = new THREE.Group();
      for (const [x, y, w, hh] of [[0, S / 2, S, W], [0, -S / 2, S, W], [S / 2, 0, W, S], [-S / 2, 0, W, S]]) {
        this.box(w, hh, 0.002, frameMat, x, y, 0, frame);
      }
      g.add(frame);
      const fill = this.box(S - W, S - W, 0.0015, fillMat, 0, 0, 0, g);
      const hit = this.box(S * 1.6, S * 1.6, 0.004, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), 0, 0, 0, g);
      this.pick(hit, id);
      g.traverse((o) => (o.userData.noShadow = true));
      // Pole + device box under the marker.
      this.cyl(0.0011, 0.0014, h, kit.surface('wood', [1, 4]), at.x, h / 2, at.z, this.root, 8);
      this.pick(this.box(0.006, 0.006, 0.006, kit.painted(0x6a737a), at.x, h + 0.002, at.z), id);
      this.markers[id] = { g, frame, fill, frameMat, fillMat };
      this.billboards.push(g);
    }
    // Fault indicator flag (hidden until it latches).
    const fp = curve.getPointAt(b.kind === 'line' || b.kind === 'tline' ? 0.25 : 0.75);
    const flag = new THREE.Group();
    flag.position.set(fp.x, h + 0.004, fp.z);
    const fmat = this.mat(T.fci, { unique: true, emissive: T.fci, emissiveIntensity: 0.9 });
    this.box(0.0012, 0.026, 0.0012, this.mat(0xcccccc), 0, 0.013, 0, flag);
    const tri = new THREE.Mesh(new THREE.ConeGeometry(0.009, 0.018, 3), fmat);
    tri.rotation.z = -Math.PI / 2;
    tri.position.set(0.009, 0.021, 0);
    flag.add(tri);
    flag.visible = false;
    this.root.add(flag);
    this.fciFlags[id] = flag;

    this.lines[id] = { curve, tube, mat, len, h, kind: b.kind, tint };
  }

  _buildLoads() {
    const THREE = this.THREE, kit = this.kit;
    const roofMat = kit.surface('shingles', [2, 2]);
    const flat = kit.surface('flatroof');
    for (const [id, ld] of Object.entries(this.net.loads)) {
      if (ld.kind === 'critical') continue; // the microgrid builds its own
      const c = this.busPos(ld.bus);
      const r = rng(id.length * 7919 + ld.kw);
      const side = ld.bus.startsWith('g') ? -1 : 1;     // feeder 2 towns sit north of their line
      if (ld.kind === 'commercial') {
        for (let i = 0; i < 6; i++) {
          const x = c.x - 0.065 + r() * 0.13, z = c.z + side * (0.04 + r() * 0.06);
          const h = 0.018 + r() * 0.03, w = 0.013 + r() * 0.01;
          const kind = i % 2 ? 'shop' : 'office';
          const floors = Math.max(1, Math.round(h / 0.008));
          const m = this.addLoadMat(id, this.facadeMat(kind, [1, floors / 4]));
          const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), [m, m, flat, flat, m, m]);
          b.position.set(x, h / 2, z);
          this.root.add(this.pick(b, id));
          kit.box(w * 0.35, 0.003, w * 0.3, kit.painted(0x9aa1a6), x, h + 0.0015, z, id);   // rooftop unit
          this.occupied.push([x, z, w * 0.75]);
        }
      } else {
        const tints = [0xffffff, 0xe8dccb, 0xd5dde2];
        const mats = tints.map((t) => this.addLoadMat(id, this.facadeMat('home', [1, 1], t)));
        for (let i = 0; i < 12; i++) {
          const x = c.x - 0.065 + r() * 0.13, z = c.z + side * (0.035 + r() * 0.065);
          const ry = r() * 0.6;
          const m = mats[i % 3];
          const b = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.009, 0.0105), m);
          b.position.set(x, 0.0045, z);
          b.rotation.y = ry;
          this.root.add(this.pick(b, id));
          const roof = new THREE.Mesh(new THREE.ConeGeometry(0.0098, 0.006, 4), roofMat);
          roof.position.set(x, 0.012, z);
          roof.rotation.y = Math.PI / 4 + ry;
          this.root.add(this.pick(roof, id));
          this.occupied.push([x, z, 0.011]);
        }
      }
    }
  }

  _buildPV() {
    const THREE = this.THREE, kit = this.kit;
    const c = this.busPos('g1');
    const cells = TX.pvCells();
    const pmat = new THREE.MeshStandardMaterial({ map: cells, metalness: 0.5, roughness: 0.28, emissive: 0x2a5d9c, emissiveIntensity: 0.3 });
    this.pvMats.pv_farm = pmat;
    const geo = new THREE.BoxGeometry(0.016, 0.001, 0.008);
    const rows = 6, cols = 9;
    const inst = new THREE.InstancedMesh(geo, pmat, rows * cols);
    const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.0006, 0.0006, 0.006, 5), kit.surface('galv'), rows * cols);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5, 0, 0));
    const one = new THREE.Vector3(1, 1, 1), qi = new THREE.Quaternion();
    let k = 0;
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      const x = c.x + 0.02 + j * 0.019, z = c.z - 0.06 - i * 0.013;
      m.compose(new THREE.Vector3(x, 0.006, z), q, one);
      inst.setMatrixAt(k, m);
      m.compose(new THREE.Vector3(x, 0.003, z), qi, one);
      posts.setMatrixAt(k++, m);
    }
    this.root.add(this.pick(inst, 'pv_farm'), posts);
    // Inverter skid + gravel access strip.
    kit.box(0.012, 0.008, 0.008, kit.surface('concrete'), c.x + 0.2, 0.004, c.z - 0.09, 'pv_farm');
    kit.box(0.009, 0.007, 0.006, this.kit.decal(TX.louvre(0x8f989e)), c.x + 0.2, 0.0115, c.z - 0.09, 'pv_farm');
    this.occupied.push([c.x + 0.1, c.z - 0.093, 0.11]);
  }

  _buildMicrogrid() {
    const THREE = this.THREE, kit = this.kit;
    const c = this.busPos('mg');
    const g = new THREE.Group();
    g.position.copy(c);
    this.root.add(g);
    this.mgGroup = g;
    this.occupied.push([c.x + 0.03, c.z + 0.01, 0.13]);
    // Campus: parking lot, lawns, critical buildings.
    this.pick(kit.box(0.2, 0.003, 0.15, kit.surface('grass', [2, 1.5]), 0.03, 0.0015, 0.01, null, g), 'mg');
    kit.box(0.15, 0.0008, 0.035, this.mat(0x3c4146, { roughness: 0.9 }), -0.0, 0.0034, 0.048, null, g);
    const crit = (id, kind, w, h, d, x, z) => {
      const m = this.addLoadMat(id, this.facadeMat(kind, [Math.max(1, w / 0.03), Math.max(1, h / 0.03)]));
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [m, m, kit.surface('flatroof'), m, m, m]);
      b.position.set(x, h / 2, z);
      g.add(this.pick(b, id));
      return b;
    };
    crit('ld_hosp', 'hospital', 0.05, 0.04, 0.035, -0.02, -0.03);
    kit.box(0.014, 0.01, 0.014, kit.painted(0xb9c0c6), -0.035, 0.045, -0.035, 'ld_hosp', g);           // rooftop plant
    const pad = kit.plaque(TX.helipad(), 0.018, 0.018, -0.008, 0.0405, -0.024, 'ld_hosp', g);
    pad.rotation.x = -Math.PI / 2;
    crit('ld_fire', 'station', 0.024, 0.016, 0.02, 0.045, -0.045);
    // Water treatment: concrete clarifiers with water that glows blue when served.
    const wmat = kit.surface('concrete');
    this.addLoadMat('ld_water', this.mat(0x4fa3c7, { unique: true, emissive: 0x4fa3c7, emissiveIntensity: 0.6, roughness: 0.2 }));
    for (const [x, z] of [[0.08, 0.02], [0.105, 0.045], [0.08, 0.06]]) {
      this.pick(this.cyl(0.012, 0.012, 0.008, wmat, x, 0.004, z, g, 24), 'ld_water');
      this.cyl(0.0105, 0.0105, 0.0005, this.loadMats.ld_water[0], x, 0.0083, z, g, 24);
    }
    // Carport solar over the parking lot, with cars underneath.
    const pmat = new THREE.MeshStandardMaterial({ map: TX.pvCells(), metalness: 0.5, roughness: 0.28, emissive: 0x2a5d9c, emissiveIntensity: 0.3 });
    this.pvMats.pv_mg = pmat;
    const carCols = [0x8e2b2b, 0xd7d9db, 0x2c3e50, 0x5d6d7e, 0xc0a062];
    for (let i = 0; i < 4; i++) {
      const x = -0.06 + i * 0.032;
      const p = this.box(0.03, 0.0012, 0.014, pmat, x, 0.012, 0.045, g);
      p.rotation.x = -0.25;
      this.pick(p, 'pv_mg');
      this.cyl(0.0008, 0.0008, 0.011, kit.surface('galv'), x, 0.0055, 0.045, g, 6);
      for (const dx of [-0.008, 0.008]) {
        const car = this.box(0.0055, 0.003, 0.009, this.mat(carCols[(i * 2 + (dx > 0)) % 5], { metalness: 0.6, roughness: 0.35 }), x + dx, 0.005, 0.05, g);
        car.userData.noShadow = false;
      }
    }
    // Battery containers + SOC gauge.
    const cont = kit.corrugated(0xd9dee2, [4, 1]);
    this.pick(kit.box(0.03, 0.012, 0.012, cont, 0.0, 0.006, 0.075, null, g), 'bess');
    this.pick(kit.box(0.03, 0.012, 0.012, cont, 0.035, 0.006, 0.075, null, g), 'bess');
    kit.box(0.005, 0.003, 0.006, kit.decal(TX.louvre(0xbfc5c9)), -0.017, 0.007, 0.075, 'bess', g);
    this.box(0.004, 0.045, 0.004, this.mat(0x3a4148), 0.06, 0.0225, 0.075, g);
    this.socMat = this.mat(T.renew, { unique: true, emissive: T.renew, emissiveIntensity: 0.6 });
    this.socBar = this.box(0.0052, 0.045, 0.0052, this.socMat, 0.06, 0.0225, 0.075, g);
    this.socBar.userData.noShadow = true;
    this.socBarBase = 0.045;
  }

  _buildRoads() {
    const THREE = this.THREE;
    const m = this.kit.surface('road');
    const off = (id, dx, dz) => this.busPos(id).add(new THREE.Vector3(dx, 0, dz));
    const paths = [
      [off('sub_lv', 0.09, 0.07), off('f1', 0, 0.03), off('f2', 0, 0.026), off('f2a', 0, 0.022), off('f3a', 0, 0.024),
        off('f3', 0, 0.03), off('f4', 0, 0.034), off('mg', -0.06, 0.07)],
      [off('sub_lv', 0.1, -0.04), off('g1', -0.03, -0.035), off('g1', 0.12, -0.035), off('g2', 0, -0.03), off('g2', 0.17, -0.06)],
      [off('sub_hv', -0.05, 0.05), off('bulk', 0.08, 0.11), off('bulk', -0.02, 0.11)],
    ];
    for (const p of paths) {
      this.ribbon(p, 0.012, m, 0.0012, 18);
      for (const v of p) this.occupied.push([v.x, v.z, 0.012]);
      const curve = new THREE.CatmullRomCurve3(p);
      for (let i = 0; i <= 30; i++) { const q = curve.getPointAt(i / 30); this.occupied.push([q.x, q.z, 0.011]); }
    }
  }

  _buildTrees() {
    const THREE = this.THREE;
    const r = rng(7);
    const N = 420;
    const crownC = new THREE.InstancedMesh(new THREE.ConeGeometry(0.0055, 0.016, 7), new THREE.MeshStandardMaterial({ roughness: 0.9 }), N);
    const crownD = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.0065, 1), new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), N);
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.0007, 0.0011, 0.007, 5), this.mat(0x4f3b2a), N * 2);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const col = new THREE.Color();
    let nc = 0, nd = 0, nt = 0;
    const free = (x, z) => this.occupied.every(([ox, oz, or]) => (x - ox) ** 2 + (z - oz) ** 2 > (or + 0.006) ** 2);
    for (let tries = 0; tries < 6000 && nc + nd < N; tries++) {
      const x = (r() - 0.5) * (MAP_W - 0.04), z = (r() - 0.5) * (MAP_D - 0.04);
      if (!free(x, z)) continue;
      const k = 0.7 + r() * 0.6;
      q.setFromEuler(new THREE.Euler(0, r() * 6.28, 0));
      s.set(k, k, k);
      p.set(x, 0.0035 * k, z);
      trunks.setMatrixAt(nt++, m.compose(p, q, s));
      if (r() < 0.45) {
        p.set(x, 0.0035 * k * 2 + 0.006 * k, z);
        crownC.setMatrixAt(nc, m.compose(p, q, s));
        crownC.setColorAt(nc++, col.setHSL(0.3 + r() * 0.04, 0.35, 0.18 + r() * 0.06));
      } else {
        p.set(x, 0.0035 * k * 2 + 0.004 * k, z);
        crownD.setMatrixAt(nd, m.compose(p, q, s));
        crownD.setColorAt(nd++, col.setHSL(0.22 + r() * 0.08, 0.38, 0.24 + r() * 0.08));
      }
      this.occupied.push([x, z, 0.004]);
    }
    crownC.count = nc;
    crownD.count = nd;
    trunks.count = nt;
    this.root.add(crownC, crownD, trunks);
  }

  _buildParticles() {
    const THREE = this.THREE;
    this.maxParticles = 900;
    const mat = new THREE.MeshBasicMaterial({ color: T.flow });
    this.particles = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0032, 8, 6), mat, this.maxParticles);
    this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particles.count = 0;
    this.particles.frustumCulled = false;
    this.root.add(this.particles);
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
  }

  _buildEffects() {
    const THREE = this.THREE;
    // Fault: a flashing arc glow + a lightning bolt that strikes when the fault starts.
    this.faultGlow = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12),
      new THREE.MeshBasicMaterial({ color: T.alarm1, transparent: true, opacity: 0.8 }));
    this.faultGlow.visible = false;
    this.root.add(this.faultGlow);
    const r = rng(42);
    const pts = [];
    for (let i = 0; i <= 8; i++) pts.push(new THREE.Vector3((r() - 0.5) * 0.03, 0.22 - i * 0.025, (r() - 0.5) * 0.02));
    this.bolt = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0), 40, 0.0022, 5),
      new THREE.MeshBasicMaterial({ color: 0xe8f0ff }));
    this.bolt.visible = false;
    this.root.add(this.bolt);
    // Storm clouds.
    this.clouds = new THREE.Group();
    const cm = new THREE.MeshStandardMaterial({ color: 0x4a525c, transparent: true, opacity: 0.0, roughness: 1, depthWrite: false });
    this.cloudMat = cm;
    for (let i = 0; i < 9; i++) {
      const c = new THREE.Mesh(new THREE.SphereGeometry(0.04 + r() * 0.035, 14, 10), cm);
      c.scale.y = 0.3;
      c.position.set(-0.55 + r() * 1.1, 0.15 + r() * 0.04, -0.24 + r() * 0.48);
      c.userData.vx = 0.01 + r() * 0.01;
      this.clouds.add(c);
    }
    this.root.add(this.clouds);
    // Selection ring.
    this.selRing = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.0016, 8, 40),
      new THREE.MeshBasicMaterial({ color: T.select }));
    this.selRing.rotation.x = Math.PI / 2;
    this.selRing.visible = false;
    this.root.add(this.selRing);
  }

  // ---- per-frame ----------------------------------------------------------------------------
  setSelected(item) {
    this.selected = item;
  }

  itemAnchor(item) {
    const THREE = this.THREE;
    if (!item) return null;
    if (this.lines[item]) {
      const L = this.lines[item];
      const p = L.curve.getPointAt(this.markers[item] ? (L.kind === 'breaker' ? 0.3 : 0.5) : 0.5);
      return p;
    }
    if (this.net.buses[item]) {
      if (item === 'sub_lv' || item === 'sub_hv') return this.subGroup.position.clone().setY(0.02);
      if (item === 'mg') return this.mgGroup.position.clone().setY(0.02);
      return this.busPos(item).setY(0.01);
    }
    if (item === 'XFMR') return this.subGroup.position.clone().add(new THREE.Vector3(-0.01, 0.03, 0));
    if (item === 'bess') return this.mgGroup.position.clone().add(new THREE.Vector3(0.02, 0.012, 0.075));
    if (item === 'pv_farm') return this.busPos('g1').add(new THREE.Vector3(0.09, 0.008, -0.09));
    if (item === 'pv_mg') return this.mgGroup.position.clone().add(new THREE.Vector3(-0.01, 0.012, 0.045));
    if (this.net.loads[item]) {
      const ld = this.net.loads[item];
      if (ld.kind === 'critical') return this.mgGroup.position.clone().setY(0.03);
      const side = ld.bus.startsWith('g') ? -1 : 1;
      return this.busPos(ld.bus).add(new THREE.Vector3(0, 0.01, side * 0.065));
    }
    return null;
  }

  setRisk(results) {
    const THREE = this.THREE;
    for (const bar of Object.values(this.riskBars)) {
      this.root.remove(bar);
      const i = this.pickables.indexOf(bar);
      if (i >= 0) this.pickables.splice(i, 1);
    }
    this.riskBars = {};
    this.risk = results;
    if (!results) return;
    const c0 = new THREE.Color(T.risk0), c1 = new THREE.Color(T.risk1);
    for (const [id, r] of Object.entries(results)) {
      const p = id === 'XFMR' ? this.itemAnchor('XFMR') : (this.lines[id] ? this.lines[id].curve.getPointAt(0.5) : null);
      if (!p) continue;
      const h = 0.01 + r.risk * 0.16;
      const col = c0.clone().lerp(c1, Math.min(1, r.risk / 0.8));
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.014, h, 0.014),
        new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.5, transparent: true, opacity: 0.85 }));
      bar.position.set(p.x, p.y + 0.012 + h / 2, p.z);
      bar.userData.item = id;
      bar.userData.targetH = h;
      bar.scale.y = 0.01;
      this.root.add(bar);
      this.pickables.push(bar);
      this.riskBars[id] = bar;
    }
  }

  update(state, dt, worldQuat) {
    if (!state) return;
    const THREE = this.THREE;
    this.time += dt;
    const t = this.time;
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);

    // Day light for PV visuals.
    for (const [id, m] of Object.entries(this.pvMats)) {
      const pv = state.pv[id];
      const frac = pv ? Math.min(1, pv.kw / (this.net.pv[id].kw || 1)) : 0;
      m.emissiveIntensity = 0.1 + 0.7 * frac;
    }
    // Windows: lit when the customer has power. Facades keep their texture and only lose the glow.
    const night = state.hour < 6.5 || state.hour > 19 ? 1 : 0.55;
    for (const [id, mats] of Object.entries(this.loadMats)) {
      const on = state.loads[id] ? state.loads[id].served : false;
      for (const m of mats) {
        if (m.userData.facade) {
          m.emissiveIntensity = on ? 0.9 * night : 0.0;
          m.color.setHex(on ? 0xffffff : 0x8a8f94);
        } else {
          m.emissiveIntensity = on ? 0.85 : 0.0;
          m.color.setHex(on ? (id === 'ld_water' ? 0x4fa3c7 : T.window) : T.dead);
        }
      }
    }
    // Conductors: voltage-class tint when energized, dark when dead, alarm colours when loaded.
    for (const [id, L] of Object.entries(this.lines)) {
      const br = state.branches[id];
      const busA = state.buses[this.net.branches[id].a], busB = state.buses[this.net.branches[id].b];
      const live = br && br.closed && (busA.energized || busB.energized);
      let col = live ? L.tint : 0x3d434a, emi = live ? 0.15 : 0.0;
      if (live && br.loading > 1.0) { col = T.alarm2; emi = 0.4 + 0.5 * pulse; }
      else if (live && br.loading > 0.9) { col = T.alarm3; emi = 0.35; }
      if (this.risk && this.risk[id]) {
        col = new THREE.Color(T.risk0).lerp(new THREE.Color(T.risk1), Math.min(1, this.risk[id].risk / 0.8)).getHex();
        emi = 0.4;
      }
      L.mat.color.setHex(col);
      L.mat.emissive.setHex(col);
      L.mat.emissiveIntensity = emi;
    }
    // Switching device markers.
    const trippedKeys = new Set(state.alarms.filter((a) => a.active && a.key.includes(':trip')).map((a) => a.key.split(':')[0]));
    for (const [id, mk] of Object.entries(this.markers)) {
      const closed = state.closed[id];
      const normal = this.net.branches[id].normally === 'closed';
      mk.fill.visible = closed;
      let col = T.equip;
      if (!closed && trippedKeys.has(id)) col = pulse > 0.5 ? T.alarm1 : 0x7a1f1d;
      else if (closed !== normal) col = T.alarm3;
      mk.frameMat.color.setHex(col);
      mk.frameMat.emissive.setHex(col);
      mk.frameMat.emissiveIntensity = col === T.equip ? 0.25 : 0.8;
    }
    // Billboards face the viewer (+z in world).
    if (worldQuat) {
      const inv = worldQuat.clone().invert();
      for (const b of this.billboards) b.quaternion.copy(inv);
    }
    // FCI flags.
    for (const [id, f] of Object.entries(this.fciFlags)) {
      f.visible = !!(state.fci && state.fci[id]);
      if (f.visible) f.children[1].material.emissiveIntensity = 0.5 + 0.6 * pulse;
    }
    // Fault effects.
    const faultLive = state.fault && (state.closed.SW_A || state.closed.SW_B);
    if (state.fault) {
      const p = this.busPos(state.fault);
      this.faultGlow.position.set(p.x, H_DIST, p.z);
      this.faultGlow.visible = faultLive;
      this.faultGlow.scale.setScalar(0.6 + 0.8 * Math.abs(Math.sin(t * 9)));
      this.faultGlow.material.opacity = 0.35 + 0.5 * pulse;
      if (this._faultT === undefined) this._faultT = t;
      this.bolt.visible = t - this._faultT < 1.6 && Math.sin(t * 40) > -0.2;
      this.bolt.position.set(p.x, H_DIST, p.z);
    } else {
      this.faultGlow.visible = false;
      this.bolt.visible = false;
      this._faultT = undefined;
    }
    // Storm clouds fade in as cloud cover drops.
    const storm = Math.max(0, Math.min(1, (0.75 - state.cloud) / 0.45));
    this.cloudMat.opacity = 0.28 * storm;
    this.clouds.visible = storm > 0.01;
    for (const c of this.clouds.children) {
      c.position.x += c.userData.vx * dt;
      if (c.position.x > 0.65) c.position.x = -0.65;
    }
    // Steam from the plant: puffs rise, grow and fade on a loop.
    for (const p of this.plumes) {
      const u = ((t * p.rate) + (p.phase || 0)) % 1;
      p.mesh.position.set(p.x + u * 0.03, p.y + u * 0.05 * p.size, p.z - u * 0.01);
      p.mesh.scale.setScalar((0.5 + u * 1.4) * p.size);
      p.mesh.material.opacity = 0.45 * Math.sin(u * Math.PI) * (p.size < 1 ? 0.6 : 1);
    }
    // Wind turbines.
    for (const s of this.spinners) s.obj.rotation.z -= s.speed * dt;
    // Battery gauge.
    const soc = state.bess.soc;
    this.socBar.scale.y = Math.max(0.02, soc);
    this.socBar.position.y = (this.socBarBase * this.socBar.scale.y) / 2;
    const bk = state.bess.kw;
    const bcol = bk > 20 ? T.renew : bk < -20 ? T.flow : T.equip;
    this.socMat.color.setHex(bcol);
    this.socMat.emissive.setHex(bcol);
    this.socMat.emissiveIntensity = Math.abs(bk) > 20 ? 0.5 + 0.4 * pulse : 0.2;

    this._updateParticles(state, dt);

    // Selection ring.
    const anchor = this.itemAnchor(this.selected);
    this.selRing.visible = !!anchor;
    if (anchor) {
      this.selRing.position.copy(anchor);
      this.selRing.scale.setScalar(1 + 0.15 * Math.sin(t * 4));
    }
    // Risk bars grow in.
    for (const bar of Object.values(this.riskBars)) bar.scale.y = Math.min(1, bar.scale.y + dt * 1.5);
  }

  _updateParticles(state, dt) {
    let n = 0;
    const m = this._m4, q = this._q, s = this._s;
    for (const [id, L] of Object.entries(this.lines)) {
      const br = state.branches[id];
      if (!br || !br.closed || Math.abs(br.kw) < 15) continue;
      const busA = state.buses[this.net.branches[id].a], busB = state.buses[this.net.branches[id].b];
      if (!busA.energized && !busB.energized) continue;
      const dir = br.kw >= 0 ? 1 : -1;
      const mag = Math.min(1, Math.abs(br.kw) / 3000);
      const speed = (0.06 + 0.22 * mag) / Math.max(0.05, L.len);     // curve fraction per second
      this.particlePhase[id] = ((this.particlePhase[id] || 0) + dir * speed * dt + 1) % 1;
      const count = Math.max(2, Math.round(L.len * (14 + 40 * mag)));
      for (let i = 0; i < count && n < this.maxParticles; i++) {
        const u = (this.particlePhase[id] + i / count) % 1;
        const p = L.curve.getPointAt(u);
        p.y += 0.0005;
        m.compose(p, q, s);
        this.particles.setMatrixAt(n++, m);
      }
    }
    this.particles.count = n;
    this.particles.instanceMatrix.needsUpdate = true;
  }
}
