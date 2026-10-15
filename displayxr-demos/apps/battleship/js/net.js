// Online play between two browsers over WebRTC (PeerJS). The host's room code is its peer id on
// the public PeerJS broker; after the handshake the two pages talk directly. Each side keeps its
// own fleet secret and answers shots with hit/miss/sunk, like the paper game.

const PREFIX = 'dxr-battleship-';
const PEERJS = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';

async function loadPeer() {
  if (window.Peer) return;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = PEERJS;
    s.onload = res;
    s.onerror = () => rej(new Error('Could not load PeerJS'));
    document.head.appendChild(s);
  });
}

export function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

export class Net {
  constructor() {
    this.onMessage = () => {};
    this.onConnect = () => {};
    this.onClose = () => {};
    this.onStatus = () => {};
    this.conn = null;
  }

  async host(code) {
    await loadPeer();
    this.isHost = true;
    this.peer = new window.Peer(PREFIX + code);
    await this.opened();
    this.onStatus('Waiting for your opponent to join…');
    this.peer.on('connection', (conn) => {
      if (this.conn) { conn.close(); return; }
      this.attach(conn);
    });
  }

  async join(code) {
    await loadPeer();
    this.isHost = false;
    this.peer = new window.Peer();
    await this.opened();
    this.onStatus('Connecting…');
    this.attach(this.peer.connect(PREFIX + code.toUpperCase(), { reliable: true }));
  }

  opened() {
    return new Promise((res, rej) => {
      this.peer.on('open', res);
      this.peer.on('error', (e) => {
        const msg = e.type === 'unavailable-id' ? 'That room code is already in use.' : e.type === 'peer-unavailable' ? 'No game with that code. Check the code and that the host is waiting.' : e.message || String(e);
        this.onStatus(msg, true);
        rej(e);
      });
    });
  }

  attach(conn) {
    this.conn = conn;
    conn.on('open', () => this.onConnect());
    conn.on('data', (m) => this.onMessage(m));
    conn.on('close', () => { this.conn = null; this.onClose(); });
    conn.on('error', () => {});
  }

  send(msg) {
    this.conn?.open && this.conn.send(msg);
  }

  close() {
    try { this.conn?.close(); this.peer?.destroy(); } catch {}
    this.conn = null;
  }
}
