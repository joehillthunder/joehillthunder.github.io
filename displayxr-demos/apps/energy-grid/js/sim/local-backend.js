// The in-browser backend: the same API as server/server.py, answered locally. Used when the page
// is served statically (GitHub Pages) and no simulation server is reachable.

import { Simulator } from './simcore.js';

function cardFor(cards, net, item) {
  if (cards[item]) return cards[item];
  const ld = net.loads[item];
  if (ld) return { title: ld.label, what: `${ld.kind} load, ${ld.customers} customer(s).`,
    role: 'Demand follows a daily curve that peaks in the late afternoon on a hot day.', nameplate: `${ld.kw} kW peak` };
  return null;
}

class WhatIfPool {
  constructor(net) {
    this.net = net;
    this.workers = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
    this.pool = [];
    this.status = { state: 'idle', done: 0, total: 0, seconds: 0, rate: 0, workers: this.workers, results: {} };
  }

  _warm() {
    if (this.pool.length) return;
    for (let i = 0; i < this.workers; i++) {
      const w = new Worker(new URL('./whatif-worker.js', import.meta.url), { type: 'module' });
      w.postMessage({ type: 'init', net: this.net });
      this.pool.push(w);
    }
  }

  run() {
    if (this.status.state === 'running') return;
    this._warm();
    // One year of hourly conditions (same generator shape as server/whatif.py, seeded).
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const conds = [];
    let cloud = 1;
    for (let i = 0; i < 8760; i++) {
      const day = Math.floor(i / 24), hod = i % 24;
      if (hod === 0) cloud = [1, 1, 0.9, 0.7, 0.4, 0.2][Math.floor(rnd() * 6)];
      const season = 1 + 0.22 * Math.cos(((day - 200) / 365) * 2 * Math.PI);
      conds.push([hod, cloud, season * (0.95 + rnd() * 0.1)]);
    }
    const ELEMENTS = ['TL1', 'XFMR', 'L1', 'L2', 'L3', 'L5', 'SW_A', 'SW_B', 'PCC'];
    const chunk = Math.max(50, Math.floor(conds.length / (this.workers * 2)));
    const tasks = [];
    for (const el of ELEMENTS) for (let i = 0; i < conds.length; i += chunk) tasks.push({ element: el, conditions: conds.slice(i, i + chunk) });
    const agg = Object.fromEntries(ELEMENTS.map((e) => [e, { n: 0, out: 0, rout: 0, over: 0, lowv: 0, worst: 0 }]));
    const st = this.status;
    Object.assign(st, { state: 'running', done: 0, total: 2 * ELEMENTS.length * conds.length, seconds: 0, rate: 0, results: {} });
    const t0 = performance.now();
    let next = 0, pending = 0;
    const finish = () => {
      for (const [el, a] of Object.entries(agg)) {
        const n = Math.max(1, a.n), out = a.out / n, rout = a.rout / n, po = a.over / n, pl = a.lowv / n;
        st.results[el] = { risk: +Math.min(1, 0.45 * out + 0.35 * rout + 0.15 * po + 0.05 * pl).toFixed(3),
          customers_out_frac: +out.toFixed(3), after_restore_frac: +rout.toFixed(3), p_overload: +po.toFixed(3),
          p_lowv: +pl.toFixed(3), worst: +a.worst.toFixed(2) };
      }
      st.state = 'done';
    };
    const feed = (w) => {
      if (next >= tasks.length) { if (pending === 0) finish(); return; }
      const t = tasks[next++];
      pending++;
      w.postMessage({ type: 'run', id: next, ...t });
    };
    for (const w of this.pool) {
      w.onmessage = (e) => {
        if (e.data.type !== 'result') return;
        pending--;
        const r = e.data, a = agg[r.element];
        a.n += r.n; a.out += r.out_frac * r.n; a.rout += r.restored_out_frac * r.n;
        a.over += r.over; a.lowv += r.lowv; a.worst = Math.max(a.worst, r.worst);
        st.done += r.flows;
        st.seconds = +((performance.now() - t0) / 1000).toFixed(2);
        st.rate = Math.round(st.done / Math.max(0.001, st.seconds));
        feed(w);
      };
      feed(w);
    }
  }
}

function gpuName() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const s = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    if (!s) return null;
    const m = s.match(/ANGLE \([^,]+, ([^(]+?)\s*(\(|Direct3D|,)/);
    return (m ? m[1] : s).trim();
  } catch { return null; }
}

export class LocalBackend {
  constructor(data) {
    this.net = data.network;
    this.cards = data.cards;
    this.sim = new Simulator(this.net);
    this.whatif = new WhatIfPool(this.net);
    this.stepMs = 0;
    this.debrief = null;
    this.hw = { machine: 'This browser (in-page simulation)', cpu: 'CPU', cores: navigator.hardwareConcurrency || null,
      gpu: gpuName(), gpu_mem_gb: null, cpu_pct: null, gpu_pct: null };
    setInterval(() => {
      const t0 = performance.now();
      this.sim.tick();
      this.stepMs = 0.8 * this.stepMs + 0.2 * (performance.now() - t0);
      const sc = this.sim.scenario;
      if (sc && sc.done && this.debrief === null) this.debrief = this._debrief(sc.score());
    }, 100);
  }

  async network() { return { network: this.net, cards: this.cards }; }

  async state() {
    const s = this.sim.snapshot();
    s.compute = { hw: this.hw, powerflow_ms: this.stepMs, engine: 'browser', whatif: this.whatif.status,
      tutor: { backend: 'offline cards (no model server)', tokens_per_s: null } };
    s.debrief = this.debrief;
    return s;
  }

  async reset(mode) { this.debrief = null; this.sim.reset(mode || 'free'); return { ok: true }; }
  async operate(device, close) { return this.sim.operate(device, !!close); }
  async bess(mode) { return this.sim.setBess(mode); }
  async identify(item) { return this.sim.identify(item); }
  async select(item) { this.sim.selected = item; return { ok: true, card: cardFor(this.cards, this.net, item) }; }
  async hint() { return { ok: true, hint: this.sim.hint() }; }
  async ack() { this.sim.ackAll(); return { ok: true }; }
  async whatifRun() { this.whatif.run(); return { ok: true }; }

  async ask(question) {
    // Same rules as server/tutor.py::_ask_cards.
    const q = question.toLowerCase();
    const alias = { battery: 'bess', microgrid: 'mg', indicator: 'fci', solar: 'pv_farm', pv: 'pv_farm' };
    const ids = q.match(/\b(bkr_f1|bkr_f2|sw_a|sw_b|tie|pcc|l1|l2|l3|l5|xfmr|tl1|bess|battery|microgrid|fci|indicator|solar|pv)\b/g) || [];
    let keys = ids.map((i) => alias[i] || (this.cards[i.toUpperCase()] ? i.toUpperCase() : i));
    if (!keys.length && this.sim.selected) keys = [this.sim.selected];
    const parts = [];
    if (['what should', 'next', 'what do i do', 'stuck', 'help', 'hint'].some((w) => q.includes(w)) && this.sim.scenario) {
      parts.push(this.sim.scenario.hint());
    }
    for (const k of keys.slice(0, 2)) {
      const c = cardFor(this.cards, this.net, k);
      if (c) parts.push(`${c.title}: ${c.what} ${c.role}`);
    }
    if (q.includes('why') && q.includes('trip')) {
      parts.unshift('A breaker trips when its relay sees current above its pickup setting. A fault draws thousands of amps, far above normal load.');
    }
    if (!parts.length) parts.push("I can explain any device (try 'what does the tie switch do?') or give you the next step ('what should I do next?').");
    return { answer: parts.join(' '), backend: 'offline cards (no model server)', seconds: 0, tokens_per_s: null };
  }

  _debrief(score) {
    const lines = [`You restored all customers in ${score.seconds} s with ${score.mistakes} mistake(s) and ${score.hints} hint(s).`];
    lines.push(score.mistakes
      ? 'Your mistakes all came from closing a device that was still connected to the fault. Isolate first (open both sides), then restore.'
      : 'You isolated before restoring, so no protective device tripped twice.');
    lines.push(`Customer-minutes interrupted: ${score.cmi.toLocaleString()}. That number feeds SAIDI, the reliability index regulators track, so every minute saved counts.`);
    lines.push('Using the battery to relieve Feeder 2 is a real microgrid service: the islandable campus becomes a grid resource when it reconnects.');
    return lines.join(' ');
  }
}
