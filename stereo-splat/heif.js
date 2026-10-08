// heif.js — open an iPhone / Vision Pro spatial photo (HEIC stereo pair) as a side-by-side pair.
//
// A spatial photo is a HEIF file with two top-level images and a `ster` entity group naming
// them (ISO/IEC 23008-12: the first entity is the LEFT view, the second the RIGHT). Each image
// can carry `cmin` (intrinsics, relative to the image width) and `cmex` (extrinsics, position in
// micrometres): the baseline is the distance between the two camera positions.
//
// Pixels come from libheif (WebAssembly, HEVC included); the metadata is read here, straight
// from the boxes, because libheif-js does not surface entity groups or camera matrices.

const LIBHEIF_URL = 'https://cdn.jsdelivr.net/npm/libheif-js@1.23.2/libheif-wasm/libheif-bundle.mjs';

/** Is this a HEIF/HEIC file? (ftyp with an image brand) */
export function isHeif(bytes) {
  if (bytes.length < 12) return false;
  const t = String.fromCharCode(...bytes.subarray(4, 8));
  const brand = String.fromCharCode(...bytes.subarray(8, 12));
  return t === 'ftyp' && /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1|mif2|avif)$/.test(brand);
}

// ── box reader ────────────────────────────────────────────────────────────────────────────

function boxes(dv, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
    let hdr = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(p + 8));
      hdr = 16;
    } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
const child = (list, type) => list.find((b) => b.type === type);

/**
 * Read what a spatial photo says about itself.
 *
 * @param {Uint8Array} bytes
 * @returns {{ stereo: [number, number] | null, primary: number | null,
 *             props: Map<number, { cmin?: object, cmex?: object, ispe?: { width: number, height: number } }> }}
 */
export function readHeifStereoMeta(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = boxes(dv, 0, dv.byteLength);
  const meta = child(top, 'meta');
  const result = { stereo: null, primary: null, props: new Map() };
  if (!meta) return result;
  const mb = boxes(dv, meta.start + 4, meta.end); // meta is a FullBox

  const pitm = child(mb, 'pitm');
  if (pitm) result.primary = dv.getUint8(pitm.start) === 0 ? dv.getUint16(pitm.start + 4) : dv.getUint32(pitm.start + 4);

  const grpl = child(mb, 'grpl');
  if (grpl) {
    for (const g of boxes(dv, grpl.start, grpl.end)) {
      if (g.type !== 'ster') continue;
      const n = dv.getUint32(g.start + 8);
      if (n >= 2) result.stereo = [dv.getUint32(g.start + 12), dv.getUint32(g.start + 16)];
    }
  }

  const iprp = child(mb, 'iprp');
  if (!iprp) return result;
  const ib = boxes(dv, iprp.start, iprp.end);
  const ipco = child(ib, 'ipco');
  if (!ipco) return result;
  const props = boxes(dv, ipco.start, ipco.end); // 1-based in ipma
  for (const ipma of ib.filter((b) => b.type === 'ipma')) {
    const version = dv.getUint8(ipma.start);
    const flags = dv.getUint32(ipma.start) & 0xffffff;
    let p = ipma.start + 4;
    const count = dv.getUint32(p);
    p += 4;
    for (let i = 0; i < count && p < ipma.end; i++) {
      const id = version < 1 ? dv.getUint16(p) : dv.getUint32(p);
      p += version < 1 ? 2 : 4;
      const n = dv.getUint8(p++);
      const rec = result.props.get(id) ?? {};
      for (let k = 0; k < n; k++) {
        const idx = flags & 1 ? dv.getUint16(p) & 0x7fff : dv.getUint8(p) & 0x7f;
        p += flags & 1 ? 2 : 1;
        const box = props[idx - 1];
        if (!box) continue;
        if (box.type === 'ispe') rec.ispe = { width: dv.getUint32(box.start + 4), height: dv.getUint32(box.start + 8) };
        else if (box.type === 'cmin') rec.cmin = parseCmin(dv, box);
        else if (box.type === 'cmex') rec.cmex = parseCmex(dv, box);
      }
      result.props.set(id, rec);
    }
  }
  return result;
}

function parseCmin(dv, b) {
  if (dv.getUint8(b.start) !== 0) return null;
  const flags = dv.getUint32(b.start) & 0xffffff;
  const den = 2 ** ((flags & 0x1f00) >> 8);
  const p = b.start + 4;
  const fx = dv.getInt32(p) / den;
  return {
    fx,
    cx: dv.getInt32(p + 4) / den,
    cy: dv.getInt32(p + 8) / den,
    fy: flags & 1 ? dv.getInt32(p + 12) / den : fx,
  };
}

function parseCmex(dv, b) {
  if (dv.getUint8(b.start) !== 0) return null;
  const flags = dv.getUint32(b.start) & 0xffffff;
  let p = b.start + 4;
  const pos = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    if (flags & (1 << a)) {
      pos[a] = dv.getInt32(p);
      p += 4;
    }
  }
  return { positionUm: pos };
}

// ── decode ────────────────────────────────────────────────────────────────────────────────

let libPromise = null;
const loadLibheif = () => (libPromise ??= import(LIBHEIF_URL).then((m) => m.default()));

/**
 * Decode a spatial photo into one side-by-side bitmap (left eye left) plus what the file says.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<{ bitmap: ImageBitmap, eyeWidth: number, height: number,
 *   baselineMm: number | null, hfovDeg: number | null, ordered: boolean }>}
 */
export async function decodeSpatialPhoto(bytes) {
  const meta = readHeifStereoMeta(bytes);
  const libheif = await loadLibheif();
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(bytes);
  const ids = libheif.heif_js_context_get_list_of_top_level_image_IDs(decoder.decoder) || [];
  if (images.length < 2) {
    throw new Error(`This HEIC has ${images.length} image${images.length === 1 ? '' : 's'}, not a stereo pair. Export it as a spatial photo.`);
  }
  const byId = new Map(images.map((img, i) => [ids[i], img]));

  // left/right: the `ster` group. Without one, only two images that both carry a camera
  // position are taken as a pair (primary = left) — any other multi-image HEIC (bursts, edits)
  // is not stereo.
  let leftId;
  let rightId;
  let ordered = false;
  if (meta.stereo && byId.has(meta.stereo[0]) && byId.has(meta.stereo[1])) {
    [leftId, rightId] = meta.stereo;
    ordered = true;
  } else {
    leftId = byId.has(meta.primary) ? meta.primary : ids[0];
    rightId = ids.find((id) => id !== leftId);
    if (!meta.props.get(leftId)?.cmex || !meta.props.get(rightId)?.cmex) {
      for (const img of images) img.free?.();
      throw new Error('This HEIC is not a spatial photo: it has no stereo pair group. On iPhone, share it from Photos as a spatial photo.');
    }
  }
  const L = byId.get(leftId);
  const R = byId.get(rightId);

  const rgba = (img) =>
    new Promise((resolve, reject) => {
      const width = img.get_width();
      const height = img.get_height();
      img.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (d) =>
        d ? resolve(new ImageData(d.data, width, height)) : reject(new Error('HEIC decoding failed')),
      );
    });
  const [li, ri] = await Promise.all([rgba(L), rgba(R)]);
  for (const img of images) img.free?.();
  decoder.free?.();

  // one SBS canvas; a right eye of a different size is scaled to the left's
  const W = li.width;
  const H = li.height;
  const c = new OffscreenCanvas(W * 2, H);
  const g = c.getContext('2d');
  g.putImageData(li, 0, 0);
  if (ri.width === W && ri.height === H) g.putImageData(ri, W, 0);
  else g.drawImage(await createImageBitmap(ri), W, 0, W, H);
  const bitmap = await createImageBitmap(c);

  // baseline: distance between the two camera positions (µm → mm)
  const pl = meta.props.get(leftId)?.cmex?.positionUm;
  const pr = meta.props.get(rightId)?.cmex?.positionUm;
  const baselineMm = pl && pr ? Math.hypot(pl[0] - pr[0], pl[1] - pr[1], pl[2] - pr[2]) / 1000 : null;

  // horizontal FOV from the left eye's intrinsics (relative to width; tolerate absolute pixels)
  const lp = meta.props.get(leftId);
  let hfovDeg = null;
  if (lp?.cmin?.fx > 0) {
    const fxRel = lp.cmin.fx > 8 ? lp.cmin.fx / (lp.ispe?.width || W) : lp.cmin.fx;
    hfovDeg = (2 * Math.atan(0.5 / fxRel) * 180) / Math.PI;
  }

  return {
    bitmap,
    eyeWidth: W,
    height: H,
    baselineMm: baselineMm > 0.5 && baselineMm < 1000 ? baselineMm : null,
    hfovDeg: hfovDeg > 5 && hfovDeg < 170 ? hfovDeg : null,
    ordered,
  };
}
