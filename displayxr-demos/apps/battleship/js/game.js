// Rules and the computer opponent. No three.js here: this is the part that decides who hit what.

import { N } from './util.js';

export const FLEET = [
  { id: 'carrier', name: 'Carrier', len: 5 },
  { id: 'battleship', name: 'Battleship', len: 4 },
  { id: 'cruiser', name: 'Cruiser', len: 3 },
  { id: 'submarine', name: 'Submarine', len: 3 },
  { id: 'destroyer', name: 'Destroyer', len: 2 },
];
export const FLEET_BY_ID = Object.fromEntries(FLEET.map((s) => [s.id, s]));

// What a player knows about the other board.
export const UNKNOWN = 0, MISS = 1, HIT = 2, SUNK = 3;

export function shipCells(r, c, len, dir) {
  const out = [];
  for (let i = 0; i < len; i++) out.push(dir === 'h' ? [r, c + i] : [r + i, c]);
  return out;
}

export class Fleet {
  constructor() {
    this.ships = []; // { id, name, len, r, c, dir, cells, hits: Set<idx> }
  }

  shipAt(r, c) {
    return this.ships.find((s) => s.cells.some(([a, b]) => a === r && b === c)) || null;
  }

  canPlace(len, r, c, dir, ignoreId = null) {
    for (const [a, b] of shipCells(r, c, len, dir)) {
      if (a < 0 || b < 0 || a >= N || b >= N) return false;
      const other = this.shipAt(a, b);
      if (other && other.id !== ignoreId) return false;
    }
    return true;
  }

  place(id, r, c, dir) {
    const def = FLEET_BY_ID[id];
    if (!this.canPlace(def.len, r, c, dir, id)) return null;
    this.remove(id);
    const ship = { ...def, r, c, dir, cells: shipCells(r, c, def.len, dir), hits: new Set() };
    this.ships.push(ship);
    return ship;
  }

  remove(id) {
    this.ships = this.ships.filter((s) => s.id !== id);
  }

  clear() {
    this.ships = [];
  }

  randomize() {
    for (let attempt = 0; attempt < 200; attempt++) {
      this.clear();
      let ok = true;
      for (const def of FLEET) {
        let placed = false;
        for (let k = 0; k < 400 && !placed; k++) {
          const dir = Math.random() < 0.5 ? 'h' : 'v';
          const r = Math.floor(Math.random() * N), c = Math.floor(Math.random() * N);
          placed = !!this.place(def.id, r, c, dir);
        }
        if (!placed) { ok = false; break; }
      }
      if (ok) return;
    }
  }

  get complete() {
    return this.ships.length === FLEET.length;
  }

  isSunk(ship) {
    return ship.hits.size >= ship.len;
  }

  get allSunk() {
    return this.ships.length > 0 && this.ships.every((s) => this.isSunk(s));
  }

  /** A shot lands on this fleet. */
  receive(r, c) {
    const ship = this.shipAt(r, c);
    if (!ship) return { hit: false, sunk: null, allSunk: false };
    ship.hits.add(r * N + c);
    const sunk = this.isSunk(ship) ? publicShip(ship) : null;
    return { hit: true, shipId: ship.id, sunk, allSunk: this.allSunk };
  }
}

/** The part of a ship the other player learns when it sinks. */
export function publicShip(s) {
  return { id: s.id, name: s.name, len: s.len, r: s.r, c: s.c, dir: s.dir };
}

export class Player {
  constructor(name, kind = 'human', level = 'normal') {
    this.name = name;
    this.kind = kind; // 'human' | 'ai' | 'remote'
    this.level = level;
    this.reset();
  }

  reset() {
    this.fleet = new Fleet();
    this.known = new Int8Array(N * N); // my knowledge of the other board
    this.sunkEnemies = []; // publicShip records
    this.received = []; // shots that landed on my fleet: { r, c, hit, sunk }
    this.seen = 0; // how many of `received` this player has watched (hot seat)
    this.stats = { shots: 0, hits: 0 };
    this.ready = false;
  }

  get enemyShipsLeft() {
    return FLEET.length - this.sunkEnemies.length;
  }
}

/** Record a resolved shot on both players. */
export function applyShot(shooter, defender, r, c, res) {
  shooter.stats.shots++;
  if (res.hit) shooter.stats.hits++;
  shooter.known[r * N + c] = res.hit ? HIT : MISS;
  if (res.sunk) {
    for (const [a, b] of shipCells(res.sunk.r, res.sunk.c, res.sunk.len, res.sunk.dir)) shooter.known[a * N + b] = SUNK;
    shooter.sunkEnemies.push(res.sunk);
  }
  defender.received.push({ r, c, hit: res.hit, sunk: res.sunk || null });
}

// ---------------------------------------------------------------------------------------------
// Computer opponent. Every level scores cells by how many ways the remaining ships could cover
// them (a probability density); open hits make placements through them far more likely, which
// gives the classic "hunt, then finish the ship" behaviour without special cases.

export function aiPick(known, sunkEnemies, level = 'normal') {
  const free = [];
  for (let i = 0; i < N * N; i++) if (known[i] === UNKNOWN) free.push(i);
  if (!free.length) return null;
  const sunkIds = new Set(sunkEnemies.map((s) => s.id));
  const lens = FLEET.filter((s) => !sunkIds.has(s.id)).map((s) => s.len);
  const openHits = [];
  for (let i = 0; i < N * N; i++) if (known[i] === HIT) openHits.push(i);

  if (level === 'easy') {
    // Random, but it does finish a ship it has found half the time.
    if (openHits.length && Math.random() < 0.5) {
      const near = neighbours(openHits).filter((i) => known[i] === UNKNOWN);
      if (near.length) return toRC(near[Math.floor(Math.random() * near.length)]);
    }
    return toRC(free[Math.floor(Math.random() * free.length)]);
  }

  let score = density(known, lens, openHits.length > 0);
  if (score.every((v) => v === 0)) score = density(known, lens, false);
  if (!openHits.length && level === 'normal') {
    // Hunt on a checkerboard; the smallest ship is 2 long, so it can't hide between squares.
    for (let i = 0; i < N * N; i++) if (((i / N | 0) + (i % N)) % 2) score[i] *= 0.15;
  }
  let best = -1;
  const top = [];
  for (const i of free) {
    const s = score[i] * (level === 'normal' ? 0.85 + Math.random() * 0.3 : 1);
    if (s > best + 1e-6) { best = s; top.length = 0; top.push(i); }
    else if (Math.abs(s - best) <= 1e-6) top.push(i);
  }
  return toRC(top[Math.floor(Math.random() * top.length)]);
}

function density(known, lens, needHit) {
  const score = new Float32Array(N * N);
  for (const len of lens) {
    for (const dir of ['h', 'v']) {
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          const cells = shipCells(r, c, len, dir);
          let ok = true, hits = 0;
          for (const [a, b] of cells) {
            if (a >= N || b >= N) { ok = false; break; }
            const k = known[a * N + b];
            if (k === MISS || k === SUNK) { ok = false; break; }
            if (k === HIT) hits++;
          }
          if (!ok || (needHit && !hits)) continue;
          const w = needHit ? 1 + hits * 25 : 1;
          for (const [a, b] of cells) if (known[a * N + b] === UNKNOWN) score[a * N + b] += w;
        }
      }
    }
  }
  return score;
}

function neighbours(idxs) {
  const out = [];
  for (const i of idxs) {
    const r = (i / N) | 0, c = i % N;
    if (r > 0) out.push(i - N);
    if (r < N - 1) out.push(i + N);
    if (c > 0) out.push(i - 1);
    if (c < N - 1) out.push(i + 1);
  }
  return out;
}

const toRC = (i) => ({ r: (i / N) | 0, c: i % N });
