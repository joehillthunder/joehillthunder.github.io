// Muse avatar: boot, render loops, inline-3D wiring, and the conversation UI.
//
// One full-window canvas for the life of the page. On the DisplayXR Browser it is registered
// once with addScene() and renders a side-by-side pair from the session's eye views; anywhere
// else it renders one mono camera. The avatar looks at the viewer: the midpoint of the two eye
// poses on a 3D display, the pointer in 2D.
//
// Inline-3D rules followed (DisplayXR/displayxr-web docs/woven-canvas-rules.md): one
// createInline3D per document; the canvas is never remounted; its 2:1 store is sized and
// committed two frames before addScene; it stays covered until handle.firstWoven and across a
// resize until handle.rewoven(); each frame checks for two views and a viewport per eye before
// clearing and otherwise replays the last good frame; pixelRatio stays 1; overlays use plain
// translucent backgrounds (no backdrop-filter, no effects on the canvas or its ancestors).

import * as THREE from 'three';
import { createInline3D, inline3dViewRigSupported } from '@displayxr/inline3d';
import { EyeCamera, displayRig } from '@displayxr/inline3d/three';
import { Avatar } from './avatar.js';
import { Stage } from './stage.js';
import { BridgeClient } from './link.js';
import { MockMuse } from './mock.js';
import { createCommands } from './commands.js';
import { Mic, SpeechPlayer, LocalVoice, unlockAudio, cameraStill } from './voice.js';

const VDH = 0.24;                       // virtual display height, metres (the SDK default)
const POP_MAX = 0.035;                  // metres the avatar may come out of (or go behind) the glass
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const FORCE_2D = params.has('2d');
const log = (...a) => console.log('[muse-avatar]', ...a);
const $ = (id) => document.getElementById(id);

const store = {
  get(k, d) { try { const v = localStorage.getItem('muse-avatar.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('muse-avatar.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const canvas = $('stage');
const cover = $('cover');
const ui = {
  pill: $('conn'), pillText: $('conn-text'), badge: $('mode-badge'), status: $('status'), statusText: $('status-text'),
  caption: $('caption'), you: $('caption-you'), muse: $('caption-muse'), hint: $('hint'),
  form: $('ask'), input: $('ask-input'), mic: $('mic'), handsFree: $('hands-free'), look: $('look'),
  start: $('start'), startGo: $('start-go'), startDemo: $('start-demo'), startNote: $('start-note'),
  settings: $('settings'), openSettings: $('open-settings'), closeSettings: $('close-settings'),
  bridgeUrl: $('bridge-url'), bridgeKey: $('bridge-key'), connect: $('connect'), useDemo: $('use-demo'),
  voiceReplies: $('voice-replies'), mirror: $('mirror'), strength: $('strength'), pop: $('pop'), theme: $('theme'),
  tour: $('tour'), info: $('bridge-info'), fs: $('fullscreen'), hud: $('hud'), toast: $('toast'),
};

// ---- bridge settings from the address fragment (`muse-avatar url` prints it) ---------------
{
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('bridge') && hash.get('key')) {
    store.set('bridge', { url: hash.get('bridge'), key: hash.get('key') });
    history.replaceState(null, '', location.pathname + location.search);   // keep the key out of view
  }
}

// ---- 3D support ----------------------------------------------------------------------------
let wall = null;
if (!FORCE_2D) {
  try {
    const w = await createInline3D({ lazy: false });
    if (w.supported) wall = w;
  } catch (e) {
    console.warn('[muse-avatar] inline-3D unavailable; running in 2D.', e);
  }
}

// ---- renderer + scene ----------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: !!wall });
renderer.setPixelRatio(1);
renderer.autoClear = false;
renderer.setClearColor(0x05060c, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const gl = renderer.getContext();
const vpDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
const MAX_DIM = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), vpDims[0], vpDims[1]);

const scene = new THREE.Scene();
const stage = new Stage(renderer, scene);
const avatar = new Avatar();
scene.add(avatar.group);

const monoCam = new THREE.PerspectiveCamera(2 * Math.atan(VDH / 2 / 0.6) * 180 / Math.PI, 16 / 9, 0.01, 10);
monoCam.position.set(0, 0, 0.6);
monoCam.lookAt(0, 0, 0);

// ---- sizing --------------------------------------------------------------------------------
let mode = 'mono';
let sbs = false;
let aspect = 16 / 9;

function applySize() {
  const cssW = canvas.clientWidth || innerWidth;
  const cssH = canvas.clientHeight || innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = Math.round(cssW * dpr);
  let h = Math.round(cssH * dpr);
  const budget = sbs ? 4.2e6 : 2.6e6;
  const k = Math.min(1, MAX_DIM / w, MAX_DIM / h, Math.sqrt(budget / (w * h)));
  w = Math.floor(w * k); h = Math.floor(h * k);
  if (sbs) w -= w % 2;
  aspect = cssW / cssH;
  monoCam.aspect = aspect;
  monoCam.updateProjectionMatrix();
  stage.setViewport(w, h, aspect);
  if (canvas.width === w && canvas.height === h) return false;
  renderer.setSize(w, h, false);
  return true;
}

// ---- layout: avatar centre stage, or beside what it shows -----------------------------------
// The avatar stands about half the display tall, a little above centre to clear the dock.
const place = { x: 0, y: 0.024, z: 0, s: 0.68, slotX: 0.075, slotY: 0.018, slotS: 0.8 };
let popTarget = 0;

function layout(dt) {
  const narrow = aspect < 1.1;
  const busy = stage.hasContent;
  const want = narrow
    ? { x: 0, y: busy ? -0.012 : 0.03, s: busy ? 0.48 : 0.6, slotX: 0, slotY: 0.068, slotS: 0.55 }
    : { x: busy ? -0.07 : 0, y: 0.024, s: 0.68, slotX: 0.075, slotY: 0.018, slotS: 0.8 };
  const k = 1 - Math.exp(-4 * dt);
  for (const key of Object.keys(want)) place[key] += (want[key] - place[key]) * k;
  place.z += (popTarget - place.z) * k;
  avatar.group.position.set(place.x, place.y, place.z);
  avatar.group.scale.setScalar(place.s);
  stage.slot.position.set(place.slotX, place.slotY, 0.004);
  stage.slot.scale.setScalar(place.slotS);
}

// ---- conversation state ---------------------------------------------------------------------
const mic = new Mic();
const player = new SpeechPlayer();
const localVoice = new LocalVoice();
let client = null;
let pendingTurn = null;          // id of the request Muse is working on
let talking = false;             // push-to-talk is recording
let wantTalk = false;            // push-to-talk is held (talking follows once the mic is open)
let recognition = null;          // demo mode: browser speech recognition
let voiceReplies = store.get('voiceReplies', true);
let mirrorChats = store.get('mirror', false);
let depth = { strength: store.get('strength', 100), pop: 0 };
let captionTimer = 0;

const speaking = () => player.playing || localVoice.speaking;

// ---- per-frame update -----------------------------------------------------------------------
let last = 0;
let fps = 0, fpsAcc = 0, fpsFrames = 0;
const pointer = { x: 0, y: 0, at: 0 };
const viewer = new THREE.Vector3(0, 0, 0.6);
let viewerFromViews = false;

function tick() {
  const now = performance.now() / 1000;
  const dt = last ? Math.min(0.1, now - last) : 1 / 60;
  last = now;

  const level = Math.max(player.sample(), localVoice.sample(now));
  avatar.speechLevel = level;
  avatar.micLevel = mic.level;
  mic.muted = speaking();
  avatar.setState(
    talking || (mic.handsFree && mic.recording) ? 'listening'
      : speaking() ? 'speaking'
        : pendingTurn ? 'thinking'
          : client && !client.muse ? 'offline' : 'idle');

  // Gaze: the tracked viewer on a 3D display; in 2D the pointer, drifting home when it rests.
  if (!viewerFromViews) {
    const rest = now - pointer.at > 4;
    const tx = rest ? 0 : pointer.x * VDH * aspect * 0.6;
    const ty = rest ? 0 : pointer.y * VDH * 0.6;
    viewer.x += (tx - viewer.x) * 0.08;
    viewer.y += (ty - viewer.y) * 0.08;
    viewer.z = 0.6;
  }
  avatar.lookAt(viewer.x, viewer.y, viewer.z);

  layout(dt);
  avatar.update(dt);
  stage.update(dt);

  fpsAcc += dt; fpsFrames++;
  if (fpsAcc > 0.5) { fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; if (DEBUG) updateHud(); }
}

addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -((e.clientY / innerHeight) * 2 - 1);
  pointer.at = performance.now() / 1000;
});

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
let woven = false;
let firstWovenMs = null;

function onXRFrame(views, layer) {
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
      good[i].proj.set(views[i].projectionMatrix);
      good[i].xf.set(views[i].transform.matrix);
    }
    haveGood = true;
    // The viewer's head: midpoint of the two eye positions, in display metres.
    const a = good[0].xf, b = good[1].xf;
    viewer.set((a[12] + b[12]) / 2, (a[13] + b[13]) / 2, (a[14] + b[14]) / 2);
    viewerFromViews = true;
  }
  tick();
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
  eyes = [new EyeCamera(THREE), new EyeCamera(THREE)];
  sbs = true;
  applySize();
  await nextFrame();
  await nextFrame();
  const registeredAt = performance.now();
  handle = wall.addScene(canvas, onXRFrame, {
    virtualDisplayHeight: VDH,
    onLayerLost: () => { log('weave layer lost; continuing in 2D'); fallTo2D(); },
  });
  mode = 'xr';
  coverUntil(handle.firstWoven.then((r) => {
    firstWovenMs = r.ms;
    woven = !!r.woven;
    log('firstWoven', r, `registered ${Math.round(performance.now() - registeredAt)} ms ago`);
    return r;
  }));
  setBadge();
  if (depth.strength !== 100) applyStrength();
  wall.on('trackingstatechange', onTracking);
}

function fallTo2D() {
  if (mode === 'mono' && !sbs) return;
  mode = 'mono';
  sbs = false;
  handle = null;
  viewerFromViews = false;
  applySize();
  coverToken++;
  cover.hidden = true;
  setBadge();
  requestAnimationFrame(onMonoFrame);
}

let lastTracking = 'unknown';
function onTracking(state) {
  // MANAGED displays (Leia) flatten themselves; the page only reacts with a hint and a hello.
  ui.hint.hidden = state !== 'searching';
  if (state === 'tracking' && lastTracking === 'searching' && !pendingTurn && !speaking()) {
    avatar.playGesture('wave');
    avatar.setExpression('happy', 2.5);
  }
  if (state === 'searching') viewerFromViews = false;
  lastTracking = state;
}

// ---- display controls Muse can use -----------------------------------------------------------
let stereoOn = true;
const rigScratch = {};
function applyStrength() {
  if (!handle || !inline3dViewRigSupported()) return false;
  handle.setViewRig(displayRig({ virtualDisplayHeight: VDH, ipdFactor: depth.strength / 100, out: rigScratch }));
  return true;
}

const display = {
  setDepth({ strength, pop }) {
    if (Number.isFinite(strength)) { depth.strength = Math.max(0, Math.min(100, strength)); store.set('strength', depth.strength); ui.strength.value = depth.strength; }
    if (Number.isFinite(pop)) { depth.pop = Math.max(-100, Math.min(100, pop)); ui.pop.value = depth.pop; }
    popTarget = (depth.pop / 100) * POP_MAX;
    const applied = applyStrength();
    return { strength: depth.strength, pop: depth.pop, stereo_strength_applied: applied,
      note: wall ? undefined : 'This screen is 2D; pop still moves the avatar, strength has no effect.' };
  },
  async setMode(m) {
    if (!wall) return { mode: '2d', applied: false, note: 'This screen has no 3D display.' };
    stereoOn = m === '3d';
    await wall.setStereoEnabled(stereoOn);
    setBadge();
    return { mode: m, applied: true };
  },
  status() {
    return {
      mode: wall && stereoOn && mode === 'xr' ? '3d' : '2d',
      display_3d: !!wall,
      woven,
      viewer: wall ? wall.trackingState : 'unknown',
      depth: { ...depth },
      speaking: speaking(),
      listening: talking,
    };
  },
};

function sayLocally(text) {
  player.stop();
  showCaption({ muse: text });
  if (!voiceReplies && client?.kind === 'mock') return;
  localVoice.speak(text, { onend: scheduleCaptionHide });
}

const runCommand = createCommands({ avatar, stage, display, sayLocally });

// ---- client events ---------------------------------------------------------------------------
function attach(c) {
  c.on('state', (s) => setPill(s));
  c.on('welcome', (w) => {
    ui.look.hidden = !w.vision;
    ui.handsFree.disabled = false;
    ui.info.textContent = `Gadget ${w.display_name || ''} (${w.node_id}) · bridge ${w.bridge_version} · SDK ${w.sdk_version} · ` +
      `${w.commands.length} commands${w.system_commands ? ' incl. system.run' : ''}${w.side_chat ? ' · side chat' : ' · main chat'}`;
  });
  c.on('turn', (t) => {
    if (t.state === 'sending' || t.state === 'sent') { pendingTurn = t.id; setStatus(t.state === 'sending' ? 'Sending…' : 'Muse is on it…'); }
    if (t.state === 'done' && pendingTurn === t.id) {
      pendingTurn = null;
      setStatus(t.timed_out ? 'Muse took too long to answer.' : null);
      if (!speaking()) scheduleCaptionHide();
    }
  });
  c.on('status', (s) => { if (s.id === pendingTurn) setStatus(statusLabel(s)); });
  c.on('reply', (r) => {
    showCaption({ muse: r.text });
    if (r.done && r.local && voiceReplies) localVoice.speak(r.text, { onend: scheduleCaptionHide });
  });
  c.on('mirror', (m) => {
    if (!mirrorChats) return;
    showCaption({ you: 'Muse, elsewhere', muse: m.text });
    avatar.playGesture('nod');
    scheduleCaptionHide();
  });
  c.on('tts_start', (t) => { localVoice.stop(); player.begin(t.message_id); });
  c.on('tts_chunk', (data) => player.push(data));
  c.on('tts_end', (t) => {
    player.end();
    if (t.error) toast('Muse’s voice could not be played: ' + t.error);
  });
  c.on('invoke', async (m, respond) => {
    if (DEBUG) log('invoke', m.command, m.params);
    const result = await runCommand(m.command, m.params);
    respond(result);
    if (!result.ok) toast(`${m.command}: ${result.error}`);
  });
  c.on('error', (e) => {
    toast(e.error || 'Something went wrong.');
    if (e.id && e.id === pendingTurn) { pendingTurn = null; setStatus(null); }
    avatar.setExpression('confused', 3);
  });
}

player.onend = scheduleCaptionHide;

function useClient(kind) {
  client?.close();
  pendingTurn = null;
  const saved = store.get('bridge', null);
  if (kind === 'bridge' && saved?.url && saved?.key) {
    client = new BridgeClient(saved.url, saved.key);
  } else {
    client = new MockMuse({ waitForQuiet });
    ui.look.hidden = true;
    ui.info.textContent = 'Demo mode: a scripted Muse runs in this page. Connect a gadget for the real one.';
  }
  attach(client);
  client.connect();
  store.set('client', client.kind);
  ui.tour.hidden = client.kind !== 'mock';
  ui.handsFree.disabled = client.kind === 'mock';
  ui.handsFree.title = client.kind === 'mock' ? 'Hands-free needs a Muse gadget' : 'Hands-free: talk any time';
  if (client.kind === 'mock') setHandsFree(false);
}

async function waitForQuiet() {
  while (pendingTurn || speaking()) await new Promise((r) => setTimeout(r, 200));
}

function statusLabel(s) {
  if (s.text) return s.text.length > 80 ? s.text.slice(0, 77) + '…' : s.text;
  const map = { thinking: 'Thinking…', researching: 'Researching…', planning: 'Planning…', executing: 'Working on it…', generating: 'Generating…', processing: 'Processing…', working: 'Working…', responding: 'Answering…' };
  return map[s.code] || 'Working…';
}

// ---- UI helpers ------------------------------------------------------------------------------
function setPill({ connected, muse, label }) {
  ui.pillText.textContent = label;
  ui.pill.dataset.state = client?.kind === 'mock' ? 'demo' : muse ? 'live' : connected ? 'partial' : 'off';
}

function setBadge() {
  const on3d = !!wall && mode === 'xr' && stereoOn;
  ui.badge.classList.toggle('on', on3d);
  ui.badge.textContent = on3d ? '3D' : '2D';
  ui.badge.title = on3d ? 'Glasses-free 3D active' : wall ? 'Flat 2D (the display is in 2D mode)' : 'Open in the DisplayXR Browser on a 3D display for depth';
}

function setStatus(text) {
  ui.status.hidden = !text;
  if (text) ui.statusText.textContent = text;
}

function showCaption({ you, muse }) {
  clearTimeout(captionTimer);
  if (you !== undefined) { ui.you.textContent = you; ui.you.hidden = !you; }
  if (muse !== undefined) { ui.muse.textContent = muse; ui.muse.hidden = !muse; }
  ui.caption.hidden = false;
}

function scheduleCaptionHide() {
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => { if (!speaking() && !pendingTurn) ui.caption.hidden = true; }, 7000);
}

let toastTimer = 0;
function toast(text) {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 5000);
}

function updateHud() {
  const st = handle ? handle.stats() : null;
  ui.hud.textContent = `mode=${mode} sbs=${sbs} fps=${fps.toFixed(0)} buffer=${canvas.width}x${canvas.height}\n` +
    `viewer=${viewer.x.toFixed(3)},${viewer.y.toFixed(3)},${viewer.z.toFixed(3)} fromViews=${viewerFromViews} tracking=${wall?.trackingState}\n` +
    `state=${avatar.state} expr=${avatar.expression} level=${avatar.speechLevel.toFixed(2)} mic=${mic.level.toFixed(2)}\n` +
    (st ? `frames=${st.frames} monoFrames=${st.monoFrames} firstWoven=${firstWovenMs ?? '…'}ms` : 'no inline-3D window');
}

// ---- talking -------------------------------------------------------------------------------
function interrupt() {
  player.stop();
  localVoice.stop();
  client?.stopSpeech();
}

async function startTalk() {
  if (talking) return;
  wantTalk = true;
  await unlockAudio();
  interrupt();
  if (!wantTalk) return;   // released while audio was starting
  if (client.kind === 'mock') {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('This browser has no speech recognition. Type to the demo Muse instead.'); ui.input.focus(); return; }
    talking = true;
    recognition = new SR();
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = true;
    recognition.onresult = (e) => {
      const text = Array.from(e.results).map((r) => r[0].transcript).join(' ');
      showCaption({ you: text, muse: '' });
      if (e.results[e.results.length - 1].isFinal) send(text, { echo: false });
    };
    recognition.onerror = (e) => { if (e.error !== 'aborted') toast('Speech recognition: ' + e.error); };
    recognition.onend = () => { talking = false; ui.mic.classList.remove('on'); };
    recognition.start();
    ui.mic.classList.add('on');
    return;
  }
  try {
    await mic.open();
  } catch (e) {
    toast('The microphone is blocked. Allow it in the address bar, then try again.');
    return;
  }
  if (!wantTalk) return;   // released while the microphone was opening
  talking = true;
  mic.start();
  ui.mic.classList.add('on');
  showCaption({ you: 'Listening…', muse: '' });
}

async function endTalk() {
  wantTalk = false;
  if (!talking) return;
  ui.mic.classList.remove('on');
  if (client.kind === 'mock') { recognition?.stop(); return; }
  talking = false;
  const note = mic.stop();
  if (!note) { showCaption({ you: 'Too short. Hold the button while you talk.' }); scheduleCaptionHide(); return; }
  await sendVoice(note.wav, note.seconds);
}

async function sendVoice(wav, seconds) {
  showCaption({ you: `🎤 ${seconds.toFixed(1)} s voice note`, muse: '' });
  try {
    await client.voice(wav, { speak: voiceReplies });
  } catch (e) {
    toast(e.message);
  }
}

function send(text, { echo = true } = {}) {
  text = text.trim();
  if (!text) return;
  interrupt();
  if (echo) showCaption({ you: text, muse: '' });
  try {
    client.say(text, { speak: voiceReplies });
  } catch (e) {
    toast(e.message);
  }
}

function setHandsFree(on) {
  mic.handsFree = on;
  ui.handsFree.classList.toggle('on', on);
  ui.handsFree.setAttribute('aria-pressed', String(on));
  if (on) {
    mic.onVoiceNote = (wav, seconds) => sendVoice(wav, seconds);
    mic.open().catch(() => { toast('The microphone is blocked.'); setHandsFree(false); });
  }
}

// ---- wiring ----------------------------------------------------------------------------------
ui.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  await unlockAudio();
  send(ui.input.value);
  ui.input.value = '';
});
ui.mic.addEventListener('pointerdown', (e) => { ui.mic.setPointerCapture(e.pointerId); startTalk(); });
ui.mic.addEventListener('pointerup', endTalk);
ui.mic.addEventListener('pointercancel', endTalk);
ui.handsFree.addEventListener('click', async () => { await unlockAudio(); setHandsFree(!mic.handsFree); });
ui.look.addEventListener('click', async () => {
  try {
    showCaption({ you: '📷 Showing Muse the camera…', muse: '' });
    const still = await cameraStill();
    await client.look(still, ui.input.value.trim() || 'What do you see?', { speak: voiceReplies });
    ui.input.value = '';
  } catch (e) {
    toast('Camera: ' + (e.message || e));
  }
});

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.repeat) return;
  if (e.code === 'Space') { e.preventDefault(); startTalk(); }
  else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  else if (e.key === 'Escape') { interrupt(); ui.settings.hidden = true; }
});
addEventListener('keyup', (e) => { if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) endTalk(); });

ui.openSettings.addEventListener('click', () => { ui.settings.hidden = !ui.settings.hidden; });
ui.closeSettings.addEventListener('click', () => { ui.settings.hidden = true; });
ui.connect.addEventListener('click', () => {
  const url = ui.bridgeUrl.value.trim(), key = ui.bridgeKey.value.trim();
  if (!url || !key) { toast('Enter the bridge address and key (run `sudo muse-avatar url` on the gadget).'); return; }
  store.set('bridge', { url, key });
  useClient('bridge');
});
ui.useDemo.addEventListener('click', () => useClient('mock'));
ui.voiceReplies.addEventListener('change', () => { voiceReplies = ui.voiceReplies.checked; store.set('voiceReplies', voiceReplies); if (!voiceReplies) interrupt(); });
ui.mirror.addEventListener('change', () => { mirrorChats = ui.mirror.checked; store.set('mirror', mirrorChats); });
ui.strength.addEventListener('input', () => display.setDepth({ strength: Number(ui.strength.value) }));
ui.pop.addEventListener('input', () => display.setDepth({ pop: Number(ui.pop.value) }));
ui.theme.addEventListener('change', () => { stage.setTheme(ui.theme.value); store.set('theme', ui.theme.value); });
ui.tour.addEventListener('click', () => { ui.settings.hidden = true; runTour(); });
ui.fs.addEventListener('click', toggleFullscreen);

async function runTour() {
  if (client?.kind !== 'mock') return;
  await unlockAudio();
  await client.tour((line) => showCaption({ you: line, muse: '' }));
}

async function toggleFullscreen() {
  if (mode === 'xr' && handle) coverUntil(handle.rewoven());
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (e) { log('fullscreen refused', e); }
}

function onResize() {
  if (mode === 'xr' && handle) coverUntil(handle.rewoven());
  if (applySize()) {
    if (mode === 'xr') renderStereo(null); else renderMono();
  }
}
addEventListener('resize', onResize);

// ---- start ---------------------------------------------------------------------------------
async function begin(kind) {
  ui.start.hidden = true;
  await unlockAudio();
  useClient(kind);
  if (kind === 'mock' && params.has('tour')) runTour();
  else if (client.kind === 'mock') {
    setTimeout(() => { avatar.playGesture('wave'); avatar.setExpression('happy', 2.5); }, 300);
  }
}

const savedBridge = store.get('bridge', null);
ui.bridgeUrl.value = savedBridge?.url || `ws://localhost:8765`;
ui.bridgeKey.value = savedBridge?.key || '';
ui.voiceReplies.checked = voiceReplies;
ui.mirror.checked = mirrorChats;
ui.strength.value = depth.strength;
ui.pop.value = 0;
ui.theme.value = store.get('theme', 'night');
stage.setTheme(ui.theme.value);
ui.hud.hidden = !DEBUG;
const preferBridge = !params.has('demo') && savedBridge?.key;
ui.startGo.textContent = preferBridge ? 'Connect to Muse' : 'Start the demo';
ui.startDemo.hidden = !preferBridge;
ui.startNote.textContent = preferBridge
  ? `Bridge: ${savedBridge.url}`
  : 'A scripted Muse runs in this page. To talk to your own Muse, set up the gadget bridge (see the README).';
ui.startGo.addEventListener('click', () => begin(preferBridge ? 'bridge' : 'mock'));
ui.startDemo.addEventListener('click', () => begin('mock'));
setPill({ connected: false, muse: false, label: 'Not started' });

applySize();
requestAnimationFrame(onMonoFrame);
setBadge();

if (wall) {
  try {
    await activate3D();
  } catch (e) {
    console.warn('[muse-avatar] addScene failed; running in 2D.', e);
    fallTo2D();
  }
} else {
  cover.hidden = true;
}
log(wall ? 'inline-3D session open' : '2D mode');
if (params.has('autostart')) begin(preferBridge ? 'bridge' : 'mock');

// Debug handle for hardware sessions.
window.__muse = { avatar, stage, display, runCommand, get client() { return client; }, get handle() { return handle; }, get wall() { return wall; } };
