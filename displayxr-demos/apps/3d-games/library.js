// The landing page's lists: the editor's top picks and the searchable library. TrueGame data comes
// from games.js (a snapshot of Acer's feed); Odyssey 3D titles are the ones Samsung has named
// publicly, since its Odyssey 3D Hub list isn't published on the web.

import { TRUEGAME, SNAPSHOT } from './games.js';

// Games Samsung has named for Odyssey 3D (GDC 2026 announcements and launch coverage).
const ODYSSEY = [
  { n: 'Stellar Blade' },
  { n: 'Lies of P', alias: 'Lies of P: Overture' },
  { n: 'The First Berserker: Khazan' },
  { n: 'MONGIL: STAR DIVE' },
  { n: 'Hell Is Us' },
  { n: 'Psychonauts 2' },
  { n: 'Cronos: The New Dawn', soon: true },
];

// Pages on this site with a playable woven diorama.
const PAGES = { 'TEKKEN 8': 'tekken-8.html', 'ELDEN RING': 'elden-ring.html', 'Diablo III': 'diablo-3.html' };

// Editor's picks, in order. Why each one carries the effect, judged on camera, depth range and HUD.
const PICKS = [
  ['ELDEN RING', 'Open-world action RPG', 'Layer after layer of hills, ruins and the golden tree on the horizon, with your character held at a steady depth by the third-person camera.'],
  ['TEKKEN 8', 'Fighting', 'A fixed side-on camera keeps both fighters right at the glass and the stage far behind it, so the depth never swings and never strains.'],
  ['Diablo III', 'Isometric action RPG', 'The isometric camera turns every room into a diorama on your desk. The whole scene sits in a shallow box, which is exactly what lenticular panels show best.'],
  ['Stellar Blade', 'Action', 'One of Samsung\'s showcase titles for Odyssey 3D: close third-person combat with lots of particle effects in front of the character.'],
  ['The First Berserker: Khazan', 'Soulslike', 'Samsung highlights its pop-out effects. Heavy hits and sparks come out past the glass.'],
  ['Street Fighter 6', 'Fighting', 'Same reason as Tekken: a locked camera, big readable characters and a deep stage behind them.'],
  ['Baldur\'s Gate 3', 'Isometric RPG', 'The tabletop view becomes a literal tabletop. Party members, spell areas and terrain heights become easy to read.'],
  ['Black Myth: Wukong', 'Action', 'Dense forests and temples give plenty of depth cues. A new 3D Ultra profile.'],
  ['Lies of P', 'Soulslike', 'On both platforms (Odyssey 3D lists Lies of P: Overture). Tight streets and lamplight give strong near and far contrast.'],
  ['Resident Evil 4', 'Survival horror', 'The over-the-shoulder camera puts Leon in the foreground with the threat behind him.'],
  ['OCTOPATH TRAVELER II', 'JRPG', 'HD-2D sprites on 3D sets look like a pop-up book. Probably the most charming effect on the list.'],
  ['Psychonauts 2', 'Platformer', 'Bright, stylised worlds built around depth, on both TrueGame and Odyssey 3D.'],
  ['Ori and the Will of the Wisps', '2.5D platformer', 'Painted parallax layers separate cleanly in 3D. The forest backgrounds sit well behind the glass.'],
  ['Little Nightmares III', 'Side-on horror', 'A dollhouse cutaway seen from the side. Small characters in big rooms show off scale.'],
  ['Hell Is Us', 'Action adventure', 'One of Samsung\'s newer Odyssey 3D additions: misty, layered environments.'],
  ['Stray', 'Adventure', 'A cat\'s-eye view of a neon city, with signs, cables and rooftops at every depth.'],
  ['Sekiro: Shadows Die Twice', 'Action', 'Vertical castles and grappling make height and distance easy to judge.'],
  ['God of War', 'Action', 'Big vistas from a close camera that never cuts away. A TrueGame launch title.'],
  ['Hollow Knight', '2D metroidvania', 'Hand-drawn foreground and background layers pull apart nicely, even in a 2D game.'],
  ['Forza Horizon 5', 'Racing', 'The 3D+ profile adds depth to the road ahead. Better from the chase camera than from the cockpit.'],
];

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Merge TrueGame and Odyssey 3D into one list keyed by name.
function buildLibrary() {
  const byKey = new Map();
  for (const g of TRUEGAME) byKey.set(norm(g.n), { ...g, ody: false, soon: false });
  for (const o of ODYSSEY) {
    const k = norm(o.n);
    const hit = byKey.get(k);
    if (hit) { hit.ody = true; hit.odyAlias = o.alias; continue; }
    byKey.set(k, { n: o.n, m: [], ody: true, soon: !!o.soon, l: '', d: '' });
  }
  return [...byKey.values()].sort((a, b) => a.n.localeCompare(b.n, 'en', { sensitivity: 'base' }));
}

const LIB = buildLibrary();
const find = (name) => LIB.find((g) => norm(g.n) === norm(name));

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}

function tags(g, extra = []) {
  const t = [...extra];
  if (g.m?.includes('ultra')) t.push(el('span', { class: 'tag ultra', title: 'Acer SpatialLabs TrueGame, 3D Ultra mode (stereo rendering with eye tracking)' }, 'TrueGame 3D Ultra'));
  if (g.m?.includes('plus')) t.push(el('span', { class: 'tag plus', title: 'Acer SpatialLabs TrueGame, 3D+ mode' }, 'TrueGame 3D+'));
  if (g.ody) t.push(el('span', { class: g.soon ? 'tag soon' : 'tag odyssey', title: g.odyAlias ? `Listed as ${g.odyAlias}` : 'Samsung Odyssey 3D Hub' }, g.soon ? 'Odyssey 3D · coming' : 'Odyssey 3D'));
  if (g.new) t.push(el('span', { class: 'tag new' }, 'New'));
  return el('div', { class: 'tags' }, t);
}

function displayName(n) {
  // Acer's feed shouts a few titles; show them the way the games style themselves.
  const fix = { 'TEKKEN 8': 'Tekken 8', 'TEKKEN 7': 'Tekken 7', 'ELDEN RING': 'Elden Ring', 'OCTOPATH TRAVELER II': 'Octopath Traveler II', 'OCTOPATH TRAVELER': 'Octopath Traveler' };
  return fix[n] || n;
}

// ---- top picks ---------------------------------------------------------------------------
const picksEl = document.getElementById('picks');
if (picksEl) {
  for (const [name, genre, why] of PICKS) {
    const g = find(name);
    if (!g) { console.warn('[3d-games] pick not in library:', name); continue; }
    const page = PAGES[g.n];
    const href = page || g.l || null;
    const title = href
      ? el('a', { href, ...(page ? {} : { target: '_blank', rel: 'noopener' }) }, displayName(g.n))
      : displayName(g.n);
    picksEl.append(el('li', { class: 'pick' },
      el('h3', {}, title),
      tags(g, [el('span', { class: 'tag genre' }, genre)]),
      el('p', {}, why),
      page ? el('a', { href: page, class: 'fine' }, 'Play the 3D diorama →') : null,
    ));
  }
}

// ---- library -----------------------------------------------------------------------------
const body = document.getElementById('lib-body');
if (body) {
  const q = document.getElementById('lib-q');
  const count = document.getElementById('lib-count');
  const chips = [...document.querySelectorAll('.chip[data-filter]')];
  let filter = 'all';
  let sort = { key: 'n', dir: 1 };

  const tests = {
    all: () => true,
    ultra: (g) => g.m.includes('ultra'),
    plus: (g) => g.m.includes('plus'),
    odyssey: (g) => g.ody,
    new: (g) => g.new,
    both: (g) => g.ody && g.m.length,
  };

  const render = () => {
    const needle = norm(q.value);
    const rows = LIB.filter((g) => tests[filter](g) && (!needle || norm(g.n).includes(needle) || (g.odyAlias && norm(g.odyAlias).includes(needle))));
    rows.sort((a, b) => {
      if (sort.key === 'd') return ((a.d || '0') < (b.d || '0') ? -1 : (a.d || '0') > (b.d || '0') ? 1 : 0) * sort.dir || a.n.localeCompare(b.n);
      return a.n.localeCompare(b.n, 'en', { sensitivity: 'base' }) * sort.dir;
    });
    body.replaceChildren(...rows.map((g) => {
      const page = PAGES[g.n];
      const name = g.l ? el('a', { href: g.l, target: '_blank', rel: 'noopener' }, displayName(g.n)) : displayName(g.n);
      return el('tr', {},
        el('td', { class: 'name' }, name, page ? el('a', { class: 'play', href: page }, '▶ 3D page') : null),
        el('td', {}, tags(g)),
        el('td', { class: 'added' }, g.d || '—'),
      );
    }));
    if (!rows.length) body.append(el('tr', {}, el('td', { class: 'lib-empty', colspan: '3' }, 'No games match. Try a shorter search.')));
    count.textContent = `${rows.length} of ${LIB.length} games`;
  };

  q.addEventListener('input', render);
  for (const c of chips) {
    c.addEventListener('click', () => {
      filter = c.dataset.filter;
      for (const o of chips) o.setAttribute('aria-pressed', String(o === c));
      render();
    });
  }
  for (const b of document.querySelectorAll('.lib th button[data-sort]')) {
    b.addEventListener('click', () => {
      const key = b.dataset.sort;
      sort = { key, dir: sort.key === key ? -sort.dir : key === 'd' ? -1 : 1 };
      render();
    });
  }
  render();
}

// ---- counts in the copy --------------------------------------------------------------------
const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
set('n-truegame', String(TRUEGAME.length));
set('n-truegame-2', String(TRUEGAME.length));
set('n-ultra', String(TRUEGAME.filter((g) => g.m.includes('ultra')).length));
set('n-new', String(TRUEGAME.filter((g) => g.new).length));
set('n-total', String(LIB.length));
for (const e of document.querySelectorAll('[data-snapshot]')) e.textContent = SNAPSHOT;
