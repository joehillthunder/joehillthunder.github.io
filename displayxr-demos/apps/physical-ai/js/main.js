// Physical AI Lab: boot, the four chapters (World, Demonstrations, Train, Evaluate), the 30 Hz sim
// loop in the kitchen and the parallel evaluation grid.

import * as THREE from 'three';
import { Stage } from './stage.js';
import { World, CATALOG, LIGHTING, usdToThree } from './world.js';
import * as D from './data.js';
import { PickOrangeEnv, DYNAMICS, randomLayout, mulberry32, ORANGE_HOME, PLATE_HOME, START_MOTOR } from './task.js';
import { ReplayController, ScriptedExpert, PolicyController, TeleopController } from './policy.js';
import { LineChart, SERIES } from './charts.js';
import { JOINTS } from './robot.js';

const BASE = new URL('../', import.meta.url).href;
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const log = (...a) => console.log('[physical-ai]', ...a);
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const store = {
  get(k, d) { try { const v = localStorage.getItem('pal.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pal.' + k, JSON.stringify(v)); } catch { /* full or blocked */ } },
};

// ---- stage + world --------------------------------------------------------------------------------
const stage = new Stage($('stage'), { force2d: params.has('2d') });
const world = new World(stage);
const WORK = usdToThree(2.3, -0.4, 0.97);
const VIEWS = {
  world: { target: usdToThree(2.4, -0.3, 1.0), dist: 2.3, yaw: 0.45, pitch: 0.42, radius: 1.2 },
  work: { target: WORK, dist: 0.95, yaw: 0.32, pitch: 0.62, radius: 0.32 },
  close: { target: WORK, dist: 0.7, yaw: 0.2, pitch: 0.7, radius: 0.25 },
};

const app = {
  chapter: null,
  demos: { lightwheel: [], synthetic: [], yours: [] },
  src: 'lightwheel',
  current: null,
  models: [],
  board: store.get('board', []),
  rng: mulberry32(Date.now() & 0xffff),
  spread: 1,
};
const sim = {
  env: new PickOrangeEnv(),
  ctl: null,
  mode: 'idle', // idle | replay | live | teleop
  playing: false,
  speed: 1,
  t: 0,
  acc: 0,
  act: new Float64Array(6),
  maxSteps: 1500,
};

// ---- loading ----------------------------------------------------------------------------------------
async function boot() {
  const started = stage.start();
  $('load-msg').textContent = "Loading Lightwheel's kitchen and SO-101…";
  await world.load(BASE, (p) => { $('load-bar').style.width = `${Math.round(p * 90)}%`; });
  $('load-msg').textContent = 'Loading 60 teleop demonstrations…';
  const eps = await D.loadDemos(BASE + 'assets/pick-orange.bin');
  DYNAMICS.k = D.fitDynamics(eps);
  for (const e of eps) { e.layout = D.recoverLayout(e); e.labels = D.replayLabels(e); }
  app.demos.lightwheel = eps;
  restoreSaved();
  $('load-bar').style.width = '100%';
  log(`demos ${eps.length}, replay success ${eps.filter((e) => e.labels.success).length}, dynamics k ${DYNAMICS.k.map((v) => v.toFixed(2)).join(' ')}`);

  sim.env.reset({ oranges: ORANGE_HOME, plate: PLATE_HOME }, START_MOTOR);
  world.main.update(sim.env);
  stage.onTick = tick;
  stage.onTap = onTap;
  stage.flyTo(VIEWS.world, 0);
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
  setChapter(params.get('step') || 'world');
  window.lab = { app, sim, world, stage, D };
}

function restoreSaved() {
  for (const e of store.get('yours', [])) {
    const ep = { ...e, s: Float32Array.from(e.s), a: Float32Array.from(e.a) };
    ep.labels = D.replayLabels(ep);
    app.demos.yours.push(ep);
  }
  for (const m of store.get('models', [])) app.models.push(reviveModel(m));
}

// ---- the sim loop -----------------------------------------------------------------------------------
function tick(dt) {
  if (evalRun) { evalTick(dt); return; }
  if (sim.playing) {
    sim.acc += dt * 30 * sim.speed;
    let n = Math.min(12, Math.floor(sim.acc));
    sim.acc -= n;
    while (n-- > 0 && sim.playing) stepSim();
  }
  const goal = sim.mode === 'live' ? sim.ctl?.goalP || sim.ctl?.goal?.pos : sim.mode === 'teleop' ? sim.ctl.target : null;
  world.main.update(sim.env, goal || null);
  hud();
  if (sim.mode === 'replay') syncReplayUI();
}

function stepSim() {
  const env = sim.env;
  if (sim.mode === 'replay') {
    const ep = app.current;
    if (sim.t >= ep.n) { setPlaying(false); return; }
    env.t = sim.t;
    env.setMotor(ep.s.subarray(sim.t * 6, sim.t * 6 + 6));
    env.physics(1 / 30);
    sim.t++;
    return;
  }
  if (sim.mode === 'teleop') { teleopStep(); return; }
  if (sim.mode === 'live') {
    sim.ctl.act(env, sim.act);
    env.step(sim.act);
    sim.t++;
    if (env.success()) { setPlaying(false); toast(`${sim.ctl.name}: success in ${(sim.t / 30).toFixed(1)} s`); }
    else if (sim.ctl.done?.(env) || sim.t >= sim.maxSteps) { setPlaying(false); toast(`${sim.ctl.name}: ${env.placedCount()} of 3 placed`); }
  }
}

function setPlaying(on) {
  sim.playing = on;
  $('rp-play').textContent = on ? '❚❚' : '▶';
  for (const v of [$('v-front'), $('v-wrist')]) { if (!v.src) continue; if (on && sim.mode === 'replay') v.play().catch(() => {}); else v.pause(); }
}

function runLive(ctl, layout) {
  stopVideos();
  sim.mode = 'live';
  sim.ctl = ctl;
  sim.t = 0;
  sim.env.reset(layout || randomLayout(app.rng, app.spread), D.jitterStart(app.rng));
  ctl.reset(sim.env);
  setPlaying(true);
}

function hud() {
  const env = sim.env;
  const who = sim.mode === 'replay' ? `${app.current.source === 'lightwheel' ? 'Lightwheel demo' : app.current.source === 'synthetic' ? 'Synthetic demo' : 'Your demo'} #${app.current.index + 1}` : sim.mode === 'live' ? sim.ctl.name : sim.mode === 'teleop' ? 'You (teleop' + (teleop.rec ? ', recording' : '') + ')' : 'Idle';
  $('hud-who').innerHTML = `<b>${who}</b>`;
  let phase = '';
  if (sim.mode === 'live') phase = sim.ctl.phase || (sim.ctl.goal ? (sim.ctl.goal.kind === 'orange' ? `reach orange ${sim.ctl.goal.orange + 1}` : sim.ctl.goal.kind === 'plate' ? 'carry to plate' : 'return home') : '');
  else if (env.held >= 0) phase = `holding orange ${env.held + 1}`;
  $('hud-phase').textContent = phase;
  $('hud-oranges').innerHTML = `oranges on plate <b>${env.placedCount()}/3</b>${env.success() ? ' · <b>success</b>' : ''}`;
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

// ---- chapters --------------------------------------------------------------------------------------
function setChapter(ch) {
  if (!['world', 'demos', 'train', 'eval'].includes(ch)) ch = 'world';
  if (evalRun && ch !== 'eval') stopEval();
  app.chapter = ch;
  for (const s of document.querySelectorAll('#panel section')) s.hidden = s.dataset.chapter !== ch;
  for (const b of document.querySelectorAll('#steps button')) b.classList.toggle('on', b.dataset.step === ch);
  $('panel').scrollTop = 0;
  world.showHighlight(null);
  if (teleop.on && ch !== 'demos') stopTeleop();
  if (ch !== 'demos') stopVideos();
  stage.idleSway = ch === 'world';
  if (ch === 'world') { stage.flyTo(VIEWS.world); }
  if (ch === 'demos') { stage.flyTo(VIEWS.work); if (!app.current || sim.mode !== 'replay') selectEpisode(app.demos[app.src][0] || app.demos.lightwheel[0]); renderEpList(); }
  if (ch === 'train') { stage.flyTo(VIEWS.work); refreshTrainCounts(); }
  if (ch === 'eval') { stage.flyTo(VIEWS.work); refreshPolicySelect(); renderBoard(); }
  const u = new URL(location.href);
  u.searchParams.set('step', ch);
  history.replaceState(null, '', u);
}

function buildUI() {
  for (const b of document.querySelectorAll('#steps button')) b.addEventListener('click', () => setChapter(b.dataset.step));
  $('intro-go').addEventListener('click', () => { $('intro').hidden = true; store.set('introSeen', true); });
  $('help').addEventListener('click', () => { $('intro').hidden = false; });
  $('depth').addEventListener('input', (e) => { stage.depthGain = +e.target.value; });

  // world
  for (const c of CATALOG) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c.name;
    b.dataset.id = c.id;
    b.addEventListener('click', () => showAsset(c.id));
    $('catalog').appendChild(b);
  }
  $('dr-shuffle').addEventListener('click', randomise);
  $('dr-spread').addEventListener('change', (e) => { app.spread = +e.target.value; });
  for (const L of LIGHTING) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = L.name;
    b.dataset.id = L.id;
    b.classList.toggle('on', L.id === 'studio');
    b.addEventListener('click', () => { world.setLighting(L.id); for (const x of $('lighting').children) x.classList.toggle('on', x.dataset.id === L.id); });
    $('lighting').appendChild(b);
  }

  // demos
  $('ds-link').href = D.DATASET.url;
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => {
    app.src = b.dataset.src;
    for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x === b);
    renderEpList();
    if (app.demos[app.src][0]) selectEpisode(app.demos[app.src][0]);
  });
  $('rp-play').addEventListener('click', () => {
    if (sim.mode !== 'replay') { if (app.current) selectEpisode(app.current); return; }
    if (sim.t >= app.current.n) seekTo(0);
    setPlaying(!sim.playing);
  });
  $('rp-seek').addEventListener('input', (e) => seekTo(+e.target.value));
  $('rp-speed').addEventListener('change', (e) => { sim.speed = +e.target.value; for (const v of [$('v-front'), $('v-wrist')]) v.playbackRate = sim.speed; });
  $('gen-syn').addEventListener('click', generateSynthetic);
  $('teleop').addEventListener('click', () => (teleop.on ? stopTeleop() : startTeleop()));
  for (const b of $('teleop-pad').querySelectorAll('button')) {
    const k = b.dataset.k;
    if (k === 'Space' || k === 'Enter' || k === 'Escape') b.addEventListener('click', () => teleopKey(k));
    else {
      b.addEventListener('pointerdown', () => teleop.keys.add(k));
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => teleop.keys.delete(k));
    }
  }
  jointChart = new LineChart($('joint-chart'), { xLabel: 's', yMin: -100, yMax: 100 });
  $('joint-legend').innerHTML = JOINTS.map((j, i) => `<span><span class="sw s${i + 1}"></span>${j.replace('_', ' ')}</span>`).join('');

  // train
  lossChart = new LineChart($('loss-chart'), { log: true, xLabel: 'epoch', empty: 'train to see the loss curves' });
  daggerChart = new LineChart($('dagger-chart'), { yMin: 0, yMax: 1, xMin: 0, xLabel: 'DAgger round', fmt: (v) => `${Math.round(v * 100)}%`, empty: 'DAgger results appear here' });
  $('train-bc').addEventListener('click', () => trainBC());
  $('train-dagger').addEventListener('click', () => trainDagger());
  $('train-stop').addEventListener('click', () => { stopTraining = true; trainer?.postMessage({ type: 'stop' }); });
  $('watch').addEventListener('click', () => { const m = app.models[app.models.length - 1]; if (m) { stage.flyTo(VIEWS.work); runLive(new PolicyController(m.model, m.name)); } });

  // eval
  $('ev-run').addEventListener('click', runEval);
  $('ev-back').addEventListener('click', stopEval);
  $('board-clear').addEventListener('click', () => { app.board = []; store.set('board', []); renderBoard(); });

  addEventListener('keydown', onKey);
  addEventListener('keyup', (e) => teleop.keys.delete(e.code));
}

// ---- 1 · world -------------------------------------------------------------------------------------
function showAsset(id) {
  const c = CATALOG.find((x) => x.id === id);
  if (!c) return;
  for (const b of $('catalog').children) b.classList.toggle('on', b.dataset.id === id);
  world.showHighlight(id);
  const box = world.frameOf(id);
  const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
  stage.flyTo({ target: centre, dist: Math.min(3, Math.max(0.45, Math.max(size.x, size.y, size.z) * 2.2)), radius: Math.max(0.2, Math.max(size.x, size.y, size.z) * 0.7) });
  let tris = 0;
  for (const n of world.catalogNodes[id] || []) n.traverse((o) => { if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  const card = $('asset-card');
  card.hidden = false;
  card.innerHTML = `<div class="kind">${c.kind}</div><h4>lightwheel_${c.id}</h4><p class="small" style="margin:4px 0 0">${c.name}. ${c.note}</p>
    <dl><dt>Source</dt><dd><a href="https://huggingface.co/LightwheelAI/leisaac_env/tree/main/assets/${c.src.replace(/\/[^/]*$/, '')}" target="_blank" rel="noopener">leisaac_env/assets/${c.src}</a></dd>
    <dt>Size</dt><dd>${(size.x * 100).toFixed(0)} × ${(size.z * 100).toFixed(0)} × ${(size.y * 100).toFixed(0)} cm</dd>
    <dt>Triangles</dt><dd>${Math.round(tris).toLocaleString()} (simplified for the web)</dd></dl>`;
}

function onTap(e) {
  if (app.chapter !== 'world' || evalRun) return;
  const rc = new THREE.Raycaster();
  stage.cam.updateMatrixWorld();
  rc.setFromCamera(stage.ndc(e), stage.cam);
  const id = world.pick(rc);
  if (id) showAsset(id);
}

function randomise() {
  stopVideos();
  const layout = randomLayout(app.rng, app.spread);
  sim.mode = 'idle';
  setPlaying(false);
  sim.env.reset(layout, START_MOTOR);
  const d = layout.oranges.map((o, i) => Math.hypot(o[0] - ORANGE_HOME[i][0], o[1] - ORANGE_HOME[i][1]) * 100);
  $('dr-note').textContent = `Oranges moved ${d.map((v) => v.toFixed(1)).join(', ')} cm; plate ${(Math.hypot(layout.plate[0] - PLATE_HOME[0], layout.plate[1] - PLATE_HOME[1]) * 100).toFixed(1)} cm.`;
  stage.flyTo(VIEWS.work);
}

// ---- 2 · demonstrations ----------------------------------------------------------------------------
let jointChart, lossChart, daggerChart;

function renderEpList() {
  const list = $('ep-list');
  list.innerHTML = '';
  const eps = app.demos[app.src];
  for (const k of Object.keys(app.demos)) $('n-' + k).textContent = app.demos[k].length;
  if (!eps.length) {
    list.innerHTML = `<div class="empty">${app.src === 'synthetic' ? 'None yet: generate some below.' : 'None yet: teleoperate below.'}</div>`;
    return;
  }
  eps.forEach((e) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `${e.index + 1}<i class="${e.labels.success ? 'ok' : e.labels.placedEnd ? 'part' : ''}"></i>`;
    b.title = `${(e.n / 30).toFixed(1)} s · ${e.labels.placedEnd}/3 placed in replay`;
    b.classList.toggle('on', e === app.current);
    b.addEventListener('click', () => selectEpisode(e));
    list.appendChild(b);
  });
}

function selectEpisode(e) {
  if (!e) return;
  if (teleop.on) stopTeleop();
  app.current = e;
  sim.mode = 'replay';
  sim.ctl = new ReplayController(e);
  sim.env.reset(e.layout, e.s.subarray(0, 6));
  sim.t = 0;
  $('rp-seek').max = String(e.n - 1);
  const L = e.labels;
  const grasps = L.events.filter((v) => v.type === 'grasp').length;
  $('rp-meta').innerHTML = `${e.source === 'lightwheel' ? 'Lightwheel teleop' : e.source === 'synthetic' ? 'Synthetic (state machine)' : 'Your teleop'} episode ${e.index + 1} · ${(e.n / 30).toFixed(1)} s · ${e.n} frames<br>`
    + `${grasps} grasp${grasps === 1 ? '' : 's'} · ${L.placedEnd}/3 on the plate at the end${L.success ? ' and back at rest: <b>success</b>' : ''}`
    + (e.source === 'lightwheel' ? `<br>Layout recovered from the demo itself: ${e.layout.recovered}/3 oranges found where the gripper closed.` : '');
  // joint traces
  const step = Math.max(1, Math.floor(e.n / 400));
  jointChart.o.yMin = -100; jointChart.o.yMax = 100;
  jointChart.set(JOINTS.map((j, k) => ({ points: Array.from({ length: Math.ceil(e.n / step) }, (_, i) => [i * step / 30, e.s[i * step * 6 + k]]), color: SERIES[k], width: 1.2 })));
  jointChart.setMarkers(L.events.map((v) => ({ x: v.t / 30, color: v.type === 'grasp' ? '--good' : '--warn' })));
  // Lightwheel's own camera renders of this episode
  const vids = [$('v-front'), $('v-wrist')];
  $('videos').hidden = e.source !== 'lightwheel';
  if (e.source === 'lightwheel') {
    vids[0].src = D.DATASET.video(e.index, 'front');
    vids[1].src = D.DATASET.video(e.index, 'wrist');
    for (const v of vids) { v.playbackRate = sim.speed; v.currentTime = 0; }
  } else stopVideos();
  renderEpList();
  setPlaying(true);
}

function seekTo(t) {
  const e = app.current;
  if (!e || sim.mode !== 'replay') return;
  // replay from the start to rebuild the object state up to t
  sim.env.reset(e.layout, e.s.subarray(0, 6));
  for (let u = 0; u <= t; u++) { sim.env.t = u; sim.env.setMotor(e.s.subarray(u * 6, u * 6 + 6)); sim.env.physics(1 / 30); }
  sim.t = t + 1;
  for (const v of [$('v-front'), $('v-wrist')]) if (v.src) v.currentTime = t / 30;
}

let lastSync = 0;
function syncReplayUI() {
  const t = Math.min(sim.t, app.current.n - 1);
  if (document.activeElement !== $('rp-seek')) $('rp-seek').value = String(t);
  jointChart.setCursor(t / 30);
  const now = performance.now();
  if (now - lastSync > 400) {
    lastSync = now;
    for (const v of [$('v-front'), $('v-wrist')]) if (v.src && v.readyState >= 2 && Math.abs(v.currentTime - t / 30) > 0.25) v.currentTime = t / 30;
  }
}

function stopVideos() {
  for (const v of [$('v-front'), $('v-wrist')]) { v.pause(); }
}

async function generateSynthetic() {
  const btn = $('gen-syn');
  btn.disabled = true;
  const start = app.demos.synthetic.length;
  for (let i = 0; i < 20; i++) {
    btn.textContent = `Generating ${i + 1}/20…`;
    const [e] = D.generateSynthetic(1, { seed: 1000 + start + i, spread: app.spread });
    if (e) {
      e.index = app.demos.synthetic.length;
      e.labels = D.replayLabels(e);
      app.demos.synthetic.push(e);
    }
    await nextFrame();
  }
  btn.textContent = 'Generate 20 more';
  btn.disabled = false;
  app.src = 'synthetic';
  for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x.dataset.src === 'synthetic');
  renderEpList();
  selectEpisode(app.demos.synthetic[start]);
  toast(`20 synthetic demos from Lightwheel's state machine (${app.demos.synthetic.length} total)`);
}

// teleop
const teleop = { on: false, keys: new Set(), rec: null };
function startTeleop() {
  stopVideos();
  teleop.on = true;
  sim.mode = 'teleop';
  sim.ctl = new TeleopController();
  sim.t = 0;
  sim.env.reset(randomLayout(app.rng, app.spread), START_MOTOR);
  sim.ctl.reset(sim.env);
  teleop.rec = { s: [], a: [], layout: { oranges: sim.env.oranges.map((o) => [o.p.x, o.p.y]), plate: [sim.env.plate.x, sim.env.plate.y], recovered: 3 } };
  $('teleop').textContent = 'Stop teleop';
  $('teleop').classList.add('on');
  $('teleop-pad').hidden = false;
  stage.flyTo(VIEWS.close);
  setPlaying(true);
  toast('Teleop: put all three oranges on the plate, then press Enter to save the demo');
}
function stopTeleop() {
  teleop.on = false;
  teleop.keys.clear();
  $('teleop').textContent = 'Teleoperate';
  $('teleop').classList.remove('on');
  $('teleop-pad').hidden = true;
  if (sim.mode === 'teleop') { sim.mode = 'idle'; setPlaying(false); }
}
const _f = new THREE.Vector3();
function teleopStep() {
  const c = sim.ctl, env = sim.env, k = teleop.keys;
  // move relative to the view: forward is away from the camera along the counter
  stage.cam.getWorldDirection(_f);
  const fx = _f.x, fy = -_f.z, n = Math.hypot(fx, fy) || 1;
  const F = [fx / n, fy / n], Rt = [F[1], -F[0]], v = 0.0045;
  const dx = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0), dr = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0), dz = (k.has('KeyR') ? 1 : 0) - (k.has('KeyF') ? 1 : 0);
  c.target.x += (F[0] * dx + Rt[0] * dr) * v;
  c.target.y += (F[1] * dx + Rt[1] * dr) * v;
  c.target.z = Math.max(0.93, Math.min(1.25, c.target.z + dz * v));
  // keep the target within reach
  c.target.x = Math.max(1.95, Math.min(2.6, c.target.x));
  c.target.y = Math.max(-0.62, Math.min(-0.12, c.target.y));
  c.roll += ((k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0)) * 0.04;
  c.act(env, sim.act);
  for (let j = 0; j < 6; j++) { teleop.rec.s.push(env.motor[j]); teleop.rec.a.push(sim.act[j]); }
  env.step(sim.act);
  sim.t++;
  if (sim.t > 30 * 120) teleopKey('Enter');
}
function teleopKey(code) {
  if (!teleop.on) return;
  if (code === 'Space') sim.ctl.grip = sim.ctl.grip > 20 ? 0 : 45;
  if (code === 'Escape') stopTeleop();
  if (code === 'Enter') {
    const r = teleop.rec;
    const n = r.s.length / 6;
    if (n < 60) { toast('Too short to keep'); return; }
    const e = { id: `yours-${Date.now()}`, index: app.demos.yours.length, source: 'yours', n, s: Float32Array.from(r.s), a: Float32Array.from(r.a), layout: r.layout };
    e.labels = D.replayLabels(e);
    app.demos.yours.push(e);
    store.set('yours', app.demos.yours.slice(-12).map((x) => ({ id: x.id, index: x.index, source: 'yours', n: x.n, s: Array.from(x.s, (v) => Math.round(v * 100) / 100), a: Array.from(x.a, (v) => Math.round(v * 100) / 100), layout: x.layout })));
    toast(`Saved your demo #${e.index + 1}: ${sim.env.placedCount()}/3 on the plate${sim.env.success() ? ', success' : ''}`);
    stopTeleop();
    app.src = 'yours';
    for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x.dataset.src === 'yours');
    renderEpList();
  }
}

function onKey(e) {
  if (e.target.matches?.('input, select, textarea')) return;
  if (teleop.on) {
    if (['Space', 'Enter', 'Escape'].includes(e.code)) { e.preventDefault(); teleopKey(e.code); return; }
    teleop.keys.add(e.code);
    return;
  }
  if (e.code === 'Space' && sim.mode !== 'idle') { e.preventDefault(); setPlaying(!sim.playing); }
  if (e.key === '?') $('intro').hidden = !$('intro').hidden;
  if (/^Digit[1-4]$/.test(e.code)) setChapter(['world', 'demos', 'train', 'eval'][+e.code.slice(5) - 1]);
}

// ---- 3 · train -----------------------------------------------------------------------------------
let trainer = null, stopTraining = false, training = false;

function refreshTrainCounts() {
  for (const k of ['lightwheel', 'synthetic', 'yours']) {
    const eps = app.demos[k];
    $('d-' + k).textContent = `${eps.length} episodes · ${(eps.reduce((s, e) => s + e.n, 0) / 30 / 60).toFixed(1)} min`;
  }
  $('train-dagger').disabled = training;
}

function selectedEpisodes() {
  const eps = [];
  if ($('use-lightwheel').checked) eps.push(...app.demos.lightwheel);
  if ($('use-synthetic').checked) eps.push(...app.demos.synthetic);
  if ($('use-yours').checked) eps.push(...app.demos.yours);
  return eps;
}

function trainOnce(ds, valEps, cfg, onEpoch) {
  trainer = trainer || new Worker(new URL('./train-worker.js', import.meta.url));
  return new Promise((res) => {
    trainer.onmessage = (m) => {
      if (m.data.type === 'epoch') onEpoch?.(m.data);
      else res(m.data.model);
    };
    trainer.postMessage({ type: 'train', X: ds.X, Y: ds.Y, epOf: ds.epOf, valEps, dim: ds.dim, outDim: ds.outDim, cfg });
  });
}

let lossSeries = [];
function plotLoss(run, ep, train, val) {
  let s = lossSeries[run];
  if (!s) s = lossSeries[run] = { train: [], val: [] };
  if (train != null) s.train.push([ep, train]);
  if (val != null) s.val.push([ep, val]);
  lossChart.set(lossSeries.flatMap((r, i) => [{ points: r.train, color: '--s1', width: i === lossSeries.length - 1 ? 1.8 : 1 }, { points: r.val, color: '--s2', width: i === lossSeries.length - 1 ? 1.8 : 1 }]));
}

async function trainBC({ quiet = false } = {}) {
  if (training) return null;
  const eps = selectedEpisodes();
  if (!eps.length) { $('train-status').textContent = 'Pick at least one dataset.'; return null; }
  training = true;
  stopTraining = false;
  setTrainButtons(true);
  $('train-status').textContent = `Preparing ${eps.length} episodes…`;
  await nextFrame();
  const ds = D.buildDataset(eps, { curate: $('curate').checked });
  const valEps = eps.map((e, i) => i).filter((i) => i % 10 === 3);
  const cfg = { hidden: +$('hidden').value, layers: 2, epochs: +$('epochs').value, lr: 2e-3, batch: 128, seed: 1 };
  if (!quiet) lossSeries = [];
  const run = lossSeries.length;
  $('train-status').innerHTML = `Training on <b>${ds.rows.toLocaleString()}</b> frames${ds.dropped ? ` (${ds.dropped.toLocaleString()} idle frames dropped)` : ''}, ${valEps.length} episodes held out…`;
  const model = await trainOnce(ds, valEps, cfg, (m) => {
    plotLoss(run, m.epoch, m.epoch ? m.train : null, m.val);
    if (m.epoch) $('train-status').innerHTML = `Epoch <b>${m.epoch}/${cfg.epochs}</b> · train ${m.train.toFixed(4)} · val ${m.val?.toFixed(4) ?? '–'} · ${(m.ms / 1000).toFixed(1)} s/epoch`;
  });
  const by = D.datasetStats(eps).by;
  const entry = addModel(model, `BC · ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(' + ')}`, { ds, eps });
  training = false;
  setTrainButtons(false);
  const q = quickEval(model, 10, 7);
  $('train-status').innerHTML = `Trained <b>${entry.name}</b>. Quick check on 10 new layouts: <b>${q.success}/10</b> succeed, ${q.placed.toFixed(1)} oranges placed on average.`;
  if (!quiet) daggerChart.set([{ points: [[0, q.success / 10]], color: '--s3', dots: true }]);
  entry.quick = q;
  return entry;
}

async function trainDagger() {
  if (training) return;
  let base = app.models[app.models.length - 1];
  if (!base || !base.ds) { base = await trainBC(); if (!base) return; }
  training = true;
  stopTraining = false;
  setTrainButtons(true);
  let ds = base.ds, model = base.model;
  const eps = base.eps;
  const valEps = eps.map((e, i) => i).filter((i) => i % 10 === 3);
  const cfg = { hidden: +$('hidden').value, layers: 2, epochs: +$('epochs').value, lr: 2e-3, batch: 128, seed: 1 };
  const pts = [[0, (base.quick || quickEval(model, 10, 7)).success / 10]];
  daggerChart.set([{ points: pts, color: '--s3', dots: true }]);
  for (let r = 0; r < 3 && !stopTraining; r++) {
    const beta = 0.5 * 0.5 ** r;
    $('train-status').innerHTML = `DAgger round <b>${r + 1}/3</b>: running the policy (expert takes over ${Math.round(beta * 100)}% of steps) and asking the expert for labels…`;
    // run the rollouts in visible slices so the page stays live
    const add = { X: [], Y: [], rows: 0 };
    for (let k = 0; k < 4; k++) {
      await nextFrame();
      const part = D.daggerRound(model, { episodes: 3, beta, seed: 300 + r * 10 + k, spread: app.spread });
      add.X.push(part.X); add.Y.push(part.Y); add.rows += part.rows;
    }
    const merged = { X: concatF32(add.X), Y: concatF32(add.Y), rows: add.rows };
    ds = D.concatRows(ds, merged);
    $('train-status').innerHTML = `DAgger round <b>${r + 1}/3</b>: retraining on ${ds.rows.toLocaleString()} frames (+${merged.rows.toLocaleString()} expert-labelled)…`;
    const run = lossSeries.length;
    model = await trainOnce(ds, valEps, cfg, (m) => plotLoss(run, m.epoch, m.epoch ? m.train : null, m.val));
    const q = quickEval(model, 10, 7);
    pts.push([r + 1, q.success / 10]);
    daggerChart.set([{ points: pts, color: '--s3', dots: true }]);
  }
  const entry = addModel(model, `${base.name} + DAgger ×3`, { ds, eps });
  const q = quickEval(model, 10, 7);
  entry.quick = q;
  training = false;
  setTrainButtons(false);
  $('train-status').innerHTML = `Trained <b>${entry.name}</b>. Quick check on 10 new layouts: <b>${q.success}/10</b> succeed (${q.placed.toFixed(1)} placed on average). Score it properly in Evaluate.`;
}

function concatF32(parts) {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function setTrainButtons(busy) {
  $('train-bc').disabled = busy;
  $('train-dagger').disabled = busy;
  $('train-stop').hidden = !busy;
  $('watch').disabled = busy || !app.models.length;
}

/** Headless check: n random layouts, no rendering. */
function quickEval(model, n, seed) {
  const env = new PickOrangeEnv(), R = mulberry32(seed), act = new Float64Array(6);
  let success = 0, placed = 0;
  for (let i = 0; i < n; i++) {
    const ctl = new PolicyController(model);
    ctl.reset();
    env.reset(randomLayout(R, app.spread), D.jitterStart(R));
    for (let t = 0; t < 1200; t++) { ctl.act(env, act); env.step(act); if (env.success()) break; }
    if (env.success()) success++;
    placed += env.placedCount();
  }
  return { success, placed: placed / n };
}

let modelSeq = 0;
function addModel(model, name, extra = {}) {
  const entry = { id: `m${Date.now()}-${modelSeq++}`, name, model, ...extra };
  app.models.push(entry);
  if (app.models.length > 6) app.models.shift();
  store.set('models', app.models.slice(-3).map((m) => ({ id: m.id, name: m.name, model: serialiseModel(m.model) })));
  $('watch').disabled = false;
  refreshPolicySelect();
  return entry;
}
function serialiseModel(m) { return { sizes: m.sizes, mean: Array.from(m.mean), std: Array.from(m.std), W: m.W.map((w) => Array.from(w, (v) => +v.toPrecision(6))), b: m.b.map((b) => Array.from(b)) }; }
function reviveModel(m) {
  const model = { sizes: m.model.sizes, mean: Float32Array.from(m.model.mean), std: Float32Array.from(m.model.std), W: m.model.W.map((w) => Float32Array.from(w)), b: m.model.b.map((b) => Float32Array.from(b)) };
  return { id: m.id, name: m.name, model };
}

// ---- 4 · evaluate ----------------------------------------------------------------------------------
let evalRun = null;

function refreshPolicySelect() {
  const sel = $('ev-policy');
  const prev = sel.value;
  sel.innerHTML = '<option value="expert">Lightwheel state machine (expert)</option>' + app.models.slice().reverse().map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  else if (app.models.length) sel.value = app.models[app.models.length - 1].id;
}

function makeController(id) {
  if (id === 'expert') return () => new ScriptedExpert();
  const m = app.models.find((x) => x.id === id);
  return () => new PolicyController(m.model, m.name);
}

function runEval() {
  const id = $('ev-policy').value;
  const N = +$('ev-n').value, spread = +$('ev-spread').value;
  const name = id === 'expert' ? 'Lightwheel state machine' : app.models.find((m) => m.id === id)?.name;
  const grid = world.buildGrid(9);
  setPlaying(false);
  stopVideos();
  world.setMode('grid');
  stage.idleSway = false;
  stage.flyTo({ target: grid.centre, dist: 2.05, yaw: 0.25, pitch: 0.95, radius: 0.9 });
  const R = mulberry32(2024 + spread); // the same layouts for every policy, so scores compare
  evalRun = { id, name, make: makeController(id), N, spread, R, done: [], batch: 0, slots: [], acc: 0, t0: performance.now() };
  startBatch();
  $('ev-run').disabled = true;
  $('ev-back').hidden = false;
  $('ev-result').hidden = true;
}

function startBatch() {
  const r = evalRun;
  r.slots = [];
  const left = r.N - r.done.length;
  r.grid = world.grid;
  r.grid.views.forEach((v, i) => {
    v.root.parent.visible = i < left;
    if (i >= left) return;
    const env = new PickOrangeEnv().reset(randomLayout(r.R, r.spread), D.jitterStart(r.R));
    const ctl = r.make();
    ctl.reset(env);
    v.badge.material.color.setHex(0x334155);
    r.slots.push({ env, ctl, view: v, t: 0, over: false, act: new Float64Array(6) });
  });
}

function evalTick(dt) {
  const r = evalRun;
  r.acc += dt * 30 * 4; // 4x real time
  let n = Math.min(24, Math.floor(r.acc));
  r.acc -= n;
  while (n-- > 0) {
    let running = 0;
    for (const s of r.slots) {
      if (s.over) continue;
      s.ctl.act(s.env, s.act);
      s.env.step(s.act);
      s.t++;
      const ok = s.env.success();
      if (ok || s.t >= 1200 || s.ctl.done?.(s.env)) {
        s.over = true;
        r.done.push({ success: ok, placed: s.env.placedCount(), t: s.t, sub: s.env.subtasks() });
        s.view.badge.material.color.setHex(ok ? 0x22c55e : s.env.placedCount() ? 0xf59e0b : 0xef4444);
      } else running++;
    }
    if (!running) {
      if (r.done.length >= r.N) { finishEval(); return; }
      startBatch();
      break;
    }
  }
  for (const s of r.slots) s.view.update(s.env);
  const ok = r.done.filter((d) => d.success).length;
  $('ev-status').innerHTML = `<b>${r.name}</b>: ${r.done.length}/${r.N} episodes done · ${ok} succeeded`;
  $('hud-who').innerHTML = `<b>Evaluating</b>`;
  $('hud-phase').textContent = `${r.name}`;
  $('hud-oranges').innerHTML = `episodes <b>${r.done.length}/${r.N}</b> · success <b>${ok}</b>`;
  $('hud-t').textContent = '4× speed';
}

function finishEval() {
  const r = evalRun;
  const N = r.done.length, ok = r.done.filter((d) => d.success);
  const rate = ok.length / N, placed = r.done.reduce((s, d) => s + d.placed, 0) / N;
  const time = ok.length ? ok.reduce((s, d) => s + d.t, 0) / ok.length / 30 : null;
  const sub = [0, 1, 2].map((i) => ({ pick: r.done.filter((d) => d.sub[i].picked).length / N, put: r.done.filter((d) => d.sub[i].placed).length / N }));
  const res = $('ev-result');
  res.hidden = false;
  res.innerHTML = `<div class="kind">Result · ${N} episodes · layouts ±${r.spread * 3} cm</div><h4>${r.name}</h4>
    <div class="grid2"><div><div class="big">${Math.round(rate * 100)}%</div><div class="small">task success (task_done)</div></div>
    <div><div class="big">${placed.toFixed(2)}</div><div class="small">oranges on the plate per episode</div></div></div>
    <table style="margin-top:8px"><thead><tr><th>Subtask</th><th class="num">Rate</th></tr></thead><tbody>
    ${sub.map((s, i) => `<tr><td>pick_orange00${i + 1}</td><td class="num">${Math.round(s.pick * 100)}%</td></tr><tr><td>put_orange00${i + 1}_to_plate</td><td class="num">${Math.round(s.put * 100)}%</td></tr>`).join('')}
    </tbody></table><p class="small">${time ? `Successful episodes took ${time.toFixed(1)} s on average.` : 'No episode succeeded.'}</p>`;
  app.board.push({ name: r.name, rate, placed, time, N, spread: r.spread, at: Date.now() });
  app.board.sort((a, b) => b.rate - a.rate || b.placed - a.placed);
  app.board = app.board.slice(0, 12);
  store.set('board', app.board);
  renderBoard();
  $('ev-status').innerHTML = `Done: <b>${ok.length}/${N}</b> succeeded.`;
  evalRun.finished = true;
  $('ev-run').disabled = false;
}

function stopEval() {
  if (!evalRun) return;
  evalRun = null;
  world.setMode('kitchen');
  $('ev-run').disabled = false;
  $('ev-back').hidden = true;
  stage.flyTo(VIEWS.work);
}

function renderBoard() {
  const tb = $('board').querySelector('tbody');
  if (!app.board.length) { tb.innerHTML = '<tr><td colspan="4" class="small">Run an evaluation to rank a policy.</td></tr>'; return; }
  tb.innerHTML = app.board.map((b) => `<tr><td>${b.name}<div class="small">${b.N} ep · ±${b.spread * 3} cm</div></td><td class="num">${Math.round(b.rate * 100)}%<div class="bar"><i style="width:${b.rate * 100}%"></i></div></td><td class="num">${b.placed.toFixed(2)}</td><td class="num">${b.time ? b.time.toFixed(1) + ' s' : '–'}</td></tr>`).join('');
}

boot().catch((e) => {
  console.error(e);
  $('load-msg').textContent = 'Could not load: ' + (e.message || e);
});
