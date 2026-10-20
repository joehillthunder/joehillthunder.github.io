// Small canvas line charts for the panel: training curves, joint traces, evaluation rounds.
// Colours come from the CSS tokens so the charts follow the page theme.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6'];

export class LineChart {
  /** opts: { yLabel, xLabel, log (log y), yMin, yMax, legend: [names] } */
  constructor(canvas, opts = {}) {
    this.c = canvas;
    this.o = opts;
    this.series = [];
    this.markers = [];
    this.cursor = null;
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  set(series) { this.series = series; this.draw(); }
  setMarkers(m) { this.markers = m; this.draw(); }
  setCursor(x) { this.cursor = x; this.draw(); }
  draw() {
    const c = this.c, dpr = Math.min(2, devicePixelRatio || 1);
    const W = Math.max(10, c.clientWidth), H = Math.max(10, c.clientHeight);
    if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const pad = { l: 34, r: 8, t: 8, b: 16 };
    const pts = this.series.flatMap((s) => s.points);
    const muted = css('--muted') || '#8a94a6', line = css('--line') || '#263042';
    g.font = '10px ui-sans-serif, system-ui, sans-serif';
    g.fillStyle = muted;
    if (!pts.length) { g.fillText(this.o.empty || 'no data yet', pad.l, H / 2); return; }
    const fy = this.o.log ? (v) => Math.log10(Math.max(1e-6, v)) : (v) => v;
    let x0 = this.o.xMin ?? Math.min(...pts.map((p) => p[0])), x1 = this.o.xMax ?? Math.max(...pts.map((p) => p[0]));
    let y0 = this.o.yMin ?? Math.min(...pts.map((p) => fy(p[1]))), y1 = this.o.yMax ?? Math.max(...pts.map((p) => fy(p[1])));
    if (x1 === x0) x1 = x0 + 1;
    if (y1 === y0) { y1 += 0.5; y0 -= 0.5; }
    const X = (x) => pad.l + ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r);
    const Y = (y) => pad.t + (1 - (fy(y) - y0) / (y1 - y0)) * (H - pad.t - pad.b);
    const Yr = (v) => pad.t + (1 - (v - y0) / (y1 - y0)) * (H - pad.t - pad.b);
    // grid + labels
    g.strokeStyle = line; g.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const v = y0 + ((y1 - y0) * i) / 3, y = Yr(v);
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke();
      const lab = this.o.log ? (10 ** v).toPrecision(2) : this.o.fmt ? this.o.fmt(v) : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2);
      g.fillText(lab, 2, y + 3);
    }
    if (this.o.xLabel) g.fillText(this.o.xLabel, W - pad.r - g.measureText(this.o.xLabel).width, H - 3);
    for (const m of this.markers) {
      g.strokeStyle = css(m.color) || muted; g.globalAlpha = 0.7; g.setLineDash([2, 3]);
      g.beginPath(); g.moveTo(X(m.x), pad.t); g.lineTo(X(m.x), H - pad.b); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
    }
    this.series.forEach((s, i) => {
      g.strokeStyle = css(s.color || SERIES[i % SERIES.length]);
      g.lineWidth = s.width || 1.6;
      g.beginPath();
      s.points.forEach((p, j) => (j ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))));
      g.stroke();
      if (s.dots) { g.fillStyle = g.strokeStyle; for (const p of s.points) { g.beginPath(); g.arc(X(p[0]), Y(p[1]), 2.5, 0, 7); g.fill(); } }
    });
    if (this.cursor != null) {
      g.strokeStyle = css('--fg') || '#e5e7eb'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(X(this.cursor), pad.t); g.lineTo(X(this.cursor), H - pad.b); g.stroke();
    }
  }
}
