// Material Forge: a Substance-style material authoring tool. Layer stacks of procedural
// generators (or photos) bake to PBR maps on the CPU; the result is previewed on objects you build
// from primitives or upload, painted onto directly, sampled from photos, and pushed to DisplayXR HQ.

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Stage, wireDepthChip } from '../shared/stage.js';
import { $, $$, el, wireSections, wireTabs, slider, select, color, toggle, toast, modal, pickFiles, onDrop, download, slug, exportGLB, loadModelFile, fitObject, readImage, pushDialog } from '../shared/ui.js';
import { GENERATORS, Compositor, makeLayer, cloneLayer, stamp, extractPalette } from './gen.js';
import { PRESETS } from './presets.js';

// ---------------------------------------------------------------------------------------------
// Stage, lights, environment

const stage = new Stage($('#stage'), { fov: 35, tag: 'forge' });
const { scene, renderer, cam, controls } = stage;
cam.position.set(2.2, 1.5, 3.1);
controls.target.set(0, 0.75, 0);
renderer.toneMappingExposure = 1;
const pmrem = new THREE.PMREMGenerator(renderer);

function skyEnv(top, horizon, bottom, sun, sunDir) {
  const s = new THREE.Scene();
  const geo = new THREE.SphereGeometry(50, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { top: { value: new THREE.Color(top) }, hor: { value: new THREE.Color(horizon) }, bot: { value: new THREE.Color(bottom) } },
    vertexShader: 'varying vec3 p; void main(){ p = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
    fragmentShader: 'uniform vec3 top, hor, bot; varying vec3 p; void main(){ float y = p.y; vec3 c = y > 0. ? mix(hor, top, pow(y, .55)) : mix(hor, bot, pow(-y, .35)); gl_FragColor = vec4(c, 1.); }',
  });
  s.add(new THREE.Mesh(geo, mat));
  const sm = new THREE.Mesh(new THREE.SphereGeometry(3, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(sun).multiplyScalar(30) }));
  sm.position.set(...sunDir).normalize().multiplyScalar(40);
  s.add(sm);
  const rt = pmrem.fromScene(s, 0.02);
  return rt.texture;
}

const ENVS = {
  Studio: () => pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture,
  'Warm sunset': () => skyEnv('#2d3f6b', '#f2a65a', '#3a2a22', '#ffcf8a', [-1, 0.25, 0.6]),
  'Overcast': () => skyEnv('#9fb3c8', '#dfe6ec', '#6b6f73', '#ffffff', [0.3, 1, 0.2]),
  'Night lab': () => skyEnv('#05070d', '#18324a', '#020203', '#7fd8ff', [0.6, 0.5, -0.8]),
};
const envCache = {};
const view = { env: 'Studio', bg: '#1a1d23', exposure: 1, grid: true, autoRotate: false };
function applyEnv() {
  envCache[view.env] ??= ENVS[view.env]();
  scene.environment = envCache[view.env];
  scene.background = new THREE.Color(view.bg);
  renderer.toneMappingExposure = view.exposure;
}
applyEnv();

const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(3, 6, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 20 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.35 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(12, 24, 0x3a404c, 0x262a32);
grid.position.y = 0.001;
scene.add(grid);

const userRoot = new THREE.Group();
userRoot.name = 'Material Forge scene';
scene.add(userRoot);

// ---------------------------------------------------------------------------------------------
// Materials

let N = 512;
let matSeq = 1;
const materials = [];
let activeMat = null;
let activeLayer = null;

class ForgeMat {
  constructor(name, preset) {
    this.id = matSeq++;
    this.name = name;
    const p = (PRESETS[preset] ?? PRESETS['Rusted Steel'])();
    this.layers = p.layers;
    this.settings = { normal: 1, ao: 1, tiling: 1, displace: 0, clearcoat: 0, clearcoatRough: 0.1, sheen: 0, emissive: 1, ...p.settings };
    this.comp = new Compositor(N);
    const tex = (c, srgb) => {
      const t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    const C = this.comp.canvases;
    this.tex = { base: tex(C.base, true), normal: tex(C.normal), orm: tex(C.orm), height: tex(C.height), emissive: tex(C.emissive, true) };
    this.mat = new THREE.MeshPhysicalMaterial({
      name, map: this.tex.base, normalMap: this.tex.normal, roughnessMap: this.tex.orm, metalnessMap: this.tex.orm, aoMap: this.tex.orm,
      roughness: 1, metalness: 1, emissive: 0xffffff, emissiveMap: this.tex.emissive, emissiveIntensity: 0,
    });
    this.mat.userData.forgeId = this.id;
    this.dirty = true;
  }

  setSize(n) {
    this.comp.setSize(n);
    for (const t of Object.values(this.tex)) { t.dispose(); t.needsUpdate = true; }
    this.dirty = true;
  }

  rebuild() {
    const s = this.settings;
    this.channels = this.comp.composite(this.layers, s);
    for (const t of Object.values(this.tex)) { t.needsUpdate = true; t.repeat.set(s.tiling, s.tiling); }
    const m = this.mat;
    m.normalScale.set(1, 1);
    m.aoMapIntensity = Math.min(1, s.ao);
    m.clearcoat = s.clearcoat;
    m.clearcoatRoughness = s.clearcoatRough;
    m.sheen = s.sheen;
    m.sheenColor.set(0xffffff);
    m.emissiveIntensity = this.comp.hasEmission ? this.comp.emissiveScale * s.emissive : 0;
    if (s.displace > 0) {
      m.displacementMap = this.tex.height;
      m.displacementScale = s.displace * 0.08;
      m.displacementBias = -m.displacementScale * 0.5;
    } else m.displacementMap = null;
    m.needsUpdate = true;
    this.thumb = thumbOf(this.comp.canvases.base);
    this.dirty = false;
  }
}

const thumbCanvas = document.createElement('canvas');
thumbCanvas.width = thumbCanvas.height = 96;
function thumbOf(c) {
  const g = thumbCanvas.getContext('2d');
  g.drawImage(c, 0, 0, 96, 96);
  return thumbCanvas.toDataURL('image/jpeg', 0.8);
}

function addMaterial(preset, select = true) {
  const m = new ForgeMat(preset, preset);
  materials.push(m);
  m.rebuild();
  if (select) setActiveMat(m);
  renderMatLib();
  return m;
}

function setActiveMat(m) {
  activeMat = m;
  activeLayer = m.layers[m.layers.length - 1] ?? null;
  renderMatLib();
  renderLayers();
  renderLayerPane();
  renderMatPane();
}

// Rebuild scheduling: generator changes are heavy, so coalesce slider drags.
let rebuildTimer = 0, rebuildQueued = false;
function scheduleRebuild(delay = 70) {
  clearTimeout(rebuildTimer);
  rebuildQueued = true;
  rebuildTimer = setTimeout(() => {
    const t0 = performance.now();
    activeMat.rebuild();
    rebuildQueued = false;
    $('#stMsg').textContent = `Baked ${activeMat.name}: ${activeMat.layers.length} layers at ${N}² in ${Math.round(performance.now() - t0)} ms`;
    refreshThumbs();
  }, delay);
}

function refreshThumbs() {
  const card = $(`#matLib [data-id="${activeMat.id}"]`);
  if (card) card.style.backgroundImage = `url(${activeMat.thumb})`;
  $$('#layerList .item').forEach((it) => {
    const l = activeMat.layers.find((x) => x.id === +it.dataset.id);
    if (l) it.querySelector('.sw').style.background = swatchBg(l);
  });
}

// ---------------------------------------------------------------------------------------------
// Objects

const PRIMS = {
  'Shader ball': () => {
    const ball = new THREE.SphereGeometry(0.62, 128, 96).translate(0, 0.86, 0);
    const neck = new THREE.CylinderGeometry(0.2, 0.32, 0.24, 64, 4).translate(0, 0.24, 0);
    const base = new THREE.CylinderGeometry(0.55, 0.6, 0.12, 64, 2).translate(0, 0.06, 0);
    return mergeGeometries([ball, neck, base]);
  },
  Sphere: () => new THREE.SphereGeometry(0.6, 128, 96).translate(0, 0.6, 0),
  'Rounded cube': () => new RoundedBoxGeometry(1, 1, 1, 8, 0.08).translate(0, 0.5, 0),
  Cylinder: () => new THREE.CylinderGeometry(0.45, 0.45, 1.2, 96, 32).translate(0, 0.6, 0),
  Cone: () => new THREE.ConeGeometry(0.55, 1.2, 96, 32).translate(0, 0.6, 0),
  Torus: () => new THREE.TorusGeometry(0.45, 0.18, 64, 160).rotateX(Math.PI / 2).translate(0, 0.18, 0),
  'Torus knot': () => new THREE.TorusKnotGeometry(0.38, 0.13, 320, 40).translate(0, 0.62, 0),
  Capsule: () => new THREE.CapsuleGeometry(0.35, 0.7, 24, 64).translate(0, 0.7, 0),
  Plane: () => new THREE.PlaneGeometry(2, 2, 200, 200).rotateX(-Math.PI / 2).translate(0, 0.01, 0),
  Pillar: () => {
    const pts = [[0, 0], [0.42, 0], [0.42, 0.1], [0.34, 0.16], [0.3, 0.22], [0.26, 0.3], [0.26, 1.5], [0.3, 1.58], [0.36, 1.64], [0.42, 1.7], [0.42, 1.8], [0, 1.8]];
    return new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), 96);
  },
  Wall: () => new THREE.BoxGeometry(2, 1.4, 0.15, 160, 120, 4).translate(0, 0.7, 0),
  Vase: () => {
    const pts = [];
    for (let i = 0; i <= 40; i++) { const t = i / 40; pts.push(new THREE.Vector2(0.18 + 0.3 * Math.sin(t * Math.PI * 1.1) ** 2 + (t > 0.85 ? (t - 0.85) * 0.9 : 0), t * 1.3)); }
    pts.unshift(new THREE.Vector2(0, 0));
    return new THREE.LatheGeometry(pts, 96);
  },
};

let objSeq = 1;
const objects = [];
let selected = null;

function addObject(name, obj, mat = activeMat, kind = 'primitive') {
  obj.name = name;
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; if (mat) o.material = mat.mat; } });
  const rec = { id: objSeq++, name, obj, matId: mat?.id ?? null, kind };
  obj.userData.objId = rec.id;
  userRoot.add(obj);
  objects.push(rec);
  selectObject(rec);
  return rec;
}

function addPrim(kind) {
  const mesh = new THREE.Mesh(PRIMS[kind](), activeMat.mat);
  // Lay new objects out on a ring so they do not stack on each other.
  const n = objects.length;
  if (n) mesh.position.set(((n + 1) >> 1) * 1.5 * (n % 2 ? 1 : -1), 0, -Math.floor(n / 7) * 1.6);
  return addObject(kind, mesh);
}

function selectObject(rec) {
  selected = rec;
  if (rec && tool !== 'orbit' && tool !== 'paint' && tool !== 'sample') tc.attach(rec.obj);
  else tc.detach();
  boxHelper.visible = !!rec;
  if (rec) boxHelper.setFromObject(rec.obj);
  renderObjects();
  renderObjProps();
}

function removeObject(rec) {
  if (!rec) return;
  userRoot.remove(rec.obj);
  objects.splice(objects.indexOf(rec), 1);
  selectObject(objects[objects.length - 1] ?? null);
}

function duplicateObject(rec) {
  if (!rec) return;
  const copy = rec.obj.clone();
  copy.position.x += 1.2;
  addObject(rec.name + ' copy', copy, rec.matId ? materials.find((m) => m.id === rec.matId) : null, rec.kind);
  // clone() shares materials; keep original materials when the source had none assigned
}

function assignMaterial(rec, mat) {
  rec.matId = mat.id;
  rec.obj.traverse((o) => { if (o.isMesh) o.material = mat.mat; });
  renderObjects();
}

const tc = new TransformControls(cam, renderer.domElement);
tc.addEventListener('dragging-changed', (e) => (controls.enabled = !e.value));
tc.addEventListener('objectChange', () => { boxHelper.setFromObject(selected.obj); renderObjProps(true); });
scene.add(tc);
const boxHelper = new THREE.BoxHelper(undefined, 0xff6a3d);
boxHelper.material.depthTest = false;
boxHelper.material.transparent = true;
boxHelper.material.opacity = 0.6;
scene.add(boxHelper);

// Brush cursor
const cursor = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.85 }));
cursor.renderOrder = 10;
cursor.visible = false;
scene.add(cursor);
stage.hideOnSnapshot.push(tc, boxHelper, cursor, grid);

// ---------------------------------------------------------------------------------------------
// Tools

let tool = 'orbit';
const brush = { size: 0.035, hardness: 0.5, flow: 0.6, erase: false };
const TOOLS = [
  ['orbit', 'Orbit', 'Q'], ['move', 'Move', 'W'], ['rotate', 'Rotate', 'E'], ['scale', 'Scale', 'R'],
  ['paint', 'Paint', 'B'], ['sample', 'Pick colour', 'I'],
];
function renderTools() {
  $('#tools').replaceChildren(
    ...TOOLS.map(([id, label, key]) => el('button', { class: 'btn sm' + (tool === id ? ' on' : ''), title: `${label} (${key})`, onclick: () => setTool(id) }, label, el('span', { class: 'kbd' }, key))),
    el('button', { class: 'btn sm', title: 'Frame the selection (F)', onclick: frameSel }, 'Frame', el('span', { class: 'kbd' }, 'F')),
    el('button', { class: 'btn sm' + (view.autoRotate ? ' on' : ''), onclick: () => { view.autoRotate = !view.autoRotate; controls.autoRotate = view.autoRotate; renderTools(); } }, 'Turntable'),
  );
}
function setTool(t) {
  tool = t;
  document.body.classList.toggle('tool-paint', t === 'paint');
  if (['move', 'rotate', 'scale'].includes(t)) {
    tc.setMode(t === 'move' ? 'translate' : t);
    if (selected) tc.attach(selected.obj);
  } else tc.detach();
  // Painting and picking use the left button, so orbit moves to the right button.
  controls.mouseButtons.LEFT = t === 'paint' || t === 'sample' ? null : THREE.MOUSE.ROTATE;
  controls.mouseButtons.RIGHT = t === 'paint' || t === 'sample' ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
  cursor.visible = false;
  $('#stTool').textContent = t.toUpperCase();
  renderTools();
  if (t === 'paint') { tabTo('right', 'layer'); renderLayerPane(); }
}
function frameSel() { stage.frame(selected?.obj ?? userRoot); }

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function hitAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, cam);
  return ray.intersectObject(userRoot, true)[0] ?? null;
}
function recOf(o) { while (o && !o.userData.objId) o = o.parent; return objects.find((r) => r.id === o?.userData.objId); }
function matOfHit(h) { return materials.find((m) => m.mat === h.object.material); }

function uvOf(h, mat) {
  const t = mat.settings.tiling;
  return [((h.uv.x * t) % 1 + 1) % 1, ((h.uv.y * t) % 1 + 1) % 1];
}

let painting = false, downAt = null;
const canvasEl = renderer.domElement;
canvasEl.addEventListener('pointerdown', (e) => {
  downAt = [e.clientX, e.clientY];
  if (e.button !== 0) return;
  if (tool === 'paint') {
    const h = hitAt(e);
    if (!h?.uv) return;
    const m = matOfHit(h);
    if (!m) return toast('That object has its original material. Assign a Forge material to paint on it.', true);
    if (m !== activeMat) setActiveMat(m);
    ensurePaintLayer();
    painting = true;
    canvasEl.setPointerCapture(e.pointerId);
    paintAt(h);
  } else if (tool === 'sample') {
    const h = hitAt(e);
    if (!h?.uv) return;
    const m = matOfHit(h);
    if (!m?.channels) return;
    const [u, v] = uvOf(h, m);
    const n = m.comp.N, i = Math.min(n - 1, Math.floor((1 - v) * n)) * n + Math.min(n - 1, Math.floor(u * n));
    const c = m.channels.col;
    const hex = '#' + [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]].map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('');
    applySample(hex, e.shiftKey);
  }
});
canvasEl.addEventListener('pointermove', (e) => {
  if (tool !== 'paint') return;
  const h = hitAt(e);
  cursor.visible = !!h;
  if (h) {
    const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
    cursor.position.copy(h.point).addScaledVector(n, 0.003);
    cursor.lookAt(h.point.clone().add(n));
    // Approximate the brush's world size from the object's size (UV space is ~ the object's surface).
    const box = new THREE.Box3().setFromObject(h.object);
    const s = box.getSize(new THREE.Vector3()).length();
    cursor.scale.setScalar(brush.size * s * 1.2 / (activeMat?.settings.tiling || 1));
  }
  if (painting && h?.uv && matOfHit(h) === activeMat) paintAt(h, e.altKey);
});
const endPaint = () => { painting = false; };
canvasEl.addEventListener('pointerup', (e) => {
  endPaint();
  // A click without a drag selects an object (orbit and transform tools).
  if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 4 && e.button === 0 && !['paint', 'sample'].includes(tool) && !tc.dragging) {
    const h = hitAt(e);
    const rec = h ? recOf(h.object) : null;
    if (rec) {
      selectObject(rec);
      const m = matOfHit(h);
      if (m && m !== activeMat) setActiveMat(m);
    } else if (!tc.object) selectObject(null);
  }
  downAt = null;
});
canvasEl.addEventListener('pointerleave', () => { cursor.visible = false; });

function ensurePaintLayer() {
  if (activeLayer?.mask === 'paint') return;
  const L = makeLayer('solid', { name: 'Paint', colorA: brushColor, roughA: 0.4, mask: 'paint', height: 0 });
  const at = activeLayer ? activeMat.layers.indexOf(activeLayer) + 1 : activeMat.layers.length;
  activeMat.layers.splice(at, 0, L);
  activeLayer = L;
  renderLayers();
  renderLayerPane();
  toast('Added a Paint layer. Its colour, roughness and height are in the Layer tab.');
}
let brushColor = '#e8402c';
let lastStroke = 0;
function paintAt(h, erase = false) {
  const [u, v] = uvOf(h, activeMat);
  stamp(activeLayer, activeMat.comp.N, u, v, { ...brush, erase: erase || brush.erase });
  const now = performance.now();
  if (now - lastStroke > 40) { lastStroke = now; activeMat.rebuild(); } else scheduleRebuild(45);
}

addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  const k = e.key.toLowerCase();
  const map = { q: 'orbit', w: 'move', e: 'rotate', r: 'scale', b: 'paint', i: 'sample' };
  if (map[k]) setTool(map[k]);
  else if (k === 'f') frameSel();
  else if (k === 'delete' && selected) removeObject(selected);
  else if (k === '[' ) { brush.size = Math.max(0.005, brush.size / 1.2); renderLayerPane(); }
  else if (k === ']') { brush.size = Math.min(0.3, brush.size * 1.2); renderLayerPane(); }
});

// ---------------------------------------------------------------------------------------------
// Panels

function tabTo(side, tab) {
  $$(`[data-tabs="${side}"] button`).forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const host = $(`[data-tabs="${side}"]`).parentElement;
  $$(':scope > [data-pane]', host).forEach((p) => (p.hidden = p.dataset.pane !== tab));
}
wireTabs();
wireSections();

function renderMatLib() {
  $('#matLib').replaceChildren(...materials.map((m) => el('div', {
    class: 'card' + (m === activeMat ? ' sel' : ''), 'data-id': m.id, title: m.name,
    style: { backgroundImage: `url(${m.thumb})` },
    onclick: () => setActiveMat(m),
    ondblclick: () => { if (selected) { assignMaterial(selected, m); toast(`${m.name} applied to ${selected.name}`); } },
  }, el('span', {}, m.name))));
}

function swatchBg(l) {
  if (l.gen === 'image' && l.src) return `url(${l.srcThumb}) center/cover`;
  if (l.mask === 'paint') return `repeating-linear-gradient(45deg, ${l.colorA} 0 6px, #0000 6px 9px), #222`;
  return `linear-gradient(135deg, ${l.colorA}, ${l.colorB})`;
}

function renderLayers() {
  const sel = $('#addLayer');
  if (!sel.options.length) {
    sel.append(el('option', { value: '' }, 'Choose a generator…'), ...Object.entries(GENERATORS).map(([k, g]) => el('option', { value: k }, g.name)));
    sel.onchange = () => {
      if (!sel.value) return;
      const L = makeLayer(sel.value, { colorA: '#8a8a8a', colorB: '#d0d0d0', height: sel.value === 'solid' ? 0 : 0.3, seed: Math.floor(Math.random() * 999) });
      if (sel.value === 'image' && samplerImg) setLayerImage(L, samplerImg);
      const at = activeLayer ? activeMat.layers.indexOf(activeLayer) + 1 : activeMat.layers.length;
      activeMat.layers.splice(at, 0, L);
      activeLayer = L;
      sel.value = '';
      renderLayers(); renderLayerPane(); scheduleRebuild(0);
    };
  }
  const list = [...activeMat.layers].reverse();
  $('#layerList').replaceChildren(...list.map((l) => el('div', {
    class: 'item' + (l === activeLayer ? ' sel' : '') + (l.visible ? '' : ' off'), 'data-id': l.id,
    onclick: () => { activeLayer = l; renderLayers(); renderLayerPane(); tabTo('right', 'layer'); },
  },
  el('span', { class: 'eye', title: 'Show / hide', onclick: (e) => { e.stopPropagation(); l.visible = !l.visible; renderLayers(); scheduleRebuild(0); } }, l.visible ? '◉' : '○'),
  el('span', { class: 'sw', style: { background: swatchBg(l) } }),
  el('span', { class: 'name' }, l.name),
  el('span', { class: 'meta' }, l.mask === 'none' ? l.blend : l.mask))));
}

$('#layUp').onclick = () => moveLayer(1);
$('#layDown').onclick = () => moveLayer(-1);
$('#layDup').onclick = () => {
  if (!activeLayer) return;
  const c = cloneLayer(activeLayer);
  c.name += ' copy';
  activeMat.layers.splice(activeMat.layers.indexOf(activeLayer) + 1, 0, c);
  activeLayer = c;
  renderLayers(); renderLayerPane(); scheduleRebuild(0);
};
$('#layDel').onclick = () => {
  if (!activeLayer) return;
  const i = activeMat.layers.indexOf(activeLayer);
  activeMat.layers.splice(i, 1);
  activeLayer = activeMat.layers[Math.max(0, i - 1)] ?? null;
  renderLayers(); renderLayerPane(); scheduleRebuild(0);
};
function moveLayer(d) {
  const L = activeMat.layers, i = L.indexOf(activeLayer), j = i + d;
  if (i < 0 || j < 0 || j >= L.length) return;
  [L[i], L[j]] = [L[j], L[i]];
  renderLayers(); scheduleRebuild(0);
}

function section(title, ...rows) {
  return el('section', { class: 'section' }, el('h3', {}, title), el('div', { class: 'body' }, rows));
}

function renderLayerPane() {
  const host = $('#layerPane');
  const L = activeLayer;
  const brushSec = el('div', { class: 'brush-only' }, section('Brush',
    slider('Size', { min: 0.005, max: 0.3, step: 0.005, value: brush.size }, (v) => (brush.size = v)).row,
    slider('Hardness', { min: 0, max: 1, step: 0.01, value: brush.hardness }, (v) => (brush.hardness = v)).row,
    slider('Flow', { min: 0.02, max: 1, step: 0.01, value: brush.flow }, (v) => (brush.flow = v)).row,
    toggle('Erase', brush.erase, (v) => (brush.erase = v)).row,
    el('p', { class: 'hint' }, 'Left-drag paints, right-drag orbits, Alt erases, [ and ] resize.')));
  if (!L) { host.replaceChildren(brushSec, el('p', { class: 'hint', style: { padding: '12px' } }, 'Add a layer to start.')); return; }
  const ch = (fn, d) => (v) => { fn(v); scheduleRebuild(d); };
  const gen = GENERATORS[L.gen];
  const nameIn = el('input', { type: 'text', value: L.name });
  nameIn.oninput = () => { L.name = nameIn.value; renderLayers(); };
  const genSel = select('Generator', Object.entries(GENERATORS).map(([k, g]) => [k, g.name]), L.gen, (v) => {
    L.gen = v;
    const p = {};
    for (const [k, , , , , def] of GENERATORS[v].params) p[k] = L.p[k] ?? def;
    L.p = p;
    if (v === 'image' && !L.src && samplerImg) setLayerImage(L, samplerImg);
    renderLayerPane(); scheduleRebuild(0);
  });
  const params = gen.params.map(([k, label, min, max, step]) => slider(label, { min, max, step, value: L.p[k] }, ch((v) => (L.p[k] = v), 90)).row);
  const seedRow = el('div', { class: 'row' }, el('label', {}, 'Seed'),
    (() => { const i = el('input', { type: 'number', value: L.seed, min: 0, max: 99999 }); i.onchange = () => { L.seed = +i.value; scheduleRebuild(0); }; return i; })(),
    el('button', { class: 'btn sm', onclick: () => { L.seed = Math.floor(Math.random() * 99999); renderLayerPane(); scheduleRebuild(0); } }, '↻'));
  const imageRows = L.gen === 'image' ? [
    el('div', { class: 'btn-row tight' }, el('button', { class: 'btn sm', onclick: async () => { const [f] = await pickFiles('image/*'); if (f) { const img = await readImage(f); setLayerImage(L, img); setSampler(img); renderLayerPane(); scheduleRebuild(0); } } }, L.src ? 'Replace photo' : 'Choose photo')),
    toggle('Tint by A', !!L.tint, ch((v) => (L.tint = v), 0)).row,
  ] : [];

  host.replaceChildren(
    brushSec,
    section('Layer',
      el('div', { class: 'row' }, el('label', {}, 'Name'), nameIn, el('span')),
      genSel.row, ...params, ...imageRows, seedRow,
      toggle('Invert', L.invert, ch((v) => (L.invert = v), 0)).row),
    section('Surface',
      el('div', { class: 'row two' }, el('label', {}, 'Colors A / B'),
        (() => { const c = el('input', { type: 'color', value: L.colorA }); c.oninput = () => { L.colorA = c.value; scheduleRebuild(30); }; return c; })(),
        (() => { const c = el('input', { type: 'color', value: L.colorB }); c.oninput = () => { L.colorB = c.value; scheduleRebuild(30); }; return c; })()),
      slider('Variation', { min: 0, max: 1, step: 0.01, value: L.vary }, ch((v) => (L.vary = v), 40)).row,
      slider('Rough A', { min: 0, max: 1, step: 0.01, value: L.roughA }, ch((v) => (L.roughA = v), 40)).row,
      slider('Rough B', { min: 0, max: 1, step: 0.01, value: L.roughB }, ch((v) => (L.roughB = v), 40)).row,
      slider('Metal A', { min: 0, max: 1, step: 0.01, value: L.metalA }, ch((v) => (L.metalA = v), 40)).row,
      slider('Metal B', { min: 0, max: 1, step: 0.01, value: L.metalB }, ch((v) => (L.metalB = v), 40)).row,
      slider('Height', { min: -1, max: 1, step: 0.01, value: L.height }, ch((v) => (L.height = v), 40)).row,
      select('Height mode', [['add', 'Add'], ['max', 'Max'], ['replace', 'Replace']], L.heightMode, ch((v) => (L.heightMode = v), 0)).row,
      slider('Emission', { min: 0, max: 8, step: 0.1, value: L.emissive }, ch((v) => (L.emissive = v), 40)).row),
    section('Blending',
      select('Blend', ['normal', 'multiply', 'screen', 'overlay', 'add'], L.blend, ch((v) => (L.blend = v), 0)).row,
      slider('Opacity', { min: 0, max: 1, step: 0.01, value: L.opacity }, ch((v) => (L.opacity = v), 40)).row,
      el('div', { class: 'row' }, el('label', {}, 'Channels'), el('div', { class: 'btn-row' },
        ...['color', 'rough', 'metal', 'height'].map((c) => el('button', { class: 'btn sm' + (L.ch[c] ? ' on' : ''), onclick: (e) => { L.ch[c] = !L.ch[c]; e.target.classList.toggle('on', L.ch[c]); scheduleRebuild(0); } }, c))), el('span'))),
    section('Mask',
      select('Mask', [['none', 'None (full)'], ['self', 'From pattern'], ['noise', 'Noise'], ['cavity', 'Cavities (dirt)'], ['peaks', 'Edges (wear)'], ['paint', 'Paint']], L.mask, (v) => { L.mask = v; renderLayerPane(); scheduleRebuild(0); }).row,
      ...(L.mask === 'none' ? [] : L.mask === 'paint' ? [
        el('div', { class: 'btn-row tight' },
          el('button', { class: 'btn sm', onclick: () => setTool('paint') }, 'Paint tool'),
          el('button', { class: 'btn sm', onclick: () => { L.paint = null; scheduleRebuild(0); } }, 'Clear'),
          el('button', { class: 'btn sm', onclick: () => { L.paint = new Float32Array(activeMat.comp.N ** 2).fill(1); scheduleRebuild(0); } }, 'Fill')),
        toggle('Invert mask', L.maskInvert, ch((v) => (L.maskInvert = v), 0)).row,
      ] : [
        slider('Coverage', { min: 0, max: 1, step: 0.01, value: L.cover }, ch((v) => (L.cover = v), 40)).row,
        slider('Softness', { min: 0, max: 0.5, step: 0.01, value: L.edge }, ch((v) => (L.edge = v), 40)).row,
        ...(L.mask === 'noise' ? [slider('Mask scale', { min: 1, max: 24, step: 1, value: L.maskScale }, ch((v) => (L.maskScale = v), 90)).row] : []),
        toggle('Invert mask', L.maskInvert, ch((v) => (L.maskInvert = v), 0)).row,
      ])),
  );
}

function renderMatPane() {
  const m = activeMat, s = m.settings;
  const ch = (fn) => (v) => { fn(v); scheduleRebuild(30); };
  const nameIn = el('input', { type: 'text', value: m.name });
  nameIn.oninput = () => { m.name = nameIn.value; m.mat.name = m.name; renderMatLib(); renderObjects(); };
  const maps = el('div', { class: 'maps' }, ...[['base', 'Base color'], ['normal', 'Normal'], ['orm', 'AO·Rough·Metal'], ['height', 'Height'], ['emissive', 'Emissive']].map(([k, label]) => {
    const c = m.comp.canvases[k];
    return el('figure', { title: 'Download ' + label, onclick: () => c.toBlob((b) => download(b, `${slug(m.name)}-${k}.png`)) }, c, el('figcaption', {}, label));
  }));
  $('#matPane').replaceChildren(
    section('Material',
      el('div', { class: 'row' }, el('label', {}, 'Name'), nameIn, el('span')),
      select('Resolution', [['256', '256 px'], ['512', '512 px'], ['1024', '1024 px (slow)']], String(N), (v) => {
        N = +v;
        materials.forEach((mm) => { mm.layers.forEach((l) => { if (l.paint) l.paint = resample(l.paint, Math.round(Math.sqrt(l.paint.length)), N); }); mm.setSize(N); mm.rebuild(); });
        renderMatPane();
      }).row,
      slider('Tiling', { min: 0.25, max: 8, step: 0.25, value: s.tiling }, ch((v) => (s.tiling = v))).row,
      slider('Normal', { min: 0, max: 4, step: 0.05, value: s.normal }, ch((v) => (s.normal = v))).row,
      slider('AO', { min: 0, max: 3, step: 0.05, value: s.ao }, ch((v) => (s.ao = v))).row,
      slider('Displace', { min: 0, max: 1, step: 0.01, value: s.displace }, ch((v) => (s.displace = v))).row,
      slider('Clearcoat', { min: 0, max: 1, step: 0.01, value: s.clearcoat }, ch((v) => (s.clearcoat = v))).row,
      slider('Coat rough', { min: 0, max: 1, step: 0.01, value: s.clearcoatRough }, ch((v) => (s.clearcoatRough = v))).row,
      slider('Sheen', { min: 0, max: 1, step: 0.01, value: s.sheen }, ch((v) => (s.sheen = v))).row,
      slider('Glow boost', { min: 0, max: 4, step: 0.05, value: s.emissive }, ch((v) => (s.emissive = v))).row,
      el('div', { class: 'btn-row tight', style: { marginTop: '6px' } },
        el('button', { class: 'btn sm', onclick: () => { if (selected) { assignMaterial(selected, m); toast(`${m.name} applied to ${selected.name}`); } else toast('Select an object first', true); } }, 'Apply to selected'),
        el('button', { class: 'btn sm', onclick: () => { objects.forEach((r) => assignMaterial(r, m)); } }, 'Apply to all'))),
    section('Maps (click to download)', maps),
    section('Viewport',
      select('Lighting', Object.keys(ENVS), view.env, (v) => { view.env = v; applyEnv(); }).row,
      color('Background', view.bg, (v) => { view.bg = v; applyEnv(); }).row,
      slider('Exposure', { min: 0.2, max: 2.5, step: 0.05, value: view.exposure }, (v) => { view.exposure = v; applyEnv(); }).row,
      slider('Sun', { min: 0, max: 4, step: 0.05, value: sun.intensity }, (v) => (sun.intensity = v)).row,
      toggle('Grid', grid.visible, (v) => (grid.visible = v)).row),
  );
}

function resample(src, from, to) {
  const out = new Float32Array(to * to);
  for (let y = 0; y < to; y++) for (let x = 0; x < to; x++) out[y * to + x] = src[Math.floor((y / to) * from) * from + Math.floor((x / to) * from)];
  return out;
}

function renderObjects() {
  $('#objList').replaceChildren(...objects.map((r) => {
    const m = materials.find((x) => x.id === r.matId);
    return el('div', { class: 'item' + (r === selected ? ' sel' : ''), onclick: () => selectObject(r), ondblclick: () => { selectObject(r); frameSel(); } },
      el('span', { class: 'sw', style: { backgroundImage: m ? `url(${m.thumb})` : 'none' } }),
      el('span', { class: 'name' }, r.name),
      el('span', { class: 'meta' }, m ? m.name : 'original'));
  }));
}

function renderObjProps(live = false) {
  const host = $('#objProps');
  if (!selected) { host.replaceChildren(el('p', { class: 'hint' }, 'Select an object in the list or click it in the viewport.')); return; }
  const o = selected.obj;
  if (live && host.dataset.for === String(selected.id)) {
    // Update numbers in place while dragging the gizmo.
    $$('input[data-k]', host).forEach((i) => { const [p, a] = i.dataset.k.split('.'); const v = p === 'rotation' ? THREE.MathUtils.radToDeg(o[p][a]) : o[p][a]; i.value = +v.toFixed(p === 'rotation' ? 1 : 3); });
    return;
  }
  host.dataset.for = selected.id;
  const vec = (label, p, step) => el('div', { class: 'row', style: { gridTemplateColumns: '60px 1fr 1fr 1fr' } }, el('label', {}, label), ...['x', 'y', 'z'].map((a) => {
    const v = p === 'rotation' ? THREE.MathUtils.radToDeg(o[p][a]) : o[p][a];
    const i = el('input', { type: 'number', step, value: +v.toFixed(3), 'data-k': `${p}.${a}` });
    i.oninput = () => { const n = parseFloat(i.value) || 0; o[p][a] = p === 'rotation' ? THREE.MathUtils.degToRad(n) : n; boxHelper.setFromObject(o); };
    return i;
  }));
  const nameIn = el('input', { type: 'text', value: selected.name });
  nameIn.oninput = () => { selected.name = nameIn.value; o.name = nameIn.value; renderObjects(); };
  host.replaceChildren(
    el('div', { class: 'row' }, el('label', {}, 'Name'), nameIn, el('span')),
    vec('Position', 'position', 0.05), vec('Rotation', 'rotation', 5), vec('Scale', 'scale', 0.05),
    select('Material', [['', 'Original / none'], ...materials.map((m) => [String(m.id), m.name])], String(selected.matId ?? ''), (v) => { const m = materials.find((x) => x.id === +v); if (m) assignMaterial(selected, m); }).row,
    el('div', { class: 'btn-row tight', style: { marginTop: '6px' } },
      el('button', { class: 'btn sm', onclick: () => { const b = new THREE.Box3().setFromObject(o); o.position.y -= b.min.y; boxHelper.setFromObject(o); renderObjProps(); } }, 'Drop to floor'),
      el('button', { class: 'btn sm', onclick: () => { o.scale.x *= -1; renderObjProps(); } }, 'Mirror X'),
      el('button', { class: 'btn sm', onclick: () => { o.position.set(0, o.position.y, 0); o.rotation.set(0, 0, 0); o.scale.setScalar(1); boxHelper.setFromObject(o); renderObjProps(); } }, 'Reset')),
  );
}

$('#prims').append(...Object.keys(PRIMS).map((k) => el('button', { class: 'btn', onclick: () => { addPrim(k); tabTo('left', 'objects'); } }, k)));
$('#objDup').onclick = () => duplicateObject(selected);
$('#objDel').onclick = () => removeObject(selected);

// ---------------------------------------------------------------------------------------------
// Sampler

let samplerImg = null, sampleTarget = 'A';
const palette = [];
function setSampler(img) {
  samplerImg = img;
  const c = el('canvas');
  const w = 560, h = Math.round((img.height / img.width) * w);
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const loupe = el('div', { class: 'loupe', hidden: true });
  const pick = (e) => {
    const r = c.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * w), y = Math.floor(((e.clientY - r.top) / r.height) * h);
    const d = g.getImageData(Math.max(0, Math.min(w - 1, x)), Math.max(0, Math.min(h - 1, y)), 1, 1).data;
    return { hex: '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join(''), x: e.clientX - r.left, y: e.clientY - r.top };
  };
  c.onpointermove = (e) => { const p = pick(e); Object.assign(loupe.style, { left: p.x + 'px', top: p.y + 'px', background: p.hex }); loupe.hidden = false; };
  c.onpointerleave = () => (loupe.hidden = true);
  c.onclick = (e) => applySample(pick(e).hex, e.shiftKey);
  $('#samplerWrap').replaceChildren(c, loupe);
  ['#sampPalette', '#sampLayer', '#sampMat'].forEach((s) => ($(s).disabled = false));
}
function applySample(hex, toB = false) {
  if (!palette.includes(hex)) { palette.unshift(hex); palette.length = Math.min(palette.length, 18); renderPalette(); }
  if (!activeLayer) return;
  const key = toB || sampleTarget === 'B' ? 'colorB' : 'colorA';
  activeLayer[key] = hex;
  if (activeLayer.mask === 'paint') brushColor = hex;
  renderLayerPane(); renderLayers(); scheduleRebuild(0);
  $('#stMsg').textContent = `Sampled ${hex} → ${activeLayer.name} ${key === 'colorA' ? 'Color A' : 'Color B'}`;
}
function renderPalette() {
  $('#palette').replaceChildren(...palette.map((hex) => el('button', { style: { background: hex }, title: `${hex} (shift-click for Color B)`, onclick: (e) => applySample(hex, e.shiftKey) })));
}
function setLayerImage(L, img) {
  L.src = img;
  L.srcId = (L.srcId || 0) + 1 + Math.random();
  const c = el('canvas'); c.width = c.height = 48;
  const s = Math.min(img.width, img.height);
  c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 48, 48);
  L.srcThumb = c.toDataURL();
  L.name = 'Photo';
}
$('#sampUpload').onclick = async () => { const [f] = await pickFiles('image/*'); if (f) setSampler(await readImage(f)); };
$('#sampTarget').onclick = (e) => { sampleTarget = sampleTarget === 'A' ? 'B' : 'A'; e.target.textContent = 'Sets: Color ' + sampleTarget; };
$('#sampPalette').onclick = () => { extractPalette(samplerImg, 8).forEach((h) => { if (!palette.includes(h)) palette.push(h); }); renderPalette(); };
$('#sampLayer').onclick = () => {
  const L = makeLayer('image', { roughA: 0.45, roughB: 0.75, height: 0.4 });
  setLayerImage(L, samplerImg);
  const at = activeLayer ? activeMat.layers.indexOf(activeLayer) + 1 : activeMat.layers.length;
  activeMat.layers.splice(at, 0, L);
  activeLayer = L;
  renderLayers(); renderLayerPane(); scheduleRebuild(0);
  tabTo('right', 'layer');
};
$('#sampMat').onclick = () => {
  const m = addMaterial('Rusted Steel');
  m.name = 'Scanned ' + (materials.length);
  const L = makeLayer('image', { roughA: 0.4, roughB: 0.85, height: 0.6 });
  setLayerImage(L, samplerImg);
  m.layers = [L];
  m.settings = { ...m.settings, normal: 1.4, ao: 1.2, clearcoat: 0 };
  setActiveMat(m);
  if (selected) assignMaterial(selected, m);
  scheduleRebuild(0);
  toast('Built a material from the photo: colour, height (high-passed luminance), normal and AO.');
};

// ---------------------------------------------------------------------------------------------
// Upload, export, push

async function importFiles(files) {
  for (const f of files) {
    const ext = f.name.split('.').pop().toLowerCase();
    try {
      if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) {
        setSampler(await readImage(f));
        tabTo('right', 'sampler');
        toast(`${f.name} is in the Sampler: click it to pick colours, or turn it into a layer.`);
      } else if (['glb', 'gltf', 'obj', 'stl'].includes(ext)) {
        $('#busy').hidden = false;
        const obj = fitObject(await loadModelFile(f), 1.6);
        const keep = ext === 'glb' || ext === 'gltf';
        addObject(f.name.replace(/\.[^.]+$/, ''), obj, keep ? null : activeMat, 'import');
        tabTo('left', 'objects');
        frameSel();
        toast(keep ? 'Model imported with its own materials. Pick a material and press "Apply to selected" to re-skin it.' : 'Model imported.');
      } else toast(`Can't import .${ext}`, true);
    } catch (e) {
      console.error(e);
      toast(`${f.name}: ${e.message}`, true);
    } finally {
      $('#busy').hidden = true;
    }
  }
}
$('#btnUpload').onclick = async () => importFiles(await pickFiles('image/*,.glb,.gltf,.obj,.stl', true));
$('#btnModel').onclick = async () => importFiles(await pickFiles('.glb,.gltf,.obj,.stl', true));
onDrop(document.body, $('#vp'), importFiles, 'Drop a photo or a model');
$('#btnNewMat').onclick = () => {
  const menu = el('div', { class: 'grid-cards' }, ...Object.keys(PRESETS).map((k) => el('div', { class: 'card', style: { background: 'var(--panel-3)' }, onclick: () => { close(); addMaterial(k); toast(`Added ${k}. Double-click a library card to apply it to the selected object.`); } }, el('span', {}, k))));
  const { close } = modal('New material', el('div', {}, el('p', { class: 'hint' }, 'Start from a preset, then edit its layers.'), menu));
};
$('#btnMaps').onclick = () => {
  for (const k of ['base', 'normal', 'orm', 'height', 'emissive']) activeMat.comp.canvases[k].toBlob((b) => download(b, `${slug(activeMat.name)}-${k}.png`));
};
$('#btnGlb').onclick = async () => download(await buildExport().then((r) => r.glb), 'material-forge-scene.glb');

async function buildExport() {
  tc.detach();
  const glb = await exportGLB(userRoot);
  if (['move', 'rotate', 'scale'].includes(tool) && selected) tc.attach(selected.obj);
  return {
    glb,
    meta: {
      objects: objects.map((r) => r.name),
      materials: materials.filter((m) => objects.some((r) => r.matId === m.id)).map((m) => ({ name: m.name, layers: m.layers.map((l) => `${l.name} (${GENERATORS[l.gen].name})`) })),
      resolution: N,
    },
  };
}
$('#btnPush').onclick = () => {
  if (!objects.length) return toast('Add an object first', true);
  pushDialog({
    app: 'material',
    defaultName: activeMat.name + (objects.length > 1 ? ' set' : ''),
    thumb: stage.snapshot(),
    build: buildExport,
    notesHint: 'e.g. "Rusted hull plating for the harbour scene"',
  });
};


// ---------------------------------------------------------------------------------------------
// Boot

stage.onTick = () => {
  if (selected && boxHelper.visible) boxHelper.setFromObject(selected.obj);
};
let fpsT = performance.now(), fpsN = 0;
setInterval(() => {
  const now = performance.now();
  const fps = Math.round(((stage.frames - fpsN) * 1000) / (now - fpsT));
  fpsT = now; fpsN = stage.frames;
  $('#stInfo').textContent = `${objects.length} objects · ${materials.length} materials · ${N}px maps · ${renderer.info.render.triangles.toLocaleString()} tris · ${fps} fps`;
}, 1000);

addMaterial('Rusted Steel');
addMaterial('Sci-Fi Panel', false);
addMaterial('Red Brick', false);
addMaterial('Oak Planks', false);
setActiveMat(materials[0]);
addPrim('Shader ball');
selectObject(objects[0]);
renderTools();
setTool('orbit');
wireDepthChip(stage, $('#chip'));
stage.start();
window.forge = { stage, materials, objects, addPrim, addMaterial, setTool, importFiles };
