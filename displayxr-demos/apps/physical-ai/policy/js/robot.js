// SO-101 follower arm: kinematics, LeRobot <-> joint-angle units, and the articulated three.js model.
//
// Geometry is Lightwheel's: the 13 part meshes of leisaac_env/assets/robots/so101_follower.usd,
// simplified into assets/so101.glb. The kinematic chain is TheRobotStudio's so101_new_calib.urdf,
// the model that USD was built from. Everything here is in the robot's own Z-up base frame (metres);
// placing the robot in the world is the caller's job.

import * as THREE from 'three';

export const JOINTS = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'];

// leisaac/assets/robots/lerobot.py: joint limits written in the USD (degrees) and the LeRobot motor
// ranges they map to. Dataset values are motor units; the kinematics run in radians.
const USD_LIMITS = [[-110, 110], [-100, 100], [-100, 90], [-95, 95], [-160, 160], [-10, 100]];
const MOTOR_LIMITS = [[-100, 100], [-100, 100], [-100, 100], [-100, 100], [-100, 100], [0, 100]];
const D2R = Math.PI / 180;

export function motorToRad(i, m) {
  const [jl, jh] = USD_LIMITS[i], [ml, mh] = MOTOR_LIMITS[i];
  return ((m - ml) / (mh - ml) * (jh - jl) + jl) * D2R;
}
export function radToMotor(i, r) {
  const [jl, jh] = USD_LIMITS[i], [ml, mh] = MOTOR_LIMITS[i];
  return (r / D2R - jl) / (jh - jl) * (mh - ml) + ml;
}
export function clampMotor(i, m) {
  const [ml, mh] = MOTOR_LIMITS[i];
  return Math.min(mh, Math.max(ml, m));
}

// leisaac's SO-101 rest pose (degrees), the pose task_done() wants the arm back in.
const REST_DEG = [0, -100, 90, 50, 0, -10];
export const REST_MOTOR = REST_DEG.map((d, i) => radToMotor(i, d * D2R));

// URDF joints, parent -> child, each revolute about its local +Z.
const CHAIN = [
  { joint: 'shoulder_pan', child: 'shoulder', xyz: [0.0388353, -8.97657e-09, 0.0624], rpy: [3.14159, 4.18253e-17, -3.14159] },
  { joint: 'shoulder_lift', child: 'upper_arm', xyz: [-0.0303992, -0.0182778, -0.0542], rpy: [-1.5708, -1.5708, 0] },
  { joint: 'elbow_flex', child: 'lower_arm', xyz: [-0.11257, -0.028, 1.73763e-16], rpy: [-3.63608e-16, 8.74301e-16, 1.5708] },
  { joint: 'wrist_flex', child: 'wrist', xyz: [-0.1349, 0.0052, 3.62355e-17], rpy: [4.02456e-15, 8.67362e-16, -1.5708] },
  { joint: 'wrist_roll', child: 'gripper', xyz: [5.55112e-17, -0.0611, 0.0181], rpy: [1.5708, 0.0486795, 3.14159] },
];
const JAW = { xyz: [0.0202, 0.0188, -0.0234], rpy: [1.5708, -5.24284e-08, -1.41553e-15] };
// gripper_frame_link: the tool point between the fingertips (the end effector Lightwheel's IK drives).
const TIP = { xyz: [-0.0079, -0.000218121, -0.0981274], rpy: [0, 3.14159, 0] };

// Visual meshes per link: [part, xyz, rpy, material]
const P = 'printed', M = 'motor';
const VISUALS = {
  base: [
    ['base_motor_holder_so101_v1', [-0.00636471, -9.94414e-05, -0.0024], [1.5708, -1.67685e-15, 1.5708], P],
    ['base_so101_v2', [-0.00636471, -8.97657e-09, -0.0024], [1.5708, -2.78073e-29, 1.5708], P],
    ['sts3215_03a_v1', [0.0263353, -8.97657e-09, 0.0437], [0, 0, 0], M],
    ['waveshare_mounting_plate_so101_v2', [-0.0309827, -0.000199441, 0.0474], [1.5708, -1.35493e-14, 1.5708], P],
  ],
  shoulder: [
    ['sts3215_03a_v1', [-0.0303992, 0.000422241, -0.0417], [1.5708, 1.5708, 0], M],
    ['motor_holder_so101_base_v1', [-0.0675992, -0.000177759, 0.0158499], [1.5708, -1.5708, 0], P],
    ['rotation_pitch_so101_v1', [0.0122008, 2.22413e-05, 0.0464], [-1.5708, 0, 0], P],
  ],
  upper_arm: [
    ['sts3215_03a_v1', [-0.11257, -0.0155, 0.0187], [-3.14159, -5.27356e-16, -1.5708], M],
    ['upper_arm_so101_v1', [-0.065085, 0.012, 0.0182], [3.14159, 0, 0], P],
  ],
  lower_arm: [
    ['under_arm_so101_v1', [-0.0648499, -0.032, 0.0182], [3.14159, 0, 0], P],
    ['motor_holder_so101_wrist_v1', [-0.0648499, -0.032, 0.018], [-3.14159, -2.55351e-15, 0], P],
    ['sts3215_03a_v1', [-0.1224, 0.0052, 0.0187], [-3.14159, 0, -3.14159], M],
  ],
  wrist: [
    ['sts3215_03a_no_horn_v1', [8.32667e-17, -0.0424, 0.0306], [1.5708, 1.5708, 0], M],
    ['wrist_roll_pitch_so101_v2', [0, -0.028, 0.0181], [-1.5708, -1.5708, 0], P],
  ],
  gripper: [
    ['sts3215_03a_v1', [0.0077, 0.0001, -0.0234], [-1.5708, -5.19179e-17, -1.66533e-16], M],
    ['wrist_roll_follower_so101_v1', [8.32667e-17, -0.000218214, 0.000949706], [-3.14159, -5.55112e-17, 0], P],
  ],
  jaw: [
    ['moving_jaw_so101_v1', [-5.55112e-17, -5.55112e-17, 0.0189], [0, 0, 0], P],
  ],
};

// URDF origin: translate, then fixed-axis roll-pitch-yaw (R = Rz(yaw) Ry(pitch) Rx(roll)).
function originMatrix(xyz, rpy, out = new THREE.Matrix4()) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX'));
  return out.compose(new THREE.Vector3(...xyz), q, new THREE.Vector3(1, 1, 1));
}
const ORIGINS = CHAIN.map((c) => originMatrix(c.xyz, c.rpy));
const JAW_M = originMatrix(JAW.xyz, JAW.rpy);
const TIP_M = originMatrix(TIP.xyz, TIP.rpy);

const _m = new THREE.Matrix4(), _rz = new THREE.Matrix4();
/**
 * Forward kinematics without a scene graph (training, evaluation and IK use it). `rad` holds at
 * least the 5 arm joint angles. Returns the tool point in the base frame; fills `outRot` with the
 * tool frame when given.
 */
export function fkTip(rad, out = new THREE.Vector3(), outRot = null) {
  _m.identity();
  for (let i = 0; i < 5; i++) _m.multiply(ORIGINS[i]).multiply(_rz.makeRotationZ(rad[i]));
  _m.multiply(TIP_M);
  if (outRot) outRot.copy(_m);
  return out.setFromMatrixPosition(_m);
}

/**
 * Damped-least-squares IK for the tool point, base frame. Moves the first `joints` joints (wrist_roll
 * stays put, as with Lightwheel's position-only targets) toward `target`, with a soft pull of the
 * tool's approach axis toward straight down so grasps come from above. Updates `rad` in place and
 * returns the remaining position error in metres.
 */
const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _R = new THREE.Matrix4(), _ax = new THREE.Vector3(), _ax2 = new THREE.Vector3();
const LIM = USD_LIMITS.map(([a, b]) => [a * D2R, b * D2R]);
export function solveIK(rad, target, { iters = 10, down = 0.04, maxStep = 0.25, joints = 4, axis = null } = {}) {
  const axx = axis ? axis.x : 0, axy = axis ? axis.y : 0, axz = axis ? axis.z : -1;
  const eps = 1e-4, lambda = 0.015, n = joints;
  const J = [[], [], [], []], e = new Float64Array(6);
  for (let it = 0; it < iters; it++) {
    fkTip(rad, _p, _R);
    _ax.setFromMatrixColumn(_R, 2);
    e[0] = target.x - _p.x; e[1] = target.y - _p.y; e[2] = target.z - _p.z;
    e[3] = (axx - _ax.x) * down; e[4] = (axy - _ax.y) * down; e[5] = (axz - _ax.z) * down;
    for (let j = 0; j < n; j++) {
      const r0 = rad[j]; rad[j] = r0 + eps;
      fkTip(rad, _q, _R); _ax2.setFromMatrixColumn(_R, 2);
      rad[j] = r0;
      const c = J[j];
      c[0] = (_q.x - _p.x) / eps; c[1] = (_q.y - _p.y) / eps; c[2] = (_q.z - _p.z) / eps;
      c[3] = (_ax2.x - _ax.x) / eps * down; c[4] = (_ax2.y - _ax.y) / eps * down; c[5] = (_ax2.z - _ax.z) / eps * down;
    }
    // dq = (J^T J + l^2 I)^-1 J^T e
    const A = [], b = [];
    for (let r = 0; r < n; r++) {
      const row = []; let s = 0;
      for (let c = 0; c < n; c++) { let v = 0; for (let k = 0; k < 6; k++) v += J[r][k] * J[c][k]; row.push(v + (r === c ? lambda * lambda : 0)); }
      for (let k = 0; k < 6; k++) s += J[r][k] * e[k];
      A.push(row); b.push(s);
    }
    const dq = solveSmall(A, b);
    for (let j = 0; j < n; j++) {
      const d = Math.max(-maxStep, Math.min(maxStep, dq[j]));
      rad[j] = Math.min(LIM[j][1], Math.max(LIM[j][0], rad[j] + d));
    }
  }
  return fkTip(rad, _p).distanceTo(target);
}

// Seed postures (LeRobot units: pan, lift, elbow, wrist flex): reaching out over the counter, and
// folded in for points close to the base.
const SEEDS = [[0, 35, -65, 95], [0, 0, 10, 90], [0, -30, 50, 85], [0, -65, 45, 70]].map((s) => s.map((m, i) => motorToRad(i, m)));
const _seed = new Float64Array(6), _best = new Float64Array(6);
/**
 * IK from fixed seed postures (keeping the best fit), so the answer depends on the target alone, not
 * on where the arm happens to be. Writes the four joint angles into `rad` (wrist roll is left as
 * given) and returns the position error.
 */
export function solveIKSeeded(rad, target, { iters = 30 } = {}) {
  let bestErr = Infinity;
  for (const s of SEEDS) {
    for (let k = 0; k < 4; k++) _seed[k] = s[k];
    _seed[4] = rad[4]; _seed[5] = rad[5];
    const err = solveIK(_seed, target, { iters });
    if (err < bestErr - 0.002) { bestErr = err; _best.set(_seed); }
    if (err < 0.003) break;
  }
  // a vertical tool can't get there (close to the base): drop the orientation preference
  if (bestErr > 0.004) bestErr = solveIK(_best, target, { iters: 40, down: 0 });
  for (let k = 0; k < 4; k++) rad[k] = _best[k];
  return bestErr;
}

const _axis = new THREE.Vector3();
/**
 * IK with the redundancy removed: the tool's approach axis is a smooth function of where the target
 * is (straight down when reaching out, tilting outward up to 45 degrees close to the base, where a
 * vertical tool can't reach), weighted like the position. So each tool point has one posture and the
 * arm doesn't drift along the redundant wrist direction from step to step. Warm-starts from `rad`,
 * writes the four joint angles into it (wrist roll is left as given) and returns the error.
 */
export function solveIKPose(rad, target, { iters = 12 } = {}) {
  const r = Math.hypot(target.x, target.y) || 1e-6;
  const tilt = Math.min(1, Math.max(0, (0.30 - r) / 0.12 + Math.max(0, target.z - 0.08) * 2)) * Math.PI / 4;
  _axis.set((target.x / r) * Math.sin(tilt), (target.y / r) * Math.sin(tilt), -Math.cos(tilt));
  return solveIK(rad, target, { iters, down: 0.25, axis: _axis });
}

function solveSmall(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / d; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}

export function robotMaterials() {
  return {
    printed: new THREE.MeshStandardMaterial({ color: 0xf0ebe1, roughness: 0.55, metalness: 0 }),
    motor: new THREE.MeshStandardMaterial({ color: 0x1c1e23, roughness: 0.4, metalness: 0.25 }),
  };
}

/**
 * The articulated model. `parts` maps part name -> BufferGeometry. Returns `root` (a Group in the
 * robot's Z-up base frame), `setMotor(values)` in LeRobot units, `setRad(rad)`, `tip` (an Object3D
 * at the tool point) and the materials (shared, so a caller can tint them).
 */
export function buildRobot(parts, mats = robotMaterials()) {
  const root = new THREE.Group();
  root.name = 'lightwheel_so101_follower';
  const links = {};
  const addVisuals = (link, name) => {
    for (const [part, xyz, rpy, mat] of VISUALS[name]) {
      const mesh = new THREE.Mesh(parts[part], mats[mat]);
      mesh.name = part;
      mesh.castShadow = true;
      originMatrix(xyz, rpy, mesh.matrix);
      mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
      link.add(mesh);
    }
  };
  links.base = new THREE.Group();
  root.add(links.base);
  addVisuals(links.base, 'base');
  const joints = [];
  let parent = links.base;
  for (let i = 0; i < CHAIN.length; i++) {
    const origin = new THREE.Group();
    origin.applyMatrix4(ORIGINS[i]);
    const joint = new THREE.Group();
    origin.add(joint);
    parent.add(origin);
    addVisuals(joint, CHAIN[i].child);
    links[CHAIN[i].child] = joint;
    joints.push(joint);
    parent = joint;
  }
  const jawOrigin = new THREE.Group();
  jawOrigin.applyMatrix4(JAW_M);
  links.gripper.add(jawOrigin);
  const jaw = new THREE.Group();
  jawOrigin.add(jaw);
  addVisuals(jaw, 'jaw');
  joints.push(jaw);
  const tip = new THREE.Object3D();
  tip.applyMatrix4(TIP_M);
  links.gripper.add(tip);
  const rad = new Float64Array(6);
  function setRad(r) { for (let i = 0; i < 6; i++) { rad[i] = r[i]; joints[i].rotation.z = r[i]; } }
  function setMotor(m) { for (let i = 0; i < 6; i++) { rad[i] = motorToRad(i, m[i]); joints[i].rotation.z = rad[i]; } }
  return { root, links, joints, tip, rad, setRad, setMotor, materials: mats };
}
