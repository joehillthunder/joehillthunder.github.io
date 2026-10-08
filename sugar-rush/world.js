// world.js — the Sugar Rush course: candy platforms, gummy pads, hazards, seals, the fountain.
//
// Everything is built from three.js primitives in code (no external art). World units are
// metres; forward is −Z; the camera follows from behind (+Z), so the course recedes into the
// screen and the player sits on the zero-disparity plane (see DESIGN.md, the depth map).

export const PALETTE = {
  sky: 0x2a1633,
  floor: 0x5a3020,
  mint: 0x9ff0d8,
  pink: 0xff9cc8,
  lilac: 0xb9a4ff,
  lemon: 0xfff1a6,
  sky2: 0x9fd8ff,
  peach: 0xffc79a,
  gummy: 0x3fe0e8,
  saw: 0xff7a59,
  gumball: 0xe8344e,
  gold: 0xffc83d,
  cane: 0xfafafa,
  caneStripe: 0xe8344e,
};

// type: 'plain' | 'gummy' (trampoline) | 'move' (slides on x)
// [x, y, z, width, depth, colour, type, extra]
const PLATFORMS = [
  [0, 0, 0, 7, 10, 'lemon', 'plain'],
  [0, 0.5, -9, 4, 4, 'pink', 'plain'],
  [-3, 1.2, -16, 3.5, 3.5, 'mint', 'plain'],
  [2, 1.6, -22, 3.5, 3.5, 'sky2', 'plain'],
  [0, 1.2, -28, 3, 3, 'lilac', 'gummy'],
  [0, 5.2, -36, 5, 4, 'peach', 'plain'],          // seal 1 (up the gummy pad)
  [-4, 4.6, -43, 3, 3, 'pink', 'move', { range: 2.6, speed: 0.9 }],
  [0, 4.2, -50, 4, 6, 'mint', 'plain'],           // gumball lane
  [4, 4.8, -57, 3, 3, 'lemon', 'plain'],
  [4, 5.4, -63, 3.5, 3.5, 'sky2', 'plain'],       // seal 2
  [0, 5.0, -70, 3, 3, 'pink', 'move', { range: 3.2, speed: 1.2 }],
  [-4, 5.6, -77, 3.5, 3.5, 'lilac', 'plain'],
  [-4, 5.0, -84, 3, 3, 'mint', 'gummy'],
  [-1, 9.4, -92, 4, 4, 'peach', 'plain'],         // seal 3
  [3, 9.0, -99, 3, 5, 'lemon', 'plain'],          // saw gate
  [3, 9.6, -107, 3, 3, 'pink', 'plain'],
  [-1, 9.2, -113, 3, 3, 'sky2', 'move', { range: 2.8, speed: 1.4 }],
  [-4, 9.8, -120, 4, 4, 'mint', 'plain'],         // seal 4
  [0, 9.4, -128, 4, 4, 'lilac', 'plain'],
  [0, 9.4, -138, 9, 9, 'lemon', 'plain'],         // fountain plaza
];

const SEALS = [
  [0, 5.2, -36],
  [4, 5.4, -63],
  [-1, 9.4, -92],
  [-4, 9.8, -120],
];

// spinning saw discs that slide across a gap: [x, y, z, range, speed]
const SAWS = [
  [0, 2.4, -19, 3.0, 1.1],
  [3, 10.3, -99, 1.4, 1.6],
  [0, 10.6, -124, 3.2, 1.3],
];

// gumballs rolling across a platform: [platformIndex, speed]
const GUMBALLS = [
  [7, 1.4],
  [11, 1.8],
];

export const FOUNTAIN = { x: 0, y: 9.4, z: -140 };
export const START = { x: 0, y: 0.01, z: 2 };
export const KILL_Y = -12;

const PLAT_H = 0.8;

export function buildWorld(THREE) {
  const root = new THREE.Group();
  const mat = (hex, extra = {}) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.55, metalness: 0.05, ...extra });

  // lights
  root.add(new THREE.HemisphereLight(0xfff0f6, 0x3a1f2a, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(6, 18, 10);
  root.add(sun);

  // chocolate floor far below, and a soft backdrop of candy towers (deep behind the glass)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mat(PALETTE.floor, { roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -8, -80);
  root.add(floor);

  const backdrop = new THREE.Group();
  for (let i = 0; i < 26; i++) {
    const side = i % 2 ? 1 : -1;
    const x = side * (16 + ((i * 37) % 22));
    const z = -10 - i * 7.5;
    const h = 10 + ((i * 53) % 14);
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.6, h, 16), mat([PALETTE.pink, PALETTE.lilac, PALETTE.mint, PALETTE.peach][i % 4]));
    tower.position.set(x, -8 + h / 2, z);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(1.9, 16, 12), mat([PALETTE.lemon, PALETTE.sky2, PALETTE.pink][i % 3]));
    cap.position.set(x, -8 + h + 0.8, z);
    backdrop.add(tower, cap);
  }
  root.add(backdrop);

  // platforms
  const platforms = PLATFORMS.map(([x, y, z, w, d, col, type, extra], i) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, PLAT_H, d), mat(PALETTE[col]));
    mesh.position.set(x, y - PLAT_H / 2, z);
    root.add(mesh);
    const p = { i, x, y, z, w, d, type, mesh, baseX: x, dx: 0, ...extra };
    if (type === 'gummy') {
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(w, d) * 0.38, Math.min(w, d) * 0.42, 0.25, 24), mat(PALETTE.gummy, { emissive: 0x0d5a5e, roughness: 0.3 }));
      pad.position.y = PLAT_H / 2 + 0.1;
      mesh.add(pad);
      p.pad = pad;
    }
    return p;
  });

  // candy-cane posts along the course edges (the foreground layer that fades near the camera)
  const posts = [];
  // each post stands on the chocolate floor (y = -8) and rises 3 m above the course beside it
  for (let z = 4; z > -136; z -= 9) {
    for (const side of [-1, 1]) {
      const m = new THREE.MeshStandardMaterial({ color: PALETTE.cane, roughness: 0.4, transparent: true });
      const h = 8 + 3 + Math.max(0, (-z / 136) * 9.4);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, h, 12), m);
      post.position.set(side * 8.5, -8 + h / 2, z);
      const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.06, 6, 12), new THREE.MeshStandardMaterial({ color: PALETTE.caneStripe, transparent: true }));
      stripe.rotation.x = Math.PI / 2;
      stripe.position.y = h / 2 - 0.4;
      post.add(stripe);
      root.add(post);
      posts.push(post);
    }
  }

  // seals (collectibles)
  const seals = SEALS.map(([x, y, z], i) => {
    const g = new THREE.Group();
    const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.12, 32), mat(PALETTE.gold, { metalness: 0.6, roughness: 0.25, emissive: 0x4a3200 }));
    coin.rotation.x = Math.PI / 2;
    const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.22), mat(0xfff7d6, { emissive: 0x806a20 }));
    star.position.z = 0.1;
    g.add(coin, star);
    g.position.set(x, y + 1.2, z);
    root.add(g);
    return { i, x, y: y + 1.2, z, mesh: g, taken: false };
  });

  // saws
  const saws = SAWS.map(([x, y, z, range, speed]) => {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.14, 20), mat(PALETTE.saw, { emissive: 0x5a1a08 }));
    disc.rotation.z = Math.PI / 2;
    const swirl = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.07, 6, 20), mat(0xffffff));
    swirl.rotation.y = Math.PI / 2;
    g.add(disc, swirl);
    g.position.set(x, y, z);
    root.add(g);
    return { mesh: g, spin: disc, baseX: x, x, y, z, range, speed, r: 0.75 };
  });

  // gumballs
  const gumballs = GUMBALLS.map(([pi, speed]) => {
    const p = platforms[pi];
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.45, 24, 16), mat(PALETTE.gumball, { roughness: 0.25 }));
    root.add(ball);
    return { mesh: ball, p, speed, t: 0, r: 0.45, x: p.x, y: p.y + 0.45, z: p.z };
  });

  // the Grand Sugar Fountain
  const fountain = new THREE.Group();
  const tiers = [[3.0, 0.8, PALETTE.pink], [2.0, 0.7, PALETTE.mint], [1.2, 0.6, PALETTE.lemon]];
  let fy = 0;
  for (const [r, h, c] of tiers) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.08, h, 32), mat(c));
    t.position.y = fy + h / 2;
    fountain.add(t);
    fy += h;
  }
  const spout = new THREE.Mesh(new THREE.SphereGeometry(0.6, 20, 14), mat(PALETTE.gold, { emissive: 0x6a4a00, metalness: 0.4 }));
  spout.position.y = fy + 0.5;
  fountain.add(spout);
  fountain.position.set(FOUNTAIN.x, FOUNTAIN.y, FOUNTAIN.z);
  root.add(fountain);
  const arch = new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.35, 10, 40, Math.PI), mat(PALETTE.cane));
  arch.position.set(FOUNTAIN.x, FOUNTAIN.y, FOUNTAIN.z - 3.5); // behind the fountain: nothing spans the screen edges in front of the player
  root.add(arch);

  return { root, platforms, posts, seals, saws, gumballs, fountain, spout, PLAT_H };
}

/** Advance moving things. `k` scales hazard speed (difficulty). */
export function updateWorld(w, t, dt, k) {
  for (const p of w.platforms) {
    if (p.type !== 'move') continue;
    const nx = p.baseX + Math.sin(t * p.speed) * p.range;
    p.dx = nx - p.x;
    p.x = nx;
    p.mesh.position.x = nx;
  }
  for (const s of w.saws) {
    s.x = s.baseX + Math.sin(t * s.speed * k) * s.range;
    s.mesh.position.x = s.x;
    s.spin.rotation.x += dt * 9;
  }
  for (const g of w.gumballs) {
    g.t += dt * g.speed * k;
    const half = g.p.w / 2 - g.r;
    g.x = g.p.x + Math.sin(g.t) * half;
    g.z = g.p.z + Math.sin(g.t * 0.5) * (g.p.d / 2 - g.r) * 0.6;
    g.mesh.position.set(g.x, g.y, g.z);
    g.mesh.rotation.z -= Math.cos(g.t) * dt * g.speed * k * 2.2;
  }
  for (const s of w.seals) {
    if (s.taken) continue;
    s.mesh.rotation.y += dt * 2;
    s.mesh.position.y = s.y + Math.sin(t * 2 + s.i) * 0.12;
  }
  w.spout.position.y = 2.6 + Math.sin(t * 3) * 0.12;
}
