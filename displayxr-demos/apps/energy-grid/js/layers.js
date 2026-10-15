// Invisible layers: what a trainee cannot see on site, drawn on demand.
//
//   flow   power-flow particles (the default view)
//   amps   live current / power labels and direction arrows on every branch
//   volts  bus voltage rings + per-unit labels
//   fault  the fault-current path: every device that saw fault current, with the amps it saw
//   live   energized (red) vs isolated (green) overlay on conductors
//   zones  each breaker's protection zone and trip setting
//
// Training shows them; Test hides them so trainees work from the real cues only.
// Colours: overlays use their own hues, never the ISA alarm colours.

import { T } from './theme.js';

export const LAYERS = [
  { id: 'flow', label: 'Power flow', hint: 'Moving particles show which way power flows' },
  { id: 'amps', label: 'Current (amps)', hint: 'Live amps or kW on every line, with direction arrows' },
  { id: 'volts', label: 'Voltage', hint: 'Bus voltage rings: teal in band, amber low, grey dead' },
  { id: 'fault', label: 'Fault current', hint: 'Where fault current flowed and how much each device saw' },
  { id: 'live', label: 'Energized / isolated', hint: 'Red glow = energized, green = isolated (dead)' },
  { id: 'zones', label: 'Protection zones', hint: 'What each breaker protects, and its trip setting' },
];
export const PRESETS = {
  training: { flow: true, amps: true, volts: true, fault: true, live: true, zones: true },
  default: { flow: true, amps: false, volts: false, fault: true, live: false, zones: false },
  test: { flow: false, amps: false, volts: false, fault: false, live: false, zones: false },
};

const ZONE_COLORS = [0x26a69a, 0x7986cb, 0xf06292];

// A text label that always faces the viewer. Redraws its canvas only when the text changes.
export function makeLabel(THREE, width = 0.075, { bg = 'rgba(20,24,28,0.85)' } = {}) {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 96;
  const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(width, width * 0.3, 1);
  sprite.renderOrder = 10;
  let last = '';
  return {
    sprite,
    set(text, color = '#e6eaee', sub = '') {
      const key = text + color + sub;
      if (key === last) return;
      last = key;
      g.clearRect(0, 0, 320, 96);
      g.fillStyle = bg;
      g.beginPath();
      g.roundRect(4, 4, 312, 88, 18);
      g.fill();
      g.strokeStyle = color;
      g.lineWidth = 4;
      g.stroke();
      g.fillStyle = color;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `600 ${sub ? 38 : 46}px "Segoe UI", system-ui, sans-serif`;
      g.fillText(text, 160, sub ? 36 : 50);
      if (sub) {
        g.fillStyle = '#9aa4ae';
        g.font = '26px "Segoe UI", system-ui, sans-serif';
        g.fillText(sub, 160, 72);
      }
      tex.needsUpdate = true;
    },
  };
}

const css = (hex) => '#' + hex.toString(16).padStart(6, '0');
export const fmtA = (a) => (a >= 1000 ? `${(a / 1000).toFixed(1)} kA` : `${Math.round(a)} A`);
export const fmtKW = (kw) => (Math.abs(kw) >= 1000 ? `${(kw / 1000).toFixed(2)} MW` : `${Math.round(kw)} kW`);

/** Overlays for the grid map. Reads the GridScene's curves and positions; adds to its root. */
export class GridLayers {
  constructor(THREE, grid, net) {
    this.THREE = THREE;
    this.grid = grid;
    this.net = net;
    this.flags = { ...PRESETS.default };
    this.root = new THREE.Group();
    grid.root.add(this.root);
    this.groups = {};
    for (const l of LAYERS) {
      this.groups[l.id] = new THREE.Group();
      this.root.add(this.groups[l.id]);
    }
    this._buildAmps();
    this._buildVolts();
    this._buildFault();
    this._buildLive();
    this._buildZones();
    this.set(this.flags);
  }

  set(flags) {
    this.flags = { ...this.flags, ...flags };
    for (const l of LAYERS) this.groups[l.id].visible = !!this.flags[l.id];
    this.grid.particles.visible = !!this.flags.flow;
  }

  _buildAmps() {
    const THREE = this.THREE;
    this.amp = {};
    const cone = new THREE.ConeGeometry(0.005, 0.014, 10);
    cone.rotateZ(-Math.PI / 2);                                // points along +x
    for (const [id, L] of Object.entries(this.grid.lines)) {
      const label = makeLabel(THREE, 0.07);
      const p = L.curve.getPointAt(0.5);
      label.sprite.position.set(p.x, L.h + 0.032, p.z);
      this.groups.amps.add(label.sprite);
      const mat = new THREE.MeshBasicMaterial({ color: T.flow, toneMapped: false });
      const arrows = [0.3, 0.7].map((u) => {
        const m = new THREE.Mesh(cone, mat);
        m.position.copy(L.curve.getPointAt(u)).add(new THREE.Vector3(0, 0.006, 0));
        this.groups.amps.add(m);
        return { m, u };
      });
      this.amp[id] = { label, arrows, mat, L };
    }
  }

  _buildVolts() {
    const THREE = this.THREE;
    this.volt = {};
    for (const id of Object.keys(this.net.buses)) {
      const p = this.grid.itemAnchor(id) || this.grid.busPos(id);
      const mat = new THREE.MeshBasicMaterial({ color: 0x26a69a, transparent: true, opacity: 0.85, toneMapped: false });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.0022, 8, 40), mat);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(p.x, 0.004, p.z);
      const label = makeLabel(THREE, 0.062);
      label.sprite.position.set(p.x, 0.05, p.z + 0.02);
      this.groups.volts.add(ring, label.sprite);
      this.volt[id] = { ring, mat, label };
    }
  }

  _buildFault() {
    const THREE = this.THREE;
    this.faultTubes = {};
    for (const [id, L] of Object.entries(this.grid.lines)) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xff5252, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false });
      const tube = new THREE.Mesh(new THREE.TubeGeometry(L.curve, 48, 0.0055, 8, false), mat);
      tube.visible = false;
      const label = makeLabel(THREE, 0.08, { bg: 'rgba(60,10,10,0.9)' });
      const p = L.curve.getPointAt(0.5);
      label.sprite.position.set(p.x, L.h + 0.055, p.z);
      label.sprite.visible = false;
      this.groups.fault.add(tube, label.sprite);
      this.faultTubes[id] = { tube, mat, label };
    }
    this.faultMark = makeLabel(THREE, 0.1, { bg: 'rgba(60,10,10,0.9)' });
    this.faultMark.sprite.visible = false;
    this.groups.fault.add(this.faultMark.sprite);
  }

  _buildLive() {
    const THREE = this.THREE;
    this.liveTubes = {};
    for (const [id, L] of Object.entries(this.grid.lines)) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.18, depthWrite: false, toneMapped: false });
      const tube = new THREE.Mesh(new THREE.TubeGeometry(L.curve, 48, L.kind === 'tline' ? 0.016 : 0.01, 10, false), mat);
      this.groups.live.add(tube);
      this.liveTubes[id] = { mat };
    }
  }

  // A zone runs from a breaker's load side through lines and closed-normally switches to the next
  // breaker (or an open point). Drawn as a coloured band on the ground under its conductors.
  _buildZones() {
    const THREE = this.THREE, net = this.net;
    const adj = {};
    for (const [id, b] of Object.entries(net.branches)) {
      (adj[b.a] ||= []).push([id, b.b]);
      (adj[b.b] ||= []).push([id, b.a]);
    }
    Object.keys(net.protection || {}).forEach((bkr, n) => {
      const color = ZONE_COLORS[n % ZONE_COLORS.length];
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false });
      const seen = new Set([bkr]), members = [bkr];
      const queue = [net.branches[bkr].b];
      const visited = new Set([net.branches[bkr].a]);
      while (queue.length) {
        const bus = queue.shift();
        if (visited.has(bus)) continue;
        visited.add(bus);
        for (const [id, other] of adj[bus] || []) {
          const br = net.branches[id];
          if (seen.has(id) || br.kind === 'breaker' || br.kind === 'xfmr' || br.normally === 'open') continue;
          seen.add(id);
          members.push(id);
          queue.push(other);
        }
      }
      let mid = null;
      for (const id of members) {
        const L = this.grid.lines[id];
        if (!L) continue;
        const flat = L.curve.getPoints(40).map((p) => new THREE.Vector3(p.x, 0.003, p.z));
        const band = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(flat), 40, 0.008, 6, false), mat);
        band.scale.y = 0.25;
        this.groups.zones.add(band);
        if (!mid && id !== bkr) mid = L.curve.getPointAt(0.5);
      }
      const label = makeLabel(THREE, 0.11);
      const at = mid || this.grid.lines[bkr].curve.getPointAt(0.5);
      label.sprite.position.set(at.x, 0.075, at.z - 0.03);
      label.set(`${bkr.replace('_', '-')} zone`, css(color), `trips above ${net.protection[bkr]} A`);
      this.groups.zones.add(label.sprite);
    });
  }

  update(state, dt) {
    if (!state) return;
    const f = this.flags;
    if (f.amps) {
      for (const [id, a] of Object.entries(this.amp)) {
        const br = state.branches[id];
        const live = br && br.closed && Math.abs(br.amps) > 0.5;
        const col = !br || !br.closed ? '#6b747d' : br.loading > 1 ? css(T.alarm2) : br.loading > 0.9 ? css(T.alarm3) : css(T.flow);
        a.label.set(br && br.closed ? fmtA(Math.abs(br.amps)) : 'open', col, br && br.closed ? fmtKW(br.kw) : '');
        for (const ar of a.arrows) {
          ar.m.visible = !!live;
          if (!live) continue;
          const t = a.L.curve.getTangentAt(ar.u);
          const dir = br.kw >= 0 ? 1 : -1;
          ar.m.rotation.set(0, -Math.atan2(t.z * dir, t.x * dir), 0);
          ar.m.scale.setScalar(0.7 + Math.min(1.2, br.loading));
        }
      }
    }
    if (f.volts) {
      for (const [id, v] of Object.entries(this.volt)) {
        const b = state.buses[id];
        const col = !b || !b.energized ? 0x6b747d : b.vpu < 0.95 || b.vpu > 1.05 ? 0xffb74d : 0x26a69a;
        v.mat.color.setHex(col);
        v.ring.scale.setScalar(b && b.energized ? 1 + Math.abs(1 - b.vpu) * 8 : 0.8);
        v.label.set(b && b.energized ? `${b.vpu.toFixed(3)} pu` : '0 V · dead', css(col), `${this.net.buses[id].kv} kV`);
      }
    }
    if (f.fault) {
      const fci = state.fci || {};
      const pulse = 0.35 + 0.3 * Math.abs(Math.sin(performance.now() / 300));
      for (const [id, ft] of Object.entries(this.faultTubes)) {
        const seen = fci[id];
        ft.tube.visible = !!seen;
        ft.label.sprite.visible = !!seen;
        if (seen) {
          ft.mat.opacity = pulse;
          ft.label.set(fmtA(seen), '#ff8a80', 'fault current seen');
        }
      }
      this.faultMark.sprite.visible = !!state.fault;
      if (state.fault) {
        const p = this.grid.busPos(state.fault);
        this.faultMark.sprite.position.set(p.x, 0.11, p.z);
        const live = state.closed.SW_A && state.closed.SW_B;
        this.faultMark.set('FAULT', '#ff5252', live ? 'still connected' : 'isolated');
      }
    }
    if (f.live) {
      for (const [id, lt] of Object.entries(this.liveTubes)) {
        const br = state.branches[id];
        const A = state.buses[this.net.branches[id].a], B = state.buses[this.net.branches[id].b];
        const aLive = !!(A && A.energized), bLive = !!(B && B.energized);
        const energized = br && br.closed && (aLive || bLive);
        const fullyDead = !aLive && !bLive;
        // amber: an open point with voltage on one side only (live up to the gap)
        lt.mat.color.setHex(fullyDead ? 0x43a047 : energized ? 0xff3b30 : 0xffb74d);
        lt.mat.opacity = fullyDead ? 0.28 : 0.18;
      }
    }
  }
}
