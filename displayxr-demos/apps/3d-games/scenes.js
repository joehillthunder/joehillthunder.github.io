// Four interactive three.js dioramas, one per woven tile: the landing page's controller and one
// set piece each for Tekken 8, Elden Ring and Diablo III. They are original low-poly tributes,
// not game assets: nothing here is ripped, traced or licensed from the games.
//
// Authored in "u" units and scaled by S into metres for a 0.24 m virtual display (the SDK
// default), so the glass is about 4 u tall. z = 0 is the glass, +z is out toward the viewer.
// Content stays within about +1 u in front and -1 u behind, which is comfortable at the display
// rig's natural depth.
//
// Each builder returns:
//   group          the scene root (the tile wraps it in a drag turntable)
//   update(t, dt)  per frame
//   status()       caption text
//   pick           objects a tap can hit (optional)
//   tap(hit)       a raycast hit on one of them (optional)
//   actions        [{ label: () => string, run() }] rendered as buttons under the tile (optional)
// Every scene plays on its own when nobody touches it and goes back to that after ~10 s idle.

export const S = 0.06;              // 1 u = 6 cm
export const BG = 0x0c0b12;         // tile clear colour, matches --tile in style.css

const IDLE = 10;                    // seconds without input before a scene resumes its loop

// ---- helpers -------------------------------------------------------------------------------

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => { const x = clamp((v - a) / (b - a)); return x * x * (3 - 2 * x); };
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const rand = (a, b) => a + Math.random() * (b - a);

function lights(THREE, group, { sky = 0xd8d4ff, ground = 0x120e18, key = 0xffffff, k = 2 } = {}) {
  const hemi = new THREE.HemisphereLight(sky, ground, 1.2);
  const dir = new THREE.DirectionalLight(key, k);
  dir.position.set(0.15, 0.3, 0.4);
  group.add(hemi, dir);
  return { hemi, dir };
}

function root(THREE, group) {
  const r = new THREE.Group();
  r.scale.setScalar(S);
  group.add(r);
  return r;
}

function idleClock() {
  let last = -1e9, now = 0;
  return {
    tick(t) { now = t; },
    poke() { last = now; },
    get now() { return now; },
    get idle() { return now - last > IDLE; },
  };
}

const matCache = new Map();
function mat(THREE, color, { metal = 0.1, rough = 0.6, emissive = 0, ei = 0 } = {}) {
  const key = [color, metal, rough, emissive, ei].join();
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial({
      color, metalness: metal, roughness: rough, emissive, emissiveIntensity: ei, flatShading: true,
    }));
  }
  return matCache.get(key);
}

function box(THREE, w, h, d, m, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z);
  return o;
}

// The shared radial-gradient texture, for sprites and point clouds.
function glowMap(THREE) { if (!glowTex) glow(THREE, 0xffffff, 1); return glowTex; }

// A soft additive glow: a sprite with a radial gradient, shared texture.
let glowTex = null;
function glow(THREE, color, size) {
  if (!glowTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    glowTex = new THREE.CanvasTexture(c);
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  s.scale.setScalar(size);
  return s;
}

// A blocky fighter: hips, torso, head, two arms (upper + fore) and two legs. Joints are groups so
// a pose is a handful of rotations. Faces +x; flip with scale.x = -1 for the other side.
function fighter(THREE, { skin, top, legs, belt }) {
  const g = new THREE.Group();
  const mSkin = mat(THREE, skin, { rough: 0.7 });
  const mTop = mat(THREE, top, { rough: 0.5 });
  const mLeg = mat(THREE, legs, { rough: 0.8 });
  const mBelt = mat(THREE, belt, { rough: 0.4, metal: 0.3 });
  const hips = new THREE.Group(); hips.position.y = 1.0; g.add(hips);
  hips.add(box(THREE, 0.5, 0.18, 0.32, mBelt));
  const torso = new THREE.Group(); hips.add(torso);
  torso.add(box(THREE, 0.56, 0.7, 0.34, mTop, 0, 0.44, 0));
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 1), mSkin);
  head.position.set(0.02, 0.98, 0); torso.add(head);
  const limb = (parent, x, y, len, w, m, m2) => {
    const upper = new THREE.Group(); upper.position.set(x, y, 0); parent.add(upper);
    upper.add(box(THREE, w, len, w, m, 0, -len / 2, 0));
    const lower = new THREE.Group(); lower.position.y = -len; upper.add(lower);
    lower.add(box(THREE, w * 0.9, len, w * 0.9, m2, 0, -len / 2, 0));
    return { upper, lower };
  };
  const armF = limb(torso, 0, 0.72, 0.32, 0.15, mTop, mSkin);
  armF.upper.position.z = 0.24;
  const armB = limb(torso, 0, 0.72, 0.32, 0.15, mTop, mSkin);
  armB.upper.position.z = -0.24;
  const fistF = box(THREE, 0.17, 0.17, 0.17, mSkin, 0, -0.34, 0); armF.lower.add(fistF);
  armB.lower.add(box(THREE, 0.17, 0.17, 0.17, mSkin, 0, -0.34, 0));
  const legF = limb(hips, 0, -0.05, 0.48, 0.2, mLeg, mLeg); legF.upper.position.z = 0.12;
  const legB = limb(hips, 0, -0.05, 0.48, 0.2, mLeg, mLeg); legB.upper.position.z = -0.12;
  return { g, hips, torso, head, armF, armB, legF, legB, fistF };
}

// ---- landing hero: a controller with the three featured games orbiting it -------------------

function arcade(THREE, motion) {
  const group = new THREE.Group();
  lights(THREE, group);
  const r = root(THREE, group);
  const clock = idleClock();

  const pad = new THREE.Group();
  pad.position.set(0, -0.15, 0.25);
  r.add(pad);
  const shell = mat(THREE, 0x22202c, { rough: 0.35, metal: 0.2 });
  pad.add(box(THREE, 2.2, 0.9, 0.4, shell));
  for (const s of [-1, 1]) {
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.34, 0.4, 18), shell);
    grip.rotation.x = Math.PI / 2;
    grip.position.set(s * 1.05, -0.28, 0);
    pad.add(grip);
  }
  // D-pad
  const dm = mat(THREE, 0x0e0d14, { rough: 0.4 });
  pad.add(box(THREE, 0.42, 0.13, 0.08, dm, -0.68, 0.08, 0.23), box(THREE, 0.13, 0.42, 0.08, dm, -0.68, 0.08, 0.23));
  // Face buttons
  const buttons = [];
  const cols = [0x4ade80, 0xf87171, 0x60a5fa, 0xfacc15];
  const at = [[0.68, -0.12], [0.88, 0.08], [0.48, 0.08], [0.68, 0.28]];
  at.forEach(([x, y], i) => {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.1, 16), mat(THREE, cols[i], { rough: 0.25, emissive: cols[i], ei: 0.25 }));
    b.rotation.x = Math.PI / 2;
    b.position.set(x, y, 0.24);
    b.userData = { press: -1, i, z: 0.24 };
    pad.add(b);
    buttons.push(b);
  });
  for (const s of [-1, 1]) {
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.16, 16), dm);
    stick.rotation.x = Math.PI / 2;
    stick.position.set(s * 0.3, -0.22, 0.26);
    pad.add(stick);
  }

  // Emblems: a fist (fighting), a golden tree (open world), a flame (dungeon crawl).
  const emblems = [];
  const fist = new THREE.Group();
  const fm = mat(THREE, 0xef4444, { rough: 0.4, emissive: 0x7f1d1d, ei: 0.4 });
  fist.add(box(THREE, 0.5, 0.42, 0.36, fm));
  for (let i = 0; i < 4; i++) fist.add(box(THREE, 0.11, 0.14, 0.12, fm, -0.18 + i * 0.12, 0.25, 0.1));
  fist.add(box(THREE, 0.16, 0.26, 0.14, fm, -0.3, 0.02, 0.12));
  emblems.push(fist);
  const tree = new THREE.Group();
  const gold = mat(THREE, 0xf5c451, { metal: 0.6, rough: 0.3, emissive: 0xb7791f, ei: 0.5 });
  tree.add(box(THREE, 0.1, 0.6, 0.1, gold, 0, -0.1, 0));
  const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 0), gold);
  crown.position.y = 0.3; tree.add(crown);
  tree.add(glow(THREE, 0xffd27a, 1.3));
  emblems.push(tree);
  const flame = new THREE.Group();
  const fl = mat(THREE, 0xfb923c, { rough: 0.4, emissive: 0xc2410c, ei: 0.8 });
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.2 - i * 0.04, 0.6 - i * 0.12, 7), fl);
    c.position.set((i - 1) * 0.12, 0.05 + (i === 1 ? 0.1 : 0), 0);
    flame.add(c);
  }
  flame.add(glow(THREE, 0xff6a2a, 1.2));
  emblems.push(flame);
  emblems.forEach((e) => r.add(e));

  const sparks = [];
  let pressed = 0;
  return {
    group,
    pick: buttons,
    update(t, dt) {
      clock.tick(t);
      pad.rotation.y = motion * 0.22 * Math.sin(t * 0.4);
      pad.rotation.x = -0.15 + motion * 0.05 * Math.sin(t * 0.33);
      emblems.forEach((e, i) => {
        const a = t * 0.45 * (motion || 0.0001) + i * (Math.PI * 2 / 3);
        e.position.set(Math.cos(a) * 2.1, 0.75 + Math.sin(a * 2) * 0.12, Math.sin(a) * 0.75);
        e.rotation.y = t * 0.8 * motion;
      });
      for (const b of buttons) {
        const p = b.userData.press < 0 ? 1 : clamp((t - b.userData.press) / 0.3);
        b.position.z = b.userData.z - Math.sin(p * Math.PI) * 0.06;
      }
      if (clock.idle && motion && Math.random() < dt * 0.6) this.press(buttons[Math.floor(Math.random() * 4)], t);
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        const k = (t - s.userData.t0) / 0.7;
        if (k >= 1) { pad.remove(s); sparks.splice(i, 1); continue; }
        s.position.z = 0.3 + k * 0.7;
        s.material.opacity = 1 - k;
        s.scale.setScalar(0.3 + k * 0.6);
      }
    },
    press(b, t) {
      b.userData.press = t;
      const s = glow(THREE, cols[b.userData.i], 0.3);
      s.position.set(b.position.x, b.position.y, 0.3);
      s.userData.t0 = t;
      pad.add(s); sparks.push(s);
    },
    tap(hit) {
      clock.poke();
      pressed++;
      this.press(hit.object, clock.now);
    },
    status: () => (pressed ? `${pressed} button press${pressed === 1 ? '' : 'es'} · each spark flies out of the glass` : 'Drag to turn the controller · tap a face button'),
  };
}

// ---- Tekken 8: two fighters trading blows on a stage, health bars floating at the glass ----

function tekken(THREE, motion) {
  const group = new THREE.Group();
  lights(THREE, group, { sky: 0xffd9c7, ground: 0x1a0d10, k: 2.4 });
  const r = root(THREE, group);
  const clock = idleClock();

  // Stage: a round platform tilted toward the viewer, with a glowing rim and a sunset backdrop.
  const stage = new THREE.Group();
  stage.position.set(0, -1.35, -0.2);
  r.add(stage);
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.5, 0.2, 40), mat(THREE, 0x2a2430, { rough: 0.85 }));
  stage.add(floor);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(2.42, 0.04, 8, 64), mat(THREE, 0xff7a3d, { emissive: 0xff5a1f, ei: 1.2 }));
  rim.rotation.x = Math.PI / 2; rim.position.y = 0.1;
  stage.add(rim);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const tile = box(THREE, 0.9, 0.02, 0.9, mat(THREE, i % 2 ? 0x3a3140 : 0x332a38, { rough: 0.9 }), Math.cos(a) * 1.3, 0.11, Math.sin(a) * 1.3 * 0.6);
    tile.rotation.y = -a;
    stage.add(tile);
  }
  const sun = glow(THREE, 0xff8a4c, 5.5);
  sun.position.set(0, 0.9, -1.4);
  r.add(sun);
  // Distant pillars, far behind the stage, for depth.
  const pm = mat(THREE, 0x2c1e2b, { rough: 0.9 });
  for (let i = 0; i < 7; i++) {
    const h = rand(1.4, 2.8);
    r.add(box(THREE, 0.3, h, 0.3, pm, -3 + i, -1.3 + h / 2, -1.0 - (i % 2) * 0.15));
  }

  const P = [
    fighter(THREE, { skin: 0xd6a37c, top: 0xb91c1c, legs: 0x1f2937, belt: 0xfacc15 }),
    fighter(THREE, { skin: 0xc68a63, top: 0x1d4ed8, legs: 0xe5e7eb, belt: 0x111827 }),
  ];
  const names = ['Red', 'Blue'];
  const state = P.map((p, i) => ({
    x: i ? 0.7 : -0.7, hp: 1, hpShown: 1, punch: -9, hurt: -9, side: i ? -1 : 1, wins: 0, combo: 0,
  }));
  P.forEach((p, i) => {
    p.g.scale.set(state[i].side * 0.9, 0.9, 0.9);
    p.g.position.set(state[i].x, -1.25, 0.05);
    r.add(p.g);
  });

  // Health bars: a HUD that floats just in front of the glass, the depth great 3D games give it.
  const hud = new THREE.Group();
  hud.position.set(0, 1.55, 0.55);
  r.add(hud);
  const bars = state.map((s, i) => {
    const back = box(THREE, 1.9, 0.14, 0.06, mat(THREE, 0x18151f, { rough: 0.6 }), (i ? 1 : -1) * 1.1, 0, 0);
    const fill = box(THREE, 1.9, 0.14, 0.08, mat(THREE, i ? 0x60a5fa : 0xf87171, { emissive: i ? 0x1d4ed8 : 0xb91c1c, ei: 0.6 }), 0, 0, 0.02);
    const pivot = new THREE.Group();
    pivot.position.set(i ? 0.15 : -0.15, 0, 0);
    fill.position.x = (i ? 1 : -1) * 0.95;
    pivot.add(fill);
    hud.add(back, pivot);
    return pivot;
  });
  const timer = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), mat(THREE, 0xfacc15, { emissive: 0xca8a04, ei: 0.8 }));
  hud.add(timer);

  const sparks = [];
  let nextAI = 1, round = 1, lastHit = '', koAt = -1;
  const hitSpark = (x, y, t, big) => {
    const s = glow(THREE, big ? 0xfff1a8 : 0xffc06b, 0.4);
    s.position.set(x, y, 0.35);
    s.userData = { t0: t, big };
    r.add(s); sparks.push(s);
  };
  const attack = (i, t) => {
    const a = state[i], b = state[1 - i];
    if (koAt > 0 || t - a.punch < 0.32) return false;
    a.punch = t;
    const reach = Math.abs(a.x - b.x) < 1.25;
    if (reach) {
      a.combo = t - a.lastLand < 0.9 ? a.combo + 1 : 1;
      a.lastLand = t;
      const dmg = 0.06 + Math.min(a.combo, 5) * 0.012;
      b.hp = Math.max(0, b.hp - dmg);
      b.hurt = t;
      b.x = clamp(b.x - b.side * 0.12, -1.9, 1.9);
      hitSpark((a.x + b.x) / 2, -0.15, t, a.combo >= 3);
      lastHit = a.combo >= 2 ? `${names[i]} · ${a.combo}-hit combo` : `${names[i]} lands a jab`;
      if (b.hp <= 0) { koAt = t; a.wins++; lastHit = `K.O. · ${names[i]} takes round ${round}`; }
    } else {
      a.x = clamp(a.x + a.side * 0.25, -1.9, 1.9);   // whiff: step in
    }
    return true;
  };

  const pose = (p, s, t, motionK) => {
    const bob = Math.sin(t * 5 + s.side) * 0.03 * motionK;
    p.hips.position.y = 1.0 + bob;
    const pk = clamp((t - s.punch) / 0.28);
    const ext = pk < 1 ? Math.sin(pk * Math.PI) : 0;
    const hk = clamp((t - s.hurt) / 0.4);
    const recoil = hk < 1 ? Math.sin(hk * Math.PI) : 0;
    p.torso.rotation.z = -0.12 + ext * -0.2 + recoil * 0.35;
    p.head.rotation.z = recoil * 0.4;
    // Guard up; the lead arm snaps forward on a punch.
    p.armF.upper.rotation.z = -1.3 - ext * 0.5;
    p.armF.lower.rotation.z = 1.9 - ext * 1.9;
    p.armB.upper.rotation.z = -0.9;
    p.armB.lower.rotation.z = 2.2;
    p.legF.upper.rotation.z = -0.35;
    p.legF.lower.rotation.z = 0.25;
    p.legB.upper.rotation.z = 0.3;
    p.legB.lower.rotation.z = 0.3;
  };

  return {
    group,
    pick: P.map((p) => p.g),
    update(t, dt) {
      clock.tick(t);
      // Gentle stage sway so the depth reads even before anyone touches it.
      stage.rotation.y = motion * 0.1 * Math.sin(t * 0.25);
      timer.rotation.y = t * 2;
      if (koAt > 0 && t - koAt > 2.4) {
        koAt = -1; round++;
        state.forEach((s, i) => { s.hp = 1; s.x = i ? 0.7 : -0.7; s.combo = 0; });
        lastHit = `Round ${round} · fight`;
      }
      // The CPU side (and both sides when idle) presses forward and throws strings.
      if (t > nextAI) {
        const who = clock.idle ? (Math.random() < 0.5 ? 0 : 1) : 1;
        const s = state[who], o = state[1 - who];
        if (Math.abs(s.x - o.x) > 1.1) s.x = clamp(s.x + s.side * 0.2, -1.9, 1.9);
        else attack(who, t);
        nextAI = t + (clock.idle ? rand(0.25, 0.7) : rand(0.5, 1.1));
      }
      P.forEach((p, i) => {
        const s = state[i];
        p.g.position.x = damp(p.g.position.x, s.x, 10, dt);
        const down = koAt > 0 && s.hp <= 0 ? smooth(0, 0.6, t - koAt) : 0;
        p.g.rotation.z = -s.side * down * 1.4;
        p.g.position.y = -1.25 - down * 0.15;
        pose(p, s, t, motion);
        s.hpShown = damp(s.hpShown, s.hp, 6, dt);
        bars[i].scale.x = Math.max(0.001, s.hpShown);
      });
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        const k = (t - s.userData.t0) / (s.userData.big ? 0.55 : 0.35);
        if (k >= 1) { r.remove(s); sparks.splice(i, 1); continue; }
        s.scale.setScalar((s.userData.big ? 1.6 : 0.9) * (0.3 + k));
        s.position.z = 0.35 + k * (s.userData.big ? 0.6 : 0.3);
        s.material.opacity = 1 - k;
      }
    },
    tap(hit) {
      clock.poke();
      let o = hit.object;
      while (o && !P.some((p) => p.g === o)) o = o.parent;
      const i = P.findIndex((p) => p.g === o);
      // Tap Red to attack; tapping Blue sends Red stepping in to hit Blue.
      attack(0, clock.now) || (i === 1 && (state[0].x = clamp(state[0].x + 0.2, -1.9, 1.9)));
    },
    actions: [
      { label: () => 'Throw a jab', run() { clock.poke(); attack(0, clock.now); } },
      {
        label: () => 'Rage Art',
        run() {
          clock.poke();
          const t = clock.now;
          state[0].x = clamp(state[1].x - 0.9, -1.9, 1.9);
          for (let k = 0; k < 5; k++) setTimeout(() => { state[0].punch = -9; attack(0, clock.now); }, k * 140);
          hitSpark(0, 0.2, t, true);
        },
      },
    ],
    status: () => {
      const w = state.map((s) => s.wins).join(' – ');
      return lastHit ? `${lastHit} · rounds ${w}` : 'Tap Red or press Throw a jab · the health bars float at the glass';
    },
  };
}

// ---- Elden Ring: a golden tree on the horizon, a site of grace and a lone knight ------------

function elden(THREE, motion) {
  const group = new THREE.Group();
  const L = lights(THREE, group, { sky: 0xffe7b0, ground: 0x15121a, key: 0xfff0d0, k: 1.8 });
  const r = root(THREE, group);
  const clock = idleClock();

  // Layered hills, each further back: the parallax that makes open worlds sing in 3D.
  const hills = [];
  const hillCols = [0x4f4a30, 0x3e3c32, 0x302e36, 0x23222e];
  hillCols.forEach((c, i) => {
    const shape = new THREE.Shape();
    shape.moveTo(-4, -2.2);
    for (let x = -4; x <= 4.01; x += 0.5) shape.lineTo(x, -1.4 + i * 0.28 + Math.sin(x * 1.3 + i * 2) * 0.18 + Math.sin(x * 0.6 + i) * 0.22);
    shape.lineTo(4, -2.2);
    const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat(THREE, c, { rough: 1 }));
    m.position.z = 0.4 - i * 0.45;
    r.add(m);
    hills.push(m);
  });

  // The tree: a gnarled trunk and a canopy of glowing gold blobs, far behind the glass.
  const tree = new THREE.Group();
  tree.position.set(0.6, -1.0, -1.05);
  r.add(tree);
  const bark = mat(THREE, 0xc99a3a, { metal: 0.4, rough: 0.4, emissive: 0x8a5a12, ei: 0.6 });
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.28, 2.0, 7), bark);
  trunk.position.y = 1.0; tree.add(trunk);
  for (let i = 0; i < 5; i++) {
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.07, 0.9, 5), bark);
    br.position.set((i - 2) * 0.18, 1.8 + Math.abs(i - 2) * -0.1, 0);
    br.rotation.z = (i - 2) * -0.45;
    tree.add(br);
  }
  const leafMat = mat(THREE, 0xffd56a, { metal: 0.3, rough: 0.35, emissive: 0xf0a420, ei: 0.9 });
  const canopy = new THREE.Group();
  canopy.position.y = 2.3;
  tree.add(canopy);
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random());
    const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(rand(0.18, 0.34), 0), leafMat);
    blob.position.set(Math.cos(a) * rr * 1.25, Math.sin(a) * rr * 0.55, rand(-0.25, 0.25));
    canopy.add(blob);
  }
  const halo = glow(THREE, 0xffc44d, 4.2);
  halo.position.y = 2.2;
  tree.add(halo);

  // Falling golden leaves drift from the canopy out past the glass toward the viewer.
  const N = 140;
  const leafGeo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3);
  const vel = new Float32Array(N * 3);
  const resetLeaf = (i, burst) => {
    pos[i * 3] = 0.6 + rand(-1.3, 1.3);
    pos[i * 3 + 1] = rand(0.9, 1.7);
    pos[i * 3 + 2] = -1.05 + rand(-0.2, 0.2);
    vel[i * 3] = rand(-0.12, 0.12) + (burst ? rand(-0.5, 0.5) : 0);
    vel[i * 3 + 1] = rand(-0.25, -0.12);
    vel[i * 3 + 2] = rand(0.18, 0.4) + (burst ? 0.4 : 0);
  };
  for (let i = 0; i < N; i++) { resetLeaf(i); pos[i * 3 + 1] = rand(-1.8, 1.7); pos[i * 3 + 2] = rand(-1.1, 0.9); }
  leafGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const leaves = new THREE.Points(leafGeo, new THREE.PointsMaterial({
    color: 0xffd16b, size: 0.01, map: glowMap(THREE), transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  r.add(leaves);

  // Site of grace: a small golden flare on the near hill with motes spiralling up.
  const grace = new THREE.Group();
  grace.position.set(-1.35, -1.25, 0.45);
  r.add(grace);
  const flare = glow(THREE, 0xffe08a, 0.7);
  flare.position.y = 0.15;
  grace.add(flare);
  const graceCore = new THREE.Mesh(new THREE.OctahedronGeometry(0.08, 0), mat(THREE, 0xfff2c0, { emissive: 0xffd36b, ei: 2 }));
  graceCore.position.y = 0.15;
  grace.add(graceCore);
  const motes = [];
  for (let i = 0; i < 10; i++) {
    const m = glow(THREE, 0xffe39a, 0.12);
    m.userData.ph = i / 10;
    grace.add(m); motes.push(m);
  }

  // The Tarnished: a cloaked knight with a sword, looking at the tree.
  const knight = new THREE.Group();
  knight.position.set(-0.75, -1.22, 0.55);
  knight.rotation.y = -0.6;
  r.add(knight);
  const steel = mat(THREE, 0x6b6f78, { metal: 0.7, rough: 0.35 });
  const cloak = mat(THREE, 0x2b2420, { rough: 0.95 });
  const cape = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.75, 6, 1, true), cloak);
  cape.position.y = 0.42; knight.add(cape);
  knight.add(box(THREE, 0.26, 0.3, 0.18, steel, 0, 0.62, 0));
  const helm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.17, 6), steel);
  helm.position.y = 0.86; knight.add(helm);
  const swordArm = new THREE.Group();
  swordArm.position.set(0.16, 0.68, 0.02);
  knight.add(swordArm);
  swordArm.add(box(THREE, 0.06, 0.24, 0.06, steel, 0, -0.12, 0));
  const blade = box(THREE, 0.035, 0.62, 0.012, mat(THREE, 0xd8dde6, { metal: 0.9, rough: 0.2 }), 0, -0.52, 0);
  swordArm.add(blade);
  swordArm.add(box(THREE, 0.16, 0.03, 0.03, steel, 0, -0.22, 0));
  swordArm.rotation.z = 0.35;

  let night = false, rested = 0, restAt = -9, swingAt = -9;
  const sky = new THREE.Color(), skyDay = new THREE.Color(0xffe7b0), skyNight = new THREE.Color(0x6d7bd8);
  return {
    group,
    pick: [graceCore, flare, knight, canopy, trunk],
    update(t, dt) {
      clock.tick(t);
      const restK = clamp((t - restAt) / 1.6);
      const restPulse = restK < 1 ? Math.sin(restK * Math.PI) : 0;
      tree.rotation.y = motion * 0.15 * Math.sin(t * 0.2);
      canopy.children.forEach((b, i) => { b.position.y += Math.sin(t * 0.8 + i) * 0.0006 * motion; });
      halo.material.opacity = 0.65 + 0.15 * Math.sin(t * 0.7) + restPulse * 0.3;
      flare.scale.setScalar(0.7 + 0.08 * Math.sin(t * 3) + restPulse * 0.9);
      graceCore.rotation.y = t * 1.5;
      motes.forEach((m) => {
        const k = (t * 0.25 + m.userData.ph) % 1;
        const a = k * Math.PI * 4 + m.userData.ph * 6;
        m.position.set(Math.cos(a) * 0.12 * (1 - k), 0.1 + k * 0.9, Math.sin(a) * 0.12 * (1 - k));
        m.material.opacity = Math.sin(k * Math.PI);
      });
      sky.copy(night ? skyNight : skyDay);
      L.hemi.color.lerp(sky, 1 - Math.exp(-2 * dt));
      L.dir.intensity = damp(L.dir.intensity, night ? 0.6 : 1.8, 2, dt);
      leafMat.emissiveIntensity = damp(leafMat.emissiveIntensity, night ? 1.6 : 0.9, 2, dt);
      // Swing: a quick arc of the sword arm; idle knights swing now and then.
      if (clock.idle && motion && Math.random() < dt * 0.12) swingAt = t;
      const sk = clamp((t - swingAt) / 0.5);
      swordArm.rotation.z = 0.35 + (sk < 1 ? Math.sin(sk * Math.PI) * -2.2 : 0);
      swordArm.rotation.x = sk < 1 ? Math.sin(sk * Math.PI) * 0.6 : 0;
      for (let i = 0; i < N; i++) {
        pos[i * 3] += (vel[i * 3] + Math.sin(t + i) * 0.05 * motion) * dt;
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        if (pos[i * 3 + 1] < -1.9 || pos[i * 3 + 2] > 0.95) resetLeaf(i);
      }
      leafGeo.attributes.position.needsUpdate = true;
    },
    tap(hit) {
      clock.poke();
      let o = hit.object;
      while (o && o !== knight && o.parent) o = o.parent;
      if (o === knight) { swingAt = clock.now; return; }
      if (hit.object === graceCore || hit.object === flare) {
        restAt = clock.now; rested++;
        for (let i = 0; i < N; i += 3) resetLeaf(i, true);
        return;
      }
      restAt = clock.now;
      for (let i = 0; i < N; i += 2) resetLeaf(i, true);
    },
    actions: [
      { label: () => 'Rest at grace', run() { clock.poke(); restAt = clock.now; rested++; for (let i = 0; i < N; i += 3) resetLeaf(i, true); } },
      { label: () => (night ? 'Pass to day' : 'Pass to night'), run() { clock.poke(); night = !night; } },
    ],
    status: () => (rested ? `Rested ${rested}× · leaves fall from 6 cm behind the glass to 6 cm in front`
      : 'Tap the grace, the knight or the tree · drag to look around'),
  };
}

// ---- Diablo III: an isometric dungeon floor, torches, a hero, demons and loot pillars ------

function diablo(THREE, motion) {
  const group = new THREE.Group();
  const L = lights(THREE, group, { sky: 0xb9a6d8, ground: 0x1a0e10, key: 0xffd0a0, k: 1.6 });
  L.hemi.intensity = 1.6;
  const r = root(THREE, group);
  const clock = idleClock();

  // The diorama sits at the classic isometric angle; the camera never moves.
  const iso = new THREE.Group();
  iso.rotation.set(0.62, Math.PI / 4, 0);
  iso.position.set(0, -0.1, -0.2);
  iso.scale.setScalar(0.78);
  r.add(iso);
  const N = 6, T = 0.62;
  const stone = [0x5a4e55, 0x51464d, 0x483e45];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const h = 0.12 + ((i * 7 + j * 3) % 5) * 0.012;
      iso.add(box(THREE, T * 0.96, h, T * 0.96, mat(THREE, stone[(i + j) % 3], { rough: 0.95 }), (i - (N - 1) / 2) * T, -h / 2, (j - (N - 1) / 2) * T));
    }
  }
  const wallM = mat(THREE, 0x3a3038, { rough: 1 });
  const half = (N * T) / 2;
  for (let i = 0; i < N; i++) {
    const h = 0.8 + (i % 3) * 0.18;
    iso.add(box(THREE, T, h, 0.18, wallM, (i - (N - 1) / 2) * T, h / 2, -half - 0.09));
    iso.add(box(THREE, 0.18, h, T, wallM, -half - 0.09, h / 2, (i - (N - 1) / 2) * T));
  }
  // Pentagram-ish rune circle in the floor.
  const rune = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.025, 6, 48), mat(THREE, 0xdc2626, { emissive: 0xb91c1c, ei: 1.4 }));
  rune.rotation.x = Math.PI / 2; rune.position.y = 0.02;
  iso.add(rune);

  // Torches on the walls, each a flickering light with a glow.
  const torches = [];
  [[-half + 0.05, -half + 0.6], [-half + 0.05, half - 0.6], [half - 0.6, -half + 0.05], [-half + 0.6 + 1.2, -half + 0.05]].forEach(([x, z], i) => {
    const g = new THREE.Group();
    g.position.set(x, 0.62, z);
    g.add(box(THREE, 0.05, 0.18, 0.05, mat(THREE, 0x4a3426), 0, -0.1, 0));
    const f = glow(THREE, 0xff8a33, 0.5);
    g.add(f);
    const light = new THREE.PointLight(0xff8a33, 0.006, 0, 2);
    g.add(light);
    iso.add(g);
    torches.push({ f, light, ph: i * 1.7 });
  });

  // The hero: a robed caster with a glowing staff.
  const hero = new THREE.Group();
  iso.add(hero);
  const robe = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.5, 7), mat(THREE, 0x5b4bb5, { rough: 0.7 }));
  robe.position.y = 0.25; hero.add(robe);
  const hood = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 0), mat(THREE, 0x3b2f80));
  hood.position.y = 0.55; hero.add(hood);
  hero.add(box(THREE, 0.025, 0.62, 0.025, mat(THREE, 0x6b4b2a), 0.15, 0.31, 0));
  const orb = glow(THREE, 0x7dd3fc, 0.32);
  orb.position.set(0.15, 0.66, 0);
  hero.add(orb);
  const heroLight = new THREE.PointLight(0x7dd3fc, 0.002, 0, 2);
  heroLight.position.set(0.15, 0.7, 0);
  hero.add(heroLight);

  // Demons: red, horned, they shamble toward the hero.
  const demons = [];
  const demonM = mat(THREE, 0x9f1d1d, { rough: 0.6, emissive: 0x450a0a, ei: 0.5 });
  const hornM = mat(THREE, 0xe7dcc8, { rough: 0.5 });
  const spawnDemon = () => {
    const d = new THREE.Group();
    d.add(box(THREE, 0.22, 0.28, 0.16, demonM, 0, 0.3, 0));
    d.add(box(THREE, 0.15, 0.13, 0.13, demonM, 0, 0.5, 0));
    for (const s of [-1, 1]) {
      const h = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.12, 5), hornM);
      h.position.set(s * 0.06, 0.6, 0); h.rotation.z = -s * 0.5; d.add(h);
      d.add(box(THREE, 0.07, 0.18, 0.07, demonM, s * 0.06, 0.09, 0));
    }
    const a = Math.random() * Math.PI * 2;
    d.position.set(Math.cos(a) * 1.6, 0, Math.sin(a) * 1.6);
    d.userData = { alive: true, dieAt: 0, ph: Math.random() * 6 };
    iso.add(d); demons.push(d);
  };
  for (let i = 0; i < 4; i++) spawnDemon();

  // Loot pillars: thin beams of light that rise out of the floor, orange for legendaries.
  const loot = [];
  const dropLoot = (x, z, t) => {
    const legendary = Math.random() < 0.3;
    const col = legendary ? 0xff8c1a : Math.random() < 0.5 ? 0xfacc15 : 0x60a5fa;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 6, 1, true),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
    beam.position.set(x, 0.7, z);
    const item = box(THREE, 0.1, 0.04, 0.16, mat(THREE, col, { metal: 0.6, rough: 0.3, emissive: col, ei: 0.6 }), x, 0.03, z);
    iso.add(beam, item);
    loot.push({ beam, item, t0: t, legendary });
    if (loot.length > 8) { const o = loot.shift(); iso.remove(o.beam, o.item); }
    return legendary;
  };

  // Frost nova: an expanding ring that kills what it touches.
  let nova = null, kills = 0, legendaries = 0, lastCast = -9;
  const castNova = (t) => {
    if (t - lastCast < 0.8) return;
    lastCast = t;
    if (nova) iso.remove(nova.mesh);
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 6, 48),
      new THREE.MeshBasicMaterial({ color: 0x9be7ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    mesh.rotation.x = Math.PI / 2; mesh.position.y = 0.15;
    iso.add(mesh);
    nova = { mesh, t0: t };
  };
  const kill = (d, t) => {
    if (!d.userData.alive) return;
    d.userData.alive = false; d.userData.dieAt = t;
    kills++;
    if (dropLoot(d.position.x, d.position.z, t)) legendaries++;
  };

  let heroTarget = new THREE.Vector3();
  return {
    group,
    pick: [iso],
    update(t, dt) {
      clock.tick(t);
      iso.rotation.y = Math.PI / 4 + motion * 0.08 * Math.sin(t * 0.2);
      rune.material.emissiveIntensity = 1 + 0.5 * Math.sin(t * 2);
      for (const tr of torches) {
        const fl = 0.85 + 0.15 * Math.sin(t * 13 + tr.ph) * Math.sin(t * 7.3 + tr.ph * 2);
        tr.f.scale.setScalar(0.5 * fl);
        tr.light.intensity = 0.006 * fl;
      }
      orb.scale.setScalar(0.3 + 0.05 * Math.sin(t * 4));
      // Hero wanders the room when idle, otherwise heads to where you tapped.
      if (clock.idle && Math.random() < dt * 0.4) heroTarget.set(rand(-1, 1), 0, rand(-1, 1));
      hero.position.x = damp(hero.position.x, heroTarget.x, 2, dt);
      hero.position.z = damp(hero.position.z, heroTarget.z, 2, dt);
      for (let i = demons.length - 1; i >= 0; i--) {
        const d = demons[i];
        if (!d.userData.alive) {
          const k = (t - d.userData.dieAt) / 0.5;
          d.scale.set(1 + k * 0.6, Math.max(0.01, 1 - k), 1 + k * 0.6);
          if (k >= 1) { iso.remove(d); demons.splice(i, 1); }
          continue;
        }
        const dx = hero.position.x - d.position.x, dz = hero.position.z - d.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.45) {
          d.position.x += (dx / dist) * 0.25 * dt;
          d.position.z += (dz / dist) * 0.25 * dt;
        }
        d.rotation.y = Math.atan2(dx, dz);
        d.position.y = Math.abs(Math.sin(t * 6 + d.userData.ph)) * 0.04;
      }
      if (demons.filter((d) => d.userData.alive).length < 4 && Math.random() < dt * 0.8) spawnDemon();
      if (clock.idle && t - lastCast > 3.5 && demons.some((d) => d.userData.alive && d.position.distanceTo(hero.position) < 0.8)) castNova(t);
      if (nova) {
        const k = (t - nova.t0) / 0.7;
        const rad = 0.1 + k * 1.5;
        nova.mesh.position.x = hero.position.x; nova.mesh.position.z = hero.position.z;
        nova.mesh.scale.setScalar(rad);
        nova.mesh.material.opacity = 1 - k;
        for (const d of demons) if (d.userData.alive && Math.hypot(d.position.x - hero.position.x, d.position.z - hero.position.z) < rad) kill(d, t);
        if (k >= 1) { iso.remove(nova.mesh); nova = null; }
      }
      for (const l of loot) {
        const k = clamp((t - l.t0) / 0.4);
        l.beam.scale.y = k;
        l.beam.material.opacity = 0.55 + 0.2 * Math.sin(t * 3 + l.t0);
      }
    },
    tap(hit) {
      clock.poke();
      let o = hit.object;
      while (o && !demons.includes(o) && o.parent) o = o.parent;
      if (demons.includes(o)) { kill(o, clock.now); return; }
      const p = iso.worldToLocal(hit.point.clone());
      heroTarget.set(clamp(p.x, -1.4, 1.4), 0, clamp(p.z, -1.4, 1.4));
    },
    actions: [
      { label: () => 'Cast Frost Nova', run() { clock.poke(); castNova(clock.now); } },
    ],
    status: () => (kills ? `${kills} demon${kills === 1 ? '' : 's'} slain · ${legendaries} legendary drop${legendaries === 1 ? '' : 's'}`
      : 'Tap a demon to smite it, tap the floor to move · the loot beams rise toward you'),
  };
}

const BUILDERS = { arcade, tekken, elden, diablo };

/**
 * Build the named scene. `motion` is 1 normally and 0 under prefers-reduced-motion (no
 * decorative sway).
 */
export function buildScene(THREE, name, motion = 1) {
  const b = BUILDERS[name];
  if (!b) throw new Error(`unknown scene ${name}`);
  return b(THREE, motion);
}
