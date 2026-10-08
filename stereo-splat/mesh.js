// mesh.js — the depth map as a textured triangle mesh for the DisplayXR 3D Model Viewer
// (displayxr-demo-modelviewer), as .obj (+ .mtl + .jpg) or as one self-contained .glb.
//
// What that viewer expects, and what this writes:
//   - glTF axes: +Y up, the viewer looking down −Z → OpenCV (x, y↓, z fwd) becomes (x, −y, −z),
//     and the subject distance is moved to the origin, where the viewer's fit and orbit centre it
//   - the photo as EMISSION over a black base colour (it has no KHR_materials_unlit), so the
//     mesh shows the photograph as captured under any lighting mode (L)
//   - OBJ: .mtl and texture resolved NEXT TO the .obj (shipped zipped); texcoords bottom-up
//   - GLB: one file, texture embedded as JPEG; texcoords top-down
// Depth edges: by default the triangles across them are kept, stretched over the gap a single
// viewpoint cannot see (the viewer frames the mesh from its own distance, not the capture
// camera's, so a cut edge would open a hole); `edgeRatio` cuts them instead.

/**
 * @typedef {{ disp: Float32Array, w: number, h: number, fx: number, baselineM: number,
 *             far: number, subjectZ: number, step?: number, edgeRatio?: number,
 *             depthScale?: number, name: string }} MeshOptions
 */

/**
 * The grid mesh, shared by both writers.
 *
 * @param {MeshOptions} o
 * @returns {{ gw: number, gh: number, P: Float32Array, N: Float32Array, UV: Float32Array,
 *             indices: Uint32Array }}  UV is glTF's (top-down v)
 */
export function buildDepthMesh(o) {
  const { disp, w, h, fx, baselineM, far, subjectZ } = o;
  const step = o.step ?? 2;
  const edgeRatio = o.edgeRatio ?? Infinity;
  // depth relief: 1 = as measured; < 1 pulls every point toward the subject plane ALONG ITS
  // RAY, so the mesh still lines up with the photo from the capture camera but needs less
  // stretching (or opens smaller gaps) when the viewer looks from anywhere else
  const relief = o.depthScale ?? 1;
  const cx = w / 2;
  const cy = h / 2;

  // grid columns/rows: every `step` pixels, always including the last
  const xs = [];
  for (let x = 0; x < w; x += step) xs.push(x);
  if (xs[xs.length - 1] !== w - 1) xs.push(w - 1);
  const ys = [];
  for (let y = 0; y < h; y += step) ys.push(y);
  if (ys[ys.length - 1] !== h - 1) ys.push(h - 1);
  const gw = xs.length;
  const gh = ys.length;

  // positions (viewer frame), texcoords and measured depth per grid vertex
  const P = new Float32Array(gw * gh * 3);
  const UV = new Float32Array(gw * gh * 2);
  const Z = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const x = xs[i];
      const y = ys[j];
      const d = disp[y * w + x];
      const zm = Math.min(far, d > 0.5 ? (fx * baselineM) / d : far);
      const z = Math.max(subjectZ * 0.05, subjectZ + (zm - subjectZ) * relief);
      const k = j * gw + i;
      Z[k] = zm;
      P[k * 3] = ((x + 0.5 - cx) * z) / fx;
      P[k * 3 + 1] = -((y + 0.5 - cy) * z) / fx;
      P[k * 3 + 2] = -z + subjectZ;
      UV[k * 2] = (x + 0.5) / w;
      UV[k * 2 + 1] = (y + 0.5) / h;
    }
  }

  // smooth normals from the grid (central differences), facing the viewer (+Z)
  const N = new Float32Array(gw * gh * 3);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const l = (j * gw + Math.max(0, i - 1)) * 3;
      const r = (j * gw + Math.min(gw - 1, i + 1)) * 3;
      const u = (Math.max(0, j - 1) * gw + i) * 3;
      const dn = (Math.min(gh - 1, j + 1) * gw + i) * 3;
      const ax = P[r] - P[l], ay = P[r + 1] - P[l + 1], az = P[r + 2] - P[l + 2]; // → right
      const bx = P[u] - P[dn], by = P[u + 1] - P[dn + 1], bz = P[u + 2] - P[dn + 2]; // → up
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz) || 1;
      if (nz < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const k = (j * gw + i) * 3;
      N[k] = nx / len;
      N[k + 1] = ny / len;
      N[k + 2] = nz / len;
    }
  }

  // two triangles per cell, counter-clockwise seen from +Z
  const idx = new Uint32Array((gw - 1) * (gh - 1) * 6);
  let n = 0;
  const tri = (a, b, c) => {
    const lo = Math.min(Z[a], Z[b], Z[c]);
    const hi = Math.max(Z[a], Z[b], Z[c]);
    if (hi > lo * edgeRatio) return; // a depth edge: leave the gap
    idx[n++] = a;
    idx[n++] = b;
    idx[n++] = c;
  };
  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const tl = j * gw + i;
      const tr = tl + 1;
      const bl = tl + gw;
      const br = bl + 1;
      tri(tl, bl, tr);
      tri(tr, bl, br);
    }
  }
  return { gw, gh, P, N, UV, indices: idx.slice(0, n) };
}

/**
 * @param {MeshOptions} o
 * @returns {{ obj: string, mtl: string, vertices: number, triangles: number }}
 */
export function buildObj(o) {
  const { name, subjectZ } = o;
  const { gw, gh, P, N, UV, indices } = buildDepthMesh(o);
  const V = gw * gh;
  const f = (v) => (Math.abs(v) < 5e-6 ? '0' : v.toFixed(5));
  const out = [
    `# Stereo Splat depth mesh — ${gw}×${gh} grid, metres, +Y up, viewer looks down -Z`,
    `# subject (${subjectZ.toFixed(3)} m from the camera) at the origin`,
    `mtllib ${name}.mtl`,
    `o ${name}`,
  ];
  for (let k = 0; k < V; k++) out.push(`v ${f(P[k * 3])} ${f(P[k * 3 + 1])} ${f(P[k * 3 + 2])}`);
  for (let k = 0; k < V; k++) out.push(`vt ${UV[k * 2].toFixed(5)} ${(1 - UV[k * 2 + 1]).toFixed(5)}`); // OBJ v is bottom-up
  for (let k = 0; k < V; k++) out.push(`vn ${f(N[k * 3])} ${f(N[k * 3 + 1])} ${f(N[k * 3 + 2])}`);
  out.push(`usemtl ${name}`, 's 1');
  for (let t = 0; t < indices.length; t += 3) {
    const A = indices[t] + 1, B = indices[t + 1] + 1, C = indices[t + 2] + 1; // 1-based; v/vt/vn share it
    out.push(`f ${A}/${A}/${A} ${B}/${B}/${B} ${C}/${C}/${C}`);
  }

  const mtl = [
    `# Photo as emission: the DisplayXR viewer shows it as captured under every lighting mode.`,
    `newmtl ${name}`,
    'Ka 0 0 0',
    'Kd 0 0 0',
    'Ks 0 0 0',
    'Ns 0',
    'Ke 1 1 1',
    `map_Ke ${name}.jpg`,
    `map_Kd ${name}.jpg`,
    'd 1',
    'illum 0',
    '',
  ].join('\n');

  return { obj: out.join('\n') + '\n', mtl, vertices: V, triangles: indices.length / 3 };
}

/**
 * One self-contained glTF 2.0 binary: the mesh plus the photo embedded as JPEG.
 *
 * @param {MeshOptions} o
 * @param {Uint8Array} jpeg  the texture
 * @returns {{ glb: Uint8Array, vertices: number, triangles: number }}
 */
export function buildGlb(o, jpeg) {
  const { name, subjectZ } = o;
  const { gw, gh, P, N, UV, indices } = buildDepthMesh(o);
  const V = gw * gh;

  // binary chunk: each view 4-byte aligned
  const parts = [P, N, UV, indices, jpeg];
  const views = [];
  let off = 0;
  for (const p of parts) {
    views.push({ byteOffset: off, byteLength: p.byteLength });
    off += (p.byteLength + 3) & ~3;
  }
  const bin = new Uint8Array(off);
  parts.forEach((p, i) => bin.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), views[i].byteOffset));

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < V; k++) {
    for (let a = 0; a < 3; a++) {
      const v = P[k * 3 + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }

  const ARRAY_BUFFER = 34962;
  const ELEMENT_ARRAY_BUFFER = 34963;
  const FLOAT = 5126;
  const UNSIGNED_INT = 5125;
  const LINEAR = 9729;
  const CLAMP_TO_EDGE = 33071;
  const gltf = {
    asset: { version: '2.0', generator: 'Stereo Splat (joehillthunder.github.io/stereo-splat)' },
    extras: { note: `Depth mesh from a stereo photo; metres; subject (${subjectZ.toFixed(3)} m from the camera) at the origin` },
    scene: 0,
    scenes: [{ name, nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    meshes: [
      {
        name,
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0, mode: 4 }],
      },
    ],
    materials: [
      {
        name,
        // the photo as emission over black: unchanged by the viewer's lighting
        pbrMetallicRoughness: { baseColorFactor: [0, 0, 0, 1], metallicFactor: 0, roughnessFactor: 1 },
        emissiveTexture: { index: 0 },
        emissiveFactor: [1, 1, 1],
        doubleSided: true,
      },
    ],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: LINEAR, minFilter: LINEAR, wrapS: CLAMP_TO_EDGE, wrapT: CLAMP_TO_EDGE }],
    images: [{ bufferView: 4, mimeType: 'image/jpeg' }],
    accessors: [
      { bufferView: 0, componentType: FLOAT, count: V, type: 'VEC3', min, max },
      { bufferView: 1, componentType: FLOAT, count: V, type: 'VEC3' },
      { bufferView: 2, componentType: FLOAT, count: V, type: 'VEC2' },
      { bufferView: 3, componentType: UNSIGNED_INT, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, ...views[0], target: ARRAY_BUFFER },
      { buffer: 0, ...views[1], target: ARRAY_BUFFER },
      { buffer: 0, ...views[2], target: ARRAY_BUFFER },
      { buffer: 0, ...views[3], target: ELEMENT_ARRAY_BUFFER },
      { buffer: 0, ...views[4] },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  };

  // JSON chunk padded with spaces, BIN chunk with zeros (already aligned)
  const raw = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLen = (raw.length + 3) & ~3;
  const json = new Uint8Array(jsonLen).fill(0x20);
  json.set(raw);
  const total = 12 + 8 + jsonLen + 8 + bin.byteLength;
  const glb = new Uint8Array(total);
  const dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  glb.set(json, 20);
  dv.setUint32(20 + jsonLen, bin.byteLength, true);
  dv.setUint32(24 + jsonLen, 0x004e4942, true); // 'BIN\0'
  glb.set(bin, 28 + jsonLen);
  return { glb, vertices: V, triangles: indices.length / 3 };
}
