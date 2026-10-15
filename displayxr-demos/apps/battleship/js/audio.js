// Synthesised sound: no audio files. Launch roar, incoming whistle, explosions, splashes, the
// groan of a sinking hull, sonar pings and a low sea bed under it all.

export class Sfx {
  constructor() {
    this.muted = false;
    this.ctx = null;
  }

  /** Browsers only allow audio after a gesture: call from a click. */
  unlock() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // brown noise for the sea
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; b[i] = last * 3.5; }
    this.sea();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.05);
  }

  src(buf, loop = false) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = loop;
    return s;
  }

  env(peak, a, d, t0 = this.ctx.currentTime) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    return g;
  }

  sea() {
    const ctx = this.ctx;
    const s = this.src(this.brown, true);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.11;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 260;
    lfo.connect(lfoG).connect(lp.frequency);
    const g = ctx.createGain();
    g.gain.value = 0.16;
    s.connect(lp).connect(g).connect(this.master);
    s.start();
    lfo.start();
  }

  launch() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = this.src(this.noise);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(2400, t + 1.1);
    const g = this.env(0.9, 0.04, 1.3, t);
    n.connect(bp).connect(g).connect(this.master);
    n.start(t);
    n.stop(t + 1.5);
    this.thump(0.6, 90, t);
  }

  whistle(dur = 1.4) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(1500, t);
    o.frequency.exponentialRampToValueAtTime(380, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  thump(peak, f0, t = this.ctx.currentTime) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.6);
    const g = this.env(peak, 0.005, 0.8, t);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.9);
  }

  boom(big = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = this.src(this.noise);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2800, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 1.6 * big);
    const g = this.env(1.4 * Math.min(big, 1.5), 0.005, 1.8 * big, t);
    n.connect(lp).connect(g).connect(this.master);
    n.start(t);
    n.stop(t + 2.2 * big);
    this.thump(1.2, 110, t);
    // crackle
    for (let i = 0; i < 6; i++) {
      const tt = t + 0.15 + Math.random() * 0.9;
      const c = this.src(this.noise);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1800;
      const cg = this.env(0.25, 0.002, 0.06, tt);
      c.connect(hp).connect(cg).connect(this.master);
      c.start(tt, Math.random());
      c.stop(tt + 0.1);
    }
  }

  splash() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = this.src(this.noise);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1800, t);
    bp.frequency.exponentialRampToValueAtTime(500, t + 0.9);
    const g = this.env(0.8, 0.01, 1.0, t);
    n.connect(bp).connect(g).connect(this.master);
    n.start(t);
    n.stop(t + 1.2);
    this.thump(0.45, 70, t);
    for (let i = 0; i < 7; i++) this.blip(t + 0.2 + Math.random() * 0.7, 300 + Math.random() * 700, 0.06);
  }

  blip(t, f, v) {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 1.8, t + 0.06);
    const g = this.env(v, 0.003, 0.07, t);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.1);
  }

  sink() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.3;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 2.6);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    const g = this.env(0.35, 0.3, 2.6, t);
    o.connect(lp).connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 3);
    for (let i = 0; i < 18; i++) this.blip(t + 0.5 + Math.random() * 2.6, 180 + Math.random() * 500, 0.05);
  }

  ping() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 1250;
    const g = this.env(0.12, 0.005, 1.1, t);
    const dl = ctx.createDelay();
    dl.delayTime.value = 0.32;
    const fb = ctx.createGain();
    fb.gain.value = 0.35;
    o.connect(g);
    g.connect(this.master);
    g.connect(dl).connect(fb).connect(dl);
    fb.connect(this.master);
    o.start(t);
    o.stop(t + 1.2);
  }

  click(f = 900) {
    if (!this.ctx) return;
    this.blip(this.ctx.currentTime, f, 0.05);
  }

  clunk() {
    if (!this.ctx) return;
    this.thump(0.35, 160);
    this.blip(this.ctx.currentTime, 220, 0.08);
  }

  fanfare(win = true) {
    if (!this.ctx) return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    const notes = win ? [523, 659, 784, 1047, 784, 1047] : [392, 370, 349, 262];
    const lens = win ? [0.14, 0.14, 0.14, 0.36, 0.14, 0.7] : [0.3, 0.3, 0.3, 0.9];
    let t = t0;
    notes.forEach((f, i) => {
      for (const det of [0, 4]) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = f + det;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 2200;
        const g = this.env(0.06, 0.01, lens[i], t);
        o.connect(lp).connect(g).connect(this.master);
        o.start(t);
        o.stop(t + lens[i] + 0.05);
      }
      t += lens[i] * (win ? 0.9 : 1);
    });
  }
}
