// One 10×10 battle area on the sea: a holographic tactical grid floating just above the swell,
// coordinate labels, corner buoys, the ships that ride the waves, and the hit/miss markers.

import * as THREE from 'three';
import { N, ROWS, rand } from './util.js';
import { waveHeight, waveSlope } from './ocean.js';
import { buildShip, charModel, ghostModel } from './ships.js';

export const GRID_Y = 0.17;

const overlayVS = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const overlayFS = `
  uniform sampler2D uCells;
  uniform vec3 uLine;
  uniform float uTime, uPulse, uDim;
  varying vec2 vUv;
  void main() {
    vec2 g = vUv * ${N}.0;
    vec2 cell = floor(g);
    vec2 f = fract(g);
    vec2 e = min(f, 1.0 - f);
    float d = min(e.x, e.y);
    float w = fwidth(d) * 1.2;
    float line = 1.0 - smoothstep(0.012, 0.012 + w, d);
    float glowL = (1.0 - smoothstep(0.0, 0.12, d)) * 0.25;
    vec2 be = min(vUv, 1.0 - vUv);
    float bd = min(be.x, be.y);
    float border = 1.0 - smoothstep(0.003, 0.003 + fwidth(bd) * 1.5, bd);
    float borderGlow = (1.0 - smoothstep(0.0, 0.03, bd)) * 0.5;
    // sonar sweep travelling down the board
    float sweep = fract(uTime * 0.12);
    float sw = exp(-pow((1.0 - vUv.y - sweep) * 28.0, 2.0)) * 0.6;
    vec4 tint = texture2D(uCells, (cell + 0.5) / ${N}.0);
    // tinted cells: soft fill with a brighter inner frame
    float inner = 1.0 - smoothstep(0.05, 0.16, d);
    float pulse = 0.75 + 0.25 * sin(uTime * 6.0);
    vec3 col = uLine * (line * 0.9 + glowL + border * 1.3 + borderGlow + sw * 0.5) * uDim;
    col += tint.rgb * tint.a * (0.38 + inner * 0.9) * mix(1.0, pulse, uPulse);
    gl_FragColor = vec4(col, 1.0);
  }`;

export class Board {
  constructor(scene, fx, center, { name, accent }) {
    this.scene = scene;
    this.fx = fx;
    this.center = center.clone();
    this.group = new THREE.Group();
    this.group.position.copy(center);
    scene.add(this.group);
    this.ships = new Map(); // id → { model, ship, wreck, sink, team }
    this.markers = [];
    this.emitters = [];

    // Cell tints (rgba per square).
    this.cellData = new Uint8Array(N * N * 4);
    this.cellTex = new THREE.DataTexture(this.cellData, N, N, THREE.RGBAFormat);
    this.cellTex.needsUpdate = true;
    this.persistent = new Uint8Array(N * N * 4);

    this.overlayU = {
      uCells: { value: this.cellTex },
      uLine: { value: new THREE.Color(accent) },
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uDim: { value: 1 },
    };
    const plane = new THREE.PlaneGeometry(N, N);
    plane.rotateX(-Math.PI / 2);
    this.overlay = new THREE.Mesh(plane, new THREE.ShaderMaterial({
      uniforms: this.overlayU, vertexShader: overlayVS, fragmentShader: overlayFS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.overlay.position.y = GRID_Y;
    this.overlay.renderOrder = 3;
    this.group.add(this.overlay);

    this.addLabels(name, accent);
    this.addBuoys(accent);
  }

  // -------------------------------------------------------------------------------------------
  // geometry helpers

  cellLocal(r, c, out = new THREE.Vector3()) {
    return out.set(c - (N - 1) / 2, 0, r - (N - 1) / 2);
  }

  cellWorld(r, c, out = new THREE.Vector3()) {
    return this.cellLocal(r, c, out).add(this.center);
  }

  /** World point on the grid plane → { r, c } or null. */
  cellAt(p) {
    const c = Math.floor(p.x - this.center.x + N / 2);
    const r = Math.floor(p.z - this.center.z + N / 2);
    if (r < 0 || c < 0 || r >= N || c >= N) return null;
    return { r, c };
  }

  shipCenterLocal(r, c, len, dir) {
    const a = this.cellLocal(r, c);
    const b = this.cellLocal(dir === 'h' ? r : r + len - 1, dir === 'h' ? c + len - 1 : c);
    return a.add(b).multiplyScalar(0.5);
  }

  // -------------------------------------------------------------------------------------------
  // decoration

  label(text, size, color) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const x = c.getContext('2d');
    x.font = `700 ${size}px Rajdhani, "Segoe UI", sans-serif`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.shadowColor = color;
    x.shadowBlur = 14;
    x.fillStyle = '#ffffff';
    x.fillText(text, 128, 66);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.5), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, toneMapped: false }));
    m.rotation.x = -Math.PI / 2 + 0.55; // lying on the water, tipped toward the viewer
    m.renderOrder = 4;
    return m;
  }

  addLabels(name, accent) {
    const col = '#' + new THREE.Color(accent).getHexString();
    for (let r = 0; r < N; r++) {
      const l = this.label(ROWS[r], 84, col);
      l.position.set(-N / 2 - 0.55, GRID_Y + 0.05, r - (N - 1) / 2);
      this.group.add(l);
    }
    for (let c = 0; c < N; c++) {
      const l = this.label(String(c + 1), 84, col);
      l.position.set(c - (N - 1) / 2, GRID_Y + 0.05, -N / 2 - 0.45);
      this.group.add(l);
    }
    const t = document.createElement('canvas');
    t.width = 1024; t.height = 128;
    const x = t.getContext('2d');
    x.font = '700 76px Rajdhani, "Segoe UI", sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.shadowColor = col; x.shadowBlur = 18; x.fillStyle = '#ffffff';
    x.fillText(name, 512, 66);
    const tex = new THREE.CanvasTexture(t);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.title = new THREE.Mesh(new THREE.PlaneGeometry(6, 0.75), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    this.title.rotation.x = -Math.PI / 2 + 0.55;
    this.title.position.set(0, GRID_Y + 0.1, N / 2 + 0.75);
    this.title.renderOrder = 4;
    this.titleTex = { canvas: t, ctx: x, tex, col };
    this.group.add(this.title);
  }

  setTitle(name) {
    const { canvas, ctx, tex } = this.titleTex;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillText(name, 512, 66);
    tex.needsUpdate = true;
  }

  addBuoys(accent) {
    this.buoys = [];
    const bodyM = new THREE.MeshStandardMaterial({ color: 0xd9a21b, metalness: 0.2, roughness: 0.5 });
    const lampM = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: accent, emissiveIntensity: 3 });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const b = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 0.3, 14), bodyM);
      body.position.y = 0.05;
      const cage = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.06, 0.28, 4, 1, true), new THREE.MeshStandardMaterial({ color: 0x333333, wireframe: true }));
      cage.position.y = 0.33;
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), lampM);
      lamp.position.y = 0.5;
      b.add(body, cage, lamp);
      b.userData.local = new THREE.Vector3(sx * (N / 2 + 0.5), 0, sz * (N / 2 + 0.5));
      b.userData.phase = Math.random() * 6;
      this.group.add(b);
      this.buoys.push(b);
    }
    this.lampM = lampM;
  }

  // -------------------------------------------------------------------------------------------
  // cell tints

  setTint(r, c, rgba, persistent = false) {
    const i = ((N - 1 - r) * N + c) * 4;
    const tgt = persistent ? this.persistent : this.cellData;
    tgt[i] = rgba[0]; tgt[i + 1] = rgba[1]; tgt[i + 2] = rgba[2]; tgt[i + 3] = rgba[3];
    if (persistent) this.cellData.set(this.persistent.subarray(i, i + 4), i);
    this.cellTex.needsUpdate = true;
  }

  /** Drop temporary tints (hover, placement) back to the persistent ones. */
  resetTints() {
    this.cellData.set(this.persistent);
    this.cellTex.needsUpdate = true;
  }

  // -------------------------------------------------------------------------------------------
  // ships

  addShip(ship, team, { wreck = false, hidden = false } = {}) {
    this.removeShip(ship.id);
    const model = buildShip(ship.id, team);
    if (ship.dir === 'v') model.rotation.y = -Math.PI / 2;
    const base = this.shipCenterLocal(ship.r, ship.c, ship.len, ship.dir);
    const entry = { model, ship, team, base, wreck: 0, sinkT: 0, roll: rand(-1, 1), phase: rand(0, 6), smoke: [] };
    model.userData.yaw = model.rotation.y;
    this.group.add(model);
    this.ships.set(ship.id, entry);
    for (const p of model.userData.smoke || []) {
      const e = this.fx.addEmitter(p, 'funnel');
      e.obj = model;
      entry.smoke.push(e);
    }
    if (wreck) this.wreck(ship.id, true);
    model.visible = !hidden;
    return entry;
  }

  removeShip(id) {
    const e = this.ships.get(id);
    if (!e) return;
    this.group.remove(e.model);
    for (const s of e.smoke) this.fx.removeEmitter(s);
    this.ships.delete(id);
  }

  /** Burn it out and let it settle low in the water, listing. */
  wreck(id, instant = false) {
    const e = this.ships.get(id);
    if (!e) return;
    charModel(e.model);
    for (const s of e.smoke) this.fx.removeEmitter(s);
    e.smoke = [];
    e.sinking = true;
    e.sinkT = instant ? 1 : 0;
  }

  shipWorld(id, local, out = new THREE.Vector3()) {
    const e = this.ships.get(id);
    return e.model.localToWorld(out.copy(local));
  }

  // -------------------------------------------------------------------------------------------
  // markers

  addMiss(r, c) {
    const g = new THREE.Group();
    const m1 = new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.4, metalness: 0.1 });
    const peg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 0.22, 14), m1);
    peg.position.y = 0.05;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), m1);
    cap.position.y = 0.16;
    g.add(peg, cap);
    const local = this.cellLocal(r, c);
    g.userData.local = local;
    g.userData.phase = rand(0, 6);
    this.group.add(g);
    this.markers.push(g);
    this.setTint(r, c, [120, 160, 200, 70], true);
    return g;
  }

  addHit(r, c, { fire = true } = {}) {
    const g = new THREE.Group();
    const m = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2a1a, emissiveIntensity: 2.2, roughness: 0.4 });
    const peg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.26, 12), m);
    peg.position.y = 0.1;
    g.add(peg);
    const local = this.cellLocal(r, c);
    g.userData.local = local;
    g.userData.phase = rand(0, 6);
    g.userData.hit = true;
    this.group.add(g);
    this.markers.push(g);
    this.setTint(r, c, [255, 40, 25, 150], true);
    if (fire) {
      const e = this.fx.addEmitter(local.clone().add(new THREE.Vector3(0, 0.22, 0)).add(this.center), 'fire', rand(1.3, 1.6));
      this.emitters.push(e);
    }
    return g;
  }

  markSunk(cells) {
    for (const [r, c] of cells) this.setTint(r, c, [150, 10, 10, 200], true);
  }

  clear() {
    for (const id of [...this.ships.keys()]) this.removeShip(id);
    for (const m of this.markers) this.group.remove(m);
    this.markers = [];
    for (const e of this.emitters) this.fx.removeEmitter(e);
    this.emitters = [];
    this.persistent.fill(0);
    this.resetTints();
  }

  // -------------------------------------------------------------------------------------------

  update(dt, t) {
    this.overlayU.uTime.value = t;
    const slope = { x: 0, y: 0 };
    const cx = this.center.x, cz = this.center.z;
    for (const e of this.ships.values()) {
      const m = e.model;
      const wx = cx + e.base.x, wz = cz + e.base.z;
      const h = waveHeight(wx, wz, t) * 0.7;
      waveSlope(wx, wz, t, slope);
      if (e.sinking && e.sinkT < 1) e.sinkT = Math.min(1, e.sinkT + dt / 3.2);
      const s = e.sinking ? 1 - Math.pow(1 - e.sinkT, 2) : 0;
      m.position.set(e.base.x, h + (m.userData.ride || 0) - s * (e.ship.id === 'submarine' ? 0.12 : 0.17), e.base.z);
      // pitch and roll with the swell, plus a list as it sinks
      const yaw = m.userData.yaw;
      const along = e.ship.dir === 'h' ? slope.x : slope.y;
      const across = e.ship.dir === 'h' ? slope.y : slope.x;
      m.rotation.set(0, 0, 0);
      m.rotateY(yaw);
      m.rotateZ(Math.atan(along) * 0.5 + s * 0.09 * Math.sign(e.roll || 1) + Math.sin(t * 0.9 + e.phase) * 0.008);
      m.rotateX(-Math.atan(across) * 0.6 + s * 0.13 * (e.roll > 0 ? 1 : -1) + Math.sin(t * 1.3 + e.phase) * 0.015);
      for (const sp of m.userData.spinners || []) sp.rotation.y += dt * 2.2;
      for (const f of m.userData.flags || []) {
        const pos = f.geometry.attributes.position;
        if (!f.userData.base) f.userData.base = pos.array.slice();
        const b = f.userData.base;
        for (let i = 0; i < pos.count; i++) {
          const x = b[i * 3];
          pos.array[i * 3 + 2] = Math.sin(t * 8 + x * 60 + e.phase) * 0.012 * (0.035 - x) * 20;
        }
        pos.needsUpdate = true;
      }
      for (const bcn of m.userData.beacons || []) bcn.visible = !e.sinking && (Math.sin(t * 3 + e.phase) > 0.6);
    }
    for (const g of this.markers) {
      const l = g.userData.local;
      g.position.set(l.x, waveHeight(cx + l.x, cz + l.z, t) * 0.8 + (g.userData.hit ? 0.02 : 0), l.z);
      g.rotation.z = Math.sin(t * 1.7 + g.userData.phase) * 0.12;
      g.rotation.x = Math.cos(t * 1.3 + g.userData.phase) * 0.12;
    }
    for (const b of this.buoys) {
      const l = b.userData.local;
      b.position.set(l.x, waveHeight(cx + l.x, cz + l.z, t) * 0.9, l.z);
      b.rotation.z = Math.sin(t * 1.4 + b.userData.phase) * 0.15;
    }
    this.lampM.emissiveIntensity = 1 + 3 * Math.max(0, Math.sin(t * 2.4));
  }
}

/** The aiming reticle: a spinning ring on the square plus a beam of light rising out of the glass. */
export class Reticle {
  constructor(scene) {
    const g = (this.group = new THREE.Group());
    const ringM = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.42, 48, 1, 0, Math.PI * 1.6), ringM);
    ring.rotation.x = -Math.PI / 2;
    const ring2 = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.24, 4), ringM);
    ring2.rotation.x = -Math.PI / 2;
    ring2.rotation.z = Math.PI / 4;
    const cross = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.03), ringM);
      bar.rotation.x = -Math.PI / 2;
      const a = (i * Math.PI) / 2;
      bar.position.set(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5);
      bar.rotation.z = a;
      cross.add(bar);
    }
    const beamM = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0xffd23f) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
        void main(){ float a = (1.0 - vUv.y) * (0.35 + 0.25 * sin(vUv.y * 30.0 - uTime * 8.0)); gl_FragColor = vec4(uColor * a, 1.0); }`,
    });
    this.beamM = beamM;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.38, 2.4, 24, 1, true), beamM);
    beam.position.y = 1.2;
    g.add(ring, ring2, cross, beam);
    this.ring = ring;
    this.cross = cross;
    this.ringM = ringM;
    g.visible = false;
    g.renderOrder = 9;
    scene.add(g);
    this.target = new THREE.Vector3();
  }

  show(p, ok = true) {
    const col = ok ? 0xffd23f : 0x8899aa;
    this.ringM.color.setHex(col);
    this.beamM.uniforms.uColor.value.setHex(ok ? 0xffb020 : 0x445566);
    if (!this.group.visible) this.group.position.copy(p);
    this.target.copy(p);
    this.group.visible = true;
  }

  hide() { this.group.visible = false; }

  update(dt, t) {
    if (!this.group.visible) return;
    this.group.position.lerp(this.target, 1 - Math.exp(-dt * 22));
    this.group.position.y = GRID_Y + 0.02;
    this.ring.rotation.z += dt * 2.5;
    const s = 1 + Math.sin(t * 6) * 0.06;
    this.cross.scale.setScalar(s);
    this.beamM.uniforms.uTime.value = t;
  }
}

export { ghostModel };
