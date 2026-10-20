// Controllers for the pick-orange task. Each one maps the env to a joint target (LeRobot units)
// every 30 Hz step:
//   ReplayController   a recorded demo's leader-arm actions
//   ScriptedExpert     Lightwheel's datagen state machine (leisaac/datagen/state_machine/pick_orange.py),
//                      ported onto this page's IK
//   PolicyController   a behaviour-cloned MLP trained on this page (train-worker.js)
//   TeleopController   you, through IK: move the tool point, open and close the gripper

import * as THREE from 'three';
import { solveIK, solveIKPose, solveIKSeeded, fkTip, motorToRad, radToMotor, REST_MOTOR } from './robot.js';
import { ROBOT_BASE, ROBOT_BASE_INV, ORANGE_H } from './task.js';

export const OBS_DIM = 15;
// Actions are end-effector deltas, as with robomimic's OSC or LeIsaac's IK action mode: where the tool
// point should be LOOKAHEAD frames from now, in the robot base frame (x25, so 4 cm = 1), the wrist
// flex and roll changes (/20 motor units) and the absolute gripper command (/50). IK on the first
// three joints turns the position into joint targets.
// The labels come from the follower's own future pose, not the leader arm's command: in the demos the
// leader sits a steady 1-2 cm above the follower (the follower sags under gravity), and cloning that
// offset would make a policy drift upward in a sim without sag.
export const ACT_DIM = 6;
export const LOOKAHEAD = 6;
const POS_GAIN = 25, WRIST_SCALE = 20, GRIP_SCALE = 50, JOINT_SCALE = 10;
// 'joint': the five arm joints' change over the lookahead (/10 motor units) + gripper, no IK.
export const ACTION = { mode: 'joint' };

const _a = new THREE.Vector3(), _b = new THREE.Vector3();
const REST_RAD = REST_MOTOR.map((m, i) => motorToRad(i, m));
export const REST_TIP = fkTip(REST_RAD, new THREE.Vector3()).applyMatrix4(ROBOT_BASE);

/**
 * What the policy is reaching for: the plate while holding, the chosen orange otherwise, and the
 * rest pose once nothing is left. `goalFor` takes an explicit orange (demo labels use hindsight:
 * the orange the demonstrator grasped next); `pick` chooses one for a rollout (the nearest orange
 * not yet on the plate, kept until it is grasped).
 */
export class Targeter {
  constructor() { this.choice = -1; this.goal = { pos: new THREE.Vector3(), kind: 'home', orange: -1 }; }
  reset() { this.choice = -1; }
  goalFor(env, orange) {
    const g = this.goal;
    if (env.held >= 0) { g.kind = 'plate'; g.orange = env.held; g.pos.copy(env.plate).setZ(env.plate.z + 0.07); }
    else if (orange >= 0 && !env.onPlate(orange)) { g.kind = 'orange'; g.orange = orange; env.orangeCentre(orange, g.pos); }
    else { g.kind = 'home'; g.orange = -1; g.pos.copy(REST_TIP); }
    return g;
  }
  pick(env) {
    if (env.held >= 0) this.choice = -1;
    else if (this.choice < 0 || env.onPlate(this.choice)) {
      // in order, like Lightwheel's state machine (orange_now 1, 2, 3)
      this.choice = -1;
      for (let i = 0; i < 3; i++) if (!env.onPlate(i)) { this.choice = i; break; }
    }
    return this.goalFor(env, env.held >= 0 ? env.held : this.choice);
  }
}

const _sa = new THREE.Vector3(), _ra = new Float64Array(6);
/** The label for a demo frame: the follower's pose `future` (LOOKAHEAD frames on) relative to now, plus the gripper command. */
export function actionLabel(env, future, gripCmd, out) {
  if (ACTION.mode === 'joint') {
    for (let k = 0; k < 5; k++) out[k] = (future[k] - env.motor[k]) / JOINT_SCALE;
    out[5] = gripCmd / GRIP_SCALE;
    return out;
  }
  env.tipInBase(_a);
  for (let k = 0; k < 5; k++) _ra[k] = motorToRad(k, future[k]);
  fkTip(_ra, _sa);
  out[0] = (_sa.x - _a.x) * POS_GAIN; out[1] = (_sa.y - _a.y) * POS_GAIN; out[2] = (_sa.z - _a.z) * POS_GAIN;
  out[3] = (future[3] - env.motor[3]) / WRIST_SCALE;
  out[4] = (future[4] - env.motor[4]) / WRIST_SCALE;
  out[5] = gripCmd / GRIP_SCALE;
  return out;
}

/** The label for a sim-made frame (synthetic demo, DAgger): the joint command itself, which is exact here. */
export function commandLabel(env, a, out) {
  for (let k = 0; k < 5; k++) out[k] = (a[k] - env.motor[k]) / JOINT_SCALE;
  out[5] = a[5] / GRIP_SCALE;
  return out;
}

/** The 15-number observation: joints, tool point and goal in the robot's base frame, task flags. */
export function observe(env, goal, out = new Float32Array(OBS_DIM)) {
  for (let k = 0; k < 6; k++) out[k] = env.motor[k] / 100;
  env.tipInBase(_a);
  _b.copy(goal.pos).applyMatrix4(ROBOT_BASE_INV).sub(_a);
  out[6] = _a.x * 4; out[7] = _a.y * 4; out[8] = _a.z * 4;
  out[9] = Math.max(-3, Math.min(3, _b.x * 8)); out[10] = Math.max(-3, Math.min(3, _b.y * 8)); out[11] = Math.max(-3, Math.min(3, _b.z * 8));
  out[12] = env.held >= 0 ? 1 : 0;
  out[13] = env.placedCount() / 3;
  out[14] = goal.kind === 'home' ? 1 : 0;
  return out;
}

// ---- MLP -----------------------------------------------------------------------------------------

/** A trained model: { sizes, W: [Float32Array], b: [Float32Array], mean, std } (see train-worker.js). */
export class MLP {
  constructor(model) {
    this.m = model;
    this.h = model.sizes.slice(1).map((n) => new Float32Array(n));
    this.x = new Float32Array(model.sizes[0]);
  }
  forward(obs) {
    const { sizes, W, b, mean, std } = this.m;
    for (let i = 0; i < sizes[0]; i++) this.x[i] = (obs[i] - mean[i]) / std[i];
    let inp = this.x;
    for (let l = 0; l < W.length; l++) {
      const nIn = sizes[l], nOut = sizes[l + 1], w = W[l], bb = b[l], out = this.h[l], last = l === W.length - 1;
      for (let o = 0; o < nOut; o++) {
        let s = bb[o];
        const row = o * nIn;
        for (let i = 0; i < nIn; i++) s += w[row + i] * inp[i];
        out[o] = last ? s : Math.tanh(s);
      }
      inp = out;
    }
    return inp;
  }
}

// ---- controllers ---------------------------------------------------------------------------------

export class ReplayController {
  constructor(ep) { this.ep = ep; this.name = 'Demo replay'; }
  reset() {}
  act(env, out) {
    const t = Math.min(env.t, this.ep.n - 1);
    for (let k = 0; k < 6; k++) out[k] = this.ep.a[t * 6 + k];
    return out;
  }
  done(env) { return env.t >= this.ep.n; }
}

export class PolicyController {
  constructor(model, name = 'BC policy') {
    this.net = new MLP(model);
    this.name = name;
    this.tg = new Targeter();
    this.obs = new Float32Array(OBS_DIM);
    this.rad = new Float64Array(6);
    this.target = new THREE.Vector3();
  }
  reset() { this.tg.reset(); }
  act(env, out) {
    this.goal = this.tg.pick(env);
    observe(env, this.goal, this.obs);
    const y = this.net.forward(this.obs);
    if ((this.net.m.mode || ACTION.mode) === 'joint') {
      for (let k = 0; k < 5; k++) out[k] = env.motor[k] + y[k] * JOINT_SCALE;
      out[5] = y[5] * GRIP_SCALE;
      return out;
    }
    env.tipInBase(this.target);
    this.target.x += y[0] / POS_GAIN; this.target.y += y[1] / POS_GAIN; this.target.z += y[2] / POS_GAIN;
    const roll = env.motor[4] + y[4] * WRIST_SCALE;
    for (let k = 0; k < 6; k++) this.rad[k] = env.rad[k];
    this.rad[4] = motorToRad(4, roll);
    if (this.wristFromPolicy) {
      // the policy's wrist pitch keeps the demonstrators' posture; IK places the tool point with the rest
      this.rad[3] = motorToRad(3, env.motor[3] + y[3] * WRIST_SCALE);
      solveIK(this.rad, this.target, { iters: 6, joints: 3, down: 0 });
    } else {
      solveIKPose(this.rad, this.target);
    }
    for (let k = 0; k < 4; k++) out[k] = env.motor[k] + Math.max(-JOINT_RATE, Math.min(JOINT_RATE, radToMotor(k, this.rad[k]) - env.motor[k]));
    out[4] = roll;
    out[5] = y[5] * GRIP_SCALE;
    return out;
  }
}

// Gripper commands in LeRobot units: the demos open to about 41 and close onto an orange around 30.
const OPEN = 45, CLOSE = 0;

const LEAD = 0.02;     // m: the commanded tool point leads the actual one by at most this much
const AT = 0.012;      // m: close enough to count as there
const JOINT_RATE = 6;  // motor units per step: the expert never jumps posture
// 0 when lined up (within 1 cm), 1 at 5 cm off: how high the gripper should stay while it lines up
const funnel = (dxy) => Math.min(1, Math.max(0, (dxy - 0.01) / 0.04));

/**
 * Lightwheel's PickOrangeStateMachine (leisaac/datagen/state_machine/pick_orange.py), phase for
 * phase: above the orange, down to it, grasp, lift, above the plate, down, release, lift, and finally
 * blend the joints to the rest pose. Oranges in order, dropped on a triangle of points on the plate.
 * Their end-effector body sits about 10 cm above the fingertips (_GRIPPER_OFFSET), so heights here are
 * for this page's tool point.
 *
 * One change makes it a good teacher for behaviour cloning: theirs advances on step counters, this one
 * reads its phase from the current state, so it has no hidden memory. The same situation always gets
 * the same action, a learner can copy it, and it can be asked what to do in any state a learner
 * drifts into (which is what DAgger needs). The drop triangle is 4 cm rather than 10 cm, so oranges
 * land inside the plate rather than on its rim.
 */
export class ScriptedExpert {
  constructor() { this.name = 'Lightwheel state machine'; this.rad = new Float64Array(6); this.goalP = new THREE.Vector3(); this.c = new THREE.Vector3(); }
  reset() { this.phase = 'start'; this.q = null; }
  /** Fills goalP and returns the gripper command, or null for "go home". */
  plan(env) {
    const tip = env.tip, g = this.goalP, c = this.c;
    const top = env.plate.z + 0.12;
    if (env.held >= 0) {
      const ang = env.held * (2 * Math.PI / 3);
      const dx = env.plate.x + Math.cos(ang) * 0.04, dy = env.plate.y + Math.sin(ang) * 0.04;
      const dxy = Math.hypot(tip.x - dx, tip.y - dy), low = env.plate.z + 0.07;
      if (dxy > 0.05) {
        if (tip.z < top - 0.025) { this.phase = 'lift orange'; g.set(tip.x, tip.y, top); }
        else { this.phase = 'move above plate'; g.set(dx, dy, top); }
        return CLOSE;
      }
      // a funnel: the closer it is over the drop point, the lower it may go
      g.set(dx, dy, low + funnel(dxy) * (top - low));
      if (dxy > 0.03 || tip.z > low + 0.03) { this.phase = 'lower to plate'; return CLOSE; }
      this.phase = 'release';
      return OPEN;
    }
    let i = -1;
    for (let k = 0; k < 3; k++) if (!env.onPlate(k)) { i = k; break; }
    if (i < 0) return null;
    env.orangeCentre(i, c);
    const dxy = Math.hypot(tip.x - c.x, tip.y - c.y);
    if (dxy > 0.05) {
      if (tip.z < c.z + 0.09) { this.phase = 'lift gripper'; g.set(tip.x, tip.y, c.z + 0.12); }
      else { this.phase = 'move above orange'; g.set(c.x, c.y, c.z + 0.12); }
      return OPEN;
    }
    g.set(c.x, c.y, c.z + funnel(dxy) * 0.12);
    if (tip.distanceTo(c) > 0.025) { this.phase = 'lower to orange'; return OPEN; }
    this.phase = 'grasp';
    return CLOSE;
  }
  act(env, out) {
    const grip = this.plan(env);
    if (grip === null) {
      this.phase = 'return home';
      // their pre_step(): blend the joints to the rest pose
      for (let k = 0; k < 6; k++) out[k] = env.motor[k] + Math.max(-2.5, Math.min(2.5, REST_MOTOR[k] - env.motor[k]));
      // keep the fingers open until they are clear of the oranges on the plate
      for (let i = 0; i < 3; i++) if (env.orangeCentre(i, _a).distanceTo(env.tip) < 0.07) out[5] = OPEN;
      return out;
    }
    // joint target for the phase goal (cached while the goal holds still), then a capped joint step
    if (!this.q || this.qFor.distanceTo(this.goalP) > 0.003) {
      this.rad.fill(0);
      solveIKSeeded(this.rad, _a.copy(this.goalP).applyMatrix4(ROBOT_BASE_INV));
      this.q = Array.from(this.rad, (r, k) => radToMotor(k, r));
      this.qFor = (this.qFor || new THREE.Vector3()).copy(this.goalP);
    }
    for (let k = 0; k < 5; k++) out[k] = env.motor[k] + Math.max(-JOINT_RATE, Math.min(JOINT_RATE, this.q[k] - env.motor[k]));
    out[4] = 0;
    out[5] = grip;
    return out;
  }
  done(env) { return env.placedCount() === 3 && env.held < 0 && Math.max(...REST_MOTOR.map((m, k) => Math.abs(m - env.motor[k]))) < 3; }
}

/** You at the controls: the tool point follows a target you move; the gripper is a toggle. */
export class TeleopController {
  constructor() { this.name = 'Teleop'; this.target = new THREE.Vector3(); this.rad = new Float64Array(6); this.grip = OPEN; this.roll = 0; }
  reset(env) { this.target.copy(env.tip); this.grip = OPEN; this.roll = 0; }
  act(env, out) {
    for (let k = 0; k < 6; k++) this.rad[k] = env.rad[k];
    this.rad[4] = this.roll;
    solveIKPose(this.rad, _a.copy(this.target).applyMatrix4(ROBOT_BASE_INV));
    for (let k = 0; k < 5; k++) out[k] = radToMotor(k, this.rad[k]);
    out[4] = radToMotor(4, this.roll);
    out[5] = this.grip;
    return out;
  }
}

export { REST_MOTOR, ORANGE_H };
