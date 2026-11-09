// Chapter: 2D vs 3D teleop. A quick, measurable check of whether depth helps demo collection: the viewer
// teleoperates the kitchen arm twice (flat and in 3D, random order) to put one highlighted orange in the
// bowl, and the page times each trial and counts missed grasps. Results stay in this viewer's browser.

import { TeleopController } from './policy.js';
import { COUNTER } from './task.js';

const LIMIT_S = 45;
const OPEN = 45, CLOSE = 0;
const KEY = 'teleopTrials';

const html = `
<style>
  .tl-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; font-variant-numeric: tabular-nums; }
  .tl-table th, .tl-table td { text-align: left; padding: 4px; border-bottom: 1px solid var(--line); }
  .tl-table td.n, .tl-table th.n { text-align: right; }
  .tl-trial { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
  .tl-trial .tl-pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel-2); color: var(--muted); }
  .tl-trial .tl-pill.on { border-color: var(--accent); color: var(--s1); background: #241d58; }
  .tl-trial .tl-pill.done { border-color: var(--good); color: var(--good); }
  .tl-big { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .tl-delta { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  .tl-delta .small { display: block; }
  .tl-good { color: var(--good); } .tl-bad { color: var(--bad); }
</style>
<h2>Does depth help teleop?</h2>
<p class="lede">Collecting demonstrations is spatial work. Put the highlighted orange in the blue bowl twice: once flat, once in
  3D, in random order. The page times each run and counts missed grasps.</p>
<div id="tl-note" class="card small"></div>
<div class="row">
  <button id="tl-start" type="button" class="primary">Start the test</button>
  <button id="tl-stop" type="button" hidden>Stop</button>
</div>
<div class="tl-trial" id="tl-trials"></div>
<div class="status" id="tl-status"></div>
<div id="tl-pad" class="pad" hidden>
  <button data-k="KeyW" type="button">↑</button><button data-k="KeyA" type="button">←</button><button data-k="KeyS" type="button">↓</button><button data-k="KeyD" type="button">→</button>
  <button data-k="KeyR" type="button">up</button><button data-k="KeyF" type="button">down</button><button data-k="Space" type="button">grip</button><button data-k="Escape" type="button">stop</button>
</div>
<p class="small"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move, <kbd>R</kbd>/<kbd>F</kbd> up/down, <kbd>Space</kbd> grip,
  <kbd>Esc</kbd> stop. ${LIMIT_S} s per trial.</p>
<h3>This session</h3>
<table class="tl-table" id="tl-session"><thead><tr><th>Trial</th><th class="n">First grasp</th><th class="n">In the bowl</th><th class="n">Misses</th></tr></thead><tbody></tbody></table>
<h3>All your sessions</h3>
<div class="tl-delta" id="tl-avg"></div>
<p class="small" id="tl-avg-note"></p>
<button id="tl-clear" type="button" class="link" style="background:none;border:none;color:var(--muted);text-decoration:underline;padding:2px 0;font-size:12px">Clear my results</button>
<p class="small">This measures you, on this sim, on this display. It's a quick check, not a study: a few runs per person, a
  learning effect between the two trials, and a simple kinematic grasp rule.</p>`;

const st = {
  ctx: null, on: false, keys: new Set(), trials: [], idx: -1, t: 0, acc: 0,
  ctl: null, target: -1, firstGrasp: null, misses: 0, closeAt: -1, results: [], ring: null, canStereo: false,
};

function load(ctx) { const v = ctx.store.get(KEY, []); return Array.isArray(v) ? v : []; }
function save(ctx, rows) { ctx.store.set(KEY, rows.slice(-60)); }
const fmt = (v) => (v == null ? '–' : `${v.toFixed(1)} s`);

function makeRing(ctx) {
  const { THREE } = ctx;
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.042, 0.004, 10, 48), new THREE.MeshBasicMaterial({ color: 0xc4bffd, transparent: true, opacity: 0.95, depthWrite: false }));
  g.add(ring);
  const pin = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.03, 16), new THREE.MeshBasicMaterial({ color: 0x847fea }));
  pin.rotation.x = -Math.PI / 2; // point down (Z-up frame)
  pin.position.z = 0.1;
  g.add(pin);
  g.userData.pin = pin;
  g.visible = false;
  ctx.world.main.root.add(g);
  return g;
}

function renderTrials() {
  const el = st.ctx.$('tl-trials');
  el.innerHTML = st.trials.map((m, i) => `<span class="tl-pill ${i === st.idx && st.on ? 'on' : i < st.results.length ? 'done' : ''}">${i + 1}. ${m === '3d' ? '3D' : 'Flat'}</span>`).join('');
}

function renderSession() {
  const tb = st.ctx.$('tl-session').querySelector('tbody');
  if (!st.results.length) { tb.innerHTML = '<tr><td colspan="4" class="small">Start the test to see your times.</td></tr>'; return; }
  tb.innerHTML = st.results.map((r) => `<tr><td>${r.mode === '3d' ? '3D' : 'Flat'}${r.stereo ? '' : r.mode === '3d' ? ' <span class="small">(flat: no 3D display)</span>' : ''}</td><td class="n">${fmt(r.grasp)}</td><td class="n">${r.done ? fmt(r.total) : `<span class="tl-bad">timed out</span>`}</td><td class="n">${r.misses}</td></tr>`).join('');
}

function avg(rows, mode, key) {
  const xs = rows.filter((r) => r.mode === mode && r[key] != null && (key !== 'total' || r.done)).map((r) => r[key]);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function renderAverages() {
  const ctx = st.ctx;
  const rows = load(ctx).filter((r) => r.stereo || r.mode === 'flat');
  const n3 = rows.filter((r) => r.mode === '3d').length, nf = rows.filter((r) => r.mode === 'flat').length;
  const cell = (label, f, d, unit = 's', lowerBetter = true) => {
    const delta = f != null && d != null ? d - f : null;
    const cls = delta == null ? '' : (lowerBetter ? delta < 0 : delta > 0) ? 'tl-good' : 'tl-bad';
    const val = delta == null ? '–' : `${delta > 0 ? '+' : ''}${unit === 's' ? delta.toFixed(1) + ' s' : delta.toFixed(1)}`;
    return `<div><div class="tl-big ${cls}">${val}</div><span class="small">${label}, 3D vs flat</span></div>`;
  };
  ctx.$('tl-avg').innerHTML = cell('first grasp', avg(rows, 'flat', 'grasp'), avg(rows, '3d', 'grasp'))
    + cell('in the bowl', avg(rows, 'flat', 'total'), avg(rows, '3d', 'total'))
    + cell('missed grasps', avg(rows, 'flat', 'misses'), avg(rows, '3d', 'misses'), 'n');
  ctx.$('tl-avg-note').textContent = n3 || nf
    ? `Averages over ${nf} flat and ${n3} 3D trial${n3 === 1 ? '' : 's'} in this browser. Negative means 3D was faster or missed less. Flat-only runs on a 2D screen don't count toward the 3D average.`
    : 'No finished trials yet. Results stay in this browser only.';
}

function startTest() {
  const ctx = st.ctx;
  st.canStereo = !!ctx.stage.displayModesSupported;
  st.trials = Math.random() < 0.5 ? ['flat', '3d'] : ['3d', 'flat'];
  st.results = [];
  st.idx = -1;
  ctx.$('tl-start').hidden = true;
  ctx.$('tl-stop').hidden = false;
  ctx.$('tl-pad').hidden = false;
  renderSession();
  nextTrial();
}

async function nextTrial() {
  const ctx = st.ctx;
  st.idx++;
  if (st.idx >= st.trials.length) { finishTest(); return; }
  const mode = st.trials[st.idx];
  if (st.canStereo) { try { await ctx.stage.setStereo(mode === '3d'); } catch (e) { console.warn('[teleop] setStereo', e); } }
  const rng = ctx.mulberry32((Date.now() & 0xffff) + st.idx * 7);
  const layout = ctx.promptLayout(rng, 1);
  ctx.setLayout(layout);
  st.target = Math.floor(rng() * 3);
  st.ctl = new TeleopController();
  st.ctl.reset(ctx.sim.env);
  ctx.sim.mode = 'teleop';
  ctx.sim.ctl = st.ctl;
  st.t = 0; st.acc = 0; st.firstGrasp = null; st.misses = 0; st.closeAt = -1;
  st.keys.clear();
  st.ring.visible = true;
  ctx.stage.idleSway = false;
  ctx.stage.flyTo(ctx.VIEWS.close);
  st.on = true;
  renderTrials();
  const label = mode === '3d' ? (st.canStereo ? '3D' : '3D (shown flat: open on a Leia display for real depth)') : 'Flat';
  ctx.$('tl-status').innerHTML = `Trial ${st.idx + 1} of 2: <b>${label}</b>. Put orange ${st.target + 1} (ringed) in the blue bowl.`;
  ctx.toast(`Trial ${st.idx + 1}: ${mode === '3d' ? '3D' : 'Flat'}. Orange ${st.target + 1} into the bowl.`);
}

function endTrial(done) {
  const ctx = st.ctx;
  st.on = false;
  st.ring.visible = false;
  st.keys.clear();
  const mode = st.trials[st.idx];
  const r = { mode, stereo: mode === '3d' ? st.canStereo : true, grasp: st.firstGrasp, total: done ? st.t / 30 : null, done, misses: st.misses, at: Date.now() };
  st.results.push(r);
  if (mode === 'flat' || st.canStereo) { const rows = load(ctx); rows.push(r); save(ctx, rows); }
  renderSession();
  renderAverages();
  ctx.toast(done ? `In the bowl in ${(st.t / 30).toFixed(1)} s, ${st.misses} missed grasp${st.misses === 1 ? '' : 's'}` : 'Time is up');
  setTimeout(() => { if (st.idx < st.trials.length && st.ctx.app.chapter === 'teleop' && !st.stopped) nextTrial(); }, 1500);
}

function finishTest() {
  const ctx = st.ctx;
  ctx.$('tl-start').hidden = false;
  ctx.$('tl-start').textContent = 'Run it again';
  ctx.$('tl-stop').hidden = true;
  ctx.$('tl-pad').hidden = true;
  renderTrials();
  const [a, b] = st.results;
  const f = st.results.find((r) => r.mode === 'flat'), d = st.results.find((r) => r.mode === '3d');
  let msg = 'Done.';
  if (f && d && f.done && d.done) msg = `Done. 3D took <b>${Math.abs(d.total - f.total).toFixed(1)} s</b> ${d.total <= f.total ? "less" : "more"} than flat, with ${d.misses} vs ${f.misses} missed grasps.`;
  else if (a && b) msg = 'Done. At least one trial timed out, so the times don’t compare.';
  if (!st.canStereo) msg += ' Both trials were flat here: run it in the DisplayXR Browser on a Leia display to compare.';
  ctx.$('tl-status').innerHTML = msg;
  if (st.canStereo) ctx.stage.setStereo(true).catch(() => {});
  ctx.sim.mode = 'idle';
}

function stopTest() {
  const ctx = st.ctx;
  st.stopped = true;
  st.on = false;
  st.keys.clear();
  if (st.ring) st.ring.visible = false;
  ctx.$('tl-start').hidden = false;
  ctx.$('tl-stop').hidden = true;
  ctx.$('tl-pad').hidden = true;
  if (st.canStereo) ctx.stage.setStereo(true).catch(() => {});
  ctx.sim.mode = 'idle';
  setTimeout(() => { st.stopped = false; }, 1600);
}

const _f = { x: 0, y: 0, z: 0 };
function step() {
  const ctx = st.ctx, env = ctx.sim.env, c = st.ctl, k = st.keys;
  const dir = ctx.stage.cam.getWorldDirection(new ctx.THREE.Vector3());
  _f.x = dir.x; _f.y = -dir.z;
  const n = Math.hypot(_f.x, _f.y) || 1;
  const F = [_f.x / n, _f.y / n], Rt = [F[1], -F[0]], v = 0.0055;
  const dx = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0), dr = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0), dz = (k.has('KeyR') ? 1 : 0) - (k.has('KeyF') ? 1 : 0);
  c.target.x = Math.max(1.95, Math.min(2.6, c.target.x + (F[0] * dx + Rt[0] * dr) * v));
  c.target.y = Math.max(-0.62, Math.min(-0.12, c.target.y + (F[1] * dx + Rt[1] * dr) * v));
  c.target.z = Math.max(0.93, Math.min(1.25, c.target.z + dz * v));
  c.act(env, ctx.sim.act);
  env.step(ctx.sim.act);
  st.t++;
  // grasp bookkeeping: a close that hasn't picked anything up after 0.5 s is a miss
  if (env.held === st.target && st.firstGrasp == null) st.firstGrasp = st.t / 30;
  if (st.closeAt >= 0 && st.t - st.closeAt >= 15) {
    if (env.held < 0) st.misses++;
    st.closeAt = -1;
  }
  if (env.onPlate(st.target) && env.held !== st.target) { endTrial(true); return; }
  if (st.t >= LIMIT_S * 30) endTrial(false);
}

function toggleGrip() {
  if (!st.on) return;
  const closing = st.ctl.grip > 20;
  st.ctl.grip = closing ? CLOSE : OPEN;
  if (closing) st.closeAt = st.t; else st.closeAt = -1;
}

export default {
  id: 'teleop',
  label: '2D vs 3D teleop',
  html,
  init(ctx) {
    st.ctx = ctx;
    st.ring = makeRing(ctx);
    ctx.$('tl-start').addEventListener('click', startTest);
    ctx.$('tl-stop').addEventListener('click', stopTest);
    ctx.$('tl-clear').addEventListener('click', () => { save(ctx, []); renderAverages(); });
    for (const b of ctx.$('tl-pad').querySelectorAll('button')) {
      const k = b.dataset.k;
      if (k === 'Space') b.addEventListener('click', toggleGrip);
      else if (k === 'Escape') b.addEventListener('click', stopTest);
      else {
        b.addEventListener('pointerdown', () => st.keys.add(k));
        for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => st.keys.delete(k));
      }
    }
    renderSession();
    renderAverages();
  },
  enter(ctx) {
    st.canStereo = !!ctx.stage.displayModesSupported;
    ctx.$('tl-note').innerHTML = st.canStereo
      ? 'The page switches this display between flat and 3D for you. Sit centred in front of the panel.'
      : 'This browser shows flat only, so both trials run flat here. For the real comparison, open the page in the DisplayXR Browser on a Leia display.';
    ctx.setLayout(ctx.promptLayout(ctx.mulberry32(11), 1));
    ctx.stage.idleSway = false;
    ctx.stage.flyTo(ctx.VIEWS.close);
    renderTrials();
    renderAverages();
  },
  leave(ctx) {
    if (st.on || st.idx >= 0) stopTest();
    st.idx = -1;
    st.trials = [];
    if (st.ring) st.ring.visible = false;
    if (ctx.stage.displayModesSupported) ctx.stage.setStereo(true).catch(() => {});
    ctx.sim.mode = 'idle';
    ctx.setLayout(ctx.promptLayout(ctx.mulberry32(3), 0));
  },
  tick(dt, ctx) {
    if (!st.on) return false;
    st.acc += dt * 30;
    let n = Math.min(8, Math.floor(st.acc));
    st.acc -= n;
    while (n-- > 0 && st.on) step();
    const env = ctx.sim.env;
    // keep the ring on the target orange (on the counter, or under the gripper while held)
    const p = env.oranges[st.target].p;
    st.ring.position.set(p.x, p.y, COUNTER.z + 0.003);
    st.ring.userData.pin.visible = env.held !== st.target;
    st.ring.userData.pin.position.z = p.z - COUNTER.z + 0.1;
    ctx.drawMain(env.held >= 0 ? null : st.ctl.target);
    const mode = st.trials[st.idx];
    ctx.hud(`Trial ${st.idx + 1} · ${mode === '3d' ? '3D' : 'Flat'}`, env.held === st.target ? 'carry it to the bowl' : env.held >= 0 ? 'wrong orange: drop it' : `grab orange ${st.target + 1}`,
      `missed grasps <b>${st.misses}</b>`, `${(st.t / 30).toFixed(1)} / ${LIMIT_S} s`);
    return true;
  },
  keydown(e) {
    if (!st.on) return false;
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) toggleGrip(); return true; }
    if (e.code === 'Escape') { stopTest(); return true; }
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF'].includes(e.code)) { st.keys.add(e.code); return true; }
    return true; // swallow other shortcuts while a trial runs
  },
  keyup(e) { st.keys.delete(e.code); },
};
