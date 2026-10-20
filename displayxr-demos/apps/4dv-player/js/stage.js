// The 3D stage: one persistent canvas, woven by the DisplayXR inline-3D SDK when the browser and
// display support it, and rendered as ordinary 2D otherwise.
//
// An orbit CAMERA rig around the performer: convergence sits on the orbit target, so the subject
// rests on the glass with the near side popping out and the far side receding. Eye separation
// scales with the orbit distance, so zooming in or out keeps the same comfortable depth. The eyes
// hang off the app camera and the rig is sent identity-posed every frame (the attach pattern), so
// orbiting has no stereo lag.

import * as THREE from 'three';
import { createInline3D, inline3dDisplayModesSupported } from '@displayxr/inline3d';
import { EyeCamera, cameraRigFromCamera } from '@displayxr/inline3d/three';

const MAX_EYE_W = 2560; // per-eye backing-store cap
// Stereo depth budget: the largest screen disparity (a fraction of the view's width) that the 5th- and
// 95th-percentile splat depths may reach at 3D strength 1. Past about 1% the lenticular weave shows
// double edges (crosstalk) on Leia panels, which reads as soft, ghosted, "wispy" splats.
const DISPARITY_BUDGET = 0.012;
const MIN_DEPTH_SHARE = 0.4; // the budget never flattens a scene below this share of its natural depth
const EYE_SEPARATION = 0.063; // metres, at ipdFactor 1 on a camera rig
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    this.woven = false;
    this.stereo = true;
    this.depthGain = 1;
    this.onTick = () => {};
    this.onEye = () => {};
    this.onModeChange = () => {};

    // Orbit state, around `target`.
    this.target = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.dist = 3;
    this.minDist = 0.2;
    this.maxDist = 30;
    this.turntable = false;

    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' }));
    // pixelRatio MUST be 1: layer.getViewport() reports backing-store pixels. Sized by hand.
    r.setPixelRatio(1);
    r.autoClear = false;
    r.setClearColor(0x05080f, 1);

    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(35, 16 / 9, 0.02, 200);
    this.scene.add(this.cam);
    this.eyes = [new EyeCamera(THREE), new EyeCamera(THREE)];
    this.rigScratch = {};
    this.viewport = new THREE.Vector2();
    window.addEventListener('resize', () => this.sizeToCanvas());
    this.bindPointer();
  }

  async start() {
    this.sizeToCanvas();
    try {
      this.wall = await createInline3D({ lazy: false });
    } catch (e) {
      console.warn('[4dv] inline-3D unavailable', e);
    }
    if (!this.wall?.supported) {
      console.info('[4dv] no inline-3D session: rendering 2D');
      this.monoLoop();
      return { woven: false, firstWoven: Promise.resolve({ woven: false }) };
    }
    this.woven = true;
    this.sizeToCanvas();
    for (const eye of this.eyes) this.cam.add(eye.camera);
    this.handle = this.wall.addScene(this.canvas, (views, layer) => this.xrFrame(views, layer), {
      viewRig: this.currentRig(),
      onLayerLost: () => {
        console.warn('[4dv] 3D layer lost: falling back to 2D');
        this.woven = false;
        this.sizeToCanvas();
        this.monoLoop();
        this.onModeChange(false);
      },
    });
    this.wall.on?.('renderingmodechange', (e) => {
      this.stereo = e.viewCount !== 1;
      this.onModeChange(this.stereo);
    });
    window.addEventListener('pagehide', () => this.wall?.close());
    console.info('[4dv] inline-3D session live: woven stereo through DisplayXR');
    this.handle.firstWoven.then((r) => console.info(`[4dv] firstWoven ${JSON.stringify(r)}`));
    setInterval(() => {
      const s = this.handle?.stats?.();
      if (s) console.info(`[4dv] frames=${s.frames} monoFrames=${s.monoFrames} stereo=${this.stereo} buffer=${this.canvas.width}x${this.canvas.height}`);
    }, 5000);
    return { woven: true, firstWoven: this.handle.firstWoven };
  }

  get displayModesSupported() {
    return this.woven && inline3dDisplayModesSupported();
  }

  async setStereo(on) {
    if (!this.displayModesSupported) return false;
    await this.wall.setStereoEnabled(on);
    this.stereo = on;
    this.onModeChange(on);
    return true;
  }

  /** Near / far depth of the visible splats (5th / 95th percentile, from the sort), smoothed. */
  setDepthRange(near, far) {
    const k = this.invNear ? 0.1 : 1;
    this.invNear = (this.invNear ?? 0) * (1 - k) + k / Math.max(near, 1e-3);
    this.invFar = (this.invFar ?? 0) * (1 - k) + k / Math.max(far, 1e-3);
  }

  currentRig() {
    // 63 mm eyes at ipdFactor 1; scale with distance so a 3 m orbit reads like a close-up ...
    let ipd = clamp(this.dist / 2.2, 0.08, 4);
    // ... but never past the disparity budget at the scene's near and far depths. Disparity of a point at
    // depth z with convergence c, as a fraction of the view width: e·|1/z − 1/c| / (2·tan(hfov/2)).
    if (this.invNear) {
      const inv = 1 / Math.max(0.1, this.dist);
      const spread = Math.max(Math.abs(this.invNear - inv), Math.abs(inv - this.invFar), 1e-6);
      const tanH = Math.tan(THREE.MathUtils.degToRad(this.cam.fov) / 2) * this.cam.aspect;
      ipd = Math.max(ipd * MIN_DEPTH_SHARE, Math.min(ipd, (DISPARITY_BUDGET * 2 * tanH) / (EYE_SEPARATION * spread)));
    }
    this.ipd = ipd *= this.depthGain;
    return cameraRigFromCamera(THREE, this.cam, {
      convergence: Math.max(0.1, this.dist),
      ipdFactor: ipd,
      attach: true,
      out: this.rigScratch,
    });
  }

  /** Aim the orbit: target point, distance, yaw/pitch in radians. */
  setView({ target, dist, yaw = 0, pitch = 0 }) {
    this.target.copy(target);
    this.dist = dist;
    this.yaw = yaw;
    this.pitch = pitch;
    this.minDist = dist * 0.15;
    this.maxDist = dist * 4;
    this.home = { target: target.clone(), dist, yaw, pitch };
  }

  resetView() {
    if (this.home) this.setView(this.home);
  }

  updateCamera(dt) {
    if (this.turntable && !this.dragging) this.yaw += dt * 0.35;
    const cp = Math.cos(this.pitch);
    this.cam.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist,
    );
    this.cam.lookAt(this.target);
    this.cam.near = Math.max(0.01, this.dist * 0.02);
    this.cam.far = this.dist * 20;
    this.cam.updateProjectionMatrix();
  }

  bindPointer() {
    const c = this.canvas;
    let last = null;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      last = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey };
      this.dragging = true;
    });
    c.addEventListener('pointermove', (e) => {
      if (!last) return;
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      last.x = e.clientX;
      last.y = e.clientY;
      if (last.pan) {
        const s = (this.dist * Math.tan(THREE.MathUtils.degToRad(this.cam.fov / 2)) * 2) / (c.clientHeight || 600);
        const right = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 1);
        this.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
      } else {
        this.yaw -= dx * 0.006;
        this.pitch = clamp(this.pitch + dy * 0.006, -1.4, 1.4);
      }
    });
    const end = () => { last = null; this.dragging = false; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = clamp(this.dist * Math.exp(e.deltaY * 0.001), this.minDist, this.maxDist);
    }, { passive: false });
  }

  sizeToCanvas() {
    const dpr = window.devicePixelRatio || 1;
    let w = Math.max(1, Math.round((this.canvas.clientWidth || 960) * dpr));
    let h = Math.max(1, Math.round((this.canvas.clientHeight || 540) * dpr));
    const s = Math.min(1, MAX_EYE_W / w);
    w = Math.floor(w * s);
    h = Math.floor(h * s);
    // Woven: a DOUBLE-WIDTH side-by-side store (left eye | right eye) in the same CSS box.
    const bw = this.woven ? w * 2 : w;
    if (this.canvas.width !== bw || this.canvas.height !== h) this.renderer.setSize(bw, h, false);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }

  step() {
    const now = performance.now();
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    this.onTick(dt);
    this.updateCamera(dt);
  }

  xrFrame(views, layer) {
    if (!views || views.length < 2 || !layer) return;
    const vps = views.map((v) => layer.getViewport(v));
    if (vps.some((vp) => !vp || vp.width <= 0 || vp.height <= 0)) return;
    this.step();
    this.handle.setViewRig(this.currentRig());
    this.scene.updateMatrixWorld();
    const r = this.renderer;
    r.setScissorTest(false);
    r.clear();
    r.setScissorTest(true);
    for (let i = 0; i < 2; i++) {
      const vp = vps[i];
      r.setViewport(vp.x, vp.y, vp.width, vp.height);
      r.setScissor(vp.x, vp.y, vp.width, vp.height);
      this.eyes[i].setLocalFromView(views[i]);
      this.eyes[i].camera.updateMatrixWorld();
      this.viewport.set(vp.width, vp.height);
      this.onEye(this.eyes[i].camera, this.viewport);
      r.render(this.scene, this.eyes[i].camera);
    }
    r.setScissorTest(false);
  }

  monoLoop() {
    if (this.monoRunning) return;
    this.monoRunning = true;
    const loop = () => {
      if (this.woven) { this.monoRunning = false; return; }
      requestAnimationFrame(loop);
      this.step();
      const r = this.renderer;
      r.setViewport(0, 0, this.canvas.width, this.canvas.height);
      r.clear();
      this.scene.updateMatrixWorld();
      this.viewport.set(this.canvas.width, this.canvas.height);
      this.onEye(this.cam, this.viewport);
      r.render(this.scene, this.cam);
    };
    requestAnimationFrame(loop);
  }
}
