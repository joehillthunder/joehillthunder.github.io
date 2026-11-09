// Visual end-effector swap on the SO-101: its own parallel jaw, a three-finger hand, or a suction
// cup. Only the look changes: the sim's grasp rule (task.js) is the same for every end effector, so
// this shows the cross-embodiment idea, not contact physics.
//
// Built in the tool frame (robot.tip): the wrist lies toward -z, the fingertips at z = 0.

import * as THREE from 'three';

export const EFFECTORS = [
  { id: 'jaw', name: 'Parallel jaw' },
  { id: 'hand', name: 'Three-finger hand' },
  { id: 'suction', name: 'Suction cup' },
];

const MATS = {
  shell: new THREE.MeshStandardMaterial({ color: 0x2a2540, roughness: 0.45, metalness: 0.3 }),
  pad: new THREE.MeshStandardMaterial({ color: 0x847fea, roughness: 0.6, metalness: 0 }),
  cup: new THREE.MeshStandardMaterial({ color: 0x482bd9, roughness: 0.5, metalness: 0, side: THREE.DoubleSide }),
};

function box(w, h, d, mat) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.castShadow = true; return m; }

function makeHand() {
  const g = new THREE.Group();
  const palm = box(0.044, 0.044, 0.03, MATS.shell);
  palm.position.z = -0.058;
  g.add(palm);
  const fingers = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    const base = new THREE.Group();
    base.position.set(Math.cos(a) * 0.018, Math.sin(a) * 0.018, -0.043);
    base.rotation.z = a; // local +x points outward
    const k1 = new THREE.Group();
    base.add(k1);
    const s1 = box(0.008, 0.012, 0.026, MATS.shell); s1.position.z = 0.013; k1.add(s1);
    const k2 = new THREE.Group(); k2.position.z = 0.026; k1.add(k2);
    const s2 = box(0.008, 0.011, 0.02, MATS.pad); s2.position.z = 0.01; k2.add(s2);
    g.add(base);
    fingers.push({ k1, k2 });
  }
  return {
    group: g,
    set(open) { // open: 0 closed .. 1 open
      for (const f of fingers) { f.k1.rotation.y = 0.15 + open * 0.35 - 0.55 * (1 - open); f.k2.rotation.y = -0.5 * (1 - open) - 0.1; }
    },
  };
}

function makeSuction() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.03, 20), MATS.shell);
  body.rotation.x = Math.PI / 2; body.position.z = -0.06; body.castShadow = true; g.add(body);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.045, 12), MATS.shell);
  rod.rotation.x = Math.PI / 2; rod.position.z = -0.025; g.add(rod);
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.006, 0.012, 24, 1, true), MATS.cup);
  cup.rotation.x = -Math.PI / 2; cup.position.z = -0.002; g.add(cup);
  return { group: g, set(open) { cup.scale.setScalar(1 - (1 - open) * 0.12); } };
}

/** Adds the alternatives to one robot (from buildRobot). Returns { set(kind), update(gripMotor) }. */
export function attachEffectors(robot) {
  const jawParts = [robot.joints[5]];
  robot.links.gripper.traverse((o) => { if (o.isMesh && o.name === 'wrist_roll_follower_so101_v1') jawParts.push(o); });
  const hand = makeHand(), suction = makeSuction();
  robot.tip.add(hand.group, suction.group);
  let kind = 'jaw';
  const api = {
    get kind() { return kind; },
    set(k) {
      kind = k;
      for (const p of jawParts) p.visible = k === 'jaw';
      hand.group.visible = k === 'hand';
      suction.group.visible = k === 'suction';
    },
    update(gripMotor) {
      const open = Math.max(0, Math.min(1, (gripMotor - 10) / 30));
      if (kind === 'hand') hand.set(open);
      if (kind === 'suction') suction.set(open);
    },
  };
  api.set('jaw');
  return api;
}
