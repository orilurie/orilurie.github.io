// המבוך – client. Room-by-room dungeon crawler for 1–4 players (solo or with friends).
// The run lives on the game server (arena-server/, class Dungeon); this file draws it, predicts
// your own movement (same step model as the arena) and sends your input.

import {
  T, CW, CH, RW, RH, PR, DASH, INTERP_MS, ITEMS, ITEM_LIST, ENEMIES, ENEMY_LIST, MAX_PLAYERS, SHOT_SPEED,
  genFloor, solids, move, roomAt, interior, blocked,
} from './dungeon-core.js?v=50';
import { play, haptic, settings as sfxSettings, toggle as toggleSfx } from './sfx.js?v=50';
import { sound, addSounds } from './arena-audio.js?v=50';
import * as gfx from './arena-gfx.js?v=50';
import { gfxMode, setGfxMode, isRich } from './gfx-mode.js?v=50';

export const VERSION = 50;
const params = new URLSearchParams(location.search);
const SERVER = params.get('server') || 'https://arena.hathatul.workers.dev';
const WS_URL = SERVER.replace(/^http/, 'ws');
const debugOn = params.get('debug') === '1';

fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' }).then(r => r.json()).then(({ version }) => {
  if (version <= VERSION) return;
  const key = `hathatul-reloaded-${version}`;
  try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch {}
  params.set('v', version); location.replace(`${location.pathname}?${params}`);
}).catch(() => {});

addSounds({
  dg_bolt: ['dg_bolt'], dg_squish: ['dg_squish'], dg_eshot: ['dg_enemyshot'], dg_lock: ['dg_lock'], dg_unlock: ['dg_unlock'],
  dg_coin: ['dg_coin'], dg_item: ['dg_item'], dg_chest: ['dg_chest'], dg_stairs: ['dg_stairs'],
}, { dg_bolt: 0.35, dg_squish: 0.6, dg_eshot: 0.35, dg_lock: 0.8, dg_unlock: 0.8, dg_coin: 0.6, dg_item: 0.8, dg_chest: 0.7, dg_stairs: 0.8 });

const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
let pid = null;
try { pid = sessionStorage.getItem('dungeon-pid'); } catch {}
if (!pid) { pid = 'd' + Math.random().toString(36).slice(2, 10); try { sessionStorage.setItem('dungeon-pid', pid); } catch {} }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $app = document.getElementById('app'), $game = document.getElementById('game'), $hud = document.getElementById('hud'), $toast = document.getElementById('toast');
const cv = document.getElementById('cv'), g = cv.getContext('2d');
const ui = { screen: 'home', name: store.get('hathatul-name') || '', joinCode: (params.get('room') || '').toUpperCase(), error: '', busy: false };
function toast(t) { $toast.textContent = t; $toast.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => $toast.classList.remove('show'), 2400); }

// ---------- sprites (Kenney Tiny Dungeon, 16×16 tiles in a 12-column sheet) ----------
const sheet = new Image(); sheet.src = 'dungeon/tiles.png';
const HEROES = [97, 84, 99, 112]; // knight, wizard, rogue, elf
const HERO_NAMES = ['אביר', 'קוסם', 'נוכלת', 'שדונית'];
const HERO_COLORS = ['#ffd27a', '#b07aff', '#ff7aa8', '#6fe08a'];
function tile(idx, x, y, size, flip = false, alpha = 1) {
  if (!sheet.complete) return;
  const sx = (idx % 12) * 16, sy = Math.floor(idx / 12) * 16;
  g.save(); g.globalAlpha = alpha; g.imageSmoothingEnabled = false;
  if (flip) { g.translate(x + size, y); g.scale(-1, 1); g.drawImage(sheet, sx, sy, 16, 16, 0, 0, size, size); }
  else g.drawImage(sheet, sx, sy, 16, 16, x, y, size, size);
  g.restore();
}
const tileIcon = (idx, px = 32) => `<span class="dg-ico" style="width:${px}px;height:${px}px;background-position:-${(idx % 12) * px}px -${Math.floor(idx / 12) * px}px;background-size:${12 * px}px auto"></span>`;

// ---------- networking ----------
let ws = null, wantOpen = false, retry = 0, code = null;
let meta = null, myId = pid, lastSnap = null, rtt = 0;
const snaps = [];
let layout = null, layoutKey = '', curSolids = null, lockedKey = '';
async function api(path) { const r = await fetch(SERVER + path, { cache: 'no-store' }); if (!r.ok) throw new Error('server'); return r.json(); }
function connect(c, solo) {
  code = c; wantOpen = true; ui.solo = solo; ui.screen = 'connecting'; render(); open();
  history.replaceState(null, '', `?room=${c}${debugOn ? '&debug=1' : ''}${params.get('server') ? '&server=' + encodeURIComponent(SERVER) : ''}`);
}
function open() {
  const sock = new WebSocket(`${WS_URL}/dws/${code}`);
  ws = sock;
  sock.onopen = () => { retry = 0; sock.send(JSON.stringify({ t: 'hello', id: pid, name: ui.name, solo: ui.solo ? 1 : 0 })); };
  sock.onmessage = e => { if (sock === ws) onMsg(JSON.parse(e.data)); };
  sock.onclose = () => {
    if (sock !== ws || !wantOpen) return;
    if (retry++ > 12) { leave('החיבור לשרת נותק'); return; }
    ui.reconnecting = true;
    setTimeout(() => { if (wantOpen && ws === sock) open(); }, Math.min(4000, 400 * retry));
  };
}
const send = m => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
setInterval(() => send({ t: 'ping', c: performance.now() }), 2000);
function leave(err = '') {
  wantOpen = false; try { ws?.close(); } catch {}
  ws = null; meta = null; lastSnap = null; snaps.length = 0; layout = null;
  ui.screen = 'home'; ui.error = err;
  history.replaceState(null, '', location.pathname + (debugOn ? '?debug=1' : ''));
  render();
}

function onMsg(m) {
  if (m.t === 'welcome') { myId = m.id; ui.reconnecting = false; return; }
  if (m.t === 'pong') { const r = performance.now() - m.c; rtt = rtt ? rtt * 0.7 + r * 0.3 : r; return; }
  if (m.t === 'err') { toast(m.m); if (m.fatal) leave(m.m); return; }
  if (m.t === 'room') {
    const prev = meta?.phase;
    meta = m; ui.screen = 'room';
    if (m.phase === 'play' && prev !== 'play') resetRun();
    if (m.phase === 'end' && prev !== 'end' && m.run) {
      const won = m.run.result === 'won';
      play(won ? 'win' : 'lose'); haptic(won ? 'win' : 'tap');
      const best = Number(store.get('dungeon-best')) || 0;
      if (m.run.floor > best || (won && best < 4)) store.set('dungeon-best', won ? 4 : m.run.floor);
    }
    render();
    return;
  }
  if (m.t === 's') {
    snaps.push({ at: performance.now(), s: m });
    while (snaps.length > 40) snaps.shift();
    const key = m.seed + ':' + m.fl;
    if (key !== layoutKey) { layoutKey = key; layout = genFloor(m.seed, m.fl); me = null; pending.length = 0; }
    const lk = m.rs.map(r => (r & 4 ? 1 : 0)).join('');
    if (lk !== lockedKey || !curSolids) { lockedKey = lk; curSolids = solids(layout, m.rs.map(r => !!(r & 4))); }
    lastSnap = m;
    handleEvents(m.ev || []);
    reconcile(m);
  }
}

// ---------- input (same scheme as the arena) ----------
const input = { mx: 0, my: 0, a: 0, f: false };
const keys = new Set();
const sticks = { move: null, aim: null };
let mouse = null;
const inRun = () => ui.screen === 'room' && meta?.phase === 'play';
addEventListener('keydown', e => {
  if (!inRun() || e.target.tagName === 'INPUT') return;
  keys.add(e.code);
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat) dashPress();
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); sticks.move = sticks.aim = null; if (mouse) mouse.down = false; });
cv.addEventListener('pointerdown', e => {
  e.preventDefault();
  if (e.pointerType === 'mouse') { if (e.button === 2) return dashPress(); mouse = { x: e.clientX, y: e.clientY, down: e.button === 0 }; return; }
  const side = e.clientX < innerWidth / 2 ? 'move' : 'aim';
  if (sticks[side]) return;
  sticks[side] = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
  try { cv.setPointerCapture(e.pointerId); } catch {}
});
cv.addEventListener('pointermove', e => {
  if (e.pointerType === 'mouse') { mouse = { ...(mouse || {}), x: e.clientX, y: e.clientY }; return; }
  for (const s of Object.values(sticks)) if (s && s.id === e.pointerId) { s.x = e.clientX; s.y = e.clientY; }
});
const endPointer = e => { if (e.pointerType === 'mouse') { if (mouse) mouse.down = false; return; } for (const k of Object.keys(sticks)) if (sticks[k]?.id === e.pointerId) sticks[k] = null; };
cv.addEventListener('pointerup', endPointer); cv.addEventListener('pointercancel', endPointer);
cv.addEventListener('contextmenu', e => e.preventDefault());
$hud.addEventListener('pointerdown', e => { if (e.target.closest('[data-act=dash]')) { e.preventDefault(); dashPress(); } });

const STICK = 60;
function readInput() {
  let mx = 0, my = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) my -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) my += 1;
  if (sticks.move) {
    const st = sticks.move; let dx = st.x - st.ox, dy = st.y - st.oy, l = Math.hypot(dx, dy);
    if (l > STICK) { st.ox = st.x - (dx / l) * STICK; st.oy = st.y - (dy / l) * STICK; dx = st.x - st.ox; dy = st.y - st.oy; l = STICK; }
    if (l > 7) { const mag = Math.min(1, (l - 7) / (STICK * 0.42)); mx = (dx / l) * mag; my = (dy / l) * mag; }
  }
  const l = Math.hypot(mx, my); if (l > 1) { mx /= l; my /= l; }
  input.mx = Math.round(mx * 100) / 100; input.my = Math.round(my * 100) / 100;
  input.f = false;
  if (sticks.aim) {
    const st = sticks.aim; let dx = st.x - st.ox, dy = st.y - st.oy; const la = Math.hypot(dx, dy);
    if (la > STICK) { st.ox = st.x - (dx / la) * STICK; st.oy = st.y - (dy / la) * STICK; dx = st.x - st.ox; dy = st.y - st.oy; }
    if (Math.hypot(dx, dy) > 14) input.a = me ? assist(Math.atan2(dy, dx)) : Math.atan2(dy, dx);
    else if (me) { const t = nearestFoe(); if (t) input.a = Math.atan2(t.y - me.y, t.x - me.x); }
    input.f = true;
  } else if (mouse && me) {
    const sp = toScreen(me.x, me.y);
    input.a = Math.atan2(mouse.y - sp.y, mouse.x - sp.x); input.f = !!mouse.down;
  } else if (mx || my) { let da = Math.atan2(my, mx) - input.a; da = Math.atan2(Math.sin(da), Math.cos(da)); input.a += da * 0.25; }
  if (keys.has('Space')) input.f = true;
  input.a = Math.round(input.a * 100) / 100;
}
function nearestFoe() {
  let best = null, bd = 700;
  for (const e of foes) { if (e.waking) continue; const d = Math.hypot(e.x - me.x, e.y - me.y); if (d < bd && !blocked(me.x, me.y, e.x, e.y, walls())) { bd = d; best = e; } }
  return best;
}
function assist(a) { // pull touch aim onto a monster that's nearly in line
  let best = null, bestErr = 0.22;
  for (const e of foes) {
    if (e.waking) continue;
    const d = Math.hypot(e.x - me.x, e.y - me.y);
    let da = Math.atan2(e.y - me.y, e.x - me.x) - a; da = Math.atan2(Math.sin(da), Math.cos(da));
    if (Math.abs(da) < Math.min(bestErr, Math.max(0.1, Math.atan2(30, d)))) { bestErr = Math.abs(da); best = da; }
  }
  return best === null ? a : a + best * 0.8;
}

// ---------- prediction ----------
let seq = 0, lastSent = 0, sentF = false;
const outbox = [], pending = [];
let me = null, localDash = { t: 0, cd: 0, dir: null };
const walls = () => curSolids || [];
const myRow = () => lastSnap?.p.find(p => p[0] === myId);
function resetRun() { me = null; pending.length = 0; outbox.length = 0; particles.length = 0; floaters.length = 0; layoutKey = ''; snaps.length = 0; lastSnap = null; localDash = { t: 0, cd: 0, dir: null }; banner = null; }
function dashPress() {
  if (!me || me.dead || localDash.cd > 0) return;
  const l = Math.hypot(input.mx, input.my), a = l > 0.2 ? Math.atan2(input.my, input.mx) : input.a;
  localDash = { t: DASH.time, cd: DASH.cd, dir: { mx: Math.cos(a), my: Math.sin(a) } };
  lastSent = 0; sound('dash'); haptic('tap');
}
function reconcile(s) {
  const sp = s.p.find(p => p[0] === myId);
  if (!sp) { me = null; return; }
  if (!sp[6]) { me = { x: sp[1], y: sp[2], dead: true }; pending.length = 0; return; }
  const ack = s.ack?.[myId] ?? 0;
  while (pending.length && pending[0].seq <= ack) pending.shift();
  const q = { x: sp[1], y: sp[2], vx: sp[9] || 0, vy: sp[10] || 0 };
  for (const u of pending) move(q, u, u.dt, walls(), u.speed, u.dash);
  if (!me || me.dead) { me = { x: q.x, y: q.y, vx: q.vx, vy: q.vy, cx: 0, cy: 0 }; return; }
  me.cx = q.x - me.x; me.cy = q.y - me.y;
  if (Math.hypot(me.cx, me.cy) > 90) { me.x = q.x; me.y = q.y; me.cx = me.cy = 0; }
}
function stepLocal(dt) {
  const sp = myRow();
  readInput();
  const now = performance.now();
  if (me && !me.dead && sp && sp[6] && meta?.phase === 'play' && layout) {
    const speed = sp[13] || 210;
    localDash.cd -= dt;
    let u;
    if (localDash.t > 0) { u = { seq: ++seq, ...localDash.dir, dt, speed: speed * DASH.speed, dash: true, d: localDash.t === DASH.time ? 1 : 0 }; localDash.t -= dt; }
    else u = { seq: ++seq, mx: input.mx, my: input.my, dt, speed };
    outbox.push([u.seq, u.mx, u.my, Math.round(dt * 10000) / 10000, u.d || 0]);
    move(me, u, dt, walls(), u.speed, u.dash);
    pending.push(u); if (pending.length > 200) pending.shift();
    const k = Math.min(1, dt * 10);
    me.x += me.cx * k; me.y += me.cy * k; me.cx -= me.cx * k; me.cy -= me.cy * k;
    if (input.f && (me.fireCd = (me.fireCd || 0) - dt) <= 0) { me.fireCd = 0.3; sound('dg_bolt'); }
  }
  const urgent = input.f !== sentF || outbox.some(c => c[4]);
  if (inRun() && ((outbox.length && (urgent || now - lastSent >= 50)) || now - lastSent > 250)) {
    sentF = input.f; lastSent = now;
    send({ t: 'in', a: input.a, f: input.f ? 1 : 0, c: outbox.splice(0), r: Math.round(rtt) });
  }
}

// ---------- interpolation ----------
let others = [], foes = [];
function interpolate(now) {
  others = []; foes = [];
  if (!snaps.length) return;
  const t = now - INTERP_MS;
  let a = snaps[0], b = snaps[snaps.length - 1];
  for (let i = snaps.length - 1; i > 0; i--) if (snaps[i - 1].at <= t) { a = snaps[i - 1]; b = snaps[i]; break; }
  const k = b.at > a.at ? Math.max(0, Math.min(1, (t - a.at) / (b.at - a.at))) : 1;
  const lerp = (x, y, jump) => (jump ? y : x + (y - x) * k);
  for (const pb of b.s.p) {
    const pa = a.s.p.find(p => p[0] === pb[0]) || pb, jump = Math.hypot(pb[1] - pa[1], pb[2] - pa[2]) > 150;
    others.push({ id: pb[0], x: lerp(pa[1], pb[1], jump), y: lerp(pa[2], pb[2], jump), aim: pb[3], hp: pb[4], maxHp: pb[5], alive: !!pb[6], inv: !!pb[7], dash: !!pb[8], moving: Math.hypot(pb[9], pb[10]) > 30, hero: pb[11], orbit: pb[12] });
  }
  for (const eb of b.s.e) {
    const ea = a.s.e.find(e => e[0] === eb[0]) || eb;
    foes.push({ id: eb[0], type: ENEMY_LIST[eb[1]], x: lerp(ea[2], eb[2]), y: lerp(ea[3], eb[3]), hp: eb[4], maxHp: eb[5], waking: !!eb[6], slow: !!eb[7], face: eb[8] });
  }
}

// ---------- effects ----------
const particles = [], floaters = [];
let shake = 0, hurtFlash = 0, banner = null;
const playerById = id => meta?.players.find(p => p.id === id);
const nameOf = id => playerById(id)?.name || '?';
function spark(x, y, color, n = 8, speed = 160) {
  for (let i = 0; i < n; i++) { const a = Math.random() * 6.28, v = speed * (0.4 + Math.random()); particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.35 + Math.random() * 0.25, max: 0.6, color, size: 3 + Math.random() * 2 }); }
}
function puff(x, y, n, color, size) {
  for (let i = 0; i < n; i++) { const a = Math.random() * 6.28, v = 30 * (0.3 + Math.random()); particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.8, max: 0.8, color, size: size * (0.6 + Math.random() * 0.5), sprite: 'smoke_04', rot: Math.random() * 6 }); }
}
const near = (x, y) => (me ? { at: { x, y }, listener: me } : {});
function handleEvents(evs) {
  for (const ev of evs) {
    switch (ev.k) {
      case 'shot': if (ev.id !== myId) sound('dg_bolt', { ...near(ev.x, ev.y), vol: 0.6 }); break;
      case 'ehit': spark(ev.x, ev.y, '#fff2b0', 5); floaters.push({ x: ev.x, y: ev.y - 20, text: `-${ev.dmg}`, color: '#fff', life: 0.7 }); sound('hit', { ...near(ev.x, ev.y), vol: 0.5 }); break;
      case 'edie': puff(ev.x, ev.y, 4, '#b9c2cf', 50); spark(ev.x, ev.y, '#9fe8a0', 12, 200); sound('dg_squish', near(ev.x, ev.y)); break;
      case 'poof': spark(ev.x, ev.y, '#cfe3ff', 3, 80); break;
      case 'hurt':
        spark(ev.x, ev.y, '#ff6b6b', 10);
        if (ev.id === myId) { sound('hurt'); haptic('hurt'); shake = 12; hurtFlash = 0.4; }
        break;
      case 'down': puff(ev.x, ev.y, 6, '#888', 60); if (ev.id === myId) { sound('die'); haptic('die'); banner = { text: '💀 נפלת! חבר יחזיר אותך כשהחדר ינוקה', life: 3 }; } else banner = { text: `💀 ${nameOf(ev.id)} נפל/ה!`, life: 2 }; break;
      case 'revive': if (ev.id === myId) banner = { text: '✨ חזרת לחיים!', life: 2 }; sound('go'); break;
      case 'lock': sound('dg_lock'); haptic('turn'); if (ev.boss) banner = { text: `⚔️ ${ENEMIES[ev.boss].name}!`, life: 2.6, big: true }; break;
      case 'clear': sound('dg_unlock'); banner = { text: '✨ החדר נוקה – הדלתות נפתחו', life: 1.8 }; break;
      case 'pick': spark(ev.x, ev.y, ev.type === 'coin' ? '#7df3ff' : '#ff7a9c', 8); if (ev.id === myId) sound(ev.type === 'coin' ? 'dg_coin' : 'pickup'); break;
      case 'item': spark(ev.x, ev.y, '#ffd27a', 18, 220); if (ev.id === myId) { sound('dg_item'); haptic('win'); banner = { text: `${ITEMS[ev.item].name}: ${ITEMS[ev.item].desc}`, life: 3, big: true }; } else banner = { text: `${nameOf(ev.id)} לקח/ה ${ITEMS[ev.item].name}`, life: 2 }; break;
      case 'boom': booms.push({ x: ev.x, y: ev.y, r: ev.r, t0: performance.now() }); sound('boom', { ...near(ev.x, ev.y), vol: 0.6 }); break;
      case 'bossdown': booms.push({ x: ev.x, y: ev.y, r: 140, t0: performance.now() }); shake = 22; sound('boom'); banner = { text: '🏆 הבוס הובס! מדרגות למטה נפתחו', life: 3, big: true }; break;
      case 'roar': shake = Math.max(shake, 10); break;
      case 'floor': if (ev.n > 1) { banner = { text: `⬇️ קומה ${ev.n}`, life: 2.4, big: true }; sound('dg_stairs'); } break;
      case 'heal': if (ev.id === myId) { sound('pickup'); floaters.push({ x: me?.x ?? 0, y: (me?.y ?? 0) - 30, text: '❤️ +1', color: '#ff7a9c', life: 1 }); } break;
      case 'pull': if (ev.id === myId) banner = { text: '🌀 הצטרפת לחברים לקרב!', life: 1.6 }; break;
      case 'dash': if (ev.id !== myId) puff(ev.x, ev.y, 2, '#c9b89a', 36); break;
    }
  }
}
const booms = [];

// ---------- rendering ----------
let view = { x: 0, y: 0, s: 1 }, dpr = 1;
function resize() { dpr = Math.min(2, devicePixelRatio || 1); cv.width = Math.round(innerWidth * dpr); cv.height = Math.round(innerHeight * dpr); }
addEventListener('resize', resize); resize();
const toScreen = (x, y) => ({ x: (x - view.x) * view.s + innerWidth / 2, y: (y - view.y) * view.s + innerHeight / 2 });
const hash = (a, b) => ((a * 73856093) ^ (b * 19349663)) >>> 0;

function drawRoom(r, rs, now) {
  const visited = rs & 1, locked = rs & 4;
  const S = T;
  // floor
  for (let ty = 0; ty < RH; ty++) for (let tx = 0; tx < RW; tx++) {
    const h = hash(r.gx * 100 + tx, r.gy * 100 + ty) % 10;
    tile(h < 6 ? 48 : h < 8 ? 49 : h < 9 ? 50 : 51, r.x + S + tx * S, r.y + S + ty * S, S);
  }
  // walls
  for (let tx = 0; tx < RW + 2; tx++) for (const ty of [0, RH + 1]) tile(ty === 0 ? 40 : 40, r.x + tx * S, r.y + ty * S, S);
  for (let ty = 1; ty < RH + 1; ty++) for (const tx of [0, RW + 1]) tile(40, r.x + tx * S, r.y + ty * S, S);
  // torches on the top wall
  tile(29, r.x + 3 * S, r.y, S); tile(29, r.x + (RW - 2) * S, r.y, S);
  // doors: open archways, closed doors while the room is locked
  const cx = r.x + CW / 2, cy = r.y + CH / 2;
  const door = (x, y, rot) => {
    g.save(); g.translate(x, y); g.rotate(rot);
    g.fillStyle = '#1a1210'; g.fillRect(-S, -S / 2, 2 * S, S);
    if (locked) { tile(46, -S, -S / 2, S); tile(46, 0, -S / 2, S, true); }
    g.restore();
  };
  if (r.doors.n != null) door(cx, r.y + S / 2, 0);
  if (r.doors.s != null) door(cx, r.y + CH - S / 2, Math.PI);
  if (r.doors.w != null) door(r.x + S / 2, cy, -Math.PI / 2);
  if (r.doors.e != null) door(r.x + CW - S / 2, cy, Math.PI / 2);
  // rocks / pillars
  for (const [x, y, w, h] of r.obstacles) for (let yy = y; yy < y + h; yy += S) for (let xx = x; xx < x + w; xx += S) tile(w > S || h > S ? 57 : 12, xx, yy, S);
  if (!visited) { g.fillStyle = 'rgba(8,6,12,0.85)'; g.fillRect(r.x, r.y, CW, CH); }
}

function drawWorld(now, dt) {
  const cw = innerWidth, ch = innerHeight;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#0c0a10'; g.fillRect(0, 0, cw, ch);
  if (!layout || !lastSnap) return;
  const s = lastSnap;
  // camera: the room you're in fits the screen; on a narrow phone it follows you inside the room
  const focus = me && !me.dead ? me : others.find(o => o.alive) || others[0] || { x: layout.rooms[layout.start].x + CW / 2, y: layout.rooms[layout.start].y + CH / 2 };
  const rid = roomAt(layout, focus.x, focus.y) ?? layout.start, room = layout.rooms[rid];
  const fit = Math.min(cw / (CW + 10), ch / (CH + 10));
  view.s = Math.max(fit, Math.min(cw / (CW * 0.62), ch / (CH * 0.62)) * (ch > cw ? 1 : 0)) || fit;
  const halfW = cw / 2 / view.s, halfH = ch / 2 / view.s;
  const clampAx = (v, lo, size, half) => (half * 2 >= size ? lo + size / 2 : Math.max(lo + half, Math.min(lo + size - half, v)));
  const tx = clampAx(focus.x, room.x, CW, halfW), ty = clampAx(focus.y, room.y, CH, halfH);
  view.x += (tx - view.x) * Math.min(1, dt * 8); view.y += (ty - view.y) * Math.min(1, dt * 8);
  if (Math.hypot(tx - view.x, ty - view.y) > 900) { view.x = tx; view.y = ty; }
  const sx = shake ? (Math.random() - 0.5) * shake : 0, sy = shake ? (Math.random() - 0.5) * shake : 0;
  g.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * (cw / 2 - view.x * view.s + sx), dpr * (ch / 2 - view.y * view.s + sy));

  // rooms around the camera
  for (const r of layout.rooms) {
    if (Math.abs(r.x + CW / 2 - view.x) > halfW + CW || Math.abs(r.y + CH / 2 - view.y) > halfH + CH) continue;
    drawRoom(r, s.rs[r.id] || 0, now);
  }
  // stairs down
  if (s.td) {
    tile(9, s.td[0] - 30, s.td[1] - 30, 60);
    gfx.drawGlow(g, s.td[0], s.td[1], 50 + Math.sin(now / 200) * 6, '#7df3ff', 0.5);
  }
  // pedestals with items (yours already taken from that set fade out)
  const took = s.me?.took || [];
  for (const [, ii, x, y, set] of s.ped || []) {
    const it = ITEMS[ITEM_LIST[ii]], fade = took.includes(set) ? 0.35 : 1;
    tile(64, x - 20, y - 6, 40, false, fade);
    const bob = Math.sin(now / 300 + x) * 4;
    gfx.drawGlow(g, x, y - 22 + bob, 26, '#ffd27a', 0.5 * fade);
    tile(it.spr, x - 18, y - 40 + bob, 36, false, fade);
  }
  // pickups
  for (const [, type, x, y] of s.u || []) {
    const bob = Math.sin(now / 250 + x) * 3;
    if (type === 'coin') { gfx.drawGlow(g, x, y + bob, 16, '#7df3ff', 0.5); tile(56, x - 12, y - 12 + bob, 24); }
    else { gfx.drawGlow(g, x, y + bob, 18, '#ff6b8a', 0.5); tile(115, x - 14, y - 14 + bob, 28); }
  }
  // monsters
  for (const e of foes) {
    const d = ENEMIES[e.type], size = T * 1.15 * d.scale;
    const wob = e.waking ? 0.35 + 0.35 * Math.sin(now / 60) : 1;
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.beginPath(); g.ellipse(e.x, e.y + size * 0.38, size * 0.35, size * 0.14, 0, 0, Math.PI * 2); g.fill();
    const hop = e.type === 'slime' || e.type === 'slimeking' ? Math.abs(Math.sin(now / 160 + e.id)) * 4 * d.scale : 0;
    tile(d.spr, e.x - size / 2, e.y - size / 2 - hop, size, e.face < 0, wob);
    if (e.slow) gfx.drawGlow(g, e.x, e.y, size * 0.5, '#8fd8ff', 0.45);
    if (!d.boss && e.hp < e.maxHp) { g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(e.x - 16, e.y - size / 2 - 8, 32, 4); g.fillStyle = '#ff5d5d'; g.fillRect(e.x - 16, e.y - size / 2 - 8, 32 * e.hp / e.maxHp, 4); }
  }
  // players
  for (const o of others) {
    if (!o.alive) { tile(65, o.x - 18, o.y - 18, 36, false, 0.8); continue; } // a gravestone
    const mine = o.id === myId && me && !me.dead;
    const p = mine ? { ...o, x: me.x, y: me.y, aim: input.a } : o;
    const size = T * 1.15, flip = Math.cos(p.aim) < 0;
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.beginPath(); g.ellipse(p.x, p.y + 18, 14, 6, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = HERO_COLORS[p.hero % 4]; g.lineWidth = 2.5; g.globalAlpha = 0.8; g.beginPath(); g.ellipse(p.x, p.y + 18, 17, 7, 0, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
    const bob = p.moving || (mine && Math.hypot(input.mx, input.my) > 0.1) ? Math.abs(Math.sin(now / 90)) * 3 : 0;
    const blink = p.inv && Math.floor(now / 80) % 2 === 0 ? 0.35 : 1;
    tile(HEROES[p.hero % 4], p.x - size / 2, p.y - size / 2 - bob, size, flip, blink);
    // wand tip shows where you aim
    gfx.drawGlow(g, p.x + Math.cos(p.aim) * 24, p.y + Math.sin(p.aim) * 24, 9, HERO_COLORS[p.hero % 4], 0.9);
    // orbiting orbs
    for (let i = 0; i < (p.orbit || 0); i++) {
      const a = (s.ot + (now - snaps[snaps.length - 1].at) / 1000) * 3 + (i / p.orbit) * Math.PI * 2;
      gfx.drawGlow(g, p.x + Math.cos(a) * 46, p.y + Math.sin(a) * 46, 16, '#8fd8ff', 1);
    }
  }
  // shots (extrapolated from the last snapshot)
  const age = (now - snaps[snaps.length - 1].at) / 1000;
  for (const [, x, y, vx, vy, r, enemy, owner] of s.s || []) {
    const px = x + vx * age, py = y + vy * age;
    if (enemy) { gfx.drawGlow(g, px, py, r * 2.6, '#ff6b3c', 0.9); g.fillStyle = '#ffd0a0'; g.beginPath(); g.arc(px, py, r * 0.6, 0, Math.PI * 2); g.fill(); }
    else { const c = HERO_COLORS[(others.find(o => o.id === owner)?.hero ?? 0) % 4]; gfx.drawGlow(g, px, py, r * 3, c, 0.9); g.fillStyle = '#fff'; g.beginPath(); g.arc(px, py, r * 0.55, 0, Math.PI * 2); g.fill(); }
  }
  for (let i = booms.length - 1; i >= 0; i--) if (!gfx.drawBoom(g, booms[i], now)) booms.splice(i, 1);
  // particles
  for (const pt of particles) {
    const a = Math.max(0, pt.life / pt.max);
    if (pt.sprite) { gfx.drawSprite(g, pt.sprite, pt.color, pt.x, pt.y, pt.size * (1.6 - a * 0.6), pt.rot, a * 0.5); continue; }
    g.globalAlpha = a; g.fillStyle = pt.color; g.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
  }
  g.globalAlpha = 1;
  // torch-lit dungeon: dark around, light around the heroes (full graphics)
  if (isRich()) {
    const lights = others.filter(o => o.alive).map(o => ({ x: o.id === myId && me ? me.x : o.x, y: o.id === myId && me ? me.y : o.y, r: 330, a: 0.85 }));
    for (const r of layout.rooms) if (Math.abs(r.x + CW / 2 - view.x) < halfW + CW) { lights.push({ x: r.x + 3.5 * T, y: r.y + T, r: 150, a: 0.5 }, { x: r.x + (RW - 1.5) * T, y: r.y + T, r: 150, a: 0.5 }); }
    if (s.td) lights.push({ x: s.td[0], y: s.td[1], r: 140, a: 0.6 });
    gfx.drawDarkness(g, { x: view.x, y: view.y, s: view.s }, cw, ch, dpr, null, lights);
  }
  // names and hearts over other players
  g.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * (cw / 2 - view.x * view.s + sx), dpr * (ch / 2 - view.y * view.s + sy));
  g.textAlign = 'center'; g.textBaseline = 'bottom'; g.direction = 'ltr';
  for (const o of others) {
    if (o.id === myId || !o.alive) continue;
    g.font = '600 12px Rubik, sans-serif'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.7)';
    g.strokeText(nameOf(o.id), o.x, o.y - 30); g.fillStyle = HERO_COLORS[o.hero % 4]; g.fillText(nameOf(o.id), o.x, o.y - 30);
    g.font = '10px sans-serif'; g.fillStyle = '#fff'; g.fillText('❤️'.repeat(Math.max(0, Math.ceil(o.hp / 2))), o.x, o.y - 18);
  }
  for (const f of floaters) { g.globalAlpha = Math.min(1, f.life * 2); g.font = 'bold 15px Rubik, sans-serif'; g.strokeText(f.text, f.x, f.y); g.fillStyle = f.color; g.fillText(f.text, f.x, f.y); }
  g.globalAlpha = 1;
  // screen space: joysticks, hurt flash, minimap
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const st of Object.values(sticks)) {
    if (!st) continue;
    g.globalAlpha = 0.35; g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(st.ox, st.oy, STICK, 0, Math.PI * 2); g.stroke();
    const dx = st.x - st.ox, dy = st.y - st.oy, l = Math.hypot(dx, dy), k = l > STICK ? STICK / l : 1;
    g.globalAlpha = 0.5; g.fillStyle = '#fff'; g.beginPath(); g.arc(st.ox + dx * k, st.oy + dy * k, 26, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  if (hurtFlash > 0) { const grd = g.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.3, cw / 2, ch / 2, Math.max(cw, ch) * 0.7); grd.addColorStop(0, 'rgba(255,0,0,0)'); grd.addColorStop(1, `rgba(255,0,0,${hurtFlash})`); g.fillStyle = grd; g.fillRect(0, 0, cw, ch); }
  drawMinimap(cw, rid);
}

function drawMinimap(cw, rid) {
  const s = lastSnap, cell = 16, w = 12, h = 8;
  const xs = layout.rooms.map(r => r.gx), ys = layout.rooms.map(r => r.gy);
  const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs);
  const ox = cw - 12 - (maxX - minX + 1) * cell, oy = Math.max(8, 0) + 56;
  for (const r of layout.rooms) {
    const st = s.rs[r.id] || 0;
    const seen = st & 1 || Object.values(r.doors).some(d => d != null && (s.rs[d] & 1));
    if (!seen) continue;
    const x = ox + (r.gx - minX) * cell, y = oy + (r.gy - minY) * cell;
    g.fillStyle = r.id === rid ? '#ffd27a' : st & 1 ? 'rgba(220,210,190,0.85)' : 'rgba(120,110,100,0.6)';
    g.fillRect(x, y, w, h);
    if (r.type !== 'normal' && r.type !== 'start') { g.font = '9px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(r.type === 'boss' ? '💀' : '👑', x + w / 2, y + h / 2); }
  }
}

// ---------- HUD ----------
let hudKey = '';
function renderHud() {
  if (!meta || meta.phase === 'lobby' || ui.screen !== 'room') { $hud.innerHTML = ''; hudKey = ''; return; }
  const s = lastSnap, mine = myRow();
  const hearts = mine ? Array.from({ length: Math.ceil(mine[5] / 2) }, (_, i) => (mine[4] >= (i + 1) * 2 ? '❤️' : mine[4] === i * 2 + 1 ? '💔' : '🖤')).join('') : '';
  const boss = foes.find(e => ENEMIES[e.type].boss);
  const items = (s?.me?.items || []).map(it => `<span title="${esc(ITEMS[it].name)}">${tileIcon(ITEMS[it].spr, 22)}</span>`).join('');
  const html = `
    <div class="ar-top">
      <span><button class="ar-x" data-act="quit">✕</button> <button class="ar-x" data-act="sound">${sfxSettings.sound ? '🔊' : '🔇'}</button></span>
      <div class="ar-time">⬇️ קומה ${s?.fl ?? 1}/3 · 💎 ${s?.coins ?? 0}</div>
      <div class="dg-hearts">${hearts}<small class="ar-ping">📶 ${Math.round(rtt)}</small></div>
    </div>
    <div class="dg-items">${items}</div>
    ${boss ? `<div class="dg-boss"><b>${esc(ENEMIES[boss.type].name)}</b><div class="bar"><i style="width:${Math.max(0, boss.hp / boss.maxHp * 100)}%"></i></div></div>` : ''}
    ${banner ? `<div class="ar-announce ${banner.big ? 'mine' : 'small'}">${esc(banner.text)}</div>` : ''}
    ${ui.reconnecting ? '<div class="ar-msg warn">📡 מתחבר מחדש…</div>' : ''}
    ${mine && mine[6] && meta.phase === 'play' ? `<button class="ar-dash ${localDash.cd > 0 ? 'cd' : ''}" data-act="dash">💨<small>${localDash.cd > 0 ? Math.ceil(localDash.cd) : (matchMedia('(pointer: fine)').matches ? 'Shift' : '')}</small></button>` : ''}
    ${meta.phase === 'end' ? endHtml() : ''}`;
  if (html !== hudKey) { $hud.innerHTML = html; hudKey = html; }
}
function endHtml() {
  const r = meta.run || {}, won = r.result === 'won', isHost = meta.host === myId;
  const mm = Math.floor((r.t || 0) / 60), ss = String((r.t || 0) % 60).padStart(2, '0');
  return `<div class="ar-end"><div class="panel">
    <h2>${won ? '🏆 ניצחתם את המבוך!' : '💀 הריצה נגמרה'}</h2>
    <p class="sub">${won ? 'השד האדום הובס – כל הכבוד!' : `הגעתם לקומה ${r.floor} מתוך 3`}</p>
    <div class="dg-stats"><div>⏱️ ${mm}:${ss}</div><div>⚔️ ${r.kills} מפלצות</div><div>💎 ${r.coins}</div></div>
    ${isHost ? '<button class="primary" data-act="start">🔁 ריצה חדשה</button>' : '<p class="sub">מחכים למארח/ת…</p>'}
    <button class="ghost" data-act="quit">יציאה</button>
  </div></div>`;
}

// ---------- screens ----------
function render() {
  const playing = ui.screen === 'room' && meta && meta.phase !== 'lobby';
  document.body.classList.toggle('ar-playing', !!playing);
  $game.hidden = !playing;
  if (playing) { $app.innerHTML = ''; renderHud(); return; }
  $hud.innerHTML = ''; hudKey = '';
  if (ui.screen === 'home') return renderHome();
  if (ui.screen === 'connecting' || !meta) { $app.innerHTML = '<div class="panel center"><div class="spinner"></div><p>נכנסים למבוך…</p><button class="ghost" data-act="quit">ביטול</button></div>'; return; }
  renderLobby();
}
function renderHome() {
  const best = Number(store.get('dungeon-best')) || 0;
  $app.innerHTML = `
    <div class="panel home">
      <a class="ar-back" href="./${debugOn ? '?debug=1' : ''}">→ לכל המשחקים</a>
      <h1>המבוך <span>🐉🗝️</span></h1>
      <p class="sub">ירדו 3 קומות במבוך שנבנה מחדש בכל פעם: חדרים מלאי מפלצות, אוצרות שמשדרגים אתכם, ובוס בסוף כל קומה. לבד או עם עד 3 חברים.</p>
      ${best ? `<p class="dg-best">${best >= 4 ? '🏆 כבר ניצחתם את המבוך!' : `🏅 השיא שלכם: קומה ${best}`}</p>` : ''}
      ${ui.error ? `<p class="err">${esc(ui.error)}</p>` : ''}
      <label>השם שלך<input id="name" maxlength="16" value="${esc(ui.name)}" placeholder="למשל: אורי"></label>
      ${ui.joinCode ? `<button class="primary" data-act="join">הצטרף לחדר ${esc(ui.joinCode)}</button><div class="or">או</div>` : ''}
      <button class="${ui.joinCode ? '' : 'primary'}" data-act="solo" ${ui.busy ? 'disabled' : ''}>⚔️ לשחק לבד</button>
      <button data-act="create" ${ui.busy ? 'disabled' : ''}>👥 חדר עם חברים</button>
      <div class="or">או הצטרף עם קוד</div>
      <div class="row"><input id="code" maxlength="4" value="${esc(ui.joinCode)}" placeholder="קוד חדר" dir="ltr"><button data-act="join" ${ui.busy ? 'disabled' : ''}>הצטרף</button></div>
      <details class="rules"><summary>איך משחקים?</summary><ul>
        <li><b>שליטה:</b> בטלפון – אגודל שמאל לזוז, אגודל ימין לכוון ולירות קסם (נגיעה בלי לגרור יורה על המפלצת הקרובה). במחשב – WASD, עכבר ולחיצה. 💨 זינוק (Shift) מתחמק מפגיעות.</li>
        <li><b>חדרים:</b> כשנכנסים לחדר הדלתות ננעלות עד שכל המפלצות מובסות. בחדר שנוקה לפעמים נשארים לבבות, יהלומים או אוצר.</li>
        <li><b>אוצרות:</b> בחדר האוצר 👑 ואחרי כל בוס בוחרים פריט אחד מתוך שלושה – הם מצטברים: יותר נזק, כמה קליעים, קליעים שקופצים, מחפשים מטרה, מתפוצצים, מגן מסתובב ועוד.</li>
        <li><b>בוס 💀:</b> בסוף כל קומה. אחרי שמביסים אותו יורדים במדרגות לקומה הבאה. בסוף הקומה השלישית מחכה השד האדום.</li>
        <li><b>חיים:</b> פגיעה מורידה חצי לב. מי שנופל חוזר כשהחברים מנקים את החדר. אם כולם נופלים – מתחילים מחדש, במבוך חדש.</li>
      </ul></details>
      <button class="ghost gfx-toggle" data-act="gfx">🎨 גרפיקה: ${gfxMode() === 'rich' ? 'מלאה' : 'פשוטה (קלה לטלפון)'}</button>
      <p class="version">גרסה ${VERSION}</p>
    </div>`;
}
function renderLobby() {
  const isHost = meta.host === myId, link = `${location.origin}${location.pathname}?room=${meta.code}`;
  $app.innerHTML = `
    <div class="panel lobby">
      <div class="lobby-game">🐉 המבוך</div>
      <p class="sub">קוד החדר</p>
      <div class="ar-code" dir="ltr">${esc(meta.code)}</div>
      <div class="ar-qr" id="qr"></div>
      <div class="row"><button data-act="share">📤 שיתוף קישור</button></div>
      <h3>הצוות (${meta.players.length}/${MAX_PLAYERS})</h3>
      <ul class="plist dg-team">${meta.players.map((p, i) => `<li>${tileIcon(HEROES[i % 4], 28)} ${esc(p.name)} <small>(${HERO_NAMES[i % 4]})</small>${p.id === meta.host ? ' 👑' : ''}${p.id === myId ? ' (את/ה)' : ''}</li>`).join('')}</ul>
      ${isHost ? '<button class="primary" data-act="start">⚔️ יוצאים לדרך!</button>' : '<p class="sub">מחכים שהמארח/ת יתחיל/תתחיל…</p>'}
      <button class="ghost" data-act="quit">יציאה</button>
    </div>`;
  const el = document.getElementById('qr');
  if (el && window.qrcode) { try { const q = window.qrcode(0, 'M'); q.addData(link); q.make(); el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch {} }
}

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  const nameOk = () => { const n = document.getElementById('name')?.value.trim() ?? ui.name; if (!n) { ui.error = 'צריך שם 🙂'; render(); return false; } ui.name = n.slice(0, 16); store.set('hathatul-name', ui.name); ui.error = ''; return true; };
  switch (act) {
    case 'solo': case 'create': {
      if (!nameOk()) return;
      ui.busy = true; render();
      try { const { code: c } = await api('/api/new'); ui.busy = false; connect(c, act === 'solo'); }
      catch { ui.busy = false; ui.error = 'אין חיבור לשרת המשחק. נסו שוב.'; render(); }
      return;
    }
    case 'join': {
      if (!nameOk()) return;
      const c = (document.getElementById('code')?.value || ui.joinCode).trim().toUpperCase();
      if (!/^[A-Z]{4}$/.test(c)) { ui.error = 'קוד חדר הוא 4 אותיות באנגלית'; return render(); }
      ui.busy = true; render();
      try { const r = await api(`/api/check?code=${c}`); ui.busy = false; if (!r.exists) { ui.error = `לא מצאנו חדר ${c}`; ui.joinCode = ''; return render(); } connect(c, false); }
      catch { ui.busy = false; ui.error = 'אין חיבור לשרת המשחק. נסו שוב.'; render(); }
      return;
    }
    case 'quit': if (meta?.phase === 'play' && !confirm('לצאת מהריצה?')) return; ui.joinCode = ''; return leave();
    case 'share': { const link = `${location.origin}${location.pathname}?room=${meta.code}`; if (navigator.share) navigator.share({ title: 'המבוך', text: `בואו למבוך איתי! קוד: ${meta.code}`, url: link }).catch(() => {}); else { navigator.clipboard?.writeText(link); toast('הקישור הועתק'); } return; }
    case 'start': play('pop'); return send({ t: 'start' });
    case 'sound': toggleSfx('sound'); return;
    case 'gfx': setGfxMode(gfxMode() === 'rich' ? 'simple' : 'rich'); return render();
  }
});

// ---------- main loop ----------
let prev = performance.now(), hudAt = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
  if (!(ui.screen === 'room' && meta && meta.phase !== 'lobby')) return;
  interpolate(now);
  stepLocal(dt);
  for (const pt of particles) { pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vx *= 0.92; pt.vy *= 0.92; pt.life -= dt; }
  for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);
  for (const f of floaters) { f.y -= 30 * dt; f.life -= dt; }
  for (let i = floaters.length - 1; i >= 0; i--) if (floaters[i].life <= 0) floaters.splice(i, 1);
  shake = Math.max(0, shake - dt * 40); hurtFlash = Math.max(0, hurtFlash - dt);
  if (banner && (banner.life -= dt) <= 0) banner = null;
  drawWorld(now, dt);
  if (now - hudAt > 80) { hudAt = now; renderHud(); }
}
requestAnimationFrame(frame);
gfx.preload();
render();
