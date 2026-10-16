// Where frames come from: a webcam, a video file or URL, or the other side of a call.
//
// The Leia panel's eye-tracking camera ("SR Camera") is the only camera on many DisplayXR PCs.
// Opening it from a web page can starve the eye tracker and break the 3D weave, so it is never
// picked automatically: the app asks first.

const SR_CAMERA = /\bSR Camera\b|eye ?track/i;
const PEER_PREFIX = 'dxr-splat-call-';

export const isEyeTracker = (label) => SR_CAMERA.test(label || '');

export async function listCameras() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'videoinput').map((d) => ({ deviceId: d.deviceId, label: d.label, eyeTracker: isEyeTracker(d.label) }));
}

/** Camera permission without opening the default camera, when the browser can tell us. */
export async function cameraPermission() {
  try {
    return (await navigator.permissions.query({ name: 'camera' })).state; // granted | prompt | denied
  } catch {
    return 'prompt';
  }
}

export async function openCamera(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  });
}

export function stopStream(stream) {
  for (const t of stream?.getTracks?.() ?? []) t.stop();
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
  constructor({ onRemote, onState }) {
    this.onRemote = onRemote;
    this.onState = onState;
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
    const call = (this.media = peer.call(PEER_PREFIX + code.trim().toLowerCase(), getLocalStream()));
    this.watch(call);
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
    this.media?.close();
    this.media = null;
    this.peer?.destroy();
    this.peer = null;
  }
}
