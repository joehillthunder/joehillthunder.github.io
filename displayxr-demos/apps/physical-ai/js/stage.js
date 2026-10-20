// The 3D stage: one persistent canvas for the life of the page, woven by the DisplayXR inline-3D SDK
// when the browser and display support it, ordinary 2D otherwise.
//
// An orbit camera rig around a target on the counter. Convergence sits on the target, so the work area
// rests on the glass, the arm leans out toward the viewer and the kitchen recedes behind. The eyes hang
// off the app camera and the rig is re-sent every frame (the attach pattern), so orbiting has no stereo
// lag. Eye separation scales with orbit distance and is capped by a disparity budget, so a close-up
// of the gripper and a wide shot of the evaluation grid both stay comfortable.
//
// Woven-canvas rules followed (DisplayXR/displayxr-web docs/woven-canvas-rules.md): one
// createInline3D per document, the canvas is never remounted, its side-by-side store is sized before
// addScene, pixelRatio stays 1, every frame validates the views before clearing, and the caller covers
// the canvas until firstWoven.

import * as THREE from 'three';
import { createInline3D, inline3dDisplayModesSupported } from '@displayxr/inline3d';
import { EyeCamera, cameraRigFromCamera } from '@displayxr/inline3d/three';

const MAX_EYE_W = 2048;
const DISPARITY_BUDGET = 0.012; // largest disparity (fraction of view width) at the near/far depths
const EYE_SEPARATION = 0.063;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Stage {
  constructor(canvas, { force2d = false } = {}) {
    this.canvas = canvas;
    this.force2d = force2d;
    this.woven = false;
    this.depthGain = 1;
    this.onTick = () => {};
    this.target = new THREE.Vector3();
    this.goal = null; // eased view change
    this.yaw = 0; this.pitch = 0.5; this.dist = 1;
    this.minDist = 0.15; this.maxDist = 8;
    this.sceneRadius = 0.35; // half-depth of what matters around the target, for the depth budget

    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(1); // layer.getViewport() reports backing-store pixels
    r.autoClear = false;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.setClearColor(0x0b0e14, 1);
    const gl = r.getContext();
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    this.maxDim = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), vp[0], vp[1]);

    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(40, 16 / 9, 0.02, 60);
    this.scene.add(this.cam);
    this.eyes = [new EyeCamera(THREE), new EyeCamera(THREE)];
    this.rigScratch = {};
    window.addEventListener('resize', () => this.onResize());
    this.bindPointer();
  }

  async start() {
    this.sizeToCanvas();
    if (!this.force2d) {
      try { this.wall = await createInline3D({ lazy: false }); } catch (e) { console.warn('[physical-ai] inline-3D unavailable', e); }
    }
    if (!this.wall?.supported) {
      this.monoLoop();
      return { woven: false, firstWoven: Promise.resolve({ woven: false }) };
    }
    this.woven = true;
    this.sizeToCanvas();
    // let the 2:1 store paint before registering (a canvas fresh to the compositor joins slowest)
    this.renderMono();
    await new Promise((r) => requestAnimationFrame(r));
    for (const eye of this.eyes) this.cam.add(eye.camera);
    this.handle = this.wall.addScene(this.canvas, (views, layer) => this.xrFrame(views, layer), {
      viewRig: this.currentRig(),
      onLayerLost: () => {
        console.warn('[physical-ai] 3D layer lost: falling back to 2D');
        this.woven = false;
        this.sizeToCanvas();
        this.monoLoop();
        this.onModeChange?.(false);
      },
    });
    this.wall.on?.('renderingmodechange', (e) => this.onModeChange?.(e.viewCount !== 1));
    window.addEventListener('pagehide', () => this.wall?.close());
    return { woven: true, firstWoven: this.handle.firstWoven };
  }

  get displayModesSupported() { return this.woven && inline3dDisplayModesSupported(); }
  async setStereo(on) { if (this.displayModesSupported) await this.wall.setStereoEnabled(on); }

  currentRig() {
    let ipd = clamp(this.dist / 1.6, 0.05, 4);
    // keep the near and far edges of the subject inside the disparity budget
    const near = Math.max(0.05, this.dist - this.sceneRadius), far = this.dist + this.sceneRadius;
    const spread = Math.max(1 / near - 1 / this.dist, 1 / this.dist - 1 / far);
    const tanH = Math.tan(THREE.MathUtils.degToRad(this.cam.fov) / 2) * this.cam.aspect;
    ipd = Math.min(ipd, (DISPARITY_BUDGET * 2 * tanH) / (EYE_SEPARATION * spread));
    this.ipd = ipd * this.depthGain;
    return cameraRigFromCamera(THREE, this.cam, { convergence: Math.max(0.1, this.dist), ipdFactor: this.ipd, attach: true, out: this.rigScratch });
  }

  /** Ease the orbit to a new view: { target, dist, yaw, pitch, radius }. */
  flyTo(v, seconds = 1.1) {
    this.goal = { from: { target: this.target.clone(), dist: this.dist, yaw: this.yaw, pitch: this.pitch, radius: this.sceneRadius }, to: { target: v.target.clone(), dist: v.dist, yaw: v.yaw ?? this.yaw, pitch: v.pitch ?? this.pitch, radius: v.radius ?? this.sceneRadius }, t: 0, T: seconds };
    if (seconds <= 0) this.goal.t = 1;
  }

  updateCamera(dt) {
    if (this.goal) {
      const g = this.goal;
      g.t = Math.min(1, g.t + dt / g.T);
      const k = g.t < 0.5 ? 4 * g.t ** 3 : 1 - (-2 * g.t + 2) ** 3 / 2;
      this.target.lerpVectors(g.from.target, g.to.target, k);
      this.dist = g.from.dist + (g.to.dist - g.from.dist) * k;
      let dy = g.to.yaw - g.from.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.yaw = g.from.yaw + dy * k;
      this.pitch = g.from.pitch + (g.to.pitch - g.from.pitch) * k;
      this.sceneRadius = g.from.radius + (g.to.radius - g.from.radius) * k;
      if (g.t >= 1) this.goal = null;
    }
    if (this.idleSway && !this.dragging && !this.goal) { this.swayT = (this.swayT || 0) + dt; this.yawOffset = Math.sin(this.swayT * 0.25) * 0.12; } else this.yawOffset = (this.yawOffset || 0) * 0.95;
    const yaw = this.yaw + (this.yawOffset || 0), cp = Math.cos(this.pitch);
    this.cam.position.set(this.target.x + Math.sin(yaw) * cp * this.dist, this.target.y + Math.sin(this.pitch) * this.dist, this.target.z + Math.cos(yaw) * cp * this.dist);
    this.cam.lookAt(this.target);
    this.cam.near = Math.max(0.01, this.dist * 0.05);
    this.cam.far = this.dist + 25;
    this.cam.updateProjectionMatrix();
  }

  bindPointer() {
    const c = this.canvas;
    let last = null, moved = 0;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      last = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey };
      moved = 0;
      this.dragging = true;
    });
    c.addEventListener('pointermove', (e) => {
      if (!last) { this.onHover?.(e); return; }
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      last.x = e.clientX; last.y = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved < 4) return;
      this.goal = null;
      if (last.pan) {
        const s = (this.dist * Math.tan(THREE.MathUtils.degToRad(this.cam.fov / 2)) * 2) / (c.clientHeight || 600);
        const right = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 1);
        this.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
      } else {
        this.yaw -= dx * 0.006;
        this.pitch = clamp(this.pitch + dy * 0.006, -0.2, 1.45);
      }
    });
    const end = (e) => {
      if (last && moved < 4 && e.type === 'pointerup') this.onTap?.(e);
      last = null; this.dragging = false;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.goal = null;
      this.dist = clamp(this.dist * Math.exp(e.deltaY * 0.001), this.minDist, this.maxDist);
    }, { passive: false });
  }

  /** Normalised device coords of a pointer event, for raycasting with the mono camera. */
  ndc(e, out = new THREE.Vector2()) {
    const r = this.canvas.getBoundingClientRect();
    return out.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  sizeToCanvas() {
    let w = Math.max(1, Math.round(this.canvas.clientWidth || innerWidth));
    let h = Math.max(1, Math.round(this.canvas.clientHeight || innerHeight));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.round(w * dpr); h = Math.round(h * dpr);
    const budget = this.woven ? 2.2e6 : 2.6e6; // per eye
    const s = Math.min(1, MAX_EYE_W / w, Math.sqrt(budget / (w * h)), this.maxDim / (this.woven ? 2 * w : w), this.maxDim / h);
    w = Math.floor(w * s); h = Math.floor(h * s);
    const bw = this.woven ? w * 2 : w;
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
    if (this.canvas.width === bw && this.canvas.height === h) return false;
    this.renderer.setSize(bw, h, false);
    return true;
  }

  onResize() {
    if (this.woven && this.handle?.rewoven) this.onRewoven?.(this.handle.rewoven());
    if (this.sizeToCanvas()) { if (this.woven) this.renderStereo(null); else this.renderMono(); }
  }

  step() {
    const now = performance.now();
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    this.onTick(dt);
    this.updateCamera(dt);
  }

  xrFrame(views, layer) {
    this.step();
    let ok = !!views && views.length >= 2 && !!layer;
    const vps = [null, null];
    if (ok) for (let i = 0; i < 2; i++) { vps[i] = layer.getViewport(views[i]); if (!vps[i] || vps[i].width <= 0) { ok = false; break; } }
    if (!ok) { if (this.haveGood) this.renderStereo(null); return; }
    this.handle.setViewRig(this.currentRig());
    this.scene.updateMatrixWorld();
    for (let i = 0; i < 2; i++) this.eyes[i].setLocalFromView(views[i]);
    this.haveGood = true;
    this.renderStereo(vps);
  }

  renderStereo(vps) {
    const r = this.renderer, w = this.canvas.width, h = this.canvas.height;
    r.setScissorTest(false);
    r.clear();
    r.setScissorTest(true);
    for (let i = 0; i < 2; i++) {
      const vp = vps ? vps[i] : { x: (i * w) / 2, y: 0, width: w / 2, height: h };
      r.setViewport(vp.x, vp.y, vp.width, vp.height);
      r.setScissor(vp.x, vp.y, vp.width, vp.height);
      const cam = this.haveGood ? this.eyes[i].camera : this.cam;
      cam.updateMatrixWorld();
      r.render(this.scene, cam);
    }
    r.setScissorTest(false);
  }

  renderMono() {
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.canvas.width, this.canvas.height);
    r.clear();
    this.scene.updateMatrixWorld();
    if (this.woven) { this.renderStereo(null); return; }
    r.render(this.scene, this.cam);
  }

  monoLoop() {
    if (this.monoRunning) return;
    this.monoRunning = true;
    const loop = () => {
      if (this.woven) { this.monoRunning = false; return; }
      requestAnimationFrame(loop);
      this.step();
      this.renderMono();
    };
    requestAnimationFrame(loop);
  }
}
