// זירה – real-time arena shooter client. Talks to the game server (arena-server/, a Cloudflare
// Worker) over a WebSocket. The server is authoritative; this file predicts your own movement and
// shots so controls feel instant, and interpolates everyone else ~110 ms in the past.

import {
  W, H, R, FIRE_CD, MAX_HP, MAPS, COLORS, INTERP_MS, PICKUPS, MAX_PLAYERS, BULLET_R, DMG, FOV, VIEW_RANGE, NEAR,
  move, shotBullets, stepBullet, blocked, rayDist, WEAPONS, WEAPON_LIST, DASH, inBush, GRENADE, PROPS, propRect,
} from './arena-core.js?v=52';
import { play, haptic, settings as sfxSettings, toggle as toggleSfx } from './sfx.js?v=52';
import * as gfx from './arena-gfx.js?v=52';
import { gfxMode, setGfxMode } from './gfx-mode.js?v=52';
import { sound } from './arena-audio.js?v=52';
// where you hear from: you, or the camera while you're out
const ear = () => (me && !me.dead ? me : { x: view.x, y: view.y });
const heardAt = (x, y) => ({ at: { x, y }, listener: ear() });

export const VERSION = 52;
const params = new URLSearchParams(location.search);
const SERVER = params.get('server') || 'https://arena.hathatul.workers.dev';
const WS_URL = SERVER.replace(/^http/, 'ws');
const debugOn = params.get('debug') === '1';

fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' })
  .then(r => r.json())
  .then(({ version }) => {
    if (version <= VERSION) return;
    const key = `hathatul-reloaded-${version}`;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch {}
    params.set('v', version);
    location.replace(`${location.pathname}?${params}`);
  })
  .catch(() => {});

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
let pid = null;
try { pid = sessionStorage.getItem('arena-pid'); } catch {}
if (!pid) {
  pid = 'p' + Math.random().toString(36).slice(2, 10);
  try { sessionStorage.setItem('arena-pid', pid); } catch {}
}

// Your level grows with XP earned in matches (kept on this device).
const xpGet = () => Number(store.get('arena-xp')) || 0;
const levelOf = xp => Math.floor(Math.sqrt(xp / 25)) + 1;
const levelProgress = xp => { const l = levelOf(xp), a = 25 * (l - 1) ** 2, b = 25 * l ** 2; return (xp - a) / (b - a); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $app = document.getElementById('app');
const $game = document.getElementById('game');
const cv = document.getElementById('cv');
const g = cv.getContext('2d');
const $hud = document.getElementById('hud');
const $toast = document.getElementById('toast');

const ui = {
  screen: 'home', // home | connecting | room
  name: store.get('hathatul-name') || '',
  joinCode: (params.get('room') || '').toUpperCase(),
  error: '',
  busy: false,
};

function toast(text) {
  $toast.textContent = text;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), 2400);
}

// ---------------------------------------------------------------------------------------------
// Networking
let ws = null, wantOpen = false, retry = 0, code = null, pub = false;
let meta = null; // last 'room' message
let myId = pid;
const snaps = []; // { at, s }
let lastSnap = null;
let rtt = 0;

async function api(path) {
  const r = await fetch(SERVER + path, { cache: 'no-store' });
  if (!r.ok) throw new Error('server ' + r.status);
  return r.json();
}

function connect(c, isPub) {
  if (!history.state?.room) history.pushState({ room: 1 }, '', location.href);
  code = c; pub = isPub; wantOpen = true;
  ui.screen = 'connecting';
  render();
  open();
  history.replaceState(null, '', `?room=${c}${debugOn ? '&debug=1' : ''}${params.get('server') ? '&server=' + encodeURIComponent(SERVER) : ''}`);
}

function open() {
  const sock = new WebSocket(`${WS_URL}/ws/${code}${pub ? '?pub=1' : ''}`);
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    sock.send(JSON.stringify({ t: 'hello', id: pid, name: ui.name, lvl: levelOf(xpGet()) }));
  };
  sock.onmessage = e => { if (sock === ws) onMsg(JSON.parse(e.data)); };
  sock.onclose = () => {
    if (sock !== ws || !wantOpen) return;
    if (retry++ > 12) { leave('החיבור לשרת נותק'); return; }
    ui.reconnecting = true;
    renderHud();
    setTimeout(() => { if (wantOpen && ws === sock) open(); }, Math.min(4000, 400 * retry));
  };
}

function send(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }

setInterval(() => send({ t: 'ping', c: performance.now() }), 2000);

addEventListener('popstate', () => {
  if (ui.screen !== 'room' && ui.screen !== 'connecting') return;
  if (confirm('לצאת מהחדר?')) leave(); else history.pushState({ room: 1 }, '', location.href);
});
function leave(err = '') {
  wantOpen = false;
  try { ws?.close(); } catch {}
  ws = null; meta = null; lastSnap = null; snaps.length = 0;
  ui.screen = 'home';
  ui.error = err;
  history.replaceState(null, '', location.pathname + (debugOn ? '?debug=1' : ''));
  render();
}

function onMsg(m) {
  if (m.t === 'welcome') { myId = m.id; ui.reconnecting = false; return; }
  if (m.t === 'pong') { const r = performance.now() - m.c; rtt = rtt ? rtt * 0.7 + r * 0.3 : r; return; }
  if (m.t === 'err') { toast(m.m); if (m.fatal) leave(m.m); return; }
  if (m.t === 'emo') return;
  if (m.t === 'room') {
    const prevPhase = meta?.phase;
    meta = m;
    if (ui.screen !== 'room') { ui.screen = 'room'; }
    if (m.phase === 'count' && prevPhase !== 'count') resetRound();
    if (m.phase === 'count') ui.endDone = false;
    if (m.phase === 'end' && m.results && !ui.endDone) {
      ui.endDone = true;
      const mine = m.results?.find(r => r.id === myId);
      if (mine) {
        play(mine.place === 1 ? 'win' : 'lose'); haptic(mine.place === 1 ? 'win' : 'tap');
        const before = xpGet(), gain = 5 + mine.kills * 10 + (mine.place === 1 ? 25 : mine.place === 2 ? 10 : 0);
        store.set('arena-xp', before + gain);
        ui.xp = { gain, before, after: before + gain };
      } else ui.xp = null;
    }
    ui.nextAt = m.next != null ? performance.now() + m.next * 1000 : null;
    render();
    return;
  }
  if (m.t === 's') {
    const at = performance.now();
    snaps.push({ at, s: m });
    while (snaps.length > 100) snaps.shift(); // ~3 s, enough for the death replay
    lastSnap = m;
    if (m.pr) { const map = MAPS[meta?.map ?? 0]; curWalls = [...map.walls, ...(map.props || []).filter((_, i) => m.pr[i]).map(propRect)]; }
    for (const [x, y, a, side] of m.fs || []) {
      footprints.push({ x, y, a, side, life: 2 });
      sound('step', { ...heardAt(x, y), vol: 1.3 });
    }
    handleEvents(m.ev || []);
    reconcile(m);
    if (meta && m.ph !== meta.phase && !(meta.phase === 'end')) { meta.phase = m.ph; }
  }
}

// ---------------------------------------------------------------------------------------------
// Input
const input = { mx: 0, my: 0, a: 0, f: false };
const keys = new Set();
const sticks = { move: null, aim: null }; // { id, ox, oy, x, y }
let mouse = null; // { x, y, down }

const inGame = () => ui.screen === 'room' && meta && (meta.phase === 'count' || meta.phase === 'play');

addEventListener('keydown', e => {
  if (!inGame() || e.target.tagName === 'INPUT') return;
  keys.add(e.code);
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('keydown', e => {
  if (!inGame() || e.repeat || e.target.tagName === 'INPUT') return;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') dashPress();
  if (e.code === 'KeyG' || e.code === 'KeyQ' || e.code === 'KeyE') nadePress();
});
let nadeCount = 0;
function nadePress() {
  if (!me || me.dead || lastSnap?.ph !== 'play' || !(lastSnap?.me?.nd > 0)) return;
  nadeCount++;
  lastSent = 0; // send right away
  haptic('tap');
}
let dashCount = 0, localDash = { t: 0, cd: 0, dir: null };
function dashPress() {
  if (!me || me.dead || localDash.cd > 0 || lastSnap?.ph !== 'play') return;
  const l = Math.hypot(input.mx, input.my);
  const a = l > 0.2 ? Math.atan2(input.my, input.mx) : input.a;
  localDash = { t: DASH.time, cd: DASH.cd, dir: { mx: Math.cos(a), my: Math.sin(a) } };
  dashCount++;
  lastSent = 0; // send right away
  sound('dash');
  haptic('tap');
  puff(me.x, me.y, 4, '#c9b89a', 'dirt_01', 46, 30);
}
addEventListener('blur', () => { keys.clear(); sticks.move = sticks.aim = null; if (mouse) mouse.down = false; });

cv.addEventListener('pointerdown', e => {
  e.preventDefault();
  if (e.pointerType === 'mouse') {
    if (e.button === 2) { dashPress(); return; }
    mouse = { x: e.clientX, y: e.clientY, down: e.button === 0 };
    return;
  }
  const side = e.clientX < innerWidth / 2 ? 'move' : 'aim';
  if (sticks[side]) return;
  sticks[side] = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
  try { cv.setPointerCapture(e.pointerId); } catch {}
});
cv.addEventListener('pointermove', e => {
  if (e.pointerType === 'mouse') { mouse = { ...(mouse || {}), x: e.clientX, y: e.clientY }; return; }
  for (const s of Object.values(sticks)) if (s && s.id === e.pointerId) { s.x = e.clientX; s.y = e.clientY; }
});
const endPointer = e => {
  if (e.pointerType === 'mouse') { if (mouse) mouse.down = false; return; }
  for (const k of Object.keys(sticks)) if (sticks[k]?.id === e.pointerId) sticks[k] = null;
};
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);
cv.addEventListener('contextmenu', e => e.preventDefault());

const STICK = 60; // px
function readInput(me) {
  let mx = 0, my = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) my -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) my += 1;
  if (sticks.move) {
    // floating stick: small scaled dead zone, full speed at under half the radius (on a phone
    // you almost always want full speed), and the base follows your thumb if you drag past it
    const st = sticks.move;
    let dx = st.x - st.ox, dy = st.y - st.oy, l = Math.hypot(dx, dy);
    if (l > STICK) { st.ox = st.x - (dx / l) * STICK; st.oy = st.y - (dy / l) * STICK; dx = st.x - st.ox; dy = st.y - st.oy; l = STICK; }
    const DZ = 7;
    if (l > DZ) { const mag = Math.min(1, (l - DZ) / (STICK * 0.42)); mx = (dx / l) * mag; my = (dy / l) * mag; }
  }
  const l = Math.hypot(mx, my);
  if (l > 1) { mx /= l; my /= l; }
  input.mx = Math.round(mx * 100) / 100;
  input.my = Math.round(my * 100) / 100;
  input.f = false;
  if (sticks.aim) {
    const st = sticks.aim;
    let dx = st.x - st.ox, dy = st.y - st.oy;
    const la = Math.hypot(dx, dy);
    if (la > STICK) { st.ox = st.x - (dx / la) * STICK; st.oy = st.y - (dy / la) * STICK; dx = st.x - st.ox; dy = st.y - st.oy; }
    if (Math.hypot(dx, dy) > 14) input.a = me ? assistAim(me, Math.atan2(dy, dx)) : Math.atan2(dy, dx);
    else if (me) { const t = autoTarget(me); if (t) input.a = Math.atan2(t.y - me.y, t.x - me.x); }
    input.f = true;
  } else if (mouse && me) {
    const sp = toScreen(me.x, me.y);
    input.a = Math.atan2(mouse.y - sp.y, mouse.x - sp.x);
    input.f = !!mouse.down;
  } else if (mx || my) { // no aiming: you look where you walk
    let da = Math.atan2(my, mx) - input.a;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    input.a += da * 0.25;
  }
  if (keys.has('Space')) input.f = true;
  input.a = Math.round(input.a * 100) / 100;
}

// Tap-to-shoot on phones: aim at the nearest enemy you can see.
// Touch aim assist: if an enemy you can see is within a few degrees of where you're
// aiming, the aim is pulled most of the way onto them (a phone thumb isn't a mouse).
function assistAim(me, a) {
  const range = weaponRange();
  let best = null, bestErr = 0.2;
  for (const o of others) {
    if (!o.alive || o.id === myId) continue;
    const d = Math.hypot(o.x - me.x, o.y - me.y);
    if (d > range + R || blocked(me.x, me.y, o.x, o.y, walls())) continue;
    let da = Math.atan2(o.y - me.y, o.x - me.x) - a;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    const tol = Math.max(0.09, Math.atan2(R * 1.6, d)); // wider for close targets
    if (Math.abs(da) < Math.min(bestErr, tol)) { bestErr = Math.abs(da); best = da; }
  }
  return best === null ? a : a + best * 0.8;
}

const weaponRange = () => { const w = WEAPONS[WEAPON_LIST[lastSnap?.me?.w ?? 0] || 'pistol']; return w.speed * w.life; };

function autoTarget(me) {
  let best = null, bd = 720;
  for (const o of others) {
    if (!o.alive || o.id === myId) continue;
    const d = Math.hypot(o.x - me.x, o.y - me.y);
    if (d < bd && !blocked(me.x, me.y, o.x, o.y, walls())) { bd = d; best = o; }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Prediction
let seq = 0, lastSent = 0, sentF = false, sentNade = 0;
const outbox = []; // movement steps not sent yet
const pending = []; // { seq, mx, my, dt, mul }
let me = null; // predicted { x, y }
let localCd = 0, myShotNo = 0, kick = 0;
const ghosts = []; // dash after-images
const splats = []; // paint left where someone fell
const propHitAt = {}; // prop id -> time it was last hit (it wobbles)
const predicted = []; // your hits not yet confirmed by the server { id, dmg, t }
const flashes = []; // muzzle flashes
const holes = []; // bullet marks on walls
const hitAt = {}; // id -> time of last hit (white flash)
let announce = null; // { text, life }
let killerId = null; // who got you (the camera follows them while you wait)
let zoomKick = 0;
let tipUntil = 0; // round-start hint about pickups
let myBullets = [];
let others = []; // interpolated players for this frame
let curWalls = null; // the map's walls plus standing crates and barrels
const walls = () => curWalls || MAPS[meta?.map ?? 0].walls;
const myServer = () => lastSnap?.p.find(p => p[0] === myId);

function resetRound() {
  curWalls = null; replay = null; booms.length = 0;
  footprints.length = 0; ghosts.length = 0; flashes.length = 0; holes.length = 0; announce = null; killerId = null;
  localDash = { t: 0, cd: 0, dir: null }; dashCount = 0;
  me = null; pending.length = 0; myBullets = []; particles.length = 0; floaters.length = 0; feed.length = 0;
  snaps.length = 0; lastSnap = null; seenEv = new Set();
}

function reconcile(s) {
  const sp = s.p.find(p => p[0] === myId);
  if (!sp) { me = null; return; }
  if (!sp[5]) { me = { x: sp[1], y: sp[2], dead: true }; pending.length = 0; return; }
  const ack = s.ack?.[myId] ?? 0;
  while (pending.length && pending[0].seq <= ack) pending.shift();
  // replay the steps the server hasn't applied yet on top of its position
  const q = { x: sp[1], y: sp[2], vx: sp[10] || 0, vy: sp[11] || 0 };
  for (const u of pending) move(q, u, u.dt, walls(), u.mul, u.dash);
  if (!me || me.dead) { me = { x: q.x, y: q.y, vx: q.vx, vy: q.vy, cx: 0, cy: 0 }; return; }
  me.cx = q.x - me.x; me.cy = q.y - me.y; // blended in over the next frames
  if (debugOn) (window.__corr ||= []).push(Math.hypot(me.cx, me.cy));
  if (Math.hypot(me.cx, me.cy) > 90) { me.x = q.x; me.y = q.y; me.cx = me.cy = 0; }
}

function stepLocal(dt) {
  const sp = myServer();
  const playing = meta?.phase === 'play' && lastSnap?.ph === 'play';
  readInput(me && !me.dead ? me : null);
  const now = performance.now();
  const alive = me && !me.dead && sp && sp[5] && playing;
  if (alive) {
    // every frame is one movement step [seq, mx, my, dt, dash]; the server replays the same steps
    localDash.cd -= dt;
    let u;
    if (localDash.t > 0) {
      u = { seq: ++seq, ...localDash.dir, dt, mul: DASH.speed, dash: true, d: localDash.t === DASH.time ? 1 : 0 };
      localDash.t -= dt;
      ghosts.push({ x: me.x, y: me.y, id: myId, life: 0.25 });
    } else u = { seq: ++seq, mx: input.mx, my: input.my, dt, mul: sp[7] & 2 ? 1.4 : 1 };
    outbox.push([u.seq, u.dash ? u.mx : input.mx, u.dash ? u.my : input.my, Math.round(dt * 10000) / 10000, u.d || 0]);
    const mul = u.mul;
    const bx = me.x, by = me.y;
    move(me, u, dt, walls(), mul, u.dash);
    me.walked = (me.walked || 0) + Math.hypot(me.x - bx, me.y - by);
    if (me.walked > 46) { me.walked = 0; sound('step', { vol: 0.35 }); }
    pending.push(u);
    if (pending.length > 200) pending.shift();
    const k = Math.min(1, dt * 10);
    me.x += me.cx * k; me.y += me.cy * k;
    me.cx -= me.cx * k; me.cy -= me.cy * k;
    // own shots appear instantly
    localCd -= dt;
    const wname = WEAPON_LIST[lastSnap?.me?.w ?? 0] || 'pistol';
    if (input.f && localCd <= 0) {
      const w = WEAPONS[wname];
      localCd = w.cd;
      for (const b of shotBullets(me.x, me.y, input.a, sp[7] & 1, wname, myShotNo++)) myBullets.push(b);
      sound(wname === 'pistol' ? 'shot' : `shot_${wname}`);
      kick = w.kick;
      shake = Math.min(16, shake + w.kick * 0.6);
      flashes.push({ x: me.x, y: me.y, a: input.a, life: 0.06, big: wname === 'shotgun' || wname === 'sniper' });
      puff(me.x + Math.cos(input.a) * 40, me.y + Math.sin(input.a) * 40, 1, '#c8ccd6', 'smoke_04', 30, 20);
      // a shell flies out to the side
      const sa = input.a + Math.PI / 2 + (Math.random() - 0.5) * 0.6;
      particles.push({ x: me.x, y: me.y, vx: Math.cos(sa) * 140, vy: Math.sin(sa) * 140, life: 0.5, max: 0.5, color: '#e6b94a', size: 3 });
    }
  }
  // send 20 times a second (fire and dash at once); just aim/trigger, slowly, while not playing
  const urgent = input.f !== sentF || outbox.some(c => c[4]) || nadeCount !== sentNade;
  if (urgent) sentNade = nadeCount;
  if (inGame() && ((outbox.length && (urgent || now - lastSent >= 50)) || now - lastSent > 250)) {
    sentF = input.f;
    lastSent = now;
    send({ t: 'in', a: input.a, f: input.f ? 1 : 0, c: outbox.splice(0), r: Math.round(rtt), g: nadeCount }); // r: lets the server compensate for your ping
  }

  // predicted bullets
  myBullets = myBullets.filter(b => {
    const bw = WEAPONS[b.w] || WEAPONS.pistol;
    if (bw.returns && me && !me.dead) { // boomerang: comes back to you
      if (!b.back && b.life < bw.life * 0.5) b.back = true;
      if (b.back) {
        const dx = me.x - b.x, dy = me.y - b.y, d = Math.hypot(dx, dy);
        if (d < R + 8 || (b.backT = (b.backT || 0) + dt) > 2.5) return false;
        b.vx = (dx / d) * bw.speed; b.vy = (dy / d) * bw.speed; b.life = Math.max(b.life, 0.2);
      }
    }
    if (!stepBullet(b, dt, walls())) {
      if (bw.returns && !b.back && b.life > 0) { b.back = true; b.x = b.px; b.y = b.py; return true; } spark(b.x, b.y, '#ffd27a', 4); particles.push({ x: b.x, y: b.y, vx: 0, vy: 0, life: 0.18, max: 0.18, color: '#ffd98a', size: 46, sprite: 'spark_05', rot: Math.random() * 6, add: true, alpha: 1 }); sound('wall', heardAt(b.x, b.y)); holes.push({ x: b.x - b.vx * 0.006, y: b.y - b.vy * 0.006, life: 6 }); if (holes.length > 60) holes.shift(); return false; }
    for (const o of others) {
      if (!o.alive || o.id === myId) continue;
      if (Math.hypot(o.x - b.x, o.y - b.y) < R + BULLET_R) {
        if (b.hitIds?.includes(o.id)) continue;
        const team = meta?.mode === 'team' && playerById(o.id)?.team === playerById(myId)?.team;
        if (team) continue; // bullets pass through teammates
        // show the hit right away; the server confirms it a moment later
        spark(b.x, b.y, '#fff', 6);
        if (!(o.flags & 4)) {
          const dmg = b.dmg || DMG;
          predicted.push({ id: o.id, dmg, t: performance.now() });
          hitAt[o.id] = performance.now();
          floaters.push({ x: b.x, y: b.y - 10, text: `-${dmg}`, color: '#fff', life: 0.8 });
          sound('hit');
        }
        if (bw.pierce) { (b.hitIds ||= []).push(o.id); continue; }
        return false;
      }
    }
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Interpolation of other players
const INTERP = INTERP_MS; // ms (the server's lag compensation assumes the same value)
function interpolate(now) {
  others = [];
  if (!snaps.length) return;
  const t = replay ? replayAt(now) : now - INTERP;
  let a = snaps[0], b = snaps[snaps.length - 1];
  for (let i = snaps.length - 1; i > 0; i--) {
    if (snaps[i - 1].at <= t) { a = snaps[i - 1]; b = snaps[i]; break; }
  }
  const span = b.at - a.at;
  const k = span > 0 ? Math.max(0, Math.min(1, (t - a.at) / span)) : 1;
  for (const pb of b.s.p) {
    if (pb[5] === 2) continue; // alive but out of your sight
    const pa = a.s.p.find(p => p[0] === pb[0]) || pb;
    const jump = Math.hypot(pb[1] - pa[1], pb[2] - pa[2]) > 120 || pa[5] !== pb[5]; // respawned
    const lerp = (x, y) => (jump ? y : x + (y - x) * k);
    let da = pb[3] - pa[3];
    da = Math.atan2(Math.sin(da), Math.cos(da));
    others.push({ id: pb[0], x: lerp(pa[1], pb[1]), y: lerp(pa[2], pb[2]), aim: jump ? pb[3] : pa[3] + da * k, hp: Math.max(0, pb[4] - predicted.filter(q => q.id === pb[0]).reduce((a, q) => a + q.dmg, 0)), alive: pb[5] === 1, shield: pb[6], flags: pb[7], respawn: pb[8], w: WEAPON_LIST[pb[9]] || 'pistol', moving: Math.min(1, Math.hypot(pb[10] || 0, pb[11] || 0) / 200) });
  }
}

// ---------------------------------------------------------------------------------------------
// Effects
const particles = [];
const footprints = []; // tracks of players you can't see
const floaters = [];
const feed = []; // kill feed
let shake = 0, hurtFlash = 0;
let seenEv = new Set();
const playerById = id => meta?.players.find(p => p.id === id);
const nameOf = id => playerById(id)?.name || '?';
const TEAM_COLORS = ['#ff5d5d', '#4da3ff'], TEAM_NAMES = ['האדומה', 'הכחולה'];
const colorOf = id => { const p = playerById(id); return meta?.mode === 'team' && p?.team != null ? TEAM_COLORS[p.team] : p?.color || '#ccc'; };

// ---- death replay: after you fall, the last ~1.4 s play again in slow motion ----
let replay = null; // { from, start, until }
const REPLAY_LEN = 1400, REPLAY_RATE = 0.6;
const replayAt = now => replay.from + (now - replay.start) * REPLAY_RATE;
const viewSnap = now => {
  if (!replay) return lastSnap;
  const t = replayAt(now);
  let best = snaps[0];
  for (const x of snaps) if (x.at <= t) best = x;
  return best?.s || lastSnap;
};

// explosions on screen
const booms = [];

function puff(x, y, n, color, sprite, size, speed = 40) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random());
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.7 + Math.random() * 0.4, max: 1.1, color, size: size * (0.6 + Math.random() * 0.5), sprite, rot: Math.random() * 6, alpha: 0.45 });
  }
}

function spark(x, y, color, n = 8, speed = 160) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random());
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.3 + Math.random() * 0.25, max: 0.55, color, size: 2 + Math.random() * 2 });
  }
}

function shout(id, text) {
  announce = { text: id === myId ? text : `${nameOf(id)}: ${text}`, life: 2.2, mine: id === myId };
  if (id === myId) { sound('go'); haptic('win'); }
}

function handleEvents(evs) {
  for (const ev of evs) {
    switch (ev.k) {
      case 'shot':
        if (ev.id !== myId) {
          const wn = WEAPON_LIST[ev.w] || 'pistol';
          sound(wn === 'pistol' ? 'shot' : `shot_${wn}`, { ...heardAt(ev.x, ev.y), vol: 0.8 });
          const o = others.find(q => q.id === ev.id);
          if (o) flashes.push({ x: o.x, y: o.y, a: o.aim, life: 0.06, big: wn === 'shotgun' || wn === 'sniper' });
        }
        break;
      case 'hit': {
        if (ev.by === myId) { // already shown when your bullet touched them?
          const i = predicted.findIndex(q => q.id === ev.v);
          if (i >= 0) { predicted.splice(i, 1); break; }
          sound('hit');
        } else if (ev.v !== myId) sound('hit', { ...heardAt(ev.x, ev.y), vol: 0.6 });
        if (ev.by !== myId) spark(ev.x, ev.y, colorOf(ev.v), 7);
        hitAt[ev.v] = performance.now();
        floaters.push({ x: ev.x, y: ev.y - 10, text: `-${ev.dmg || DMG}`, color: ev.v === myId ? '#ff6b6b' : '#fff', life: 0.8 });
        if (ev.v === myId) { sound('hurt'); haptic('hurt'); shake = Math.min(14, shake + 7); hurtFlash = 0.35; }
        break;
      }
      case 'block': spark(ev.x, ev.y, '#9fe8ff', 5); sound('block', heardAt(ev.x, ev.y)); break;
      case 'wall': break;
      case 'kill': {
        if (ev.x !== undefined) {
          spark(ev.x, ev.y, colorOf(ev.v), 26, 260); spark(ev.x, ev.y, '#ffd27a', 12, 200);
          splats.push({ x: ev.x, y: ev.y, color: colorOf(ev.v), size: 90, rot: Math.random() * 6, life: 10 });
          if (splats.length > 20) splats.shift();
          puff(ev.x, ev.y, 6, '#9aa3b5', 'smoke_04', 70);
          particles.push({ x: ev.x, y: ev.y, vx: 0, vy: 0, life: 0.35, max: 0.35, color: '#ffcf7a', size: 160, sprite: 'light_02', add: true, alpha: 0.9 });
        }
        feed.push({ a: ev.a, v: ev.v, life: 5 });
        if (feed.length > 4) feed.shift();
        if (ev.x !== undefined && ev.v !== myId) sound('die', { ...heardAt(ev.x, ev.y), vol: 0.7 });
        if (ev.v === myId) {
          sound('die'); haptic('die'); shake = 18; killerId = ev.a;
          const t = performance.now() - INTERP;
          replay = { from: t - REPLAY_LEN, start: performance.now() + 250, until: performance.now() + 250 + REPLAY_LEN / REPLAY_RATE };
        }
        else if (ev.a === myId) { sound('kill'); haptic('tap'); zoomKick = 0.07; floaters.push({ x: ev.x, y: ev.y - 30, text: '💀 +1', color: '#ffd27a', life: 1.2 }); }
        break;
      }
      case 'pick':
        spark(ev.x, ev.y, '#7dffb0', 10);
        if (ev.id === myId) {
          sound('pickup'); haptic('tap');
          const info = { heal: '+40 חיים', shield: 'מגן 50', triple: '3 כדורים בכל ירייה – 8 שניות', speed: 'מהירות – 6 שניות', smg: 'יורה מהר! 45 כדורים', shotgun: '6 כדורים בכל ירייה, מקרוב – 8 יריות', sniper: 'טווח ארוך, 70 נזק – 5 יריות' }[ev.type];
          announce = { text: `${PICKUPS[ev.type].icon} ${PICKUPS[ev.type].name}: ${info}`, life: 2.4, mine: true, small: true };
        }
        break;
      case 'boom': {
        booms.push({ x: ev.x, y: ev.y, r: ev.r, t0: performance.now() });
        splats.push({ x: ev.x, y: ev.y, color: '#2a2018', size: ev.r * 1.3, rot: Math.random() * 6, life: 12 });
        if (splats.length > 24) splats.shift();
        puff(ev.x, ev.y, 7, '#8a8f99', 'smoke_04', ev.r * 0.9, 70);
        particles.push({ x: ev.x, y: ev.y, vx: 0, vy: 0, life: 0.3, max: 0.3, color: '#ffbf6a', size: ev.r * 3.2, sprite: 'light_02', add: true, alpha: 1 });
        spark(ev.x, ev.y, '#ffcf7a', 22, 320);
        const ear0 = ear(), d = Math.hypot(ev.x - ear0.x, ev.y - ear0.y);
        shake = Math.min(26, shake + Math.max(0, 22 - d / 30));
        sound('boom', { ...heardAt(ev.x, ev.y), vol: 1.4 });
        if (d < 300) haptic('die');
        break;
      }
      case 'break': if (ev.type === 'crate') { spark(ev.x, ev.y, '#b07a3c', 18, 220); puff(ev.x, ev.y, 3, '#c9b89a', 'dirt_01', 60, 40); sound('crate', heardAt(ev.x, ev.y)); } break;
      case 'phit': propHitAt[ev.id] = performance.now(); break;
      case 'throw': sound('throw', ev.id === myId ? {} : heardAt(ev.x, ev.y)); break;
      case 'dash': puff(ev.x, ev.y, 4, '#c9b89a', 'dirt_01', 46, 30); if (ev.id !== myId) sound('dash', { ...heardAt(ev.x, ev.y), vol: 0.7 }); break;
      case 'empty': if (ev.id === myId) { sound('empty'); floaters.push({ x: me?.x ?? 0, y: (me?.y ?? 0) - 30, text: '🔫 חזרת לאקדח', color: '#ffd27a', life: 1.2 }); } break;
      case 'multi': shout(ev.id, ['', '', 'דאבל קיל! ✌️', 'טריפל קיל! 🔥', 'מולטי קיל! 💥'][Math.min(4, ev.n)]); break;
      case 'streak': shout(ev.id, `ברצף של ${ev.n}! 👑`); break;
      case 'stop': announce = { text: `${nameOf(ev.a)} עצר/ה את הרצף של ${nameOf(ev.v)} (+1) 🛑`, life: 2.5 }; if (ev.a === myId) sound('kill'); break;
      case 'go': sound('go'); haptic('turn'); tipUntil = performance.now() + 7000;
        if (meta?.mode === 'team' && playerById(myId)?.team != null) announce = { text: `את/ה בקבוצה ${TEAM_NAMES[playerById(myId).team]}!`, life: 2.6, mine: true };
        break;
      case 'spawn': break;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering
let view = { x: W / 2, y: H / 2, s: 1 };
const look = { x: 0, y: 0 };
let dpr = 1;
function resize() {
  dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = Math.round(innerWidth * dpr);
  cv.height = Math.round(innerHeight * dpr);
}
addEventListener('resize', resize);
resize();

function toScreen(x, y) { return { x: (x - view.x) * view.s + innerWidth / 2, y: (y - view.y) * view.s + innerHeight / 2 }; }

function drawWorld(now, dt) {
  const cw = innerWidth, ch = innerHeight;
  const portrait = ch > cw;
  view.s = (portrait ? cw / 640 : Math.min(cw / 960, ch / 560)) * (1 + zoomKick);
  // camera follows you (or, while you're out, whoever is still alive)
  let focus = me && !me.dead ? me : null;
  if (!focus) {
    const live = others.find(o => o.alive && o.id !== myId);
    const mine = others.find(o => o.id === myId);
    const killer = killerId && others.find(o => o.id === killerId && o.alive);
    focus = mine && mine.alive ? mine : killer || live || mine || { x: W / 2, y: H / 2 };
  }
  const halfW = cw / 2 / view.s, halfH = ch / 2 / view.s;
  const clampV = (v, half, max) => (half * 2 >= max + 160 ? max / 2 : Math.max(half - 80, Math.min(max + 80 - half, v)));
  // look ahead: the camera leans toward where you aim, so you see more of what's in front of you
  const alive = me && !me.dead && focus === me;
  const la = alive ? (input.f || sticks.aim || mouse ? 120 : 70) : 0;
  look.x += (Math.cos(input.a) * la - look.x) * Math.min(1, dt * 4);
  look.y += (Math.sin(input.a) * la - look.y) * Math.min(1, dt * 4);
  const tx = clampV(focus.x + look.x, halfW, W), ty = clampV(focus.y + look.y, halfH, H);
  view.x += (tx - view.x) * Math.min(1, dt * 10);
  view.y += (ty - view.y) * Math.min(1, dt * 10);

  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.direction = 'ltr';
  g.fillStyle = '#121826';
  g.fillRect(0, 0, cw, ch);
  const sx = shake ? (Math.random() - 0.5) * shake : 0, sy = shake ? (Math.random() - 0.5) * shake : 0;
  g.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * (cw / 2 - view.x * view.s + sx), dpr * (ch / 2 - view.y * view.s + sy));

  // floor (textured per map) and paint splats where players fell
  const mapI = meta?.map ?? 0;
  gfx.drawFloor(g, mapI, W, H);
  for (const d of splats) gfx.drawSprite(g, 'scorch_01', d.color, d.x, d.y, d.size, d.rot, Math.min(0.75, d.life / 2));

  const s = viewSnap(now);
  // pickups
  for (const [, type, x, y] of s?.u || []) {
    const pulse = 1 + Math.sin(now / 200 + x) * 0.08;
    g.fillStyle = 'rgba(125,255,176,0.18)';
    g.beginPath(); g.arc(x, y, 22 * pulse, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(125,255,176,0.7)'; g.lineWidth = 2; g.stroke();
    g.font = '22px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    g.fillText(PICKUPS[type].icon, x, y + 1);
    g.font = '600 11px Rubik, sans-serif'; g.textBaseline = 'top';
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.strokeText(PICKUPS[type].name, x, y + 25); g.fillStyle = '#c9ffe0'; g.fillText(PICKUPS[type].name, x, y + 25);
  }

  // bullets: others' from the server (extrapolated), yours predicted
  const age = s && !replay ? (now - snaps[snaps.length - 1].at) / 1000 : 0;
  for (const [, x, y, vx, vy, owner, wi] of s?.b || []) {
    if (owner === myId && !replay) continue;
    drawBullet(x + vx * age, y + vy * age, vx, vy, colorOf(owner), WEAPON_LIST[wi]);
  }
  // grenades: a dark ball whose light blinks faster as the fuse runs out
  for (const [, x, y, fuse] of s?.gr || []) gfx.drawGrenade(g, x, y, fuse, GRENADE.r, now);
  for (const b of myBullets) drawBullet(b.x, b.y, b.vx, b.vy, colorOf(myId), b.w);

  // dash after-images
  for (const gh of ghosts) {
    g.globalAlpha = gh.life * 1.6;
    g.fillStyle = colorOf(gh.id);
    g.beginPath(); g.arc(gh.x, gh.y, R * 0.9, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  // players
  for (const o of others) {
    if (!o.alive) continue;
    if (o.id !== myId && o.flags & 8) ghosts.push({ x: o.x, y: o.y, id: o.id, life: 0.25 });
    const mine = o.id === myId && me && !me.dead;
    const p = mine ? { ...o, x: me.x - Math.cos(input.a) * kick, y: me.y - Math.sin(input.a) * kick, aim: input.a, w: WEAPON_LIST[lastSnap?.me?.w ?? 0] } : o;
    drawPlayer(p, now);
  }
  // walls are drawn over the players so someone behind a wall is partly hidden, like in 3D
  gfx.drawWalls(g, mapI, MAPS[mapI].walls);
  // crates and barrels still standing
  (MAPS[mapI].props || []).forEach((q, i) => {
    if (s?.pr && !s.pr[i]) return;
    const wob = Math.max(0, 1 - (now - (propHitAt[i] || -1e9)) / 200);
    gfx.drawProp(g, q[0], q[1], q[2], PROPS[q[0]].size, wob);
  });
  // explosions
  for (let i = booms.length - 1; i >= 0; i--) { if (!gfx.drawBoom(g, booms[i], now)) booms.splice(i, 1); }
  for (const h of holes) {
    g.globalAlpha = Math.min(1, h.life / 2) * 0.7;
    g.fillStyle = '#141a28';
    g.beginPath(); g.arc(h.x, h.y - gfx.WALL_H, 3, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  // muzzle flashes
  for (const f of flashes) gfx.drawMuzzle(g, f.x, f.y, f.a, f.big, f.life);
  // bushes cover whoever is inside (yours is see-through so you know where you are)
  const meIn = me && !me.dead && inBush(me.x, me.y, meta?.map ?? 0);
  for (const [bx, by, br] of MAPS[mapI].bushes || []) gfx.drawBush(g, bx, by, br, now, meIn && Math.hypot(me.x - bx, me.y - by) < br);

  // particles
  for (const pt of particles) {
    const a = Math.max(0, pt.life / pt.max);
    if (pt.sprite) { gfx.drawSprite(g, pt.sprite, pt.color, pt.x, pt.y, pt.size * (1.6 - a * 0.6), pt.rot || 0, a * (pt.alpha ?? 0.6), pt.add); continue; }
    g.globalAlpha = a;
    g.fillStyle = pt.color;
    g.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
  }
  g.globalAlpha = 1;

  // darkness outside what you can see (soft edges); muzzle flashes light up their surroundings
  const looking = me && !me.dead && meta?.phase === 'play';
  if (looking) {
    const lights = flashes.map(f => ({ x: f.x + Math.cos(f.a) * 40, y: f.y + Math.sin(f.a) * 40, r: f.big ? 200 : 140, a: 0.6 }));
    lights.push({ x: me.x, y: me.y, r: 160, a: 0.5 });
    gfx.drawDarkness(g, { x: view.x, y: view.y, s: view.s }, cw, ch, dpr, visionPolygon(me.x, me.y, input.a), lights);
  }
  // aim line (touch: while the aim thumb is down): a dotted line to the weapon's range, stopped by
  // walls; it turns red with a reticle when it crosses someone you can see. Shotgun: a cone.
  if (looking && (sticks.aim || !matchMedia('(pointer: fine)').matches)) drawAimLine(now);

  // footprints: you can't see them, but you notice their tracks
  for (const f of footprints) {
    g.save();
    g.translate(f.x - Math.sin(f.a) * 6 * f.side, f.y + Math.cos(f.a) * 6 * f.side);
    g.rotate(f.a);
    g.globalAlpha = Math.min(0.75, f.life * 0.6);
    g.fillStyle = '#e8ecf5';
    g.beginPath(); g.ellipse(2, 0, 6, 3.6, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(-7, 0, 3, 2.6, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  g.globalAlpha = 1;

  // shrinking zone
  if (s?.z) {
    const [zx, zy, zr] = s.z;
    g.fillStyle = 'rgba(255,40,60,0.22)';
    g.beginPath();
    g.rect(-200, -200, W + 400, H + 400);
    g.arc(zx, zy, zr, 0, Math.PI * 2, true);
    g.fill('evenodd');
    g.strokeStyle = 'rgba(255,90,100,0.9)';
    g.lineWidth = 4;
    g.setLineDash([18, 12]);
    g.beginPath(); g.arc(zx, zy, zr, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
  }

  for (const o of drawnPlayers) drawLabel(o, now);
  drawnPlayers.length = 0;

  // floating text
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const f of floaters) {
    g.globalAlpha = Math.min(1, f.life * 2);
    g.font = 'bold 18px Rubik, sans-serif';
    g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.strokeText(f.text, f.x, f.y);
    g.fillStyle = f.color; g.fillText(f.text, f.x, f.y);
  }
  g.globalAlpha = 1;

  // screen space: arrows to enemies off screen, joysticks, hurt flash
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (me && !me.dead) {
    for (const o of others) {
      if (!o.alive || o.id === myId) continue;
      const p = toScreen(o.x, o.y);
      if (p.x > 0 && p.x < cw && p.y > 0 && p.y < ch) continue;
      const a = Math.atan2(p.y - ch / 2, p.x - cw / 2);
      const m = 22;
      const k = Math.min((cw / 2 - m) / Math.abs(Math.cos(a) || 1e-6), (ch / 2 - m) / Math.abs(Math.sin(a) || 1e-6));
      const ax = cw / 2 + Math.cos(a) * k, ay = ch / 2 + Math.sin(a) * k;
      g.save(); g.translate(ax, ay); g.rotate(a);
      g.fillStyle = colorOf(o.id); g.globalAlpha = 0.85;
      g.beginPath(); g.moveTo(12, 0); g.lineTo(-8, -9); g.lineTo(-8, 9); g.closePath(); g.fill();
      g.restore();
    }
  }
  drawMinimap(cw, ch);
  for (const st of Object.values(sticks)) {
    if (!st) continue;
    g.globalAlpha = 0.35;
    g.strokeStyle = '#fff'; g.lineWidth = 3;
    g.beginPath(); g.arc(st.ox, st.oy, STICK, 0, Math.PI * 2); g.stroke();
    const dx = st.x - st.ox, dy = st.y - st.oy, l = Math.hypot(dx, dy), k = l > STICK ? STICK / l : 1;
    g.globalAlpha = 0.5; g.fillStyle = '#fff';
    g.beginPath(); g.arc(st.ox + dx * k, st.oy + dy * k, 26, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  if (hurtFlash > 0) {
    const grd = g.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.3, cw / 2, ch / 2, Math.max(cw, ch) * 0.7);
    grd.addColorStop(0, 'rgba(255,0,0,0)');
    grd.addColorStop(1, `rgba(255,0,0,${hurtFlash})`);
    g.fillStyle = grd; g.fillRect(0, 0, cw, ch);
  }
}

// The area you can see: the view cone out to VIEW_RANGE plus a NEAR circle, cut by walls.
function visionPolygon(x, y, aim) {
  const pts = [];
  const n = 240;
  const inCone = a => { let d = a - aim; d = Math.atan2(Math.sin(d), Math.cos(d)); return Math.abs(d) <= FOV / 2; };
  const angles = [];
  for (let i = 0; i < n; i++) angles.push(aim - Math.PI + (i / n) * Math.PI * 2);
  angles.push(aim - FOV / 2 - 1e-4, aim - FOV / 2 + 1e-4, aim + FOV / 2 - 1e-4, aim + FOV / 2 + 1e-4);
  angles.sort((a, b) => a - b);
  for (const a of angles) {
    const d = rayDist(x, y, a, walls(), inCone(a) ? VIEW_RANGE : NEAR);
    pts.push(x + Math.cos(a) * d, y + Math.sin(a) * d);
  }
  return pts;
}

// Small map in the corner: walls, bushes, zone, bonuses, you, and whoever you can see.
function drawMinimap(cw, ch) {
  const mw = Math.min(150, cw * 0.3), k = mw / W, mh = H * k;
  const ox = 10, oy = Math.max(8, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0) + 52;
  g.save();
  g.translate(ox, oy);
  g.fillStyle = 'rgba(10,14,24,0.6)'; g.fillRect(-3, -3, mw + 6, mh + 6);
  g.fillStyle = 'rgba(40,52,80,0.9)'; g.fillRect(0, 0, mw, mh);
  g.beginPath(); g.rect(0, 0, mw, mh); g.clip();
  g.fillStyle = '#7f8db3';
  for (const [x, y, w, h] of walls()) g.fillRect(x * k, y * k, Math.max(1.5, w * k), Math.max(1.5, h * k));
  g.fillStyle = '#3a8f52';
  for (const [x, y, rr] of MAPS[meta?.map ?? 0].bushes || []) { g.beginPath(); g.arc(x * k, y * k, rr * k, 0, Math.PI * 2); g.fill(); }
  const s = lastSnap;
  if (s?.z) { g.strokeStyle = '#ff5a64'; g.lineWidth = 1.5; g.beginPath(); g.arc(s.z[0] * k, s.z[1] * k, s.z[2] * k, 0, Math.PI * 2); g.stroke(); }
  for (const [, , x, y] of s?.u || []) { g.fillStyle = '#7dffb0'; g.fillRect(x * k - 1.5, y * k - 1.5, 3, 3); }
  for (const o of others) {
    if (!o.alive || o.id === myId) continue;
    g.fillStyle = colorOf(o.id); g.beginPath(); g.arc(o.x * k, o.y * k, 3, 0, Math.PI * 2); g.fill();
  }
  if (me && !me.dead) {
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.beginPath(); g.moveTo(me.x * k, me.y * k); g.arc(me.x * k, me.y * k, 720 * k, input.a - 0.95, input.a + 0.95); g.closePath(); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(me.x * k, me.y * k, 3.5, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

// the server's bullets don't say which weapon fired them; their speed does
const weaponBySpeed = sp => (sp > 1200 ? 'sniper' : sp < 740 ? 'shotgun' : sp > 800 ? 'smg' : 'pistol');
function drawAimLine(now) {
  const wname = WEAPON_LIST[lastSnap?.me?.w ?? 0] || 'pistol', w = WEAPONS[wname];
  const a = input.a, sx = me.x + Math.cos(a) * (R + 6), sy = me.y + Math.sin(a) * (R + 6);
  const len = Math.min(w.speed * w.life, rayDist(sx, sy, a, walls(), w.speed * w.life));
  // first visible enemy on the line
  let hit = null, hd = len;
  for (const o of others) {
    if (!o.alive || o.id === myId) continue;
    const t = (o.x - sx) * Math.cos(a) + (o.y - sy) * Math.sin(a);
    if (t < 0 || t > hd) continue;
    const px = sx + Math.cos(a) * t, py = sy + Math.sin(a) * t;
    if (Math.hypot(o.x - px, o.y - py) < R + 4) { hd = t; hit = o; }
  }
  const active = !!sticks.aim;
  const color = hit ? '255,90,90' : '255,255,255';
  g.save();
  if (w.pellets > 1) { // shotgun spread
    g.fillStyle = `rgba(${color},${active ? 0.16 : 0.07})`;
    g.beginPath(); g.moveTo(sx, sy); g.arc(sx, sy, len, a - w.spread / 2, a + w.spread / 2); g.closePath(); g.fill();
  }
  g.strokeStyle = `rgba(${color},${active ? 0.75 : 0.28})`;
  g.lineWidth = active ? 3 : 2;
  g.setLineDash([10, 9]);
  g.lineDashOffset = -now / 25;
  g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + Math.cos(a) * hd, sy + Math.sin(a) * hd); g.stroke();
  g.setLineDash([]);
  if (hit) { // reticle on the target
    g.strokeStyle = 'rgba(255,90,90,0.95)'; g.lineWidth = 2.5;
    const rr = R + 8 + Math.sin(now / 90) * 2;
    g.beginPath(); g.arc(hit.x, hit.y, rr, 0, Math.PI * 2); g.stroke();
    for (let k = 0; k < 4; k++) {
      const q = k * Math.PI / 2;
      g.beginPath(); g.moveTo(hit.x + Math.cos(q) * (rr - 6), hit.y + Math.sin(q) * (rr - 6)); g.lineTo(hit.x + Math.cos(q) * (rr + 6), hit.y + Math.sin(q) * (rr + 6)); g.stroke();
    }
  } else if (active) {
    g.fillStyle = `rgba(${color},0.8)`;
    g.beginPath(); g.arc(sx + Math.cos(a) * hd, sy + Math.sin(a) * hd, 4, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

function drawBullet(x, y, vx, vy, color, weapon) {
  gfx.drawBullet(g, x, y, vx, vy, color, weapon || weaponBySpeed(Math.hypot(vx, vy)));
}

const drawnPlayers = [];
function drawPlayer(p, now) {
  const color = colorOf(p.id);
  const seat = Math.max(0, COLORS.indexOf(playerById(p.id)?.color));
  const since = performance.now() - (hitAt[p.id] || -1e9);
  const moving = p.id === myId && me ? Math.min(1, Math.hypot(me.vx || 0, me.vy || 0) / 200) : p.moving || 0;
  const ok = gfx.drawCharacter(g, { x: p.x, y: p.y, aim: p.aim, w: p.w || 'pistol', moving, dash: !!(p.flags & 8), flash: since < 120 ? 0.9 * (1 - since / 120) : 0, bot: playerById(p.id)?.bot }, seat, color, now);
  if (!ok) { g.fillStyle = color; g.beginPath(); g.arc(p.x, p.y, R, 0, Math.PI * 2); g.fill(); }
  if (p.flags & 2) gfx.drawGlow(g, p.x, p.y, 34, '#7fd8ff', 0.35); // speed
  if (p.flags & 1) gfx.drawGlow(g, p.x, p.y, 34, '#ffd27a', 0.3); // triple shot
  if (p.flags & 4) { // spawn protection bubble
    g.strokeStyle = `rgba(159,232,255,${0.5 + Math.sin(now / 80) * 0.3})`; g.lineWidth = 3;
    g.beginPath(); g.arc(p.x, p.y, R + 9, 0, Math.PI * 2); g.stroke();
  }
  if (p.shield > 0) {
    g.strokeStyle = 'rgba(90,180,255,0.9)'; g.lineWidth = 3;
    g.beginPath(); g.arc(p.x, p.y, R + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (p.shield / 50)); g.stroke();
  }
  drawnPlayers.push(p);
}

// name, level, health and crown: drawn last so walls and bushes never cover them
function drawLabel(p, now) {
  g.font = `600 13px Rubik, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'bottom';
  g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.6)';
  const lv = playerById(p.id)?.lvl;
  const nm = (lv ? `⭐${lv} ` : '') + nameOf(p.id);
  g.strokeText(nm, p.x, p.y - R - 14); g.fillStyle = '#fff'; g.fillText(nm, p.x, p.y - R - 14);
  const bw = 40;
  g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(p.x - bw / 2, p.y - R - 12, bw, 5);
  g.fillStyle = p.hp > 50 ? '#3ccf7a' : p.hp > 25 ? '#ffb02e' : '#ff4d4d';
  g.fillRect(p.x - bw / 2, p.y - R - 12, bw * Math.max(0, p.hp) / MAX_HP, 5);
  if (p.flags & 16) { g.font = '18px sans-serif'; g.fillStyle = '#fff'; g.fillText('👑', p.x, p.y - R - 30); }
}

// ---------------------------------------------------------------------------------------------
// HUD (DOM over the canvas)
let hudKey = '';
function renderHud() {
  if (!meta || !inGameOrEnd()) { $hud.innerHTML = ''; hudKey = ''; return; }
  const s = lastSnap;
  const mine = s?.p.find(p => p[0] === myId);
  const players = meta.players.filter(p => p.inRound).slice().sort((a, b) => b.k - a.k || a.d - b.d);
  const alive = s ? s.p.filter(p => p[5]).length : 0;
  const tl = s?.tl;
  let center = '';
  if (meta.phase === 'count' || s?.ph === 'count') center = `<div class="ar-count">${Math.max(1, Math.ceil(tl ?? 3))}</div>`;
  else if (replay && performance.now() < replay.until) center = '';
  else if (meta.phase === 'play' && mine && !mine[5]) {
    center = meta.mode !== 'lms'
      ? `<div class="ar-msg">💥 ${killerId ? `${esc(nameOf(killerId))} פגע/ה בך!` : 'נפגעת!'} חוזר/ת לזירה בעוד ${Math.ceil(mine[8] || 0)}…</div>`
      : `<div class="ar-msg">💀 נפסלת – צופה בשאר</div>`;
  } else if (meta.phase === 'play' && !mine) center = '<div class="ar-msg">👀 צופה – תצטרפו בסיבוב הבא</div>';
  const ts = meta.teamScore;
  const top = meta.mode === 'team'
    ? `<span dir="ltr"><span style="color:${TEAM_COLORS[0]}">● ${ts?.[0] ?? 0}</span> : <span style="color:${TEAM_COLORS[1]}">${ts?.[1] ?? 0} ●</span></span> · ⏱️ ${fmtTime(tl ?? 0)}`
    : meta.mode === 'dm'
    ? `⏱️ ${fmtTime(tl ?? 0)}`
    : `🎯 נשארו ${alive} · 🔴 ${fmtTime(tl ?? 0)}`;
  const hp = mine ? Math.max(0, mine[4]) : 0, sh = mine ? mine[6] : 0, flags = mine ? mine[7] : 0;
  const myMeta = meta.players.find(p => p.id === myId);
  const html = `
    <div class="ar-top">
      <span><button class="ar-x" data-act="quit" aria-label="יציאה">✕</button>
      <button class="ar-x" data-act="sound" aria-label="צליל">${sfxSettings.sound ? '🔊' : '🔇'}</button></span>
      <div class="ar-time">${top}</div>
      <div class="ar-me">💀 ${myMeta?.k ?? 0}<small class="ar-ping ${rtt > 180 ? 'bad' : rtt > 100 ? 'mid' : ''}">📶 ${Math.round(rtt)}</small></div>
    </div>
    <div class="ar-board">${players.map(p => `<div class="${p.id === myId ? 'ar-mine' : ''}"><i style="background:${colorOf(p.id)}"></i>${esc(p.name)}<b>${p.k}</b></div>`).join('')}</div>
    <div class="ar-feed">${feed.map(f => `<div><span style="color:${colorOf(f.a)}">${f.a ? esc(nameOf(f.a)) : '☠️ האזור'}</span> 🔫 <span style="color:${colorOf(f.v)}">${esc(nameOf(f.v))}</span></div>`).join('')}</div>
    ${center}
    ${replay && performance.now() < replay.until ? `<div class="ar-replay"><span>🎬 הילוך חוזר${killerId ? ` · ${esc(nameOf(killerId))}` : ''}</span></div>` : ''}
    ${announce ? `<div class="ar-announce ${announce.mine ? 'mine' : ''} ${announce.small ? 'small' : ''}">${esc(announce.text)}</div>` : ''}
    ${performance.now() < tipUntil ? '<div class="ar-tip">💡 אספו בונוסים מהזירה: 🔥 תת־מקלע · 💥 רובה ציד · 🎯 צלפים · 🔱 3 כדורים · ⚡ מהירות</div>' : ''}
    ${ui.reconnecting ? '<div class="ar-msg warn">📡 מתחבר מחדש…</div>' : ''}
    ${mine && mine[5] && meta.phase === 'play' ? `<div class="ar-bottom">
      <div class="ar-hp"><div style="width:${hp}%"></div>${sh ? `<div class="sh" style="width:${sh}%"></div>` : ''}<span>❤️ ${hp}${sh ? ` 🛡️ ${sh}` : ''}</span></div>
      <div class="ar-buffs">${flags & 1 ? '🔱' : ''}${flags & 2 ? '⚡' : ''}</div>
      ${(() => { const w = WEAPON_LIST[s?.me?.w ?? 0] || 'pistol'; const am = s?.me?.am ?? -1; return `<div class="ar-weapon">${WEAPONS[w].icon} ${WEAPONS[w].name}${am >= 0 ? ` · ${am}` : ''}</div>`; })()}
    </div>
    <button class="ar-nade ${(s?.me?.nd ?? 0) > 0 ? '' : 'cd'}" data-act="nade" aria-label="רימון">💣<small>${s?.me?.nd ?? 0}${matchMedia('(pointer: fine)').matches ? ' · G' : ''}</small></button>
    <button class="ar-dash ${localDash.cd > 0 ? 'cd' : ''}" data-act="dash" aria-label="זינוק">💨<small>${localDash.cd > 0 ? Math.ceil(localDash.cd) : (matchMedia('(pointer: fine)').matches ? 'Shift' : '')}</small></button>` : ''}
    ${meta.phase === 'end' ? endHtml() : ''}`;
  if (html !== hudKey) { $hud.innerHTML = html; hudKey = html; }
}
const inGameOrEnd = () => meta && (meta.phase === 'count' || meta.phase === 'play' || meta.phase === 'end');
const fmtTime = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function endHtml() {
  const isHost = meta.host === myId;
  const medal = ['🥇', '🥈', '🥉'];
  const rows = (meta.results || []).map(r => `<tr class="${r.id === myId ? 'ar-mine' : ''}"><td>${medal[r.place - 1] || r.place}</td><td><i style="background:${meta.mode === 'team' && r.team != null ? TEAM_COLORS[r.team] : r.color}"></i>${esc(r.name)}</td><td>${r.kills}</td><td>${r.deaths}</td></tr>`).join('');
  const win = meta.results?.[0];
  return `<div class="ar-end"><div class="panel">
    <h2>${meta.mode === 'team'
      ? (meta.winTeam === -1 ? '🤝 תיקו!' : `🏆 הקבוצה ${TEAM_NAMES[meta.winTeam]} ניצחה!${playerById(myId)?.team === meta.winTeam ? ' 🎉' : ''}`)
      : win?.id === myId ? '🏆 ניצחת!' : `🏆 ${esc(win?.name || '')} ניצח/ה!`}</h2>
    <table class="ar-res"><tr><th></th><th>שחקן</th><th>💀</th><th>☠️</th></tr>${rows}</table>
    ${ui.xp ? `<div class="ar-xp"><div>+${ui.xp.gain} XP · רמה ${levelOf(ui.xp.after)}${levelOf(ui.xp.after) > levelOf(ui.xp.before) ? ' 🎉 עלית רמה!' : ''}</div><div class="bar"><i style="width:${Math.round(levelProgress(ui.xp.after) * 100)}%"></i></div></div>` : ''}
    ${ui.nextAt ? `<p class="sub">⏭️ הסיבוב הבא מתחיל בעוד ${Math.max(0, Math.ceil((ui.nextAt - performance.now()) / 1000))}</p>` : ''}
    ${isHost ? `<button class="primary" data-act="start">🔁 סיבוב נוסף עכשיו</button><button class="ghost" data-act="toLobby">⚙️ הגדרות (עצירה)</button>` : (ui.nextAt ? '' : '<p class="sub">מחכים למארח/ת…</p>')}
    <button class="ghost" data-act="quit">יציאה</button>
  </div></div>`;
}

// ---------------------------------------------------------------------------------------------
// Screens (DOM)
function render() {
  const playing = ui.screen === 'room' && inGameOrEnd();
  document.body.classList.toggle('ar-playing', playing);
  $game.hidden = !playing;
  if (playing) { $app.innerHTML = ''; renderHud(); return; }
  $hud.innerHTML = ''; hudKey = '';
  if (ui.screen === 'home') return renderHome();
  if (ui.screen === 'connecting' || !meta) {
    $app.innerHTML = `<div class="panel center"><div class="spinner"></div><p>מתחבר לשרת…</p><button class="ghost" data-act="quit">ביטול</button></div>`;
    return;
  }
  renderLobby();
}

function renderHome() {
  $app.innerHTML = `
    <div class="panel home">
      <a class="ar-back" href="./${debugOn ? '?debug=1' : ''}">→ לכל המשחקים</a>
      <h1>זירה <span>🔫💥</span></h1>
      <p class="sub">קרב יריות בזמן אמת, 2 עד 6 שחקנים. כל אחד לעצמו – מי יישאר אחרון?</p>
      ${ui.error ? `<p class="err">${esc(ui.error)}</p>` : ''}
      <label>השם שלך<input id="name" maxlength="16" value="${esc(ui.name)}" placeholder="למשל: אורי"></label>
      <div class="ar-level">⭐ רמה ${levelOf(xpGet())}<div class="bar"><i style="width:${Math.round(levelProgress(xpGet()) * 100)}%"></i></div></div>
      ${ui.joinCode ? `<button class="primary" data-act="join" ${ui.busy ? 'disabled' : ''}>הצטרף לחדר ${esc(ui.joinCode)}</button><div class="or">או</div>` : ''}
      <button class="${ui.joinCode ? '' : 'primary'}" data-act="quick" ${ui.busy ? 'disabled' : ''}>⚡ משחק מהיר</button>
      <p class="hint">נכנסים לחדר פתוח עם מי שמחובר עכשיו (או פותחים אחד חדש).</p>
      <button data-act="create" ${ui.busy ? 'disabled' : ''}>🔒 חדר פרטי לחברים</button>
      <div class="or">או הצטרף עם קוד</div>
      <div class="row">
        <input id="code" maxlength="4" value="${esc(ui.joinCode)}" placeholder="קוד חדר" dir="ltr">
        <button data-act="join" ${ui.busy ? 'disabled' : ''}>הצטרף</button>
      </div>
      <details class="rules"><summary>איך משחקים?</summary>
        <ul>
          <li><b>בטלפון:</b> אגודל שמאל על חצי המסך השמאלי – תזוזה. אגודל ימין על החצי הימני – כיוון ויריה (נגיעה בלי לגרור יורה על האויב הקרוב).</li>
          <li><b>במחשב:</b> WASD או החצים לתזוזה, העכבר לכיוון, לחיצה (או רווח) ליריה.</li>
          <li><b>קרב חופשי:</b> 2.5 דקות, חוזרים לזירה אחרי פגיעה. הכי הרבה פגיעות מנצח.</li>
          <li><b>אחרון שורד:</b> אין חזרה. האזור האדום סוגר על הזירה – מחוץ לאזור הבטוח מאבדים חיים. הוא נסגר לגמרי אחרי 15 שניות לכל שחקן (2 שחקנים: 30 שניות, 3: 45 שניות…).</li>
          <li><b>זינוק 💨:</b> כפתור הזינוק (או Shift / קליק ימני) – התחמקות מהירה, פעם ב-3 שניות.</li>
          <li><b>ראייה:</b> רואים רק את מה שמולכם ומעגל קטן סביבכם. את מי שלא רואים – אפשר לזהות לפי העקבות 👣 והצלילים.</li>
          <li><b>שיחים 🌳:</b> מי שבתוך שיח נעלם – עד שמתקרבים אליו או שהוא יורה.</li>
          <li><b>נשקים:</b> 🔥 תת־מקלע (מהיר) · 💥 רובה ציד (קרוב וקטלני) · 🎯 רובה צלפים (רחוק, 70 נזק) · 🚀 משגר רקטות (מתפוצץ) · ⚡ לייזר (עובר דרך כמה שחקנים) · 🪃 בומרנג (חוזר אליך ופוגע בדרך). כשהתחמושת נגמרת חוזרים לאקדח 🔫.</li>
          <li><b>רימונים 💣:</b> כפתור הרימון (או G) – מקפץ מהקירות ומתפוצץ אחרי שנייה וחצי. רימון אחד בכל חיים, ועוד מבונוס.</li>
          <li><b>חביות וארגזים:</b> חבית אדומה מתפוצצת כשיורים בה 🛢️💥, ארגז נשבר ולפעמים יש בו בונוס.</li>
          <li><b>קבוצות 👥:</b> אדום נגד כחול, אין פגיעה בחברים לקבוצה ורואים אותם תמיד. הקבוצה עם הכי הרבה הפלות מנצחת.</li>
          <li><b>בונוסים:</b> ❤️ חיים · 🛡️ מגן · 🔱 ירייה משולשת · ⚡ מהירות.</li>
          <li><b>רצפים 👑:</b> 3 פגיעות בלי למות = כתר. מי שעוצר רצף מקבל נקודה בונוס.</li>
          <li><b>רמה ⭐:</b> כל משחק נותן XP – על פגיעות ועל מקום ראשון.</li>
          <li>אין מספיק חברים? המארח יכול להוסיף בוטים 🤖.</li>
          <li>🔊 <a href="sounds.html">לשמוע את הצלילים ולבחור צליל יריה</a></li>
        </ul>
      </details>
      <button class="ghost gfx-toggle" data-act="gfx">🎨 גרפיקה: ${gfxMode() === 'rich' ? 'מלאה' : 'פשוטה (קלה לטלפון)'} <small>(לחצו להחלפה)</small></button>
      <p class="version">גרסה ${VERSION}</p>
    </div>`;
}

function renderLobby() {
  const isHost = meta.host === myId;
  const link = `${location.origin}${location.pathname}?room=${meta.code}`;
  const humans = meta.players.filter(p => !p.bot).length;
  const maxBots = MAX_PLAYERS - humans;
  const seg = (items, cur, act) => `<div class="im-seg">${items.map(([v, t, dis]) => `<button class="${cur === v ? 'on' : ''}" data-act="${act}" data-v="${v}" ${!isHost || dis ? 'disabled' : ''}>${t}</button>`).join('')}</div>`;
  $app.innerHTML = `
    <div class="panel lobby">
      <div class="lobby-game">🔫 זירה ${meta.pub ? '· חדר ציבורי' : ''}</div>
      <p class="sub">קוד החדר</p>
      <div class="ar-code" dir="ltr">${esc(meta.code)}</div>
      <div class="ar-qr" id="qr"></div>
      <div class="row"><button data-act="share">📤 שיתוף קישור</button></div>
      <h3>שחקנים (${meta.players.length}/${MAX_PLAYERS})</h3>
      <ul class="plist ar-plist">${meta.players.map(p => `<li><i style="background:${p.color}"></i>${esc(p.name)}${p.id === meta.host ? ' 👑' : ''}${p.id === myId ? ' (את/ה)' : ''}${!p.on && !p.bot ? ' 📡' : ''}</li>`).join('')}</ul>
      <div class="im-setting"><span>מצב</span>${seg([['dm', '⏱️ קרב חופשי'], ['team', '👥 קבוצות'], ['lms', '🎯 אחרון שורד']], meta.mode, 'cfgMode')}</div>
      <div class="im-setting"><span>מפה</span>${seg([[-1, '🎲'], ...MAPS.map((m, i) => [i, m.name])], meta.mapPick, 'cfgMap')}</div>
      <div class="im-setting"><span>בוטים 🤖</span>${seg([0, 1, 2, 3, 4, 5].map(n => [n, n, n > maxBots]), meta.bots, 'cfgBots')}</div>
      <div class="im-setting"><span>רמת הבוטים</span>${seg([['vez', '😴 קל מאוד'], ['easy', '🙂 קל'], ['normal', '😐 רגיל'], ['hard', '😈 קשה']], meta.botLevel || 'easy', 'cfgBotLevel')}</div>
      ${isHost
        ? `<button class="primary" data-act="start" ${meta.players.length < 2 ? 'disabled' : ''}>🔫 התחילו!</button>
           ${meta.players.length < 2 ? '<p class="sub">מחכים לשחקנים… או הוסיפו בוט כדי להתחיל</p>' : ''}`
        : '<p class="sub">מחכים שהמארח/ת יתחיל/תתחיל…</p>'}
      <button class="ghost" data-act="quit">יציאה</button>
    </div>`;
  drawQr(link);
}

function drawQr(text) {
  const el = document.getElementById('qr');
  if (!el || !window.qrcode) return;
  try {
    const q = window.qrcode(0, 'M');
    q.addData(text);
    q.make();
    el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch {}
}

// ---------------------------------------------------------------------------------------------
// Actions
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  const nameOk = () => {
    const n = document.getElementById('name')?.value.trim() ?? ui.name;
    if (!n) { ui.error = 'צריך שם 🙂'; render(); return false; }
    ui.name = n.slice(0, 16);
    store.set('hathatul-name', ui.name);
    ui.error = '';
    return true;
  };
  switch (act) {
    case 'quick': case 'create': {
      if (!nameOk()) return;
      ui.busy = true; render();
      try {
        const { code: c } = await api(act === 'quick' ? '/api/quick' : '/api/new');
        ui.busy = false;
        connect(c, act === 'quick');
      } catch { ui.busy = false; ui.error = 'אין חיבור לשרת המשחק. נסו שוב.'; render(); }
      return;
    }
    case 'join': {
      if (!nameOk()) return;
      const c = (document.getElementById('code')?.value || ui.joinCode).trim().toUpperCase();
      if (!/^[A-Z]{4}$/.test(c)) { ui.error = 'קוד חדר הוא 4 אותיות באנגלית'; return render(); }
      ui.busy = true; render();
      try {
        const r = await api(`/api/check?code=${c}`);
        ui.busy = false;
        if (!r.exists) { ui.error = `לא מצאנו חדר ${c}`; ui.joinCode = ''; return render(); }
        connect(c, false);
      } catch { ui.busy = false; ui.error = 'אין חיבור לשרת המשחק. נסו שוב.'; render(); }
      return;
    }
    case 'quit':
      if (meta?.phase === 'play' && !confirm('לצאת מהמשחק?')) return;
      ui.joinCode = '';
      return leave();
    case 'share': {
      const link = `${location.origin}${location.pathname}?room=${meta.code}`;
      if (navigator.share) navigator.share({ title: 'זירה', text: `בואו לשחק איתי זירה! קוד: ${meta.code}`, url: link }).catch(() => {});
      else { navigator.clipboard?.writeText(link); toast('הקישור הועתק'); }
      return;
    }
    case 'cfgMode': return send({ t: 'cfg', mode: el.dataset.v });
    case 'cfgMap': return send({ t: 'cfg', map: Number(el.dataset.v) });
    case 'cfgBots': return send({ t: 'cfg', bots: Number(el.dataset.v) });
    case 'cfgBotLevel': return send({ t: 'cfg', botLevel: el.dataset.v });
    case 'start': play('pop'); return send({ t: 'start' });
    case 'toLobby': return send({ t: 'lobby' });
    case 'sound': toggleSfx('sound'); return;
    case 'gfx': setGfxMode(gfxMode() === 'rich' ? 'simple' : 'rich'); return render();
  }
});

// the dash button reacts on touch-down (a click would wait for the finger to lift)
$hud.addEventListener('pointerdown', e => {
  if (e.target.closest('[data-act=dash]')) { e.preventDefault(); dashPress(); }
  if (e.target.closest('[data-act=nade]')) { e.preventDefault(); nadePress(); }
});

// ---------------------------------------------------------------------------------------------
// Main loop
let prev = performance.now(), lastCount = null, hudAt = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - prev) / 1000);
  prev = now;
  if (!(ui.screen === 'room' && inGameOrEnd())) return;
  interpolate(now);
  stepLocal(dt);
  for (const pt of particles) { pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vx *= 0.92; pt.vy *= 0.92; pt.life -= dt; }
  for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);
  for (const f of floaters) { f.y -= 30 * dt; f.life -= dt; }
  for (const f of footprints) f.life -= dt;
  for (const a of [ghosts, flashes, holes, splats]) { for (const x of a) x.life -= dt; for (let i = a.length - 1; i >= 0; i--) if (a[i].life <= 0) a.splice(i, 1); }
  kick = Math.max(0, kick - dt * 40);
  zoomKick = Math.max(0, zoomKick - dt * 0.35);
  if (announce && (announce.life -= dt) <= 0) announce = null;
  while (footprints.length && footprints[0].life <= 0) footprints.shift();
  if (footprints.length > 200) footprints.splice(0, footprints.length - 200);
  for (let i = floaters.length - 1; i >= 0; i--) if (floaters[i].life <= 0) floaters.splice(i, 1);
  for (const f of feed) f.life -= dt;
  while (feed.length && feed[0].life <= 0) feed.shift();
  shake = Math.max(0, shake - dt * 40);
  hurtFlash = Math.max(0, hurtFlash - dt);
  drawWorld(now, dt);
  if (lastSnap?.ph === 'count') {
    const c = Math.ceil(lastSnap.tl);
    if (c !== lastCount && c > 0) { lastCount = c; sound('count'); }
  } else lastCount = null;
  if (replay && now > replay.until) replay = null;
  for (let i = predicted.length - 1; i >= 0; i--) if (now - predicted[i].t > 450) predicted.splice(i, 1); // the server said no
  if (now - hudAt > 50) { hudAt = now; renderHud(); }
}
requestAnimationFrame(frame);

// keep the screen awake during a match
let wakeLock = null;
setInterval(async () => {
  const want = inGame() && document.visibilityState === 'visible';
  if (want && !wakeLock && navigator.wakeLock) { try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch {} }
  if (!want && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}, 2000);

render();

gfx.preload();
