// The 3D stage: one persistent canvas, woven by the DisplayXR inline-3D SDK when the browser and
// display support it, and rendered as ordinary 2D otherwise.
//
// An orbit CAMERA rig around the caller's head: convergence sits on the orbit target, so the face
// rests on the glass with the nose popping out and the far side receding. Eye separation
// scales with the orbit distance, so zooming in or out keeps the same comfortable depth. The eyes
// hang off the app camera and the rig is sent identity-posed every frame (the attach pattern), so
// orbiting has no stereo lag.

import * as THREE from 'three';
import { createInline3D, inline3dDisplayModesSupported } from '@displayxr/inline3d';
import { EyeCamera, cameraRigFromCamera } from '@displayxr/inline3d/three';

const MAX_EYE_W = 2560; // per-eye backing-store cap
const FOV = 35; // vertical FOV on landscape screens, degrees
const NARROW = 0.8; // below this aspect (portrait phones), widen the FOV to keep the width framed
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
    // Sway: a slow side-to-side swing that shows the volume on flat screens. It fades in and out.
    this.sway = false;
    this.swayAmp = 0;
    this.swayT = 0;

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
      console.warn('[splat-call] inline-3D unavailable', e);
    }
    if (!this.wall?.supported) {
      console.info('[splat-call] no inline-3D session: rendering 2D');
      this.monoLoop();
      return { woven: false, firstWoven: Promise.resolve({ woven: false }) };
    }
    this.woven = true;
    this.sizeToCanvas();
    for (const eye of this.eyes) this.cam.add(eye.camera);
    this.handle = this.wall.addScene(this.canvas, (views, layer) => this.xrFrame(views, layer), {
      viewRig: this.currentRig(),
      onLayerLost: () => {
        console.warn('[splat-call] 3D layer lost: falling back to 2D');
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

  currentRig() {
    // 63 mm eyes at ipdFactor 1; scale with distance so a 3 m orbit reads like a close-up.
    const ipd = this.depthGain * clamp(this.dist / 2.2, 0.08, 4);
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
    const want = this.sway && !this.dragging ? 0.38 : 0;
    this.swayAmp += (want - this.swayAmp) * Math.min(1, dt * 1.5);
    this.swayT += dt * this.swayAmp;
    const yaw = this.yaw + this.swayAmp * Math.sin(this.swayT * 1.6);
    const cp = Math.cos(this.pitch);
    this.cam.position.set(
      this.target.x + Math.sin(yaw) * cp * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(yaw) * cp * this.dist,
    );
    this.cam.lookAt(this.target);
    this.cam.near = Math.max(0.01, this.dist * 0.02);
    this.cam.far = Math.max(this.dist * 20, 40); // the scenes reach ~16 m
    this.cam.updateProjectionMatrix();
  }

  /** Pan the orbit target by a screen-space move of (dx, dy) CSS pixels. */
  pan(dx, dy) {
    const s = (this.dist * Math.tan(THREE.MathUtils.degToRad(this.cam.fov / 2)) * 2) / (this.canvas.clientHeight || 600);
    const right = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 1);
    this.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
  }

  // Mouse: drag orbits, right- or shift-drag pans, the wheel zooms. Touch: one finger orbits, two
  // fingers pinch to zoom and drag to pan, a double tap resets.
  bindPointer() {
    const c = this.canvas;
    const pts = new Map(); // pointerId → { x, y }
    let pan = false, pinch = null;
    const two = () => {
      const [a, b] = [...pts.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      try { c.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      pan = e.button !== 0 || e.shiftKey;
      pinch = pts.size === 2 ? two() : null;
      this.dragging = true;
    });
    c.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pts.size >= 2) {
        if (!pinch) { pinch = two(); return; }
        const now = two();
        this.dist = clamp((this.dist * pinch.d) / now.d, this.minDist, this.maxDist);
        this.pan(now.x - pinch.x, now.y - pinch.y);
        pinch = now;
      } else if (pan) {
        this.pan(dx, dy);
      } else {
        this.yaw -= dx * 0.006;
        this.pitch = clamp(this.pitch + dy * 0.006, -1.4, 1.4);
      }
    });
    const end = (e) => {
      pts.delete(e.pointerId);
      pinch = null;
      this.dragging = pts.size > 0;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', () => this.resetView());
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
    // Portrait: keep about a 0.8-aspect width in view, so the caller is not cropped to a nose.
    const a = w / h;
    this.cam.fov = a >= NARROW ? FOV : THREE.MathUtils.radToDeg(2 * Math.atan((Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * NARROW) / a));
    this.cam.aspect = a;
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
