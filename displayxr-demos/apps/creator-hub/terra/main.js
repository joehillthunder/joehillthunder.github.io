// Terra Studio: an ArcGIS-style 3D scene builder. Real elevation and basemap tiles become a terrain
// "table model"; layers add contours, hypsometric tint, a water level, OSM buildings and your own
// GeoJSON / CSV data; tools identify, measure (with an elevation profile), test line of sight and
// sketch pins, symbols and extruded buildings. The scene is pushed to DisplayXR HQ as a .glb.
//
// World space: the area is S x S units centred on the origin, north is -z. Pixel space (px, py) is
// the stitched tile mosaic, P x P pixels, row 0 at the north edge.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Stage, wireDepthChip } from '../shared/stage.js';
import { $, $$, el, wireSections, wireTabs, slider, select, color, toggle, toast, modal, pickFiles, onDrop, download, slug, exportGLB, readImage, pushDialog } from '../shared/ui.js';
import { TILE, BASEMAPS, ELEVATION_URL, ELEVATION_CREDIT, PLACES, lonLatToPx, pxToLonLat, metresPerPx, stitch, decodeTerrarium, proceduralDEM, decodeHeightImage, fetchBuildings, parseCSV } from './geo.js';

const S = 10; // world units across the area
const SEG = 255; // terrain grid segments
const BASE = -0.35; // bottom of the table-model block

const stage = new Stage($('#stage'), { fov: 35, tag: 'terra', far: 300, pop: 1.0 });
const { scene, renderer, cam, controls } = stage;
cam.position.set(0, 7.5, 10.5);
controls.target.set(0, 0.4, 0);
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.minDistance = 0.4;
controls.maxDistance = 40;
controls.screenSpacePanning = false;
scene.background = new THREE.Color('#141820');
renderer.toneMappingExposure = 1.1;

const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x3a3020, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -7.5, right: 7.5, top: 7.5, bottom: -7.5, near: 0.5, far: 60 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.01;
scene.add(sun, sun.target);
const view = { sunAz: 315, sunAlt: 40, exag: 1.5, basemap: 'Imagery', tint: 0, contours: false, contourStep: 100, water: false, waterLevel: 0, symbolSize: 0.16, bldHeight: 120, sketchColor: '#ff6a3d' };
function placeSun() {
  const az = THREE.MathUtils.degToRad(view.sunAz), alt = THREE.MathUtils.degToRad(view.sunAlt);
  sun.position.set(Math.sin(az) * Math.cos(alt) * 20, Math.sin(alt) * 20, -Math.cos(az) * Math.cos(alt) * 20);
}
placeSun();

const world = new THREE.Group();
world.name = 'Terra Studio scene';
scene.add(world);

// ---------------------------------------------------------------------------------------------
// Area state

let area = null; // { geo, name, lat, lon, z, G, tx0, ty0, P, mpp, extentM, heights, hmin, hmax }
const u = () => S / area.extentM; // world units per metre (horizontal)
const vscale = () => u() * view.exag;

function sampleH(px, py) {
  const P = area.P, H = area.heights;
  const x = Math.max(0, Math.min(P - 1.001, px - 0.5)), y = Math.max(0, Math.min(P - 1.001, py - 0.5));
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const a = H[yi * P + xi], b = H[yi * P + xi + 1], c = H[(yi + 1) * P + xi], d = H[(yi + 1) * P + xi + 1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
const yOf = (h) => (h - area.hmin) * vscale();
const pxToWorld = (px, py, lift = 0) => new THREE.Vector3((px / area.P - 0.5) * S, yOf(sampleH(px, py)) + lift, (py / area.P - 0.5) * S);
const worldToPx = (v) => [(v.x / S + 0.5) * area.P, (v.z / S + 0.5) * area.P];
/** A stored point (lon/lat when geo, px otherwise) to area pixels. */
function ptToPx(p) {
  if (p.px != null) return [p.px, p.py];
  const [gx, gy] = lonLatToPx(p.lon, p.lat, area.z);
  return [gx - area.tx0 * TILE, gy - area.ty0 * TILE];
}
function pxToPt(px, py) {
  if (!area.geo) return { px, py };
  const [lon, lat] = pxToLonLat(area.tx0 * TILE + px, area.ty0 * TILE + py, area.z);
  return { lon, lat };
}
const mPerPx = () => area.extentM / area.P;

// ---------------------------------------------------------------------------------------------
// Terrain mesh with contour / tint shader hooks

const uniforms = { uTint: { value: 0 }, uContour: { value: 0 }, uMin: { value: 0 }, uMax: { value: 1 } };
const terrainMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
terrainMat.onBeforeCompile = (sh) => {
  Object.assign(sh.uniforms, uniforms);
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float elev;\nvarying float vElev;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvElev = elev;');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform float uTint, uContour, uMin, uMax;
varying float vElev;
vec3 hypso(float t) {
  vec3 c0 = vec3(.18,.43,.23), c1 = vec3(.56,.70,.35), c2 = vec3(.90,.84,.54), c3 = vec3(.73,.54,.33), c4 = vec3(.54,.42,.35), c5 = vec3(.96);
  t = clamp(t, 0., 1.) * 5.;
  if (t < 1.) return mix(c0, c1, t); if (t < 2.) return mix(c1, c2, t - 1.); if (t < 3.) return mix(c2, c3, t - 2.);
  if (t < 4.) return mix(c3, c4, t - 3.); return mix(c4, c5, t - 4.);
}`).replace('#include <map_fragment>', `#include <map_fragment>
if (uTint > 0.) diffuseColor.rgb = mix(diffuseColor.rgb, hypso((vElev - uMin) / max(1., uMax - uMin)), uTint);
if (uContour > 0.) {
  float f = vElev / uContour;
  float w = fwidth(f);
  float line = 1. - smoothstep(0., w * 1.3, abs(fract(f + .5) - .5));
  float idx = floor(f + .5);
  float major = abs(mod(idx, 5.)) < .5 ? 1. : 0.;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.42, .24, .1) * (1. - .45 * major), line * (.55 + .4 * major));
}`);
};
let terrain = null, walls = null, baseTex = null;
const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a3128, roughness: 1 });

function buildTerrain() {
  if (terrain) { world.remove(terrain, walls); terrain.geometry.dispose(); walls.geometry.dispose(); }
  const g = new THREE.PlaneGeometry(S, S, SEG, SEG).rotateX(-Math.PI / 2);
  const pos = g.attributes.position, elev = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const ix = i % (SEG + 1), iy = Math.floor(i / (SEG + 1));
    const h = sampleH((ix / SEG) * area.P, (iy / SEG) * area.P);
    elev[i] = h;
    pos.setY(i, yOf(h));
  }
  g.setAttribute('elev', new THREE.BufferAttribute(elev, 1));
  g.computeVertexNormals();
  terrain = new THREE.Mesh(g, terrainMat);
  terrain.name = 'Terrain';
  terrain.castShadow = terrain.receiveShadow = true;

  // Side walls + base: the terrain becomes a physical table model, which reads well in depth.
  const wp = [], idx = [];
  const edge = (fn) => {
    const start = wp.length / 3;
    for (let k = 0; k <= SEG; k++) {
      const [x, z, px, py] = fn(k / SEG);
      const y = yOf(sampleH(px, py));
      wp.push(x, y, z, x, BASE, z);
    }
    for (let k = 0; k < SEG; k++) { const a = start + k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  };
  const P = area.P;
  edge((t) => [(t - 0.5) * S, -S / 2, t * P, 0]);
  edge((t) => [S / 2, (t - 0.5) * S, P, t * P]);
  edge((t) => [(0.5 - t) * S, S / 2, (1 - t) * P, P]);
  edge((t) => [-S / 2, (0.5 - t) * S, 0, (1 - t) * P]);
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
  wg.setIndex(idx);
  const bottom = new THREE.PlaneGeometry(S, S).rotateX(Math.PI / 2).translate(0, BASE, 0);
  const strip = (x) => { x.deleteAttribute('uv'); x.deleteAttribute('normal'); return x.index ? x.toNonIndexed() : x; };
  walls = new THREE.Mesh(mergeGeometries([strip(wg), strip(bottom)]), wallMat);
  walls.geometry.computeVertexNormals();
  walls.material.side = THREE.DoubleSide;
  walls.name = 'Base';
  walls.castShadow = walls.receiveShadow = true;
  world.add(terrain, walls);
  uniforms.uMin.value = area.hmin;
  uniforms.uMax.value = area.hmax;
  applyLook();
  placeWater();
}

function applyLook() {
  const b = view.basemap;
  terrainMat.map = BASEMAPS[b]?.url || b === 'Custom image' ? baseTex : null;
  terrainMat.color.set(terrainMat.map ? 0xffffff : 0xe8e4dc);
  uniforms.uTint.value = b === 'Elevation tint' ? 1 : view.tint;
  uniforms.uContour.value = view.contours ? view.contourStep : 0;
  terrainMat.needsUpdate = true;
  const credits = [BASEMAPS[b]?.credit, area?.geo ? ELEVATION_CREDIT : 'Elevation: uploaded heightmap'].filter(Boolean);
  $('#credit').textContent = credits.join(' · ');
}

// Water level plane
const water = new THREE.Mesh(new THREE.PlaneGeometry(S, S).rotateX(-Math.PI / 2), new THREE.MeshPhysicalMaterial({ color: 0x2a6f97, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.72, clearcoat: 1 }));
water.name = 'Water level';
water.receiveShadow = true;
function placeWater() {
  water.visible = view.water;
  water.position.y = Math.max(0.001, yOf(view.waterLevel));
  if (!water.parent) world.add(water);
}

// ---------------------------------------------------------------------------------------------
// Loading an area

let loadSeq = 0;
async function loadArea({ name, lat, lon, z, G = 4, buildings = false }) {
  const seq = ++loadSeq;
  z = Math.max(3, Math.min(15, Math.round(z)));
  const busy = $('#busy');
  busy.hidden = false;
  busy.textContent = `LOADING ${name.toUpperCase()}…`;
  const [cx, cy] = lonLatToPx(lon, lat, z);
  const tx0 = Math.floor(cx / TILE - G / 2 + 0.5), ty0 = Math.floor(cy / TILE - G / 2 + 0.5);
  const prog = (d, n) => (busy.textContent = `LOADING ${name.toUpperCase()} · ${d}/${n} TILES`);
  const bm = BASEMAPS[view.basemap]?.url ? view.basemap : 'Imagery';
  const [elev, imagery] = await Promise.all([
    stitch(ELEVATION_URL, z, tx0, ty0, G, prog),
    stitch(BASEMAPS[bm].url, z, tx0, ty0, G),
  ]);
  if (seq !== loadSeq) return;
  const P = G * TILE;
  let heights = decodeTerrarium(elev.canvas);
  let offline = elev.failed === G * G;
  if (offline) heights = proceduralDEM(P);
  const [hmin, hmax] = robustRange(heights);
  const mpp = metresPerPx(lat, z);
  area = { geo: true, name, lat, lon, z, G, tx0, ty0, P, mpp, extentM: P * mpp, heights, hmin, hmax };
  setBaseCanvas(imagery.failed === G * G ? null : imagery.canvas, bm);
  view.waterLevel = Math.round(hmin + (hmax - hmin) * 0.15);
  if (area.extentM < 6000 && view.exag > 1.2) view.exag = 1;
  if (area.extentM > 20000 && view.exag < 1.5) view.exag = 1.5;
  buildTerrain();
  rebuildLayers();
  busy.hidden = true;
  stage.flyTo([0, 6.2 + yOf(hmax) * 0.5, 9], [0, yOf((hmin + hmax) / 2) * 0.6, 0], 1.2);
  $('#stMsg').textContent = offline
    ? 'Elevation tiles unreachable: showing a procedural range instead.'
    : `${name}: ${(area.extentM / 1000).toFixed(1)} km across, ${Math.round(hmin)}–${Math.round(hmax)} m`;
  renderMap();
  renderLayers();
  if (buildings && area.extentM < 8000) addOsmBuildings();
}

/** Clamp elevation spikes: tile no-data pixels can read -15 km (seen over the Hudson at zoom 15). */
function robustRange(h) {
  const sample = [];
  const step = Math.max(1, Math.floor(h.length / 40000));
  for (let i = 0; i < h.length; i += step) sample.push(h[i]);
  sample.sort((a, b) => a - b);
  const q = (p) => sample[Math.min(sample.length - 1, Math.floor(sample.length * p))];
  // Percentile trim, plus an outlier fence 3 inter-percentile spreads beyond the 5th-95th band.
  const spread = Math.max(20, q(0.95) - q(0.05));
  const lo = Math.max(q(0.002), q(0.05) - 3 * spread), hi = Math.min(q(0.9995), q(0.95) + 3 * spread);
  for (let i = 0; i < h.length; i++) h[i] = h[i] < lo ? lo : h[i] > hi ? hi : h[i];
  return [lo, Math.max(hi, lo + 1)];
}

function setBaseCanvas(canvas, label) {
  baseTex?.dispose();
  baseTex = canvas ? new THREE.CanvasTexture(canvas) : null;
  if (baseTex) { baseTex.colorSpace = THREE.SRGBColorSpace; baseTex.anisotropy = 8; }
  if (canvas && label) view.basemap = label;
}

async function switchBasemap(b) {
  view.basemap = b;
  if (BASEMAPS[b]?.url && area?.geo) {
    $('#busy').hidden = false;
    $('#busy').textContent = 'LOADING BASEMAP…';
    const { canvas, failed } = await stitch(BASEMAPS[b].url, area.z, area.tx0, area.ty0, area.G);
    $('#busy').hidden = true;
    if (failed === area.G * area.G) { toast('That basemap is unreachable right now', true); return; }
    setBaseCanvas(canvas, b);
  }
  applyLook();
  renderLayers();
}

/** Re-apply exaggeration: terrain and every overlay are rebuilt from stored data. */
function setExaggeration(x) {
  view.exag = x;
  buildTerrain();
  rebuildLayers();
}

// ---------------------------------------------------------------------------------------------
// Layers (data, buildings, sketches, measurements). Each stores geometry as points and rebuilds.

const layers = [];
let layerSeq = 1;
function addLayer(name, kind, build, extra = {}) {
  const L = { id: layerSeq++, name, kind, visible: true, build, obj: null, ...extra };
  layers.push(L);
  buildLayer(L);
  renderLayers();
  return L;
}
function buildLayer(L) {
  if (L.obj) world.remove(L.obj);
  L.obj = L.build();
  L.obj.name = L.name;
  L.obj.visible = L.visible;
  world.add(L.obj);
}
function rebuildLayers() { layers.forEach(buildLayer); }
function removeLayer(L) { world.remove(L.obj); layers.splice(layers.indexOf(L), 1); renderLayers(); }

const stdMat = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, ...o });

/** A ribbon tube draped over the terrain along area-pixel points. */
function drapedTube(pts, colorHex, radius = 0.018, lift = 0.02) {
  const dense = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 3));
    for (let k = 0; k < n; k++) dense.push(pxToWorld(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, lift));
  }
  dense.push(pxToWorld(...pts[pts.length - 1], lift));
  if (dense.length < 2) return new THREE.Group();
  const curve = new THREE.CatmullRomCurve3(dense, false, 'centripetal', 0);
  const m = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(2000, dense.length * 2), radius, 6), stdMat(colorHex, { emissive: colorHex, emissiveIntensity: 0.35 }));
  m.castShadow = true;
  return m;
}

// Symbols, sized in world units (a 15 m tree would be invisible on a 30 km table).
const SYMBOLS = {
  Pin: (c) => { const g = new THREE.Group(); const cone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.7, 20).rotateX(Math.PI), stdMat(c)); cone.position.y = 0.35; const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 14), stdMat(c, { emissive: c, emissiveIntensity: 0.3 })); head.position.y = 0.85; g.add(cone, head); return g; },
  Tree: () => { const g = new THREE.Group(); const t = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.3, 8), stdMat('#5a3b22')); t.position.y = 0.15; const c1 = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.6, 12), stdMat('#2f6b34')); c1.position.y = 0.5; const c2 = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.45, 12), stdMat('#3c8442')); c2.position.y = 0.8; g.add(t, c1, c2); return g; },
  'Wind turbine': () => { const g = new THREE.Group(); const p = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.06, 1.4, 10), stdMat('#eceff2')); p.position.y = 0.7; const hub = new THREE.Group(); hub.position.set(0, 1.4, 0.06); for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.62, 0.015), stdMat('#f6f7f8')); b.position.y = 0.31; const arm = new THREE.Group(); arm.rotation.z = (i * Math.PI * 2) / 3; arm.add(b); hub.add(arm); } hub.userData.spin = true; g.add(p, hub); return g; },
  Tower: (c) => { const g = new THREE.Group(); const m = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.16, 1.6, 4, 1, true), stdMat('#9aa0a8', { wireframe: true })); m.position.y = 0.8; const top = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), stdMat(c, { emissive: c, emissiveIntensity: 1.5 })); top.position.y = 1.62; g.add(m, top); return g; },
  House: (c) => { const g = new THREE.Group(); const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.4), stdMat('#e9e2d4')); b.position.y = 0.175; const r = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.28, 4).rotateY(Math.PI / 4), stdMat(c)); r.scale.z = 0.8; r.position.y = 0.49; g.add(b, r); return g; },
  Flag: (c) => { const g = new THREE.Group(); const p = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1, 8), stdMat('#ddd')); p.position.y = 0.5; const f = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.25), stdMat(c, { side: THREE.DoubleSide })); f.position.set(0.2, 0.86, 0); g.add(p, f); return g; },
};
function symbolAt(type, pt, c, size = view.symbolSize) {
  const s = SYMBOLS[type](c);
  const [px, py] = ptToPx(pt);
  s.position.copy(pxToWorld(px, py));
  s.scale.setScalar(size);
  s.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return s;
}

function extrudeRing(ringPx, heightM, colorHex, opacity = 1) {
  const pts = ringPx.map(([px, py]) => [(px / area.P - 0.5) * S, (py / area.P - 0.5) * S]);
  let base = Infinity;
  for (const [px, py] of ringPx) base = Math.min(base, yOf(sampleH(px, py)));
  const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.005, heightM * vscale()) + 0.03, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, base - 0.03, 0);
  const m = new THREE.Mesh(g, stdMat(colorHex, { transparent: opacity < 1, opacity }));
  m.castShadow = m.receiveShadow = true;
  return m;
}

// --- OSM buildings
async function addOsmBuildings() {
  if (!area?.geo) return toast('Buildings need a real place, not an uploaded heightmap', true);
  if (area.extentM > 8000) return toast('Zoom in first: buildings load for areas under 8 km across (zoom 14+)', true);
  const [w, n] = pxToLonLat(area.tx0 * TILE, area.ty0 * TILE, area.z);
  const [e, s] = pxToLonLat((area.tx0 + area.G) * TILE, (area.ty0 + area.G) * TILE, area.z);
  $('#busy').hidden = false;
  $('#busy').textContent = 'LOADING OSM BUILDINGS…';
  try {
    const list = await fetchBuildings(s, w, n, e);
    layers.filter((l) => l.kind === 'osm').forEach(removeLayer);
    addLayer(`OSM buildings (${list.length})`, 'osm', () => {
      const geos = [];
      const col = new THREE.Color();
      for (const b of list) {
        const ring = b.ring.map((p) => ptToPx({ lon: p[0], lat: p[1] }));
        const pts = ring.map(([px, py]) => new THREE.Vector2((px / area.P - 0.5) * S, -(py / area.P - 0.5) * S));
        if (pts.length < 3) continue;
        let base = Infinity;
        for (const [px, py] of ring) base = Math.min(base, yOf(sampleH(px, py)));
        const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: b.height * u() + 0.004, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, base - 0.004, 0);
        g.deleteAttribute('uv');
        col.setHSL(0.58 - Math.min(1, b.height / 200) * 0.5, 0.25, 0.55 + Math.min(1, b.height / 300) * 0.25);
        const c = new Float32Array(g.attributes.position.count * 3);
        for (let i = 0; i < c.length; i += 3) { c[i] = col.r; c[i + 1] = col.g; c[i + 2] = col.b; }
        g.setAttribute('color', new THREE.BufferAttribute(c, 3));
        geos.push(g.index ? g.toNonIndexed() : g);
      }
      if (!geos.length) return new THREE.Group();
      const m = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
      m.castShadow = m.receiveShadow = true;
      return m;
    });
    toast(`${list.length} buildings from OpenStreetMap`);
  } catch (e) {
    toast('OSM buildings failed: ' + e.message, true);
  } finally { $('#busy').hidden = true; }
}

// --- GeoJSON / CSV / heightmap / drape
function fitAreaTo(lonlats) {
  let w = 180, e = -180, s = 90, n = -90;
  for (const [lo, la] of lonlats) { w = Math.min(w, lo); e = Math.max(e, lo); s = Math.min(s, la); n = Math.max(n, la); }
  const lat = (s + n) / 2, lon = (w + e) / 2;
  const span = Math.max(((e - w) * Math.PI / 180) * 6378137 * Math.cos(lat * Math.PI / 180), ((n - s) * Math.PI / 180) * 6378137, 800) * 1.3;
  const G = 4;
  const z = Math.floor(Math.log2((G * TILE * metresPerPx(lat, 0)) / span));
  return { lat, lon, z: Math.max(3, Math.min(15, z)), G };
}
function insideArea(lonlats) {
  if (!area?.geo) return false;
  let inside = 0;
  for (const [lo, la] of lonlats) { const [px, py] = ptToPx({ lon: lo, lat: la }); if (px >= 0 && py >= 0 && px <= area.P && py <= area.P) inside++; }
  return inside >= lonlats.length * 0.5;
}

async function addGeoJSON(json, name) {
  const feats = json.type === 'FeatureCollection' ? json.features : json.type === 'Feature' ? [json] : [{ type: 'Feature', geometry: json, properties: {} }];
  const all = [];
  const walk = (c) => (typeof c[0] === 'number' ? all.push(c) : c.forEach(walk));
  feats.forEach((f) => f.geometry && walk(f.geometry.coordinates));
  if (!all.length) return toast('No coordinates in that GeoJSON', true);
  if (!insideArea(all)) await loadArea({ name, ...fitAreaTo(all) });
  const colorHex = ['#ff6a3d', '#ffd23d', '#3dd8ff', '#c08bff', '#59d38c'][layers.length % 5];
  addLayer(name, 'geojson', () => {
    const g = new THREE.Group();
    for (const f of feats) {
      const geom = f.geometry;
      if (!geom) continue;
      const props = f.properties || {};
      const h = parseFloat(props.height ?? props.HEIGHT ?? props.Height) || (parseFloat(props.levels ?? props['building:levels']) || 0) * 3.2 || 30;
      const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
      const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.type === 'MultiLineString' ? geom.coordinates : [];
      const points = geom.type === 'Point' ? [geom.coordinates] : geom.type === 'MultiPoint' ? geom.coordinates : [];
      polys.forEach((p) => { const ring = p[0].map(([lo, la]) => ptToPx({ lon: lo, lat: la })); g.add(extrudeRing(ring, h, colorHex, 0.85)); g.add(drapedTube([...ring, ring[0]], colorHex, 0.008)); });
      lines.forEach((l) => g.add(drapedTube(l.map(([lo, la]) => ptToPx({ lon: lo, lat: la })), colorHex)));
      points.forEach(([lo, la]) => g.add(symbolAt('Pin', { lon: lo, lat: la }, colorHex)));
    }
    return g;
  });
  toast(`${name}: ${feats.length} features`);
}

async function addCSV(text, name) {
  const rows = parseCSV(text);
  const keys = Object.keys(rows[0] || {});
  const latK = keys.find((k) => /^(lat|latitude|y)$/.test(k)), lonK = keys.find((k) => /^(lon|lng|long|longitude|x)$/.test(k));
  if (!latK || !lonK) return toast('CSV needs lat and lon (or latitude / longitude) columns', true);
  const valK = keys.find((k) => k !== latK && k !== lonK && rows.every((r) => r[k] === '' || !isNaN(parseFloat(r[k]))));
  const pts = rows.map((r) => ({ lon: parseFloat(r[lonK]), lat: parseFloat(r[latK]), v: valK ? parseFloat(r[valK]) || 0 : 1, name: r.name || r.title || '' })).filter((p) => isFinite(p.lon) && isFinite(p.lat));
  if (!pts.length) return toast('No valid rows in that CSV', true);
  const ll = pts.map((p) => [p.lon, p.lat]);
  if (!insideArea(ll)) await loadArea({ name, ...fitAreaTo(ll) });
  const vmax = Math.max(...pts.map((p) => Math.abs(p.v)), 1e-6);
  addLayer(`${name}${valK ? ` (${valK})` : ''}`, 'csv', () => {
    const g = new THREE.Group();
    const col = new THREE.Color();
    for (const p of pts) {
      const t = Math.abs(p.v) / vmax;
      const hgt = 0.06 + t * 1.2;
      col.setHSL(0.6 - t * 0.6, 0.85, 0.55);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, hgt, 12).translate(0, hgt / 2, 0), stdMat(col.clone(), { emissive: col.clone(), emissiveIntensity: 0.25 }));
      const [px, py] = ptToPx(p);
      m.position.copy(pxToWorld(px, py));
      m.castShadow = true;
      m.name = p.name || `${p.v}`;
      g.add(m);
    }
    return g;
  });
  toast(`${pts.length} points${valK ? `, column "${valK}" as bar height` : ''}`);
}

function addHeightmap(img, fname) {
  const widthIn = el('input', { class: 'field', type: 'number', value: 10, min: 0.1, step: 0.1 });
  const maxIn = el('input', { class: 'field', type: 'number', value: 1500, min: 1 });
  const { close } = modal('Heightmap', el('div', { style: { display: 'grid', gap: '10px' } },
    el('p', { class: 'hint' }, 'Lighter pixels are higher. How big is the area it covers?'),
    el('label', { class: 'f' }, 'Width (km)', widthIn), el('label', { class: 'f' }, 'Highest point (m)', maxIn)), [
    ['Cancel', (c) => c()],
    ['Build terrain', () => {
      const P = 1024;
      const heights = decodeHeightImage(img, P, parseFloat(maxIn.value) || 1000);
      const [hmin, hmax] = robustRange(heights);
      area = { geo: false, name: fname, P, extentM: (parseFloat(widthIn.value) || 10) * 1000, heights, hmin, hmax, z: 0, tx0: 0, ty0: 0, G: 4 };
      layers.slice().forEach((l) => { if (l.kind === 'osm' || l.kind === 'geojson' || l.kind === 'csv') removeLayer(l); });
      setBaseCanvas(null);
      view.basemap = 'Elevation tint';
      buildTerrain();
      rebuildLayers();
      renderMap(); renderLayers();
      close();
      toast('Heightmap terrain built. Sketch and measure work; lat/lon do not (no georeference).');
    }, 'primary'],
  ]);
}

function drapeImage(img) {
  const c = document.createElement('canvas');
  c.width = c.height = 2048;
  c.getContext('2d').drawImage(img, 0, 0, 2048, 2048);
  setBaseCanvas(c);
  view.basemap = 'Custom image';
  applyLook();
  renderLayers();
  toast('Image draped over the whole area (stretched to fit).');
}

async function importFiles(files) {
  for (const f of files) {
    const ext = f.name.split('.').pop().toLowerCase();
    const name = f.name.replace(/\.[^.]+$/, '');
    try {
      if (ext === 'geojson' || ext === 'json') await addGeoJSON(JSON.parse(await f.text()), name);
      else if (ext === 'csv') await addCSV(await f.text(), name);
      else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
        const img = await readImage(f);
        modal('Use this image as…', el('p', { class: 'hint' }, `${f.name} (${img.width} × ${img.height})`), [
          ['Drape over terrain', (c) => { c(); drapeImage(img); }],
          ['Heightmap (DEM)', (c) => { c(); addHeightmap(img, name); }, 'primary'],
        ]);
      } else toast(`Can't import .${ext}. Try GeoJSON, CSV, or a PNG/JPG.`, true);
    } catch (e) { console.error(e); toast(`${f.name}: ${e.message}`, true); }
  }
}

// ---------------------------------------------------------------------------------------------
// Tools

let tool = 'navigate';
const TOOLS = [['navigate', 'Navigate'], ['identify', 'Identify'], ['measure', 'Measure'], ['los', 'Line of sight'], ['pin', 'Place symbol'], ['polygon', 'Extrude building'], ['path', 'Draw route']];
let draft = []; // area-pixel points of the shape being drawn
const draftGroup = new THREE.Group();
scene.add(draftGroup);
const marker = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
marker.renderOrder = 5;
marker.visible = false;
scene.add(marker);
stage.hideOnSnapshot.push(marker, draftGroup);
let symbolType = 'Pin';
let sketchSeq = 1;

function setTool(t) {
  tool = t;
  draft = [];
  draftGroup.clear();
  $('#stTool').textContent = t.toUpperCase();
  const tips = {
    navigate: 'Drag to orbit, right-drag to pan, wheel to zoom.',
    identify: 'Click the terrain for coordinates, elevation and slope.',
    measure: 'Click points along a path; double-click or Enter to finish. Esc clears.',
    los: 'Click an observer, then a target.',
    pin: `Click to place a ${symbolType}. Pick symbols in the Sketch tab.`,
    polygon: 'Click the footprint corners; double-click or Enter to extrude.',
    path: 'Click along a route; double-click or Enter to finish.',
  };
  $('#stMsg').textContent = tips[t];
  renderTools();
  if (['pin', 'polygon', 'path'].includes(t)) tabTo('right', 'sketch');
  if (['identify', 'measure', 'los'].includes(t)) tabTo('right', 'analysis');
}
function renderTools() {
  $('#tools').replaceChildren(...TOOLS.map(([id, label]) => el('button', { class: 'btn sm' + (tool === id ? ' on' : ''), onclick: () => setTool(id) }, label)));
}
function tabTo(side, tab) { $$(`[data-tabs="${side}"] button`).find((b) => b.dataset.tab === tab)?.click(); }

const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pick(e) {
  if (!terrain) return null;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, cam);
  const hit = ray.intersectObject(terrain, false)[0];
  if (!hit) return null;
  const [px, py] = worldToPx(hit.point);
  return { px, py, point: hit.point, normal: hit.face.normal };
}

function describe(px, py) {
  const h = sampleH(px, py);
  const d = 2, m = mPerPx() * d * 2;
  const sx = (sampleH(px + d, py) - sampleH(px - d, py)) / m, sy = (sampleH(px, py + d) - sampleH(px, py - d)) / m;
  const slope = Math.atan(Math.hypot(sx, sy)) * 180 / Math.PI;
  const aspect = (Math.atan2(sx, -sy) * 180 / Math.PI + 360) % 360;
  const pt = pxToPt(px, py);
  return { h, slope, aspect, pt };
}
const fmtLL = (pt) => (pt.lat != null ? `${Math.abs(pt.lat).toFixed(5)}°${pt.lat >= 0 ? 'N' : 'S'}  ${Math.abs(pt.lon).toFixed(5)}°${pt.lon >= 0 ? 'E' : 'W'}` : `x ${Math.round(pt.px * mPerPx())} m, y ${Math.round(pt.py * mPerPx())} m`);
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

let downAt = null, lastClick = 0;
const cv = renderer.domElement;
cv.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
cv.addEventListener('pointerup', (e) => {
  if (!downAt || e.button !== 0 || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const now = performance.now(), dbl = now - lastClick < 320;
  lastClick = now;
  if (dbl && ['measure', 'polygon', 'path'].includes(tool)) { finishDraft(); return; }
  const p = pick(e);
  if (!p) return;
  clickTool(p);
});
let moveT = 0;
cv.addEventListener('pointermove', (e) => {
  const now = performance.now();
  if (now - moveT < 60 || !area) return;
  moveT = now;
  const p = pick(e);
  if (!p) return;
  const d = describe(p.px, p.py);
  $('#stInfo').textContent = `${fmtLL(d.pt)} · ${Math.round(d.h)} m · slope ${d.slope.toFixed(0)}°`;
  if (draft.length && ['measure', 'polygon', 'path'].includes(tool)) drawDraft([p.px, p.py]);
});
addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  if (e.key === 'Enter') finishDraft();
  if (e.key === 'Escape') { draft = []; draftGroup.clear(); marker.visible = false; }
});

function drawDraft(hover) {
  draftGroup.clear();
  const pts = hover ? [...draft, hover] : draft;
  if (tool === 'polygon' && pts.length > 2) pts.push(pts[0]);
  if (pts.length > 1) draftGroup.add(drapedTube(pts, tool === 'measure' ? '#ffffff' : view.sketchColor, 0.012, 0.03));
  for (const q of draft) { const m = marker.clone(); m.visible = true; m.position.copy(pxToWorld(...q, 0.03)); m.scale.setScalar(0.6); draftGroup.add(m); }
}

let losA = null;
function clickTool(p) {
  marker.visible = true;
  marker.position.copy(p.point);
  if (tool === 'identify') {
    const d = describe(p.px, p.py);
    showReadout(`${fmtLL(d.pt)}\nElevation  ${d.h.toFixed(1)} m\nSlope      ${d.slope.toFixed(1)}°\nAspect     ${d.aspect.toFixed(0)}° (${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d.aspect / 45) % 8]})\n${area.geo ? '' : '(uploaded heightmap: local coordinates)'}`);
  } else if (tool === 'measure' || tool === 'polygon' || tool === 'path') {
    draft.push([p.px, p.py]);
    drawDraft();
    if (tool === 'measure') measureReport(draft, false);
  } else if (tool === 'los') {
    if (!losA) { losA = [p.px, p.py]; $('#stMsg').textContent = 'Observer set. Now click a target.'; return; }
    lineOfSight(losA, [p.px, p.py]);
    losA = null;
  } else if (tool === 'pin') {
    const pt = pxToPt(p.px, p.py), type = symbolType, c = view.sketchColor, size = view.symbolSize;
    addLayer(`${type} ${sketchSeq++}`, 'sketch', () => symbolAt(type, pt, c, size), { pt });
  }
}

function finishDraft() {
  if (tool === 'measure' && draft.length > 1) {
    const pts = draft.map(([px, py]) => pxToPt(px, py));
    const res = measureReport(draft, true);
    addLayer(`Measure ${fmtDist(res.dist)}`, 'measure', () => drapedTube(pts.map(ptToPx), '#ffffff', 0.012));
  } else if (tool === 'polygon' && draft.length > 2) {
    const pts = draft.map(([px, py]) => pxToPt(px, py)), h = view.bldHeight, c = view.sketchColor;
    addLayer(`Building ${sketchSeq++} (${h} m)`, 'sketch', () => extrudeRing(pts.map(ptToPx), h, c));
  } else if (tool === 'path' && draft.length > 1) {
    const pts = draft.map(([px, py]) => pxToPt(px, py)), c = view.sketchColor;
    addLayer(`Route ${sketchSeq++}`, 'sketch', () => drapedTube(pts.map(ptToPx), c, 0.02));
  }
  draft = [];
  draftGroup.clear();
}

// Analysis panel
let readout, profileHost;
function showReadout(text) { readout.textContent = text; }

function measureReport(pts, final) {
  const samples = [];
  let dist = 0, flat = 0, gain = 0, loss = 0;
  const mpp = mPerPx();
  let prev = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const n = Math.max(4, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let k = 0; k <= n; k++) {
      if (i > 0 && k === 0) continue;
      const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n, h = sampleH(x, y);
      if (prev) {
        const dh = (Math.hypot(x - prev[0], y - prev[1])) * mpp;
        flat += dh;
        dist += Math.hypot(dh, h - prev[2]);
        if (h > prev[2]) gain += h - prev[2]; else loss += prev[2] - h;
      }
      samples.push([flat, h]);
      prev = [x, y, h];
    }
  }
  showReadout(`${final ? 'Measured path' : 'Measuring…'}  (${pts.length} points)\nSurface distance  ${fmtDist(dist)}\nMap distance      ${fmtDist(flat)}\nClimb ${Math.round(gain)} m · descent ${Math.round(loss)} m\nHighest ${Math.round(Math.max(...samples.map((s) => s[1])))} m · lowest ${Math.round(Math.min(...samples.map((s) => s[1])))} m`);
  drawProfile(samples);
  return { dist, flat, gain, loss };
}

function drawProfile(samples, losLine = null) {
  if (samples.length < 2) return;
  const W = 300, H = 150, pad = 26;
  const dMax = samples[samples.length - 1][0] || 1;
  let hMin = Math.min(...samples.map((s) => s[1])), hMax = Math.max(...samples.map((s) => s[1]));
  if (losLine) { hMin = Math.min(hMin, losLine[0][1], losLine[1][1]); hMax = Math.max(hMax, losLine[0][1], losLine[1][1]); }
  const span = Math.max(1, hMax - hMin);
  const X = (d) => pad + (d / dMax) * (W - pad - 6), Y = (h) => H - 16 - ((h - hMin) / span) * (H - 28);
  const line = samples.map(([d, h]) => `${X(d).toFixed(1)},${Y(h).toFixed(1)}`).join(' ');
  const area2 = `${X(0)},${H - 16} ${line} ${X(dMax)},${H - 16}`;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `
    <polygon points="${area2}" fill="rgba(53,196,160,.25)"/>
    <polyline points="${line}" fill="none" stroke="#35c4a0" stroke-width="1.6"/>
    ${losLine ? `<line x1="${X(losLine[0][0])}" y1="${Y(losLine[0][1])}" x2="${X(losLine[1][0])}" y2="${Y(losLine[1][1])}" stroke="${losLine.blocked ? '#ff5c5c' : '#59d38c'}" stroke-dasharray="4 3" stroke-width="1.4"/>` : ''}
    <text x="4" y="${Y(hMax) + 4}" fill="#9a9ea8" font-size="9" font-family="monospace">${Math.round(hMax)}</text>
    <text x="4" y="${Y(hMin)}" fill="#9a9ea8" font-size="9" font-family="monospace">${Math.round(hMin)}</text>
    <text x="${W - 6}" y="${H - 3}" fill="#9a9ea8" font-size="9" font-family="monospace" text-anchor="end">${fmtDist(dMax)}</text>
    <text x="${pad}" y="${H - 3}" fill="#9a9ea8" font-size="9" font-family="monospace">0</text>`;
  profileHost.replaceChildren(svg);
}

const losState = { observer: 2, target: 2 };
function lineOfSight(a, b) {
  const n = Math.max(20, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 1.5));
  const ha = sampleH(...a) + losState.observer, hb = sampleH(...b) + losState.target;
  const samples = [];
  let blockedAt = -1;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) * mPerPx();
  for (let k = 0; k <= n; k++) {
    const t = k / n, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
    const h = sampleH(x, y), sight = ha + (hb - ha) * t;
    samples.push([t * len, h]);
    if (blockedAt < 0 && k > 0 && k < n && h > sight) blockedAt = t;
  }
  const blocked = blockedAt >= 0;
  const ptA = pxToPt(...a), ptB = pxToPt(...b);
  addLayer(`Line of sight ${blocked ? '(blocked)' : '(clear)'}`, 'measure', () => {
    // Rebuild from stored points so exaggeration changes keep it on the ground.
    const [ax, ay] = ptToPx(ptA), [bx, by] = ptToPx(ptB);
    const P0 = pxToWorld(ax, ay), P1 = pxToWorld(bx, by);
    P0.y = yOf(sampleH(ax, ay) + losState.observer); P1.y = yOf(sampleH(bx, by) + losState.target);
    const gg = new THREE.Group();
    const segB = (p, q, c) => { const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, p.distanceTo(q), 8), new THREE.MeshBasicMaterial({ color: c })); cyl.position.copy(p).add(q).multiplyScalar(0.5); cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), q.clone().sub(p).normalize()); gg.add(cyl); };
    if (blocked) { const M = P0.clone().lerp(P1, blockedAt); segB(P0, M, 0x59d38c); segB(M, P1, 0xff5c5c); } else segB(P0, P1, 0x59d38c);
    return gg;
  });
  showReadout(`Line of sight: ${blocked ? 'BLOCKED' : 'CLEAR'}\nDistance  ${fmtDist(len)}\nObserver  ${Math.round(ha)} m (${losState.observer} m above ground)\nTarget    ${Math.round(hb)} m (${losState.target} m above ground)${blocked ? `\nTerrain blocks it ${fmtDist(blockedAt * len)} from the observer` : ''}`);
  const line = [[0, ha], [len, hb]];
  line.blocked = blocked;
  drawProfile(samples, line);
}

// ---------------------------------------------------------------------------------------------
// Panels

wireTabs();
wireSections();
const section = (title, ...rows) => el('section', { class: 'section' }, el('h3', {}, title), el('div', { class: 'body' }, rows));

function renderMap() {
  const lat = el('input', { type: 'number', step: 0.0001, value: area?.lat?.toFixed(4) ?? '' });
  const lon = el('input', { type: 'number', step: 0.0001, value: area?.lon?.toFixed(4) ?? '' });
  const zoom = el('input', { type: 'number', min: 3, max: 15, value: area?.z || 12 });
  const size = el('select', {}, ...[[3, '3 × 3 tiles'], [4, '4 × 4 tiles'], [5, '5 × 5 tiles'], [6, '6 × 6 tiles']].map(([v, t]) => el('option', { value: v, selected: v === (area?.G || 4) }, t)));
  $('#mapPane').replaceChildren(
    section('Places', el('div', { class: 'places' }, ...PLACES.map((p) => el('button', { class: 'btn' + (area?.name === p.name ? ' on' : ''), onclick: () => loadArea(p) }, p.name)))),
    section('Go to coordinates',
      el('div', { class: 'row' }, el('label', {}, 'Latitude'), lat, el('span')),
      el('div', { class: 'row' }, el('label', {}, 'Longitude'), lon, el('span')),
      el('div', { class: 'row' }, el('label', {}, 'Zoom (3–15)'), zoom, el('span')),
      el('div', { class: 'row' }, el('label', {}, 'Area'), size, el('span')),
      el('div', { class: 'btn-row tight', style: { marginTop: '6px' } }, el('button', { class: 'btn sm', onclick: () => {
        const la = parseFloat(lat.value), lo = parseFloat(lon.value);
        if (!isFinite(la) || !isFinite(lo)) return toast('Enter a latitude and longitude', true);
        loadArea({ name: `${la.toFixed(3)}, ${lo.toFixed(3)}`, lat: la, lon: lo, z: +zoom.value, G: +size.value });
      } }, 'Load area'),
      el('button', { class: 'btn sm', onclick: () => {
        if (!navigator.geolocation) return toast('No location available', true);
        navigator.geolocation.getCurrentPosition((p) => loadArea({ name: 'My location', lat: p.coords.latitude, lon: p.coords.longitude, z: 13 }), () => toast('Location was not allowed', true));
      } }, 'My location')),
      el('p', { class: 'hint' }, area ? `${area.name} · ${(area.extentM / 1000).toFixed(1)} km across · ${Math.round(area.hmin)}–${Math.round(area.hmax)} m` : '')),
    section('Terrain',
      slider('Exaggeration', { min: 0.5, max: 5, step: 0.1, value: view.exag, unit: '×' }, (v) => { clearTimeout(renderMap.t); renderMap.t = setTimeout(() => setExaggeration(v), 150); }).row,
      slider('Sun azimuth', { min: 0, max: 360, step: 1, value: view.sunAz, unit: '°' }, (v) => { view.sunAz = v; placeSun(); }).row,
      slider('Sun altitude', { min: 3, max: 90, step: 1, value: view.sunAlt, unit: '°' }, (v) => { view.sunAlt = v; placeSun(); }).row,
      color('Backdrop', '#' + scene.background.getHexString(), (v) => scene.background.set(v)).row),
  );
}

function renderLayers() {
  const sysRow = (name, on, fn, extra) => el('div', { class: 'item' + (on ? '' : ' off'), onclick: () => fn(!on) },
    el('span', { class: 'eye' }, on ? '◉' : '○'), el('span', { class: 'name' }, name), extra ? el('span', { class: 'meta' }, extra) : null);
  $('#layersPane').replaceChildren(
    section('Basemap',
      el('div', { class: 'seg' }, ...[...Object.keys(BASEMAPS), ...(view.basemap === 'Custom image' ? ['Custom image'] : [])].map((b) => el('button', { class: 'btn sm' + (view.basemap === b ? ' on' : ''), onclick: () => switchBasemap(b) }, b)))),
    section('Surface analysis',
      el('div', { class: 'list' },
        sysRow('Contours', view.contours, (v) => { view.contours = v; applyLook(); renderLayers(); }, `${view.contourStep} m`),
        sysRow('Elevation tint', view.tint > 0, (v) => { view.tint = v ? 0.6 : 0; applyLook(); renderLayers(); }),
        sysRow('Water level', view.water, (v) => { view.water = v; placeWater(); renderLayers(); }, `${view.waterLevel} m`)),
      slider('Contour step', { min: 5, max: 500, step: 5, value: view.contourStep, unit: ' m' }, (v) => { view.contourStep = v; applyLook(); }).row,
      slider('Tint', { min: 0, max: 1, step: 0.05, value: view.tint }, (v) => { view.tint = v; applyLook(); }).row,
      area ? slider('Water level', { min: Math.floor(area.hmin), max: Math.ceil(area.hmax), step: 1, value: view.waterLevel, unit: ' m' }, (v) => { view.waterLevel = v; view.water = true; placeWater(); }).row : null,
      el('div', { class: 'legend-ramp', style: { marginTop: '6px' } }),
      el('div', { class: 'row', style: { gridTemplateColumns: '1fr 1fr' } }, el('span', { class: 'hint' }, area ? `${Math.round(area.hmin)} m` : ''), el('span', { class: 'hint', style: { textAlign: 'right' } }, area ? `${Math.round(area.hmax)} m` : ''))),
    section('Operational layers',
      el('div', { class: 'list' }, ...layers.map((L) => el('div', { class: 'item' + (L.visible ? '' : ' off') },
        el('span', { class: 'eye', onclick: () => { L.visible = !L.visible; L.obj.visible = L.visible; renderLayers(); } }, L.visible ? '◉' : '○'),
        el('span', { class: 'name', onclick: () => stage.frame(L.obj, [0, 0.9, 1]) }, L.name),
        el('span', { class: 'meta' }, L.kind),
        el('span', { class: 'x', title: 'Remove', onclick: () => removeLayer(L) }, '✕')))),
      layers.length ? null : el('p', { class: 'hint' }, 'Add GeoJSON or CSV with "Add data", load buildings, or sketch with the tools.'),
      el('div', { class: 'btn-row tight', style: { marginTop: '6px' } },
        el('button', { class: 'btn sm', onclick: addOsmBuildings }, 'Add OSM buildings'),
        el('button', { class: 'btn sm', onclick: async () => importFiles(await pickFiles('.geojson,.json,.csv,.png,.jpg,.jpeg,.webp', true)) }, 'Add data…'),
        el('button', { class: 'btn sm', onclick: sampleData }, 'Sample data'))),
  );
  if (readout) renderSketch(); // keep the Sketch tab's list in step
}

function renderAnalysis() {
  readout = el('div', { class: 'readout' }, 'Pick Identify, Measure or Line of sight, then click the terrain.');
  profileHost = el('div', { class: 'profile' }, el('p', { class: 'hint' }, 'The elevation profile of a measured path or sight line appears here.'));
  $('#analysisPane').replaceChildren(
    section('Result', readout),
    section('Elevation profile', profileHost),
    section('Line of sight',
      slider('Observer height', { min: 0, max: 200, step: 1, value: losState.observer, unit: ' m' }, (v) => (losState.observer = v)).row,
      slider('Target height', { min: 0, max: 200, step: 1, value: losState.target, unit: ' m' }, (v) => (losState.target = v)).row),
  );
}

function renderSketch() {
  $('#sketchPane').replaceChildren(
    section('Symbols',
      el('div', { class: 'seg' }, ...Object.keys(SYMBOLS).map((k) => el('button', { class: 'btn sm' + (symbolType === k ? ' on' : ''), onclick: () => { symbolType = k; setTool('pin'); renderSketch(); } }, k))),
      slider('Symbol size', { min: 0.05, max: 0.6, step: 0.01, value: view.symbolSize }, (v) => (view.symbolSize = v)).row),
    section('Shapes',
      el('div', { class: 'btn-row tight' },
        el('button', { class: 'btn sm', onclick: () => setTool('polygon') }, 'Extrude building'),
        el('button', { class: 'btn sm', onclick: () => setTool('path') }, 'Draw route')),
      slider('Building height', { min: 5, max: 800, step: 5, value: view.bldHeight, unit: ' m' }, (v) => (view.bldHeight = v)).row,
      color('Colour', view.sketchColor, (v) => (view.sketchColor = v)).row),
    section('Sketches',
      el('div', { class: 'list' }, ...layers.filter((l) => l.kind === 'sketch').map((L) => el('div', { class: 'item' }, el('span', { class: 'name' }, L.name), el('span', { class: 'x', onclick: () => { removeLayer(L); renderSketch(); } }, '✕')))),
      el('div', { class: 'btn-row tight', style: { marginTop: '6px' } }, el('button', { class: 'btn sm', onclick: () => { layers.filter((l) => l.kind === 'sketch' || l.kind === 'measure').forEach(removeLayer); renderSketch(); } }, 'Clear sketches & measurements'))),
  );
}

// A built-in sample: a hiking route and summit points for whatever place is loaded.
function sampleData() {
  if (!area) return;
  const P = area.P, H = area.heights;
  // the three highest points, spaced apart
  const peaks = [];
  const step = Math.max(4, P / 64);
  const cand = [];
  for (let y = step; y < P - step; y += step) for (let x = step; x < P - step; x += step) cand.push([x, y, H[Math.floor(y) * P + Math.floor(x)]]);
  cand.sort((a, b) => b[2] - a[2]);
  for (const c of cand) { if (peaks.every((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) > P / 6)) peaks.push(c); if (peaks.length === 3) break; }
  const feats = peaks.map((p, i) => { const pt = pxToPt(p[0], p[1]); return { type: 'Feature', properties: { name: `Summit ${i + 1}`, elevation: Math.round(p[2]) }, geometry: { type: 'Point', coordinates: [pt.lon ?? 0, pt.lat ?? 0] } }; });
  if (!area.geo) { peaks.forEach((p) => addLayer(`Summit ${Math.round(p[2])} m`, 'sketch', () => symbolAt('Flag', { px: p[0], py: p[1] }, '#ffd23d'))); return; }
  const start = pxToPt(P * 0.15, P * 0.85), mid = pxToPt(peaks[0][0], peaks[0][1]);
  feats.push({ type: 'Feature', properties: { name: 'Sample route' }, geometry: { type: 'LineString', coordinates: [[start.lon, start.lat], [(start.lon + mid.lon) / 2 + 0.002, (start.lat + mid.lat) / 2], [mid.lon, mid.lat]] } });
  addGeoJSON({ type: 'FeatureCollection', features: feats }, 'Sample summits & route');
}

// Compass
const compass = $('#compass');
compass.onclick = () => {
  const d = cam.position.distanceTo(controls.target), t = controls.target;
  stage.flyTo([t.x, t.y + d * 0.6, t.z + d * 0.8], [t.x, t.y, t.z]);
};

// ---------------------------------------------------------------------------------------------
// Export / push

async function buildExport() {
  marker.visible = false;
  const glb = await exportGLB(world);
  return { glb, meta: { place: area.name, lat: area.lat, lon: area.lon, zoom: area.z, extentKm: +(area.extentM / 1000).toFixed(2), exaggeration: view.exag, basemap: view.basemap, layers: layers.map((l) => l.name) } };
}
$('#btnUpload').onclick = async () => importFiles(await pickFiles('.geojson,.json,.csv,.png,.jpg,.jpeg,.webp', true));
onDrop(document.body, $('#vp'), importFiles, 'Drop GeoJSON, CSV or an image');
$('#btnGlb').onclick = async () => download((await buildExport()).glb, `terra-${slug(area.name)}.glb`);
$('#btnShot').onclick = async () => download(await stage.snapshot(3840, 'image/png'), `terra-${slug(area.name)}.png`);
$('#btnPush').onclick = () => {
  if (!area) return;
  pushDialog({ app: 'terra', defaultName: `${area.name} terrain`, thumb: stage.snapshot(), build: buildExport, notesHint: 'e.g. "Ridge route recon with sight lines"' });
};

// ---------------------------------------------------------------------------------------------
// Boot

stage.onTick = (dt, t) => {
  const az = Math.atan2(cam.position.x - controls.target.x, cam.position.z - controls.target.z);
  compass.querySelector('i').style.rotate = `${(az * 180) / Math.PI}deg`;
  world.traverse((o) => { if (o.userData.spin) o.rotation.z = t * 2.2; });
};
renderTools();
renderAnalysis();
renderSketch();
renderLayers();
renderMap();
setTool('navigate');
wireDepthChip(stage, $('#chip'));
stage.start();
const qs = new URLSearchParams(location.search);
const start = PLACES.find((p) => p.name.toLowerCase().replace(/\W+/g, '-') === qs.get('place')) ?? PLACES[0];
loadArea(start);
window.terra = { stage, loadArea, layers, addGeoJSON, addCSV, setTool, view, setExaggeration, switchBasemap, addOsmBuildings, sampleData, lineOfSight, measureReport, get area() { return area; } };
