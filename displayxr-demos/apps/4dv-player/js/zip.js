// Minimal zip reader over a Blob: reads the central directory, then any entry on demand.
// A .4dv file is a plain zip (stored or deflated entries), so nothing more is needed.

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);

export class Zip {
  /** @param {Blob} blob */
  constructor(blob) {
    this.blob = blob;
    this.entries = new Map();
  }

  async open() {
    const size = this.blob.size;
    const tail = Math.min(size, 65557);
    const end = new DataView(await this.blob.slice(size - tail).arrayBuffer());
    let eocd = -1;
    for (let i = end.byteLength - 22; i >= 0; i--) {
      if (u32(end, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a .4dv file (no zip directory found).');
    const count = u16(end, eocd + 10);
    const cdSize = u32(end, eocd + 12);
    const cdOffset = u32(end, eocd + 16);
    const cd = new DataView(await this.blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
      if (u32(cd, p) !== 0x02014b50) throw new Error('Corrupt .4dv directory.');
      const method = u16(cd, p + 10);
      const csize = u32(cd, p + 20);
      const usize = u32(cd, p + 24);
      const nl = u16(cd, p + 28), el = u16(cd, p + 30), cl = u16(cd, p + 32);
      const local = u32(cd, p + 42);
      const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nl));
      this.entries.set(name, { name, method, csize, usize, local });
      p += 46 + nl + el + cl;
    }
    return this;
  }

  has(name) {
    return this.entries.has(name);
  }

  /** The entry's bytes as a Blob (inflated if it was deflated). */
  async blobOf(name, type = '') {
    const e = this.entries.get(name);
    if (!e) throw new Error(`Missing ${name} in the .4dv file.`);
    const h = new DataView(await this.blob.slice(e.local, e.local + 30).arrayBuffer());
    const start = e.local + 30 + u16(h, 26) + u16(h, 28);
    const raw = this.blob.slice(start, start + e.csize, type);
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new Error(`Unsupported zip method ${e.method} for ${name}.`);
    const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Blob([await new Response(stream).arrayBuffer()], { type });
  }

  async json(name) {
    return JSON.parse(await (await this.blobOf(name)).text());
  }
}
