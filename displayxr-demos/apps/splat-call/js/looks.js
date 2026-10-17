// Looks (what the caller becomes) and experiences (a scene + a look + framing, as one preset).
//
// A look is either a splat STYLE (a shader treatment in splats.js: the caller stays their real,
// live 3D self, recoloured or restyled) or a 3D AVATAR head built here from primitives and driven
// by MediaPipe's head pose and blendshapes (blinks, jaw, smile). An avatar that replaces the head
// sets `hideHead`, and the splat shader drops the head splats, so the real shoulders stay.
//
// Experiences are homages in look and mood to films and shows; they use no characters, logos,
// music or quotes. The caller supplies the performance.

import * as THREE from 'three';

/** id → { name, style (splats.js uStyle), avatar?, hideHead? } */
export const LOOKS = {
  natural: { name: 'Natural', style: 0 },
  hologram: { name: 'Hologram', style: 1 },
  transporter: { name: 'Transporter beam', style: 2 },
  toon: { name: 'Cel toon', style: 3 },
  yellow: { name: 'Yellow toon', style: 4 },
  stone: { name: 'Stone age', style: 5 },
  portal: { name: 'Portal acid', style: 6 },
  neon: { name: 'Neon 1985', style: 7 },
  voxel: { name: 'Voxel', style: 8 },
  gold: { name: 'Gold statue', style: 9 },
  robot: { name: 'Robot', style: 0, avatar: 'robot', hideHead: true },
  alien: { name: 'Alien', style: 0, avatar: 'alien', hideHead: true },
  astronaut: { name: 'Astronaut', style: 0, avatar: 'astronaut' },
};

/**
 * id → { name, homage, scene, look, scale?, y?, view?: { y, dist }, caption?, beam? }
 * `scale` / `y` place the caller (the subject group); `view` aims the orbit camera.
 */
export const EXPERIENCES = {
  message: {
    name: 'Hologram message', homage: 'Star Wars', scene: 'hologram', look: 'hologram',
    scale: 0.42, y: -0.075, view: { y: -0.1, dist: 0.62 },
    caption: 'Incoming hologram message · play it back as many times as you need',
  },
  holodeck: {
    name: 'Holodeck', homage: 'Star Trek', scene: 'holodeck', look: 'transporter', beam: true,
    caption: 'Program running · materialising',
  },
  year3000: { name: 'Year 3000', homage: 'Futurama', scene: 'year3000', look: 'toon', caption: 'Calling from the year 3000' },
  sitcom: { name: 'Yellow sitcom', homage: 'The Simpsons', scene: 'sitcom', look: 'yellow', caption: 'Couch not included' },
  stone: { name: 'Stone age call', homage: 'The Flintstones', scene: 'stone', look: 'stone', caption: 'Live from the quarry' },
  portal: { name: 'Portal adventure', homage: 'Rick and Morty', scene: 'portal', look: 'portal', caption: 'Calling from another dimension' },
  time1985: { name: '1985 time circuits', homage: 'Back to the Future', scene: 'time1985', look: 'neon', caption: 'Calling from 1985 · hold on tight' },
};

// ------------------------------------------------------------------------------------------------
// Avatars

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.2, ...extra });
const at = (o, x = 0, y = 0, z = 0) => { o.position.set(x, y, z); return o; };

function robot() {
  const g = new THREE.Group();
  const steel = mat(0xc9d2dc, { metalness: 0.35, roughness: 0.35 });
  const dark = mat(0x2a3038, { metalness: 0.3, roughness: 0.5 });
  const glow = new THREE.MeshBasicMaterial({ color: 0x55e0ff });
  g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.19, 0.17), steel), 0, 0.02, 0));
  g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 0.005), dark), 0, 0.045, 0.086));
  const eyes = [-0.035, 0.035].map((x) => {
    const e = at(new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.01, 20), glow), x, 0.045, 0.09);
    e.rotation.x = Math.PI / 2;
    g.add(e);
    return e;
  });
  const jaw = at(new THREE.Group(), 0, -0.05, 0.088);
  for (let i = 0; i < 5; i++) jaw.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.022, 0.006), dark), (i - 2) * 0.018, 0, 0));
  g.add(jaw);
  const mouthGlow = at(new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.02), new THREE.MeshBasicMaterial({ color: 0xff7a3a, transparent: true, opacity: 0 })), 0, -0.05, 0.0865);
  g.add(mouthGlow);
  for (const x of [-0.09, 0.09]) {
    const ear = at(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.02, 16), dark), x, 0.03, 0);
    ear.rotation.z = Math.PI / 2;
    g.add(ear);
  }
  g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.06, 8), dark), 0, 0.145, 0));
  const tip = at(new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff4040 })), 0, 0.18, 0);
  g.add(tip);
  g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.06, 16), dark), 0, -0.1, 0));
  return {
    group: g,
    update(face, t) {
      for (const [e, b] of [[eyes[0], face.blinkR], [eyes[1], face.blinkL]]) e.scale.z = Math.max(0.08, 1 - b);
      jaw.position.y = -0.05 - face.jaw * 0.02;
      mouthGlow.material.opacity = face.jaw * 0.9;
      mouthGlow.scale.y = 0.4 + face.jaw * 1.5;
      tip.material.color.setHSL(0, 1, 0.35 + 0.25 * (Math.sin(t * 6) > 0 ? 1 : 0));
    },
  };
}

function alien() {
  const g = new THREE.Group();
  const skin = mat(0x7fd36b, { roughness: 0.6 });
  const head = at(new THREE.Mesh(new THREE.SphereGeometry(0.1, 32, 24), skin), 0, 0.04, 0);
  head.scale.set(1, 1.25, 0.95);
  g.add(head);
  const chin = at(new THREE.Mesh(new THREE.SphereGeometry(0.05, 24, 16), skin), 0, -0.06, 0.02);
  chin.scale.set(1, 1.2, 1);
  g.add(chin);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.1, metalness: 0.3 });
  const eyes = [-1, 1].map((sx) => {
    const e = at(new THREE.Mesh(new THREE.SphereGeometry(0.034, 24, 16), eyeMat), sx * 0.045, 0.03, 0.075);
    e.scale.set(1, 0.6, 0.45);
    e.rotation.z = sx * -0.45;
    g.add(e);
    return e;
  });
  const mouth = at(new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 8), new THREE.MeshBasicMaterial({ color: 0x1a2a10 })), 0, -0.07, 0.065);
  g.add(mouth);
  for (const sx of [-1, 1]) {
    const ant = at(new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.004, 0.08, 8), skin), sx * 0.04, 0.17, 0);
    ant.rotation.z = -sx * 0.4;
    g.add(ant);
    g.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.01, 12, 8), new THREE.MeshBasicMaterial({ color: 0xd8ff5a })), sx * 0.057, 0.205, 0));
  }
  return {
    group: g,
    update(face) {
      eyes[0].scale.y = 0.6 * Math.max(0.1, 1 - face.blinkR);
      eyes[1].scale.y = 0.6 * Math.max(0.1, 1 - face.blinkL);
      mouth.scale.set(1 + face.smile * 1.5, 0.4 + face.jaw * 2.2, 1);
    },
  };
}

function astronaut() {
  // A glass bubble helmet over the caller's real face, with a collar and a headlamp.
  const g = new THREE.Group();
  const glass = new THREE.Mesh(
    new THREE.SphereGeometry(0.165, 48, 32),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
      fragmentShader: `varying vec3 vN; varying vec3 vV;
        void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
          float spec = pow(max(0.0, dot(reflect(-normalize(vV), normalize(vN)), normalize(vec3(-0.4,0.7,0.6)))), 40.0);
          gl_FragColor = vec4(vec3(0.75,0.88,1.0) * (f * 0.7) + vec3(spec), f * 0.55 + spec * 0.8); }`,
    }),
  );
  glass.position.y = 0.02;
  glass.renderOrder = 30; // over the splats: the face is behind the glass
  g.add(glass);
  const collar = at(new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.03, 16, 48), mat(0xeeeeee, { roughness: 0.7 })), 0, -0.135, 0);
  collar.rotation.x = Math.PI / 2;
  collar.renderOrder = 30;
  g.add(collar);
  const lamp = at(new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.02, 16), new THREE.MeshBasicMaterial({ color: 0xfff6d0 })), 0.11, 0.1, 0.07);
  lamp.rotation.x = Math.PI / 2;
  lamp.renderOrder = 30;
  g.add(lamp);
  return { group: g, update() {} };
}

const AVATARS = { robot, alien, astronaut };

/** A fresh avatar for `id`, or null. */
export function makeAvatar(id) {
  return AVATARS[id] ? AVATARS[id]() : null;
}

// ------------------------------------------------------------------------------------------------
// Head pose and expression from MediaPipe, smoothed.

const S = new THREE.Matrix4().makeScale(-1, 1, 1);

export class FaceRig {
  constructor() {
    this.quat = new THREE.Quaternion();
    this.jaw = 0;
    this.blinkL = 0;
    this.blinkR = 0;
    this.smile = 0;
    this.seen = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
  }

  /**
   * @param {Float32Array|number[]|null} matrix  MediaPipe facial transformation (column-major 4x4,
   *        canonical face → camera, OpenGL axes: x right, y up, z toward the camera).
   * @param {Record<string, number>|null} blend  blendshape scores by name
   * @param {boolean} mirror  the world is mirrored (a local camera)
   */
  update(matrix, blend, mirror, dt) {
    const k = 1 - Math.exp(-14 * dt);
    if (matrix) {
      this._m.fromArray(matrix);
      if (mirror) this._m.premultiply(S).multiply(S);
      this._q.setFromRotationMatrix(this._m);
      this.quat.slerp(this._q, k);
      this.seen = performance.now();
    }
    if (blend) {
      const ease = (cur, v) => cur + (v - cur) * k;
      const L = blend.eyeBlinkLeft ?? 0, Rr = blend.eyeBlinkRight ?? 0;
      // Mirrored, the person's left eye shows on the right.
      this.blinkL = ease(this.blinkL, mirror ? Rr : L);
      this.blinkR = ease(this.blinkR, mirror ? L : Rr);
      this.jaw = ease(this.jaw, Math.min(1, (blend.jawOpen ?? 0) * 1.6));
      this.smile = ease(this.smile, ((blend.mouthSmileLeft ?? 0) + (blend.mouthSmileRight ?? 0)) / 2);
    }
  }
}
