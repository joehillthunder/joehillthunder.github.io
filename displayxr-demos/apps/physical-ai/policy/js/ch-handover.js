// Chapter: two-arm handover. Two SO-101 arms face each other on a clean bench. Arm A picks each
// orange and presents it in mid-air at a handover point H between them; arm B comes in from the other
// side, closes, A lets go and backs off, and B carries the orange to a bowl on its side. Three
// oranges, both arms back to rest, then a new jittered layout.
//
// Scripted coordination (a phase machine per arm, like the scripted expert in policy.js), not a
// learned policy: the point is reading the handover in depth. Arm B's base is arm A's mirrored about
// a vertical axis through H, so both reach H the same way.
//
// Everything lives in its own group far from the kitchen (three.js z = -40), with a Z-up USD-frame
// group inside, so positions below are in the same metres as task.js.

import * as THREE from 'three';
import { buildRobot, robotMaterials, fkTip, solveIK, motorToRad, radToMotor, REST_MOTOR } from './robot.js';
import { ROBOT_BASE, COUNTER, ORANGE_H } from './task.js';
import { makeBowl } from './fleet.js';

const OPEN = 45, CLOSE = 0;
const JOINT_STEP = 6;   // motor units per 30 Hz step, like the scripted expert
const GRIP_STEP = 4;
const HOLD_OFF = 0.03;  // B's fingertips sit this far past the orange centre, on its side
const GROUP_Z = -40;
const D2R = Math.PI / 180;

// IK seeds (LeRobot motor units: pan, lift, elbow, wrist flex), with a few pan angles so side reaches converge.
const SEEDS = [];
for (const pan of [0, -35, 35, -70, 70]) for (const s of [[0, 35, -65, 95], [0, 0, 10, 90], [0, -30, 50, 85], [0, -65, 45, 70]]) SEEDS.push([pan, ...s.slice(1)].map((m, i) => motorToRad(i, m)));

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _fk = new THREE.Vector3(), _R = new THREE.Matrix4(), _ax = new THREE.Vector3();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Seeded IK for one arm: world target (and optional world approach axis) -> { rad, err, axisErr }. */
function ik(arm, pW, axisW, weight = 0.3) {
  const t = _v.copy(pW).applyMatrix4(arm.inv);
  const ax = axisW ? _v2.copy(axisW).transformDirection(arm.inv) : null;
  const seed = new Float64Array(6);
  let best = null, be = Infinity;
  for (const s of SEEDS) {
    for (let k = 0; k < 4; k++) seed[k] = s[k];
    seed[4] = 0; seed[5] = 0;
    const e = solveIK(seed, t, { iters: 40, down: ax ? weight : 0.04, axis: ax });
    if (e < be - 1e-4) { be = e; best = Float64Array.from(seed); }
    if (e < 0.002) break;
  }
  // a pose the preferred approach can't reach: give up the orientation, keep the position
  if (be > 0.006) be = solveIK(best, t, { iters: 40, down: 0 });
  fkTip(best, _fk, _R);
  _ax.setFromMatrixColumn(_R, 2);
  const want = ax ? ax.clone() : new THREE.Vector3(0, 0, -1);
  const axisErr = Math.acos(clamp(_ax.dot(want) / (want.length() || 1), -1, 1)) / D2R;
  return { rad: best, err: be, axisErr };
}

function tipWorld(arm, out = new THREE.Vector3(), axisOut = null) {
  for (let i = 0; i < 6; i++) arm.rad[i] = motorToRad(i, arm.motor[i]);
  fkTip(arm.rad, out, _R);
  out.applyMatrix4(arm.base);
  if (axisOut) axisOut.setFromMatrixColumn(_R, 2).transformDirection(arm.base);
  return out;
}

const st = {
  built: false, active: false, playing: true, speed: 1, acc: 0,
  group: null, usd: null, A: null, B: null, oranges: [], bowl: null,
  layout: null, H: new THREE.Vector3(), d: new THREE.Vector3(), axisA: new THREE.Vector3(), axisB: new THREE.Vector3(),
  k: 0, handed: 0, dropped: 0, cycles: 0, pause: 0, residuals: null, tilt: 0, testPause: null, paused: false,
};

// ---- layout ----------------------------------------------------------------------------------------
const A0 = new THREE.Vector3().setFromMatrixPosition(ROBOT_BASE);
const FWD = new THREE.Vector3(0, 1, 0);   // arm A reaches toward +y (the kitchen oranges sit there)

function nominalLayout(H) {
  const B0 = new THREE.Vector3(2 * H.x - A0.x, 2 * H.y - A0.y, A0.z);
  // oranges to arm A's left, bowl to arm B's left (diagonal transfer, each arm stays on its side)
  const oranges = [35, 55, 75].map((deg) => new THREE.Vector3(A0.x - 0.21 * Math.sin(deg * D2R), A0.y + 0.21 * Math.cos(deg * D2R), COUNTER.z));
  const bowl = new THREE.Vector3(B0.x + 0.21 * Math.sin(50 * D2R), B0.y - 0.21 * Math.cos(50 * D2R), COUNTER.z);
  return { B0, oranges, bowl };
}

function jitter(nom, rng = Math.random) {
  const j = (a) => (rng() * 2 - 1) * a;
  return {
    oranges: nom.oranges.map((p) => p.clone().add(new THREE.Vector3(j(0.015), j(0.015), 0))),
    bowl: nom.bowl.clone().add(new THREE.Vector3(j(0.01), j(0.01), 0)),
  };
}

function dropSpot(k) {
  const a = (k * 2 * Math.PI) / 3;
  return new THREE.Vector3(st.layout.bowl.x + Math.cos(a) * 0.028, st.layout.bowl.y + Math.sin(a) * 0.028, COUNTER.z);
}

// ---- build -----------------------------------------------------------------------------------------
function makeArm(name, base, parts, mats) {
  const robot = buildRobot(parts, mats);
  robot.root.matrixAutoUpdate = false;
  robot.root.matrix.copy(base);
  return { name, robot, base, inv: base.clone().invert(), motor: Float64Array.from(REST_MOTOR), rad: new Float64Array(6), q: null, qKey: '', goal: new THREE.Vector3(), axis: null, grip: OPEN, mode: 'rest', phase: 'rest', arrived: false, gripDone: false, lastErr: 0 };
}

function chooseHandover() {
  // pick H (height above the bench, distance ahead of A) and the tilt below horizontal of the
  // approach axis: the flattest tilt whose IK lands within 6 mm, for both arms
  const tmpArm = { inv: ROBOT_BASE.clone().invert() };
  for (const h of [0.15, 0.13, 0.17, 0.11]) for (const dist of [0.25, 0.23, 0.27]) for (const tilt of [0, 0.3, 0.55, 0.8, 1.05]) {
    const H = new THREE.Vector3(A0.x, A0.y + dist, COUNTER.z + h);
    const axis = new THREE.Vector3(0, Math.cos(tilt), -Math.sin(tilt));
    const r = ik(tmpArm, H, axis);
    if (r.err < 0.006 && r.axisErr < 12) return { H, tilt };
  }
  return { H: new THREE.Vector3(A0.x, A0.y + 0.25, COUNTER.z + 0.15), tilt: 0.8 };
}

function build(ctx) {
  const { world } = ctx;
  const choice = chooseHandover();
  st.H.copy(choice.H);
  st.tilt = choice.tilt;
  st.d.copy(FWD);
  // approach axes: A toward B, B toward A, both tilted down by the same angle
  st.axisA.set(0, Math.cos(st.tilt), -Math.sin(st.tilt));
  st.axisB.set(0, -Math.cos(st.tilt), -Math.sin(st.tilt));
  const H = st.H;
  // B = T(H) Rz(pi) T(-H) A, about a vertical axis through H
  const mirror = new THREE.Matrix4().makeTranslation(H.x, H.y, 0).multiply(new THREE.Matrix4().makeRotationZ(Math.PI)).multiply(new THREE.Matrix4().makeTranslation(-H.x, -H.y, 0));
  const B_BASE = mirror.multiply(ROBOT_BASE.clone());
  st.nominal = nominalLayout(H);

  const group = new THREE.Group();
  group.position.set(0, 0, GROUP_Z);
  group.visible = false;
  const usd = new THREE.Group();
  usd.rotation.x = -Math.PI / 2;
  group.add(usd);
  // bench (Leia palette), centred between the arms
  const cx = A0.x - 0.02, cy = (A0.y + st.nominal.B0.y) / 2;
  const bench = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.86, 0.04), new THREE.MeshStandardMaterial({ color: 0x3a3180, roughness: 0.75 }));
  bench.position.set(cx, cy, COUNTER.z - 0.02);
  bench.receiveShadow = true;
  usd.add(bench);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.79, 0.87, 0.006), new THREE.MeshStandardMaterial({ color: 0x847fea, roughness: 0.6 }));
  edge.position.set(cx, cy, COUNTER.z - 0.043);
  usd.add(edge);
  // handover marker: a faint ring on the bench under H
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.034, 40), new THREE.MeshBasicMaterial({ color: 0xc4bffd, transparent: true, opacity: 0.6 }));
  ring.position.set(H.x, H.y, COUNTER.z + 0.001);
  usd.add(ring);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1.4, 64), new THREE.MeshStandardMaterial({ color: 0x0d0a1f, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0.05, -cy);
  group.add(floor);

  const mats = robotMaterials();
  st.A = makeArm('A', ROBOT_BASE.clone(), world.parts, mats);
  st.B = makeArm('B', B_BASE, world.parts, mats);
  usd.add(st.A.robot.root, st.B.robot.root);
  st.oranges = ['lightwheel_orange001', 'lightwheel_orange002', 'lightwheel_orange003'].map((n) => {
    const node = world.objects[n].clone();
    usd.add(node);
    return { node, p: new THREE.Vector3(), holder: 'bench', vz: 0 };
  });
  st.bowl = makeBowl();
  usd.add(st.bowl);
  world.scene.add(group);
  st.group = group; st.usd = usd;

  // reachability report (metres / degrees): printed by the test page
  const R = {};
  const rep = (name, arm, p, axis) => { const r = ik(arm, p, axis); R[name] = { mm: +(r.err * 1000).toFixed(1), axisDeg: +r.axisErr.toFixed(1) }; };
  st.nominal.oranges.forEach((o, i) => { const c = o.clone().setZ(o.z + ORANGE_H / 2); rep(`A orange${i + 1}`, st.A, c, null); rep(`A above orange${i + 1}`, st.A, c.clone().setZ(c.z + 0.1), null); });
  rep('A at H', st.A, H, st.axisA);
  rep('B at H+off', st.B, H.clone().addScaledVector(st.axisB, -HOLD_OFF), st.axisB);
  rep('B approach', st.B, H.clone().addScaledVector(st.axisB, -0.08), st.axisB);
  rep('B above bowl', st.B, st.nominal.bowl.clone().setZ(COUNTER.z + 0.13), null);
  rep('B drop', st.B, st.nominal.bowl.clone().setZ(COUNTER.z + 0.07), null);
  st.residuals = { H: H.toArray().map((v) => +v.toFixed(3)), tiltDeg: +(st.tilt / D2R).toFixed(1), ...R };
  console.log('[handover] IK residuals', JSON.stringify(st.residuals));
  newCycle();
  st.built = true;
}

function newCycle() {
  if (st.layout) st.lastCycle = st.oranges.map((o) => ({ holder: o.holder, cmFromBowl: +(Math.hypot(o.p.x - st.layout.bowl.x, o.p.y - st.layout.bowl.y) * 100).toFixed(1) }));
  st.layout = jitter(st.nominal);
  st.oranges.forEach((o, i) => { o.p.copy(st.layout.oranges[i]); o.holder = 'bench'; o.vz = 0; });
  st.bowl.position.copy(st.layout.bowl);
  st.k = 0; st.handed = 0; st.dropped = 0; st.pause = 0;
  for (const arm of [st.A, st.B]) { arm.motor.set(REST_MOTOR); arm.q = null; arm.qKey = ''; arm.grip = OPEN; arm.motor[5] = OPEN; }
  setPhase(st.A, 'reach');
  setPhase(st.B, 'wait');
}

// ---- control ---------------------------------------------------------------------------------------
const gripAt = (arm, v) => Math.abs(arm.motor[5] - v) < 1; // judged against the wanted value, not last step’s target
const orangeCentre = (o, out = new THREE.Vector3()) => out.copy(o.p).setZ(o.p.z + ORANGE_H / 2);

function setPhase(arm, phase) { arm.phase = phase; arm.arrived = false; }

function target(arm, p, axis, grip) {
  arm.mode = 'move';
  arm.goal.copy(p);
  arm.axis = axis;
  if (grip != null) arm.grip = grip;
}

function drive(arm) {
  if (arm.mode === 'rest') {
    let m = 0;
    for (let k = 0; k < 5; k++) { const e = REST_MOTOR[k] - arm.motor[k]; arm.motor[k] += clamp(e, -2.5, 2.5); m = Math.max(m, Math.abs(e)); }
    arm.motor[5] += clamp(arm.grip - arm.motor[5], -GRIP_STEP, GRIP_STEP);
    arm.arrived = m < 1.5;
    arm.gripDone = Math.abs(arm.grip - arm.motor[5]) < 1;
    return;
  }
  const key = arm.goal.toArray().map((v) => v.toFixed(3)).join(',') + (arm.axis ? arm.axis.toArray().map((v) => v.toFixed(2)).join(',') : 'down');
  if (key !== arm.qKey) {
    const r = ik(arm, arm.goal, arm.axis);
    arm.q = Array.from(r.rad, (v, k) => radToMotor(k, v));
    arm.qKey = key;
    arm.lastErr = r.err;
  }
  let m = 0;
  for (let k = 0; k < 4; k++) { const e = arm.q[k] - arm.motor[k]; arm.motor[k] += clamp(e, -JOINT_STEP, JOINT_STEP); m = Math.max(m, Math.abs(e)); }
  arm.motor[4] += clamp(0 - arm.motor[4], -JOINT_STEP, JOINT_STEP);
  arm.motor[5] += clamp(arm.grip - arm.motor[5], -GRIP_STEP, GRIP_STEP);
  arm.arrived = m < 0.8;
  arm.gripDone = Math.abs(arm.grip - arm.motor[5]) < 1;
}

const _c = new THREE.Vector3(), _t = new THREE.Vector3(), _a = new THREE.Vector3();
function stepA() {
  const A = st.A, o = st.oranges[st.k], H = st.H;
  switch (A.phase) {
    case 'reach': target(A, orangeCentre(o, _c).setZ(_c.z + 0.1), null, OPEN); if (A.arrived) setPhase(A, 'lower'); break;
    case 'lower': target(A, orangeCentre(o, _c), null, OPEN); if (A.arrived) setPhase(A, 'grasp'); break;
    case 'grasp': A.grip = CLOSE; if (gripAt(A, CLOSE)) { o.holder = 'A'; setPhase(A, 'lift'); } break;
    case 'lift': target(A, orangeCentre(o, _c).setZ(COUNTER.z + 0.17), null); if (A.arrived) setPhase(A, 'present'); break;
    case 'present': target(A, H, st.axisA); if (A.arrived) setPhase(A, 'hold'); break;
    case 'hold': if (o.holder === 'B') setPhase(A, 'release'); break;
    case 'release': A.grip = OPEN; if (gripAt(A, OPEN)) setPhase(A, 'retreat'); break;
    case 'retreat': target(A, _t.copy(H).addScaledVector(st.d, -0.09).setZ(H.z + 0.05), st.axisA, OPEN); if (A.arrived) { if (st.k < 2) { st.k++; setPhase(A, 'reach'); } else { A.mode = 'rest'; setPhase(A, 'home'); } } break;
    case 'home': A.mode = 'rest'; if (A.arrived) setPhase(A, 'done'); break;
    default: break;
  }
}

function stepB() {
  const B = st.B, A = st.A, H = st.H, o = st.oranges[st.k];
  switch (B.phase) {
    case 'wait': B.mode = 'rest'; B.grip = OPEN; if (A.phase === 'present' || A.phase === 'hold') setPhase(B, 'approach'); break;
    case 'approach': target(B, _t.copy(H).addScaledVector(st.axisB, -0.08), st.axisB, OPEN); if (B.arrived && A.phase === 'hold') setPhase(B, 'close in'); break;
    case 'close in': target(B, _t.copy(H).addScaledVector(st.axisB, -HOLD_OFF), st.axisB, OPEN); if (B.arrived) setPhase(B, 'grasp'); break;
    case 'grasp': B.grip = CLOSE; if (gripAt(B, CLOSE)) { o.holder = 'B'; st.handed++; B.carrying = o; setPhase(B, 'take'); } break;
    case 'take': if (A.phase === 'retreat' || A.phase === 'reach' || A.phase === 'home' || A.phase === 'done') setPhase(B, 'withdraw'); break;
    case 'withdraw': target(B, _t.copy(H).addScaledVector(st.d, 0.1).setZ(H.z + 0.04), st.axisB, CLOSE); if (B.arrived) setPhase(B, 'carry'); break;
    case 'carry': target(B, _t.copy(dropSpot(st.dropped)).setZ(COUNTER.z + 0.14), null, CLOSE); if (B.arrived) setPhase(B, 'lower'); break;
    case 'lower': target(B, _t.copy(dropSpot(st.dropped)).setZ(COUNTER.z + 0.085), null, CLOSE); if (B.arrived) setPhase(B, 'drop'); break;
    case 'drop':
      B.grip = OPEN;
      if (B.carrying && B.motor[5] > 20) { B.carrying.holder = 'falling'; B.carrying.vz = 0; B.carrying = null; st.dropped++; }
      if (gripAt(B, OPEN)) setPhase(B, 'back');
      break;
    case 'back': target(B, _t.copy(dropSpot(0)).setZ(COUNTER.z + 0.16), null, OPEN); if (B.arrived) { if (st.dropped >= 3) { B.mode = 'rest'; setPhase(B, 'home'); } else setPhase(B, 'wait'); } break;
    case 'home': B.mode = 'rest'; if (B.arrived) setPhase(B, 'done'); break;
    default: break;
  }
}

function stepOranges(dt) {
  for (const o of st.oranges) {
    if (o.holder === 'A') { tipWorld(st.A, _c); o.p.copy(_c).setZ(_c.z - ORANGE_H / 2); }
    else if (o.holder === 'B') {
      // B holds it just past its fingertips along its approach axis, so the hand-over doesn't jump
      tipWorld(st.B, _c, _a); o.p.copy(_c).addScaledVector(_a, HOLD_OFF).setZ(o.p.z - ORANGE_H / 2);
    } else if (o.holder === 'falling') {
      const floor = COUNTER.z + 0.004;
      o.vz -= 9.81 * dt;
      o.p.z += o.vz * dt;
      if (o.p.z <= floor) { o.p.z = floor; o.holder = 'bowl'; }
    }
  }
}

function simStep() {
  const dt = 1 / 30;
  stepA(); stepB();
  drive(st.A); drive(st.B);
  stepOranges(dt);
  if (st.A.phase === 'done' && st.B.phase === 'done') {
    st.pause += dt;
    if (st.pause > 1.5) { st.cycles++; newCycle(); }
  }
  // test hook: stop the moment B has closed on an orange A still holds (both gripping, mid-air)
  if (st.testPause === 'bowl' && st.oranges.every((o) => o.holder === 'bowl')) { st.playing = false; st.paused = true; }
  if (st.testPause === 'handover' && st.B.phase === 'grasp' && st.B.motor[5] < 8 && st.A.phase === 'hold') { st.playing = false; st.paused = true; }
}

function draw(ctx) {
  for (const arm of [st.A, st.B]) arm.robot.setMotor(arm.motor);
  for (const o of st.oranges) o.node.position.copy(o.p);
}

const LABEL = {
  reach: 'reach for orange', lower: 'lower to orange', grasp: 'grasp', lift: 'lift', present: 'present at handover', hold: 'hold for B',
  release: 'let go', retreat: 'back off', home: 'return to rest', done: 'at rest', wait: 'wait', approach: 'approach', 'close in': 'close in',
  take: 'take it', withdraw: 'withdraw', carry: 'carry to bowl', drop: 'drop', back: 'clear the bowl',
};

let lastUi = 0;
function ui(ctx, force = false) {
  const now = performance.now();
  if (!force && now - lastUi < 150) return;
  lastUi = now;
  const $ = ctx.$;
  $('ho-a').textContent = LABEL[st.A.phase] || st.A.phase;
  $('ho-b').textContent = LABEL[st.B.phase] || st.B.phase;
  $('ho-handed').textContent = `${st.handed}/3`;
  $('ho-bowl').textContent = `${st.oranges.filter((o) => o.holder === 'bowl').length}/3`;
  $('ho-cycles').textContent = String(st.cycles);
  $('ho-play').textContent = st.playing ? 'Pause' : 'Play';
  ctx.hud('Handover', `A: ${LABEL[st.A.phase] || st.A.phase} · B: ${LABEL[st.B.phase] || st.B.phase}`, `in the bowl <b>${st.oranges.filter((o) => o.holder === 'bowl').length}/3</b>`, `${st.speed}×`);
  window.__ho = { A: st.A.phase, B: st.B.phase, k: st.k, handed: st.handed, dropped: st.dropped, cycles: st.cycles, paused: st.paused, residuals: st.residuals, lastCycle: st.lastCycle, holders: st.oranges.map((o) => o.holder) };
}

function frame(ctx) {
  // side view of both arms, looking across the handover line
  const mid = new THREE.Vector3(st.H.x - 0.02, COUNTER.z + 0.08, -st.H.y + GROUP_Z);
  ctx.stage.flyTo({ target: mid, dist: 1.2, yaw: 0.62, pitch: 0.5, radius: 0.36 });
}

export default {
  id: 'handover',
  label: 'Handover',
  html: `
    <style>
      .ho-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 13px; margin: 0; }
      .ho-grid dt { color: var(--muted); }
      .ho-grid dd { margin: 0; font-variant-numeric: tabular-nums; }
      .ho-arm { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--leia); color: #fff; font-size: 11px; margin-right: 4px; }
    </style>
    <h2>Two arms, one handover</h2>
    <p class="lede">Arm A picks each orange and holds it out in mid-air. Arm B comes in from the other side, closes, A lets go, and
      B carries it to the bowl. In 3D you can see both grippers meet on the same orange.</p>
    <div class="row">
      <button id="ho-play" type="button" class="primary">Pause</button>
      <label class="inline">Speed <select id="ho-speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label>
      <button id="ho-reset" type="button">New layout</button>
    </div>
    <div class="card">
      <dl class="ho-grid">
        <dt><span class="ho-arm">A</span>Arm A</dt><dd id="ho-a">–</dd>
        <dt><span class="ho-arm">B</span>Arm B</dt><dd id="ho-b">–</dd>
        <dt>Handed over</dt><dd id="ho-handed">0/3</dd>
        <dt>In the bowl</dt><dd id="ho-bowl">0/3</dd>
        <dt>Cycles done</dt><dd id="ho-cycles">0</dd>
      </dl>
    </div>
    <details class="small"><summary>How this is driven</summary>
      <p>Scripted coordination in this sim: each arm runs a fixed sequence of goals (reach, grasp, present, take, carry, drop),
        solved with inverse kinematics and stepped at 30 Hz. B waits for A to present, and A lets go only once B has closed.
        It isn't a learned policy. It shows what a two-arm task looks like on a 3D display: the handover point, the approach
        angles and the clearance between the grippers.</p>
      <p>Arm B is a mirror image of arm A about the handover point, so both arms reach it with the same posture.</p>
    </details>`,
  init(ctx) {
    const $ = ctx.$;
    const q = new URLSearchParams(location.search);
    if (q.get('hospeed')) st.speed = +q.get('hospeed');
    if (q.get('hopause')) st.testPause = q.get('hopause');
    $('ho-play').addEventListener('click', () => { st.playing = !st.playing; st.paused = false; ui(ctx, true); });
    $('ho-speed').addEventListener('change', (e) => { st.speed = +e.target.value; ui(ctx, true); });
    $('ho-reset').addEventListener('click', () => { if (st.built) { newCycle(); ui(ctx, true); } });
    if (q.get('hospeed')) { const sel = $('ho-speed'); if (![...sel.options].some((o) => o.value === String(st.speed))) sel.add(new Option(`${st.speed}× (test)`, String(st.speed))); sel.value = String(st.speed); }
  },
  enter(ctx) {
    if (!st.built) build(ctx);
    st.active = true;
    ctx.showKitchen(false);
    st.group.visible = true;
    ctx.stage.idleSway = false;
    frame(ctx);
    draw(ctx);
    ui(ctx, true);
  },
  leave(ctx) {
    st.active = false;
    if (st.group) st.group.visible = false;
    ctx.showKitchen(true);
  },
  tick(dt, ctx) {
    if (!st.active) return false;
    if (st.playing) {
      st.acc += dt * 30 * st.speed;
      let n = Math.min(60, Math.floor(st.acc));
      st.acc -= n;
      while (n-- > 0 && st.playing) simStep();
    }
    draw(ctx);
    ui(ctx);
    return true;
  },
  keydown(e, ctx) {
    if (e.code === 'Space') { e.preventDefault(); st.playing = !st.playing; st.paused = false; ui(ctx, true); return true; }
    return false;
  },
};
