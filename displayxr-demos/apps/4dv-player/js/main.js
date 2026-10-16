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
  info: $('#info'),
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

/** Download a chunked clip (manifest + 8 MiB parts) as one Blob, with progress. */
async function download(clip, token) {
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
  for (const [k, b] of [...ui.clips.children].entries()) b.setAttribute('aria-current', String(k === i));
  const u = new URL(location.href);
  u.searchParams.set('clip', clip.id);
  history.replaceState(null, '', u);
  try {
    showLoading(clip.name, 'Downloading', 0);
    const blob = await download(clip, token);
    if (!blob || token !== loadToken) return;
    await openBlob(blob, clip.name, token);
  } catch (e) {
    console.error(e);
    if (token === loadToken) { hideLoading(); showError(e.message); }
  }
}

async function loadFile(file) {
  const token = ++loadToken;
  current = -1;
  for (const b of ui.clips.children) b.setAttribute('aria-current', 'false');
  try {
    showLoading(file.name, 'Reading archive');
    await openBlob(file, file.name.replace(/\.4dv$/i, ''), token);
  } catch (e) {
    console.error(e);
    if (token === loadToken) { hideLoading(); showError(e.message); }
  }
}

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
ui.file.addEventListener('change', () => {
  const f = ui.file.files?.[0];
  ui.file.value = '';
  if (f) loadFile(f);
});
// Drop a .4dv anywhere.
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
  else if (k === 'v' || k === 'V') ui.mode.click();
});

async function boot() {
  const started = stage.start();
  clips = await (await fetch('./clips/clips.json')).json();
  for (const [i, c] of clips.entries()) {
    const b = document.createElement('button');
    b.className = 'clip';
    b.type = 'button';
    b.innerHTML = `<strong></strong><span></span>`;
    b.querySelector('strong').textContent = c.name;
    b.querySelector('span').textContent = c.desc;
    b.addEventListener('click', () => loadClip(i));
    ui.clips.appendChild(b);
  }
  const { woven, firstWoven } = await started;
  ui.mode.hidden = !stage.displayModesSupported;
  document.body.classList.toggle('woven', woven);
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
