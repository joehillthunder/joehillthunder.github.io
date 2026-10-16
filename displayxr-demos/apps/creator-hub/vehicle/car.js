// Procedural concept cars for Vehicle Studio. A body is a side profile extruded across the width
// with a big bevel, then tapered in plan (narrower nose and tail) and tumbled in at the glass.
// Every mesh carries userData.part, which is how the variant system finds paint, glass, rims...
//
// Units are metres; +x is forward, +y up, the car sits on y = 0 centred on the origin.

import * as THREE from 'three';
import { mergeVertices, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export const STYLES = {
  Coupe: {
    len: 4.55, width: 1.94, wb: 2.72, track: 1.64, wheelR: 0.345, clear: 0.24,
    noseH: 0.52, hoodF: 0.72, belt: 0.9, cowl: 0.62, roofF: -0.05, roofR: -0.95, roofH: 1.3, deckX: -1.72, deckH: 0.92, tailH: 0.86,
  },
  Sedan: {
    len: 4.9, width: 1.9, wb: 2.92, track: 1.6, wheelR: 0.34, clear: 0.26,
    noseH: 0.6, hoodF: 0.78, belt: 0.98, cowl: 0.85, roofF: 0.25, roofR: -1.05, roofH: 1.45, deckX: -1.78, deckH: 1.02, tailH: 0.98,
  },
  SUV: {
    len: 4.85, width: 2.0, wb: 2.95, track: 1.68, wheelR: 0.39, clear: 0.34,
    noseH: 0.78, hoodF: 1.0, belt: 1.15, cowl: 1.0, roofF: 0.45, roofR: -2.0, roofH: 1.78, deckX: -2.25, deckH: 1.55, tailH: 1.45,
  },
};

function arch(path, cx, r, y0) {
  path.lineTo(cx - r, y0);
  path.absarc(cx, y0 + 0.02, r, Math.PI, 0, true);
  path.lineTo(cx + r, y0);
}

function lowerShape(S) {
  const L = S.len / 2, wf = S.wb / 2, ar = S.wheelR + 0.07, y0 = S.clear;
  const p = new THREE.Shape();
  p.moveTo(-L + 0.06, y0 + 0.06);
  arch(p, -wf, ar, y0);
  arch(p, wf, ar, y0);
  p.lineTo(L - 0.12, y0);
  p.quadraticCurveTo(L + 0.04, y0 + 0.04, L, S.noseH);
  p.quadraticCurveTo(L - 0.02, S.hoodF, L - 0.35, S.hoodF + 0.03);
  p.quadraticCurveTo(S.roofF + 0.9, S.belt - 0.02, S.roofF + 0.62, S.belt); // hood up to the base of the screen
  p.lineTo(S.deckX + 0.15, S.belt + 0.02);
  p.quadraticCurveTo(-L + 0.1, S.deckH, -L + 0.02, S.tailH);
  p.quadraticCurveTo(-L - 0.04, (S.tailH + y0) / 2, -L + 0.06, y0 + 0.06);
  return p;
}

function glassShape(S) {
  const p = new THREE.Shape();
  p.moveTo(S.roofF + 0.62, S.belt - 0.04);
  p.quadraticCurveTo(S.roofF + 0.3, S.roofH - 0.12, S.roofF, S.roofH);
  p.lineTo(S.roofR, S.roofH);
  p.quadraticCurveTo(S.deckX + 0.35, S.roofH - 0.12, S.deckX + 0.15, S.belt - 0.02);
  p.closePath();
  return p;
}

function roofShape(S) {
  const p = new THREE.Shape();
  p.moveTo(S.roofF + 0.02, S.roofH - 0.02);
  p.lineTo(S.roofR - 0.02, S.roofH - 0.02);
  p.quadraticCurveTo((S.roofF + S.roofR) / 2, S.roofH + 0.05, S.roofF + 0.02, S.roofH - 0.02);
  return p;
}

function extrude(shape, width, bevel, taper) {
  const depth = Math.max(0.05, width - bevel * 2);
  let g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.7, bevelSegments: 6, curveSegments: 28, steps: 1 });
  g.translate(0, 0, -depth / 2);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g.clearGroups();
  g = mergeVertices(g, 1e-4);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    pos.setZ(i, z * taper(x, y));
  }
  g.computeVertexNormals();
  return g;
}

function tire(R, w) {
  const pts = [];
  const r0 = R * 0.66;
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * Math.PI;
    pts.push(new THREE.Vector2(R - 0.035 + Math.sin(a) * 0.035, -w / 2 + (1 - Math.cos(a)) * 0.5 * w));
  }
  pts.unshift(new THREE.Vector2(r0, -w / 2 + 0.01));
  pts.push(new THREE.Vector2(r0, w / 2 - 0.01));
  return new THREE.LatheGeometry(pts, 64).rotateX(Math.PI / 2);
}

function rimGeo(R, w, design) {
  const parts = [];
  const rr = R * 0.66;
  parts.push(new THREE.CylinderGeometry(rr, rr, w * 0.85, 48, 1, true).rotateX(Math.PI / 2)); // barrel
  parts.push(new THREE.TorusGeometry(rr - 0.008, 0.012, 8, 48).translate(0, 0, w * 0.42)); // lip
  parts.push(new THREE.CylinderGeometry(rr * 0.2, rr * 0.22, 0.06, 24).rotateX(Math.PI / 2).translate(0, 0, w * 0.36)); // hub
  const z = w * 0.38;
  const spoke = (a, width, depth, twist = 0, len = rr * 0.85) => {
    const g = new THREE.BoxGeometry(len, width, depth);
    g.translate(len / 2 + rr * 0.12, 0, 0);
    g.rotateX(twist);
    g.rotateZ(a);
    g.translate(0, 0, z);
    parts.push(g);
  };
  if (design === 'Five-spoke') for (let i = 0; i < 5; i++) spoke((i / 5) * Math.PI * 2, 0.07, 0.035);
  else if (design === 'Multi-spoke') for (let i = 0; i < 10; i++) spoke((i / 10) * Math.PI * 2, 0.026, 0.03);
  else if (design === 'Turbine') for (let i = 0; i < 14; i++) spoke((i / 14) * Math.PI * 2, 0.05, 0.012, 0.9);
  else if (design === 'Mesh') {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      spoke(a + 0.18, 0.018, 0.025);
      spoke(a - 0.18, 0.018, 0.025);
    }
  } else if (design === 'Aero disc') {
    parts.push(new THREE.CylinderGeometry(rr * 0.97, rr * 0.97, 0.02, 48).rotateX(Math.PI / 2).translate(0, 0, z));
    for (let i = 0; i < 5; i++) spoke((i / 5) * Math.PI * 2, 0.05, 0.03, 0, rr * 0.5); // vents
  }
  return mergeGeometries(parts.map((g) => { g.deleteAttribute('uv'); return g.index ? g.toNonIndexed() : g; }));
}

/** Build a car. Returns a Group whose meshes are tagged with userData.part. */
export function buildCar(styleName, mats, opts = {}) {
  const S = STYLES[styleName];
  const car = new THREE.Group();
  car.name = `${styleName} concept`;
  const L = S.len / 2, W = S.width;
  const tag = (m, part, name) => { m.userData.part = part; m.name = name || part; m.castShadow = true; m.receiveShadow = true; return m; };

  // Plan taper: narrower nose and tail; tumblehome above the belt line.
  const plan = (x) => 1 - 0.13 * smooth(L - 0.9, L + 0.05, x) - 0.1 * smooth(-L + 0.8, -L - 0.05, x);
  const body = extrude(lowerShape(S), W, 0.16, (x, y) => plan(x) * (1 - 0.05 * smooth(S.clear + 0.3, S.clear, y)));
  car.add(tag(new THREE.Mesh(body, mats.paint), 'paint', 'Body'));

  const gw = W * 0.86;
  const tumble = (x, y) => plan(x) * (1 - 0.22 * smooth(S.belt, S.roofH, y));
  car.add(tag(new THREE.Mesh(extrude(glassShape(S), gw, 0.12, tumble), mats.glass), 'glass', 'Glass'));
  const roof = new THREE.Mesh(extrude(roofShape(S), gw * 0.84, 0.06, (x) => plan(x)), mats.paint);
  roof.position.y = 0.012;
  car.add(tag(roof, 'paint', 'Roof'));

  // Lights
  const head = new THREE.BoxGeometry(0.1, 0.06, 0.42);
  for (const s of [-1, 1]) {
    const h = new THREE.Mesh(head, mats.headlight);
    h.position.set(L - 0.12, S.noseH + 0.06, s * (W / 2 - 0.36));
    h.rotation.z = -0.5;
    h.rotation.y = s * 0.25;
    car.add(tag(h, 'headlight', 'Headlight'));
  }
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, W * 0.8), mats.taillight);
  tail.position.set(-L + 0.04, S.tailH - 0.04, 0);
  car.add(tag(tail, 'taillight', 'Tail light bar'));

  // Grille, diffuser, mirrors, exhausts
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, W * 0.5), mats.trim);
  grille.position.set(L - 0.02, S.clear + 0.14, 0);
  car.add(tag(grille, 'trim', 'Grille'));
  const diff = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, W * 0.7), mats.trim);
  diff.position.set(-L + 0.18, S.clear + 0.02, 0);
  car.add(tag(diff, 'trim', 'Diffuser'));
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.14), mats.paint);
    m.position.set(S.roofF + 0.45, S.belt + 0.1, s * (W / 2 - 0.02));
    car.add(tag(m, 'paint', 'Mirror'));
    const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.14, 20, 1, true).rotateZ(Math.PI / 2), mats.chrome);
    ex.position.set(-L - 0.01, S.clear + 0.08, s * 0.42);
    car.add(tag(ex, 'chrome', 'Exhaust'));
  }

  // Interior: seats, dash, wheel (seen through the glass)
  const seatX = (S.roofF + S.roofR) / 2 + 0.05;
  for (const s of [-1, 1]) {
    const cushion = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.48), mats.interior);
    cushion.position.set(seatX, S.belt - 0.38, s * 0.38);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.62, 0.48), mats.interior);
    back.position.set(seatX - 0.26, S.belt - 0.08, s * 0.38);
    back.rotation.z = 0.2;
    car.add(tag(cushion, 'interior', 'Seat'), tag(back, 'interior', 'Seat back'));
  }
  const dash = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, W * 0.72), mats.interior);
  dash.position.set(S.roofF + 0.42, S.belt - 0.1, 0);
  car.add(tag(dash, 'interior', 'Dashboard'));
  const sw = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.022, 10, 36), mats.trim);
  sw.position.set(S.roofF + 0.18, S.belt - 0.02, -0.38);
  sw.rotation.y = Math.PI / 2;
  sw.rotation.x = 0.0;
  sw.rotation.z = 0.35;
  car.add(tag(sw, 'trim', 'Steering wheel'));

  // Wheels
  const wheels = new THREE.Group();
  wheels.name = 'Wheels';
  const R = S.wheelR * (opts.wheelScale ?? 1), tw = 0.26;
  const tireG = tire(R, tw), rimG = rimGeo(R, tw, opts.rim ?? 'Five-spoke');
  const disc = new THREE.CylinderGeometry(R * 0.55, R * 0.55, 0.03, 32).rotateX(Math.PI / 2);
  for (const [x, s, name] of [[S.wb / 2, 1, 'FL'], [S.wb / 2, -1, 'FR'], [-S.wb / 2, 1, 'RL'], [-S.wb / 2, -1, 'RR']]) {
    const w = new THREE.Group();
    w.name = 'Wheel ' + name;
    w.position.set(x, R, s * (S.track / 2));
    const inner = new THREE.Group(); // spins
    inner.add(tag(new THREE.Mesh(tireG, mats.rubber), 'rubber', 'Tire'));
    inner.add(tag(new THREE.Mesh(rimG, mats.rim), 'rim', 'Rim'));
    if (s < 0) inner.rotation.y = Math.PI; // the face points outward on both sides
    const d = tag(new THREE.Mesh(disc, mats.brake), 'brake', 'Brake disc');
    d.position.z = -s * 0.02;
    const cal = tag(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.16, 0.08), mats.caliper), 'caliper', 'Caliper');
    cal.position.set(-0.14 * Math.sign(x), 0.1, s * 0.01);
    w.add(inner, d, cal);
    w.userData.spin = inner;
    wheels.add(w);
  }
  car.add(wheels);
  car.userData.wheels = wheels;
  car.userData.style = styleName;
  car.userData.dims = S;
  return car;
}
