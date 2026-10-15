// "DisplayXR HQ": an isometric voxel office where every demo is a room. Room plaques are
// links into the demos; little people wander between rooms and chat about what they're doing.
//
// Two ways to draw it. In any browser: a flat isometric view with HTML labels. In the DisplayXR
// Browser on a 3D display: the same office as a woven inline-3D scene (display rig, the diorama is
// the subject), with the labels as sprites at their real depth. Rules followed here are in
// DisplayXR/displayxr-web docs/woven-canvas-rules.md.

import * as THREE from 'three';
import { createInline3D, inline3DAvailable, ViewerEase, frameTrackingState } from '@displayxr/inline3d';
import { EyeCamera, DepthCursor, raycastHitTest } from '@displayxr/inline3d/three';
import { WINGS, LOBBY_CHATTER } from './demos.js';

const hero = document.getElementById('hq');
const canvas = document.getElementById('office');
const cover = document.getElementById('cover');
const labelLayer = document.getElementById('labels');
const feedList = document.getElementById('feed');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const params = new URLSearchParams(location.search);
// ?mono forces the flat view (headless checks, or a 2D monitor beside the panel).
const tryWoven = !params.has('mono') && inline3DAvailable();

let renderer;
try {
  // preserveDrawingBuffer: large woven scene canvases can race the weave's read on older
  // DisplayXR Browser builds (porting pitfall 26).
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: tryWoven });
} catch (err) {
  hero.classList.add('no-webgl');
  throw err;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// stage → depthRoot (squashes depth in 3D) → scene (the office, in office units).
// In the flat view both wrappers stay identity.
const stage = new THREE.Scene();
const depthRoot = new THREE.Group();
const scene = new THREE.Group();
stage.add(depthRoot);
depthRoot.add(scene);

// Sprites and the point cloud live on this layer: every camera draws it, the depth cursor's
// raycast skips it (a sprite needs a camera to be raycast, and a point cloud's hit radius is huge).
const LABEL_LAYER = 1;

// ---------- helpers ----------

const BOX = new THREE.BoxGeometry(1, 1, 1);
const mats = new Map();
const mat = (c) => {
  if (!mats.has(c)) mats.set(c, new THREE.MeshLambertMaterial({ color: c }));
  return mats.get(c);
};
const glow = (c, i = 1) => new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: i });

// A box whose bottom sits at y. Shared geometry, sized by scale.
function box(parent, w, h, d, c, x, y, z, { shadow = true } = {}) {
  const m = new THREE.Mesh(BOX, typeof c === 'string' ? mat(c) : c);
  m.scale.set(w, h, d);
  m.position.set(x, y + h / 2, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function sphere(parent, r, c, x, y, z, seg = 12) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1)), typeof c === 'string' ? mat(c) : c);
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

function checker(a, b, w, d) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 2;
  const g = cv.getContext('2d');
  g.fillStyle = a; g.fillRect(0, 0, 2, 2);
  g.fillStyle = b; g.fillRect(0, 0, 1, 1); g.fillRect(1, 1, 1, 1);
  const t = new THREE.CanvasTexture(cv);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(w / 2, d / 2);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function floor(x0, x1, z0, z1, a, b, y = 0.01) {
  const w = x1 - x0, d = z1 - z0;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshLambertMaterial({ map: checker(a, b, w, d) }));
  m.rotation.x = -Math.PI / 2;
  m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
  m.receiveShadow = true;
  scene.add(m);
  return m;
}

// Axis-aligned wall from a to b along x (axis 'x', at z = k) or along z (axis 'z', at x = k), with door gaps.
function wall(axis, k, a, b, h, c, gaps = [], t = 0.22) {
  const cuts = [...gaps].sort((p, q) => p[0] - q[0]);
  let s = a;
  for (const [g0, g1] of [...cuts, [b, b]]) {
    if (g0 > s + 0.01) {
      const len = g0 - s, mid = (s + g0) / 2;
      if (axis === 'x') box(scene, len, h, t, c, mid, 0, k);
      else box(scene, t, h, len, c, k, 0, mid);
    }
    s = Math.max(s, g1);
  }
}

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const shade = (hex, f) => '#' + new THREE.Color(hex).multiplyScalar(f).getHexString();

// ---------- layout ----------
// Building spans x -20..20, z -14..14. A cross-shaped hall (|z| < 2 and |x| < 2) splits it into four wings.

const X0 = -20, X1 = 20, Z0 = -14, Z1 = 14, HALL = 2;
const QUADS = [
  { x0: X0, x1: -HALL, z0: Z0, z1: -HALL, back: true },
  { x0: HALL, x1: X1, z0: Z0, z1: -HALL, back: true },
  { x0: X0, x1: -HALL, z0: HALL, z1: Z1, back: false },
  { x0: HALL, x1: X1, z0: HALL, z1: Z1, back: false },
];

const rooms = [];
WINGS.forEach((wing, wi) => {
  const q = QUADS[wi];
  const n = wing.demos.length, rw = (q.x1 - q.x0) / n;
  wing.demos.forEach((demo, i) => {
    const x0 = q.x0 + i * rw, x1 = x0 + rw;
    const cx = (x0 + x1) / 2;
    rooms.push({
      demo, wing, back: q.back, x0, x1, z0: q.z0, z1: q.z1, cx, cz: (q.z0 + q.z1) / 2,
      // props sit in the strip furthest from the hall door, people walk in the rest
      propZ: q.back ? q.z0 + 2.4 : q.z1 - 2.4,
      walk: q.back ? [q.z0 + 5, q.z1 - 0.9] : [q.z0 + 0.9, q.z1 - 5],
      doorIn: new THREE.Vector3(cx, 0, q.back ? q.z1 - 0.9 : q.z0 + 0.9),
      doorOut: new THREE.Vector3(cx, 0, q.back ? -1 : 1),
      plaque: new THREE.Vector3(cx, q.back ? 1.65 : 1.05, q.back ? q.z0 + 0.15 : q.z0),
    });
  });
});

// ---------- the building ----------

box(scene, X1 - X0 + 0.8, 0.5, Z1 - Z0 + 0.8, '#3d3a44', 0, -0.5, 0, { shadow: false });
WINGS.forEach((w, i) => floor(QUADS[i].x0, QUADS[i].x1, QUADS[i].z0, QUADS[i].z1, w.floor[0], w.floor[1]));
floor(X0, X1, -HALL, HALL, '#5b5966', '#524f5c', 0.012);
floor(-HALL, HALL, Z0, -HALL, '#5b5966', '#524f5c', 0.012);
floor(-HALL, HALL, HALL, Z1, '#5b5966', '#524f5c', 0.012);

const OUTER = '#d8d2c4', INNER = '#8d8796';
wall('x', Z0, X0, X1, 2.6, OUTER, [], 0.35);
wall('z', X0, Z0, Z1, 2.6, OUTER, [], 0.35);
wall('x', Z1, X0, X1, 0.35, OUTER, [[-HALL, HALL]], 0.35);
wall('z', X1, Z0, Z1, 0.35, OUTER, [[-HALL, HALL]], 0.35);
for (const q of QUADS) {
  const qr = rooms.filter((r) => r.x0 >= q.x0 && r.x1 <= q.x1 && r.back === q.back);
  const doors = qr.map((r) => [r.cx - 1.1, r.cx + 1.1]);
  wall('x', q.back ? q.z1 : q.z0, q.x0, q.x1, 0.9, INNER, doors);
  wall('z', q.x0 < 0 ? q.x1 : q.x0, q.z0, q.z1, 0.9, INNER);
  qr.slice(1).forEach((r) => wall('z', r.x0, q.z0, q.z1, 0.9, INNER));
}

// Wall trim: a coloured stripe per wing along the tall back walls.
WINGS.forEach((w, i) => {
  const q = QUADS[i];
  if (q.back) box(scene, q.x1 - q.x0, 0.12, 0.05, glow(w.accent, 0.35), (q.x0 + q.x1) / 2, 2.2, Z0 + 0.2, { shadow: false });
});

// ---------- furniture shared by all rooms ----------

const flickers = [];
function desk(x, z, accent, rot = 0) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = rot;
  box(g, 1.5, 0.08, 0.8, '#b07a4a', 0, 0.62, 0);
  box(g, 0.08, 0.62, 0.7, '#7a5232', -0.68, 0, 0);
  box(g, 0.08, 0.62, 0.7, '#7a5232', 0.68, 0, 0);
  box(g, 0.6, 0.04, 0.3, '#222', 0, 0.7, -0.15);
  box(g, 0.06, 0.25, 0.06, '#222', 0, 0.7, -0.22);
  const screen = glow(accent, 0.6);
  box(g, 0.8, 0.5, 0.06, '#1c1c22', 0, 0.92, -0.25);
  box(g, 0.7, 0.4, 0.02, screen, 0, 0.97, -0.21, { shadow: false });
  box(g, 0.5, 0.06, 0.5, '#33333d', 0, 0.42, 0.65);
  box(g, 0.5, 0.45, 0.08, '#33333d', 0, 0.45, 0.88);
  box(g, 0.08, 0.42, 0.08, '#555', 0, 0, 0.65);
  scene.add(g);
  flickers.push({ m: screen, o: Math.random() * 10 });
}

function plant(x, z, s = 1) {
  box(scene, 0.45 * s, 0.4 * s, 0.45 * s, '#a0522d', x, 0, z);
  box(scene, 0.6 * s, 0.45 * s, 0.6 * s, '#4f9d4a', x, 0.4 * s, z);
  box(scene, 0.4 * s, 0.35 * s, 0.4 * s, '#67b85c', x, 0.85 * s, z);
}

// ---------- one set piece per demo ----------

const animators = [];
const BUILD = {
  'energy-grid'(g, r) {
    box(g, 5, 0.7, 2.4, '#3b3f46', -0.6, 0, 0);
    box(g, 4.8, 0.04, 2.2, '#1f4030', -0.6, 0.7, 0);
    const lineMat = glow('#ffd34d', 0.8);
    const towers = [[-2.6, 0.7], [-1.6, -0.2], [-0.5, 0.5], [0.6, -0.4], [1.4, 0.4]];
    towers.forEach(([x, z]) => {
      box(g, 0.1, 0.7, 0.1, '#cfd6de', x, 0.74, z);
      box(g, 0.45, 0.05, 0.07, '#cfd6de', x, 1.32, z);
    });
    for (let i = 1; i < towers.length; i++) {
      const [ax, az] = towers[i - 1], [bx, bz] = towers[i];
      const len = Math.hypot(bx - ax, bz - az);
      const m = box(g, len, 0.04, 0.04, lineMat, (ax + bx) / 2, 1.38, (az + bz) / 2, { shadow: false });
      m.rotation.y = -Math.atan2(bz - az, bx - ax);
    }
    box(g, 0.9, 0.35, 0.6, '#7d8792', -2.3, 0.74, -0.6);
    const leds = [];
    [0, 1].forEach((i) => {
      box(g, 1.3, 0.95, 0.75, '#e9ecef', 3, 0, -0.7 + i * 1.05);
      const led = glow('#44ff88', 1);
      box(g, 0.12, 0.12, 0.04, led, 2.6, 0.7, -0.31 + i * 1.05, { shadow: false });
      leds.push(led);
    });
    const breaker = glow('#ff4040', 1);
    box(g, 0.2, 0.2, 0.2, breaker, -2.3, 1.09, -0.6, { shadow: false });
    animators.push((t) => {
      const storm = (t % 9) < 1.4;
      lineMat.emissiveIntensity = storm ? (Math.sin(t * 40) > 0 ? 1.6 : 0.1) : 0.7 + 0.4 * Math.sin(t * 3);
      breaker.emissiveIntensity = storm ? 1.5 : 0.15;
      leds.forEach((m, i) => (m.emissiveIntensity = Math.sin(t * 2 + i * 1.7) > 0 ? 1.2 : 0.2));
    });
  },
  aviation(g) {
    box(g, 0.25, 0.75, 0.25, '#555', -0.8, 0, 0);
    box(g, 0.25, 0.75, 0.25, '#555', 0.8, 0, 0);
    const plane = new THREE.Group();
    plane.position.y = 0.75;
    g.add(plane);
    box(plane, 3.2, 0.6, 0.7, '#eef1f5', 0, 0, 0);
    box(plane, 0.6, 0.06, 4.2, '#dfe4ea', 0.3, 0.42, 0);
    box(plane, 0.55, 0.75, 0.08, '#c63b3b', -1.45, 0.55, 0);
    box(plane, 0.5, 0.06, 1.5, '#dfe4ea', -1.45, 0.4, 0);
    box(plane, 0.6, 0.3, 0.72, '#7fb2e5', 0.75, 0.45, 0);
    box(plane, 0.35, 0.5, 0.55, '#8a9099', 1.7, 0.05, 0);
    const prop = new THREE.Group();
    prop.position.set(1.92, 0.3, 0);
    plane.add(prop);
    box(prop, 0.05, 1.5, 0.14, '#2a2a2a', 0, -0.75, 0);
    box(prop, 0.12, 0.16, 0.16, '#c63b3b', 0, -0.08, 0);
    box(g, 0.8, 0.8, 0.5, '#c0392b', 3, 0, 0.6);
    box(g, 0.6, 0.06, 0.3, '#888', 3, 0.8, 0.6);
    animators.push((t) => {
      prop.rotation.x = t * 14;
      plane.rotation.z = Math.sin(t * 0.8) * 0.02;
    });
  },
  'mission-planner'(g) {
    // A planning sand table: hills, a river, a route, a hostile marker, and an ISR drone overhead.
    box(g, 3.6, 0.72, 2.2, '#3b3f46', 0, 0, 0);
    box(g, 3.4, 0.05, 2.0, '#4d6b3a', 0, 0.72, 0);
    [[-1.1, -0.5, 0.35, '#6f8a4a'], [-0.7, -0.6, 0.22, '#7c8f55'], [0.9, 0.5, 0.28, '#8a8a5a'], [1.2, -0.55, 0.42, '#6a7f45'], [1.35, -0.35, 0.25, '#7c8f55']].forEach(([x, z, h, c]) => box(g, 0.6, h, 0.55, c, x, 0.76, z));
    box(g, 0.14, 0.02, 2.0, glow('#3a7fb8', 0.4), -0.15, 0.77, 0, { shadow: false }).rotation.y = 0.25;
    for (let i = 0; i < 6; i++) box(g, 0.16, 0.06, 0.12, '#d8cbb0', 0.45 + (i % 3) * 0.2, 0.77, -0.15 + Math.floor(i / 3) * 0.2);
    const route = glow('#4fd8ff', 0.9);
    [[-1.4, 0.8, -0.5, 0.35], [-0.5, 0.35, 0.3, -0.3], [0.3, -0.3, 0.6, -0.05]].forEach(([ax, az, bx, bz]) => {
      const len = Math.hypot(bx - ax, bz - az);
      const m = box(g, len, 0.03, 0.05, route, (ax + bx) / 2, 0.8, (az + bz) / 2, { shadow: false });
      m.rotation.y = -Math.atan2(bz - az, bx - ax);
    });
    const marker = box(g, 0.22, 0.22, 0.22, glow('#ff5c5c', 0.9), 0.55, 1.25, 0, { shadow: false });
    marker.rotation.set(0, Math.PI / 4, Math.PI / 4);
    const drone = new THREE.Group();
    g.add(drone);
    box(drone, 0.5, 0.08, 0.14, '#cfd6de', 0, 0, 0);
    box(drone, 0.12, 0.05, 0.9, '#cfd6de', 0.05, 0.02, 0);
    box(drone, 0.1, 0.18, 0.3, '#cfd6de', -0.22, 0.05, 0);
    const eye = box(drone, 0.07, 0.07, 0.07, glow('#ffffff', 1), 0.16, -0.08, 0, { shadow: false });
    animators.push((t) => {
      const a = t * 0.5;
      drone.position.set(0.55 + Math.cos(a) * 1.2, 2.3, Math.sin(a) * 0.8);
      drone.rotation.y = -a - Math.PI / 2;
      marker.position.y = 1.2 + Math.sin(t * 2) * 0.08;
      marker.rotation.y = t;
      route.emissiveIntensity = 0.6 + 0.4 * Math.sin(t * 3);
      eye.material.emissiveIntensity = Math.sin(t * 6) > 0 ? 1.4 : 0.3;
    });
  },
  'flight-lines'(g) {
    // A glowing globe on a plinth with little airliners circling it on tilted flight rings.
    box(g, 1.2, 0.8, 1.2, '#2a3340', 0, 0, 0);
    const globe = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.62, 2),
      new THREE.MeshLambertMaterial({ color: '#1d4f8a', emissive: '#0d2f66', emissiveIntensity: 0.8, flatShading: true }),
    );
    globe.position.y = 1.55;
    globe.castShadow = true;
    g.add(globe);
    [[0.25, 0.2], [-0.3, -0.35], [0.1, 0.5], [-0.6, 1.4]].forEach(([a, b]) => {
      const land = box(globe, 0.34, 0.1, 0.28, '#5fbf7a', 0, 0, 0, { shadow: false });
      land.position.setFromSphericalCoords(0.6, 1.3 + a, b * 6);
      land.lookAt(0, 0, 0);
    });
    const planes = [[0.5, 0, '#ff7ab8'], [-0.4, 1.1, '#5fb4ff'], [0.15, 2.2, '#ffd34d']].map(([tilt, yaw, color]) => {
      const ring = new THREE.Group();
      ring.position.y = 1.55;
      ring.rotation.set(tilt, yaw, 0);
      g.add(ring);
      const arc = new THREE.Mesh(new THREE.TorusGeometry(0.88, 0.012, 6, 64), glow(color, 0.9));
      arc.rotation.x = Math.PI / 2;
      ring.add(arc);
      const plane = new THREE.Group();
      ring.add(plane);
      box(plane, 0.07, 0.07, 0.3, '#eef1f5', 0, -0.035, -0.15, { shadow: false });
      box(plane, 0.36, 0.02, 0.08, '#eef1f5', 0, -0.01, -0.12, { shadow: false });
      box(plane, 0.02, 0.09, 0.06, color, 0, 0.02, -0.27, { shadow: false });
      return plane;
    });
    animators.push((t) => {
      globe.rotation.y = t * 0.25;
      planes.forEach((p, i) => {
        const a = t * (0.6 + i * 0.15) + i * 2;
        p.position.set(Math.cos(a) * 0.88, 0, -Math.sin(a) * 0.88);
        p.rotation.y = a + Math.PI;   // the nose is local +z; point it along the direction of travel
      });
    });
  },
  'dual-view'(g) {
    // A 3D display on a stand sending two coloured beams to two viewers: one picture each.
    box(g, 0.5, 0.9, 0.4, '#2a3340', 0, 0, -0.4);
    box(g, 2.2, 1.3, 0.12, '#14171f', 0, 0.9, -0.4);
    const halfA = box(g, 1.0, 1.1, 0.02, glow('#5fb4ff', 0.9), -0.52, 1.0, -0.33, { shadow: false });
    const halfB = box(g, 1.0, 1.1, 0.02, glow('#ff9a3d', 0.9), 0.52, 1.0, -0.33, { shadow: false });
    const viewers = [[-1.3, '#5fb4ff'], [1.3, '#ff9a3d']].map(([x, color]) => {
      const v = new THREE.Group();
      v.position.set(x, 0, 1.4);
      g.add(v);
      box(v, 0.4, 0.75, 0.28, color, 0, 0, 0);
      sphere(v, 0.2, '#f1c9a5', 0, 0.98, 0, 12);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.32, 1, 10, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide }));
      g.add(beam);
      // From the screen centre to the viewer's head.
      const from = new THREE.Vector3(0, 1.0, -0.3), to = new THREE.Vector3(x, 0.98, 1.4);
      beam.position.copy(from).add(to).multiplyScalar(0.5);
      beam.scale.y = from.distanceTo(to);
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), to.clone().sub(from).normalize());
      return { v, beam };
    });
    animators.push((t) => {
      halfA.material.emissiveIntensity = 0.7 + Math.sin(t * 2.2) * 0.25;
      halfB.material.emissiveIntensity = 0.7 + Math.sin(t * 2.2 + Math.PI) * 0.25;
      viewers.forEach(({ v, beam }, i) => {
        beam.material.opacity = 0.18 + Math.abs(Math.sin(t * 1.6 + i * 1.3)) * 0.2;
        v.rotation.y = Math.sin(t * 0.7 + i * 2) * 0.25;
      });
    });
  },
  muse(g, r) {
    box(g, 1.3, 0.8, 1.3, '#2a2238', 0, 0, 0);
    const holo = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.7, 0),
      new THREE.MeshLambertMaterial({ color: '#c08bff', emissive: '#7a3dff', emissiveIntensity: 0.7, flatShading: true, transparent: true, opacity: 0.9 }),
    );
    holo.castShadow = true;
    g.add(holo);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.04, 6, 32), glow('#e3c8ff', 0.9));
    ring.rotation.x = Math.PI / 2;
    g.add(ring);
    box(g, 0.06, 1.4, 0.06, '#333', 2.2, 0, 0.4);
    sphere(g, 0.13, '#222', 2.2, 1.45, 0.4);
    const bars = [];
    for (let i = 0; i < 7; i++) bars.push(box(g, 0.14, 0.5, 0.08, glow('#c08bff', 0.9), -2.6 + i * 0.22, 0.6, -1.2, { shadow: false }));
    box(g, 1.9, 1.5, 0.08, '#1a1424', -1.94, 0.3, -1.3);
    animators.push((t) => {
      holo.position.y = 1.75 + Math.sin(t * 1.5) * 0.15;
      holo.rotation.y = t * 0.8;
      holo.rotation.x = t * 0.4;
      ring.position.y = holo.position.y;
      ring.scale.setScalar(1 + Math.sin(t * 3) * 0.08);
      bars.forEach((b, i) => {
        b.scale.y = 0.15 + Math.abs(Math.sin(t * 6 + i * 0.9)) * 0.7;
        b.position.y = 0.95 - b.scale.y / 2 + 0.3;
      });
    });
  },
  dot(g) {
    box(g, 1.1, 0.7, 1.1, '#20303a', 0, 0, 0);
    const orb = sphere(g, 0.5, glow('#4fd8ff', 0.8), 0, 1.6, 0, 20);
    const dots = [];
    const colors = ['#ff6b6b', '#ffd34d', '#6fe0a4', '#ff7ab8', '#ffffff'];
    for (let i = 0; i < 12; i++) {
      dots.push({ m: sphere(g, 0.09, glow(colors[i % colors.length], 0.9), 0, 0, 0, 8), r: 0.9 + (i % 3) * 0.25, s: 0.6 + Math.random(), tilt: Math.random() * Math.PI, o: Math.random() * 6.28 });
    }
    animators.push((t) => {
      orb.scale.setScalar(1 + Math.sin(t * 2.4) * 0.06);
      dots.forEach((d) => {
        const a = t * d.s + d.o;
        d.m.position.set(Math.cos(a) * d.r, 1.6 + Math.sin(a) * d.r * Math.sin(d.tilt) * 0.6, Math.sin(a) * d.r * Math.cos(d.tilt));
      });
    });
  },
  'sugar-rush'(g) {
    const steps = [[-2.4, 0.3], [-0.9, 0.8], [0.6, 1.3], [2.1, 0.7]];
    steps.forEach(([x, h], i) => {
      box(g, 0.25, h, 0.25, '#ffffff', x, 0, 0);
      box(g, 1.2, 0.3, 1.1, i % 2 ? '#ffb3d9' : '#9be7ff', x, h, 0);
      box(g, 1.22, 0.08, 1.12, '#ffffff', x, h + 0.3, 0);
    });
    [[-3.3, 0.6, '#ff5c8a'], [3.2, -0.5, '#ffb84d']].forEach(([x, z, c]) => {
      box(g, 0.08, 1.4, 0.08, '#fff', x, 0, z);
      const pop = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.1, 16), mat(c));
      pop.rotation.x = Math.PI / 2;
      pop.position.set(x, 1.6, z);
      pop.castShadow = true;
      g.add(pop);
    });
    const gummy = box(g, 0.35, 0.4, 0.3, glow('#ff3b3b', 0.3), 0, 0, 0);
    animators.push((t) => {
      const seg = (t * 0.9) % steps.length, i = Math.floor(seg), f = seg - i;
      const [ax, ah] = steps[i], [bx, bh] = steps[(i + 1) % steps.length];
      const top = (h) => h + 0.38;
      gummy.position.x = ax + (bx - ax) * f;
      gummy.position.y = top(ah) + (top(bh) - top(ah)) * f + Math.sin(f * Math.PI) * 1.1 + 0.2;
      gummy.rotation.y = t * 2;
    });
  },
  battleship(g) {
    // a war-room plotting table: two grids, two ships, a shell arcing across and a hit
    box(g, 4.4, 0.6, 2.4, '#2b3440', 0, 0, 0);
    box(g, 4.2, 0.06, 2.2, glow('#1d5f93', 0.35), 0, 0.6, 0, { shadow: false });
    for (let i = 0; i <= 4; i++) {
      box(g, 0.025, 0.02, 2.0, glow('#45c4ff', 0.9), -1.95 + i * 0.45, 0.66, 0, { shadow: false });
      box(g, 0.025, 0.02, 2.0, glow('#ff7a4a', 0.9), 0.15 + i * 0.45, 0.66, 0, { shadow: false });
      box(g, 1.8, 0.02, 0.025, glow('#45c4ff', 0.9), -1.05, 0.66, -1 + i * 0.5, { shadow: false });
      box(g, 1.8, 0.02, 0.025, glow('#ff7a4a', 0.9), 1.05, 0.66, -1 + i * 0.5, { shadow: false });
    }
    box(g, 1.2, 0.16, 0.26, '#8a96a3', -1.2, 0.66, -0.45);
    box(g, 0.3, 0.26, 0.18, '#cfd6de', -1.1, 0.82, -0.45);
    box(g, 0.08, 0.3, 0.08, '#4d5763', -1.35, 0.82, -0.45);
    const target = box(g, 0.9, 0.14, 0.24, '#7d776f', 1.3, 0.66, 0.45);
    const shell = sphere(g, 0.11, glow('#ffb03a', 1.2), 0, 0, 0, 10);
    const boom = sphere(g, 0.35, glow('#ff5a2a', 1.4), 1.3, 0.85, 0.45, 12);
    animators.push((t) => {
      const k = (t * 0.45) % 1;
      const f = Math.min(k / 0.65, 1);
      shell.visible = k < 0.65;
      shell.position.set(-1.2 + 2.5 * f, 0.95 + Math.sin(f * Math.PI) * 1.7, -0.45 + 0.9 * f);
      const b = k >= 0.65 ? (k - 0.65) / 0.35 : 0;
      boom.visible = b > 0;
      boom.scale.setScalar(0.4 + b * 1.4);
      boom.position.y = 0.85 + b * 0.5;
      target.rotation.z = b > 0 ? Math.sin(b * 30) * 0.06 * (1 - b) : 0;
    });
  },
  playground(g) {
    box(g, 2.6, 0.5, 2.2, '#3e7cc9', -1.6, 0, 0);
    const cols = ['#ff5c5c', '#ffd34d', '#4fd8ff', '#6fe0a4', '#ff7ab8'];
    for (let i = 0; i < 26; i++) sphere(g, 0.17, cols[i % cols.length], -1.6 + rand(-1.05, 1.05), 0.55, rand(-0.85, 0.85), 8);
    box(g, 0.9, 1.6, 0.9, '#f2b134', 1.5, 0, -0.4);
    const slide = box(g, 0.7, 0.1, 2.2, '#e74c3c', 1.5, 0.8, 0.9);
    slide.rotation.x = 0.62;
    for (let i = 0; i < 4; i++) box(g, 0.7, 0.06, 0.1, '#888', 1.5, 0.3 + i * 0.38, -0.95);
    const ball = sphere(g, 0.3, '#ff7ab8', 3.2, 0.3, 0.2, 16);
    animators.push((t) => {
      ball.position.y = 0.3 + Math.abs(Math.sin(t * 2.6)) * 1.4;
      ball.scale.y = ball.position.y < 0.4 ? 0.8 : 1;
    });
  },
  'solar-system'(g) {
    // An orrery on a dark table: a glowing Sun with planets circling at their own speeds.
    box(g, 4.2, 0.7, 2.6, '#1c2233', 0, 0, 0);
    box(g, 4.0, 0.04, 2.4, '#0b1020', 0, 0.7, 0);
    const sun = sphere(g, 0.32, glow('#ffb547', 1.4), 0, 1.25, 0, 20);
    box(g, 0.06, 0.5, 0.06, '#8a93a8', 0, 0.74, 0);
    const planets = [
      [0.55, 0.06, '#a8a39c', 4.1], [0.75, 0.09, '#e8c58a', 1.6], [0.98, 0.1, '#5b9bff', 1], [1.2, 0.08, '#e0663f', 0.53],
      [1.5, 0.2, '#d8b48a', 0.25], [1.8, 0.17, '#e8d29c', 0.12],
    ].map(([r, s, c, w], i) => ({ m: sphere(g, s, c, 0, 1.25, 0, 14), r, w: w * 0.9, o: i * 1.3 }));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.025, 6, 32), mat('#d9c58f'));
    ring.rotation.x = Math.PI / 2.4;
    planets[5].m.add(ring);
    const moon = sphere(g, 0.035, '#d0d0d0', 0, 0, 0, 8);
    animators.push((t) => {
      sun.rotation.y = t * 0.3;
      sun.material.emissiveIntensity = 1.2 + Math.sin(t * 2) * 0.2;
      planets.forEach((p) => p.m.position.set(Math.cos(t * p.w + p.o) * p.r, 1.25, Math.sin(t * p.w + p.o) * p.r * 0.75));
      const e = planets[2].m.position;
      moon.position.set(e.x + Math.cos(t * 5) * 0.18, 1.25, e.z + Math.sin(t * 5) * 0.18);
    });
  },
  underwater(g) {
    // An aquarium on a stand: sand, coral, a kelp frond, fish circling, a turtle, a little diver
    // and bubbles rising to the top.
    box(g, 4.0, 0.7, 2.0, '#2a3142', 0, 0, 0);
    box(g, 3.8, 0.12, 1.8, '#e6d6a8', 0, 0.7, 0);
    const glass = new THREE.MeshLambertMaterial({ color: '#5fd0ff', transparent: true, opacity: 0.22, emissive: '#0a6a9a', emissiveIntensity: 0.35, depthWrite: false });
    box(g, 3.9, 1.6, 1.9, glass, 0, 0.7, 0, { shadow: false });
    box(g, 4.0, 0.08, 2.0, '#2a3142', 0, 2.3, 0);
    [[-1.3, 0.3, '#ff7ab0', 0.28], [-0.9, -0.4, '#ffd060', 0.2], [1.2, 0.2, '#c080ff', 0.26], [0.6, -0.5, '#ff9050', 0.18]].forEach(([x, z, c, r]) => sphere(g, r, c, x, 0.82, z, 10));
    const kelp = [];
    for (let i = 0; i < 6; i++) kelp.push(box(g, 0.08, 0.22, 0.03, '#7a9a2a', 1.6, 0.82 + i * 0.22, 0.5, { shadow: false }));
    const fishCols = ['#ff7a14', '#1a4ae0', '#ffe23a', '#4ae0d0', '#ff7a14', '#ffe23a'];
    const fish = fishCols.map((c, i) => {
      const f = new THREE.Group();
      sphere(f, 0.09, glow(c, 0.25), 0, 0, 0, 8).scale.set(1.5, 1, 0.6);
      const tail = box(f, 0.03, 0.12, 0.1, c, -0.16, -0.06, 0, { shadow: false });
      f.userData = { r: 0.9 + (i % 3) * 0.3, y: 1.2 + (i % 4) * 0.2, w: 0.7 + i * 0.12, o: i * 1.1, tail };
      g.add(f);
      return f;
    });
    const turtle = new THREE.Group();
    sphere(turtle, 0.2, '#6b5a32', 0, 0, 0, 10).scale.set(1.2, 0.45, 1);
    sphere(turtle, 0.07, '#7b6a48', 0.25, 0, 0, 8);
    g.add(turtle);
    const diver = new THREE.Group();
    box(diver, 0.1, 0.1, 0.28, '#1c2430', -0.05, -0.05, 0, { shadow: false });
    sphere(diver, 0.06, '#f0c8a0', 0, 0, 0.17, 8);
    box(diver, 0.08, 0.05, 0.03, glow('#9fe8ff', 0.6), 0, 0.0, 0.22, { shadow: false });
    box(diver, 0.06, 0.12, 0.05, '#ffd21a', 0, 0.05, -0.05, { shadow: false });
    box(diver, 0.14, 0.02, 0.12, '#ffd21a', 0, -0.03, -0.25, { shadow: false });
    g.add(diver);
    const bubbles = [];
    for (let i = 0; i < 10; i++) bubbles.push({ m: sphere(g, 0.03, glow('#eaffff', 0.6), 0, 0, 0, 6), o: i / 10 });
    animators.push((t) => {
      fish.forEach((f) => {
        const u = f.userData, a = t * u.w + u.o;
        f.position.set(Math.cos(a) * u.r, u.y + Math.sin(a * 2) * 0.06, Math.sin(a) * u.r * 0.55);
        f.rotation.y = -a - Math.PI / 2;
        u.tail.rotation.y = Math.sin(t * 12 + u.o) * 0.5;
      });
      const ta = t * 0.35;
      turtle.position.set(Math.cos(ta) * 0.7, 1.55 + Math.sin(t * 0.8) * 0.08, Math.sin(ta) * 0.35);
      turtle.rotation.y = -ta - Math.PI / 2;
      diver.position.set(Math.sin(t * 0.25) * 1.2, 1.25, -0.2 + Math.cos(t * 0.3) * 0.3);
      diver.rotation.y = Math.cos(t * 0.25) > 0 ? Math.PI / 2 : -Math.PI / 2;
      kelp.forEach((k, i) => { k.position.x = 1.6 + Math.sin(t * 1.2 + i * 0.5) * 0.04 * i; });
      bubbles.forEach((b) => {
        const k = (t * 0.25 + b.o) % 1;
        b.m.position.set(diver.position.x + Math.sin(k * 12 + b.o * 9) * 0.05, 1.3 + k * 0.95, diver.position.z);
      });
    });
  },
  'stem-lab'(g) {
    // A classroom lab bench: four S-T-E-M blocks bobbing in turn, an atom, meshing gears and a sine
    // wave on a chalkboard.
    box(g, 4.2, 0.7, 2.2, '#2a3142', 0, 0, 0.2);
    box(g, 4.0, 0.04, 2.0, '#e6e9ef', 0, 0.7, 0.2);
    box(g, 3.6, 1.5, 0.08, '#1d3a2e', 0, 0.9, -1.0);
    box(g, 3.8, 0.08, 0.14, '#8a6a45', 0, 0.86, -0.98);
    const wave = new THREE.Group();
    const wm = glow('#c38bff', 0.9);
    for (let i = 0; i < 28; i++) {
      const x = -1.5 + i * (3 / 27);
      box(wave, 0.07, 0.07, 0.02, wm, x, 1.6 + Math.sin(i * 0.45) * 0.35, -0.95, { shadow: false });
    }
    g.add(wave);
    const blocks = ['#4fd1a5', '#5aa9ff', '#ffb347', '#c38bff'].map((c, i) => box(g, 0.42, 0.42, 0.42, glow(c, 0.5), -1.35 + i * 0.9, 0.95, 0.75));
    const atom = new THREE.Group();
    atom.position.set(-1.3, 1.25, -0.1);
    sphere(atom, 0.12, '#ff6b6b', 0, 0, 0, 14);
    const orbits = [0, 1, 2].map((k) => {
      const o = new THREE.Group();
      o.rotation.set(k * 1.05, 0, k * 0.6);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.012, 6, 40), glow('#4fd1a5', 0.6));
      const e = sphere(o, 0.045, glow('#5ad8ff', 1.2), 0.36, 0, 0, 8);
      o.add(ring);
      atom.add(o);
      return { o, e, k };
    });
    g.add(atom);
    box(g, 0.08, 0.5, 0.08, '#8a93a8', -1.3, 0.74, -0.1);
    const gears = [[0.25, 0.9, '#c9ccd2', 1], [0.17, 1.33, '#d9a441', -1.47]].map(([r, x, c, k]) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.08, 12), mat(c));
      m.rotation.x = Math.PI / 2;
      m.position.set(x, 1.0 + r, -0.4);
      m.castShadow = true;
      g.add(m);
      return { m, k };
    });
    animators.push((t) => {
      blocks.forEach((b, i) => {
        const up = Math.max(0, Math.sin(t * 2 - i * 0.9));
        b.position.y = 0.95 + up * 0.25;
        b.rotation.y = up * 0.6;
        b.material.emissiveIntensity = 0.35 + up * 0.8;
      });
      orbits.forEach(({ e, k }) => e.position.set(Math.cos(t * (2 + k * 0.5)) * 0.36, Math.sin(t * (2 + k * 0.5)) * 0.36, 0));
      atom.rotation.y = t * 0.4;
      gears.forEach(({ m, k }) => (m.rotation.y = t * k));
      wave.position.x = Math.sin(t * 0.8) * 0.05;
    });
  },
  'battle-school'(g) {
    // Left: a glass Battle Room with floating stars and a soldier jumping between them.
    const cube = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), new THREE.MeshStandardMaterial({ color: '#5fd0ff', transparent: true, opacity: 0.1, depthWrite: false }));
    cube.position.set(-1.5, 1.3, 0);
    cube.add(new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry), new THREE.LineBasicMaterial({ color: '#5fd0ff' })));
    g.add(cube);
    const stars = [[-2.2, 0.6, -0.5], [-0.9, 1.0, 0.5], [-1.9, 1.8, 0.4], [-1.0, 2.0, -0.6]];
    stars.forEach(([x, y, z]) => box(g, 0.3, 0.3, 0.3, glow('#c9d6ea', 0.25), x, y - 0.15, z));
    const kid = box(g, 0.12, 0.22, 0.12, glow('#ff8a2a', 0.5), 0, 0, 0, { shadow: false });
    // Right: the simulator table with a hologram dogfight over it.
    box(g, 1.3, 0.8, 1.3, '#1a2130', 1.6, 0, 0);
    box(g, 1.4, 0.04, 1.4, glow('#5fd0ff', 0.9), 1.6, 0.8, 0, { shadow: false });
    const ships = [];
    for (let i = 0; i < 9; i++) {
      const c = i < 4 ? '#5fd0ff' : '#ff5a6a';
      ships.push({ m: box(g, 0.09, 0.05, 0.16, glow(c, 1.2), 0, 0, 0, { shadow: false }), r: 0.25 + (i % 4) * 0.12, o: i * 0.9, s: i < 4 ? 1.4 : -0.9, h: 1.05 + (i % 3) * 0.18 });
    }
    animators.push((t) => {
      const seg = (t * 0.7) % stars.length, i = Math.floor(seg), f = seg - i;
      const a = stars[i], b = stars[(i + 1) % stars.length];
      kid.position.set(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f + 0.05, a[2] + (b[2] - a[2]) * f);
      kid.rotation.z = t * 3;
      ships.forEach((s) => {
        const ang = t * s.s + s.o;
        s.m.position.set(1.6 + Math.cos(ang) * s.r, s.h + Math.sin(t * 1.3 + s.o) * 0.06, Math.sin(ang) * s.r);
        s.m.rotation.y = -ang + (s.s > 0 ? 0 : Math.PI);
      });
    });
  },
  aetherfall(g) {
    // A war table: two castles, an aether geyser between them and two little armies.
    box(g, 4.4, 0.7, 2.4, '#5a3e28', 0, 0, 0);
    box(g, 4.2, 0.06, 2.2, '#5c8a34', 0, 0.7, 0);
    const base = 0.76;
    box(g, 0.8, 0.55, 0.7, '#d8ccb0', -1.6, base, -0.3);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.62, 0.5, 4), mat('#3f6fd0'));
    roof.position.set(-1.6, base + 0.8, -0.3);
    roof.rotation.y = Math.PI / 4;
    g.add(roof);
    box(g, 0.28, 0.95, 0.28, '#b8b2a6', -1.15, base, 0.15);
    const tent = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.85, 6), mat('#b8603a'));
    tent.position.set(1.6, base + 0.42, -0.25);
    g.add(tent);
    box(g, 0.06, 0.5, 0.06, '#e8e0c8', 1.6, base + 0.75, -0.25);
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 0), glow('#5ff0ff', 1));
    crystal.position.set(0, base + 0.35, 0);
    crystal.scale.y = 1.6;
    g.add(crystal);
    const motes = [];
    for (let i = 0; i < 10; i++) motes.push({ m: box(g, 0.07, 0.07, 0.07, glow(i % 3 ? '#5ff0ff' : '#c89aff', 1.4), 0, 0, 0, { shadow: false }), o: i / 10, a: i * 2.4 });
    const armies = [];
    for (let i = 0; i < 4; i++) armies.push({ m: box(g, 0.12, 0.22, 0.12, i < 2 ? '#3f8fff' : '#e0402f', 0, base, 0), side: i < 2 ? -1 : 1, z: -0.55 + (i % 2) * 0.22 });
    animators.push((t) => {
      crystal.rotation.y = t * 1.2;
      crystal.material.emissiveIntensity = 0.8 + Math.sin(t * 3) * 0.4;
      motes.forEach((p) => {
        const k = (t * 0.45 + p.o) % 1;
        p.m.position.set(Math.cos(p.a + t * 2) * 0.12 * (1 + k), base + 0.3 + k * 1.8, Math.sin(p.a + t * 2) * 0.12 * (1 + k));
        p.m.scale.setScalar(1 - k * 0.7);
      });
      const clash = (Math.sin(t * 0.8) + 1) / 2;
      armies.forEach((a) => a.m.position.set(a.side * (1.2 - clash * 0.85), base + Math.abs(Math.sin(t * 8 + a.z * 9)) * 0.04, 0.55 + a.z));
    });
  },
  'street-brawl'(g) {
    // Two voxel fighters trade blows on a little stage and sparks pop at each hit; an arcade cabinet on the right.
    box(g, 2.8, 0.25, 1.6, '#3a2a4a', -0.7, 0, 0);
    box(g, 2.9, 0.04, 1.7, glow('#ff7ab8', 0.6), -0.7, 0.25, 0, { shadow: false });
    const fighter = (c, belt, x, dir) => {
      const f = new THREE.Group();
      f.position.set(x, 0.29, 0);
      g.add(f);
      box(f, 0.12, 0.36, 0.1, '#2a2a33', 0, 0, -0.07);
      box(f, 0.12, 0.36, 0.1, '#2a2a33', 0, 0, 0.07);
      box(f, 0.2, 0.42, 0.32, c, 0, 0.36, 0);
      box(f, 0.21, 0.06, 0.33, belt, 0, 0.38, 0);
      box(f, 0.2, 0.2, 0.2, '#e0ac7e', 0, 0.8, 0);
      const arm = new THREE.Group();
      arm.position.set(0, 0.62, 0.1);
      f.add(arm);
      box(arm, 0.36, 0.09, 0.09, c, 0.18 * dir, 0, 0);
      box(arm, 0.13, 0.13, 0.13, belt, 0.38 * dir, -0.02, 0);
      return { f, arm, x };
    };
    const A = fighter('#f2f2f2', '#d02a1a', -1.15, 1);
    const B = fighter('#ffe23a', '#1d1d2a', -0.25, -1);
    const spark = box(g, 0.22, 0.22, 0.22, glow('#ffd23f', 2), -0.7, 0.9, 0, { shadow: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.03, 6, 20), glow('#ff4a2a', 1.6));
    g.add(ring);
    // arcade cabinet
    box(g, 0.9, 1.7, 0.7, '#20142c', 1.45, 0, 0);
    box(g, 0.94, 0.25, 0.74, glow('#ff4a2a', 0.8), 1.45, 1.7, 0, { shadow: false });
    const screen = box(g, 0.7, 0.5, 0.04, glow('#3ab0ff', 1.0), 1.45, 1.05, 0.34, { shadow: false });
    box(g, 0.9, 0.08, 0.35, '#2a1a3a', 1.45, 0.85, 0.45);
    sphere(g, 0.05, glow('#ff4a2a', 1.2), 1.3, 0.97, 0.5, 8);
    sphere(g, 0.05, glow('#ffd23f', 1.2), 1.55, 0.97, 0.5, 8);
    animators.push((t) => {
      const beat = t * 2.2, turn = Math.floor(beat) % 2, k = beat % 1;
      const jab = Math.max(0, Math.sin(Math.min(1, k * 2.5) * Math.PI));
      const atk = turn ? B : A, def = turn ? A : B;
      A.f.position.x = A.x + Math.sin(t * 5) * 0.03 + (atk === A ? jab * 0.12 : -jab * 0.08);
      B.f.position.x = B.x - Math.sin(t * 5) * 0.03 - (atk === B ? jab * 0.12 : -jab * 0.08);
      A.arm.scale.x = 1 + (atk === A ? jab * 0.5 : 0);
      B.arm.scale.x = 1 + (atk === B ? jab * 0.5 : 0);
      A.f.rotation.z = def === A ? jab * 0.2 : 0;
      B.f.rotation.z = def === B ? -jab * 0.2 : 0;
      const hit = k > 0.28 && k < 0.55;
      spark.visible = ring.visible = hit;
      const s = hit ? 0.6 + (k - 0.28) * 4 : 0.01;
      spark.scale.setScalar(0.22 * s);
      spark.rotation.set(t * 7, t * 9, 0);
      spark.position.set((A.f.position.x + B.f.position.x) / 2, 0.95 + (k - 0.28) * 0.6, (k - 0.28) * 1.2);
      ring.position.copy(spark.position);
      ring.scale.setScalar(s * 1.6);
      screen.material.emissiveIntensity = 0.7 + Math.abs(Math.sin(t * 6)) * 0.6;
    });
  },
  music(g) {
    [-1.7, 1.7].forEach((x) => {
      box(g, 0.75, 1.6, 0.6, '#1d1d24', x, 0, 0);
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.05, 14), mat('#444'));
      cone.rotation.x = Math.PI / 2;
      cone.position.set(x, 0.55, 0.31);
      g.add(cone);
    });
    const hues = ['#ff3b8d', '#ff6b3b', '#ffd34d', '#6fe0a4', '#4fd8ff', '#7a7bff', '#c08bff', '#ff3b8d'];
    const bars = hues.map((c, i) => box(g, 0.24, 1, 0.24, glow(c, 0.8), -0.95 + i * 0.27, 0, 0, { shadow: false }));
    const ball = sphere(g, 0.35, new THREE.MeshLambertMaterial({ color: '#d8d8e8', emissive: '#6666aa', emissiveIntensity: 0.4, flatShading: true }), 0, 2.4, 0, 8);
    animators.push((t) => {
      const beat = Math.pow(Math.abs(Math.sin(t * Math.PI * 1.1)), 6);
      bars.forEach((b, i) => {
        b.scale.y = 0.2 + Math.abs(Math.sin(t * 3 + i * 0.8)) * 1.1 + beat * 0.5;
        b.position.y = b.scale.y / 2;
      });
      ball.rotation.y = t;
      ball.material.emissiveIntensity = 0.3 + beat * 0.8;
    });
  },
  splat(g) {
    [0, 2.1, 4.2].forEach((a) => {
      const leg = box(g, 0.05, 1.3, 0.05, '#333', -1.9 + Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3);
      leg.rotation.z = Math.cos(a) * 0.2;
    });
    box(g, 0.5, 0.32, 0.3, '#222', -1.9, 1.25, 0);
    box(g, 0.14, 0.14, 0.12, '#556', -1.72, 1.34, 0.2);
    box(g, 0.14, 0.14, 0.12, '#556', -2.08, 1.34, 0.2);
    box(g, 1.1, 0.6, 1.1, '#2b3a33', 0.9, 0, 0);
    const n = 900, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 6.28, v = Math.acos(rand(-1, 1)), r = Math.cbrt(Math.random()) * 0.75;
      pos.set([Math.sin(v) * Math.cos(u) * r, Math.cos(v) * r * 1.2, Math.sin(v) * Math.sin(u) * r], i * 3);
      c.setHSL(0.35 + Math.cos(v) * 0.25, 0.7, 0.55);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const cloud = new THREE.Points(geo, new THREE.PointsMaterial({ size: 2.5, sizeAttenuation: false, vertexColors: true }));
    cloud.position.set(0.9, 1.6, 0);
    cloud.layers.set(LABEL_LAYER);
    g.add(cloud);
    animators.push((t) => {
      cloud.rotation.y = t * 0.6;
      cloud.scale.setScalar(0.92 + Math.sin(t * 1.3) * 0.08);
    });
  },
};

rooms.forEach((r, i) => {
  const g = new THREE.Group();
  g.position.set(r.cx, 0, r.propZ);
  scene.add(g);
  BUILD[r.demo.id]?.(g, r);
  const w = r.x1 - r.x0;
  // Set pieces are sized for rooms about 4.5 m wide; shrink them in narrower rooms (5-room wings).
  if (w < 4.4) g.scale.setScalar(w / 4.5);
  const deskZ = r.back ? r.walk[0] + 0.8 : r.walk[1] - 0.8;
  desk(r.x0 + Math.min(1.6, w * 0.25), deskZ, r.wing.accent);
  if (w > 7) desk(r.x1 - 1.6, deskZ, r.wing.accent);
  plant(r.back ? r.x1 - 0.55 : r.x0 + 0.55, r.back ? r.walk[1] - 0.2 : r.walk[0] + 0.2, 0.8);

  // Invisible hover target that tints the floor of the room.
  const hl = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.3, r.z1 - r.z0 - 0.3), new THREE.MeshBasicMaterial({ color: r.wing.accent, transparent: true, opacity: 0, depthWrite: false }));
  hl.rotation.x = -Math.PI / 2;
  hl.position.set(r.cx, 0.03, r.cz);
  hl.userData.room = r;
  scene.add(hl);
  r.highlight = hl;
});

// Lobby
box(scene, 2.6, 0.95, 0.8, '#8a5a3a', 0, 0, 8.5);
box(scene, 2.8, 0.08, 1, '#c99a6b', 0, 0.95, 8.5);
box(scene, 0.6, 1.2, 0.5, '#2d2d33', -1.3, 0, 12.8);
box(scene, 0.3, 0.2, 0.3, '#eee', -1.3, 1.2, 12.8);
box(scene, 2.6, 0.45, 0.9, '#d6573c', 0, 0, -12.8);
box(scene, 2.6, 0.6, 0.25, '#c04a32', 0, 0.45, -13.2);
box(scene, 1.2, 0.35, 0.7, '#7a5232', 0, 0, -11.3);
plant(1.4, 12.9);
plant(-1.4, -9.5, 0.9);
plant(1.4, -4, 0.8);
const lobbyRug = box(scene, 2.6, 0.02, 3, '#c0573e', 0, 0.02, 4.8, { shadow: false });
lobbyRug.receiveShadow = true;

// ---------- outside: street, trees, billboard, cars, bunnies ----------

// The site is a floating diorama plot, not an endless ground plane: in 3D an endless plane would
// run out of the glass toward the viewer and get cut by the frame edge.
const PX = 34, PZ0 = -22, PZ1 = 27, PCZ = (PZ0 + PZ1) / 2;
box(scene, PX * 2, 1.6, PZ1 - PZ0, '#7a5638', 0, -2.22, PCZ, { shadow: false });
box(scene, PX * 2, 0.12, PZ1 - PZ0, '#5f9a52', 0, -0.62, PCZ, { shadow: false });
box(scene, PX * 2, 0.12, 2.4, '#b9b5ad', 0, -0.5, 15.9, { shadow: false });
box(scene, PX * 2, 0.1, 6, '#3c3c44', 0, -0.5, 20.3, { shadow: false });
for (let x = -PX + 2; x < PX - 1; x += 4) box(scene, 1.8, 0.02, 0.18, '#e9d27a', x, -0.39, 20.3, { shadow: false });
for (let i = 0; i < 6; i++) box(scene, 0.5, 0.02, 5.4, '#e8e8e8', -2.4 + i * 0.95, -0.39, 20.3, { shadow: false });
box(scene, 4, 0.06, 1.4, '#b9b5ad', 0, -0.48, 14.5, { shadow: false });

const trees = [[24, -12], [27, -7], [24, -2], [28, 3], [25, 8], [29, 12], [-24, -10], [-27, -3], [-24, 5], [-28, 11], [-8, 25], [6, 26], [16, 24], [-18, 25], [10, -19], [-12, -19], [30, -16]];
trees.forEach(([x, z]) => {
  const s = rand(0.8, 1.25);
  box(scene, 0.4 * s, 1.2 * s, 0.4 * s, '#7a5232', x, -0.45, z);
  box(scene, 1.8 * s, 1.2 * s, 1.8 * s, '#4f9d4a', x, -0.45 + 1.1 * s, z);
  box(scene, 1.2 * s, 0.8 * s, 1.2 * s, '#67b85c', x, -0.45 + 2.2 * s, z);
});
for (let i = 0; i < 10; i++) box(scene, rand(0.6, 1.1), 0.5, rand(0.6, 1.1), '#3f8a3c', rand(-19, 19), -0.5, rand(14.9, 15.1) + (i % 2 ? 0 : 0.01));

function billboard() {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 256;
  const c = cv.getContext('2d');
  c.fillStyle = '#f3e3bf'; c.fillRect(0, 0, 1024, 256);
  c.strokeStyle = '#6b4a2b'; c.lineWidth = 6; c.strokeRect(14, 14, 996, 228);
  c.fillStyle = '#3a2a1a';
  c.font = 'bold 120px "Courier New", monospace';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('DISPLAYXR HQ', 512, 118);
  c.font = 'bold 28px "Courier New", monospace';
  c.fillText('GLASSES-FREE 3D  ·  DEMOS  ·  EST. 2026', 512, 205);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const g = new THREE.Group();
  g.position.set(0, 0, -17.5);
  box(g, 0.4, 5.5, 0.4, '#3a2a1a', -6, -0.5, 0);
  box(g, 0.4, 5.5, 0.4, '#3a2a1a', 6, -0.5, 0);
  box(g, 16.6, 4.4, 0.4, '#6b4a2b', 0, 4.6, -0.05);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(16, 3.9), new THREE.MeshBasicMaterial({ map: tex }));
  face.position.set(0, 6.8, 0.17);
  g.add(face);
  scene.add(g);
}
billboard();

const cars = [];
const carColors = ['#e07b39', '#3e7cc9', '#d64545', '#f2c94c', '#ececec', '#4caf7a'];
for (let i = 0; i < 6; i++) {
  const g = new THREE.Group();
  const c = carColors[i];
  box(g, 2.6, 0.6, 1.3, c, 0, 0.25, 0);
  box(g, 1.4, 0.5, 1.15, shade(c, 0.85), -0.2, 0.85, 0);
  box(g, 1.3, 0.38, 1.18, '#9cc7e8', -0.2, 0.9, 0, { shadow: false });
  [[-0.85, 0.66], [0.85, 0.66], [-0.85, -0.66], [0.85, -0.66]].forEach(([x, z]) => box(g, 0.5, 0.5, 0.15, '#1a1a1a', x, 0, z));
  const lane = i % 2;
  g.userData = { lane, speed: rand(4, 7), x: rand(-PX + 2, PX - 2) };
  g.position.set(0, -0.4, lane ? 21.7 : 18.9);
  g.rotation.y = lane ? 0 : Math.PI;
  scene.add(g);
  cars.push(g);
}

const bunnies = [];
for (let i = 0; i < 4; i++) {
  const g = new THREE.Group();
  box(g, 0.45, 0.32, 0.3, '#f4f1ea', 0, 0, 0);
  box(g, 0.25, 0.25, 0.25, '#f4f1ea', 0.25, 0.22, 0);
  box(g, 0.06, 0.25, 0.08, '#f4c6c6', 0.25, 0.47, 0.06);
  box(g, 0.06, 0.25, 0.08, '#f4c6c6', 0.25, 0.47, -0.06);
  g.position.set(rand(22, 30), -0.5, rand(-8, 12));
  g.userData = { target: g.position.clone(), next: rand(0, 3) };
  scene.add(g);
  bunnies.push(g);
}

// ---------- people ----------

const NAMES = ['Ada', 'Kai', 'Nova', 'Juno', 'Rex', 'Iris', 'Theo', 'Mila', 'Otto', 'Pia', 'Lux', 'Remy', 'Zara', 'Fern', 'Milo', 'Vega', 'Atlas', 'Lyra', 'Bo', 'Cy', 'Dex', 'Echo', 'Sol', 'Wren', 'Ivo'];
const SKIN = ['#f1c9a5', '#e0ac7e', '#c68a5c', '#8d5a3b', '#5c3a26'];
const HAIR = ['#2b1d14', '#5a3825', '#d9b45a', '#b8452c', '#1d1d1d', '#e8e2d6', '#3c5aa8'];
const SHIRT = ['#3e7cc9', '#4a90d9', '#2d6aa8', '#e07b39', '#6fae5a', '#8e5bd1', '#d14b6a', '#e8e8e8'];
const PANTS = ['#2b3546', '#3a3a44', '#4b3a2a', '#24324a'];

const tagLayer = document.createElement('div');
tagLayer.className = 'tags';
labelLayer.append(tagLayer);

function makePerson(name, home) {
  const g = new THREE.Group();
  const shirt = pick(SHIRT), pants = pick(PANTS), skin = pick(SKIN), hair = pick(HAIR);
  const limb = (x, y, w, h, c) => {
    const p = new THREE.Group();
    p.position.set(x, y, 0);
    box(p, w, h, 0.2, c, 0, -h, 0);
    g.add(p);
    return p;
  };
  const legL = limb(-0.13, 0.5, 0.2, 0.5, pants), legR = limb(0.13, 0.5, 0.2, 0.5, pants);
  box(g, 0.58, 0.55, 0.34, shirt, 0, 0.5, 0);
  const armL = limb(-0.38, 1.02, 0.16, 0.48, shirt), armR = limb(0.38, 1.02, 0.16, 0.48, shirt);
  box(g, 0.44, 0.4, 0.4, skin, 0, 1.05, 0);
  box(g, 0.47, 0.13, 0.43, hair, 0, 1.4, 0);
  box(g, 0.47, 0.25, 0.1, hair, 0, 1.2, -0.18);
  box(g, 0.06, 0.06, 0.02, '#1d1d1d', -0.1, 1.2, 0.205, { shadow: false });
  box(g, 0.06, 0.06, 0.02, '#1d1d1d', 0.1, 1.2, 0.205, { shadow: false });
  g.scale.setScalar(0.9);
  g.userData.person = true;
  scene.add(g);

  const tag = document.createElement('div');
  tag.className = 'tag';
  tag.textContent = name;
  tagLayer.append(tag);

  return { g, legL, legR, armL, armR, name, home, region: home, path: [], wait: rand(0, 2), phase: Math.random() * 6, tag, bubble: null, away: 0 };
}

const inHallH = (p) => Math.abs(p.z) < HALL - 0.4;
function hallPoint() {
  return Math.random() < 0.6
    ? new THREE.Vector3(rand(X0 + 1, X1 - 1), 0, rand(-1.3, 1.3))
    : new THREE.Vector3(rand(-1.3, 1.3), 0, Math.random() < 0.5 ? rand(Z0 + 2.5, -2.5) : rand(2.5, Z1 - 1.2));
}
function roomPoint(r) {
  return new THREE.Vector3(rand(r.x0 + 0.9, r.x1 - 0.9), 0, rand(r.walk[0], r.walk[1]));
}

// Route through doors and the hall; the hall's two strips meet near the origin.
function route(p, to, dest) {
  const pts = [];
  const from = p.region;
  if (from !== 'hall' && from === to) return [dest];
  let cur = p.g.position;
  if (from !== 'hall') { pts.push(from.doorIn.clone(), from.doorOut.clone().setX(from.doorOut.x + rand(-0.5, 0.5))); cur = pts[pts.length - 1]; }
  const hallGoal = to === 'hall' ? dest : to.doorOut.clone().setX(to.doorOut.x + rand(-0.5, 0.5));
  if (!(inHallH(cur) && inHallH(hallGoal))) pts.push(new THREE.Vector3(rand(-0.8, 0.8), 0, rand(-0.8, 0.8)));
  pts.push(hallGoal);
  if (to !== 'hall') pts.push(to.doorIn.clone(), dest);
  return pts;
}

const people = [];
let ni = 0;
rooms.forEach((r) => {
  const n = r.x1 - r.x0 > 7 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const p = makePerson(NAMES[ni++ % NAMES.length], r);
    p.g.position.copy(roomPoint(r));
    people.push(p);
  }
});
for (let i = 0; i < 4; i++) {
  const p = makePerson(NAMES[ni++ % NAMES.length], 'hall');
  p.g.position.copy(hallPoint());
  people.push(p);
}

function nextErrand(p) {
  const roll = Math.random();
  if (p.home === 'hall') {
    if (roll < 0.25) { const r = pick(rooms); p.path = route(p, r, roomPoint(r)); p.region = r; p.away = 1; }
    else { p.path = route(p, 'hall', hallPoint()); p.region = 'hall'; }
    return;
  }
  if (p.region !== p.home) { p.path = route(p, p.home, roomPoint(p.home)); p.region = p.home; return; }
  if (roll < 0.1) { const r = pick(rooms.filter((x) => x !== p.home)); p.path = route(p, r, roomPoint(r)); p.region = r; }
  else if (roll < 0.16) { p.path = route(p, 'hall', hallPoint()); p.region = 'hall'; }
  else p.path = [roomPoint(p.home)];
}

const SPEED = 1.7;
const tmp = new THREE.Vector3();
function stepPerson(p, dt) {
  if (!p.path.length) {
    p.wait -= dt;
    p.legL.rotation.x = p.legR.rotation.x = p.armL.rotation.x = p.armR.rotation.x = 0;
    p.g.position.y = 0;
    if (p.wait <= 0) { nextErrand(p); p.wait = rand(1, 4.5); }
    return;
  }
  tmp.subVectors(p.path[0], p.g.position);
  tmp.y = 0;
  const d = tmp.length();
  if (d < 0.08) { p.path.shift(); return; }
  const s = Math.min(d, SPEED * dt);
  p.g.position.addScaledVector(tmp.normalize(), s);
  const want = Math.atan2(tmp.x, tmp.z);
  let diff = want - p.g.rotation.y;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  p.g.rotation.y += diff * Math.min(1, dt * 10);
  p.phase += dt * 9;
  const sw = Math.sin(p.phase) * 0.6;
  p.legL.rotation.x = sw; p.legR.rotation.x = -sw;
  p.armL.rotation.x = -sw * 0.8; p.armR.rotation.x = sw * 0.8;
  p.g.position.y = Math.abs(Math.cos(p.phase)) * 0.05;
}

// ---------- labels, bubbles and activity feed ----------
// Flat view: HTML labels projected over the canvas. Woven view: the same labels as sprites in the
// scene, so each sits at its room's or person's depth instead of on the glass.

const MONO = '"Cascadia Mono", Consolas, "Courier New", monospace';

function canvasTexture(w, h, draw) {
  const cv = document.createElement('canvas');
  cv.width = w * 2; cv.height = h * 2;
  const c = cv.getContext('2d');
  c.scale(2, 2);
  draw(c);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A sprite whose bottom centre is its anchor, `height` office units tall.
function sprite(tex, w, h, height) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  s.scale.set((height * w) / h, height, 1);
  s.center.set(0.5, 0);
  s.layers.set(LABEL_LAYER);
  return s;
}

const measure = document.createElement('canvas').getContext('2d');
function textWidth(text, font) {
  measure.font = font;
  return measure.measureText(text).width;
}

function plaqueSprite(r) {
  const name = r.demo.name.toUpperCase(), wing = r.wing.name.toUpperCase();
  const fName = `600 22px ${MONO}`, fWing = `500 12px ${MONO}`;
  const w = Math.ceil(Math.max(textWidth(name + ' →', fName), textWidth(wing, fWing)) + 34), h = 56;
  const draw = (hot) => (c) => {
    c.beginPath(); c.roundRect(1.5, 1.5, w - 3, h - 3, 5);
    c.fillStyle = hot ? 'rgba(12,14,20,.97)' : 'rgba(20,22,28,.82)'; c.fill();
    c.lineWidth = hot ? 3 : 1.5; c.strokeStyle = hot ? r.wing.accent : 'rgba(255,255,255,.18)'; c.stroke();
    c.fillStyle = r.wing.accent; c.fillRect(1.5, 1.5, 5, h - 3);
    c.textAlign = 'center';
    c.font = fWing; c.fillText(wing, w / 2 + 2, 20);
    c.font = fName; c.fillStyle = '#f1ede4'; c.fillText(hot ? name + ' →' : name, w / 2 + 2, 45);
  };
  const s = sprite(canvasTexture(w, h, draw(false)), w, h, 1.5);
  // Always drawn over the wall it hangs on (a camera-facing sprite would otherwise cut into it).
  s.material.depthTest = false;
  s.renderOrder = 10;
  s.userData = { room: r, cold: s.material.map, hot: canvasTexture(w, h, draw(true)) };
  return s;
}

function tagSprite(name) {
  const f = `600 15px ${MONO}`, w = Math.ceil(textWidth(name, f) + 12), h = 22;
  return sprite(canvasTexture(w, h, (c) => {
    c.fillStyle = 'rgba(20,22,28,.72)'; c.beginPath(); c.roundRect(0, 0, w, h, 3); c.fill();
    c.fillStyle = '#e6e2d8'; c.font = f; c.textAlign = 'center'; c.fillText(name, w / 2, 16);
  }), w, h, 0.5);
}

function bubbleSprite(text) {
  const f = `500 15px ${MONO}`, maxW = 210, lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? line + ' ' + word : word;
    if (line && textWidth(next, f) > maxW) { lines.push(line); line = word; } else line = next;
  }
  lines.push(line);
  const w = Math.ceil(Math.max(...lines.map((l) => textWidth(l, f))) + 22), bodyH = lines.length * 19 + 12, h = bodyH + 9;
  return sprite(canvasTexture(w, h, (c) => {
    c.fillStyle = '#fbf8f1';
    c.beginPath(); c.roundRect(0, 0, w, bodyH, 7); c.fill();
    c.beginPath(); c.moveTo(w / 2 - 7, bodyH - 1); c.lineTo(w / 2, h); c.lineTo(w / 2 + 7, bodyH - 1); c.fill();
    c.fillStyle = '#2a2620'; c.font = f; c.textAlign = 'center';
    lines.forEach((l, i) => c.fillText(l, w / 2, 21 + i * 19));
  }), w, h, (h / 22) * 0.8);
}

const plaques = rooms.map((r) => {
  const a = document.createElement('a');
  a.className = 'plaque';
  a.href = r.demo.url;
  a.style.setProperty('--accent', r.wing.accent);
  a.innerHTML = `<small>${r.wing.name}</small><span>${r.demo.name}</span>`;
  a.title = r.demo.desc;
  a.addEventListener('pointerenter', () => setHot(r));
  a.addEventListener('pointerleave', () => setHot(null));
  a.addEventListener('focus', () => setHot(r));
  a.addEventListener('blur', () => setHot(null));
  labelLayer.append(a);
  return { r, el: a, sprite: null };
});
const lobbyTag = document.createElement('div');
lobbyTag.className = 'plaque plaque-static';
lobbyTag.innerHTML = '<span>Lobby</span>';
labelLayer.append(lobbyTag);
const lobbyAnchor = new THREE.Vector3(0, 0.1, 6.6);

// 3D labels, built the first time the woven view starts.
const labels3d = new THREE.Group();
labels3d.visible = false;
scene.add(labels3d);
function buildLabels3d() {
  if (labels3d.children.length) return;
  plaques.forEach((p) => {
    const s = plaqueSprite(p.r);
    s.position.copy(p.r.plaque);
    if (p.r.back) { s.position.y = 1.3; s.position.z += 0.35; }
    p.sprite = s;
    labels3d.add(s);
  });
  people.forEach((p) => {
    p.tag3d = tagSprite(p.name);
    p.tag3d.position.y = 1.98;
    p.tag3d.visible = false;
    p.g.add(p.tag3d);
  });
}
function showLabels3d(on) {
  labels3d.visible = on;
  people.forEach((p) => p.tag3d && (p.tag3d.visible = on));
}

let hot = null;
function setHot(r) {
  if (r === hot) return;
  hot = r;
  plaques.forEach((p) => {
    p.el.classList.toggle('hot', p.r === r);
    if (p.sprite) p.sprite.material.map = p.r === r ? p.sprite.userData.hot : p.sprite.userData.cold;
  });
  canvas.style.cursor = r ? 'pointer' : '';
}

const bubbles = [];
function say(p) {
  const r = p.region === 'hall' ? null : p.region;
  const text = pick(r ? r.demo.chatter : LOBBY_CHATTER);
  const b = { until: clock + 4.5 };
  if (woven) {
    b.sprite = bubbleSprite(text);
    b.sprite.position.y = 2.6;
    b.sprite.material.depthTest = false; // over the wall signs, like the flat view's bubbles
    b.sprite.renderOrder = 11;
    p.g.add(b.sprite);
  } else {
    b.el = document.createElement('div');
    b.el.className = 'bubble';
    b.el.textContent = text;
    labelLayer.append(b.el);
  }
  p.bubble = b;
  bubbles.push(p);
  const li = document.createElement('li');
  li.innerHTML = `<b style="--accent:${r ? r.wing.accent : '#bbb'}">${r ? r.demo.name : 'Lobby'}</b> `;
  li.append(`${p.name}: ${text}`);
  feedList.prepend(li);
  while (feedList.children.length > 3) feedList.lastChild.remove();
}
function unsay(p) {
  const b = p.bubble;
  if (b.el) b.el.remove();
  if (b.sprite) { p.g.remove(b.sprite); b.sprite.material.map.dispose(); b.sprite.material.dispose(); }
  p.bubble = null;
  bubbles.splice(bubbles.indexOf(p), 1);
}

// ---------- flat camera ----------

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
camera.layers.enable(LABEL_LAYER);
const target = new THREE.Vector3(0, 0, 1.5);
const BASE_AZ = Math.PI / 4, ELEV = 0.62, DIST = 120;
let viewH = 20;
const fitPts = [[X0, 0, Z0], [X1, 0, Z0], [X0, 0, Z1], [X1, 0, Z1], [X0, 2.6, Z0], [-8, 9.3, -17.5], [8, 9.3, -17.5]].map((p) => new THREE.Vector3(...p));

function placeCamera(az) {
  camera.position.set(target.x + Math.sin(az) * Math.cos(ELEV) * DIST, target.y + Math.sin(ELEV) * DIST, target.z + Math.cos(az) * Math.cos(ELEV) * DIST);
  camera.lookAt(target);
}

function resize() {
  const w = hero.clientWidth, h = hero.clientHeight, aspect = w / h;
  renderer.setSize(w, h, false);
  // Fit the building and billboard: measure at unit size, then scale.
  camera.left = -aspect; camera.right = aspect; camera.top = 1; camera.bottom = -1;
  camera.updateProjectionMatrix();
  placeCamera(BASE_AZ);
  camera.updateMatrixWorld();
  let mx = 0, my = 0;
  const v = new THREE.Vector3();
  for (const p of fitPts) {
    v.copy(p).applyMatrix4(camera.matrixWorldInverse);
    mx = Math.max(mx, Math.abs(v.x)); my = Math.max(my, Math.abs(v.y));
  }
  const narrow = w < 700;
  viewH = Math.max(my * (narrow ? 1.0 : 1.04), (mx / aspect) * (narrow ? 1.08 : 1.02));
  camera.left = -viewH * aspect; camera.right = viewH * aspect; camera.top = viewH; camera.bottom = -viewH;
  camera.updateProjectionMatrix();
  hero.classList.toggle('narrow', narrow);
}

// ---------- lights ----------

scene.add(new THREE.HemisphereLight('#dfeeff', '#4a4038', 1.5));
const sun = new THREE.DirectionalLight('#fff3df', 2.2);
sun.position.set(25, 40, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);
// The shadow camera works in world units, so it follows the office's scale in the woven view.
function setShadowScale(k) {
  Object.assign(sun.shadow.camera, { left: -38 * k, right: 38 * k, top: 38 * k, bottom: -38 * k, near: k, far: 120 * k });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.normalBias = 0.02 * k;
}
setShadowScale(1);

// ---------- picking ----------
// Flat: the ortho camera. Woven: one camera at the midpoint between the eyes. There is one cursor
// on one screen, so pick against that cyclopean view, never an eye camera.

const ray = new THREE.Raycaster();
ray.layers.enable(LABEL_LAYER);
const ndc = new THREE.Vector2();
const pickCam = new THREE.PerspectiveCamera();
pickCam.matrixAutoUpdate = false;
let havePickCam = false;
function roomAt(e) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  const cam = woven ? (havePickCam ? pickCam : null) : camera;
  if (!cam) return null;
  ray.setFromCamera(ndc, cam);
  const targets = rooms.map((r) => r.highlight);
  if (woven) plaques.forEach((p) => p.sprite && targets.push(p.sprite));
  for (const hit of ray.intersectObjects(targets, false)) if (hit.object.userData.room) return hit.object.userData.room;
  return null;
}
canvas.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') setHot(roomAt(e)); });
canvas.addEventListener('pointerleave', () => setHot(null));
canvas.addEventListener('click', (e) => { const r = roomAt(e); if (r) location.href = r.demo.url; });

// ---------- simulation (shared by both views) ----------

let clock = 0, last = performance.now(), nextSay = 0;
let woven = false;

function step(now) {
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
  last = now;
  clock += dt;
  const sway = reduceMotion ? 0 : Math.sin(clock * 0.12) * 0.06;
  if (woven) scene.rotation.y = -BASE_AZ - sway;
  else placeCamera(BASE_AZ + sway);

  animators.forEach((f) => f(clock));
  flickers.forEach((f) => (f.m.emissiveIntensity = 0.45 + 0.25 * Math.sin(clock * 3 + f.o) + (Math.sin(clock * 17 + f.o) > 0.97 ? 0.4 : 0)));
  people.forEach((p) => stepPerson(p, dt));
  cars.forEach((c) => {
    const u = c.userData;
    u.x += (u.lane ? 1 : -1) * u.speed * dt;
    if (u.x > PX - 1.5) u.x = -PX + 1.5;
    if (u.x < -PX + 1.5) u.x = PX - 1.5;
    c.position.x = u.x;
  });
  bunnies.forEach((b) => {
    const u = b.userData;
    u.next -= dt;
    if (u.next <= 0) { u.target.set(rand(22, 31), -0.5, rand(-9, 13)); u.next = rand(2, 5); }
    tmp.subVectors(u.target, b.position); tmp.y = 0;
    const d = tmp.length();
    if (d > 0.1) {
      b.position.addScaledVector(tmp.normalize(), Math.min(d, dt * 1.4));
      b.rotation.y = Math.atan2(-tmp.z, tmp.x);
      b.position.y = -0.5 + Math.abs(Math.sin(clock * 8)) * 0.25;
    } else b.position.y = -0.5;
  });
  rooms.forEach((r) => {
    const m = r.highlight.material;
    m.opacity += ((r === hot ? 0.22 : 0) - m.opacity) * 0.2;
  });

  bubbles.slice().forEach((p) => clock > p.bubble.until && unsay(p));
  nextSay -= dt;
  if (nextSay <= 0) {
    nextSay = rand(1.4, 2.6);
    const free = people.filter((p) => !p.bubble);
    if (bubbles.length < (hero.classList.contains('narrow') ? 2 : 4) && free.length) say(pick(free));
  }
}

// ---------- flat view loop ----------

const proj = new THREE.Vector3();
function toScreen(v, w, h) {
  proj.copy(v).project(camera);
  return [(proj.x * 0.5 + 0.5) * w, (-proj.y * 0.5 + 0.5) * h, proj.z];
}
const place = (el, x, y) => (el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`);
const head = new THREE.Vector3();

let onScreen = true;
function frame(now) {
  if (!onScreen || woven) return;
  step(now);
  renderer.render(stage, camera);

  const w = hero.clientWidth, h = hero.clientHeight;
  plaques.forEach(({ r, el }) => { const [x, y] = toScreen(r.plaque, w, h); place(el, x, y); });
  { const [x, y] = toScreen(lobbyAnchor, w, h); place(lobbyTag, x, y); }
  people.forEach((p) => {
    head.copy(p.g.position); head.y += 1.75;
    const [x, y] = toScreen(head, w, h);
    place(p.tag, x, y);
    if (p.bubble?.el) place(p.bubble.el, x, y - 16);
  });
  requestAnimationFrame(frame);
}
function startFlat() {
  resize();
  last = performance.now();
  requestAnimationFrame(frame);
}
new IntersectionObserver(([e]) => {
  const was = onScreen;
  onScreen = e.isIntersecting;
  if (onScreen && !was && !woven) { last = performance.now(); requestAnimationFrame(frame); }
}).observe(hero);
addEventListener('resize', () => (woven ? resizeWoven() : resize()));

// ---------- woven (3D) view ----------
// Display rig: the canvas is a portal onto a virtual display VDH metres tall and the office is the
// subject, turned to the same isometric angle and scaled into it. Room height sits on the glass,
// the street comes out toward the viewer, the back wall and billboard sit behind it.

const VDH = 0.3;
const SKY = '#a9d2ea';
let depth = Math.min(1, Math.max(0.05, Number(params.get('depth')) || 0.35)); // building depth as a share of VDH
let subjectDepth = 1, dxr = null, handle = null, cursor = null, haveGood = false;
const eyes = [new EyeCamera(THREE), new EyeCamera(THREE)];
eyes.forEach((e) => e.camera.layers.enable(LABEL_LAYER));
const good = [0, 1].map(() => ({ proj: new Float32Array(16), pose: new Float32Array(16), x: 0, y: 0, width: 0, height: 0 }));
const ease = new ViewerEase(); // glides the eyes when a viewer is found or lost instead of snapping

const corners = [];
for (const x of [X0, X1]) for (const y of [0, 2.6]) for (const z of [Z0, Z1]) corners.push(new THREE.Vector3(x, y, z));

function frameSubject() {
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  depthRoot.scale.set(1, 1, 1);
  scene.position.set(0, 0, 0);
  scene.scale.setScalar(1);
  scene.rotation.set(ELEV, -BASE_AZ, 0, 'XYZ');
  scene.updateMatrix();
  const v = new THREE.Vector3(), lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const p of fitPts) { v.copy(p).applyMatrix4(scene.matrix); lo.min(v); hi.max(v); }
  let z0 = Infinity, z1 = -Infinity;
  for (const p of corners) { v.copy(p).applyMatrix4(scene.matrix); z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z); }
  const s = Math.min((VDH * aspect * 0.96) / (hi.x - lo.x), (VDH * 0.92) / (hi.y - lo.y));
  const glass = new THREE.Vector3(0, 0.8, 0).applyMatrix4(scene.matrix);
  scene.scale.setScalar(s);
  scene.position.set((-s * (lo.x + hi.x)) / 2, (-s * (lo.y + hi.y)) / 2, -s * glass.z);
  subjectDepth = s * (z1 - z0);
  setShadowScale(s);
  applyDepth();
}
function applyDepth() {
  depthRoot.scale.z = Math.min(1, (depth * VDH) / subjectDepth);
}

// SBS backing store: two eyes side by side. Kept no wider than the panel (half a panel per eye is
// what a lenticular delivers anyway), never below half resolution.
function sizeSBS() {
  const dpr = devicePixelRatio || 1;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  const scale = Math.max(0.5, Math.min(1, (screen.width * dpr) / 2 / (cssW * dpr)));
  const ew = Math.round(cssW * dpr * scale), eh = Math.round(cssH * dpr * scale);
  if (canvas.width === ew * 2 && canvas.height === eh) return false; // setSize clears even for equal values
  renderer.setSize(ew * 2, eh, false);
  return true;
}
function resizeWoven() {
  hero.classList.toggle('narrow', hero.clientWidth < 700);
  if (sizeSBS()) { frameSubject(); drawGood(); }
}

function drawGood() {
  renderer.clear();
  if (!haveGood) return; // still present a frame: an undrawn canvas can drop out of the weave
  renderer.setScissorTest(true);
  for (let i = 0; i < 2; i++) {
    const g = good[i];
    renderer.setViewport(g.x, g.y, g.width, g.height);
    renderer.setScissor(g.x, g.y, g.width, g.height);
    eyes[i].setFromMatrices(g.proj, g.pose);
    renderer.render(stage, eyes[i].camera);
  }
  renderer.setScissorTest(false);
}

const ma = new THREE.Matrix4(), mb = new THREE.Matrix4(), pa = new THREE.Vector3(), pb = new THREE.Vector3();
function onFrame(views, layer, frame) {
  step(performance.now());
  // Validate everything before clearing: a short view list or a null viewport is the session's
  // per-frame fallback, and clearing on it is a black blink. Replay the last good frame instead.
  if (!views || views.length < 2 || !layer) return drawGood();
  const vps = [layer.getViewport(views[0]), layer.getViewport(views[1])];
  if (vps.some((vp) => !vp || vp.width <= 0 || vp.height <= 0)) return drawGood();
  cursor?.update(views, { layer });
  for (let i = 0; i < 2; i++) {
    const g = good[i], vp = vps[i];
    g.proj.set(views[i].projectionMatrix);
    g.pose.set(views[i].transform.matrix);
    g.x = vp.x; g.y = vp.y; g.width = vp.width; g.height = vp.height;
  }
  ease.apply(good, frameTrackingState(frame));
  haveGood = true;
  drawGood();
  ma.fromArray(good[0].pose); mb.fromArray(good[1].pose);
  pa.setFromMatrixPosition(ma).add(pb.setFromMatrixPosition(mb)).multiplyScalar(0.5);
  ma.setPosition(pa);
  pickCam.matrixWorld.copy(ma);
  pickCam.matrixWorldInverse.copy(ma).invert();
  pickCam.projectionMatrix.fromArray(good[0].proj);
  pickCam.projectionMatrixInverse.copy(pickCam.projectionMatrix).invert();
  havePickCam = true;
}

const nextFrame = () => new Promise((res) => requestAnimationFrame(res));

async function startWoven() {
  let w;
  try { w = await createInline3D({ lazy: false }); } catch { return; }
  if (!w.supported) return;
  dxr = w;
  woven = true; // stops the flat loop
  cover.hidden = false; // on top of the canvas until the first woven frame; a hard cut, never a fade
  hero.classList.add('woven'); // hides the full-bleed HTML label layer (display: none)
  hero.querySelectorAll('[data-overlay]').forEach((el) => dxr.addGlobalOverlay(el));
  bubbles.slice().forEach(unsay);
  buildLabels3d();
  showLabels3d(true);

  renderer.setPixelRatio(1); // getViewport() is already in backing-store pixels
  renderer.autoClear = false;
  renderer.setClearColor(SKY, 1); // a transparent woven frame comes out black on the panel
  sizeSBS();
  frameSubject();
  renderer.clear();

  // The depth cursor rises over content that comes out of the glass (the street, the front rooms).
  const solids = scene.children.filter((o) => !o.userData.person && o !== labels3d && !o.isLight);
  cursor = new DepthCursor(THREE, { canvas, hitTest: raycastHitTest(THREE, solids), raysPerFrame: 4 });
  stage.add(cursor.object);

  // Settle the canvas for two frames before registering it (rule 4).
  await nextFrame(); await nextFrame();
  handle = dxr.addScene(canvas, onFrame, { virtualDisplayHeight: VDH, rectCover: 'auto', onLayerLost: backToFlat });
  handle.firstWoven.then(() => (cover.hidden = true));
  addEventListener('pagehide', () => dxr.close());

  const slider = document.getElementById('depth');
  slider.value = depth;
  slider.addEventListener('input', () => { depth = Number(slider.value); applyDepth(); });

  // Reading the cards below the hero: put the panel in real 2D for sharp text, and back to 3D when
  // the office scrolls into view (the SDK eases the disparity in and out).
  let stereoOn = true;
  new IntersectionObserver(([e]) => {
    const want = e.intersectionRatio >= 0.25;
    if (want === stereoOn) return;
    stereoOn = want;
    dxr.setStereoEnabled(want).catch(() => {});
  }, { threshold: [0, 0.25, 0.5] }).observe(hero);
}

function backToFlat() {
  woven = false;
  cover.hidden = true;
  hero.classList.remove('woven');
  showLabels3d(false);
  bubbles.slice().forEach(unsay);
  if (cursor) { stage.remove(cursor.object); cursor.dispose(); cursor = null; }
  depthRoot.scale.set(1, 1, 1);
  scene.position.set(0, 0, 0);
  scene.rotation.set(0, 0, 0);
  scene.scale.setScalar(1);
  setShadowScale(1);
  renderer.autoClear = true;
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  startFlat();
}

startFlat();
hero.classList.add('ready');
// Start with a little chatter so the office is already busy on arrival.
people.slice().sort(() => Math.random() - 0.5).slice(0, 3).forEach((p) => say(p));
if (tryWoven) startWoven();
