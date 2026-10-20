// 4DV Player for DisplayXR: UI, clip downloads and keyboard, around the stage and the player.

import { Stage } from './stage.js';
import { Player } from './player.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#stage');
const cover = $('#cover');
const stage = new Stage(canvas);
const player = new Player(stage);

const ui = {
  clips: $('#clips'),
  file: $('#file'),
  play: $('#play'),
  time: $('#time'),
  scrub: $('#scrub'),
  speed: $('#speed'),
  loop: $('#loop'),
  depth: $('#depth'),
  depthVal: $('#depthVal'),
  mode: $('#mode'),
  turn: $('#turn'),
  reset: $('#reset'),
  hide: $('#hide'),
  full: $('#full'),
  info: $('#info'),
  where: $('#where'),
  loading: $('#loading'),
  loadName: $('#loadName'),
  loadStage: $('#loadStage'),
  loadBar: $('#loadBar'),
  error: $('#error'),
};

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
let clips = [];
let current = -1;
let scrubbing = false;
let loadToken = 0;

const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

stage.onTick = (dt) => {
  player.tick(dt);
  if (!player.info) return;
  ui.time.textContent = `${fmt(player.time)} / ${fmt(player.info.duration)}`;
  if (!scrubbing) ui.scrub.value = String(player.time / player.info.duration);
};
stage.onEye = (_cam, vp) => player.setViewport(vp);
stage.onModeChange = (stereo) => {
  ui.mode.textContent = stereo ? '3D' : '2D';
  ui.mode.setAttribute('aria-pressed', String(stereo));
};

function showLoading(name, stageText, pct = null) {
  ui.loading.hidden = false;
  ui.loadName.textContent = name;
  ui.loadStage.textContent = stageText;
  ui.loadBar.style.width = pct == null ? '100%' : `${Math.round(pct * 100)}%`;
  ui.loadBar.classList.toggle('indeterminate', pct == null);
}
const hideLoading = () => { ui.loading.hidden = true; };

function showError(msg) {
  ui.error.textContent = msg;
  ui.error.hidden = !msg;
}

/** Stream one file from its source (CORS required), with progress. */
async function fetchWithProgress(clip, url, token) {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
  const size = Number(res.headers.get('content-length')) || clip.size || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (token !== loadToken) { reader.cancel(); return null; }
    chunks.push(value);
    got += value.length;
    showLoading(clip.name, `Downloading ${(got / 1048576).toFixed(0)}${size ? ` / ${(size / 1048576).toFixed(0)}` : ''} MB`, size ? got / size : null);
  }
  return new Blob(chunks);
}

/** Download a clip as one Blob, with progress: a hosted chunked clip (manifest + 8 MiB parts) or a `src` URL. */
async function download(clip, token) {
  if (clip.src) return fetchWithProgress(clip, clip.src, token);
  const manUrl = new URL(clip.manifest, location.href);
  const man = await (await fetch(manUrl)).json();
  const parts = [];
  let done = 0;
  for (const part of man.parts) {
    const res = await fetch(new URL(part.url, manUrl));
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      if (token !== loadToken) { reader.cancel(); return null; }
      chunks.push(value);
      got += value.length;
      showLoading(clip.name, `Downloading ${((done + got) / 1048576).toFixed(0)} / ${(man.size / 1048576).toFixed(0)} MB`, (done + got) / man.size);
    }
    parts.push(new Blob(chunks));
    done += part.size;
  }
  return new Blob(parts);
}

async function openBlob(blob, name, token) {
  showError('');
  await player.open(blob, (s) => token === loadToken && showLoading(name, s));
  if (token !== loadToken) return;
  const info = player.info;
  const segs = info.segments.length;
  ui.info.textContent = `${name} · ${info.duration.toFixed(1)} s${segs > 1 ? ` · ${segs} segments` : ''}${info.audio ? ' · sound' : ''}`;
  hideLoading();
  ui.scrub.disabled = false;
  player.play();
}

async function loadClip(i) {
  const clip = clips[i];
  if (!clip) return;
  const token = ++loadToken;
  current = i;
  for (const b of ui.clips.querySelectorAll('.clip')) b.setAttribute('aria-current', String(Number(b.dataset.i) === i));
  const u = new URL(location.href);
  u.searchParams.set('clip', clip.id);
  history.replaceState(null, '', u);
  try {
    showLoading(clip.name, 'Downloading', 0);
    // Multi-file clips stream segment by segment from their source; the rest download whole first.
    const src = clip.remote ? { remote: clip.remote } : await download(clip, token);
    if (!src || token !== loadToken) return;
    await openBlob(src, clip.name, token);
  } catch (e) {
    console.error(e);
    if (token === loadToken) { hideLoading(); showError(e.message); }
  }
}

async function loadFile(file) {
  const token = ++loadToken;
  current = -1;
  for (const b of ui.clips.querySelectorAll('.clip')) b.setAttribute('aria-current', 'false');
  try {
    showLoading(file.name, 'Reading archive');
    await openBlob(file, file.name.replace(/\.(4dv|splatv|c\.ply|compressed\.ply|ply)$/i, ''), token);
  } catch (e) {
    console.error(e);
    if (token === loadToken) { hideLoading(); showError(e.message); }
  }
}

player.addEventListener('buffering', (e) => {
  if (e.detail) showLoading(clips[current]?.name ?? 'Clip', 'Buffering the next part', null);
  else hideLoading();
});

player.addEventListener('state', () => {
  ui.play.textContent = player.playing ? 'Pause' : 'Play';
  ui.play.setAttribute('aria-pressed', String(player.playing));
});

// Controls
ui.play.addEventListener('click', () => player.toggle());
ui.scrub.addEventListener('input', () => {
  scrubbing = true;
  if (player.info) player.seek(Number(ui.scrub.value) * player.info.duration);
});
ui.scrub.addEventListener('change', () => { scrubbing = false; });
ui.speed.addEventListener('change', () => player.setSpeed(Number(ui.speed.value)));
ui.loop.addEventListener('click', () => {
  player.loop = !player.loop;
  ui.loop.setAttribute('aria-pressed', String(player.loop));
});
const setDepth = (v) => {
  stage.depthGain = Math.max(0, Math.min(2, v));
  ui.depth.value = String(stage.depthGain);
  ui.depthVal.textContent = stage.depthGain.toFixed(1);
};
ui.depth.addEventListener('input', () => setDepth(Number(ui.depth.value)));
ui.mode.addEventListener('click', () => stage.setStereo(!stage.stereo));
ui.turn.addEventListener('click', () => {
  stage.turntable = !stage.turntable;
  ui.turn.setAttribute('aria-pressed', String(stage.turntable));
});
ui.reset.addEventListener('click', () => stage.resetView());
ui.hide.addEventListener('click', () => document.body.classList.toggle('bare'));

// Fullscreen: the page goes fullscreen with every control hidden; Esc leaves and brings them back.
// `?fullscreen` (or `?kiosk`) starts bare for a hands-off display: launch the browser with
// --start-fullscreen, and the first click or key also asks for page fullscreen (it needs a gesture).
// requestFullscreen is on the document, never the canvas, so the woven canvas is not remounted.
const params = new URLSearchParams(location.search);
const kiosk = params.has('fullscreen') || params.has('kiosk');
async function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen();
  document.body.classList.add('bare');
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    // refused (no gesture, or an iframe without allowfullscreen): stay bare in the window
  }
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && !kiosk) document.body.classList.remove('bare');
});
ui.full.addEventListener('click', toggleFullscreen);
if (kiosk) {
  document.body.classList.add('bare');
  const once = () => { if (!document.fullscreenElement) toggleFullscreen(); };
  window.addEventListener('pointerdown', once, { once: true });
  window.addEventListener('keydown', (e) => { if (e.key !== 'f' && e.key !== 'F' && e.key !== 'Escape') once(); }, { once: true });
}
// Hide the pointer after 2 s without movement while the controls are hidden.
let idleTimer = 0;
window.addEventListener('pointermove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 2000);
});
ui.file.addEventListener('change', () => {
  const f = ui.file.files?.[0];
  ui.file.value = '';
  if (f) loadFile(f);
});
// Drop a .4dv or .splatv anywhere.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  if (e.target instanceof HTMLSelectElement) return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); player.toggle(); }
  else if (k === 'r' || k === 'R') { player.seek(0); }
  else if (k === 'Home') { stage.resetView(); }
  else if (k === 't' || k === 'T') ui.turn.click();
  else if (k === '[') setDepth(stage.depthGain - 0.1);
  else if (k === ']') setDepth(stage.depthGain + 0.1);
  else if (k === 'ArrowRight' && clips.length) loadClip((current + 1) % clips.length);
  else if (k === 'ArrowLeft' && clips.length) loadClip((current - 1 + clips.length) % clips.length);
  else if (k === 'ArrowUp' || k === 'ArrowDown') {
    e.preventDefault();
    const i = SPEEDS.indexOf(player.speed);
    const j = Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 2 : i) + (k === 'ArrowUp' ? 1 : -1)));
    ui.speed.value = String(SPEEDS[j]);
    player.setSpeed(SPEEDS[j]);
  }
  else if (k === 'l' || k === 'L') ui.loop.click();
  else if (k === 'h' || k === 'H') ui.hide.click();
  else if (k === 'f' || k === 'F') toggleFullscreen();
  else if (k === 'v' || k === 'V') ui.mode.click();
});

async function boot() {
  const started = stage.start();
  clips = await (await fetch('./clips/clips.json')).json();
  let lastGroup = null;
  for (const [i, c] of clips.entries()) {
    const b = document.createElement('button');
    b.className = 'clip';
    b.type = 'button';
    b.innerHTML = `<strong></strong><span></span><em></em>`;
    b.querySelector('strong').textContent = c.name;
    b.querySelector('span').textContent = c.desc;
    b.querySelector('em').textContent = c.by ? `by ${c.by}` : '';
    if (c.group && c.group !== lastGroup) {
      const h = document.createElement('div');
      h.className = 'group';
      h.textContent = c.group;
      ui.clips.appendChild(h);
      lastGroup = c.group;
    }
    b.dataset.i = String(i);
    b.addEventListener('click', () => loadClip(i));
    ui.clips.appendChild(b);
  }
  const { woven, firstWoven } = await started;
  ui.mode.hidden = !stage.displayModesSupported;
  document.body.classList.toggle('woven', woven);
  ui.where.hidden = false;
  ui.where.textContent = woven
    ? 'Glasses-free 3D through DisplayXR'
    : '2D here. For glasses-free 3D, open this page in the DisplayXR Browser on a Leia display.';
  // Keep the canvas covered until the weave has joined (woven-canvas rule 5): a hard cut.
  firstWoven.then(() => cover.remove());
  const want = new URLSearchParams(location.search).get('clip');
  const idx = Math.max(0, clips.findIndex((c) => c.id === want));
  loadClip(idx);
}

window.fourdv = { stage, player };
boot().catch((e) => {
  console.error(e);
  showError(e.message);
});
