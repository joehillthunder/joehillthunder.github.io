// Small DOM helpers shared by the three tools: panel rows, toasts, modals, file picking and drop,
// GLB export/import, and the "Push to DisplayXR HQ" dialog.

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { pushToHQ, HQ_URL, HUB_BASE, sameOriginAsHQ } from './hq.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e[k] = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}

/** Collapsible sections: clicking an h3 toggles its section. */
export function wireSections(root = document) {
  root.addEventListener('click', (e) => {
    const h = e.target.closest('.section > h3');
    if (h && !e.target.closest('.act')) h.parentElement.classList.toggle('closed');
  });
}

/** Tab strips: <div class="tabs" data-tabs="x"><button data-tab="a">; sibling panes carry data-pane="a". */
export function wireTabs(root = document) {
  $$('.tabs[data-tabs]', root).forEach((strip) => {
    strip.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (!b) return;
      $$('button', strip).forEach((x) => x.classList.toggle('on', x === b));
      $$(':scope > [data-pane]', strip.parentElement).forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
    });
  });
}

const fmt = (v, step) => (step >= 1 ? String(Math.round(v)) : step >= 0.1 ? v.toFixed(1) : v.toFixed(2));

/** A labelled slider row. onInput(value) fires live. Returns { row, set(v) }. */
export function slider(label, { min = 0, max = 1, step = 0.01, value = 0, unit = '' }, onInput) {
  const input = el('input', { type: 'range', min, max, step, value });
  const out = el('output', {}, fmt(value, step) + unit);
  input.oninput = () => {
    const v = parseFloat(input.value);
    out.textContent = fmt(v, step) + unit;
    onInput(v);
  };
  const row = el('div', { class: 'row' }, el('label', { title: label }, label), input, out);
  return { row, input, set(v) { input.value = v; out.textContent = fmt(+v, step) + unit; } };
}

export function select(label, options, value, onChange) {
  const s = el('select', {}, options.map((o) => {
    const [v, t] = Array.isArray(o) ? o : [o, o];
    return el('option', { value: v, selected: v === value }, t);
  }));
  s.onchange = () => onChange(s.value);
  return { row: el('div', { class: 'row' }, el('label', {}, label), s, el('span')), input: s };
}

export function color(label, value, onInput) {
  const c = el('input', { type: 'color', value });
  c.oninput = () => onInput(c.value);
  return { row: el('div', { class: 'row' }, el('label', {}, label), c, el('span')), input: c };
}

export function toggle(label, value, onChange) {
  const c = el('input', { type: 'checkbox', checked: value });
  c.onchange = () => onChange(c.checked);
  return { row: el('div', { class: 'row' }, el('label', {}, label), el('span', {}, c), el('span')), input: c };
}

let toastTimer;
export function toast(msg, bad = false, ms = 2600) {
  $('.toast')?.remove();
  const t = el('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

export function modal(title, content, buttons = []) {
  const back = el('div', { class: 'modal-back' });
  const close = () => back.remove();
  const foot = el('footer', {}, buttons.map(([label, fn, cls = '']) => el('button', { class: 'btn ' + cls, onclick: () => fn(close) }, label)));
  back.append(el('div', { class: 'modal' },
    el('header', {}, el('h2', {}, title), el('button', { class: 'btn icon sm', onclick: close, 'aria-label': 'Close' }, '✕')),
    el('div', { class: 'content' }, content), foot));
  back.onclick = (e) => { if (e.target === back) close(); };
  document.body.append(back);
  return { back, close, foot };
}

export function pickFiles(accept, multiple = false) {
  return new Promise((resolve) => {
    const i = el('input', { type: 'file', accept, multiple });
    i.onchange = () => resolve([...i.files]);
    i.click();
  });
}

/** Drop files anywhere on `target`; shows a hint overlay inside `overlayHost`. */
export function onDrop(target, overlayHost, fn, text = 'Drop to import') {
  let hint;
  target.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!hint) { hint = el('div', { class: 'drop-hint' }, text); overlayHost.append(hint); }
  });
  target.addEventListener('dragleave', (e) => {
    if (e.target === target || !target.contains(e.relatedTarget)) { hint?.remove(); hint = null; }
  });
  target.addEventListener('drop', (e) => {
    e.preventDefault();
    hint?.remove(); hint = null;
    if (e.dataTransfer.files.length) fn([...e.dataTransfer.files]);
  });
}

export function download(blobOrUrl, filename) {
  const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const slug = (s) => (s || 'creation').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'creation';

/** Binary glTF of an object, as a Blob. */
export async function exportGLB(object) {
  const buf = await new GLTFExporter().parseAsync(object, { binary: true, onlyVisible: true, maxTextureSize: 2048 });
  return new Blob([buf], { type: 'model/gltf-binary' });
}

/** Load a 3D model file (GLB, GLTF with embedded data, OBJ, STL) into an Object3D. */
export async function loadModelFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'glb' || ext === 'gltf') {
    const data = ext === 'glb' ? await file.arrayBuffer() : await file.text();
    const gltf = await new GLTFLoader().parseAsync(data, '');
    return gltf.scene;
  }
  if (ext === 'obj') {
    const obj = new OBJLoader().parse(await file.text());
    obj.traverse((o) => { if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.6 }); });
    return obj;
  }
  if (ext === 'stl') {
    const geo = new STLLoader().parse(await file.arrayBuffer());
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.5 }));
  }
  throw new Error(`Unsupported model type .${ext}`);
}

/** Normalise an imported model: centred on x/z, sitting on y = 0, longest side `size`. */
export function fitObject(obj, size = 1.6) {
  const box = new THREE.Box3().setFromObject(obj);
  const dims = box.getSize(new THREE.Vector3());
  const s = size / Math.max(dims.x, dims.y, dims.z, 1e-6);
  obj.scale.multiplyScalar(s);
  box.setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  obj.position.x -= c.x;
  obj.position.z -= c.z;
  obj.position.y -= box.min.y;
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return obj;
}

export function readImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = url;
  });
}

const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');

/**
 * The Push dialog. `build()` returns { glb: Blob, meta } and is called when the user confirms,
 * so the export reflects the scene at that moment. `thumb` is a data URL.
 */
export function pushDialog({ app, defaultName, thumb, build, notesHint = '' }) {
  const name = el('input', { class: 'field', value: defaultName, maxlength: 60 });
  const notes = el('textarea', { class: 'field', placeholder: notesHint || 'What is it? (optional)' });
  const status = el('div', { class: 'hint' },
    sameOriginAsHQ
      ? 'Goes to the Creator Gallery on the DisplayXR HQ homepage, on this PC and browser.'
      : 'Saved in this browser. The HQ gallery shows it when this tool is opened from joehillthunder.github.io.');
  const content = el('div', { style: { display: 'grid', gap: '10px' } },
    el('img', { class: 'thumb', src: thumb, alt: 'Preview' }),
    el('label', { class: 'f' }, 'Name', name),
    el('label', { class: 'f' }, 'Notes', notes),
    status);
  const m = modal('Push to DisplayXR HQ', content, [
    ['Download .glb', async () => {
      const { glb } = await build();
      download(glb, slug(name.value) + '.glb');
    }],
    ['Push to HQ', async () => {
      const btn = m.foot.lastChild;
      btn.disabled = true;
      btn.textContent = 'Exporting…';
      try {
        const { glb, meta } = await build();
        const rec = await pushToHQ({ app, name: name.value.trim(), notes: notes.value.trim(), thumb, glb, meta });
        status.className = 'hint ok';
        status.textContent = `Pushed "${rec.name}" (${fmtSize(rec.size)}) to the DisplayXR HQ Creator Gallery.`;
        m.foot.replaceChildren(
          el('a', { class: 'btn', href: `${HUB_BASE}view/?id=${encodeURIComponent(rec.id)}`, target: '_blank' }, 'View in 3D'),
          el('a', { class: 'btn', href: HQ_URL, target: '_blank' }, 'Open HQ'),
          el('button', { class: 'btn primary', onclick: m.close }, 'Done'));
      } catch (e) {
        console.error(e);
        status.className = 'hint';
        status.style.color = 'var(--bad)';
        status.textContent = 'Push failed: ' + (e.message || e);
        btn.disabled = false;
        btn.textContent = 'Push to HQ';
      }
    }, 'primary'],
  ]);
  name.focus();
  name.select();
}
