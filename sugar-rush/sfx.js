// sfx.js — every sound is synthesised here with Web Audio (no audio files).

let ctx = null;
let muted = false;

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, dur, { type = 'sine', gain = 0.15, slide = 0, delay = 0 } = {}) {
  const a = ac();
  if (!a || muted) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sfx = {
  unlock: () => ac(),
  setMuted(v) {
    muted = v;
  },
  get muted() {
    return muted;
  },
  jump: () => tone(420, 0.16, { type: 'square', gain: 0.06, slide: 380 }),
  bounce: () => tone(220, 0.35, { type: 'sine', gain: 0.18, slide: 700 }),
  dash: () => tone(900, 0.18, { type: 'sawtooth', gain: 0.04, slide: -600 }),
  // A sweet's pitch climbs with the combo, so a good chain sounds like a rising scale.
  sweet: (combo = 1, kind = 'candy') => {
    const base = [0, 784, 880, 988, 1175, 1319][Math.min(5, Math.max(1, combo))];
    tone(base, 0.12, { type: 'triangle', gain: 0.08 });
    if (kind !== 'candy') tone(base * 1.5, 0.16, { type: 'sine', gain: 0.06, delay: 0.05 });
  },
  ticket: () => [523, 659, 784, 1046, 1318, 1568].forEach((f, i) => tone(f, 0.3, { type: 'triangle', gain: 0.11, delay: i * 0.08 })),
  checkpoint: () => [587, 880].forEach((f, i) => tone(f, 0.18, { type: 'sine', gain: 0.1, delay: i * 0.09 })),
  cloud: () => tone(330, 0.3, { type: 'sine', gain: 0.12, slide: 330 }),
  creak: () => tone(140, 0.3, { type: 'sawtooth', gain: 0.03, slide: -40 }),
  crumble: () => tone(90, 0.35, { type: 'square', gain: 0.05, slide: -50 }),
  splash: () => tone(160, 0.5, { type: 'sine', gain: 0.16, slide: -110 }),
  hurt: () => tone(300, 0.4, { type: 'square', gain: 0.07, slide: -220 }),
  locked: () => tone(180, 0.2, { type: 'triangle', gain: 0.1 }),
  win: () => [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.35, { type: 'triangle', gain: 0.12, delay: i * 0.1 })),
};
