// The whole 3D scene: sea, sky, the two battle areas, effects, the camera that swings between
// them, picking, and the strike sequences (launch → flight → impact → sinking).

import * as THREE from 'three';
import { Stage } from './stage.js';
import { createSky, createOcean, createLighting } from './ocean.js';
import { FX } from './fx.js';
import { Board, Reticle, GRID_Y } from './board.js';
import { ghostModel } from './ships.js';
import { HIT, MISS, SUNK, shipCells } from './game.js';
import { N, clamp, easeInOut, rand, sleep, cellName } from './util.js';

const BOARD_X = 6.6;
const DEG = Math.PI / 180;

export class World {
  constructor(canvas, sfx) {
    this.sfx = sfx;
    const stage = (this.stage = new Stage(canvas));
    this.scene = stage.scene;
    this.cam = stage.cam;
    this.time = 0;

    this.sky = createSky();
    this.scene.add(this.sky);
    this.ocean = createOcean();
    this.scene.add(this.ocean);
    createLighting(stage.renderer, this.scene, this.sky);

    this.fx = new FX(this.scene, this.cam);
    this.home = new Board(this.scene, this.fx, new THREE.Vector3(-BOARD_X, 0, 0), { name: 'YOUR FLEET', accent: 0x45c4ff });
    this.target = new Board(this.scene, this.fx, new THREE.Vector3(BOARD_X, 0, 0), { name: 'ENEMY WATERS', accent: 0xff7a4a });
    this.reticle = new Reticle(this.scene);
    this.ghost = null;

    // camera state
    this.view = { pos: new THREE.Vector3(0, 14, 26), look: new THREE.Vector3(0, 0, 0) };
    this.tween = null;
    this.mode = 'orbit';
    this.orbitA = 0.3;
    this.parallax = new THREE.Vector2();
    this.parallaxS = new THREE.Vector2();
    this.ray = new THREE.Raycaster();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -GRID_Y);

    stage.onTick = (dt) => this.tick(dt);
    stage.onEye = (h) => this.fx.setViewHeight(h);
  }

  start() {
    return this.stage.start();
  }

  board(which) {
    return which === 'home' ? this.home : this.target;
  }

  // -------------------------------------------------------------------------------------------
  // camera

  viewFor(name) {
    const aspect = this.cam.aspect;
    const vf = (this.cam.fov * DEG) / 2;
    const hf = Math.atan(Math.tan(vf) * aspect);
    let look, halfW, halfH, el;
    if (name === 'both') {
      look = new THREE.Vector3(0, 0, 0.8);
      halfW = BOARD_X + 7; halfH = 6.4; el = 50 * DEG;
    } else if (name === 'place') {
      // the home board, sitting higher on screen to leave room for the placement bar
      look = this.home.center.clone().add(new THREE.Vector3(0, 0, 2.1));
      halfW = 7.4; halfH = 7.6; el = 58 * DEG;
    } else {
      const b = this.board(name);
      look = b.center.clone().add(new THREE.Vector3(0, 0, 0.45));
      halfW = 7.4; halfH = 6.6; el = 54 * DEG;
    }
    const dist = Math.max(halfW / Math.tan(hf), halfH / Math.tan(vf));
    const pos = look.clone().add(new THREE.Vector3(0, Math.sin(el), Math.cos(el)).multiplyScalar(dist));
    return { pos, look };
  }

  orbitView() {
    const r = 25, a = this.orbitA;
    return { pos: new THREE.Vector3(Math.sin(a) * r, 9.5, Math.cos(a) * r), look: new THREE.Vector3(0, 0, 0) };
  }

  /** Swing the camera to 'home', 'target', 'both' or 'orbit'. Resolves when it arrives. */
  camTo(name, dur = 1.3) {
    this.mode = name;
    if (name === 'orbit') {
      // continue the orbit from wherever we are
      const p = this.view.pos;
      this.orbitA = Math.atan2(p.x, p.z);
    }
    const from = { pos: this.view.pos.clone(), look: this.view.look.clone() };
    return new Promise((resolve) => {
      if (this.tween) this.tween.resolve();
      this.tween = { from, t: 0, dur, resolve };
    });
  }

  setParallax(x, y) {
    this.parallax.set(x, y);
  }

  updateCamera(dt) {
    if (this.mode === 'orbit') this.orbitA += dt * 0.045;
    const goal = this.mode === 'orbit' ? this.orbitView() : this.viewFor(this.mode);
    if (this.tween) {
      const tw = this.tween;
      tw.t += dt / tw.dur;
      const k = easeInOut(clamp(tw.t, 0, 1));
      this.view.pos.lerpVectors(tw.from.pos, goal.pos, k);
      this.view.look.lerpVectors(tw.from.look, goal.look, k);
      // lift the camera a little mid-swing so it arcs over the water
      this.view.pos.y += Math.sin(k * Math.PI) * 2.0;
      if (tw.t >= 1) { this.tween = null; tw.resolve(); }
    } else {
      this.view.pos.copy(goal.pos);
      this.view.look.copy(goal.look);
    }
    // gentle parallax from the pointer
    this.parallaxS.lerp(this.parallax, 1 - Math.exp(-dt * 3));
    const cam = this.cam;
    cam.position.copy(this.view.pos);
    cam.position.x += this.parallaxS.x * 0.9;
    cam.position.y += this.parallaxS.y * 0.5;
    const sh = this.fx.shake;
    if (sh > 0.002) cam.position.add(new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(sh));
    cam.lookAt(this.view.look);
    this.stage.focusDist = cam.position.distanceTo(this.view.look);
  }

  // -------------------------------------------------------------------------------------------
  // frame

  tick(dt) {
    this.time += dt;
    const t = this.time;
    this.ocean.material.uniforms.uTime.value = t;
    this.sky.material.uniforms.uTime.value = t;
    this.fx.waveTime = t;
    this.updateCamera(dt);
    this.home.update(dt, t);
    this.target.update(dt, t);
    this.reticle.update(dt, t);
    if (this.ghost) this.ghost.position.y = 0.02 + Math.sin(t * 3) * 0.02;
    this.fx.update(dt);
    this.onTick?.(dt);
  }

  // -------------------------------------------------------------------------------------------
  // picking

  pick(ndcX, ndcY, which) {
    this.ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.cam);
    const p = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(this.plane, p)) return null;
    return this.board(which).cellAt(p);
  }

  // -------------------------------------------------------------------------------------------
  // scene state for a viewer

  clearBoards() {
    this.home.clear();
    this.target.clear();
    this.hideGhost();
    this.reticle.hide();
  }

  /** Rebuild both boards from what `me` knows. `reveal`: also show the opponent's live ships. */
  setViewer(me, foe, { reveal = false } = {}) {
    this.clearBoards();
    this.home.setTitle(`${me.name.toUpperCase()} · FLEET`);
    this.target.setTitle(`${foe.name.toUpperCase()} · WATERS`);
    for (const s of me.fleet.ships) this.home.addShip(s, me.team);
    for (let i = 0; i < me.seen; i++) this.drawReceived(me.received[i]);
    for (let i = 0; i < N * N; i++) {
      const k = me.known[i];
      const r = (i / N) | 0, c = i % N;
      if (k === MISS) this.target.addMiss(r, c);
      else if (k === HIT || k === SUNK) this.target.addHit(r, c);
    }
    for (const s of me.sunkEnemies) {
      this.target.addShip({ ...s }, foe.team, { wreck: true });
      this.target.markSunk(shipCells(s.r, s.c, s.len, s.dir));
    }
    if (reveal) this.revealFleet(foe);
  }

  revealFleet(foe) {
    for (const s of foe.fleet.ships) if (!this.target.ships.has(s.id)) this.target.addShip(s, foe.team);
  }

  drawReceived(rec) {
    if (rec.hit) this.home.addHit(rec.r, rec.c); else this.home.addMiss(rec.r, rec.c);
    if (rec.sunk) {
      this.home.wreck(rec.sunk.id, true);
      this.home.markSunk(shipCells(rec.sunk.r, rec.sunk.c, rec.sunk.len, rec.sunk.dir));
    }
  }

  /** Both fleets out on the water for the title screen. */
  showcase(fleetA, fleetB) {
    this.clearBoards();
    this.home.setTitle('BLUE FLEET');
    this.target.setTitle('RED FLEET');
    for (const s of fleetA.ships) this.home.addShip(s, 0);
    for (const s of fleetB.ships) this.target.addShip(s, 1);
  }

  // -------------------------------------------------------------------------------------------
  // placement ghost

  showGhost(id, r, c, len, dir, ok) {
    if (!this.ghost || this.ghost.name !== id) {
      this.hideGhost();
      this.ghost = ghostModel(id);
      this.home.group.add(this.ghost);
    }
    const p = this.home.shipCenterLocal(r, c, len, dir);
    this.ghost.position.set(p.x, 0.02, p.z);
    this.ghost.rotation.y = dir === 'v' ? -Math.PI / 2 : 0;
    this.ghost.userData.setValid(ok);
    this.ghost.visible = true;
  }

  hideGhost() {
    if (this.ghost) { this.home.group.remove(this.ghost); this.ghost = null; }
  }

  // -------------------------------------------------------------------------------------------
  // strikes

  /** Fire from the viewer's fleet at a square on the target board; resolves at impact. */
  async outgoing(r, c) {
    const to = this.target.cellWorld(r, c);
    to.y = 0.05;
    const afloat = [...this.home.ships.values()].filter((e) => !e.sinking);
    let from;
    if (afloat.length) {
      const e = afloat[Math.floor(Math.random() * afloat.length)];
      const m = e.model;
      // swing the turrets onto the target, then fire them
      const turrets = m.userData.turrets || [];
      if (turrets.length) {
        await this.aimTurrets(m, turrets, to);
        for (const t of turrets) {
          const muzzle = t.localToWorld(t.userData.muzzle.clone());
          const dir = to.clone().sub(muzzle).setY(0).normalize().setY(0.5).normalize();
          this.fx.muzzle(muzzle, dir);
          t.userData.guns.position.x = t.userData.gunsX - 0.06; // recoil
        }
        this.sfx.thump(0.7, 140);
        this.recoilReset();
      }
      const lp = m.userData.launch[Math.floor(Math.random() * m.userData.launch.length)];
      from = m.localToWorld(lp.clone());
    } else {
      from = this.home.center.clone().add(new THREE.Vector3(0, 0.3, 0));
    }
    this.fx.muzzle(from, new THREE.Vector3(0, 1, 0));
    this.sfx.launch();
    const dist = from.distanceTo(to);
    await this.fx.missile(from, to, { apex: 3.2 + dist * 0.16, dur: 1.25 + dist * 0.035 });
  }

  aimTurrets(model, turrets, worldTarget) {
    const goals = turrets.map((t) => {
      const local = model.worldToLocal(worldTarget.clone()).sub(t.position);
      let a = Math.atan2(-local.z, local.x);
      const from = t.rotation.y;
      // shortest way round
      while (a - from > Math.PI) a -= 2 * Math.PI;
      while (a - from < -Math.PI) a += 2 * Math.PI;
      return { t, from, to: a };
    });
    let k = 0;
    return new Promise((resolve) => {
      this.fx.task((dt) => {
        k = Math.min(1, k + dt / 0.55);
        const e = easeInOut(k);
        for (const g of goals) g.t.rotation.y = g.from + (g.to - g.from) * e;
        if (k >= 1) { resolve(); return false; }
      });
    });
  }

  recoilReset() {
    // guns run back out after the recoil
    const guns = [];
    for (const e of this.home.ships.values()) for (const t of e.model.userData.turrets || []) guns.push(t.userData);
    this.fx.task((dt) => {
      let done = true;
      for (const u of guns) {
        u.guns.position.x += (u.gunsX - u.guns.position.x) * Math.min(1, dt * 4);
        if (Math.abs(u.gunsX - u.guns.position.x) > 1e-3) done = false;
      }
      return !done;
    });
  }

  /** An enemy missile drops out of the sky onto the viewer's fleet; resolves at impact. */
  async incoming(r, c) {
    const to = this.home.cellWorld(r, c);
    to.y = 0.05;
    const from = to.clone().add(new THREE.Vector3(rand(-3, 3) + 9, 15, -20));
    this.sfx.whistle(1.5);
    await this.fx.missile(from, to, { apex: 1.5, dur: 1.5, incoming: true });
  }

  /** Effects for a resolved shot. `foeTeam` colours a ship revealed by sinking it. */
  async impact(which, r, c, res, foeTeam) {
    const b = this.board(which);
    const p = b.cellWorld(r, c);
    p.y = 0.12;
    if (res.hit) {
      this.fx.explosion(p, 1);
      this.sfx.boom(1);
      b.addHit(r, c);
      if (res.sunk) {
        await sleep(450);
        this.fx.banner('SUNK!', p, { color: '#ff3b2f', sub: res.sunk.name.toUpperCase(), size: 1.25, dur: 2.8 });
        await this.sink(b, res.sunk, foeTeam);
      } else {
        this.fx.banner('HIT!', p, { color: '#ff5a2a' });
        await sleep(1100);
      }
    } else {
      this.fx.splash(p, 1);
      this.sfx.splash();
      b.addMiss(r, c);
      this.fx.banner('MISS', p, { color: '#9fd8ff', size: 0.75, dur: 1.7 });
      await sleep(1000);
    }
  }

  async sink(b, s, team) {
    const cells = shipCells(s.r, s.c, s.len, s.dir);
    if (!b.ships.has(s.id)) {
      // the hidden enemy ship surfaces in flames
      const e = b.addShip({ ...s }, team);
      e.model.position.y = -0.4;
    }
    this.sfx.sink();
    b.wreck(s.id);
    b.markSunk(cells);
    for (const [rr, cc] of cells) {
      const q = b.cellWorld(rr, cc);
      q.y = 0.15;
      this.fx.explosion(q, 0.7);
      this.sfx.boom(0.7);
      await sleep(180);
    }
    await sleep(1200);
  }

  async victory(which = 'target') {
    const b = this.board(which);
    for (let i = 0; i < 14; i++) {
      const p = b.center.clone().add(new THREE.Vector3(rand(-4, 4), rand(4, 7), rand(-3, 3)));
      this.fx.fireworks(p);
      this.sfx.thump(0.3, 200);
      await sleep(rand(180, 420));
    }
  }
}

export { cellName };
