// Music visualizer: boot, render loops, inline-3D wiring and UI.
//
// One full-window canvas for the life of the page. On the DisplayXR Browser it is registered
// once with addScene() and renders a side-by-side stereo pair from the session's eye views; in
// any other browser (or if the SDK cannot load) it renders one mono camera. The styles and the
// audio analysis are identical on both paths.
//
// Inline-3D rules followed here (DisplayXR/displayxr-web docs/woven-canvas-rules.md and
// docs/porting-three-js-apps.md §9): one createInline3D per document; the canvas is never
// remounted; its 2:1 backing store is sized and committed two frames before addScene; it stays
// covered until handle.firstWoven and across a resize until handle.rewoven(); every frame checks
// for two views and a viewport per eye before clearing and replays the last good frame
// otherwise; pixelRatio stays 1; the SBS buffer is no wider than the panel; the SDK is imported
// dynamically at a pinned version so a CDN failure degrades to 2D instead of a blank page.

import * as THREE from 'three';
import { AudioEngine } from './audio.js';
import { createStyles } from './styles.js';

const SDK_BASE = 'https://cdn.jsdelivr.net/npm/@displayxr/inline3d@1.37.1/js/';
const VDH = 0.24;                     // virtual display height, metres (the SDK default)
const AUTO_SECONDS = 22;              // auto-cycle: switch on the first beat after this long
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const FORCE_2D = params.has('2d');
const log = (...a) => console.log('[music-visualizer]', ...a);

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const cover = $('cover');
const ui = {
  start: $('start'), startError: $('start-error'), startClose: $('start-close'), badge: $('mode-badge'),
  bar: $('bar'), play: $('play'), label: $('now-label'), seek: $('seek'), beat: $('beat'),
  change: $('change'), fs: $('fs'), styles: $('style-buttons'), auto: $('auto'),
  depthWrap: $('depth-wrap'), depth: $('depth'), drop: $('drop'), file: $('file'), hud: $('hud'),
};

const store = {
  get(k, d) { try { const v = localStorage.getItem('mv.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mv.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---- 3D support: SDK first, so the renderer can be created with the right options ---------
let sdk = null;
let wall = null;
if (!FORCE_2D) {
  try {
    const [core, three] = await Promise.all([
      import(SDK_BASE + 'inline3d.js'),
      import(SDK_BASE + 'inline3d-three.js'),
    ]);
    sdk = { ...core, ...three };
    const w = await sdk.createInline3D({ lazy: false });
    if (w.supported) wall = w;
  } catch (e) {
    console.warn('[music-visualizer] inline-3D SDK unavailable; running in 2D.', e);
  }
}

// ---- renderer + scene ----------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
  // A full-window woven scene: lets the browser copy each frame rather than race our next write.
  preserveDrawingBuffer: !!wall,
});
renderer.setPixelRatio(1);              // getViewport() is backing-store px; never let three scale it
renderer.autoClear = false;
renderer.setClearColor(0x000000, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const gl = renderer.getContext();
const vpDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
const MAX_DIM = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), vpDims[0], vpDims[1]);

const scene = new THREE.Scene();
const styles = createStyles(THREE);
for (const s of styles) { s.group.visible = false; scene.add(s.group); }

// Mono camera: the nominal viewer 0.6 m in front of a VDH-tall display at z = 0.
const monoCam = new THREE.PerspectiveCamera(2 * Math.atan(VDH / 2 / 0.6) * 180 / Math.PI, 16 / 9, 0.01, 10);
monoCam.position.set(0, 0, 0.6);
monoCam.lookAt(0, 0, 0);

// ---- sizing --------------------------------------------------------------------------------
let mode = 'mono';          // 'mono' | 'xr'
let sbs = false;            // backing store is a side-by-side pair
let aspect = 16 / 9;

function applySize() {
  const cssW = canvas.clientWidth || innerWidth;
  const cssH = canvas.clientHeight || innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = Math.round(cssW * dpr);
  let h = Math.round(cssH * dpr);
  // SBS: the whole pair is the panel's width, so each eye gets half (what a lenticular panel
  // resolves anyway). Mono: 1:1 with the box. Clamp both axes by one factor to the GL limits
  // and to a pixel budget (a dpr-3 window is 5+ MP, which drops the frame rate for no visible
  // gain; on the 3D path each eye then stays above ~0.5 render scale).
  const budget = sbs ? 4.2e6 : 2.6e6;
  const k = Math.min(1, MAX_DIM / w, MAX_DIM / h, Math.sqrt(budget / (w * h)));
  w = Math.floor(w * k); h = Math.floor(h * k);
  if (sbs) w -= w % 2;
  aspect = cssW / cssH;
  monoCam.aspect = aspect;
  monoCam.updateProjectionMatrix();
  for (const s of styles) s.resize(VDH * aspect, VDH);
  // Writing the size reallocates (and clears) the buffer even for the same value: only on change.
  if (canvas.width === w && canvas.height === h) return false;
  renderer.setSize(w, h, false);
  return true;
}

// ---- per-frame update ----------------------------------------------------------------------
const audio = new AudioEngine();
let current = -1;
let styleSince = 0;
let auto = store.get('auto', false);
let last = 0;
let t = 0;
let frameCount = 0, fps = 0, fpsAcc = 0, fpsFrames = 0;

function tick() {
  const now = performance.now() / 1000;
  const dt = last ? Math.min(0.1, now - last) : 1 / 60;
  last = now;
  t += dt;
  const a = audio.analyse(dt, now);
  if (auto && audio.source && a.beat && now - styleSince > AUTO_SECONDS) setStyle((current + 1) % styles.length);
  styles[current].update(dt, a, t);
  frameCount++;
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc > 0.5) { fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }
  if ((frameCount & 3) === 0) updateBarLive(a);
}

// ---- mono path -----------------------------------------------------------------------------
function renderMono() {
  renderer.setScissorTest(false);
  renderer.clear();
  const w = canvas.width, h = canvas.height;
  if (!sbs) {
    renderer.setViewport(0, 0, w, h);
    renderer.render(scene, monoCam);
    return;
  }
  // SBS buffer but no eye views yet (before activation, or before the first stereo frame):
  // the mono view in both halves, so the buffer is never empty. It is under the cover anyway.
  renderer.setScissorTest(true);
  for (let i = 0; i < 2; i++) {
    renderer.setViewport(i * w / 2, 0, w / 2, h);
    renderer.setScissor(i * w / 2, 0, w / 2, h);
    renderer.render(scene, monoCam);
  }
  renderer.setScissorTest(false);
}

function onMonoFrame() {
  if (mode !== 'mono') return;
  requestAnimationFrame(onMonoFrame);
  tick();
  renderMono();
}

// ---- inline-3D path ------------------------------------------------------------------------
let handle = null;
let eyes = null;
const good = [0, 1].map(() => ({ proj: new Float32Array(16), xf: new Float32Array(16) }));
let haveGood = false;
let firstWovenMs = null;

function onXRFrame(views, layer) {
  tick();
  // Validate BEFORE clearing: a short view list or a null viewport would otherwise leave the
  // woven buffer black for a frame. On such a frame replay the last good eye matrices.
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
      good[i].proj.set(views[i].projectionMatrix);    // copies: an XRView dies with its frame
      good[i].xf.set(views[i].transform.matrix);
    }
    haveGood = true;
  }
  renderStereo(ok ? vps : null);
}

function renderStereo(vps) {
  if (!haveGood) { renderMono(); return; }
  const w = canvas.width, h = canvas.height;
  renderer.setScissorTest(false);
  renderer.clear();
  renderer.setScissorTest(true);
  for (let i = 0; i < 2; i++) {
    const vp = vps ? vps[i] : { x: i * w / 2, y: 0, width: w / 2, height: h };
    renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
    renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
    eyes[i].setFromMatrices(good[i].proj, good[i].xf);
    renderer.render(scene, eyes[i].camera);
  }
  renderer.setScissorTest(false);
}

let coverToken = 0;
function coverUntil(promise) {
  const token = ++coverToken;
  cover.hidden = false;
  promise.then((r) => {
    if (token !== coverToken) return;
    cover.hidden = true;
    if (DEBUG) log('cover released', r);
  });
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

async function activate3D() {
  eyes = [new sdk.EyeCamera(THREE), new sdk.EyeCamera(THREE)];
  // Commit a settled 2:1 store and let it paint (the mono loop keeps drawing into it) before
  // registering: a canvas fresh to the compositor joins slowest.
  sbs = true;
  applySize();
  await nextFrame();
  await nextFrame();
  const registeredAt = performance.now();
  handle = wall.addScene(canvas, onXRFrame, {
    virtualDisplayHeight: VDH,
    onLayerLost: () => {
      log('weave layer lost; continuing in 2D');
      fallTo2D();
    },
  });
  mode = 'xr';                // stops the mono loop; the session's frames drive onXRFrame now
  coverUntil(handle.firstWoven.then((r) => {
    firstWovenMs = r.ms;
    log('firstWoven', r, `registered ${Math.round(performance.now() - registeredAt)} ms ago`);
    return r;
  }));
  setBadge(true);
  ui.depthWrap.hidden = !sdk.inline3dViewRigSupported();
}

function fallTo2D() {
  if (mode === 'mono' && !sbs) return;
  mode = 'mono';
  sbs = false;
  handle = null;
  applySize();
  coverToken++;
  cover.hidden = true;
  ui.depthWrap.hidden = true;
  setBadge(false);
  requestAnimationFrame(onMonoFrame);
}

const rigScratch = {};
function setDepth(v) {
  if (!handle || !sdk.inline3dViewRigSupported()) return;
  handle.setViewRig(sdk.displayRig({ virtualDisplayHeight: VDH, ipdFactor: v, out: rigScratch }));
}

// ---- resize / fullscreen -------------------------------------------------------------------
function onResize() {
  if (mode === 'xr' && handle) coverUntil(handle.rewoven());   // a resize is a fresh-canvas moment
  if (applySize()) {
    // The buffer was just cleared: repaint now rather than leaving a black frame to the weave.
    if (mode === 'xr') renderStereo(null); else renderMono();
  }
}
addEventListener('resize', onResize);

async function toggleFullscreen() {
  if (mode === 'xr' && handle) coverUntil(handle.rewoven());
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (e) { log('fullscreen refused', e); }
}

// ---- styles --------------------------------------------------------------------------------
const styleButtons = styles.map((s, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = `${i + 1} ${s.name}`;
  b.title = `${s.name} (${i + 1})`;
  b.addEventListener('click', () => setStyle(i));
  ui.styles.appendChild(b);
  return b;
});

function setStyle(i) {
  if (i === current) return;
  if (current >= 0) styles[current].group.visible = false;
  current = i;
  const s = styles[i];
  s.group.visible = true;
  scene.fog = s.fog ? new THREE.Fog(0x000000, s.fog[0], s.fog[1]) : null;
  styleSince = performance.now() / 1000;
  styleButtons.forEach((b, j) => b.classList.toggle('on', j === i));
  store.set('style', i);
}

function setAuto(v) {
  auto = v;
  ui.auto.classList.toggle('on', v);
  ui.auto.setAttribute('aria-pressed', String(v));
  store.set('auto', v);
}

// ---- sources -------------------------------------------------------------------------------
async function startSource(fn) {
  ui.startError.hidden = true;
  try {
    const src = await fn();
    onSourceStarted(src);
  } catch (e) {
    if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') {
      showError('Permission was denied or the picker was closed.');
    } else if (e?.name === 'NotSupportedError') {
      showError('This browser cannot play that file. Try MP3, WAV or OGG.');
    } else {
      showError(e?.message || String(e));
    }
    console.warn('[music-visualizer] source failed', e);
  }
}

function showError(msg) {
  ui.startError.textContent = msg;
  ui.startError.hidden = false;
  showStart();
}

function onSourceStarted(src) {
  ui.label.textContent = src.label;
  ui.label.title = src.label;
  ui.seek.hidden = src.kind !== 'file';
  ui.play.hidden = !(src.kind === 'file' || src.kind === 'demo');
  updatePlayButton();
  hideStart();
  poke();
}

function showStart() {
  ui.start.hidden = false;
  ui.startClose.hidden = !audio.source;
  ui.bar.hidden = true;
}

function hideStart() {
  ui.start.hidden = true;
  ui.startError.hidden = true;
}

function playFile(file) {
  if (!file) return;
  const okType = file.type.startsWith('audio/') || file.type === 'video/webm' || file.type === 'video/ogg'
    || /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|webm)$/i.test(file.name);
  if (!okType) { showError(`"${file.name}" does not look like an audio file.`); return; }
  startSource(() => audio.playFile(file));
}

audio.onSourceEnded = (kind) => {
  showError(kind === 'tab' ? 'Tab sharing stopped.' : 'The microphone was disconnected.');
};

$('src-demo').addEventListener('click', () => startSource(() => audio.playDemo()));
$('src-file').addEventListener('click', () => ui.file.click());
$('src-tab').addEventListener('click', () => startSource(() => audio.captureTab()));
$('src-mic').addEventListener('click', () => startSource(() => audio.useMicrophone()));
ui.file.addEventListener('change', () => { playFile(ui.file.files[0]); ui.file.value = ''; });
ui.startClose.addEventListener('click', () => { hideStart(); poke(); });

// ---- transport -----------------------------------------------------------------------------
function togglePlay() {
  const s = audio.source;
  if (!s) return;
  if (s.kind === 'file') { if (s.media.paused) s.media.play(); else s.media.pause(); }
  else if (s.kind === 'demo') { if (s.demo.playing) s.demo.stop(); else s.demo.start(); }
  updatePlayButton();
}

function isPaused() {
  const s = audio.source;
  if (!s) return true;
  if (s.kind === 'file') return s.media.paused;
  if (s.kind === 'demo') return !s.demo.playing;
  return false;
}

function updatePlayButton() {
  const paused = isPaused();
  ui.play.textContent = paused ? '▶' : '❚❚';
  ui.play.setAttribute('aria-label', paused ? 'Play' : 'Pause');
}

let seeking = false;
ui.seek.addEventListener('input', () => {
  seeking = true;
  const m = audio.source?.media;
  if (m && isFinite(m.duration)) m.currentTime = (ui.seek.value / 1000) * m.duration;
});
ui.seek.addEventListener('change', () => { seeking = false; });
ui.play.addEventListener('click', togglePlay);
ui.change.addEventListener('click', showStart);
ui.fs.addEventListener('click', toggleFullscreen);
ui.auto.addEventListener('click', () => setAuto(!auto));
ui.depth.addEventListener('input', () => { const v = parseFloat(ui.depth.value); setDepth(v); store.set('depth', v); });

function fmtTime(s) {
  if (!isFinite(s)) return '';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function updateBarLive(a) {
  ui.beat.classList.toggle('hit', a.pulse > 0.45);
  const m = audio.source?.kind === 'file' ? audio.source.media : null;
  if (m && !seeking && isFinite(m.duration) && m.duration > 0) {
    ui.seek.value = String(Math.round((m.currentTime / m.duration) * 1000));
    ui.seek.title = `${fmtTime(m.currentTime)} / ${fmtTime(m.duration)}`;
  }
  if (DEBUG) {
    const st = handle ? handle.stats() : null;
    ui.hud.textContent =
      `mode=${mode} sbs=${sbs} fps=${fps.toFixed(0)}\n` +
      `buffer=${canvas.width}x${canvas.height} css=${canvas.clientWidth}x${canvas.clientHeight} dpr=${devicePixelRatio}\n` +
      `style=${styles[current].name} level=${a.level.toFixed(2)} bass=${a.bass.toFixed(2)} pulse=${a.pulse.toFixed(2)} beats=${a.beatCount}\n` +
      (st ? `frames=${st.frames} monoFrames=${st.monoFrames} firstWoven=${firstWovenMs ?? '…'}ms` : 'no inline-3D window');
  }
}

// ---- control bar auto-hide -----------------------------------------------------------------
let uiHidden = false;
let idleTimer = 0;
let pointerOverBar = false;
ui.bar.addEventListener('pointerenter', () => { pointerOverBar = true; });
ui.bar.addEventListener('pointerleave', () => { pointerOverBar = false; poke(); });

function poke() {
  document.body.classList.remove('idle');
  if (!ui.start.hidden || !audio.source) return;
  ui.bar.hidden = uiHidden;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pointerOverBar || !ui.start.hidden || document.activeElement === ui.seek) return;
    ui.bar.hidden = true;
    document.body.classList.add('idle');
  }, 3000);
}
addEventListener('pointermove', poke);
addEventListener('pointerdown', poke);

// ---- keyboard ------------------------------------------------------------------------------
addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  const k = e.key;
  if (k >= '1' && k <= String(styles.length)) { setStyle(Number(k) - 1); }
  else if (k === 'ArrowRight') setStyle((current + 1) % styles.length);
  else if (k === 'ArrowLeft') setStyle((current + styles.length - 1) % styles.length);
  else if (k === 'a' || k === 'A') setAuto(!auto);
  else if (k === 'f' || k === 'F') toggleFullscreen();
  else if (k === 'h' || k === 'H') { uiHidden = !uiHidden; ui.bar.hidden = uiHidden || !ui.start.hidden || !audio.source; }
  else if (k === ' ' && !(e.target instanceof HTMLButtonElement)) { togglePlay(); }
  else if (k === 'Escape' && !ui.start.hidden && audio.source) { hideStart(); }
  else return;
  e.preventDefault();
  poke();
});

// ---- drag and drop -------------------------------------------------------------------------
let dragDepth = 0;
addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  ui.drop.hidden = false;
});
addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) ui.drop.hidden = true; });
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  ui.drop.hidden = true;
  playFile(e.dataTransfer?.files?.[0]);
});

// ---- badge ---------------------------------------------------------------------------------
function setBadge(on3d) {
  ui.badge.classList.toggle('on', on3d);
  ui.badge.innerHTML = on3d
    ? 'Glasses-free 3D active'
    : '2D mode. For depth, open this page in the <a href="https://github.com/DisplayXR/displayxr-browser" target="_blank" rel="noopener">DisplayXR Browser</a> on a 3D display.';
  ui.badge.querySelector('a')?.style.setProperty('color', 'inherit');
}

// ---- boot ----------------------------------------------------------------------------------
setStyle(Math.min(styles.length - 1, Math.max(0, store.get('style', 0) | 0)));
setAuto(auto);
ui.depth.value = String(store.get('depth', 1));
ui.hud.hidden = !DEBUG;
applySize();
requestAnimationFrame(onMonoFrame);

if (wall) {
  try {
    await activate3D();
    const d = parseFloat(ui.depth.value);
    if (d !== 1) setDepth(d);
  } catch (e) {
    console.warn('[music-visualizer] addScene failed; running in 2D.', e);
    fallTo2D();
  }
} else {
  cover.hidden = true;
  setBadge(false);
}
log(wall ? 'inline-3D session open' : '2D mode', { sdk: !!sdk });

// Debug handle for hardware sessions.
window.__mv = { audio, styles, setStyle, get handle() { return handle; }, get wall() { return wall; } };
