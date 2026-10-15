// The page's side of the bridge protocol (see README → Bridge protocol).
//
// A client emits the same events whether it talks to the real bridge (BridgeClient) or plays
// Muse locally (MockMuse in mock.js), so the app has one code path:
//
//   state   { connected, muse, label }    connection to the bridge, and the bridge's to Muse
//   welcome { node_id, muse_name, vision, commands, … }
//   turn    { id, state: 'sending' | 'sent' | 'done', timed_out? }
//   status  { id, code, text }            Muse's progress: thinking, researching, …
//   reply   { id, message_id, text, done, local? }   local: the page speaks it itself
//   mirror  { message_id, text }          Muse talking in another conversation
//   tts_start / tts_chunk (ArrayBuffer) / tts_end
//   invoke  ({ id, command, params }, respond)       Muse runs a display command
//   error   { id, error }

export class Emitter {
  constructor() { this._on = new Map(); }
  on(type, fn) { (this._on.get(type) || this._on.set(type, []).get(type)).push(fn); return this; }
  emit(type, ...args) { for (const fn of this._on.get(type) || []) { try { fn(...args); } catch (e) { console.error(e); } } }
}

let seq = 0;
export const requestId = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;

export class BridgeClient extends Emitter {
  constructor(url, key) {
    super();
    this.url = url;
    this.key = key;
    this.ws = null;
    this.connected = false;
    this.muse = false;
    this.welcome = null;
    this._retry = 1000;
    this._closed = false;
    this._timer = 0;
  }

  get kind() { return 'bridge'; }

  connect() {
    this._closed = false;
    clearTimeout(this._timer);
    let ws;
    try {
      const u = new URL(this.url);
      u.searchParams.set('key', this.key);
      ws = new WebSocket(u.toString());
    } catch (e) {
      this._state(`Bad bridge address: ${e.message}`);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this._state('Connecting to the bridge…');
    ws.onopen = () => { this._retry = 1000; ws.send(JSON.stringify({ type: 'hello', client: 'muse-avatar-page' })); };
    ws.onmessage = (e) => this._message(e.data);
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.muse = false;
      if (e.code === 4401) { this._closed = true; this._state('Wrong bridge key. Run `sudo muse-avatar url` on the gadget.'); return; }
      if (e.code === 4403) { this._closed = true; this._state('The bridge refused this page’s origin (see --allow-origin).'); return; }
      if (this._closed) { this._state('Disconnected'); return; }
      this._state(`Bridge offline. Retrying in ${Math.round(this._retry / 1000)} s…`);
      this._timer = setTimeout(() => this.connect(), this._retry);
      this._retry = Math.min(15000, this._retry * 1.7);
    };
  }

  close() {
    this._closed = true;
    clearTimeout(this._timer);
    this.ws?.close();
  }

  _state(label) {
    this.emit('state', { connected: this.connected, muse: this.muse, label });
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('The bridge is not connected.');
    this.ws.send(JSON.stringify(obj));
  }

  _message(data) {
    if (data instanceof ArrayBuffer) { this.emit('tts_chunk', data); return; }
    let m;
    try { m = JSON.parse(data); } catch { return; }
    switch (m.type) {
      case 'welcome':
        this.connected = true;
        this.muse = !!m.muse_connected;
        this.welcome = m;
        this.emit('welcome', m);
        this._state(this.muse ? `Connected to ${m.muse_name || 'Muse'}` : 'Bridge connected, waiting for Muse…');
        break;
      case 'muse':
        this.muse = !!m.connected;
        if (m.muse_name && this.welcome) this.welcome.muse_name = m.muse_name;
        this._state(this.muse ? `Connected to ${m.muse_name || this.welcome?.muse_name || 'Muse'}` : 'Bridge connected, Muse offline…');
        break;
      case 'invoke':
        this.emit('invoke', m, (result) => {
          try { this._send({ type: 'result', id: m.id, ...result }); } catch { /* the bridge times it out */ }
        });
        break;
      case 'turn': case 'status': case 'reply': case 'mirror': case 'tts_start': case 'tts_end': case 'error':
        this.emit(m.type, m);
        break;
    }
  }

  say(text, { speak = true } = {}) {
    const id = requestId();
    this._send({ type: 'say', id, text, speak });
    return id;
  }

  async voice(wavBlob, { speak = true } = {}) {
    const id = requestId();
    const data = await wavBlob.arrayBuffer();
    this._send({ type: 'voice', id, speak, mime_type: 'audio/wav' });
    this.ws.send(data);
    return id;
  }

  async look(jpegBlob, text, { speak = true } = {}) {
    const id = requestId();
    const data = await jpegBlob.arrayBuffer();
    this._send({ type: 'look', id, speak, text, mime_type: jpegBlob.type || 'image/jpeg' });
    this.ws.send(data);
    return id;
  }

  stopSpeech() {
    try { this._send({ type: 'stop_speech' }); } catch { /* nothing to stop */ }
  }
}
