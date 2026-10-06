// Transports.
// Online: messages go through public MQTT relays over wss://, which work from any network
// (cellular carriers often block direct phone-to-phone WebRTC). PeerJS (direct WebRTC) is
// tried alongside them.
// ?local=1: BroadcastChannel between tabs of the same browser (testing).
//
// Host:   hostTransport(code, { onData(cid, msg), onClose(cid), onReady(), onReconnect(), onError(err) })
//         -> { send(cid, msg), close() }
// Client: clientTransport(code, id, { onOpen(), onData(msg), onClose(), onError(err) }) -> { send(msg), close() }
//         onOpen fires again after every reconnect; onError only when every path failed.

const PREFIX = 'hathatul-room-';
// Several independent public relays; the host listens on all of them and each player uses
// whichever answers first, so one slow or blocked server doesn't stop the game.
const RELAYS = [
  { id: 'a', url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public' },
  { id: 'b', url: 'wss://broker.hivemq.com:8884/mqtt' },
  { id: 'c', url: 'wss://broker.emqx.io:8084/mqtt' },
];
const topic = code => `hathatul-v1/${code}`;
const useLocal = new URLSearchParams(location.search).has('local');
const rand = () => Math.random().toString(36).slice(2, 8);

let log = () => {};
export const setNetLog = fn => { log = fn; };

export function hostTransport(code, h) {
  if (useLocal) return localHost(code, h);
  const route = new Map(); // cid -> the transport that player came in on
  const children = [];
  let ready = false, failures = 0;
  const wrap = name => ({
    onData(cid, msg) { route.set(cid, children.find(c => c.name === name)); h.onData(cid, msg); },
    onClose(cid) { route.delete(cid); h.onClose(cid); },
    onReady() {
      log(`host ${name} ready`);
      if (!ready) { ready = true; h.onReady(); }
    },
    onReconnect() { log(`host ${name} reconnected`); h.onReconnect?.(); },
    onError(err) {
      log(`host ${name} error ${err?.type || err?.message || err}`);
      if (!ready && ++failures === total) h.onError(err);
    },
  });
  const total = (typeof mqtt !== 'undefined' ? RELAYS.length : 0) + (typeof Peer !== 'undefined' ? 1 : 0);
  if (typeof mqtt !== 'undefined') for (const r of RELAYS) children.push({ name: r.id, ...relayHost(code, r, wrap(r.id)) });
  if (typeof Peer !== 'undefined') children.push({ name: 'peer', ...peerHost(code, wrap('peer')) });
  if (!total) setTimeout(() => h.onError({ type: 'network' }), 0);
  return {
    send(cid, msg) { route.get(cid)?.send(cid, msg); },
    close() { children.forEach(c => c.close()); },
  };
}

export function clientTransport(code, id, h) {
  if (useLocal) return localClient(code, h);
  // Every path is tried at once; the first one the host answers on is kept, the rest closed.
  const children = [];
  let locked = null, failures = 0;
  const wrap = name => {
    const child = { name, open: false, failed: false };
    child.handlers = {
      onOpen() {
        log(`${name} open`);
        child.open = true;
        if (!locked || locked === child) h.onOpen();
      },
      onData(msg) {
        if (!locked) {
          locked = child;
          log(`using ${name}`);
          children.filter(c => c !== child).forEach(c => c.close());
        }
        if (locked === child) h.onData(msg);
      },
      onClose() {
        log(`${name} closed`);
        child.open = false;
        if (locked === child) h.onClose();
      },
      onError(err) {
        log(`${name} error ${err?.type || err?.message || err}`);
        if (child.failed || locked) return;
        child.failed = true;
        if (++failures === children.length) h.onError(err);
      },
    };
    return child;
  };
  if (typeof mqtt !== 'undefined') {
    for (const r of RELAYS) {
      const child = wrap(r.id);
      Object.assign(child, relayClient(code, r, id, child.handlers));
      children.push(child);
    }
  }
  if (typeof Peer !== 'undefined') {
    const child = wrap('peer');
    Object.assign(child, peerClient(code, child.handlers));
    children.push(child);
  }
  if (!children.length) setTimeout(() => h.onError({ type: 'network' }), 0);
  return {
    send(msg) {
      if (locked) locked.send(msg);
      else children.forEach(c => c.open && c.send(msg));
    },
    close() { children.forEach(c => c.close()); },
  };
}

// ---------- MQTT relays ----------
const relayOpts = (r, clientId) => ({
  username: r.username, password: r.password, clientId,
  keepalive: 20, reconnectPeriod: 2000, connectTimeout: 10000,
});

function parse(buf) {
  try { return JSON.parse(buf.toString()); } catch { return null; }
}

function relayHost(code, r, h) {
  const base = topic(code);
  const c = mqtt.connect(r.url, relayOpts(r, `hh-${code}-${rand()}`));
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

function relayClient(code, r, id, h) {
  const base = topic(code);
  const cid = `${r.id}${id}`;
  const c = mqtt.connect(r.url, {
    ...relayOpts(r, `hc-${cid}-${rand()}`),
    will: { topic: `${base}/h`, payload: JSON.stringify({ from: cid, kind: 'bye' }), qos: 0, retain: false },
  });
  let first = true;
  c.on('connect', () => {
    c.subscribe(`${base}/c/${cid}`, () => {
      first = false;
      h.onOpen();
    });
  });
  c.on('close', () => { if (!first) h.onClose(); });
  c.on('message', (_t, buf) => {
    const m = parse(buf);
    if (m) h.onData(m);
  });
  c.on('error', err => { if (first) h.onError(err); });
  addEventListener('pagehide', () => c.connected && c.publish(`${base}/h`, JSON.stringify({ from: cid, kind: 'bye' })));
  return {
    send: msg => c.publish(`${base}/h`, JSON.stringify({ from: cid, kind: 'data', msg })),
    close: () => c.end(true),
  };
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
