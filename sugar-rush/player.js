// player.js — the candy apprentice: a small factory helper in a paper hat and apron, built from
// primitives, with a run cycle, a jump pose and squash-and-stretch on landing.

export function createPlayer(THREE) {
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, ...o });
  const skin = std(0xffd9b8), coat = std(0xff7aa8, { roughness: 0.6 }), apron = std(0xfff7f0, { roughness: 0.8 });
  const trousers = std(0x5a2e17), boots = std(0x3a1d0e, { roughness: 0.4 }), hat = std(0xffffff, { roughness: 0.9 });
  const cheek = std(0xff9aa8), dark = std(0x2a1610, { roughness: 0.3 });

  const root = new THREE.Group();          // world position + facing
  const body = new THREE.Group();          // squash/stretch + bob
  root.add(body);

  const mesh = (geo, mat, x = 0, y = 0, z = 0, parent = body) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };

  // Torso, apron, belt.
  mesh(new THREE.CapsuleGeometry(0.28, 0.32, 6, 16), coat, 0, 0.78, 0);
  const ap = mesh(new THREE.CylinderGeometry(0.29, 0.34, 0.42, 16, 1, true, -Math.PI * 0.42, Math.PI * 0.84), apron, 0, 0.68, 0);
  ap.material.side = THREE.DoubleSide;
  mesh(new THREE.TorusGeometry(0.29, 0.035, 8, 24), std(0xffc83d, { metalness: 0.5, roughness: 0.3 }), 0, 0.86, 0).rotation.x = Math.PI / 2;
  // Head, face, hat.
  const head = new THREE.Group();
  head.position.y = 1.32;
  body.add(head);
  mesh(new THREE.SphereGeometry(0.28, 24, 18), skin, 0, 0, 0, head);
  for (const s of [-1, 1]) {
    mesh(new THREE.SphereGeometry(0.045, 10, 8), dark, s * 0.1, 0.03, 0.25, head);
    mesh(new THREE.SphereGeometry(0.05, 10, 8), cheek, s * 0.16, -0.07, 0.22, head).scale.z = 0.4;
  }
  mesh(new THREE.TorusGeometry(0.07, 0.015, 6, 12, Math.PI), dark, 0, -0.1, 0.25, head).rotation.z = Math.PI;   // smile
  mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.16, 20), hat, 0, 0.24, 0, head);
  const puff = mesh(new THREE.SphereGeometry(0.33, 18, 12), hat, 0, 0.42, 0, head);
  puff.scale.y = 0.6;
  // Arms and legs on shoulder/hip pivots so they can swing.
  const limb = (x, y, len, r, mat, endMat, endR) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    body.add(pivot);
    mesh(new THREE.CapsuleGeometry(r, len, 4, 10), mat, 0, -len / 2 - r, 0, pivot);
    mesh(new THREE.SphereGeometry(endR, 12, 10), endMat, 0, -len - r * 2, 0.02, pivot);
    return pivot;
  };
  const armL = limb(-0.36, 1.0, 0.3, 0.08, coat, skin, 0.09);
  const armR = limb(0.36, 1.0, 0.3, 0.08, coat, skin, 0.09);
  const legL = limb(-0.13, 0.5, 0.26, 0.1, trousers, boots, 0.13);
  const legR = limb(0.13, 0.5, 0.26, 0.1, trousers, boots, 0.13);

  let phase = 0, squash = 0;

  return {
    root,
    /** Call once per frame. speed: horizontal m/s; air: in the air; vy: vertical speed. */
    animate(dt, { speed, air, vy, dashing }) {
      const run = Math.min(1, speed / 7.5);
      phase += dt * (4 + run * 9);
      const swing = air ? 0 : Math.sin(phase) * 0.9 * run;
      legL.rotation.x = air ? -0.5 : swing;
      legR.rotation.x = air ? 0.3 : -swing;
      armL.rotation.x = air ? -2.4 + Math.min(0.6, Math.max(-0.6, vy * 0.05)) : -swing * 0.9;
      armR.rotation.x = air ? -2.4 + Math.min(0.6, Math.max(-0.6, vy * 0.05)) : swing * 0.9;
      armL.rotation.z = air ? 0.3 : 0.08;
      armR.rotation.z = air ? -0.3 : -0.08;
      body.rotation.x = dashing ? 0.55 : air ? 0.1 : run * 0.18;
      const bob = air ? 0 : Math.abs(Math.sin(phase)) * 0.06 * run;
      squash += (0 - squash) * Math.min(1, dt * 10);
      const stretch = air ? Math.min(0.15, Math.abs(vy) * 0.012) : 0;
      body.scale.set(1 + squash * 0.25 - stretch * 0.4, 1 - squash * 0.3 + stretch, 1 + squash * 0.25 - stretch * 0.4);
      body.position.y = bob;
      head.rotation.y = Math.sin(phase * 0.5) * 0.08 * run;
    },
    land(strength = 1) { squash = Math.min(1, 0.6 * strength); },
  };
}
