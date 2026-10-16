// Web Mercator maths, tile fetching and elevation decoding for Terra Studio.
//
// Elevation: AWS Terrain Tiles (Terrarium PNG, metres = R*256 + G + B/256 - 32768, zoom <= 15).
// Basemaps: Esri World Imagery / World Topographic, and OpenStreetMap. All send CORS headers, so the
// stitched canvases stay untainted and can be exported into a .glb.

export const TILE = 256;
const R_EARTH = 6378137;

export const BASEMAPS = {
  Imagery: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', credit: 'Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community' },
  Topographic: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', credit: 'Basemap: Esri, HERE, Garmin, USGS, NGA and contributors' },
  Streets: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', credit: '© OpenStreetMap contributors' },
  Hillshade: { url: null, credit: '' },
  'Elevation tint': { url: null, credit: '' },
};
export const ELEVATION_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const ELEVATION_CREDIT = 'Elevation: Mapzen Terrain Tiles on AWS (SRTM, GMTED, NED, ETOPO1 and others)';

export const PLACES = [
  { name: 'Grand Canyon', lat: 36.0975, lon: -112.0965, z: 12 },
  { name: 'Mount Everest', lat: 27.9881, lon: 86.925, z: 12 },
  { name: 'Yosemite Valley', lat: 37.7375, lon: -119.575, z: 13 },
  { name: 'Matterhorn', lat: 45.9763, lon: 7.6586, z: 13 },
  { name: 'Mount Fuji', lat: 35.3606, lon: 138.7274, z: 12 },
  { name: 'Mount St. Helens', lat: 46.1912, lon: -122.1944, z: 13 },
  { name: 'San Francisco', lat: 37.7793, lon: -122.4193, z: 15, buildings: true },
  { name: 'Manhattan', lat: 40.758, lon: -73.9855, z: 15, buildings: true },
];

export function lonLatToPx(lon, lat, z) {
  const n = TILE * 2 ** z;
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

export function pxToLonLat(x, y, z) {
  const n = TILE * 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon, lat];
}

export const metresPerPx = (lat, z) => (2 * Math.PI * R_EARTH * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** z);

/** Great-circle distance in metres. */
export function haversine(lon1, lat1, lon2, lat2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

function loadImg(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Stitch a G x G block of tiles starting at (tx0, ty0) into one canvas. Returns { canvas, failed }. */
export async function stitch(template, z, tx0, ty0, G, onProgress) {
  const c = document.createElement('canvas');
  c.width = c.height = G * TILE;
  const g = c.getContext('2d', { willReadFrequently: true });
  let failed = 0, done = 0;
  const n = 2 ** z;
  await Promise.all(Array.from({ length: G * G }, async (_, i) => {
    const tx = tx0 + (i % G), ty = ty0 + Math.floor(i / G);
    const url = template.replace('{z}', z).replace('{x}', ((tx % n) + n) % n).replace('{y}', ty);
    const img = await loadImg(url);
    if (img) g.drawImage(img, (i % G) * TILE, Math.floor(i / G) * TILE);
    else failed++;
    onProgress?.(++done, G * G);
  }));
  return { canvas: c, failed };
}

/** Decode a stitched Terrarium canvas into metres. */
export function decodeTerrarium(canvas) {
  const N = canvas.width;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, N, N).data;
  const h = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
  return h;
}

/** A plausible mountain range for offline use (or a heightmap that failed to load). */
export function proceduralDEM(N, seed = 7) {
  const h = new Float32Array(N * N);
  const rnd = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453; return s - Math.floor(s); };
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = rnd(xi, yi), b = rnd(xi + 1, yi), c = rnd(xi, yi + 1), d = rnd(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0, amp = 1, f = 3 / N;
    for (let o = 0; o < 7; o++) { const n = 1 - Math.abs(noise(x * f, y * f) * 2 - 1); s += n * n * amp; amp *= 0.5; f *= 2; }
    h[y * N + x] = 400 + s * 1500;
  }
  return h;
}

/** Height-map image (grey = elevation) to metres. */
export function decodeHeightImage(img, N, maxH) {
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, N, N);
  const d = g.getImageData(0, 0, N, N).data;
  const h = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) h[i] = ((d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) / 255) * maxH;
  return h;
}

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

/** OSM building footprints in a bbox, via the Overpass API (with a mirror as fallback). */
export async function fetchBuildings(s, w, n, e) {
  const q = `[out:json][timeout:25];(way["building"](${s},${w},${n},${e}););out geom 4000;`;
  let json, lastErr;
  for (const host of OVERPASS) {
    try {
      const res = await fetch(host, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      json = await res.json();
      break;
    } catch (e) { lastErr = e; }
  }
  if (!json) throw lastErr;
  return json.elements.filter((el) => el.geometry?.length > 2).map((el) => {
    const t = el.tags || {};
    let height = parseFloat(t.height) || (parseFloat(t['building:levels']) || 0) * 3.2;
    if (!height) height = 8 + ((el.id * 2654435761) % 1000) / 1000 * 10;
    return { ring: el.geometry.map((p) => [p.lon, p.lat]), height, name: t.name };
  });
}

/** Parse CSV text into rows of objects (handles quoted fields). */
export function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift().map((h) => h.trim().toLowerCase());
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]?.trim()])));
}
