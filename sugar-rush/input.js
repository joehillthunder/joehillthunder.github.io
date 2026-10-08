// input.js — keyboard, mouse, touch and gamepad folded into one per-frame state.
//
//   move.x  −1 left … +1 right        move.z  −1 forward (into the screen) … +1 back
//   jump / dash / pause               true for exactly one frame per press (edge)

export function createInput(canvas, touchUi) {
  const keys = new Set();
  const edges = { jump: false, dash: false, pause: false, confirm: false };
  const touch = { x: 0, z: 0, id: null, ox: 0, oy: 0 };

  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k === ' ') edges.jump = true;
    if (k === 'shift') edges.dash = true;
    if (k === 'escape' || k === 'p') edges.pause = true;
    if (k === 'enter') edges.confirm = true;
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  addEventListener('blur', () => keys.clear());

  // mouse: left button jumps, right button dashes
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) edges.jump = true;
    if (e.button === 2) edges.dash = true;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // touch: a virtual stick on the left half, buttons on the right
  const { stick, knob, jumpBtn, dashBtn } = touchUi;
  const stickR = 50;
  stick.addEventListener('pointerdown', (e) => {
    touch.id = e.pointerId;
    const r = stick.getBoundingClientRect();
    touch.ox = r.left + r.width / 2;
    touch.oy = r.top + r.height / 2;
    stick.setPointerCapture(e.pointerId);
    moveStick(e);
  });
  const moveStick = (e) => {
    if (e.pointerId !== touch.id) return;
    let dx = e.clientX - touch.ox;
    let dy = e.clientY - touch.oy;
    const len = Math.hypot(dx, dy);
    if (len > stickR) {
      dx = (dx / len) * stickR;
      dy = (dy / len) * stickR;
    }
    touch.x = dx / stickR;
    touch.z = dy / stickR;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  stick.addEventListener('pointermove', moveStick);
  const endStick = (e) => {
    if (e.pointerId !== touch.id) return;
    touch.id = null;
    touch.x = touch.z = 0;
    knob.style.transform = '';
  };
  stick.addEventListener('pointerup', endStick);
  stick.addEventListener('pointercancel', endStick);
  jumpBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    edges.jump = true;
  });
  dashBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    edges.dash = true;
  });

  // gamepad: polled; buttons need their own edge detection
  const padPrev = [];
  function pollPad() {
    const out = { x: 0, z: 0 };
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const dz = (v) => (Math.abs(v) < 0.18 ? 0 : v);
      out.x += dz(p.axes[0] || 0);
      out.z += dz(p.axes[1] || 0);
      const b = (i) => Boolean(p.buttons[i]?.pressed);
      if (b(14)) out.x -= 1;
      if (b(15)) out.x += 1;
      if (b(12)) out.z -= 1;
      if (b(13)) out.z += 1;
      const prev = padPrev[p.index] || [];
      const down = (i) => b(i) && !prev[i];
      if (down(0)) edges.jump = true; // A / Cross
      if (down(2) || down(5) || down(7)) edges.dash = true; // X / RB / RT
      if (down(9)) edges.pause = true; // Start
      if (down(0) || down(9)) edges.confirm = true;
      padPrev[p.index] = p.buttons.map((x) => x.pressed);
    }
    return out;
  }

  return {
    /** Read and clear this frame's input. */
    frame() {
      const pad = pollPad();
      let x = pad.x + touch.x;
      let z = pad.z + touch.z;
      if (keys.has('a') || keys.has('arrowleft')) x -= 1;
      if (keys.has('d') || keys.has('arrowright')) x += 1;
      if (keys.has('w') || keys.has('arrowup')) z -= 1;
      if (keys.has('s') || keys.has('arrowdown')) z += 1;
      const len = Math.hypot(x, z);
      if (len > 1) {
        x /= len;
        z /= len;
      }
      const f = { x, z, jump: edges.jump, dash: edges.dash, pause: edges.pause, confirm: edges.confirm };
      edges.jump = edges.dash = edges.pause = edges.confirm = false;
      return f;
    },
  };
}
