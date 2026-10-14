// Live one-line diagram (SVG), drawn from the same network description as the 3D map.
// Same state rules as the 3D view: grey = normal, colour only for abnormal; filled square =
// closed, hollow square = open.

import { T, css } from './theme.js';

const NS = 'http://www.w3.org/2000/svg';
const X = (c) => 40 + c * 104;
const Y = (r) => 58 + r * 96;

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

export class OneLine {
  constructor(container, net, onSelect) {
    this.net = net;
    this.svg = el('svg', { viewBox: '0 0 1000 300', class: 'oneline', role: 'img',
      'aria-label': 'One-line diagram of the feeder system' });
    container.appendChild(this.svg);
    this.paths = {};
    this.devs = {};
    this.busEls = {};
    this.loadEls = {};
    this.onSelect = onSelect;
    this._build();
  }

  _pt(bus) {
    const [c, r] = this.net.buses[bus].ol;
    return [X(c), Y(r)];
  }

  _build() {
    const s = this.svg;
    const gLines = el('g', {}, s), gBus = el('g', {}, s), gDev = el('g', {}, s), gTxt = el('g', {}, s);
    for (const [id, b] of Object.entries(this.net.branches)) {
      const [ax, ay] = this._pt(b.a), [bx, by] = this._pt(b.b);
      const d = ay === by ? `M${ax},${ay} H${bx}` : (b.kind === 'switch' ? `M${ax},${ay} V${by} H${bx}` : `M${ax},${ay} V${by} H${bx}`);
      const p = el('path', { d, class: 'ol-line', 'stroke-width': b.kind === 'tline' ? 5 : 3.5 }, gLines);
      p.addEventListener('click', () => this.onSelect(id));
      const hit = el('path', { d, class: 'ol-hit' }, gLines);
      hit.addEventListener('click', () => this.onSelect(id));
      this.paths[id] = p;
      const mx = ay === by ? (ax + bx) / 2 : (ax + bx) / 2 + (bx > ax ? 0 : 0);
      const my = by;
      if (b.kind === 'breaker' || b.kind === 'switch') {
        const cx = ay === by ? mx : (ax + bx) / 2, cy = ay === by ? ay : by;
        const g = el('g', { class: 'ol-dev', transform: `translate(${cx},${cy})` }, gDev);
        const sq = el('rect', { x: -10, y: -10, width: 20, height: 20, rx: 2 }, g);
        const lab = el('text', { x: 0, y: -16, class: 'ol-label' }, g);
        lab.textContent = id.replace('_', '-');
        g.addEventListener('click', () => this.onSelect(id));
        this.devs[id] = sq;
      } else if (b.kind === 'xfmr') {
        const cx = (ax + bx) / 2, cy = ay;
        const g = el('g', { class: 'ol-dev', transform: `translate(${cx},${cy})` }, gDev);
        el('rect', { x: -22, y: -18, width: 44, height: 36, class: 'ol-mask' }, g);
        el('circle', { cx: -8, cy: 0, r: 12, class: 'ol-xfmr' }, g);
        el('circle', { cx: 8, cy: 0, r: 12, class: 'ol-xfmr' }, g);
        g.addEventListener('click', () => this.onSelect('XFMR'));
        this.devs[id] = null;
      } else {
        const lab = el('text', { x: (ax + bx) / 2, y: my + 18, class: 'ol-label dim' }, gTxt);
        lab.textContent = id;
      }
    }
    for (const [id, b] of Object.entries(this.net.buses)) {
      const [x, y] = this._pt(id);
      const r = el('rect', { x: x - 3, y: y - 14, width: 6, height: 28, class: 'ol-bus' }, gBus);
      r.addEventListener('click', () => this.onSelect(id));
      this.busEls[id] = r;
    }
    // Loads as arrows below their bus; DER as circles.
    const byBus = {};
    for (const [id, ld] of Object.entries(this.net.loads)) (byBus[ld.bus] ||= []).push(id);
    for (const [bus, ids] of Object.entries(byBus)) {
      const [x, y] = this._pt(bus);
      const dir = this.net.buses[bus].ol[1] === 0 ? -1 : 1;
      const g = el('g', { class: 'ol-load' }, gBus);
      el('path', { d: `M${x},${y} v${dir * 26}`, class: 'ol-stub' }, g);
      const tri = el('path', { d: `M${x - 7},${y + dir * 26} h14 l-7,${dir * 11} z`, class: 'ol-arrow' }, g);
      g.addEventListener('click', () => this.onSelect(ids[0]));
      this.loadEls[bus] = { tri, ids };
    }
    for (const [id, pv] of Object.entries(this.net.pv)) {
      const [x, y] = this._pt(pv.bus);
      const g = el('g', { class: 'ol-der', transform: `translate(${x + 30},${y - 30})` }, gBus);
      el('path', { d: `M-30,30 L0,0`, class: 'ol-stub' }, g);
      el('circle', { r: 11, class: 'ol-pv' }, g);
      const t = el('text', { y: 4, class: 'ol-sym' }, g);
      t.textContent = 'PV';
      g.addEventListener('click', () => this.onSelect(id));
    }
    {
      const [x, y] = this._pt(this.net.bess.bus);
      const g = el('g', { class: 'ol-der', transform: `translate(${x + 32},${y + 30})` }, gBus);
      el('path', { d: `M-32,-30 L0,0`, class: 'ol-stub' }, g);
      this.bessRect = el('rect', { x: -12, y: -9, width: 24, height: 18, rx: 2, class: 'ol-bess' }, g);
      const t = el('text', { y: 4, class: 'ol-sym' }, g);
      t.textContent = 'BESS';
      g.addEventListener('click', () => this.onSelect('bess'));
    }
    // Section names.
    const name = (txt, x, y) => { const t = el('text', { x, y, class: 'ol-section' }, gTxt); t.textContent = txt; };
    name('115 kV', X(0) + 10, Y(1) - 22);
    name('Feeder 2', X(5) - 6, Y(0) - 18);
    name('Feeder 1', X(5) - 6, Y(2) + 40);
    name('Microgrid', X(9) - 14, Y(2) - 26);
    name('TIE n.o.', X(7) + 12, Y(1) + 4);
  }

  update(state, selected) {
    const trippedKeys = new Set(state.alarms.filter((a) => a.active && a.key.includes(':trip')).map((a) => a.key.split(':')[0]));
    for (const [id, p] of Object.entries(this.paths)) {
      const b = this.net.branches[id];
      const br = state.branches[id];
      const live = br && br.closed && (state.buses[b.a].energized || state.buses[b.b].energized);
      let col = live ? (b.kind === 'tline' || b.kind === 'xfmr' ? T.kv115 : T.kv12) : 0x4a5159;
      if (live && br.loading > 1.0) col = T.alarm2;
      else if (live && br.loading > 0.9) col = T.alarm3;
      p.setAttribute('stroke', css(col));
      p.classList.toggle('dead', !live);
      p.classList.toggle('sel', selected === id);
    }
    for (const [id, sq] of Object.entries(this.devs)) {
      if (!sq) continue;
      const closed = state.closed[id];
      const normal = this.net.branches[id].normally === 'closed';
      let col = T.equip;
      if (!closed && trippedKeys.has(id)) col = T.alarm1;
      else if (closed !== normal) col = T.alarm3;
      sq.setAttribute('stroke', css(col));
      sq.setAttribute('fill', closed ? css(col) : 'transparent');
      sq.classList.toggle('blink', !closed && trippedKeys.has(id));
      sq.parentNode.classList.toggle('sel', selected === id);
    }
    for (const [id, r] of Object.entries(this.busEls)) {
      r.setAttribute('fill', state.buses[id].energized ? '#c9d1d8' : '#4a5159');
      r.classList.toggle('sel', selected === id);
    }
    for (const { tri, ids } of Object.values(this.loadEls)) {
      const out = ids.some((i) => state.loads[i] && !state.loads[i].served);
      tri.setAttribute('fill', out ? css(T.alarm1) : '#8a949e');
    }
    const bk = state.bess.kw;
    this.bessRect.setAttribute('stroke', bk > 20 ? css(T.renew) : bk < -20 ? css(T.flow) : '#8a949e');
  }
}
