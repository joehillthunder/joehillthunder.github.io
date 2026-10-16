// HQ Viewer: browse every creation pushed to DisplayXR HQ (the shared IndexedDB store) and look at
// it in glasses-free 3D. ?id=<creation id> opens one directly; the HQ homepage links here.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Stage, wireDepthChip } from '../shared/stage.js';
import { $, el, toast, download, slug } from '../shared/ui.js';
import { listCreations, getCreation, deleteCreation, onHQChange, HQ_URL } from '../shared/hq.js';

const stage = new Stage($('#stage'), { fov: 35, tag: 'hq-viewer' });
const { scene, renderer, controls } = stage;
scene.background = new THREE.Color('#15181e');
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture;
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(4, 8, 5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8 });
scene.add(key);
const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 64), new THREE.ShadowMaterial({ opacity: 0.35 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const holder = new THREE.Group();
scene.add(holder);
$('#btnHQ').href = HQ_URL;

let current = null, spin = false;
const ICON = { material: 'Material Forge', vehicle: 'Vehicle Studio', terra: 'Terra Studio' };

async function renderList() {
  const items = await listCreations().catch(() => []);
  const id = current?.id ?? new URLSearchParams(location.search).get('id');
  $('#gal').replaceChildren(...(items.length ? items.map((c) => el('div', { class: 'c' + (c.id === id ? ' sel' : ''), onclick: () => open(c.id) },
    el('img', { src: c.thumb, alt: '' }),
    el('div', {}, el('b', {}, c.name), el('small', {}, ICON[c.app] ?? c.appName), el('small', {}, new Date(c.created).toLocaleString()))))
    : [el('div', { class: 'empty' }, 'Nothing pushed yet. Open Material Forge, Vehicle Studio or Terra Studio and press Push to HQ.')]));
  return items;
}

async function open(id) {
  const c = await getCreation(id);
  if (!c) return toast('That creation is not in this browser', true);
  current = c;
  history.replaceState(null, '', `?id=${encodeURIComponent(id)}`);
  $('#busy').hidden = false;
  try {
    const gltf = await new GLTFLoader().parseAsync(await c.glb.arrayBuffer(), '');
    holder.clear();
    gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
    holder.add(gltf.scene);
    holder.rotation.y = 0;
    // Sit it on the floor.
    const box = new THREE.Box3().setFromObject(gltf.scene);
    gltf.scene.position.y -= box.min.y;
    floor.position.y = 0;
    stage.frame(holder, [1, 0.6, 1.3]);
  } catch (e) {
    console.error(e);
    toast('Could not open it: ' + e.message, true);
  } finally { $('#busy').hidden = true; }
  $('#btnDl').disabled = $('#btnDel').disabled = false;
  const d = $('#details');
  d.hidden = false;
  d.replaceChildren(el('b', {}, c.name), el('div', { class: 'hint' }, `${ICON[c.app] ?? c.appName} · ${(c.size / 1e6).toFixed(1)} MB`), ...(c.notes ? [el('p', {}, c.notes)] : []), el('pre', {}, JSON.stringify(c.meta, null, 1)));
  $('#stMsg').textContent = `${c.name} · drag to orbit, wheel to zoom`;
  renderList();
}

$('#btnDl').onclick = () => current && download(current.glb, slug(current.name) + '.glb');
$('#btnDel').onclick = async () => {
  if (!current) return;
  await deleteCreation(current.id);
  toast(`Removed "${current.name}" from HQ`);
  current = null;
  holder.clear();
  history.replaceState(null, '', location.pathname);
  $('#details').hidden = true;
  $('#btnDl').disabled = $('#btnDel').disabled = true;
  renderList();
};
$('#btnSpin').onclick = (e) => { spin = !spin; e.target.classList.toggle('on', spin); };
$('#btnFrame').onclick = () => stage.frame(holder, [1, 0.6, 1.3]);
stage.onTick = (dt) => { if (spin) holder.rotation.y += dt * 0.4; };
onHQChange(() => renderList());

wireDepthChip(stage, $('#chip'));
stage.start();
const items = await renderList();
const want = new URLSearchParams(location.search).get('id') ?? items[0]?.id;
if (want) open(want);
window.viewer = { stage, open };
