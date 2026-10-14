// Backend selection. With the local server (server/server.py) running, the page uses it: OpenDSS
// power flow, the multi-core Python what-if sweep, and the optional local-model tutor. Served
// statically (GitHub Pages) there is no server, so the in-browser engine in sim/ takes over.
// `?local` forces the in-browser engine.

async function req(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

const remote = {
  network: () => req('GET', 'api/network'),
  state: () => req('GET', 'api/state'),
  reset: (mode) => req('POST', 'api/reset', { mode }),
  operate: (device, close) => req('POST', 'api/operate', { device, close }),
  bess: (mode) => req('POST', 'api/bess', { mode }),
  identify: (item) => req('POST', 'api/identify', { item }),
  select: (item) => req('POST', 'api/select', { item }),
  hint: () => req('POST', 'api/hint', {}),
  ack: () => req('POST', 'api/ack', {}),
  whatif: () => req('POST', 'api/whatif', {}),
  ask: (question) => req('POST', 'api/ask', { question }),
};

export const api = { ...remote };
export let engine = 'server';

export async function initApi() {
  if (!new URLSearchParams(location.search).has('local')) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch('api/state', { signal: ctl.signal });
      clearTimeout(t);
      if (r.ok && (r.headers.get('content-type') || '').includes('json')) return engine;
    } catch { /* no server: fall through */ }
  }
  const { LocalBackend } = await import('./sim/local-backend.js');
  const data = await (await fetch('data/network.json')).json();
  const b = new LocalBackend(data);
  Object.assign(api, {
    network: () => b.network(), state: () => b.state(), reset: (m) => b.reset(m), operate: (d, c) => b.operate(d, c),
    bess: (m) => b.bess(m), identify: (i) => b.identify(i), select: (i) => b.select(i), hint: () => b.hint(),
    ack: () => b.ack(), whatif: () => b.whatifRun(), ask: (q) => b.ask(q),
  });
  engine = 'browser';
  return engine;
}
