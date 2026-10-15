// Shared 3D parts for the map, the substation twin and the microgrid yard: textured materials,
// lattice steel, porcelain with sheds, chain-link fence, signs. Everything is procedural.

import * as TX from './textures.js';

export class Kit {
  constructor(THREE, root) {
    this.THREE = THREE;
    this.root = root;
    this.pickables = [];
    this.mats = new Map();
    this.geos = new Map();
  }

  // Cached MeshStandardMaterial. `unique: true` returns a fresh one (for per-object live state).
  mat(key, make) {
    if (!this.mats.has(key)) this.mats.set(key, make());
    return this.mats.get(key);
  }
  std(color, o = {}) {
    const { unique, ...rest } = o;
    const make = () => new this.THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1, ...rest });
    return unique ? make() : this.mat('std' + color + JSON.stringify(rest, (k, v) => (v && v.isTexture ? v.uuid : v)), make);
  }
  // Common surfaces, each a textured material sized for `repeat` tiles.
  surface(name, repeat = [1, 1], extra = {}) {
    const key = `surf:${name}:${repeat}:${JSON.stringify(extra)}`;
    return this.mat(key, () => {
      const T = this.THREE;
      const rep = (t) => { const c = t.clone(); c.repeat.set(repeat[0], repeat[1]); c.needsUpdate = true; return c; };
      switch (name) {
        case 'grass': return new T.MeshStandardMaterial({ map: rep(TX.grass()), roughness: 0.95, ...extra });
        case 'soil': return new T.MeshStandardMaterial({ map: rep(TX.soil()), roughness: 1, ...extra });
        case 'gravel': return new T.MeshStandardMaterial({ map: rep(TX.gravel()), roughness: 1, ...extra });
        case 'concrete': return new T.MeshStandardMaterial({ map: rep(TX.concrete()), roughness: 0.9, ...extra });
        case 'water': return new T.MeshStandardMaterial({ map: rep(TX.water()), roughness: 0.15, metalness: 0.1, ...extra });
        case 'crops': return new T.MeshStandardMaterial({ map: rep(TX.crops()), roughness: 1, ...extra });
        case 'wood': return new T.MeshStandardMaterial({ map: rep(TX.wood()), roughness: 0.9, ...extra });
        case 'galv': return new T.MeshStandardMaterial({ map: rep(TX.galvanized()), roughness: 0.45, metalness: 0.75, ...extra });
        case 'shingles': return new T.MeshStandardMaterial({ map: rep(TX.shingles()), roughness: 0.95, ...extra });
        case 'flatroof': return new T.MeshStandardMaterial({ map: rep(TX.flatRoof()), roughness: 0.95, ...extra });
        case 'road': return new T.MeshStandardMaterial({ map: rep(TX.road()), roughness: 0.9, polygonOffset: true,
          polygonOffsetFactor: -2, polygonOffsetUnits: -2, ...extra });
        case 'pv': return new T.MeshStandardMaterial({ map: rep(TX.pvCells()), roughness: 0.25, metalness: 0.5, ...extra });
        case 'chain': return new T.MeshStandardMaterial({ map: rep(TX.chainLink()), alphaTest: 0.4, side: T.DoubleSide,
          roughness: 0.5, metalness: 0.6, ...extra });
        default: throw new Error('unknown surface ' + name);
      }
    });
  }
  painted(base, repeat = [1, 1], o = {}) {
    return this.mat(`paint:${base}:${repeat}:${JSON.stringify(o)}`, () => {
      const t = TX.paint(base).clone();
      t.repeat.set(repeat[0], repeat[1]);
      t.needsUpdate = true;
      return new this.THREE.MeshStandardMaterial({ map: t, roughness: 0.55, metalness: 0.35, ...o });
    });
  }
  corrugated(base, repeat = [1, 1]) {
    return this.mat(`corr:${base}:${repeat}`, () => {
      const { map, bump } = TX.corrugated(base);
      const m = map.clone(), b = bump.clone();
      for (const t of [m, b]) { t.repeat.set(repeat[0], repeat[1]); t.needsUpdate = true; }
      return new this.THREE.MeshStandardMaterial({ map: m, bumpMap: b, bumpScale: 0.6, roughness: 0.55, metalness: 0.4 });
    });
  }
  // A plain texture on a flat material (signs, plates, rack fronts).
  decal(texture, o = {}) {
    return this.mat('decal' + texture.uuid + JSON.stringify(o), () =>
      new this.THREE.MeshStandardMaterial({ map: texture, roughness: 0.6, metalness: 0.1, ...o }));
  }

  // ---- primitives -------------------------------------------------------------------------------
  pick(obj, item) {
    if (item) { obj.userData.item = item; this.pickables.push(obj); }
    return obj;
  }
  box(w, h, d, m, x, y, z, item, parent = this.root) {
    const o = new this.THREE.Mesh(this._geo('box', w, h, d), m);
    o.position.set(x, y, z);
    parent.add(o);
    return this.pick(o, item);
  }
  cyl(rt, rb, h, m, x, y, z, item, parent = this.root, seg = 16) {
    const o = new this.THREE.Mesh(this._geo('cyl', rt, rb, h, seg), m);
    o.position.set(x, y, z);
    parent.add(o);
    return this.pick(o, item);
  }
  _geo(kind, ...a) {
    const key = kind + a.join(',');
    if (!this.geos.has(key)) {
      const T = this.THREE;
      this.geos.set(key, kind === 'box' ? new T.BoxGeometry(...a) : new T.CylinderGeometry(...a));
    }
    return this.geos.get(key);
  }

  // A thin member between two points (lattice legs, braces, crossarms, jumpers).
  strut(a, b, t, m, item, parent = this.root) {
    const T = this.THREE;
    const A = a.isVector3 ? a : new T.Vector3(...a), B = b.isVector3 ? b : new T.Vector3(...b);
    const len = A.distanceTo(B);
    const o = new T.Mesh(this._geo('box', t, len, t), m);
    o.position.copy(A).add(B).multiplyScalar(0.5);
    o.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    parent.add(o);
    return this.pick(o, item);
  }

  // A square lattice tower/column: 4 legs tapering from `base` to `top` half-width, X-braced.
  lattice(x, z, h, base, top, m, item, parent = this.root, levels = 4, t = 0.004) {
    const T = this.THREE;
    const g = new T.Group();
    g.position.set(x, 0, z);
    parent.add(g);
    const corner = (y, s) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, k]) => {
      const w = base + (top - base) * (y / h);
      return new T.Vector3(i * w * s, y, k * w * s);
    });
    for (let c = 0; c < 4; c++) this.strut(corner(0, 1)[c], corner(h, 1)[c], t, m, item, g);
    for (let l = 0; l < levels; l++) {
      const y0 = (h * l) / levels, y1 = (h * (l + 1)) / levels;
      const lo = corner(y0, 1), hi = corner(y1, 1);
      for (let c = 0; c < 4; c++) {
        const n = (c + 1) % 4;
        this.strut(lo[c], hi[n], t * 0.6, m, item, g);
        this.strut(lo[n], hi[c], t * 0.6, m, item, g);
        this.strut(hi[c], hi[n], t * 0.7, m, item, g);
      }
    }
    return g;
  }

  // Porcelain (or polymer) insulator with sheds, built on a lathe. Returns the mesh.
  insulator(x, y, z, h, r, item, { color = 0x8a4f35, parent = this.root, sheds } = {}) {
    const T = this.THREE;
    const n = sheds || Math.max(3, Math.round(h / (r * 1.6)));
    const key = `ins${h.toFixed(4)},${r.toFixed(4)},${n}`;
    if (!this.geos.has(key)) {
      const pts = [new T.Vector2(0, 0), new T.Vector2(r * 0.55, 0)];
      for (let i = 0; i < n; i++) {
        const y0 = (h * i) / n;
        pts.push(new T.Vector2(r * 0.45, y0 + h * 0.15 / n));
        pts.push(new T.Vector2(r, y0 + h * 0.35 / n));
        pts.push(new T.Vector2(r * 0.95, y0 + h * 0.5 / n));
        pts.push(new T.Vector2(r * 0.45, y0 + h * 0.75 / n));
      }
      pts.push(new T.Vector2(r * 0.55, h), new T.Vector2(0, h));
      this.geos.set(key, new T.LatheGeometry(pts, 20));
    }
    const m = this.std(color, { roughness: 0.25, metalness: 0.05 });
    const o = new T.Mesh(this.geos.get(key), m);
    o.position.set(x, y, z);
    parent.add(o);
    return this.pick(o, item);
  }

  // A run of chain-link fence between two points on the ground, with posts.
  fence(a, b, h, item, parent = this.root, postEvery = 0.12) {
    const T = this.THREE;
    const A = new T.Vector3(a[0], 0, a[1]), B = new T.Vector3(b[0], 0, b[1]);
    const len = A.distanceTo(B);
    const mesh = new T.Mesh(new T.PlaneGeometry(len, h), this.surface('chain', [len / (h * 0.35), 1 / 0.35]));
    mesh.position.copy(A).add(B).multiplyScalar(0.5).setY(h / 2);
    mesh.rotation.y = -Math.atan2(B.z - A.z, B.x - A.x);
    mesh.userData.noShadow = true;     // a solid shadow from a see-through fence reads wrong
    parent.add(mesh);
    this.pick(mesh, item);
    const galv = this.surface('galv');
    const posts = Math.max(1, Math.round(len / postEvery));
    for (let i = 0; i <= posts; i++) {
      const p = A.clone().lerp(B, i / posts);
      this.cyl(h * 0.03, h * 0.03, h * 1.08, galv, p.x, h * 0.54, p.z, item, parent, 8);
    }
    this.strut(A.clone().setY(h), B.clone().setY(h), h * 0.03, galv, item, parent);
    return mesh;
  }

  // A flat sign facing +z (rotate the returned mesh to face elsewhere).
  plaque(texture, w, h, x, y, z, item, parent = this.root, ry = 0) {
    const o = new this.THREE.Mesh(new this.THREE.PlaneGeometry(w, h), this.decal(texture));
    o.position.set(x, y, z);
    o.rotation.y = ry;
    parent.add(o);
    return this.pick(o, item);
  }

  // A catenary conductor between two points (jumpers, bus drops, cable runs).
  wire(a, b, r, m, sag = 0, item, parent = this.root, seg = 16) {
    const T = this.THREE;
    const A = new T.Vector3(...a), B = new T.Vector3(...b);
    const mid = A.clone().add(B).multiplyScalar(0.5);
    mid.y -= sag;
    const o = new T.Mesh(new T.TubeGeometry(new T.QuadraticBezierCurve3(A, mid, B), seg, r, 6, false), m);
    parent.add(o);
    return this.pick(o, item);
  }

  // Shadows on, except for flat decals, invisible pick helpers and transparent effects.
  enableShadows(root = this.root) {
    root.traverse((o) => {
      if (!o.isMesh) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const invisible = m && m.colorWrite === false;
      const fx = m && (m.transparent || m.isMeshBasicMaterial);
      o.castShadow = !invisible && !fx && !o.userData.noShadow;
      o.receiveShadow = !invisible && !fx;
    });
  }
}
