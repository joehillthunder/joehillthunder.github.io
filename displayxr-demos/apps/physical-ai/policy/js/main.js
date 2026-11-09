// Robot Policy Lab (Physical AI Lab): boot, the chapters (Prompt it, Fleet, then js/chapters.js), the 30 Hz
// sim loop in the kitchen and the fleet grid. Built on the Physical AI Lab sim (Lightwheel kitchen,
// SO-101, pick-and-place) with a pretrained, goal-conditioned policy baked offline (tools/bake4.js).

import * as THREE from 'three';
import { Stage } from './stage.js';
import { World, usdToThree } from './world.js';
import * as D from './data.js';
import { PickOrangeEnv, DYNAMICS, mulberry32, START_MOTOR, COUNTER } from './task.js';
import { ScriptedExpert, TeleopController } from './policy.js';
import { SLOTS, promptLayout, PromptedPolicy, readPrompt, FIRST_ORDER } from './prompt.js';
import { buildFleet, THEMES, makeBowl } from './fleet.js';
import { EFFECTORS, attachEffectors } from './effectors.js';
import { reviveModel } from './finetune.js';
import { CHAPTERS } from './chapters.js';

const BASE = new URL('../', import.meta.url).href;
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const store = {
  get(k, d) { try { const v = localStorage.getItem('prl.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('prl.' + k, JSON.stringify(v)); } catch { /* blocked */ } },
};

// Joint lag fitted from Lightwheel's 60 teleop demos (same fit the policy was trained under).
DYNAMICS.k = [0.4133, 0.2585, 0.3087, 0.1677, 0.4471, 0.4];

const PROMPT_FRAMES = 360; // 12 s at 30 Hz
const CONTEXT_S = 30;
const KITCHEN_NAMES = ['Plate', 'Blue bowl'];

const stage = new Stage($('stage'), { force2d: params.has('2d') });
const world = new World(stage);
const WORK = usdToThree(2.28, -0.42, 0.97);
const VIEWS = {
  wide: { target: usdToThree(2.4, -0.3, 1.0), dist: 2.2, yaw: 0.45, pitch: 0.42, radius: 1.1 },
  work: { target: WORK, dist: 0.95, yaw: 0.3, pitch: 0.66, radius: 0.32 },
  close: { target: WORK, dist: 0.75, yaw: 0.22, pitch: 0.72, radius: 0.26 },
};

const app = {
  chapter: null,
  prior: null,
  results: null,
  rng: mulberry32((Date.now() & 0xffff) + 1),
  layout: null,
  prompt: null,
  effector: 'jaw',
  fleet: null,
};
const sim = {
  env: new PickOrangeEnv(),
  ctl: null,
  mode: 'idle', // idle | prompt | teleop | live
  playing: false,
  t: 0,
  acc: 0,
  act: new Float64Array(6),
  maxSteps: 1400,
  rec: null,
  onDone: null,
};

// ---- boot ---------------------------------------------------------------------------------------------
async function boot() {
  const started = stage.start();
  const [, prior, results] = await Promise.all([
    world.load(new URL('../../', import.meta.url).href, (p) => { $('load-bar').style.width = `${Math.round(p * 95)}%`; }), // GLBs: the Physical AI Lab's own assets/
    fetch(BASE + 'assets/prior.json').then((r) => r.json()),
    fetch(BASE + 'assets/results.json').then((r) => r.json()),
  ]);
  app.prior = reviveModel(prior);
  app.results = results;
  $('load-bar').style.width = '100%';

  // the second container and the end effectors on the kitchen arm
  world.main.plate.scale.setScalar(0.72); // visual: keep plate and bowl apart
  world.bowl = makeBowl();
  world.main.root.add(world.bowl);
  world.effector = attachEffectors(world.main.robot);

  setLayout(promptLayout(app.rng, 0));
  stage.onTick = tick;
  stage.flyTo(VIEWS.wide, 0);
  stage.idleSway = true;

  const { woven, firstWoven } = await started;
  $('mode').textContent = woven ? '3D' : '2D';
  $('mode').classList.toggle('on', woven);
  $('mode').title = woven ? 'Glasses-free 3D through DisplayXR' : 'For glasses-free 3D, open this page in the DisplayXR Browser on a Leia display';
  if (woven) $('depth-wrap').hidden = false;
  firstWoven.then(() => { $('cover').hidden = true; });
  if (!woven) $('cover').hidden = true;
  stage.onRewoven = (p) => { $('cover').hidden = false; p.then(() => { $('cover').hidden = true; }); };
  $('loading').hidden = true;
  if (!store.get('introSeen', false) || params.has('intro')) $('intro').hidden = false;
  buildUI();
  setChapter(params.get('step') || 'prompt');
  window.gen3d = { app, sim, world, stage };
}

function setLayout(layout, motor = START_MOTOR) {
  app.layout = layout;
  sim.env.reset(layout, motor);
  drawMain(null);
}

function containerNames() { return KITCHEN_NAMES; }

// ---- sim loop -----------------------------------------------------------------------------------------
function tick(dt) {
  if (fleetRun) { fleetTick(dt); return; }
  const ext = CHAPTERS.find((c) => c.id === app.chapter);
  if (ext?.tick && ext.tick(dt, ctx) === true) return;
  if (sim.playing) {
    sim.acc += dt * 30;
    let n = Math.min(8, Math.floor(sim.acc));
    sim.acc -= n;
    while (n-- > 0 && sim.playing) stepSim();
  }
  const goal = sim.mode === 'live' ? sim.ctl?.goal?.pos : sim.mode === 'prompt' ? sim.ctl?.goalP : sim.mode === 'teleop' ? sim.ctl?.target : null;
  drawMain(goal || null);
  hud();
}

function drawMain(goal) {
  const v = world.main, cs = app.layout.containers;
  v.update(sim.env, goal);
  v.plate.position.set(cs[0][0], cs[0][1], COUNTER.z);
  world.bowl.position.set(cs[1][0], cs[1][1], COUNTER.z);
  world.effector.update(sim.env.motor[5]);
}

const releases = [];
function stepSim() {
  const env = sim.env;
  const nEv = env.events.length;
  if (sim.mode === 'teleop') teleopStep();
  else { sim.ctl.act(env, sim.act); env.step(sim.act); }
  sim.t++;
  // where things were let go (the prompt reader needs drop points, not just "released")
  for (let i = nEv; i < env.events.length; i++) {
    const e = env.events[i];
    if (e.type === 'release') releases.push([env.oranges[e.orange].p.x, env.oranges[e.orange].p.y]);
    if (sim.rec) onPromptEvent(e);
  }
  if (sim.rec) {
    updateContextBar(sim.t / 30);
    if (sim.t >= PROMPT_FRAMES) finishPrompt();
    return;
  }
  if (sim.mode === 'live') {
    const ok = env.success();
    if (ok || sim.t >= sim.maxSteps || sim.ctl.done?.(env)) {
      setPlaying(false);
      const msg = ok ? `Done in ${(sim.t / 30).toFixed(1)} s` : `${env.placedCount()} of 3 placed`;
      if (sim.onDone) { const f = sim.onDone; sim.onDone = null; f(ok, msg); } else toast(`${sim.ctl.name}: ${msg}`);
    }
  }
}

function setPlaying(on) { sim.playing = on; }

function hud() {
  const env = sim.env, names = containerNames();
  let who = 'Idle', phase = '';
  if (sim.mode === 'prompt') { who = sim.rec?.teleop ? 'You, recording the prompt' : 'Example prompt (scripted demo)'; phase = sim.ctl?.phase || ''; }
  else if (sim.mode === 'teleop') { who = 'You, recording the prompt'; phase = env.held >= 0 ? `holding orange ${env.held + 1}` : ''; }
  else if (sim.mode === 'live') {
    who = sim.ctl.name;
    const g = sim.ctl.goal;
    phase = g ? (g.kind === 'orange' ? `reach orange ${g.orange + 1}` : g.kind === 'plate' ? `carry to the ${names[app.layout.slot].toLowerCase()}` : 'return home') : '';
  }
  $('hud-who').innerHTML = `<b>${who}</b>`;
  $('hud-phase').textContent = phase;
  $('hud-oranges').innerHTML = sim.mode === 'idle' ? '' : `in the ${names[app.layout.slot].toLowerCase()} <b>${env.placedCount()}/3</b>${env.success() ? ' · <b>done</b>' : ''}`;
  $('hud-t').textContent = sim.mode === 'idle' ? '' : `${(sim.t / 30).toFixed(1)} s`;
}

let toastTimer = 0;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---- chapters -----------------------------------------------------------------------------------------
function setChapter(ch) {
  if (!['prompt', 'fleet', ...CHAPTERS.map((c) => c.id)].includes(ch)) ch = 'prompt';
  const prev = CHAPTERS.find((c) => c.id === app.chapter);
  if (prev && prev.id !== ch) { try { prev.leave?.(ctx); } catch (e) { console.error(e); } }
  if (fleetRun && ch !== 'fleet') stopFleet();
  if (teleop.on && ch !== 'prompt') stopTeleop();
  app.chapter = ch;
  for (const s of document.querySelectorAll('#panel section')) s.hidden = s.dataset.chapter !== ch;
  for (const b of document.querySelectorAll('#steps button')) b.classList.toggle('on', b.dataset.step === ch);
  $('panel').scrollTop = 0;
  stage.idleSway = ch === 'prompt' && sim.mode === 'idle';
  if (ch === 'prompt') stage.flyTo(VIEWS.work);
  if (ch === 'fleet') renderFleetTable();
  const next = CHAPTERS.find((c) => c.id === ch);
  if (next && prev !== next) { setPlaying(false); sim.mode = 'idle'; try { next.enter?.(ctx); } catch (e) { console.error(e); } }
  const u = new URL(location.href);
  u.searchParams.set('step', ch);
  history.replaceState(null, '', u);
}

function buildUI() {
  // extra chapters (js/chapters.js): nav button + panel section each, numbered after Prompt it and Fleet
  CHAPTERS.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.step = c.id;
    b.innerHTML = `<b>${i + 3}</b> ${c.label}`;
    $('steps').appendChild(b);
    const sec = document.createElement('section');
    sec.dataset.chapter = c.id;
    sec.hidden = true;
    sec.innerHTML = c.html;
    $('panel').appendChild(sec);
  });
  for (const c of CHAPTERS) { try { c.init?.(ctx); } catch (e) { console.error('chapter init', c.id, e); } }
  for (const b of document.querySelectorAll('#steps button')) b.addEventListener('click', () => setChapter(b.dataset.step));
  $('intro-go').addEventListener('click', () => { $('intro').hidden = true; store.set('introSeen', true); });
  $('help').addEventListener('click', () => { $('intro').hidden = false; });
  $('depth').addEventListener('input', (e) => { stage.depthGain = +e.target.value; });

  // prompt
  const R = app.results;
  $('prior-card').innerHTML = `<div class="kind">Pretrained policy (stand-in)</div>
    <h4>Trained offline on ${R.synthetic} demonstrations · ${R.syntheticMinutes.toFixed(0)} min</h4>
    <p class="small" style="margin:4px 0 0">Both containers, one default order, then ${R.daggerRounds} rounds of DAgger: ${R.frames.toLocaleString()} labelled frames.
    Measured on 20 new layouts per prompt: ${rateText(R)}.</p>`;
  $('prior-mins').textContent = R.syntheticMinutes.toFixed(0);
  $('p-example').addEventListener('click', playExamplePrompt);
  $('p-teleop').addEventListener('click', () => (teleop.on ? stopTeleop() : startTeleop()));
  $('p-run').addEventListener('click', () => runPrompted());
  $('p-check').addEventListener('click', scorePrompt);
  for (const b of $('teleop-pad').querySelectorAll('button')) {
    const k = b.dataset.k;
    if (k === 'Space') b.addEventListener('click', () => teleopKey(k));
    else {
      b.addEventListener('pointerdown', () => teleop.keys.add(k));
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => teleop.keys.delete(k));
    }
  }
  for (const E of EFFECTORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = E.name;
    b.dataset.id = E.id;
    b.classList.toggle('on', E.id === app.effector);
    b.addEventListener('click', () => setEffector(E.id));
    $('effectors').appendChild(b);
  }

  // fleet
  $('f-run').addEventListener('click', runFleet);
  $('f-shuffle').addEventListener('click', () => { fleetPrompts = null; if (fleetRun) runFleet(); else renderFleetTable(); });
  $('f-back').addEventListener('click', stopFleet);

  addEventListener('keydown', onKey);
  addEventListener('keyup', (e) => { teleop.keys.delete(e.code); CHAPTERS.find((c) => c.id === app.chapter)?.keyup?.(e, ctx); });
}

function setEffector(id) {
  app.effector = id;
  world.effector.set(id);
  for (const b of $('effectors').children) b.classList.toggle('on', b.dataset.id === id);
}

// ---- 1 · prompt ---------------------------------------------------------------------------------------
function beginPrompt(teleopMode) {
  const slot = +$('p-slot').value;
  const layout = promptLayout(app.rng, slot);
  setLayout(layout, teleopMode ? START_MOTOR : D.jitterStart(app.rng));
  releases.length = 0;
  sim.t = 0;
  sim.rec = { teleop: teleopMode, events: [] };
  app.prompt = null;
  $('ctx-events').innerHTML = '';
  $('readout').innerHTML = '<span class="muted">Watching the prompt…</span>';
  $('p-run').disabled = true; $('p-check').disabled = true;
  $('p-status').textContent = '';
  updateContextBar(0);
  stage.idleSway = false;
}

function playExamplePrompt() {
  if (teleop.on) stopTeleop();
  beginPrompt(false);
  const first = +$('p-first').value;
  const ctl = new ScriptedExpert();
  ctl.order = FIRST_ORDER[first].slice();
  ctl.reset();
  ctl.name = 'Example prompt';
  sim.ctl = ctl;
  sim.mode = 'prompt';
  stage.flyTo(VIEWS.work);
  setPlaying(true);
}

function onPromptEvent(e) {
  const names = containerNames();
  sim.rec.events.push(e);
  const span = document.createElement('span');
  if (e.type === 'grasp') { span.className = 'g'; span.textContent = `${(e.t / 30).toFixed(1)} s · grasped orange ${e.orange + 1}`; }
  else {
    const p = releases[releases.length - 1];
    const d = app.layout.containers.map((c) => Math.hypot(p[0] - c[0], p[1] - c[1]));
    const near = d[0] < d[1] ? 0 : 1;
    span.className = 'r';
    span.textContent = `${(e.t / 30).toFixed(1)} s · dropped ${d[near] < 0.12 ? 'in the ' + names[near].toLowerCase() : 'on the counter'}`;
  }
  $('ctx-events').appendChild(span);
}

function updateContextBar(seconds) {
  $('ctx-fill').style.width = `${Math.min(100, (seconds / CONTEXT_S) * 100)}%`;
  $('ctx-t').textContent = Math.min(12, seconds).toFixed(1);
}

function finishPrompt() {
  const rec = sim.rec;
  sim.rec = null;
  setPlaying(false);
  if (teleop.on) stopTeleop(true);
  sim.mode = 'idle';
  const p = readPrompt(rec.events, app.layout, releases.slice());
  const names = containerNames();
  if (p.slot === null) {
    $('readout').innerHTML = `<span class="muted">No drop seen in the 12 s, so the container is unknown. ${p.seen ? `It saw orange ${p.order[0] + 1} grasped first.` : 'Nothing was grasped.'} Try again, or play the example.</span>`;
    return;
  }
  app.prompt = p;
  $('readout').innerHTML = `<dl>
    <dt>Container</dt><dd><b>${names[p.slot]}</b> <span class="muted">(the first drop was nearest to it)</span></dd>
    <dt>Order</dt><dd><b>${p.order.map((i) => i + 1).join(' → ')}</b> <span class="muted">(${p.seen} of 3 from the demo${p.seen < 3 ? ', the rest completed' : ''})</span></dd>
    <dt>Weights changed</dt><dd>none</dd>
    <dt>Measured</dt><dd>${measured(p)}</dd></dl>`;
  $('p-run').disabled = false; $('p-check').disabled = false;
  toast('Prompt read. Now run the policy on a new layout.');
}

function runPrompted({ prompt = app.prompt, layout = null, onDone = null, name } = {}) {
  if (!prompt) return;
  if (teleop.on) stopTeleop();
  const L = layout || promptLayout(app.rng, prompt.slot);
  setLayout(L, D.jitterStart(app.rng));
  sim.ctl = new PromptedPolicy(app.prior, prompt, name || `Pretrained policy · ${containerNames()[prompt.slot]} · ${prompt.order.map((i) => i + 1).join('→')}`);
  sim.ctl.reset(sim.env);
  sim.mode = 'live';
  sim.t = 0;
  sim.rec = null;
  sim.onDone = onDone;
  releases.length = 0;
  stage.idleSway = false;
  if (app.chapter === 'prompt') stage.flyTo(VIEWS.work);
  setPlaying(true);
}

async function scorePrompt() {
  const p = app.prompt;
  if (!p) return;
  $('p-check').disabled = true;
  const env = new PickOrangeEnv(), R = mulberry32(4242), act = new Float64Array(6);
  let ok = 0, placed = 0;
  for (let i = 0; i < 10; i++) {
    $('p-status').innerHTML = `Scoring layout ${i + 1}/10…`;
    await nextFrame();
    const c = new PromptedPolicy(app.prior, p);
    c.reset(env);
    env.reset(promptLayout(R, p.slot), D.jitterStart(R));
    for (let t = 0; t < sim.maxSteps; t++) { c.act(env, act); env.step(act); if (env.success()) break; }
    if (env.success()) ok++;
    placed += env.placedCount();
  }
  $('p-status').innerHTML = `This prompt on 10 new layouts: <b>${ok}/10</b> finished, ${(placed / 10).toFixed(1)} oranges in the ${containerNames()[p.slot].toLowerCase()} on average.`;
  $('p-check').disabled = false;
}

// teleop (the 12 s prompt by hand)
const teleop = { on: false, keys: new Set() };
function startTeleop() {
  beginPrompt(true);
  teleop.on = true;
  sim.mode = 'teleop';
  sim.ctl = new TeleopController();
  sim.ctl.reset(sim.env);
  $('p-teleop').textContent = 'Stop recording';
  $('p-teleop').classList.add('on');
  $('teleop-pad').hidden = false;
  $('teleop-help').hidden = false;
  stage.flyTo(VIEWS.close);
  setPlaying(true);
  toast('Recording 12 s: grab an orange and drop it in a container');
}
function stopTeleop(fromFinish = false) {
  teleop.on = false;
  teleop.keys.clear();
  $('p-teleop').textContent = 'Record your own';
  $('p-teleop').classList.remove('on');
  $('teleop-pad').hidden = true;
  $('teleop-help').hidden = true;
  if (!fromFinish && sim.rec) finishPrompt();
}
const _f = new THREE.Vector3();
function teleopStep() {
  const c = sim.ctl, env = sim.env, k = teleop.keys;
  stage.cam.getWorldDirection(_f);
  const fx = _f.x, fy = -_f.z, n = Math.hypot(fx, fy) || 1;
  const F = [fx / n, fy / n], Rt = [F[1], -F[0]], v = 0.0055;
  const dx = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0), dr = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0), dz = (k.has('KeyR') ? 1 : 0) - (k.has('KeyF') ? 1 : 0);
  c.target.x = Math.max(1.95, Math.min(2.6, c.target.x + (F[0] * dx + Rt[0] * dr) * v));
  c.target.y = Math.max(-0.62, Math.min(-0.12, c.target.y + (F[1] * dx + Rt[1] * dr) * v));
  c.target.z = Math.max(0.93, Math.min(1.25, c.target.z + dz * v));
  c.act(env, sim.act);
  env.step(sim.act);
}
function teleopKey(code) { if (teleop.on && code === 'Space') sim.ctl.grip = sim.ctl.grip > 20 ? 0 : 45; }

function onKey(e) {
  if (e.target.matches?.('input, select, textarea')) return;
  const ext = CHAPTERS.find((c) => c.id === app.chapter);
  if (ext?.keydown && ext.keydown(e, ctx) === true) return;
  if (teleop.on) {
    if (e.code === 'Space') { e.preventDefault(); teleopKey('Space'); return; }
    if (e.code === 'Escape') { stopTeleop(); return; }
    teleop.keys.add(e.code);
    return;
  }
  if (e.key === '?') $('intro').hidden = !$('intro').hidden;
  if (/^Digit[1-9]$/.test(e.code)) { const ids = ['prompt', 'fleet', ...CHAPTERS.map((c) => c.id)]; const id = ids[+e.code.slice(5) - 1]; if (id) setChapter(id); }
}

// ---- 2 · fleet ----------------------------------------------------------------------------------------
let fleetRun = null, fleetPrompts = null;
const FLEET_THEMES = ['kitchen', 'kitchen', 'kitchen', 'warehouse', 'warehouse', 'warehouse', 'lab', 'lab', 'lab'];
const THEME_CONTAINERS = { kitchen: ['plate', 'bowl'], warehouse: ['tote', 'bin'], lab: ['tray', 'rack'] };
const THEME_OBJECT = { kitchen: 'oranges', warehouse: 'parcels', lab: 'vials' };
const ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
// the orders this policy handles best (measured in tools/bake5.js); fleet prompts use these
const STRONG = [[0, 1, 2], [2, 1, 0], [1, 2, 0]];

function makeFleetPrompts() {
  const R = mulberry32((Date.now() & 0xffff) + 7);
  return FLEET_THEMES.map(() => ({ slot: R() < 0.5 ? 0 : 1, order: STRONG[Math.floor(R() * 2)], seen: 3 }));
}

function renderFleetTable(done = null) {
  if (!fleetPrompts) fleetPrompts = makeFleetPrompts();
  const tb = $('f-table').querySelector('tbody');
  tb.innerHTML = Object.entries(THEMES).map(([id, T]) => {
    const idx = FLEET_THEMES.map((t, i) => (t === id ? i : -1)).filter((i) => i >= 0);
    const d = done ? idx.filter((i) => done[i] === true).length : null;
    return `<tr><td>${T.name}<div class="small">${THEME_OBJECT[id]} → ${THEME_CONTAINERS[id].join(' / ')}</div></td><td>${EFFECTORS.find((e) => e.id === T.effector).name}</td><td class="num">${d === null ? '–' : `${d}/${idx.length}`}</td></tr>`;
  }).join('');
}

function runFleet() {
  if (!app.fleet) app.fleet = buildFleet(world, FLEET_THEMES);
  if (!fleetPrompts) fleetPrompts = makeFleetPrompts();
  setPlaying(false);
  world.setMode('grid');
  app.fleet.group.visible = true;
  stage.idleSway = false;
  stage.flyTo({ target: app.fleet.centre.clone().add(new THREE.Vector3(-0.32, 0, 0.12)), dist: 2.45, yaw: 0.0, pitch: 1.0, radius: 0.95 });
  const R = mulberry32(99);
  fleetRun = { slots: [], acc: 0, done: FLEET_THEMES.map(() => null) };
  app.fleet.cells.forEach((cell, i) => {
    const p = fleetPrompts[i], layout = promptLayout(R, p.slot);
    const env = new PickOrangeEnv().reset(layout, D.jitterStart(R));
    const ctl = new PromptedPolicy(app.prior, p);
    ctl.reset(env);
    const names = THEME_CONTAINERS[cell.theme];
    cell.setLabel(`${THEMES[cell.theme].name} · ${names[p.slot]} · ${p.order.map((k) => k + 1).join('→')}`);
    cell.setStatus(0x2a2450);
    fleetRun.slots.push({ env, ctl, cell, layout, t: 0, over: false, act: new Float64Array(6) });
  });
  $('f-run').textContent = 'Run again';
  $('f-back').hidden = false;
  renderFleetTable(fleetRun.done);
}

function fleetTick(dt) {
  const r = fleetRun;
  if (!r.finished) {
    r.acc += dt * 30 * 3;
    let n = Math.min(18, Math.floor(r.acc));
    r.acc -= n;
    while (n-- > 0) {
      let running = 0;
      r.slots.forEach((s, i) => {
        if (s.over) return;
        s.ctl.act(s.env, s.act);
        s.env.step(s.act);
        s.t++;
        const ok = s.env.success();
        if (ok || s.t >= sim.maxSteps || s.ctl.done?.(s.env)) {
          s.over = true;
          r.done[i] = ok;
          s.cell.setStatus(ok ? 0x22c55e : s.env.placedCount() ? 0xf59e0b : 0xef4444);
          renderFleetTable(r.done);
        } else running++;
      });
      if (!running) { r.finished = true; break; }
    }
  }
  for (const s of r.slots) s.cell.update(s.env, s.layout);
  const ok = r.done.filter((d) => d === true).length, fin = r.done.filter((d) => d !== null).length;
  $('f-status').innerHTML = r.finished ? `All cells done: <b>${ok}/9</b> finished their prompted task.` : `<b>${fin}/9</b> cells done · ${ok} finished · 3× speed`;
  $('hud-who').innerHTML = '<b>Fleet</b>';
  $('hud-phase').textContent = 'one pretrained policy, nine prompts';
  $('hud-oranges').innerHTML = `finished <b>${ok}/9</b>`;
  $('hud-t').textContent = '3× speed';
}

function stopFleet() {
  if (!fleetRun) return;
  fleetRun = null;
  app.fleet.group.visible = false;
  world.setMode('kitchen');
  $('f-back').hidden = true;
  $('f-run').textContent = 'Run the fleet';
  stage.flyTo(VIEWS.work);
}

// What extra chapters get (js/chapters.js). Keep this the only coupling between them and this file.
const ctx = {
  THREE, app, sim, world, stage, $, toast, VIEWS, store, nextFrame,
  setLayout, drawMain, setPlaying, runPrompted, promptLayout, PromptedPolicy, mulberry32, jitterStart: D.jitterStart,
  STRONG: () => STRONG, containerNames,
  hud(who, phase = '', info = '', t = '') { $('hud-who').innerHTML = who ? `<b>${who}</b>` : ''; $('hud-phase').textContent = phase; $('hud-oranges').innerHTML = info; $('hud-t').textContent = t; },
  showKitchen(on) { world.setMode(on ? 'kitchen' : 'grid'); },
};

boot().catch((e) => {
  console.error(e);
  $('load-msg').textContent = 'Could not load: ' + (e.message || e);
});

// measured success of the prompted policy (tools/bake5.js: 20 new layouts per order and container)
function measured(p) {
  const r = app.results.orders[p.order.join('') + '@' + p.slot];
  return r ? `<b>${Math.round(r.success * 100)}%</b> of 20 new layouts finished with this exact prompt` : 'not measured';
}
function rateText(R) {
  const f = (o) => Math.round(((R.orders[o + '@0'].success + R.orders[o + '@1'].success) / 2) * 100);
  return `<b>${f('012')}%</b> for order 1→2→3, <b>${f('210')}%</b> for 3→2→1, <b>${f('120')}%</b> for 2→3→1`;
}
