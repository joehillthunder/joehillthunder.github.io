// Substation digital twin: the drill-down view, laid out like a real 115/12.47 kV distribution
// substation and built at high detail so trainees recognise the equipment on their first site walk:
// incoming line on a dead-end structure -> surge arresters -> disconnect switch -> SF6 dead-tank
// breaker -> CTs/VTs -> power transformer (radiators, fans, conservator, LTC) -> 12.47 kV bus ->
// metal-clad feeder switchgear -> feeder riser poles. Around it: control house, cable trench,
// capacitor bank, shield masts, grounded fence and signage.
//
// Every device is pickable and maps onto an id the server has a card for, or carries its own text.

import { T } from './theme.js';
import { Kit } from './kit.js';
import * as TX from './textures.js';
import { makeLabel, fmtA, fmtKW, PRESETS } from './layers.js';

export const TWIN_ITEMS = {
  twin_line: { title: 'Incoming 115 kV line', card: 'TL1' },
  twin_arrester: { title: 'Surge arresters',
    text: 'Metal-oxide arresters clamp lightning and switching surges and send them to ground before they reach the transformer insulation. A damaged arrester can fail violently: report it and stay clear.' },
  twin_ds: { title: 'HV disconnect switch',
    text: 'A visible air gap that lets crews confirm the circuit is open before working on it. It is only operated with no load current flowing (after the breaker opens).' },
  twin_hvbkr: { title: 'HV circuit breaker (SF6 dead-tank)',
    text: 'Interrupts fault current on the 115 kV side. The arc is quenched in sulfur hexafluoride (SF6) gas inside the grounded tanks. The cabinet holds the operating mechanism and gas-pressure gauges.' },
  twin_ct: { title: 'Current transformers (CTs) and voltage transformers (VTs)',
    text: 'Scale the high currents and voltages down to safe levels (e.g. 5 A, 120 V) for relays and meters. Protection only works if the relay can measure. Never open a CT secondary circuit under load.' },
  twin_xfmr: { title: 'Power transformer', card: 'XFMR' },
  twin_cooling: { title: 'Radiators and cooling fans',
    text: 'Oil circulates through the radiators to shed heat. Fans force air through them when the oil runs hot; in this model their speed follows the transformer\'s load, so watch them spin up as load shifts.' },
  twin_ltc: { title: 'Load tap changer (LTC)',
    text: 'Changes the transformer\'s turns ratio in small steps while it carries load, holding the 12.47 kV bus voltage in its band as demand rises and falls through the day.' },
  twin_bus: { title: '12.47 kV bus',
    text: 'Rigid aluminium tubes on post insulators that every feeder breaker connects to. It glows in the distribution tint when energized and goes dark when it is dead.' },
  twin_relay: { title: 'Control house: protective relays + SCADA RTU',
    text: 'Microprocessor relays watch the CTs and VTs and trip breakers within cycles of a fault. The RTU reports breaker status and measurements to the control center. Control cables run to every device in the concrete trench.' },
  twin_f1: { title: 'Feeder 1 breaker', card: 'BKR_F1', device: 'BKR_F1' },
  twin_f2: { title: 'Feeder 2 breaker', card: 'BKR_F2', device: 'BKR_F2' },
  twin_cap: { title: 'Capacitor bank',
    text: 'Supplies reactive power to support voltage at peak load. Capacitors hold a charge after they are switched off: crews wait, then ground them, before touching anything.' },
  twin_mast: { title: 'Shield masts and ground grid',
    text: 'Masts intercept lightning. The buried copper ground grid bonds every structure so touch and step voltages stay safe during a fault. Never open or cut a ground connection in a live yard.' },
  twin_fence: { title: 'Perimeter fence and signs',
    text: 'The grounded fence keeps the public out. Entering the yard needs authorization, PPE, and a briefing on what is energized. Field convention on switchgear lamps: RED = breaker closed, GREEN = open.' },
};

const G = 0.006;                 // top of the gravel
const PH = [-0.07, 0, 0.07];     // phase spacing on the HV side

export class SubstationTwin {
  constructor(THREE) {
    this.THREE = THREE;
    this.root = new THREE.Group();
    this.kit = new Kit(THREE, this.root);
    this.pickables = this.kit.pickables;
    this.footprint = { w: 1.66, d: 0.8, h: 0.42 };
    this.markers = {};
    this.lamps = {};
    this.fans = [];
    this.busMats = [];
    this.hvMats = [];
    this.selected = null;
    this.time = 0;
    this._build();
    this._buildLayers();
    this._buildTraining();
    this.kit.enableShadows();
    this.setLayers(PRESETS.default);
    this.setTraining({});
  }

  // ---- site training overlays: limits of approach, the pre-job work zone, a person for scale ------
  // Scale: the fence is 0.07 tall, a 7 ft (2.1 m) chain-link fence, so one model unit is about 30 m.
  _buildTraining() {
    const THREE = this.THREE;
    const U = 1 / 30;
    this.trainRoot = new THREE.Group();
    this.root.add(this.trainRoot);
    this.tg = { approach: new THREE.Group(), briefing: new THREE.Group(), person: new THREE.Group() };
    for (const g of Object.values(this.tg)) this.trainRoot.add(g);
    // A translucent box with outlined edges around [x0, x1] × [y0, y1] × [z0, z1], grown by `pad`
    // on every side but never below the gravel.
    const shell = (g, color, [x0, x1], [y0, y1], [z0, z1], pad, opacity = 0.1) => {
      const yb = Math.max(G, y0 - pad), yt = y1 + pad;
      const geo = new THREE.BoxGeometry(x1 - x0 + 2 * pad, yt - yb, z1 - z0 + 2 * pad);
      const o = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, toneMapped: false }));
      o.position.set((x0 + x1) / 2, (yb + yt) / 2, (z0 + z1) / 2);
      o.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, toneMapped: false })));
      g.add(o);
    };
    const at = (g, label, x, y, z) => { label.sprite.position.set(x, y, z); g.add(label.sprite); return label; };

    // Limits of approach (training.js MAD): around every exposed energized part, by voltage class.
    const PINK = 0xff6ec7, hvPad = 3.25 * U, lvPad = 3.05 * U;
    const A = this.tg.approach;
    shell(A, PINK, [-0.74, -0.22], [0.1, 0.34], [-0.09, 0.09], hvPad);       // line, arresters, disconnect, breaker, CTs
    shell(A, PINK, [-0.12, 0.09], [0.2, 0.33], [-0.06, 0.06], hvPad);        // transformer bushings
    shell(A, PINK, [0.07, 0.52], [0.13, 0.21], [-0.06, 0.06], lvPad);        // 12.47 kV bus
    shell(A, PINK, [0.565, 0.695], [0.07, 0.19], [0.07, 0.19], lvPad);       // capacitor bank
    shell(A, PINK, [0.17, 0.45], [0.26, 0.29], [0.35, 0.37], lvPad);         // feeder riser terminations
    at(A, makeLabel(THREE, 0.2, { bg: 'rgba(50,14,40,0.9)' }), -0.47, 0.5, 0).set('115 kV · 10 ft 8 in', '#ff9ad8', '3.25 m · unqualified persons');
    at(A, makeLabel(THREE, 0.2, { bg: 'rgba(50,14,40,0.9)' }), 0.3, 0.36, -0.06).set('12.47 kV · 10 ft', '#ff9ad8', '3.05 m · unqualified persons');

    // Pre-job briefing for Feeder 2: the work zone (isolated) and what stays energized beside it.
    const B = this.tg.briefing;
    shell(B, 0x43a047, [0.335, 0.465], [G, 0.155], [0.155, 0.245], 0.008, 0.22);   // F2 cubicle
    shell(B, 0x43a047, [0.39, 0.43], [G, 0.3], [0.345, 0.37], 0.006, 0.22);        // F2 riser
    for (const [x, y, z] of [[[0.07, 0.52], [0.12, 0.22], [-0.07, 0.07]], [[0.155, 0.285], [G, 0.155], [0.155, 0.245]],
      [[0.55, 0.71], [G, 0.2], [0.06, 0.2]], [[-0.22, 0.12], [G, 0.34], [-0.17, 0.17]]]) shell(B, 0xff3b30, x, y, z, 0.006, 0.14);
    at(B, makeLabel(THREE, 0.19, { bg: 'rgba(10,40,16,0.9)' }), 0.42, 0.42, 0.26).set('WORK ZONE · F2', '#81c784', 'isolated · locked · grounded');
    at(B, makeLabel(THREE, 0.17, { bg: 'rgba(60,10,10,0.9)' }), 0.12, 0.33, 0.2).set('ENERGIZED', '#ff8a80', 'Feeder 1 + 12.47 kV bus');

    // A 1.8 m worker in a hard hat and hi-vis vest.
    const P = this.tg.person;
    const k = this.kit;
    const h = 1.8 * U;
    k.cyl(0.0045, 0.004, h * 0.48, k.std(0x2f3a4a), 0, h * 0.24, 0, null, P, 10);            // legs
    k.cyl(0.0058, 0.005, h * 0.32, k.std(0xc6ff00, { emissive: 0x4a6000 }), 0, h * 0.63, 0, null, P, 10);  // vest
    const head = new THREE.Mesh(new THREE.SphereGeometry(h * 0.075, 12, 8), k.std(0xd9a582));
    head.position.y = h * 0.86;
    const hat = new THREE.Mesh(new THREE.SphereGeometry(h * 0.085, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), k.std(0xf5f5f5));
    hat.position.y = h * 0.89;
    P.add(head, hat);
    this.trainRoot.traverse((o) => { if (o.isSprite || o.isLineSegments) o.userData.noShadow = true; });
  }

  // { approach, briefing, person }: which training overlays to show.
  setTraining(show) {
    for (const [id, g] of Object.entries(this.tg)) g.visible = !!show[id];
    // The worker waits at the gate, or stands at the work zone during a briefing.
    if (show.briefing) this.tg.person.position.set(0.4, G, 0.272);
    else this.tg.person.position.set(0.04, 0, 0.36);
  }

  // ---- invisible layers: current through the yard, CT secondaries, energized zones ----------------
  _buildLayers() {
    const THREE = this.THREE;
    const X = -0.04;
    const V = (pts) => new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
    this.flowPaths = {
      TL1: V([[-0.84, 0.37, 0], [-0.74, 0.325, 0], [-0.68, 0.32, 0], [-0.6, 0.176, 0], [-0.555, 0.228, 0], [-0.485, 0.228, 0],
        [-0.415, 0.215, 0], [-0.305, 0.215, 0], [-0.24, 0.222, 0], [X - 0.06, 0.324, 0]]),
      XFMR: V([[X - 0.06, 0.25, 0], [X + 0.07, 0.254, 0], [0.1, 0.206, 0], [0.16, 0.206, 0], [0.22, 0.206, 0]]),
      BKR_F1: V([[0.22, 0.206, 0], [0.22, 0.165, 0.19], [0.22, 0.04, 0.3], [0.23, 0.28, 0.352]]),
      BKR_F2: V([[0.22, 0.206, 0], [0.4, 0.206, 0], [0.4, 0.165, 0.19], [0.4, 0.04, 0.3], [0.41, 0.28, 0.352]]),
    };
    this.layerRoot = new THREE.Group();
    this.root.add(this.layerRoot);
    this.lg = {};
    for (const id of ['flow', 'amps', 'volts', 'fault', 'live', 'zones']) {
      this.lg[id] = new THREE.Group();
      this.layerRoot.add(this.lg[id]);
    }
    this.particles = new THREE.InstancedMesh(new THREE.SphereGeometry(0.006, 8, 6), new THREE.MeshBasicMaterial({ color: T.flow, toneMapped: false }), 220);
    this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particles.frustumCulled = false;
    this.particles.count = 0;
    this.lg.flow.add(this.particles);
    this.phase = {};
    const at = (label, x, y, z, g) => { label.sprite.position.set(x, y, z); this.lg[g].add(label.sprite); return label; };
    this.labels = {
      TL1: at(makeLabel(THREE, 0.16), -0.76, 0.43, 0, 'amps'),
      XFMR: at(makeLabel(THREE, 0.18), X, 0.42, 0, 'amps'),
      BKR_F1: at(makeLabel(THREE, 0.15), 0.2, 0.3, 0.3, 'amps'),
      BKR_F2: at(makeLabel(THREE, 0.15), 0.42, 0.3, 0.3, 'amps'),
      ct: at(makeLabel(THREE, 0.18), -0.24, 0.3, 0.12, 'amps'),
      vHV: at(makeLabel(THREE, 0.15), -0.42, 0.36, -0.16, 'volts'),
      vLV: at(makeLabel(THREE, 0.15), 0.3, 0.3, -0.1, 'volts'),
      zF1: at(makeLabel(THREE, 0.17), 0.12, 0.45, 0.42, 'zones'),
      zF2: at(makeLabel(THREE, 0.17), 0.5, 0.45, 0.42, 'zones'),
      fF1: at(makeLabel(THREE, 0.17, { bg: 'rgba(60,10,10,0.9)' }), 0.2, 0.22, 0.42, 'fault'),
      fF2: at(makeLabel(THREE, 0.17, { bg: 'rgba(60,10,10,0.9)' }), 0.42, 0.22, 0.42, 'fault'),
    };
    // Energized-zone shells: the HV yard, the LV bus, and each feeder bay.
    const shell = (w, h, d, x, y, z) => {
      const m = new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.12, depthWrite: false, toneMapped: false });
      const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      o.position.set(x, y, z);
      this.lg.live.add(o);
      return m;
    };
    this.zones = {
      hv: shell(0.6, 0.36, 0.3, -0.44, 0.19, 0),
      xf: shell(0.3, 0.34, 0.36, X, 0.18, 0),
      lv: shell(0.44, 0.1, 0.16, 0.3, 0.2, 0),
      BKR_F1: shell(0.14, 0.17, 0.1, 0.22, 0.09, 0.2),
      BKR_F2: shell(0.14, 0.17, 0.1, 0.4, 0.09, 0.2),
    };
    this.faultTubes = {};
    for (const id of ['BKR_F1', 'BKR_F2']) {
      const m = new THREE.MeshBasicMaterial({ color: 0xff5252, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false });
      const t = new THREE.Mesh(new THREE.TubeGeometry(this.flowPaths[id], 40, 0.01, 8, false), m);
      this.lg.fault.add(t);
      this.faultTubes[id] = t;
    }
    this.layerRoot.traverse((o) => (o.userData.noShadow = true));
  }

  setLayers(flags) {
    for (const [id, g] of Object.entries(this.lg)) g.visible = !!flags[id];
  }

  _updateLayers(state) {
    const THREE = this.THREE;
    // particles along each path, density and speed from the power on that branch
    let n = 0;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1);
    for (const [id, c] of Object.entries(this.flowPaths)) {
      const br = state.branches[id];
      if (!br || !br.closed || Math.abs(br.kw) < 15) continue;
      const mag = Math.min(1, Math.abs(br.kw) / 5000), dir = br.kw >= 0 ? 1 : -1;
      this.phase[id] = ((this.phase[id] || 0) + dir * (0.12 + 0.3 * mag) * 0.016 + 1) % 1;
      const count = Math.round(10 + 30 * mag);
      for (let i = 0; i < count && n < 220; i++) this.particles.setMatrixAt(n++, m.compose(c.getPointAt((this.phase[id] + i / count) % 1), q, s));
    }
    this.particles.count = n;
    this.particles.instanceMatrix.needsUpdate = true;

    const br = (id) => state.branches[id];
    const amps = (id) => (br(id) && br(id).closed ? fmtA(Math.abs(br(id).amps)) : 'open');
    this.labels.TL1.set(`TL1 ${amps('TL1')}`, '#7fa8d9', br('TL1') ? `${fmtKW(br('TL1').kw)} at 115 kV` : '');
    const xl = br('XFMR');
    this.labels.XFMR.set(`XFMR ${xl ? fmtKW(xl.kw) : '-'}`, xl && xl.loading > 0.9 ? '#fdd835' : '#e6eaee', xl ? `${Math.round(xl.loading * 100)}% of 20 MVA` : '');
    for (const id of ['BKR_F1', 'BKR_F2']) {
      const b = br(id);
      this.labels[id].set(`${id.replace('BKR_', '')} ${amps(id)}`, b && b.loading > 0.9 ? '#fdd835' : '#c9c27a', b && b.closed ? fmtKW(b.kw) : 'breaker open');
    }
    // A feeder relay measures through a 1200:5 CT: what the relay actually sees.
    const f1 = br('BKR_F1');
    const sec = f1 && f1.closed ? (Math.abs(f1.amps) * 5) / 1200 : 0;
    this.labels.ct.set(`CT ${sec.toFixed(2)} A`, '#b388ff', 'F1 relay input · 1200:5');
    const hv = state.buses.sub_hv, lv = state.buses.sub_lv;
    this.labels.vHV.set(hv.energized ? `${hv.vpu.toFixed(3)} pu` : '0 V · dead', hv.energized ? '#26a69a' : '#6b747d', '115 kV bus');
    this.labels.vLV.set(lv.energized ? `${lv.vpu.toFixed(3)} pu` : '0 V · dead', lv.energized ? (lv.vpu < 0.95 ? '#ffb74d' : '#26a69a') : '#6b747d', '12.47 kV bus');
    for (const [id, z] of [['BKR_F1', 'zF1'], ['BKR_F2', 'zF2']]) {
      this.labels[z].set(`${id.replace('_', '-')} zone`, id === 'BKR_F1' ? '#26a69a' : '#7986cb', 'trips above 900 A');
    }
    const fci = state.fci || {};
    const pulse = 0.35 + 0.3 * Math.abs(Math.sin(this.time * 6));
    for (const [id, f] of [['BKR_F1', 'fF1'], ['BKR_F2', 'fF2']]) {
      const seen = fci[id];
      this.faultTubes[id].visible = !!seen;
      this.faultTubes[id].material.opacity = pulse;
      this.labels[f].sprite.visible = !!seen;
      if (seen) this.labels[f].set(`Fault ${fmtA(seen)}`, '#ff8a80', 'seen by this breaker');
    }
    const live = (on, mat) => { mat.color.setHex(on ? 0xff3b30 : 0x43a047); mat.opacity = on ? 0.12 : 0.2; };
    live(hv.energized, this.zones.hv);
    live(hv.energized, this.zones.xf);
    live(lv.energized, this.zones.lv);
    for (const id of ['BKR_F1', 'BKR_F2']) live(lv.energized && state.closed[id], this.zones[id]);
  }

  _build() {
    const THREE = this.THREE, k = this.kit;
    const galv = k.surface('galv');
    const steel = k.painted(0x8d969d);
    const copper = k.std(0xb26b3c, { metalness: 0.8, roughness: 0.35 });
    const hvMat = () => { const m = k.std(T.kv115, { unique: true, metalness: 0.6, roughness: 0.35, emissive: T.kv115, emissiveIntensity: 0.1 }); this.hvMats.push(m); return m; };
    const hv = hvMat();

    // ---- ground: grass base, soil sides, gravel yard -----------------------------------------
    const soil = k.surface('soil', [12, 1]);
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.04, 0.8), [soil, soil, k.surface('grass', [8, 4]), soil, soil, soil]);
    base.position.y = -0.02;
    this.root.add(base);
    k.box(1.52, G, 0.64, k.surface('gravel', [9, 3.8]), 0, G / 2, 0);

    // ---- incoming line: lattice dead-end structure ------------------------------------------
    for (const z of [-0.12, 0.12]) k.lattice(-0.68, z, 0.34, 0.014, 0.008, galv, 'twin_line', this.root, 6, 0.005);
    k.strut([-0.68, 0.335, -0.135], [-0.68, 0.335, 0.135], 0.012, galv, 'twin_line');
    k.strut([-0.68, 0.3, -0.135], [-0.68, 0.3, 0.135], 0.008, galv, 'twin_line');
    for (const z of PH) {
      const ins = k.insulator(-0.68, 0.325, z, 0.06, 0.009, 'twin_line', { color: 0x6f8a94 });
      ins.rotation.z = Math.PI / 2;                                     // a horizontal dead-end string
      k.wire([-0.84, 0.37, z], [-0.74, 0.325, z], 0.003, hv, 0.01, 'twin_line');
      k.wire([-0.68, 0.32, z], [-0.6, 0.176, z], 0.0025, hv, -0.01, 'twin_line');
    }

    // ---- surge arresters on steel pedestals --------------------------------------------------
    for (const z of PH) {
      k.box(0.022, 0.1, 0.022, galv, -0.6, G + 0.05, z, 'twin_arrester');
      k.insulator(-0.6, G + 0.1, z, 0.07, 0.011, 'twin_arrester', { color: 0x8c979d });
      k.strut([-0.6, G + 0.01, z + 0.012], [-0.6, G + 0.0, z + 0.03], 0.003, copper, 'twin_mast');
    }

    // ---- disconnect switch: steel frame, two insulator columns per phase, blades ----------------
    for (const z of [-0.11, 0.11]) k.lattice(-0.52, z, 0.12, 0.01, 0.008, galv, 'twin_ds', this.root, 3, 0.004);
    for (const x of [-0.555, -0.485]) k.strut([x, 0.12, -0.12], [x, 0.12, 0.12], 0.01, galv, 'twin_ds');
    for (const z of PH) {
      k.insulator(-0.555, 0.125, z, 0.1, 0.011, 'twin_ds');
      k.insulator(-0.485, 0.125, z, 0.1, 0.011, 'twin_ds');
      k.box(0.075, 0.005, 0.01, k.std(0xd2d6d9, { metalness: 0.8, roughness: 0.3 }), -0.52, 0.228, z, 'twin_ds');
      k.wire([-0.6, 0.176, z], [-0.555, 0.228, z], 0.0025, hv, 0.004, 'twin_ds');
    }
    k.box(0.03, 0.045, 0.025, steel, -0.52, 0.06, 0.135, 'twin_ds');     // motor operator
    k.strut([-0.52, 0.083, 0.135], [-0.52, 0.12, 0.12], 0.003, galv, 'twin_ds');

    // ---- SF6 dead-tank breaker: three tanks, V bushings, mechanism cabinet ----------------------
    k.box(0.12, 0.05, 0.2, galv, -0.36, G + 0.025, 0, 'twin_hvbkr');
    for (const z of PH) {
      const tank = k.cyl(0.026, 0.026, 0.11, k.painted(0x8a949b), -0.36, 0.1, z, 'twin_hvbkr', this.root, 24);
      tank.rotation.z = Math.PI / 2;
      for (const s of [-1, 1]) {
        const b = k.insulator(-0.36 + s * 0.03, 0.118, z, 0.1, 0.01, 'twin_hvbkr');
        b.rotation.z = -s * 0.25;
      }
      k.wire([-0.485, 0.228, z], [-0.415, 0.215, z], 0.0025, hv, 0.006, 'twin_hvbkr');
      k.wire([-0.305, 0.215, z], [-0.24, 0.222, z], 0.0025, hv, 0.006, 'twin_ct');
    }
    k.box(0.07, 0.09, 0.045, k.painted(0x9aa2a8), -0.36, G + 0.045, 0.14, 'twin_hvbkr');
    k.plaque(TX.plate(['SF6 BREAKER', '115 kV', 'GAS PRESSURE OK']), 0.04, 0.02, -0.36, G + 0.07, 0.1631, 'twin_hvbkr');

    // ---- CTs / VTs: live-tank heads on insulator columns --------------------------------------
    for (const z of PH) {
      k.box(0.018, 0.08, 0.018, galv, -0.24, G + 0.04, z, 'twin_ct');
      k.insulator(-0.24, G + 0.08, z, 0.1, 0.012, 'twin_ct');
      k.cyl(0.02, 0.016, 0.035, k.painted(0x7f898f), -0.24, G + 0.2, z, 'twin_ct', this.root, 20);
    }

    // ---- power transformer ------------------------------------------------------------------
    const X = -0.04;
    k.box(0.36, 0.012, 0.34, k.surface('concrete', [2, 2]), X, G + 0.006, 0, 'twin_xfmr');
    for (const [w, d, x, z] of [[0.36, 0.008, X, 0.166], [0.36, 0.008, X, -0.166], [0.008, 0.34, X + 0.176, 0], [0.008, 0.34, X - 0.176, 0]]) {
      k.box(w, 0.02, d, k.surface('concrete'), x, G + 0.02, z, 'twin_xfmr');   // oil containment curb
    }
    const tankMat = k.painted(0x8d969d, [1, 1]);
    k.box(0.2, 0.18, 0.14, tankMat, X, 0.108, 0, 'twin_xfmr');
    k.box(0.21, 0.008, 0.15, tankMat, X, 0.2, 0, 'twin_xfmr');
    for (let i = 0; i < 5; i++) for (const z of [0.0725, -0.0725]) k.box(0.006, 0.17, 0.006, tankMat, X - 0.08 + i * 0.04, 0.108, z, 'twin_xfmr');
    k.plaque(TX.plate(['POWER TRANSFORMER', '115 / 12.47 kV   20 MVA', 'ONAN / ONAF   3 PHASE   60 Hz']), 0.06, 0.03, X - 0.03, 0.13, 0.0766, 'twin_xfmr');
    k.plaque(TX.sign('DANGER', ['HIGH VOLTAGE']), 0.03, 0.02, X + 0.055, 0.16, 0.0766, 'twin_xfmr');
    // Bushings: tall HV on the breaker side, short LV on the bus side.
    for (const z of [-0.05, 0, 0.05]) {
      k.insulator(X - 0.06, 0.204, z, 0.12, 0.011, 'twin_xfmr');
      k.insulator(X + 0.07, 0.204, z, 0.05, 0.009, 'twin_xfmr');
    }
    for (let i = 0; i < 3; i++) k.wire([-0.24, 0.222, PH[i]], [X - 0.06, 0.324, [-0.05, 0, 0.05][i]], 0.0025, hv, 0.008, 'twin_xfmr');
    // Conservator on a bracket, with the pipe down to the tank.
    const cons = k.cyl(0.03, 0.03, 0.17, tankMat, X - 0.135, 0.28, 0, 'twin_xfmr', this.root, 24);
    cons.rotation.x = Math.PI / 2;
    for (const z of [-0.055, 0.055]) k.strut([X - 0.09, 0.204, z], [X - 0.135, 0.255, z], 0.008, galv, 'twin_xfmr');
    k.strut([X - 0.12, 0.25, 0], [X - 0.09, 0.204, 0], 0.006, tankMat, 'twin_xfmr');
    k.cyl(0.008, 0.008, 0.03, k.std(0xc05a3c), X - 0.135, 0.245, 0.09, 'twin_xfmr', this.root, 10);   // breather
    // Radiator banks and fans on both long sides.
    const fin = k.corrugated(0x858f96, [1, 3]);
    for (const s of [-1, 1]) {
      for (let i = 0; i < 5; i++) k.box(0.01, 0.15, 0.07, fin, X - 0.08 + i * 0.04, 0.105, s * 0.117, 'twin_cooling');
      for (const y of [0.17, 0.045]) {
        const hdr = k.cyl(0.006, 0.006, 0.18, tankMat, X, y, s * 0.085, 'twin_cooling', this.root, 10);
        hdr.rotation.z = Math.PI / 2;
      }
      for (const x of [X - 0.06, X + 0.02]) {
        const fan = new THREE.Group();
        fan.position.set(x, 0.09, s * 0.158);
        this.root.add(fan);
        k.pick(new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.003, 8, 28), galv), 'twin_cooling');
        fan.add(k.pickables[k.pickables.length - 1]);
        const blades = new THREE.Group();
        fan.add(blades);
        k.cyl(0.005, 0.005, 0.008, k.std(0x2d3236), 0, 0, 0, 'twin_cooling', blades, 10).rotation.x = Math.PI / 2;
        for (let b = 0; b < 4; b++) {
          const arm = new THREE.Group();
          arm.rotation.z = (b * Math.PI) / 2;
          blades.add(arm);
          const bl = k.box(0.008, 0.019, 0.0015, k.std(0x3a4045), 0, 0.011, 0, 'twin_cooling', arm);
          bl.rotation.y = 0.5;
        }
        for (let g = -2; g <= 2; g++) k.box(0.048, 0.0012, 0.0012, galv, 0, g * 0.009, s * 0.004, null, fan);  // guard
        this.fans.push(blades);
      }
    }
    // Load tap changer compartment and its drive cabinet on the LV end.
    k.box(0.045, 0.11, 0.08, tankMat, X + 0.123, 0.1, -0.02, 'twin_ltc');
    k.box(0.03, 0.05, 0.04, k.painted(0x9aa2a8), X + 0.12, 0.04, 0.05, 'twin_ltc');
    k.plaque(TX.plate(['LTC', 'TAP 9R', 'AUTO']), 0.022, 0.013, X + 0.12, 0.05, 0.0705, 'twin_ltc');
    // Ground leads from the tank to the grid.
    for (const [x, z] of [[X - 0.1, 0.07], [X + 0.1, -0.07]]) k.strut([x, 0.03, z], [x, G, z + Math.sign(z) * 0.03], 0.003, copper, 'twin_mast');

    // ---- 12.47 kV bus on steel stands and post insulators ------------------------------------
    const BP = [-0.05, 0, 0.05];
    for (const x of [0.12, 0.3, 0.48]) {
      k.box(0.016, 0.12, 0.016, galv, x, G + 0.06, 0, 'twin_bus');
      k.box(0.012, 0.012, 0.16, galv, x, G + 0.124, 0, 'twin_bus');
      for (const z of BP) k.insulator(x, G + 0.13, z, 0.065, 0.009, 'twin_bus');
    }
    for (let i = 0; i < 3; i++) {
      const m = k.std(T.kv12, { unique: true, metalness: 0.6, roughness: 0.35, emissive: T.kv12, emissiveIntensity: 0.15 });
      this.busMats.push(m);
      const tube = k.cyl(0.0055, 0.0055, 0.42, m, 0.3, 0.206, BP[i], 'twin_bus', this.root, 12);
      tube.rotation.z = Math.PI / 2;
      k.wire([X + 0.07, 0.254, [-0.05, 0, 0.05][i]], [0.1, 0.206, BP[i]], 0.003, m, 0.01, 'twin_bus');
    }

    // ---- metal-clad feeder switchgear lineup ------------------------------------------------
    const cable = k.std(0x1d2124, { roughness: 0.8 });
    const gear = k.painted(0x9ea6ac, [1, 1]);
    const door = k.painted(0x8a939a, [1, 1]);
    const bays = [['twin_f1', 'BKR_F1', 0.22, 'FEEDER 1'], ['twin_f2', 'BKR_F2', 0.4, 'FEEDER 2']];
    k.box(0.05, 0.15, 0.09, gear, 0.31, G + 0.075, 0.2, 'twin_bus');                       // bus PT / aux cubicle
    k.box(0.36, 0.008, 0.1, gear, 0.31, G + 0.154, 0.2, 'twin_bus');                      // roof
    for (const [item, dev, x, label] of bays) {
      k.box(0.13, 0.15, 0.09, gear, x, G + 0.075, 0.2, item);
      k.box(0.112, 0.125, 0.004, door, x, G + 0.072, 0.2465, item);
      k.box(0.012, 0.004, 0.006, k.std(0x2d3236, { metalness: 0.6 }), x + 0.045, G + 0.07, 0.25, item);   // handle
      k.box(0.06, 0.012, 0.002, k.decal(TX.louvre(0x7c858c)), x, G + 0.02, 0.2495, item);
      k.plaque(TX.plate([label, '12.47 kV  1200 A']), 0.05, 0.02, x - 0.02, G + 0.115, 0.2489, item);
      // Field-convention indicator lamps: RED lit = closed, GREEN lit = open.
      const red = k.std(0x5a1a17, { unique: true, emissive: 0xff2a1f, emissiveIntensity: 0 });
      const green = k.std(0x15401c, { unique: true, emissive: 0x2bff5a, emissiveIntensity: 0 });
      k.cyl(0.005, 0.005, 0.004, red, x + 0.03, G + 0.118, 0.249, item, this.root, 12).rotation.x = Math.PI / 2;
      k.cyl(0.005, 0.005, 0.004, green, x + 0.045, G + 0.118, 0.249, item, this.root, 12).rotation.x = Math.PI / 2;
      this.lamps[dev] = { red, green };
      // Bus drops: cables from the bus down to the cubicle roof bushings.
      for (const z of BP) k.wire([x, 0.2, z], [x + z * 0.5, 0.165, 0.19], 0.003, cable, -0.005, item);
      // ISA status marker above the cubicle (the same square symbol as the map).
      const g = new THREE.Group();
      g.position.set(x, 0.205, 0.25);
      this.root.add(g);
      const S = 0.04, W = 0.007;
      const fm = k.std(T.equip, { unique: true, emissive: T.equip, emissiveIntensity: 0.3 });
      for (const [bx, by, w, h] of [[0, S / 2, S, W], [0, -S / 2, S, W], [S / 2, 0, W, S], [-S / 2, 0, W, S]]) k.box(w, h, 0.004, fm, bx, by, 0, item, g);
      const fill = k.box(S - W, S - W, 0.003, k.std(0xc9d1d8, { unique: true, emissive: 0xc9d1d8, emissiveIntensity: 0.3 }), 0, 0, 0, item, g);
      g.traverse((o) => (o.userData.noShadow = true));
      this.markers[dev] = { fill, fm };
      // Feeder exit: an underground cable to a riser pole outside the fence.
      const wood = k.surface('wood', [1, 5]);
      k.cyl(0.006, 0.008, 0.3, wood, x, 0.15, 0.36, item, this.root, 10);
      k.box(0.12, 0.008, 0.008, wood, x, 0.28, 0.36, item);
      for (const dx of [-0.045, 0, 0.045]) k.insulator(x + dx, 0.284, 0.36, 0.014, 0.004, null, { color: 0x6f7f74, sheds: 3 });
      k.cyl(0.004, 0.004, 0.26, cable, x + 0.01, 0.14, 0.352, item, this.root, 8);
      k.box(0.014, 0.08, 0.006, k.painted(0x8d969d), x + 0.01, 0.06, 0.35, item);          // cable guard
    }

    // ---- capacitor bank ---------------------------------------------------------------------
    const CX = 0.63, CZ = 0.13;
    for (const [dx, dz] of [[-0.06, -0.05], [0.06, -0.05], [-0.06, 0.05], [0.06, 0.05]]) {
      k.strut([CX + dx, G, CZ + dz], [CX + dx, G + 0.16, CZ + dz], 0.006, galv, 'twin_cap');
    }
    for (const y of [0.07, 0.135]) {
      k.box(0.13, 0.005, 0.11, galv, CX, y, CZ, 'twin_cap');
      for (let i = 0; i < 3; i++) for (const dz of [-0.025, 0.025]) {
        k.box(0.026, 0.045, 0.016, k.painted(0xb5bbbf), CX - 0.04 + i * 0.04, y + 0.025, CZ + dz, 'twin_cap');
        k.insulator(CX - 0.04 + i * 0.04, y + 0.048, CZ + dz, 0.012, 0.004, 'twin_cap', { sheds: 2 });
      }
    }
    k.plaque(TX.sign('WARNING', ['CAPACITORS', 'STORED ENERGY'], { header: '#f2a900' }), 0.05, 0.032, CX, G + 0.035, CZ + 0.056, 'twin_cap');

    // ---- control house + cable trench --------------------------------------------------------
    const wall = k.painted(0xb7ab92, [2, 1]);
    const house = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, 0.14), [wall, wall, k.surface('flatroof', [2, 2]), wall, wall, wall]);
    house.position.set(0.56, G + 0.06, -0.18);
    this.root.add(k.pick(house, 'twin_relay'));
    k.box(0.215, 0.008, 0.155, k.painted(0x6c747a), 0.56, G + 0.124, -0.18, 'twin_relay');
    k.box(0.034, 0.075, 0.004, k.painted(0x6c747a), 0.51, G + 0.0375, -0.108, 'twin_relay');      // door
    k.plaque(TX.plate(['CONTROL HOUSE', 'RELAYS  SCADA  BATTERY']), 0.07, 0.025, 0.6, G + 0.085, -0.1085, 'twin_relay');
    k.box(0.025, 0.05, 0.05, k.decal(TX.louvre(0xa7adb2)), 0.675, G + 0.07, -0.18, 'twin_relay');   // HVAC
    const trench = k.surface('concrete', [8, 1]);
    for (const [x0, z0, x1, z1] of [[0.46, -0.27, -0.6, -0.27], [-0.36, -0.27, -0.36, -0.1], [X, -0.27, X, -0.17],
      [0.3, -0.27, 0.3, 0.15], [-0.52, -0.27, -0.52, -0.12]]) {
      const w = Math.abs(x1 - x0) + 0.025, d = Math.abs(z1 - z0) + 0.025;
      k.box(w, 0.006, d, trench, (x0 + x1) / 2, G + 0.003, (z0 + z1) / 2, 'twin_relay');
    }

    // ---- shield masts --------------------------------------------------------------------------
    for (const x of [-0.72, 0.0, 0.72]) {
      k.cyl(0.004, 0.009, 0.42, galv, x, G + 0.21, -0.29, 'twin_mast', this.root, 10);
      k.cyl(0.0008, 0.003, 0.05, galv, x, G + 0.445, -0.29, 'twin_mast', this.root, 6);
      k.strut([x, G + 0.01, -0.285], [x + 0.02, G, -0.27], 0.003, copper, 'twin_mast');
    }

    // ---- perimeter fence with a gate opening and signage --------------------------------------
    const FH = 0.07;
    k.fence([-0.75, -0.31], [0.75, -0.31], FH, 'twin_fence', this.root, 0.1);
    k.fence([0.75, -0.31], [0.75, 0.31], FH, 'twin_fence', this.root, 0.1);
    k.fence([0.75, 0.31], [0.12, 0.31], FH, 'twin_fence', this.root, 0.1);
    k.fence([-0.04, 0.31], [-0.75, 0.31], FH, 'twin_fence', this.root, 0.1);
    k.fence([-0.75, 0.31], [-0.75, -0.31], FH, 'twin_fence', this.root, 0.1);
    k.plaque(TX.sign('DANGER', ['HIGH VOLTAGE', 'KEEP OUT']), 0.06, 0.038, -0.12, 0.04, 0.3125, 'twin_fence');
    k.plaque(TX.sign('NOTICE', ['AUTHORIZED', 'PERSONNEL ONLY'], { header: '#005eb8' }), 0.06, 0.038, 0.2, 0.04, 0.3125, 'twin_fence');
    k.plaque(TX.sign('DANGER', ['HIGH VOLTAGE', 'KEEP OUT']), 0.06, 0.038, 0.55, 0.04, 0.3125, 'twin_fence');

    // Selection ring.
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.004, 8, 48), new THREE.MeshBasicMaterial({ color: T.select }));
    this.ring.rotation.x = Math.PI / 2;
    this.ring.visible = false;
    this.root.add(this.ring);
  }

  anchor(item) {
    const a = {
      twin_line: [-0.68, 0.02, 0], twin_arrester: [-0.6, 0.02, 0], twin_ds: [-0.52, 0.02, 0], twin_hvbkr: [-0.36, 0.02, 0],
      twin_ct: [-0.24, 0.02, 0], twin_xfmr: [-0.04, 0.02, 0], twin_cooling: [-0.04, 0.02, 0.16], twin_ltc: [0.085, 0.02, -0.02],
      twin_bus: [0.3, 0.02, 0], twin_relay: [0.56, 0.02, -0.18], twin_f1: [0.22, 0.02, 0.2], twin_f2: [0.4, 0.02, 0.2],
      twin_cap: [0.63, 0.02, 0.13], twin_mast: [0.0, 0.02, -0.29], twin_fence: [0.04, 0.02, 0.31],
    }[item];
    return a ? new this.THREE.Vector3(...a) : null;
  }

  update(state, dt) {
    this.time += dt;
    if (!state) return;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 6);
    const hvLive = state.buses.sub_hv.energized, lvLive = state.buses.sub_lv.energized;
    for (const m of this.hvMats) {
      m.color.setHex(hvLive ? T.kv115 : 0x3d434a);
      m.emissiveIntensity = hvLive ? 0.1 : 0;
    }
    for (const m of this.busMats) {
      m.color.setHex(lvLive ? T.kv12 : 0x3d434a);
      m.emissiveIntensity = lvLive ? 0.15 : 0;
    }
    const tripped = new Set(state.alarms.filter((a) => a.active && a.key.includes(':trip')).map((a) => a.key.split(':')[0]));
    for (const [dev, mk] of Object.entries(this.markers)) {
      const closed = state.closed[dev];
      mk.fill.visible = closed;
      const col = !closed && tripped.has(dev) ? (pulse > 0.5 ? T.alarm1 : 0x7a1f1d) : !closed ? T.alarm3 : T.equip;
      mk.fm.color.setHex(col);
      mk.fm.emissive.setHex(col);
      const lamp = this.lamps[dev];
      lamp.red.emissiveIntensity = closed ? 1.6 : 0;
      lamp.green.emissiveIntensity = closed ? 0 : 1.6;
    }
    // Cooling fans: speed follows transformer loading.
    const load = state.branches.XFMR ? Math.max(0, state.branches.XFMR.loading) : 0;
    this.fanSpeed = (this.fanSpeed || 0) + ((lvLive ? 6 + 60 * load : 0) - (this.fanSpeed || 0)) * Math.min(1, dt * 0.8);
    for (const f of this.fans) f.rotation.z -= this.fanSpeed * dt;
    this._updateLayers(state);
    const p = this.anchor(this.selected);
    this.ring.visible = !!p;
    if (p) { this.ring.position.copy(p); this.ring.scale.setScalar(1 + 0.12 * Math.sin(this.time * 4)); }
  }
}
