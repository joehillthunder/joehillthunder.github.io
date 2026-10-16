// The 3D stage every Creator Hub tool renders into: one persistent canvas, woven by the DisplayXR
// inline-3D SDK when the browser and display support it, and ordinary 2D otherwise.
//
// An orbit-camera rig: focusDist is the distance from the camera to the orbit target, and the
// convergence plane sits just beyond it, so the thing you are working on floats a little in front
// of the glass. Eye separation scales with that distance, so a close-up of a material ball and a
// 20 km terrain both get comfortable depth. The eyes hang off the app camera and the rig is sent
// every frame (attach pattern), so orbiting has no stereo lag.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createInline3D, inline3dDisplayModesSupported } from '@displayxr/inline3d';
import { EyeCamera, cameraRigFromCamera } from '@displayxr/inline3d/three';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const MAX_EYE_W = 2560; // per-eye backing-store cap
const params = new URLSearchParams(location.search);

export class Stage {
  constructor(canvas, { fov = 40, near = 0.02, far = 800, pop = 1.06, tag = 'creator' } = {}) {
    this.canvas = canvas;
    this.tag = tag;
    this.woven = false;
    this.stereo = true;
    this.pop = pop;
    this.depthGain = clamp(parseFloat(params.get('depth') ?? '1') || 1, 0, 2);
    this.onTick = () => {};
    this.onModeChange = () => {};
    this.frames = 0;
    this.hideOnSnapshot = [];

    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' }));
    // pixelRatio MUST stay 1: layer.getViewport() reports backing-store pixels. sizeToCanvas sizes it.
    r.setPixelRatio(1);
    r.autoClear = false;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    // The camera lives IN the scene so the eye cameras parented to it get updated by the traversal.
    this.cam = new THREE.PerspectiveCamera(fov, 16 / 9, near, far);
    this.cam.position.set(2.4, 1.6, 3.2);
    this.scene.add(this.cam);
    this.controls = new OrbitControls(this.cam, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.eyes = [new EyeCamera(THREE), new EyeCamera(THREE)];
    this.rigScratch = {};
    new ResizeObserver(() => this.sizeToCanvas()).observe(canvas);
    this.cover = Object.assign(document.createElement('div'), { className: 'stage-cover', textContent: 'Starting 3D…' });
    canvas.after(this.cover);
  }

  get focusDist() {
    return this.cam.position.distanceTo(this.controls.target);
  }

  async start() {
    this.sizeToCanvas();
    if (!params.has('mono')) {
      try {
        this.wall = await createInline3D({ lazy: false });
      } catch (e) {
        console.warn(`[${this.tag}] inline-3D unavailable`, e);
      }
    }
    if (!this.wall?.supported) {
      console.info(`[${this.tag}] no inline-3D session: rendering 2D`);
      this.monoLoop();
      this.uncover();
      return { woven: false, firstWoven: Promise.resolve({ woven: false, reason: 'unsupported' }) };
    }
    // Woven-canvas rule 4: size the backing store 2:1 first, then wait two frames before registering.
    this.woven = true;
    this.sizeToCanvas();
    for (const eye of this.eyes) this.cam.add(eye.camera);
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    await raf();
    await raf();
    this.handle = this.wall.addScene(this.canvas, (views, layer) => this.xrFrame(views, layer), {
      viewRig: this.currentRig(),
      rectCover: 'auto', // rule 11: the SDK covers resizes until the canvas is rewoven
      onLayerLost: () => {
        console.warn(`[${this.tag}] 3D layer lost: falling back to 2D`);
        this.woven = false;
        this.sizeToCanvas();
        this.monoLoop();
        this.uncover();
        this.onModeChange(false);
      },
    });
    this.wall.on?.('renderingmodechange', (e) => {
      this.stereo = e.viewCount !== 1;
      this.onModeChange(this.stereo);
    });
    window.addEventListener('pagehide', () => this.wall?.close());
    console.info(`[${this.tag}] inline-3D session live`);
    this.onModeChange(true);
    // Rule 5: the cover stays over the canvas until the first woven frame, then a hard cut.
    this.handle.firstWoven.then((r) => {
      console.info(`[${this.tag}] firstWoven`, r);
      this.uncover();
    });
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

  setDepth(gain) {
    this.depthGain = clamp(gain, 0, 2);
  }

  currentRig() {
    const d = Math.max(0.05, this.focusDist);
    return cameraRigFromCamera(THREE, this.cam, {
      convergence: d * this.pop,
      ipdFactor: this.depthGain * clamp(d / 2.2, 0.08, 4),
      attach: true,
      out: this.rigScratch,
    });
  }

  sizeToCanvas() {
    const dpr = window.devicePixelRatio || 1;
    let w = Math.max(1, Math.round((this.canvas.clientWidth || 960) * dpr));
    let h = Math.max(1, Math.round((this.canvas.clientHeight || 540) * dpr));
    const s = Math.min(1, MAX_EYE_W / w);
    w = Math.floor(w * s);
    h = Math.floor(h * s);
    // Woven: a double-width side-by-side store (left eye | right eye) in the same CSS box.
    const bw = this.woven ? w * 2 : w;
    if (this.canvas.width !== bw || this.canvas.height !== h) this.renderer.setSize(bw, h, false);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }

  step() {
    const now = performance.now();
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    this.controls.update();
    this.onTick(dt, now / 1000);
    this.frames++;
  }

  xrFrame(views, layer) {
    // Validate before clearing. An unusable frame replays the last good views, so the woven
    // canvas is redrawn every frame and never drops out of the compositor's aggregate.
    let vps = views && views.length >= 2 && layer ? views.map((v) => layer.getViewport(v)) : null;
    if (!vps || vps.some((vp) => !vp || vp.width <= 0 || vp.height <= 0)) {
      if (!this.lastGood) return;
      ({ views, vps } = this.lastGood);
    } else this.lastGood = { views, vps };
    this.step();
    this.handle.setViewRig(this.currentRig());
    const snap = this.snapReq;
    if (snap) { this.snapReq = null; snap.hidden = this.hideForSnapshot(); }
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
      r.render(this.scene, this.eyes[i].camera);
    }
    r.setScissorTest(false);
    if (snap) {
      // The left eye, read back from the frame just drawn (preserveDrawingBuffer keeps it).
      snap.hidden.forEach((o) => (o.visible = true));
      snap.resolve(this.cropToDataURL(vps[0], snap));
    }
  }

  renderMono() {
    const r = this.renderer;
    r.setViewport(0, 0, this.canvas.width, this.canvas.height);
    r.clear();
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

  /** Remove the boot cover (a hard cut, never a fade). */
  uncover() {
    this.cover?.remove();
    this.cover = null;
  }

  hideForSnapshot() {
    const hidden = this.hideOnSnapshot.filter((o) => o && o.visible);
    hidden.forEach((o) => (o.visible = false));
    return hidden;
  }

  cropToDataURL(vp, { maxW, type }) {
    const c = this.canvas;
    const sy = c.height - vp.y - vp.height; // GL viewports are bottom-up, the image is top-down
    const s = Math.min(1, maxW / vp.width);
    const out = document.createElement('canvas');
    out.width = Math.round(vp.width * s);
    out.height = Math.round(vp.height * s);
    out.getContext('2d').drawImage(c, vp.x, sy, vp.width, vp.height, 0, 0, out.width, out.height);
    return out.toDataURL(type, 0.88);
  }

  /**
   * A data URL of the current view with helpers hidden (a Promise). Woven, it is taken inside the
   * next woven frame (left eye), so nothing is ever drawn to the woven canvas outside onFrame.
   */
  snapshot(maxW = 640, type = 'image/jpeg') {
    if (this.woven) return new Promise((resolve) => { this.snapReq = { resolve, maxW, type }; });
    const hidden = this.hideForSnapshot();
    this.renderMono();
    const url = this.cropToDataURL({ x: 0, y: 0, width: this.canvas.width, height: this.canvas.height }, { maxW, type });
    hidden.forEach((o) => (o.visible = true));
    return Promise.resolve(url);
  }

  /** Smoothly move the camera and orbit target. */
  flyTo(pos, target, secs = 0.9) {
    const p0 = this.cam.position.clone(), t0 = this.controls.target.clone();
    const p1 = new THREE.Vector3(...pos), t1 = new THREE.Vector3(...target);
    const start = performance.now();
    this.flight = () => {
      const k = Math.min(1, (performance.now() - start) / (secs * 1000));
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.cam.position.lerpVectors(p0, p1, e);
      this.controls.target.lerpVectors(t0, t1, e);
      if (k >= 1) this.flight = null;
    };
    const tick = () => { if (this.flight) { this.flight(); requestAnimationFrame(tick); } };
    requestAnimationFrame(tick);
  }

  /** Frame an object: orbit target at its centre, distance from its bounding sphere. */
  frame(object, dirHint = [1, 0.55, 1.35], secs = 0.8) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const sph = box.getBoundingSphere(new THREE.Sphere());
    const d = (sph.radius / Math.sin(THREE.MathUtils.degToRad(this.cam.fov / 2))) * 1.05;
    const dir = new THREE.Vector3(...dirHint).normalize();
    const c = sph.center;
    this.flyTo([c.x + dir.x * d, c.y + dir.y * d, c.z + dir.z * d], [c.x, c.y, c.z], secs);
  }
}

/** Wire the standard viewport chip: 2D/3D state, depth slider, lens toggle. */
export function wireDepthChip(stage, chip) {
  const label = chip.querySelector('.mode-label');
  const depth = chip.querySelector('input[type=range]');
  const lens = chip.querySelector('.lens');
  if (depth) {
    depth.value = stage.depthGain;
    depth.oninput = () => stage.setDepth(parseFloat(depth.value));
  }
  const show = () => {
    const live = stage.woven && stage.stereo;
    if (label) label.innerHTML = live ? '<b>3D</b> DisplayXR woven' : stage.woven ? '2D (lens off)' : '2D preview';
    chip.querySelector('.vp-depth')?.toggleAttribute('hidden', !stage.woven);
    if (lens) lens.hidden = !stage.displayModesSupported;
    if (lens) lens.textContent = stage.stereo ? '3D lens: on' : '3D lens: off';
  };
  if (lens) lens.onclick = () => stage.setStereo(!stage.stereo);
  const prev = stage.onModeChange;
  stage.onModeChange = (on) => { prev(on); show(); };
  show();
}
