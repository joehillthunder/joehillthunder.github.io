// Sea and sky at golden hour. The waves are a sum of sines evaluated both in the ocean's vertex
// shader and on the CPU (waveHeight / waveSlope), so ships, buoys and wrecks ride the same swell
// the water shows.

import * as THREE from 'three';

export const SUN_DIR = new THREE.Vector3(-0.38, 0.2, -1).normalize();

// [dirX, dirZ, amplitude m, wavenumber rad/m, angular speed rad/s, phase]
const WAVES = [
  [1.0, 0.25, 0.045, 0.45, 0.95, 0.0],
  [-0.45, 1.0, 0.03, 0.7, 1.25, 1.7],
  [0.7, -0.7, 0.017, 1.25, 1.75, 3.1],
].map(([x, z, a, k, w, p]) => {
  const l = Math.hypot(x, z);
  return [x / l, z / l, a, k, w, p];
});

export function waveHeight(x, z, t) {
  let h = 0;
  for (const [dx, dz, a, k, w, p] of WAVES) h += a * Math.sin(k * (dx * x + dz * z) + w * t + p);
  return h;
}

/** dh/dx, dh/dz into out.x, out.y */
export function waveSlope(x, z, t, out) {
  let sx = 0, sz = 0;
  for (const [dx, dz, a, k, w, p] of WAVES) {
    const c = a * k * Math.cos(k * (dx * x + dz * z) + w * t + p);
    sx += c * dx;
    sz += c * dz;
  }
  out.x = sx;
  out.y = sz;
  return out;
}

const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const WAVE_GLSL = `
vec3 waveField(vec2 p, float t) {
  float h = 0.0, sx = 0.0, sz = 0.0, ph, a;
${WAVES.map(([dx, dz, a, k, w, p]) => `  ph = ${f(k)} * dot(vec2(${f(dx)}, ${f(dz)}), p) + ${f(w)} * t + ${f(p)};
  h += ${f(a)} * sin(ph); a = ${f(a * k)} * cos(ph); sx += a * ${f(dx)}; sz += a * ${f(dz)};`).join('\n')}
  return vec3(h, sx, sz);
}`;

const SKY_GLSL = `
uniform vec3 uZenith, uHorizon, uGlow, uSun, uSunCol;
vec3 skyColor(vec3 d) {
  float y = d.y;
  float h = clamp(y, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, pow(h, 0.42));
  float sd = max(dot(d, uSun), 0.0);
  col += uGlow * (pow(sd, 5.0) * 0.55 + pow(sd, 48.0) * 0.9);
  col = mix(col, uHorizon * 0.45, smoothstep(0.0, -0.2, y));
  return col;
}`;

function skyUniforms() {
  const c = (hex) => new THREE.Color(hex);
  return {
    uZenith: { value: c('#1d3061') },
    uHorizon: { value: c('#f0a46a') },
    uGlow: { value: c('#ffb36b') },
    uSun: { value: SUN_DIR.clone() },
    uSunCol: { value: c('#fff1d0').multiplyScalar(6) },
  };
}

export function createSky() {
  const uniforms = { ...skyUniforms(), uTime: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
        vec4 p = projectionMatrix * viewMatrix * vec4((modelMatrix * vec4(position, 1.0)).xyz, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: `
      ${SKY_GLSL}
      uniform float uTime;
      varying vec3 vDir;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = skyColor(d);
        float sd = max(dot(d, uSun), 0.0);
        col += uSunCol * smoothstep(0.9993, 0.99965, sd);
        // Clouds: a band of fbm above the horizon, lit warm from the sun side.
        if (d.y > 0.0) {
          vec2 uv = d.xz / (d.y + 0.12) * 1.6 + vec2(uTime * 0.004, 0.0);
          float cl = smoothstep(0.52, 0.85, fbm(uv));
          float band = smoothstep(0.0, 0.06, d.y) * (1.0 - smoothstep(0.35, 0.7, d.y));
          vec3 cc = mix(vec3(0.32, 0.22, 0.30), vec3(1.0, 0.62, 0.38), pow(sd, 3.0) * 0.9 + 0.15);
          col = mix(col, cc, cl * band * 0.85);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

export function createOcean() {
  const uniforms = {
    ...skyUniforms(),
    uTime: { value: 0 },
    uDeep: { value: new THREE.Color('#06213a') },
    uShallow: { value: new THREE.Color('#1a6d80') },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      ${WAVE_GLSL}
      uniform float uTime;
      varying vec3 vWorld;
      varying vec3 vN;
      varying float vH;
      void main() {
        vec3 w = (modelMatrix * vec4(position, 1.0)).xyz;
        // Calm the swell far away so the horizon stays clean.
        float fade = 1.0 - smoothstep(60.0, 220.0, length(w.xz));
        vec3 wf = waveField(w.xz, uTime) * fade;
        w.y += wf.x;
        vWorld = w;
        vH = wf.x;
        vN = normalize(vec3(-wf.y, 1.0, -wf.z));
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: `
      ${SKY_GLSL}
      uniform float uTime;
      uniform vec3 uDeep, uShallow;
      varying vec3 vWorld;
      varying vec3 vN;
      varying float vH;
      void main() {
        vec2 p = vWorld.xz;
        float t = uTime;
        // Fine ripples on top of the swell: only in the normal.
        vec2 rip = vec2(
          sin(dot(p, vec2(3.7, 1.3)) + t * 2.1) * 0.5 + sin(dot(p, vec2(-2.3, 5.1)) + t * 2.9) * 0.35 + sin(dot(p, vec2(7.9, -4.4)) + t * 3.7) * 0.2,
          sin(dot(p, vec2(1.1, 4.3)) + t * 1.7) * 0.5 + sin(dot(p, vec2(5.3, 2.2)) + t * 2.5) * 0.35 + sin(dot(p, vec2(-6.1, 8.2)) + t * 4.1) * 0.2);
        float dist = length(cameraPosition - vWorld);
        float detail = 0.09 * (1.0 - smoothstep(10.0, 90.0, dist));
        vec3 N = normalize(vN + vec3(rip.x, 0.0, rip.y) * detail);
        vec3 V = normalize(cameraPosition - vWorld);
        float ndv = max(dot(N, V), 0.0);
        float fres = 0.03 + 0.97 * pow(1.0 - ndv, 5.0);
        vec3 R = reflect(-V, N);
        R.y = abs(R.y);
        vec3 refl = skyColor(R);
        // Body colour, with light scattering through the backlit crests.
        vec3 body = mix(uDeep, uShallow, clamp(0.25 + vH * 5.0, 0.0, 1.0));
        float sss = pow(max(dot(V, -uSun), 0.0), 3.0) * clamp(0.3 + vH * 8.0, 0.0, 1.0);
        body += uGlow * sss * 0.18;
        vec3 col = mix(body, refl, fres);
        // Sun glitter.
        float spec = pow(max(dot(R, uSun), 0.0), 900.0) * 18.0 + pow(max(dot(R, uSun), 0.0), 90.0) * 0.6;
        col += uSunCol * spec * 0.25;
        // Foam on the highest crests.
        float foam = smoothstep(0.065, 0.1, vH) * (0.5 + 0.5 * sin(p.x * 9.0 + p.y * 7.0 + t * 3.0));
        col = mix(col, vec3(0.85, 0.82, 0.78), foam * 0.25);
        // Haze into the horizon.
        float fog = smoothstep(35.0, 320.0, dist);
        vec3 hz = skyColor(normalize(vec3(vWorld.x - cameraPosition.x, 0.02, vWorld.z - cameraPosition.z)));
        col = mix(col, hz, fog);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const geo = new THREE.PlaneGeometry(500, 500, 360, 360);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

/** Sun, sky fill, and an environment map built from the sky so steel picks up the sunset. */
export function createLighting(renderer, scene, sky) {
  const hemi = new THREE.HemisphereLight(0xc6d6ff, 0x16324a, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffd9b0, 2.0);
  sun.position.copy(SUN_DIR).multiplyScalar(60);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x6f8fd0, 0.6);
  fill.position.set(10, 14, 20);
  scene.add(fill);

  const envScene = new THREE.Scene();
  envScene.add(sky.clone());
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(envScene, 0, 0.1, 2000).texture;
  scene.environment = env;
  pmrem.dispose();
  return { hemi, sun, fill };
}
