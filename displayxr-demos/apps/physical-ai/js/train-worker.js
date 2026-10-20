// Behaviour cloning in a worker: an MLP (tanh hidden layers) regressing the demonstrator's
// end-effector actions from the 15-number observation, trained with Adam on minibatches. Validation is
// on held-out whole episodes, so the curve shows generalisation to new layouts, not to nearby frames.
// (Noise injection happens when the dataset is built: see buildDataset in data.js.)
//
// in:  { type: 'train', X, Y, epOf, valEps: number[], dim, outDim, cfg: { hidden, layers, epochs, lr, batch, seed } }
// out: { type: 'epoch', epoch, train, val, ms } ... then { type: 'done', model }

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let stop = false;

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'stop') { stop = true; return; }
  if (msg.type === 'train') { stop = false; train(msg); }
};

function train({ X, Y, epOf, valEps, dim, outDim: OUT, cfg }) {
  const R = rng(cfg.seed || 1);
  const gauss = () => Math.sqrt(-2 * Math.log(R() + 1e-12)) * Math.cos(2 * Math.PI * R());
  const rows = Y.length / OUT;
  const isVal = new Uint8Array(rows);
  const valSet = new Set(valEps);
  const trainIdx = [], valIdx = [];
  for (let r = 0; r < rows; r++) { if (valSet.has(epOf[r])) { isVal[r] = 1; valIdx.push(r); } else trainIdx.push(r); }

  // input standardisation from the training rows
  const mean = new Float32Array(dim), std = new Float32Array(dim);
  for (const r of trainIdx) for (let i = 0; i < dim; i++) mean[i] += X[r * dim + i];
  for (let i = 0; i < dim; i++) mean[i] /= trainIdx.length;
  for (const r of trainIdx) for (let i = 0; i < dim; i++) { const d = X[r * dim + i] - mean[i]; std[i] += d * d; }
  for (let i = 0; i < dim; i++) std[i] = Math.max(1e-3, Math.sqrt(std[i] / trainIdx.length));

  const sizes = [dim];
  for (let l = 0; l < (cfg.layers || 2); l++) sizes.push(cfg.hidden);
  sizes.push(OUT);
  const L = sizes.length - 1;
  const W = [], B = [], gW = [], gB = [], mW = [], vW = [], mB = [], vB = [];
  for (let l = 0; l < L; l++) {
    const nIn = sizes[l], nOut = sizes[l + 1], s = Math.sqrt(1 / nIn);
    const w = new Float32Array(nIn * nOut);
    for (let i = 0; i < w.length; i++) w[i] = gauss() * s * (l === L - 1 ? 0.5 : 1);
    W.push(w); B.push(new Float32Array(nOut));
    gW.push(new Float32Array(nIn * nOut)); gB.push(new Float32Array(nOut));
    mW.push(new Float32Array(nIn * nOut)); vW.push(new Float32Array(nIn * nOut));
    mB.push(new Float32Array(nOut)); vB.push(new Float32Array(nOut));
  }
  const acts = sizes.map((n) => new Float32Array(n));
  const deltas = sizes.map((n) => new Float32Array(n));
  const y = new Float32Array(OUT);

  function forward(r) {
    const a0 = acts[0];
    for (let i = 0; i < dim; i++) a0[i] = X[r * dim + i];
    for (let k = 0; k < OUT; k++) y[k] = Y[r * OUT + k];
    for (let i = 0; i < dim; i++) a0[i] = (a0[i] - mean[i]) / std[i];
    for (let l = 0; l < L; l++) {
      const nIn = sizes[l], nOut = sizes[l + 1], w = W[l], b = B[l], inp = acts[l], out = acts[l + 1], last = l === L - 1;
      for (let o = 0; o < nOut; o++) {
        let s = b[o];
        const row = o * nIn;
        for (let i = 0; i < nIn; i++) s += w[row + i] * inp[i];
        out[o] = last ? s : Math.tanh(s);
      }
    }
    const out = acts[L];
    let loss = 0;
    for (let k = 0; k < OUT; k++) { const d = out[k] - y[k]; loss += d * d; deltas[L][k] = 2 * d / OUT; }
    return loss / OUT;
  }

  function backward() {
    for (let l = L - 1; l >= 0; l--) {
      const nIn = sizes[l], nOut = sizes[l + 1], w = W[l], inp = acts[l], dOut = deltas[l + 1], dIn = deltas[l], gw = gW[l], gb = gB[l];
      if (l > 0) dIn.fill(0);
      for (let o = 0; o < nOut; o++) {
        const d = dOut[o];
        if (d === 0) continue;
        gb[o] += d;
        const row = o * nIn;
        for (let i = 0; i < nIn; i++) { gw[row + i] += d * inp[i]; if (l > 0) dIn[i] += d * w[row + i]; }
      }
      if (l > 0) for (let i = 0; i < nIn; i++) dIn[i] *= 1 - inp[i] * inp[i]; // tanh'
    }
  }

  let step = 0;
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  function adam(lr, n) {
    step++;
    const c1 = 1 - Math.pow(b1, step), c2 = 1 - Math.pow(b2, step);
    const upd = (p, g, m, v) => {
      for (let i = 0; i < p.length; i++) {
        const gi = g[i] / n;
        m[i] = b1 * m[i] + (1 - b1) * gi;
        v[i] = b2 * v[i] + (1 - b2) * gi * gi;
        p[i] -= lr * (m[i] / c1) / (Math.sqrt(v[i] / c2) + eps);
        g[i] = 0;
      }
    };
    for (let l = 0; l < L; l++) { upd(W[l], gW[l], mW[l], vW[l]); upd(B[l], gB[l], mB[l], vB[l]); }
  }

  const batch = cfg.batch || 128;
  const evalVal = () => {
    if (!valIdx.length) return null;
    let s = 0;
    const stride = Math.max(1, Math.floor(valIdx.length / 4000));
    let n = 0;
    for (let i = 0; i < valIdx.length; i += stride) { s += forward(valIdx[i]); n++; }
    return s / n;
  };

  const v0 = evalVal();
  self.postMessage({ type: 'epoch', epoch: 0, train: v0, val: v0, ms: 0, rows: trainIdx.length, valRows: valIdx.length });
  for (let ep = 1; ep <= cfg.epochs && !stop; ep++) {
    const t0 = performance.now();
    // shuffle
    for (let i = trainIdx.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); const t = trainIdx[i]; trainIdx[i] = trainIdx[j]; trainIdx[j] = t; }
    const lr = cfg.lr * (0.5 + 0.5 * Math.cos(Math.PI * (ep - 1) / cfg.epochs)); // cosine decay
    let sum = 0, n = 0;
    for (let i = 0; i < trainIdx.length; i++) {
      sum += forward(trainIdx[i]);
      backward();
      n++;
      if (n % batch === 0 || i === trainIdx.length - 1) adam(lr, n % batch || batch);
    }
    self.postMessage({ type: 'epoch', epoch: ep, train: sum / n, val: evalVal(), ms: performance.now() - t0 });
  }
  self.postMessage({ type: 'done', stopped: stop, model: { sizes, W, B, b: B, mean, std, cfg } });
}
