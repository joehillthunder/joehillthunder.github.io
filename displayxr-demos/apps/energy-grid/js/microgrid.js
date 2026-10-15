// Microgrid & battery yard twin: the second drill-down module. A walk-through of the campus
// microgrid at the end of Feeder 1, built at high detail and driven by the live simulation:
//   utility riser pole + PCC recloser -> microgrid switchgear (12.47 kV bus) -> pad-mount step-up
//   transformers -> power conversion system (inverters) -> battery containers (one open: racks
//   with live state-of-charge LEDs), plus the carport solar, the microgrid controller with its
//   island beacon, the hospital it protects and the hospital's standby generator.
// Cyan particles show where power is flowing right now.

import { T } from './theme.js';
import { Kit } from './kit.js';
import * as TX from './textures.js';

export const MG_ITEMS = {
  mg_pcc: { title: 'Point of common coupling (PCC) recloser', card: 'PCC', device: 'PCC' },
  mg_bus: { title: 'Microgrid switchgear (12.47 kV)', card: 'mg', device: 'mg' },
  mg_bess: { title: 'Battery containers', card: 'bess', device: 'bess' },
  mg_pcs: { title: 'Power conversion system (PCS)',
    text: 'Bidirectional inverters that turn the batteries\' DC into 480 V AC and back. Tied to the grid they follow it; islanded they are grid-forming and set the voltage and frequency for the whole campus.' },
  mg_xfmr: { title: 'Pad-mounted step-up transformers',
    text: 'Raise the inverters\' 480 V to 12.47 kV for the microgrid bus. Cabinets stay locked: the compartments are live whenever the batteries or the grid are connected.' },
  mg_pv: { title: 'Carport solar', card: 'pv_mg', device: 'pv_mg' },
  mg_ctrl: { title: 'Microgrid controller',
    text: 'Decides when to island and reconnect, dispatches the battery and solar, and sheds load if it must. It islands automatically when the PCC loses utility voltage; the amber beacon on the roof shows the campus is islanded.' },
  mg_gen: { title: 'Hospital standby generator',
    text: 'Required for the hospital\'s life-safety loads. It is not part of this exercise\'s model: here the battery carries the island on its own.' },
  mg_fire: { title: 'Battery safety systems',
    text: 'Each container has gas detection, deflagration vents, fire suppression and an emergency stop. Lithium-ion fires re-ignite: never open a container door after an alarm; wait for the fire service.' },
};

const G = 0.006;

export class MicrogridTwin {
  constructor(THREE) {
    this.THREE = THREE;
    this.root = new THREE.Group();
    this.kit = new Kit(THREE, this.root);
    this.pickables = this.kit.pickables;
    this.footprint = { w: 1.6, d: 0.8, h: 0.32 };
    this.selected = null;
    this.time = 0;
    this.flows = {};
    this.phase = {};
    this._build();
    this.kit.enableShadows();
  }

  _build() {
    const THREE = this.THREE, k = this.kit;
    const galv = k.surface('galv');
    const wood = k.surface('wood', [1, 5]);
    const cable = k.std(0x1d2124, { roughness: 0.8 });

    // ---- ground --------------------------------------------------------------------------------
    const soil = k.surface('soil', [12, 1]);
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.04, 0.8), [soil, soil, k.surface('grass', [8, 4]), soil, soil, soil]);
    base.position.y = -0.02;
    this.root.add(base);
    k.box(0.92, G, 0.44, k.surface('gravel', [5, 2.4]), -0.29, G / 2, -0.09);            // battery yard
    k.box(0.62, 0.002, 0.36, k.std(0x3b4045, { roughness: 0.9 }), 0.44, 0.001, 0.11);      // parking lot
    for (let i = 0; i < 9; i++) k.box(0.003, 0.0022, 0.07, k.std(0xd9d9d0), 0.16 + i * 0.07, 0.0012, 0.2);   // bay lines
    k.box(0.92, 0.0016, 0.05, k.std(0x3b4045, { roughness: 0.9 }), -0.29, G + 0.0008, -0.12); // fire lane between rows

    // ---- battery containers ------------------------------------------------------------------
    const wall = k.corrugated(0xe1e4e6, [8, 1]);
    const CL = 0.28, CW = 0.07, CH = 0.085;
    const spots = [[-0.53, -0.04, true], [-0.2, -0.04, false], [-0.53, -0.2, false], [-0.2, -0.2, false]];
    spots.forEach(([x, z, open], n) => {
      k.box(CL + 0.02, 0.008, CW + 0.02, k.surface('concrete', [3, 1]), x, G + 0.004, z, 'mg_bess');
      const y0 = G + 0.008;
      if (open) this._openContainer(x, y0, z, CL, CW, CH, wall);
      else k.box(CL, CH, CW, wall, x, y0 + CH / 2, z, 'mg_bess');
      for (const s of [-1, 1]) k.box(0.014, 0.05, 0.05, k.decal(TX.louvre(0xc7ccd0)), x + s * (CL / 2 + 0.007), y0 + 0.05, z, 'mg_bess');   // HVAC
      k.box(0.03, 0.006, 0.02, k.std(0x9aa1a6), x - 0.08, y0 + CH + 0.003, z, 'mg_fire');                                                // vent
      k.plaque(TX.plate([`BESS ${String(n + 1).padStart(2, '0')}`, '500 kW / 2 MWh']), 0.05, 0.022, x + 0.09, y0 + CH * 0.72, z + CW / 2 + 0.001, 'mg_bess');
      k.plaque(TX.sign('WARNING', ['LITHIUM-ION', 'BATTERY STORAGE'], { header: '#f2a900' }), 0.04, 0.025, x + 0.03, y0 + CH * 0.72, z + CW / 2 + 0.001, 'mg_fire');
      k.box(0.008, 0.012, 0.004, k.std(0xc8102e, { emissive: 0x5a0000 }), x + 0.125, y0 + 0.045, z + CW / 2 + 0.002, 'mg_fire');           // E-stop
    });

    // ---- power conversion system + pad-mount transformers ----------------------------------------
    const louvre = k.decal(TX.louvre(0x9aa1a7));
    const padGreen = k.painted(0x4f6b4d);
    for (const x of [-0.53, -0.2]) {
      k.box(0.12, 0.008, 0.07, k.surface('concrete'), x, G + 0.004, 0.08, 'mg_pcs');
      k.box(0.07, 0.07, 0.045, k.painted(0xc9cdd0), x - 0.02, G + 0.043, 0.08, 'mg_pcs');
      k.box(0.06, 0.05, 0.002, louvre, x - 0.02, G + 0.045, 0.1035, 'mg_pcs');
      k.plaque(TX.plate(['PCS', 'INVERTER 1 MW']), 0.035, 0.014, x - 0.02, G + 0.072, 0.1036, 'mg_pcs');
      k.box(0.04, 0.045, 0.045, padGreen, x + 0.04, G + 0.0305, 0.08, 'mg_xfmr');
      k.plaque(TX.sign('DANGER', ['HIGH VOLTAGE']), 0.028, 0.018, x + 0.04, G + 0.035, 0.1031, 'mg_xfmr');
      // DC cables from the containers, AC cable to the switchgear (in conduit).
      k.wire([x, G + 0.05, -0.005], [x - 0.02, G + 0.06, 0.058], 0.003, cable, -0.01, 'mg_pcs');
    }

    // ---- microgrid switchgear, controller, PCC riser pole --------------------------------------
    const gear = k.painted(0x9ea6ac);
    k.box(0.2, 0.008, 0.08, k.surface('concrete'), 0.0, G + 0.004, -0.27, 'mg_bus');
    k.box(0.18, 0.09, 0.06, gear, 0.0, G + 0.053, -0.27, 'mg_bus');
    for (let i = 0; i < 4; i++) k.box(0.038, 0.075, 0.002, k.painted(0x8a939a), -0.066 + i * 0.044, G + 0.05, -0.2395, 'mg_bus');
    k.plaque(TX.plate(['MICROGRID SWITCHGEAR', '12.47 kV MAIN BUS']), 0.08, 0.022, 0.0, G + 0.085, -0.2389, 'mg_bus');
    // Controller building with island beacon.
    const cw = k.painted(0xb7ab92);
    const ctrl = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, 0.08), [cw, cw, k.surface('flatroof'), cw, cw, cw]);
    ctrl.position.set(0.2, G + 0.035, -0.27);
    this.root.add(k.pick(ctrl, 'mg_ctrl'));
    k.plaque(TX.plate(['MICROGRID CONTROL', 'SCADA  EMS']), 0.06, 0.02, 0.2, G + 0.05, -0.2295, 'mg_ctrl');
    k.box(0.022, 0.05, 0.003, k.painted(0x6c747a), 0.16, G + 0.025, -0.2295, 'mg_ctrl');
    k.cyl(0.002, 0.002, 0.04, galv, 0.24, G + 0.09, -0.29, 'mg_ctrl', this.root, 6);                          // antenna
    this.beaconMat = k.std(0x6b4a12, { unique: true, emissive: 0xffa000, emissiveIntensity: 0, transparent: true, opacity: 0.9 });
    this.beacon = k.cyl(0.008, 0.008, 0.012, this.beaconMat, 0.17, G + 0.076, -0.27, 'mg_ctrl', this.root, 14);
    // Utility feeder arrives on wood poles from the left; the PCC recloser sits on the last pole.
    const kv = k.std(T.kv12, { unique: true, metalness: 0.6, roughness: 0.35, emissive: T.kv12, emissiveIntensity: 0.12 });
    this.feederMat = kv;
    const poles = [[-0.78, -0.33], [-0.55, -0.34], [-0.3, -0.34], [-0.08, -0.33]];
    poles.forEach(([x, z], i) => {
      const item = 'mg_pcc';
      k.cyl(0.005, 0.007, 0.26, wood, x, 0.13, z, item, this.root, 10);
      k.box(0.008, 0.008, 0.1, wood, x, 0.245, z, item);
      for (const dz of [-0.04, 0, 0.04]) k.insulator(x, 0.249, z + dz, 0.012, 0.0035, null, { color: 0x6f7f74, sheds: 3 });
      if (i) for (const dz of [-0.04, 0, 0.04]) k.wire([poles[i - 1][0], 0.261, poles[i - 1][1] + dz], [x, 0.261, z + dz], 0.0018, kv, 0.012, 'mg_pcc');
    });
    // Recloser tank + control cabinet on the last pole, then a cable riser down to the switchgear.
    const [px, pz] = poles[poles.length - 1];
    k.box(0.05, 0.03, 0.03, k.painted(0x8d969d), px + 0.025, 0.2, pz + 0.02, 'mg_pcc');
    for (const dz of [-0.01, 0, 0.01]) k.insulator(px + 0.025 + dz * 1.5, 0.215, pz + 0.02, 0.016, 0.004, 'mg_pcc', { sheds: 3 });
    k.box(0.025, 0.035, 0.015, k.painted(0xb4bac0), px, 0.09, pz + 0.012, 'mg_pcc');
    k.cyl(0.004, 0.004, 0.18, cable, px + 0.008, 0.1, pz + 0.008, 'mg_pcc', this.root, 8);
    k.wire([px + 0.008, G + 0.01, pz + 0.008], [-0.09, G + 0.04, -0.27], 0.004, cable, 0.03, 'mg_pcc');
    // PCC status: the ISA square (filled = closed) and field lamps on the control cabinet.
    const sq = new THREE.Group();
    sq.position.set(px, 0.31, pz);
    this.root.add(sq);
    const S = 0.04, W = 0.007;
    this.pccFrame = k.std(T.equip, { unique: true, emissive: T.equip, emissiveIntensity: 0.3 });
    for (const [bx, by, w, h] of [[0, S / 2, S, W], [0, -S / 2, S, W], [S / 2, 0, W, S], [-S / 2, 0, W, S]]) k.box(w, h, 0.004, this.pccFrame, bx, by, 0, 'mg_pcc', sq);
    this.pccFill = k.box(S - W, S - W, 0.003, k.std(0xc9d1d8, { unique: true, emissive: 0xc9d1d8, emissiveIntensity: 0.3 }), 0, 0, 0, 'mg_pcc', sq);
    sq.traverse((o) => (o.userData.noShadow = true));
    this.pccSq = sq;
    this.lampRed = k.std(0x5a1a17, { unique: true, emissive: 0xff2a1f, emissiveIntensity: 0 });
    this.lampGreen = k.std(0x15401c, { unique: true, emissive: 0x2bff5a, emissiveIntensity: 0 });
    k.cyl(0.004, 0.004, 0.003, this.lampRed, px - 0.006, 0.1, pz + 0.0205, 'mg_pcc', this.root, 10).rotation.x = Math.PI / 2;
    k.cyl(0.004, 0.004, 0.003, this.lampGreen, px + 0.006, 0.1, pz + 0.0205, 'mg_pcc', this.root, 10).rotation.x = Math.PI / 2;

    // ---- carport solar over the parking lot --------------------------------------------------
    const cells = TX.pvCells().clone();
    cells.repeat.set(4, 2);
    cells.needsUpdate = true;
    this.pvMat = new THREE.MeshStandardMaterial({ map: cells, metalness: 0.5, roughness: 0.28, emissive: 0x2a5d9c, emissiveIntensity: 0.3 });
    const carCols = [0x8e2b2b, 0xd7d9db, 0x2c3e50, 0x5d6d7e, 0xc0a062, 0x2f5d3a];
    for (let row = 0; row < 2; row++) {
      const z = 0.04 + row * 0.18;
      const canopy = k.box(0.56, 0.006, 0.11, this.pvMat, 0.44, 0.105, z, 'mg_pv');
      canopy.rotation.x = row ? 0.12 : -0.12;
      for (const x of [0.2, 0.36, 0.52, 0.68]) {
        k.cyl(0.004, 0.004, 0.1, galv, x, 0.05, z, 'mg_pv', this.root, 8);
        k.strut([x, 0.1, z - 0.04], [x, 0.1, z + 0.04], 0.005, galv, 'mg_pv');
      }
      for (let i = 0; i < 8; i++) {
        const x = 0.19 + i * 0.07;
        const car = new THREE.Group();
        car.position.set(x, 0, z + (row ? -0.01 : 0.01));
        this.root.add(car);
        const paint = k.std(carCols[(i * 3 + row) % carCols.length], { metalness: 0.6, roughness: 0.3 });
        k.box(0.03, 0.012, 0.055, paint, 0, 0.009, 0, null, car);
        k.box(0.026, 0.01, 0.03, k.std(0x22313d, { metalness: 0.3, roughness: 0.15 }), 0, 0.02, -0.002, null, car);
        for (const [wx, wz] of [[-0.015, 0.018], [0.015, 0.018], [-0.015, -0.018], [0.015, -0.018]]) {
          k.cyl(0.005, 0.005, 0.004, k.std(0x1a1a1a), wx, 0.005, wz, null, car, 10).rotation.z = Math.PI / 2;
        }
        if (i % 3 === 0) {                                       // EV charger at the head of the bay
          k.box(0.012, 0.03, 0.008, k.painted(0xd0d4d7), 0, 0.015, row ? -0.045 : 0.045, 'mg_pv', car);
        }
      }
    }
    k.box(0.04, 0.05, 0.02, k.painted(0xc9cdd0), 0.74, G + 0.025, 0.11, 'mg_pv');               // solar inverters
    k.box(0.034, 0.04, 0.002, louvre, 0.74, G + 0.027, 0.1215, 'mg_pv');

    // ---- the hospital it protects + standby generator ------------------------------------------
    const F = TX.facade('hospital');
    const fmap = F.map.clone(), femi = F.emissive.clone();
    for (const t of [fmap, femi]) { t.repeat.set(4, 1); t.needsUpdate = true; }
    this.hospMat = new THREE.MeshStandardMaterial({ map: fmap, emissiveMap: femi, emissive: T.window, emissiveIntensity: 0.9, roughness: 0.8 });
    const hosp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.1), [this.hospMat, this.hospMat, k.surface('flatroof', [3, 1]), this.hospMat, this.hospMat, this.hospMat]);
    hosp.position.set(0.5, 0.07, -0.3);
    this.root.add(k.pick(hosp, 'ld_hosp'));
    k.plaque(TX.plate(['COMMUNITY HOSPITAL', 'EMERGENCY'], { bg: '#b71c1c', fg: '#ffffff' }), 0.12, 0.03, 0.42, 0.125, -0.2495, 'ld_hosp');
    k.box(0.07, 0.035, 0.035, k.painted(0xcfc9b8), 0.35, G + 0.0175, -0.2, 'mg_gen');
    k.box(0.05, 0.022, 0.002, louvre, 0.35, G + 0.02, -0.1824, 'mg_gen');
    k.cyl(0.004, 0.004, 0.04, k.std(0x3a3f44, { metalness: 0.6 }), 0.375, G + 0.055, -0.21, 'mg_gen', this.root, 8);
    k.plaque(TX.plate(['STANDBY GEN', '750 kW DIESEL']), 0.04, 0.014, 0.33, G + 0.028, -0.1822, 'mg_gen');

    // ---- fences ---------------------------------------------------------------------------------
    const FH = 0.06;
    k.fence([-0.75, 0.13], [-0.75, -0.31], FH, 'mg_fire', this.root, 0.1);
    k.fence([-0.75, 0.13], [0.15, 0.13], FH, 'mg_fire', this.root, 0.1);
    k.fence([0.15, 0.13], [0.15, -0.06], FH, 'mg_fire', this.root, 0.1);
    k.plaque(TX.sign('DANGER', ['HIGH VOLTAGE', 'ARC FLASH HAZARD']), 0.06, 0.038, -0.3, 0.035, 0.1315, 'mg_fire');
    k.plaque(TX.sign('NOTICE', ['NO SMOKING', 'NO OPEN FLAME'], { header: '#005eb8' }), 0.05, 0.032, 0.05, 0.035, 0.1315, 'mg_fire');

    // ---- power-flow paths (cyan particles) ------------------------------------------------------
    const P = (pts) => new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
    this.flows = {
      utility: P([[-0.78, 0.262, -0.33], [-0.3, 0.262, -0.34], [-0.08, 0.262, -0.33], [-0.072, 0.1, -0.322], [-0.07, G + 0.1, -0.27]]),
      bess1: P([[-0.53, G + 0.11, -0.12], [-0.53, G + 0.1, 0.06], [-0.4, G + 0.1, 0.12], [-0.15, G + 0.12, -0.05], [-0.02, G + 0.1, -0.24]]),
      bess2: P([[-0.2, G + 0.11, -0.12], [-0.2, G + 0.1, 0.06], [-0.1, G + 0.1, 0.0], [0.02, G + 0.1, -0.24]]),
      pv: P([[0.44, 0.12, 0.13], [0.74, G + 0.06, 0.11], [0.4, G + 0.1, -0.12], [0.06, G + 0.1, -0.24]]),
      load: P([[0.08, G + 0.1, -0.27], [0.25, G + 0.1, -0.22], [0.42, 0.1, -0.25]]),
    };
    this.particles = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0045, 8, 6), new THREE.MeshBasicMaterial({ color: T.flow }), 200);
    this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particles.frustumCulled = false;
    this.particles.count = 0;
    this.root.add(this.particles);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);

    // Selection ring.
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.004, 8, 48), new THREE.MeshBasicMaterial({ color: T.select }));
    this.ring.rotation.x = Math.PI / 2;
    this.ring.visible = false;
    this.root.add(this.ring);
  }

  // The front-left container is built hollow with its doors swung open, so trainees see the racks.
  _openContainer(x, y0, z, L, W, H, wall) {
    const THREE = this.THREE, k = this.kit;
    const it = 'mg_bess';
    const t = 0.004;
    k.box(L, t, W, k.std(0x5d6266), x, y0 + t / 2, z, it);                  // floor
    k.box(L, t, W, wall, x, y0 + H - t / 2, z, it);                          // roof
    k.box(L, H, t, wall, x, y0 + H / 2, z - W / 2 + t / 2, it);              // back wall
    for (const s of [-1, 1]) k.box(t, H, W, wall, x + s * (L / 2 - t / 2), y0 + H / 2, z, it);
    k.box(L, 0.012, t, wall, x, y0 + H - 0.006, z + W / 2 - t / 2, it);      // door header
    // Two door pairs, swung open.
    for (const cx of [x - L / 4, x + L / 4]) {
      for (const s of [-1, 1]) {
        const hinge = new THREE.Group();
        hinge.position.set(cx + s * (L / 4 - 0.004), y0, z + W / 2);
        hinge.rotation.y = s * 1.75;
        this.root.add(hinge);
        k.box(L / 4 - 0.004, H - 0.014, t, wall, -s * (L / 8 - 0.002), (H - 0.014) / 2, t / 2, it, hinge);
        for (const dx of [-0.012, 0.012]) k.box(0.002, H - 0.02, 0.003, k.std(0x9aa1a6, { metalness: 0.7 }), -s * (L / 8) + dx, (H - 0.014) / 2, t + 0.002, it, hinge);
      }
    }
    // Racks against the back wall, each with a column of module LEDs.
    const racks = 8, modules = 10;
    this.leds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.004, 0.0035, 0.002), new THREE.MeshBasicMaterial(), racks * modules);
    const m = new THREE.Matrix4();
    for (let r = 0; r < racks; r++) {
      const rx = x - L / 2 + 0.022 + r * ((L - 0.044) / (racks - 1));
      k.box(0.026, H - 0.012, 0.03, k.std(0x2a2d30, { metalness: 0.4 }), rx, y0 + (H - 0.012) / 2 + 0.004, z - W / 2 + 0.019, it);
      k.plaque(TX.rack(), 0.024, H - 0.016, rx, y0 + (H - 0.012) / 2 + 0.004, z - W / 2 + 0.0345, it);
      for (let j = 0; j < modules; j++) {
        m.makeTranslation(rx + 0.008, y0 + 0.01 + j * ((H - 0.022) / modules), z - W / 2 + 0.036);
        this.leds.setMatrixAt(r * modules + j, m);
        this.leds.setColorAt(r * modules + j, new THREE.Color(0x30353b));
      }
    }
    this.ledModules = modules;
    this.root.add(this.leds);
  }

  anchor(item) {
    const a = {
      mg_pcc: [-0.08, 0.02, -0.33], mg_bus: [0, 0.02, -0.27], mg_bess: [-0.37, 0.02, -0.12], mg_pcs: [-0.37, 0.02, 0.08],
      mg_xfmr: [-0.2, 0.02, 0.08], mg_pv: [0.44, 0.02, 0.13], mg_ctrl: [0.2, 0.02, -0.27], mg_gen: [0.35, 0.02, -0.2],
      mg_fire: [-0.37, 0.02, 0.13], ld_hosp: [0.5, 0.02, -0.3],
    }[item];
    return a ? new this.THREE.Vector3(...a) : null;
  }

  update(state, dt) {
    this.time += dt;
    if (!state) return;
    const THREE = this.THREE;
    const t = this.time, pulse = 0.5 + 0.5 * Math.sin(t * 6);
    const bk = state.bess.kw, soc = state.bess.soc;
    // State-of-charge LEDs: lit modules = charge; colour = discharging (green) / charging (cyan) / idle.
    if (this.leds) {
      const on = new THREE.Color(bk > 20 ? T.renew : bk < -20 ? T.flow : 0xc9d1d8), off = new THREE.Color(0x30353b);
      const lit = Math.round(soc * this.ledModules);
      const blink = Math.abs(bk) > 20 && pulse > 0.5;
      for (let i = 0; i < this.leds.count; i++) {
        const j = i % this.ledModules;
        this.leds.setColorAt(i, j < lit - (blink && j === lit - 1 ? 1 : 0) ? on : off);
      }
      this.leds.instanceColor.needsUpdate = true;
    }
    // Island beacon.
    this.beaconMat.emissiveIntensity = state.islanded ? 0.6 + 1.2 * pulse : 0;
    // PCC recloser status.
    const closed = state.closed.PCC;
    const tripped = state.alarms.some((a) => a.active && a.key === 'PCC:trip');
    this.pccFill.visible = closed;
    const col = !closed && tripped ? (pulse > 0.5 ? T.alarm1 : 0x7a1f1d) : closed ? T.equip : T.alarm3;
    this.pccFrame.color.setHex(col);
    this.pccFrame.emissive.setHex(col);
    this.lampRed.emissiveIntensity = closed ? 1.6 : 0;
    this.lampGreen.emissiveIntensity = closed ? 0 : 1.6;
    const feederLive = state.buses.f4 && state.buses.f4.energized;
    this.feederMat.color.setHex(feederLive ? T.kv12 : 0x3d434a);
    this.feederMat.emissiveIntensity = feederLive ? 0.12 : 0;
    // Solar and hospital windows.
    const pv = state.pv.pv_mg;
    this.pvMat.emissiveIntensity = 0.1 + 0.7 * Math.min(1, (pv ? pv.kw : 0) / 800);
    const hosp = state.loads.ld_hosp;
    this.hospMat.emissiveIntensity = hosp && hosp.served ? 0.9 : 0;
    this.hospMat.color.setHex(hosp && hosp.served ? 0xffffff : 0x8a8f94);

    // Power-flow particles.
    const pcc = state.branches.PCC;
    const flows = [
      ['utility', pcc && pcc.closed ? pcc.kw : 0],
      ['bess1', bk / 2], ['bess2', bk / 2],
      ['pv', pv ? pv.kw : 0],
      ['load', hosp && hosp.served ? hosp.kw : 0],
    ];
    let n = 0;
    for (const [id, kw] of flows) {
      if (Math.abs(kw) < 15) continue;
      const c = this.flows[id], len = c.getLength();
      const mag = Math.min(1, Math.abs(kw) / 1500);
      const dir = kw >= 0 ? 1 : -1;
      this.phase[id] = ((this.phase[id] || 0) + dir * ((0.05 + 0.12 * mag) / len) * dt + 1) % 1;
      const count = Math.max(3, Math.round(len * (16 + 30 * mag)));
      for (let i = 0; i < count && n < 200; i++) {
        const p = c.getPointAt((this.phase[id] + i / count) % 1);
        this.particles.setMatrixAt(n++, this._m.compose(p, this._q, this._s));
      }
    }
    this.particles.count = n;
    this.particles.instanceMatrix.needsUpdate = true;

    const a = this.anchor(this.selected);
    this.ring.visible = !!a;
    if (a) { this.ring.position.copy(a); this.ring.scale.setScalar(1 + 0.12 * Math.sin(t * 4)); }
  }
}
