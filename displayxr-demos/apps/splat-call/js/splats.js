// The live Gaussian cloud on the GPU: an instanced quad per splat, data in textures that the
// reconstruction worker refills every frame, drawn back to front in the order it hands over.
// Adapted from the 4DV player's renderer (EWA splatting), without the temporal model.

import * as THREE from 'three';

const vertexShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D tPos;
uniform sampler2D tCovA;
uniform sampler2D tCovB;
uniform sampler2D tColor;
uniform int uTexW;
uniform vec2 uViewport;
uniform float uSplatScale;
uniform float uOpacity;
// Looks (looks.js STYLES): 0 natural, 1 hologram, 2 transporter, 3 toon, 4 yellow toon,
// 5 stone age, 6 portal acid, 7 neon 1985, 8 voxel, 9 gold statue.
uniform int uStyle;
uniform float uTime;
uniform float uBeam;     // transporter materialise, 0..1
uniform float uHideHead; // 1 = drop the head (a 3D avatar head replaces it)

in float splatIndex;
out vec4 vColor;
out vec2 vPos;

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
float poster(float v, float n) { return floor(v * n + 0.5) / n; }
bool isSkin(vec3 hsv) { return (hsv.x < 0.12 || hsv.x > 0.95) && hsv.y > 0.15 && hsv.y < 0.75 && hsv.z > 0.25; }

void main() {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  int idx = int(splatIndex + 0.5);
  ivec2 uv = ivec2(idx % uTexW, idx / uTexW);
  vec4 pa = texelFetch(tPos, uv, 0);
  vec4 col = texelFetch(tColor, uv, 0);
  float alpha = pa.w * uOpacity;
  if (alpha < 1.0 / 255.0) return;
  vec3 P = pa.xyz;
  vec3 c = col.rgb;
  float h = hash11(float(idx) * 1.37 + 0.5);
  if (uHideHead > 0.5) {
    vec3 q = (P - vec3(0.0, 0.04, -0.01)) / vec3(0.13, 0.175, 0.16);
    if (dot(q, q) < 1.0) return;
  }
  float L = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 hsv = rgb2hsv(c);
  bool voxel = false;
  if (uStyle == 1) {
    // Hologram: blue monochrome, flicker, a rolling glitch band.
    c = vec3(0.35, 0.72, 1.0) * (0.22 + 1.35 * L);
    float band = step(0.95, fract(P.y * 7.0 - uTime * 0.6));
    P.x += band * 0.01 * sin(uTime * 53.0);
    alpha *= (0.5 + 0.2 * hash11(floor(uTime * 20.0))) * (1.0 + band * 0.6);
  } else if (uStyle == 2) {
    // Transporter: gold sparkle, materialising splat by splat while uBeam rises.
    float sp = step(0.985, hash11(float(idx) + floor(uTime * 16.0) * 7.13));
    float reveal = smoothstep(h - 0.08, h + 0.02, uBeam);
    c = mix(vec3(1.0, 0.86, 0.5) * 1.3, c, reveal) + sp * vec3(1.0, 0.9, 0.6) * (1.0 - 0.6 * reveal);
    alpha *= max(reveal, sp * 0.8 * (1.0 - reveal) + (1.0 - reveal) * 0.15 * step(0.6, h));
    P.y += (1.0 - reveal) * (h - 0.5) * 0.06;
  } else if (uStyle == 3) {
    // Cel toon: flat bands, punchier colour.
    c = hsv2rgb(vec3(hsv.x, min(1.0, hsv.y * 1.35), poster(hsv.z, 4.0) * 0.92 + 0.08));
  } else if (uStyle == 4) {
    // Yellow toon: skin goes cartoon yellow, everything else flat and bright.
    if (isSkin(hsv)) c = vec3(1.0, 0.84, 0.12) * (0.55 + 0.45 * poster(hsv.z, 3.0));
    else c = hsv2rgb(vec3(hsv.x, min(1.0, hsv.y * 1.5 + 0.1), poster(hsv.z, 3.0) * 0.9 + 0.1));
  } else if (uStyle == 5) {
    // Stone age: warm earth palette, chunky bands, a little grit.
    float l = poster(L, 4.0) + (h - 0.5) * 0.08;
    c = mix(vec3(0.32, 0.2, 0.1), vec3(1.0, 0.82, 0.55), l);
    if (isSkin(hsv)) c = mix(c, vec3(1.0, 0.75, 0.55), 0.35);
  } else if (uStyle == 6) {
    // Portal acid: saturated, a green cast, wobbling like it came through a portal.
    c = isSkin(hsv) ? hsv2rgb(vec3(0.08, 0.28, poster(hsv.z, 3.0) * 0.6 + 0.4))
                   : hsv2rgb(vec3(hsv.x, min(1.0, hsv.y * 1.7 + 0.15), poster(hsv.z, 3.0) * 0.85 + 0.15));
    c = mix(c, vec3(0.35, 1.0, 0.45), 0.12);
    P.x += 0.004 * sin(uTime * 3.0 + P.y * 30.0);
  } else if (uStyle == 7) {
    // Neon 1985: a magenta/indigo duotone with cyan highlights.
    c = mix(vec3(0.06, 0.0, 0.18), vec3(1.0, 0.25, 0.65), smoothstep(0.05, 0.7, L));
    c = mix(c, vec3(0.3, 0.95, 1.0), smoothstep(0.62, 0.92, L));
  } else if (uStyle == 8) {
    // Voxel: snap to a 9 mm grid, square-ish blocks, flat colour.
    P = (floor(P / 0.009) + 0.5) * 0.009;
    c = vec3(poster(c.r, 6.0), poster(c.g, 6.0), poster(c.b, 6.0));
    voxel = true;
  } else if (uStyle == 9) {
    // Gold statue.
    c = mix(vec3(0.28, 0.16, 0.02), vec3(1.0, 0.82, 0.38), pow(L, 0.8)) + vec3(0.6, 0.5, 0.3) * smoothstep(0.78, 1.0, L);
  }

  vec4 cam = modelViewMatrix * vec4(P, 1.0);
  vec4 clip = projectionMatrix * cam;
  float bound = 1.2 * clip.w;
  if (clip.w <= 0.0 || abs(clip.x) > bound || abs(clip.y) > bound) return;

  // Covariance in mm², so half floats would do; we keep floats for simplicity.
  vec4 ca = texelFetch(tCovA, uv, 0) * 1e-6;
  vec2 cb = texelFetch(tCovB, uv, 0).rg * 1e-6;
  mat3 sigma = mat3(ca.x, ca.y, ca.z, ca.y, ca.w, cb.x, ca.z, cb.x, cb.y) * (uSplatScale * uSplatScale);
  if (voxel) sigma = mat3(1.0) * 0.0045 * 0.0045;

  // EWA splatting: screen covariance = J W Σ Wᵀ Jᵀ, with three's camera looking down −z.
  float fx = projectionMatrix[0][0] * uViewport.x * 0.5;
  float fy = projectionMatrix[1][1] * uViewport.y * 0.5;
  float z = -cam.z;
  mat3 J = mat3(fx / z, 0.0, 0.0, 0.0, fy / z, 0.0, fx * cam.x / (z * z), fy * cam.y / (z * z), 0.0);
  mat3 T = J * mat3(modelViewMatrix);
  mat3 c2 = T * sigma * transpose(T);
  float a = c2[0][0] + 0.3;
  float b = c2[0][1];
  float d = c2[1][1] + 0.3;
  float mid = 0.5 * (a + d);
  float rad = length(vec2(0.5 * (a - d), b));
  float l1 = mid + rad;
  float l2 = max(mid - rad, 0.1);
  vec2 dir = abs(b) < 1e-12 ? (a >= d ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) : normalize(vec2(b, l1 - a));
  vec2 major = min(sqrt(2.0 * l1), 1024.0) * dir;
  vec2 minor = min(sqrt(2.0 * l2), 1024.0) * vec2(dir.y, -dir.x);

  vPos = position.xy * 2.0;
  vec2 px = vPos.x * major + vPos.y * minor;
  gl_Position = clip + vec4(px / uViewport * 2.0 * clip.w, 0.0, 0.0);
  vColor = vec4(c, alpha);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;
uniform int uStyle;
in vec4 vColor;
in vec2 vPos;
layout(location = 0) out vec4 fragColor;
void main() {
  float r2 = dot(vPos, vPos);
  if (r2 > 4.0) discard;
  // Voxels: a flat-topped falloff reads as a block, not a blob.
  float a = (uStyle == 8 ? (1.0 - smoothstep(0.7, 1.6, max(abs(vPos.x), abs(vPos.y)))) : exp(-r2)) * vColor.a;
  if (a < 1.0 / 255.0) discard;
  vec3 c = vColor.rgb;
  // Scanlines for the hologram and the neon look.
  if (uStyle == 1 || uStyle == 7) c *= 0.72 + 0.28 * step(0.5, fract(gl_FragCoord.y * 0.34));
  fragColor = vec4(c * a, a);
}
`;

function dataTexture(array, w, h, format, type) {
  const t = new THREE.DataTexture(array, w, h, format, type);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

export const TEX_W = 1024;

export class LiveSplats {
  /** @param capacity the most splats one frame can hold */
  constructor(capacity) {
    this.capacity = capacity;
    const rows = Math.ceil(capacity / TEX_W);
    const n = TEX_W * rows;
    this.rows = rows;
    this.tPos = dataTexture(new Float32Array(n * 4), TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
    this.tCovA = dataTexture(new Float32Array(n * 4), TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
    this.tCovB = dataTexture(new Float32Array(n * 2), TEX_W, rows, THREE.RGFormat, THREE.FloatType);
    this.tColor = dataTexture(new Uint8Array(n * 4), TEX_W, rows, THREE.RGBAFormat, THREE.UnsignedByteType);

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.index = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.index.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('splatIndex', this.index);
    geo.instanceCount = 0;
    this.geometry = geo;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        tPos: { value: this.tPos }, tCovA: { value: this.tCovA }, tCovB: { value: this.tCovB }, tColor: { value: this.tColor },
        uTexW: { value: TEX_W },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uSplatScale: { value: 1 },
        uOpacity: { value: 1 },
        uStyle: { value: 0 },
        uTime: { value: 0 },
        uBeam: { value: 1 },
        uHideHead: { value: 0 },
      },
      transparent: true,
      // (major, minor) is a left-handed basis, so the quads come out back-facing.
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.count = 0;
  }

  /** Copy one frame from the worker: N splats packed in the worker's layout. */
  setFrame(f) {
    const n = Math.min(f.N, this.capacity);
    this.tPos.image.data.set(f.pos.subarray(0, n * 4));
    this.tCovA.image.data.set(f.covA.subarray(0, n * 4));
    this.tCovB.image.data.set(f.covB.subarray(0, n * 2));
    this.tColor.image.data.set(f.color.subarray(0, n * 4));
    for (const t of [this.tPos, this.tCovA, this.tCovB, this.tColor]) t.needsUpdate = true;
    this.setOrder(f.order, f.count);
  }

  /** Take a back-to-front order. */
  setOrder(order, count) {
    const n = Math.min(count, this.capacity);
    this.index.array.set(order.subarray(0, n));
    this.index.clearUpdateRanges();
    this.index.addUpdateRange(0, n);
    this.index.needsUpdate = true;
    this.geometry.instanceCount = n;
    this.count = n;
  }

  setViewport(v) {
    this.material.uniforms.uViewport.value.copy(v);
  }
}
