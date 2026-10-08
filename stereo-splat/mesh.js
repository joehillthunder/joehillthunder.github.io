// mesh.js — the depth map as a textured triangle mesh (.obj + .mtl + .jpg) for the DisplayXR 3D
// Model Viewer (displayxr-demo-modelviewer), which loads OBJ through tinyobjloader.
//
// What that loader expects, and what this writes:
//   - .mtl and textures resolved NEXT TO the .obj → shipped as one zip of three files
//   - PNG/JPEG textures; OBJ texcoords bottom-up (the loader flips V)
//   - glTF axes: +Y up, the viewer looking down −Z → OpenCV (x, y↓, z fwd) becomes (x, −y, −z),
//     and the subject distance is moved to the origin, where the viewer's fit and orbit centre it
//   - its Phong→PBR shim maps Ke/map_Ke to emissive: the photo is put there with a black
//     diffuse, so the mesh shows the photograph as captured under any lighting mode (L)
// Depth edges: by default the triangles across them are kept, stretched over the gap a single
// viewpoint cannot see (the viewer frames the mesh from its own distance, not the capture
// camera's, so a cut edge would open a hole); `edgeRatio` cuts them instead.

/**
 * @param {{ disp: Float32Array, w: number, h: number, fx: number, baselineM: number,
 *           far: number, subjectZ: number, step?: number, edgeRatio?: number, depthScale?: number,
 *           name: string }} o
 * @returns {{ obj: string, mtl: string, vertices: number, triangles: number }}
 */
export function buildObj(o) {
  const { disp, w, h, fx, baselineM, far, subjectZ, name } = o;
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

  // positions (viewer frame) and depth per grid vertex
  const P = new Float32Array(gw * gh * 3);
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

  const f = (v) => (Math.abs(v) < 5e-6 ? '0' : v.toFixed(5));
  const out = [
    `# Stereo Splat depth mesh — ${gw}×${gh} grid, metres, +Y up, viewer looks down -Z`,
    `# subject (${subjectZ.toFixed(3)} m from the camera) at the origin`,
    `mtllib ${name}.mtl`,
    `o ${name}`,
  ];
  for (let k = 0; k < gw * gh; k++) out.push(`v ${f(P[k * 3])} ${f(P[k * 3 + 1])} ${f(P[k * 3 + 2])}`);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) out.push(`vt ${((xs[i] + 0.5) / w).toFixed(5)} ${(1 - (ys[j] + 0.5) / h).toFixed(5)}`);
  }
  for (let k = 0; k < gw * gh; k++) out.push(`vn ${f(N[k * 3])} ${f(N[k * 3 + 1])} ${f(N[k * 3 + 2])}`);
  out.push(`usemtl ${name}`, 's 1');

  let triangles = 0;
  const tri = (a, b, c) => {
    const lo = Math.min(Z[a], Z[b], Z[c]);
    const hi = Math.max(Z[a], Z[b], Z[c]);
    if (hi > lo * edgeRatio) return; // a depth edge: leave the gap
    const A = a + 1, B = b + 1, C = c + 1; // OBJ is 1-based; v/vt/vn share the index
    out.push(`f ${A}/${A}/${A} ${B}/${B}/${B} ${C}/${C}/${C}`);
    triangles++;
  };
  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const tl = j * gw + i;
      const tr = tl + 1;
      const bl = tl + gw;
      const br = bl + 1;
      tri(tl, bl, tr); // counter-clockwise seen from +Z
      tri(tr, bl, br);
    }
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

  return { obj: out.join('\n') + '\n', mtl, vertices: gw * gh, triangles };
}
