// Future Grids Training: boot, render loop, input, panels, attract mode.
//
// 3D: one persistent woven canvas (DisplayXR inline-3D, display rig). The diorama is the SUBJECT:
// the user turns and zooms it under a fixed portal, and the runtime places the eyes. In any other
// browser the same scene renders mono, so the page also works as a plain 2D demo.
//
// Three 3D modules share that canvas: the grid map, the substation twin and the microgrid yard.
// A depth slider applies to all of them (see applyDepth).

import * as THREE from 'three';
import { createInline3D, inline3dViewRigSupported } from '@displayxr/inline3d';
import { EdgeFeather, displayRig } from '@displayxr/inline3d/three';
import { api, initApi, engine } from './api.js';
import { GridScene, MAP_W, MAP_D } from './scene.js';
import { SubstationTwin, TWIN_ITEMS } from './twin.js';
import { MicrogridTwin, MG_ITEMS } from './microgrid.js';
import { initTextures } from './textures.js';
import { OneLine } from './oneline.js';
import { T } from './theme.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const ATTRACT_AFTER_MS = (Number(params.get('attract')) || 60) * 1000;
const VDH = 0.3;                         // virtual display height (m) the scene is composed for

let net, cards, state = null, view = 'map', selected = null;
let lastInput = performance.now(), attract = false, attractCaption = 0;
let lastToastT = 0, debriefShown = false, lastStepShown = -1;

// Each module's default pose. tilt 0 = eye level, PI/2 = straight down.
const VIEWS = {
  map: { tilt: 0.98, yaw: -0.18, label: 'Grid map' },
  twin: { tilt: 0.62, yaw: -0.35, label: 'Substation twin' },
  mg: { tilt: 0.7, yaw: -0.25, label: 'Microgrid yard' },
};
// Camera presets, the same in every module.
const ANGLES = {
  overview: (v) => ({ tilt: VIEWS[v].tilt, yaw: VIEWS[v].yaw, zoom: 1 }),
  eye: (v) => ({ tilt: 0.16, yaw: VIEWS[v].yaw, zoom: v === 'map' ? 1.9 : 1.45 }),
  top: (v) => ({ tilt: 1.45, yaw: 0, zoom: 1 }),
};
// Ids that appear in both a module and the one-line: one-line clicks select the module's version.
const ALIAS = {
  twin: { BKR_F1: 'twin_f1', BKR_F2: 'twin_f2', XFMR: 'twin_xfmr', TL1: 'twin_line', sub_lv: 'twin_bus', sub_hv: 'twin_line' },
  mg: { PCC: 'mg_pcc', bess: 'mg_bess', pv_mg: 'mg_pv', mg: 'mg_bus', ld_hosp: 'ld_hosp' },
};
const MG_DEVICES = new Set(['mg', 'bess', 'pv_mg', 'PCC', 'ld_hosp', 'ld_fire', 'ld_water']);
const SUB_DEVICES = new Set(['XFMR', 'sub_lv', 'sub_hv']);

// ---- 3D setup ----------------------------------------------------------------------------------
const canvas = $('#grid3d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(1);              // getViewport() is in backing-store pixels (see hello-cube)
renderer.autoClear = false;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;  // rendered once per frame, shared by both eyes
initTextures(THREE);
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xcfdcff, 0x2a2620, 0.5));
scene.environment = skyEnvironment();

// depthGroup stretches the scene along the viewing axis (the depth slider); subject is turned and
// scaled by the user; stage holds the current module. The sun rides on the subject so lighting and
// shadows stay fixed to the model however it is turned.
const depthGroup = new THREE.Group();
scene.add(depthGroup);
const subject = new THREE.Group();
depthGroup.add(subject);
const stage = new THREE.Group();
subject.add(stage);
const sun = new THREE.DirectionalLight(0xfff4e0, 1.5);
sun.position.set(-0.45, 1.1, 0.65);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0003;
subject.add(sun, sun.target);
const pose = { yaw: -0.18, tilt: 0.98, zoom: 1, yawTarget: -0.18, tiltTarget: 0.98 };

// A soft sky for image-based lighting: blue above, warm ground below, a bright sun patch. Gives
// metal and glass something to reflect without loading an HDR file.
function skyEnvironment() {
  const env = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 48, 24);
  const pos = geo.attributes.position, cols = [];
  const zenith = new THREE.Color(0x5577a0), horizon = new THREE.Color(0xb9c8d8), ground = new THREE.Color(0x4a443a);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 10;
    const c = y >= 0 ? horizon.clone().lerp(zenith, Math.pow(y, 0.6)) : horizon.clone().lerp(ground, Math.min(1, -y * 3));
    cols.push(c.r * 0.8, c.g * 0.8, c.b * 0.8);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  env.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const disc = new THREE.Mesh(new THREE.SphereGeometry(0.8, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 5.6, 4.8) }));
  disc.position.set(-4, 7, 5);
  env.add(disc);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(env, 0.02).texture;
  pm.dispose();
  return tex;
}

// ---- depth slider ------------------------------------------------------------------------------
// 0-200%. Below 100% the eyes move closer together (the runtime's comfort dial on the display rig:
// ipdFactor in [0, 1]). Above 100% the scene itself is stretched along the viewing axis, so the same
// eye separation shows more depth. On a browser without view-rig support the stretch does both.
const DEPTH_KEY = 'energyGrid.depth';
let depth = 1, handle = null, rigOK = false;
try {
  const saved = parseFloat(localStorage.getItem(DEPTH_KEY));
  if (saved >= 0 && saved <= 2) depth = saved;
} catch { /* storage blocked: default depth */ }

function rigFor(d) {
  return displayRig({ virtualDisplayHeight: VDH, ipdFactor: Math.min(1, d), parallaxFactor: 1 });
}

function setDepth(d) {
  depth = Math.round(Math.min(2, Math.max(0, d)) * 20) / 20;
  try { localStorage.setItem(DEPTH_KEY, String(depth)); } catch { /* fine without */ }
  applyDepth();
}

function applyDepth() {
  const stretch = !sbsMode ? 1 : rigOK ? Math.max(1, depth) : Math.max(0.06, depth);
  depthGroup.scale.set(1, 1, stretch);
  if (handle && rigOK) handle.setViewRig(rigFor(depth));
  const slider = $('#depth');
  slider.value = String(Math.round(depth * 100));
  slider.disabled = !sbsMode;
  $('#depth-val').textContent = `${Math.round(depth * 100)}%`;
  $('#depth-wrap').title = sbsMode
    ? 'How much the 3D view pops out of and recedes into the display. 100% is true to scale. Keys: [ and ]'
    : 'Depth applies on a glasses-free 3D display (DisplayXR Browser)';
  frameShadow();
}
$('#depth').addEventListener('input', (e) => { touch(); setDepth(Number(e.target.value) / 100); });

const eyeCam = new THREE.PerspectiveCamera();
eyeCam.matrixAutoUpdate = false;
const pickCam = new THREE.PerspectiveCamera();
pickCam.matrixAutoUpdate = false;
let havePickCam = false;
const monoCam = new THREE.PerspectiveCamera(2 * Math.atan(VDH / 2 / 0.55) * 180 / Math.PI, 1.6, 0.01, 20);
monoCam.position.set(0, 0, 0.55);
monoCam.lookAt(0, 0, 0);
const feather = new EdgeFeather(THREE, { px: 40 });

let sbsMode = false;
function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  renderer.setSize(sbsMode ? w * 2 : w, h, false);
  monoCam.aspect = w / h;
  monoCam.updateProjectionMatrix();
  frameSubject();
}
addEventListener('resize', sizeCanvas);

let grid, twin, mgTwin, mods = {};
const footprint = () => (view === 'map' ? { w: MAP_W, d: MAP_D, h: 0.16 } : mods[view].footprint);
function frameSubject() {
  if (!grid) return;
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const vw = VDH * aspect, vh = VDH;
  const f = footprint();
  // Frame for the settled tilt, so a preset does not jump in scale while it eases.
  const tilt = pose.tiltTarget;
  const s = Math.min(vw * 0.94 / f.w, vh * 0.94 / (f.d * Math.sin(tilt) + f.h * Math.cos(tilt)));
  subject.scale.setScalar(s * pose.zoom);
  frameShadow();
}

// Fit the sun's shadow camera to the model (it rides on the subject, so its units are the model's).
function frameShadow() {
  if (!grid) return;
  const f = footprint(), ext = 0.55 * Math.hypot(f.w, f.d) + f.h;
  const cam = sun.shadow.camera;
  cam.left = cam.bottom = -ext;
  cam.right = cam.top = ext;
  cam.near = 0.05;
  cam.far = 3;
  cam.updateProjectionMatrix();
  sun.shadow.normalBias = (2 * ext / sun.shadow.mapSize.x) * 1.5;
}

function setView(v, angle = 'overview') {
  view = v;
  stage.clear();
  stage.add(mods[v].root);
  setAngle(angle);
  document.querySelectorAll('.views button[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  select(null);
}

function setAngle(name) {
  const a = ANGLES[name](view);
  pose.tiltTarget = a.tilt;
  pose.yawTarget = a.yaw;
  pose.zoom = a.zoom;
  frameSubject();
  document.querySelectorAll('.angles button').forEach((b) => b.classList.toggle('on', b.dataset.angle === name));
}

// ---- render ------------------------------------------------------------------------------------
let lastT = 0;
const worldQuat = new THREE.Quaternion();
function animate(dt) {
  if (attract) pose.yawTarget += dt * 0.12;
  pose.yaw += (pose.yawTarget - pose.yaw) * Math.min(1, dt * 6);
  pose.tilt += (pose.tiltTarget - pose.tilt) * Math.min(1, dt * 6);
  subject.rotation.set(pose.tilt, pose.yaw, 0, 'XYZ');
  subject.updateMatrixWorld(true);
  subject.getWorldQuaternion(worldQuat);
  if (view === 'map') grid.update(state, dt, worldQuat);
  else mods[view].update(state, dt);
  // Daylight follows the clock.
  const h = state ? state.hour : 14;
  const sunUp = Math.max(0, Math.sin(((h - 6) / 13.5) * Math.PI));
  sun.intensity = 0.4 + 1.3 * sunUp * (state ? 0.5 + 0.5 * state.cloud : 1);
  renderer.shadowMap.needsUpdate = true;   // once per frame; both eyes reuse it
}

function onXRFrame(views, layer) {
  const now = performance.now(), dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
  lastT = now;
  animate(dt);
  const size = new THREE.Vector2();
  renderer.getSize(size);
  renderer.clear();
  renderer.setScissorTest(true);
  views.forEach((v, i) => {
    const vp = layer.getViewport(v) || { x: i ? size.x / 2 : 0, y: 0, width: size.x / 2, height: size.y };
    renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
    renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
    eyeCam.projectionMatrix.fromArray(v.projectionMatrix);
    eyeCam.projectionMatrixInverse.copy(eyeCam.projectionMatrix).invert();
    eyeCam.matrix.fromArray(v.transform.matrix);
    eyeCam.matrixWorld.copy(eyeCam.matrix);
    eyeCam.matrixWorldInverse.copy(eyeCam.matrixWorld).invert();
    renderer.render(scene, eyeCam);
    feather.render(renderer, vp);
  });
  renderer.setScissorTest(false);
  // Picking camera: first eye's frustum, moved to the midpoint between the eyes.
  if (views.length) {
    const a = new THREE.Matrix4().fromArray(views[0].transform.matrix);
    const b = new THREE.Matrix4().fromArray(views[views.length - 1].transform.matrix);
    const pa = new THREE.Vector3().setFromMatrixPosition(a), pb = new THREE.Vector3().setFromMatrixPosition(b);
    a.setPosition(pa.add(pb).multiplyScalar(0.5));
    pickCam.matrixWorld.copy(a);
    pickCam.matrixWorldInverse.copy(a).invert();
    pickCam.projectionMatrix.fromArray(views[0].projectionMatrix);
    pickCam.projectionMatrixInverse.copy(pickCam.projectionMatrix).invert();
    havePickCam = true;
  }
}

function onMonoFrame(now) {
  requestAnimationFrame(onMonoFrame);
  const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
  lastT = now;
  animate(dt);
  renderer.clear();
  const size = new THREE.Vector2();
  renderer.getSize(size);
  renderer.setViewport(0, 0, size.x, size.y);
  renderer.render(scene, monoCam);
}

// ---- input: drag to turn, wheel/pinch to zoom, tap to select ----------------------------------
const pointers = new Map();
let dragDist = 0, pinch0 = 0, zoom0 = 1;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  dragDist = 0;
  if (pointers.size === 2) {
    const [p, q] = [...pointers.values()];
    pinch0 = Math.hypot(p.x - q.x, p.y - q.y);
    zoom0 = pose.zoom;
  }
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  dragDist += Math.abs(dx) + Math.abs(dy);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pose.zoom = Math.min(2.6, Math.max(0.7, zoom0 * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch0)));
    frameSubject();
  } else {
    pose.yawTarget += dx * 0.006;
    pose.tiltTarget = Math.min(1.45, Math.max(0.12, pose.tiltTarget + dy * 0.004));
    document.querySelectorAll('.angles button').forEach((b) => b.classList.remove('on'));
  }
  touch();
});
canvas.addEventListener('pointerup', (e) => {
  pointers.delete(e.pointerId);
  if (dragDist < 8) pickAt(e.clientX, e.clientY);
  touch();
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  pose.zoom = Math.min(2.6, Math.max(0.7, pose.zoom * Math.exp(-e.deltaY * 0.0012)));
  frameSubject();
  touch();
}, { passive: false });
canvas.addEventListener('dblclick', () => {
  if (view !== 'map') return;
  if (SUB_DEVICES.has(selected)) setView('twin');
  else if (MG_DEVICES.has(selected)) setView('mg');
});

const raycaster = new THREE.Raycaster();
function pickAt(cx, cy) {
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, havePickCam && sbsMode ? pickCam : monoCam);
  const hits = raycaster.intersectObjects(mods[view].pickables, false);
  select(hits.length ? hits[0].object.userData.item : null);
}

// ---- selection + device card -------------------------------------------------------------------
const KIND = (id) => net.branches[id]?.kind;
async function select(item) {
  selected = item;
  grid.setSelected(view === 'map' ? item : null);
  twin.selected = view === 'twin' ? item : null;
  mgTwin.selected = view === 'mg' ? item : null;
  if (item && state?.scenario && state.scenario.step === 1 && net.branches[item] && KIND(item) !== 'xfmr') {
    const res = await api.identify(item);
    if (res.msg) toast(res.msg, res.correct ? 'good' : 'bad');
  } else if (item) {
    api.select(item);
  }
  renderCard();
}

function cardFor(item) {
  if (!item) return null;
  if (TWIN_ITEMS[item] || MG_ITEMS[item]) {
    const t = TWIN_ITEMS[item] || MG_ITEMS[item];
    if (t.card) return { ...cards[t.card], title: t.title, device: t.device || t.card };
    return { title: t.title, what: t.text };
  }
  if (cards[item]) return { ...cards[item], device: item };
  const ld = net.loads[item];
  if (ld) return { title: ld.label, what: `${ld.kind[0].toUpperCase() + ld.kind.slice(1)} load, ${ld.customers} customer${ld.customers > 1 ? 's' : ''}.`,
    role: ld.kind === 'critical' ? 'Critical facility on the microgrid: it stays powered when the microgrid islands.'
      : 'Demand follows a daily curve that peaks in the late afternoon on a hot day.', nameplate: `${ld.kw} kW peak`, device: item };
  const b = net.buses[item];
  if (b) return { title: b.label, what: `${b.kv} kV bus.`, device: item };
  return null;
}

function fmtKW(kw) { return Math.abs(kw) >= 1000 ? `${(kw / 1000).toFixed(2)} MW` : `${Math.round(kw)} kW`; }

function renderCard() {
  const el = $('#card');
  const c = cardFor(selected);
  if (!c) {
    el.innerHTML = `<h3>Equipment</h3><div class="placeholder">Tap any equipment in the 3D view or on the
      one-line diagram to see what it is, what it does, and its live values.<br><br>
      Drag to turn the grid, scroll or pinch to zoom. Double-tap the substation to open its digital twin.</div>`;
    return;
  }
  const dev = c.device;
  let vals = '', actions = '';
  if (state && dev && state.branches[dev]) {
    const br = state.branches[dev];
    const pct = Math.round(br.loading * 100);
    const col = br.loading > 1 ? 'var(--alarm2)' : br.loading > 0.9 ? 'var(--alarm3)' : 'var(--equip)';
    vals = `<dl class="vals">
      <dt>State</dt><dd>${br.closed ? 'Closed / in service' : 'OPEN'}</dd>
      <dt>Power</dt><dd>${fmtKW(br.kw)} ${br.kw < -1 ? '(reverse flow)' : ''}</dd>
      <dt>Current</dt><dd>${Math.round(br.amps)} A</dd>
      <dt>Loading</dt><dd>${pct}% <div class="bar"><i style="width:${Math.min(100, pct / 1.2)}%;background:${col}"></i><b style="left:${100 / 1.2 * 0.9}%"></b></div></dd>
      ${state.fci[dev] ? `<dt>Fault ind.</dt><dd style="color:var(--fci)">FLAGGED · ${state.fci[dev]} A seen</dd>` : ''}
    </dl>`;
    if (KIND(dev) === 'breaker' || KIND(dev) === 'switch') {
      const closed = state.closed[dev];
      actions = `<div class="row"><button class="btn ${closed ? 'primary' : ''}" data-op="open" ${closed ? '' : 'disabled'}>Open ${dev.replace('_', '-')}</button>
        <button class="btn ${closed ? '' : 'primary'}" data-op="close" ${closed ? 'disabled' : ''}>Close ${dev.replace('_', '-')}</button></div>`;
    }
  } else if (state && dev === 'bess') {
    const b = state.bess;
    vals = `<dl class="vals"><dt>Output</dt><dd>${fmtKW(b.kw)} ${b.kw > 20 ? 'discharging' : b.kw < -20 ? 'charging' : 'idle'}</dd>
      <dt>Charge</dt><dd>${Math.round(b.soc * 100)}% <div class="bar"><i style="width:${b.soc * 100}%;background:var(--renew)"></i></div></dd>
      <dt>Mode</dt><dd>${state.islanded ? 'Grid-forming (islanded)' : b.mode}</dd></dl>`;
    actions = `<div class="row">${['charge', 'idle', 'discharge'].map((m) =>
      `<button class="btn ${b.mode === m ? 'primary' : ''}" data-bess="${m}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div>`;
  } else if (state && (dev === 'pv_farm' || dev === 'pv_mg')) {
    const p = state.pv[dev];
    vals = `<dl class="vals"><dt>Output</dt><dd>${fmtKW(p.kw)} of ${fmtKW(net.pv[dev].kw)}</dd>
      <dt>Sky</dt><dd>${Math.round(state.cloud * 100)}% clear</dd></dl>`;
  } else if (state && state.loads[dev]) {
    const l = state.loads[dev];
    vals = `<dl class="vals"><dt>Demand</dt><dd>${l.served ? fmtKW(l.kw) : '—'}</dd><dt>Power</dt><dd style="color:${l.served ? 'inherit' : 'var(--alarm1)'}">${l.served ? 'On' : 'OUT'}</dd></dl>`;
  } else if (state && state.buses[dev]) {
    const b = state.buses[dev];
    vals = `<dl class="vals"><dt>Voltage</dt><dd>${b.energized ? b.vpu.toFixed(3) + ' pu' : 'de-energized'}</dd></dl>`;
  }
  const wr = state?.compute?.whatif?.results?.[dev];
  if (wr) {
    vals += `<dl class="vals"><dt style="color:var(--risk)">What-if</dt><dd>if it fails, over a year of conditions:</dd>
      <dt>Out at first</dt><dd>${Math.round(wr.customers_out_frac * 100)}% of customers</dd>
      <dt>After restoring</dt><dd>${Math.round(wr.after_restore_frac * 100)}% still out (tie closed, microgrid islanded)</dd>
      <dt>Overload risk</dt><dd>${Math.round(wr.p_overload * 100)}% of hours · worst ${Math.round(wr.worst * 100)}%</dd></dl>`;
  }
  const twinBtn = view !== 'map' ? ''
    : SUB_DEVICES.has(dev) ? `<button class="btn" data-twin>Open the substation twin</button>`
      : MG_DEVICES.has(dev) ? `<button class="btn" data-mg>Open the microgrid yard</button>` : '';
  el.innerHTML = `<h3>Equipment</h3><div class="card-title">${c.title}</div>
    ${c.what ? `<p class="card-what">${c.what}</p>` : ''}
    ${c.role ? `<p class="card-role">${c.role}</p>` : ''}
    ${c.nameplate ? `<div class="card-plate">${c.nameplate}</div>` : ''}
    ${vals}${actions}${twinBtn}`;
}

$('#card').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  touch();
  const c = cardFor(selected);
  if (b.dataset.op) {
    const res = await api.operate(c.device, b.dataset.op === 'close');
    toast(res.msg, res.tripped && res.tripped.length ? 'bad' : res.ok ? 'good' : 'bad');
  } else if (b.dataset.bess) {
    const res = await api.bess(b.dataset.bess);
    toast(res.msg, 'good');
  } else if ('twin' in b.dataset) {
    setView('twin');
  } else if ('mg' in b.dataset) {
    setView('mg');
  }
  await poll();
});

// ---- mission panel (explore / scenario steps / score) ------------------------------------------
function renderMission() {
  const el = $('#mission');
  const sc = state?.scenario;
  if (!sc) {
    if (el.dataset.mode === 'free') return;
    el.dataset.mode = 'free';
    el.innerHTML = `<h3>Mission</h3>
      <div class="mission-title">A storm is coming</div>
      <p class="mission-body">You're on shift in the distribution control room. Lightning will hit Feeder 1.
        Find the fault, isolate it, and get every customer back on, using the microgrid to help.</p>
      <button class="big" id="btn-start">Start storm restoration · 3 min</button>
      <button class="big secondary" id="btn-whatif2">What-if: test every failure across a year</button>`;
    $('#btn-start').onclick = () => startScenario();
    $('#btn-whatif2').onclick = () => runWhatIf();
    return;
  }
  const key = `s${sc.step}${sc.done}`;
  if (el.dataset.mode === key) return;
  el.dataset.mode = key;
  const cur = sc.steps[Math.min(sc.step, sc.steps.length - 1)];
  el.innerHTML = `<h3>Storm restoration <span class="fine">step ${Math.min(sc.step + 1, sc.steps.length)} of ${sc.steps.length}</span></h3>
    <ol class="steps">${sc.steps.map((s, i) => `<li class="${i < sc.step ? 'done' : i === sc.step ? 'now' : ''}">${s.title}</li>`).join('')}</ol>
    <div class="mission-title">${cur.title}</div>
    <p class="mission-body">${cur.body}</p>
    <div class="row"><button class="btn" id="btn-hint">Hint</button><button class="btn" id="btn-quit">End scenario</button></div>`;
  $('#btn-hint').onclick = async () => { const r = await api.hint(); toast(r.hint, 'good', 9000); touch(); };
  $('#btn-quit').onclick = () => { api.reset('free').then(poll); touch(); };
  if (sc.step !== lastStepShown && sc.step > 0) {
    lastStepShown = sc.step;
    if (sc.step === 1) select(null);
  }
}

async function startScenario() {
  touch();
  attract = false;
  debriefShown = false;
  lastStepShown = -1;
  $('#scorecard').hidden = true;
  if (view !== 'map') setView('map');
  grid.setRisk(null);
  await api.reset('storm');
  pose.zoom = 1; pose.yawTarget = -0.18; pose.tiltTarget = 0.98;
  frameSubject();
  await poll();
}

function renderScore() {
  const sc = state?.scenario;
  if (!sc || !sc.done || !sc.score) { $('#scorecard').hidden = true; return; }
  if (!$('#scorecard').hidden && debriefShown === (state.debrief || '')) return;
  debriefShown = state.debrief || '';
  const s = sc.score;
  $('#scorecard').innerHTML = `<h2>Restoration complete</h2>
    <div class="score-big">${s.score}<span class="fine"> / 100</span></div>
    <div class="score-grid">
      <div><b>${s.seconds}s</b><span>fault to full restoration</span></div>
      <div><b>${s.mistakes}</b><span>closed into the fault</span></div>
      <div><b>${s.hints}</b><span>hints used</span></div>
      <div><b>${s.cmi.toLocaleString()}</b><span>customer-minutes interrupted</span></div>
    </div>
    <p class="debrief">${state.debrief && state.debrief !== '…' ? state.debrief : 'Writing your debrief…'}</p>
    <div class="row"><button class="big" id="btn-again">Try again</button><button class="big secondary" id="btn-done">Explore</button></div>`;
  $('#scorecard').hidden = false;
  $('#btn-again').onclick = () => startScenario();
  $('#btn-done').onclick = () => { $('#scorecard').hidden = true; api.reset('free').then(poll); };
}

// ---- alarms, KPIs, compute ---------------------------------------------------------------------
function renderAlarms() {
  $('#alarms').innerHTML = state.alarms.slice(0, 12).map((a) =>
    `<li class="${a.active ? '' : 'cleared'} ${a.acked ? '' : 'unacked'}"><span class="pri p${a.pri}">${a.pri}</span>
      <span>${a.t}</span><span class="dev">${a.device}</span><span class="msg">${a.text}</span></li>`).join('')
    || '<li class="cleared"><span></span><span></span><span></span><span class="msg">No alarms. Grid normal.</span></li>';
}

function kpi(k, v, s = '', cls = '') { return `<div class="kpi ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`; }
function renderKpis() {
  const k = state.kpi;
  const mw = (x) => (x / 1000).toFixed(2);
  $('#kpis').innerHTML =
    kpi('Load', `${mw(k.load_kw)}<small>MW</small>`, 'customer demand served') +
    kpi('Solar', `${mw(k.pv_kw)}<small>MW</small>`, `${Math.round(state.cloud * 100)}% clear sky`) +
    kpi('Grid import', `${mw(k.import_kw)}<small>MW</small>`, 'from the 115 kV system') +
    kpi('Battery', `${mw(k.bess_kw)}<small>MW</small>`, `${Math.round(state.bess.soc * 100)}% charged · ${state.islanded ? 'grid-forming' : state.bess.mode}`) +
    kpi('Frequency', `${k.freq.toFixed(2)}<small>Hz</small>`, state.islanded ? 'microgrid island' : 'interconnection') +
    kpi('Microgrid', state.islanded ? 'Island' : 'Tied', state.islanded ? 'critical loads on local power' : 'connected at PCC', state.islanded ? '' : '') +
    kpi('Customers out', k.customers_out.toLocaleString(), `of ${k.customers_total.toLocaleString()}`, k.customers_out ? 'alarm' : '') +
    kpi('Cust-minutes out', k.cmi.toLocaleString(), 'feeds SAIDI reliability index');
}

function renderCompute() {
  const c = state.compute, hw = c.hw, w = c.whatif;
  const pct = w.total ? Math.round((100 * w.done) / w.total) : 0;
  $('#compute').innerHTML = `<dl>
    <dt>Machine</dt><dd>${hw.machine}</dd>
    <dt>CPU</dt><dd>${hw.cpu} · ${hw.cores} threads${hw.cpu_pct != null ? ` · ${hw.cpu_pct}%` : ''}</dd>
    <dt>GPU</dt><dd>${hw.gpu ?? '—'}${hw.gpu_mem_gb ? ` · ${hw.gpu_mem_gb} GB` : ''}${hw.gpu_pct != null ? ` · ${hw.gpu_pct}%` : ''}</dd>
    <dt>Power flow</dt><dd>${engine === 'server' ? 'OpenDSS' : 'In-browser'} AC solve · ${c.powerflow_ms < 0.1 ? '<0.1' : c.powerflow_ms.toFixed(2)} ms per step (10/s)</dd>
    <dt>What-if</dt><dd>${w.state === 'idle' ? 'ready · press 4' :
      `<span class="big-num">${w.done.toLocaleString()}</span> power flows · ${w.seconds}s · ${w.rate.toLocaleString()}/s on ${w.workers} ${engine === 'server' ? 'cores' : 'web workers'}
       <div class="meter ${w.state === 'running' ? 'run' : ''}"><i style="width:${pct}%"></i></div>`}</dd>
    <dt>Tutor</dt><dd>${c.tutor.backend}${c.tutor.tokens_per_s ? ` · ${c.tutor.tokens_per_s} tok/s` : ''}</dd>
    <dt>Network</dt><dd>${engine === 'server' ? 'none needed · no data leaves this machine' : 'none · simulation runs in this page'}</dd>
  </dl>`;
}

// ---- what-if ------------------------------------------------------------------------------------
let whatifShown = false;
async function runWhatIf() {
  touch();
  if (view !== 'map') setView('map');
  whatifShown = false;
  grid.setRisk(null);
  await api.whatif();
  toast('Running one year of hourly conditions × every failure, restoration included…', 'good', 5000);
}
function checkWhatIf() {
  const w = state.compute.whatif;
  if (w.state === 'done' && !whatifShown) {
    whatifShown = true;
    grid.setRisk(w.results);
    const worst = Object.entries(w.results).sort((a, b) => b[1].risk - a[1].risk)[0];
    toast(`${w.done.toLocaleString()} power flows in ${w.seconds}s. Highest risk: ${worst[0]} ` +
      `(${Math.round(worst[1].customers_out_frac * 100)}% of customers out if it fails). Tap a bar for details.`, 'good', 12000);
  }
}

// ---- tutor ----------------------------------------------------------------------------------------
async function ask(q) {
  touch();
  const a = $('#answer');
  a.classList.add('thinking');
  a.textContent = 'Thinking…';
  const r = await api.ask(q);
  a.classList.remove('thinking');
  a.textContent = r.answer + (r.note ? `  (${r.note})` : '');
  $('#tutor-backend').textContent = `${r.backend}${r.seconds ? ` · ${r.seconds}s` : ''}${r.tokens_per_s ? ` · ${r.tokens_per_s} tok/s` : ''}`;
}
document.querySelectorAll('.chips button').forEach((b) => (b.onclick = () => ask(b.dataset.q)));
$('#ask').addEventListener('submit', (e) => { e.preventDefault(); const q = $('#ask-input').value.trim(); if (q) ask(q); $('#ask-input').value = ''; });

// ---- toast, attract ---------------------------------------------------------------------------------
let toastTimer = 0;
function toast(msg, kind = '', ms = 6000) {
  if (!msg) return;
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
  lastToastT = performance.now();
}

function touch() {
  lastInput = performance.now();
  if (attract) { attract = false; $('#mode-tag').textContent = 'Explore'; }
}
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  touch();
  if (e.key === '1') setView('map');
  if (e.key === '2') setView('twin');
  if (e.key === '3') setView('mg');
  if (e.key === '4') runWhatIf();
  if (e.key === '[') setDepth(depth - 0.1);
  if (e.key === ']') setDepth(depth + 0.1);
  if (e.key === 'o' || e.key === 'O') setAngle('overview');
  if (e.key === 'e' || e.key === 'E') setAngle('eye');
  if (e.key === 't' || e.key === 'T') setAngle('top');
  if (e.key === 'r' || e.key === 'R') { grid.setRisk(null); api.reset('free').then(poll); }
  if (e.key === 's' || e.key === 'S') startScenario();
});
document.querySelectorAll('.views button[data-view]').forEach((b) => (b.onclick = () => { touch(); setView(b.dataset.view); }));
document.querySelectorAll('.angles button').forEach((b) => (b.onclick = () => { touch(); setAngle(b.dataset.angle); }));
$('#btn-whatif').onclick = () => runWhatIf();
$('#btn-reset').onclick = () => { touch(); grid.setRisk(null); $('#scorecard').hidden = true; api.reset('free').then(poll); };
$('#btn-ack').onclick = () => { touch(); api.ack().then(poll); };
addEventListener('pointerdown', () => touch(), true);

const CAPTIONS = [
  'A live digital twin of a 12.47 kV distribution grid with a microgrid: a real AC power flow, 10 times a second.',
  'Cyan particles are power flowing. Lit windows are customers with power.',
  'Tap Start to restore power after a lightning strike, in about three minutes.',
  'Everything runs on this workstation: simulation, what-if analysis and the tutor. No cloud.',
];
function attractTick(now) {
  if (!attract && now - lastInput > ATTRACT_AFTER_MS && !(state?.scenario && !state.scenario.done)) {
    attract = true;
    $('#mode-tag').textContent = 'Demo';
    $('#scorecard').hidden = true;
    if (view !== 'map') setView('map');
    grid.setRisk(null);
    api.reset('free').then(poll);
  }
  if (attract && now - lastToastT > 8000) {
    toast(CAPTIONS[attractCaption++ % CAPTIONS.length], '', 7500);
  }
}

// ---- state polling ----------------------------------------------------------------------------------
async function poll() {
  try {
    state = await api.state();
  } catch {
    return;
  }
  $('#clock').textContent = state.clock;
  const tag = $('#mode-tag');
  if (!attract) {
    tag.textContent = state.scenario ? (state.scenario.done ? 'Complete' : 'Storm event') : 'Explore';
    tag.classList.toggle('live', !!state.scenario && !state.scenario.done && state.scenario.step > 0);
  }
  oneline.update(state, selected);
  renderMission();
  renderAlarms();
  renderKpis();
  renderCompute();
  renderScore();
  checkWhatIf();
  if (selected) renderCard();
}

// ---- boot ---------------------------------------------------------------------------------------------
let oneline;
(async () => {
  await initApi();
  const n = await api.network();
  net = n.network;
  cards = n.cards;
  grid = new GridScene(THREE, net);
  twin = new SubstationTwin(THREE);
  mgTwin = new MicrogridTwin(THREE);
  mods = { map: grid, twin, mg: mgTwin };
  oneline = new OneLine($('#oneline'), net, (id) => {
    touch();
    // In a module, a one-line click on that module's equipment selects it there; anything else
    // goes back to the map.
    if (view !== 'map') {
      if (ALIAS[view][id]) { select(ALIAS[view][id]); return; }
      setView('map');
    }
    select(id);
  });
  setView(VIEWS[params.get('view')] ? params.get('view') : 'map');
  if (params.get('select')) select(params.get('select'));
  renderCard();
  await poll();
  setInterval(poll, 200);
  if (params.get('start') === 'storm') startScenario();
  if (params.get('start') === 'whatif') runWhatIf();
  setInterval(() => attractTick(performance.now()), 500);

  // ?mono forces the flat renderer (headless checks, or a plain 2D monitor beside the 3D panel).
  const wall = params.has('mono') ? { supported: false } : await createInline3D({ lazy: false });
  if (wall.supported) {
    // With view-rig support the depth slider can lower eye separation; without it, only the
    // scene stretch is available (applyDepth handles both).
    rigOK = inline3dViewRigSupported();
    handle = wall.addScene(canvas, onXRFrame, rigOK ? { viewRig: rigFor(depth) } : { virtualDisplayHeight: VDH });
    sbsMode = true;
    sizeCanvas();
    applyDepth();
    // Keep the canvas covered until the browser has joined it to the weave (no raw SBS flash).
    Promise.resolve(handle.firstWoven).finally(() => ($('#cover').hidden = true));
    addEventListener('pagehide', () => wall.close && wall.close());
  } else {
    sizeCanvas();
    applyDepth();
    $('#cover').hidden = true;
    requestAnimationFrame(onMonoFrame);
  }
})();
