// Chapter "Robot’s eye": what a policy sees. While the pretrained prompted policy runs the kitchen
// task, a simulated depth camera (wrist-mounted or fixed at the front) renders the scene into a small
// render target a few times a second: a depth pass (MeshDepthMaterial, RGBA packing) and a colour pass.
// Both are read back, each pixel's depth is unprojected through the camera, and the result is drawn as
// a coloured point cloud in the scene. "Robot’s view" hides the kitchen and the objects, leaving the
// arm, the cloud and the camera frustum. A simulated sensor: no noise model, just the sim's renderer.

const W = 128, H = 96;         // depth image size
const PERIOD = 0.2;            // s between captures (5 Hz)
const CLIP = 1.5;              // m: drop points farther than this from the camera
const CROP = { y0: 0.9, y1: 1.3, zMin: 0.06, r: 0.55, cx: 2.3, cz: 0.42 }; // three.js frame: keep the counter top around the work area
const MAP_MAX = 60000;         // accumulated map size
const VOXEL = 0.005;           // m: map de-duplication grid

let T = null;                  // THREE, from ctx
const S = {
  cam: 'wrist', view: 'robot', acc: false,
  timer: 0, t: 0, loopTimer: 0, run: 0, active: false,
};

function seg(id, items) {
  return `<div class="pc-seg" id="${id}">${items.map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`).join('')}</div>`;
}

const html = `<style>
.pc-seg { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
.pc-check { display: flex; align-items: center; gap: 8px; margin: 10px 0 4px; font-size: 13px; }
.pc-legend { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; font-size: 12px; margin-top: 6px; }
.pc-legend dt { color: var(--muted); }
.pc-legend dd { margin: 0; }
</style>
<h2>What the policy sees</h2>
<p class="lede">A policy doesn’t see a kitchen. It sees depth pixels. Here a simulated depth camera samples the scene
  ${W} × ${H} at 5 Hz while the pretrained policy works, and every pixel becomes a point in 3D. Switch to the robot’s
  view: the kitchen disappears and only the point cloud is left. On a 3D display you can judge how far the oranges
  are from the gripper, which a flat depth map doesn’t show.</p>
<h3>Camera</h3>
${seg('pc-cam', [['wrist', 'Wrist'], ['front', 'Front']])}
<h3>View</h3>
${seg('pc-view', [['scene', 'Scene + cloud'], ['robot', 'Robot’s view']])}
<label class="pc-check"><input type="checkbox" id="pc-acc"> Accumulate a map over time</label>
<div class="row"><button type="button" id="pc-clear">Clear map</button></div>
<div class="status" id="pc-status"></div>
<dl class="pc-legend">
  <dt>Sensor</dt><dd>${W} × ${H} depth + colour, 5 Hz, cropped to the counter top around the work area</dd>
  <dt>Wrist</dt><dd>rides on the tool frame, looking past the fingertips</dd>
  <dt>Front</dt><dd>fixed, looking at the workspace from the front of the counter</dd>
</dl>
<p class="small">Simulated: rendered by the same engine as the scene, with no sensor noise or missing returns. A real
  depth camera is noisier; the 3D view is the same idea.</p>`;

// ---- capture ---------------------------------------------------------------------------------------

let rtDepth, rtColor, depthMat, cam, bufD, bufC;
let live, liveGeo, map, mapGeo, mapCount = 0, mapKeys = null, frustum, frustumGeo;
const tmp = {};

function setup(ctx) {
  T = ctx.THREE;
  rtDepth = new T.WebGLRenderTarget(W, H, { depthBuffer: true });
  rtColor = new T.WebGLRenderTarget(W, H, { depthBuffer: true });
  depthMat = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking });
  cam = new T.PerspectiveCamera(62, W / H, 0.03, 2.0);
  bufD = new Uint8Array(W * H * 4);
  bufC = new Uint8Array(W * H * 4);
  tmp.v = new T.Vector3(); tmp.p = new T.Vector3(); tmp.q = new T.Vector3(); tmp.up = new T.Vector3();
  tmp.cc = new T.Color();

  liveGeo = new T.BufferGeometry();
  liveGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(W * H * 3), 3));
  liveGeo.setAttribute('color', new T.BufferAttribute(new Float32Array(W * H * 3), 3));
  liveGeo.setDrawRange(0, 0);
  live = new T.Points(liveGeo, new T.PointsMaterial({ size: 0.0075, sizeAttenuation: true, vertexColors: true }));
  live.frustumCulled = false;

  mapGeo = new T.BufferGeometry();
  mapGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(MAP_MAX * 3), 3));
  mapGeo.setAttribute('color', new T.BufferAttribute(new Float32Array(MAP_MAX * 3), 3));
  mapGeo.setDrawRange(0, 0);
  map = new T.Points(mapGeo, new T.PointsMaterial({ size: 0.0045, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.8 }));
  map.frustumCulled = false;

  // frustum: apex + 4 corner rays + the near rectangle at 0.18 m
  frustumGeo = new T.BufferGeometry();
  frustumGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(16 * 3), 3));
  frustum = new T.LineSegments(frustumGeo, new T.LineBasicMaterial({ color: 0x847fea, transparent: true, opacity: 0.95 }));
  frustum.frustumCulled = false;
}

/** Places the sensor camera for the current mode. */
function placeCamera(ctx) {
  const w = ctx.world;
  cam.fov = S.cam === 'wrist' ? 85 : 40; // wrist cams are wide; the fixed one frames the work area
  if (S.cam === 'wrist') {
    const tip = w.main.robot.tip;
    tip.updateWorldMatrix(true, false);
    // tool frame: wrist toward -z, fingertips at z = 0. Sit 6 cm behind the tips, look along +z.
    tip.localToWorld(tmp.p.set(0, 0, -0.06));
    tip.localToWorld(tmp.q.set(0, 0, 0.4));
    tmp.up.set(0, 1, 0).applyQuaternion(tip.getWorldQuaternion(new T.Quaternion()));
    cam.position.copy(tmp.p);
    cam.up.copy(tmp.up);
    cam.lookAt(tmp.q);
  } else {
    // USD (x, y, z) -> three (x, z, -y): in front of the counter, above, looking at the work area
    // USD (1.95, -0.95, 1.36): front-left of the counter, 45 cm up, looking down at the work area
    cam.position.set(1.95, 1.36, 0.95);
    cam.up.set(0, 1, 0);
    cam.lookAt(2.3, 0.95, 0.4);
  }
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
}

function updateFrustum() {
  const pos = frustumGeo.attributes.position.array;
  const apex = cam.position, L = 0.18;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
    const v = new T.Vector3(x, y, 0.5).unproject(cam).sub(apex).normalize().multiplyScalar(L).add(apex);
    return v;
  });
  let k = 0;
  const put = (v) => { pos[k++] = v.x; pos[k++] = v.y; pos[k++] = v.z; };
  for (let i = 0; i < 4; i++) { put(apex); put(corners[i]); }
  for (let i = 0; i < 4; i++) { put(corners[i]); put(corners[(i + 1) % 4]); }
  frustumGeo.attributes.position.needsUpdate = true;
  frustumGeo.computeBoundingSphere();
}

/** Renders depth + colour from the sensor camera and rebuilds the live cloud. */
function capture(ctx) {
  const r = ctx.stage.renderer, scene = ctx.stage.scene, w = ctx.world;
  placeCamera(ctx);

  // what the sensor sees: the full scene, minus this chapter's overlays (and the arm itself on the wrist)
  const restore = [];
  const hide = (o, vis) => { if (o) { restore.push([o, o.visible]); o.visible = vis; } };
  hide(live, false); hide(map, false); hide(frustum, false);
  hide(w.kitchen, true);
  for (const o of w.main.oranges) hide(o, true);
  hide(w.main.plate, true); hide(w.bowl, true);
  hide(w.main.goal, false); hide(w.main.ring, false);
  if (S.cam === 'wrist') hide(w.main.robot.root, false);

  const prevTarget = r.getRenderTarget();
  const prevClear = r.getClearColor(tmp.cc).getHex(), prevAlpha = r.getClearAlpha();
  const prevScissor = r.getScissorTest();
  const prevOverride = scene.overrideMaterial;
  r.setScissorTest(false);
  try {
    // depth: cleared to white = "nothing hit"
    scene.overrideMaterial = depthMat;
    r.setRenderTarget(rtDepth);
    r.setClearColor(0xffffff, 1);
    r.clear(true, true, true);
    r.render(scene, cam);
    scene.overrideMaterial = prevOverride;
    // colour
    r.setRenderTarget(rtColor);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, true);
    r.render(scene, cam);
    r.readRenderTargetPixels(rtDepth, 0, 0, W, H, bufD);
    r.readRenderTargetPixels(rtColor, 0, 0, W, H, bufC);
  } finally {
    scene.overrideMaterial = prevOverride;
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevClear, prevAlpha);
    r.setScissorTest(prevScissor);
    for (let i = restore.length - 1; i >= 0; i--) restore[i][0].visible = restore[i][1];
  }

  // unpack (three's packDepthToRGBA, r0.161) and unproject
  const P = liveGeo.attributes.position.array, C = liveGeo.attributes.color.array;
  const k3 = 255 / 256, f0 = k3 / (256 * 256 * 256), f1 = k3 / (256 * 256), f2 = k3 / 256;
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const d = (bufD[i] * f0 + bufD[i + 1] * f1 + bufD[i + 2] * f2 + bufD[i + 3] * k3) / 255;
      if (d >= 0.9995) continue;
      tmp.v.set(((x + 0.5) / W) * 2 - 1, ((y + 0.5) / H) * 2 - 1, d * 2 - 1).unproject(cam);
      if (tmp.v.distanceTo(cam.position) > CLIP) continue;
      if (tmp.v.y < CROP.y0 || tmp.v.y > CROP.y1 || tmp.v.z < CROP.zMin || Math.hypot(tmp.v.x - CROP.cx, tmp.v.z - CROP.cz) > CROP.r) continue; // workspace only, no back wall
      P[n * 3] = tmp.v.x; P[n * 3 + 1] = tmp.v.y; P[n * 3 + 2] = tmp.v.z;
      C[n * 3] = bufC[i] / 255; C[n * 3 + 1] = bufC[i + 1] / 255; C[n * 3 + 2] = bufC[i + 2] / 255;
      // the map keeps the static scene: points low over the counter (the moving arm would smear across it)
      if (S.acc && mapCount < MAP_MAX && tmp.v.y < 1.02) addToMap(tmp.v, C[n * 3], C[n * 3 + 1], C[n * 3 + 2]);
      n++;
    }
  }
  liveGeo.setDrawRange(0, n);
  liveGeo.attributes.position.needsUpdate = true;
  liveGeo.attributes.color.needsUpdate = true;
  liveGeo.computeBoundingSphere();
  if (S.acc) {
    mapGeo.setDrawRange(0, mapCount);
    mapGeo.attributes.position.needsUpdate = true;
    mapGeo.attributes.color.needsUpdate = true;
  }
  updateFrustum();
  S.lastN = n;
  status(ctx);
}

function addToMap(v, r, g, b) {
  const key = `${Math.round(v.x / VOXEL)},${Math.round(v.y / VOXEL)},${Math.round(v.z / VOXEL)}`;
  if (mapKeys.has(key)) return;
  mapKeys.add(key);
  const P = mapGeo.attributes.position.array, C = mapGeo.attributes.color.array, i = mapCount * 3;
  P[i] = v.x; P[i + 1] = v.y; P[i + 2] = v.z;
  C[i] = r; C[i + 1] = g; C[i + 2] = b;
  mapCount++;
}

function clearMap() {
  mapCount = 0;
  mapKeys = new Set();
  mapGeo.setDrawRange(0, 0);
}

function status(ctx) {
  const el = ctx.$('pc-status');
  if (!el) return;
  el.innerHTML = `<b>${(S.lastN || 0).toLocaleString()}</b> points this frame from the ${S.cam === 'wrist' ? 'wrist' : 'front'} camera`
    + (S.acc ? ` · map <b>${mapCount.toLocaleString()}</b>${mapCount >= MAP_MAX ? ' (full)' : ''}` : '');
}

// ---- view ------------------------------------------------------------------------------------------

function applyView(ctx) {
  const w = ctx.world, robotView = S.view === 'robot';
  w.kitchen.visible = !robotView;
  for (const o of w.main.oranges) o.visible = !robotView;
  w.main.plate.visible = !robotView;
  if (w.bowl) w.bowl.visible = !robotView;
  ctx.stage.renderer.setClearColor(robotView ? 0x07051a : 0x0b0e14, 1);
  for (const b of ctx.$('pc-view').children) b.classList.toggle('on', b.dataset.v === S.view);
  for (const b of ctx.$('pc-cam').children) b.classList.toggle('on', b.dataset.v === S.cam);
}

// ---- the policy keeps working while we watch -------------------------------------------------------

function runLoop(ctx) {
  if (!S.active) return;
  const strong = ctx.STRONG();
  const i = S.run++;
  const prompt = { slot: i % 2, order: strong[i % 2 === 0 ? 0 : 1], seen: 3 };
  ctx.runPrompted({
    prompt,
    name: `Pretrained policy · ${ctx.containerNames()[prompt.slot]} · ${prompt.order.map((k) => k + 1).join('→')}`,
    onDone: () => { if (S.active) S.loopTimer = setTimeout(() => runLoop(ctx), 1200); },
  });
}

export default {
  id: 'pointcloud',
  label: 'Robot’s eye',
  html,
  init(ctx) {
    setup(ctx);
    window.gen3dPointcloud = { S, get cam() { return cam; }, get live() { return live; } }; // debug handle
    mapKeys = new Set();
    ctx.$('pc-cam').addEventListener('click', (e) => {
      const v = e.target.closest('button')?.dataset.v;
      if (!v) return;
      S.cam = v; clearMap(); applyView(ctx); S.timer = PERIOD;
    });
    ctx.$('pc-view').addEventListener('click', (e) => {
      const v = e.target.closest('button')?.dataset.v;
      if (!v) return;
      S.view = v; applyView(ctx);
      ctx.stage.flyTo(v === 'robot' ? { target: ctx.VIEWS.work.target, dist: 1.05, yaw: 0.55, pitch: 0.5, radius: 0.4 } : ctx.VIEWS.work);
    });
    ctx.$('pc-acc').addEventListener('change', (e) => { S.acc = e.target.checked; if (!S.acc) clearMap(); status(ctx); });
    ctx.$('pc-clear').addEventListener('click', () => { clearMap(); status(ctx); });
  },
  enter(ctx) {
    S.active = true;
    const scene = ctx.stage.scene;
    scene.add(live, map, frustum);
    live.visible = map.visible = frustum.visible = true;
    applyView(ctx);
    ctx.stage.idleSway = false;
    ctx.stage.flyTo(S.view === 'robot' ? { target: ctx.VIEWS.work.target, dist: 1.05, yaw: 0.55, pitch: 0.5, radius: 0.4 } : ctx.VIEWS.work);
    S.timer = PERIOD;
    runLoop(ctx);
  },
  leave(ctx) {
    S.active = false;
    clearTimeout(S.loopTimer);
    ctx.sim.onDone = null;
    ctx.setPlaying(false);
    ctx.sim.mode = 'idle';
    const scene = ctx.stage.scene;
    scene.remove(live, map, frustum);
    const w = ctx.world;
    w.kitchen.visible = true;
    for (const o of w.main.oranges) o.visible = true;
    w.main.plate.visible = true;
    if (w.bowl) w.bowl.visible = true;
    w.setMode('kitchen');
  },
  tick(dt, ctx) {
    if (!S.active) return false;
    S.timer += dt;
    if (S.timer >= PERIOD) { S.timer = 0; capture(ctx); }
    return false; // main runs the sim, draws the kitchen view and the HUD
  },
};
