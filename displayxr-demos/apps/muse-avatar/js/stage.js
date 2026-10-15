// The world around the avatar: lights, a themed backdrop behind the glass, drifting particles at
// several depths (they are what make the 3D read), and one content slot beside the avatar for
// whatever Muse shows: an image, a glTF model, a built-in shape or an information card.
//
// Everything is in display metres for a 0.24 m virtual display. Content enters with a scale pop
// and leaves the same way, inside the one canvas (never a CSS transition on the woven tile).

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const SHAPES = ['planet', 'solar_system', 'dna', 'heart', 'globe', 'molecule', 'rocket', 'torus_knot', 'cube', 'crystal'];
export const THEMES = {
  night:   { top: '#0d1230', bottom: '#020308', glow: '#4b3cff', stars: 1.0, rim: 0x8f7bff, bands: 0 },
  sunrise: { top: '#ffb38a', bottom: '#5a3a8c', glow: '#ffd2a1', stars: 0.0, rim: 0xffb27a, bands: 0 },
  ocean:   { top: '#0b5c78', bottom: '#03141f', glow: '#3ee6d0', stars: 0.25, rim: 0x5fe3ff, bands: 0.35 },
  studio:  { top: '#3a3f4b', bottom: '#14161b', glow: '#ffffff', stars: 0.0, rim: 0xffffff, bands: 0 },
  aurora:  { top: '#06121f', bottom: '#010409', glow: '#3dff9b', stars: 0.8, rim: 0x6dffc0, bands: 1.0 },
};

const BACKDROP_Z = -0.085;            // behind the glass, within a comfortable depth budget
const SLOT = new THREE.Vector3(0.085, 0.005, 0.004);
const SLOT_SIZE = 0.13;               // content fits a box this many metres across

export class Stage {
  constructor(renderer, scene) {
    this.scene = scene;
    this.renderer = renderer;
    this.time = 0;
    this.themeName = 'night';
    this.content = null;              // { kind, caption, object, born, dying }
    this.leaving = [];
    this.loader = new GLTFLoader();

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.key = new THREE.DirectionalLight(0xffffff, 1.6);
    this.key.position.set(0.3, 0.5, 0.7);
    scene.add(this.key);
    this.rim = new THREE.DirectionalLight(THEMES.night.rim, 2.2);
    this.rim.position.set(-0.4, 0.3, -0.5);
    scene.add(this.rim);
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    this._buildBackdrop();
    this._buildParticles();
    this.slot = new THREE.Group();
    this.slot.position.copy(SLOT);
    scene.add(this.slot);
    this.setTheme('night');
  }

  // ---- backdrop ------------------------------------------------------------------------------
  _buildBackdrop() {
    this.backdropUniforms = {
      uTop: { value: new THREE.Color() }, uBottom: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() },
      uStars: { value: 1 }, uBands: { value: 0 }, uTime: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.backdropUniforms,
      depthWrite: false,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform vec3 uTop, uBottom, uGlow; uniform float uStars, uBands, uTime;
        varying vec2 vUv;
        // Hash without sine (Dave Hoskins): no banding on low-precision GPUs.
        float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
        void main() {
          vec3 col = mix(uBottom, uTop, smoothstep(0.0, 1.0, vUv.y));
          // a soft glow behind the avatar
          float d = distance(vUv, vec2(0.45, 0.52));
          col += uGlow * 0.22 * (1.0 - smoothstep(0.0, 0.42, d));
          // aurora / caustic bands
          float b = sin(vUv.x * 9.0 + uTime * 0.35 + sin(vUv.y * 5.0 + uTime * 0.2) * 1.6);
          col += uGlow * uBands * 0.10 * smoothstep(0.55, 1.0, b) * smoothstep(0.25, 0.85, vUv.y);
          // stars
          // stars: a round dot at a random spot in a few of the grid's cells
          vec2 cell = vUv * vec2(160.0, 90.0);
          vec2 g = floor(cell);
          float s = step(0.965, hash(g));
          vec2 at = vec2(hash(g + 7.7), hash(g + 1.9)) * 0.6 + 0.2;
          float r = 0.06 + 0.1 * hash(g + 4.2);
          float dotMask = 1.0 - smoothstep(r * 0.4, r, length(fract(cell) - at));
          float tw = 0.55 + 0.45 * sin(uTime * 1.7 + hash(g + 3.1) * 40.0);
          col += vec3(0.85, 0.9, 1.0) * s * dotMask * tw * uStars * smoothstep(0.15, 0.7, vUv.y);
          // vignette
          col *= 1.0 - 0.45 * pow(distance(vUv, vec2(0.5)), 2.0);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.backdrop.position.z = BACKDROP_Z;
    this.backdrop.renderOrder = -10;
    this.scene.add(this.backdrop);
  }

  _buildParticles() {
    const N = 260;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 0.5;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 0.28;
      pos[i * 3 + 2] = -0.07 + Math.random() * 0.1;     // from behind the glass to a little in front
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    this.particleUniforms = { uTime: { value: 0 }, uColor: { value: new THREE.Color() }, uScale: { value: 1 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.particleUniforms,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute float seed; uniform float uTime, uScale; varying float vA;
        void main() {
          vec3 p = position;
          p.y += mod(uTime * (0.004 + seed * 0.006) + seed, 0.28) - 0.14 - position.y * 0.0;
          p.x += sin(uTime * 0.3 + seed * 20.0) * 0.006;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uScale * (1.5 + seed * 3.0) * (0.6 / -mv.z);
          vA = 0.25 + 0.6 * seed;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(uColor, vA * (1.0 - smoothstep(0.0, 0.5, d)));
        }`,
    });
    this.particles = new THREE.Points(geo, mat);
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);
  }

  /** The canvas's pixel height, so points stay the same apparent size at any resolution. */
  setViewport(width, height, aspect) {
    this.particleUniforms.uScale.value = height / 400;
    // Cover the view from any tracked head position: the plane is behind the glass.
    this.backdrop.scale.set(0.24 * aspect * 1.9, 0.24 * 1.9, 1);
  }

  setTheme(name) {
    const th = THEMES[name];
    if (!th) return false;
    this.themeName = name;
    const u = this.backdropUniforms;
    u.uTop.value.set(th.top); u.uBottom.value.set(th.bottom); u.uGlow.value.set(th.glow);
    u.uStars.value = th.stars; u.uBands.value = th.bands;
    this.rim.color.setHex(th.rim);
    this.particleUniforms.uColor.value.set(th.glow);
    return true;
  }

  // ---- content -------------------------------------------------------------------------------
  get hasContent() { return !!this.content; }

  describe() {
    return this.content ? { kind: this.content.kind, caption: this.content.caption || null } : null;
  }

  clear() {
    if (!this.content) return;
    this.content.dying = this.time;
    this.leaving.push(this.content);
    this.content = null;
  }

  _present(kind, object, caption, { spin = 0 } = {}) {
    this.clear();
    const holder = new THREE.Group();
    holder.add(object);
    if (caption) {
      const label = captionMesh(caption);
      label.position.y = -SLOT_SIZE * 0.5 - 0.012;
      holder.add(label);
    }
    holder.scale.setScalar(0.001);
    this.slot.add(holder);
    this.content = { kind, caption, holder, object, spin, born: this.time, dying: 0 };
  }

  async showImage(src, caption) {
    const tex = await new THREE.TextureLoader().loadAsync(src);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const img = tex.image;
    const aspect = img.width / img.height || 1;
    const w = aspect >= 1 ? SLOT_SIZE : SLOT_SIZE * aspect;
    const h = aspect >= 1 ? SLOT_SIZE / aspect : SLOT_SIZE;
    const group = new THREE.Group();
    const frame = new THREE.Mesh(
      new RoundedBoxGeometry(w + 0.008, h + 0.008, 0.005, 4, 0.0035),
      new THREE.MeshPhysicalMaterial({ color: 0x151827, roughness: 0.35, metalness: 0.2, clearcoat: 1 }),
    );
    frame.position.z = -0.0028;
    group.add(frame);
    const pic = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    pic.position.z = 0.0001;
    group.add(pic);
    group.rotation.y = -0.18;               // turned a little toward the avatar
    this._present('image', group, caption);
  }

  async showModel(url, caption, spin = true) {
    const gltf = await this.loader.loadAsync(url);
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const s = SLOT_SIZE / Math.max(size.x, size.y, size.z, 1e-6);
    model.position.sub(center);
    const pivot = new THREE.Group();
    pivot.add(model);
    pivot.scale.setScalar(s);
    this._present('model', pivot, caption, { spin: spin ? 0.5 : 0 });
  }

  showShape(name, caption, color) {
    const object = buildShape(name, color);
    if (!object) return false;
    this._present('shape:' + name, object, caption, { spin: object.userData.spin ?? 0.4 });
    return true;
  }

  showCard({ title, body, bullets, accent }) {
    const tex = cardTexture({ title, body, bullets, accent });
    const w = 0.15, h = w * tex.image.height / tex.image.width;
    const group = new THREE.Group();
    const slab = new THREE.Mesh(
      new RoundedBoxGeometry(w, h, 0.004, 4, 0.006),
      new THREE.MeshPhysicalMaterial({ color: 0x10142a, roughness: 0.3, clearcoat: 1, metalness: 0.1 }),
    );
    slab.position.z = -0.0022;
    group.add(slab);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
    face.position.z = 0.0001;
    group.add(face);
    group.rotation.y = -0.16;
    this._present('card', group, null);
    this.content.caption = title;
  }

  // ---- per frame -------------------------------------------------------------------------------
  update(dt) {
    this.time += dt;
    this.backdropUniforms.uTime.value = this.time;
    this.particleUniforms.uTime.value = this.time;

    const c = this.content;
    if (c) {
      const age = this.time - c.born;
      c.holder.scale.setScalar(Math.max(0.001, popIn(Math.min(1, age / 0.55))));
      c.holder.position.y = Math.sin(this.time * 1.3) * 0.003;
      if (c.spin) c.object.rotation.y += dt * c.spin;
      c.object.userData.tick?.(dt, this.time);
    }
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const old = this.leaving[i];
      const p = Math.min(1, (this.time - old.dying) / 0.3);
      old.holder.scale.setScalar(Math.max(0.001, 1 - p * p));
      if (p >= 1) {
        this.slot.remove(old.holder);
        dispose(old.holder);
        this.leaving.splice(i, 1);
      }
    }
  }
}

// ---- helpers ---------------------------------------------------------------------------------
function popIn(p) {
  const s = 1.70158 * 1.2;
  const q = p - 1;
  return 1 + q * q * ((s + 1) * q + s);   // ease-out-back
}

function dispose(root) {
  root.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { m.map?.dispose?.(); m.dispose?.(); }
  });
}

function captionMesh(text) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = '600 44px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.font = font;
  const label = text.length > 60 ? text.slice(0, 57) + '…' : text;
  const w = Math.min(1400, Math.ceil(ctx.measureText(label).width) + 64);
  c.width = w; c.height = 80;
  ctx.font = font;
  ctx.fillStyle = 'rgba(8,10,22,0.78)';
  roundRect(ctx, 0, 0, w, 80, 40);
  ctx.fill();
  ctx.fillStyle = '#f3f4ff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, w / 2, 42);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const h = 0.011;
  return new THREE.Mesh(new THREE.PlaneGeometry(h * w / 80, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
}

function cardTexture({ title = '', body = '', bullets = [], accent = '#8f7bff' }) {
  const W = 1024;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const pad = 64;
  const lines = [];
  ctx.font = '400 40px system-ui, -apple-system, Segoe UI, sans-serif';
  for (const l of wrap(ctx, body, W - pad * 2)) lines.push({ text: l, kind: 'body' });
  for (const b of bullets) wrap(ctx, b, W - pad * 2 - 48).forEach((l, i) => lines.push({ text: l, kind: i ? 'cont' : 'bullet' }));
  ctx.font = '700 60px system-ui, -apple-system, Segoe UI, sans-serif';
  const titleLines = wrap(ctx, title, W - pad * 2).slice(0, 2);
  const H = Math.min(1024, pad * 2 + 24 + titleLines.length * 70 + 24 + lines.length * 54);
  c.width = W; c.height = H;

  ctx.fillStyle = '#121633';
  roundRect(ctx, 0, 0, W, H, 48);
  ctx.fill();
  ctx.fillStyle = accent;
  roundRect(ctx, pad, pad - 20, 120, 10, 5);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 60px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textBaseline = 'top';
  let y = pad + 10;
  for (const l of titleLines) { ctx.fillText(l, pad, y); y += 70; }
  y += 18;
  ctx.font = '400 40px system-ui, -apple-system, Segoe UI, sans-serif';
  for (const l of lines) {
    if (y > H - pad) break;
    if (l.kind === 'bullet') {
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(pad + 12, y + 22, 9, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = l.kind === 'body' ? '#c9cdf0' : '#eef0ff';
    ctx.fillText(l.text, l.kind === 'body' ? pad : pad + 48, y);
    y += 54;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function wrap(ctx, text, width) {
  if (!text) return [];
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? line + ' ' + word : word;
      if (ctx.measureText(next).width > width && line) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const std = (color, extra = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.4, metalness: 0.1, clearcoat: 0.6, ...extra });
const glowMat = (color, i = 2) => new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: i });

/** Built-in shapes, each fitting the slot (about 0.13 m), for Muse to illustrate with. */
export function buildShape(name, color) {
  const R = SLOT_SIZE / 2;
  const g = new THREE.Group();
  switch (name) {
    case 'planet': {
      const tex = bandsTexture(color || '#d9a066');
      g.add(new THREE.Mesh(new THREE.SphereGeometry(R * 0.55, 64, 48), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 })));
      const ring = new THREE.Mesh(new THREE.RingGeometry(R * 0.72, R * 1.0, 96), new THREE.MeshStandardMaterial({ color: 0xe8d6b0, side: THREE.DoubleSide, transparent: true, opacity: 0.75, roughness: 0.9 }));
      ring.rotation.x = Math.PI / 2 - 0.42;
      g.add(ring);
      g.rotation.z = 0.25;
      g.userData.spin = 0.25;
      break;
    }
    case 'solar_system': {
      g.add(new THREE.Mesh(new THREE.SphereGeometry(R * 0.26, 48, 32), glowMat(color || 0xffb547, 2.5)));
      const planets = [[0.42, 0.06, 0x7fd1ff, 1.3], [0.62, 0.085, 0x7cf0a5, 0.9], [0.86, 0.07, 0xff8a7a, 0.6]];
      const orbits = planets.map(([r, s, c, w]) => {
        const pivot = new THREE.Group();
        const p = new THREE.Mesh(new THREE.SphereGeometry(R * s, 32, 24), std(c));
        p.position.x = R * r;
        pivot.add(p);
        const path = new THREE.Mesh(new THREE.TorusGeometry(R * r, 0.0003, 6, 128), new THREE.MeshBasicMaterial({ color: 0x8890c0, transparent: true, opacity: 0.5 }));
        path.rotation.x = Math.PI / 2;
        g.add(path, pivot);
        return { pivot, w };
      });
      g.rotation.x = 0.45;
      g.userData.spin = 0;
      g.userData.tick = (dt) => orbits.forEach((o) => { o.pivot.rotation.y += dt * o.w; });
      break;
    }
    case 'dna': {
      const a = std(color || '#5fe3ff'), b = std('#ff7ac8'), rung = std('#e9ecff', { roughness: 0.6 });
      const turns = 2.2, steps = 22, height = R * 1.9;
      for (let i = 0; i < steps; i++) {
        const t = i / (steps - 1);
        const ang = t * turns * Math.PI * 2;
        const y = (t - 0.5) * height;
        const p1 = new THREE.Vector3(Math.cos(ang) * R * 0.42, y, Math.sin(ang) * R * 0.42);
        const p2 = p1.clone().multiply(new THREE.Vector3(-1, 1, -1));
        const s1 = new THREE.Mesh(new THREE.SphereGeometry(0.0042, 16, 12), a); s1.position.copy(p1);
        const s2 = new THREE.Mesh(new THREE.SphereGeometry(0.0042, 16, 12), b); s2.position.copy(p2);
        g.add(s1, s2, cylinderBetween(p1, p2, 0.0012, rung));
      }
      g.userData.spin = 0.6;
      break;
    }
    case 'heart': {
      const s = new THREE.Shape();
      s.moveTo(0, -0.5);
      s.bezierCurveTo(-1.1, 0.2, -0.55, 0.95, 0, 0.42);
      s.bezierCurveTo(0.55, 0.95, 1.1, 0.2, 0, -0.5);
      const geo = new THREE.ExtrudeGeometry(s, { depth: 0.3, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.1, bevelSegments: 8, curveSegments: 48 });
      geo.center();
      const mesh = new THREE.Mesh(geo, std(color || '#ff4f86', { roughness: 0.25, clearcoat: 1 }));
      mesh.scale.setScalar(R * 0.9);
      g.add(mesh);
      g.userData.tick = (dt, t) => mesh.scale.setScalar(R * 0.9 * (1 + 0.08 * Math.pow(Math.max(0, Math.sin(t * 5)), 8)));
      g.userData.spin = 0.5;
      break;
    }
    case 'globe': {
      g.add(new THREE.Mesh(new THREE.SphereGeometry(R * 0.7, 64, 48), std(color || '#1f6fd1', { roughness: 0.5 })));
      const wire = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(R * 0.71, 18, 12)), new THREE.LineBasicMaterial({ color: 0x9fd6ff, transparent: true, opacity: 0.35 }));
      g.add(wire);
      const dots = new THREE.Group();
      for (let i = 0; i < 70; i++) {
        const v = new THREE.Vector3().randomDirection().multiplyScalar(R * 0.72);
        if (Math.abs(v.y) > R * 0.6) continue;
        const d = new THREE.Mesh(new THREE.SphereGeometry(0.0016, 8, 6), glowMat(0x7cf0a5, 1.6));
        d.position.copy(v);
        dots.add(d);
      }
      g.add(dots);
      g.rotation.z = 0.4;
      g.userData.spin = 0.35;
      break;
    }
    case 'molecule': {
      const atoms = [[0, 0, 0, 0.13, 0xff5a5a], [0.32, 0.18, 0, 0.09, 0xffffff], [-0.32, 0.18, 0, 0.09, 0xffffff], [0, -0.36, 0.12, 0.11, 0x5fa8ff], [0.2, -0.55, -0.2, 0.08, 0xffffff]];
      const pts = atoms.map(([x, y, z, r, c]) => {
        const p = new THREE.Vector3(x, y, z).multiplyScalar(R * 1.25);
        const m = new THREE.Mesh(new THREE.SphereGeometry(R * r, 32, 24), std(c, { roughness: 0.2, clearcoat: 1 }));
        m.position.copy(p);
        g.add(m);
        return p;
      });
      const bond = std(0xb8bdd6);
      [[0, 1], [0, 2], [0, 3], [3, 4]].forEach(([i, j]) => g.add(cylinderBetween(pts[i], pts[j], 0.0018, bond)));
      g.position.y = R * 0.15;
      g.userData.spin = 0.5;
      break;
    }
    case 'rocket': {
      const body = new THREE.Mesh(new THREE.LatheGeometry([[0, -0.5], [0.16, -0.48], [0.2, -0.2], [0.2, 0.15], [0.12, 0.42], [0, 0.6]].map(([x, y]) => new THREE.Vector2(x * R * 1.4, y * R * 1.4)), 48), std(color || '#eef0f8', { clearcoat: 1 }));
      g.add(body);
      const win = new THREE.Mesh(new THREE.CircleGeometry(R * 0.09, 32), std(0x5fe3ff, { metalness: 0.6, roughness: 0.1 }));
      win.position.set(0, R * 0.18, R * 0.281);
      g.add(win);
      for (let i = 0; i < 3; i++) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(R * 0.02, R * 0.3, R * 0.22), std(0xff5a7a));
        const pivot = new THREE.Group();
        fin.position.set(0, -R * 0.58, R * 0.32);
        pivot.add(fin);
        pivot.rotation.y = (i / 3) * Math.PI * 2;
        g.add(pivot);
      }
      const flame = new THREE.Mesh(new THREE.ConeGeometry(R * 0.14, R * 0.4, 24), new THREE.MeshBasicMaterial({ color: 0xffb547, transparent: true, opacity: 0.85 }));
      flame.rotation.x = Math.PI;
      flame.position.y = -R * 0.9;
      g.add(flame);
      g.userData.tick = (dt, t) => { flame.scale.y = 0.8 + 0.3 * Math.sin(t * 30) * Math.sin(t * 13); g.position.y = Math.sin(t * 2) * 0.003; };
      g.rotation.z = -0.35;
      g.userData.spin = 0.4;
      break;
    }
    case 'torus_knot':
      g.add(new THREE.Mesh(new THREE.TorusKnotGeometry(R * 0.5, R * 0.15, 220, 32), std(color || '#9b7bff', { metalness: 0.5, roughness: 0.15, clearcoat: 1 })));
      g.userData.spin = 0.5;
      break;
    case 'cube':
      g.add(new THREE.Mesh(new RoundedBoxGeometry(R * 1.1, R * 1.1, R * 1.1, 6, R * 0.12), std(color || '#3ee6a8', { clearcoat: 1, roughness: 0.2 })));
      g.rotation.set(0.5, 0.6, 0);
      g.userData.spin = 0.5;
      break;
    case 'crystal':
      g.add(new THREE.Mesh(new THREE.OctahedronGeometry(R * 0.75, 0), new THREE.MeshPhysicalMaterial({
        color: color || '#a8e6ff', roughness: 0.05, metalness: 0, transmission: 0.6, thickness: 0.02, ior: 1.6, clearcoat: 1, flatShading: true,
      })));
      g.scale.y = 1.3;
      g.userData.spin = 0.6;
      break;
    default:
      return null;
  }
  return g;
}

function cylinderBetween(a, b, radius, material) {
  const dir = b.clone().sub(a);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, dir.length(), 10), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

function bandsTexture(base) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const ctx = c.getContext('2d');
  const col = new THREE.Color(base);
  for (let y = 0; y < 128; y++) {
    const k = 0.75 + 0.25 * Math.sin(y * 0.35) * Math.sin(y * 0.11 + 1.3);
    ctx.fillStyle = '#' + col.clone().multiplyScalar(k).getHexString();
    ctx.fillRect(0, y, 256, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
