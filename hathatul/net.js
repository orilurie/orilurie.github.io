// Transports: PeerJS (online, WebRTC) or BroadcastChannel (?local=1, same browser tabs).
// Host:   hostTransport(code, { onConnect(cid), onData(cid, msg), onClose(cid), onReady(), onError(err) })
//         -> { send(cid, msg), close() }
// Client: clientTransport(code, { onOpen(), onData(msg), onClose(), onError(err) }) -> { send(msg), close() }

const PREFIX = 'hathatul-room-';
const useLocal = new URLSearchParams(location.search).has('local');

export function hostTransport(code, h) {
  return useLocal ? localHost(code, h) : peerHost(code, h);
}

export function clientTransport(code, h) {
  return useLocal ? localClient(code, h) : peerClient(code, h);
}

function peerHost(code, h) {
  const peer = new Peer(PREFIX + code);
  const conns = new Map();
  peer.on('open', () => h.onReady());
  peer.on('error', err => h.onError(err));
  peer.on('disconnected', () => peer.reconnect());
  peer.on('connection', conn => {
    const cid = conn.connectionId;
    conn.on('open', () => {
      conns.set(cid, conn);
      h.onConnect(cid);
    });
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
    send(msg) {
      if (conn && conn.open) conn.send(msg);
    },
    close: () => peer.destroy(),
  };
}

function localHost(code, h) {
  const ch = new BroadcastChannel(PREFIX + code);
  ch.onmessage = ({ data }) => {
    if (data.to !== 'host') return;
    if (data.kind === 'hello') h.onConnect(data.from);
    else if (data.kind === 'data') h.onData(data.from, data.msg);
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
  ch.postMessage({ to: 'host', from: me, kind: 'hello' });
  addEventListener('pagehide', () => ch.postMessage({ to: 'host', from: me, kind: 'bye' }));
  setTimeout(() => h.onOpen(), 0);
  return {
    send: msg => ch.postMessage({ to: 'host', from: me, kind: 'data', msg }),
    close: () => ch.close(),
  };
}
