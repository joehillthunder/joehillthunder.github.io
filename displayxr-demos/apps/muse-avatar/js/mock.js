// Demo mode: a scripted stand-in for Muse, so the page works with no gadget, account or keys.
//
// It speaks the bridge's event language (link.js) and drives the display through the same
// `invoke` path Muse uses, so every command, animation and caption here is the real code path.
// It only knows a handful of phrases; the README says so, and so does its fallback answer.

import { Emitter, requestId } from './link.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const SHAPE_WORDS = {
  planet: 'planet', saturn: 'planet', 'solar system': 'solar_system', 'the solar system': 'solar_system', dna: 'dna', helix: 'dna',
  heart: 'heart', globe: 'globe', earth: 'globe', world: 'globe', molecule: 'molecule', water: 'molecule', atom: 'molecule',
  rocket: 'rocket', knot: 'torus_knot', cube: 'cube', box: 'cube', crystal: 'crystal', diamond: 'crystal', gem: 'crystal',
};
const SHAPE_LINES = {
  planet: 'Here is a ringed planet, a lot like Saturn. Its rings are mostly ice.',
  solar_system: 'Here is a tiny solar system. The planets closer to the sun orbit faster.',
  dna: 'This is a DNA double helix: two strands, joined by base pairs.',
  heart: 'A heart, beating just for you.',
  globe: 'Here is the Earth. The green dots are some of the places people use Muse.',
  molecule: 'A small molecule. Oxygen in red, hydrogen in white, nitrogen in blue.',
  rocket: 'Three, two, one... liftoff!',
  torus_knot: 'A torus knot: one tube that loops around itself, forever.',
  cube: 'A rounded cube. Try moving your head: it really is in 3D.',
  crystal: 'A crystal, catching the light.',
};
const JOKES = [
  'Why did the hologram break up with the screen? It needed more depth in the relationship.',
  'I tried to tell a joke in 2D, but it fell flat.',
  'What do you call a robot that always takes the long way? R2-Detour.',
];

export class MockMuse extends Emitter {
  constructor({ waitForQuiet = () => Promise.resolve() } = {}) {
    super();
    this.connected = true;
    this.muse = true;
    this.waitForQuiet = waitForQuiet;
    this._active = 0;
  }

  get kind() { return 'mock'; }

  connect() {
    this.emit('state', { connected: true, muse: true, label: 'Demo mode · scripted Muse' });
  }

  close() {}
  stopSpeech() {}

  say(text) {
    const id = requestId();
    this._turn(id, text);
    return id;
  }

  async voice() {
    const id = requestId();
    this._turn(id, null);
    return id;
  }

  async look() {
    const id = requestId();
    this._turn(id, '__look__');
    return id;
  }

  _invoke(command, params) {
    return new Promise((resolve) => this.emit('invoke', { id: requestId(), command, params }, resolve));
  }

  async _turn(id, text) {
    const turn = ++this._active;
    const live = () => turn === this._active;
    this.emit('turn', { id, state: 'sending' });
    await sleep(120);
    this.emit('turn', { id, state: 'sent' });
    const plan = this._plan(text);
    for (const s of plan.status || [['thinking', 'Thinking']]) {
      if (!live()) return;
      this.emit('status', { id, code: s[0], text: s[1] });
      await sleep(450 + Math.random() * 350);
    }
    for (const [command, params] of plan.actions || []) {
      if (!live()) return;
      await this._invoke(command, params);
      await sleep(150);
    }
    if (!live()) return;
    // Stream the answer a few words at a time, as Muse's deltas arrive.
    const words = plan.reply.split(' ');
    const message_id = 'm' + id;
    for (let i = 3; i < words.length; i += 3) {
      if (!live()) return;
      this.emit('reply', { id, message_id, text: words.slice(0, i).join(' '), done: false });
      await sleep(70);
    }
    this.emit('reply', { id, message_id, text: plan.reply, done: true, local: true });
    this.emit('turn', { id, state: 'done' });
    plan.after?.();
  }

  _plan(raw) {
    if (raw === null) {
      return { reply: 'In demo mode I can only read what you type, or hear you if this browser has speech recognition. Connect a Muse gadget to talk to the real me.', actions: [['avatar.express', { expression: 'confused', seconds: 3 }]] };
    }
    if (raw === '__look__') {
      return { reply: 'In demo mode I cannot see your camera. With a Muse gadget and the bridge started with --vision, I can.', actions: [['avatar.express', { expression: 'sad', seconds: 3 }]] };
    }
    const t = raw.toLowerCase().replace(/[^\w\s#']/g, ' ').replace(/\s+/g, ' ').trim();
    const has = (...w) => w.some((x) => new RegExp(`\\b${x}\\b`).test(t));

    if (has('hi', 'hello', 'hey', 'yo', 'morning', 'evening')) {
      return { reply: pick(['Hi! I am Muse, in glasses-free 3D. Ask me to show you something.', 'Hello! Good to see you. Lean left and right: I can see you move.']),
        actions: [['avatar.gesture', { gesture: 'wave' }], ['avatar.express', { expression: 'happy', seconds: 3 }]] };
    }
    if (has('help', 'what can you do', 'can you do', 'features', 'commands')) {
      return { reply: 'Here is what I can do on this display. With a real Muse I can also answer anything, set reminders, run commands on the gadget, and more.',
        actions: [['display.show_card', { title: 'Muse in 3D', body: 'Ask me to…', bullets: ['Show a planet, DNA, a rocket or a heart', 'Show a picture or a card', 'Wave, nod, spin or celebrate', 'Change the theme: ocean, aurora, sunrise', 'Pop out of the screen, or go flat 2D', 'Set a timer and remind you'] }]] };
    }
    for (const [word, shape] of Object.entries(SHAPE_WORDS)) {
      if (has(word)) {
        return { reply: SHAPE_LINES[shape], status: [['thinking', 'Thinking'], ['generating', 'Building it in 3D']],
          actions: [['display.show_shape', { shape, caption: shape.replace('_', ' ') }], ['avatar.express', { expression: 'excited', seconds: 2 }]] };
      }
    }
    if (has('picture', 'image', 'photo', 'painting', 'landscape')) {
      return { reply: 'I painted you a little landscape. With a real Muse I can show any image from the web.', status: [['thinking', 'Thinking'], ['generating', 'Painting']],
        actions: [['display.show_image', { data_base64: landscape(), mime_type: 'image/jpeg', caption: 'Sunset, by Muse' }]] };
    }
    if (has('joke', 'funny', 'laugh')) {
      return { reply: pick(JOKES), actions: [['avatar.express', { expression: 'wink', seconds: 4 }]] };
    }
    if (has('weather', 'rain', 'sunny', 'forecast')) {
      return { reply: 'In demo mode I cannot check the weather, so here is a pretend forecast. Connected to Muse, this card would be real.', status: [['thinking', 'Thinking'], ['researching', 'Checking the forecast']],
        actions: [['display.show_card', { title: 'Forecast (pretend)', body: 'Demo data, not a real forecast.', bullets: ['Now: 21° and clear', 'Tonight: 14°, light breeze', 'Tomorrow: 24°, sunny'], accent: '#ffb547' }]] };
    }
    if (has('time', 'clock')) {
      const now = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return { reply: `It is ${now}.`, actions: [] };
    }
    const timer = t.match(/timer (?:for )?(\d+) ?(second|seconds|sec|minute|minutes|min)/);
    if (timer) {
      const n = Math.min(600, Number(timer[1]) * (timer[2].startsWith('min') ? 60 : 1));
      return { reply: `Timer set for ${timer[1]} ${timer[2]}. I will tell you when it is done.`, actions: [['avatar.gesture', { gesture: 'nod' }]],
        after: () => setTimeout(async () => {
          await this._invoke('avatar.gesture', { gesture: 'celebrate' });
          await this._invoke('avatar.say', { text: 'Your timer is done!', expression: 'excited' });
        }, n * 1000) };
    }
    for (const g of ['wave', 'nod', 'shake', 'shrug', 'bow', 'spin', 'celebrate']) {
      if (t.includes(g) || (g === 'celebrate' && has('dance', 'party'))) {
        return { reply: pick(['Like this?', 'Ta-da!', 'How was that?']), actions: [['avatar.gesture', { gesture: g }]] };
      }
    }
    for (const e of ['happy', 'sad', 'surprised', 'confused', 'sleepy', 'excited', 'love', 'wink', 'thinking']) {
      if (t.includes(e)) return { reply: 'How is this?', actions: [['avatar.express', { expression: e, seconds: 5 }]] };
    }
    for (const th of ['ocean', 'aurora', 'sunrise', 'studio', 'night']) {
      if (t.includes(th)) return { reply: `Switching to ${th}.`, actions: [['display.set_theme', { theme: th }]] };
    }
    if (has('closer', 'pop', 'out')) return { reply: 'Coming out of the screen!', actions: [['display.set_depth', { pop: 70 }], ['avatar.express', { expression: 'excited', seconds: 2 }]] };
    if (has('back', 'behind', 'away')) return { reply: 'Back into the screen.', actions: [['display.set_depth', { pop: -50 }]] };
    if (has('flat', '2d')) return { reply: 'Going flat.', actions: [['display.set_mode', { mode: '2d' }]] };
    if (has('3d', 'depth')) return { reply: 'Back to glasses-free 3D.', actions: [['display.set_mode', { mode: '3d' }], ['display.set_depth', { strength: 100, pop: 0 }]] };
    if (has('clear', 'hide', 'remove', 'close')) return { reply: 'All clear.', actions: [['display.clear', {}]] };
    if (has('who', 'name', 'you')) {
      return { reply: 'I am Muse, here as a 3D avatar on a Leia display. In this demo I run on a script; connected to a Muse gadget, I am the real assistant.', actions: [['avatar.express', { expression: 'happy', seconds: 3 }]] };
    }
    return { reply: 'In demo mode I only know a few tricks. Try "show me a planet", "tell me a joke", or "what can you do". Connect a Muse gadget for everything else.',
      actions: [['avatar.express', { expression: 'confused', seconds: 3 }], ['avatar.gesture', { gesture: 'shrug' }]] };
  }

  /** A guided tour of every feature, for kiosks: `?tour` or the settings button. */
  async tour(onLine) {
    const lines = ['hello', 'what can you do', 'show me a planet', 'show me DNA', 'pop out of the screen', 'show me a picture', 'switch to aurora', 'celebrate', 'back into the screen', 'clear'];
    for (const line of lines) {
      onLine?.(line);
      this.say(line);
      await sleep(1200);
      await this.waitForQuiet();
      await sleep(900);
    }
    await this._invoke('display.set_theme', { theme: 'night' });
  }
}

/** A small procedural sunset, as JPEG base64, so demo mode needs no image files. */
function landscape() {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 400;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 400);
  sky.addColorStop(0, '#2b1b5a'); sky.addColorStop(0.55, '#ff7e6b'); sky.addColorStop(1, '#ffd29a');
  g.fillStyle = sky; g.fillRect(0, 0, 640, 400);
  g.fillStyle = '#fff1c4'; g.beginPath(); g.arc(420, 250, 46, 0, Math.PI * 2); g.fill();
  const ridge = (y, amp, color, seed) => {
    g.fillStyle = color; g.beginPath(); g.moveTo(0, 400);
    for (let x = 0; x <= 640; x += 8) g.lineTo(x, y - amp * (Math.sin(x * 0.011 + seed) * 0.6 + Math.sin(x * 0.027 + seed * 2) * 0.4));
    g.lineTo(640, 400); g.closePath(); g.fill();
  };
  ridge(290, 50, '#6b3a73', 1); ridge(325, 38, '#47285a', 4); ridge(360, 26, '#2a1940', 7);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}
