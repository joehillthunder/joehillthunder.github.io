// Echo-3 Worlds: SpAItial's public Echo-3 captures as glasses-free 3D dollhouses.
//
// Each world is a Streamed SOG on SpAItial's CDN (CORS open), read by the SDK's PlayCanvas
// backend. worlds.json is baked by tools/echo3_frame.py from each world's coarsest LOD: the floor
// height and footprint, so the page can cut the room at 1.6 m (a clip box) and frame the cut room
// from outside. Rule zero: the room fills the tile at a middle size, the camera is never inside it.
//
// Two things specific to Echo-3 files:
// - They are Y-UP, unlike most 3DGS exports, so `flipY: false` (the SDK's default flip would
//   turn every room upside down).
// - A Streamed SOG is ~10 M splats; the SDK streams ~600 k per tile under its default budget.

import { createInline3D } from '@displayxr/inline3d';
import { addSplat } from '@displayxr/inline3d/splat/playcanvas';
import * as pc from 'playcanvas';

const $ = (id) => document.getElementById(id);
const canvas = $('tile');
const cover = $('cover');
const titleEl = $('title');
const readout = $('readout');
const params = new URLSearchParams(location.search);

const { worlds } = await fetch(new URL('./worlds.json', import.meta.url)).then((r) => r.json());

// The dollhouse view: looking down at the cut room from outside, turning slowly.
// zoom < 1: the fit box is measured unpitched, and looking down 35° the cut room projects taller.
const REST = { yaw: 30, pitch: Number(params.get('pitch') ?? 35), zoom: Number(params.get('zoom') ?? 0.75) };
const SPIN = 6; // deg/s once idle
const DEPTH_STEPS = [0.5, 0.75, 1, 1.25, 1.5];
// The page's 100 % = 0.75 × the SDK display rig's default: seated on the Leia panel the default
// read "a bit strong" (2026-10-28, runtime 2.57.1 + leia-sr 2.19.1). ?depthBase= overrides.
const DEPTH_BASE = Number(params.get('depthBase') ?? 0.75);

let world = worlds.find((w) => w.id === params.get('world')) ?? worlds[0];
let depthIdx = 2;
let cutOn = true;
let spinning = true;

const wall = await createInline3D({ lazy: false });
const handle = addSplat(wall, canvas, world.url, {
  engine: 'playcanvas',
  flipY: false,
  rig: 'display',
  frame: world.frame,
  fit: 'contain',
  margin: 0.86,
  idleSpin: SPIN,
  orbit: false, // the page drives yaw/pitch/zoom below: a full turn, not tilt-and-relax
  feather: 16,
  renderScale: 0.7,
  rectCover: 'auto',
});

// ── room state ───────────────────────────────────────────────────────────────────────────
function applyCut() {
  handle.setEffect('clip', cutOn ? { box: { min: world.clip.min, max: world.clip.max } } : null);
}
function showTitle() {
  titleEl.textContent = `${world.title} · ${world.size[0].toFixed(1)} × ${world.size[1].toFixed(1)} m`;
  for (const b of document.querySelectorAll('.world')) b.setAttribute('aria-current', String(b.dataset.id === world.id));
}
function rest() {
  handle.setPose({ ...REST });
}
// The `frame` option alone is not enough on a Streamed SOG: the SDK frames from its octree leaf
// boxes and orbits a default focus. Fit and focus on the baked cut-room box explicitly.
function frameRoom(w) {
  handle.viewer.fitTo(w.frame.center, w.frame.extent);
  handle.setFocus(w.frame.center, { snap: true });
}

await handle.ready.catch((err) => {
  cover.textContent = `Couldn't load the room: ${err.message}`;
  throw err;
});
frameRoom(world);
applyCut();
setDepth(depthIdx);
rest();
showTitle();
const woven = await handle.firstWoven;
cover.remove(); // a cut, never a fade (woven-canvas rule 5)
console.info('[echo-worlds] firstWoven', woven);

// ── world picker ─────────────────────────────────────────────────────────────────────────
const list = $('worlds');
for (const w of worlds) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'world';
  b.dataset.id = w.id;
  b.innerHTML = `<img alt="" loading="lazy" src="${w.thumb}"><span></span>`;
  b.querySelector('span').textContent = w.name;
  b.addEventListener('click', () => switchTo(w));
  list.append(b);
}
showTitle();

let switching = null;
async function switchTo(w) {
  if (w.id === world.id) return;
  world = w;
  clearMeasure();
  showTitle();
  const job = (switching = handle.setSource(w.url, { transition: 'cut', resetPose: true }));
  try {
    await job;
  } catch (err) {
    readout.hidden = false;
    readout.textContent = `Couldn't load ${w.name}`;
    return;
  }
  if (switching !== job) return; // a newer pick superseded this one
  frameRoom(w);
  applyCut();
  rest();
  const u = new URL(location.href);
  u.searchParams.set('world', w.id);
  history.replaceState(null, '', u);
}

// ── drag to turn, wheel to zoom ──────────────────────────────────────────────────────────
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  const p = handle.viewer.getPose({ target: true });
  drag = { x: e.clientX, y: e.clientY, yaw: p.yaw, pitch: p.pitch, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.hypot(dx, dy) > 4) drag.moved = true;
  if (!drag.moved || measuring) return;
  const pitch = Math.max(10, Math.min(75, drag.pitch + dy * 0.25));
  handle.setPose({ yaw: drag.yaw + dx * 0.4, pitch });
});
canvas.addEventListener('pointerup', (e) => {
  const click = drag && !drag.moved;
  drag = null;
  if (click && measuring) addMeasurePoint(e.clientX, e.clientY);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const z = handle.viewer.getPose({ target: true }).zoom;
  handle.setPose({ zoom: Math.max(0.7, Math.min(2.5, z * Math.exp(-e.deltaY * 0.001))) });
}, { passive: false });

// ── measure: two picks, a line between them, the distance in metres (Echo-3 is metric) ─────
let measuring = false;
let points = [];
let marks = [];
function marker(p, r = 0.05) {
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color(0.85, 0.64, 0.36);
  m.emissive = new pc.Color(0.5, 0.36, 0.18);
  m.update();
  const e = new pc.Entity('measure');
  e.addComponent('render', { type: 'sphere', material: m, castShadows: false });
  e.setLocalPosition(p[0], p[1], p[2]);
  e.setLocalScale(r * 2, r * 2, r * 2);
  handle.engine.root.addChild(e);
  return e;
}
function bar(a, b) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const e = marker([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  e.lookAt(new pc.Vec3(b[0], b[1], b[2]));
  e.rotateLocal(90, 0, 0); // the cylinder's axis is Y; lookAt points -Z at b
  e.render.type = 'cylinder';
  e.setLocalScale(0.025, len, 0.025);
  return e;
}
function clearMeasure() {
  for (const m of marks) m.destroy();
  marks = [];
  points = [];
  readout.hidden = !measuring;
  readout.textContent = 'Click two points';
}
function addMeasurePoint(x, y) {
  const p = handle.pick(x, y);
  if (!p) return;
  if (points.length === 2) clearMeasure();
  points.push(p);
  marks.push(marker(p));
  if (points.length === 2) {
    const [a, b] = points;
    marks.push(bar(a, b));
    readout.textContent = `${Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]).toFixed(2)} m`;
  }
}
$('measure').addEventListener('click', (e) => {
  measuring = !measuring;
  e.currentTarget.setAttribute('aria-pressed', String(measuring));
  canvas.classList.toggle('measuring', measuring);
  setSpin(!measuring && spinning);
  clearMeasure();
});

// ── controls ─────────────────────────────────────────────────────────────────────────────
function setSpin(on) {
  handle.viewer.idleSpin = on ? SPIN : 0;
}
$('spin').addEventListener('click', (e) => {
  spinning = !spinning;
  e.currentTarget.setAttribute('aria-pressed', String(spinning));
  setSpin(spinning && !measuring);
});
$('cut').addEventListener('click', (e) => {
  cutOn = !cutOn;
  e.currentTarget.setAttribute('aria-pressed', String(cutOn));
  applyCut();
});
function setDepth(i) {
  depthIdx = Math.max(0, Math.min(DEPTH_STEPS.length - 1, i));
  handle.setStereo({ ipdScale: DEPTH_BASE * DEPTH_STEPS[depthIdx], parallaxScale: DEPTH_BASE * DEPTH_STEPS[depthIdx] });
  $('depthOut').textContent = `${Math.round(DEPTH_STEPS[depthIdx] * 100)} %`;
}
$('depthDown').addEventListener('click', () => setDepth(depthIdx - 1));
$('depthUp').addEventListener('click', () => setDepth(depthIdx + 1));
$('reset').addEventListener('click', () => {
  setDepth(2);
  clearMeasure();
  rest();
});

// Full panel: the browser's own fullscreen on the stage. A resize is a fresh-canvas moment
// (woven-canvas rule 11), so cover the tile until it is woven again.
$('full').addEventListener('click', async () => {
  const stage = $('stage');
  const veil = document.createElement('div');
  veil.id = 'cover';
  stage.append(veil);
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stage.requestFullscreen();
  } catch { /* fullscreen refused: the tile stays as it was */ }
  await (handle.rewoven?.() ?? Promise.resolve());
  veil.remove();
});
addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') rest();
});

// Diagnostics for the depth check (DevTools): where the room sits relative to the glass.
window.echoWorlds = { handle, worlds, bounds: () => handle.viewer.getSubjectBounds() };

if (params.has('debug')) {
  if (params.has('nocut')) { cutOn = false; applyCut(); }
  setInterval(() => {
    const s = handle.stats?.();
    let b = null;
    try { b = handle.viewer.getSubjectBounds(); } catch (e) { b = String(e); }
    console.info('[echo-worlds] debug', JSON.stringify({ stats: s, pose: handle.viewer.getPose(), bounds: b, rig: handle.rig && { type: handle.rig.type, focus: handle.rig.focus, frame: handle.rig.frame } }));
  }, 3000);
}
