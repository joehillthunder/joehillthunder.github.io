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

in float splatIndex;
out vec4 vColor;
out vec2 vPos;

void main() {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  int idx = int(splatIndex + 0.5);
  ivec2 uv = ivec2(idx % uTexW, idx / uTexW);
  vec4 pa = texelFetch(tPos, uv, 0);
  vec4 col = texelFetch(tColor, uv, 0);
  float alpha = pa.w * uOpacity;
  if (alpha < 1.0 / 255.0) return;

  vec4 cam = modelViewMatrix * vec4(pa.xyz, 1.0);
  vec4 clip = projectionMatrix * cam;
  float bound = 1.2 * clip.w;
  if (clip.w <= 0.0 || abs(clip.x) > bound || abs(clip.y) > bound) return;

  // Covariance in mm², so half floats would do; we keep floats for simplicity.
  vec4 ca = texelFetch(tCovA, uv, 0) * 1e-6;
  vec2 cb = texelFetch(tCovB, uv, 0).rg * 1e-6;
  mat3 sigma = mat3(ca.x, ca.y, ca.z, ca.y, ca.w, cb.x, ca.z, cb.x, cb.y) * (uSplatScale * uSplatScale);

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
  vColor = vec4(col.rgb, alpha);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
in vec4 vColor;
in vec2 vPos;
layout(location = 0) out vec4 fragColor;
void main() {
  float r2 = dot(vPos, vPos);
  if (r2 > 4.0) discard;
  float a = exp(-r2) * vColor.a;
  if (a < 1.0 / 255.0) discard;
  fragColor = vec4(vColor.rgb * a, a);
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
