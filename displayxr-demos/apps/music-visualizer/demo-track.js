// The built-in demo track: a 124 BPM electronic loop synthesized live with the Web Audio API,
// so the app works with no audio files, keys or network. 32 bars: intro, drop, breakdown,
// build, drop, which gives the visualizer quiet passages and hits to react to.
//
// Standard lookahead scheduler: a timer wakes every 25 ms and schedules every 16th note that
// falls in the next 120 ms on the audio clock.

const BPM = 124;
const SIXTEENTH = 60 / BPM / 4;
const BARS = 32;

// A minor: Am - F - C - G, one chord per bar.
const CHORDS = [
  [57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62],
];
const ROOTS = [33, 29, 36, 31];
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

// Section of the arrangement for a bar.
function section(bar) {
  if (bar < 4) return 'intro';
  if (bar < 16) return 'drop';
  if (bar < 20) return 'break';
  if (bar < 24) return 'build';
  return 'drop';
}

export class DemoTrack {
  constructor(ctx) {
    this.ctx = ctx;
    this.playing = false;
    this.step = 0;
    this.nextTime = 0;
    this._timer = 0;

    this.output = ctx.createGain();
    this.output.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.7;
    this.bus.connect(comp).connect(this.output);

    // Pads and arp go through a "pump" gain the kick ducks (sidechain feel).
    this.pump = ctx.createGain();
    this.pump.connect(this.bus);

    // Feedback delay for the arp.
    this.delay = ctx.createDelay(1);
    this.delay.delayTime.value = SIXTEENTH * 3;
    const fb = ctx.createGain(); fb.gain.value = 0.35;
    const wet = ctx.createGain(); wet.gain.value = 0.3;
    this.delay.connect(fb).connect(this.delay);
    this.delay.connect(wet).connect(this.pump);

    // Shared white-noise buffer for hats, snare and risers.
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    this.nextTime = this.ctx.currentTime + 0.06;
    this.output.gain.cancelScheduledValues(this.ctx.currentTime);
    this.output.gain.setValueAtTime(0.9, this.ctx.currentTime);
    this._timer = setInterval(() => this._schedule(), 25);
    this._schedule();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this._timer);
    // Notes already scheduled keep sounding; fade the output under them instead of clicking.
    const t = this.ctx.currentTime;
    this.output.gain.cancelScheduledValues(t);
    this.output.gain.setValueAtTime(this.output.gain.value, t);
    this.output.gain.linearRampToValueAtTime(0, t + 0.08);
  }

  _schedule() {
    while (this.nextTime < this.ctx.currentTime + 0.12) {
      this._playStep(this.step, this.nextTime);
      this.nextTime += SIXTEENTH;
      this.step = (this.step + 1) % (BARS * 16);
    }
  }

  _playStep(step, t) {
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const sec = section(bar);
    const chord = bar % 4;
    const drums = sec === 'drop';

    if (drums && s % 4 === 0) this._kick(t);
    if (sec === 'build' && s % 4 === 0 && bar >= 22) this._kick(t, 0.6);
    if (drums && (s === 4 || s === 12)) this._snare(t);
    if (sec === 'build') {
      // Snare roll that doubles in speed over the four bars.
      const every = bar < 21 ? 4 : bar < 22 ? 2 : 1;
      if (s % every === 0) this._snare(t, 0.25 + 0.5 * ((bar - 20) * 16 + s) / 64);
    }
    if (drums || sec === 'build') this._hat(t, s % 4 === 2 ? 0.16 : 0.07, s % 4 === 2 ? 0.12 : 0.03);
    if (drums && s % 2 === 1) this._bass(t, ROOTS[chord] + (s === 7 || s === 15 ? 12 : 0));

    if (s === 0) this._pad(t, CHORDS[chord], sec === 'break' ? 0.11 : 0.07);
    const arpOn = sec !== 'intro' || bar >= 2;
    if (arpOn && s % 2 === 0) {
      const notes = CHORDS[chord];
      const n = notes[(s / 2) % 3] + 12 + (s >= 8 ? 12 : 0);
      this._pluck(t, n, sec === 'break' ? 0.09 : 0.06, sec === 'intro' ? 900 + bar * 600 : 3200);
    }
    if (sec === 'build' && s === 0 && bar === 20) this._riser(t, 4 * 16 * SIXTEENTH);
    if (bar === 0 && s === 0 && this._looped) this._crash(t);
    if ((bar === 4 || bar === 24) && s === 0) this._crash(t);
    if (bar === BARS - 1 && s === 15) this._looped = true;
  }

  _env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  _kick(t, vol = 1) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    this._env(g, t, 1.0 * vol, 0.002, 0.42);
    o.connect(g).connect(this.bus);
    o.start(t); o.stop(t + 0.5);
    // Duck the pads.
    const p = this.pump.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(0.25, t);
    p.linearRampToValueAtTime(1, t + SIXTEENTH * 3);
  }

  _noise(t, dur) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.start(t, Math.random() * Math.max(0, 1.9 - dur), dur + 0.05);
    return src;
  }

  _snare(t, vol = 0.5) {
    const ctx = this.ctx;
    const n = this._noise(t, 0.25);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.7;
    const g = ctx.createGain();
    this._env(g, t, vol, 0.002, 0.2);
    n.connect(bp).connect(g).connect(this.bus);
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 190;
    const og = ctx.createGain();
    this._env(og, t, vol * 0.6, 0.002, 0.09);
    o.connect(og).connect(this.bus);
    o.start(t); o.stop(t + 0.15);
  }

  _hat(t, vol, decay) {
    const ctx = this.ctx;
    const n = this._noise(t, decay + 0.02);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7500;
    const g = ctx.createGain();
    this._env(g, t, vol, 0.001, decay);
    n.connect(hp).connect(g).connect(this.bus);
  }

  _crash(t) {
    const ctx = this.ctx;
    const n = this._noise(t, 1.6);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5000;
    const g = ctx.createGain();
    this._env(g, t, 0.18, 0.002, 1.5);
    n.connect(hp).connect(g).connect(this.bus);
  }

  _riser(t, dur) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2;
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.02);
    src.connect(bp).connect(g).connect(this.bus);
    src.start(t); src.stop(t + dur + 0.05);
  }

  _bass(t, note) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(note);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 6;
    lp.frequency.setValueAtTime(1400, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.16);
    const g = ctx.createGain();
    this._env(g, t, 0.32, 0.004, 0.18);
    o.connect(lp).connect(g).connect(this.bus);
    o.start(t); o.stop(t + 0.25);
  }

  _pad(t, notes, vol) {
    const ctx = this.ctx;
    const dur = 16 * SIXTEENTH;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1300; lp.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.4);
    g.gain.setValueAtTime(vol, t + dur - 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.3);
    lp.connect(g).connect(this.pump);
    for (const n of notes) {
      for (const det of [-9, 9]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        o.frequency.value = midi(n); o.detune.value = det;
        o.connect(lp);
        o.start(t); o.stop(t + dur + 0.35);
      }
    }
  }

  _pluck(t, note, vol, cutoff) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = midi(note);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cutoff, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + 0.2);
    const g = ctx.createGain();
    this._env(g, t, vol, 0.003, 0.22);
    o.connect(lp).connect(g);
    g.connect(this.pump);
    g.connect(this.delay);
    o.start(t); o.stop(t + 0.3);
  }
}
