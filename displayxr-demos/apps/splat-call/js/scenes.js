// Backgrounds ("scenes") around the caller. Each one is built to sell depth on a 3D display: a far
// layer well behind the caller, a mid layer, and foreground pieces (particles, clouds, sparks)
// that sit IN FRONT of the caller, so they come out of the glass while the caller rests on it.
//
// World space as everywhere in the app: metres, the caller's head centre at the origin, x right,
// y up, z toward the viewer. The default camera orbits the head at 0.9 m, so the frame at the head
// is about ±0.5 m by ±0.28 m; anything with z > ~0.1 is in front of the caller.
//
// Keep everything within ~16 m of the head: the sky sphere is 16 m, and on the Leia panel the
// runtime picks the eye frustums' far plane.
//
// Draw order matters: the splats draw with depth testing off at renderOrder 10, so background
// pieces keep the default order and FOREGROUND pieces use renderOrder 20 (fg()).
//
// The franchise-flavoured scenes are homages in look and mood only: no characters, logos, music
// or quotes from any show or film.

import * as THREE from 'three';

const FG = 20;
const rand = mulberry(7);
function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = (a, b) => a + (b - a) * rand();

let dotTex = null;
function dot() {
  if (dotTex) return dotTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  dotTex = new THREE.CanvasTexture(c);
  return dotTex;
}

const fg = (o) => {
  o.traverse((x) => { x.renderOrder = FG; });
  return o;
};
const at = (o, x = 0, y = 0, z = 0) => { o.position.set(x, y, z); return o; };
const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
const basic = (color, extra = {}) => new THREE.MeshBasicMaterial({ color, ...extra });
const glowMat = (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });

/** A big gradient sky sphere. `extra` is GLSL that may modify `c` from the direction `d`. */
function sky(top, bottom, extra = '', uniforms = {}) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(16, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uTop: { value: new THREE.Color(top) }, uBottom: { value: new THREE.Color(bottom) }, uTime: { value: 0 }, ...uniforms },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 uTop; uniform vec3 uBottom; uniform float uTime; varying vec3 vD;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
        void main(){ vec3 d = normalize(vD); vec3 c = mix(uBottom, uTop, smoothstep(-0.15, 0.6, d.y)); ${extra} gl_FragColor = vec4(c, 1.0); }`,
    }),
  );
  m.renderOrder = -10;
  return m;
}

/** Drifting points in a box. `step(p, v, dt)` moves one point; returns the THREE.Points. */
function particles({ n, min, max, color, size, opacity = 0.9, additive = true, vel = [0, 0, 0], jitter = 0, wrap = true, front = false }) {
  const pos = new Float32Array(n * 3), v = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      pos[i * 3 + k] = R(min[k], max[k]);
      v[i * 3 + k] = vel[k] * R(0.6, 1.4) + R(-jitter, jitter);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    color, size, map: dot(), transparent: true, opacity, depthWrite: false, sizeAttenuation: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  }));
  pts.frustumCulled = false;
  pts.userData.update = (dt) => {
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        let x = pos[i * 3 + k] + v[i * 3 + k] * dt;
        if (wrap) {
          const span = max[k] - min[k];
          if (x > max[k]) x -= span;
          else if (x < min[k]) x += span;
        }
        pos[i * 3 + k] = x;
      }
    }
    geo.attributes.position.needsUpdate = true;
  };
  if (front) fg(pts);
  return pts;
}

/** A soft glowing disc facing +z (or lying flat with flat = true). */
function glowDisc(radius, color, strength = 0.6, flat = false) {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 64),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uC: { value: new THREE.Color(color) }, uS: { value: strength } },
      vertexShader: 'varying vec2 vU; void main(){ vU = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 uC; uniform float uS; varying vec2 vU; void main(){ float d = length(vU - 0.5) * 2.0; gl_FragColor = vec4(uC * pow(1.0 - clamp(d,0.0,1.0), 2.0) * uS, 1.0); }',
    }),
  );
  if (flat) m.rotation.x = -Math.PI / 2;
  return m;
}

function updater(group, fn) {
  group.userData.tick = fn;
  return group;
}
const tickParticles = (g, dt) => g.traverse((o) => o.userData.update?.(dt));

// ------------------------------------------------------------------------------------------------

function studio() {
  const g = new THREE.Group();
  g.add(sky(0x0d1222, 0x04060b, 'c += vec3(0.10,0.05,0.22) * pow(max(0.0, d.z), 6.0) * 0.6;'));
  const pad = at(new THREE.Group(), 0, -0.36, 0);
  for (const [r0, r1, col, o] of [[0.26, 0.268, 0x5fd4ff, 0.8], [0.2, 0.203, 0x8a7dff, 0.5]]) {
    const m = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 96), glowMat(col, o));
    m.rotation.x = -Math.PI / 2;
    pad.add(m);
  }
  pad.add(glowDisc(0.3, 0x3388ff, 0.35, true));
  g.add(pad);
  g.add(particles({ n: 60, min: [-0.6, -0.35, -0.4], max: [0.6, 0.35, 0.45], color: 0x9fd8ff, size: 0.004, opacity: 0.6, vel: [0, 0.01, 0], jitter: 0.004, front: true }));
  return updater(g, (t, dt) => tickParticles(g, dt));
}

function hologramMessage() {
  // A dim starship hold; the caller is a small blue hologram standing in a projector's beam.
  const g = new THREE.Group();
  g.add(sky(0x070b14, 0x020305, 'c += vec3(0.02,0.05,0.10) * pow(max(0.0, 1.0 - abs(d.y)), 8.0);'));
  // Ribbed back wall with small indicator lights.
  const wall = new THREE.Group();
  for (let i = -9; i <= 9; i++) {
    const a = i * 0.13;
    const rib = at(new THREE.Mesh(new THREE.BoxGeometry(0.12, 3.2, 0.12), lambert(0x2a3038)), Math.sin(a) * 2.6, 0.2, -Math.cos(a) * 2.6);
    rib.rotation.y = -a;
    wall.add(rib);
    if (i % 3 === 0) wall.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8), glowMat(i % 2 ? 0xff5544 : 0x55ccff)), Math.sin(a) * 2.5, R(-0.4, 0.6), -Math.cos(a) * 2.5));
  }
  g.add(wall);
  const floor = at(new THREE.Mesh(new THREE.CircleGeometry(3, 48), lambert(0x15191f)), 0, -0.3, 0);
  floor.rotation.x = -Math.PI / 2;
  g.add(floor);
  for (let r = 0.4; r < 3; r += 0.4) {
    const ring = at(new THREE.Mesh(new THREE.RingGeometry(r, r + 0.006, 64), basic(0x2a3a4a)), 0, -0.299, 0);
    ring.rotation.x = -Math.PI / 2;
    g.add(ring);
  }
  // The projector and its beam.
  const proj = at(new THREE.Group(), 0, -0.3, 0);
  proj.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.07, 32), lambert(0x8a8f99)), 0, 0.035, 0));
  proj.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.012, 24), glowMat(0x88ccff)), 0, 0.075, 0));
  const beam = at(new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.025, 0.3, 48, 1, true),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
      vertexShader: 'varying vec2 vU; void main(){ vU = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform float uTime; varying vec2 vU; void main(){ float f = 0.75 + 0.25 * sin(uTime * 37.0); float a = (1.0 - vU.y) * 0.22 * f; gl_FragColor = vec4(vec3(0.3,0.65,1.0) * a, 1.0); }',
    }),
  ), 0, 0.23, 0);
  proj.add(beam);
  proj.add(glowDisc(0.16, 0x3399ff, 0.5, true));
  g.add(proj);
  g.add(particles({ n: 140, min: [-0.12, -0.28, -0.1], max: [0.12, 0.25, 0.1], color: 0x88ccff, size: 0.003, opacity: 0.8, vel: [0, 0.03, 0], jitter: 0.004 }));
  g.add(particles({ n: 50, min: [-0.5, -0.3, 0.05], max: [0.5, 0.3, 0.45], color: 0x6fa8ff, size: 0.003, opacity: 0.5, vel: [0, 0.005, 0], jitter: 0.004, front: true }));
  return updater(g, (t, dt) => {
    beam.material.uniforms.uTime.value = t;
    tickParticles(g, dt);
  });
}

function holodeck() {
  // A black room ruled with a glowing yellow grid.
  const g = new THREE.Group();
  const room = at(new THREE.Mesh(
    new THREE.BoxGeometry(6, 3.4, 6),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { uTime: { value: 0 } },
      vertexShader: 'varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform float uTime; varying vec3 vW;
        float line(float x){ float d = abs(fract(x / 0.5 + 0.5) - 0.5) * 0.5; return 1.0 - smoothstep(0.0, 0.012, d); }
        void main(){ vec3 n = abs(normalize(cross(dFdx(vW), dFdy(vW))));
          float l = n.x > 0.5 ? max(line(vW.y), line(vW.z)) : n.y > 0.5 ? max(line(vW.x), line(vW.z)) : max(line(vW.x), line(vW.y));
          vec3 c = vec3(0.01) + vec3(1.0, 0.78, 0.15) * l * (0.85 + 0.15 * sin(uTime * 2.0));
          gl_FragColor = vec4(c, 1.0); }`,
    }),
  ), 0, 0.5, -0.8);
  room.renderOrder = -10;
  g.add(room);
  // An arch where the door would be.
  const arch = at(new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.03, 8, 48, Math.PI), glowMat(0xffc840, 0.6)), 0.9, -0.6, -3.75);
  g.add(arch);
  g.add(particles({ n: 40, min: [-0.6, -0.3, -0.3], max: [0.6, 0.35, 0.45], color: 0xffd060, size: 0.003, opacity: 0.6, vel: [0, 0.01, 0], jitter: 0.006, front: true }));
  return updater(g, (t, dt) => {
    room.material.uniforms.uTime.value = t;
    tickParticles(g, dt);
  });
}

function warp() {
  // Stars stretched into streaks, rushing past the caller and out of the glass.
  const g = new THREE.Group();
  g.add(sky(0x050314, 0x000000, 'c += vec3(0.08,0.02,0.12) * pow(max(0.0, -d.z), 4.0);'));
  const n = 700;
  const pos = new Float32Array(n * 6), speed = new Float32Array(n);
  const reset = (i, z) => {
    let x, y;
    do { x = R(-2.5, 2.5); y = R(-1.6, 1.6); } while (Math.abs(x) < 0.32 && Math.abs(y) < 0.36);
    pos.set([x, y, z, x, y, z - 0.1], i * 6);
    speed[i] = R(2, 5);
  };
  for (let i = 0; i < n; i++) reset(i, R(-14, 0.6));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const lines = fg(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xbfd8ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })));
  lines.frustumCulled = false;
  g.add(lines);
  return updater(g, (t, dt) => {
    for (let i = 0; i < n; i++) {
      const z = pos[i * 6 + 2] + speed[i] * dt;
      if (z > 0.7) { reset(i, -14); continue; }
      pos[i * 6 + 2] = z;
      pos[i * 6 + 5] = z - 0.04 - speed[i] * 0.05;
    }
    geo.attributes.position.needsUpdate = true;
  });
}

function year3000() {
  // A cheerful retro-future skyline: domed towers, glass tubes and flying cars.
  const g = new THREE.Group();
  g.add(sky(0x63d0d6, 0xffc7a0));
  const ground = at(new THREE.Mesh(new THREE.PlaneGeometry(28, 28), lambert(0x6a7f9a)), 0, -1.3, 0);
  ground.rotation.x = -Math.PI / 2;
  g.add(ground);
  const cols = [0xf4a261, 0xe9c46a, 0x8ecae6, 0xb5838d, 0x90be6d, 0xcdb4db];
  for (let i = 0; i < 18; i++) {
    const x = R(-8, 8), z = R(-12, -3.5), h = R(1.5, 6), r = R(0.25, 0.7);
    const col = cols[i % cols.length];
    const tower = at(new THREE.Group(), x, -1.3, z);
    tower.add(at(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.8, r, h, 20), lambert(col)), 0, h / 2, 0));
    tower.add(at(new THREE.Mesh(new THREE.SphereGeometry(r * 1.15, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), lambert(0xdff6ff, { transparent: true, opacity: 0.8 })), 0, h, 0));
    if (i % 3 === 0) {
      const halo = at(new THREE.Mesh(new THREE.TorusGeometry(r * 1.4, 0.04, 8, 32), lambert(0xffffff)), 0, h * 0.7, 0);
      halo.rotation.x = Math.PI / 2;
      tower.add(halo);
    }
    g.add(tower);
  }
  // Glass transport tubes.
  for (let i = 0; i < 4; i++) {
    const pts = [new THREE.Vector3(-10, R(0, 2), R(-10, -4)), new THREE.Vector3(R(-3, 3), R(1, 3), R(-8, -3)), new THREE.Vector3(10, R(0, 2), R(-10, -4))];
    g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.12, 12), lambert(0xe0ffff, { transparent: true, opacity: 0.35 })));
  }
  // Flying cars on loops; one lane passes in front of the caller.
  const cars = [];
  const lanes = [[-6, 1.2, 0.8], [-4, 0.6, -1.1], [-2.2, 0.2, 1.4], [0.35, 0.2, -0.7]];
  lanes.forEach(([z, y, v], i) => {
    const car = new THREE.Group();
    car.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.14, 4, 12), lambert(cols[(i + 2) % cols.length])).rotateZ(Math.PI / 2));
    car.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), lambert(0xcff8ff, { transparent: true, opacity: 0.7 })), 0, 0.03, 0));
    car.add(at(glowDisc(0.07, 0xffaa55, 0.8), -0.12, 0, 0));
    const s = z > 0 ? 0.55 : 1 + Math.abs(z) * 0.35;
    car.scale.setScalar(s);
    car.userData = { z, y, v, x: R(-6, 6) };
    if (z > 0) fg(car);
    cars.push(car);
    g.add(car);
  });
  return updater(g, (t, dt) => {
    for (const c of cars) {
      const u = c.userData;
      u.x += u.v * dt;
      const lim = u.z > 0 ? 1.6 : 8;
      if (u.x > lim) u.x = -lim;
      if (u.x < -lim) u.x = lim;
      c.position.set(u.x, u.y + Math.sin(t * 1.3 + u.z) * 0.04, u.z);
      c.rotation.y = u.v > 0 ? 0 : Math.PI;
    }
  });
}

function cloud(scale = 1) {
  const c = new THREE.Group();
  const m = lambert(0xffffff);
  for (let i = 0; i < 6; i++) c.add(at(new THREE.Mesh(new THREE.SphereGeometry(R(0.25, 0.45) * scale, 16, 12), m), R(-0.6, 0.6) * scale, R(-0.1, 0.15) * scale, R(-0.15, 0.15) * scale));
  return c;
}

function sitcom() {
  // Big blue sky with puffy clouds (some drifting in front of the caller), a lawn and a house.
  const g = new THREE.Group();
  g.add(sky(0x2f7fe0, 0x9fd4ff));
  const lawn = at(new THREE.Mesh(new THREE.PlaneGeometry(28, 28), lambert(0x6cc04a)), 0, -1.0, 0);
  lawn.rotation.x = -Math.PI / 2;
  g.add(lawn);
  const house = at(new THREE.Group(), 2.6, -1.0, -6);
  house.add(at(new THREE.Mesh(new THREE.BoxGeometry(3, 1.6, 2), lambert(0xf2b8a2)), 0, 0.8, 0));
  const roof = at(new THREE.Mesh(new THREE.ConeGeometry(2.3, 1, 4), lambert(0x8a5a44)), 0, 2.1, 0);
  roof.rotation.y = Math.PI / 4;
  roof.scale.set(1, 1, 0.7);
  house.add(roof);
  house.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.05), lambert(0x6b3e26)), 0, 0.45, 1.01));
  for (const x of [-0.95, 0.95]) house.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.45, 0.05), lambert(0xbfe6ff)), x, 1.0, 1.01));
  g.add(house);
  for (let i = -14; i <= 14; i++) {
    g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.03), lambert(0xffffff)), i * 0.3, -0.75, -2.2));
  }
  g.add(at(new THREE.Mesh(new THREE.BoxGeometry(9, 0.05, 0.03), lambert(0xffffff)), 0, -0.6, -2.2));
  const clouds = [];
  for (let i = 0; i < 9; i++) {
    const front = i < 3;
    const c = cloud(front ? 0.18 : R(1.2, 2.2));
    const z = front ? R(0.15, 0.4) : R(-13, -7);
    c.userData = { x: front ? R(-0.7, 0.7) : R(-14, 14), y: front ? R(0.12, 0.3) : R(1, 5), z, v: front ? R(0.02, 0.05) : R(0.1, 0.3), lim: front ? 0.9 : 11 };
    if (front) fg(c);
    clouds.push(c);
    g.add(c);
  }
  return updater(g, (t, dt) => {
    for (const c of clouds) {
      const u = c.userData;
      u.x += u.v * dt;
      if (u.x > u.lim) u.x = -u.lim;
      c.position.set(u.x, u.y, u.z);
    }
  });
}

function palm(h) {
  const p = new THREE.Group();
  let y = 0, x = 0;
  for (let i = 0; i < 6; i++) {
    const seg = at(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.075, h / 6, 8), lambert(0x8b5a2b)), x, y + h / 12, 0);
    p.add(seg);
    y += h / 6;
    x += 0.03 * i;
  }
  for (let i = 0; i < 7; i++) {
    const leaf = at(new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.9, 4), lambert(0x3f8f3a, { flatShading: true })), x, y, 0);
    leaf.rotation.set(Math.PI / 2.4, (i / 7) * Math.PI * 2, 0, 'YXZ');
    leaf.translateY(0.4);
    p.add(leaf);
  }
  return p;
}

function stoneAge() {
  // Mesas, a smoking volcano, palm trees and boulders under a warm sky.
  const g = new THREE.Group();
  g.add(sky(0xff9a5c, 0xffd9a0));
  const ground = at(new THREE.Mesh(new THREE.PlaneGeometry(28, 28), lambert(0xc8935a)), 0, -1.0, 0);
  ground.rotation.x = -Math.PI / 2;
  g.add(ground);
  for (let i = 0; i < 7; i++) {
    const h = R(1.2, 3.5), r = R(0.8, 2);
    g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.75, r, h, 9), lambert(i % 2 ? 0xb0643a : 0x9a5530, { flatShading: true })), R(-10, 10), -1 + h / 2, R(-13, -6)));
  }
  const volcano = at(new THREE.Mesh(new THREE.ConeGeometry(3.2, 4, 12, 1, true), lambert(0x6b4a3a, { flatShading: true })), -4.5, 1, -12.5);
  g.add(volcano);
  g.add(at(glowDisc(1, 0xff5a1f, 0.9), -4.5, 3, -12.4));
  g.add(particles({ n: 60, min: [-5.5, 3, -13.5], max: [-3.5, 7, -11.5], color: 0x7a6a66, size: 0.9, opacity: 0.45, additive: false, vel: [0.15, 0.5, 0], jitter: 0.1 }));
  for (const [x, z, h] of [[-2.2, -3, 2.4], [2.6, -4, 2.8], [-0.9, -6, 2]]) g.add(at(palm(h), x, -1, z));
  // Boulders in the near corners, in front of the caller.
  for (const [x, y, z, s] of [[-0.55, -0.42, 0.25, 0.12], [0.6, -0.45, 0.3, 0.1], [0.42, -0.5, 0.42, 0.06]]) {
    const b = fg(at(new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), lambert(0x8d8478, { flatShading: true })), x, y, z));
    b.rotation.set(R(0, 3), R(0, 3), 0);
    g.add(b);
  }
  // Birds flapping across the sky.
  const birds = [];
  for (let i = 0; i < 5; i++) {
    const b = new THREE.Group();
    const wing = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, -0.5, 0.05, -0.15, -0.2, 0, 0.1]), 3));
    const l = new THREE.Mesh(wing, basic(0x3a2a2a, { side: THREE.DoubleSide }));
    const r = l.clone();
    r.scale.x = -1;
    b.add(l, r);
    b.userData = { l, r, x: R(-12, 12), y: R(2, 5), z: R(-12, -6), v: R(0.6, 1.2), ph: R(0, 6) };
    birds.push(b);
    g.add(b);
  }
  return updater(g, (t, dt) => {
    tickParticles(g, dt);
    for (const b of birds) {
      const u = b.userData;
      u.x += u.v * dt;
      if (u.x > 14) u.x = -14;
      b.position.set(u.x, u.y + Math.sin(t + u.ph) * 0.2, u.z);
      b.rotation.y = -Math.PI / 2;
      const f = Math.sin(t * 6 + u.ph) * 0.6;
      u.l.rotation.z = f;
      u.r.rotation.z = -f;
    }
  });
}

function portalLab() {
  // A dim garage lab with a swirling green portal behind the caller, spitting sparks forward.
  const g = new THREE.Group();
  g.add(sky(0x1d2420, 0x0b0e0c));
  const wall = at(new THREE.Mesh(new THREE.PlaneGeometry(10, 5), lambert(0x3a403b)), 0, 0.5, -2.6);
  g.add(wall);
  for (let i = 0; i < 10; i++) g.add(at(new THREE.Mesh(new THREE.BoxGeometry(R(0.2, 0.5), R(0.15, 0.4), 0.3), lambert([0x7a6a4a, 0x5a6a7a, 0x8a4a3a][i % 3])), R(-3.5, 3.5), R(-0.6, 1.6), -2.4));
  const floor = at(new THREE.Mesh(new THREE.PlaneGeometry(10, 6), lambert(0x2a2d2b)), 0, -0.9, -0.5);
  floor.rotation.x = -Math.PI / 2;
  g.add(floor);
  const portal = at(new THREE.Mesh(
    new THREE.CircleGeometry(0.85, 96),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: 'varying vec2 vU; void main(){ vU = uv - 0.5; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform float uTime; varying vec2 vU;
        void main(){ float r = length(vU) * 2.0; float a = atan(vU.y, vU.x);
          float s = sin(a * 5.0 + r * 14.0 - uTime * 4.0) * 0.5 + 0.5;
          float s2 = sin(a * 3.0 - r * 9.0 + uTime * 2.6) * 0.5 + 0.5;
          vec3 c = mix(vec3(0.05,0.35,0.05), vec3(0.55,1.0,0.3), s * 0.7 + s2 * 0.3);
          c = mix(c, vec3(0.9,1.0,0.6), smoothstep(0.86, 0.98, r));
          float alpha = smoothstep(1.0, 0.95, r) * (0.85 + 0.15 * s);
          gl_FragColor = vec4(c, alpha); }`,
    }),
  ), 0.15, 0.0, -1.3);
  g.add(portal);
  g.add(at(glowDisc(1.6, 0x55ff55, 0.35), 0.15, 0, -1.31));
  // Sparks spiralling out of the portal toward the viewer.
  const n = 220;
  const pos = new Float32Array(n * 3), life = new Float32Array(n), ang = new Float32Array(n);
  const spawn = (i) => { ang[i] = R(0, Math.PI * 2); life[i] = R(0, 1); };
  for (let i = 0; i < n; i++) spawn(i);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const sparks = fg(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x9dff6a, size: 0.012, map: dot(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
  sparks.frustumCulled = false;
  g.add(sparks);
  return updater(g, (t, dt) => {
    portal.material.uniforms.uTime.value = t;
    portal.rotation.z = t * 0.2;
    for (let i = 0; i < n; i++) {
      life[i] += dt * 0.35;
      if (life[i] > 1) { spawn(i); life[i] = 0; }
      const L = life[i], a = ang[i] + L * 4;
      const r = 0.8 * (1 - L * 0.4) + L * 0.6;
      pos[i * 3] = 0.15 + Math.cos(a) * r;
      pos[i * 3 + 1] = Math.sin(a) * r * 0.8;
      pos[i * 3 + 2] = -1.3 + L * 1.85;
    }
    geo.attributes.position.needsUpdate = true;
  });
}

function time1985() {
  // A neon night road: two fire trails racing away, lightning behind a clock tower, sparks.
  const g = new THREE.Group();
  g.add(sky(0x1a0533, 0x050008, 'c += vec3(0.9,0.2,0.5) * pow(max(0.0, 1.0 - abs(d.y + 0.02) * 6.0), 3.0) * 0.35;'));
  const road = at(new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.ShaderMaterial({
      vertexShader: 'varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 vW;
        void main(){ vec2 p = vW.xz; float gx = abs(fract(p.x * 1.0) - 0.5); float gz = abs(fract(p.y * 1.0) - 0.5);
          float l = max(1.0 - smoothstep(0.0, 0.03, 0.5 - gx), 1.0 - smoothstep(0.0, 0.03, 0.5 - gz));
          float fade = exp(-length(p) * 0.08);
          gl_FragColor = vec4(vec3(0.03,0.0,0.06) + vec3(1.0,0.2,0.75) * l * fade, 1.0); }`,
    }),
  ), 0, -0.7, -10);
  road.rotation.x = -Math.PI / 2;
  g.add(road);
  // Clock tower silhouette with a glowing face.
  const tower = at(new THREE.Group(), -2.5, -0.7, -14);
  tower.add(at(new THREE.Mesh(new THREE.BoxGeometry(1.4, 4, 1.4), basic(0x120818)), 0, 2, 0));
  const spire = at(new THREE.Mesh(new THREE.ConeGeometry(1.1, 1.4, 4), basic(0x120818)), 0, 4.7, 0);
  spire.rotation.y = Math.PI / 4;
  tower.add(spire);
  tower.add(at(new THREE.Mesh(new THREE.CircleGeometry(0.45, 32), basic(0xfff2c0)), 0, 3.2, 0.71));
  g.add(tower);
  // Fire trails.
  const fireMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 } },
    vertexShader: 'varying vec2 vU; void main(){ vU = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform float uTime; varying vec2 vU;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      void main(){ float n = hash(floor(vec2(vU.x * 40.0, vU.y * 6.0 - uTime * 12.0)));
        float h = (1.0 - vU.y) * (0.6 + 0.4 * n);
        vec3 c = mix(vec3(1.0,0.25,0.0), vec3(1.0,0.85,0.3), h);
        gl_FragColor = vec4(c * h * (0.4 + 0.6 * (1.0 - vU.x)), 1.0); }`,
  });
  for (const x of [-0.42, 0.42]) {
    const trail = at(new THREE.Mesh(new THREE.PlaneGeometry(0.06, 14), fireMat), x, -0.64, -6.5);
    trail.rotation.x = -Math.PI / 2;
    trail.rotation.y = Math.PI / 2;
    g.add(trail);
    const flame = at(new THREE.Mesh(new THREE.PlaneGeometry(14, 0.14), fireMat), x, -0.62, -6.5);
    flame.rotation.y = Math.PI / 2;
    g.add(flame);
  }
  // Lightning, now and then.
  const boltGeo = new THREE.BufferGeometry();
  const bolt = new THREE.Line(boltGeo, new THREE.LineBasicMaterial({ color: 0xcfe8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending }));
  g.add(bolt);
  let nextBolt = 2;
  g.add(particles({ n: 90, min: [-0.6, -0.6, -1.5], max: [0.6, 0.1, 0.5], color: 0xffa040, size: 0.006, opacity: 0.9, vel: [0, 0.05, 0.8], jitter: 0.08, front: true }));
  return updater(g, (t, dt) => {
    fireMat.uniforms.uTime.value = t;
    tickParticles(g, dt);
    if (t > nextBolt) {
      const pts = [];
      let x = R(-4, 1), y = 6;
      while (y > 0) { pts.push(x, y, -13); x += R(-0.4, 0.4); y -= R(0.3, 0.7); }
      boltGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
      bolt.material.opacity = 1;
      nextBolt = t + R(2.5, 6);
    }
    bolt.material.opacity = Math.max(0, bolt.material.opacity - dt * 3);
  });
}

function deepSpace() {
  // A nebula, a ringed planet, and asteroids tumbling past (some in front of the caller).
  const g = new THREE.Group();
  g.add(sky(0x0a0620, 0x02010a, `float n = sin(d.x * 7.0 + sin(d.y * 5.0)) * sin(d.y * 6.0 + d.z * 4.0);
    c += vec3(0.35,0.1,0.45) * smoothstep(0.2, 1.0, n) * 0.5 + vec3(0.05,0.2,0.4) * smoothstep(0.4, 1.0, -n) * 0.4;
    c += vec3(1.0) * step(0.9985, hash(floor(d.xy * 400.0) + floor(d.z * 400.0)));`));
  const planet = at(new THREE.Group(), -3.2, 1.2, -9);
  planet.add(new THREE.Mesh(new THREE.SphereGeometry(1.6, 48, 32), lambert(0xd9a066)));
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.1, 3, 96), lambert(0xe8d3a8, { side: THREE.DoubleSide, transparent: true, opacity: 0.7 }));
  ring.rotation.x = Math.PI / 2.4;
  planet.add(ring);
  g.add(planet);
  const rocks = [];
  for (let i = 0; i < 16; i++) {
    const front = i < 4;
    const s = front ? R(0.02, 0.05) : R(0.15, 0.5);
    const rock = at(new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), lambert(0x7d7368, { flatShading: true })), 0, 0, 0);
    rock.userData = { x: front ? R(-0.8, 0.8) : R(-8, 8), y: front ? R(-0.3, 0.3) : R(-3, 3), z: front ? R(0.18, 0.45) : R(-10, -3), v: front ? R(0.03, 0.08) : R(0.1, 0.3), lim: front ? 0.9 : 9, spin: R(0.2, 1) };
    if (front) fg(rock);
    rocks.push(rock);
    g.add(rock);
  }
  return updater(g, (t, dt) => {
    for (const r of rocks) {
      const u = r.userData;
      u.x += u.v * dt;
      if (u.x > u.lim) u.x = -u.lim;
      r.position.set(u.x, u.y, u.z);
      r.rotation.x += u.spin * dt;
      r.rotation.y += u.spin * 0.7 * dt;
    }
  });
}

/** id → { name, build } . Lights: every scene gets the app's hemisphere + key light. */
export const SCENES = {
  studio: { name: 'Studio', swatch: 'radial-gradient(circle at 50% 30%, #4a5a80, #121a2c)', build: studio },
  hologram: { name: 'Hologram hold', swatch: 'radial-gradient(circle at 50% 80%, #5fc8ff, #0a1830 60%)', build: hologramMessage },
  holodeck: { name: 'Holodeck grid', swatch: 'repeating-linear-gradient(90deg, #111 0 4px, #ffcc33 4px 5px)', build: holodeck },
  warp: { name: 'Warp speed', swatch: 'radial-gradient(circle, #ffffff, #5f7dff 30%, #05081f)', build: warp },
  year3000: { name: 'Year 3000 city', swatch: 'linear-gradient(#7ad0ff, #ff9ad5)', build: year3000 },
  sitcom: { name: 'Cartoon suburb', swatch: 'linear-gradient(#7cc8ff 55%, #5fbf4a 55%)', build: sitcom },
  stone: { name: 'Stone age', swatch: 'linear-gradient(#ffb36b, #a0703a)', build: stoneAge },
  portal: { name: 'Portal lab', swatch: 'radial-gradient(circle, #d8ff5a, #2f9b2a 60%, #0b3a10)', build: portalLab },
  time1985: { name: 'Neon 1985', swatch: 'linear-gradient(#ff3ec8 0 45%, #2a0a5a 45%)', build: time1985 },
  space: { name: 'Deep space', swatch: 'radial-gradient(circle at 30% 30%, #8a7dff, #05080f 70%)', build: deepSpace },
};
