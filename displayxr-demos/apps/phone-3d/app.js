// 3D Phone: a phone whose screen is one woven 3D tile, with apps that show what a
// switchable glasses-free 3D phone is for: AI 2D-to-3D photos, games, calls and learning.
//
// Every [data-scene] figure holds one canvas for the life of the page. On the DisplayXR Browser
// each canvas is registered once with addScene() on a single lazy inline-3D session and renders
// a side-by-side pair from the session's eye views; in any other browser (or if the SDK cannot
// load) each renders one mono camera that follows the pointer a little.
//
// Inline-3D rules followed (DisplayXR/displayxr-web docs/woven-canvas-rules.md and
// porting-three-js-apps.md): one createInline3D per document; canvases are never remounted and
// sit in the normal page flow, so scrolling is the only thing that moves them; each 2:1 backing
// store is sized and drawn for two frames before addScene; each tile is covered until its
// handle.firstWoven and across a resize until handle.rewoven(); every XR frame checks for two
// views and a viewport per eye before clearing and replays the last good eye matrices otherwise;
// pixelRatio stays 1 and each buffer is clamped to the GL limits and a pixel budget;
// preserveDrawingBuffer is on for woven canvases; no CSS effects on a tile or its ancestors.

import * as THREE from 'three';
import { buildScene, BG } from './scenes.js';

const SDK_BASE = 'https://cdn.jsdelivr.net/npm/@displayxr/inline3d@1.45.1/js/';
const VDH = 0.24;                       // virtual display height, metres (the SDK default)
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const FORCE_2D = params.has('2d');
const THEME = document.querySelector('meta[name="phone-theme"]')?.content || 'generic';
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const log = (...a) => console.log('[phone-3d]', ...a);

// ---- 3D support first, so renderers are created with the right options ---------------------
let sdk = null;
let wall = null;
if (!FORCE_2D) {
  try {
    const [core, three] = await Promise.all([
      import(SDK_BASE + 'inline3d.js'),
      import(SDK_BASE + 'inline3d-three.js'),
    ]);
    sdk = { ...core, ...three };
    const w = await sdk.createInline3D({ lazy: true });
    if (w.supported) wall = w;
  } catch (e) {
    console.warn('[phone-3d] inline-3D SDK unavailable; running in 2D.', e);
  }
}

// ---- pointer: a stand-in for head tracking on the mono path --------------------------------
const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = (e.clientY / innerHeight) * 2 - 1;
}, { passive: true });

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

// ---- one tile ------------------------------------------------------------------------------
class Tile {
  constructor(fig, ctx = {}) {
    this.fig = fig;
    this.name = fig.dataset.scene;
    this.canvas = fig.querySelector('canvas');
    this.cover = fig.querySelector('.cover');
    this.readout = fig.querySelector('[data-status]');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: !!wall,
    });
    const r = this.renderer;
    r.setPixelRatio(1);
    r.autoClear = false;
    r.setClearColor(BG, 1);
    r.outputColorSpace = THREE.SRGBColorSpace;
    const gl = r.getContext();
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    this.maxDim = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), vp[0], vp[1]);

    this.scene = new THREE.Scene();
    this.content = buildScene(THREE, this.name, REDUCED ? 0 : 1, ctx);
    // The turntable: dragging turns the whole subject about the glass's centre (a display rig
    // turns the subject, never a camera). It eases home after a while with no input.
    this.turn = new THREE.Group();
    this.turn.add(this.content.group);
    this.scene.add(this.turn);
    this.yaw = 0; this.pitch = 0; this.yawT = 0; this.pitchT = 0; this.lastInput = -1e9;

    // Mono camera: the nominal viewer 0.6 m in front of a VDH-tall display at z = 0.
    this.cam = new THREE.PerspectiveCamera(2 * Math.atan(VDH / 2 / 0.6) * 180 / Math.PI, 4 / 3, 0.01, 10);
    this.cam.position.set(0, 0, 0.6);

    this.mode = 'mono';        // 'mono' | 'xr'
    this.sbs = false;
    this.visible = false;
    this.handle = null;
    this.eyes = null;
    this.good = [0, 1].map(() => ({ proj: new Float32Array(16), xf: new Float32Array(16) }));
    this.haveGood = false;
    this.lastXR = 0;
    this.lastT = 0;
    this.lastStatus = '';
    this.coverToken = 0;
    this.applySize();
    this.bindInput();
    this.buildActions();
  }

  // ---- interaction: drag to turn, tap to pick, hover for scenes that follow the pointer ----
  bindInput() {
    const c = this.canvas;
    const ray = new THREE.Raycaster();
    let down = null;
    const norm = (e) => {
      const r = c.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
    };
    c.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, yaw: this.yawT, pitch: this.pitchT, moved: false };
      try { c.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      this.lastInput = performance.now();
    });
    c.addEventListener('pointermove', (e) => {
      if (this.content.hover && e.pointerType === 'mouse' && !down) this.content.hover(norm(e).x, norm(e).y);
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) > 6) { down.moved = true; c.classList.add('dragging'); }
      if (!down.moved) return;
      this.yawT = down.yaw + dx * 0.012;
      this.pitchT = Math.max(-0.7, Math.min(0.7, down.pitch + dy * 0.008));
      this.lastInput = performance.now();
    });
    const end = (e) => {
      if (!down) return;
      const wasTap = !down.moved;
      down = null;
      c.classList.remove('dragging');
      if (wasTap && e.type === 'pointerup') this.tapAt(norm(e), ray);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { if (this.content.hover) this.content.hover(null, null); });
    // Keyboard: arrows turn the scene, Enter/Space taps its centre.
    c.tabIndex = 0;
    c.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowRight') { this.yawT += k === 'ArrowLeft' ? -0.25 : 0.25; }
      else if (k === 'ArrowUp' || k === 'ArrowDown') { this.pitchT = Math.max(-0.7, Math.min(0.7, this.pitchT + (k === 'ArrowUp' ? -0.15 : 0.15))); }
      else if (k === 'Enter' || k === ' ') this.tapAt({ x: 0, y: 0 }, ray);
      else return;
      e.preventDefault();
      this.lastInput = performance.now();
    });
  }

  tapAt(p, ray) {
    if (!this.content.tap || !this.content.pick) return;
    this.cam.lookAt(0, 0, 0);
    this.cam.updateMatrixWorld();
    this.scene.updateMatrixWorld();
    ray.setFromCamera(p, this.cam);
    const hit = ray.intersectObjects(this.content.pick, true)[0];
    if (hit) this.content.tap(hit);
  }

  buildActions() {
    const acts = this.content.actions;
    if (!acts?.length) return;
    const bar = document.createElement('div');
    bar.className = 'tile-actions';
    this.actionButtons = acts.map((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label();
      b.addEventListener('click', () => { a.run(); this.lastInput = performance.now(); b.textContent = a.label(); });
      bar.appendChild(b);
      return { a, b };
    });
    this.fig.appendChild(bar);
  }

  applySize() {
    const cssW = this.canvas.clientWidth || 640;
    const cssH = this.canvas.clientHeight || 480;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    let w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    // SBS: the pair is the box's width, so each eye gets half (what a lenticular panel resolves).
    const budget = this.sbs ? 2.4e6 : 1.6e6;
    const k = Math.min(1, this.maxDim / w, this.maxDim / h, Math.sqrt(budget / (w * h)));
    w = Math.floor(w * k); h = Math.floor(h * k);
    if (this.sbs) w -= w % 2;
    this.cam.aspect = cssW / cssH;
    this.cam.updateProjectionMatrix();
    // Writing the size reallocates (and clears) the buffer even for the same value: only on change.
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.renderer.setSize(w, h, false);
    return true;
  }

  step() {
    const now = performance.now() / 1000;
    const dt = this.lastT ? Math.min(0.1, now - this.lastT) : 1 / 60;
    this.lastT = now;
    this.content.update(now, dt);
    // Turntable: follow the drag, then drift home after 8 s untouched.
    if (performance.now() - this.lastInput > 8000) {
      this.yawT = damp(this.yawT, Math.round(this.yawT / (Math.PI * 2)) * Math.PI * 2, 1.2, dt);
      this.pitchT = damp(this.pitchT, 0, 1.2, dt);
    }
    this.yaw = damp(this.yaw, this.yawT, 10, dt);
    this.pitch = damp(this.pitch, this.pitchT, 10, dt);
    this.turn.rotation.set(this.pitch, this.yaw, 0);
    const s = this.content.status();
    if (s !== this.lastStatus && this.readout) {
      this.readout.textContent = s; this.lastStatus = s;
      if (this.actionButtons) for (const { a, b } of this.actionButtons) { const l = a.label(); if (b.textContent !== l) b.textContent = l; }
    }
  }

  renderMono() {
    const r = this.renderer;
    if (!REDUCED) {
      this.cam.position.x = pointer.sx * 0.05;
      this.cam.position.y = -pointer.sy * 0.03;
    }
    this.cam.lookAt(0, 0, 0);
    r.setScissorTest(false);
    r.clear();
    const w = this.canvas.width, h = this.canvas.height;
    if (!this.sbs) {
      r.setViewport(0, 0, w, h);
      r.render(this.scene, this.cam);
      return;
    }
    // SBS buffer but no eye views yet: the mono view in both halves, so it is never empty.
    r.setScissorTest(true);
    for (let i = 0; i < 2; i++) {
      r.setViewport(i * w / 2, 0, w / 2, h);
      r.setScissor(i * w / 2, 0, w / 2, h);
      r.render(this.scene, this.cam);
    }
    r.setScissorTest(false);
  }

  onXRFrame(views, layer) {
    this.lastXR = performance.now();
    this.step();
    // Validate BEFORE clearing; on a short frame replay the last good eye matrices.
    let ok = !!views && views.length >= 2;
    const vps = [null, null];
    if (ok) {
      for (let i = 0; i < 2; i++) {
        vps[i] = layer.getViewport(views[i]);
        if (!vps[i]) { ok = false; break; }
      }
    }
    if (ok) {
      for (let i = 0; i < 2; i++) {
        this.good[i].proj.set(views[i].projectionMatrix);   // copies: an XRView dies with its frame
        this.good[i].xf.set(views[i].transform.matrix);
      }
      this.haveGood = true;
    }
    this.renderStereo(ok ? vps : null);
  }

  renderStereo(vps) {
    if (!this.haveGood) { this.renderMono(); return; }
    const r = this.renderer;
    const w = this.canvas.width, h = this.canvas.height;
    r.setScissorTest(false);
    r.clear();
    r.setScissorTest(true);
    for (let i = 0; i < 2; i++) {
      const vp = vps ? vps[i] : { x: i * w / 2, y: 0, width: w / 2, height: h };
      r.setViewport(vp.x, vp.y, vp.width, vp.height);
      r.setScissor(vp.x, vp.y, vp.width, vp.height);
      this.eyes[i].setFromMatrices(this.good[i].proj, this.good[i].xf);
      r.render(this.scene, this.eyes[i].camera);
    }
    r.setScissorTest(false);
  }

  // Called from the page's own rAF. On the XR path it only draws when the session has not
  // delivered a frame for this tile recently (before activation, or a lazy layer re-arming),
  // so the canvas is never left undrawn.
  pageFrame(now) {
    if (!this.visible) return;
    if (this.mode === 'xr' && now - this.lastXR < 150) return;
    this.step();
    if (this.mode === 'xr' && this.haveGood) this.renderStereo(null);
    else this.renderMono();
  }

  coverUntil(promise) {
    const token = ++this.coverToken;
    this.cover.hidden = false;
    promise.then((res) => {
      if (token !== this.coverToken) return;
      this.cover.hidden = true;
      if (DEBUG) log(this.name, 'cover released', res);
    });
  }

  async activate3D() {
    this.eyes = [new sdk.EyeCamera(THREE), new sdk.EyeCamera(THREE)];
    this.cover.hidden = false;
    // Commit a settled 2:1 store and let it paint before registering.
    this.sbs = true;
    this.applySize();
    this.renderMono();
    await nextFrame();
    this.renderMono();
    await nextFrame();
    const at = performance.now();
    this.handle = wall.addScene(this.canvas, (v, l) => this.onXRFrame(v, l), {
      virtualDisplayHeight: VDH,
      observe: this.fig,
      onLayerLost: () => { log(this.name, 'weave layer lost; continuing in 2D'); this.fallTo2D(); },
    });
    this.mode = 'xr';
    this.coverUntil(this.handle.firstWoven.then((res) => {
      log(this.name, 'firstWoven', res, `registered ${Math.round(performance.now() - at)} ms ago`);
      return res;
    }));
  }

  fallTo2D() {
    this.mode = 'mono';
    this.sbs = false;
    this.handle = null;
    this.coverToken++;
    this.cover.hidden = true;
    if (this.applySize()) this.renderMono();
    updateBadge();
  }

  onResize() {
    if (this.mode === 'xr' && this.handle) this.coverUntil(this.handle.rewoven());
    if (this.applySize()) {
      // The buffer was just cleared: repaint now rather than leave a black frame to the weave.
      this.step();
      if (this.mode === 'xr' && this.haveGood) this.renderStereo(null); else this.renderMono();
    }
  }
}

// ---- boot ----------------------------------------------------------------------------------
const tiles = [];
for (const fig of document.querySelectorAll('[data-scene]')) {
  try {
    tiles.push(new Tile(fig, { theme: THEME, onApp: (name) => markApp(name) }));
  } catch (e) {
    console.warn('[phone-3d] tile failed', fig.dataset.scene, e);
    fig.classList.add('no-gl');
  }
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const t = tiles.find((x) => x.fig === e.target);
    if (t) t.visible = e.isIntersecting;
  }
}, { rootMargin: '25% 0px' });
const ro = new ResizeObserver((entries) => {
  for (const e of entries) tiles.find((x) => x.canvas === e.target)?.onResize();
});
for (const t of tiles) { io.observe(t.fig); ro.observe(t.canvas); }

function loop() {
  requestAnimationFrame(loop);
  pointer.sx += (pointer.x - pointer.sx) * 0.06;
  pointer.sy += (pointer.y - pointer.sy) * 0.06;
  const now = performance.now();
  for (const t of tiles) t.pageFrame(now);
}
requestAnimationFrame(loop);

function updateBadge() {
  const badge = document.getElementById('mode');
  if (!badge) return;
  const woven = tiles.some((t) => t.mode === 'xr');
  badge.dataset.mode = woven ? '3d' : '2d';
  badge.querySelector('.mode-label').textContent = woven ? 'Glasses-free 3D' : '2D preview';
  const note = document.getElementById('mode-note');
  if (note) note.hidden = woven;
}

if (wall) {
  for (const t of tiles) await t.activate3D();
  log('inline-3D session open', { tiles: tiles.length });
} else {
  log('2D mode', { sdk: !!sdk });
}
updateBadge();

// ---- the dock under the phone switches apps; the scene reports back when it switches itself --
const phone = tiles.find((t) => t.name === 'phone');
const dockButtons = [...document.querySelectorAll('[data-app]')];
for (const b of dockButtons) {
  b.addEventListener('click', () => { phone?.content.setApp(b.dataset.app); if (phone) phone.lastInput = performance.now(); });
}
function markApp(name) {
  for (const b of dockButtons) b.setAttribute('aria-pressed', String(b.dataset.app === name));
}
const startApp = params.get('app');
if (startApp && phone) phone.content.setApp(startApp);
else markApp('home');

if (DEBUG) {
  window.phone3d = { tiles, wall, sdk };
  setInterval(() => {
    for (const t of tiles) if (t.handle) log(t.name, t.handle.stats());
  }, 5000);
}
