// sog.js — encode a splat table as .sog with PlayCanvas splat-transform, carrying a DisplayXR
// `camera` block in its meta.json.
//
// splat-transform writes the SOG planes (means, quats, scales, sh0 as WebP) and meta.json. It is
// asked for the UNBUNDLED form so meta.json can be extended before the zip is made: the camera
// block is what tells the DisplayXR viewer "this splat is a photograph, reopen it at the camera
// that took it" (see vendor/inline3d/js/inline3d-sog.js). The zip itself is stored, not
// deflated — the WebP planes are already compressed.
//
// The splat-transform module is passed in, so the same code runs in the browser (jsDelivr ESM)
// and under Node (tests).

/**
 * @param {typeof import('@playcanvas/splat-transform')} st
 * @param {Record<string, Float32Array>} columns  x y z scale_* rot_* f_dc_* opacity (PLY space)
 * @param {object | null} camera  the meta.json `camera` block, or null for none
 * @returns {Promise<Uint8Array>} the .sog bytes
 */
export async function encodeSog(st, columns, camera) {
  const { DataTable, Column, Transform, MemoryFileSystem, writeSog } = st;
  // The columns are already in PLY space (OpenCV camera frame). Declaring the table as PLY space
  // makes splat-transform's bake to PLY space an identity: the bytes keep our coordinates.
  const table = new DataTable(
    Object.entries(columns).map(([n, a]) => new Column(n, a)),
    Transform.PLY,
  );
  const fs = new MemoryFileSystem();
  await writeSog({ filename: 'meta.json', dataTable: table, bundle: false, iterations: 10, logging: 'silent' }, fs);

  const files = [];
  let meta = null;
  for (const [name, data] of fs.results) {
    const base = name.split(/[\\/]/).pop();
    if (base === 'meta.json') meta = JSON.parse(new TextDecoder().decode(data));
    else files.push([base, data]);
  }
  if (!meta) throw new Error('splat-transform wrote no meta.json');
  if (camera) {
    // The block goes right after `count`, as the DisplayXR reader documents; key order is cosmetic.
    const { version, asset, count, ...rest } = meta;
    meta = { version, asset, count, camera, ...rest };
  }
  files.unshift(['meta.json', new TextEncoder().encode(JSON.stringify(meta))]);
  return zipStored(files);
}

// ── a minimal PKZip writer (method 0, no zip64) ───────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {Array<[string, Uint8Array]>} files */
export function zipStored(files) {
  const enc = new TextEncoder();
  const entries = files.map(([name, data]) => ({ name: enc.encode(name), data, crc: crc32(data) }));
  const localSize = entries.reduce((s, e) => s + 30 + e.name.length + e.data.length, 0);
  const cenSize = entries.reduce((s, e) => s + 46 + e.name.length, 0);
  const out = new Uint8Array(localSize + cenSize + 22);
  const dv = new DataView(out.buffer);
  let p = 0;
  const offsets = [];
  for (const e of entries) {
    offsets.push(p);
    dv.setUint32(p, 0x04034b50, true);
    dv.setUint16(p + 4, 20, true); // version needed
    dv.setUint16(p + 6, 0x0800, true); // UTF-8 names
    dv.setUint16(p + 8, 0, true); // stored
    dv.setUint32(p + 14, e.crc, true);
    dv.setUint32(p + 18, e.data.length, true);
    dv.setUint32(p + 22, e.data.length, true);
    dv.setUint16(p + 26, e.name.length, true);
    out.set(e.name, p + 30);
    out.set(e.data, p + 30 + e.name.length);
    p += 30 + e.name.length + e.data.length;
  }
  const cen = p;
  entries.forEach((e, i) => {
    dv.setUint32(p, 0x02014b50, true);
    dv.setUint16(p + 4, 20, true); // version made by
    dv.setUint16(p + 6, 20, true);
    dv.setUint16(p + 8, 0x0800, true);
    dv.setUint16(p + 10, 0, true);
    dv.setUint32(p + 16, e.crc, true);
    dv.setUint32(p + 20, e.data.length, true);
    dv.setUint32(p + 24, e.data.length, true);
    dv.setUint16(p + 28, e.name.length, true);
    dv.setUint32(p + 42, offsets[i], true);
    out.set(e.name, p + 46);
    p += 46 + e.name.length;
  });
  dv.setUint32(p, 0x06054b50, true);
  dv.setUint16(p + 8, entries.length, true);
  dv.setUint16(p + 10, entries.length, true);
  dv.setUint32(p + 12, p - cen, true);
  dv.setUint32(p + 16, cen, true);
  return out;
}

/**
 * The DisplayXR `camera` block (v2) for a rectified stereo capture.
 *
 * @param {{ eyeWidth: number, eyeHeight: number, fx: number, baselineM: number, subjectZ: number,
 *           near: number, far: number, source: 'convergence' | 'auto' }} c  fx in eye pixels
 */
export function cameraBlock(c) {
  return {
    convention: 'opencv',
    rig: 'camera',
    rest: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    intrinsics: { fx: c.fx, fy: c.fx, cx: c.eyeWidth / 2, cy: c.eyeHeight / 2, width: c.eyeWidth, height: c.eyeHeight },
    stereo: { baseline_m: c.baselineM },
    focus: { point: [0, 0, c.subjectZ], subject_m: c.subjectZ, near_m: c.near, far_m: c.far, source: c.source },
  };
}
