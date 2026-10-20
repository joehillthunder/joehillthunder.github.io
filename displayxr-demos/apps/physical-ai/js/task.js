// The pick-orange task from Lightwheel's LeIsaac (leisaac/tasks/pick_orange), as a light kinematic
// simulation: the SO-101 tracks joint targets through a first-order lag fitted to the demos, an orange
// is held when the gripper closes on it, and a released orange drops onto whatever is under it.
// Success follows mdp/terminations.py task_done(): every orange within ±10 cm (x, y) and ±7 cm (z) of
// the plate, and the arm back inside the rest-pose range.
//
// All positions are in the kitchen's USD world frame (Z up, metres), so the numbers match the
// LeIsaac configs. No three.js scene graph is needed (evaluation runs many of these at once).

import * as THREE from 'three';
import { fkTip, motorToRad, radToMotor, clampMotor, REST_MOTOR } from './robot.js';

// Robot placement: leisaac SO101_FOLLOWER_CFG init_state pos (2.2, -0.61, 0.89), rot wxyz (0, 0, 0, 1),
// then the USD's base frame -> URDF base_link offset (checked against the USD rest pose to 0.1 mm).
const USD_BASE_TO_URDF = (() => {
  const mk = (p, q) => new THREE.Matrix4().compose(new THREE.Vector3(...p), q, new THREE.Vector3(1, 1, 1));
  const vUsd = mk([0.0206915, 0.0221255, 0.0300817], new THREE.Quaternion(0.7071081, 0, 0, 0.7071055));
  const vUrdf = mk([-0.00636471, -9.94414e-05, -0.0024], new THREE.Quaternion().setFromEuler(new THREE.Euler(1.5708, -1.67685e-15, 1.5708, 'ZYX')));
  return vUsd.multiply(vUrdf.invert());
})();
export const ROBOT_BASE = new THREE.Matrix4()
  .compose(new THREE.Vector3(2.2, -0.61, 0.89), new THREE.Quaternion(0, 0, 1, 0), new THREE.Vector3(1, 1, 1))
  .multiply(USD_BASE_TO_URDF);
export const ROBOT_BASE_INV = ROBOT_BASE.clone().invert();

// Scene layout from kitchen_with_orange/scene.usd. Orange and plate origins sit at their bottoms.
export const COUNTER = { z: 0.92, x0: 0.25, x1: 2.75, y0: -0.65, y1: 0 };
export const ORANGE_HOME = [[2.1256, -0.3037], [2.2492, -0.3322], [2.1538, -0.4054]];
export const PLATE_HOME = [2.4153, -0.3384];
export const ORANGE_R = 0.0275, ORANGE_H = 0.044, PLATE_R = 0.101, PLATE_LIP = 0.008;

const GRASP_DIST = 0.045;   // tool point to orange centre, to pick it up
const GRASP_MAX = 40;       // gripper motor value below which closing fingers can hold an orange
const RELEASE_GAP = 6;      // opening this far past the stall point lets go (calibration varies per demo)
const G = 9.81;

// leisaac SO101_FOLLOWER_REST_POSE_RANGE: ±30° around the rest pose, every joint.
const REST_DEG = [0, -100, 90, 50, 0, -10];
export function atRest(motor) {
  for (let i = 0; i < 6; i++) if (Math.abs(motorToRad(i, motor[i]) * 180 / Math.PI - REST_DEG[i]) > 30) return false;
  return true;
}

// Where the demos start: the mean first frame of the 60 Lightwheel episodes (LeRobot units).
export const START_MOTOR = [-11.8, -45.6, 53.2, 49.7, 1.8, 9.1];

/** Joint tracking: s += k (a - s) per 30 Hz step. Defaults are refit from the demos in data.js. */
export const DYNAMICS = { k: [0.32, 0.3, 0.3, 0.32, 0.35, 0.4] };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Domain randomisation as in pick_orange_env_cfg.py: each orange and the plate move uniformly
 * within ±3 cm in x and y. `spread` scales the range (1 = Lightwheel's setting).
 */
export function randomLayout(rng, spread = 1) {
  const j = () => (rng() * 2 - 1) * 0.03 * spread;
  for (let tries = 0; tries < 50; tries++) {
    const oranges = ORANGE_HOME.map(([x, y]) => [x + j(), y + j()]);
    const plate = [PLATE_HOME[0] + j(), PLATE_HOME[1] + j()];
    let ok = true;
    for (let a = 0; a < 3 && ok; a++) for (let b = a + 1; b < 3; b++) if (Math.hypot(oranges[a][0] - oranges[b][0], oranges[a][1] - oranges[b][1]) < 2 * ORANGE_R + 0.008) { ok = false; break; }
    for (const o of oranges) if (Math.hypot(o[0] - plate[0], o[1] - plate[1]) < PLATE_R + ORANGE_R) ok = false;
    if (ok) return { oranges, plate };
  }
  return { oranges: ORANGE_HOME.map((o) => o.slice()), plate: PLATE_HOME.slice() };
}

const _tipBase = new THREE.Vector3(), _tipRot = new THREE.Matrix4(), _tmp = new THREE.Vector3();

export class PickOrangeEnv {
  constructor() {
    this.motor = new Float64Array(6);
    this.rad = new Float64Array(6);
    this.tip = new THREE.Vector3();        // world
    this.tipRot = new THREE.Matrix4();     // world tool frame
    this.oranges = [0, 1, 2].map(() => ({ p: new THREE.Vector3(), vz: 0, held: false, everHeld: false, offset: new THREE.Vector3(), q: new THREE.Quaternion() }));
    this.plate = new THREE.Vector3();
    this.reset();
  }

  reset(layout = { oranges: ORANGE_HOME, plate: PLATE_HOME }, motor = START_MOTOR) {
    this.t = 0;
    this.held = -1;
    this.holdClamp = 0;
    this.stall = 0;
    for (let i = 0; i < 3; i++) {
      const o = this.oranges[i];
      o.p.set(layout.oranges[i][0], layout.oranges[i][1], COUNTER.z + 0.004);
      o.vz = 0; o.held = false; o.everHeld = false; o.q.identity();
    }
    this.plate.set(layout.plate[0], layout.plate[1], COUNTER.z);
    this.motor.set(motor);
    this.updateKinematics();
    this.prevGrip = this.motor[5];
    this.events = [];
    return this;
  }

  updateKinematics() {
    for (let i = 0; i < 6; i++) this.rad[i] = motorToRad(i, this.motor[i]);
    fkTip(this.rad, _tipBase, _tipRot);
    this.tip.copy(_tipBase).applyMatrix4(ROBOT_BASE);
    this.tipRot.multiplyMatrices(ROBOT_BASE, _tipRot);
  }

  /** Tool point in the robot base frame (what a policy observes). */
  tipInBase(out = new THREE.Vector3()) { return out.copy(this.tip).applyMatrix4(ROBOT_BASE_INV); }

  orangeCentre(i, out = new THREE.Vector3()) { return out.copy(this.oranges[i].p).setZ(this.oranges[i].p.z + ORANGE_H / 2); }

  /** Sets the joint state directly (demo replay drives the recorded state). */
  setMotor(m) {
    for (let i = 0; i < 6; i++) this.motor[i] = clampMotor(i, m[i]);
    this.updateKinematics();
    this.contacts();
  }

  /** One 30 Hz step toward joint target `action` (LeRobot units). */
  step(action, dt = 1 / 30) {
    const k = DYNAMICS.k;
    for (let i = 0; i < 6; i++) this.motor[i] = clampMotor(i, this.motor[i] + k[i] * (action[i] - this.motor[i]));
    if (this.held >= 0) this.motor[5] = Math.max(this.motor[5], this.holdClamp);
    this.updateKinematics();
    this.contacts(action[5]);
    this.physics(dt);
    this.t++;
  }

  contacts(gripCmd = this.motor[5]) {
    const g = this.motor[5];
    if (this.held < 0) {
      // Closing fingers pick up the nearest orange inside the grasp radius.
      if (g < GRASP_MAX && g < this.prevGrip - 0.05 && g > 8) {
        let best = -1, bd = GRASP_DIST;
        for (let i = 0; i < 3; i++) {
          const d = this.orangeCentre(i, _tmp).distanceTo(this.tip);
          if (d < bd) { bd = d; best = i; }
        }
        if (best >= 0) {
          const o = this.oranges[best];
          this.held = best; o.held = true; o.everHeld = true; o.vz = 0;
          this.holdClamp = g - 9; this.stall = g; // the fingers close a little further onto the orange, as in the demos
          // keep the orange where it is relative to the tool frame
          const inv = _tipRot.copy(this.tipRot).invert();
          o.offset.copy(this.orangeCentre(best, _tmp)).applyMatrix4(inv);
          this.events.push({ t: this.t, type: 'grasp', orange: best });
        }
      }
    } else if (g > this.stall + RELEASE_GAP && gripCmd >= g - 0.5) {
      const o = this.oranges[this.held];
      o.held = false;
      this.events.push({ t: this.t, type: 'release', orange: this.held, onPlate: this.onPlate(this.held) });
      this.held = -1;
    }
    if (this.held >= 0) this.stall = Math.min(this.stall, g);
    this.prevGrip = g;
    if (this.held >= 0) {
      const o = this.oranges[this.held];
      _tmp.copy(o.offset).applyMatrix4(this.tipRot);
      o.p.set(_tmp.x, _tmp.y, _tmp.z - ORANGE_H / 2);
    }
  }

  supportZ(x, y) {
    if (Math.hypot(x - this.plate.x, y - this.plate.y) < PLATE_R * 0.85) return this.plate.z + PLATE_LIP;
    if (x > COUNTER.x0 && x < COUNTER.x1 && y > COUNTER.y0 && y < COUNTER.y1) return COUNTER.z + 0.004;
    return 0;
  }

  physics(dt) {
    for (const o of this.oranges) {
      if (o.held) continue;
      const floor = this.supportZ(o.p.x, o.p.y);
      if (o.p.z > floor + 1e-4) {
        o.vz -= G * dt;
        o.p.z = Math.max(floor, o.p.z + o.vz * dt);
        if (o.p.z === floor) o.vz = 0;
      }
    }
  }

  onPlate(i) {
    const o = this.oranges[i].p, p = this.plate;
    return !this.oranges[i].held && Math.abs(o.x - p.x) < 0.10 && Math.abs(o.y - p.y) < 0.10 && Math.abs(o.z - p.z) < 0.07;
  }

  placedCount() { let n = 0; for (let i = 0; i < 3; i++) if (this.onPlate(i)) n++; return n; }

  /** LeIsaac task_done(): all three on the plate and the arm at rest. */
  success() { return this.placedCount() === 3 && atRest(this.motor); }

  /** Per-orange subtask flags, as the LeIsaac SubtaskCfg observation terms report them. */
  subtasks() { return this.oranges.map((o, i) => ({ picked: o.everHeld, placed: this.onPlate(i) })); }
}

export { radToMotor };
