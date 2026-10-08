// The visual styles. Every style is built once at boot and only shown or hidden afterwards:
// switching style swaps what is drawn inside the one woven canvas, never the canvas.
//
// Units are metres on a display rig with virtualDisplayHeight = 0.24: the canvas plane is z = 0
// (on the glass), +z comes out toward the viewer, -z goes behind the glass. The visible plane at
// z = 0 is `h` = 0.24 tall and `w` = 0.24 × aspect wide. Depth is kept to roughly +0.06 in front
// and -0.32 behind, which a lenticular panel shows comfortably; the beat pushes things forward.
//
// Each style: { name, key, group, resize(w, h), update(dt, a, t), fog }
//   a = AudioEngine.features (bands, wave, level, bass, mid, treble, beat, pulse)

import { BANDS } from './audio.js';

const POP = 0.06;     // furthest a beat pushes anything in front of the glass
const DEEP = -0.32;   // furthest back anything sits

export function createStyles(THREE) {
  const color = new THREE.Color();
  const hsl = (h, s, l) => color.setHSL(((h % 1) + 1) % 1, s, l);
  const bandAt = (a, u) => {
    // Smooth lookup into the bands, u in [0,1].
    const x = Math.max(0, Math.min(1, u)) * (BANDS - 1);
    const i = Math.floor(x), f = x - i;
    return a.bands[i] * (1 - f) + a.bands[Math.min(BANDS - 1, i + 1)] * f;
  };

  // Soft round sprite for point clouds.
  const dot = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();

  // ---------------------------------------------------------------------------------------
  // 1. Spectrogram: a 3D waterfall of spectrum bars. The newest row stands on the glass and
  //    history scrolls back into the screen.
  function spectrogram() {
    const COLS = 48, ROWS = 26;
    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const mesh = new THREE.InstancedMesh(geo, mat, COLS * ROWS);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(COLS * ROWS * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    group.add(mesh);
    const lights = new THREE.Group();
    lights.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(0.3, 1, 0.8); lights.add(key);
    group.add(lights);

    const hist = new Float32Array(COLS * ROWS);
    let head = 0, acc = 0, w = 0.4, h = 0.24, hue = 0.55;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    group.rotation.x = 0.32;

    return {
      name: 'Spectrogram', group, fog: [0.62, 1.05],
      resize(W, H) { w = W; h = H; },
      update(dt, a, t) {
        acc += dt;
        // New row 30 times a second.
        if (acc >= 1 / 30) { acc %= 1 / 30; head = (head + ROWS - 1) % ROWS; }
        for (let c = 0; c < COLS; c++) hist[head * COLS + c] = bandAt(a, c / (COLS - 1));
        hue += dt * 0.02 + (a.beat ? 0.06 : 0);
        const span = Math.min(w * 0.9, h * 2.6);
        const dx = span / COLS, dz = 0.3 / ROWS;
        const base = -h * 0.36;
        let i = 0;
        for (let r = 0; r < ROWS; r++) {
          const row = (head + r) % ROWS;
          const fade = 1 - r / ROWS;
          const z = 0.02 - r * dz + (r === 0 ? a.pulse * 0.03 : 0);
          for (let c = 0; c < COLS; c++, i++) {
            const v = hist[row * COLS + c];
            p.set((c - (COLS - 1) / 2) * dx, base, z);
            s.set(dx * 0.72, 0.002 + v * h * 0.62, dz * 0.7);
            m.compose(p, q, s);
            mesh.setMatrixAt(i, m);
            hsl(hue + c / COLS * 0.45, 0.85, 0.12 + v * 0.5 * (0.35 + 0.65 * fade));
            mesh.setColorAt(i, color);
          }
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
        group.position.z = a.pulse * 0.012;
        group.rotation.y = Math.sin(t * 0.15) * 0.12;
      },
    };
  }

  // ---------------------------------------------------------------------------------------
  // 2. Tunnel: rings shaped by the radial spectrum fly out of the screen toward the viewer.
  function tunnel() {
    const N = 34, S = 128;
    const group = new THREE.Group();
    const rings = [];
    const index = [];
    for (let k = 0; k < S; k++) {
      const a0 = k * 2, b0 = ((k + 1) % S) * 2;
      index.push(a0, a0 + 1, b0, b0, a0 + 1, b0 + 1);
    }
    for (let i = 0; i < N; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(S * 2 * 3), 3));
      g.setIndex(index);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      group.add(mesh);
      rings.push({ mesh, z: DEEP + (i / N) * (POP - DEEP), hue: 0, glow: 0.5 });
    }
    let h = 0.24, hue = 0.8, speed = 0.05, shaped = false;
    const shape = (ring, a, beat) => {
      const pos = ring.mesh.geometry.attributes.position.array;
      const R = h * 0.3;
      const thick = 0.0022 + (beat ? 0.0025 : 0);
      for (let k = 0; k < S; k++) {
        const th = (k / S) * Math.PI * 2;
        const u = Math.abs(((k / S) * 2 + 0.5) % 2 - 1);   // mirror so the ring is symmetric
        const r = R * (1 + 0.42 * bandAt(a, u * 0.8));
        const c = Math.cos(th), sn = Math.sin(th);
        pos.set([c * r, sn * r, 0, c * (r + thick), sn * (r + thick), 0], k * 6);
      }
      ring.mesh.geometry.attributes.position.needsUpdate = true;
      ring.hue = hue;
      ring.glow = beat ? 1 : 0.35 + a.level * 0.5;
    };
    return {
      name: 'Tunnel', group, fog: null,
      resize(W, H) { h = H; },
      update(dt, a, t) {
        hue += dt * 0.03 + (a.beat ? 0.08 : 0);
        speed += ((0.045 + a.level * 0.16 + a.pulse * 0.32) - speed) * Math.min(1, dt * 6);
        if (!shaped) { shaped = true; for (const ring of rings) shape(ring, a, false); }
        let respawnedOnBeat = false;
        for (const ring of rings) {
          ring.z += speed * dt;
          if (ring.z > POP) {
            ring.z -= POP - DEEP;
            shape(ring, a, a.beat && !respawnedOnBeat);
            respawnedOnBeat = respawnedOnBeat || a.beat;
          }
          const u = (ring.z - DEEP) / (POP - DEEP);          // 0 far .. 1 near
          const fadeIn = Math.min(1, u * 4), fadeOut = Math.min(1, (1 - u) * 2.5);
          const m = ring.mesh;
          m.position.set(Math.sin(t * 0.6 + ring.z * 9) * 0.018, Math.cos(t * 0.45 + ring.z * 7) * 0.012, ring.z);
          m.rotation.z = t * 0.1 + ring.z * 2;
          hsl(ring.hue + u * 0.15, 0.9, 0.5);
          m.material.color.copy(color).multiplyScalar(ring.glow * fadeIn * fadeOut * (0.7 + a.pulse * 0.6));
        }
      },
    };
  }

  // ---------------------------------------------------------------------------------------
  // 3. Hyperspace: a particle field streaming toward the viewer; kicks fire radial bursts.
  function hyperspace() {
    const N = 2600;
    const group = new THREE.Group();
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const vel = new Float32Array(N * 2), seed = new Float32Array(N);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({
      size: 0.0042, map: dot, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    group.add(points);
    let w = 0.4, h = 0.24, hue = 0.6, speed = 0.05;
    const spawn = (i, anywhere) => {
      pos[i * 3] = (Math.random() - 0.5) * w * 1.3;
      pos[i * 3 + 1] = (Math.random() - 0.5) * h * 1.3;
      pos[i * 3 + 2] = anywhere ? DEEP + Math.random() * (POP - DEEP) : DEEP - Math.random() * 0.03;
      vel[i * 2] = vel[i * 2 + 1] = 0;
      seed[i] = Math.random();
    };
    for (let i = 0; i < N; i++) spawn(i, true);
    return {
      name: 'Hyperspace', group, fog: null,
      resize(W, H) { w = W; h = H; for (let i = 0; i < N; i++) spawn(i, true); },
      update(dt, a) {
        hue += dt * 0.025 + (a.beat ? 0.11 : 0);
        speed += ((0.03 + a.bass * 0.2 + a.pulse * 0.35) - speed) * Math.min(1, dt * 5);
        const burst = a.beat ? 0.05 + a.pulse * 0.12 : 0;
        const damp = Math.exp(-dt * 2.5);
        for (let i = 0; i < N; i++) {
          const k = i * 3;
          let x = pos[k], y = pos[k + 1];
          if (burst) {
            const r = Math.hypot(x, y) + 1e-4;
            vel[i * 2] += (x / r) * burst * (0.5 + seed[i]);
            vel[i * 2 + 1] += (y / r) * burst * (0.5 + seed[i]);
          }
          vel[i * 2] *= damp; vel[i * 2 + 1] *= damp;
          x += vel[i * 2] * dt; y += vel[i * 2 + 1] * dt;
          pos[k] = x; pos[k + 1] = y;
          pos[k + 2] += speed * dt * (0.6 + seed[i] * 0.8);
          if (pos[k + 2] > POP || Math.abs(x) > w || Math.abs(y) > h) spawn(i, false);
          const u = (pos[k + 2] - DEEP) / (POP - DEEP);
          const band = bandAt(a, seed[i]);
          hsl(hue + seed[i] * 0.25, 0.95, 0.5 + band * 0.25);
          const fade = Math.min(1, u * 3) * (0.75 + band * 0.6);
          col[k] = color.r * fade; col[k + 1] = color.g * fade; col[k + 2] = color.b * fade;
        }
        geo.attributes.position.needsUpdate = true;
        geo.attributes.color.needsUpdate = true;
        mat.size = 0.011 + a.treble * 0.006 + a.pulse * 0.004;
      },
    };
  }

  // ---------------------------------------------------------------------------------------
  // 4. Ridgeline: the "Unknown Pleasures" stack of spectrum lines, receding into the screen.
  //    Each ridge has an opaque black skirt so nearer ridges hide the ones behind them.
  function ridgeline() {
    const L = 34, P = 120;
    const group = new THREE.Group();
    const ridges = [];
    const idx = [];
    for (let k = 0; k < P - 1; k++) idx.push(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 2, k * 2 + 1, k * 2 + 3);
    for (let i = 0; i < L; i++) {
      const line = new THREE.BufferGeometry();
      line.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P * 2 * 3), 3));
      line.setIndex(idx);
      const skirt = new THREE.BufferGeometry();
      skirt.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P * 2 * 3), 3));
      skirt.setIndex(idx);
      const lineMesh = new THREE.Mesh(line, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
      const skirtMesh = new THREE.Mesh(skirt, new THREE.MeshBasicMaterial({
        color: 0x000000, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      }));
      lineMesh.frustumCulled = skirtMesh.frustumCulled = false;
      group.add(skirtMesh, lineMesh);
      ridges.push({ line: lineMesh, skirt: skirtMesh });
    }
    const hist = new Float32Array(L * P);
    const noise = new Float32Array(P).map(() => Math.random());
    let head = 0, acc = 0, w = 0.4, h = 0.24, hue = 0.0;
    group.rotation.x = 0.42;
    return {
      name: 'Ridgeline', group, fog: [0.6, 1.0],
      resize(W, H) { w = W; h = H; },
      update(dt, a, t) {
        acc += dt;
        const write = () => {
          for (let k = 0; k < P; k++) {
            const x = k / (P - 1) * 2 - 1;                     // -1..1
            const env = Math.exp(-x * x * 5.5);                // peaks in the middle, flat edges
            const u = Math.abs(x) * 0.9;                       // bass in the centre
            hist[head * P + k] = env * (bandAt(a, u) * 0.85 + noise[(k + head * 7) % P] * 0.12 * (0.3 + a.level));
          }
        };
        if (acc >= 1 / 18) { acc %= 1 / 18; head = (head + L - 1) % L; noise.forEach((_, k) => { noise[k] = Math.random(); }); }
        write();
        hue += dt * 0.015 + (a.beat ? 0.05 : 0);
        const span = Math.min(w * 0.8, h * 1.8);
        const dz = 0.3 / L, dy = h * 0.012;
        const amp = h * 0.32;
        const base0 = -h * 0.3;
        for (let r = 0; r < L; r++) {
          const row = (head + r) % L;
          const z = 0.03 - r * dz + (r === 0 ? a.pulse * 0.025 : 0);
          const base = base0 + r * dy;
          const lp = ridges[r].line.geometry.attributes.position.array;
          const sp = ridges[r].skirt.geometry.attributes.position.array;
          const thick = 0.0016;
          for (let k = 0; k < P; k++) {
            const x = (k / (P - 1) - 0.5) * span;
            const y = base + hist[row * P + k] * amp;
            const j = k * 6;
            lp[j] = x; lp[j + 1] = y; lp[j + 2] = z;
            lp[j + 3] = x; lp[j + 4] = y + thick; lp[j + 5] = z;
            sp[j] = x; sp[j + 1] = base - h * 0.08; sp[j + 2] = z;
            sp[j + 3] = x; sp[j + 4] = y; sp[j + 5] = z;
          }
          ridges[r].line.geometry.attributes.position.needsUpdate = true;
          ridges[r].skirt.geometry.attributes.position.needsUpdate = true;
          const fade = 1 - r / L;
          hsl(hue + r * 0.012, r === 0 ? 0.2 : 0.55, 0.35 + 0.5 * fade + (r === 0 ? a.pulse * 0.2 : 0));
          ridges[r].line.material.color.copy(color);
        }
        group.position.y = Math.sin(t * 0.3) * 0.004;
      },
    };
  }

  // ---------------------------------------------------------------------------------------
  // 5. Orb: a noise-displaced sphere straddling the glass. Bands map to latitude, the beat
  //    swells it out toward the viewer, a fresnel rim makes the silhouette glow.
  function orb() {
    const group = new THREE.Group();
    const spec = new THREE.DataTexture(new Uint8Array(BANDS * 4), BANDS, 1, THREE.RGBAFormat);
    spec.magFilter = spec.minFilter = THREE.LinearFilter;
    spec.needsUpdate = true;
    const uniforms = {
      uTime: { value: 0 }, uPulse: { value: 0 }, uLevel: { value: 0 }, uMid: { value: 0 },
      uHue: { value: 0 }, uSpec: { value: spec }, uRadius: { value: 0.05 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */`
        uniform float uTime, uPulse, uLevel, uMid, uRadius;
        uniform sampler2D uSpec;
        varying vec3 vN; varying vec3 vView; varying float vDisp;
        ${SNOISE}
        void main() {
          vec3 n = normalize(position);
          float lat = acos(clamp(n.y, -1.0, 1.0)) / 3.14159265;     // 0 top .. 1 bottom
          float band = texture2D(uSpec, vec2(abs(lat * 2.0 - 1.0) * 0.85 + 0.02, 0.5)).r;
          float nse = snoise(n * 2.2 + vec3(0.0, uTime * 0.35, uTime * 0.2));
          float d = 0.16 * nse * (0.35 + uMid) + 0.38 * band + 0.22 * uPulse;
          vDisp = d;
          vec3 p = n * uRadius * (1.0 + d);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vN = normalize(normalMatrix * n);   // undisplaced normal: a smooth fresnel rim
          vView = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uHue, uPulse, uLevel;
        varying vec3 vN; varying vec3 vView; varying float vDisp;
        vec3 hsv(float h, float s, float v) {
          vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
          return v * mix(vec3(1.0), k, s);
        }
        void main() {
          float fr = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 2.2);
          vec3 core = hsv(uHue + vDisp * 0.6, 0.85, 0.12 + 0.25 * uLevel);
          vec3 rim = hsv(uHue + 0.12, 0.6, 1.0) * fr * (1.2 + uPulse);
          gl_FragColor = vec4(core + rim, 1.0);
        }`,
    });
    const sphere = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 32), mat);
    sphere.frustumCulled = false;
    group.add(sphere);

    // A ring of satellites orbiting on a tilted plane, so there is always something in front of
    // and behind the orb.
    const SAT = 260;
    const satPos = new Float32Array(SAT * 3), satCol = new Float32Array(SAT * 3);
    const satGeo = new THREE.BufferGeometry();
    satGeo.setAttribute('position', new THREE.BufferAttribute(satPos, 3).setUsage(THREE.DynamicDrawUsage));
    satGeo.setAttribute('color', new THREE.BufferAttribute(satCol, 3).setUsage(THREE.DynamicDrawUsage));
    const sats = new THREE.Points(satGeo, new THREE.PointsMaterial({
      size: 0.004, map: dot, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    sats.frustumCulled = false;
    sats.rotation.x = 1.15;
    group.add(sats);
    const satSeed = Array.from({ length: SAT }, () => [Math.random() * Math.PI * 2, 0.8 + Math.random() * 0.5, Math.random()]);

    let h = 0.24, hue = 0.75;
    return {
      name: 'Orb', group, fog: null,
      resize(W, H) { h = H; },
      update(dt, a, t) {
        const d = spec.image.data;
        for (let i = 0; i < BANDS; i++) d[i * 4] = Math.min(255, a.bands[i] * 255);
        spec.needsUpdate = true;
        hue += dt * 0.02 + (a.beat ? 0.07 : 0);
        const R = h * 0.2;
        uniforms.uTime.value = t;
        uniforms.uPulse.value = a.pulse;
        uniforms.uLevel.value = a.level;
        uniforms.uMid.value = a.mid;
        uniforms.uHue.value = hue % 1;
        uniforms.uRadius.value = R;
        sphere.rotation.y += dt * (0.15 + a.level * 0.4);
        sphere.position.z = a.pulse * 0.02;
        for (let i = 0; i < SAT; i++) {
          const [ph, rr, s] = satSeed[i];
          const ang = ph + t * (0.25 + s * 0.3) * (1 + a.bass);
          const r = R * (1.9 + rr * 0.9 + a.pulse * 0.4);
          satPos[i * 3] = Math.cos(ang) * r;
          satPos[i * 3 + 1] = Math.sin(ang) * r;
          satPos[i * 3 + 2] = (s - 0.5) * R * 0.3;
          hsl(hue + 0.15 + s * 0.2, 0.8, 0.3 + bandAt(a, s) * 0.5);
          satCol[i * 3] = color.r; satCol[i * 3 + 1] = color.g; satCol[i * 3 + 2] = color.b;
        }
        satGeo.attributes.position.needsUpdate = true;
        satGeo.attributes.color.needsUpdate = true;
        sats.rotation.z = t * 0.05;
      },
    };
  }

  // ---------------------------------------------------------------------------------------
  // 6. Halo: the radial spectrum ring of the music-channel era (bars around a pulsing disc),
  //    in three layers at different depths. The back layers replay older spectra as echoes.
  function halo() {
    const B = 120, LAYERS = 3;
    const group = new THREE.Group();
    const geo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const layers = [];
    for (let l = 0; l < LAYERS; l++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, B);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      group.add(mesh);
      layers.push({ mesh, z: [0.012, -0.045, -0.11][l], hist: new Float32Array(B) });
    }
    // Centre disc: a radial gradient drawn into a canvas, recoloured through material.color.
    const discTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const g = c.getContext('2d');
      const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.55, 'rgba(255,255,255,0.35)');
      grd.addColorStop(0.92, 'rgba(255,255,255,0.9)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const disc = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: discTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    group.add(disc);
    // Dust behind the ring.
    const D = 500;
    const dPos = new Float32Array(D * 3);
    const dGeo = new THREE.BufferGeometry();
    dGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
    const dust = new THREE.Points(dGeo, new THREE.PointsMaterial({
      size: 0.003, map: dot, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffffff,
    }));
    dust.frustumCulled = false;
    group.add(dust);

    let w = 0.4, h = 0.24, hue = 0.9;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const zAxis = new THREE.Vector3(0, 0, 1);
    const seedDust = () => {
      for (let i = 0; i < D; i++) {
        dPos[i * 3] = (Math.random() - 0.5) * w * 1.2;
        dPos[i * 3 + 1] = (Math.random() - 0.5) * h * 1.2;
        dPos[i * 3 + 2] = -0.14 - Math.random() * 0.16;
      }
      dGeo.attributes.position.needsUpdate = true;
    };
    seedDust();
    let echoAcc = 0;
    return {
      name: 'Halo', group, fog: null,
      resize(W, H) { w = W; h = H; seedDust(); },
      update(dt, a, t) {
        hue += dt * 0.02 + (a.beat ? 0.09 : 0);
        const R0 = h * 0.19 * (1 + a.pulse * 0.12);
        // Echo layers: each takes the layer in front of it a few frames late.
        echoAcc += dt;
        if (echoAcc > 0.07) {
          echoAcc = 0;
          for (let l = LAYERS - 1; l > 0; l--) layers[l].hist.set(layers[l - 1].hist);
        }
        for (let k = 0; k < B; k++) {
          const u = Math.abs((k / B) * 2 - 1);                 // mirrored left/right
          layers[0].hist[k] = bandAt(a, (1 - u) * 0.75);
        }
        for (let l = 0; l < LAYERS; l++) {
          const L = layers[l];
          const barW = (2 * Math.PI * R0 / B) * 0.55;
          for (let k = 0; k < B; k++) {
            const th = (k / B) * Math.PI * 2 + Math.PI / 2;
            const len = 0.002 + L.hist[k] * h * 0.26 * (1 - l * 0.15);
            q.setFromAxisAngle(zAxis, th - Math.PI / 2);
            p.set(Math.cos(th) * R0, Math.sin(th) * R0, L.z + (l === 0 ? a.pulse * 0.02 : 0));
            s.set(barW, len, 1);
            m.compose(p, q, s);
            L.mesh.setMatrixAt(k, m);
          }
          L.mesh.instanceMatrix.needsUpdate = true;
          hsl(hue + l * 0.12, 0.9, 0.55 - l * 0.12);
          L.mesh.material.color.copy(color);
          L.mesh.rotation.z = Math.sin(t * 0.2) * 0.08 * (l + 1);
        }
        const ds = R0 * 1.85 * (1 + a.pulse * 0.25 + a.bass * 0.1);
        disc.scale.set(ds, ds, 1);
        disc.position.z = 0.02 + a.pulse * 0.035;
        hsl(hue + 0.5, 0.6, 0.35 + a.pulse * 0.35);
        disc.material.color.copy(color);
        dust.material.color.copy(hsl(hue + 0.3, 0.5, 0.35 + a.treble * 0.4));
        dust.rotation.z = t * 0.02;
        dust.position.z = a.pulse * 0.01;
      },
    };
  }

  return [spectrogram(), tunnel(), hyperspace(), ridgeline(), orb(), halo()];
}

// Ashima Arts / Stefan Gustavson 3D simplex noise (MIT): github.com/ashima/webgl-noise
const SNOISE = /* glsl */`
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+10.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 105.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;
