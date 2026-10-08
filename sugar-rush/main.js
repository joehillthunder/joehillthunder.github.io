// Sugar Rush — a candy-factory 3D platformer for glasses-free 3D displays (DisplayXR), and a
// normal 3D game in 2D anywhere else.
//
// DisplayXR wiring follows the SDK's samples/camera-rig: one inline-3D session, one woven
// canvas, a CAMERA rig rebuilt every frame from the follow camera (the runtime offsets the eyes
// and skews each frustum), the eye cameras parented under the app camera ("attach"), each eye
// rendered into the viewport the layer reports. Depth layout: DESIGN.md.

import * as THREE from 'three';
import { createInline3D, inline3dDisplayModesSupported } from '@displayxr/inline3d';
import { EyeCamera, cameraRigFromCamera } from '@displayxr/inline3d/three';
import { buildWorld, updateWorld, PALETTE, START, FOUNTAIN, KILL_Y } from './world.js';
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
const DASH_V = 15;
const DASH_TIME = 0.18;
const DASH_COOLDOWN = 0.8;
const COYOTE = 0.1;
const CAM_OFFSET = new THREE.Vector3(0, 3.4, 7.8);
const CAM_LOOK = new THREE.Vector3(0, 0.8, -5);
const PLAYER_R = 0.4;

// ---- renderer + scene ----------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1); // the layer reports backing-store pixels (camera-rig sample)
renderer.autoClear = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.sky);
scene.fog = new THREE.Fog(PALETTE.sky, 60, 170);

const world = buildWorld(THREE);
scene.add(world.root);

const appCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.3, 400);
scene.add(appCam); // in the scene: the eye cameras are parented under it

// ---- the player (primitives only) --------------------------------------------------------------
const player = new THREE.Group();
{
  const m = (c, e = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, emissive: e });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.45, 6, 14), m(0x9ff0d8));
  body.position.y = 0.55;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 14), m(0xffd9b8));
  head.position.y = 1.15;
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.31, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), m(0xc8642a));
  hair.position.y = 1.18;
  const goggles = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.05, 8, 20), m(0x3fe0e8, 0x0d4a4e));
  goggles.position.set(0, 1.28, 0);
  goggles.rotation.x = Math.PI / 2.4;
  const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.07, 8, 20), m(0xff9cc8));
  scarf.position.y = 0.88;
  scarf.rotation.x = Math.PI / 2;
  player.add(body, head, hair, goggles, scarf);
}
scene.add(player);

// ---- sparkle bursts (pop toward the viewer) ---------------------------------------------------
const SPARKS = 96;
const sparkGeo = new THREE.BufferGeometry();
const sparkPos = new Float32Array(SPARKS * 3);
sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
const sparkMat = new THREE.PointsMaterial({ color: PALETTE.gold, size: 0.22, transparent: true, depthWrite: false });
const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
sparkPoints.frustumCulled = false;
scene.add(sparkPoints);
const sparks = Array.from({ length: SPARKS }, () => ({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3() }));

function burst(at) {
  const toCam = appCam.position.clone().sub(at).normalize();
  let n = 0;
  for (const s of sparks) {
    if (s.life > 0) continue;
    s.life = 0.9;
    s.p.copy(at);
    s.v.copy(toCam).multiplyScalar(3 + Math.random() * 2.5)
      .add(new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4));
    if (++n >= 40) break;
  }
}

// ---- game state ---------------------------------------------------------------------------------
const G = {
  state: 'title', // title | play | paused | won | over
  difficulty: 'normal',
  lives: 3,
  seals: 0,
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
  facing: 0,
};
let convPush = 0; // 0..1, eases back to 0 — the gummy-pad "push" toward the viewer

function loadBest() {
  try {
    return Number(localStorage.getItem('sugar-rush-best')) || null;
  } catch {
    return null;
  }
}
function saveBest(t) {
  try {
    localStorage.setItem('sugar-rush-best', String(t));
  } catch {
    /* private mode: best time lasts the session */
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
  G.seals = 0;
  G.time = 0;
  G.invuln = 1;
  G.checkpoint.set(START.x, START.y, START.z);
  for (const s of world.seals) {
    s.taken = false;
    s.mesh.visible = true;
  }
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
  if (G.lives <= 0) {
    G.state = 'over';
    ui.show('over');
  } else {
    resetPlayer(G.checkpoint);
    G.invuln = 1.2;
  }
  hud();
}

function win() {
  G.state = 'won';
  sfx.win();
  const t = G.time;
  const record = !G.best || t < G.best;
  if (record) {
    G.best = t;
    saveBest(t);
  }
  $('winTime').textContent = fmt(t);
  $('winNote').textContent = record ? 'New best time!' : `Best: ${fmt(G.best)}`;
  ui.show('won');
  burst(new THREE.Vector3(FOUNTAIN.x, FOUNTAIN.y + 3, FOUNTAIN.z));
}

// ---- physics -------------------------------------------------------------------------------------
const tmp = new THREE.Vector3();

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
  }

  // ride a moving platform
  if (P.onGround && P.ground) P.pos.x += P.ground.dx;

  const prevY = P.pos.y;
  P.pos.addScaledVector(P.vel, dt);

  // collide with platform boxes: land on tops, get pushed out of sides
  P.onGround = false;
  for (const p of world.platforms) {
    const hx = p.w / 2;
    const hz = p.d / 2;
    const top = p.y;
    const bottom = top - world.PLAT_H;
    const inX = Math.abs(P.pos.x - p.x) < hx + PLAYER_R * 0.4;
    const inZ = Math.abs(P.pos.z - p.z) < hz + PLAYER_R * 0.4;
    if (inX && inZ && P.vel.y <= 0 && prevY >= top - 0.05 && P.pos.y <= top) {
      P.pos.y = top;
      P.vel.y = 0;
      P.onGround = true;
      P.ground = p;
      P.airDash = true;
      if (p.type === 'gummy') {
        P.vel.y = GUMMY_V;
        P.onGround = false;
        convPush = 1;
        sfx.bounce();
        p.pad.scale.y = 0.4;
      }
      continue;
    }
    // side push-out when the body overlaps the box below its top
    const bodyLo = P.pos.y;
    const bodyHi = P.pos.y + 1.4;
    if (bodyLo < top - 0.05 && bodyHi > bottom) {
      const ox = hx + PLAYER_R - Math.abs(P.pos.x - p.x);
      const oz = hz + PLAYER_R - Math.abs(P.pos.z - p.z);
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
  for (const p of world.platforms) if (p.pad) p.pad.scale.y += (1 - p.pad.scale.y) * Math.min(1, dt * 8);

  // hazards
  tmp.set(P.pos.x, P.pos.y + 0.7, P.pos.z);
  for (const s of world.saws) if (tmp.distanceTo(s.mesh.position) < s.r + PLAYER_R) loseLife();
  for (const g of world.gumballs) if (tmp.distanceTo(g.mesh.position) < g.r + PLAYER_R) loseLife();
  if (P.pos.y < KILL_Y) {
    G.invuln = 0;
    loseLife();
  }

  // seals: collecting one also moves the checkpoint there
  for (const s of world.seals) {
    if (s.taken || tmp.distanceTo(s.mesh.position) > 1.2) continue;
    s.taken = true;
    s.mesh.visible = false;
    G.seals++;
    G.checkpoint.set(s.x, s.y - 1.2 + 0.01, s.z);
    sfx.seal();
    burst(s.mesh.position.clone());
    hud();
  }

  // the fountain: only opens with all four seals
  const df = Math.hypot(P.pos.x - FOUNTAIN.x, P.pos.z - FOUNTAIN.z);
  if (df < 3.6 && P.pos.y > FOUNTAIN.y - 0.5) {
    if (G.seals >= 4) win();
    else if (G.hint <= 0) {
      sfx.locked();
      G.hint = 2.5;
      toast(`The fountain needs all 4 seals (${G.seals}/4)`);
    }
  }
  G.hint = Math.max(0, G.hint - dt);

  updateWorld(world, G.time, dt, k);
  player.position.copy(P.pos);
  player.rotation.y += (wrapAngle(P.facing - player.rotation.y)) * Math.min(1, dt * 12);
  player.visible = G.invuln <= 0 || Math.floor(G.invuln * 12) % 2 === 0;
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
    if (s.life > 0) sparkPos.set([s.p.x, s.p.y, s.p.z], i * 3);
    else sparkPos.set([0, -999, 0], i * 3);
  }
  sparkGeo.attributes.position.needsUpdate = true;
}

// ---- HUD + menus (plain DOM over the canvas: crisp, never woven) ------------------------------
const fmt = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

function hud() {
  $('seals').textContent = `${'●'.repeat(G.seals)}${'○'.repeat(4 - G.seals)}`;
  $('lives').textContent = '♥'.repeat(Math.max(0, G.lives));
  $('timer').textContent = fmt(G.time);
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

const ui = {
  show(which) {
    for (const id of ['title', 'paused', 'won', 'over']) $(id).hidden = id !== which;
    $('best').textContent = G.best ? `Best time: ${fmt(G.best)}` : '';
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

function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const inp = input.frame();

  if (inp.pause) togglePause();
  if (inp.confirm && (G.state === 'title' || G.state === 'won' || G.state === 'over')) startGame($('difficulty').value);

  if (G.state === 'play') {
    G.time += dt;
    stepPlayer(dt, inp);
    $('timer').textContent = fmt(G.time);
  } else {
    updateWorld(world, now / 1000, dt, 1);
  }
  stepCamera(dt);

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

  handle.setViewRig(cameraRigFromCamera(THREE, appCam, { convergence, attach: true, out: rigOut }));

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
stepCamera(0, true);
hud();
ui.show('title');
if (DEV) $('fps').hidden = false;

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
    viewRig: cameraRigFromCamera(THREE, appCam, { convergence, attach: true, out: rigOut }),
  });
  $('mode').textContent = '3D';
  setupModeToggle(wall);
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
  show_score: () => ({ state: G.state, seals: G.seals, lives: G.lives, time: Number(G.time.toFixed(1)), best: G.best && Number(G.best.toFixed(1)), difficulty: G.difficulty }),
};
if (DEV) window.__sugar = { G, P, world, teleport: (x, y, z) => resetPlayer(new THREE.Vector3(x, y, z)) };
