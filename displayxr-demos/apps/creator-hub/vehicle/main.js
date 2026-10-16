// Vehicle Studio: a VRED-style car configurator and presentation tool. A procedural concept car
// (or your own uploaded model) gets paint finishes, rims, calipers, glass, interior and lights;
// configurations are saved as variant sets; studio environments, floors and camera viewpoints
// present it; and the configured car is pushed to DisplayXR HQ as a .glb.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { Stage, wireDepthChip } from '../shared/stage.js';
import { $, $$, el, wireSections, wireTabs, slider, select, color, toggle, toast, pickFiles, onDrop, download, slug, exportGLB, loadModelFile, fitObject, pushDialog } from '../shared/ui.js';
import { buildCar, STYLES } from './car.js';

const stage = new Stage($('#stage'), { fov: 32, tag: 'vehicle', far: 400 });
const { scene, renderer, cam, controls } = stage;
cam.position.set(5.6, 1.9, 5.2);
controls.target.set(0, 0.7, 0);
controls.maxPolarAngle = Math.PI / 2 - 0.03;
controls.minDistance = 1.2;
controls.maxDistance = 25;

// ---------------------------------------------------------------------------------------------
// Material library (shared instances: variants edit them in place)

const phys = (o) => new THREE.MeshPhysicalMaterial(o);
const mats = {
  paint: phys({ name: 'Paint', color: 0xb3121b, metalness: 0.6, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.03 }),
  glass: phys({ name: 'Glass', color: 0x1d2a33, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.38, envMapIntensity: 1.6, side: THREE.DoubleSide }),
  trim: phys({ name: 'Trim', color: 0x0d0e10, metalness: 0.2, roughness: 0.45 }),
  chrome: phys({ name: 'Chrome', color: 0xffffff, metalness: 1, roughness: 0.04 }),
  rubber: phys({ name: 'Rubber', color: 0x121212, metalness: 0, roughness: 0.88 }),
  rim: phys({ name: 'Rim', color: 0xc8ccd2, metalness: 1, roughness: 0.22, clearcoat: 0.6 }),
  brake: phys({ name: 'Brake disc', color: 0x7a7d82, metalness: 0.9, roughness: 0.4 }),
  caliper: phys({ name: 'Caliper', color: 0xd1121b, metalness: 0.2, roughness: 0.35, clearcoat: 1 }),
  interior: phys({ name: 'Interior leather', color: 0x1b1a19, metalness: 0, roughness: 0.6, sheen: 0.4, sheenColor: new THREE.Color(0x555555) }),
  headlight: phys({ name: 'Headlight', color: 0xdfe8f2, emissive: 0xe8f2ff, emissiveIntensity: 0.15, metalness: 0.5, roughness: 0.1 }),
  taillight: phys({ name: 'Tail light', color: 0x5a0508, emissive: 0xff1020, emissiveIntensity: 0.25, roughness: 0.2 }),
};

const PAINTS = [
  ['Racing Red', '#b3121b'], ['Lava Orange', '#e2541b'], ['Solar Yellow', '#f2c21b'], ['British Green', '#0f3b2a'],
  ['Lime Rush', '#7fd12a'], ['Glacier Blue', '#6aa9d8'], ['Midnight Blue', '#0d1f45'], ['Ultra Violet', '#4b2a8a'],
  ['Arctic White', '#eef0f2'], ['Liquid Silver', '#b9bec5'], ['Graphite', '#3b3e43'], ['Obsidian Black', '#0b0c0e'],
];
const FINISHES = {
  Gloss: { metalness: 0.05, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.02, iridescence: 0, sheen: 0 },
  Metallic: { metalness: 0.65, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.03, iridescence: 0, sheen: 0 },
  Pearl: { metalness: 0.45, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.03, iridescence: 1, iridescenceIOR: 1.35, sheen: 0 },
  Candy: { metalness: 0.9, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.01, iridescence: 0, sheen: 0 },
  Satin: { metalness: 0.35, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4, iridescence: 0, sheen: 0.3 },
  Matte: { metalness: 0.2, roughness: 0.68, clearcoat: 0, clearcoatRoughness: 0.5, iridescence: 0, sheen: 0 },
  Chrome: { metalness: 1, roughness: 0.05, clearcoat: 0, clearcoatRoughness: 0, iridescence: 0, sheen: 0 },
};
const RIM_FINISH = { Silver: ['#c8ccd2', 0.22], Gunmetal: ['#4a4d52', 0.3], 'Gloss black': ['#111214', 0.12], Gold: ['#c9a24a', 0.2], Bronze: ['#7a5a36', 0.3], Chrome: ['#ffffff', 0.03] };
const CALIPERS = { Red: '#d1121b', Yellow: '#f2c21b', Blue: '#1e5fd1', Green: '#2a9d4b', Black: '#141414', Orange: '#ff6a1a' };
const GLASS = { Clear: ['#8fa6b3', 0.42], 'Light tint': ['#1a2630', 0.62], Privacy: ['#06080a', 0.86] };
const INTERIOR = { Black: '#1b1a19', Tan: '#9a6a3d', Oxblood: '#5a1416', Ivory: '#d9d1c2', 'Slate blue': '#2e3b55' };
const RIMS = ['Five-spoke', 'Multi-spoke', 'Turbine', 'Mesh', 'Aero disc'];

const cfg = {
  style: 'Coupe', paint: 'Racing Red', paintHex: '#b3121b', finish: 'Metallic', rim: 'Five-spoke', rimFinish: 'Silver',
  caliper: 'Red', glass: 'Light tint', interior: 'Black', lights: false, ride: 0, wheelScale: 1,
};

// ---------------------------------------------------------------------------------------------
// Environment, floor, lights

const pmrem = new THREE.PMREMGenerator(renderer);
function envFromScene(build, blur = 0.03) {
  const s = new THREE.Scene();
  build(s);
  return pmrem.fromScene(s, blur).texture;
}
function gradientDome(s, top, hor, bot) {
  s.add(new THREE.Mesh(new THREE.SphereGeometry(60, 48, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { top: { value: new THREE.Color(top) }, hor: { value: new THREE.Color(hor) }, bot: { value: new THREE.Color(bot) } },
    vertexShader: 'varying vec3 p; void main(){ p = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
    fragmentShader: 'uniform vec3 top, hor, bot; varying vec3 p; void main(){ float y = p.y; vec3 c = y > 0. ? mix(hor, top, pow(y, .5)) : mix(hor, bot, pow(-y, .3)); gl_FragColor = vec4(c, 1.); }',
  })));
}
function panel(s, w, h, x, y, z, k, col = 0xffffff) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(k), side: THREE.DoubleSide }));
  m.position.set(x, y, z);
  m.lookAt(0, 1, 0);
  s.add(m);
}
const ENVS = {
  'Studio': { bg: ['#59606b', '#1d2025'], make: () => pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture },
  'Showroom': {
    bg: ['#d9dde2', '#9aa0a8'],
    make: () => envFromScene((s) => {
      gradientDome(s, '#3a3d42', '#24262a', '#141516');
      panel(s, 30, 4, 0, 22, 0, 6); // ceiling strip
      panel(s, 4, 30, 0, 22, 0, 6);
      for (const a of [0, 1, 2, 3]) panel(s, 8, 3, Math.cos(a * Math.PI / 2) * 20, 6, Math.sin(a * Math.PI / 2) * 20, 3);
    }),
  },
  'Sunset': {
    bg: ['#f0a668', '#3c3245'],
    make: () => envFromScene((s) => {
      gradientDome(s, '#2f4778', '#ffb070', '#3a2b25');
      const sun = new THREE.Mesh(new THREE.SphereGeometry(3, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffd29a').multiplyScalar(40) }));
      sun.position.set(-40, 8, 20);
      s.add(sun);
    }, 0.02),
  },
  'Night city': {
    bg: ['#121a2c', '#05060a'],
    make: () => envFromScene((s) => {
      gradientDome(s, '#04060c', '#162238', '#030304');
      const cols = [0xff3d7f, 0x3dd8ff, 0xffb13d, 0x8a5bff];
      for (let i = 0; i < 16; i++) panel(s, 2 + (i % 3), 0.6, Math.cos(i) * 24, 2 + (i % 5) * 2.5, Math.sin(i) * 24, 4, cols[i % 4]);
    }),
  },
  'Overcast': {
    bg: ['#c9d3dc', '#7f8790'],
    make: () => envFromScene((s) => gradientDome(s, '#b8c6d4', '#e8edf1', '#5d6166'), 0.06),
  },
};
const envCache = {};
const view = { env: 'Studio', bgMode: 'Gradient', floor: 'Glossy', exposure: 1, sun: 1.6, turntable: false, autoSpin: 0.25 };
let customEnv = null;

const backdrop = new THREE.Mesh(new THREE.SphereGeometry(150, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  uniforms: { top: { value: new THREE.Color() }, bot: { value: new THREE.Color() } },
  vertexShader: 'varying float y; void main(){ y = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
  fragmentShader: 'uniform vec3 top, bot; varying float y; void main(){ gl_FragColor = vec4(mix(bot, top, smoothstep(-.05, .6, y)), 1.); }',
}));
backdrop.renderOrder = -1;
scene.add(backdrop);

function applyEnv() {
  const E = ENVS[view.env];
  const tex = view.env === 'Custom HDR' ? customEnv : (envCache[view.env] ??= E.make());
  scene.environment = tex;
  backdrop.visible = view.bgMode === 'Gradient';
  if (view.bgMode === 'Gradient') {
    const [t, b] = E?.bg ?? ['#30343b', '#15171a'];
    backdrop.material.uniforms.top.value.set(t);
    backdrop.material.uniforms.bot.value.set(b);
    scene.background = null;
  } else if (view.bgMode === 'Environment') {
    scene.background = tex;
    scene.backgroundBlurriness = 0.35;
  } else scene.background = new THREE.Color('#0d0f13');
  renderer.toneMappingExposure = view.exposure;
}

const key = new THREE.DirectionalLight(0xffffff, view.sun);
key.position.set(4, 9, 5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 1, far: 30 });
key.shadow.radius = 6;
key.shadow.bias = -0.0004;
scene.add(key);

// Floors: shadow-only, glossy disc, or a real mirror under a tinted glaze.
const floorGroup = new THREE.Group();
scene.add(floorGroup);
const shadowFloor = new THREE.Mesh(new THREE.CircleGeometry(14, 64), new THREE.ShadowMaterial({ opacity: 0.45 }));
shadowFloor.rotation.x = -Math.PI / 2;
shadowFloor.receiveShadow = true;
const glossFloor = new THREE.Mesh(new THREE.CircleGeometry(9, 96), new THREE.MeshPhysicalMaterial({ color: 0x1a1c20, roughness: 0.22, metalness: 0.1, clearcoat: 0.6 }));
glossFloor.rotation.x = -Math.PI / 2;
glossFloor.position.y = -0.002;
glossFloor.receiveShadow = true;
let mirror = null;
const glaze = new THREE.Mesh(new THREE.CircleGeometry(9, 96), new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.4, transparent: true, opacity: 0.72 }));
glaze.rotation.x = -Math.PI / 2;
glaze.position.y = 0.001;
glaze.receiveShadow = true;
const turntable = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.5, 0.06, 96), new THREE.MeshPhysicalMaterial({ color: 0x2a2d33, metalness: 0.6, roughness: 0.3, clearcoat: 0.5 }));
turntable.position.y = -0.03;
turntable.receiveShadow = true;

function applyFloor() {
  floorGroup.clear();
  if (view.floor === 'Shadow only') floorGroup.add(shadowFloor);
  if (view.floor === 'Glossy') floorGroup.add(glossFloor, shadowFloor);
  if (view.floor === 'Mirror') {
    mirror ??= new Reflector(new THREE.CircleGeometry(9, 96), { textureWidth: 1024, textureHeight: 1024, color: 0x9a9a9a });
    mirror.rotation.x = -Math.PI / 2;
    mirror.position.y = -0.003;
    floorGroup.add(mirror, glaze, shadowFloor);
  }
  if (view.floor === 'Turntable') floorGroup.add(turntable, shadowFloor);
}

// Headlight beams for "lights on"
const beams = [-1, 1].map(() => {
  const s = new THREE.SpotLight(0xe8f2ff, 0, 18, 0.45, 0.6, 1.2);
  scene.add(s, s.target);
  return s;
});

// ---------------------------------------------------------------------------------------------
// The car

const carRoot = new THREE.Group();
carRoot.name = 'Vehicle';
scene.add(carRoot);
let car = null;
let uploaded = false;

function rebuildCar() {
  if (car) carRoot.remove(car);
  car = uploaded ? car : buildCar(cfg.style, mats, { rim: cfg.rim, wheelScale: cfg.wheelScale });
  carRoot.add(car);
  applyRide();
}
function applyRide() {
  if (!car || uploaded) return;
  car.position.y = cfg.ride;
  // Wheels stay on the floor while the body moves.
  car.userData.wheels?.position.set(0, -cfg.ride, 0);
}

let paintTween = null;
function applyMaterials(animate = true) {
  const F = FINISHES[cfg.finish];
  const target = new THREE.Color(cfg.paintHex);
  Object.assign(mats.paint, { metalness: F.metalness, roughness: F.roughness, clearcoat: F.clearcoat, clearcoatRoughness: F.clearcoatRoughness, iridescence: F.iridescence, sheen: F.sheen });
  if (F.iridescenceIOR) mats.paint.iridescenceIOR = F.iridescenceIOR;
  mats.paint.iridescenceThicknessRange = [120, 420];
  if (cfg.finish === 'Candy') target.multiplyScalar(0.6);
  if (cfg.finish === 'Chrome') target.lerp(new THREE.Color(1, 1, 1), 0.6);
  if (animate) {
    const from = mats.paint.color.clone(), t0 = performance.now();
    paintTween = () => {
      const k = Math.min(1, (performance.now() - t0) / 600);
      mats.paint.color.lerpColors(from, target, k * k * (3 - 2 * k));
      if (k >= 1) paintTween = null;
    };
  } else mats.paint.color.copy(target);
  const [rc, rr] = RIM_FINISH[cfg.rimFinish];
  mats.rim.color.set(rc);
  mats.rim.roughness = rr;
  mats.caliper.color.set(CALIPERS[cfg.caliper]);
  const [gc, go] = GLASS[cfg.glass];
  mats.glass.color.set(gc);
  mats.glass.opacity = go;
  mats.interior.color.set(INTERIOR[cfg.interior]);
  mats.headlight.emissiveIntensity = cfg.lights ? 5 : 0.15;
  mats.taillight.emissiveIntensity = cfg.lights ? 4 : 0.25;
  aimBeams();
  for (const m of Object.values(mats)) m.needsUpdate = true;
}
function aimBeams() {
  const S = car?.userData.dims;
  beams.forEach((b, i) => {
    b.intensity = cfg.lights && S ? 60 : 0;
    if (!S) return;
    const s = i ? 1 : -1;
    b.position.set(S.len / 2 - 0.1, S.noseH + 0.06 + cfg.ride, s * (S.width / 2 - 0.36)).applyMatrix4(carRoot.matrixWorld);
    b.target.position.set(S.len / 2 + 6, 0, s * 1.2).applyMatrix4(carRoot.matrixWorld);
  });
}

function setCfg(patch, { rebuild = false } = {}) {
  Object.assign(cfg, patch);
  if (rebuild) rebuildCar();
  applyMaterials();
  applyRide();
  renderConfig();
}

// ---------------------------------------------------------------------------------------------
// Variant sets

const vsets = [
  { name: 'Track Spec', cfg: { style: 'Coupe', paint: 'Solar Yellow', paintHex: '#f2c21b', finish: 'Gloss', rim: 'Turbine', rimFinish: 'Gloss black', caliper: 'Black', glass: 'Light tint', interior: 'Black', lights: false, ride: -0.04, wheelScale: 1.05 } },
  { name: 'Grand Tourer', cfg: { style: 'Coupe', paint: 'Midnight Blue', paintHex: '#0d1f45', finish: 'Pearl', rim: 'Multi-spoke', rimFinish: 'Silver', caliper: 'Blue', glass: 'Light tint', interior: 'Tan', lights: false, ride: 0, wheelScale: 1 } },
  { name: 'Stealth', cfg: { style: 'Sedan', paint: 'Graphite', paintHex: '#3b3e43', finish: 'Matte', rim: 'Mesh', rimFinish: 'Gloss black', caliper: 'Orange', glass: 'Privacy', interior: 'Black', lights: true, ride: -0.02, wheelScale: 1 } },
  { name: 'Heritage', cfg: { style: 'Sedan', paint: 'British Green', paintHex: '#0f3b2a', finish: 'Metallic', rim: 'Five-spoke', rimFinish: 'Chrome', caliper: 'Black', glass: 'Clear', interior: 'Oxblood', lights: false, ride: 0.02, wheelScale: 0.95 } },
  { name: 'Expedition', cfg: { style: 'SUV', paint: 'Arctic White', paintHex: '#eef0f2', finish: 'Satin', rim: 'Aero disc', rimFinish: 'Bronze', caliper: 'Black', glass: 'Privacy', interior: 'Slate blue', lights: true, ride: 0.06, wheelScale: 1 } },
];
function applySet(v) {
  const rebuild = !uploaded && (v.cfg.style !== cfg.style || v.cfg.rim !== cfg.rim || v.cfg.wheelScale !== cfg.wheelScale);
  setCfg(structuredClone(v.cfg), { rebuild });
  $('#stMsg').textContent = `Variant set: ${v.name}`;
}

function renderSets() {
  const grid = el('div', { class: 'grid-cards vsets' }, ...vsets.map((v, i) => el('div', {
    class: 'card', title: `${v.name}: ${v.cfg.paint} ${v.cfg.finish}, ${v.cfg.rim} rims`,
    style: v.thumb ? { backgroundImage: `url(${v.thumb})` } : { background: `radial-gradient(circle at 40% 35%, ${v.cfg.paintHex}, #111 75%)` },
    onclick: () => applySet(v),
  }, el('span', {}, v.name), v.user ? el('button', { class: 'x', title: 'Delete', onclick: (e) => { e.stopPropagation(); vsets.splice(i, 1); renderSets(); } }, '✕') : null)));
  const nameIn = el('input', { class: 'field', placeholder: 'Name this configuration' });
  $('#setsPane').replaceChildren(
    el('section', { class: 'section' }, el('h3', {}, 'Variant sets'), el('div', { class: 'body' }, grid,
      el('div', { class: 'row', style: { marginTop: '8px', gridTemplateColumns: '1fr auto' } }, nameIn,
        el('button', { class: 'btn sm', onclick: async () => {
          const v = { name: nameIn.value.trim() || `Config ${vsets.length + 1}`, cfg: structuredClone(cfg), user: true };
          vsets.push(v);
          v.thumb = await stage.snapshot(240);
          renderSets();
        } }, 'Save current')),
      el('p', { class: 'hint' }, 'A variant set stores every option. Click one to switch; the paint blends over.'))),
    el('section', { class: 'section' }, el('h3', {}, 'Viewpoints'), el('div', { class: 'body' },
      el('div', { class: 'seg' }, ...viewpoints.map((vp) => el('button', { class: 'btn sm', onclick: () => goView(vp) }, vp.name))),
      el('div', { class: 'btn-row tight', style: { marginTop: '6px' } }, el('button', { class: 'btn sm', onclick: () => {
        viewpoints.push({ name: `View ${viewpoints.length + 1}`, pos: cam.position.toArray(), target: controls.target.toArray() });
        renderSets();
      } }, 'Save current view')))),
  );
}

// ---------------------------------------------------------------------------------------------
// Cameras

const viewpoints = [
  { name: 'Front 3/4', pos: [4.6, 1.5, 4.4], target: [0, 0.65, 0] },
  { name: 'Rear 3/4', pos: [-4.8, 1.7, 4.2], target: [0, 0.7, 0] },
  { name: 'Side', pos: [0, 0.9, 7.2], target: [0, 0.65, 0] },
  { name: 'Front', pos: [7, 0.9, 0], target: [0, 0.65, 0] },
  { name: 'Top', pos: [0.01, 9, 0.01], target: [0, 0, 0] },
  { name: 'Wheel detail', pos: [1.9, 0.5, 2.5], target: [1.4, 0.35, 0.82] },
  { name: 'Interior', pos: [-0.35, 1.05, -0.38], target: [1.6, 0.85, -0.38] },
  { name: 'Low hero', pos: [5.2, 0.35, 2.4], target: [0, 0.75, 0] },
];
function goView(vp) {
  const S = car?.userData.dims;
  let pos = vp.pos, target = vp.target;
  if (vp.name === 'Interior' && S) { pos = [(S.roofF + S.roofR) / 2 - 0.1, S.belt + 0.18 + cfg.ride, -0.38]; target = [S.len / 2, S.belt + 0.05, -0.38]; }
  if (vp.name === 'Wheel detail' && S) { pos = [S.wb / 2 + 0.6, 0.5, S.track / 2 + 1.7]; target = [S.wb / 2, S.wheelR, S.track / 2]; }
  controls.minDistance = vp.name === 'Interior' ? 0.05 : 1.2;
  stage.flyTo(pos, target, 1.1);
}

// ---------------------------------------------------------------------------------------------
// Panels

wireTabs();
wireSections();
const section = (title, ...rows) => el('section', { class: 'section' }, el('h3', {}, title), el('div', { class: 'body' }, rows));
const seg = (options, value, fn) => el('div', { class: 'seg' }, ...options.map((o) => el('button', { class: 'btn sm' + (o === value ? ' on' : ''), onclick: () => fn(o) }, o)));

function renderConfig() {
  $('#configPane').replaceChildren(
    section('Model',
      seg([...Object.keys(STYLES), ...(uploaded ? ['Uploaded'] : [])], uploaded ? 'Uploaded' : cfg.style, (s) => {
        if (s === 'Uploaded') return;
        uploaded = false;
        setCfg({ style: s }, { rebuild: true });
        stage.frame(carRoot, [1, 0.35, 0.95]);
      }),
      el('div', { class: 'btn-row tight', style: { marginTop: '6px' } }, el('button', { class: 'btn sm', onclick: upload }, 'Upload your car (.glb .obj .stl)')),
      uploaded ? el('p', { class: 'hint' }, 'Click a part of your model, then use the Material tab to give it Paint, Glass, Chrome, Rim… so the variant options drive it.') : null),
    section('Paint',
      el('div', { class: 'swatches' }, ...PAINTS.map(([n, hex]) => el('button', { class: n === cfg.paint ? 'sel' : '', title: n, style: { background: hex }, onclick: () => setCfg({ paint: n, paintHex: hex }) }))),
      el('div', { class: 'row', style: { marginTop: '6px' } }, el('label', {}, cfg.paint), (() => { const c = el('input', { type: 'color', value: cfg.paintHex }); c.oninput = () => setCfg({ paint: 'Custom', paintHex: c.value }); return c; })(), el('span')),
      el('div', { style: { marginTop: '6px' } }, seg(Object.keys(FINISHES), cfg.finish, (f) => setCfg({ finish: f })))),
    section('Wheels',
      seg(RIMS, cfg.rim, (r) => setCfg({ rim: r }, { rebuild: !uploaded })),
      el('div', { style: { marginTop: '6px' } }, seg(Object.keys(RIM_FINISH), cfg.rimFinish, (r) => setCfg({ rimFinish: r }))),
      slider('Wheel size', { min: 0.85, max: 1.2, step: 0.01, value: cfg.wheelScale }, (v) => { cfg.wheelScale = v; clearTimeout(renderConfig.t); renderConfig.t = setTimeout(() => setCfg({}, { rebuild: !uploaded }), 120); }).row,
      el('div', { class: 'row' }, el('label', {}, 'Calipers'), seg(Object.keys(CALIPERS), cfg.caliper, (c) => setCfg({ caliper: c })), el('span'))),
    section('Glass & interior',
      el('div', { class: 'row' }, el('label', {}, 'Glass'), seg(Object.keys(GLASS), cfg.glass, (g) => setCfg({ glass: g })), el('span')),
      el('div', { class: 'row' }, el('label', {}, 'Interior'), seg(Object.keys(INTERIOR), cfg.interior, (i) => setCfg({ interior: i })), el('span'))),
    section('Stance & lights',
      slider('Ride height', { min: -0.08, max: 0.1, step: 0.005, value: cfg.ride, unit: ' m' }, (v) => { cfg.ride = v; applyRide(); aimBeams(); }).row,
      toggle('Lights on', cfg.lights, (v) => setCfg({ lights: v })).row),
  );
}

function renderScene() {
  $('#scenePane').replaceChildren(
    section('Environment',
      seg([...Object.keys(ENVS), ...(customEnv ? ['Custom HDR'] : [])], view.env, (e) => { view.env = e; applyEnv(); renderScene(); }),
      el('div', { class: 'btn-row tight', style: { marginTop: '6px' } }, el('button', { class: 'btn sm', onclick: async () => { const [f] = await pickFiles('.hdr'); if (f) loadHDR(f); } }, 'Upload .hdr')),
      select('Background', ['Gradient', 'Environment', 'Dark'], view.bgMode, (v) => { view.bgMode = v; applyEnv(); }).row,
      slider('Exposure', { min: 0.3, max: 2.5, step: 0.05, value: view.exposure }, (v) => { view.exposure = v; applyEnv(); }).row,
      slider('Key light', { min: 0, max: 5, step: 0.05, value: view.sun }, (v) => { view.sun = v; key.intensity = v; }).row,
      slider('Key angle', { min: 0, max: 360, step: 1, value: 50 }, (v) => { const a = THREE.MathUtils.degToRad(v); key.position.set(Math.cos(a) * 6.4, 9, Math.sin(a) * 6.4); }).row),
    section('Floor',
      seg(['Shadow only', 'Glossy', 'Mirror', 'Turntable'], view.floor, (f) => { view.floor = f; applyFloor(); renderScene(); })),
    section('Presentation',
      toggle('Turntable spin', view.turntable, (v) => { view.turntable = v; }).row,
      slider('Spin speed', { min: 0.05, max: 1, step: 0.01, value: view.autoSpin }, (v) => (view.autoSpin = v)).row,
      slider('Lens (FOV)', { min: 15, max: 70, step: 1, value: cam.fov, unit: '°' }, (v) => { cam.fov = v; cam.updateProjectionMatrix(); }).row),
  );
}

// Selection + material editor
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let selectedMesh = null;
const selBox = new THREE.BoxHelper(undefined, 0x4aa8ff);
selBox.material.depthTest = false;
selBox.visible = false;
scene.add(selBox);
stage.hideOnSnapshot.push(selBox);
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, cam);
  const hit = ray.intersectObject(carRoot, true)[0];
  selectMesh(hit?.object ?? null);
});
function selectMesh(m) {
  selectedMesh = m;
  selBox.visible = !!m;
  if (m) { selBox.setFromObject(m); $$('[data-tabs="right"] button').find((b) => b.dataset.tab === 'material').click(); }
  renderMatPane();
}
const LIB_LABEL = { paint: 'Paint', glass: 'Glass', trim: 'Trim black', chrome: 'Chrome', rubber: 'Rubber', rim: 'Rim', brake: 'Brake disc', caliper: 'Caliper', interior: 'Interior leather', headlight: 'Headlight', taillight: 'Tail light' };
function renderMatPane() {
  const host = $('#matPane');
  if (!selectedMesh) { host.replaceChildren(section('Material editor', el('p', { class: 'hint' }, 'Click any part of the car to edit its material.'))); return; }
  const m = selectedMesh.material;
  const libKey = Object.keys(mats).find((k) => mats[k] === m);
  const num = (label, prop, min, max, step = 0.01) => (prop in m ? slider(label, { min, max, step, value: m[prop] }, (v) => { m[prop] = v; m.needsUpdate = true; }).row : null);
  host.replaceChildren(section('Material editor',
    el('div', { class: 'part-name' }, selectedMesh.name || 'Part'),
    el('p', { class: 'hint' }, libKey ? `Shared "${LIB_LABEL[libKey]}" material: edits apply to every part that uses it.` : 'This part has its own material.'),
    select('Use library', [['', libKey ? LIB_LABEL[libKey] : 'Own material'], ...Object.entries(LIB_LABEL).filter(([k]) => k !== libKey)], '', (k) => {
      if (!k) return;
      selectedMesh.material = mats[k];
      selectedMesh.userData.part = k;
      applyMaterials(false);
      renderMatPane();
    }).row,
    color('Color', '#' + m.color.getHexString(), (v) => m.color.set(v)).row,
    num('Metalness', 'metalness', 0, 1), num('Roughness', 'roughness', 0, 1),
    num('Clearcoat', 'clearcoat', 0, 1), num('Coat rough', 'clearcoatRoughness', 0, 1),
    num('Iridescence', 'iridescence', 0, 1), num('Sheen', 'sheen', 0, 1),
    num('Opacity', 'opacity', 0.05, 1), num('Emission', 'emissiveIntensity', 0, 8, 0.05),
    el('div', { class: 'btn-row tight', style: { marginTop: '6px' } },
      el('button', { class: 'btn sm', onclick: () => { selectedMesh.visible = !selectedMesh.visible; } }, 'Hide / show part'),
      el('button', { class: 'btn sm', onclick: () => stage.frame(selectedMesh, [1, 0.4, 1]) }, 'Frame part'))));
  if (m.transparent === false && 'opacity' in m) $$('input[type=range]', host).at(-2)?.addEventListener('input', () => { m.transparent = m.opacity < 1; });
}

// Viewport toolbar
function renderTools() {
  $('#tools').replaceChildren(
    ...['Front 3/4', 'Side', 'Rear 3/4', 'Interior'].map((n) => el('button', { class: 'btn sm', onclick: () => goView(viewpoints.find((v) => v.name === n)) }, n)),
    el('button', { class: 'btn sm' + (view.turntable ? ' on' : ''), onclick: () => { view.turntable = !view.turntable; renderTools(); renderScene(); } }, 'Turntable'),
    el('button', { class: 'btn sm' + (cfg.lights ? ' on' : ''), onclick: () => { setCfg({ lights: !cfg.lights }); renderTools(); } }, 'Lights'),
  );
}

// ---------------------------------------------------------------------------------------------
// Upload, render, export, push

async function upload() { importFiles(await pickFiles('.glb,.gltf,.obj,.stl,.hdr', true)); }
async function loadHDR(f) {
  $('#busy').hidden = false;
  try {
    const url = URL.createObjectURL(f);
    const tex = await new RGBELoader().loadAsync(url);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    customEnv = pmrem.fromEquirectangular(tex).texture;
    view.env = 'Custom HDR';
    view.bgMode = 'Environment';
    applyEnv();
    renderScene();
    toast(`${f.name} is now the lighting environment.`);
  } catch (e) { toast('HDR failed: ' + e.message, true); } finally { $('#busy').hidden = true; }
}
async function importFiles(files) {
  for (const f of files) {
    const ext = f.name.split('.').pop().toLowerCase();
    if (ext === 'hdr') { await loadHDR(f); continue; }
    if (!['glb', 'gltf', 'obj', 'stl'].includes(ext)) { toast(`Can't import .${ext}`, true); continue; }
    $('#busy').hidden = false;
    try {
      const obj = fitObject(await loadModelFile(f), 4.5);
      obj.name = f.name.replace(/\.[^.]+$/, '');
      // Guess roles from material names so the variant options drive common parts straight away.
      obj.traverse((o) => {
        if (!o.isMesh) return;
        const n = `${o.name} ${o.material?.name ?? ''}`.toLowerCase();
        const guess = /paint|body|carpaint|exterior/.test(n) ? 'paint' : /glass|window|windshield/.test(n) ? 'glass' : /tyre|tire|rubber/.test(n) ? 'rubber' : /rim|wheel/.test(n) ? 'rim' : /caliper/.test(n) ? 'caliper' : /chrome/.test(n) ? 'chrome' : null;
        if (guess) { o.material = mats[guess]; o.userData.part = guess; }
      });
      if (car) carRoot.remove(car);
      car = obj;
      uploaded = true;
      carRoot.add(car);
      applyMaterials(false);
      renderConfig();
      stage.frame(carRoot, [1, 0.35, 0.95]);
      toast(`${f.name} loaded. Click parts to give them Paint, Glass, Rim… materials.`);
    } catch (e) { console.error(e); toast(`${f.name}: ${e.message}`, true); } finally { $('#busy').hidden = true; }
  }
}
$('#btnUpload').onclick = upload;
onDrop(document.body, $('#vp'), importFiles, 'Drop a car model or an .hdr');
$('#btnRender').onclick = async () => download(await stage.snapshot(3840, 'image/png'), `vehicle-studio-${slug(cfg.paint)}.png`);
async function buildExport() {
  const glb = await exportGLB(carRoot);
  return { glb, meta: { ...cfg, model: uploaded ? car.name : `${cfg.style} concept` } };
}
$('#btnGlb').onclick = async () => download((await buildExport()).glb, `vehicle-${slug(cfg.paint)}.glb`);
$('#btnPush').onclick = () => pushDialog({
  app: 'vehicle',
  defaultName: `${uploaded ? car.name : cfg.style} · ${cfg.paint} ${cfg.finish}`,
  thumb: stage.snapshot(),
  build: buildExport,
  notesHint: 'e.g. "Launch colour for the auto show stand"',
});

// ---------------------------------------------------------------------------------------------
// Boot

stage.onTick = (dt) => {
  paintTween?.();
  if (view.turntable) {
    carRoot.rotation.y += dt * view.autoSpin;
    if (view.floor === 'Turntable') turntable.rotation.y = carRoot.rotation.y;
    if (cfg.lights) aimBeams();
  }
  if (selectedMesh && selBox.visible) selBox.setFromObject(selectedMesh);
};
let fpsT = performance.now(), fpsN = 0;
setInterval(() => {
  const now = performance.now();
  const fps = Math.round(((stage.frames - fpsN) * 1000) / (now - fpsT));
  fpsT = now; fpsN = stage.frames;
  $('#stInfo').textContent = `${uploaded ? car.name : cfg.style} · ${cfg.paint} ${cfg.finish} · ${renderer.info.render.triangles.toLocaleString()} tris · ${fps} fps`;
}, 1000);

applyEnv();
applyFloor();
rebuildCar();
carRoot.updateMatrixWorld();
applyMaterials(false);
renderConfig();
renderScene();
renderSets();
renderMatPane();
renderTools();
wireDepthChip(stage, $('#chip'));
stage.start();
window.studio = { stage, cfg, setCfg, applySet, vsets, goView, viewpoints, importFiles, mats, view, applyFloor, applyEnv };
