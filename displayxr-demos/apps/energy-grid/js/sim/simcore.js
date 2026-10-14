// In-browser simulator: clock, protection, alarms, battery and the storm scenario.
// A line-for-line port of server/sim.py, so both builds behave the same.

import { Grid } from './powerflow.js';

const FCI_AMPS = 600;
const BESS_MODES = { discharge: 1.0, idle: 0.0, charge: -0.5 };

export function clockStr(simS) {
  const h = Math.floor(simS / 3600) % 24, m = Math.floor((simS % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export class Simulator {
  constructor(net) {
    this.net = net;
    this.reset('free');
  }

  reset(mode = 'free') {
    this.grid = new Grid(this.net);
    this.mode = mode;
    this.speed = mode === 'free' ? 30 : 12;
    this.simS = mode === 'free' ? 14 * 3600 : 16 * 3600 + 25 * 60;
    this.grid.hour = this.simS / 3600;
    this.grid.cloud = 0.9;
    this.bessMode = mode === 'free' ? 'charge' : 'idle';
    this.soc = 0.82;
    this.fci = {};
    this.alarms = [];
    this.alarmKeys = new Set();
    this.alarmSeq = 0;
    this.events = [];
    this.mistakes = [];
    this.hintsUsed = 0;
    this.cmi = 0;
    this.selected = null;
    this.scenario = mode === 'storm' ? new StormScenario(this) : null;
    this.result = this.grid.solve();
    this.lastTick = performance.now();
    this.postSolve();
  }

  tick() {
    const now = performance.now();
    const dtReal = Math.min(0.5, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const dtSim = dtReal * this.speed;
    this.simS += dtSim;
    const g = this.grid;
    g.hour = (this.simS / 3600) % 24;
    if (this.scenario) this.scenario.tick(dtReal);
    if (!g.islanded) {
      let kw = BESS_MODES[this.bessMode] * this.net.bess.kw;
      if ((kw > 0 && this.soc <= 0.05) || (kw < 0 && this.soc >= 0.98)) kw = 0;
      g.bessKw = kw;
    }
    this.result = g.solve();
    this.soc = Math.min(1, Math.max(0, this.soc - (this.result.bess_kw * dtSim) / 3600 / this.net.bess.kwh));
    if (g.islanded && this.soc <= 0.02) this.alarm(1, 'BESS', 'Battery empty: microgrid blackout', 'bess_empty');
    this.cmi += (this.customersOut() * dtSim) / 60;
    this.postSolve();
  }

  customersOut() {
    let n = 0;
    for (const [k, v] of Object.entries(this.result.loads)) if (!v.served) n += this.net.loads[k].customers;
    return n;
  }

  customersTotal() { return Object.values(this.net.loads).reduce((a, l) => a + l.customers, 0); }

  frequency() {
    const j = (a) => (Math.random() * 2 - 1) * a;
    return this.grid.islanded ? 60 - 0.03 * (this.result.bess_kw / this.net.bess.kw) + j(0.006) : 60 + j(0.003);
  }

  alarm(pri, device, text, key) {
    key = key || `${device}:${text}`;
    if (this.alarmKeys.has(key)) return;
    this.alarmKeys.add(key);
    this.alarms.unshift({ id: ++this.alarmSeq, key, pri, device, text, t: clockStr(this.simS), acked: false, active: true });
    this.alarms = this.alarms.slice(0, 40);
  }

  clearAlarm(key) {
    if (!this.alarmKeys.has(key)) return;
    this.alarmKeys.delete(key);
    for (const a of this.alarms) if (a.key === key) a.active = false;
  }

  postSolve() {
    const r = this.result;
    for (const [k, b] of Object.entries(r.branches)) {
      const hi = `${k}:overload`, warn = `${k}:near`;
      if (b.loading > 1.0) { this.alarm(2, k, `Overload ${Math.round(b.loading * 100)}% of rating`, hi); this.clearAlarm(warn); }
      else if (b.loading > 0.9) { this.alarm(3, k, `Loading ${Math.round(b.loading * 100)}%, approaching rating`, warn); this.clearAlarm(hi); }
      else { this.clearAlarm(hi); this.clearAlarm(warn); }
    }
    for (const [k, bus] of Object.entries(r.buses)) {
      const key = `${k}:lowv`;
      if (bus.energized && bus.vpu < 0.95) this.alarm(3, k, `Low voltage ${bus.vpu.toFixed(3)} pu`, key);
      else this.clearAlarm(key);
    }
    for (const a of this.alarms) {
      if (a.active && a.key.includes(':trip:') && this.grid.closed[a.device]) this.clearAlarm(a.key);
    }
    const out = this.customersOut();
    const live = this.alarms.find((a) => a.key === 'cust_out' && a.active);
    if (out && live) {
      const text = `${out} customers without power`;
      if (live.text !== text) { live.text = text; live.t = clockStr(this.simS); live.acked = false; }
    } else if (out) this.alarm(1, 'SYSTEM', `${out} customers without power`, 'cust_out');
    else this.clearAlarm('cust_out');
  }

  ackAll() { for (const a of this.alarms) a.acked = true; }

  protect(cause) {
    const g = this.grid, net = this.net;
    const tripped = [];
    for (let n = 0; n < 4 && g.faultBus; n++) {
      const [fc] = g.faultCurrents();
      for (const [k, amps] of Object.entries(fc)) {
        if (['line', 'switch', 'breaker'].includes(net.branches[k].kind) && amps > FCI_AMPS && !this.fci[k]) this.fci[k] = Math.round(amps);
      }
      const tripNow = Object.entries(net.protection).filter(([d, pick]) => g.closed[d] && (fc[d] || 0) > pick).map(([d]) => d);
      if (!tripNow.length) break;
      for (const d of tripNow) {
        g.closed[d] = false;
        tripped.push(d);
        this.events.push({ t: clockStr(this.simS), who: 'protection', text: `${d} tripped on ${(fc[d] / 1000).toFixed(1)} kA fault current` });
        this.alarm(1, d, `Tripped: overcurrent ${(fc[d] / 1000).toFixed(1)} kA`, `${d}:trip:${this.events.length}`);
      }
    }
    let r = g.solve();
    if (g.closed.PCC && !r.buses.f4.energized) {
      g.closed.PCC = false;
      g.islanded = true;
      tripped.push('PCC');
      this.events.push({ t: clockStr(this.simS), who: 'protection', text: 'PCC opened on loss of grid voltage; microgrid islanded, battery grid-forming' });
      this.alarm(2, 'PCC', 'Microgrid islanded: battery is grid-forming', 'islanded');
      r = g.solve();
    }
    this.result = r;
    this.postSolve();
    if (tripped.length && cause) {
      this.mistakes.push({ t: clockStr(this.simS), action: cause, text: `${cause} energized the fault: ${tripped.join(', ')} tripped` });
    }
    return tripped;
  }

  operate(device, close) {
    const g = this.grid, b = this.net.branches[device];
    if (!b || !['breaker', 'switch'].includes(b.kind)) return { ok: false, msg: `${device} is not operable` };
    if (g.closed[device] === close) return { ok: false, msg: `${device} is already ${close ? 'closed' : 'open'}` };
    if (device === 'PCC' && close && !this.result.buses.f4.energized) {
      return { ok: false, msg: 'Sync check failed: no grid voltage at the PCC. Restore the feeder before reconnecting the microgrid.' };
    }
    const verb = close ? 'Closed' : 'Opened';
    g.closed[device] = close;
    if (device === 'PCC') { g.islanded = !close; if (close) this.clearAlarm('islanded'); }
    this.events.push({ t: clockStr(this.simS), who: 'trainee', text: `${verb} ${device}` });
    const tripped = this.protect(close ? `${verb} ${device}` : null);
    if (this.scenario) this.scenario.check();
    return { ok: true, msg: `${verb} ${device}` + (tripped.length ? ` — protection tripped ${tripped.join(', ')}` : ''), tripped };
  }

  setBess(mode) {
    if (!(mode in BESS_MODES)) return { ok: false, msg: 'unknown mode' };
    this.bessMode = mode;
    this.events.push({ t: clockStr(this.simS), who: 'trainee', text: `Battery set to ${mode}` });
    return { ok: true, msg: `Battery: ${mode}` + (this.grid.islanded ? ' (islanded: battery follows the load until reconnected)' : '') };
  }

  identify(item) {
    this.selected = item;
    return this.scenario ? this.scenario.onIdentify(item) : { ok: true };
  }

  hint() {
    this.hintsUsed++;
    return this.scenario ? this.scenario.hint() : 'Explore: click any equipment to learn what it does.';
  }

  snapshot() {
    const r = this.result;
    const loadKw = Object.values(r.loads).reduce((a, v) => a + v.kw, 0);
    const pvKw = Object.values(r.pv).reduce((a, v) => a + v.kw, 0);
    return {
      mode: this.mode, clock: clockStr(this.simS), hour: this.grid.hour, cloud: this.grid.cloud, converged: r.converged,
      buses: r.buses, branches: r.branches, loads: r.loads, pv: r.pv, closed: { ...this.grid.closed }, fci: this.fci,
      fault: this.grid.faultBus, islanded: this.grid.islanded,
      bess: { kw: r.bess_kw, soc: this.soc, mode: this.bessMode },
      kpi: { load_kw: Math.round(loadKw), pv_kw: Math.round(pvKw), import_kw: Math.round(r.import_kw), bess_kw: Math.round(r.bess_kw),
        losses_kw: r.losses_kw, freq: this.frequency(), customers_out: this.customersOut(), customers_total: this.customersTotal(),
        cmi: Math.round(this.cmi) },
      alarms: this.alarms.slice(0, 14), events: this.events.slice(-12), selected: this.selected,
      scenario: this.scenario ? this.scenario.view() : null,
    };
  }
}

const STEPS = [
  { title: 'Storm incoming', body: "It's 4:25 PM on a hot afternoon. Load is near peak and a thunderstorm is moving across the service area. Watch the grid." },
  { title: 'Find the fault', body: "Feeder 1's breaker tripped and the microgrid islanded. Fault indicators (orange flags) latch when fault current passes them. The fault is past the LAST flagged device. Click the faulted line section." },
  { title: 'Isolate the faulted section', body: "Open the switches on both sides of the faulted section so it can't be re-energized. Click a switch and press Open." },
  { title: 'Restore upstream customers', body: "With the fault isolated, close Feeder 1's breaker to restore the customers between the substation and the fault." },
  { title: 'Restore downstream through the tie', body: 'Customers past the fault can be fed from Feeder 2. Close the normally-open tie switch.' },
  { title: 'Relieve the overload and reconnect the microgrid', body: 'Feeder 2 is now carrying extra load. Reconnect the microgrid at the PCC and set the battery to discharge so it supports the feeder.' },
  { title: 'Restoration complete', body: 'Every customer is back, the fault is isolated for the line crew, and the feeder is within its rating.' },
];

class StormScenario {
  constructor(sim) {
    this.sim = sim; this.step = 0; this.t = 0; this.done = false;
    this.faultStarted = null; this.completedAt = null; this.identified = false;
  }

  tick(dt) {
    this.t += dt;
    const s = this.sim;
    if (this.step === 0) {
      s.grid.cloud = Math.max(0.25, 0.9 - this.t * 0.06);
      if (this.t > 9) {
        s.grid.faultBus = 'f2a';
        s.events.push({ t: clockStr(s.simS), who: 'system', text: 'Lightning strike: 3-phase fault on Feeder 1, section L2' });
        s.alarm(1, 'L2', 'Fault detected on Feeder 1', 'fault');
        s.protect();
        this.faultStarted = this.t;
        this.step++;
      }
    }
    this.check();
  }

  check() {
    const s = this.sim, c = s.grid.closed, r = s.result;
    if (this.step === 1 && this.identified) this.step++;
    if (this.step === 2 && !c.SW_A && !c.SW_B) {
      s.events.push({ t: clockStr(s.simS), who: 'system', text: 'Faulted section isolated' });
      s.clearAlarm('fault');
      this.step++;
    }
    if (this.step === 3 && c.BKR_F1 && r.buses.f1.energized) this.step++;
    if (this.step === 4 && r.buses.f3.energized && r.buses.f4.energized) this.step++;
    if (this.step === 5 && c.PCC && r.branches.L5.loading <= 1.0 && s.customersOut() === 0) {
      this.step++; this.done = true; this.completedAt = this.t;
    }
  }

  onIdentify(item) {
    if (this.step !== 1) return { ok: true };
    const s = this.sim;
    if (['L2', 'f2a', 'f3a'].includes(item)) {
      this.identified = true;
      s.events.push({ t: clockStr(s.simS), who: 'trainee', text: 'Identified the faulted section: L2' });
      this.check();
      return { ok: true, correct: true, msg: 'Correct: L2 lies past the last flagged indicator (SW-A).' };
    }
    s.mistakes.push({ t: clockStr(s.simS), action: `Identify ${item}`, text: `${item} is not the faulted section` });
    const why = item in s.fci ? 'its indicator flagged, so fault current passed THROUGH it: the fault is further downstream.'
      : 'no fault current flowed here. Look for where the flags stop.';
    return { ok: true, correct: false, msg: `Not quite: ${item} — ${why}` };
  }

  hint() {
    const c = this.sim.grid.closed;
    if (this.step >= 3 && !c.BKR_F2) {
      return 'BKR_F2 tripped because the tie fed the fault before it was isolated. The fault is isolated now, so close BKR_F2 again to restore Feeder 2.';
    }
    return {
      0: 'Wait for the storm. Notice how the flow particles show power moving toward the loads.',
      1: 'Orange flags mark devices fault current passed through: BKR_F1, L1 and SW_A. The fault is just past SW_A, on section L2.',
      2: 'Open SW_A (upstream side of L2) and SW_B (downstream side).',
      3: 'Close BKR_F1 at the substation. The fault is isolated, so it will hold.',
      4: 'Close the TIE switch between Northgate (Feeder 2) and Riverside.',
      5: "Close the PCC breaker, then set the battery to Discharge. Watch line L5's loading drop.",
    }[this.step] || 'All done. Review your score card.';
  }

  score() {
    const s = this.sim;
    const elapsed = (this.completedAt ?? this.t) - (this.faultStarted || 0);
    const pts = 100 - 15 * s.mistakes.length - 5 * s.hintsUsed - Math.max(0, Math.floor((elapsed - 90) / 10));
    return { seconds: Math.round(elapsed), mistakes: s.mistakes.length, hints: s.hintsUsed, cmi: Math.round(s.cmi),
      score: Math.max(0, Math.min(100, pts)), mistake_list: s.mistakes };
  }

  view() {
    return { step: this.step, steps: STEPS, done: this.done,
      elapsed: Math.round(this.t - (this.faultStarted ?? this.t)), score: this.done ? this.score() : null };
  }
}
