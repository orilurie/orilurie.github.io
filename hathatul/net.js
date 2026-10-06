// Transports.
// Online: messages go through a public MQTT relay over wss:// on port 443, which works from
// any network (cellular carriers often block direct phone-to-phone WebRTC). The host also
// listens on PeerJS (direct WebRTC) as a fallback for when the relay can't be reached.
// ?local=1: BroadcastChannel between tabs of the same browser (testing).
//
// Host:   hostTransport(code, { onData(cid, msg), onClose(cid), onReady(), onReconnect(), onError(err) })
//         -> { send(cid, msg), close() }
// Client: clientTransport(code, id, { onOpen(), onData(msg), onClose(), onError(err) }) -> { send(msg), close() }
//         onOpen fires again after every reconnect.

const PREFIX = 'hathatul-room-';
const RELAY = 'wss://public.cloud.shiftr.io';
const RELAY_TIMEOUT = 7000;
const topic = code => `hathatul-v1/${code}`;
const useLocal = new URLSearchParams(location.search).has('local');
const rand = () => Math.random().toString(36).slice(2, 8);

export function hostTransport(code, h) {
  if (useLocal) return localHost(code, h);
  // Both transports feed the same handlers; replies go back the way the player came in.
  const route = new Map(); // cid -> transport
  let ready = false, failures = 0;
  const wrap = name => ({
    onData(cid, msg) { route.set(cid, transports[name]); h.onData(cid, msg); },
    onClose(cid) { route.delete(cid); h.onClose(cid); },
    onReady() { if (!ready) { ready = true; h.onReady(); } },
    onReconnect() { h.onReconnect?.(); },
    onError(err) {
      console.warn(name, err);
      if (!ready && ++failures === 2) h.onError(err);
    },
  });
  const transports = {};
  transports.relay = typeof mqtt !== 'undefined' ? relayHost(code, wrap('relay')) : (failures++, null);
  transports.peer = typeof Peer !== 'undefined' ? peerHost(code, wrap('peer')) : (failures++, null);
  if (failures === 2) setTimeout(() => h.onError({ type: 'network' }), 0);
  return {
    send(cid, msg) { route.get(cid)?.send(cid, msg); },
    close() { transports.relay?.close(); transports.peer?.close(); },
  };
}

export function clientTransport(code, id, h) {
  if (useLocal) return localClient(code, h);
  // Try the relay first; fall back to direct WebRTC if the relay can't be reached.
  let active = null;
  const usePeer = () => {
    if (active?.kind === 'peer') return;
    active?.close();
    active = typeof Peer !== 'undefined' ? peerClient(code, h) : null;
    if (!active) h.onError({ type: 'network' });
  };
  if (typeof mqtt === 'undefined') usePeer();
  else {
    active = relayClient(code, id, { ...h, onError: usePeer });
    const timer = setTimeout(() => { if (!active.connected()) usePeer(); }, RELAY_TIMEOUT);
    active.onFirstConnect = () => clearTimeout(timer);
  }
  return {
    send: msg => active?.send(msg),
    close: () => active?.close(),
  };
}

// ---------- MQTT relay ----------
const relayOpts = clientId => ({
  username: 'public', password: 'public', clientId,
  keepalive: 20, reconnectPeriod: 2000, connectTimeout: RELAY_TIMEOUT,
});

function parse(buf) {
  try { return JSON.parse(buf.toString()); } catch { return null; }
}

function relayHost(code, h) {
  const base = topic(code);
  const c = mqtt.connect(RELAY, relayOpts(`hh-${code}-${rand()}`));
  let connectedOnce = false;
  c.on('connect', () => {
    c.subscribe(`${base}/h`);
    if (!connectedOnce) { connectedOnce = true; h.onReady(); } else h.onReconnect();
  });
  c.on('message', (_t, buf) => {
    const m = parse(buf);
    if (!m || !m.from) return;
    if (m.kind === 'data') h.onData(m.from, m.msg);
    else if (m.kind === 'bye') h.onClose(m.from);
  });
  c.on('error', err => { if (!connectedOnce) h.onError(err); });
  return {
    send: (cid, msg) => c.publish(`${base}/c/${cid}`, JSON.stringify(msg)),
    close: () => c.end(true),
  };
}

function relayClient(code, id, h) {
  const base = topic(code);
  const cid = 'r' + id;
  const c = mqtt.connect(RELAY, {
    ...relayOpts(`hc-${cid}-${rand()}`),
    will: { topic: `${base}/h`, payload: JSON.stringify({ from: cid, kind: 'bye' }), qos: 0, retain: false },
  });
  const t = {
    kind: 'relay',
    connected: () => c.connected,
    onFirstConnect: null,
    send: msg => c.publish(`${base}/h`, JSON.stringify({ from: cid, kind: 'data', msg })),
    close: () => c.end(true),
  };
  let first = true;
  c.on('connect', () => {
    c.subscribe(`${base}/c/${cid}`, () => {
      if (first) { first = false; t.onFirstConnect?.(); }
      h.onOpen();
    });
  });
  c.on('message', (_t, buf) => {
    const m = parse(buf);
    if (m) h.onData(m);
  });
  c.on('error', err => { if (first) h.onError(err); });
  addEventListener('pagehide', () => t.send && c.publish(`${base}/h`, JSON.stringify({ from: cid, kind: 'bye' })));
  return t;
}

// ---------- PeerJS (direct WebRTC) ----------
function peerHost(code, h) {
  const peer = new Peer(PREFIX + code);
  const conns = new Map();
  peer.on('open', () => h.onReady());
  peer.on('error', err => h.onError(err));
  peer.on('disconnected', () => peer.reconnect());
  peer.on('connection', conn => {
    const cid = conn.connectionId;
    conn.on('open', () => conns.set(cid, conn));
    conn.on('data', msg => h.onData(cid, msg));
    conn.on('close', () => {
      conns.delete(cid);
      h.onClose(cid);
    });
  });
  return {
    send(cid, msg) {
      const c = conns.get(cid);
      if (c && c.open) c.send(msg);
    },
    close: () => peer.destroy(),
  };
}

function peerClient(code, h) {
  const peer = new Peer();
  let conn = null;
  peer.on('error', err => h.onError(err));
  peer.on('open', () => {
    conn = peer.connect(PREFIX + code, { reliable: true });
    conn.on('open', () => h.onOpen());
    conn.on('data', msg => h.onData(msg));
    conn.on('close', () => h.onClose());
  });
  return {
    kind: 'peer',
    send(msg) {
      if (conn && conn.open) conn.send(msg);
    },
    close: () => peer.destroy(),
  };
}

// ---------- Local (BroadcastChannel) ----------
function localHost(code, h) {
  const ch = new BroadcastChannel(PREFIX + code);
  ch.onmessage = ({ data }) => {
    if (data.to !== 'host') return;
    if (data.kind === 'data') h.onData(data.from, data.msg);
    else if (data.kind === 'bye') h.onClose(data.from);
  };
  setTimeout(() => h.onReady(), 0);
  return {
    send: (cid, msg) => ch.postMessage({ to: cid, kind: 'data', msg }),
    close: () => ch.close(),
  };
}

function localClient(code, h) {
  const ch = new BroadcastChannel(PREFIX + code);
  const me = 'c' + Math.random().toString(36).slice(2);
  ch.onmessage = ({ data }) => {
    if (data.to === me && data.kind === 'data') h.onData(data.msg);
  };
  addEventListener('pagehide', () => ch.postMessage({ to: 'host', from: me, kind: 'bye' }));
  setTimeout(() => h.onOpen(), 0);
  return {
    send: msg => ch.postMessage({ to: 'host', from: me, kind: 'data', msg }),
    close: () => ch.close(),
  };
}
