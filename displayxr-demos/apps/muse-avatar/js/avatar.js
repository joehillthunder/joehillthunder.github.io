// The avatar: a small floating companion built from three.js primitives, authored in metres
// for a 0.24 m virtual display (the glass is z = 0, +z comes out toward the viewer).
//
// The face is a 2D canvas redrawn every frame and wrapped on a curved visor, so expressions,
// blinks and lip-sync are drawing code rather than morph targets. The head turns toward the
// viewer: on a 3D display that is the tracked head position the session's eye views report,
// in 2D it is the pointer.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const EXPRESSIONS = ['neutral', 'happy', 'excited', 'thinking', 'surprised', 'sad', 'confused', 'wink', 'love', 'sleepy'];
export const GESTURES = ['wave', 'nod', 'shake', 'shrug', 'bow', 'spin', 'celebrate', 'point_left', 'point_right'];

// What each expression asks of the face. Every number eases toward these targets.
const FACE = {
  neutral:   { open: 1.00, squint: 0, heart: 0, wink: 0, brow: 0,     smile: 0.35, width: 1.0, oShape: 0,   blush: 0,   size: 1.00 },
  happy:     { open: 1.00, squint: 1, heart: 0, wink: 0, brow: 0.1,   smile: 0.95, width: 1.2, oShape: 0,   blush: 0.6, size: 1.00 },
  excited:   { open: 1.00, squint: 0, heart: 0, wink: 0, brow: 0.6,   smile: 1.00, width: 1.3, oShape: 0,   blush: 0.8, size: 1.18 },
  thinking:  { open: 0.80, squint: 0, heart: 0, wink: 0, brow: 0.35,  smile: -0.05, width: 0.6, oShape: 0,  blush: 0,   size: 0.95 },
  surprised: { open: 1.00, squint: 0, heart: 0, wink: 0, brow: 1.0,   smile: 0,    width: 0.7, oShape: 1,   blush: 0,   size: 1.25 },
  sad:       { open: 0.75, squint: 0, heart: 0, wink: 0, brow: -0.9,  smile: -0.7, width: 0.9, oShape: 0,   blush: 0,   size: 0.95 },
  confused:  { open: 0.90, squint: 0, heart: 0, wink: 0, brow: -0.35, smile: -0.15, width: 0.7, oShape: 0,  blush: 0,   size: 1.00 },
  wink:      { open: 1.00, squint: 0, heart: 0, wink: 1, brow: 0.2,   smile: 0.9,  width: 1.1, oShape: 0,   blush: 0.4, size: 1.00 },
  love:      { open: 1.00, squint: 0, heart: 1, wink: 0, brow: 0.2,   smile: 0.9,  width: 1.0, oShape: 0,   blush: 1.0, size: 1.10 },
  sleepy:    { open: 0.18, squint: 0, heart: 0, wink: 0, brow: -0.2,  smile: 0.1,  width: 0.6, oShape: 0.3, blush: 0,   size: 1.00 },
};

// State colours for the halo ring and the antenna tip.
const STATE_COLOR = {
  idle: 0x7c8cff, listening: 0x3ee6a8, thinking: 0xffb547, speaking: 0x9b7bff, offline: 0x5b6273,
};

const GESTURE_SECONDS = { wave: 1.9, nod: 1.1, shake: 1.2, shrug: 1.5, bow: 1.7, spin: 1.5, celebrate: 2.0, point_left: 1.8, point_right: 1.8 };

const ease = (t) => t * t * (3 - 2 * t);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export class Avatar {
  constructor({ accent = '#8f7bff' } = {}) {
    this.group = new THREE.Group();       // placed by the app (x shift, pop)
    this.rig = new THREE.Group();         // bob, lean, gestures
    this.group.add(this.rig);

    this.expression = 'neutral';
    this.expressionUntil = 0;
    this.state = 'idle';                  // idle | listening | thinking | speaking | offline
    this.speechLevel = 0;                 // 0..1, set every frame while speaking
    this.micLevel = 0;                    // 0..1, while listening
    this.face = { ...FACE.neutral, gx: 0, gy: 0, mouthOpen: 0, blink: 1 };
    this.gesture = null;                  // { name, t, dur }
    this.lookTarget = new THREE.Vector3(0, 0, 0.6);
    this.time = 0;
    this.nextBlink = 1.5;
    this.blinkT = -1;
    this.accent = new THREE.Color(accent);
    this.ringColor = new THREE.Color(STATE_COLOR.idle);

    this._build();
  }

  // ---- construction ------------------------------------------------------------------------
  _build() {
    const shell = new THREE.MeshPhysicalMaterial({
      color: 0xeef0f8, roughness: 0.32, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.18, sheen: 0.4,
    });
    const trim = new THREE.MeshStandardMaterial({ color: 0x2a2f45, roughness: 0.5, metalness: 0.3 });
    this.glow = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: STATE_COLOR.idle, emissiveIntensity: 2.2 });

    // Body: a soft pod below the head.
    const bodyGeo = new THREE.LatheGeometry(lathePoints([
      [0.000, -0.040], [0.020, -0.038], [0.030, -0.028], [0.033, -0.012], [0.031, 0.004],
      [0.025, 0.016], [0.014, 0.024], [0.000, 0.026],
    ]), 48);
    this.body = new THREE.Mesh(bodyGeo, shell);
    this.body.position.y = -0.072;
    this.rig.add(this.body);

    // Chest light: a small glowing disc that pulses with the state.
    const chest = new THREE.Mesh(new THREE.CircleGeometry(0.0055, 32), this.glow);
    chest.position.set(0, -0.066, 0.0322);
    chest.rotation.x = -0.12;
    this.rig.add(chest);

    // Halo ring around the waist.
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.046, 0.0028, 16, 96), this.glow);
    this.ring.position.y = -0.085;
    this.ring.rotation.x = Math.PI / 2 - 0.22;
    this.rig.add(this.ring);

    // Head.
    this.head = new THREE.Group();
    this.head.position.y = 0.004;
    this.rig.add(this.head);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.044, 64, 48), shell);
    skull.scale.set(1.12, 0.94, 0.98);
    this.head.add(skull);

    // Visor: the front cap of a slightly larger sphere, carrying the face canvas.
    this.faceCanvas = document.createElement('canvas');
    this.faceCanvas.width = 512;
    this.faceCanvas.height = 320;
    this.faceCtx = this.faceCanvas.getContext('2d');
    this.faceTex = new THREE.CanvasTexture(this.faceCanvas);
    this.faceTex.colorSpace = THREE.SRGBColorSpace;
    this.faceTex.anisotropy = 4;
    const PHI = 2.15, THETA = 1.25;          // angular size of the visor (radians)
    // Three's sphere puts phi = π/2 at +z, so this cap faces the viewer, with the canvas's
    // left edge on the viewer's left.
    const visorGeo = new THREE.SphereGeometry(0.0445, 64, 40, Math.PI / 2 - PHI / 2, PHI, Math.PI / 2 - THETA / 2, THETA);
    const visorMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, map: this.faceTex, emissive: 0xffffff, emissiveMap: this.faceTex, emissiveIntensity: 0.9,
      roughness: 0.12, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05,
    });
    this.visor = new THREE.Mesh(visorGeo, visorMat);
    this.visor.scale.set(1.12, 0.94, 0.98);
    this.head.add(this.visor);

    // Ear pods with glowing rims.
    for (const side of [-1, 1]) {
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.010, 32), trim);
      pod.rotation.z = Math.PI / 2;
      pod.position.set(side * 0.049, 0.0, 0);
      this.head.add(pod);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.0105, 0.0016, 12, 48), this.glow);
      rim.rotation.y = Math.PI / 2;
      rim.position.set(side * 0.0545, 0.0, 0);
      this.head.add(rim);
    }

    // Antenna.
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.0012, 0.0016, 0.022, 12), trim);
    stalk.position.set(0, 0.050, 0);
    this.head.add(stalk);
    this.tip = new THREE.Mesh(new THREE.SphereGeometry(0.0042, 24, 16), this.glow);
    this.tip.position.set(0, 0.062, 0);
    this.head.add(this.tip);

    // Floating hands.
    const handGeo = new RoundedBoxGeometry(0.018, 0.022, 0.014, 4, 0.007);
    this.hands = [-1, 1].map((side) => {
      const hand = new THREE.Mesh(handGeo, shell);
      hand.userData.side = side;
      this.rig.add(hand);
      return hand;
    });

    // Thinking dots: three small spheres that orbit above the head while Muse works.
    this.dots = new THREE.Group();
    const dotMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: STATE_COLOR.thinking, emissiveIntensity: 2 });
    for (let i = 0; i < 3; i++) {
      const d = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 16, 12), dotMat);
      this.dots.add(d);
    }
    this.dots.position.set(0.035, 0.07, 0);
    this.dots.visible = false;
    this.head.add(this.dots);
    this.dotMat = dotMat;

    // Soft contact shadow on an implied floor.
    const shadowTex = radialTexture();
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.12, 0.05),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.55 }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = -0.118;
    this.group.add(this.shadow);
  }

  // ---- control -----------------------------------------------------------------------------
  setExpression(name, seconds = 0) {
    if (!FACE[name]) return false;
    this.expression = name;
    this.expressionUntil = seconds > 0 ? this.time + seconds : 0;
    return true;
  }

  playGesture(name) {
    if (!GESTURE_SECONDS[name]) return false;
    this.gesture = { name, t: 0, dur: GESTURE_SECONDS[name] };
    if (name === 'celebrate') this.setExpression('excited', 2.4);
    return true;
  }

  setState(state) {
    if (STATE_COLOR[state] === undefined) return;
    this.state = state;
  }

  /** World-space point the head should turn toward (display metres). */
  lookAt(x, y, z) {
    this.lookTarget.set(x, y, z);
  }

  // ---- per frame ---------------------------------------------------------------------------
  update(dt) {
    this.time += dt;
    const t = this.time;
    if (this.expressionUntil && t > this.expressionUntil) { this.expression = 'neutral'; this.expressionUntil = 0; }

    // Face targets: the expression, overridden by what the state needs.
    let target = FACE[this.expression];
    if (this.expression === 'neutral') {
      if (this.state === 'thinking') target = FACE.thinking;
      else if (this.state === 'offline') target = FACE.sleepy;
    }
    const f = this.face;
    for (const k of ['open', 'squint', 'heart', 'wink', 'brow', 'smile', 'width', 'oShape', 'blush', 'size']) {
      f[k] = approach(f[k], target[k], 10, dt);
    }

    // Blinks (not while the eyes are closed arcs or hearts).
    if (this.blinkT < 0 && t > this.nextBlink) { this.blinkT = 0; }
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const p = this.blinkT / 0.16;
      f.blink = p < 0.5 ? 1 - p * 2 : Math.min(1, (p - 0.5) * 2);
      if (p >= 1) { this.blinkT = -1; f.blink = 1; this.nextBlink = t + 2.2 + Math.random() * 3.5; }
    }

    // Mouth: speech drives it, with a little chatter so steady tones still look like talking.
    const speaking = this.state === 'speaking';
    const chatter = speaking ? 0.12 * (0.5 + 0.5 * Math.sin(t * 23) * Math.sin(t * 7.3)) : 0;
    const wantOpen = speaking ? clamp(this.speechLevel * 1.6 + chatter, 0, 1) : 0;
    f.mouthOpen = approach(f.mouthOpen, wantOpen, speaking ? 28 : 12, dt);

    // Gaze: head turns toward the look target, eyes do the rest.
    const lt = this.lookTarget;
    const headWorld = new THREE.Vector3();
    this.head.getWorldPosition(headWorld);
    const dx = lt.x - headWorld.x, dy = lt.y - headWorld.y, dz = Math.max(0.15, lt.z - headWorld.z);
    let yaw = clamp(Math.atan2(dx, dz), -0.55, 0.55);
    let pitch = clamp(-Math.atan2(dy, dz), -0.35, 0.35);
    if (this.state === 'thinking') { yaw = yaw * 0.4 + 0.25; pitch = pitch * 0.4 - 0.22; }
    f.gx = approach(f.gx, clamp(yaw / 0.55, -1, 1), 8, dt);
    f.gy = approach(f.gy, clamp(-pitch / 0.35, -1, 1), 8, dt);

    // Body language.
    const bob = Math.sin(t * 1.6) * 0.0035;
    let headYaw = yaw * 0.65, headPitch = pitch * 0.6, headRoll = Math.sin(t * 0.7) * 0.03;
    let rigY = bob, rigZ = 0, rigRotY = 0, rigPitch = 0;
    if (this.state === 'listening') { rigZ = 0.006; headPitch -= 0.05; headRoll += 0.08; }
    if (this.state === 'thinking') { headRoll += 0.12; }
    if (speaking) { headPitch += Math.sin(t * 9) * 0.02 * this.speechLevel; rigY += this.speechLevel * 0.002; }

    const restL = new THREE.Vector3(-0.066, -0.078 + Math.sin(t * 1.6 + 0.8) * 0.003, 0.012);
    const restR = new THREE.Vector3(0.066, -0.078 + Math.sin(t * 1.6 + 2.0) * 0.003, 0.012);
    const L = restL.clone(), R = restR.clone();
    let handRollL = 0.25, handRollR = -0.25;

    const g = this.gesture;
    if (g) {
      g.t += dt;
      const p = clamp(g.t / g.dur, 0, 1);
      const env = Math.sin(Math.PI * p);     // 0 → 1 → 0 over the gesture
      switch (g.name) {
        case 'wave':
          R.set(0.074, -0.02 + 0.045 * env, 0.022);
          R.x += Math.sin(g.t * 13) * 0.012 * env;
          handRollR = -0.25 + Math.sin(g.t * 13) * 0.5 * env;
          headRoll += 0.1 * env;
          break;
        case 'nod': headPitch += 0.28 * Math.sin(p * Math.PI * 4) * (1 - p); break;
        case 'shake': headYaw += 0.38 * Math.sin(p * Math.PI * 5) * (1 - p); break;
        case 'shrug':
          L.lerp(new THREE.Vector3(-0.085, -0.045, 0.02), env);
          R.lerp(new THREE.Vector3(0.085, -0.045, 0.02), env);
          handRollL += 0.6 * env; handRollR -= 0.6 * env;
          headRoll += 0.18 * env; rigY += 0.004 * env;
          break;
        case 'bow': rigPitch = 0.38 * env; headPitch += 0.2 * env; break;
        case 'spin': rigRotY = ease(p) * Math.PI * 2; rigY += 0.012 * env; break;
        case 'celebrate': {
          const shake = Math.sin(g.t * 16) * 0.006 * env;
          L.lerp(new THREE.Vector3(-0.07 + shake, 0.05, 0.015), env);
          R.lerp(new THREE.Vector3(0.07 - shake, 0.05, 0.015), env);
          rigY += Math.abs(Math.sin(g.t * 9)) * 0.012 * env;
          break;
        }
        case 'point_left':
        case 'point_right': {
          const s = g.name === 'point_left' ? -1 : 1;
          const hand = s < 0 ? L : R;
          hand.lerp(new THREE.Vector3(s * 0.1, -0.02, 0.03), env);
          headYaw += s * 0.35 * env;
          break;
        }
      }
      if (p >= 1) this.gesture = null;
    }

    this.rig.position.set(0, rigY, rigZ);
    this.rig.rotation.set(rigPitch, rigRotY, 0);
    this.head.rotation.set(headPitch, headYaw, headRoll, 'YXZ');
    this.hands[0].position.copy(L); this.hands[0].rotation.set(0, 0, handRollL);
    this.hands[1].position.copy(R); this.hands[1].rotation.set(0, 0, handRollR);
    this.shadow.scale.setScalar(1 - rigY * 8);

    // Glow: state colour, pulsing with the mic while listening and with speech while speaking.
    this.ringColor.lerp(new THREE.Color(STATE_COLOR[this.state]), 1 - Math.exp(-6 * dt));
    this.glow.emissive.copy(this.ringColor);
    let pulse = 1.6 + 0.4 * Math.sin(t * 2.2);
    if (this.state === 'listening') pulse = 1.6 + this.micLevel * 4;
    if (speaking) pulse = 1.8 + this.speechLevel * 3;
    if (this.state === 'offline') pulse = 0.6;
    this.glow.emissiveIntensity = pulse;
    this.ring.rotation.z += dt * (this.state === 'thinking' ? 3.2 : 0.5);

    this.dots.visible = this.state === 'thinking';
    if (this.dots.visible) {
      this.dots.children.forEach((d, i) => {
        const a = t * 3 + i * 2.094;
        d.position.set(Math.cos(a) * 0.012, Math.sin(t * 6 + i) * 0.003, Math.sin(a) * 0.012);
      });
    }

    this._drawFace();
  }

  // ---- the face ----------------------------------------------------------------------------
  _drawFace() {
    const ctx = this.faceCtx, W = 512, H = 320, f = this.face;
    const accent = '#' + this.ringColor.clone().lerp(new THREE.Color(0x8ff3ff), 0.55).getHexString();

    // Glassy dark visor with a soft vertical gradient.
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#141a33');
    bg.addColorStop(1, '#070912');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = 26;
    ctx.fillStyle = accent;
    ctx.strokeStyle = accent;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const gx = f.gx * 26, gy = f.gy * 14;
    const cy = 138 + gy;
    const blink = f.blink;
    for (const side of [-1, 1]) {
      const cx = 256 + side * 98 + gx;
      const winked = side === 1 ? f.wink : 0;
      const open = Math.max(0.06, f.open * blink * (1 - winked));
      const w = 25 * f.size, h = 36 * f.size;
      const plain = Math.max(0, 1 - f.squint - f.heart);

      // Oval eye.
      if (plain > 0.02) {
        ctx.globalAlpha = plain;
        ctx.beginPath();
        ctx.ellipse(cx, cy, w, Math.max(4, h * open), 0, 0, Math.PI * 2);
        ctx.fill();
        if (open > 0.4) {   // catch-light
          ctx.save();
          ctx.shadowBlur = 0;
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.beginPath();
          ctx.ellipse(cx - 8 + f.gx * 4, cy - h * open * 0.45, 6, 8 * open, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
      // Happy arc ^.
      if (f.squint > 0.02) {
        ctx.globalAlpha = Math.min(1, f.squint);
        ctx.lineWidth = 15;
        ctx.beginPath();
        ctx.moveTo(cx - w, cy + 10);
        ctx.quadraticCurveTo(cx, cy - h * 1.15, cx + w, cy + 10);
        ctx.stroke();
      }
      // Heart.
      if (f.heart > 0.02) {
        ctx.globalAlpha = Math.min(1, f.heart);
        heartPath(ctx, cx, cy + 4, 34 * f.size * (0.92 + 0.08 * Math.sin(this.time * 8)));
        ctx.fill();
      }
      // Winked eye: a closed line.
      if (winked > 0.3) {
        ctx.globalAlpha = winked;
        ctx.lineWidth = 13;
        ctx.beginPath();
        ctx.moveTo(cx - w, cy + 4);
        ctx.quadraticCurveTo(cx, cy + 16, cx + w, cy + 4);
        ctx.stroke();
      }
      // Brows: only when they say something.
      if (Math.abs(f.brow) > 0.08) {
        ctx.globalAlpha = Math.min(1, Math.abs(f.brow) * 1.4);
        ctx.lineWidth = 9;
        const lift = 54 + f.brow * 16;
        const tilt = (f.brow < 0 ? -1 : 0.4) * side * f.brow * 12 + (this.expression === 'confused' && side === 1 ? -12 : 0);
        ctx.beginPath();
        ctx.moveTo(cx - 24, cy - lift + tilt);
        ctx.lineTo(cx + 24, cy - lift - tilt);
        ctx.stroke();
      }
    }

    // Mouth.
    ctx.globalAlpha = 1;
    const mx = 256 + gx * 0.7, my = 236 + gy * 0.6;
    const open = Math.max(f.mouthOpen, f.oShape * 0.55);
    const mw = 56 * f.width * (1 - 0.45 * f.oShape) * (1 - 0.25 * f.mouthOpen);
    if (open > 0.06) {
      const mh = 10 + 44 * open;
      ctx.beginPath();
      ctx.moveTo(mx - mw, my - f.smile * 6);
      ctx.quadraticCurveTo(mx, my - 6 - f.smile * 4 + (f.oShape ? -mh * 0.4 : 0), mx + mw, my - f.smile * 6);
      ctx.quadraticCurveTo(mx, my + mh + f.smile * 10, mx - mw, my - f.smile * 6);
      ctx.fill();
    } else {
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.moveTo(mx - mw, my - f.smile * 8);
      ctx.quadraticCurveTo(mx, my + f.smile * 34, mx + mw, my - f.smile * 8);
      ctx.stroke();
    }

    // Blush.
    if (f.blush > 0.03) {
      ctx.shadowBlur = 30;
      ctx.shadowColor = '#ff6fa8';
      ctx.fillStyle = `rgba(255,111,168,${0.5 * f.blush})`;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(256 + side * 150 + gx, 205 + gy, 26, 12, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // Specular sweep across the glass.
    const sheen = ctx.createLinearGradient(0, 0, W, H * 0.6);
    sheen.addColorStop(0.0, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.42, 'rgba(255,255,255,0.0)');
    sheen.addColorStop(0.5, 'rgba(255,255,255,0.07)');
    sheen.addColorStop(0.58, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, W, H);

    this.faceTex.needsUpdate = true;
  }

  /** A plain description for display.status. */
  describe() {
    return { expression: this.expression, state: this.state, gesture: this.gesture ? this.gesture.name : null };
  }
}

function lathePoints(pairs) {
  return pairs.map(([x, y]) => new THREE.Vector2(x, y));
}

function heartPath(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.55);
  ctx.bezierCurveTo(x - s * 1.1, y - s * 0.1, x - s * 0.55, y - s * 0.95, x, y - s * 0.38);
  ctx.bezierCurveTo(x + s * 0.55, y - s * 0.95, x + s * 1.1, y - s * 0.1, x, y + s * 0.55);
  ctx.closePath();
}

function radialTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 32, 2, 64, 32, 62);
  g.addColorStop(0, 'rgba(0,0,0,0.9)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.save();
  ctx.scale(1, 0.5);
  ctx.translate(0, 32);
  ctx.fillRect(0, 0, 128, 128);
  ctx.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
