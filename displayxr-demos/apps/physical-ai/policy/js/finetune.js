// Few-step adaptation on the main thread: start from a pretrained policy (the "prior") and take a
// handful of full-batch Adam steps on one short demonstration. Same MLP as train-worker.js (tanh
// hidden layers, linear output, squared error); the input standardisation of the prior is kept, so the
// clip is seen exactly the way the prior sees the world.
//
// Returns a NEW model (the prior is never modified) and the loss before/after every step.

export function cloneModel(m) {
  return {
    ...m,
    sizes: m.sizes.slice(),
    mean: Float32Array.from(m.mean),
    std: Float32Array.from(m.std),
    W: m.W.map((w) => Float32Array.from(w)),
    b: m.b.map((b) => Float32Array.from(b)),
  };
}

/**
 * @param prior   { sizes, W, b, mean, std }
 * @param X, Y    Float32Array rows (dim = sizes[0], out = sizes.at(-1))
 * @param steps   gradient steps (each one sees every row of the clip once)
 * @param lr      Adam step size
 * @param anchor  optional { X, Y } rows from the pretraining data, mixed in so the prior isn't forgotten
 */
export function finetune(prior, X, Y, { steps = 10, lr = 3e-3, anchor = null, onStep } = {}) {
  const m = cloneModel(prior);
  const { sizes } = m, L = sizes.length - 1, dim = sizes[0], OUT = sizes[L];
  const sets = [{ X, Y, w: 1 }];
  if (anchor) sets.push({ X: anchor.X, Y: anchor.Y, w: 1 });
  const acts = sizes.map((n) => new Float32Array(n));
  const deltas = sizes.map((n) => new Float32Array(n));
  const gW = m.W.map((w) => new Float32Array(w.length)), gB = m.b.map((b) => new Float32Array(b.length));
  const mW = m.W.map((w) => new Float32Array(w.length)), vW = m.W.map((w) => new Float32Array(w.length));
  const mB = m.b.map((b) => new Float32Array(b.length)), vB = m.b.map((b) => new Float32Array(b.length));

  function forward(Xs, Ys, r, grad) {
    const a0 = acts[0];
    for (let i = 0; i < dim; i++) a0[i] = (Xs[r * dim + i] - m.mean[i]) / m.std[i];
    for (let l = 0; l < L; l++) {
      const nIn = sizes[l], nOut = sizes[l + 1], w = m.W[l], bb = m.b[l], inp = acts[l], out = acts[l + 1], last = l === L - 1;
      for (let o = 0; o < nOut; o++) {
        let s = bb[o];
        const row = o * nIn;
        for (let i = 0; i < nIn; i++) s += w[row + i] * inp[i];
        out[o] = last ? s : Math.tanh(s);
      }
    }
    let loss = 0;
    for (let k = 0; k < OUT; k++) { const d = acts[L][k] - Ys[r * OUT + k]; loss += d * d; deltas[L][k] = 2 * d / OUT; }
    if (grad) {
      for (let l = L - 1; l >= 0; l--) {
        const nIn = sizes[l], nOut = sizes[l + 1], w = m.W[l], inp = acts[l], dOut = deltas[l + 1], dIn = deltas[l];
        if (l > 0) dIn.fill(0);
        for (let o = 0; o < nOut; o++) {
          const d = dOut[o];
          if (d === 0) continue;
          gB[l][o] += d;
          const row = o * nIn;
          for (let i = 0; i < nIn; i++) { gW[l][row + i] += d * inp[i]; if (l > 0) dIn[i] += d * w[row + i]; }
        }
        if (l > 0) for (let i = 0; i < nIn; i++) dIn[i] *= 1 - inp[i] * inp[i];
      }
    }
    return loss / OUT;
  }

  const clipLoss = () => { let s = 0; const n = Y.length / OUT; for (let r = 0; r < n; r++) s += forward(X, Y, r, false); return s / n; };
  const losses = [clipLoss()];
  onStep?.(0, losses[0]);
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  for (let step = 1; step <= steps; step++) {
    let n = 0;
    for (const S of sets) { const rows = S.Y.length / OUT; for (let r = 0; r < rows; r++) { forward(S.X, S.Y, r, true); n++; } }
    const c1 = 1 - b1 ** step, c2 = 1 - b2 ** step;
    const upd = (p, g, mm, vv) => {
      for (let i = 0; i < p.length; i++) {
        const gi = g[i] / n;
        mm[i] = b1 * mm[i] + (1 - b1) * gi;
        vv[i] = b2 * vv[i] + (1 - b2) * gi * gi;
        p[i] -= lr * (mm[i] / c1) / (Math.sqrt(vv[i] / c2) + eps);
        g[i] = 0;
      }
    };
    for (let l = 0; l < L; l++) { upd(m.W[l], gW[l], mW[l], vW[l]); upd(m.b[l], gB[l], mB[l], vB[l]); }
    losses.push(clipLoss());
    onStep?.(step, losses[step]);
  }
  return { model: m, losses };
}

export function serialiseModel(m) {
  return { sizes: m.sizes, mean: Array.from(m.mean), std: Array.from(m.std), W: m.W.map((w) => Array.from(w, (v) => +v.toPrecision(6))), b: m.b.map((b) => Array.from(b)) };
}
export function reviveModel(j) {
  return { sizes: j.sizes, mean: Float32Array.from(j.mean), std: Float32Array.from(j.std), W: j.W.map((w) => Float32Array.from(w)), b: j.b.map((b) => Float32Array.from(b)) };
}
