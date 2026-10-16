// Splat Call: a live 3D Gaussian-splat video call from one ordinary webcam, after Microsoft's
// VoluMe. The main thread captures frames, runs MediaPipe, picks the head crop and draws; the
// reconstruction worker turns each frame into Gaussians (see recon-worker.js).

import * as THREE from 'three';
import { Stage } from './stage.js';
import { LiveSplats } from './splats.js';
import { Perception } from './perception.js';
import { Call, cameraPermission, isEyeTracker, listCameras, openCamera, play, stopStream } from './sources.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const QUALITY = {
  fast: { model: 'small', S: 266, G: 160, label: 'Fast' },
  hq: { model: 'small', S: 392, G: 224, label: 'HQ' },
  ultra: { model: 'base', S: 518, G: 256, label: 'Ultra' },
};
const CAPACITY = 2 * 256 * 256;
const SAMPLE = {
  url: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/3/31/Ward_Cunningham%2C_Inventor_of_the_Wiki.webm/Ward_Cunningham%2C_Inventor_of_the_Wiki.webm.480p.vp9.webm',
  start: 12,
  credit: 'Sample: “Ward Cunningham, Inventor of the Wiki”, Wikimedia Commons, CC BY-SA 3.0',
};

const opts = {
  quality: QUALITY[params.get('q')] ? params.get('q') : 'hq',
  back: params.get('back') !== '0',
  depthColor: params.has('depthcolor'),
  mirror: true,
  smooth: 0.55,
  fov: Number(params.get('fov')) || 60, // horizontal FOV of the source camera, degrees
  defaultDist: 0.6,
};

// ---------------------------------------------------------------------------------------------
// Scene

const stage = new Stage($('stage'));
const splats = new LiveSplats(CAPACITY);
stage.scene.add(splats.mesh);
stage.setView({ target: new THREE.Vector3(0, -0.05, 0), dist: 0.9 });
stage.sway = params.has('sway');
if (params.has('depth')) stage.depthGain = Number(params.get('depth')) || 1;
addSet(stage.scene);

function addSet(scene) {
  // A soft backdrop dome and a glowing pad under the bust, so the caller sits in a space.
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(8, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {},
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 vP;
        void main(){
          float h = vP.y * 0.5 + 0.5;
          vec3 c = mix(vec3(0.015,0.02,0.04), vec3(0.05,0.07,0.13), smoothstep(0.2, 0.75, h));
          c += vec3(0.10,0.05,0.22) * pow(max(0.0, vP.z), 6.0) * 0.6;
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  dome.renderOrder = -10;
  scene.add(dome);

  const pad = new THREE.Group();
  pad.position.y = -0.36;
  const ring = (r0, r1, color, opacity) => {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(r0, r1, 96),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    m.rotation.x = -Math.PI / 2;
    pad.add(m);
    return m;
  };
  ring(0.26, 0.268, 0x5fd4ff, 0.8);
  ring(0.2, 0.203, 0x8a7dff, 0.5);
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(0.3, 64),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: 'varying vec2 vU; void main(){ vU = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying vec2 vU; void main(){ float d = length(vU - 0.5) * 2.0; gl_FragColor = vec4(vec3(0.2,0.55,1.0) * pow(1.0 - clamp(d,0.0,1.0), 2.0) * 0.35, 1.0); }',
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  pad.add(glow);
  scene.add(pad);
  stage.pad = pad;
}

// ---------------------------------------------------------------------------------------------
// Reconstruction pipeline

const worker = new Worker(new URL('./recon-worker.js', import.meta.url), { type: 'module' });
const perception = new Perception();
const localVideo = $('local');
const remoteVideo = $('remote');

const state = {
  modelReady: false,
  modelName: '',
  perceptionReady: false,
  busy: false,
  pending: false,
  id: 0,
  shownId: -1,
  roi: null,       // committed crop { x0, y0, size } in source pixels
  roiTarget: null, // damped target crop
  lastRoiT: 0,
  mode: 'idle',    // idle | local | call
  sourceKind: '',  // camera | file | sample | url
  camStream: null,
  stats: { recon: 0, model: 0, build: 0, render: 0, splats: 0, fitOk: false, zEyes: 0, device: '' },
  sortPending: false,
  sortedCam: new THREE.Vector3(1e9, 0, 0),
  orderBuf: new Float32Array(CAPACITY),
  lastFrameT: 0,
  noFaceSince: 0,
};

const source = () => (state.mode === 'call' ? remoteVideo : localVideo);

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') {
    loader.progress('Depth model', m.loaded, m.total);
  } else if (m.type === 'ready') {
    state.modelReady = true;
    state.modelName = m.model;
    state.stats.device = `${m.device}/${m.dtype}`;
    $('hudModel').textContent = `Depth Anything V2 ${m.model === 'base' ? 'Base' : 'Small'} · ${m.device === 'webgpu' ? 'WebGPU' : 'WASM'} ${m.dtype}`;
    if (m.device !== 'webgpu') toast('WebGPU is not available, so depth runs on the CPU and will be slow.');
    loader.done('model');
    kick();
  } else if (m.type === 'splats') {
    state.busy = false;
    if (m.id > state.shownId) {
      state.shownId = m.id;
      splats.setFrame({ ...m.bufs, N: m.N, count: m.count });
      const now = performance.now();
      if (state.lastFrameT) {
        const fps = 1000 / (now - state.lastFrameT);
        state.stats.recon = state.stats.recon ? state.stats.recon * 0.85 + fps * 0.15 : fps;
      }
      state.lastFrameT = now;
      const s = m.stats;
      state.stats.model = s.modelMs;
      state.stats.build = s.buildMs;
      state.stats.splats = m.N;
      state.stats.fitOk = s.fitOk;
      state.stats.zEyes = s.zEyes;
      state.sortedCam.copy(state.frameCam);
      if (!state.firstFrame) {
        state.firstFrame = true;
        $('waiting').hidden = true;
      }
    }
    worker.postMessage({ type: 'recycle', bufs: m.bufs }, [m.bufs.pos.buffer, m.bufs.covA.buffer, m.bufs.covB.buffer, m.bufs.color.buffer, m.bufs.order.buffer]);
    if (state.pending) kick();
  } else if (m.type === 'sorted') {
    state.sortPending = false;
    state.orderBuf = new Float32Array(m.buf);
    if (m.count >= 0 && m.id === state.shownId) {
      splats.setOrder(state.orderBuf, m.count);
      state.sortedCam.copy(state.sortReqCam);
    }
  } else if (m.type === 'error') {
    console.error('[splat-call] worker:', m.message);
    if (m.stage === 'init') loader.fail(`The depth model failed to load: ${m.message}`);
    else {
      state.busy = false;
      toast(`Reconstruction error: ${m.message}`);
    }
  }
};

function camPose() {
  const cam = stage.cam;
  cam.updateMatrixWorld();
  const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const dir = new THREE.Vector3();
  cam.getWorldDirection(dir);
  return { pos, dir };
}

function cropFromFace(lm, W, H) {
  let minx = 1, maxx = 0, miny = 1, maxy = 0;
  for (let i = 0; i < 468; i++) {
    const x = lm[i * 3], y = lm[i * 3 + 1];
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
  }
  const fw = (maxx - minx) * W, fh = (maxy - miny) * H;
  const fs = Math.max(fw, fh);
  // Head and shoulders: room above the hair, the shoulders below. Landmarks stop at the hairline.
  const size = fs * 2.6;
  return { x0: ((minx + maxx) / 2) * W - size / 2, y0: miny * H - fs * 0.55, size };
}

/** Damp the crop toward the face, but only move the committed crop when it is clearly off. */
function updateRoi(lm, W, H) {
  const now = performance.now();
  const dt = state.lastRoiT ? Math.min(0.5, (now - state.lastRoiT) / 1000) : 0;
  state.lastRoiT = now;
  let target = lm ? cropFromFace(lm, W, H) : null;
  if (!target) {
    if (state.roi) return state.roi;
    const size = Math.min(W, H) * 0.92;
    return (state.roi = { x0: (W - size) / 2, y0: H * 0.04, size });
  }
  if (!state.roiTarget || !dt) state.roiTarget = { ...target };
  else {
    const k = 1 - Math.exp(-4 * dt);
    for (const key of ['x0', 'y0', 'size']) state.roiTarget[key] += (target[key] - state.roiTarget[key]) * k;
  }
  const t = state.roiTarget;
  const r = state.roi;
  if (!r || Math.abs(t.x0 - r.x0) > r.size * 0.05 || Math.abs(t.y0 - r.y0) > r.size * 0.05 || Math.abs(t.size - r.size) > r.size * 0.07) {
    state.roi = { x0: Math.round(t.x0), y0: Math.round(t.y0), size: Math.round(t.size) };
  }
  return state.roi;
}

async function processFrame() {
  const v = source();
  const W = v.videoWidth, H = v.videoHeight;
  if (!W || !H) return false;
  const q = QUALITY[opts.quality];
  if (state.modelName !== q.model) return false; // a model swap is loading
  const det = perception.detect(v);
  if (!det.mask) return false;
  if (!det.lm) {
    state.noFaceSince ||= performance.now();
    if (performance.now() - state.noFaceSince > 1500) $('noface').hidden = false;
  } else {
    state.noFaceSince = 0;
    $('noface').hidden = true;
  }
  const roi = updateRoi(det.lm, W, H);
  const bitmap = await createImageBitmap(v, roi.x0, roi.y0, roi.size, roi.size, { resizeWidth: q.S, resizeHeight: q.S, resizeQuality: 'medium' });
  const f = W / 2 / Math.tan(THREE.MathUtils.degToRad(opts.fov) / 2);
  const { pos, dir } = camPose();
  state.frameCam = pos.clone();
  const id = ++state.id;
  const transfer = [bitmap, det.mask.buffer];
  if (det.lm) transfer.push(det.lm.buffer);
  worker.postMessage({
    type: 'frame', id, bitmap, S: q.S, W, H, f, roi, lm: det.lm, mask: det.mask, mw: det.mw, mh: det.mh,
    t: performance.now(),
    opts: { G: q.G, back: opts.back, depthColor: opts.depthColor, mirror: opts.mirror, smooth: opts.smooth, defaultDist: opts.defaultDist },
    cam: pos.toArray(), dir: dir.toArray(),
  }, transfer);
  return true;
}

/** Start the next frame if the worker is free; otherwise remember that one is waiting. */
async function kick() {
  if (!state.modelReady || !state.perceptionReady || state.mode === 'idle') return;
  if (state.busy) { state.pending = true; return; }
  const v = source();
  if (v.readyState < 2 || v.paused && !v.srcObject) { state.pending = true; return; }
  state.pending = false;
  state.busy = true;
  let sent = false;
  try {
    sent = await processFrame();
  } catch (e) {
    console.error('[splat-call] frame', e);
  }
  if (!sent) {
    state.busy = false;
    state.pending = true;
  }
}

function watchVideo(v) {
  const onFrame = () => {
    if (source() === v) kick();
    v.requestVideoFrameCallback(onFrame);
  };
  v.requestVideoFrameCallback(onFrame);
}
watchVideo(localVideo);
watchVideo(remoteVideo);

// Re-sort when the view has moved since the last order, e.g. while orbiting a paused clip.
stage.onTick = (dt) => {
  state.stats.render = state.stats.render ? state.stats.render * 0.95 + (1 / dt) * 0.05 : 1 / dt;
  if (state.shownId < 0 || state.sortPending) return;
  const { pos, dir } = camPose();
  if (pos.distanceTo(state.sortedCam) < 0.004) return;
  state.sortPending = true;
  state.sortReqCam = pos;
  const buf = state.orderBuf.buffer;
  worker.postMessage({ type: 'sort', id: state.shownId, cam: pos.toArray(), dir: dir.toArray(), buf }, [buf]);
};
stage.onEye = (cam, viewport) => splats.setViewport(viewport);

// ---------------------------------------------------------------------------------------------
// Sources

async function useCamera(deviceId, { allowEyeTracker = false } = {}) {
  let stream;
  try {
    stream = await openCamera(deviceId);
  } catch (e) {
    toast(e.name === 'NotAllowedError' ? 'Camera permission was denied.' : `The camera could not be opened: ${e.message}`);
    return false;
  }
  const label = stream.getVideoTracks()[0]?.label || '';
  if (isEyeTracker(label) && !allowEyeTracker) {
    // The browser picked the eye tracker. Use another camera if there is one, otherwise ask.
    stopStream(stream);
    const other = (await listCameras()).find((c) => !c.eyeTracker);
    if (other) return useCamera(other.deviceId);
    showDialog('srDlg');
    return false;
  }
  stopStream(state.camStream);
  state.camStream = stream;
  await play(localVideo, stream);
  setLocal('camera', label);
  call.replaceTrack(stream.getVideoTracks()[0]);
  await fillCameraList(stream.getVideoTracks()[0]?.getSettings().deviceId);
  return true;
}

async function useClip(src, kind, credit = '') {
  stopStream(state.camStream);
  state.camStream = null;
  try {
    await play(localVideo, src);
  } catch (e) {
    toast(`That video could not be played: ${e.message}`);
    return false;
  }
  if (kind === 'sample' && SAMPLE.start) localVideo.currentTime = SAMPLE.start;
  setLocal(kind, credit);
  return true;
}

function setLocal(kind, label) {
  state.sourceKind = kind;
  if (state.mode !== 'call') {
    state.mode = 'local';
    opts.mirror = kind === 'camera';
    resetRecon();
  }
  document.body.classList.toggle('mirror-pip', kind === 'camera');
  $('credit').textContent = kind === 'sample' ? SAMPLE.credit : '';
  $('srcLabel').textContent = kind === 'camera' ? label.replace(/\s*\(.*\)$/, '') : kind === 'file' ? 'Video file' : kind === 'sample' ? 'Sample clip' : 'Video';
  hideStart();
  kick();
}

function resetRecon() {
  state.roi = state.roiTarget = null;
  state.firstFrame = false;
  $('waiting').hidden = false;
  worker.postMessage({ type: 'reset' });
}

async function fillCameraList(activeId) {
  const sel = $('selCam');
  const cams = await listCameras();
  sel.innerHTML = '';
  for (const c of cams) {
    const o = document.createElement('option');
    o.value = c.deviceId;
    o.textContent = (c.label || 'Camera').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '') + (c.eyeTracker ? ' (eye tracker)' : '');
    sel.append(o);
  }
  const o = document.createElement('option');
  o.value = '__file';
  o.textContent = 'Video file…';
  sel.append(o);
  const s = document.createElement('option');
  s.value = '__sample';
  s.textContent = 'Sample clip';
  sel.append(s);
  sel.value = state.sourceKind === 'camera' ? activeId : state.sourceKind === 'sample' ? '__sample' : '';
}

async function startCamera() {
  const want = params.get('cam');
  if ((await cameraPermission()) === 'granted') {
    const cams = await listCameras();
    const pick = (want && cams.find((c) => c.label.toLowerCase().includes(want.toLowerCase()))) || cams.find((c) => !c.eyeTracker);
    if (pick) return useCamera(pick.deviceId, { allowEyeTracker: pick.eyeTracker });
    if (cams.length) { showDialog('srDlg'); return false; }
    toast('No camera was found. Try a video file or the sample clip.');
    return false;
  }
  return useCamera();
}

// ---------------------------------------------------------------------------------------------
// Call

const call = new Call({
  onRemote: async (stream) => {
    state.mode = 'call';
    opts.mirror = false;
    resetRecon();
    await play(remoteVideo, stream);
    document.body.classList.add('in-call');
    $('srcLabel').textContent = 'You';
    hideStart();
    closeDialogs();
    kick();
  },
  onState: (s, info) => {
    const el = $('callState');
    document.body.classList.toggle('call-live', call.active);
    if (s === 'waiting') {
      const link = `${location.origin}${location.pathname}?join=${info}`;
      $('callCode').textContent = info;
      $('callLink').value = link;
      $('hostInfo').hidden = false;
      el.textContent = 'Waiting for someone to join…';
    } else if (s === 'calling') el.textContent = `Calling ${info}…`;
    else if (s === 'connected') el.textContent = 'Connected';
    else if (s === 'ended') {
      el.textContent = 'Call ended';
      endCall();
    } else if (s === 'error') {
      el.textContent = info;
      toast(info);
    }
  },
});

function localStreamForCall() {
  if (state.camStream) return state.camStream;
  if (localVideo.captureStream && localVideo.readyState >= 2) return localVideo.captureStream();
  // Nothing to send: a black placeholder so the other side can still see us arrive.
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 240;
  c.getContext('2d').fillRect(0, 0, 320, 240);
  return c.captureStream(1);
}

function endCall() {
  call.hangup();
  document.body.classList.remove('in-call', 'call-live');
  remoteVideo.srcObject = null;
  $('hostInfo').hidden = true;
  if (state.mode === 'call') {
    state.mode = state.sourceKind ? 'local' : 'idle';
    opts.mirror = state.sourceKind === 'camera';
    resetRecon();
    if (state.mode === 'idle') showStart();
    kick();
  }
}

// ---------------------------------------------------------------------------------------------
// UI

const loader = {
  parts: new Map(),
  progress(name, loaded, total) {
    $('loadText').textContent = `Downloading ${name.toLowerCase()}… ${total ? Math.round((100 * loaded) / total) : 0}%`;
    $('loadBar').style.width = `${total ? (100 * loaded) / total : 5}%`;
  },
  done(part) {
    this.parts.set(part, true);
    if (this.parts.get('model') && this.parts.get('perception')) {
      $('loading').hidden = true;
    } else {
      $('loadText').textContent = this.parts.get('model') ? 'Loading face tracking…' : 'Loading depth model…';
    }
  },
  fail(msg) {
    $('loadText').textContent = msg;
    $('loading').classList.add('failed');
  },
};

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
}

function showDialog(id) {
  closeDialogs();
  $(id).hidden = false;
}
function closeDialogs() {
  for (const d of document.querySelectorAll('.dialog')) d.hidden = true;
}
function showStart() { $('start').hidden = false; }
function hideStart() { $('start').hidden = true; }

function setToggle(id, on) {
  $(id).classList.toggle('on', on);
  $(id).setAttribute('aria-pressed', String(on));
}

function setQuality(q) {
  opts.quality = q;
  $('selQuality').value = q;
  const want = QUALITY[q].model;
  if (want !== state.modelName) {
    state.modelReady = false;
    $('loading').hidden = false;
    $('loading').classList.remove('failed');
    loader.parts.set('model', false);
    $('loadText').textContent = want === 'base' ? 'Loading the larger depth model (non-commercial licence)…' : 'Loading depth model…';
    worker.postMessage({ type: 'init', model: want });
  }
  resetRecon();
  kick();
}

function bindUi() {
  $('btnCamera').onclick = () => startCamera();
  $('btnSample').onclick = () => useClip(SAMPLE.url, 'sample');
  $('btnFile').onclick = () => $('file').click();
  $('btnStartCall').onclick = () => showDialog('callDlg');
  $('file').onchange = () => {
    const f = $('file').files?.[0];
    if (f) useClip(f, 'file');
    $('file').value = '';
  };
  $('selCam').onchange = () => {
    const v = $('selCam').value;
    if (v === '__file') $('file').click();
    else if (v === '__sample') useClip(SAMPLE.url, 'sample');
    else {
      const label = $('selCam').selectedOptions[0]?.textContent || '';
      if (/eye tracker/.test(label)) showDialog('srDlg');
      else useCamera(v);
    }
  };
  $('btnSrUse').onclick = async () => {
    closeDialogs();
    const sr = (await listCameras()).find((c) => c.eyeTracker);
    useCamera(sr?.deviceId, { allowEyeTracker: true });
  };
  for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => closeDialogs();

  $('selQuality').onchange = () => setQuality($('selQuality').value);
  $('tglBack').onclick = () => { opts.back = !opts.back; setToggle('tglBack', opts.back); };
  $('tglDepth').onclick = () => { opts.depthColor = !opts.depthColor; setToggle('tglDepth', opts.depthColor); };
  $('tglSway').onclick = () => { stage.sway = !stage.sway; setToggle('tglSway', stage.sway); };
  $('btnReset').onclick = () => stage.resetView();
  $('btnHelp').onclick = () => showDialog('helpDlg');
  $('btnCall').onclick = () => (call.active ? endCall() : showDialog('callDlg'));
  $('btnHost').onclick = async () => {
    $('callState').textContent = 'Opening a room…';
    try { await call.host(localStreamForCall); } catch (e) { $('callState').textContent = `Could not open a room: ${e.message || e}`; }
  };
  $('btnJoinGo').onclick = async () => {
    const code = $('inpJoin').value.trim();
    if (!code) return;
    try { await call.join(code, localStreamForCall); } catch (e) { $('callState').textContent = `Could not join: ${e.message || e}`; }
  };
  $('btnCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('callLink').value); $('btnCopy').textContent = 'Copied'; } catch { $('callLink').select(); }
    setTimeout(() => ($('btnCopy').textContent = 'Copy link'), 1500);
  };
  $('btnHang').onclick = () => endCall();
  $('rngDepth').oninput = () => { stage.depthGain = Number($('rngDepth').value); };

  setToggle('tglBack', opts.back);
  setToggle('tglDepth', opts.depthColor);
  setToggle('tglSway', stage.sway);
  $('selQuality').value = opts.quality;

  addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'r') stage.resetView();
    else if (k === 'b') $('tglBack').click();
    else if (k === 'd') $('tglDepth').click();
    else if (k === 's') $('tglSway').click();
    else if (k === 'h' || k === '?') showDialog('helpDlg');
    else if (k === 'escape') closeDialogs();
    else if (k === '1') setQuality('fast');
    else if (k === '2') setQuality('hq');
    else if (k === '3') setQuality('ultra');
    else if (k === 'p') document.body.classList.toggle('no-pip');
  });

  // Drop a video anywhere.
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    e.preventDefault();
    const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('video/'));
    if (f) useClip(f, 'file');
  });
}

function hud() {
  const s = state.stats;
  $('hudFps').textContent = s.recon ? `${s.recon.toFixed(0)} fps` : '–';
  $('hudSplats').textContent = s.splats ? `${(s.splats / 1000).toFixed(0)}k splats` : '–';
  $('hudMs').textContent = s.model ? `depth ${s.model.toFixed(0)} ms · build ${s.build.toFixed(0)} ms` : '';
  $('hudFit').textContent = s.zEyes ? `${s.fitOk ? 'metric fit' : 'held fit'} · ${(s.zEyes * 100).toFixed(0)} cm` : '';
  $('hudFit').classList.toggle('warn', !s.fitOk);
}
setInterval(hud, 500);

// ---------------------------------------------------------------------------------------------
// Boot

async function boot() {
  bindUi();
  const { woven, firstWoven } = await stage.start();
  document.body.classList.toggle('woven', woven);
  // Keep the canvas covered until the browser has joined it, or a raw side-by-side pair flashes.
  firstWoven.then(() => ($('cover').hidden = true));
  $('hudMode').textContent = woven ? '3D' : '2D';
  stage.onModeChange = (stereo) => ($('hudMode').textContent = stage.woven ? (stereo ? '3D' : '3D off') : '2D');
  if (!woven && !params.has('sway') && !params.has('nosway')) {
    // Flat screens get a gentle sway so the volume reads; the Leia panel's own parallax does it in 3D.
    stage.sway = true;
    setToggle('tglSway', true);
  }

  worker.postMessage({ type: 'init', model: QUALITY[opts.quality].model });
  perception.init().then(() => {
    state.perceptionReady = true;
    loader.done('perception');
    kick();
  }, (e) => loader.fail(`Face tracking failed to load: ${e.message || e}`));

  const join = params.get('join');
  if (join) {
    $('inpJoin').value = join;
    showDialog('callDlg');
  }
  if (params.get('src')) useClip(params.get('src'), 'url');
  else if (params.has('sample')) useClip(SAMPLE.url, 'sample');
  else if (params.has('camera')) startCamera();
}

window.splatCall = { stage, splats, state, opts, worker, perception, call, setQuality, useClip, useCamera, SAMPLE };
boot();
