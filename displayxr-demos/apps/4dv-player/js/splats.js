// One decoded 4DV segment on the GPU: an instanced quad per splat, data in textures, drawn back to
// front in the order the sort worker hands over. The temporal model (position = mean + v·dt,
// opacity × exp(−½ dt²/σt²)) runs in the vertex shader, so playback between sorts stays smooth.
// Colour is the DC term plus spherical-harmonic bands 1..3 from the clip's shared codebook,
// evaluated per eye from that eye's own position, as 4DV.ai's viewer does. The footprint and the
// opacity-adaptive cut-off (√(2 ln(α/α_min)), at most 3.33σ) follow 4DV.ai's rasteriser too.
//
// uKind 1 is a .splatv (Spacetime Gaussians): cubic motion, a quaternion that turns over time and a
// per-axis scale, so Σ = R S² Rᵀ is rebuilt per frame instead of read from tCovA.

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
uniform sampler2D tLabel;
uniform sampler2D tSh;
uniform int uShK; // SH coefficients per channel beyond DC: 0, 3, 8 or 15
uniform int uShRow; // codebook entries per texture row
uniform int uKind; // 0 = .4dv, 1 = .splatv
uniform sampler2D tAcc;
uniform sampler2D tJerk;
uniform sampler2D tQuat;
uniform sampler2D tOmega;
uniform int uTexW;
uniform float uTime;
uniform vec2 uViewport;
uniform float uSplatScale;

in float splatIndex;
out vec4 vColor;
out vec2 vPos;
flat out float vCut2;

const float MIN_ALPHA = 1.0 / 255.0;

vec3 coeff(int base, int c) {
  int i = base + c;
  return texelFetch(tSh, ivec2(i % (uShRow * uShK), i / (uShRow * uShK)), 0).rgb;
}

// 4DV.ai's sh_coeffs_to_color_fast, bands 1..3, dir from the eye to the splat in the splats' frame.
vec3 shColor(int label, vec3 dir) {
  vec3 n = normalize(dir);
  float x = n.x, y = n.y, z = n.z;
  int b = label * uShK; // entry e, coefficient c = pixel e·k + c of a (uShRow·k)-wide image
  vec3 r = 0.48860252 * (-y * coeff(b, 0) + z * coeff(b, 1) - x * coeff(b, 2));
  if (uShK < 8) return r;
  float z2 = z * z;
  float t0 = -1.0925485 * z;
  float c1 = x * x - y * y;
  float s1 = 2.0 * x * y;
  r += 0.54627424 * s1 * coeff(b, 3) + t0 * y * coeff(b, 4) + (0.9461747 * z2 - 0.31539157) * coeff(b, 5)
     + t0 * x * coeff(b, 6) + 0.54627424 * c1 * coeff(b, 7);
  if (uShK < 15) return r;
  float t0c = -2.285229 * z2 + 0.4570458;
  float t1b = 1.4453057 * z;
  float c2 = x * c1 - y * s1;
  float s2 = x * s1 + y * c1;
  r += -0.5900436 * s2 * coeff(b, 8) + t1b * s1 * coeff(b, 9) + t0c * y * coeff(b, 10)
     + z * (1.8658817 * z2 - 1.119529) * coeff(b, 11) + t0c * x * coeff(b, 12) + t1b * c1 * coeff(b, 13)
     - 0.5900436 * c2 * coeff(b, 14);
  return r;
}

void main() {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  int idx = int(splatIndex + 0.5);
  ivec2 uv = ivec2(idx % uTexW, idx / uTexW);
  vec4 pt = texelFetch(tPosT, uv, 0);
  vec4 vl = texelFetch(tVel, uv, 0);
  vec4 col = texelFetch(tColor, uv, 0);
  float dt = uTime - pt.w;
  float alpha = col.a * exp(-0.5 * dt * dt * vl.w);
  if (alpha < MIN_ALPHA) return;

  vec3 p = pt.xyz + vl.xyz * dt;
  if (uKind == 1) p += texelFetch(tAcc, uv, 0).xyz * dt * dt + texelFetch(tJerk, uv, 0).xyz * dt * dt * dt;
  vec4 cam = modelViewMatrix * vec4(p, 1.0);
  vec4 clip = projectionMatrix * cam;
  float bound = 1.2 * clip.w;
  if (clip.w <= 0.0 || abs(clip.x) > bound || abs(clip.y) > bound) return;

  mat3 sigma;
  if (uKind == 1) {
    vec4 q = normalize(texelFetch(tQuat, uv, 0) + texelFetch(tOmega, uv, 0) * dt);
    float w = q.x, x = q.y, y = q.z, zq = q.w;
    mat3 R = mat3(
      1.0 - 2.0 * (y * y + zq * zq), 2.0 * (x * y + w * zq), 2.0 * (x * zq - w * y),
      2.0 * (x * y - w * zq), 1.0 - 2.0 * (x * x + zq * zq), 2.0 * (y * zq + w * x),
      2.0 * (x * zq + w * y), 2.0 * (y * zq - w * x), 1.0 - 2.0 * (x * x + y * y));
    vec3 sc = texelFetch(tCovA, uv, 0).xyz;
    sigma = R * mat3(sc.x * sc.x, 0.0, 0.0, 0.0, sc.y * sc.y, 0.0, 0.0, 0.0, sc.z * sc.z) * transpose(R);
  } else {
    vec4 ca = texelFetch(tCovA, uv, 0) * 1e-4;
    vec2 cb = texelFetch(tCovB, uv, 0).rg * 1e-4;
    sigma = mat3(ca.x, ca.y, ca.z, ca.y, ca.w, cb.x, ca.z, cb.x, cb.y);
  }
  sigma *= uSplatScale * uSplatScale;

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
  // Out to where this splat's Gaussian falls below 1/255: 3.33σ when opaque, less when faint.
  float cut = sqrt(2.0 * log(alpha / MIN_ALPHA));
  vec2 major = min(cut * sqrt(l1), 2048.0) * dir;
  vec2 minor = min(cut * sqrt(l2), 2048.0) * vec2(-dir.y, dir.x);

  vPos = position.xy * cut; // in σ units
  vCut2 = cut * cut;
  vec2 px = position.x * major + position.y * minor;
  gl_Position = clip + vec4(px / uViewport * 2.0 * clip.w, 0.0, 0.0);

  vec3 rgb = col.rgb;
  if (uShK > 0) {
    // The eye in the splats' own frame (the root is a rigid transform).
    vec3 eye = transpose(mat3(modelMatrix)) * (cameraPosition - modelMatrix[3].xyz);
    rgb += shColor(int(texelFetch(tLabel, uv, 0).r + 0.5), p - eye);
  }
  vColor = vec4(max(rgb, 0.0), alpha);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
in vec4 vColor;
in vec2 vPos;
flat in float vCut2;
out vec4 fragColor;
void main() {
  float r2 = dot(vPos, vPos);
  if (r2 > vCut2) discard;
  float a = exp(-0.5 * r2) * vColor.a;
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
      dataTexture(data.colorH, texW, rows, THREE.RGBAFormat, THREE.HalfFloatType),
      data.sh ? dataTexture(data.sh.labels, texW, rows, THREE.RedFormat, THREE.FloatType) : dataTexture(new Float32Array(1), 1, 1, THREE.RedFormat, THREE.FloatType),
      data.sh ? dataTexture(data.sh.book, data.sh.w, data.sh.h, THREE.RGBAFormat, THREE.HalfFloatType) : dataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType),
    ];
    const m = data.motion;
    const f4 = (a) => (a ? dataTexture(a, texW, rows, THREE.RGBAFormat, THREE.FloatType) : dataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType));
    this.textures.push(f4(m?.acc), f4(m?.jerk), f4(m?.quat), f4(m?.omega));
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.index = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    this.index.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('splatIndex', this.index);
    geo.instanceCount = 0;
    this.geometry = geo;
    const [tPosT, tVel, tCovA, tCovB, tColor, tLabel, tSh, tAcc, tJerk, tQuat, tOmega] = this.textures;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        tPosT: { value: tPosT }, tVel: { value: tVel }, tCovA: { value: tCovA }, tCovB: { value: tCovB }, tColor: { value: tColor },
        tLabel: { value: tLabel }, tSh: { value: tSh }, uShK: { value: data.sh ? data.sh.k : 0 }, uShRow: { value: data.sh?.perRow ?? 64 },
        uKind: { value: data.kind ?? 0 }, tAcc: { value: tAcc }, tJerk: { value: tJerk }, tQuat: { value: tQuat }, tOmega: { value: tOmega },
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
