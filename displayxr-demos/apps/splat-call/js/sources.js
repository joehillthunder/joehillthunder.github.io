// Where frames come from: a webcam, a video file or URL, or the other side of a call.
//
// The Leia panel's eye-tracking camera ("SR Camera") is the only camera on many DisplayXR PCs.
// Opening it from a web page can starve the eye tracker and break the 3D weave, so it is never
// picked automatically: the app asks first. Every other camera is recognised by `cameras.js`.

import { recognise } from './cameras.js';

const PEER_PREFIX = 'dxr-splat-call-';

export const isEyeTracker = (label) => recognise(label).kind === 'eyetracker';

/** Video inputs, each with its recognised profile. Labels are empty until permission is granted. */
export async function listCameras() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === 'videoinput')
    .map((d) => {
      const profile = recognise(d.label);
      return { deviceId: d.deviceId, label: d.label, profile, eyeTracker: profile.kind === 'eyetracker' };
    });
}

/** Call `cb()` (debounced) whenever a camera is plugged in or removed. */
export function watchDevices(cb) {
  let t = 0;
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    clearTimeout(t);
    t = setTimeout(cb, 400); // a USB camera can enumerate in several steps
  });
}

/** Camera permission without opening the default camera, when the browser can tell us. */
export async function cameraPermission() {
  try {
    return (await navigator.permissions.query({ name: 'camera' })).state; // granted | prompt | denied
  } catch {
    return 'prompt';
  }
}

/**
 * Open a camera. `profile.res` asks for the camera's native size (a stereo camera's side-by-side
 * frame), and a stereo camera is handed back as its LEFT EYE only, through a canvas, so the rest
 * of the app (the PiP, the reconstruction, the call) sees an ordinary mono camera.
 */
export async function openCamera(deviceId, profile = null) {
  const [w, h] = profile?.res || [1280, 720];
  const raw = await navigator.mediaDevices.getUserMedia({
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }), // phones: the selfie camera
      width: { ideal: w },
      height: { ideal: h },
      frameRate: { ideal: 30 },
    },
    audio: false,
  });
  const track = raw.getVideoTracks()[0];
  const p = profile || recognise(track?.label);
  const st = track?.getSettings?.() || {};
  // Side by side if the profile says so, or if any camera delivers a frame wider than 3:1.
  if (p.kind === 'stereo' || (st.width && st.height && st.width / st.height > 3)) return leftEye(raw, track.label);
  return raw;
}

/** The left half of a side-by-side stream, as a new MediaStream (stopping it stops the camera). */
async function leftEye(raw, label) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = raw;
  await v.play();
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d', { alpha: false });
  let on = true;
  const draw = () => {
    if (!on) return;
    const W = v.videoWidth, H = v.videoHeight;
    if (W && H) {
      if (c.width !== W >> 1 || c.height !== H) { c.width = W >> 1; c.height = H; }
      ctx.drawImage(v, 0, 0, W >> 1, H, 0, 0, W >> 1, H);
    }
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(draw);
    else requestAnimationFrame(draw);
  };
  draw();
  const out = c.captureStream(30);
  const t = out.getVideoTracks()[0];
  out.cameraLabel = label;
  out.stereo = true;
  out.release = () => {
    on = false;
    for (const x of raw.getTracks()) x.stop();
    v.srcObject = null;
  };
  // An unplugged stereo camera must end the mono track too, so the app notices.
  raw.getVideoTracks()[0]?.addEventListener('ended', () => {
    t.stop();
    t.dispatchEvent(new Event('ended'));
  });
  return out;
}

/** The camera's label, also for a stereo camera's left-eye stream. */
export const streamLabel = (stream) => stream?.cameraLabel || stream?.getVideoTracks?.()[0]?.label || '';

export function stopStream(stream) {
  for (const t of stream?.getTracks?.() ?? []) t.stop();
  stream?.release?.();
}

/** Point a <video> at a stream, a File or a URL, and wait until it has frames. */
export async function play(video, src) {
  video.pause();
  if (video.srcObject) video.srcObject = null;
  if (video.src?.startsWith('blob:')) URL.revokeObjectURL(video.src);
  video.removeAttribute('src');
  video.muted = true;
  video.playsInline = true;
  if (src instanceof MediaStream) {
    video.srcObject = src;
    video.loop = false;
  } else {
    video.crossOrigin = 'anonymous';
    video.src = src instanceof Blob ? URL.createObjectURL(src) : src;
    video.loop = true;
  }
  await new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error(video.error?.message || 'the video could not be loaded')); };
    const cleanup = () => { video.removeEventListener('loadeddata', ok); video.removeEventListener('error', bad); };
    if (video.readyState >= 2) return resolve();
    video.addEventListener('loadeddata', ok);
    video.addEventListener('error', bad);
  });
  await video.play();
}

/** A tiny peer-to-peer call (PeerJS public broker for signalling, media goes direct). */
export class Call {
  constructor({ onRemote, onState, onData = () => {}, onDataOpen = () => {} }) {
    this.onRemote = onRemote;
    this.onState = onState;
    this.onData = onData;
    this.onDataOpen = onDataOpen;
  }

  /** A small data channel next to the media, for camera info (the FOV the receiver needs). */
  bindData(conn) {
    this.data?.close();
    this.data = conn;
    conn.on('open', () => this.onDataOpen());
    conn.on('data', (d) => this.onData(d));
    conn.on('close', () => {
      if (this.data === conn) this.data = null;
    });
  }

  send(msg) {
    if (this.data?.open) this.data.send(msg);
  }

  async lib() {
    if (!this.Peer) ({ Peer: this.Peer } = await import('https://cdn.jsdelivr.net/npm/peerjs@1.5.5/+esm'));
    return this.Peer;
  }

  static newCode() {
    const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    const r = crypto.getRandomValues(new Uint8Array(5));
    for (const b of r) s += abc[b % abc.length];
    return s;
  }

  /** Wait for a guest. Resolves with the room code once the broker has registered us. */
  async host(getLocalStream) {
    const Peer = await this.lib();
    this.hangup();
    const code = Call.newCode();
    const peer = (this.peer = new Peer(PEER_PREFIX + code));
    await new Promise((resolve, reject) => {
      peer.once('open', resolve);
      peer.once('error', reject);
    });
    peer.on('call', (call) => {
      this.media?.close();
      this.media = call;
      call.answer(getLocalStream());
      this.watch(call);
    });
    peer.on('connection', (conn) => this.bindData(conn));
    peer.on('error', (e) => this.onState('error', e.message || String(e)));
    peer.on('disconnected', () => peer.reconnect?.());
    this.onState('waiting', code);
    return code;
  }

  async join(code, getLocalStream) {
    const Peer = await this.lib();
    this.hangup();
    const peer = (this.peer = new Peer());
    await new Promise((resolve, reject) => {
      peer.once('open', resolve);
      peer.once('error', reject);
    });
    peer.on('error', (e) => this.onState('error', e.type === 'peer-unavailable' ? `No call with code “${code}”.` : e.message || String(e)));
    this.onState('calling', code);
    const id = PEER_PREFIX + code.trim().toLowerCase();
    const call = (this.media = peer.call(id, getLocalStream()));
    this.watch(call);
    this.bindData(peer.connect(id, { reliable: true }));
  }

  watch(call) {
    call.on('stream', (stream) => {
      this.onState('connected');
      this.onRemote(stream);
    });
    call.on('close', () => {
      if (this.media === call) this.media = null;
      this.onState('ended');
    });
    call.on('error', (e) => this.onState('error', e.message || String(e)));
  }

  /** Swap the video we send (e.g. after changing camera). */
  replaceTrack(track) {
    const sender = this.media?.peerConnection?.getSenders?.().find((s) => s.track?.kind === 'video');
    sender?.replaceTrack(track);
  }

  get active() {
    return !!this.peer && !this.peer.destroyed;
  }

  hangup() {
    this.data?.close();
    this.data = null;
    this.media?.close();
    this.media = null;
    this.peer?.destroy();
    this.peer = null;
  }
}
