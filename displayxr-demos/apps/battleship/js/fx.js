// Effects: pooled point-sprite particles (fire, smoke, sparks, spray), missiles, explosions,
// splashes, shockwaves, flying debris, floating 3D banners and camera shake. Upward is toward the
// viewer here, so anything that climbs (missile arcs, debris, banners) comes out of the glass.

import * as THREE from 'three';
import { rand, clamp, lerp } from './util.js';
import { waveHeight } from './ocean.js';

function spriteTexture(kind) {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const x = c.getContext('2d');
  if (kind === 'glow') {
    const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.18)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, s, s);
  } else {
    // smoke puff: overlapping soft blobs
    for (let i = 0; i < 26; i++) {
      const r = rand(12, 34), px = s / 2 + rand(-26, 26), py = s / 2 + rand(-26, 26);
      const g = x.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, 'rgba(255,255,255,0.32)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g;
      x.fillRect(0, 0, s, s);
    }
    // keep the edge clean
    x.globalCompositeOperation = 'destination-in';
    const m = x.createRadialGradient(s / 2, s / 2, s * 0.25, s / 2, s / 2, s / 2);
    m.addColorStop(0, 'rgba(0,0,0,1)');
    m.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = m;
    x.fillRect(0, 0, s, s);
  }
  const t = new THREE.CanvasTexture(c);
  return t;
}

class Pool {
  constructor(max, additive, texture) {
    this.max = max;
    this.n = 0; // high-water mark
    this.free = [];
    const g = (this.geo = new THREE.BufferGeometry());
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.c0 = new Float32Array(max * 4);
    this.c1 = new Float32Array(max * 4);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.alive = new Uint8Array(max);
    this.uniforms = { map: { value: texture }, uViewH: { value: 1000 } };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `
        attribute vec4 aColor; attribute float aSize;
        uniform float uViewH;
        varying vec4 vColor;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * projectionMatrix[1][1] * uViewH * 0.5 / max(-mv.z, 0.05);
          vColor = aColor;
        }`,
      fragmentShader: `
        uniform sampler2D map;
        varying vec4 vColor;
        void main() {
          float a = texture2D(map, gl_PointCoord).a * vColor.a;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vColor.rgb * ${additive ? 'a' : '1.0'}, ${additive ? '1.0' : 'a'});
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
  }

  spawn(p, v, life, s0, s1, c0, c1, drag = 0.5, grav = 0) {
    let i = this.free.pop();
    if (i === undefined) {
      if (this.n >= this.max) return;
      i = this.n++;
    }
    this.alive[i] = 1;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.life[i] = 0;
    this.maxLife[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.c0.set(c0, i * 4);
    this.c1.set(c1, i * 4);
    this.drag[i] = drag;
    this.grav[i] = grav;
  }

  update(dt) {
    const { pos, vel, col, size } = this;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const l = (this.life[i] += dt);
      const T = this.maxLife[i];
      if (l >= T) {
        this.alive[i] = 0;
        size[i] = 0;
        this.free.push(i);
        continue;
      }
      const k = l / T;
      const d = Math.exp(-this.drag[i] * dt);
      vel[i * 3] *= d; vel[i * 3 + 1] = vel[i * 3 + 1] * d - this.grav[i] * dt; vel[i * 3 + 2] *= d;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      size[i] = lerp(this.s0[i], this.s1[i], Math.sqrt(k));
      for (let j = 0; j < 4; j++) col[i * 4 + j] = lerp(this.c0[i * 4 + j], this.c1[i * 4 + j], k);
      // fade in quickly, fade out with life
      col[i * 4 + 3] *= Math.min(1, l * 12);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.setDrawRange(0, this.n);
  }
}

const V = new THREE.Vector3();
const V2 = new THREE.Vector3();

// colour presets (linear-ish rgba)
const FIRE0 = [1.0, 0.55, 0.18, 0.55], FIRE1 = [0.8, 0.1, 0.02, 0];
const HOT0 = [1, 0.8, 0.5, 0.75], HOT1 = [1, 0.32, 0.05, 0];
const BALL0 = [1, 0.5, 0.16, 0.42];
const SMOKE0 = [0.16, 0.14, 0.13, 0.75], SMOKE1 = [0.3, 0.28, 0.27, 0];
const SPRAY0 = [0.92, 0.96, 1.0, 0.9], SPRAY1 = [0.75, 0.85, 0.95, 0];
const SPARK0 = [1, 0.85, 0.5, 1], SPARK1 = [1, 0.3, 0.05, 0];

export class FX {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.time = 0;
    const glow = spriteTexture('glow');
    const puff = spriteTexture('puff');
    this.smoke = new Pool(5000, false, puff);
    this.spray = new Pool(3000, false, glow);
    this.add = new Pool(6000, true, glow);
    this.smoke.points.renderOrder = 5;
    this.spray.points.renderOrder = 6;
    this.add.points.renderOrder = 7;
    scene.add(this.smoke.points, this.spray.points, this.add.points);

    this.emitters = new Set();
    this.tasks = new Set(); // per-frame callbacks returning false when done
    this.shake = 0;

    // A flash light that every explosion borrows; always in the scene so shaders never recompile.
    this.flash = new THREE.PointLight(0xffa040, 0, 18, 1.6);
    scene.add(this.flash);

    // Rings: shockwaves (additive) and ripples (white)
    this.ringGeo = new THREE.RingGeometry(0.9, 1, 64);
    this.ringGeo.rotateX(-Math.PI / 2);

    this.debrisGeo = [new THREE.BoxGeometry(0.06, 0.03, 0.04), new THREE.TetrahedronGeometry(0.04), new THREE.BoxGeometry(0.1, 0.015, 0.03)];
    this.debrisMat = new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.5, roughness: 0.6, emissive: 0x501000, emissiveIntensity: 1 });
  }

  setViewHeight(h) {
    this.smoke.uniforms.uViewH.value = h;
    this.spray.uniforms.uViewH.value = h;
    this.add.uniforms.uViewH.value = h;
  }

  update(dt) {
    this.time += dt;
    for (const e of this.emitters) this.runEmitter(e, dt);
    for (const t of this.tasks) if (t(dt) === false) this.tasks.delete(t);
    this.smoke.update(dt);
    this.spray.update(dt);
    this.add.update(dt);
    this.flash.intensity *= Math.exp(-dt * 7);
    this.shake *= Math.exp(-dt * 4.5);
  }

  task(fn) { this.tasks.add(fn); }

  // -------------------------------------------------------------------------------------------
  // Burning hit markers and funnel smoke

  addEmitter(pos, kind = 'fire', scale = 1) {
    const e = { pos: pos.clone(), kind, scale, acc: Math.random(), on: true, obj: null };
    this.emitters.add(e);
    return e;
  }

  removeEmitter(e) { this.emitters.delete(e); }

  clearEmitters() { this.emitters.clear(); }

  runEmitter(e, dt) {
    if (!e.on) return;
    const p = e.obj ? e.obj.localToWorld(V2.copy(e.pos)) : V2.copy(e.pos);
    const s = e.scale;
    e.acc += dt;
    if (e.kind === 'fire') {
      while (e.acc > 0.045) {
        e.acc -= 0.045;
        V.set(rand(-0.08, 0.08) * s, rand(0.5, 0.9) * s, rand(-0.08, 0.08) * s);
        this.add.spawn(p.clone().add(new THREE.Vector3(rand(-0.08, 0.08) * s, 0, rand(-0.08, 0.08) * s)), V, rand(0.35, 0.7), 0.42 * s, 0.1 * s, FIRE0, FIRE1, 1.5, -0.4);
        if (Math.random() < 0.55) {
          V.set(rand(-0.06, 0.06) + 0.12, rand(0.45, 0.75) * s, rand(-0.06, 0.06) - 0.05);
          this.smoke.spawn(p.clone().add(new THREE.Vector3(0, 0.2 * s, 0)), V, rand(2.2, 3.4), 0.35 * s, 1.8 * s, SMOKE0, SMOKE1, 0.3, -0.05);
        }
      }
    } else if (e.kind === 'funnel') {
      while (e.acc > 0.18) {
        e.acc -= 0.18;
        V.set(rand(0.05, 0.12), rand(0.12, 0.22), rand(-0.03, 0.03));
        this.smoke.spawn(p, V, rand(2.5, 3.5), 0.05, 0.35, [0.35, 0.34, 0.34, 0.35], [0.5, 0.48, 0.47, 0], 0.2, -0.02);
      }
    } else if (e.kind === 'beacon') {
      // nothing: handled by meshes
    }
  }

  // -------------------------------------------------------------------------------------------
  // One-shot effects

  muzzle(p, dir) {
    for (let i = 0; i < 18; i++) {
      V.copy(dir).multiplyScalar(rand(1.5, 4)).add(new THREE.Vector3(rand(-0.4, 0.4), rand(-0.2, 0.5), rand(-0.4, 0.4)));
      this.add.spawn(p, V, rand(0.08, 0.2), 0.3, 0.05, HOT0, HOT1, 6);
    }
    for (let i = 0; i < 10; i++) {
      V.copy(dir).multiplyScalar(rand(0.4, 1.2)).add(new THREE.Vector3(rand(-0.2, 0.2), rand(0, 0.3), rand(-0.2, 0.2)));
      this.smoke.spawn(p, V, rand(1, 1.8), 0.15, 0.7, [0.55, 0.53, 0.5, 0.6], [0.6, 0.58, 0.56, 0], 1.8, -0.05);
    }
    this.flashAt(p, 6);
  }

  flashAt(p, power) {
    this.flash.position.copy(p).add(V.set(0, 0.6, 0));
    this.flash.intensity = Math.max(this.flash.intensity, power);
  }

  shockwave(p, radius = 2.4, color = 0xffb060, dur = 0.7) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(this.ringGeo, mat);
    ring.position.copy(p);
    ring.renderOrder = 8;
    this.scene.add(ring);
    let t = 0;
    this.task((dt) => {
      t += dt;
      const k = t / dur;
      const s = 0.1 + radius * (1 - Math.pow(1 - Math.min(k, 1), 3));
      ring.scale.set(s, 1, s);
      ring.position.y = p.y + 0.02;
      mat.opacity = 0.9 * (1 - k);
      if (k >= 1) { this.scene.remove(ring); mat.dispose(); return false; }
    });
  }

  ripple(p, radius = 1.2, dur = 1.6) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xe8f4ff, transparent: true, opacity: 0.6, depthWrite: false });
    const ring = new THREE.Mesh(this.ringGeo, mat);
    ring.renderOrder = 4;
    this.scene.add(ring);
    let t = 0;
    this.task((dt) => {
      t += dt;
      const k = t / dur;
      const s = 0.1 + radius * Math.sqrt(Math.min(k, 1));
      ring.scale.set(s, 1, s);
      ring.position.set(p.x, waveHeight(p.x, p.z, this.waveTime ?? 0) + 0.02, p.z);
      mat.opacity = 0.55 * (1 - k);
      if (k >= 1) { this.scene.remove(ring); mat.dispose(); return false; }
    });
  }

  splash(p, big = 1) {
    // Water column, then the mist and the ring.
    for (let i = 0; i < 110 * big; i++) {
      const a = rand(0, Math.PI * 2), r = rand(0, 0.18);
      V.set(Math.cos(a) * r * 3, rand(2.5, 6.5) * Math.sqrt(big), Math.sin(a) * r * 3);
      this.spray.spawn(p.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)), V, rand(0.9, 1.6), rand(0.12, 0.24), rand(0.3, 0.5), SPRAY0, SPRAY1, 0.6, 7.5);
    }
    for (let i = 0; i < 40 * big; i++) {
      const a = rand(0, Math.PI * 2);
      V.set(Math.cos(a) * rand(0.6, 1.6), rand(0.4, 1.4), Math.sin(a) * rand(0.6, 1.6));
      this.smoke.spawn(p, V, rand(1.2, 2.2), 0.4, 1.6, [0.85, 0.9, 0.95, 0.35], [0.9, 0.92, 0.95, 0], 1.6, 0.3);
    }
    this.ripple(p, 1.3 * big);
    setTimeout(() => this.ripple(p, 0.9 * big, 1.3), 260);
  }

  explosion(p, big = 1) {
    const s = big;
    // Fireball
    for (let i = 0; i < 55 * s; i++) {
      V.set(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).normalize().multiplyScalar(rand(1.2, 3.4) * s);
      V.y = Math.abs(V.y) + 0.6;
      this.add.spawn(p, V, rand(0.5, 1.0), rand(0.6, 0.9) * s, rand(1.7, 2.5) * s, BALL0, FIRE1, 3.2, -0.6);
    }
    for (let i = 0; i < 5; i++) this.add.spawn(p, V.set(0, 0.5, 0), 0.25, 3.2 * s, 0.8 * s, HOT0, HOT1, 1);
    // Sparks and embers: fast, falling, they fly out of the glass.
    for (let i = 0; i < 90 * s; i++) {
      V.set(rand(-1, 1), rand(0.4, 1.6), rand(-1, 1)).normalize().multiplyScalar(rand(4, 10) * Math.sqrt(s));
      this.add.spawn(p, V, rand(0.6, 1.5), rand(0.05, 0.1), 0.02, SPARK0, SPARK1, 0.9, 6);
    }
    // Black smoke column
    for (let i = 0; i < 45 * s; i++) {
      V.set(rand(-0.5, 0.5), rand(0.8, 2.6), rand(-0.5, 0.5)).multiplyScalar(s);
      this.smoke.spawn(p.clone().add(new THREE.Vector3(rand(-0.2, 0.2), rand(0, 0.3), rand(-0.2, 0.2))), V, rand(2.5, 4.5), rand(0.8, 1.2) * s, rand(3, 4.4) * s, [0.06, 0.055, 0.055, 0.95], [0.22, 0.2, 0.2, 0], 1.1, -0.15);
    }
    // Spray from the water around the hull
    for (let i = 0; i < 50 * s; i++) {
      const a = rand(0, Math.PI * 2);
      V.set(Math.cos(a) * rand(1, 2.4), rand(2, 4.5), Math.sin(a) * rand(1, 2.4));
      this.spray.spawn(p, V, rand(0.8, 1.3), 0.16, 0.4, SPRAY0, SPRAY1, 0.5, 7.5);
    }
    this.debris(p, Math.round(10 * s));
    this.shockwave(p, 2.6 * s);
    this.ripple(p, 2 * s, 2);
    this.flashAt(p, 40 * s);
    this.shake = Math.max(this.shake, 0.22 * s);
  }

  debris(p, n) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.debrisGeo[i % 3], this.debrisMat);
      m.position.copy(p);
      const v = new THREE.Vector3(rand(-1, 1), rand(1.2, 2.2), rand(-1, 1)).normalize().multiplyScalar(rand(3.5, 7.5));
      const spin = new THREE.Vector3(rand(-12, 12), rand(-12, 12), rand(-12, 12));
      this.scene.add(m);
      let t = 0;
      this.task((dt) => {
        t += dt;
        v.y -= 9.8 * dt;
        m.position.addScaledVector(v, dt);
        m.rotation.x += spin.x * dt; m.rotation.y += spin.y * dt; m.rotation.z += spin.z * dt;
        if (Math.random() < 0.5) this.smoke.spawn(m.position, V.set(0, 0.2, 0), 0.8, 0.06, 0.25, [0.12, 0.1, 0.1, 0.6], [0.3, 0.3, 0.3, 0], 1, 0);
        if (Math.random() < 0.6) this.add.spawn(m.position, V.set(0, 0, 0), 0.25, 0.1, 0.02, FIRE0, FIRE1, 1, 0);
        if (m.position.y < waveHeight(m.position.x, m.position.z, this.waveTime ?? 0) || t > 4) {
          for (let k = 0; k < 14; k++) this.spray.spawn(m.position, V.set(rand(-0.6, 0.6), rand(1, 2.4), rand(-0.6, 0.6)), 0.6, 0.05, 0.12, SPRAY0, SPRAY1, 0.5, 7);
          this.ripple(m.position.clone(), 0.4, 0.9);
          this.scene.remove(m);
          return false;
        }
      });
    }
  }

  fireworks(p) {
    const hue = Math.random();
    const c = new THREE.Color().setHSL(hue, 1, 0.6);
    const c2 = new THREE.Color().setHSL((hue + 0.12) % 1, 1, 0.55);
    for (let i = 0; i < 160; i++) {
      V.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(3, 4.5));
      const cc = i % 2 ? c : c2;
      this.add.spawn(p, V, rand(1.2, 2), 0.16, 0.04, [cc.r * 1.5, cc.g * 1.5, cc.b * 1.5, 1], [cc.r, cc.g * 0.6, cc.b, 0], 1.4, 1.6);
    }
    this.flashAt(p, 25);
  }

  // -------------------------------------------------------------------------------------------
  // Missile: a parabolic arc from `from` to `to`; resolves on impact.

  missile(from, to, { apex = 5, dur = 1.5, incoming = false } = {}) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.42, 10), new THREE.MeshStandardMaterial({ color: 0xdfe3e6, metalness: 0.4, roughness: 0.4 }));
    body.rotation.x = Math.PI / 2;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.12, 10), new THREE.MeshStandardMaterial({ color: incoming ? 0xd03a2a : 0x2f6fd0, metalness: 0.3, roughness: 0.4 }));
    nose.rotation.x = Math.PI / 2;
    nose.position.z = 0.27;
    g.add(body, nose);
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.09, 0.08), body.material);
      fin.position.z = -0.17;
      fin.rotation.z = (i * Math.PI) / 2;
      fin.position.x = Math.sin((i * Math.PI) / 2) * 0.045;
      fin.position.y = Math.cos((i * Math.PI) / 2) * 0.045;
      g.add(fin);
    }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.add.uniforms.map.value, color: 0xffb060, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.scale.setScalar(0.5);
    glow.position.z = -0.26;
    g.add(glow);
    g.scale.setScalar(1.35);
    this.scene.add(g);

    const ctrl = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    ctrl.y = Math.max(from.y, to.y) + apex * 2; // quadratic Bezier peaks at ~apex
    const P = (t, out) => {
      const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
      return out.set(a * from.x + b * ctrl.x + c * to.x, a * from.y + b * ctrl.y + c * to.y, a * from.z + b * ctrl.z + c * to.z);
    };
    const prev = new THREE.Vector3().copy(from);
    const cur = new THREE.Vector3();
    let t = 0;
    return new Promise((resolve) => {
      this.task((dt) => {
        t += dt / dur;
        // slow off the rail, fast at the end
        const k = clamp(incoming ? t * t * 0.25 + t * 0.75 : t * t * 0.45 + t * 0.55, 0, 1);
        P(k, cur);
        g.position.copy(cur);
        if (cur.distanceToSquared(prev) > 1e-8) g.lookAt(V.copy(cur).add(cur).sub(prev));
        // exhaust
        const tail = V2.set(0, 0, -0.38).applyQuaternion(g.quaternion).add(cur);
        for (let i = 0; i < 3; i++) {
          this.add.spawn(tail, V.set(rand(-0.3, 0.3), rand(-0.3, 0.3), rand(-0.3, 0.3)), rand(0.12, 0.25), 0.26, 0.05, HOT0, HOT1, 3);
        }
        this.smoke.spawn(tail, V.set(rand(-0.15, 0.15), rand(0, 0.2), rand(-0.15, 0.15)), rand(1.4, 2.2), 0.12, 0.6, [0.75, 0.73, 0.7, 0.5], [0.8, 0.78, 0.76, 0], 1.2, -0.02);
        prev.copy(cur);
        glow.material.rotation += dt * 20;
        if (t >= 1) {
          this.scene.remove(g);
          resolve();
          return false;
        }
      });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Floating 3D banner ("HIT!", "MISS", "SUNK"): rises out of the screen and fades.

  banner(text, p, { color = '#ff4a3d', sub = '', size = 1, dur = 2.2 } = {}) {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 384;
    const x = c.getContext('2d');
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.font = '900 190px "Black Ops One", Impact, "Arial Black", sans-serif';
    x.lineWidth = 18;
    x.strokeStyle = 'rgba(0,0,0,0.8)';
    x.strokeText(text, 512, sub ? 150 : 192);
    const grd = x.createLinearGradient(0, 60, 0, 280);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(0.45, color);
    grd.addColorStop(1, color);
    x.fillStyle = grd;
    x.fillText(text, 512, sub ? 150 : 192);
    if (sub) {
      x.font = '700 70px Rajdhani, "Segoe UI", sans-serif';
      x.lineWidth = 10;
      x.strokeText(sub, 512, 310);
      x.fillStyle = '#ffffff';
      x.fillText(sub, 512, 310);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    sp.renderOrder = 20;
    this.scene.add(sp);
    const start = p.clone();
    const toCam = new THREE.Vector3();
    let t = 0;
    this.task((dt) => {
      t += dt;
      const k = t / dur;
      // rise and drift toward the camera: it pops out of the glass
      toCam.copy(this.camera.getWorldPosition(V2)).sub(start).normalize();
      sp.position.copy(start).addScaledVector(toCam, 3.2 * size * Math.sqrt(Math.min(k * 1.6, 1))).add(V.set(0, 0.6, 0));
      const pop = k < 0.15 ? 0.6 + (k / 0.15) * 0.55 : 1.15 - Math.min(0.15, (k - 0.15) * 0.4);
      sp.scale.set(3.6 * size * pop, 1.35 * size * pop, 1);
      mat.opacity = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      if (k >= 1) { this.scene.remove(sp); tex.dispose(); mat.dispose(); return false; }
    });
  }
}
