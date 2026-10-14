// Substation digital twin: the drill-down view. Equipment is built procedurally at a larger scale
// than the map, laid out like a real 115/12.47 kV distribution substation: incoming line ->
// disconnect switch -> HV breaker -> power transformer -> LV bus -> feeder breakers -> feeders.
//
// Every device is pickable and maps onto an id the server has a card for.

import { T } from './theme.js';

export const TWIN_ITEMS = {
  twin_line: { title: 'Incoming 115 kV line', card: 'TL1' },
  twin_ds: { title: 'HV disconnect switch',
    text: 'A visible air gap that lets crews confirm the circuit is open before working on it. It is only operated with no load current flowing (after the breaker opens).' },
  twin_hvbkr: { title: 'HV circuit breaker (SF6 dead-tank)',
    text: 'Interrupts fault current on the 115 kV side. The arc is quenched in sulfur hexafluoride (SF6) gas inside the grounded tanks.' },
  twin_ct: { title: 'Current transformers (CTs) and voltage transformers (VTs)',
    text: 'Scale the high currents and voltages down to safe levels (e.g. 5 A, 120 V) for relays and meters. Protection only works if the relay can measure.' },
  twin_xfmr: { title: 'Power transformer', card: 'XFMR' },
  twin_bus: { title: '12.47 kV bus',
    text: 'Rigid aluminium tubes on insulators that every feeder breaker connects to.' },
  twin_relay: { title: 'Control house: protective relays + SCADA RTU',
    text: 'Microprocessor relays watch the CTs and VTs and trip breakers within cycles of a fault. The RTU reports breaker status and measurements to the control center.' },
  twin_f1: { title: 'Feeder 1 breaker', card: 'BKR_F1', device: 'BKR_F1' },
  twin_f2: { title: 'Feeder 2 breaker', card: 'BKR_F2', device: 'BKR_F2' },
};

export class SubstationTwin {
  constructor(THREE) {
    this.THREE = THREE;
    this.root = new THREE.Group();
    this.pickables = [];
    this.markers = {};
    this.selected = null;
    this.time = 0;
    this._build();
  }

  mat(color, o = {}) { return new this.THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2, ...o }); }

  box(w, h, d, m, x, y, z, item, parent = this.root) {
    const o = new this.THREE.Mesh(new this.THREE.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z);
    parent.add(o);
    if (item) { o.userData.item = item; this.pickables.push(o); }
    return o;
  }

  cyl(r1, r2, h, m, x, y, z, item, parent = this.root, seg = 16) {
    const o = new this.THREE.Mesh(new this.THREE.CylinderGeometry(r1, r2, h, seg), m);
    o.position.set(x, y, z);
    parent.add(o);
    if (item) { o.userData.item = item; this.pickables.push(o); }
    return o;
  }

  insulator(x, y, z, h, item) {
    const porcelain = this.mat(0xb8714a, { roughness: 0.4 });
    const n = Math.round(h / 0.012);
    for (let i = 0; i < n; i++) this.cyl(0.009, 0.009, 0.003, porcelain, x, y + i * 0.012 + 0.006, z, item, this.root, 10);
    this.cyl(0.004, 0.004, h, porcelain, x, y + h / 2, z, item, this.root, 8);
  }

  _build() {
    const steel = this.mat(0xa4adb5, { metalness: 0.6 });
    const grey = this.mat(0x7c868f, { metalness: 0.35 });
    // Gravel yard.
    this.box(1.5, 0.02, 0.62, this.mat(0x3b4148, { roughness: 1 }), 0, -0.01, 0);
    // Incoming line on a dead-end structure (left).
    for (const z of [-0.08, 0.08]) this.box(0.012, 0.32, 0.012, steel, -0.66, 0.16, z, 'twin_line');
    this.box(0.012, 0.012, 0.2, steel, -0.66, 0.31, 0, 'twin_line');
    for (let p = -1; p <= 1; p++) {
      const curve = new this.THREE.CatmullRomCurve3([
        new this.THREE.Vector3(-0.8, 0.33, p * 0.06), new this.THREE.Vector3(-0.66, 0.29, p * 0.06),
        new this.THREE.Vector3(-0.56, 0.2, p * 0.06)]);
      const w = new this.THREE.Mesh(new this.THREE.TubeGeometry(curve, 20, 0.003, 6), this.mat(T.kv115));
      this.root.add(w);
    }
    // Disconnect switch: three insulator columns + blades.
    for (let p = -1; p <= 1; p++) {
      this.insulator(-0.56, 0.08, p * 0.06, 0.1, 'twin_ds');
      this.insulator(-0.48, 0.08, p * 0.06, 0.1, 'twin_ds');
      this.box(0.09, 0.006, 0.008, steel, -0.52, 0.19, p * 0.06, 'twin_ds');
    }
    this.box(0.14, 0.08, 0.22, steel, -0.52, 0.04, 0, 'twin_ds').scale.set(1, 1, 1);
    // HV breaker: three SF6 tanks on a frame.
    this.box(0.12, 0.06, 0.24, steel, -0.36, 0.03, 0, 'twin_hvbkr');
    for (let p = -1; p <= 1; p++) {
      const tank = this.cyl(0.024, 0.024, 0.09, grey, -0.36, 0.09, p * 0.07, 'twin_hvbkr');
      tank.rotation.z = Math.PI / 2;
      this.insulator(-0.39, 0.11, p * 0.07, 0.07, 'twin_hvbkr');
      this.insulator(-0.33, 0.11, p * 0.07, 0.07, 'twin_hvbkr');
    }
    // CTs/VTs.
    for (let p = -1; p <= 1; p++) {
      this.insulator(-0.24, 0.0, p * 0.07, 0.14, 'twin_ct');
      this.cyl(0.02, 0.02, 0.03, grey, -0.24, 0.16, p * 0.07, 'twin_ct');
    }
    // Power transformer.
    const tankMat = this.mat(0x6f7b85, { metalness: 0.4 });
    this.box(0.2, 0.18, 0.16, tankMat, -0.04, 0.09, 0, 'twin_xfmr');
    for (let i = 0; i < 9; i++) this.box(0.008, 0.15, 0.1, this.mat(0x5f6a73), -0.04 - 0.08 + i * 0.02, 0.085, -0.14, 'twin_xfmr');
    for (let i = 0; i < 9; i++) this.box(0.008, 0.15, 0.1, this.mat(0x5f6a73), -0.04 - 0.08 + i * 0.02, 0.085, 0.14, 'twin_xfmr');
    const cons = this.cyl(0.025, 0.025, 0.14, tankMat, -0.04, 0.22, 0.03, 'twin_xfmr');
    cons.rotation.x = Math.PI / 2;
    for (let p = -1; p <= 1; p++) {
      this.insulator(-0.1, 0.18, p * 0.045, 0.09, 'twin_xfmr');   // HV bushings
      this.insulator(0.03, 0.18, p * 0.045, 0.05, 'twin_xfmr');   // LV bushings
    }
    // Nameplate (a plain plate; details are in the card).
    this.box(0.04, 0.025, 0.002, this.mat(0xc9d1d8), -0.04, 0.1, 0.081, 'twin_xfmr');
    // HV jumpers from breaker to transformer.
    for (let p = -1; p <= 1; p++) {
      const c = new this.THREE.CatmullRomCurve3([
        new this.THREE.Vector3(-0.48, 0.19, p * 0.06), new this.THREE.Vector3(-0.39, 0.19, p * 0.07),
        new this.THREE.Vector3(-0.24, 0.17, p * 0.07), new this.THREE.Vector3(-0.1, 0.28, p * 0.045)]);
      this.root.add(new this.THREE.Mesh(new this.THREE.TubeGeometry(c, 30, 0.0025, 6), this.mat(T.kv115)));
    }
    // LV bus on insulators.
    this.busMats = [];
    for (let p = -1; p <= 1; p++) {
      const m = this.mat(T.kv12, { emissive: T.kv12, emissiveIntensity: 0.15 });
      this.busMats.push(m);
      const tube = this.cyl(0.005, 0.005, 0.42, m, 0.3, 0.2, p * 0.05, 'twin_bus');
      tube.rotation.z = Math.PI / 2;
      for (const x of [0.12, 0.3, 0.48]) this.insulator(x, 0.0, p * 0.05, 0.19, 'twin_bus');
      const c = new this.THREE.CatmullRomCurve3([
        new this.THREE.Vector3(0.03, 0.23, p * 0.045), new this.THREE.Vector3(0.08, 0.24, p * 0.05),
        new this.THREE.Vector3(0.1, 0.2, p * 0.05)]);
      this.root.add(new this.THREE.Mesh(new this.THREE.TubeGeometry(c, 12, 0.003, 6), m));
    }
    // Feeder breakers: metal-clad switchgear lineup with status markers.
    const gear = this.mat(0x8a949e, { metalness: 0.3 });
    const bays = [['twin_f1', 'BKR_F1', 0.22], ['twin_f2', 'BKR_F2', 0.4]];
    for (const [item, dev, x] of bays) {
      this.box(0.13, 0.15, 0.09, gear, x, 0.075, 0.2, item);
      this.box(0.11, 0.12, 0.004, this.mat(0x6c757e), x, 0.075, 0.247, item);
      const g = new this.THREE.Group();
      g.position.set(x, 0.19, 0.25);
      this.root.add(g);
      const S = 0.04, W = 0.007;
      const fm = this.mat(T.equip, { emissive: T.equip, emissiveIntensity: 0.3 });
      for (const [bx, by, w, h] of [[0, S / 2, S, W], [0, -S / 2, S, W], [S / 2, 0, W, S], [-S / 2, 0, W, S]]) this.box(w, h, 0.004, fm, bx, by, 0, item, g);
      const fill = this.box(S - W, S - W, 0.003, this.mat(0xc9d1d8, { emissive: 0xc9d1d8, emissiveIntensity: 0.3 }), 0, 0, 0, item, g);
      this.markers[dev] = { fill, fm };
    }
    // Control house.
    this.box(0.2, 0.12, 0.14, this.mat(0x59626b), 0.56, 0.06, -0.18, 'twin_relay');
    this.box(0.21, 0.01, 0.15, this.mat(0x48505a), 0.56, 0.125, -0.18, 'twin_relay');
    this.box(0.03, 0.06, 0.003, this.mat(0x3a4048), 0.5, 0.03, -0.108, 'twin_relay');
    // Selection ring.
    this.ring = new this.THREE.Mesh(new this.THREE.TorusGeometry(0.06, 0.004, 8, 48), new this.THREE.MeshBasicMaterial({ color: T.select }));
    this.ring.rotation.x = Math.PI / 2;
    this.ring.visible = false;
    this.root.add(this.ring);
  }

  anchor(item) {
    const a = {
      twin_line: [-0.66, 0.02, 0], twin_ds: [-0.52, 0.02, 0], twin_hvbkr: [-0.36, 0.02, 0],
      twin_ct: [-0.24, 0.02, 0], twin_xfmr: [-0.04, 0.02, 0], twin_bus: [0.3, 0.02, 0],
      twin_relay: [0.56, 0.02, -0.18], twin_f1: [0.22, 0.02, 0.2], twin_f2: [0.4, 0.02, 0.2],
    }[item];
    return a ? new this.THREE.Vector3(...a) : null;
  }

  update(state, dt) {
    this.time += dt;
    if (!state) return;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 6);
    const live = state.buses.sub_lv.energized;
    for (const m of this.busMats) {
      m.color.setHex(live ? T.kv12 : 0x3d434a);
      m.emissiveIntensity = live ? 0.15 : 0;
    }
    const tripped = new Set(state.alarms.filter((a) => a.active && a.key.includes(':trip')).map((a) => a.key.split(':')[0]));
    for (const [dev, mk] of Object.entries(this.markers)) {
      const closed = state.closed[dev];
      mk.fill.visible = closed;
      const col = !closed && tripped.has(dev) ? (pulse > 0.5 ? T.alarm1 : 0x7a1f1d) : !closed ? T.alarm3 : T.equip;
      mk.fm.color.setHex(col);
      mk.fm.emissive.setHex(col);
    }
    const p = this.anchor(this.selected);
    this.ring.visible = !!p;
    if (p) { this.ring.position.copy(p); this.ring.scale.setScalar(1 + 0.12 * Math.sin(this.time * 4)); }
  }
}
