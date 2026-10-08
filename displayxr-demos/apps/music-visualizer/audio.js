// Audio input and analysis.
//
// One AudioContext and one AnalyserNode for the life of the page. A source (file, tab capture,
// microphone, or the built-in demo track) connects into the analyser; switching sources
// disconnects the old one. Each frame `analyse()` turns the analyser's FFT into the numbers the
// visual styles read: 64 log-spaced bands, a waveform, bass/mid/treble levels and a beat pulse.

import { DemoTrack } from './demo-track.js';

export const BANDS = 64;
const MIN_HZ = 30;
const MAX_HZ = 16000;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.source = null;        // { kind, label, node, stream?, stop() }
    this.audioEl = null;       // persistent <audio> for files (a media element can be wrapped once)
    this.audioElNode = null;
    this.demo = null;
    this.onSourceEnded = null; // called when a stream source ends on its own (tab closed, etc.)

    // Analysis output, reused every frame (no per-frame allocation).
    this.features = {
      bands: new Float32Array(BANDS),   // 0..1, smoothed
      wave: new Float32Array(1024),     // -1..1
      level: 0, bass: 0, mid: 0, treble: 0,
      beat: false,                      // true on the frame a beat is detected
      pulse: 0,                         // 1 on a beat, decays toward 0
      beatCount: 0,
      active: false,                    // a source is connected and producing sound
    };
    this._bandRanges = null;
    this._raw = new Float32Array(BANDS);
    this._prevLow = new Float32Array(12);
    this._fluxHist = new Float32Array(60); // ~1 s of low-band onset strength at 60 fps
    this._fluxHistI = 0;
    this._lastBeat = 0;
    this._peak = 0.3;
    this._idleBeat = 0;
  }

  // Must be called from a user gesture (autoplay policy).
  async ensureContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 4096;               // ~11.7 Hz bins at 48 kHz: enough to split the bass
      this.analyser.smoothingTimeConstant = 0.55;
      this.analyser.minDecibels = -90;
      this.analyser.maxDecibels = -15;
      this._freq = new Uint8Array(this.analyser.frequencyBinCount);
      this._time = new Float32Array(this.analyser.fftSize);
      this._bandRanges = this._makeBandRanges();
    }
    if (this.ctx.state === 'suspended') {
      // Without a user gesture resume() never settles; say so instead of doing nothing.
      await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
      if (this.ctx.state !== 'running') throw new Error('The browser blocked audio. Click the button again to start it.');
    }
    return this.ctx;
  }

  _makeBandRanges() {
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    const n = this.analyser.frequencyBinCount;
    const ranges = [];
    for (let i = 0; i < BANDS; i++) {
      const lo = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, i / BANDS);
      const hi = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, (i + 1) / BANDS);
      const a = Math.min(n - 1, Math.floor(lo / binHz));
      const b = Math.min(n, Math.max(a + 1, Math.ceil(hi / binHz)));
      ranges.push([a, b]);
    }
    return ranges;
  }

  stop() {
    if (this.source) {
      try { this.source.stop(); } catch { /* already stopped */ }
      try { this.source.node.disconnect(); } catch { /* not connected */ }
    }
    this.source = null;
    this.features.active = false;
  }

  async playFile(file) {
    await this.ensureContext();
    this.stop();
    if (!this.audioEl) {
      this.audioEl = new Audio();
      this.audioEl.loop = true;
      this.audioEl.crossOrigin = 'anonymous';
      this.audioElNode = this.ctx.createMediaElementSource(this.audioEl);
    }
    if (this.audioEl.dataset.url) URL.revokeObjectURL(this.audioEl.dataset.url);
    const url = URL.createObjectURL(file);
    this.audioEl.dataset.url = url;
    this.audioEl.src = url;
    this.audioElNode.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    await this.audioEl.play();
    const el = this.audioEl;
    this.source = {
      kind: 'file',
      label: file.name.replace(/\.[^.]+$/, ''),
      node: this.audioElNode,
      media: el,
      stop: () => el.pause(),
    };
    this.features.active = true;
    return this.source;
  }

  async playDemo() {
    await this.ensureContext();
    this.stop();
    if (!this.demo) this.demo = new DemoTrack(this.ctx);
    this.demo.output.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.demo.start();
    const demo = this.demo;
    this.source = {
      kind: 'demo',
      label: 'Demo track (synthesized live)',
      node: demo.output,
      demo,
      stop: () => demo.stop(),
    };
    this.features.active = true;
    return this.source;
  }

  // Tab / system audio via screen capture. Chromium only returns audio when a video track is
  // requested too, and only if the user ticks "Share tab audio" (or "Share system audio").
  async captureTab() {
    await this.ensureContext();
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('This browser cannot capture tab audio.');
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        suppressLocalAudioPlayback: false,
      },
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      systemAudio: 'include',
    });
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('No audio was shared. Pick a tab and tick "Share tab audio".');
    }
    // We only want the sound. Stopping the video track keeps the audio track alive.
    stream.getVideoTracks().forEach((t) => t.stop());
    return this._useStream(stream, 'tab', 'Tab audio');
  }

  async useMicrophone() {
    await this.ensureContext();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    return this._useStream(stream, 'mic', 'Microphone');
  }

  _useStream(stream, kind, label) {
    this.stop();
    const node = this.ctx.createMediaStreamSource(stream);
    // Streams go to the analyser only, never the speakers: the tab already plays its own sound,
    // and a microphone routed to the speakers feeds back.
    try { this.analyser.disconnect(); } catch { /* not connected */ }
    node.connect(this.analyser);
    const track = stream.getAudioTracks()[0];
    track.addEventListener('ended', () => {
      if (this.source?.stream === stream) {
        this.stop();
        this.onSourceEnded?.(kind);
      }
    });
    this.source = {
      kind, label: track.label && kind === 'tab' ? `Tab audio: ${track.label}` : label,
      node, stream,
      stop: () => stream.getTracks().forEach((t) => t.stop()),
    };
    this.features.active = true;
    return this.source;
  }

  // ---- per-frame analysis ----------------------------------------------------------------
  analyse(dt, now) {
    const f = this.features;
    f.beat = false;
    if (!this.analyser || !this.source || this._paused()) {
      this._idle(dt, now);
      return f;
    }
    this.analyser.getByteFrequencyData(this._freq);
    this.analyser.getFloatTimeDomainData(this._time);

    // Waveform: decimate the analyser window into f.wave.
    const step = this._time.length / f.wave.length;
    for (let i = 0; i < f.wave.length; i++) f.wave[i] = this._time[Math.floor(i * step)];

    // Bands: peak bin in each log-spaced range, tilted up toward the treble (which carries less
    // energy), then auto-gained so quiet sources (a mic across the room) still fill the screen.
    let frameMax = 0;
    for (let i = 0; i < BANDS; i++) {
      const [a, b] = this._bandRanges[i];
      let m = 0;
      for (let k = a; k < b; k++) if (this._freq[k] > m) m = this._freq[k];
      const v = (m / 255) * (0.85 + 0.5 * (i / BANDS));
      this._raw[i] = v;
      if (v > frameMax) frameMax = v;
    }
    this._peak = Math.max(frameMax, this._peak * Math.exp(-dt / 6), 0.25);
    const gain = 0.95 / this._peak;
    for (let i = 0; i < BANDS; i++) {
      const v = Math.min(1, this._raw[i] * gain);
      const s = f.bands[i];
      f.bands[i] = v > s ? s + (v - s) * 0.65 : s + (v - s) * 0.18; // fast attack, slow release
    }
    this._summarise(dt);

    // Beat: onset detection on the low bands. The analyser's bytes are on a dB scale, so a kick's
    // tail stays loud between hits and a plain energy-over-average test stops firing once the
    // average catches up. Spectral flux (how much the low bands ROSE since the last frame) is
    // what spikes on a hit; it is compared against its own recent mean + spread, with a
    // refractory gap so one kick does not register twice.
    let flux = 0;
    for (let i = 0; i < 12; i++) {
      const rise = this._raw[i] - this._prevLow[i];
      if (rise > 0) flux += rise * (i < 7 ? 1 : 0.5);
      this._prevLow[i] = this._raw[i];
    }
    const h = this._fluxHist;
    let mean = 0, varc = 0;
    for (let i = 0; i < h.length; i++) mean += h[i];
    mean /= h.length;
    for (let i = 0; i < h.length; i++) varc += (h[i] - mean) ** 2;
    const std = Math.sqrt(varc / h.length);
    h[this._fluxHistI] = flux;
    this._fluxHistI = (this._fluxHistI + 1) % h.length;
    if (flux > mean + 1.4 * std && flux > 0.18 && now - this._lastBeat > 0.27) {
      this._lastBeat = now;
      this._fireBeat(Math.min(1, 0.5 + (flux - mean) * 0.6));
    }
    f.pulse *= Math.exp(-dt * 5.5);
    return f;
  }

  _paused() {
    const s = this.source;
    if (s.kind === 'file') return s.media.paused;
    if (s.kind === 'demo') return !s.demo.playing;
    return false;
  }

  _fireBeat(strength) {
    const f = this.features;
    f.beat = true;
    f.beatCount++;
    f.pulse = Math.max(f.pulse, strength);
  }

  _summarise(dt) {
    const f = this.features;
    const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += f.bands[i]; return s / (b - a); };
    const k = 1 - Math.exp(-dt * 12);
    f.bass += (avg(0, 10) - f.bass) * k;
    f.mid += (avg(10, 38) - f.mid) * k;
    f.treble += (avg(38, BANDS) - f.treble) * k;
    f.level += (avg(0, BANDS) - f.level) * k;
  }

  // No source yet (or paused): a slow synthetic "breath" so the screen is alive behind the
  // start menu and the woven window has real frames to join on.
  _idle(dt, now) {
    const f = this.features;
    for (let i = 0; i < BANDS; i++) {
      const target = 0.08 + 0.07 * Math.sin(now * 1.3 + i * 0.35) * Math.sin(now * 0.37 + i * 0.11)
        + 0.05 * Math.max(0, 1 - i / 20);
      f.bands[i] += (Math.max(0, target) - f.bands[i]) * Math.min(1, dt * 4);
    }
    for (let i = 0; i < f.wave.length; i++) {
      f.wave[i] = 0.08 * Math.sin(i * 0.05 + now * 3) * Math.sin(i * 0.007 + now * 0.5);
    }
    this._summarise(dt);
    if (now - this._idleBeat > 1.6) { this._idleBeat = now; this._fireBeat(0.25); }
    f.pulse *= Math.exp(-dt * 4);
  }
}
