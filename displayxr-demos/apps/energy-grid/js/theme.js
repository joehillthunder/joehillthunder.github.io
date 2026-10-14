// Palette tokens. The single source for colours in the 3D scene; app.css mirrors
// the same values as CSS custom properties for the 2D panels.
//
// ISA-101 rule: grey is normal. Colour means something needs attention, and each colour has one job.
export const T = {
  bg: 0x1e2328,
  surface: 0x2a3037,
  slab: 0x262c33,
  slabEdge: 0x343c45,
  ground: 0x2b3238,
  equip: 0x8a949e,
  equipDark: 0x5c656e,
  text: 0xe6eaee,
  kv115: 0x7fa8d9,     // transmission tint
  kv12: 0xc9c27a,      // distribution tint (desaturated)
  flow: 0x4fc3f7,      // power-flow particles (cyan)
  renew: 0x66bb6a,     // solar / battery discharging
  alarm1: 0xe53935,    // critical: trip, fault, de-energized with load
  alarm2: 0xfb8c00,    // high: overload
  alarm3: 0xfdd835,    // advisory: approaching a limit
  fci: 0xff9100,       // fault indicator flag (orange: a latched alarm)
  select: 0xffffff,
  window: 0xffd27a,    // lit windows = energized customers
  dead: 0x30353b,      // de-energized building
  water: 0x2f4352,
  risk0: 0x3a4048,     // what-if heat overlay: sequential, separate from the alarm colours
  risk1: 0xb388ff,
};

export const css = (hex) => '#' + hex.toString(16).padStart(6, '0');
