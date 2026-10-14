// The regional grid map: a tabletop diorama built procedurally from the network description.
//
// Units: the network's (x, z) positions span about 1.5 x 0.6 "map units"; heights are in the same
// units. app.js scales the whole diorama into the virtual display, so nothing here knows about
// metres or the screen.

import { T } from './theme.js';

const H_TX = 0.065;     // transmission conductor height
const H_DIST = 0.03;    // distribution conductor height
// Map compaction: bus positions are pulled together so equipment reads larger relative to the map.
export const K = 0.72;
export const MAP_W = 1.26, MAP_D = 0.66;

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
    this.pickables = [];
    this.lines = {};                       // branch id -> {curve, tube, mat, len, ...}
    this.markers = {};                     // branch id -> status marker group
    this.fciFlags = {};
    this.loadMats = {};                    // load id -> window material
    this.loadBodies = {};
    this.billboards = [];
    this.spinners = [];
    this.pvMats = {};
    this.matCache = new Map();
    this.particlePhase = {};
    this.selected = null;
    this.riskBars = {};
    this.time = 0;
    this._build();
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

  // ---- build --------------------------------------------------------------------------------
  _build() {
    const THREE = this.THREE;
    // Table slab and terrain accents.
    const slab = this.box(MAP_W, 0.03, MAP_D, this.mat(T.slab), 0, -0.015, 0);
    slab.receiveShadow = true;
    this.box(MAP_W + 0.02, 0.012, MAP_D + 0.02, this.mat(T.slabEdge), 0, -0.033, 0);
    // A river across the map for orientation.
    const river = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
        new THREE.Vector3(-0.62, 0.001, 0.31), new THREE.Vector3(-0.3, 0.001, 0.29),
        new THREE.Vector3(0.0, 0.001, 0.312), new THREE.Vector3(0.3, 0.001, 0.305),
        new THREE.Vector3(0.62, 0.001, 0.29)]), 40, 0.014, 6, false),
      this.mat(T.water, { roughness: 0.3 }));
    river.scale.y = 0.08;
    this.root.add(river);
    // Faint district grid.
    const grid = new THREE.GridHelper(MAP_W, 28, 0x3a434c, 0x30373f);
    grid.position.y = 0.0005;
    grid.scale.z = MAP_D / MAP_W;
    this.root.add(grid);

    this._buildBulk();
    this._buildSubstation();
    for (const [id, b] of Object.entries(this.net.branches)) {
      if (b.kind === 'xfmr') continue;
      this._buildBranch(id, b);
    }
    this._buildLoads();
    this._buildPV();
    this._buildMicrogrid();
    this._buildParticles();
    this._buildEffects();
  }

  _buildBulk() {
    const p = this.busPos('bulk');
    const g = new this.THREE.Group();
    g.position.copy(p);
    this.root.add(g);
    // Gas plant: turbine hall + two stacks.
    this.pick(this.box(0.08, 0.035, 0.05, this.mat(T.equipDark), -0.02, 0.0175, 0.02, g), 'bulk');
    this.pick(this.cyl(0.006, 0.008, 0.09, this.mat(T.equip), 0.03, 0.045, 0.03, g), 'bulk');
    this.pick(this.cyl(0.006, 0.008, 0.09, this.mat(T.equip), 0.045, 0.045, 0.018, g), 'bulk');
    // Wind farm on the ridge behind.
    for (let i = 0; i < 4; i++) {
      const t = new this.THREE.Group();
      t.position.set(-0.05 + i * 0.045, 0, -0.07 + (i % 2) * 0.02);
      g.add(t);
      this.cyl(0.0012, 0.0024, 0.1, this.mat(0xd7dde3), 0, 0.05, 0, t);
      const hub = new this.THREE.Group();
      hub.position.set(0, 0.1, 0.004);
      t.add(hub);
      for (let k = 0; k < 3; k++) {
        const blade = this.box(0.0025, 0.045, 0.0008, this.mat(0xe8edf1), 0, 0.022, 0, new this.THREE.Group());
        const arm = blade.parent;
        arm.rotation.z = (k * 2 * Math.PI) / 3;
        hub.add(arm);
      }
      this.spinners.push({ obj: hub, speed: 1.6 + i * 0.2 });
      this.pick(t.children[0], 'bulk');
    }
  }

  _buildSubstation() {
    const a = this.busPos('sub_hv'), b = this.busPos('sub_lv');
    const c = a.clone().add(b).multiplyScalar(0.5);
    const g = new this.THREE.Group();
    g.position.copy(c);
    this.root.add(g);
    this.subGroup = g;
    // Gravel pad + fence posts.
    this.pick(this.box(0.16, 0.004, 0.12, this.mat(0x3b4148), 0, 0.002, 0, g), 'sub_lv');
    const fence = this.mat(0x6b747d);
    for (let i = 0; i <= 8; i++) {
      for (const z of [-0.06, 0.06]) this.box(0.0012, 0.012, 0.0012, fence, -0.08 + i * 0.02, 0.006, z, g);
    }
    for (let i = 0; i <= 6; i++) {
      for (const x of [-0.08, 0.08]) this.box(0.0012, 0.012, 0.0012, fence, x, 0.006, -0.06 + i * 0.02, g);
    }
    // Power transformer: tank, radiators, bushings.
    const tank = this.box(0.04, 0.032, 0.03, this.mat(0x7c868f, { metalness: 0.3 }), -0.01, 0.02, 0, g);
    this.pick(tank, 'XFMR');
    for (let i = 0; i < 5; i++) this.pick(this.box(0.002, 0.026, 0.016, this.mat(0x6a737b), -0.035 - i * 0.0035, 0.018, 0, g), 'XFMR');
    for (let i = 0; i < 3; i++) {
      this.cyl(0.0018, 0.0026, 0.02, this.mat(0xb8714a), -0.02 + i * 0.01, 0.046, -0.008, g, 8);  // HV bushings
      this.cyl(0.0014, 0.002, 0.01, this.mat(0xb8714a), -0.02 + i * 0.01, 0.041, 0.01, g, 8);    // LV bushings
    }
    this.xfmrTank = tank;
    // HV steel structure.
    const steel = this.mat(0x9aa3ab, { metalness: 0.5 });
    for (const x of [-0.06, -0.035]) this.box(0.002, 0.06, 0.002, steel, x - 0.01, 0.03, -0.04, g);
    this.box(0.03, 0.002, 0.002, steel, -0.0575, 0.06, -0.04, g);
    // LV switchgear lineup (feeder breakers live here).
    this.box(0.05, 0.022, 0.016, this.mat(0x737d86), 0.045, 0.011, 0.025, g);
    // Control house.
    this.box(0.035, 0.02, 0.025, this.mat(0x59626b), 0.05, 0.01, -0.03, g);
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
    const pts = [];
    const sag = b.kind === 'tline' ? 0.012 : 0.006;
    for (let i = 0; i < spans; i++) {
      pts.push(supports[i]);
      pts.push(supports[i].clone().lerp(supports[i + 1], 0.5).setY(h - sag));
    }
    pts.push(supports[spans]);
    return { curve: new THREE.CatmullRomCurve3(pts), supports, len, h };
  }

  _buildBranch(id, b) {
    const THREE = this.THREE;
    const { curve, supports, len, h } = this._branchCurve(id, b);
    const tint = b.kind === 'tline' ? T.kv115 : T.kv12;
    const mat = this.mat(tint, { unique: true, roughness: 0.5, emissive: tint, emissiveIntensity: 0.15 });
    const r = b.kind === 'tline' ? 0.0022 : 0.0015;
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(16, supports.length * 8), r, 6, false), mat);
    this.root.add(tube);
    // Fat invisible tube for picking: thin wires are hard to hit.
    const hit = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.012, 6, false),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    this.root.add(this.pick(hit, id));

    // Supports: lattice towers for transmission, wood poles for distribution.
    if (b.kind === 'tline') {
      const steel = this.mat(0x9aa3ab, { metalness: 0.5 });
      for (const s of supports.slice(1, -1)) {
        this.cyl(0.0018, 0.0065, h, steel, s.x, h / 2, s.z, this.root, 4);
        this.box(0.03, 0.0016, 0.0016, steel, s.x, h, s.z);
      }
    } else if (b.kind === 'line') {
      const wood = this.mat(0x7a6650);
      for (const s of supports.slice(1, -1)) {
        this.cyl(0.0011, 0.0014, h + 0.004, wood, s.x, (h + 0.004) / 2, s.z, this.root, 6);
        this.box(0.014, 0.0012, 0.0012, wood, s.x, h + 0.001, s.z);
      }
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
      // Pole + device box under the marker.
      this.cyl(0.0011, 0.0014, h, this.mat(0x7a6650), at.x, h / 2, at.z, this.root, 6);
      this.pick(this.box(0.006, 0.006, 0.006, this.mat(T.equipDark), at.x, h + 0.002, at.z), id);
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
    const THREE = this.THREE;
    for (const [id, ld] of Object.entries(this.net.loads)) {
      if (ld.kind === 'critical') continue; // the microgrid builds its own
      const c = this.busPos(ld.bus);
      const r = rng(id.length * 7919 + ld.kw);
      const winMat = this.mat(T.window, { unique: true, emissive: T.window, emissiveIntensity: 0.8 });
      const bodyMat = this.mat(ld.kind === 'commercial' ? 0x6f7881 : 0x8a8478, { unique: true });
      const roofMat = this.mat(0x5a4d45);
      this.loadMats[id] = winMat;
      this.loadBodies[id] = bodyMat;
      const n = ld.kind === 'commercial' ? 6 : 12;
      const side = ld.bus.startsWith('g') ? -1 : 1;     // feeder 2 towns sit north of their line
      for (let i = 0; i < n; i++) {
        const x = c.x - 0.065 + r() * 0.13;
        const z = c.z + side * (0.035 + r() * 0.065);
        if (ld.kind === 'commercial') {
          const h = 0.018 + r() * 0.03;
          const w = 0.012 + r() * 0.01;
          const b = this.box(w, h, w, bodyMat, x, h / 2, z);
          this.pick(b, id);
          for (let k = 1; k * 0.008 < h; k++) this.box(w * 1.02, 0.0025, w * 1.02, winMat, x, k * 0.008, z);
        } else {
          const b = this.box(0.012, 0.009, 0.0105, bodyMat, x, 0.0045, z);
          b.rotation.y = r() * 0.6;
          this.pick(b, id);
          const roof = new THREE.Mesh(new THREE.ConeGeometry(0.0098, 0.006, 4), roofMat);
          roof.position.set(x, 0.012, z);
          roof.rotation.y = Math.PI / 4 + b.rotation.y;
          this.root.add(roof);
          this.box(0.005, 0.0033, 0.0108, winMat, x, 0.0048, z).rotation.y = b.rotation.y;
        }
      }
    }
  }

  _buildPV() {
    const THREE = this.THREE;
    const c = this.busPos('g1');
    const pmat = this.mat(0x1f3550, { unique: true, metalness: 0.4, roughness: 0.35, emissive: 0x2a5d9c, emissiveIntensity: 0.3 });
    this.pvMats.pv_farm = pmat;
    const geo = new THREE.BoxGeometry(0.016, 0.001, 0.008);
    const rows = 6, cols = 9;
    const inst = new THREE.InstancedMesh(geo, pmat, rows * cols);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5, 0, 0));
    let k = 0;
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      m.compose(new THREE.Vector3(c.x + 0.02 + j * 0.019, 0.006, c.z - 0.06 - i * 0.013), q, new THREE.Vector3(1, 1, 1));
      inst.setMatrixAt(k++, m);
    }
    this.root.add(this.pick(inst, 'pv_farm'));
  }

  _buildMicrogrid() {
    const THREE = this.THREE;
    const c = this.busPos('mg');
    const g = new THREE.Group();
    g.position.copy(c);
    this.root.add(g);
    this.mgGroup = g;
    this.pick(this.box(0.2, 0.003, 0.15, this.mat(0x2f3a36), 0.03, 0.0015, 0.01, g), 'mg');
    const crit = (id, w, h, d, x, z, color) => {
      const win = this.mat(T.window, { unique: true, emissive: T.window, emissiveIntensity: 0.8 });
      const body = this.mat(color, { unique: true });
      this.loadMats[id] = win;
      this.loadBodies[id] = body;
      this.pick(this.box(w, h, d, body, x, h / 2, z, g), id);
      for (let k = 1; k * 0.009 < h; k++) this.box(w * 1.02, 0.003, d * 1.02, win, x, k * 0.009, z, g);
    };
    crit('ld_hosp', 0.05, 0.04, 0.035, -0.02, -0.03, 0xb9c0c6);         // hospital
    this.box(0.012, 0.012, 0.012, this.mat(0xb9c0c6), -0.02, 0.046, -0.03, g); // rooftop plant
    crit('ld_fire', 0.022, 0.014, 0.018, 0.045, -0.045, 0x8f7f73);       // fire station
    // Water treatment: clarifier tanks.
    const wmat = this.mat(0x7f8a92);
    this.loadMats.ld_water = this.mat(0x4fa3c7, { unique: true, emissive: 0x4fa3c7, emissiveIntensity: 0.6 });
    this.loadBodies.ld_water = wmat;
    for (const [x, z] of [[0.08, 0.02], [0.105, 0.045], [0.08, 0.06]]) {
      this.pick(this.cyl(0.012, 0.012, 0.008, wmat, x, 0.004, z, g), 'ld_water');
      this.cyl(0.0105, 0.0105, 0.0005, this.loadMats.ld_water, x, 0.0083, z, g);
    }
    // Carport solar.
    const pmat = this.mat(0x1f3550, { unique: true, metalness: 0.4, roughness: 0.35, emissive: 0x2a5d9c, emissiveIntensity: 0.3 });
    this.pvMats.pv_mg = pmat;
    for (let i = 0; i < 4; i++) {
      const p = this.box(0.03, 0.0012, 0.014, pmat, -0.06 + i * 0.032, 0.012, 0.045, g);
      p.rotation.x = -0.25;
      this.pick(p, 'pv_mg');
      this.cyl(0.0008, 0.0008, 0.011, this.mat(0x9aa3ab), -0.06 + i * 0.032, 0.0055, 0.045, g, 4);
    }
    // Battery containers + SOC gauge.
    const bmat = this.mat(0xd9dee2);
    this.pick(this.box(0.03, 0.012, 0.012, bmat, 0.0, 0.006, 0.075, g), 'bess');
    this.pick(this.box(0.03, 0.012, 0.012, bmat, 0.035, 0.006, 0.075, g), 'bess');
    this.box(0.004, 0.045, 0.004, this.mat(0x3a4148), 0.06, 0.0225, 0.075, g);
    this.socMat = this.mat(T.renew, { unique: true, emissive: T.renew, emissiveIntensity: 0.6 });
    this.socBar = this.box(0.0052, 0.045, 0.0052, this.socMat, 0.06, 0.0225, 0.075, g);
    this.socBarBase = 0.045;
  }

  _buildParticles() {
    const THREE = this.THREE;
    this.maxParticles = 900;
    const mat = new THREE.MeshBasicMaterial({ color: T.flow });
    this.particles = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0032, 8, 6), mat, this.maxParticles);
    this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particles.count = 0;
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
    for (const bar of Object.values(this.riskBars)) this.root.remove(bar);
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
    // Windows: lit when the customer has power.
    for (const [id, m] of Object.entries(this.loadMats)) {
      const on = state.loads[id] ? state.loads[id].served : false;
      m.emissiveIntensity = on ? 0.85 : 0.0;
      m.color.setHex(on ? (id === 'ld_water' ? 0x4fa3c7 : T.window) : T.dead);
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
