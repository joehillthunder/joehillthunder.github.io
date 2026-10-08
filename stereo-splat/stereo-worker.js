// stereo-worker.js — runs stereo.js off the main thread so the live 3D preview keeps its frame rate.

import { toGray, computeDisparity, buildSplats } from './stereo.js';

self.onmessage = ({ data }) => {
  const { L, R, w, h, fx, baselineM, subjectZ, minD, maxD } = data;
  try {
    const disp = computeDisparity(toGray(L, w, h), toGray(R, w, h), w, h, {
      minD,
      maxD,
      onProgress: (f) => self.postMessage({ type: 'progress', f }),
    });
    const { columns, count, depth } = buildSplats(L, disp, w, h, { fx, baselineM, subjectZ });
    const transfer = [disp.buffer, ...Object.values(columns).map((a) => a.buffer)];
    self.postMessage({ type: 'done', disp, columns, count, depth }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
