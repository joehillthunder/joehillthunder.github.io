// world.js — the Sugar Rush course: a magical chocolate factory.
//
// Everything is built in code from three.js primitives and canvas-drawn textures (textures.js):
// no external art. World units are metres; forward is −Z; the camera follows from behind (+Z), so
// the course recedes into the screen and the player sits on the zero-disparity plane (DESIGN.md).
//
// Sections: Fondant Foyer → Chocolate River → Conveyor Hall → Wafer Bridge → Gumdrop Gardens →
// Kettle Tower → the Grand Chocolate Fountain and its Golden Gate.

import * as TX from './textures.js';

export const PALETTE = {
  sky: 0x2b1420,
  haze: 0x5a2f3a,
  choc: 0x4a2412,
  milk: 0x7a4526,
  white: 0xf3e6d8,
  pink: 0xff9cc8,
  mint: 0x9ff0d8,
  lilac: 0xc6b4ff,
  lemon: 0xfff1a6,
  peach: 0xffc79a,
  gummy: 0x3fe0e8,
  gold: 0xffc83d,
  copper: 0xc07a45,
};

export const RIVER_Y = -3;
export const KILL_Y = RIVER_Y + 0.25;
export const START = { x: 0, y: 0.01, z: 3 };
export const FOUNTAIN = { x: 0, y: 13.4, z: -167 };
export const TICKETS_TO_OPEN = 3;

// Platforms. look: bar | milk | wafer | marble | fondant | copper | cloud | belt | gumdrop
// type: plain | gummy (big launch) | move (slides on x) | conveyor (pushes you) | crumble | cloud (soft bounce)
// shape: box (w × d) | round (radius w/2). main: on the main path (gets a sweet trail).
const P = (x, y, z, w, d, look, type = 'plain', extra = {}) => ({ x, y, z, w, d, look, type, shape: 'box', main: true, ...extra });
const R = (x, y, z, r, look, type = 'plain', extra = {}) => ({ x, y, z, w: r * 2, d: r * 2, look, type, shape: 'round', main: true, ...extra });

const COURSE = [
  // Fondant Foyer
  P(0, 0, 0, 8, 12, 'marble', 'plain', { checkpoint: true, h: 1.2 }),
  P(0, 0.4, -10, 4, 4, 'bar'),
  // Chocolate River: rafts, a gummy pad, a giant lollipop
  R(-2.5, 0.3, -15.5, 1.8, 'wafer', 'move', { range: 1.6, speed: 0.8 }),
  R(2, 0.6, -21, 1.6, 'milk'),
  P(0, 1.0, -27, 3, 3, 'bar', 'gummy'),
  R(0, 5.0, -34, 2.4, 'fondant', 'plain', { checkpoint: true, tint: PALETTE.pink, lolly: true }),
  R(-6.6, 5.6, -37, 1.2, 'fondant', 'plain', { main: false, tint: PALETTE.mint, lolly: true }),          // ticket 1
  P(3, 4.2, -41, 3, 3, 'bar'),
  // Conveyor Hall
  P(0, 4.2, -51, 3, 11, 'belt', 'conveyor', { push: [0, 3.2] }),                                          // runs back at you
  P(0, 4.6, -60, 4, 4, 'copper', 'plain', { checkpoint: true }),
  P(5.6, 4.6, -60, 6, 2.4, 'belt', 'conveyor', { push: [-3.6, 0], main: false }),                      // side belt to ticket 2
  R(10.2, 5.0, -60, 1.2, 'copper', 'plain', { main: false }),                                             // ticket 2
  P(-3, 5.2, -67, 3, 3, 'milk'),
  P(1, 5.6, -73, 3, 3, 'bar', 'move', { range: 3, speed: 1.2 }),
  // Wafer Bridge: tiles crumble a moment after you land
  P(0, 5.6, -79, 3, 3, 'bar'),
  P(0.8, 5.6, -82.6, 2.3, 2.3, 'wafer', 'crumble'),
  P(-0.8, 5.6, -85.6, 2.3, 2.3, 'wafer', 'crumble'),
  P(0.8, 5.6, -88.6, 2.3, 2.3, 'wafer', 'crumble'),
  P(-0.8, 5.6, -91.6, 2.3, 2.3, 'wafer', 'crumble'),
  P(-5.2, 3.4, -88.5, 2.6, 2.6, 'wafer', 'gummy', { main: false }),                                      // ticket 3 (drop down)
  P(0, 6.0, -98, 5, 5, 'bar', 'plain', { checkpoint: true }),
  // Gumdrop Gardens
  R(-3, 6.4, -105, 2.2, 'gumdrop', 'plain', { tint: PALETTE.lilac }),
  R(2.5, 7.0, -111, 2.0, 'gumdrop', 'gummy', { tint: PALETTE.mint }),
  R(0, 11.5, -118, 2.6, 'cloud', 'cloud'),
  R(5, 13.4, -122.5, 1.6, 'cloud', 'cloud', { main: false }),                                             // ticket 4
  P(-2, 10.6, -127, 4, 4, 'milk', 'plain', { checkpoint: true }),
  // Kettle Tower
  R(2, 11.2, -134, 1.8, 'copper'),
  R(-1.5, 11.8, -140, 1.8, 'copper', 'plain', { vent: true }),
  P(1.5, 12.4, -146, 3, 3, 'bar'),
  P(-2.4, 12.4, -146, 1.6, 1.6, 'copper', 'gummy', { main: false }),                                     // up to ticket 5
  R(-6, 16.4, -149.5, 1.0, 'copper', 'plain', { main: false, chimney: true }),                             // ticket 5
  R(-1, 13.0, -152, 2.0, 'copper', 'plain', { vent: true }),
  P(0, 13.2, -157.5, 3, 3, 'bar'),
  // The Grand Chocolate Fountain
  P(0, 13.4, -168, 13, 13, 'marble', 'plain', { checkpoint: true, h: 1.4, noTrail: true }),
  // Added after the course was laid out (appended so the indices above stay put):
  R(6.4, 0.6, -5, 1.1, 'fondant', 'plain', { main: false, tint: PALETTE.lilac }),                         // 34: blueberry 1
];

// Blueberries: grab one and a bubble carries you further along the course. A shortcut with a
// price: you skip that stretch's sweets and its Golden Ticket. [x, y, z, destination platform]
const BLUEBERRIES = [
  [6.4, 1.9, -5, 9],          // Foyer side candy → Conveyor Hall checkpoint
  [-4.6, 6.9, -79, 25],       // over the river by the Wafer Bridge → Kettle Tower checkpoint
  [5.6, 12.9, -134, 33],      // beside the first kettle → the fountain plaza
];

// The five Golden Tickets sit above these platforms (index into COURSE).
const TICKET_ON = [6, 11, 19, 24, 30];

// Hazards
// Never on a checkpoint platform: a respawn must not land in a hazard.
const WHISKS = [[0, 4.2, -50, 1.7, 2.1], [0, 13.2, -157.5, 1.4, -1.8]];        // [x, topY, z, arm, rad/s]
const JAWBREAKERS = [[12, 1.4], [14, 1.6], [28, 1.8]];                          // [platform index, speed]

export function buildWorld(THREE) {
  TX.initTextures(THREE);
  const root = new THREE.Group();
  const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, ...o });
  const rep = (t, x, y) => { const c = t.clone(); c.repeat.set(x, y); c.needsUpdate = true; return c; };
  const shadow = (m, cast = true) => { m.castShadow = cast; m.receiveShadow = true; return m; };

  // ---- light: warm factory glow; the key light casts shadows and follows the player ----------
  root.add(new THREE.HemisphereLight(0xffe2c4, 0x3a1d1a, 0.9));
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 70 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  root.add(sun, sun.target);

  // ---- the chocolate river: the whole factory floor flows ----------------------------------
  const flow = TX.chocolateFlow();
  const riverMap = rep(flow.map, 12, 26), riverNormal = rep(flow.normal, 12, 26);
  const river = new THREE.Mesh(new THREE.PlaneGeometry(140, 280),
    std({ map: riverMap, normalMap: riverNormal, normalScale: new THREE.Vector2(0.35, 0.35), roughness: 0.3, metalness: 0.0,
      color: 0xb08a78, envMapIntensity: 0.45 }));
  river.rotation.x = -Math.PI / 2;
  river.position.set(0, RIVER_Y, -90);
  river.receiveShadow = true;
  root.add(river);

  // Chocolate waterfalls pouring from great pipes on both sides.
  const falls = [];
  for (const [x, z, h] of [[-17, -30, 16], [18, -96, 20], [-19, -140, 24]]) {
    const fm = std({ map: rep(flow.map, 1.5, 3), normalMap: rep(flow.normal, 1.5, 3), roughness: 0.2, side: THREE.DoubleSide });
    const fall = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4.2, h, 24, 1, true, Math.PI * 0.15, Math.PI * 0.7), fm);
    fall.position.set(x, RIVER_Y + h / 2, z);
    fall.rotation.y = x < 0 ? -Math.PI / 2 : Math.PI / 2;
    root.add(fall);
    falls.push(fm);
    const pipe = shadow(new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 6, 24), std({ map: rep(TX.copper(), 3, 1), metalness: 0.7, roughness: 0.35 })));
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(x + Math.sign(x) * 3, RIVER_Y + h + 1, z);
    root.add(pipe);
    for (let k = 0; k < 7; k++) {                                       // frothy splash at the base
      const foam = new THREE.Mesh(new THREE.SphereGeometry(1 + (k % 3) * 0.5, 14, 10), std({ color: 0x8a5634, roughness: 0.3 }));
      foam.position.set(x + Math.cos(k) * 2.6, RIVER_Y + 0.2, z + Math.sin(k * 1.7) * 2.6);
      foam.scale.y = 0.4;
      root.add(foam);
    }
  }

  // ---- factory walls: brick, glowing sugar-glass windows, copper pipes, turning gears -----------
  const B = TX.brick();
  const wallMat = std({ map: rep(B.map, 40, 12), normalMap: rep(B.normal, 40, 12), roughness: 0.85 });
  const winMat = new THREE.MeshBasicMaterial({ map: TX.windowGlow(), color: 0xffd9a8 });
  const copperMat = std({ map: rep(TX.copper(), 1, 6), metalness: 0.75, roughness: 0.32 });
  const gears = [];
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 46, 280), wallMat);
    wall.position.set(side * 34, RIVER_Y + 20, -90);
    wall.receiveShadow = true;
    root.add(wall);
    for (let z = 0; z > -200; z -= 18) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(6, 12), winMat);
      w.position.set(side * 32.9, RIVER_Y + 16, z - 6);
      w.rotation.y = -side * Math.PI / 2;
      root.add(w);
      const arch = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.35, 8, 24, Math.PI), std({ color: 0x3a2214 }));
      arch.position.set(side * 32.9, RIVER_Y + 22, z - 6);
      arch.rotation.y = -side * Math.PI / 2;
      root.add(arch);
    }
    for (const y of [4, 9]) {                                           // long pipe runs
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 280, 16), copperMat);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(side * 31.5, RIVER_Y + y + 6, -90);
      root.add(pipe);
    }
    for (let z = -20; z > -190; z -= 34) {                              // big gears on the walls
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(4, 0.8, 10, 40), copperMat);
      g.add(ring);
      for (let k = 0; k < 12; k++) {
        const tooth = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.4, 1.2), copperMat);
        tooth.position.set(Math.cos((k / 12) * Math.PI * 2) * 4.9, Math.sin((k / 12) * Math.PI * 2) * 4.9, 0);
        tooth.rotation.z = (k / 12) * Math.PI * 2;
        g.add(tooth);
      }
      for (let k = 0; k < 3; k++) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(8, 0.6, 0.6), copperMat);
        spoke.rotation.z = (k / 3) * Math.PI;
        g.add(spoke);
      }
      g.position.set(side * 32.4, RIVER_Y + 26, z);
      g.rotation.y = Math.PI / 2;
      root.add(g);
      gears.push({ g, speed: (side * 0.25) * (z % 68 ? 1 : -1) });
    }
  }

  // ---- candy scenery on the banks -----------------------------------------------------------------
  const scenery = new THREE.Group();
  root.add(scenery);
  const r = rng(5);
  const swirlCols = [
    ['#ff5d8f', '#ffd23f', '#3fd2c7'], ['#8f6bff', '#ff9cc8', '#ffffff'], ['#e8344e', '#ffffff', '#ffd23f'], ['#3fd2c7', '#ffffff', '#ff5d8f']];
  const stickMat = std({ color: 0xfaf3ea, roughness: 0.6 });
  const lolly = (x, z, h, rad, cols) => {
    const g = new THREE.Group();
    g.add(shadow(new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.08, rad * 0.08, h, 10), stickMat)));
    g.children[0].position.y = h / 2;
    const disc = shadow(new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, rad * 0.35, 40),
      [std({ color: 0xffffff, roughness: 0.25 }), std({ map: TX.swirl([...cols, '#fff2f7']), roughness: 0.2 }), std({ map: TX.swirl([...cols, '#fff2f7']), roughness: 0.2 })]));
    disc.rotation.x = Math.PI / 2;
    disc.position.y = h + rad * 0.9;
    g.add(disc);
    g.position.set(x, RIVER_Y, z);
    g.rotation.y = r() * Math.PI;
    scenery.add(g);
    return g;
  };
  const caneMat = std({ map: rep(TX.caneStripe(), 1, 8), roughness: 0.35 });
  const cane = (x, z, h) => {
    const g = new THREE.Group();
    const shaft = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, h, 14), caneMat));
    shaft.position.y = h / 2;
    const hook = shadow(new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.35, 10, 20, Math.PI), caneMat));
    hook.position.set(1.1, h, 0);
    g.add(shaft, hook);
    g.position.set(x, RIVER_Y, z);
    g.rotation.y = r() * Math.PI * 2;
    scenery.add(g);
  };
  const gumdropMats = [PALETTE.pink, PALETTE.mint, PALETTE.lilac, PALETTE.lemon, PALETTE.peach].map((c) =>
    std({ map: TX.sprinkles(c), roughness: 0.4 }));
  const gumdrop = (x, z, s) => {
    const m = shadow(new THREE.Mesh(new THREE.SphereGeometry(s, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), gumdropMats[Math.floor(r() * 5)]));
    m.position.set(x, RIVER_Y, z);
    m.scale.y = 1.3;
    scenery.add(m);
  };
  const cotton = (x, z, h) => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, h, 8), stickMat));
    g.children[0].position.y = h / 2;
    const cm = std({ map: TX.cottonCandy(), roughness: 1 });
    for (let k = 0; k < 6; k++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(1.4 + r() * 0.8, 16, 12), cm);
      puff.position.set((r() - 0.5) * 2.2, h + 1 + r() * 1.6, (r() - 0.5) * 2.2);
      g.add(puff);
    }
    g.traverse((o) => o.isMesh && shadow(o));
    g.position.set(x, RIVER_Y, z);
    scenery.add(g);
  };
  for (let z = -6; z > -185; z -= 7) {
    for (const side of [-1, 1]) {
      const x = side * (13 + r() * 14);
      const zz = z + (r() - 0.5) * 5;
      const pick = r();
      if (pick < 0.32) lolly(x, zz, 6 + r() * 12, 1.8 + r() * 1.6, swirlCols[Math.floor(r() * 4)]);
      else if (pick < 0.55) cane(x, zz, 6 + r() * 10);
      else if (pick < 0.8) gumdrop(x, zz, 1.5 + r() * 2.5);
      else cotton(x, zz, 5 + r() * 8);
    }
  }

  // Copper kettles bubbling in the Kettle Tower section.
  const kettleMat = std({ map: rep(TX.copper(), 2, 1), metalness: 0.8, roughness: 0.3 });
  const kettles = [];
  for (const [x, z, s] of [[-11, -136, 4], [12, -148, 5], [-13, -158, 3.5]]) {
    const k = shadow(new THREE.Mesh(new THREE.SphereGeometry(s, 32, 20), kettleMat));
    k.scale.y = 0.85;
    k.position.set(x, RIVER_Y + s * 0.8, z);
    root.add(k);
    const top = new THREE.Mesh(new THREE.CircleGeometry(s * 0.72, 32), std({ map: rep(flow.map, 1, 1), color: 0xd08a9a, roughness: 0.2 }));
    top.rotation.x = -Math.PI / 2;
    top.position.set(x, RIVER_Y + s * 1.25, z);
    root.add(top);
    kettles.push(top);
  }

  // ---- platforms -----------------------------------------------------------------------------------
  const barTex = TX.chocolateBar(0x5a2e17), milkTex = TX.chocolateBar(0x8a5230), waferTex = TX.wafer();
  const topMat = (p) => {
    const sx = p.w / 2, sz = p.d / 2;
    switch (p.look) {
      case 'bar': return std({ map: rep(barTex.map, sx, sz), normalMap: rep(barTex.normal, sx, sz), roughness: 0.35 });
      case 'milk': return std({ map: rep(milkTex.map, sx, sz), normalMap: rep(milkTex.normal, sx, sz), roughness: 0.35 });
      case 'wafer': return std({ map: rep(waferTex.map, sx * 0.8, sz * 0.8), normalMap: rep(waferTex.normal, sx * 0.8, sz * 0.8), roughness: 0.75 });
      case 'marble': return std({ map: rep(TX.marble(), p.w / 6, p.d / 6), roughness: 0.18, metalness: 0.05 });
      case 'copper': return std({ map: rep(TX.copper(), sx, sz), metalness: 0.75, roughness: 0.3 });
      case 'belt': return std({ map: rep(TX.belt(), p.w / 1.5, p.d / 1.5), roughness: 0.8 });
      case 'cloud': return std({ map: TX.cottonCandy(), roughness: 1 });
      case 'fondant': case 'gumdrop': return std({ map: TX.sprinkles(p.tint), roughness: 0.4 });
      default: return std({ color: 0x888888 });
    }
  };
  const sideMat = (p) => (p.look === 'wafer' ? std({ map: rep(waferTex.map, p.w / 2, 0.5), roughness: 0.8 })
    : p.look === 'marble' ? std({ map: rep(TX.marble(), p.w / 6, 0.3), roughness: 0.2 })
      : p.look === 'copper' || p.look === 'belt' ? std({ map: rep(TX.copper(), 2, 0.5), metalness: 0.7, roughness: 0.35 })
        : p.look === 'cloud' ? std({ map: TX.cottonCandy(), roughness: 1 })
          : p.look === 'fondant' || p.look === 'gumdrop' ? std({ map: TX.fondant(p.tint), roughness: 0.4 })
            : std({ color: p.look === 'milk' ? 0x6e3d20 : 0x3f1f0e, roughness: 0.4 }));

  const PLAT_H = 0.8;
  const platforms = COURSE.map((spec, i) => {
    const p = { i, ...spec, baseX: spec.x, dx: 0, dz: 0, solid: true, crumbleT: -1, respawnT: 0 };
    const h = spec.h || (spec.look === 'cloud' ? 1.2 : PLAT_H);
    p.h = h;
    let mesh;
    if (spec.shape === 'round') {
      if (spec.look === 'cloud') {
        mesh = new THREE.Group();
        const cm = topMat(spec);
        for (let k = 0; k < 7; k++) {
          const a = (k / 7) * Math.PI * 2;
          const puff = new THREE.Mesh(new THREE.SphereGeometry(spec.w * 0.32, 18, 12), cm);
          puff.position.set(Math.cos(a) * spec.w * 0.28, -h * 0.5, Math.sin(a) * spec.w * 0.28);
          puff.scale.y = 0.6;
          mesh.add(puff);
        }
        const mid = new THREE.Mesh(new THREE.SphereGeometry(spec.w * 0.42, 20, 14), cm);
        mid.scale.y = 0.45;
        mid.position.y = -h * 0.35;
        mesh.add(mid);
      } else if (spec.look === 'gumdrop') {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(spec.w / 2, spec.w / 2 + 0.5, h * 2.5, 40), [sideMat(spec), topMat(spec), sideMat(spec)]);
        mesh.position.y = -h * 1.25;
        const g = new THREE.Group();
        g.add(mesh);
        mesh = g;
      } else {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(spec.w / 2, spec.w / 2, h, 40), [sideMat(spec), topMat(spec), sideMat(spec)]);
        mesh.position.y = -h / 2;
        const g = new THREE.Group();
        g.add(mesh);
        mesh = g;
      }
    } else {
      const s = sideMat(spec), t = topMat(spec);
      const box = new THREE.Mesh(new THREE.BoxGeometry(spec.w, h, spec.d), [s, s, t, s, s, s]);
      box.position.y = -h / 2;
      mesh = new THREE.Group();
      mesh.add(box);
      if (spec.type === 'conveyor') p.beltMap = t.map;
    }
    mesh.position.set(spec.x, spec.y, spec.z);
    mesh.traverse((o) => o.isMesh && shadow(o));
    root.add(mesh);
    p.mesh = mesh;
    // A giant lollipop: the platform is the candy disc, on a stick down into the river.
    if (spec.lolly) {
      const stick = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, spec.y - RIVER_Y, 10), stickMat));
      stick.position.set(spec.x, (spec.y + RIVER_Y) / 2 - 0.4, spec.z);
      root.add(stick);
    }
    // Pillars of chocolate hold up the rest (not rafts, clouds or movers).
    else if (spec.type !== 'move' && spec.type !== 'crumble' && spec.look !== 'cloud' && !spec.chimney && spec.y - RIVER_Y > 2) {
      const pr = Math.min(spec.w, spec.d) * 0.22;
      const pillar = shadow(new THREE.Mesh(new THREE.CylinderGeometry(pr, pr * 1.3, spec.y - RIVER_Y - h, 16),
        std({ map: rep(flow.map, 1, 3), normalMap: rep(flow.normal, 1, 3), roughness: 0.3 })));
      pillar.position.set(spec.x, (spec.y - h + RIVER_Y) / 2, spec.z);
      root.add(pillar);
    }
    if (spec.chimney) {                                                  // a tall brick chimney stack
      const ch = shadow(new THREE.Mesh(new THREE.CylinderGeometry(1, 1.3, spec.y - RIVER_Y, 20), std({ map: rep(B.map, 3, 8), roughness: 0.85 })));
      ch.position.set(spec.x, (spec.y + RIVER_Y) / 2 - 0.5, spec.z);
      root.add(ch);
    }
    if (spec.type === 'gummy') {
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(spec.w, spec.d) * 0.38, Math.min(spec.w, spec.d) * 0.42, 0.28, 32),
        std({ color: PALETTE.gummy, emissive: 0x0d5a5e, roughness: 0.15, transparent: true, opacity: 0.9 }));
      pad.position.y = 0.12;
      mesh.add(pad);
      p.pad = pad;
    }
    if (spec.type === 'conveyor') {                                      // rollers along the edges
      for (const s of [-1, 1]) {
        const long = spec.d > spec.w;
        const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, long ? spec.d : spec.w, 12), copperMat);
        roll.rotation[long ? 'x' : 'z'] = Math.PI / 2;
        roll.position.set(long ? s * (spec.w / 2 + 0.12) : 0, -0.1, long ? 0 : s * (spec.d / 2 + 0.12));
        mesh.add(roll);
      }
    }
    if (spec.checkpoint) {                                               // a lollipop flag that lights when reached
      const flag = new THREE.Group();
      flag.add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 8), stickMat));
      flag.children[0].position.y = 1.1;
      const fm = std({ color: 0x8a6f86, emissive: 0x000000, roughness: 0.3 });
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.32, 20, 14), fm);
      ball.position.y = 2.35;
      flag.add(ball);
      flag.position.set(spec.x + (spec.shape === 'round' ? spec.w * 0.35 : spec.w / 2 - 0.4), spec.y, spec.z + (spec.shape === 'round' ? 0 : spec.d / 2 - 0.4));
      flag.traverse((o) => o.isMesh && shadow(o));
      root.add(flag);
      p.flagMat = fm;
    }
    if (spec.vent) p.vent = { period: 3.2, on: 1.1, phase: i * 0.7, active: false };
    return p;
  });

  // Steam vents: a grate on the platform and a plume that rises while it is active.
  const steamMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, roughness: 1 });
  for (const p of platforms) {
    if (!p.vent) continue;
    const grate = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.06, 20), std({ color: 0x2a2a2e, metalness: 0.8, roughness: 0.4 }));
    grate.position.y = 0.03;
    p.mesh.add(grate);
    const plume = new THREE.Group();
    for (let k = 0; k < 6; k++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.55 + k * 0.12, 14, 10), steamMat);
      puff.position.y = 0.4 + k * 0.55;
      plume.add(puff);
    }
    p.mesh.add(plume);
    p.vent.plume = plume;
  }

  // ---- hazards ---------------------------------------------------------------------------------------
  const steel = std({ color: 0xd8dde2, metalness: 0.9, roughness: 0.2 });
  const whisks = WHISKS.map(([x, y, z, arm, speed]) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    const hub = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 0.9, 16), copperMat));
    hub.position.y = 0.45;
    g.add(hub);
    const rot = new THREE.Group();
    rot.position.y = 0.55;
    g.add(rot);
    for (const s of [-1, 1]) {
      const bar = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, arm, 8), steel));
      bar.rotation.z = Math.PI / 2;
      bar.position.x = (s * arm) / 2;
      rot.add(bar);
      for (let k = 0; k < 4; k++) {                                    // balloon whisk loops at the tip
        const loop = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.03, 6, 20), steel);
        loop.position.x = s * (arm - 0.1);
        loop.rotation.x = (k / 4) * Math.PI;
        loop.scale.set(0.8, 1, 1);
        rot.add(loop);
      }
    }
    root.add(g);
    return { g, rot, x, y: y + 0.55, z, arm, speed, a: 0 };
  });

  const jbMats = [['#e8344e', '#ffffff', '#ffd23f'], ['#3fd2c7', '#ffffff', '#8f6bff'], ['#ff9cc8', '#ffffff', '#6be675']].map((c) =>
    std({ map: TX.swirl([...c, '#fff2f7']), roughness: 0.15, metalness: 0.05 }));
  const jawbreakers = JAWBREAKERS.map(([pi, speed], k) => {
    const p = platforms[pi];
    const ball = shadow(new THREE.Mesh(new THREE.SphereGeometry(0.5, 28, 20), jbMats[k % 3]));
    root.add(ball);
    return { mesh: ball, p, speed, t: k, r: 0.5, x: p.x, y: p.y + 0.5, z: p.z };
  });

  // ---- collectibles ------------------------------------------------------------------------------------
  const SWEET = {
    candy: { value: 10, color: 0xff5d8f },
    lolly: { value: 25, color: 0x3fd2c7 },
    truffle: { value: 50, color: 0xffc83d },
  };
  const foils = [['#ff5d8f', '#ffd1e3'], ['#3fd2c7', '#d6fff9'], ['#ffd23f', '#fff4c2'], ['#8f6bff', '#e3dbff']].map(([a, b]) =>
    std({ map: TX.foil(a, b), metalness: 0.6, roughness: 0.25 }));
  const truffleMat = std({ map: TX.sprinkles(0x3d1d0d), roughness: 0.45 });
  const sweetGeo = {
    body: new THREE.SphereGeometry(0.2, 16, 12),
    wing: new THREE.ConeGeometry(0.16, 0.22, 10),
    disc: new THREE.CylinderGeometry(0.3, 0.3, 0.08, 28),
    stick: new THREE.CylinderGeometry(0.025, 0.025, 0.45, 6),
    truffle: new THREE.SphereGeometry(0.26, 18, 14),
  };
  const lollyMats = swirlCols.map((c) => std({ map: TX.swirl([...c, '#fff2f7']), roughness: 0.2 }));
  const makeSweet = (kind, k) => {
    const g = new THREE.Group();
    if (kind === 'candy') {
      const m = foils[k % foils.length];
      g.add(new THREE.Mesh(sweetGeo.body, m));
      for (const s of [-1, 1]) {
        const w = new THREE.Mesh(sweetGeo.wing, m);
        w.rotation.z = s * Math.PI / 2;
        w.position.x = s * 0.25;
        g.add(w);
      }
      g.children[0].scale.set(1.25, 1, 1);
    } else if (kind === 'lolly') {
      const d = new THREE.Mesh(sweetGeo.disc, [stickMat, lollyMats[k % 4], lollyMats[k % 4]]);
      d.rotation.x = Math.PI / 2;
      d.position.y = 0.15;
      const s = new THREE.Mesh(sweetGeo.stick, stickMat);
      s.position.y = -0.2;
      g.add(d, s);
    } else {
      g.add(new THREE.Mesh(sweetGeo.truffle, truffleMat));
    }
    g.traverse((o) => o.isMesh && (o.castShadow = true));
    root.add(g);
    return g;
  };
  const sweets = [];
  const addSweet = (x, y, z, kind) => {
    const k = sweets.length;
    const mesh = makeSweet(kind, k);
    mesh.position.set(x, y, z);
    sweets.push({ kind, value: SWEET[kind].value, color: SWEET[kind].color, mesh, x, y, z, taken: false, k });
  };
  // A trail across every main-path platform, plus arcs over the gaps between them.
  const main = platforms.filter((p) => p.main);
  main.forEach((p, n) => {
    if (p.noTrail) return;
    const len = p.shape === 'round' ? p.w * 0.7 : Math.max(p.w, p.d) * 0.7;
    const count = Math.max(1, Math.min(5, Math.round(len / 1.4)));
    const alongZ = p.shape === 'round' || p.d >= p.w;
    for (let k = 0; k < count; k++) {
      const u = count === 1 ? 0 : k / (count - 1) - 0.5;
      const kind = (n + k) % 6 === 5 ? 'lolly' : 'candy';
      addSweet(p.x + (alongZ ? 0 : u * len), p.y + 0.9, p.z + (alongZ ? -u * len : 0), kind);
    }
    const q = main[n + 1];
    if (q && Math.hypot(q.x - p.x, q.z - p.z) > 4 && q.y - p.y < 3) {
      for (let k = 1; k <= 2; k++) {
        const u = k / 3;
        addSweet(p.x + (q.x - p.x) * u, p.y + (q.y - p.y) * u + 1.6 + Math.sin(u * Math.PI) * 0.8, p.z + (q.z - p.z) * u, 'candy');
      }
    }
  });
  // A ring of lollipops around the fountain.
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    addSweet(FOUNTAIN.x + Math.cos(a) * 4.6, FOUNTAIN.y + 0.9, FOUNTAIN.z + Math.sin(a) * 4.6, k % 2 ? 'lolly' : 'candy');
  }
  // Truffles in the hard-to-reach spots.
  for (const [x, y, z] of [[-4.6, 7.4, -35.5], [8.4, 6.3, -60], [-5.2, 6.5, -88.5], [3, 15.4, -121], [-4, 17.5, -148], [0, 15.2, -161],
    [0, 2.4, -24], [0, 9, -114], [-2.4, 14.4, -146]]) addSweet(x, y, z, 'truffle');

  // The five Golden Tickets: rare, glowing, each above an off-path platform.
  const ticketMat = std({ map: TX.goldenTicket(), metalness: 0.65, roughness: 0.25, emissive: 0x6a4a00, emissiveMap: TX.goldenTicket(), emissiveIntensity: 0.6, side: THREE.DoubleSide });
  const haloMat = new THREE.SpriteMaterial({ map: TX.glow(), color: 0xffd24a, transparent: true, opacity: 0.7, depthWrite: false });
  const tickets = TICKET_ON.map((pi, i) => {
    const p = platforms[pi];
    const g = new THREE.Group();
    const card = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.55, 0.02), ticketMat);
    card.castShadow = true;
    const halo = new THREE.Sprite(haloMat);
    halo.scale.set(2.4, 2.4, 1);
    g.add(halo, card);
    const y = p.y + 1.3;
    g.position.set(p.x, y, p.z);
    root.add(g);
    return { i, mesh: g, card, halo, x: p.x, y, z: p.z, taken: false };
  });

  // Blueberries: deep-blue gloss with a dusty bloom, a star-shaped crown, a leaf and a blue halo.
  const berryMat = std({ color: 0x3346b8, roughness: 0.32, metalness: 0.05, emissive: 0x0d1450, emissiveIntensity: 0.6, envMapIntensity: 1.2 });
  const crownMat = std({ color: 0x2a1f44, roughness: 0.6 });
  const leafMat = std({ color: 0x4f9a4a, roughness: 0.5, side: THREE.DoubleSide });
  const berryHalo = new THREE.SpriteMaterial({ map: TX.glow(), color: 0x7f9cff, transparent: true, opacity: 0.6, depthWrite: false });
  const blueberries = BLUEBERRIES.map(([x, y, z, dest], i) => {
    const g = new THREE.Group();
    const berry = shadow(new THREE.Mesh(new THREE.SphereGeometry(0.38, 28, 20), berryMat));
    berry.scale.y = 0.92;
    g.add(berry);
    for (let k = 0; k < 5; k++) {
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 6), crownMat);
      const a = (k / 5) * Math.PI * 2;
      tip.position.set(Math.cos(a) * 0.09, 0.36, Math.sin(a) * 0.09);
      tip.rotation.set(Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6);
      g.add(tip);
    }
    const leaf = new THREE.Mesh(new THREE.CircleGeometry(0.16, 12), leafMat);
    leaf.scale.set(1, 0.45, 1);
    leaf.position.set(0.12, 0.4, 0);
    leaf.rotation.set(-0.5, 0.4, 0.6);
    g.add(leaf);
    const halo = new THREE.Sprite(berryHalo.clone());
    halo.scale.set(1.8, 1.8, 1);
    g.add(halo);
    g.position.set(x, y, z);
    root.add(g);
    const d = platforms[dest];
    return { i, mesh: g, halo, x, y, z, taken: false,
      to: { x: d.x, y: d.y + 0.01, z: d.z + (d.shape === 'round' ? 0 : d.d / 2 - 1.2) }, dest };
  });

  // ---- the Grand Chocolate Fountain and the Golden Gate ------------------------------------------------
  const fountain = new THREE.Group();
  const plate = std({ color: 0xfff7ee, map: rep(TX.marble(), 1, 1), roughness: 0.15 });
  const chocSheet = std({ map: rep(flow.map, 2, 1), normalMap: rep(flow.normal, 2, 1), roughness: 0.15 });
  let fy = 0;
  const fountainFlows = [];
  for (const [rad, h] of [[3.0, 0.7], [2.1, 0.6], [1.3, 0.5]]) {
    const t = shadow(new THREE.Mesh(new THREE.CylinderGeometry(rad, rad * 1.08, h, 40), plate));
    t.position.y = fy + h / 2;
    fountain.add(t);
    const sheet = new THREE.Mesh(new THREE.CylinderGeometry(rad * 1.02, rad * 1.12, 1.4, 40, 1, true), chocSheet);   // chocolate pouring over the rim
    sheet.position.y = fy + h - 0.55;
    fountain.add(sheet);
    fountainFlows.push(sheet);
    fy += h + 0.35;
  }
  const spout = shadow(new THREE.Mesh(new THREE.SphereGeometry(0.6, 24, 16), std({ color: PALETTE.gold, emissive: 0x6a4a00, metalness: 0.7, roughness: 0.2 })));
  spout.position.y = fy + 0.5;
  fountain.add(spout);
  fountain.position.set(FOUNTAIN.x, FOUNTAIN.y, FOUNTAIN.z);
  root.add(fountain);
  // The gate stands BEHIND the fountain (nothing spans the screen edges in front of the player).
  const gate = new THREE.Group();
  gate.position.set(FOUNTAIN.x, FOUNTAIN.y, FOUNTAIN.z - 4.5);
  const goldMat = std({ color: PALETTE.gold, metalness: 0.85, roughness: 0.2, emissive: 0x3a2800 });
  const archG = shadow(new THREE.Mesh(new THREE.TorusGeometry(4.4, 0.4, 12, 48, Math.PI), goldMat));
  archG.position.y = 4;
  gate.add(archG);
  for (const s of [-1, 1]) {
    const post = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 4, 16), goldMat));
    post.position.set(s * 4.4, 2, 0);
    gate.add(post);
  }
  const doors = [];
  for (const s of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.set(s * 4.1, 0, 0);
    gate.add(hinge);
    for (let k = 0; k < 6; k++) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 6.4, 8), goldMat);
      bar.position.set(-s * (0.35 + k * 0.62), 3.2, 0);
      hinge.add(bar);
    }
    const curl = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.08, 8, 24), goldMat);
    curl.position.set(-s * 2, 4.4, 0);
    hinge.add(curl);
    doors.push({ hinge, s });
  }
  root.add(gate);

  // Floating sugar dust: tiny glints drifting through the warm air.
  const DUST = 600;
  const dustGeo = new THREE.BufferGeometry();
  const dp = new Float32Array(DUST * 3);
  for (let k = 0; k < DUST; k++) dp.set([(r() - 0.5) * 60, RIVER_Y + r() * 30, 10 - r() * 200], k * 3);
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dp, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ map: TX.glow(), color: 0xffe6b3, size: 0.25, transparent: true, opacity: 0.7, depthWrite: false }));
  root.add(dust);

  // Candy-cane posts along the course edges: the foreground layer that fades near the camera.
  const posts = [];
  for (let z = 4; z > -160; z -= 10) {
    const yTop = courseY(platforms, z) + 2.5;
    for (const side of [-1, 1]) {
      const h = yTop - RIVER_Y;
      const m = std({ map: rep(TX.caneStripe(), 1, h / 1.5), roughness: 0.35, transparent: true });
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, h, 12), m);
      post.position.set(side * 9, RIVER_Y + h / 2, z);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), std({ color: 0xe8344e, roughness: 0.3, transparent: true }));
      knob.position.y = h / 2;
      post.add(knob);
      root.add(post);
      posts.push(post);
    }
  }

  return {
    root, sun, platforms, posts, sweets, tickets, blueberries, whisks, jawbreakers, fountain, spout, doors, gate,
    river: { map: riverMap, normal: riverNormal }, falls, fountainFlows, kettles, gears, dust, steamMat,
    PLAT_H,
  };
}

// The main path's height near z (for scenery that should track the course).
function courseY(platforms, z) {
  let best = null;
  for (const p of platforms) if (p.main && (!best || Math.abs(p.z - z) < Math.abs(best.z - z))) best = p;
  return best ? best.y : 0;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Advance everything that moves on its own. `k` scales hazard speed (difficulty). */
export function updateWorld(w, t, dt, k, ticketsHeld = 0) {
  for (const p of w.platforms) {
    if (p.type === 'move') {
      const nx = p.baseX + Math.sin(t * p.speed) * p.range;
      p.dx = nx - p.x;
      p.x = nx;
      p.mesh.position.x = nx;
    }
    if (p.beltMap) {                                                     // belts scroll the way they push
      const [px, pz] = p.push;
      p.beltMap.offset.x -= (px * dt) / 1.5;
      p.beltMap.offset.y += (pz * dt) / 1.5;
    }
    if (p.vent) {
      const ph = ((t + p.vent.phase) % p.vent.period);
      p.vent.active = ph < p.vent.on;
      const warn = ph > p.vent.period - 0.6;                             // a hiss and a wisp before it blows
      p.vent.plume.children.forEach((puff, n) => {
        puff.visible = p.vent.active || (warn && n < 2);
        puff.position.y = 0.4 + n * 0.55 + (p.vent.active ? Math.sin(t * 9 + n) * 0.08 : 0);
        puff.scale.setScalar(p.vent.active ? 1 + Math.sin(t * 7 + n) * 0.1 : 0.5);
      });
    }
    if (p.look === 'cloud') p.mesh.position.y = p.y + Math.sin(t * 1.3 + p.i) * 0.04;
    if (p.pad) p.pad.material.emissiveIntensity = 0.8 + Math.sin(t * 4 + p.i) * 0.4;
  }
  w.steamMat.opacity = 0.55;
  for (const s of w.whisks) {
    s.a += dt * s.speed * k;
    s.rot.rotation.y = s.a;
  }
  for (const g of w.jawbreakers) {
    g.t += dt * g.speed * k;
    const p = g.p;
    const half = (p.shape === 'round' ? p.w / 2 : p.w / 2) - g.r;
    g.x = p.x + Math.sin(g.t) * half;
    g.z = p.z + Math.sin(g.t * 0.5) * ((p.shape === 'round' ? p.w : p.d) / 2 - g.r) * 0.6;
    g.y = p.y + g.r;
    g.mesh.position.set(g.x, g.y, g.z);
    g.mesh.rotation.z -= Math.cos(g.t) * dt * g.speed * k * 2;
    g.mesh.rotation.x += dt * g.speed * k * 0.6;
  }
  for (const s of w.sweets) {
    if (s.taken) continue;
    s.mesh.rotation.y += dt * (s.kind === 'lolly' ? 1.6 : 2.4);
    s.mesh.position.y = s.y + Math.sin(t * 2.4 + s.k * 0.7) * 0.1;
  }
  for (const tk of w.tickets) {
    if (tk.taken) continue;
    tk.card.rotation.y = t * 1.6 + tk.i;
    tk.card.rotation.z = Math.sin(t * 2 + tk.i) * 0.15;
    tk.mesh.position.y = tk.y + Math.sin(t * 1.8 + tk.i) * 0.15;
    tk.halo.material.opacity = 0.5 + Math.sin(t * 3 + tk.i) * 0.2;
  }
  for (const b of w.blueberries) {
    if (b.taken) continue;
    b.mesh.rotation.y = t * 1.2 + b.i;
    b.mesh.position.y = b.y + Math.sin(t * 2.2 + b.i * 2) * 0.14;
    b.halo.material.opacity = 0.45 + Math.sin(t * 3.4 + b.i) * 0.2;
  }
  w.spout.position.y = 2.75 + Math.sin(t * 3) * 0.1;
  // Chocolate flows: the river runs toward the viewer; falls and fountain pour down.
  w.river.map.offset.y += dt * 0.05;
  w.river.normal.offset.y += dt * 0.05;
  for (const m of w.falls) { m.map.offset.y += dt * 0.6; m.normalMap.offset.y += dt * 0.6; }
  for (const s of w.fountainFlows) { s.material.map.offset.y += dt * 0.3; }
  for (const kt of w.kettles) kt.material.map.offset.x += dt * 0.04;
  for (const g of w.gears) g.g.rotation.z += dt * g.speed;
  const dp = w.dust.geometry.attributes.position;
  for (let i = 0; i < dp.count; i++) {
    let y = dp.getY(i) + dt * 0.25;
    if (y > RIVER_Y + 30) y = RIVER_Y;
    dp.setY(i, y);
    dp.setX(i, dp.getX(i) + Math.sin(t * 0.5 + i) * dt * 0.1);
  }
  dp.needsUpdate = true;
  // The Golden Gate swings open once you hold enough tickets.
  const open = ticketsHeld >= TICKETS_TO_OPEN ? 1 : 0;
  for (const d of w.doors) d.hinge.rotation.y += ((open * d.s * 1.4) - d.hinge.rotation.y) * Math.min(1, dt * 2);
}
