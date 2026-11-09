// Chapter "Rollouts": rollout review. Twelve runs of the pretrained prompted policy from ONE layout,
// differing only in the arm's start pose. Each run's tool path is a tube in the kitchen, coloured by
// outcome, so the place where failures split off from the good runs reads in depth. A scrubber
// replays the selected run on the kitchen arm; a bead marks time t on every path.

import * as THREE from 'three';
import { PickOrangeEnv } from './task.js';

const N = 12;
const MAX_STEPS = 1400;
const SEED_LAYOUT = 777;
const ORDERS = [
  { order: [0, 1, 2], label: '1 → 2 → 3' },
  { order: [2, 1, 0], label: '3 → 2 → 1' },
  { order: [1, 2, 0], label: '2 → 3 → 1' },
  { order: [2, 0, 1], label: '3 → 1 → 2' },
];
const COLORS = { ok: 0x4ade80, part: 0xf5b83d, bad: 0xf87171 };

const html = `
<style>
  .ro-list { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin: 8px 0; }
  .ro-list button { font-size: 12px; padding: 5px 6px; text-align: left; display: flex; align-items: center; gap: 6px; }
  .ro-list button i { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .ro-list button.on { border-color: var(--s1); background: #241d58; }
  .ro-scrub { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
  .ro-scrub input { flex: 1; min-width: 0; }
  .ro-leg { display: flex; gap: 12px; font-size: 11px; color: var(--muted); }
  .ro-leg i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 4px; vertical-align: -1px; }
</style>
<h2>Twelve runs, one scene</h2>
<p class="lede">The same pretrained policy runs the same prompt twelve times on one layout. Only the arm's start pose
  differs. Each run's tool path is drawn in the kitchen, so you can see in depth where the failures split off.</p>
<div class="row">
  <label class="inline">Container <select id="ro-slot"><option value="0">Plate</option><option value="1">Blue bowl</option></select></label>
  <label class="inline">Order <select id="ro-order">${ORDERS.map((o, i) => `<option value="${i}"${i === 2 ? ' selected' : ''}>${o.label}</option>`).join('')}</select></label>
</div>
<div class="row"><button id="ro-run" type="button" class="primary">Run 12 rollouts</button></div>
<div class="status" id="ro-status">Pick a prompt and run. 2 → 3 → 1 is the default because it fails often enough to compare.</div>
<div class="ro-leg"><span><i style="background:#4ade80"></i>done</span><span><i style="background:#f5b83d"></i>partly placed</span><span><i style="background:#f87171"></i>none placed</span></div>
<div id="ro-list" class="ro-list"></div>
<div class="ro-scrub">
  <button id="ro-play" type="button" class="icon" title="Play / pause" disabled>▶</button>
  <input id="ro-t" type="range" min="0" max="1" step="1" value="0" aria-label="Time" disabled>
  <span id="ro-tl" class="small">0.0 s</span>
</div>
<p class="small">Same layout every run; only the start pose differs. Failures show where the paths split off in depth.
  A toy policy in a toy sim.</p>`;

const st = {
  runs: [], sel: 0, t: 0, playing: false, acc: 0, busy: false, group: null, layout: null, token: 0,
};

function clearGroup(ctx) {
  if (!st.group) return;
  ctx.world.usd.remove(st.group);
  st.group.traverse((o) => { o.geometry?.dispose?.(); if (o.material && !o.material.shared) o.material.dispose?.(); });
  st.group = null;
}

function outcome(r) { return r.success ? 'ok' : r.placed > 0 ? 'part' : 'bad'; }

function buildTubes(ctx) {
  clearGroup(ctx);
  const g = new THREE.Group();
  g.name = 'rollout-ribbons';
  for (const r of st.runs) {
    const pts = [];
    const stride = 3;
    for (let f = 0; f < r.n; f += stride) pts.push(new THREE.Vector3(r.tip[f * 3], r.tip[f * 3 + 1], r.tip[f * 3 + 2]));
    pts.push(new THREE.Vector3(r.tip[(r.n - 1) * 3], r.tip[(r.n - 1) * 3 + 1], r.tip[(r.n - 1) * 3 + 2]));
    const curve = new THREE.CatmullRomCurve3(pts);
    const color = COLORS[outcome(r)];
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.5, transparent: true, opacity: 0.9 });
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(900, pts.length * 2), 0.0015, 6, false), mat);
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.005, 14, 10), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6 }));
    r.tube = tube; r.bead = bead; r.mat = mat;
    g.add(tube, bead);
  }
  ctx.world.usd.add(g);
  st.group = g;
  styleSelection();
}

function styleSelection() {
  st.runs.forEach((r, i) => {
    const on = i === st.sel;
    r.mat.opacity = on ? 1 : 0.35;
    r.mat.emissiveIntensity = on ? 0.6 : 0.15;
    r.tube.renderOrder = on ? 2 : 1;
    if (on && !r.thick) { r.thin = r.tube.geometry; r.thick = new THREE.TubeGeometry(r.thin.parameters.path, r.thin.parameters.tubularSegments, 0.003, 8, false); }
    r.tube.geometry = on && r.thick ? r.thick : (r.thin || r.tube.geometry);
    r.bead.scale.setScalar(on ? 1.5 : 1);
  });
  for (const b of document.querySelectorAll('#ro-list button')) b.classList.toggle('on', +b.dataset.i === st.sel);
}

async function runAll(ctx) {
  if (st.busy) return;
  st.busy = true;
  const token = ++st.token;
  const $ = ctx.$;
  $('ro-run').disabled = true;
  st.playing = false;
  const slot = +$('ro-slot').value, O = ORDERS[+$('ro-order').value];
  const prompt = { slot, order: O.order.slice(), seen: 3 };
  const layout = ctx.promptLayout(ctx.mulberry32(SEED_LAYOUT), slot);
  st.layout = layout;
  ctx.setLayout(layout);
  st.runs = [];
  clearGroup(ctx);
  $('ro-list').innerHTML = '';
  const env = new PickOrangeEnv(), act = new Float64Array(6);
  for (let i = 0; i < N; i++) {
    const start = ctx.jitterStart(ctx.mulberry32(1000 + i * 17));
    env.reset(layout, start);
    const ctl = new ctx.PromptedPolicy(ctx.app.prior, prompt);
    ctl.reset(env);
    const tip = [], motor = [], oranges = [], held = [];
    const rec = () => {
      tip.push(env.tip.x, env.tip.y, env.tip.z);
      for (let k = 0; k < 6; k++) motor.push(env.motor[k]);
      for (const o of env.oranges) oranges.push(o.p.x, o.p.y, o.p.z);
      held.push(env.held);
    };
    rec();
    let t = 0;
    while (t < MAX_STEPS) {
      for (let c = 0; c < 200 && t < MAX_STEPS; c++, t++) {
        ctl.act(env, act);
        env.step(act);
        rec();
        if (env.success() || ctl.done?.(env)) { t = MAX_STEPS; break; }
      }
      $('ro-status').innerHTML = `Running rollout <b>${i + 1}/${N}</b>…`;
      await ctx.nextFrame();
      if (token !== st.token) return;
    }
    const r = { i, n: held.length, tip: Float32Array.from(tip), motor: Float32Array.from(motor), oranges: Float32Array.from(oranges), held: Int8Array.from(held), success: env.success(), placed: env.placedCount() };
    st.runs.push(r);
  }
  const ok = st.runs.filter((r) => r.success).length;
  buildTubes(ctx);
  $('ro-list').innerHTML = st.runs.map((r, i) => `<button type="button" data-i="${i}"><i style="background:#${COLORS[outcome(r)].toString(16).padStart(6, '0')}"></i>Run ${i + 1} · ${r.success ? (r.n / 30).toFixed(1) + ' s' : r.placed + '/3'}</button>`).join('');
  for (const b of document.querySelectorAll('#ro-list button')) b.addEventListener('click', () => select(ctx, +b.dataset.i));
  const names = ctx.containerNames();
  $('ro-status').innerHTML = `<b>${ok} of ${N}</b> runs finished (prompt: ${names[slot].toLowerCase()}, ${O.label}). Pick a run to replay it.`;
  const firstBad = st.runs.findIndex((r) => !r.success);
  select(ctx, firstBad >= 0 ? firstBad : 0);
  $('ro-run').disabled = false;
  $('ro-play').disabled = false;
  $('ro-t').disabled = false;
  st.playing = true;
  st.busy = false;
}

function select(ctx, i) {
  st.sel = i;
  st.t = 0;
  st.acc = 0;
  const r = st.runs[i];
  ctx.$('ro-t').max = String(r.n - 1);
  ctx.$('ro-t').value = '0';
  styleSelection();
}

function applyFrame(ctx, r, f) {
  const env = ctx.sim.env;
  f = Math.max(0, Math.min(r.n - 1, f));
  for (let k = 0; k < 6; k++) env.motor[k] = r.motor[f * 6 + k];
  env.updateKinematics();
  const h = r.held[f];
  env.held = h;
  for (let i = 0; i < 3; i++) {
    const o = env.oranges[i];
    o.p.set(r.oranges[f * 9 + i * 3], r.oranges[f * 9 + i * 3 + 1], r.oranges[f * 9 + i * 3 + 2]);
    o.held = i === h;
    o.q.identity();
  }
  ctx.drawMain(null);
}

function placeBeads(t) {
  for (const r of st.runs) {
    const f = Math.min(r.n - 1, Math.floor(t));
    r.bead.position.set(r.tip[f * 3], r.tip[f * 3 + 1], r.tip[f * 3 + 2]);
    r.bead.visible = t < r.n + 30;
  }
}

export default {
  id: 'rollouts',
  label: 'Rollouts',
  html,
  init(ctx) {
    const $ = ctx.$;
    $('ro-run').addEventListener('click', () => runAll(ctx));
    $('ro-play').addEventListener('click', () => {
      const r = st.runs[st.sel];
      if (!r) return;
      if (st.t >= r.n - 1) st.t = 0;
      st.playing = !st.playing;
    });
    $('ro-t').addEventListener('input', (e) => { st.t = +e.target.value; st.playing = false; });
  },
  enter(ctx) {
    ctx.stage.idleSway = false;
    ctx.stage.flyTo({ ...ctx.VIEWS.work, dist: 1.0, pitch: 0.75, radius: 0.34 });
    if (st.runs.length) { ctx.setLayout(st.layout); buildTubes(ctx); }
    else ctx.hud('Rollout review', 'pick a prompt and run');
  },
  leave(ctx) {
    st.token++;
    st.busy = false;
    st.playing = false;
    ctx.$('ro-run').disabled = false;
    clearGroup(ctx);
    for (const r of st.runs) { r.thick?.dispose?.(); r.thick = null; r.thin = null; }
    ctx.setLayout(ctx.promptLayout(ctx.app.rng, 0));
  },
  tick(dt, ctx) {
    const $ = ctx.$;
    const r = st.runs[st.sel];
    if (!r || st.busy) {
      ctx.world.main.update(ctx.sim.env, null);
      if (st.busy) ctx.hud('Rollout review', 'computing 12 runs', '', '');
      return true;
    }
    if (st.playing) {
      st.acc += dt * 30;
      const n = Math.floor(st.acc);
      st.acc -= n;
      st.t = Math.min(r.n - 1, st.t + n);
      if (st.t >= r.n - 1) st.playing = false;
      if (document.activeElement !== $('ro-t')) $('ro-t').value = String(st.t);
    }
    $('ro-play').textContent = st.playing ? '❚❚' : '▶';
    $('ro-tl').textContent = `${(st.t / 30).toFixed(1)} s`;
    applyFrame(ctx, r, st.t);
    placeBeads(st.t);
    const ok = st.runs.filter((x) => x.success).length;
    const f = Math.min(r.n - 1, st.t);
    let placed = 0;
    const env = ctx.sim.env;
    for (let i = 0; i < 3; i++) if (env.onPlate(i)) placed++;
    ctx.hud(`Run ${st.sel + 1} of ${N}`, r.success ? 'finished' : `${r.placed}/3 placed at the end`, `in the ${ctx.containerNames()[st.layout.slot].toLowerCase()} <b>${placed}/3</b> · ${ok}/${N} runs finished`, `${(f / 30).toFixed(1)} s`);
    return true;
  },
};
