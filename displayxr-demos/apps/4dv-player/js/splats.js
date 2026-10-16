// One decoded 4DV segment on the GPU: an instanced quad per splat, data in textures, drawn back to
// front in the order the sort worker hands over. The temporal model (position = mean + v·dt,
// opacity × exp(−½ dt²/σt²)) runs in the vertex shader, so playback between sorts stays smooth.

import * as THREE from 'three';

const vertexShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D tPosT;
uniform sampler2D tVel;
uniform sampler2D tCovA;
uniform sampler2D tCovB;
uniform sampler2D tColor;
uniform int uTexW;
uniform float uTime;
uniform vec2 uViewport;
uniform float uSplatScale;

in float splatIndex;
out vec4 vColor;
out vec2 vPos;

void main() {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  int idx = int(splatIndex + 0.5);
  ivec2 uv = ivec2(idx % uTexW, idx / uTexW);
  vec4 pt = texelFetch(tPosT, uv, 0);
  vec4 vl = texelFetch(tVel, uv, 0);
  vec4 col = texelFetch(tColor, uv, 0);
  float dt = uTime - pt.w;
  float alpha = col.a * exp(-0.5 * dt * dt * vl.w);
  if (alpha < 1.0 / 255.0) return;

  vec4 cam = modelViewMatrix * vec4(pt.xyz + vl.xyz * dt, 1.0);
  vec4 clip = projectionMatrix * cam;
  float bound = 1.2 * clip.w;
  if (clip.w <= 0.0 || abs(clip.x) > bound || abs(clip.y) > bound) return;

  vec4 ca = texelFetch(tCovA, uv, 0) * 1e-4;
  vec2 cb = texelFetch(tCovB, uv, 0).rg * 1e-4;
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
  // Major-axis angle of [[a b] [b d]].
  float theta = 0.5 * atan(2.0 * b, (a - d) + 1e-9);
  vec2 dir = vec2(cos(theta), sin(theta));
  vec2 major = min(sqrt(2.0 * l1), 1024.0) * dir;
  vec2 minor = min(sqrt(2.0 * l2), 1024.0) * vec2(-dir.y, dir.x);

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
out vec4 fragColor;
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

export class SplatSegment {
  /** @param data the loader worker's segment payload */
  constructor(data) {
    const { N, texW, rows } = data;
    this.N = N;
    this.textures = [
      dataTexture(data.posT, texW, rows, THREE.RGBAFormat, THREE.FloatType),
      dataTexture(data.velT, texW, rows, THREE.RGBAFormat, THREE.FloatType),
      dataTexture(data.covA, texW, rows, THREE.RGBAFormat, THREE.HalfFloatType),
      dataTexture(data.covB, texW, rows, THREE.RGFormat, THREE.HalfFloatType),
      dataTexture(data.color, texW, rows, THREE.RGBAFormat, THREE.UnsignedByteType),
    ];
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.index = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    this.index.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('splatIndex', this.index);
    geo.instanceCount = 0;
    this.geometry = geo;
    const [tPosT, tVel, tCovA, tCovB, tColor] = this.textures;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        tPosT: { value: tPosT }, tVel: { value: tVel }, tCovA: { value: tCovA }, tCovB: { value: tCovB }, tColor: { value: tColor },
        uTexW: { value: texW },
        uTime: { value: 0 },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uSplatScale: { value: 1 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.sorted = false;
  }

  /** Take a back-to-front order from the sort worker. */
  setOrder(order, count) {
    const n = Math.min(count, this.N);
    this.index.array.set(order.subarray(0, n));
    this.index.clearUpdateRanges();
    this.index.addUpdateRange(0, n);
    this.index.needsUpdate = true;
    this.geometry.instanceCount = n;
    this.sorted = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    for (const t of this.textures) t.dispose();
  }
}
