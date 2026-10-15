// Audio in and out.
//
// Mic: records 16 kHz mono 16-bit WAV (Muse's voice notes are WAV, at most 2 MiB: about 60 s
// here), reports a level for the avatar, and in hands-free mode finds speech by energy so a
// sentence becomes one voice note.
//
// Speaker: plays Muse's spoken replies as the MP3 arrives (MediaSource where the browser can, a
// whole-file blob where it cannot), and measures the output level so the mouth moves with it.
// The page's own voice (avatar.say, demo mode) uses speechSynthesis with a synthetic level.

const RATE = 16000;
const MAX_SECONDS = 55;

let ctx = null;
export function audioContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}
/** Call from a user gesture: browsers start audio contexts suspended. */
export async function unlockAudio() {
  const c = audioContext();
  if (c.state !== 'running') { try { await c.resume(); } catch { /* stays suspended */ } }
  return c.state === 'running';
}

function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

// ---- mic ---------------------------------------------------------------------------------------
export class Mic {
  constructor() {
    this.stream = null;
    this.level = 0;
    this.recording = false;
    this.handsFree = false;
    this.muted = false;            // true while the avatar speaks, so it never hears itself
    this.onVoiceNote = null;       // (wavBlob, seconds) => void, for hands-free notes
    this._chunks = [];
    this._samples = 0;
    this._vad = { speaking: false, since: 0, quietSince: 0 };
  }

  get ready() { return !!this.stream; }

  async open() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const c = audioContext();
    const src = c.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but works everywhere this page runs, with no worklet file.
    const node = c.createScriptProcessor(4096, 1, 1);
    const sink = c.createGain();
    sink.gain.value = 0;
    src.connect(node);
    node.connect(sink);
    sink.connect(c.destination);
    this._ratio = c.sampleRate / RATE;
    node.onaudioprocess = (e) => this._process(e.inputBuffer.getChannelData(0));
  }

  close() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  start() {
    this._chunks = [];
    this._samples = 0;
    this.recording = true;
  }

  /** Stop and return the note as WAV, or null when it was too short to be speech. */
  stop() {
    this.recording = false;
    const seconds = this._samples / RATE;
    if (seconds < 0.35) return null;
    return { wav: encodeWav(this._chunks, this._samples), seconds };
  }

  _process(input) {
    const level = rms(input);
    this.level = this.level * 0.6 + Math.min(1, level * 9) * 0.4;
    if (this.muted) { this._vad.speaking = false; return; }
    if (this.recording) this._append(input);
    if (this.handsFree) this._detect(level);
  }

  _append(input) {
    const out = new Float32Array(Math.floor(input.length / this._ratio));
    for (let i = 0; i < out.length; i++) out[i] = input[Math.floor(i * this._ratio)];
    this._chunks.push(out);
    this._samples += out.length;
    if (this._samples > RATE * MAX_SECONDS) this._finish();
  }

  _detect(level) {
    const now = performance.now();
    const v = this._vad;
    const loud = level > 0.022;
    if (!v.speaking && loud) {
      v.speaking = true; v.since = now; v.quietSince = 0;
      this.start();
    } else if (v.speaking) {
      if (loud) v.quietSince = 0;
      else if (!v.quietSince) v.quietSince = now;
      else if (now - v.quietSince > 900) this._finish();
    }
  }

  _finish() {
    this._vad.speaking = false;
    const note = this.stop();
    if (note && note.seconds > 0.6) this.onVoiceNote?.(note.wav, note.seconds);
  }
}

function encodeWav(chunks, samples) {
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples * 2, true);
  let o = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// ---- Muse's voice: streamed MP3 ------------------------------------------------------------------
export class SpeechPlayer {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.level = 0;
    this.playing = false;
    this.onstart = null;
    this.onend = null;
    this._wired = false;
    this._queue = [];          // messages waiting: { chunks, ended, ms, sb }
    this._current = null;
    this.audio.addEventListener('ended', () => this._next());
    this.audio.addEventListener('error', () => this._next());
    this._buf = new Uint8Array(1024);
  }

  _wire() {
    if (this._wired) return;
    const c = audioContext();
    const src = c.createMediaElementSource(this.audio);
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.analyser.connect(c.destination);
    this._wired = true;
  }

  /** A new spoken message starts streaming. */
  begin(id) {
    const msg = { id, chunks: [], ended: false };
    this._queue.push(msg);
    if (!this._current) this._next();
    return msg;
  }

  push(data) {
    const msg = this._queue[this._queue.length - 1] || this._current;
    if (!msg) return;
    msg.chunks.push(new Uint8Array(data));
    msg.sb && this._feed(msg);
  }

  end() {
    const msg = this._queue[this._queue.length - 1] || this._current;
    if (!msg) return;
    msg.ended = true;
    if (msg.sb) this._feed(msg);
    else if (msg === this._current && msg.blobMode) this._playBlob(msg);
  }

  stop() {
    this._queue = [];
    this._current = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.playing) { this.playing = false; this.onend?.(); }
  }

  _next() {
    const msg = this._queue.shift();
    this._current = msg || null;
    if (!msg) {
      if (this.playing) { this.playing = false; this.onend?.(); }
      return;
    }
    this._wire();
    if (window.MediaSource && MediaSource.isTypeSupported('audio/mpeg')) {
      const ms = new MediaSource();
      msg.ms = ms;
      this.audio.src = URL.createObjectURL(ms);
      ms.addEventListener('sourceopen', () => {
        msg.sb = ms.addSourceBuffer('audio/mpeg');
        msg.sb.addEventListener('updateend', () => this._feed(msg));
        this._feed(msg);
      }, { once: true });
      this._play();
    } else {
      msg.blobMode = true;
      if (msg.ended) this._playBlob(msg);
    }
  }

  _feed(msg) {
    if (!msg.sb || msg.sb.updating || msg !== this._current) return;
    if (msg.chunks.length) {
      try { msg.sb.appendBuffer(msg.chunks.shift()); } catch (e) { console.warn('[muse-avatar] audio append failed', e); }
    } else if (msg.ended && msg.ms.readyState === 'open') {
      try { msg.ms.endOfStream(); } catch { /* already ended */ }
    }
  }

  _playBlob(msg) {
    const blob = new Blob(msg.chunks, { type: 'audio/mpeg' });
    this.audio.src = URL.createObjectURL(blob);
    this._play();
  }

  _play() {
    this.audio.play().then(() => {
      if (!this.playing) { this.playing = true; this.onstart?.(); }
    }).catch((e) => { console.warn('[muse-avatar] playback blocked', e); this._next(); });
  }

  /** 0..1, call once per frame. */
  sample() {
    if (!this.playing || !this.analyser) { this.level *= 0.85; return this.level; }
    this.analyser.getByteTimeDomainData(this._buf);
    let s = 0;
    for (let i = 0; i < this._buf.length; i++) { const d = (this._buf[i] - 128) / 128; s += d * d; }
    const v = Math.min(1, Math.sqrt(s / this._buf.length) * 4.5);
    this.level = this.level * 0.5 + v * 0.5;
    return this.level;
  }
}

// ---- the page's own voice --------------------------------------------------------------------
export class LocalVoice {
  constructor() {
    this.level = 0;
    this.speaking = false;
    this._bump = 0;
    this.available = 'speechSynthesis' in window;
  }

  speak(text, { onstart, onend } = {}) {
    if (!this.available || !text) { onend?.(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[*_#`>]/g, ''));
    u.rate = 1.03;
    u.pitch = 1.15;
    const voice = pickVoice();
    if (voice) u.voice = voice;
    u.onstart = () => { this.speaking = true; onstart?.(); };
    u.onboundary = () => { this._bump = 1; };
    u.onend = u.onerror = () => { this.speaking = false; onend?.(); };
    speechSynthesis.speak(u);
    // Some engines never fire onstart for a queued utterance: count it as started anyway.
    setTimeout(() => { if (!this.speaking && speechSynthesis.speaking) { this.speaking = true; onstart?.(); } }, 400);
  }

  stop() {
    if (this.available) speechSynthesis.cancel();
    this.speaking = false;
  }

  sample(t) {
    this._bump *= 0.86;
    const target = this.speaking ? 0.25 + 0.35 * this._bump + 0.25 * Math.abs(Math.sin(t * 17) * Math.sin(t * 5.3)) : 0;
    this.level = this.level * 0.6 + target * 0.4;
    return this.level;
  }
}

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  const en = voices.filter((v) => /^en(-|_|$)/i.test(v.lang));
  return en.find((v) => /aria|jenny|samantha|google us english|natural/i.test(v.name)) || en[0] || null;
}

/** A small JPEG still from a camera stream, for Muse to look at (bridge --vision). */
export async function cameraStill(maxSide = 768) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => setTimeout(r, 350));   // let exposure settle
    const k = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(video.videoWidth * k);
    c.height = Math.round(video.videoHeight * k);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}
