// What-if worker: fail one element under many operating conditions, then restore what can be
// restored (close the tie, island the microgrid). Two AC power flows per condition.
// Port of server/whatif.py::_run_chunk.

import { Grid } from './powerflow.js';

let grid = null, net = null;

self.onmessage = (e) => {
  const { type } = e.data;
  if (type === 'init') {
    net = e.data.net;
    grid = new Grid(net);
    self.postMessage({ type: 'ready' });
    return;
  }
  const { element, conditions, id } = e.data;
  const base = {};
  for (const [k, b] of Object.entries(net.branches)) base[k] = b.normally === 'closed';
  const total = Object.values(net.loads).reduce((a, l) => a + l.customers, 0);
  const out = (r) => Object.entries(r.loads).reduce((a, [k, v]) => a + (v.served ? 0 : net.loads[k].customers), 0);
  let outSum = 0, restoredSum = 0, over = 0, lowv = 0, worst = 0;
  for (const [hour, cloud, scale] of conditions) {
    grid.closed = { ...base };
    grid.closed[element] = false;
    grid.xfmrOut = element === 'XFMR';
    grid.islanded = false;
    grid.bessKw = 0;
    grid.hour = hour; grid.cloud = cloud; grid.loadScale = scale;
    let r = grid.solve();
    outSum += out(r);
    grid.closed.TIE = true;
    if (!r.buses.mg.energized || element === 'PCC') { grid.closed.PCC = false; grid.islanded = true; }
    r = grid.solve();
    restoredSum += out(r);
    let mx = 0;
    for (const b of Object.values(r.branches)) mx = Math.max(mx, b.loading);
    worst = Math.max(worst, mx);
    if (mx > 1) over++;
    if (Object.values(r.buses).some((b) => b.energized && b.vpu < 0.95)) lowv++;
  }
  grid.xfmrOut = false;
  const n = Math.max(1, conditions.length);
  self.postMessage({ type: 'result', id, element, n: conditions.length, flows: 2 * conditions.length,
    out_frac: outSum / n / total, restored_out_frac: restoredSum / n / total, over, lowv, worst });
};
