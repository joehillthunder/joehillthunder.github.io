// In-browser AC power flow: the fallback engine when the OpenDSS server isn't there
// (e.g. the GitHub Pages build). Same inputs and same result shape as server/engine.py.
//
// Method: balanced positive-sequence per-unit model, nodal admittance matrix, constant-power loads
// (constant-impedance below 0.6 pu, as OpenDSS does), sources as Norton equivalents, fixed-point
// current-injection iteration with a dense complex solve. It handles meshes, islands and faults,
// which is all this 12-bus network needs. It is not OpenDSS; numbers agree to a few percent.

const SBASE_KVA = 10000;
const R1_DIST = 0.31, X1_DIST = 0.42, R1_TX = 0.06, X1_TX = 0.40;
const VMIN = 0.6;

export function loadShape(hour) {
  const base = 0.55 + 0.12 * Math.sin(((hour - 9.0) / 24.0) * 2 * Math.PI);
  const peak = 0.38 * Math.exp(-((hour - 17.0) ** 2) / 8.0);
  return Math.min(1.0, base + peak);
}

export function solarShape(hour) {
  if (hour <= 6.0 || hour >= 19.5) return 0;
  return Math.sin(((hour - 6.0) / 13.5) * Math.PI) ** 1.5;
}

// ---- complex helpers on [re, im] ----------------------------------------------------------------
const cadd = (a, b) => [a[0] + b[0], a[1] + b[1]];
const csub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdiv = (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };
const conj = (a) => [a[0], -a[1]];
const cabs = (a) => Math.hypot(a[0], a[1]);

function solveComplex(A, b) {
  // Gaussian elimination with partial pivoting; A is n x n of [re,im], destroyed.
  const n = b.length;
  for (let k = 0; k < n; k++) {
    let p = k, best = cabs(A[k][k]);
    for (let i = k + 1; i < n; i++) { const v = cabs(A[i][k]); if (v > best) { best = v; p = i; } }
    if (p !== k) { [A[k], A[p]] = [A[p], A[k]]; [b[k], b[p]] = [b[p], b[k]]; }
    const piv = A[k][k];
    for (let i = k + 1; i < n; i++) {
      const f = cdiv(A[i][k], piv);
      if (f[0] === 0 && f[1] === 0) continue;
      for (let j = k; j < n; j++) A[i][j] = csub(A[i][j], cmul(f, A[k][j]));
      b[i] = csub(b[i], cmul(f, b[k]));
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s = csub(s, cmul(A[i][j], x[j]));
    x[i] = cdiv(s, A[i][i]);
  }
  return x;
}

export class Grid {
  constructor(net) {
    this.net = net;
    this.busIds = Object.keys(net.buses);
    this.closed = {};
    for (const [k, b] of Object.entries(net.branches)) this.closed[k] = b.normally === 'closed';
    this.faultBus = null;
    this.islanded = false;
    this.bessKw = 0;
    this.hour = 14;
    this.cloud = 1;
    this.loadScale = 1;
    this.xfmrOut = false;
    // Per-unit impedances.
    this.z = {};
    for (const [k, b] of Object.entries(net.branches)) {
      const kv = net.buses[b.a].kv;
      const zb = (kv * kv * 1000) / SBASE_KVA;          // ohms
      if (b.kind === 'xfmr') this.z[k] = [0.004 * SBASE_KVA / b.kva * 2, 0.08 * SBASE_KVA / b.kva];
      else if (b.kind === 'tline') this.z[k] = [(R1_TX * b.km) / zb, (X1_TX * b.km) / zb];
      else if (b.kind === 'line') this.z[k] = [(R1_DIST * b.km) / zb, (X1_DIST * b.km) / zb];
      else this.z[k] = [1e-6, 1e-5];
    }
  }

  loadKw(name) { return this.net.loads[name].kw * loadShape(this.hour) * this.loadScale; }
  pvKw(name) { return this.net.pv[name].kw * solarShape(this.hour) * this.cloud; }

  active(k) {
    const b = this.net.branches[k];
    if (b.kind === 'xfmr') return !this.xfmrOut && this.closed[k] !== false;
    return this.closed[k];
  }

  solve(withFault = false) {
    const net = this.net;
    const sources = [{ bus: 'bulk', v: 1.02, y: cdiv([1, 0], [10 / 3000 / 10, 10 / 3000]), name: 'source' }];
    if (this.islanded) sources.push({ bus: net.bess.bus, v: 1.0, y: cdiv([1, 0], [10 / 60 / 10, 10 / 60]), name: 'bess' });

    // Energized buses: reachable from a source over active branches.
    const adj = {};
    for (const id of this.busIds) adj[id] = [];
    for (const k of Object.keys(net.branches)) if (this.active(k)) {
      const b = net.branches[k];
      adj[b.a].push(b.b); adj[b.b].push(b.a);
    }
    const live = new Set();
    const stack = sources.map((s) => s.bus);
    while (stack.length) { const u = stack.pop(); if (live.has(u)) continue; live.add(u); stack.push(...adj[u]); }
    const ids = this.busIds.filter((b) => live.has(b));
    const idx = Object.fromEntries(ids.map((b, i) => [b, i]));
    const n = ids.length;

    // Admittance matrix.
    const Y = Array.from({ length: n }, () => Array.from({ length: n }, () => [0, 0]));
    for (const k of Object.keys(net.branches)) {
      if (!this.active(k)) continue;
      const b = net.branches[k];
      if (!(b.a in idx) || !(b.b in idx)) continue;
      const y = cdiv([1, 0], this.z[k]);
      const i = idx[b.a], j = idx[b.b];
      Y[i][i] = cadd(Y[i][i], y); Y[j][j] = cadd(Y[j][j], y);
      Y[i][j] = csub(Y[i][j], y); Y[j][i] = csub(Y[j][i], y);
    }
    const Isrc = Array.from({ length: n }, () => [0, 0]);
    for (const s of sources) {
      const i = idx[s.bus];
      Y[i][i] = cadd(Y[i][i], s.y);
      Isrc[i] = cadd(Isrc[i], cmul([s.v, 0], s.y));
    }
    if (withFault && this.faultBus && this.faultBus in idx) {
      const zb = (net.buses[this.faultBus].kv ** 2 * 1000) / SBASE_KVA;
      const i = idx[this.faultBus];
      Y[i][i] = cadd(Y[i][i], [zb / 0.3, 0]);
    }
    // Bus power demand (pu, + = consumption).
    const S = Array.from({ length: n }, () => [0, 0]);
    const q = Math.tan(Math.acos(0.95));
    for (const [k, ld] of Object.entries(net.loads)) if (ld.bus in idx) {
      const p = this.loadKw(k) / SBASE_KVA;
      S[idx[ld.bus]] = cadd(S[idx[ld.bus]], [p, p * q]);
    }
    for (const [k, pv] of Object.entries(net.pv)) if (pv.bus in idx) {
      S[idx[pv.bus]] = csub(S[idx[pv.bus]], [this.pvKw(k) / SBASE_KVA, 0]);
    }
    if (!this.islanded && net.bess.bus in idx) S[idx[net.bess.bus]] = csub(S[idx[net.bess.bus]], [this.bessKw / SBASE_KVA, 0]);

    // Fixed-point current-injection iteration.
    let V = Array.from({ length: n }, () => [1, 0]);
    let converged = n === 0;
    for (let it = 0; it < 60 && n; it++) {
      const I = Isrc.map((x, i) => {
        const vm = cabs(V[i]);
        const load = vm < VMIN ? cmul(conj(S[i]), V[i]).map((c) => c / (VMIN * VMIN)) : conj(cdiv(S[i], V[i]));
        return csub(x, load);
      });
      const Vn = solveComplex(Y.map((r) => r.map((c) => [c[0], c[1]])), I);
      let d = 0;
      for (let i = 0; i < n; i++) d = Math.max(d, cabs(csub(Vn[i], V[i])));
      V = Vn;
      if (d < 1e-8) { converged = true; break; }
    }
    return this._read(V, idx, sources, withFault && !!this.faultBus, converged);
  }

  _read(V, idx, sources, fault, converged) {
    const net = this.net;
    const Vb = (b) => (b in idx ? V[idx[b]] : [0, 0]);
    const buses = {};
    for (const b of this.busIds) {
      const v = cabs(Vb(b));
      buses[b] = { vpu: +v.toFixed(4), energized: v > 0.5 };
    }
    const branches = {};
    let losses = 0;
    for (const [k, b] of Object.entries(net.branches)) {
      if (!this.active(k) || !(b.a in idx)) {
        branches[k] = { closed: !!this.active(k), kw: 0, kvar: 0, amps: 0, loading: 0 };
        if (!this.active(k)) branches[k].closed = false;
        continue;
      }
      const I = cdiv(csub(Vb(b.a), Vb(b.b)), this.z[k]);
      const s = cmul(Vb(b.a), conj(I));
      const kvSide = b.kind === 'xfmr' ? net.buses[b.b].kv : net.buses[b.a].kv;
      const ibase = SBASE_KVA / (Math.sqrt(3) * kvSide);
      let amps = cabs(I) * ibase;
      const rated = b.kind === 'xfmr' ? b.kva / (Math.sqrt(3) * net.buses[b.b].kv) : b.amps;
      let kw = s[0] * SBASE_KVA, kvar = s[1] * SBASE_KVA;
      losses += cabs(I) ** 2 * this.z[k][0] * SBASE_KVA;
      if (!fault && !buses[b.a].energized && !buses[b.b].energized) kw = kvar = amps = 0;
      branches[k] = { closed: true, kw: +kw.toFixed(1), kvar: +kvar.toFixed(1), amps: +amps.toFixed(1), loading: +(amps / rated).toFixed(3) };
    }
    const loads = {};
    for (const [k, ld] of Object.entries(net.loads)) {
      const on = buses[ld.bus].energized;
      loads[k] = { kw: on ? +this.loadKw(k).toFixed(1) : 0, served: on };
    }
    const pv = {};
    for (const [k, p] of Object.entries(net.pv)) {
      const on = buses[p.bus].energized;
      pv[k] = { kw: on ? +this.pvKw(k).toFixed(1) : 0, online: on };
    }
    const srcKw = (s) => {
      const v = Vb(s.bus);
      const inj = csub(cmul([s.v, 0], s.y), cmul(s.y, v));
      return cmul(v, conj(inj))[0] * SBASE_KVA;
    };
    let importKw = 0, bessKw = this.islanded ? 0 : (buses[net.bess.bus].energized ? this.bessKw : 0);
    for (const s of sources) {
      if (s.name === 'source') importKw = srcKw(s);
      else bessKw = srcKw(s);
    }
    return { converged, buses, branches, loads, pv, bess_kw: +bessKw.toFixed(1), import_kw: +importKw.toFixed(1),
      losses_kw: +losses.toFixed(1) };
  }

  faultCurrents() {
    const r = this.solve(true);
    const fc = {};
    for (const [k, v] of Object.entries(r.branches)) fc[k] = v.amps;
    return [fc, r];
  }
}
