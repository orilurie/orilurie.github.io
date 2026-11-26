// המבוך – client. Room-by-room co-op roguelite for 1–4 players (solo, with friends, or the daily run).
// The run lives on the game server (arena-server/, class Dungeon); this file draws it, predicts
// your own movement (same step model as the arena) and sends your input.

import * as core from './dungeon-core.js?v=52';
import { play, haptic, settings as sfxSettings, toggle as toggleSfx } from './sfx.js?v=52';
import { sound, addSounds } from './arena-audio.js?v=52';
import * as gfx from './arena-gfx.js?v=52';
import { gfxMode, setGfxMode, isRich } from './gfx-mode.js?v=52';

const { T, CW, CH, RW, RH, DASH, INTERP_MS, ITEMS, ITEM_LIST, ENEMIES, ENEMY_LIST, MAX_PLAYERS, genFloor, solids, move, roomAt, blocked } = core;
// v2 tables from the core (with a fallback so an older core never breaks the page)
const HEROES = core.HEROES || [
  { key: 'knight', name: 'אביר', spr: 97, color: '#ffd27a', ab: 'shield', abName: 'מגן', abCd: 9, weapon: 'sword', hp: 8, unlock: 0 },
  { key: 'wizard', name: 'קוסם', spr: 84, color: '#b07aff', ab: 'fireball', abName: 'כדור אש', abCd: 5, weapon: 'wand', hp: 6, unlock: 0 },
  { key: 'rogue', name: 'נוכלת', spr: 99, color: '#ff7aa8', ab: 'daggers', abName: 'מטר פגיונות', abCd: 6, weapon: 'daggers', hp: 6, unlock: 60 },
  { key: 'elf', name: 'שדונית', spr: 112, color: '#6fe08a', ab: 'volley', abName: 'מטח חיצים', abCd: 5, weapon: 'spear', hp: 6, unlock: 120 },
];
const WEAPONS = core.WEAPONS || { wand: { name: 'שרביט', spr: 130, kind: 'shot' } };
const WEAPON_LIST = core.WEAPON_LIST || Object.keys(WEAPONS);
const CHEST = core.CHEST_SPR || { wood: 89, gold: 89, open: 91, mimic: 92 };
const hero = h => HEROES[((h | 0) % HEROES.length + HEROES.length) % HEROES.length];

// menus (hero picker, gems, daily leaderboard, admin panel) – loaded on the side so a problem there never breaks the game
let menus = null;
import('./dungeon-menus.js?v=52').then(m => { menus = m; if (ui.screen !== 'room' || meta?.phase === 'lobby') render(); }).catch(() => {});
const isAdmin = () => (menus ? menus.isAdminName(ui.name) : false);

export const VERSION = 52;
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

// missing sound files just stay silent (arena-audio skips what fails to load)
addSounds({
  dg_bolt: ['dg_bolt'], dg_squish: ['dg_squish'], dg_eshot: ['dg_enemyshot'], dg_lock: ['dg_lock'], dg_unlock: ['dg_unlock'],
  dg_coin: ['dg_coin'], dg_item: ['dg_item'], dg_chest: ['dg_chest'], dg_stairs: ['dg_stairs'],
  dg_shield: ['dg_shield'], dg_fireball: ['dg_fireball'], dg_slash: ['dg_slash'], dg_shock: ['dg_shock'], dg_buy: ['dg_buy'],
  dg_open: ['dg_open'], dg_mimic: ['dg_mimic'], dg_secret: ['dg_secret'], dg_phase2: ['dg_phase2'], dg_revive: ['dg_revive'],
  dg_warn: ['dg_warn'], dg_unlocked: ['dg_unlocked'],
}, {
  dg_bolt: 0.35, dg_squish: 0.6, dg_eshot: 0.35, dg_lock: 0.8, dg_unlock: 0.8, dg_coin: 0.6, dg_item: 0.8, dg_chest: 0.7, dg_stairs: 0.8,
  dg_shield: 0.7, dg_fireball: 0.7, dg_slash: 0.45, dg_shock: 0.7, dg_buy: 0.7, dg_open: 0.7, dg_mimic: 0.8, dg_secret: 0.8,
  dg_phase2: 0.9, dg_revive: 0.7, dg_warn: 0.6, dg_unlocked: 0.8,
});

const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const sstore = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch {} } };
let pid = sstore.get('dungeon-pid');
if (!pid) { pid = 'd' + Math.random().toString(36).slice(2, 10); sstore.set('dungeon-pid', pid); }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $app = document.getElementById('app'), $game = document.getElementById('game'), $hud = document.getElementById('hud'), $toast = document.getElementById('toast');
const cv = document.getElementById('cv'), g = cv.getContext('2d');
const ui = {
  screen: 'home', name: store.get('hathatul-name') || '', joinCode: (params.get('room') || '').toUpperCase(), error: '', busy: false,
  hero: Math.max(0, Math.min(HEROES.length - 1, Number(store.get('dungeon-hero')) || 0)), daily: false, dailyState: null, dailyAt: 0,
};
function toast(t) { $toast.textContent = t; $toast.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => $toast.classList.remove('show'), 2400); }

// ---------- sprites (Kenney Tiny Dungeon, 16×16 tiles in a 12-column sheet) ----------
const sheet = new Image(); sheet.src = 'dungeon/tiles.png';
function tile(idx, x, y, size, flip = false, alpha = 1) {
  if (!sheet.complete) return;
  const sx = (idx % 12) * 16, sy = Math.floor(idx / 12) * 16;
  g.save(); g.globalAlpha *= alpha; g.imageSmoothingEnabled = false;
  if (flip) { g.translate(x + size, y); g.scale(-1, 1); g.drawImage(sheet, sx, sy, 16, 16, 0, 0, size, size); }
  else g.drawImage(sheet, sx, sy, 16, 16, x, y, size, size);
  g.restore();
}
// a tile drawn centred on (x, y) and turned by rot
function tileRot(idx, x, y, size, rot, alpha = 1, flip = false) {
  if (!sheet.complete) return;
  g.save(); g.globalAlpha *= alpha; g.imageSmoothingEnabled = false; g.translate(x, y); g.rotate(rot); if (flip) g.scale(-1, 1);
  g.drawImage(sheet, (idx % 12) * 16, Math.floor(idx / 12) * 16, 16, 16, -size / 2, -size / 2, size, size);
  g.restore();
}
const tileIcon = (idx, px = 32) => `<span class="dg-ico" style="width:${px}px;height:${px}px;background-position:-${(idx % 12) * px}px -${Math.floor(idx / 12) * px}px;background-size:${12 * px}px auto"></span>`;
// slash arcs (Kenney particle pack, white – tinted per colour); missing files are skipped
const slashImgs = [0, 1, 2, 3].map(i => { const im = new Image(); im.src = `dungeon/slash_${i}.png`; return im; });
const tinted = new Map();
function slashTex(i, color) {
  const im = slashImgs[i];
  if (!im.complete || !im.naturalWidth) return null;
  const key = i + color;
  if (!tinted.has(key)) {
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const x = c.getContext('2d'); x.drawImage(im, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
    tinted.set(key, c);
  }
  return tinted.get(key);
}
const AB_ICON = { shield: ['shield', '🛡️'], fireball: ['fire', '🔥'], daggers: ['dagger', '🗡️'], volley: ['bow', '🏹'] };
const uiImg = (name, emoji, cls = '') => `<span class="dg-uiimg ${cls}"><img src="dungeon/ui/${name}.png" alt="" onerror="this.remove()"><b>${emoji}</b></span>`;
// item icons: optional Fluent PNG (ITEMS[k].icon → dungeon/ui/<icon>.png), else the sheet tile
const iconImgs = new Map();
function iconImg(name) {
  if (!name) return null;
  if (!iconImgs.has(name)) { const im = new Image(); im.src = `dungeon/ui/${name}.png`; iconImgs.set(name, im); }
  const im = iconImgs.get(name);
  return im.complete && im.naturalWidth ? im : null;
}
function drawIcon(info, x, y, size, alpha = 1) { // top-left at (x, y)
  const im = iconImg(info.icon);
  if (!im) return tile(info.spr, x, y, size, false, alpha);
  g.save(); g.globalAlpha *= alpha; g.imageSmoothingEnabled = true; const k = 0.82; g.drawImage(im, x + size * (1 - k) / 2, y + size * (1 - k) / 2, size * k, size * k); g.restore();
}
const itemIconHtml = (it, px) => (it.icon ? `<span class="dg-iic">${tileIcon(it.spr, px)}<img src="dungeon/ui/${it.icon}.png" alt="" width="${px}" height="${px}" style="display:none" onload="this.style.display='';this.previousElementSibling.remove()"></span>` : tileIcon(it.spr, px));
// glow in full graphics; a soft disc in simple graphics
function aura(x, y, r, color, a = 0.5) {
  if (isRich()) return gfx.drawGlow(g, x, y, r, color, a);
  g.save(); g.globalAlpha = a * 0.35; g.fillStyle = color; g.beginPath(); g.arc(x, y, r * 0.6, 0, Math.PI * 2); g.fill(); g.restore();
}
const RARITY = ['#ffffff', '#5aa9ff', '#ffc531'];
// pedestal code → what it shows
function pedInfo(code) {
  if (typeof code === 'number') code = ITEM_LIST[code];
  if (code === 'hp') return { spr: 115, name: 'מילוי לבבות', r: 0 };
  if (typeof code === 'string' && code.startsWith('w:')) { const w = WEAPONS[code.slice(2)]; return { spr: w?.spr ?? 130, name: w?.name ?? '', r: 1, weapon: true }; }
  const it = ITEMS[code];
  return it ? { spr: it.spr, icon: it.icon, name: it.name, desc: it.desc, r: it.r || 0 } : { spr: 66, name: '?', r: 0 };
}

// ---------- networking ----------
let ws = null, wantOpen = false, retry = 0, code = null;
let meta = null, myId = pid, lastSnap = null, rtt = 0;
const snaps = [];
let layout = null, layoutKey = '', curSolids = null, lockedKey = '';
async function api(path) { const r = await fetch(SERVER + path, { cache: 'no-store' }); if (!r.ok) throw new Error('server'); return r.json(); }
function connect(c, solo, daily = false) {
  if (!history.state?.room) history.pushState({ room: 1 }, '', location.href);
  code = c; wantOpen = true; ui.solo = solo; ui.daily = daily; ui.screen = 'connecting'; render(); open();
  history.replaceState(null, '', `?room=${c}${debugOn ? '&debug=1' : ''}${params.get('server') ? '&server=' + encodeURIComponent(SERVER) : ''}`);
}
function open() {
  const sock = new WebSocket(`${WS_URL}/dws/${code}`);
  ws = sock;
  sock.onopen = () => { retry = 0; sock.send(JSON.stringify({ t: 'hello', id: pid, name: ui.name, solo: ui.solo ? 1 : 0, hero: ui.hero, daily: ui.daily ? 1 : 0 })); };
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
addEventListener('popstate', () => {
  if (ui.screen !== 'room' && ui.screen !== 'connecting') return;
  if (confirm('לצאת מהחדר?')) leave(); else history.pushState({ room: 1 }, '', location.href);
});
function leave(err = '') {
  wantOpen = false; try { ws?.close(); } catch {}
  ws = null; meta = null; lastSnap = null; snaps.length = 0; layout = null;
  ui.screen = 'home'; ui.error = err; ui.daily = false; closeAdmin();
  history.replaceState(null, '', location.pathname + (debugOn ? '?debug=1' : '') + (params.get('server') ? `${debugOn ? '&' : '?'}server=${encodeURIComponent(SERVER)}` : ''));
  render();
}

let endInfo = null; // { gems, daily html } for the end screen of the current run
function onRunEnd(r) {
  const won = r.result === 'won';
  play(won ? 'win' : 'lose'); haptic(won ? 'win' : 'tap');
  const best = Number(store.get('dungeon-best')) || 0;
  if (r.floor > best || (won && best < 4)) store.set('dungeon-best', won ? 4 : r.floor);
  endInfo = { gems: 0, board: '' };
  if (menus && !r.cheated) {
    const n = menus.runGems({ floor: r.floor || 1, kills: r.kills || 0, won });
    const key = `dungeon-gems-${code}-${r.t}-${r.kills}-${r.floor}`;
    if (sstore.get(key)) endInfo.gems = n;
    else if (n > 0) { menus.addGems(n); sstore.set(key, '1'); endInfo.gems = n; }
  }
  if (r.daily && menus) { // the server posts the score itself; give it a moment, then show the table
    setTimeout(() => menus.loadDaily(SERVER).then(st => { if (endInfo) { endInfo.board = menus.dailyHtml(st); hudKey = ''; } }).catch(() => {}), 1200);
  }
}
function onMsg(m) {
  if (m.t === 'welcome') { myId = m.id; ui.reconnecting = false; return; }
  if (m.t === 'pong') { const r = performance.now() - m.c; rtt = rtt ? rtt * 0.7 + r * 0.3 : r; return; }
  if (m.t === 'err') { toast(m.m); if (m.fatal) leave(m.m); return; }
  if (m.t === 'room') {
    const prev = meta?.phase;
    meta = m; ui.screen = 'room';
    if (m.phase === 'play' && prev !== 'play') { resetRun(); endInfo = null; }
    if (m.phase === 'end' && prev !== 'end' && m.run) onRunEnd(m.run);
    render();
    return;
  }
  if (m.t === 's') {
    snaps.push({ at: performance.now(), s: m });
    while (snaps.length > 40) snaps.shift();
    const key = m.seed + ':' + m.fl;
    if (key !== layoutKey) { layoutKey = key; layout = genFloor(m.seed, m.fl); me = null; pending.length = 0; curSolids = null; }
    const lk = m.rs.map(r => (r & 4 ? 1 : 0)).join('') + (m.so ? 'S' : '');
    if (lk !== lockedKey || !curSolids) { lockedKey = lk; curSolids = solids(layout, m.rs.map(r => !!(r & 4)), !!m.so); }
    lastSnap = m;
    handleEvents(m.ev || []);
    reconcile(m);
  }
}

// ---------- input (same scheme as the arena) ----------
const input = { mx: 0, my: 0, a: 0, f: false };
const keys = new Set();
const sticks = { move: null, aim: null };
let mouse = null, abCount = 0, sentB = 0;
const inRun = () => ui.screen === 'room' && meta?.phase === 'play';
addEventListener('keydown', e => {
  if (!inRun() || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  keys.add(e.code);
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat) dashPress();
  if ((e.code === 'KeyQ' || e.code === 'KeyE') && !e.repeat) abilityPress();
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); sticks.move = sticks.aim = null; if (mouse) mouse.down = false; });
cv.addEventListener('pointerdown', e => {
  e.preventDefault();
  if (e.pointerType === 'mouse') { if (e.button === 2) return dashPress(); if (e.button === 1) return abilityPress(); mouse = { x: e.clientX, y: e.clientY, down: e.button === 0 }; return; }
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
$hud.addEventListener('pointerdown', e => {
  if (e.target.closest('[data-act=dash]')) { e.preventDefault(); dashPress(); }
  else if (e.target.closest('[data-act=ab]')) { e.preventDefault(); abilityPress(); }
});

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
function resetRun() { me = null; pending.length = 0; outbox.length = 0; particles.length = 0; floaters.length = 0; fx.length = 0; swings.clear(); layoutKey = ''; snaps.length = 0; lastSnap = null; localDash = { t: 0, cd: 0, dir: null }; banner = null; crackFlash = 0; }
function dashPress() {
  if (!me || me.dead || localDash.cd > 0) return;
  const l = Math.hypot(input.mx, input.my), a = l > 0.2 ? Math.atan2(input.my, input.mx) : input.a;
  localDash = { t: DASH.time, cd: DASH.cd, dir: { mx: Math.cos(a), my: Math.sin(a) } };
  lastSent = 0; sound('dash'); haptic('tap');
}
function abilityPress() {
  const sp = myRow();
  if (!me || me.dead || !sp || !sp[6]) return;
  if ((sp[15] ?? 1) < 1) { haptic('tap'); return; } // still charging
  abCount++; lastSent = 0; haptic('tap');
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
    // instant feedback for shooting weapons (melee / hammer sound comes with the server's slash / shock)
    const wk = WEAPONS[sp[14]]?.kind || 'shot';
    if (input.f && wk === 'shot' && (me.fireCd = (me.fireCd || 0) - dt) <= 0) { me.fireCd = 0.3; sound('dg_bolt'); }
  }
  const urgent = input.f !== sentF || abCount !== sentB || outbox.some(c => c[4]);
  if (inRun() && ((outbox.length && (urgent || now - lastSent >= 50)) || abCount !== sentB || now - lastSent > 250)) {
    sentF = input.f; sentB = abCount; lastSent = now;
    send({ t: 'in', a: input.a, f: input.f ? 1 : 0, c: outbox.splice(0), r: Math.round(rtt), b: abCount });
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
    others.push({
      id: pb[0], x: lerp(pa[1], pb[1], jump), y: lerp(pa[2], pb[2], jump), aim: pb[3], hp: pb[4], maxHp: pb[5], alive: !!pb[6], inv: !!pb[7], dash: !!pb[8],
      moving: Math.hypot(pb[9], pb[10]) > 30, hero: pb[11] | 0, orbit: pb[12], weapon: pb[14], abReady: pb[15] ?? 1, shield: !!pb[16], revive: pb[17] || 0, god: !!pb[18],
    });
  }
  for (const eb of b.s.e) {
    const ea = a.s.e.find(e => e[0] === eb[0]) || eb;
    foes.push({ id: eb[0], type: ENEMY_LIST[eb[1]], x: lerp(ea[2], eb[2]), y: lerp(ea[3], eb[3]), hp: eb[4], maxHp: eb[5], waking: !!eb[6], slow: !!eb[7], face: eb[8], elite: !!eb[9], warn: !!eb[10], phase: eb[11] || 1 });
  }
}

// ---------- effects ----------
const particles = [], floaters = [], fx = [], booms = [];
const swings = new Map(); // player id → { t0, a, arc } for the melee swing of the weapon in hand
let shake = 0, hurtFlash = 0, banner = null, crackFlash = 0;
const playerById = id => meta?.players.find(p => p.id === id);
const nameOf = id => playerById(id)?.name || '?';
const colorOf = id => hero(others.find(o => o.id === id)?.hero ?? playerById(id)?.hero ?? 0).color;
function spark(x, y, color, n = 8, speed = 160) {
  for (let i = 0; i < n; i++) { const a = Math.random() * 6.28, v = speed * (0.4 + Math.random()); particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.35 + Math.random() * 0.25, max: 0.6, color, size: 3 + Math.random() * 2 }); }
}
function puff(x, y, n, color, size) {
  for (let i = 0; i < n; i++) { const a = Math.random() * 6.28, v = 30 * (0.3 + Math.random()); particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.8, max: 0.8, color, size: size * (0.6 + Math.random() * 0.5), sprite: 'smoke_04', rot: Math.random() * 6 }); }
}
const ring = (x, y, r, color, dur = 320, width = 6) => fx.push({ k: 'ring', x, y, r, color, t0: performance.now(), dur, width });
const near = (x, y) => (me ? { at: { x, y }, listener: me } : {});
const mine = id => id === myId;
function handleEvents(evs) {
  for (const ev of evs) {
    switch (ev.k) {
      case 'shot': if (!mine(ev.id)) sound('dg_bolt', { ...near(ev.x, ev.y), vol: 0.6 }); break;
      case 'ehit':
        spark(ev.x, ev.y, ev.crit ? '#ffe14d' : '#fff2b0', ev.crit ? 10 : 5);
        floaters.push(ev.crit ? { x: ev.x, y: ev.y - 24, text: `-${ev.dmg}!`, color: '#ffd23d', life: 0.9, big: true } : { x: ev.x, y: ev.y - 20, text: `-${ev.dmg}`, color: '#fff', life: 0.7 });
        sound('hit', { ...near(ev.x, ev.y), vol: ev.crit ? 0.8 : 0.5 }); break;
      case 'edie': puff(ev.x, ev.y, 4, '#b9c2cf', 50); spark(ev.x, ev.y, '#9fe8a0', 12, 200); sound('dg_squish', near(ev.x, ev.y)); break;
      case 'poof': spark(ev.x, ev.y, '#cfe3ff', 3, 80); break;
      case 'hurt':
        spark(ev.x, ev.y, '#ff6b6b', 10);
        if (mine(ev.id)) { sound('hurt'); haptic('hurt'); shake = 12; hurtFlash = 0.4; }
        break;
      case 'down': puff(ev.x, ev.y, 6, '#888', 60); if (mine(ev.id)) { sound('die'); haptic('die'); banner = { text: '💀 נפלת! חבר/ה שיעמוד/תעמוד לידך יחזיר/תחזיר אותך', life: 3 }; } else banner = { text: `💀 ${nameOf(ev.id)} נפל/ה! עמדו לידו/ה כדי להחיות`, life: 2.4 }; break;
      case 'revive': {
        const o = others.find(p => p.id === ev.id); if (o) { ring(o.x, o.y, 70, '#9dffb0'); spark(o.x, o.y, '#9dffb0', 14, 180); }
        if (mine(ev.id)) banner = { text: '✨ חזרת לחיים!', life: 2 }; else banner = { text: `✨ ${nameOf(ev.id)} חזר/ה לחיים`, life: 1.6 };
        sound('dg_revive'); break;
      }
      case 'phoenix': { const o = others.find(p => p.id === ev.id); if (o) { ring(o.x, o.y, 110, '#ff9a3d', 500, 10); spark(o.x, o.y, '#ffb14d', 26, 260); } banner = { text: mine(ev.id) ? '🔥 נוצת עוף החול החזירה אותך!' : `🔥 ${nameOf(ev.id)} קם/ה מהאפר!`, life: 2.4, big: mine(ev.id) }; sound('dg_revive'); break; }
      case 'lock': sound('dg_lock'); haptic('turn'); if (ev.boss) banner = { text: `⚔️ ${ENEMIES[ev.boss]?.name ?? ''}!`, life: 2.6, big: true }; break;
      case 'clear': sound('dg_unlock'); banner = { text: '✨ החדר נוקה – הדלתות נפתחו', life: 1.8 }; break;
      case 'pick': spark(ev.x, ev.y, ev.type === 'coin' ? '#ffd24d' : '#ff7a9c', 8); if (mine(ev.id)) sound(ev.type === 'coin' ? 'dg_coin' : 'pickup'); break;
      case 'item': {
        const it = ITEMS[ev.item]; if (!it) break;
        spark(ev.x, ev.y, RARITY[it.r || 0] === '#ffffff' ? '#ffd27a' : RARITY[it.r || 0], 18, 220);
        if (mine(ev.id)) { sound('dg_item'); haptic('win'); banner = { text: `${it.name}: ${it.desc}`, life: 3, big: true }; } else banner = { text: `${nameOf(ev.id)} לקח/ה ${it.name}`, life: 2 };
        break;
      }
      case 'weapon': { const w = WEAPONS[ev.w]; if (ev.x != null) spark(ev.x, ev.y, '#cfe3ff', 12, 180); if (mine(ev.id) && w) { sound('dg_item'); banner = { text: `🗡️ נשק חדש: ${w.name}`, life: 2.2, big: true }; } break; }
      case 'boom': booms.push({ x: ev.x, y: ev.y, r: ev.r, t0: performance.now() }); sound('boom', { ...near(ev.x, ev.y), vol: 0.6 }); break;
      case 'bossdown': booms.push({ x: ev.x, y: ev.y, r: 140, t0: performance.now() }); shake = 22; sound('boom'); banner = { text: '🏆 הבוס הובס! מדרגות למטה נפתחו', life: 3, big: true }; break;
      case 'roar': shake = Math.max(shake, 10); break;
      case 'floor': if (ev.n > 1) { banner = { text: `⬇️ קומה ${ev.n}`, life: 2.4, big: true }; sound('dg_stairs'); } break;
      case 'heal': if (mine(ev.id)) { sound('pickup'); floaters.push({ x: me?.x ?? 0, y: (me?.y ?? 0) - 30, text: '❤️ +1', color: '#ff7a9c', life: 1 }); } break;
      case 'pull': if (mine(ev.id)) banner = { text: '🌀 הצטרפת לחברים לקרב!', life: 1.6 }; break;
      case 'dash': if (!mine(ev.id)) puff(ev.x, ev.y, 2, '#c9b89a', 36); break;
      // v2
      case 'ab': {
        const h = hero(ev.hero), c = h.color;
        if (h.ab === 'shield') { ring(ev.x, ev.y, 100, '#8fd8ff', 420, 10); sound('dg_shield', near(ev.x, ev.y)); }
        else if (h.ab === 'fireball') sound('dg_fireball', near(ev.x, ev.y));
        else if (h.ab === 'daggers') { ring(ev.x, ev.y, 60, c, 250, 4); sound('dg_slash', near(ev.x, ev.y)); }
        else sound('dg_bolt', near(ev.x, ev.y));
        spark(ev.x, ev.y, c, 10, 160);
        if (mine(ev.id)) haptic('turn');
        break;
      }
      case 'slash': {
        const c = colorOf(ev.id);
        fx.push({ k: 'slash', x: ev.x, y: ev.y, a: ev.a, arc: ev.arc || 1.1, r: ev.r || 75, color: c, t0: performance.now(), dur: 220, id: ev.id });
        swings.set(ev.id, { t0: performance.now(), a: ev.a, arc: ev.arc || 1.1 });
        sound('dg_slash', { ...near(ev.x, ev.y), vol: mine(ev.id) ? 1 : 0.6 });
        break;
      }
      case 'shock': ring(ev.x, ev.y, ev.r || 110, '#ffe3a0', 360, 10); spark(ev.x, ev.y, '#c9b89a', 14, 260); shake = Math.max(shake, mine(ev.id) ? 7 : 3); sound('dg_shock', near(ev.x, ev.y)); swings.set(ev.id, { t0: performance.now(), a: -Math.PI / 2, arc: 1.3 }); break;
      case 'buy': {
        const info = pedInfo(ev.code); spark(ev.x, ev.y, '#ffd24d', 16, 200); sound('dg_buy');
        banner = { text: mine(ev.id) ? `🛒 קנית: ${info.name}` : `🛒 ${nameOf(ev.id)} קנה/תה ${info.name}`, life: 2, big: mine(ev.id) };
        break;
      }
      case 'nocash': if (mine(ev.id) && performance.now() - (handleEvents.noCashAt || 0) > 1500) { handleEvents.noCashAt = performance.now(); toast('🪙 אין מספיק מטבעות'); sound('empty'); } break;
      case 'chest': spark(ev.x, ev.y, ev.kind ? '#ffd24d' : '#e0b070', 18, 200); sound('dg_open', near(ev.x, ev.y)); break;
      case 'mimic': shake = Math.max(shake, 8); spark(ev.x, ev.y, '#ff5d5d', 16, 220); sound('dg_mimic', near(ev.x, ev.y)); banner = { text: '😱 מימיק! התיבה נושכת', life: 2, big: true }; break;
      case 'crack': crackFlash = 1; spark(ev.x, ev.y, '#a9a0b8', 8, 160); sound('wall', { ...near(ev.x, ev.y), vol: 1 }); break;
      case 'secret': {
        const sr = layout?.secret?.rect; if (sr) { puff(sr[0] + sr[2] / 2, sr[1] + sr[3] / 2, 8, '#a9a0b8', 70); spark(sr[0] + sr[2] / 2, sr[1] + sr[3] / 2, '#d8d0e8', 20, 220); }
        shake = Math.max(shake, 10); sound('dg_secret'); banner = { text: '🗝️ מצאתם חדר סודי!', life: 2.6, big: true }; break;
      }
      case 'phase2': shake = 18; ring(ev.x, ev.y, 160, '#ff3b3b', 500, 12); sound('dg_phase2'); haptic('hurt'); banner = { text: '🔥 הבוס התעצבן! שלב 2', life: 2.6, big: true }; break;
      case 'warn': sound('dg_warn', { vol: 0.8 }); break;
      case 'curse': if (mine(ev.id)) { banner = { text: '🩸 המזבח לקח ממך 2 לבבות', life: 2.6 }; hurtFlash = 0.5; } break;
      case 'cwave': banner = { text: ev.n > 1 ? '⚔️ גל אחרון – עם עלית!' : '⚔️ אתגר! שרדו את הגלים', life: 2.2, big: true }; sound('dg_lock'); break;
      case 'chain': fx.push({ k: 'bolt', x: ev.x1, y: ev.y1, x2: ev.x2, y2: ev.y2, t0: performance.now(), dur: 200 }); break;
      case 'block': spark(ev.x, ev.y, '#cfe3ff', 6, 140); sound('block', { ...near(ev.x, ev.y), vol: 0.6 }); break;
      case 'admin': toast(`⚙️ ${ev.c}`); break;
    }
  }
}

// ---------- rendering ----------
let view = { x: 0, y: 0, s: 1 }, dpr = 1;
function resize() { dpr = Math.min(2, devicePixelRatio || 1); cv.width = Math.round(innerWidth * dpr); cv.height = Math.round(innerHeight * dpr); }
addEventListener('resize', resize); resize();
const toScreen = (x, y) => ({ x: (x - view.x) * view.s + innerWidth / 2, y: (y - view.y) * view.s + innerHeight / 2 });
const hash = (a, b) => ((a * 73856093) ^ (b * 19349663)) >>> 0;
const secretOpen = () => !!lastSnap?.so;
const isHiddenRoom = r => r.hidden && !secretOpen();

function drawRoom(r, rs, now) {
  if (isHiddenRoom(r)) return; // the secret room stays out of sight until its wall breaks
  const visited = rs & 1, locked = rs & 4;
  const S = T;
  // floor
  for (let ty = 0; ty < RH; ty++) for (let tx = 0; tx < RW; tx++) {
    const h = hash(r.gx * 100 + tx, r.gy * 100 + ty) % 10;
    tile(h < 6 ? 48 : h < 8 ? 49 : h < 9 ? 50 : 51, r.x + S + tx * S, r.y + S + ty * S, S);
  }
  // walls
  for (let tx = 0; tx < RW + 2; tx++) for (const ty of [0, RH + 1]) tile(40, r.x + tx * S, r.y + ty * S, S);
  for (let ty = 1; ty < RH + 1; ty++) for (const tx of [0, RW + 1]) tile(40, r.x + tx * S, r.y + ty * S, S);
  // torches on the top wall
  tile(29, r.x + 3 * S, r.y, S); tile(29, r.x + (RW - 2) * S, r.y, S);
  // doors: open archways, closed doors while the room is locked (no archway towards an unfound secret room)
  const cx = r.x + CW / 2, cy = r.y + CH / 2;
  const door = (x, y, rot) => {
    g.save(); g.translate(x, y); g.rotate(rot);
    g.fillStyle = '#1a1210'; g.fillRect(-S, -S / 2, 2 * S, S);
    if (locked) { tile(46, -S, -S / 2, S); tile(46, 0, -S / 2, S, true); }
    g.restore();
  };
  const hasDoor = d => r.doors[d] != null && !(layout.rooms[r.doors[d]]?.hidden && !secretOpen()) && !(r.hidden && !secretOpen());
  if (hasDoor('n')) door(cx, r.y + S / 2, 0);
  if (hasDoor('s')) door(cx, r.y + CH - S / 2, Math.PI);
  if (hasDoor('w')) door(r.x + S / 2, cy, -Math.PI / 2);
  if (hasDoor('e')) door(r.x + CW - S / 2, cy, Math.PI / 2);
  // rocks / pillars
  for (const [x, y, w, h] of r.obstacles || []) for (let yy = y; yy < y + h; yy += S) for (let xx = x; xx < x + w; xx += S) tile(w > S || h > S ? 57 : 12, xx, yy, S);
  // room furniture
  if (r.type === 'shop') { // the shopkeeper at the top-centre, behind a little counter
    const bob = Math.sin(now / 500) * 2;
    aura(cx, r.y + S + 26, 34, '#ffd24d', 0.35);
    tile(86, cx - 22, r.y + S - 2 + bob, 44);
    tile(72, cx - 24, r.y + S + 30, 48);
    tile(82, r.x + S, r.y + S, S); tile(82, r.x + S, r.y + 2 * S, S); tile(82, r.x + RW * S, r.y + S, S);
  } else if (r.type === 'altar') { // a gargoyle statue over the altar
    aura(cx, r.y + S + 40, 46, '#ff3b5c', 0.3 + 0.1 * Math.sin(now / 400));
    tile(19, cx - 20, r.y, 40); tile(32, cx - 24, r.y + S + 4, 48);
  } else if (r.type === 'secret') {
    tile(82, r.x + 2 * S, r.y + 2 * S, S); tile(82, r.x + (RW - 1) * S, r.y + 2 * S, S);
  }
  if (!visited) { g.fillStyle = 'rgba(8,6,12,0.85)'; g.fillRect(r.x, r.y, CW, CH); }
}

// the cracked wall that hides the secret room: darker bricks with cracks that grow with every hit
function drawCrack(now) {
  const sec = layout.secret; if (!sec?.rect) return;
  const [x, y, w, h] = sec.rect, S = T;
  if (secretOpen()) { // broken through: rubble on the floor of the opening
    g.fillStyle = '#1a1210'; g.fillRect(x, y, w, h);
    for (let yy = y; yy < y + h; yy += S) for (let xx = x; xx < x + w; xx += S) tile(hash(xx, yy) % 2 ? 24 : 12, xx, yy, S, false, 0.85);
    if ((lastSnap.rs[sec.from] || 0) & 4) { // shut while the room in front is locked
      const vert = sec.dir === 'n' || sec.dir === 's';
      g.save(); g.translate(x + w / 2, y + h / 2); g.rotate(vert ? 0 : Math.PI / 2); tile(46, -S, -S / 2, S); tile(46, 0, -S / 2, S, true); g.restore();
    }
    return;
  }
  const fromVisited = (lastSnap.rs[sec.from] || 0) & 1;
  if (!fromVisited) return;
  for (let yy = y; yy < y + h; yy += S) for (let xx = x; xx < x + w; xx += S) tile(hash(xx, yy) % 3 ? 28 : 40, xx, yy, S);
  g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(x, y, w, h);
  const hits = lastSnap.ck || 0;
  g.save(); g.strokeStyle = 'rgba(20,14,24,0.95)'; g.lineWidth = 2.5; g.lineCap = 'round';
  const R = (n) => (hash(x + n * 17, y + n * 31) % 1000) / 1000;
  const lines = 3 + hits * 2;
  for (let i = 0; i < lines; i++) {
    let px = x + w * (0.2 + 0.6 * R(i)), py = y + h * (0.2 + 0.6 * R(i + 50));
    g.beginPath(); g.moveTo(px, py);
    for (let j = 0; j < 4; j++) { px += (R(i * 7 + j) - 0.5) * w * 0.5; py += (R(i * 11 + j + 3) - 0.5) * h * 0.5; g.lineTo(Math.max(x, Math.min(x + w, px)), Math.max(y, Math.min(y + h, py))); }
    g.stroke();
  }
  g.restore();
  if (crackFlash > 0) { g.fillStyle = `rgba(255,255,255,${crackFlash * 0.5})`; g.fillRect(x, y, w, h); }
}

function drawPedestals(s, now) {
  const took = s.me?.took || [];
  const coins = s.coins ?? 0;
  for (const [, codeV, x, y, set, price, curse] of s.ped || []) {
    const info = pedInfo(codeV), fade = took.includes(set) && !price ? 0.35 : 1;
    const rc = curse ? '#ff3b5c' : RARITY[info.r] || RARITY[0];
    // rarity glow under the pedestal
    g.save(); g.globalAlpha = 0.4 * fade; g.fillStyle = rc; g.beginPath(); g.ellipse(x, y + 14, 27, 10, 0, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 0.95 * fade; g.strokeStyle = rc; g.lineWidth = info.r ? 3 : 2; g.stroke(); g.restore();
    tile(64, x - 20, y - 6, 40, false, fade);
    const bob = Math.sin(now / 300 + x) * 4;
    aura(x, y - 22 + bob, info.r === 2 ? 34 : 26, rc, (info.r === 2 ? 0.75 : 0.5) * fade);
    drawIcon(info, x - 18, y - 40 + bob, 36, fade);
  }
  // labels after the sprites so nothing covers them
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.direction = 'ltr';
  for (const [, , x, y, , price, curse] of s.ped || []) {
    if (price > 0) {
      const can = coins >= price;
      g.font = '800 14px Rubik, sans-serif';
      const tw = g.measureText(String(price)).width, bw = tw + 26;
      g.fillStyle = 'rgba(0,0,0,0.6)'; roundRect(x - bw / 2, y + 22, bw, 20, 10); g.fill();
      coinIcon(x - bw / 2 + 11, y + 32, 6.5);
      g.fillStyle = can ? '#ffe28a' : '#ff5d5d'; g.fillText(String(price), x + 9, y + 32.5);
    }
    if (curse) {
      g.font = '800 14px Rubik, sans-serif';
      g.fillStyle = 'rgba(40,0,8,0.7)'; roundRect(x - 26, y + (price > 0 ? 44 : 22), 52, 20, 10); g.fill();
      g.fillStyle = '#ff6b80'; g.fillText('−2 ❤', x, y + (price > 0 ? 54.5 : 32.5));
    }
  }
}
function coinIcon(x, y, r) {
  g.fillStyle = '#b8860b'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffd24d'; g.beginPath(); g.arc(x, y, r * 0.75, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff3b0'; g.fillRect(x - r * 0.15, y - r * 0.45, r * 0.3, r * 0.9);
}
function roundRect(x, y, w, h, r) { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); }

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
  const worldTf = () => g.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * (cw / 2 - view.x * view.s + sx), dpr * (ch / 2 - view.y * view.s + sy));
  worldTf();

  // rooms around the camera
  for (const r of layout.rooms) {
    if (Math.abs(r.x + CW / 2 - view.x) > halfW + CW || Math.abs(r.y + CH / 2 - view.y) > halfH + CH) continue;
    drawRoom(r, s.rs[r.id] || 0, now);
  }
  drawCrack(now);
  // stairs down
  if (s.td) {
    tile(9, s.td[0] - 30, s.td[1] - 30, 60);
    aura(s.td[0], s.td[1], 50 + Math.sin(now / 200) * 6, '#7df3ff', 0.5);
  }
  // chests
  for (const [, x, y, kind, opened] of s.ch || []) {
    if (kind) aura(x, y, opened ? 26 : 34 + Math.sin(now / 250) * 4, '#ffc531', opened ? 0.3 : 0.7);
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.beginPath(); g.ellipse(x, y + 15, 17, 6, 0, 0, Math.PI * 2); g.fill();
    tile(opened ? CHEST.open : kind ? CHEST.gold : CHEST.wood, x - 20, y - 22, 40, false, opened ? 0.8 : 1);
  }
  drawPedestals(s, now);
  // pickups
  for (const [, type, x, y] of s.u || []) {
    const bob = Math.sin(now / 250 + x) * 3;
    if (type === 'coin') { aura(x, y + bob, 16, '#ffd24d', 0.5); tile(56, x - 12, y - 12 + bob, 24); }
    else if (typeof type === 'string' && type.startsWith('w:')) { const w = WEAPONS[type.slice(2)]; aura(x, y + bob, 22, '#cfe3ff', 0.55); tileRot(w?.spr ?? 130, x, y + bob, 34, 0.6); }
    else { aura(x, y + bob, 18, '#ff6b8a', 0.5); tile(115, x - 14, y - 14 + bob, 28); }
  }
  // monsters
  for (const e of foes) {
    const d = ENEMIES[e.type] || { spr: 108, scale: 1 }, size = T * 1.15 * (d.scale || 1) * (e.elite ? 1.3 : 1);
    const wob = e.waking ? 0.35 + 0.35 * Math.sin(now / 60) : 1;
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.beginPath(); g.ellipse(e.x, e.y + size * 0.38, size * 0.35, size * 0.14, 0, 0, Math.PI * 2); g.fill();
    if (e.elite) aura(e.x, e.y, size * 0.75, '#ffc531', 0.75);
    if (d.boss && e.phase === 2) aura(e.x, e.y, size * 0.8, '#ff2a2a', 0.55 + 0.15 * Math.sin(now / 120));
    const hop = e.type === 'slime' || e.type === 'slimeking' ? Math.abs(Math.sin(now / 160 + e.id)) * 4 * (d.scale || 1) : 0;
    tile(d.spr, e.x - size / 2, e.y - size / 2 - hop, size, e.face < 0, wob);
    if (e.elite && !isRich()) { g.strokeStyle = '#ffc531'; g.lineWidth = 2.5; g.beginPath(); g.ellipse(e.x, e.y + size * 0.38, size * 0.42, size * 0.17, 0, 0, Math.PI * 2); g.stroke(); }
    if (e.warn) { // telegraph: red flash over the monster and a "!" above it
      const on = Math.floor(now / 90) % 2 === 0;
      if (on) { g.save(); g.globalAlpha = 0.45; g.fillStyle = '#ff2020'; g.beginPath(); g.arc(e.x, e.y, size * 0.48, 0, Math.PI * 2); g.fill(); g.restore(); }
      aura(e.x, e.y, size * 0.9, '#ff2020', on ? 0.9 : 0.4);
      const br = 11 + size * 0.06, by = e.y - size / 2 - br - 4;
      g.fillStyle = on ? '#ff2d2d' : '#ffd23d'; g.strokeStyle = '#000'; g.lineWidth = 3; g.beginPath(); g.arc(e.x, by, br, 0, Math.PI * 2); g.fill(); g.stroke();
      g.font = `900 ${Math.round(br * 1.6)}px Rubik, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = on ? '#fff' : '#000'; g.fillText('!', e.x, by + 1);
    }
    if (e.slow) aura(e.x, e.y, size * 0.5, '#8fd8ff', 0.45);
    if (!d.boss && e.hp < e.maxHp) { g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(e.x - 16, e.y - size / 2 - 8, 32, 4); g.fillStyle = e.elite ? '#ffc531' : '#ff5d5d'; g.fillRect(e.x - 16, e.y - size / 2 - 8, 32 * e.hp / e.maxHp, 4); }
  }
  // players
  for (const o of others) {
    if (!o.alive) { // a gravestone, with the revive ring filling while a friend stands next to it
      tile(65, o.x - 18, o.y - 18, 36, false, 0.8);
      g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,0.45)'; g.beginPath(); g.arc(o.x, o.y, 28, 0, Math.PI * 2); g.stroke();
      if (o.revive > 0) { g.strokeStyle = '#7dffa0'; g.beginPath(); g.arc(o.x, o.y, 28, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * o.revive); g.stroke(); aura(o.x, o.y, 40, '#7dffa0', 0.4 * o.revive); }
      continue;
    }
    const isMe = o.id === myId && me && !me.dead;
    const p = isMe ? { ...o, x: me.x, y: me.y, aim: input.a } : o;
    const h = hero(p.hero), size = T * 1.15, flip = Math.cos(p.aim) < 0;
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.beginPath(); g.ellipse(p.x, p.y + 18, 14, 6, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = h.color; g.lineWidth = 2.5; g.globalAlpha = 0.8; g.beginPath(); g.ellipse(p.x, p.y + 18, 17, 7, 0, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
    const bob = p.moving || (isMe && Math.hypot(input.mx, input.my) > 0.1) ? Math.abs(Math.sin(now / 90)) * 3 : 0;
    const blink = p.inv && !p.shield && Math.floor(now / 80) % 2 === 0 ? 0.35 : 1;
    // the weapon in hand: behind the hero when aiming up, in front otherwise
    const drawWeapon = () => {
      const w = WEAPONS[p.weapon]; if (!w) { aura(p.x + Math.cos(p.aim) * 24, p.y + Math.sin(p.aim) * 24, 9, h.color, 0.9); return; }
      let a = p.aim;
      const sw = swings.get(p.id), st = sw ? (now - sw.t0) / 180 : 1;
      if (st < 1) a = (w.kind === 'wave' ? p.aim : sw.a) + (w.kind === 'wave' ? -1.2 + 1.6 * st : -sw.arc + 2 * sw.arc * st);
      const dist = w.kind === 'melee' || w.kind === 'wave' ? 20 : 18;
      const hx = p.x + Math.cos(a) * dist, hy = p.y + 4 + Math.sin(a) * dist * 0.8 - bob;
      tileRot(w.spr, hx, hy, w.kind === 'shot' ? 24 : 28, a + Math.PI / 2, blink);
      if (w.kind === 'shot') aura(p.x + Math.cos(a) * 30, p.y + Math.sin(a) * 28, 8, h.color, 0.7);
    };
    if (Math.sin(p.aim) < -0.3) drawWeapon();
    tile(h.spr, p.x - size / 2, p.y - size / 2 - bob, size, flip, blink);
    if (Math.sin(p.aim) >= -0.3) drawWeapon();
    if (p.shield) { // knight's shield bubble
      const pulse = 1 + Math.sin(now / 90) * 0.05;
      g.save(); g.globalAlpha = 0.22; g.fillStyle = '#8fd8ff'; g.beginPath(); g.arc(p.x, p.y, 30 * pulse, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 0.85; g.strokeStyle = '#bfe9ff'; g.lineWidth = 2.5; g.stroke(); g.restore();
    }
    // orbiting orbs
    for (let i = 0; i < (p.orbit || 0); i++) {
      const a = (s.ot + (now - snaps[snaps.length - 1].at) / 1000) * 3 + (i / p.orbit) * Math.PI * 2;
      const ox = p.x + Math.cos(a) * 46, oy = p.y + Math.sin(a) * 46;
      aura(ox, oy, 16, '#8fd8ff', 1);
      if (!isRich()) { g.fillStyle = '#8fd8ff'; g.beginPath(); g.arc(ox, oy, 6, 0, Math.PI * 2); g.fill(); }
    }
  }
  // shots (extrapolated from the last snapshot)
  const age = (now - snaps[snaps.length - 1].at) / 1000;
  for (const [, x, y, vx, vy, r, enemy, owner, kind] of s.s || []) {
    const px = x + vx * age, py = y + vy * age, ang = Math.atan2(vy, vx);
    if (enemy) { aura(px, py, r * 2.6, '#ff6b3c', 0.9); g.fillStyle = '#ffd0a0'; g.beginPath(); g.arc(px, py, r * 0.6, 0, Math.PI * 2); g.fill(); if (!isRich()) { g.strokeStyle = '#ff6b3c'; g.lineWidth = 2; g.stroke(); } continue; }
    switch (kind) {
      case 1: { // fire
        aura(px - vx * 0.03, py - vy * 0.03, r * 2.6, '#ff3b1a', 0.7); aura(px, py, r * 3, '#ff9a3d', 0.95);
        g.fillStyle = '#ffd36b'; g.beginPath(); g.arc(px, py, r * 0.75, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff6d0'; g.beginPath(); g.arc(px, py, r * 0.4, 0, Math.PI * 2); g.fill();
        if (Math.random() < 0.5) particles.push({ x: px, y: py, vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40, life: 0.3, max: 0.3, color: '#ff8a3d', size: 4 });
        break;
      }
      case 2: // ice
        aura(px, py, r * 3, '#8fd8ff', 0.9);
        g.save(); g.translate(px, py); g.rotate(ang + now / 120); g.fillStyle = '#e8f8ff'; g.strokeStyle = '#5ab8ff'; g.lineWidth = 1.5;
        g.beginPath(); for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; g.lineTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9); g.lineTo(Math.cos(a + Math.PI / 4) * r * 0.35, Math.sin(a + Math.PI / 4) * r * 0.35); } g.closePath(); g.fill(); g.stroke(); g.restore();
        break;
      case 3: // dagger
        aura(px, py, r * 2, colorOf(owner), 0.5);
        tileRot(103, px, py, Math.max(20, r * 3.4), ang + Math.PI / 2);
        break;
      case 4: // spear / arrow
        aura(px - Math.cos(ang) * 8, py - Math.sin(ang) * 8, r * 2.2, colorOf(owner), 0.5);
        tileRot(WEAPONS.spear?.spr ?? 131, px, py, Math.max(24, r * 4), ang + Math.PI / 2);
        break;
      default: { const c = colorOf(owner); aura(px, py, r * 3, c, 0.9); g.fillStyle = isRich() ? '#fff' : c; g.beginPath(); g.arc(px, py, r * (isRich() ? 0.55 : 0.8), 0, Math.PI * 2); g.fill(); }
    }
  }
  // slashes and rings
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i], t = (now - f.t0) / f.dur;
    if (t >= 1) { fx.splice(i, 1); continue; }
    if (f.k === 'ring') {
      const rr = f.r * (0.3 + 0.7 * Math.sqrt(t));
      g.save(); g.globalAlpha = (1 - t) * 0.9; g.strokeStyle = f.color; g.lineWidth = f.width * (1 - t * 0.6);
      g.beginPath(); g.arc(f.x, f.y, rr, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = (1 - t) * 0.18; g.fillStyle = f.color; g.fill(); g.restore();
    } else if (f.k === 'bolt') { // chain lightning: a jagged line between the two monsters
      g.save(); g.globalAlpha = 1 - t; g.strokeStyle = '#bfe6ff'; g.lineWidth = 3; g.lineJoin = 'round'; g.beginPath(); g.moveTo(f.x, f.y);
      for (let j = 1; j < 6; j++) { const k = j / 6; g.lineTo(f.x + (f.x2 - f.x) * k + (Math.random() - 0.5) * 18, f.y + (f.y2 - f.y) * k + (Math.random() - 0.5) * 18); }
      g.lineTo(f.x2, f.y2); g.stroke(); g.lineWidth = 1.2; g.strokeStyle = '#fff'; g.stroke(); g.restore();
      aura(f.x2, f.y2, 22, '#8fd8ff', 0.8 * (1 - t));
    } else if (f.k === 'slash') {
      const followMe = f.id === myId && me && !me.dead, x = followMe ? me.x : f.x, y = followMe ? me.y : f.y;
      // slash_2 is an arc bulging to +x (thin, sword); slash_1 bulges to +y (thick, axe)
      const ti = f.arc > 1.4 ? 1 : 2, tex = isRich() ? slashTex(ti, f.color) : null;
      if (tex) {
        const sz = f.r * (1.5 + 0.25 * t), fwd = f.r * (0.45 + 0.15 * t) - (ti === 1 ? sz * 0.28 : 0);
        g.save(); g.globalAlpha = 1 - t * t; g.globalCompositeOperation = 'lighter'; g.translate(x, y); g.rotate(f.a - (ti === 1 ? Math.PI / 2 : 0));
        if (ti === 1) g.translate(0, fwd); else g.translate(fwd, 0);
        if (ti === 1) g.scale(Math.max(0.8, Math.min(1.5, f.arc / 1.7)), 1); else g.scale(1, Math.max(0.8, Math.min(1.5, f.arc / 1.1)));
        g.drawImage(tex, -sz / 2, -sz / 2, sz, sz); g.drawImage(tex, -sz / 2, -sz / 2, sz, sz); g.restore();
      } else { // vector arc sweeping across
        const from = f.a - f.arc, to = f.a - f.arc + 2 * f.arc * Math.min(1, t * 1.6);
        g.save(); g.globalAlpha = 1 - t; g.strokeStyle = f.color; g.lineCap = 'round';
        g.lineWidth = 10; g.beginPath(); g.arc(x, y, f.r * 0.8, from, to); g.stroke();
        g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(x, y, f.r * 0.8, from, to); g.stroke(); g.restore();
      }
    }
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
    for (const r of layout.rooms) if (!isHiddenRoom(r) && Math.abs(r.x + CW / 2 - view.x) < halfW + CW) {
      lights.push({ x: r.x + 3.5 * T, y: r.y + T, r: 150, a: 0.5 }, { x: r.x + (RW - 1.5) * T, y: r.y + T, r: 150, a: 0.5 });
      if (r.type === 'shop' || r.type === 'altar') lights.push({ x: r.x + CW / 2, y: r.y + CH / 2, r: 260, a: 0.6 });
    }
    if (s.td) lights.push({ x: s.td[0], y: s.td[1], r: 140, a: 0.6 });
    gfx.drawDarkness(g, { x: view.x, y: view.y, s: view.s }, cw, ch, dpr, null, lights);
  }
  // names, hearts and badges over players
  worldTf();
  g.textAlign = 'center'; g.textBaseline = 'bottom'; g.direction = 'ltr';
  for (const o of others) {
    if (!o.alive) continue;
    const isMe = o.id === myId, x = isMe && me ? me.x : o.x, y = isMe && me ? me.y : o.y;
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.7)';
    if (!isMe) {
      g.font = '600 12px Rubik, sans-serif';
      g.strokeText(nameOf(o.id), x, y - 30); g.fillStyle = hero(o.hero).color; g.fillText(nameOf(o.id), x, y - 30);
      g.font = '10px sans-serif'; g.fillStyle = '#fff'; g.fillText('❤️'.repeat(Math.max(0, Math.ceil(o.hp / 2))), x, y - 18);
    }
    if (o.god) { g.font = '900 10px Rubik, sans-serif'; g.strokeText('GOD', x, y - (isMe ? 26 : 44)); g.fillStyle = '#ffd23d'; g.fillText('GOD', x, y - (isMe ? 26 : 44)); }
  }
  for (const f of floaters) {
    g.globalAlpha = Math.min(1, f.life * 2); g.font = f.big ? '900 21px Rubik, sans-serif' : 'bold 15px Rubik, sans-serif';
    g.lineWidth = f.big ? 4 : 3; g.strokeStyle = 'rgba(0,0,0,.75)'; g.strokeText(f.text, f.x, f.y); g.fillStyle = f.color; g.fillText(f.text, f.x, f.y);
  }
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

const ROOM_ICON = { boss: '💀', treasure: '👑', shop: '🛒', altar: '🗿', challenge: '⚔️', secret: '❓' };
function drawMinimap(cw, rid) {
  const s = lastSnap, small = cw < 520, cell = small ? 13 : 16, w = small ? 10 : 12, h = small ? 7 : 8;
  const rooms = layout.rooms.filter(r => !isHiddenRoom(r));
  const xs = rooms.map(r => r.gx), ys = rooms.map(r => r.gy);
  const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs);
  const ox = cw - 12 - (maxX - minX + 1) * cell, oy = 56;
  for (const r of rooms) {
    const st = s.rs[r.id] || 0;
    const seen = st & 1 || Object.values(r.doors).some(d => d != null && (s.rs[d] & 1) && !isHiddenRoom(layout.rooms[d]));
    if (!seen) continue;
    const x = ox + (r.gx - minX) * cell, y = oy + (r.gy - minY) * cell;
    g.fillStyle = r.id === rid ? '#ffd27a' : st & 1 ? 'rgba(220,210,190,0.85)' : 'rgba(120,110,100,0.6)';
    g.fillRect(x, y, w, h);
    const ic = ROOM_ICON[r.type];
    if (ic) { g.font = `${small ? 8 : 9}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff'; g.fillText(ic, x + w / 2, y + h / 2); }
  }
}

// ---------- HUD ----------
let hudKey = '';
function renderHud() {
  if (!meta || meta.phase === 'lobby' || ui.screen !== 'room') { $hud.innerHTML = ''; hudKey = ''; return; }
  const s = lastSnap, row = myRow();
  const hearts = row ? Array.from({ length: Math.ceil(row[5] / 2) }, (_, i) => (row[4] >= (i + 1) * 2 ? '❤️' : row[4] === i * 2 + 1 ? '💔' : '🖤')).join('') : '';
  const boss = foes.find(e => ENEMIES[e.type]?.boss);
  const items = (s?.me?.items || []).filter(it => ITEMS[it]).map(it => `<span class="r${ITEMS[it].r || 0}" title="${esc(ITEMS[it].name)}">${itemIconHtml(ITEMS[it], 22)}</span>`).join('');
  const h = hero(row?.[11] ?? ui.hero), wk = s?.me?.w ?? row?.[14], w = WEAPONS[wk];
  const alive = row && row[6] && meta.phase === 'play';
  const abReady = row?.[15] ?? 1, ready = abReady >= 1, abLeft = s?.me?.ab?.cd ?? 0;
  const [abImg, abEmoji] = AB_ICON[h.ab] || ['gear', '✨'];
  const fine = matchMedia('(pointer: fine)').matches;
  const godOn = s?.me?.god || row?.[18];
  const html = `
    <div class="ar-top">
      <span class="dg-btns"><button class="ar-x" data-act="quit">✕</button> <button class="ar-x" data-act="sound">${sfxSettings.sound ? '🔊' : '🔇'}</button></span>
      <div class="ar-time">⬇️ ${s?.fl ?? 1}/3 · 🪙 ${s?.coins ?? 0}${s?.daily || meta.run?.daily ? ` · 🗓️ ${s?.score ?? 0}` : ''}</div>
      <div class="dg-hearts">${hearts}${godOn ? ' <b class="dg-god">GOD</b>' : ''}<small class="ar-ping">📶 ${Math.round(rtt)}</small></div>
    </div>
    <div class="dg-items">${w ? `<span class="dg-weapon" title="${esc(w.name)}">${tileIcon(w.spr, 22)}<small>${esc(w.name)}</small></span>` : ''}${items}</div>
    ${boss ? `<div class="dg-boss ${boss.phase === 2 ? 'p2' : ''}"><b>${esc(ENEMIES[boss.type].name)}${boss.phase === 2 ? ' 🔥' : ''}</b><div class="bar"><i style="width:${Math.max(0, boss.hp / boss.maxHp * 100)}%"></i></div></div>` : ''}
    ${banner ? `<div class="ar-announce ${banner.big ? 'mine' : 'small'}">${esc(banner.text)}</div>` : ''}
    ${ui.reconnecting ? '<div class="ar-msg warn">📡 מתחבר מחדש…</div>' : ''}
    ${alive ? `<button class="ar-dash ${localDash.cd > 0 ? 'cd' : ''}" data-act="dash">💨<small>${localDash.cd > 0 ? Math.ceil(localDash.cd) : (fine ? 'Shift' : '')}</small></button>` : ''}
    ${alive ? `<button class="dg-ab ${ready ? 'ready' : 'cd'}" data-act="ab" title="${esc(h.abName)}" style="--c:${h.color}">${uiImg(abImg, abEmoji)}<small>${ready ? (fine ? 'Q' : '') : Math.ceil(abLeft) || ''}</small></button>` : ''}
    ${meta.phase === 'end' ? endHtml() : ''}`;
  if (html !== hudKey) { $hud.innerHTML = html; hudKey = html; }
  const ab = $hud.querySelector('.dg-ab');
  if (ab) ab.style.setProperty('--p', String(Math.max(0, Math.min(1, abReady))));
}
function endHtml() {
  const r = meta.run || {}, won = r.result === 'won', isHost = meta.host === myId;
  const mm = Math.floor((r.t || 0) / 60), ss = String((r.t || 0) % 60).padStart(2, '0');
  const gemsLine = r.cheated ? '<p class="sub dg-cheat">⚙️ ריצה עם צ\'יטים – בלי אבני חן ובלי טבלה</p>'
    : endInfo?.gems ? `<p class="dg-gems">${uiImg('gem', '💎', 'sm')} +${endInfo.gems} אבני חן <small>(יש לך ${menus?.gems() ?? 0})</small></p>` : '';
  return `<div class="ar-end"><div class="panel">
    <h2>${won ? '🏆 ניצחתם את המבוך!' : '💀 הריצה נגמרה'}</h2>
    <p class="sub">${won ? 'השד האדום הובס – כל הכבוד!' : `הגעתם לקומה ${r.floor} מתוך 3`}${r.daily ? ' · 🗓️ ריצה יומית' : ''}</p>
    <div class="dg-score">ניקוד: <b>${r.score ?? 0}</b></div>
    <div class="dg-stats"><div>⏱️ ${mm}:${ss}</div><div>⚔️ ${r.kills ?? 0} מפלצות</div><div>🪙 ${r.coins ?? 0}</div></div>
    ${gemsLine}
    ${r.daily && endInfo?.board ? `<div class="dg-endboard">${endInfo.board}</div>` : ''}
    <div class="dg-endbtns">${r.daily ? '' : isHost ? '<button class="primary" data-act="start">🔁 ריצה חדשה</button>' : '<p class="sub">מחכים למארח/ת…</p>'}
    <button class="ghost" data-act="quit">יציאה</button></div>
  </div></div>`;
}

// ---------- screens ----------
function render() {
  const playing = ui.screen === 'room' && meta && meta.phase !== 'lobby';
  document.body.classList.toggle('ar-playing', !!playing);
  $game.hidden = !playing;
  if (playing) { $app.innerHTML = ''; ensureAdmin(); renderHud(); return; }
  $hud.innerHTML = ''; hudKey = '';
  if (ui.screen === 'home') return renderHome();
  if (ui.screen === 'connecting' || !meta) { $app.innerHTML = '<div class="panel center"><div class="spinner"></div><p>נכנסים למבוך…</p><button class="ghost" data-act="quit">ביטול</button></div>'; return; }
  renderLobby();
}
// hero choice: D's picker when it's loaded, otherwise a plain list of the free heroes
function heroPicker(selected) {
  if (menus) return menus.heroPickerHtml(selected);
  return `<div class="dg-heroes-fallback">${HEROES.map((h, i) => (h.unlock ? '' : `<button data-hero="${i}" class="${i === selected ? 'sel' : ''}">${tileIcon(h.spr, 32)}<span>${esc(h.name)}</span></button>`)).join('')}</div>`;
}
function bindPicker(el, onPick, onChange) {
  if (!el) return;
  if (menus) { menus.bindHeroPicker(el, { onPick, onChange }); return; }
  el.addEventListener('click', e => { const b = e.target.closest('[data-hero]'); if (b) onPick(Number(b.dataset.hero)); });
}
function pickHomeHero(i) { ui.hero = i; store.set('dungeon-hero', String(i)); renderHome(); }
function renderHome() {
  const best = Number(store.get('dungeon-best')) || 0;
  if (menus && !isUnlockedSafe(ui.hero)) ui.hero = 0;
  $app.innerHTML = `
    <div class="panel home">
      <a class="ar-back" href="./${debugOn ? '?debug=1' : ''}">→ לכל המשחקים</a>
      <h1>המבוך <span>🐉🗝️</span></h1>
      <p class="sub">ירדו 3 קומות במבוך שנבנה מחדש בכל פעם: מפלצות, חנויות, חדרים סודיים, אוצרות שמשדרגים אתכם, ובוס בסוף כל קומה. לבד או עם עד 3 חברים.</p>
      ${best ? `<p class="dg-best">${best >= 4 ? '🏆 כבר ניצחתם את המבוך!' : `🏅 השיא שלכם: קומה ${best}`}</p>` : ''}
      ${ui.error ? `<p class="err">${esc(ui.error)}</p>` : ''}
      <label>השם שלך<input id="name" maxlength="16" value="${esc(ui.name)}" placeholder="למשל: אורי"></label>
      <div class="dg-pick-title">בחרו גיבור/ה</div>
      <div id="heroPick" class="dg-pick">${heroPicker(ui.hero)}</div>
      ${ui.joinCode ? `<button class="primary" data-act="join">הצטרף לחדר ${esc(ui.joinCode)}</button><div class="or">או</div>` : ''}
      <button class="${ui.joinCode ? '' : 'primary'}" data-act="solo" ${ui.busy ? 'disabled' : ''}>⚔️ לשחק לבד</button>
      <button data-act="create" ${ui.busy ? 'disabled' : ''}>👥 חדר עם חברים</button>
      ${menus ? '' : `<button class="dg-daily-btn" data-act="daily" ${ui.busy ? 'disabled' : ''}>🗓️ הריצה היומית <small>אותו מבוך לכולם היום</small></button>`}
      <div class="or">או הצטרף עם קוד</div>
      <div class="row"><input id="code" maxlength="4" value="${esc(ui.joinCode)}" placeholder="קוד חדר" dir="ltr"><button data-act="join" ${ui.busy ? 'disabled' : ''}>הצטרף</button></div>
      <div id="dailyBoard" class="dg-board">${menus ? menus.dailyHtml(ui.dailyState || { loading: true }) : ''}</div>
      <details class="rules"><summary>איך משחקים?</summary><ul>
        <li><b>שליטה:</b> בטלפון – אגודל שמאל לזוז, אגודל ימין לכוון ולתקוף (נגיעה בלי לגרור תוקפת את המפלצת הקרובה). במחשב – WASD, עכבר ולחיצה. 💨 זינוק (Shift) מתחמק מפגיעות, ✨ כוח מיוחד (Q או הכפתור) לכל גיבור.</li>
        <li><b>גיבורים ונשק:</b> לכל גיבור כוח משלו ונשק פותח. נשקים על הרצפה מחליפים את מה שביד: חרב וגרזן מכים מקרוב, פטיש עושה גל הלם, שרביטים וחניתות יורים.</li>
        <li><b>חדרים:</b> הדלתות ננעלות עד שכל המפלצות מובסות. 👑 אוצר, 🛒 חנות (משלמים במטבעות של הצוות), 🗿 מזבח (פריט אגדי במחיר 2 לבבות), ⚔️ אתגר. קיר סדוק? ירו בו כמה פעמים…</li>
        <li><b>בוס 💀:</b> בסוף כל קומה. כשהוא מהבהב באדום – זוזו! בסוף הקומה השלישית מחכה השד האדום.</li>
        <li><b>חיים:</b> פגיעה מורידה חצי לב. מי שנופל חוזר כשחבר/ה עומד/ת לידו כמה שניות. אם כולם נופלים – מתחילים מחדש.</li>
        <li><b>אבני חן 💎:</b> כל ריצה נותנת אבני חן שפותחות גיבורים חדשים.</li>
      </ul></details>
      <button class="ghost gfx-toggle" data-act="gfx">🎨 גרפיקה: ${gfxMode() === 'rich' ? 'מלאה' : 'פשוטה (קלה לטלפון)'}</button>
      <p class="version">גרסה ${VERSION}</p>
    </div>`;
  bindPicker(document.getElementById('heroPick'), pickHomeHero, () => renderHome());
  if (menus && Date.now() - ui.dailyAt > 60000) {
    ui.dailyAt = Date.now();
    const show = st => { ui.dailyState = st; const el = document.getElementById('dailyBoard'); if (el && ui.screen === 'home') el.innerHTML = menus.dailyHtml(st); };
    menus.loadDaily(SERVER).then(show).catch(() => { show({ error: true }); ui.dailyAt = 0; });
  }
}
function isUnlockedSafe(i) { try { return !menus || menus.isUnlocked(i); } catch { return true; } }
function renderLobby() {
  const isHost = meta.host === myId, link = `${location.origin}${location.pathname}?room=${meta.code}`;
  const myHero = meta.players.find(p => p.id === myId)?.hero ?? ui.hero;
  $app.innerHTML = `
    <div class="panel lobby">
      <div class="lobby-game">🐉 המבוך</div>
      <p class="sub">קוד החדר</p>
      <div class="ar-code" dir="ltr">${esc(meta.code)}</div>
      <div class="ar-qr" id="qr"></div>
      <div class="row"><button data-act="share">📤 שיתוף קישור</button></div>
      <h3>הצוות (${meta.players.length}/${MAX_PLAYERS})</h3>
      <ul class="plist dg-team">${meta.players.map((p, i) => { const h = hero(p.hero ?? i); return `<li>${tileIcon(h.spr, 28)} ${esc(p.name)} <small style="color:${h.color}">(${esc(h.name)})</small>${p.id === meta.host ? ' 👑' : ''}${p.id === myId ? ' (את/ה)' : ''}</li>`; }).join('')}</ul>
      <div class="dg-pick-title">הגיבור/ה שלך</div>
      <div id="heroPick" class="dg-pick">${heroPicker(myHero)}</div>
      ${isHost ? '<button class="primary" data-act="start">⚔️ יוצאים לדרך!</button>' : '<p class="sub">מחכים שהמארח/ת יתחיל/תתחיל…</p>'}
      <button class="ghost" data-act="quit">יציאה</button>
    </div>`;
  bindPicker(document.getElementById('heroPick'), i => { ui.hero = i; store.set('dungeon-hero', String(i)); send({ t: 'hero', h: i }); play('pop'); }, () => renderLobby());
  const el = document.getElementById('qr');
  if (el && window.qrcode) { try { const q = window.qrcode(0, 'M'); q.addData(link); q.make(); el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch {} }
}

document.addEventListener('input', e => { if (e.target.id === 'name') ui.name = e.target.value.slice(0, 16); });
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  const nameOk = () => { const n = document.getElementById('name')?.value.trim() ?? ui.name; if (!n) { ui.error = 'צריך שם 🙂'; render(); return false; } ui.name = n.slice(0, 16); store.set('hathatul-name', ui.name); ui.error = ''; return true; };
  switch (act) {
    case 'solo': case 'create': case 'daily': {
      if (!nameOk()) return;
      ui.busy = true; render();
      try { const { code: c } = await api('/api/new'); ui.busy = false; connect(c, act !== 'create', act === 'daily'); }
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

// admin: snapshots only carry god, so the speed / dmg toggles are tracked here
let adminOpen = false;
const adminLocal = { speed: false, dmg: false };
function adminSend(m) { if (m?.c === 'speed' || m?.c === 'dmg') adminLocal[m.c] = !adminLocal[m.c]; send(m); }
// the admin's ⚙️ (D's panel brings its own round button at the left edge): created closed when a run starts
function ensureAdmin() {
  if (adminOpen || !menus || !isAdmin()) return;
  adminOpen = true;
  try {
    const api = menus.openAdminPanel({ send: adminSend, ITEMS, ITEM_LIST, WEAPONS, WEAPON_LIST, getState: () => ({ god: !!(lastSnap?.me?.god || myRow()?.[18]), speed: adminLocal.speed, dmg: adminLocal.dmg, coins: lastSnap?.coins ?? 0 }) });
    api?.close?.();
  } catch (e) { console.warn('admin panel', e); }
}
function closeAdmin() { if (adminOpen) { try { menus?.closeAdminPanel?.(); } catch {} } adminOpen = false; adminLocal.speed = adminLocal.dmg = false; }

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
  if (particles.length > 600) particles.splice(0, particles.length - 600);
  for (const f of floaters) { f.y -= 30 * dt; f.life -= dt; }
  for (let i = floaters.length - 1; i >= 0; i--) if (floaters[i].life <= 0) floaters.splice(i, 1);
  shake = Math.max(0, shake - dt * 40); hurtFlash = Math.max(0, hurtFlash - dt); crackFlash = Math.max(0, crackFlash - dt * 4);
  if (banner && (banner.life -= dt) <= 0) banner = null;
  drawWorld(now, dt);
  if (now - hudAt > 80) { hudAt = now; renderHud(); }
}
requestAnimationFrame(frame);
if (debugOn) window.__dg = { get snap() { return lastSnap; }, get layout() { return layout; }, get me() { return me; }, get meta() { return meta; }, send };
gfx.preload();
render();
