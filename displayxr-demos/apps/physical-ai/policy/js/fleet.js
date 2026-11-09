// The fleet: parallel task envs in three settings (kitchen, warehouse, lab), each with its own objects,
// containers and end effector, all driven by the same pretrained policy with a different prompt per
// cell. The sim underneath is the same pick-and-place task; only the look changes per setting.

import * as THREE from 'three';
import { robotMaterials } from './robot.js';
import { COUNTER } from './task.js';
import { attachEffectors } from './effectors.js';

export const THEMES = {
  kitchen: { name: 'Kitchen', slab: 0xd8c3a2, effector: 'jaw', textured: true },
  warehouse: { name: 'Warehouse', slab: 0x3b4256, effector: 'suction' },
  lab: { name: 'Lab', slab: 0xe9e5ff, effector: 'hand' },
};

const M = {
  kraft: new THREE.MeshStandardMaterial({ color: 0xc49a66, roughness: 0.85 }),
  tape: new THREE.MeshStandardMaterial({ color: 0xe9e5ff, roughness: 0.5 }),
  tote: new THREE.MeshStandardMaterial({ color: 0x482bd9, roughness: 0.6 }),
  bin: new THREE.MeshStandardMaterial({ color: 0x5b6275, roughness: 0.7 }),
  glass: new THREE.MeshStandardMaterial({ color: 0xc4bffd, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.55 }),
  liquid: [0x5950e0, 0x22c55e, 0xf59e0b].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.3 })),
  cap: new THREE.MeshStandardMaterial({ color: 0x1b1730, roughness: 0.5 }),
  tray: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45 }),
  rack: new THREE.MeshStandardMaterial({ color: 0x847fea, roughness: 0.5 }),
  bowl: new THREE.MeshStandardMaterial({ color: 0x5950e0, roughness: 0.45, side: THREE.DoubleSide }),
};

const mesh = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m; };

/** An open box (5 sides) in the Z-up frame, base at z = 0. */
function openBox(w, d, h, t, mat) {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(w, d, t), mat, 0, 0, t / 2));
  g.add(mesh(new THREE.BoxGeometry(t, d, h), mat, -w / 2 + t / 2, 0, h / 2), mesh(new THREE.BoxGeometry(t, d, h), mat, w / 2 - t / 2, 0, h / 2));
  g.add(mesh(new THREE.BoxGeometry(w, t, h), mat, 0, -d / 2 + t / 2, h / 2), mesh(new THREE.BoxGeometry(w, t, h), mat, 0, d / 2 - t / 2, h / 2));
  return g;
}

/** A shallow bowl (lathe), Z-up, base at z = 0. */
export function makeBowl(r = 0.058, h = 0.032, mat = M.bowl) {
  const pts = [];
  for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push(new THREE.Vector2(r * (0.45 + 0.55 * Math.sin(t * Math.PI / 2)), h * (1 - Math.cos(t * Math.PI / 2)))); }
  const geo = new THREE.LatheGeometry(pts, 48);
  geo.rotateX(Math.PI / 2);
  const g = new THREE.Group();
  g.add(mesh(geo, mat));
  g.add(mesh(new THREE.CircleGeometry(r * 0.45, 32), mat, 0, 0, 0.001));
  return g;
}

function objectSkin(theme, i) {
  const g = new THREE.Group();
  if (theme === 'warehouse') {
    g.add(mesh(new THREE.BoxGeometry(0.048, 0.048, 0.044), M.kraft, 0, 0, 0.022));
    g.add(mesh(new THREE.BoxGeometry(0.05, 0.012, 0.0455), M.tape, 0, 0, 0.022));
  } else if (theme === 'lab') {
    g.add(mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.05, 20).rotateX(Math.PI / 2), M.glass, 0, 0, 0.025));
    g.add(mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.028, 20).rotateX(Math.PI / 2), M.liquid[i], 0, 0, 0.016));
    g.add(mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.01, 20).rotateX(Math.PI / 2), M.cap, 0, 0, 0.054));
  }
  return g;
}

function containerSkin(theme, which) {
  if (theme === 'warehouse') return which === 0 ? openBox(0.12, 0.12, 0.05, 0.005, M.tote) : openBox(0.11, 0.1, 0.04, 0.005, M.bin);
  if (theme === 'lab') {
    if (which === 0) { const g = openBox(0.12, 0.11, 0.014, 0.004, M.tray); return g; }
    const g = new THREE.Group();
    g.add(mesh(new THREE.BoxGeometry(0.11, 0.1, 0.008), M.rack, 0, 0, 0.004));
    for (let k = 0; k < 4; k++) g.add(mesh(new THREE.TorusGeometry(0.02, 0.003, 8, 24), M.rack, -0.026 + (k % 2) * 0.052, -0.024 + Math.floor(k / 2) * 0.048, 0.03));
    return g;
  }
  return which === 0 ? null : makeBowl(); // kitchen: the real plate + a bowl
}

function labelSprite(text) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(20,14,48,0.86)';
  x.beginPath(); x.roundRect(4, 4, 504, 88, 18); x.fill();
  x.strokeStyle = '#847fea'; x.lineWidth = 3; x.stroke();
  x.fillStyle = '#ffffff'; x.font = '600 40px Campton, "Segoe UI", system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, 256, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  s.scale.set(0.2, 0.0375, 1);
  s.userData = { canvas: c, ctx: x, tex };
  return s;
}
function setLabel(s, text, color = '#847fea') {
  const { ctx: x, tex } = s.userData;
  x.clearRect(0, 0, 512, 96);
  x.fillStyle = 'rgba(20,14,48,0.86)'; x.beginPath(); x.roundRect(4, 4, 504, 88, 18); x.fill();
  x.strokeStyle = color; x.lineWidth = 4; x.stroke();
  x.fillStyle = '#ffffff'; x.font = '600 38px Campton, "Segoe UI", system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, 256, 50);
  tex.needsUpdate = true;
}

/** Builds the fleet group (far from the kitchen; World.setMode-style toggling is done by the caller). */
export function buildFleet(world, cellThemes) {
  const group = new THREE.Group();
  const usd = new THREE.Group();
  usd.rotation.x = -Math.PI / 2;
  group.add(usd);
  const n = cellThemes.length, cols = Math.ceil(Math.sqrt(n)), spacing = 0.64;
  const counterTex = world.findMaterial('counter_main_main_group');
  const mats = robotMaterials();
  const cells = [];
  for (let i = 0; i < n; i++) {
    const theme = cellThemes[i], T = THEMES[theme];
    const cx = (i % cols - (cols - 1) / 2) * spacing, cy = ((Math.ceil(n / cols) - 1) / 2 - Math.floor(i / cols)) * spacing;
    const cell = new THREE.Group();
    cell.position.set(cx - 2.3, cy + 0.42, -COUNTER.z);
    const slabMat = new THREE.MeshStandardMaterial({ color: T.slab, roughness: theme === 'warehouse' ? 0.5 : 0.7, metalness: theme === 'warehouse' ? 0.35 : 0 });
    if (T.textured && counterTex) slabMat.map = counterTex.map;
    const slab = mesh(new THREE.BoxGeometry(0.58, 0.58, 0.03), slabMat, 2.3, -0.42, COUNTER.z - 0.015);
    cell.add(slab);
    if (theme === 'warehouse') { // hazard edge
      const stripe = mesh(new THREE.BoxGeometry(0.58, 0.012, 0.031), new THREE.MeshStandardMaterial({ color: 0xf5c518, roughness: 0.6 }), 2.3, -0.42 + 0.284, COUNTER.z - 0.015);
      cell.add(stripe);
    }
    const v = world.makeEnvView({ lod: true, mats });
    v.plate.scale.setScalar(0.72);
    cell.add(v.root);
    v.effector = attachEffectors(v.robot);
    v.effector.set(T.effector);
    // object and container skins
    const skins = theme === 'kitchen' ? null : [0, 1, 2].map((k) => { const s = objectSkin(theme, k); cell.add(s); return s; });
    if (skins) for (const o of v.oranges) o.visible = false;
    const containers = [containerSkin(theme, 0), containerSkin(theme, 1)];
    if (containers[0]) { v.plate.visible = false; cell.add(containers[0]); }
    if (containers[1]) cell.add(containers[1]);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.27, 0.285, 64), new THREE.MeshBasicMaterial({ color: 0x2a2450, transparent: true, opacity: 0.95 }));
    ring.position.set(2.3, -0.42, COUNTER.z + 0.001);
    cell.add(ring);
    const label = labelSprite(T.name);
    group.add(label);
    usd.add(cell);
    const c = {
      theme, view: v, ring, label, skins, containers, cell,
      update(env, layout) {
        v.update(env, null);
        v.effector.update(env.motor[5]);
        const cs = layout.containers;
        v.plate.position.set(cs[0][0], cs[0][1], COUNTER.z);
        if (containers[0]) containers[0].position.set(cs[0][0], cs[0][1], COUNTER.z);
        if (containers[1]) containers[1].position.set(cs[1][0], cs[1][1], COUNTER.z);
        if (skins) for (let k = 0; k < 3; k++) { skins[k].position.copy(v.oranges[k].position); skins[k].quaternion.copy(v.oranges[k].quaternion); }
      },
      setLabel(text, color) { setLabel(label, text, color); },
      setStatus(color) { ring.material.color.setHex(color); },
    };
    // label floats above the back edge of the cell (three.js frame: usd (x, y, z) -> (x, z, -y))
    label.position.set(cx, 0.07, -cy + 0.27);
    cells.push(c);
  }
  const floor = new THREE.Mesh(new THREE.CircleGeometry(cols * spacing * 1.25, 64), new THREE.MeshStandardMaterial({ color: 0x0d0a1f, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.031;
  group.add(floor);
  group.position.set(0, 0, 40);
  group.visible = false;
  world.scene.add(group);
  return { group, cells, cols, spacing, centre: new THREE.Vector3(0, 0.05, 40) };
}
