// Sugar Rush — a magical chocolate-factory 3D platformer for glasses-free 3D displays (DisplayXR),
// and a normal 3D game in 2D anywhere else. Run and jump through the factory, gather sweets for
// points, and hunt the five rare Golden Tickets: three open the Golden Gate at the fountain.
//
// DisplayXR wiring follows the SDK's samples/camera-rig: one inline-3D session, one woven
// canvas, a CAMERA rig rebuilt every frame from the follow camera (the runtime offsets the eyes
// and skews each frustum), the eye cameras parented under the app camera ("attach"), each eye
// rendered into the viewport the layer reports. Depth layout: DESIGN.md.

import * as THREE from 'three';
import { createInline3D, inline3dDisplayModesSupported } from '@displayxr/inline3d';
import { EyeCamera, cameraRigFromCamera } from '@displayxr/inline3d/three';
import { buildWorld, updateWorld, PALETTE, START, FOUNTAIN, KILL_Y, RIVER_Y, TICKETS_TO_OPEN } from './world.js';
import { createPlayer } from './player.js';
import { glow } from './textures.js';
import { createInput } from './input.js';
import { sfx } from './sfx.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const DEV = new URLSearchParams(location.search).has('dev');

// ---- tuning ------------------------------------------------------------------------------------
const DIFFICULTY = {
  easy: { lives: 5, hazard: 0.7, label: 'Easy' },
  normal: { lives: 3, hazard: 1.0, label: 'Normal' },
  hard: { lives: 2, hazard: 1.35, label: 'Hard' },
};
const MOVE_SPEED = 7.5;
const GRAVITY = 26;
const JUMP_V = 10;
const GUMMY_V = 17;
const CLOUD_V = 11;
const DASH_V = 15;
const DASH_TIME = 0.18;
const DASH_COOLDOWN = 0.8;
const COYOTE = 0.1;
const CRUMBLE_AFTER = 0.55;
const CRUMBLE_BACK = 3.5;
const COMBO_WINDOW = 1.6;
const CAM_OFFSET = new THREE.Vector3(0, 3.4, 7.8);
const CAM_LOOK = new THREE.Vector3(0, 0.8, -5);
const PLAYER_R = 0.4;
const TICKETS = 5;

// ---- renderer + scene ----------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1); // the layer reports backing-store pixels (camera-rig sample)
renderer.autoClear = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false; // rendered once per frame and shared by both eyes

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.sky);
scene.fog = new THREE.Fog(PALETTE.haze, 45, 150);
scene.environment = warmEnvironment();

const world = buildWorld(THREE);
scene.add(world.root);

const appCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.3, 400);
scene.add(appCam); // in the scene: the eye cameras are parented under it

// A warm factory "sky" for reflections on chocolate, copper and foil: amber glow above, cocoa below.
function warmEnvironment() {
  const env = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 48, 24);
  const pos = geo.attributes.position, cols = [];
  const top = new THREE.Color(0xffb27a), mid = new THREE.Color(0xa45a5a), low = new THREE.Color(0x2a140c);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 10;
    const c = y >= 0 ? mid.clone().lerp(top, Math.pow(y, 0.7)) : mid.clone().lerp(low, Math.min(1, -y * 2.5));
    cols.push(c.r * 0.7, c.g * 0.7, c.b * 0.7);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  env.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  for (const [x, z] of [[-6, -3], [6, -6], [0, 7]]) {                     // window glows
    const w = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 3.6, 2.2), side: THREE.DoubleSide }));
    w.position.set(x, 4, z);
    w.lookAt(0, 0, 0);
    env.add(w);
  }
  const pm = new THREE.PMREMGenerator(renderer);
  const t = pm.fromScene(env, 0.03).texture;
  pm.dispose();
  return t;
}

// ---- the player ---------------------------------------------------------------------------------
const hero = createPlayer(THREE);
const player = hero.root;
player.rotation.y = Math.PI; // back to the camera, facing into the factory
scene.add(player);

// ---- sparkle bursts (pop toward the viewer) ---------------------------------------------------
const SPARKS = 160;
const sparkGeo = new THREE.BufferGeometry();
const sparkPos = new Float32Array(SPARKS * 3);
const sparkCol = new Float32Array(SPARKS * 3);
sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkCol, 3));
const sparkMat = new THREE.PointsMaterial({ map: glow(), size: 0.42, vertexColors: true, transparent: true, depthWrite: false,
  blending: THREE.AdditiveBlending, toneMapped: false });
const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
sparkPoints.frustumCulled = false;
scene.add(sparkPoints);
const sparks = Array.from({ length: SPARKS }, () => ({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), c: new THREE.Color() }));

function burst(at, color = PALETTE.gold, n = 40, toward = true) {
  const toCam = appCam.position.clone().sub(at).normalize();
  const c = new THREE.Color(color);
  let made = 0;
  for (const s of sparks) {
    if (s.life > 0) continue;
    s.life = 0.9;
    s.p.copy(at);
    s.c.copy(c).lerp(new THREE.Color(0xffffff), Math.random() * 0.5);
    s.v.set((Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4);
    if (toward) s.v.addScaledVector(toCam, 3 + Math.random() * 2.5);
    if (++made >= n) break;
  }
}

// ---- game state ---------------------------------------------------------------------------------
const G = {
  state: 'title', // title | play | paused | won | over
  difficulty: 'normal',
  lives: 3,
  score: 0,
  sweets: 0,
  tickets: 0,
  combo: 0,
  comboT: 0,
  time: 0,
  best: loadBest(),
  checkpoint: new THREE.Vector3(START.x, START.y, START.z),
  invuln: 0,
  hint: 0,
};
const P = {
  pos: new THREE.Vector3(START.x, START.y, START.z),
  vel: new THREE.Vector3(),
  onGround: false,
  ground: null,
  airTime: 0,
  dashT: 0,
  dashCd: 0,
  airDash: true,
  facing: Math.PI,
};
let convPush = 0; // 0..1, eases back to 0 — the gummy-pad "push" toward the viewer

function loadBest() {
  try {
    return JSON.parse(localStorage.getItem('sugar-rush-best2')) || { score: 0, time: null };
  } catch {
    return { score: 0, time: null };
  }
}
function saveBest() {
  try {
    localStorage.setItem('sugar-rush-best2', JSON.stringify(G.best));
  } catch {
    /* private mode: the best lasts the session */
  }
}

function resetPlayer(at) {
  P.pos.copy(at);
  P.vel.set(0, 0, 0);
  P.onGround = false;
  P.ground = null;
  P.dashT = 0;
  P.airDash = true;
}

function startGame(difficulty = G.difficulty) {
  G.difficulty = DIFFICULTY[difficulty] ? difficulty : 'normal';
  G.lives = DIFFICULTY[G.difficulty].lives;
  G.score = G.sweets = G.tickets = G.combo = 0;
  G.comboT = 0;
  G.time = 0;
  G.invuln = 1;
  G.checkpoint.set(START.x, START.y, START.z);
  for (const s of world.sweets) {
    s.taken = false;
    s.mesh.visible = true;
  }
  for (const t of world.tickets) {
    t.taken = false;
    t.mesh.visible = true;
  }
  for (const p of world.platforms) {
    restorePlatform(p);
    p.reached = false;
    if (p.flagMat) {
      p.flagMat.color.setHex(0x8a6f86);
      p.flagMat.emissive.setHex(0x000000);
    }
  }
  reachCheckpoint(world.platforms[0]);
  G.checkpoint.set(START.x, START.y, START.z);
  resetPlayer(G.checkpoint);
  G.state = 'play';
  sfx.unlock();
  ui.show(null);
  hud();
}

function loseLife() {
  if (G.invuln > 0) return;
  sfx.hurt();
  G.lives--;
  G.combo = 0;
  if (G.lives <= 0) {
    G.state = 'over';
    $('overScore').textContent = G.score.toLocaleString();
    ui.show('over');
  } else {
    resetPlayer(G.checkpoint);
    G.invuln = 1.4;
  }
  hud();
}

function win() {
  G.state = 'won';
  sfx.win();
  const timeBonus = Math.max(0, Math.round(3000 - G.time * 12));
  const livesBonus = G.lives * 250;
  const perfect = G.tickets === TICKETS ? 2000 : 0;
  G.score += timeBonus + livesBonus + perfect;
  const record = G.score > (G.best.score || 0);
  if (record) G.best.score = G.score;
  if (!G.best.time || G.time < G.best.time) G.best.time = G.time;
  saveBest();
  $('winTime').textContent = fmt(G.time);
  $('winTickets').textContent = `${G.tickets} / ${TICKETS}`;
  $('winBreakdown').innerHTML =
    `<span>Sweets</span><b>${(G.score - timeBonus - livesBonus - perfect).toLocaleString()}</b>` +
    `<span>Time bonus</span><b>+${timeBonus.toLocaleString()}</b>` +
    `<span>Lives bonus</span><b>+${livesBonus.toLocaleString()}</b>` +
    (perfect ? `<span>All 5 Golden Tickets!</span><b>+${perfect.toLocaleString()}</b>` : '');
  $('winScore').textContent = G.score.toLocaleString();
  $('winNote').textContent = record ? 'New high score!' : `High score: ${G.best.score.toLocaleString()}`;
  ui.show('won');
  hud();
  burst(new THREE.Vector3(FOUNTAIN.x, FOUNTAIN.y + 3, FOUNTAIN.z), PALETTE.gold, 80);
}

// ---- physics -------------------------------------------------------------------------------------
const tmp = new THREE.Vector3();

function inside(p, x, z, pad) {
  if (p.shape === 'round') return Math.hypot(x - p.x, z - p.z) < p.w / 2 + pad;
  return Math.abs(x - p.x) < p.w / 2 + pad && Math.abs(z - p.z) < p.d / 2 + pad;
}

function restorePlatform(p) {
  p.solid = true;
  p.crumbleT = -1;
  p.respawnT = 0;
  p.mesh.visible = true;
  p.mesh.position.set(p.x, p.y, p.z);
  p.mesh.rotation.set(0, 0, 0);
}

function stepPlatforms(dt) {
  for (const p of world.platforms) {
    if (p.type !== 'crumble') continue;
    if (p.crumbleT >= 0 && p.solid) {
      p.crumbleT += dt;
      const shake = Math.min(1, p.crumbleT / CRUMBLE_AFTER) * 0.06;
      p.mesh.position.set(p.x + (Math.random() - 0.5) * shake, p.y, p.z + (Math.random() - 0.5) * shake);
      if (p.crumbleT > CRUMBLE_AFTER) {
        p.solid = false;
        p.respawnT = CRUMBLE_BACK;
        p.fallV = 0;
        sfx.crumble();
        burst(new THREE.Vector3(p.x, p.y, p.z), 0xd9a35a, 18, false);
      }
    } else if (!p.solid) {
      p.fallV += GRAVITY * 0.5 * dt;
      p.mesh.position.y -= p.fallV * dt;
      p.mesh.rotation.x += dt * 1.5;
      p.mesh.visible = p.mesh.position.y > RIVER_Y - 1;
      p.respawnT -= dt;
      if (p.respawnT <= 0) restorePlatform(p);
    }
  }
}

function stepPlayer(dt, inp) {
  const k = DIFFICULTY[G.difficulty].hazard;
  P.dashCd = Math.max(0, P.dashCd - dt);
  G.invuln = Math.max(0, G.invuln - dt);

  // horizontal control
  if (P.dashT > 0) {
    P.dashT -= dt;
    P.vel.y = 0;
  } else {
    const accel = P.onGround ? 45 : 16;
    const tx = inp.x * MOVE_SPEED;
    const tz = inp.z * MOVE_SPEED;
    P.vel.x += Math.max(-accel * dt, Math.min(accel * dt, tx - P.vel.x));
    P.vel.z += Math.max(-accel * dt, Math.min(accel * dt, tz - P.vel.z));
    P.vel.y -= GRAVITY * dt;
  }
  if (Math.hypot(inp.x, inp.z) > 0.1) P.facing = Math.atan2(inp.x, inp.z);

  // jump (with a little coyote time) and dash
  P.airTime = P.onGround ? 0 : P.airTime + dt;
  if (inp.jump && (P.onGround || P.airTime < COYOTE)) {
    P.vel.y = JUMP_V;
    P.onGround = false;
    P.airTime = COYOTE;
    sfx.jump();
  }
  if (inp.dash && P.dashCd === 0 && (P.onGround || P.airDash)) {
    const dx = Math.hypot(inp.x, inp.z) > 0.1 ? inp.x : Math.sin(P.facing);
    const dz = Math.hypot(inp.x, inp.z) > 0.1 ? inp.z : Math.cos(P.facing);
    const l = Math.hypot(dx, dz) || 1;
    P.vel.set((dx / l) * DASH_V, 0, (dz / l) * DASH_V);
    P.dashT = DASH_TIME;
    P.dashCd = DASH_COOLDOWN;
    if (!P.onGround) P.airDash = false;
    sfx.dash();
    burst(tmp.set(P.pos.x, P.pos.y + 0.6, P.pos.z).clone(), PALETTE.gummy, 12, false);
  }

  // ride what you stand on: moving trays carry you, belts push you
  if (P.onGround && P.ground) {
    P.pos.x += P.ground.dx;
    if (P.ground.type === 'conveyor') {
      P.pos.x += P.ground.push[0] * dt;
      P.pos.z += P.ground.push[1] * dt;
    }
  }

  const prevY = P.pos.y;
  const wasGround = P.onGround;
  const fallSpeed = -P.vel.y;
  P.pos.addScaledVector(P.vel, dt);

  // collide with platforms: land on tops, get pushed out of sides
  P.onGround = false;
  for (const p of world.platforms) {
    if (!p.solid) continue;
    const top = p.y;
    const bottom = top - p.h;
    if (inside(p, P.pos.x, P.pos.z, PLAYER_R * 0.4) && P.vel.y <= 0 && prevY >= top - 0.05 && P.pos.y <= top) {
      P.pos.y = top;
      P.vel.y = 0;
      P.onGround = true;
      P.ground = p;
      P.airDash = true;
      if (!wasGround) hero.land(Math.min(1.5, fallSpeed / 12));
      if (p.type === 'gummy') {
        P.vel.y = GUMMY_V;
        P.onGround = false;
        convPush = 1;
        sfx.bounce();
        p.pad.scale.y = 0.4;
      } else if (p.type === 'cloud') {
        P.vel.y = CLOUD_V;
        P.onGround = false;
        sfx.cloud();
        p.mesh.scale.set(1.08, 0.82, 1.08);
      } else if (p.type === 'crumble' && p.crumbleT < 0) {
        p.crumbleT = 0;
        sfx.creak();
      }
      if (p.checkpoint && !p.reached) reachCheckpoint(p);
      continue;
    }
    // side push-out when the body overlaps the platform below its top
    if (P.pos.y < top - 0.05 && P.pos.y + 1.4 > bottom) {
      if (p.shape === 'round') {
        const dx = P.pos.x - p.x, dz = P.pos.z - p.z, d = Math.hypot(dx, dz) || 1;
        const over = p.w / 2 + PLAYER_R - d;
        if (over > 0) {
          P.pos.x += (dx / d) * over;
          P.pos.z += (dz / d) * over;
        }
      } else {
        const ox = p.w / 2 + PLAYER_R - Math.abs(P.pos.x - p.x);
        const oz = p.d / 2 + PLAYER_R - Math.abs(P.pos.z - p.z);
        if (ox > 0 && oz > 0) {
          if (ox < oz) {
            P.pos.x += Math.sign(P.pos.x - p.x || 1) * ox;
            P.vel.x = 0;
          } else {
            P.pos.z += Math.sign(P.pos.z - p.z || 1) * oz;
            P.vel.z = 0;
          }
        }
      }
    }
  }
  for (const p of world.platforms) {
    if (p.pad) p.pad.scale.y += (1 - p.pad.scale.y) * Math.min(1, dt * 8);
    if (p.type === 'cloud') p.mesh.scale.lerp(tmp.set(1, 1, 1), Math.min(1, dt * 6));
  }

  // hazards
  tmp.set(P.pos.x, P.pos.y + 0.7, P.pos.z);
  for (const s of world.whisks) {
    // the spinning arm is a segment through the hub; touching either half hurts
    const ax = Math.cos(s.a), az = -Math.sin(s.a);
    const rx = tmp.x - s.x, rz = tmp.z - s.z;
    const along = Math.max(-s.arm, Math.min(s.arm, rx * ax + rz * az));
    const d = Math.hypot(rx - ax * along, rz - az * along);
    if (d < 0.45 && Math.abs(tmp.y - s.y) < 0.7) loseLife();
  }
  for (const g of world.jawbreakers) if (tmp.distanceTo(g.mesh.position) < g.r + PLAYER_R) loseLife();
  for (const p of world.platforms) {
    if (!p.vent || !p.vent.active) continue;
    if (Math.hypot(P.pos.x - p.x, P.pos.z - p.z) < 0.85 && P.pos.y < p.y + 3.2 && P.pos.y > p.y - 0.2) loseLife();
  }
  if (P.pos.y < KILL_Y) {
    sfx.splash();
    burst(new THREE.Vector3(P.pos.x, RIVER_Y + 0.2, P.pos.z), 0x6b3a1f, 30, false);
    G.invuln = 0;
    loseLife();
  }

  // sweets: chain them quickly for a combo multiplier
  G.comboT = Math.max(0, G.comboT - dt);
  if (G.comboT === 0) G.combo = 0;
  for (const s of world.sweets) {
    if (s.taken || tmp.distanceTo(s.mesh.position) > 0.85) continue;
    s.taken = true;
    s.mesh.visible = false;
    G.combo = Math.min(5, G.combo + 1);
    G.comboT = COMBO_WINDOW;
    const mult = Math.max(1, G.combo);
    G.score += s.value * mult;
    G.sweets++;
    sfx.sweet(G.combo, s.kind);
    burst(s.mesh.position.clone(), s.color, s.kind === 'truffle' ? 26 : 12);
    hud();
  }
  // Golden Tickets
  for (const t of world.tickets) {
    if (t.taken || tmp.distanceTo(t.mesh.position) > 1.3) continue;
    t.taken = true;
    t.mesh.visible = false;
    G.tickets++;
    G.score += 500;
    sfx.ticket();
    burst(t.mesh.position.clone(), PALETTE.gold, 60);
    toast(G.tickets === TICKETS_TO_OPEN ? 'Golden Ticket! The Golden Gate is open!' : `Golden Ticket! ${G.tickets} of ${TICKETS}`);
    hud();
  }

  // the fountain: the Golden Gate needs tickets
  const df = Math.hypot(P.pos.x - FOUNTAIN.x, P.pos.z - FOUNTAIN.z);
  if (df < 3.6 && P.pos.y > FOUNTAIN.y - 0.5) {
    if (G.tickets >= TICKETS_TO_OPEN) win();
    else if (G.hint <= 0) {
      sfx.locked();
      G.hint = 2.5;
      toast(`The Golden Gate needs ${TICKETS_TO_OPEN} Golden Tickets (${G.tickets}/${TICKETS_TO_OPEN}). Look off the path!`);
    }
  }
  G.hint = Math.max(0, G.hint - dt);

  player.position.copy(P.pos);
  player.rotation.y += (wrapAngle(P.facing - player.rotation.y)) * Math.min(1, dt * 12);
  player.visible = G.invuln <= 0 || Math.floor(G.invuln * 12) % 2 === 0;
  hero.animate(dt, { speed: Math.hypot(P.vel.x, P.vel.z), air: !P.onGround, vy: P.vel.y, dashing: P.dashT > 0 });
}

function reachCheckpoint(p) {
  p.reached = true;
  G.checkpoint.set(p.x, p.y + 0.01, p.z);
  if (p.flagMat) {
    p.flagMat.color.setHex(PALETTE.pink);
    p.flagMat.emissive.setHex(0xff3d7f);
    p.flagMat.emissiveIntensity = 0.8;
  }
  if (G.state === 'play' && p.i !== 0) {
    sfx.checkpoint();
    toast('Checkpoint!');
  }
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---- camera + depth --------------------------------------------------------------------------------
const camTarget = new THREE.Vector3();
const lookTarget = new THREE.Vector3();
let convergence = 8;

function stepCamera(dt, snap = false) {
  camTarget.copy(P.pos).add(CAM_OFFSET);
  lookTarget.copy(P.pos).add(CAM_LOOK);
  const a = snap ? 1 : 1 - Math.exp(-6 * dt);
  appCam.position.lerp(camTarget, a);
  appCam.lookAt(lookTarget);
  appCam.updateMatrixWorld();

  // the player sits on the zero-disparity plane; a gummy bounce pushes the plane out a little,
  // which brings the whole view briefly toward the viewer
  convPush = Math.max(0, convPush - dt * 1.8);
  const toPlayer = appCam.position.distanceTo(tmp.set(P.pos.x, P.pos.y + 0.7, P.pos.z));
  convergence = toPlayer * (1 + 0.18 * convPush);

  // foreground candy canes fade out before they get near the viewer (and the screen edges)
  const nearFade = convergence * 0.5;
  for (const post of world.posts) {
    const d = appCam.position.distanceTo(post.position);
    const o = Math.min(1, Math.max(0, (d - nearFade) / (convergence * 0.35)));
    post.material.opacity = o;
    post.children[0].material.opacity = o;
    post.visible = o > 0.02;
  }

  // sparkles fly toward the viewer and vanish before crossing half the convergence distance
  for (let i = 0; i < SPARKS; i++) {
    const s = sparks[i];
    if (s.life > 0) {
      s.life -= dt;
      s.v.y -= 4 * dt;
      s.p.addScaledVector(s.v, dt);
      if (appCam.position.distanceTo(s.p) < convergence * 0.55) s.life = 0;
    }
    if (s.life > 0) {
      sparkPos.set([s.p.x, s.p.y, s.p.z], i * 3);
      sparkCol.set([s.c.r, s.c.g, s.c.b], i * 3);
    } else sparkPos.set([0, -999, 0], i * 3);
  }
  sparkGeo.attributes.position.needsUpdate = true;
  sparkGeo.attributes.color.needsUpdate = true;

  // the key light (and its shadow box) travels with the player
  world.sun.position.set(P.pos.x + 9, P.pos.y + 20, P.pos.z + 6);
  world.sun.target.position.set(P.pos.x, P.pos.y, P.pos.z - 6);
  world.sun.target.updateMatrixWorld();
}

// ---- HUD + menus (plain DOM over the canvas: crisp, never woven) ------------------------------
const fmt = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

function hud() {
  $('score').textContent = G.score.toLocaleString();
  $('tickets').textContent = `${'🎫'.repeat(G.tickets)}${'·'.repeat(TICKETS - G.tickets)}`;
  $('tickets').title = `Golden Tickets: ${G.tickets} of ${TICKETS} (${TICKETS_TO_OPEN} open the Golden Gate)`;
  $('lives').textContent = '♥'.repeat(Math.max(0, G.lives));
  $('timer').textContent = fmt(G.time);
  const c = $('combo');
  c.hidden = G.combo < 2;
  c.textContent = `×${G.combo} combo`;
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

const ui = {
  show(which) {
    for (const id of ['title', 'paused', 'won', 'over']) $(id).hidden = id !== which;
    $('best').textContent = G.best.score ? `High score: ${G.best.score.toLocaleString()} · best time ${fmt(G.best.time)}` : '';
  },
};

for (const b of document.querySelectorAll('[data-start]')) {
  b.addEventListener('click', () => startGame($('difficulty').value));
}
$('resume').addEventListener('click', () => togglePause());
$('pauseBtn').addEventListener('click', () => togglePause());
$('muteBtn').addEventListener('click', () => {
  sfx.setMuted(!sfx.muted);
  $('muteBtn').textContent = sfx.muted ? 'Sound off' : 'Sound on';
});
$('difficulty').addEventListener('change', () => (G.difficulty = $('difficulty').value));

function togglePause() {
  if (G.state === 'play') {
    G.state = 'paused';
    ui.show('paused');
  } else if (G.state === 'paused') {
    G.state = 'play';
    ui.show(null);
  }
}

// ---- frame -----------------------------------------------------------------------------------------
const input = createInput(canvas, { stick: $('stick'), knob: $('knob'), jumpBtn: $('jumpBtn'), dashBtn: $('dashBtn') });
let last = performance.now();
let fpsAcc = 0;
let fpsN = 0;
let worldT = 0;

function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const inp = input.frame();

  if (inp.pause) togglePause();
  if (inp.confirm && (G.state === 'title' || G.state === 'won' || G.state === 'over')) startGame($('difficulty').value);

  if (G.state !== 'paused') worldT += dt;
  if (G.state === 'play') {
    G.time += dt;
    stepPlatforms(dt);
    stepPlayer(dt, inp);
    $('timer').textContent = fmt(G.time);
    if (G.combo < 2 && !$('combo').hidden) hud();
  } else if (G.state === 'title') {
    hero.animate(dt, { speed: 0, air: false, vy: 0, dashing: false });
  }
  if (G.state !== 'paused') updateWorld(world, worldT, dt, DIFFICULTY[G.difficulty].hazard, G.tickets);
  stepCamera(dt);
  renderer.shadowMap.needsUpdate = true;

  if (DEV) {
    fpsAcc += dt;
    fpsN++;
    if (fpsAcc > 0.5) {
      $('fps').textContent = `${Math.round(fpsN / fpsAcc)} fps`;
      fpsAcc = fpsN = 0;
    }
  }
}

// ---- rendering: 3D (woven) and 2D ------------------------------------------------------------
let sbsMode = false;
let handle = null;
const eyes = [new EyeCamera(THREE), new EyeCamera(THREE)];
const rigOut = {};

function sizeToCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round((canvas.clientWidth || 640) * dpr);
  const h = Math.round((canvas.clientHeight || 360) * dpr);
  // double width while woven: the layer splits the canvas into a left and a right half
  renderer.setSize(sbsMode ? w * 2 : w, h, false);
  appCam.aspect = w / h;
  appCam.updateProjectionMatrix();
}
addEventListener('resize', sizeToCanvas);

function onXRFrame(views, layer) {
  tick();
  // validate BEFORE clearing (a short view list must not become a dark frame)
  if (!views || views.length < 2 || !layer) return;
  const vps = views.map((v) => layer.getViewport(v));
  if (vps.some((vp) => !vp || vp.width <= 0 || vp.height <= 0)) return;

  handle.setViewRig(cameraRigFromCamera(THREE, appCam, { convergence, ipdFactor: depth, attach: true, out: rigOut }));

  renderer.clear();
  renderer.setScissorTest(true);
  for (let i = 0; i < 2; i++) {
    const vp = vps[i];
    renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
    renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
    eyes[i].setLocalFromView(views[i]);
    renderer.render(scene, eyes[i].camera);
  }
  renderer.setScissorTest(false);
}

function onMonoFrame() {
  requestAnimationFrame(onMonoFrame);
  tick();
  const size = renderer.getSize(new THREE.Vector2());
  renderer.clear();
  renderer.setViewport(0, 0, size.x, size.y);
  renderer.render(scene, appCam);
}

// ---- depth slider -----------------------------------------------------------------------------
// 0-200% of the designed depth: the camera rig's ipdFactor (absolute on a camera rig, so 1 = true
// eye separation). Convergence is untouched, so the player stays on the screen plane at any depth.
// At 200% the comfort product (DESIGN.md) is still about 0.12, far inside the limit of 1.
let depth = 1;
try {
  const v = parseFloat(localStorage.getItem('sugar-rush-depth'));
  if (v >= 0 && v <= 2) depth = v;
} catch { /* storage blocked: default depth */ }
function setDepth(d) {
  depth = Math.round(Math.min(2, Math.max(0, d)) * 20) / 20;
  try { localStorage.setItem('sugar-rush-depth', String(depth)); } catch { /* fine without */ }
  $('depth').value = String(Math.round(depth * 100));
  $('depthVal').textContent = `${Math.round(depth * 100)}%`;
}
function setupDepth() {
  $('depthWrap').hidden = false;
  setDepth(depth);
  const slider = $('depth');
  slider.addEventListener('input', () => setDepth(Number(slider.value) / 100));
  slider.addEventListener('change', () => slider.blur()); // hand the arrow keys back to the game
  addEventListener('keydown', (e) => {
    if (e.key === '[') setDepth(depth - 0.1);
    if (e.key === ']') setDepth(depth + 0.1);
  });
}

// ---- 2D/3D switch (display-modes sample: setStereoEnabled + renderingmodechange) ------------
let stereoOn = true;
function setupModeToggle(wall) {
  const btn = $('modeBtn');
  if (!wall.supported || !inline3dDisplayModesSupported()) return;
  btn.hidden = false;
  const label = () => (btn.textContent = stereoOn ? '3D on' : '3D off');
  label();
  btn.addEventListener('click', async () => {
    const ok = await wall.setStereoEnabled(!stereoOn);
    if (!ok) toast('The display could not switch modes');
  });
  wall.on('renderingmodechange', (e) => {
    if (e.viewCount != null) stereoOn = e.viewCount !== 1;
    label();
  });
}

// ---- boot ------------------------------------------------------------------------------------------
resetPlayer(G.checkpoint);
reachCheckpoint(world.platforms[0]);
stepCamera(0, true);
hud();
ui.show('title');
if (DEV) $('fps').hidden = false;
// Test flags: ?start skips the title; ?at=<platform index> starts the run there (screenshots, QA).
{
  const q = new URLSearchParams(location.search);
  if (q.has('start') || q.has('at')) {
    startGame();
    const p = world.platforms[Number(q.get('at'))];
    if (p) {
      resetPlayer(new THREE.Vector3(p.x, p.y + 0.01, p.z + (p.shape === 'round' ? 0 : p.d / 2 - 0.6)));
      stepCamera(0, true);
    }
  }
}

(async () => {
  const wall = await createInline3D({ lazy: false });
  if (!wall.supported) {
    $('cover').hidden = true;
    $('mode').textContent = '2D';
    sizeToCanvas();
    requestAnimationFrame(onMonoFrame);
    return;
  }
  sbsMode = true;
  sizeToCanvas();
  for (const eye of eyes) appCam.add(eye.camera); // attach: eyes read the view as a rig-local pose
  handle = wall.addScene(canvas, onXRFrame, {
    viewRig: cameraRigFromCamera(THREE, appCam, { convergence, ipdFactor: depth, attach: true, out: rigOut }),
  });
  $('mode').textContent = '3D';
  setupModeToggle(wall);
  setupDepth();
  await handle.firstWoven; // keep the cover on until the first woven frame, then cut it
  $('cover').hidden = true;
})();

// ---- agent hook (for a voice agent or any script; no network bridge yet) ---------------------
window.sugarRush = {
  start_game: (difficulty) => startGame(difficulty),
  set_difficulty: (name) => {
    if (!DIFFICULTY[name]) return false;
    G.difficulty = name;
    $('difficulty').value = name;
    return true;
  },
  show_score: () => ({ state: G.state, score: G.score, sweets: G.sweets, tickets: G.tickets, lives: G.lives, time: Number(G.time.toFixed(1)), best: G.best, difficulty: G.difficulty }),
};
if (DEV) window.__sugar = { G, P, world, teleport: (x, y, z) => resetPlayer(new THREE.Vector3(x, y, z)) };
