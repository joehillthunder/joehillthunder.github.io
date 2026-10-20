// Playback: opens a .4dv, streams its segments through the loader worker onto the GPU, keeps the
// sort worker busy with the current time and camera, and runs the clock (audio-locked when the
// clip has a soundtrack).

import * as THREE from 'three';
import { SplatSegment } from './splats.js';

const KEEP_SEGMENTS = 3;

export class Player extends EventTarget {
  constructor(stage) {
    super();
    this.stage = stage;
    this.root = new THREE.Group();
    this.root.matrixAutoUpdate = false;
    stage.scene.add(this.root);
    this.loader = new Worker(new URL('./loader-worker.js', import.meta.url), { type: 'module' });
    this.sorter = new Worker(new URL('./sort-worker.js', import.meta.url));
    this.pending = new Map();
    this.nextId = 1;
    this.loader.onmessage = (e) => this.onLoader(e.data);
    this.sorter.onmessage = (e) => this.onSorted(e.data);
    this.sortBuf = new ArrayBuffer(4);
    this.sortInFlight = false;
    this.sortMs = 0;

    this.info = null;
    this.segs = new Map(); // index → SplatSegment
    this.loading = new Map(); // index → Promise
    this.active = -1;
    this.time = 0;
    this.playing = false;
    this.speed = 1;
    this.loop = true;
    this.splatScale = 1;
    this.generation = 0;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.tmpV = new THREE.Vector3();
    this.tmpM = new THREE.Matrix4();
  }

  call(msg, transfer = [], onStage) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onStage });
      this.loader.postMessage({ ...msg, id }, transfer);
    });
  }

  onLoader(m) {
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.type === 'stage') { p.onStage?.(m.stage); return; }
    this.pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Open a .4dv Blob. Resolves once the first segment is on screen. */
  async open(blob, onStage = () => {}) {
    const gen = ++this.generation;
    this.unload();
    onStage('Reading archive');
    const { info } = await this.call({ type: 'open', blob });
    if (gen !== this.generation) return;
    this.info = info;
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioUrl = info.audio ? URL.createObjectURL(info.audio) : null;
    this.audio.src = this.audioUrl ?? '';
    this.time = 0;
    const seg = await this.loadSegment(0, onStage, gen);
    if (gen !== this.generation || !seg) return;
    this.frame(seg.sample);
    this.emit('loaded', info);
  }

  unload() {
    this.playing = false;
    this.audio.pause();
    for (const s of this.segs.values()) s.dispose();
    this.segs.clear();
    this.loading.clear();
    this.sorter.postMessage({ type: 'clear' });
    this.active = -1;
    this.info = null;
  }

  loadSegment(i, onStage = () => {}, gen = this.generation) {
    if (this.segs.has(i)) return Promise.resolve(this.segs.get(i));
    if (this.loading.has(i)) return this.loading.get(i);
    const segInfo = this.info.segments[i];
    const p = this.call({ type: 'segment', seg: segInfo, index: i }, [], (s) => onStage(`Decoding ${s.toLowerCase()}`)).then((m) => {
      this.loading.delete(i);
      if (gen !== this.generation) return null;
      const d = m.data;
      console.info(`[4dv] segment ${i}: ${d.N.toLocaleString()} splats, decoded in ${d.ms} ms, time ${d.timeRange.map((v) => v.toFixed(2)).join('…')}`);
      const seg = new SplatSegment(d);
      seg.sample = d.sample;
      seg.key = `${gen}:${i}`;
      this.sorter.postMessage({ type: 'segment', key: seg.key, duration: segInfo.duration, N: d.N, posT: d.posT.slice(), velT: d.velT.slice(), color: d.color.slice() });
      this.root.add(seg.mesh);
      this.segs.set(i, seg);
      this.evict(i);
      return seg;
    });
    this.loading.set(i, p);
    return p;
  }

  evict(keep) {
    if (this.segs.size <= KEEP_SEGMENTS) return;
    const want = new Set([keep, this.active, this.segmentAt(this.time) + 1, 0]);
    for (const [i, s] of this.segs) {
      if (this.segs.size <= KEEP_SEGMENTS) break;
      if (want.has(i)) continue;
      this.sorter.postMessage({ type: 'drop', key: s.key });
      s.dispose();
      this.segs.delete(i);
    }
  }

  segmentAt(t) {
    const segs = this.info?.segments ?? [];
    for (let i = segs.length - 1; i >= 0; i--) if (t >= segs[i].start) return i;
    return 0;
  }

  /**
   * Put the performer upright at the origin, facing +z, and aim the orbit at them. Up and front
   * come from the capture rig (OpenCV cameras: y down, z forward), the size from the splats.
   */
  frame(sample) {
    const cams = this.info.cameras ? Object.values(this.info.cameras) : [];
    const up = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    let pivot = null;
    const camCentres = [];
    const halfTans = [];
    if (cams.length) {
      // Least-squares point closest to every optical axis.
      const A = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);
      const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      const b = new THREE.Vector3();
      for (const c of cams) {
        const R = c.R, T = c.T.map((v) => (Array.isArray(v) ? v[0] : v));
        const C = new THREE.Vector3(
          -(R[0][0] * T[0] + R[1][0] * T[1] + R[2][0] * T[2]),
          -(R[0][1] * T[0] + R[1][1] * T[1] + R[2][1] * T[2]),
          -(R[0][2] * T[0] + R[1][2] * T[1] + R[2][2] * T[2]),
        );
        const d = new THREE.Vector3(R[2][0], R[2][1], R[2][2]).normalize();
        up.add(new THREE.Vector3(-R[1][0], -R[1][1], -R[1][2]));
        camCentres.push(C);
        if (c.K) halfTans.push((c.K[1][2] || c.K[0][2] * 0.5625) / c.K[1][1]); // tan(vfov/2) ≈ cy / fy
        const P = [1 - d.x * d.x, -d.x * d.y, -d.x * d.z, -d.y * d.x, 1 - d.y * d.y, -d.y * d.z, -d.z * d.x, -d.z * d.y, 1 - d.z * d.z];
        for (let k = 0; k < 9; k++) a[k] += P[k];
        b.x += P[0] * C.x + P[1] * C.y + P[2] * C.z;
        b.y += P[3] * C.x + P[4] * C.y + P[5] * C.z;
        b.z += P[6] * C.x + P[7] * C.y + P[8] * C.z;
      }
      A.set(...a);
      if (Math.abs(A.determinant()) > 1e-6) pivot = b.applyMatrix3(A.invert());
      const c0 = cams[0].R;
      fwd.set(c0[2][0], c0[2][1], c0[2][2]);
    } else {
      up.set(0, -1, 0);
      fwd.set(0, 0, 1);
    }
    up.normalize();
    fwd.addScaledVector(up, -fwd.dot(up)).normalize();
    if (fwd.lengthSq() < 0.5) fwd.set(1, 0, 0).addScaledVector(up, -up.x).normalize();
    // Display basis: Y = up, Z = toward the front camera (three looks down −z), X = Y × Z.
    const Y = up.clone();
    const Z = fwd.clone().negate();
    const X = new THREE.Vector3().crossVectors(Y, Z).normalize();

    const n = sample.length / 3;
    if (!pivot) {
      pivot = new THREE.Vector3();
      for (let i = 0; i < n; i++) pivot.add(this.tmpV.fromArray(sample, i * 3));
      pivot.divideScalar(Math.max(1, n));
    }
    const rot = new THREE.Matrix4().makeBasis(X, Y, Z).transpose();
    const m = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z).premultiply(rot);
    this.root.matrix.copy(m);
    this.root.matrixWorldNeedsUpdate = true;

    // Robust bounds of the solid splats in the display frame.
    const xs = [], ys = [], zs = [];
    for (let i = 0; i < n; i++) {
      this.tmpV.fromArray(sample, i * 3).applyMatrix4(m);
      xs.push(this.tmpV.x); ys.push(this.tmpV.y); zs.push(this.tmpV.z);
    }
    const pct = (arr, q) => {
      if (!arr.length) return 0;
      const s = Float32Array.from(arr).sort();
      return s[Math.min(s.length - 1, Math.floor(q * s.length))];
    };
    // 10th–90th percentile, grown back by a third: stray floaters don't widen the shot.
    const lo = new THREE.Vector3(pct(xs, 0.1), pct(ys, 0.1), pct(zs, 0.1));
    const hi = new THREE.Vector3(pct(xs, 0.9), pct(ys, 0.9), pct(zs, 0.9));
    const grow = hi.clone().sub(lo).multiplyScalar(0.15);
    lo.sub(grow);
    hi.add(grow);
    const size = hi.clone().sub(lo);
    const fov = THREE.MathUtils.degToRad(this.stage.cam.fov);
    const aspect = this.stage.cam.aspect || 16 / 9;
    let target, dist;
    const med = (arr) => Float32Array.from(arr).sort()[arr.length >> 1];
    if (pivot && camCentres.length && halfTans.length) {
      // Frame what the capture cameras framed: their common focus, at their median field of view.
      const camDist = med(camCentres.map((c) => c.distanceTo(pivot)));
      const halfH = camDist * med(halfTans);
      // Pulled back from the capture's telephoto framing so there is room to orbit.
      target = new THREE.Vector3();
      dist = (1.8 * Math.max(halfH, (halfH * 16) / 9 / aspect)) / Math.tan(fov / 2);
    } else {
      target = lo.clone().add(hi).multiplyScalar(0.5);
      const h = Math.max(size.y, size.x / aspect, 0.2);
      dist = (h * 0.62) / Math.tan(fov / 2) + size.z * 0.5;
    }
    this.stage.setView({ target, dist, yaw: 0, pitch: 0.08 });
    this.bounds = { lo, hi };
  }

  play() {
    if (!this.info) return;
    if (this.time >= this.info.duration - 1e-3) this.seek(0);
    this.playing = true;
    if (this.audioUrl) {
      this.audio.currentTime = this.time;
      this.audio.playbackRate = this.speed;
      this.audio.play().catch(() => {});
    }
    this.emit('state');
  }

  pause() {
    this.playing = false;
    this.audio.pause();
    this.emit('state');
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  seek(t) {
    if (!this.info) return;
    this.time = Math.max(0, Math.min(this.info.duration, t));
    if (this.audioUrl) this.audio.currentTime = this.time;
  }

  setSpeed(s) {
    this.speed = s;
    this.audio.playbackRate = s;
  }

  /** Called once per frame by the stage. */
  tick(dt) {
    if (!this.info) return;
    const dur = this.info.duration;
    if (this.playing) {
      if (this.audioUrl && !this.audio.paused && this.speed > 0) this.time = this.audio.currentTime;
      else this.time += dt * this.speed;
      if (this.time >= dur) {
        if (this.loop) {
          this.seek(0);
          if (this.audioUrl) this.audio.play().catch(() => {});
        } else {
          this.time = dur;
          this.pause();
        }
      }
    }
    const want = this.segmentAt(this.time);
    const seg = this.segs.get(want);
    if (!seg) {
      this.loadSegment(want);
    } else if (want !== this.active && seg.sorted) {
      this.segs.get(this.active)?.mesh && (this.segs.get(this.active).mesh.visible = false);
      seg.mesh.visible = true;
      this.active = want;
    }
    // Make sure the next segment (and the loop's first) is decoding before we reach it.
    const segs = this.info.segments;
    if (segs.length > 1) {
      const next = want + 1 < segs.length ? want + 1 : this.loop ? 0 : -1;
      if (next >= 0 && !this.segs.has(next) && this.time > segs[want].start + segs[want].duration * 0.2) this.loadSegment(next);
    }
    // Splat times are local to their segment.
    for (const [i, s] of this.segs) s.material.uniforms.uTime.value = this.time - segs[i].start;
    this.requestSort(want);
  }

  setViewport(vp) {
    for (const s of this.segs.values()) {
      s.material.uniforms.uViewport.value.copy(vp);
      s.material.uniforms.uSplatScale.value = this.splatScale;
    }
  }

  requestSort(index) {
    if (this.sortInFlight) return;
    const seg = this.segs.get(index);
    if (!seg) return;
    // The camera in the splats' own space.
    this.stage.cam.updateMatrixWorld();
    this.tmpM.copy(this.root.matrix).invert();
    const cam = this.tmpV.setFromMatrixPosition(this.stage.cam.matrixWorld).applyMatrix4(this.tmpM).toArray();
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(this.stage.cam.matrixWorld).transformDirection(this.tmpM).toArray();
    // Sort slightly ahead: the order lands a sort-time later.
    const t = this.time - this.info.segments[index].start + (this.playing ? this.speed * (this.sortMs / 1000) : 0);
    this.sortInFlight = true;
    this.sortIndex = index;
    this.sorter.postMessage({ type: 'sort', key: seg.key, t, cam, dir: fwd, buf: this.sortBuf }, [this.sortBuf]);
  }

  onSorted(m) {
    this.sortInFlight = false;
    this.sortBuf = m.buf;
    if (m.count < 0) return;
    this.sortMs = this.sortMs * 0.8 + m.ms * 0.2;
    this.activeCount = m.count;
    if (m.count > 1000 && m.far > m.near) this.stage.setDepthRange(m.near, m.far);
    for (const s of this.segs.values()) {
      if (s.key === m.key) {
        s.setOrder(new Float32Array(m.buf), m.count);
        if (this.active === -1) {
          s.mesh.visible = true;
          this.active = this.segmentAt(this.time);
          this.emit('firstframe');
        }
      }
    }
  }
}
