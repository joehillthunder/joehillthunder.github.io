// The world: Lightwheel's kitchen_with_orange scene and SO-101 follower (converted from their USD in
// leisaac_env to GLB, see README), lights, the SimReady asset catalogue, and the views a task env is
// drawn in: the one in the kitchen and the grid of parallel envs used for evaluation.
//
// Two frames: three.js is Y-up; the task runs in the kitchen's USD world frame (Z-up, metres). `usd`
// is a group that maps one to the other, so anything parented to it uses LeIsaac's numbers directly.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildRobot, robotMaterials } from './robot.js';
import { ROBOT_BASE, COUNTER, ORANGE_H } from './task.js';

export const usdToThree = (x, y, z, out = new THREE.Vector3()) => out.set(x, z, -y);

// What the asset panel can point at. `match` finds the node in the kitchen GLB by name.
export const CATALOG = [
  { id: 'orange', name: 'Orange001–003', match: /^lightwheel_orange00\d$/, kind: 'Rigid object', src: 'kitchen_with_orange/objects/Orange00N/Orange00N.usd', note: 'Scanned PBR orange with base-colour and ORM maps and a convex collider. 5.5 cm across. The task randomises each one ±3 cm in x and y.' },
  { id: 'plate', name: 'Plate', match: /^lightwheel_plate$/, kind: 'Rigid object', src: 'kitchen_with_orange/objects/Plate/Plate.usd', note: 'The target. task_done() counts an orange as placed within ±10 cm (x, y) and ±7 cm (z) of its origin.' },
  { id: 'robot', name: 'SO-101 follower', match: /^lightwheel_so101_follower$/, kind: 'Articulation', src: 'robots/so101_follower.usd', note: 'TheRobotStudio SO-101, 6 revolute joints (5 arm + gripper), STS3215 servos. Lightwheel tunes stiffness 17.8 and damping 0.6 per joint for Isaac Lab.' },
  { id: 'counter', name: 'Counter', match: /^counter_main_main_group$/, kind: 'Static fixture', src: 'kitchen_with_orange/scene.usd', note: 'Oak-veneer worktop at z = 0.92 m, OmniPBR material with a projected-UV wood texture.' },
  { id: 'stove', name: 'Gas stove', match: /^stove_main_group$/, kind: 'Articulated fixture', src: 'kitchen_with_orange/scene.usd', note: 'Range with five revolute knobs and an oven door (PhysicsRevoluteJoint), the kind of articulated SimReady fixture LW-BenchHub tasks open and turn.' },
  { id: 'sink', name: 'Sink', match: /^sink_main_group$/, kind: 'Articulated fixture', src: 'kitchen_with_orange/scene.usd', note: 'Concrete sink with a spout and handle joints.' },
  { id: 'fridge', name: 'Fridge', match: /^fridge_main_group$/, kind: 'Articulated fixture', src: 'kitchen_with_orange/scene.usd', note: 'French-door fridge (pack_2) with revolute doors.' },
  { id: 'dishwasher', name: 'Dishwasher', match: /^dishwasher_main_group$/, kind: 'Articulated fixture', src: 'kitchen_with_orange/scene.usd', note: 'Drop-down door and racks.' },
  { id: 'microwave', name: 'Microwave', match: /^microwave_main_group$/, kind: 'Articulated fixture', src: 'kitchen_with_orange/scene.usd', note: 'Over-range microwave with a hinged door.' },
  { id: 'cabinets', name: 'Cabinets', match: /^cab_main_main_group$/, kind: 'Articulated fixture', src: 'kitchen_with_orange/scene.usd', note: 'Procedural cabinet stacks: every door is a revolute joint with limits, every handle a fixed joint.' },
];

export const LIGHTING = [
  { id: 'studio', name: 'Studio', env: 0.9, sun: 2.4, sunColor: 0xfff4e6, hemi: 0.5, exposure: 1.05 },
  { id: 'warm', name: 'Warm evening', env: 0.55, sun: 2.0, sunColor: 0xffc58a, hemi: 0.35, exposure: 1.0 },
  { id: 'cool', name: 'Cool daylight', env: 1.1, sun: 1.6, sunColor: 0xd6e6ff, hemi: 0.6, exposure: 1.1 },
  { id: 'dim', name: 'Dim', env: 0.3, sun: 0.9, sunColor: 0xffffff, hemi: 0.2, exposure: 0.9 },
];

function loadGLB(url, onProgress) {
  return new Promise((res, rej) => new GLTFLoader().load(url, (g) => res(g.scene), (e) => onProgress?.(e.total ? e.loaded / e.total : 0), rej));
}

function partsOf(root) {
  const parts = {};
  root.traverse((o) => { if (o.isMesh) parts[o.name] = o.geometry; });
  return parts;
}

export class World {
  constructor(stage) {
    this.stage = stage;
    this.scene = stage.scene;
    this.usd = new THREE.Group();
    this.usd.name = 'usd-world (Z up)';
    this.usd.rotation.x = -Math.PI / 2;
    this.scene.add(this.usd);
  }

  async load(base, onProgress) {
    const prog = [0, 0, 0];
    const report = () => onProgress?.((prog[0] * 6.7 + prog[1] * 0.9 + prog[2] * 0.4) / 8);
    const [kitchen, robotGlb, lodGlb] = await Promise.all([
      loadGLB(base + 'assets/kitchen.glb', (p) => { prog[0] = p; report(); }),
      loadGLB(base + 'assets/so101.glb', (p) => { prog[1] = p; report(); }),
      loadGLB(base + 'assets/so101-lod.glb', (p) => { prog[2] = p; report(); }),
    ]);
    this.kitchen = kitchen;
    this.parts = partsOf(robotGlb);
    this.lodParts = partsOf(lodGlb);
    kitchen.traverse((o) => { if (o.isMesh) { o.receiveShadow = true; o.castShadow = false; } });
    this.scene.add(kitchen);
    kitchen.updateMatrixWorld(true);

    // pull the task objects out of the scene so the env can move them
    this.objects = {};
    for (const name of ['lightwheel_orange001', 'lightwheel_orange002', 'lightwheel_orange003', 'lightwheel_plate']) {
      const node = kitchen.getObjectByName(name);
      node.parent.remove(node);
      node.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.objects[name] = node;
    }
    this.catalogNodes = {};
    for (const c of CATALOG) {
      const found = [];
      kitchen.traverse((o) => { if (c.match.test(o.name)) found.push(o); });
      this.catalogNodes[c.id] = found;
    }

    this.lights();
    this.main = this.makeEnvView({ lod: false, objects: this.objects });
    this.usd.add(this.main.root);
    this.catalogNodes.orange = this.main.oranges;
    this.catalogNodes.plate = [this.main.plate];
    this.catalogNodes.robot = [this.main.robot.root];
    this.highlight = this.makeHighlight();
    this.scene.add(this.highlight);
    return this;
  }

  lights() {
    const pm = new THREE.PMREMGenerator(this.stage.renderer);
    this.envMap = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envMap;
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x3a3328, 0.5);
    this.scene.add(this.hemi);
    const sun = (this.sun = new THREE.DirectionalLight(0xfff4e6, 2.4));
    const c = usdToThree(2.3, -0.4, 0.92);
    sun.position.set(c.x - 0.6, c.y + 1.6, c.z + 1.1);
    sun.target.position.copy(c);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -0.7, right: 0.7, top: 0.7, bottom: -0.7, near: 0.5, far: 4 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.01;
    this.scene.add(sun, sun.target);
    this.setLighting('studio');
  }

  setLighting(id) {
    const L = LIGHTING.find((l) => l.id === id) || LIGHTING[0];
    this.lighting = L.id;
    this.scene.environmentIntensity = L.env; // three 0.161 ignores this; materials below carry it
    this.kitchen.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if ('envMapIntensity' in m) m.envMapIntensity = L.env; });
    this.sun.intensity = L.sun;
    this.sun.color.setHex(L.sunColor);
    this.hemi.intensity = L.hemi;
    this.stage.renderer.toneMappingExposure = L.exposure;
  }

  /** One task env's visuals: the robot, three oranges and the plate, all in the USD frame. */
  makeEnvView({ lod, objects, mats } = {}) {
    const root = new THREE.Group();
    const robot = buildRobot(lod ? this.lodParts : this.parts, mats || robotMaterials());
    robot.root.matrixAutoUpdate = false;
    robot.root.matrix.copy(ROBOT_BASE);
    root.add(robot.root);
    const src = objects || this.objects;
    const oranges = ['lightwheel_orange001', 'lightwheel_orange002', 'lightwheel_orange003'].map((n) => {
      const o = objects ? src[n] : src[n].clone();
      o.position.set(0, 0, 0);
      root.add(o);
      return o;
    });
    const plate = objects ? src.lightwheel_plate : src.lightwheel_plate.clone();
    root.add(plate);
    // the goal marker: where the policy is reaching
    const goal = new THREE.Mesh(new THREE.SphereGeometry(0.008, 16, 12), new THREE.MeshBasicMaterial({ color: 0x5eead4, transparent: true, opacity: 0.9, depthWrite: false }));
    goal.visible = false;
    root.add(goal);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.0025, 8, 40), new THREE.MeshBasicMaterial({ color: 0x5eead4, transparent: true, opacity: 0.8, depthWrite: false }));
    ring.visible = false;
    root.add(ring);
    return {
      root, robot, oranges, plate, goal, ring,
      update(env, goalPos = null) {
        robot.setMotor(env.motor);
        for (let i = 0; i < 3; i++) {
          const o = oranges[i], p = env.oranges[i].p;
          o.position.set(p.x, p.y, p.z);
          if (env.oranges[i].held) o.quaternion.setFromRotationMatrix(env.tipRot).multiply(env.oranges[i].q);
        }
        plate.position.set(env.plate.x, env.plate.y, env.plate.z);
        goal.visible = !!goalPos;
        ring.visible = !!goalPos;
        if (goalPos) { goal.position.copy(goalPos); ring.position.set(goalPos.x, goalPos.y, COUNTER.z + 0.002); }
      },
    };
  }

  makeHighlight() {
    const h = new THREE.Box3Helper(new THREE.Box3(), 0x5eead4);
    h.visible = false;
    h.material.depthTest = false;
    h.material.transparent = true;
    h.renderOrder = 10;
    return h;
  }

  /** Box around a catalogue entry (three.js world); also returns its centre and size. */
  frameOf(id) {
    const nodes = this.catalogNodes[id] || [];
    const box = new THREE.Box3();
    for (const n of nodes) box.expandByObject(n);
    return box;
  }

  showHighlight(id) {
    if (!id) { this.highlight.visible = false; return; }
    this.highlight.box.copy(this.frameOf(id)).expandByScalar(0.01);
    this.highlight.visible = true;
  }

  /** Which catalogue entry a ray hits first. */
  pick(raycaster) {
    const roots = [];
    for (const [id, nodes] of Object.entries(this.catalogNodes)) for (const n of nodes) roots.push([id, n]);
    let best = null;
    for (const [id, n] of roots) {
      const hit = raycaster.intersectObject(n, true)[0];
      if (hit && (!best || hit.distance < best.d)) best = { id, d: hit.distance };
    }
    return best?.id || null;
  }

  // ---- evaluation grid: parallel envs, as Isaac Lab lays them out ---------------------------------
  buildGrid(n) {
    if (this.grid && this.grid.views.length === n) return this.grid;
    if (this.grid) this.scene.remove(this.grid.group);
    const group = new THREE.Group();
    const usd = new THREE.Group();
    usd.rotation.x = -Math.PI / 2;
    group.add(usd);
    const cols = Math.ceil(Math.sqrt(n)), spacing = 0.62;
    const counterMat = new THREE.MeshStandardMaterial({ color: 0xd8c3a2, roughness: 0.7 });
    const counterTex = this.findMaterial('counter_main_main_group');
    if (counterTex) counterMat.map = counterTex.map;
    const mats = robotMaterials();
    const views = [];
    for (let i = 0; i < n; i++) {
      const cx = (i % cols - (cols - 1) / 2) * spacing, cy = (Math.floor(i / cols) - (Math.ceil(n / cols) - 1) / 2) * spacing;
      const cell = new THREE.Group();
      // shift each env so its work area (around x 2.3, y -0.42) sits on its grid cell
      cell.position.set(cx - 2.3, cy + 0.42, -COUNTER.z);
      const slab = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.56, 0.03), counterMat);
      slab.position.set(2.3, -0.42, COUNTER.z - 0.015);
      slab.receiveShadow = true;
      cell.add(slab);
      const v = this.makeEnvView({ lod: true, mats });
      cell.add(v.root);
      const badge = new THREE.Mesh(new THREE.RingGeometry(0.255, 0.27, 48), new THREE.MeshBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.9 }));
      badge.position.set(2.3, -0.42, COUNTER.z + 0.001);
      cell.add(badge);
      v.badge = badge;
      usd.add(cell);
      views.push(v);
    }
    const floor = new THREE.Mesh(new THREE.CircleGeometry(cols * spacing * 1.2, 64), new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.031;
    group.add(floor);
    const gridLines = new THREE.GridHelper(cols * spacing * 2.2, cols * 8, 0x1e293b, 0x172033);
    gridLines.position.y = -0.03;
    group.add(gridLines);
    group.position.set(0, 0, 40); // far from the kitchen; only one of the two is visible at a time
    group.visible = false;
    this.scene.add(group);
    this.grid = { group, views, cols, spacing, centre: new THREE.Vector3(0, 0.05, 40) };
    return this.grid;
  }

  findMaterial(nodeName) {
    let mat = null;
    this.kitchen.getObjectByName(nodeName)?.traverse((o) => { if (!mat && o.isMesh && o.material?.map) mat = o.material; });
    return mat;
  }

  setMode(mode) {
    this.mode = mode;
    const grid = mode === 'grid';
    this.kitchen.visible = !grid;
    this.usd.visible = !grid;
    if (this.grid) this.grid.group.visible = grid;
    this.sun.castShadow = !grid;
    this.stage.renderer.setClearColor(grid ? 0x070a10 : 0x0b0e14, 1);
  }
}

export { ORANGE_H };
