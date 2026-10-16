// "Push to DisplayXR HQ": creations go into an IndexedDB store shared by every page on the
// joehillthunder.github.io origin, so the HQ homepage's Creator Gallery (and the viewer here) can
// list and open them. A BroadcastChannel tells any open HQ tab to refresh.
//
// Record: { id, app, appName, name, notes, created, thumb (data URL), glb (Blob), size, meta }

const DB = 'displayxr-hq';
const STORE = 'creations';
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('displayxr-hq') : null;

export const APPS = {
  material: { name: 'Material Forge', path: 'material/' },
  vehicle: { name: 'Vehicle Studio', path: 'vehicle/' },
  terra: { name: 'Terra Studio', path: 'terra/' },
};

let dbp;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' }).createIndex('created', 'created');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  }));
}

export async function pushToHQ({ app, name, notes = '', thumb, glb, meta = {} }) {
  const rec = {
    id: `${app}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    app,
    appName: APPS[app]?.name ?? app,
    name: name || 'Untitled',
    notes,
    created: Date.now(),
    thumb,
    glb,
    size: glb?.size ?? 0,
    meta,
  };
  await tx('readwrite', (s) => s.put(rec));
  channel?.postMessage({ type: 'pushed', id: rec.id, app });
  return rec;
}

export async function listCreations() {
  const all = await tx('readonly', (s) => s.getAll());
  return all.sort((a, b) => b.created - a.created);
}

export const getCreation = (id) => tx('readonly', (s) => s.get(id));

export async function deleteCreation(id) {
  await tx('readwrite', (s) => s.delete(id));
  channel?.postMessage({ type: 'deleted', id });
}

export function onHQChange(fn) {
  channel?.addEventListener('message', fn);
}

/** Root of the hub site: HQ lives at the origin root on GitHub Pages. */
export const HQ_URL = location.hostname.endsWith('github.io') ? `${location.origin}/#creator-gallery` : 'https://joehillthunder.github.io/#creator-gallery';
export const sameOriginAsHQ = location.hostname === 'joehillthunder.github.io';

/** Base URL of this repo (works served from a sub-path or from localhost root). */
export const HUB_BASE = new URL('../', import.meta.url).href;
