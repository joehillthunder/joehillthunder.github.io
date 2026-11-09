// Demonstrations: Lightwheel's LeIsaac pick-orange teleop dataset (60 episodes, 30 fps, SO-101 joint
// state + leader-arm action in LeRobot units), plus any demos made on this page.
//
// The dataset has joints and camera video but no object poses, so each episode's layout is recovered
// from the demo itself: wherever the gripper closed low over the counter is where an orange was.
// Replaying the recorded joint states through the task then gives the hidden state a policy needs
// (which orange is held, which are on the plate) frame by frame.

import * as THREE from 'three';
import { fkTip, motorToRad, REST_MOTOR } from './robot.js';
import { PickOrangeEnv, ROBOT_BASE, ORANGE_HOME, PLATE_HOME, PLATE_R, DYNAMICS, START_MOTOR, mulberry32, randomLayout } from './task.js';
import { observe, actionLabel, commandLabel, OBS_DIM, ACT_DIM, LOOKAHEAD, Targeter, ScriptedExpert, PolicyController } from './policy.js';

export const DATASET = {
  id: 'LightwheelAI/leisaac-pick-orange',
  url: 'https://huggingface.co/datasets/LightwheelAI/leisaac-pick-orange',
  task: 'Grab orange and place into plate',
  robot: 'so101_follower',
  fps: 30,
  video: (ep, cam) => `https://huggingface.co/datasets/LightwheelAI/leisaac-pick-orange/resolve/main/videos/chunk-000/observation.images.${cam}/episode_${String(ep).padStart(6, '0')}.mp4`,
};

/** assets/pick-orange.bin: 'LWEP', u32 count, u32 lengths[count], then per frame 6 state + 6 action int16 (x100). */
export async function loadDemos(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const dv = new DataView(buf);
  if (String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== 'LWEP') throw new Error('bad demo file');
  const n = dv.getUint32(4, true);
  const lens = [];
  for (let i = 0; i < n; i++) lens.push(dv.getUint32(8 + i * 4, true));
  let off = 8 + n * 4;
  const eps = [];
  for (let i = 0; i < n; i++) {
    const raw = new Int16Array(buf.slice(off, off + lens[i] * 24));
    off += lens[i] * 24;
    const s = new Float32Array(lens[i] * 6), a = new Float32Array(lens[i] * 6);
    for (let t = 0; t < lens[i]; t++) for (let k = 0; k < 6; k++) { s[t * 6 + k] = raw[t * 12 + k] / 100; a[t * 6 + k] = raw[t * 12 + 6 + k] / 100; }
    eps.push({ id: `lightwheel-${i}`, index: i, source: 'lightwheel', n: lens[i], s, a });
  }
  return eps;
}

/** Least-squares fit of s[t+1] - s[t] = k (a[t] - s[t]) per joint, over every demo. */
export function fitDynamics(eps) {
  const num = new Float64Array(6), den = new Float64Array(6);
  for (const e of eps) for (let t = 0; t + 1 < e.n; t++) for (let k = 0; k < 5; k++) {
    const u = e.a[t * 6 + k] - e.s[t * 6 + k], d = e.s[(t + 1) * 6 + k] - e.s[t * 6 + k];
    if (Math.abs(u) < 0.5) continue;
    num[k] += u * d; den[k] += u * u;
  }
  const k = Array.from(num, (v, i) => (den[i] ? Math.min(0.9, Math.max(0.05, v / den[i])) : DYNAMICS.k[i]));
  k[5] = 0.4; // the gripper stalls on the orange, which would bias its fit
  return k;
}

const _p = new THREE.Vector3();
function tipWorld(state, t) {
  const rad = [0, 1, 2, 3, 4].map((i) => motorToRad(i, state[t * 6 + i]));
  return fkTip(rad, _p).applyMatrix4(ROBOT_BASE).clone();
}

/**
 * Grasp and release moments from the gripper channel alone, with the tool point at each. The
 * thresholds are relative because the gripper's calibration differs between demos: a grasp is a
 * close of 4+ units from the recent maximum, a release an opening of 6+ units past the stall point.
 */
export function gripperEvents(e) {
  const ev = [];
  let closed = false, stall = 0;
  for (let t = 6; t < e.n; t++) {
    const g = e.s[t * 6 + 5];
    let recent = g;
    for (let u = Math.max(0, t - 12); u < t; u++) recent = Math.max(recent, e.s[u * 6 + 5]);
    if (!closed && g > 8 && g < 40 && recent - g > 4) { closed = true; stall = g; ev.push({ t, type: 'grasp', p: tipWorld(e.s, t) }); }
    else if (closed) {
      stall = Math.min(stall, g);
      if (g > stall + 6) { closed = false; ev.push({ t, type: 'release', p: tipWorld(e.s, t) }); }
    }
  }
  return ev;
}

/** The orange and plate layout an episode was recorded in, recovered from where it grasped. */
export function recoverLayout(e) {
  const ev = gripperEvents(e);
  const found = [];
  for (const g of ev) {
    // low over the counter, and not a re-grasp at the plate's rim
    if (g.type !== 'grasp' || g.p.z > 0.975 || Math.hypot(g.p.x - PLATE_HOME[0], g.p.y - PLATE_HOME[1]) < PLATE_R + 0.03) continue;
    if (found.every((f) => Math.hypot(f[0] - g.p.x, f[1] - g.p.y) > 0.045)) found.push([g.p.x, g.p.y]);
    if (found.length === 3) break;
  }
  const oranges = found.slice();
  for (const h of ORANGE_HOME) {
    if (oranges.length === 3) break;
    if (oranges.every((f) => Math.hypot(f[0] - h[0], f[1] - h[1]) > 0.06)) oranges.push(h.slice());
  }
  while (oranges.length < 3) oranges.push(ORANGE_HOME[oranges.length].slice());
  const drops = ev.filter((r) => r.type === 'release' && r.p.x > 2.3 && r.p.z < 1.08);
  let plate = PLATE_HOME.slice();
  if (drops.length) {
    const mx = drops.reduce((s, r) => s + r.p.x, 0) / drops.length, my = drops.reduce((s, r) => s + r.p.y, 0) / drops.length;
    if (Math.hypot(mx - PLATE_HOME[0], my - PLATE_HOME[1]) < 0.05) plate = [mx, my];
  }
  return { oranges, plate, recovered: found.length };
}

/**
 * Replays a demo's recorded joint states through the task and returns, per frame, what the policy
 * would have observed (with hindsight: the target orange is the one the demonstrator grasped next).
 */
export function replayLabels(e, layout = e.layout || recoverLayout(e)) {
  const env = new PickOrangeEnv().reset(layout, e.s.subarray(0, 6));
  const held = new Int8Array(e.n), placed = new Uint8Array(e.n), frames = [];
  for (let t = 0; t < e.n; t++) {
    env.t = t;
    env.setMotor(e.s.subarray(t * 6, t * 6 + 6));
    env.physics(1 / 30);
    held[t] = env.held;
    placed[t] = env.placedCount();
    frames.push(env.oranges.map((o) => [o.p.x, o.p.y, o.p.z]));
  }
  const grasps = env.events.filter((v) => v.type === 'grasp');
  // hindsight target: for every frame before grasp g, the orange grasped at g
  const target = new Int8Array(e.n).fill(-1);
  let gi = 0;
  for (let t = 0; t < e.n; t++) {
    while (gi < grasps.length && grasps[gi].t < t) gi++;
    target[t] = gi < grasps.length ? grasps[gi].orange : -1;
  }
  return { layout, held, placed, target, frames, events: env.events, success: env.success(), placedEnd: env.placedCount() };
}

/**
 * Observation/label matrices for behaviour cloning (labels: see policy.js actionLabel). With
 * `noise` > 0, every frame also gets `copies` jittered twins (DART, Laskey et al. 2017): the arm
 * joints are perturbed by `noise` motor units and the label recomputed from the perturbed pose, so the
 * policy also learns how to steer back onto the demonstration when it drifts.
 */
export function buildDataset(eps, { noise = 0, copies = 1, seed = 1, curate = false } = {}) {
  const reps = noise > 0 ? 1 + copies : 1;
  const masks = eps.map((e) => (curate ? idleMask(e) : null));
  let total = 0, dropped = 0;
  eps.forEach((e, i) => { let n = e.n; if (masks[i]) { const d = masks[i].reduce((s, v) => s + v, 0); n -= d; dropped += d; } total += n * reps; });
  const X = new Float32Array(total * OBS_DIM), Y = new Float32Array(total * ACT_DIM), epOf = new Uint16Array(total);
  const env = new PickOrangeEnv();
  const tg = new Targeter();
  const rnd = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const s = new Float64Array(6);
  let row = 0;
  eps.forEach((e, ei) => {
    const L = e.labels || (e.labels = replayLabels(e));
    for (let t = 0; t < e.n; t++) {
      if (masks[ei] && masks[ei][t]) continue;
      for (let r = 0; r < reps; r++) {
        for (let k = 0; k < 6; k++) s[k] = e.s[t * 6 + k] + (r > 0 && k < 4 ? gauss() * noise : 0);
        env.reset({ oranges: L.frames[t].map((p) => [p[0], p[1]]), plate: L.layout.plate }, s);
        for (let i = 0; i < 3; i++) env.oranges[i].p.z = L.frames[t][i][2];
        env.held = L.held[t];
        if (env.held >= 0) env.oranges[env.held].held = true;
        const goal = tg.goalFor(env, L.held[t] >= 0 ? L.held[t] : L.target[t]);
        observe(env, goal, X.subarray(row * OBS_DIM, row * OBS_DIM + OBS_DIM));
        const y = Y.subarray(row * ACT_DIM, row * ACT_DIM + ACT_DIM);
        if (e.source === 'lightwheel') {
          const f = Math.min(e.n - 1, t + LOOKAHEAD);
          actionLabel(env, e.s.subarray(f * 6, f * 6 + 6), e.a[t * 6 + 5], y);
        } else commandLabel(env, e.a.subarray(t * 6, t * 6 + 6), y); // made in this sim: the command is exact
        epOf[row] = ei;
        row++;
      }
    }
  });
  return { X, Y, epOf, rows: total, dim: OBS_DIM, outDim: ACT_DIM, noise, dropped };
}

/**
 * One DAgger round (Ross et al. 2011): run the current policy (handing control to the expert with
 * probability `beta` each step), and at every state it visits ask the expert what it would have done.
 * Those labels are what plain behaviour cloning never sees: how to recover from the policy's own
 * mistakes. Returns rows to aggregate into the dataset, plus how the rollouts went.
 */
export function daggerRound(model, { episodes = 10, beta = 0.5, seed = 1, spread = 1, maxSteps = 900, onEpisode } = {}) {
  const rnd = mulberry32(seed);
  const env = new PickOrangeEnv();
  const X = [], Y = [];
  const obs = new Float32Array(OBS_DIM), y = new Float32Array(ACT_DIM), pa = new Float64Array(6), ea = new Float64Array(6);
  let success = 0, placed = 0;
  for (let ep = 0; ep < episodes; ep++) {
    const pol = new PolicyController(model), exp = new ScriptedExpert();
    pol.reset(); exp.reset();
    env.reset(randomLayout(rnd, spread), jitterStart(rnd));
    for (let t = 0; t < maxSteps && !exp.done(env); t++) {
      pol.act(env, pa);
      observe(env, pol.goal, obs);
      exp.act(env, ea);
      commandLabel(env, ea, y);
      X.push(...obs); Y.push(...y);
      env.step(rnd() < beta ? ea : pa);
    }
    if (env.success()) success++;
    placed += env.placedCount();
    onEpisode?.(ep + 1, episodes);
  }
  return { X: Float32Array.from(X), Y: Float32Array.from(Y), rows: Y.length / ACT_DIM, success, placed, episodes };
}

/** Appends rows (DAgger's) to a dataset. They are always training rows (never validation). */
export function concatRows(ds, add) {
  const rows = ds.rows + add.rows;
  const X = new Float32Array(rows * OBS_DIM), Y = new Float32Array(rows * ACT_DIM), epOf = new Uint16Array(rows);
  X.set(ds.X); X.set(add.X, ds.rows * OBS_DIM);
  Y.set(ds.Y); Y.set(add.Y, ds.rows * ACT_DIM);
  epOf.set(ds.epOf); epOf.fill(65535, ds.rows);
  return { ...ds, X, Y, epOf, rows };
}

/**
 * Synthetic demonstrations, as Lightwheel's datagen does: run the scripted state machine in randomised
 * layouts and record the joint state and command every step. Only successful runs are kept.
 */
export function generateSynthetic(count, { seed = 1, spread = 1, onEpisode } = {}) {
  const rnd = mulberry32(seed);
  const env = new PickOrangeEnv();
  const out = [];
  const act = new Float64Array(6);
  let tries = 0;
  while (out.length < count && tries < count * 3) {
    tries++;
    const layout = randomLayout(rnd, spread);
    const ctl = new ScriptedExpert();
    ctl.reset();
    env.reset(layout, jitterStart(rnd));
    const s = [], a = [];
    for (let t = 0; t < 1500 && !ctl.done(env); t++) {
      ctl.act(env, act);
      for (let k = 0; k < 6; k++) { s.push(env.motor[k]); a.push(act[k]); }
      env.step(act);
    }
    if (!env.success()) continue;
    const n = s.length / 6;
    const e = { id: `synthetic-${seed}-${out.length}`, index: out.length, source: 'synthetic', n, s: Float32Array.from(s), a: Float32Array.from(a), layout: { ...layout, recovered: 3 } };
    out.push(e);
    onEpisode?.(e, out.length);
  }
  return out;
}

/** A start pose near the demos' mean first frame. */
export function jitterStart(rnd, amp = 6) {
  return START_MOTOR.map((m, k) => (k < 5 ? m + (rnd() * 2 - 1) * amp : m));
}

/** Frames where the arm is idle (tool point moves < 2 mm over the lookahead and the gripper holds still). */
export function idleMask(e) {
  const idle = new Uint8Array(e.n);
  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), r0 = new Float64Array(6), r1 = new Float64Array(6);
  for (let t = 0; t < e.n; t++) {
    const f = Math.min(e.n - 1, t + LOOKAHEAD);
    for (let k = 0; k < 5; k++) { r0[k] = motorToRad(k, e.s[t * 6 + k]); r1[k] = motorToRad(k, e.s[f * 6 + k]); }
    fkTip(r0, p0); fkTip(r1, p1);
    idle[t] = p0.distanceTo(p1) < 0.002 && Math.abs(e.a[t * 6 + 5] - e.a[f * 6 + 5]) < 1 ? 1 : 0;
  }
  return idle;
}

export function datasetStats(eps) {
  const frames = eps.reduce((s, e) => s + e.n, 0);
  const by = {};
  for (const e of eps) by[e.source] = (by[e.source] || 0) + 1;
  return { episodes: eps.length, frames, seconds: frames / 30, by };
}

export { REST_MOTOR };
