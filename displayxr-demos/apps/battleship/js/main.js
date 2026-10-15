// Game flow: menu → fleet placement → turns → victory, for pass-and-play, online, vs computer and
// watch modes. The 3D work lives in world.js; the rules in game.js.

import { World } from './world.js';
import { Sfx } from './audio.js';
import { Net, makeCode } from './net.js';
import { FLEET, Player, applyShot, aiPick, UNKNOWN } from './game.js';
import { N, cellName, sleep } from './util.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const sfx = new Sfx();
const canvas = $('#stage');
const world = new World(canvas, sfx);

const G = {
  mode: null, // 'local' | 'ai' | 'online' | 'watch'
  P: [],
  viewer: 0,
  turn: 0,
  phase: 'menu', // menu | place | handoff | aim | busy | wait | over
  sel: null,
  dir: 'h',
  cursor: { r: 4, c: 4 },
  hover: null,
  rules: { bonus: false },
  net: null,
  queue: Promise.resolve(),
  pendingResult: null,
  gen: 0, // bumps on every new game so stale async turns stop
};
window.battleship = { G, world };

// ---------------------------------------------------------------------------------------------
// HUD helpers

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function setTurn(html, tone = '') {
  const t = $('#turn');
  if (!html) { t.hidden = true; return; }
  t.innerHTML = html;
  t.dataset.tone = tone;
  t.hidden = false;
}

function hint(text) {
  const h = $('#hint');
  h.hidden = !text;
  if (text) h.innerHTML = text;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pips = (len, hits = 0) => `<span class="pips">${Array.from({ length: len }, (_, i) => `<i class="${i < hits ? 'hit' : ''}"></i>`).join('')}</span>`;

function updateFleets() {
  const me = G.P[G.viewer], foe = G.P[1 - G.viewer];
  if (!me || G.phase === 'menu' || G.phase === 'place' || G.phase === 'handoff') {
    $('#fleet-me').hidden = $('#fleet-foe').hidden = true;
    return;
  }
  $('#fleet-me').hidden = $('#fleet-foe').hidden = false;
  $('#me-name').textContent = me.name;
  $('#foe-name').textContent = foe.name;
  const seen = me.received.slice(0, me.seen);
  $('#fleet-me ul').innerHTML = me.fleet.ships.map((s) => {
    const hits = seen.filter((x) => x.hit && s.cells.some(([r, c]) => r === x.r && c === x.c)).length;
    return `<li class="${hits >= s.len ? 'sunk' : ''}"><span>${s.name}</span>${pips(s.len, hits)}</li>`;
  }).join('');
  const sunk = new Set(me.sunkEnemies.map((s) => s.id));
  $('#fleet-foe ul').innerHTML = FLEET.map((s) => `<li class="${sunk.has(s.id) ? 'sunk' : ''}"><span>${s.name}</span>${pips(s.len, sunk.has(s.id) ? s.len : 0)}</li>`).join('');
  const st = (p) => `${p.stats.shots} shots · ${p.stats.hits} hits · ${p.stats.shots ? Math.round((100 * p.stats.hits) / p.stats.shots) : 0}%`;
  $('#fleet-me .stats').textContent = st(me);
  $('#fleet-foe .stats').textContent = G.mode === 'online' ? '' : st(foe);
}

function showDialog(id) {
  for (const d of ['#menu', '#online', '#handoff', '#end']) $(d).hidden = d !== id;
}

// ---------------------------------------------------------------------------------------------
// Menu

function toMenu() {
  G.gen++;
  G.queue = Promise.resolve();
  G.pendingResult = null;
  G.phase = 'menu';
  G.net?.close();
  G.net = null;
  setTurn('');
  hint('');
  $('#place').hidden = true;
  document.body.classList.remove('placing');
  updateFleets();
  showDialog('#menu');
  showcase();
  world.camTo('orbit', 2);
}

function showcase() {
  const a = new Player('Blue'), b = new Player('Red');
  a.fleet.randomize();
  b.fleet.randomize();
  world.showcase(a.fleet, b.fleet);
}

for (const b of document.querySelectorAll('.mode[data-mode]')) {
  b.addEventListener('click', () => {
    sfx.unlock();
    sfx.click();
    const mode = b.dataset.mode;
    if (mode === 'online') { openOnline(); return; }
    newGame(mode);
  });
}

function readOpts() {
  return {
    n1: $('#name1').value.trim() || 'Player 1',
    n2: $('#name2').value.trim() || 'Player 2',
    level: $('#level').value,
    bonus: $('#bonus').checked,
  };
}

function newGame(mode, o = readOpts()) {
  G.gen++;
  G.queue = Promise.resolve(); // a stale chain (say, a shot to an opponent who left) must not block this game
  G.pendingResult = null;
  G.mode = mode;
  G.rules.bonus = !!o.bonus;
  if (mode === 'local') G.P = [new Player(o.n1), new Player(o.n2)];
  else if (mode === 'ai') G.P = [new Player(o.n1), new Player('Admiral Byte', 'ai', o.level)];
  else if (mode === 'watch') G.P = [new Player('Blue Fleet', 'ai', 'hard'), new Player('Red Fleet', 'ai', 'normal')];
  else if (mode === 'online') G.P = [new Player(o.n1), new Player(o.opp || 'Opponent', 'remote')];
  G.P[0].team = mode === 'online' && !G.net?.isHost ? 1 : 0;
  G.P[1].team = 1 - G.P[0].team;
  G.turn = mode === 'online' && !G.net?.isHost ? 1 : 0;
  G.viewer = 0;
  for (const p of G.P) if (p.kind === 'ai') { p.fleet.randomize(); p.ready = true; }
  showDialog(null);
  $('#end').hidden = true;
  if (mode === 'watch') { beginBattle(); return; }
  startPlacement(0);
}

// ---------------------------------------------------------------------------------------------
// Placement

function startPlacement(pi) {
  G.phase = 'place';
  G.viewer = pi;
  const me = G.P[pi];
  world.setViewer(me, G.P[1 - pi]);
  world.target.setTitle('ENEMY WATERS');
  world.camTo('place', 1.6);
  G.dir = 'h';
  G.sel = FLEET.find((d) => !me.fleet.ships.some((s) => s.id === d.id))?.id || null;
  $('#place').hidden = false;
  document.body.classList.add('placing');
  hint('');
  setTurn(`<b>${esc(me.name)}</b>, deploy your fleet<small>${G.mode === 'local' ? 'Keep it secret from the other player' : 'Five ships, any layout'}</small>`, 'wait');
  renderChips();
  updateFleets();
}

function renderChips() {
  const me = G.P[G.viewer];
  $('#ship-chips').innerHTML = FLEET.map((d) => {
    const done = me.fleet.ships.some((s) => s.id === d.id);
    return `<button type="button" data-id="${d.id}" class="${done ? 'done' : ''} ${G.sel === d.id ? 'sel' : ''}">${d.name}${pips(d.len)}</button>`;
  }).join('');
  for (const b of document.querySelectorAll('#ship-chips button')) {
    b.addEventListener('click', () => {
      G.sel = b.dataset.id;
      sfx.click();
      renderChips();
      refreshGhost();
    });
  }
  $('#ready').disabled = !me.fleet.complete;
}

function refreshGhost() {
  if (G.phase !== 'place') return;
  const h = G.hover;
  if (!G.sel || !h) { world.hideGhost(); return; }
  const len = FLEET.find((d) => d.id === G.sel).len;
  const ok = G.P[G.viewer].fleet.canPlace(len, h.r, h.c, G.dir, G.sel);
  world.showGhost(G.sel, h.r, h.c, len, G.dir, ok);
}

function placeAt(r, c) {
  const me = G.P[G.viewer];
  const there = me.fleet.shipAt(r, c);
  if (there && there.id !== G.sel) {
    // pick it up to move it
    me.fleet.remove(there.id);
    world.home.removeShip(there.id);
    G.sel = there.id;
    G.dir = there.dir;
    sfx.click(600);
    renderChips();
    refreshGhost();
    return;
  }
  if (!G.sel) return;
  const ship = me.fleet.place(G.sel, r, c, G.dir);
  if (!ship) { sfx.click(220); toast("It doesn't fit there"); return; }
  world.home.addShip(ship, me.team);
  const p = world.home.cellWorld(r, c);
  world.fx.ripple(world.home.shipCenterLocal(ship.r, ship.c, ship.len, ship.dir).add(world.home.center), 1.6);
  world.fx.ripple(p, 0.8);
  sfx.clunk();
  G.sel = FLEET.find((d) => !me.fleet.ships.some((s) => s.id === d.id))?.id || null;
  renderChips();
  refreshGhost();
}

function rotate() {
  G.dir = G.dir === 'h' ? 'v' : 'h';
  sfx.click(700);
  refreshGhost();
}

$('#rotate').addEventListener('click', rotate);
$('#random').addEventListener('click', () => {
  const me = G.P[G.viewer];
  me.fleet.randomize();
  for (const id of [...world.home.ships.keys()]) world.home.removeShip(id);
  me.fleet.ships.forEach((s, i) => setTimeout(() => { world.home.addShip(s, me.team); world.fx.ripple(world.home.shipCenterLocal(s.r, s.c, s.len, s.dir).add(world.home.center), 1.4); sfx.clunk(); }, i * 110));
  G.sel = null;
  renderChips();
  world.hideGhost();
});
$('#clear').addEventListener('click', () => {
  const me = G.P[G.viewer];
  me.fleet.clear();
  for (const id of [...world.home.ships.keys()]) world.home.removeShip(id);
  G.sel = FLEET[0].id;
  renderChips();
  refreshGhost();
});
$('#ready').addEventListener('click', () => {
  const me = G.P[G.viewer];
  if (!me.fleet.complete) return;
  me.ready = true;
  sfx.ping();
  $('#place').hidden = true;
  document.body.classList.remove('placing');
  world.hideGhost();
  if (G.mode === 'local') {
    if (G.viewer === 0 && !G.P[1].ready) handoff(1, `${G.P[1].name}, it's your turn to hide your fleet. ${G.P[0].name}, look away!`, () => startPlacement(1));
    else beginBattle();
  } else if (G.mode === 'online') {
    G.net.send({ t: 'placed' });
    G.phase = 'wait';
    if (G.P[1].ready) beginBattle();
    else { setTurn(`Fleet ready<small>Waiting for ${esc(G.P[1].name)} to deploy…</small>`, 'wait'); world.camTo('both'); }
  } else beginBattle();
});

// ---------------------------------------------------------------------------------------------
// Pass & play hand-off: the boards are wiped while the screen changes hands.

function handoff(to, text, then) {
  G.phase = 'handoff';
  world.clearBoards();
  world.home.setTitle('');
  world.target.setTitle('');
  world.camTo('orbit', 1.6);
  setTurn('');
  hint('');
  updateFleets();
  $('#handoff-title').textContent = `PASS TO ${G.P[to].name.toUpperCase()}`;
  $('#handoff-text').textContent = text;
  showDialog('#handoff');
  $('#handoff-go').onclick = () => {
    sfx.unlock();
    sfx.click();
    showDialog(null);
    then();
  };
}

// ---------------------------------------------------------------------------------------------
// Battle

function beginBattle() {
  G.phase = 'busy';
  if (G.mode !== 'local') {
    G.viewer = 0;
    world.setViewer(G.P[0], G.P[1], { reveal: G.mode === 'watch' });
    updateFleets();
  }
  toast('All ships ready. Commence firing!');
  turnStart();
}

async function turnStart() {
  const gen = G.gen;
  const shooter = G.P[G.turn];
  if (G.mode === 'local' && G.viewer !== G.turn) {
    const foe = G.P[1 - G.turn];
    const incoming = shooter.received.length - shooter.seen;
    handoff(G.turn, incoming ? `${foe.name} fired. ${shooter.name}, take the screen and see where it landed.` : `${shooter.name}, take the screen. ${foe.name}, no peeking!`, async () => {
      G.viewer = G.turn;
      world.setViewer(shooter, foe);
      updateFleets();
      await replayUnseen(shooter);
      if (gen === G.gen) aim();
    });
    return;
  }
  if (shooter.kind === 'human') { await replayUnseen(shooter); if (gen === G.gen) aim(); }
  else if (shooter.kind === 'ai') await aiTurn(gen);
  else waitRemote();
}

async function replayUnseen(p) {
  if (p.seen >= p.received.length) return;
  G.phase = 'busy';
  setTurn(`<b>Incoming!</b><small>${esc(G.P[1 - G.viewer].name)} fired at your fleet</small>`, 'wait');
  await world.camTo('home', 1.2);
  while (p.seen < p.received.length) {
    const rec = p.received[p.seen];
    await world.incoming(rec.r, rec.c);
    p.seen++;
    await world.impact('home', rec.r, rec.c, rec, G.P[1 - G.viewer].team);
    updateFleets();
  }
  await sleep(300);
}

function aim() {
  G.phase = 'aim';
  const me = G.P[G.turn];
  world.camTo('target', 1.3);
  setTurn(`<b>${esc(me.name)}</b>: fire!<small>Pick a square in ${esc(G.P[1 - G.turn].name)}'s waters</small>`, 'fire');
  hint('Click a square to fire · arrows + <kbd>Enter</kbd> work too');
  updateFleets();
  sfx.ping();
  if (G.hover) showReticle(G.hover);
}

function showReticle(cell) {
  const me = G.P[G.turn];
  const ok = me.known[cell.r * N + cell.c] === UNKNOWN;
  world.target.resetTints();
  world.target.setTint(cell.r, cell.c, ok ? [255, 200, 60, 140] : [90, 110, 130, 90]);
  const p = world.target.cellWorld(cell.r, cell.c);
  world.reticle.show(p, ok);
}

function fire(r, c) {
  if (G.phase !== 'aim') return;
  const shooter = G.P[G.turn];
  if (shooter.known[r * N + c] !== UNKNOWN) { sfx.click(200); toast(`Already fired at ${cellName(r, c)}`); return; }
  G.phase = 'busy';
  enqueue(() => doFire(r, c));
}

// Shots and turn changes run one at a time, so a shot that arrives from the network while one is
// still exploding waits its turn.
function enqueue(fn) {
  G.queue = G.queue.then(fn).catch((e) => console.error('[battleship]', e));
}

async function doFire(r, c) {
  const gen = G.gen;
  const shooter = G.P[G.turn], defender = G.P[1 - G.turn];
  world.reticle.hide();
  world.target.resetTints();
  hint('');
  setTurn(`<b>${cellName(r, c)}</b>: missile away!`, 'fire');
  const resP = defender.kind === 'remote' ? remoteResult(r, c) : Promise.resolve(defender.fleet.receive(r, c));
  const [res] = await Promise.all([resP, world.outgoing(r, c)]);
  if (gen !== G.gen) return;
  applyShot(shooter, defender, r, c, res);
  await world.impact('target', r, c, res, defender.team);
  if (gen !== G.gen) return;
  updateFleets();
  afterShot(res, G.turn);
}

function afterShot(res, shooterIdx) {
  if (res.allSunk) { gameOver(shooterIdx); return; }
  if (G.rules.bonus && res.hit) {
    if (G.P[shooterIdx].kind === 'human') toast('Hit! Fire again');
    enqueue(() => sleep(300).then(turnStart));
    return;
  }
  G.turn = 1 - shooterIdx;
  enqueue(() => sleep(G.mode === 'local' ? 1400 : 500).then(turnStart));
}

async function aiTurn(gen) {
  G.phase = 'busy';
  const ai = G.P[G.turn], foe = G.P[1 - G.turn];
  const foeIsViewer = 1 - G.turn === G.viewer;
  setTurn(`<b>${esc(ai.name)}</b> is taking aim…`, 'wait');
  await world.camTo(foeIsViewer ? 'home' : 'target', 1.2);
  await sleep(G.mode === 'watch' ? 300 : 600);
  if (gen !== G.gen) return;
  const { r, c } = aiPick(ai.known, ai.sunkEnemies, ai.level);
  const res = foe.fleet.receive(r, c);
  setTurn(`<b>${esc(ai.name)}</b> fires at ${cellName(r, c)}`, 'wait');
  if (foeIsViewer) {
    await world.incoming(r, c);
    applyShot(ai, foe, r, c, res);
    foe.seen = foe.received.length;
    await world.impact('home', r, c, res, ai.team);
  } else {
    await world.outgoing(r, c);
    applyShot(ai, foe, r, c, res);
    await world.impact('target', r, c, res, foe.team);
  }
  if (gen !== G.gen) return;
  updateFleets();
  afterShot(res, G.turn);
}

// ---------------------------------------------------------------------------------------------
// Online

function openOnline() {
  showDialog('#online');
  $('#online-choose').hidden = false;
  $('#online-host').hidden = true;
  netStatus('');
  const code = params.get('join');
  if (code) $('#join-code').value = code;
}

function netStatus(msg, err = false) {
  const s = $('#net-status');
  s.textContent = msg;
  s.classList.toggle('err', !!err);
}

function setupNet() {
  G.net?.close();
  const net = (G.net = new Net());
  net.onStatus = netStatus;
  net.onConnect = () => {
    netStatus('Connected!');
    net.send({ t: 'hello', name: readOpts().n1, rules: net.isHost ? { bonus: readOpts().bonus } : undefined });
  };
  net.onClose = () => {
    if (G.mode === 'online' && G.phase !== 'menu') { toast('Your opponent left the game', 4000); toMenu(); }
  };
  net.onMessage = (m) => onNet(m);
  return net;
}

$('#host').addEventListener('click', async () => {
  sfx.unlock();
  const code = makeCode();
  const net = setupNet();
  $('#online-choose').hidden = true;
  $('#online-host').hidden = false;
  $('#room-code').textContent = code;
  const url = new URL(location.href);
  url.search = `?join=${code}`;
  $('#room-link').value = url.toString();
  netStatus('Opening the room…');
  try { await net.host(code); } catch (e) { console.warn(e); }
});
$('#copy-link').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#room-link').value); toast('Link copied'); } catch { $('#room-link').select(); }
});
$('#join').addEventListener('click', async () => {
  sfx.unlock();
  const code = $('#join-code').value.trim().toUpperCase();
  if (code.length < 4) { netStatus('Enter the 5-letter code', true); return; }
  const net = setupNet();
  try { await net.join(code); } catch (e) { console.warn(e); }
});
$('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#join').click(); });
$('#online-back').addEventListener('click', () => { G.net?.close(); G.net = null; showDialog('#menu'); });

function onNet(m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'hello') {
    const o = readOpts();
    if (!G.net.isHost && m.rules) o.bonus = !!m.rules.bonus;
    o.opp = String(m.name || 'Opponent').slice(0, 16);
    newGame('online', o);
    toast(`Connected to ${o.opp}`);
  } else if (m.t === 'placed') {
    G.P[1].ready = true;
    if (G.P[0].ready && G.phase !== 'place') beginBattle();
    else if (G.phase === 'place') toast(`${G.P[1].name} is ready`);
  } else if (m.t === 'shot') {
    const r = m.r | 0, c = m.c | 0;
    enqueue(() => onRemoteShot(r, c));
  } else if (m.t === 'result') {
    G.pendingResult?.({ hit: !!m.hit, sunk: m.sunk || null, allSunk: !!m.allSunk });
    G.pendingResult = null;
  } else if (m.t === 'fleet') {
    // the other side's fleet, sent at the end so the loser can see where it was
    G.revealed = m.ships;
    if (G.phase === 'over') revealRemote();
  } else if (m.t === 'rematch') {
    if (G.phase === 'over') rematch(false);
  }
}

function remoteResult(r, c) {
  return new Promise((resolve) => {
    G.pendingResult = resolve;
    G.net.send({ t: 'shot', r, c });
  });
}

function waitRemote() {
  G.phase = 'wait';
  world.camTo('home', 1.3);
  setTurn(`Waiting for <b>${esc(G.P[1].name)}</b><small>They're picking a square in your waters</small>`, 'wait');
  hint('');
}

async function onRemoteShot(r, c) {
  const gen = G.gen;
  const me = G.P[0], foe = G.P[1];
  const res = me.fleet.receive(r, c);
  G.net.send({ t: 'result', r, c, hit: res.hit, sunk: res.sunk, allSunk: res.allSunk });
  G.phase = 'busy';
  await world.camTo('home', 0.6);
  setTurn(`<b>${esc(foe.name)}</b> fires at ${cellName(r, c)}`, 'wait');
  await world.incoming(r, c);
  applyShot(foe, me, r, c, res);
  me.seen = me.received.length;
  await world.impact('home', r, c, res, foe.team);
  if (gen !== G.gen) return;
  updateFleets();
  afterShot(res, 1);
}

function revealRemote() {
  if (!G.revealed) return;
  const known = new Set(G.P[0].sunkEnemies.map((s) => s.id));
  for (const s of G.revealed) if (!known.has(s.id)) world.target.addShip(s, G.P[1].team);
}

// ---------------------------------------------------------------------------------------------
// Game over

async function gameOver(winner) {
  G.phase = 'over';
  hint('');
  const w = G.P[winner], l = G.P[1 - winner];
  const viewerWon = winner === G.viewer;
  if (G.mode === 'online') {
    G.net.send({ t: 'fleet', ships: G.P[0].fleet.ships.map(({ id, name, len, r, c, dir }) => ({ id, name, len, r, c, dir })) });
    revealRemote();
  } else {
    world.revealFleet(G.P[1 - G.viewer]);
  }
  setTurn(`<b>${esc(w.name)}</b> wins!`, 'fire');
  sfx.fanfare(G.mode === 'local' || G.mode === 'watch' || viewerWon);
  await world.camTo(viewerWon ? 'target' : 'home', 1.4);
  world.victory(viewerWon ? 'target' : 'home');
  await sleep(1600);
  const human = G.mode === 'local' || G.mode === 'watch';
  $('#end-title').textContent = human ? `${w.name.toUpperCase()} WINS` : viewerWon ? 'VICTORY' : 'DEFEAT';
  $('#end-text').textContent = `${w.name} sank all five of ${l.name}'s ships in ${w.stats.shots} shots.`;
  const row = (p) => `<span>${esc(p.name)}</span><span>${p.stats.shots}</span><span>${p.stats.hits}</span><span>${p.stats.shots ? Math.round((100 * p.stats.hits) / p.stats.shots) : 0}%</span>`;
  $('#end-results').innerHTML = `<span class="h">Admiral</span><span class="h">Shots</span><span class="h">Hits</span><span class="h">Accuracy</span>${row(G.P[0])}${G.mode === 'online' ? '' : row(G.P[1])}`;
  showDialog('#end');
  if (G.mode === 'watch') setTimeout(() => { if (G.phase === 'over' && G.mode === 'watch') newGame('watch'); }, 9000);
}

function rematch(announce = true) {
  if (G.mode === 'online') {
    if (announce) G.net?.send({ t: 'rematch' });
    const o = readOpts();
    o.opp = G.P[1].name;
    o.bonus = G.rules.bonus;
    G.revealed = null;
    newGame('online', o);
  } else {
    const o = readOpts();
    if (G.mode !== 'watch') { o.n1 = G.P[0].name; o.n2 = G.P[1].name; }
    newGame(G.mode, o);
  }
}

$('#end-rematch').addEventListener('click', () => { sfx.click(); rematch(true); });
$('#end-menu').addEventListener('click', () => { sfx.click(); toMenu(); });
$('#menu-btn').addEventListener('click', () => {
  sfx.click();
  if (G.phase === 'menu') return;
  if (G.phase !== 'over' && !confirm('Leave this battle and go back to the menu?')) return;
  toMenu();
});

// ---------------------------------------------------------------------------------------------
// Input

function ndc(e) {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1];
}

function boardForPhase() {
  if (G.phase === 'place') return 'home';
  if (G.phase === 'aim') return 'target';
  return null;
}

canvas.addEventListener('pointermove', (e) => {
  const [x, y] = ndc(e);
  world.setParallax(x * 0.6, y * 0.4);
  const which = boardForPhase();
  if (!which) return;
  const cell = world.pick(x, y, which);
  const changed = (cell?.r !== G.hover?.r) || (cell?.c !== G.hover?.c);
  G.hover = cell;
  if (cell) G.cursor = { ...cell };
  if (!changed) return;
  if (G.phase === 'place') refreshGhost();
  else if (G.phase === 'aim') {
    if (cell) { showReticle(cell); sfx.click(1400); }
    else { world.reticle.hide(); world.target.resetTints(); }
  }
});

let downAt = null;
canvas.addEventListener('pointerdown', (e) => {
  sfx.unlock();
  downAt = { x: e.clientX, y: e.clientY, button: e.button, type: e.pointerType };
  canvas.focus();
});
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 12) { downAt = null; return; }
  const button = downAt.button, touch = downAt.type === 'touch';
  downAt = null;
  const which = boardForPhase();
  if (!which) return;
  const [x, y] = ndc(e);
  const cell = world.pick(x, y, which);
  if (!cell) return;
  if (G.phase === 'place') {
    if (button === 2) { rotate(); return; }
    G.hover = cell;
    placeAt(cell.r, cell.c);
  } else if (G.phase === 'aim') {
    // on touch, the first tap aims and a second tap on the same square fires
    if (touch && (G.armed?.r !== cell.r || G.armed?.c !== cell.c)) {
      G.armed = cell;
      G.hover = cell;
      showReticle(cell);
      hint('Tap the square again to fire');
      return;
    }
    G.armed = null;
    fire(cell.r, cell.c);
  }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const k = e.key.toLowerCase();
  if (k === 'm') { $('#mute').click(); return; }
  const which = boardForPhase();
  if (!which) return;
  if (k === 'r' && G.phase === 'place') { rotate(); return; }
  const d = { arrowup: [-1, 0], w: [-1, 0], arrowdown: [1, 0], s: [1, 0], arrowleft: [0, -1], a: [0, -1], arrowright: [0, 1], d: [0, 1] }[k];
  if (d) {
    e.preventDefault();
    G.cursor.r = Math.max(0, Math.min(N - 1, G.cursor.r + d[0]));
    G.cursor.c = Math.max(0, Math.min(N - 1, G.cursor.c + d[1]));
    G.hover = { ...G.cursor };
    if (G.phase === 'place') refreshGhost(); else showReticle(G.hover);
    sfx.click(1400);
  } else if (k === 'enter' || k === ' ') {
    e.preventDefault();
    if (G.phase === 'place') placeAt(G.cursor.r, G.cursor.c);
    else fire(G.cursor.r, G.cursor.c);
  }
});

// ---------------------------------------------------------------------------------------------
// Tools

$('#depth').addEventListener('input', (e) => world.stage.setDepth(+e.target.value));
$('#mute').addEventListener('click', () => {
  sfx.unlock();
  sfx.setMuted(!sfx.muted);
  $('#mute').textContent = sfx.muted ? 'Sound off' : 'Sound on';
});
$('#mode3d').addEventListener('click', async () => {
  await world.stage.setStereo(!world.stage.stereo);
  setBadge();
});

function setBadge() {
  const b = $('#badge');
  if (world.stage.woven && world.stage.stereo) { b.textContent = '3D'; b.dataset.kind = 'ok'; }
  else if (world.stage.woven) { b.textContent = '2D mode'; b.dataset.kind = ''; }
  else { b.textContent = '2D preview'; b.dataset.kind = ''; }
  $('#mode3d').hidden = !world.stage.displayModesSupported;
  $('#mode3d').textContent = world.stage.stereo ? 'Switch to 2D' : 'Switch to 3D';
}
world.stage.onModeChange = setBadge;

// ---------------------------------------------------------------------------------------------
// Boot

showcase();
world.camTo('orbit', 0.01);
const { firstWoven } = await world.start();
setBadge();
firstWoven.then((r) => {
  console.info(`[battleship] firstWoven woven=${r.woven} confirmed=${r.confirmed} reason=${r.reason} ms=${Math.round(r.ms || 0)}`);
  $('#boot').remove(); // a hard cut, never a fade
  setBadge();
});
if (params.has('watch') || params.has('auto')) newGame('watch');
else if (params.get('join')) openOnline();
