// המבוך – a room-by-room dungeon crawler (roguelite) for 1–4 players.
// This file is shared: the game server runs DungeonSim; the browser uses the same floor
// generator (same seed → same floor) and movement code to predict your own steps.
// No imports: the server bundles this file as is.

export const T = 40; // world units per tile
export const RW = 15, RH = 9; // room interior, in tiles
export const CW = (RW + 2) * T, CH = (RH + 2) * T; // a room cell including its walls (680 × 440)
export const PR = 14; // player radius
export const MAX_PLAYERS = 4;
export const TICK = 1 / 30;
export const FLOORS = 3;
export const DOOR = 80; // door opening width
export const DASH = { time: 0.16, speed: 3.2, cd: 2.5 };
export const INTERP_MS = 75;
export const REVIVE = { r: 45, time: 2.5 }; // stand this close to a downed friend for this long
export const CRACK_HITS = 4; // shots it takes to break the cracked wall of a secret room

// ---------- seeded random ----------
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// ---------- heroes ----------
// spr: tile in the sheet; ab: ability key; abCd: ability cooldown (s); weapon: starting weapon; unlock: gem price
export const HEROES = [
  { key: 'knight', name: 'אביר', spr: 97, color: '#ffd27a', ab: 'shield', abName: 'מגן', abCd: 9, weapon: 'sword', hp: 8, unlock: 0 },
  { key: 'wizard', name: 'קוסם', spr: 84, color: '#b07aff', ab: 'fireball', abName: 'כדור אש', abCd: 5, weapon: 'wand', hp: 6, unlock: 0 },
  { key: 'rogue', name: 'נוכלת', spr: 99, color: '#ff7aa8', ab: 'daggers', abName: 'מטר פגיונות', abCd: 6, weapon: 'daggers', hp: 6, unlock: 60 },
  { key: 'elf', name: 'שדונית', spr: 112, color: '#6fe08a', ab: 'volley', abName: 'מטח חיצים', abCd: 5, weapon: 'spear', hp: 6, unlock: 120 },
];

// ---------- weapons ----------
// kind 'shot': cd/dmg/life/size multipliers, speed, pierce, sk = shot kind sent to the client
// kind 'melee': arc = half angle (rad), r = reach; kind 'wave': shockwave of radius r around you
export const WEAPONS = {
  wand: { name: 'שרביט', spr: 129, kind: 'shot', cd: 1, dmg: 1, speed: 520, life: 1, pierce: 0, sk: 0 },
  ice: { name: 'מטה קרח', spr: 130, kind: 'shot', cd: 1.15, dmg: 1, speed: 430, life: 1.1, pierce: 0, freeze: 1, sk: 2 },
  daggers: { name: 'פגיונות', spr: 103, kind: 'shot', cd: 0.55, dmg: 0.6, speed: 600, life: 0.6, pierce: 0, sk: 3 },
  spear: { name: 'חנית', spr: 131, kind: 'shot', cd: 1.3, dmg: 1.3, speed: 700, life: 1, pierce: 3, sk: 4 },
  sword: { name: 'חרב', spr: 106, kind: 'melee', cd: 1.1, dmg: 2.2, arc: (65 * Math.PI) / 180, r: 75, parry: true },
  axe: { name: 'גרזן', spr: 118, kind: 'melee', cd: 1.6, dmg: 2.8, arc: (100 * Math.PI) / 180, r: 80 },
  hammer: { name: 'פטיש', spr: 117, kind: 'wave', cd: 1.9, dmg: 3, r: 110 },
};
export const WEAPON_LIST = Object.keys(WEAPONS);
export const CHEST_SPR = { wood: 89, gold: 90, open: 91, mimic: 92 };

// ---------- items (upgrades) ----------
// spr: tile index in the Tiny Dungeon sheet; icon (optional): game-night/dungeon/ui/<icon>.png; r: rarity 0 common, 1 rare, 2 legendary
export const ITEMS = {
  dmg: { name: 'חרב חדה', desc: '+30% נזק', spr: 104, r: 0 },
  rate: { name: 'שרביט מהיר', desc: 'יורה מהר יותר', spr: 130, r: 0 },
  multi: { name: 'מטה משולש', desc: '+1 קליע בכל ירייה (קשת רחבה לנשק קרב)', spr: 131, r: 1 },
  pierce: { name: 'פגיון רפאים', desc: 'קליעים עוברים דרך אויבים', spr: 103, r: 1 },
  bounce: { name: 'טבעת קפיצה', desc: 'קליעים קופצים מהקירות', spr: 101, r: 1 },
  homing: { name: 'טבעת ציד', desc: 'קליעים מחפשים מטרה', spr: 102, r: 1 },
  big: { name: 'שיקוי ענק', desc: 'קליעים גדולים וחזקים', spr: 116, r: 0 },
  speed: { name: 'שיקוי זריזות', desc: '+15% מהירות', spr: 114, r: 0 },
  heart: { name: 'שיקוי חיים', desc: '+1 לב (ומתמלא)', spr: 115, r: 0 },
  vamp: { name: 'בקבוקון דם', desc: 'סיכוי להחזיר לב בכל הריגה', spr: 127, r: 1 },
  freeze: { name: 'בקבוקון קרח', desc: 'קליעים מאטים אויבים', spr: 128, r: 1 },
  orbit: { name: 'מגן מסתובב', desc: 'כדור קסם מסתובב סביבך', spr: 66, r: 2 },
  range: { name: 'חנית ארוכה', desc: '+40% טווח', spr: 107, r: 0 },
  explode: { name: 'שרביט האש', desc: 'קליעים מתפוצצים', spr: 129, r: 2 },
  crit: { name: 'עין הנץ', desc: '15% סיכוי לפגיעה קריטית ×2.5', spr: 32, icon: 'eye', r: 1 },
  split: { name: 'פיצול', desc: 'קליע שפוגע מתפצל לשלושה', spr: 105, icon: 'split', r: 2 },
  chain: { name: 'שרשרת ברק', desc: 'כל פגיעה קופצת למפלצת נוספת', spr: 128, icon: 'high_voltage', r: 2 },
  magnet: { name: 'מגנט', desc: 'מטבעות ולבבות עפים אליך', spr: 102, icon: 'magnet', r: 1 },
  luck: { name: 'תלתן', desc: 'יותר מטבעות, תיבות ופריטים נדירים', spr: 114, icon: 'four_leaf_clover', r: 1 },
  phoenix: { name: 'נוצת עוף החול', desc: 'קם לתחייה פעם אחת עם לבבות מלאים', spr: 115, icon: 'feather', r: 2 },
  thorns: { name: 'שריון קוצים', desc: 'מפלצות שנוגעות בך נפגעות', spr: 101, icon: 'cactus', r: 2 },
};
export const ITEM_LIST = Object.keys(ITEMS);
export const RARITY_PRICE = [12, 20, 32];
export const SHOP_PRICE = { hp: 8, weapon: 18 };
export const baseStats = (maxHp = 6) => ({ dmg: 10, cd: 0.36, shots: 1, pierce: 0, bounce: 0, homing: 0, size: 6, speed: 210, life: 0.85, vamp: 0, freeze: 0, orbit: 0, explode: 0, maxHp, crit: 0, split: 0, chain: 0, magnet: 0, luck: 0, phoenix: 0, thorns: 0 });
export function applyItem(st, item) {
  switch (item) {
    case 'dmg': st.dmg *= 1.3; break;
    case 'rate': st.cd *= 0.8; break;
    case 'multi': st.shots += 1; break;
    case 'pierce': st.pierce += 1; break;
    case 'bounce': st.bounce += 1; break;
    case 'homing': st.homing += 1; break;
    case 'big': st.size *= 1.45; st.dmg *= 1.15; break;
    case 'speed': st.speed *= 1.15; break;
    case 'heart': st.maxHp = Math.max(st.maxHp, Math.min(12, st.maxHp + 2)); break;
    case 'vamp': st.vamp += 1; break;
    case 'freeze': st.freeze += 1; break;
    case 'orbit': st.orbit = Math.min(3, st.orbit + 1); break;
    case 'range': st.life *= 1.4; break;
    case 'explode': st.explode += 1; break;
    case 'crit': case 'split': case 'chain': case 'magnet': case 'luck': case 'phoenix': case 'thorns': st[item] += 1; break;
  }
}
export const SHOT_SPEED = 520;
// rarity roll: 60 / 32 / 8 %, each point of luck moves 4% + 4% from common to rare / legendary
export function rollRarity(luck = 0, min = 0, rnd = Math.random) {
  const leg = 0.08 + 0.04 * luck, rare = 0.32 + 0.04 * luck, u = rnd();
  return Math.max(min, u < leg ? 2 : u < leg + rare ? 1 : 0);
}

// ---------- monsters ----------
// spr: tile in the sheet; r: radius; hp; speed; scale: draw size in tiles
export const ENEMIES = {
  slime: { name: 'סליים', spr: 108, r: 14, hp: 30, speed: 70, scale: 1 },
  bat: { name: 'עטלף', spr: 120, r: 12, hp: 18, speed: 150, scale: 1 },
  spider: { name: 'עכביש', spr: 122, r: 14, hp: 26, speed: 0, scale: 1 },
  skeleton: { name: 'שלד קשת', spr: 87, r: 14, hp: 30, speed: 80, scale: 1 },
  ghost: { name: 'רוח', spr: 121, r: 14, hp: 32, speed: 65, scale: 1, flies: true },
  demon: { name: 'שד', spr: 110, r: 15, hp: 46, speed: 55, scale: 1 },
  // bosses (one per floor)
  slimeking: { name: 'מלך הסליים', spr: 108, r: 40, hp: 520, speed: 50, scale: 3, boss: true },
  cyclops: { name: 'הקיקלופ', spr: 109, r: 40, hp: 820, speed: 60, scale: 3, boss: true },
  archdemon: { name: 'השד האדום', spr: 110, r: 42, hp: 1150, speed: 45, scale: 3.2, boss: true },
  // a chest with teeth
  mimic: { name: 'מימיק', spr: 92, r: 16, hp: 120, speed: 95, scale: 1.2 },
};
export const ENEMY_LIST = Object.keys(ENEMIES);
const BOSS_OF = ['slimeking', 'cyclops', 'archdemon'];
const POOL = [['slime', 'slime', 'bat', 'spider'], ['slime', 'bat', 'spider', 'skeleton', 'ghost'], ['bat', 'spider', 'skeleton', 'ghost', 'demon', 'demon']];

// ---------- floor generation ----------
// Obstacle layouts in room tiles [tx, ty, tw, th]; the lanes to the four doors stay clear.
const LAYOUTS = [
  [],
  [[3, 2, 1, 1], [11, 2, 1, 1], [3, 6, 1, 1], [11, 6, 1, 1]],
  [[6, 3, 3, 3]],
  [[3, 2, 1, 5], [11, 2, 1, 5]],
  [[2, 2, 1, 1], [5, 6, 1, 1], [9, 2, 1, 1], [12, 6, 1, 1], [7, 4, 1, 1]],
  [[3, 2, 4, 1], [8, 6, 4, 1]],
  [[2, 1, 2, 1], [2, 1, 1, 2], [11, 1, 2, 1], [12, 1, 1, 2], [2, 7, 2, 1], [2, 6, 1, 2], [11, 7, 2, 1], [12, 6, 1, 2]],
  [[7, 2, 1, 2], [7, 5, 1, 2], [4, 4, 2, 1], [9, 4, 2, 1]],
  [[4, 2, 2, 2], [9, 5, 2, 2]],
];
const DIRS = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };
const OPP = { n: 's', s: 'n', e: 'w', w: 'e' };
// the opening of room r toward direction d (both wall layers), as a rect
function plugRect(r, d) {
  const cx = r.x + CW / 2, cy = r.y + CH / 2;
  if (d === 'n') return [cx - DOOR / 2, r.y - T, DOOR, 2 * T];
  if (d === 's') return [cx - DOOR / 2, r.y + CH - T, DOOR, 2 * T];
  if (d === 'w') return [r.x - T, cy - DOOR / 2, 2 * T, DOOR];
  return [r.x + CW - T, cy - DOOR / 2, 2 * T, DOOR];
}

// Everything here depends on (seed, floor) only: the client regenerates the very same floor.
export function genFloor(seed, floor) {
  const R = rng(seed * 31 + floor * 7919 + 17);
  const want = 7 + floor * 2;
  const G = 9, key = (x, y) => y * G + x;
  const cells = new Map([[key(4, 4), { gx: 4, gy: 4 }]]);
  const nb = (x, y) => Object.values(DIRS).filter(([dx, dy]) => cells.has(key(x + dx, y + dy))).length;
  const isStart = c => c.gx === 4 && c.gy === 4;
  for (let guard = 0; cells.size < want && guard < 5000; guard++) {
    const list = [...cells.values()];
    const c = list[Math.floor(R() * list.length)];
    const [dx, dy] = Object.values(DIRS)[Math.floor(R() * 4)];
    const nx = c.gx + dx, ny = c.gy + dy;
    if (nx < 1 || ny < 1 || nx >= G - 1 || ny >= G - 1 || cells.has(key(nx, ny))) continue;
    if (nb(nx, ny) > 1 && R() < 0.85) continue; // keep it branchy, few loops
    cells.set(key(nx, ny), { gx: nx, gy: ny });
  }
  // special rooms sit on dead ends: grow extra leaves until there are enough
  const wantAltar = R() < 0.5, wantChal = floor >= 2 || R() < 0.4;
  const need = 3 + (wantAltar ? 1 : 0) + (wantChal ? 1 : 0); // boss, treasure, shop (+ altar, challenge)
  const endCount = () => [...cells.values()].filter(c => !isStart(c) && nb(c.gx, c.gy) === 1).length;
  for (let guard = 0; endCount() < need && guard < 3000; guard++) {
    // prefer branching off a corridor (+1 dead end); sometimes extend a dead end (unblocks tight clusters)
    const all = [...cells.values()], list = guard % 4 === 3 ? all : all.filter(c => isStart(c) || nb(c.gx, c.gy) !== 1);
    const c = list[Math.floor(R() * list.length)];
    const [dx, dy] = Object.values(DIRS)[Math.floor(R() * 4)];
    const nx = c.gx + dx, ny = c.gy + dy;
    if (nx < 0 || ny < 0 || nx >= G || ny >= G || cells.has(key(nx, ny)) || nb(nx, ny) !== 1) continue;
    cells.set(key(nx, ny), { gx: nx, gy: ny });
  }
  const rooms = [...cells.values()].map((c, id) => ({ id, gx: c.gx, gy: c.gy, x: c.gx * CW, y: c.gy * CH, type: 'normal', doors: {} }));
  const at = new Map(rooms.map(r => [key(r.gx, r.gy), r]));
  for (const r of rooms) for (const [d, [dx, dy]] of Object.entries(DIRS)) { const o = at.get(key(r.gx + dx, r.gy + dy)); r.doors[d] = o ? o.id : null; }
  // distances from the start
  const start = at.get(key(4, 4));
  start.type = 'start';
  const dist = new Map([[start.id, 0]]), q = [start];
  while (q.length) { const r = q.shift(); for (const o of Object.values(r.doors)) if (o != null && !dist.has(o)) { dist.set(o, dist.get(r.id) + 1); q.push(rooms[o]); } }
  const ends = rooms.filter(r => r !== start && Object.values(r.doors).filter(v => v != null).length === 1).sort((a, b) => dist.get(b.id) - dist.get(a.id));
  const far = rooms.filter(r => r !== start).sort((a, b) => dist.get(b.id) - dist.get(a.id));
  const boss = ends[0] || far[0];
  boss.type = 'boss';
  const pool = ends.filter(r => r !== boss);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const specials = ['treasure', 'shop'].concat(wantAltar ? ['altar'] : [], wantChal ? ['challenge'] : []);
  for (const type of specials) {
    const r = pool.shift() || far.find(o => o.type === 'normal');
    if (r) r.type = type;
  }
  // secret room: an empty cell next to a normal room (or the start), joined by a cracked wall
  let secret = null;
  const cand = [];
  for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
    if (at.has(key(gx, gy))) continue;
    for (const [d, [dx, dy]] of Object.entries(DIRS)) {
      const o = at.get(key(gx + dx, gy + dy));
      if (o && (o.type === 'normal' || o.type === 'start')) cand.push([gx, gy, o, OPP[d]]);
    }
  }
  if (cand.length) {
    const [gx, gy, from, dir] = cand[Math.floor(R() * cand.length)];
    const sr = { id: rooms.length, gx, gy, x: gx * CW, y: gy * CH, type: 'secret', hidden: true, doors: { n: null, e: null, s: null, w: null } };
    rooms.push(sr); at.set(key(gx, gy), sr);
    secret = { room: sr.id, from: from.id, dir, rect: plugRect(from, dir) };
  }
  // obstacles
  for (const r of rooms) {
    const lay = r.type === 'normal' || r.type === 'challenge' ? LAYOUTS[1 + Math.floor(R() * (LAYOUTS.length - 1))] : r.type === 'treasure' ? LAYOUTS[1] : [];
    r.obstacles = lay.map(([tx, ty, tw, th]) => [r.x + T + tx * T, r.y + T + ty * T, tw * T, th * T]);
    r.boss = r.type === 'boss' ? BOSS_OF[Math.min(floor - 1, BOSS_OF.length - 1)] : null;
  }
  // walls: four sides per room, with a gap where a door (or the cracked wall) is
  const gap = (r, d) => r.doors[d] != null || (secret && ((r.id === secret.from && d === secret.dir) || (r.id === secret.room && d === OPP[secret.dir])));
  const walls = [];
  for (const r of rooms) {
    const cx = r.x + CW / 2, cy = r.y + CH / 2;
    const hw = (y, d) => !gap(r, d) ? walls.push([r.x, y, CW, T]) : walls.push([r.x, y, cx - DOOR / 2 - r.x, T], [cx + DOOR / 2, y, r.x + CW - cx - DOOR / 2, T]);
    const vw = (x, d) => !gap(r, d) ? walls.push([x, r.y, T, CH]) : walls.push([x, r.y, T, cy - DOOR / 2 - r.y], [x, cy + DOOR / 2, T, r.y + CH - cy - DOOR / 2]);
    hw(r.y, 'n'); hw(r.y + CH - T, 's'); vw(r.x, 'w'); vw(r.x + CW - T, 'e');
  }
  // door plugs: closing a room fills its door openings (both wall layers)
  for (const r of rooms) r.plugs = Object.keys(DIRS).filter(d => r.doors[d] != null).map(d => plugRect(r, d));
  const grid = new Map(rooms.map(r => [key(r.gx, r.gy), r.id]));
  return { floor, rooms, walls, start: start.id, grid, G, secret };
}

export const roomAt = (layout, x, y) => layout.grid.get(Math.floor(y / CH) * layout.G + Math.floor(x / CW)) ?? null;
export const interior = r => [r.x + T, r.y + T, RW * T, RH * T];

// every solid rectangle right now: walls, obstacles, the doors of locked rooms, and the cracked wall
// (solid until broken; once open it closes again while the room in front of it is locked)
export function solids(layout, locked, secretOpen = false) {
  const out = layout.walls.slice();
  for (const r of layout.rooms) {
    out.push(...r.obstacles);
    if (locked[r.id]) out.push(...r.plugs);
  }
  const s = layout.secret;
  if (s && (!secretOpen || locked[s.from])) out.push(s.rect);
  return out;
}

// ---------- movement (same model as the arena) ----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
export function collide(p, rects, r = PR) {
  for (const [x, y, w, h] of rects) {
    if (p.x + r < x || p.x - r > x + w || p.y + r < y || p.y - r > y + h) continue;
    const cx = clamp(p.x, x, x + w), cy = clamp(p.y, y, y + h);
    const dx = p.x - cx, dy = p.y - cy, d2 = dx * dx + dy * dy;
    if (d2 >= r * r) continue;
    if (d2 > 1e-6) { const d = Math.sqrt(d2); p.x = cx + (dx / d) * r; p.y = cy + (dy / d) * r; }
    else {
      const o = [[p.x - x + r, -1, 0], [x + w - p.x + r, 1, 0], [p.y - y + r, 0, -1], [y + h - p.y + r, 0, 1]].sort((a, b) => a[0] - b[0])[0];
      p.x += o[1] * o[0]; p.y += o[2] * o[0];
    }
  }
}
export const ACCEL = 28;
export function move(p, input, dt, rects, speed, instant = false, r = PR) {
  let mx = input.mx || 0, my = input.my || 0;
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  const k = instant ? 1 : 1 - Math.exp(-ACCEL * dt);
  p.vx = (p.vx || 0) + (mx * speed - (p.vx || 0)) * k;
  p.vy = (p.vy || 0) + (my * speed - (p.vy || 0)) * k;
  const x0 = p.x, y0 = p.y, ex = x0 + p.vx * dt, ey = y0 + p.vy * dt;
  p.x = ex; p.y = ey;
  collide(p, rects, r);
  if (dt > 0 && (Math.abs(p.x - ex) > 0.01 || Math.abs(p.y - ey) > 0.01)) { p.vx = (p.x - x0) / dt; p.vy = (p.y - y0) / dt; }
}
export const inRect = (x, y, [rx, ry, rw, rh], pad = 0) => x > rx - pad && x < rx + rw + pad && y > ry - pad && y < ry + rh + pad;
export const hitsSolid = (x, y, rects, pad = 0) => rects.some(r => inRect(x, y, r, pad));
export function blocked(ax, ay, bx, by, rects) {
  const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / 14);
  for (let i = 1; i < steps; i++) { const t = i / steps; if (hitsSolid(ax + (bx - ax) * t, ay + (by - ay) * t, rects)) return true; }
  return false;
}
// nearest point of a rect to (x, y)
const nearestOn = (x, y, [rx, ry, rw, rh]) => [clamp(x, rx, rx + rw), clamp(y, ry, ry + rh)];

// ---------- the game ----------
export class DungeonSim {
  constructor(players, seed, emit, opts = {}) {
    this.seed = seed;
    this.emit = emit || (() => {});
    this.daily = !!opts.daily;
    this.cheated = false;
    this.t = 0;
    this.seq = 0;
    this.phase = 'play'; // play | won | lost
    this.players = new Map(players.map((p, i) => [p.id, this.newPlayer(p, i)]));
    this.coins = 0;
    this.kills = 0;
    this.startFloor(1);
  }

  newPlayer(p, i) {
    const hero = Number.isInteger(p.hero) && p.hero >= 0 && p.hero < HEROES.length ? p.hero : i % HEROES.length;
    const H = HEROES[hero], st = baseStats(H.hp);
    return {
      id: p.id, name: p.name, hero, weapon: H.weapon, x: 0, y: 0, vx: 0, vy: 0, aim: 0, fire: false, hp: st.maxHp, st, items: [], alive: true, inv: 0, cd: 0,
      dashT: 0, dashCd: 0, dashDir: null, budget: 0, lastSeq: 0, kills: 0, input: { a: 0, f: false },
      abCd: 0, shieldT: 0, revive: 0, god: false, spdMul: 1, dmgMul: 1, wGuard: null, nocashT: 0,
    };
  }

  startFloor(n) {
    this.floor = n;
    this.layout = genFloor(this.seed, n);
    const fights = new Set(['normal', 'boss', 'challenge']);
    this.rooms = this.layout.rooms.map(r => ({ visited: r.type === 'start', cleared: !fights.has(r.type), locked: false, wave: 0, mimic: false }));
    this.enemies = [];
    this.shots = [];
    this.pickups = [];
    this.pedestals = [];
    this.chests = [];
    this.trapdoor = null;
    this.secretOpen = false;
    this.crackHits = 0;
    this.rebuild();
    const s = this.layout.rooms[this.layout.start];
    let i = 0;
    for (const p of this.players.values()) {
      p.x = s.x + CW / 2 + (i % 2 ? 40 : -40) * Math.ceil(i / 2); p.y = s.y + CH / 2 + (i > 1 ? 40 : 0); i++;
      p.vx = p.vy = 0; p.dashT = 0; p.revive = 0; p.wGuard = null;
      if (!p.alive) { p.alive = true; p.hp = Math.min(2, p.st.maxHp); p.inv = this.t + 1.5; }
    }
    const L = this.layout, luck = this.luck(), centre = r => [r.x + CW / 2, r.y + CH / 2];
    for (const r of L.rooms) {
      const [cx, cy] = centre(r);
      if (r.type === 'treasure') this.offerItems(cx, cy, 3); // three items to choose from (one per player)
      else if (r.type === 'shop') this.stockShop(cx, cy, luck);
      else if (r.type === 'altar') this.offerItems(cx, cy, 1, { rarity: 2, curse: 1 });
      else if (r.type === 'secret') {
        this.addChest(cx, cy, 1);
        for (let k = 0; k < 5; k++) this.drop('coin', cx + Math.cos(k * 1.26) * 70, cy + Math.sin(k * 1.26) * 50);
      }
    }
    this.emit({ k: 'floor', n });
  }

  // shop: 2 items, a full heart refill and a weapon; touching a pedestal with enough team coins buys it
  stockShop(cx, cy, luck) {
    const codes = [];
    for (let k = 0; k < 2; k++) {
      const r = rollRarity(luck);
      const c = this.pickItem(r, codes);
      codes.push(c);
    }
    const ws = WEAPON_LIST.filter(w => w !== 'wand' && ![...this.players.values()].every(p => p.weapon === w));
    codes.push('hp', 'w:' + ws[Math.floor(Math.random() * ws.length)]);
    codes.forEach((code, i) => {
      const [px, py] = this.freeSpot(cx + (i - 1.5) * 120, cy + 30, 26);
      const price = code === 'hp' ? SHOP_PRICE.hp : code.startsWith('w:') ? SHOP_PRICE.weapon : RARITY_PRICE[ITEMS[code].r];
      this.pedestals.push({ id: ++this.seq, set: ++this.seq, item: code, x: px, y: py, takenBy: [], price, curse: 0 });
    });
  }

  rebuild() { this.solid = solids(this.layout, this.rooms.map(r => r.locked), this.secretOpen); this.solidSeq = (this.solidSeq || 0) + 1; }
  alivePlayers() { return [...this.players.values()].filter(p => p.alive); }
  scale() { return (1 + 0.3 * (this.floor - 1)) * (1 + 0.45 * (this.players.size - 1)); }
  luck() { let n = 0; for (const p of this.players.values()) n += p.st.luck || 0; return n; }
  score() { return this.floor * 1000 + this.kills * 5 + this.coins + (this.phase === 'won' ? 3000 : 0); }
  crackRect() { return this.layout.secret && !this.secretOpen ? this.layout.secret.rect : null; }

  // nearest spot to (x, y) inside the same room that isn't inside a rock or wall (drops must be reachable)
  freeSpot(x, y, pad = 22) {
    const id = roomAt(this.layout, x, y), box = id != null ? interior(this.layout.rooms[id]) : null;
    const ok = (nx, ny) => !hitsSolid(nx, ny, this.solid, pad) && (!box || inRect(nx, ny, box, -pad));
    if (box) { x = clamp(x, box[0] + pad + 1, box[0] + box[2] - pad - 1); y = clamp(y, box[1] + pad + 1, box[1] + box[3] - pad - 1); }
    if (ok(x, y)) return [x, y];
    for (let d = 20; d < 400; d += 20) for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2, nx = x + Math.cos(a) * d, ny = y + Math.sin(a) * d;
      if (ok(nx, ny)) return [nx, ny];
    }
    return [x, y];
  }
  drop(type, x, y) { const [fx, fy] = this.freeSpot(x, y, 16); const u = { id: ++this.seq, type, x: fx, y: fy }; this.pickups.push(u); return u; }
  addChest(x, y, kind, mimic = false) { const [fx, fy] = this.freeSpot(x, y, 24); this.chests.push({ id: ++this.seq, x: fx, y: fy, kind, open: false, mimic }); }

  pickItem(r, not = []) {
    let c = ITEM_LIST.filter(k => ITEMS[k].r === r && !not.includes(k));
    if (!c.length) c = ITEM_LIST.filter(k => !not.includes(k));
    return c[Math.floor(Math.random() * c.length)];
  }
  // o: { rarity (fixed), rmin, curse }
  offerItems(x, y, n, o = {}) {
    const luck = this.luck(), picked = [];
    for (let i = 0; i < n; i++) picked.push(this.pickItem(o.rarity ?? rollRarity(luck, o.rmin || 0), picked));
    const set = ++this.seq;
    picked.forEach((item, i) => { const [px, py] = this.freeSpot(x + (i - (n - 1) / 2) * 110, y, 26); this.pedestals.push({ id: ++this.seq, set, item, x: px, y: py, takenBy: [], price: 0, curse: o.curse || 0 }); });
  }

  // ---------- input ----------
  applyCmd(p, c) {
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || c[0] <= p.lastSeq) return;
    p.lastSeq = c[0];
    if (this.phase !== 'play' || !p.alive) return;
    let mx = Number(c[1]) || 0, my = Number(c[2]) || 0;
    const l = Math.hypot(mx, my);
    if (l > 1) { mx /= l; my /= l; }
    const dt = Math.min(Math.max(0, Number(c[3]) || 0), 0.1, p.budget);
    p.budget -= dt;
    if (dt <= 0) return;
    if (c[4] && p.dashCd <= 0) {
      const a = l > 0.2 ? Math.atan2(my, mx) : (Number.isFinite(p.input.a) ? p.input.a : p.aim);
      p.dashDir = { mx: Math.cos(a), my: Math.sin(a) }; p.dashT = DASH.time; p.dashCd = DASH.cd;
      p.inv = Math.max(p.inv, this.t + DASH.time + 0.05); // dodge through shots
      this.emit({ k: 'dash', id: p.id, x: p.x, y: p.y });
    }
    if (p.dashT > 0) { move(p, p.dashDir, dt, this.solid, p.st.speed * DASH.speed, true); p.dashT -= dt; }
    else move(p, { mx, my }, dt, this.solid, p.st.speed);
  }

  // hero ability (server calls this once per press); returns true when it fired
  useAbility(p) {
    if (!p || this.phase !== 'play' || !p.alive || p.abCd > 0) return false;
    const H = HEROES[p.hero] || HEROES[0], st = p.st, a = p.aim;
    p.abCd = H.abCd;
    this.emit({ k: 'ab', id: p.id, hero: p.hero, x: p.x, y: p.y, a });
    if (H.ab === 'shield') {
      p.shieldT = this.t + 2; p.inv = Math.max(p.inv, this.t + 2);
      const R = 100;
      this.shots = this.shots.filter(s => {
        if (!s.enemy || Math.hypot(s.x - p.x, s.y - p.y) > R) return true;
        this.emit({ k: 'block', x: s.x, y: s.y }); return false;
      });
      for (const e of this.enemies.slice()) {
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        if (d > R + e.r || this.t < e.wake) continue;
        this.knock(e, Math.atan2(e.y - p.y, e.x - p.x), 70);
        this.damageEnemy(e, 3 * st.dmg, p.id);
      }
    } else if (H.ab === 'fireball') {
      this.addShot(p, a, { sp: 300, life: 1.6, dmg: 4 * st.dmg, r: 16, pierce: 0, bounce: 0, homing: 0, freeze: 0, explode: 0, fb: true, kind: 1 });
    } else if (H.ab === 'daggers') {
      for (let k = 0; k < 12; k++) this.addShot(p, a + (k / 12) * Math.PI * 2, { sp: 480, life: 0.6, dmg: st.dmg, r: 6, pierce: st.pierce, bounce: 0, homing: 0, freeze: st.freeze, explode: 0, kind: 3 });
    } else if (H.ab === 'volley') {
      const fan = (40 * Math.PI) / 180;
      for (let k = 0; k < 7; k++) this.addShot(p, a + (k / 6 - 0.5) * fan, { sp: 650, life: 0.9 * (st.life / 0.85), dmg: st.dmg * 1.3, r: 6, pierce: 2 + st.pierce, bounce: 0, homing: 0, freeze: st.freeze, explode: 0, kind: 4 });
    }
    return true;
  }

  // ---------- admin (the server checked the name) ----------
  admin(p, cmd, val) {
    if (!p) return false;
    const L = this.layout;
    switch (cmd) {
      case 'god': p.god = !p.god; break;
      case 'coins': this.coins = Math.max(0, Math.floor(Number(val) || 0)); break;
      case 'addcoins': this.coins = Math.max(0, this.coins + Math.floor(Number(val) || 0)); break;
      case 'heal': if (!p.alive) this.reviveP(p, p.st.maxHp); p.hp = p.st.maxHp; break;
      case 'maxhp': p.st.maxHp = Math.min(20, p.st.maxHp + 2); p.hp = Math.min(p.st.maxHp, p.hp + 2); break;
      case 'item': if (!ITEMS[val]) return false; this.addItem(p, val); this.emit({ k: 'item', id: p.id, item: val, x: p.x, y: p.y }); break;
      case 'weapon': if (!WEAPONS[val]) return false; p.weapon = val; this.emit({ k: 'weapon', id: p.id, w: val, x: p.x, y: p.y }); break;
      case 'killroom': {
        const id = roomAt(L, p.x, p.y);
        for (const e of this.enemies.slice()) if (e.room === id && e.hp > 0) { e.wake = Math.min(e.wake, this.t); this.damageEnemy(e, e.hp + 1, p.id); }
        break;
      }
      case 'nextfloor':
        if (this.phase !== 'play') return false;
        if (this.floor >= FLOORS) { this.phase = 'won'; this.emit({ k: 'won' }); } else this.startFloor(this.floor + 1);
        break;
      case 'reveal': this.rooms.forEach(r => { r.visited = true; }); if (L.secret && !this.secretOpen) { this.secretOpen = true; this.rebuild(); } break;
      case 'speed': if (p.spdMul === 1) { p.spdMul = 2; p.st.speed *= 2; } else { p.spdMul = 1; p.st.speed /= 2; } break;
      case 'dmg': if (p.dmgMul === 1) { p.dmgMul = 5; p.st.dmg *= 5; } else { p.dmgMul = 1; p.st.dmg /= 5; } break;
      case 'reviveall': for (const o of this.players.values()) if (!o.alive) { this.reviveP(o, Math.min(2, o.st.maxHp)); o.x = p.x + 30; o.y = p.y; collide(o, this.solid); } break;
      default: return false;
    }
    this.cheated = true;
    this.emit({ k: 'admin', c: cmd });
    return true;
  }

  // ---------- simulation ----------
  tick() {
    if (this.phase !== 'play') return;
    const dt = TICK;
    this.t += dt;
    for (const p of this.players.values()) {
      p.budget = Math.min(0.3, p.budget + dt);
      p.dashCd -= dt;
      p.abCd = Math.max(0, p.abCd - dt);
      if (!p.alive) continue;
      if (Number.isFinite(p.input.a)) p.aim = p.input.a;
      this.roomCheck(p);
      p.cd -= dt;
      if (p.input.f && p.cd <= 0) this.fire(p);
    }
    this.stepPickups(dt);
    for (const p of this.players.values()) if (p.alive) this.touchPickups(p);
    this.stepEnemies(dt);
    this.stepShots(dt);
    this.stepOrbits();
    this.stepRevive(dt);
    // rooms: clear when their monsters are gone
    const alive = this.alivePlayers();
    this.rooms.forEach((rs, id) => {
      if (!rs.locked) return;
      // nobody alive left inside but friends outside: open it so they can come in (and revive)
      if (alive.length && !alive.some(p => roomAt(this.layout, p.x, p.y) === id)) { rs.locked = false; rs.mimic = false; this.rebuild(); return; }
      if (this.enemies.some(e => e.room === id)) return;
      if (rs.mimic) { rs.mimic = false; rs.locked = false; this.rebuild(); this.emit({ k: 'clear', room: id }); return; }
      if (this.layout.rooms[id].type === 'challenge' && rs.wave === 1) { rs.wave = 2; this.spawnRoom(id, 2); this.emit({ k: 'cwave', room: id, n: 2 }); return; }
      rs.locked = false; rs.cleared = true;
      this.rebuild();
      this.onClear(id);
    });
    // everyone down → the run is over
    if (this.phase === 'play' && !this.alivePlayers().length) { this.phase = 'lost'; this.emit({ k: 'lost' }); }
    // stairs: everyone alive standing on them goes down
    if (this.phase === 'play' && this.trapdoor) {
      const ps = this.alivePlayers();
      const on = ps.filter(p => Math.hypot(p.x - this.trapdoor.x, p.y - this.trapdoor.y) < 34);
      if (ps.length && on.length === ps.length) {
        if (this.floor >= FLOORS) { this.phase = 'won'; this.emit({ k: 'won' }); }
        else { this.emit({ k: 'stairs' }); this.startFloor(this.floor + 1); }
      }
    }
  }

  // a downed player gets up when a living friend stands next to them for a while
  stepRevive(dt) {
    const alive = this.alivePlayers();
    for (const p of this.players.values()) {
      if (p.alive) { p.revive = 0; continue; }
      const near = alive.some(o => Math.hypot(o.x - p.x, o.y - p.y) < REVIVE.r);
      p.revive = clamp(p.revive + (near ? dt : -dt) / REVIVE.time, 0, 1);
      if (p.revive >= 1) { this.reviveP(p, Math.min(2, p.st.maxHp)); collide(p, this.solid); }
    }
  }
  reviveP(p, hp) { p.alive = true; p.hp = hp; p.revive = 0; p.inv = this.t + 1.5; p.vx = p.vy = 0; p.dashT = 0; this.emit({ k: 'revive', id: p.id }); }

  // entering a room that hasn't been cleared closes it and wakes its monsters;
  // friends elsewhere are pulled in so the party fights together
  roomCheck(p) {
    const id = roomAt(this.layout, p.x, p.y);
    if (id == null) return;
    const rs = this.rooms[id], room = this.layout.rooms[id];
    if (!rs.visited) { rs.visited = true; this.emit({ k: 'enter', room: id }); }
    if (rs.cleared || rs.locked) return;
    const [ix, iy, iw, ih] = interior(room);
    if (!inRect(p.x, p.y, [ix + 30, iy + 30, iw - 60, ih - 60])) return;
    rs.locked = true;
    for (const o of this.players.values()) {
      if (o === p || !o.alive) continue;
      const oid = roomAt(this.layout, o.x, o.y);
      if (oid === id || (oid != null && this.rooms[oid].locked)) continue; // busy in another fight (a mimic)
      o.x = p.x + (Math.random() - 0.5) * 60; o.y = p.y + (Math.random() - 0.5) * 60; o.vx = o.vy = 0; o.dashT = 0;
      this.emit({ k: 'pull', id: o.id });
    }
    this.rebuild();
    for (const o of this.players.values()) if (o.alive) collide(o, this.solid);
    if (this.enemies.some(e => e.room === id)) {} // re-entering a room the party had abandoned: its monsters are still there
    else if (room.type === 'challenge') { rs.wave = 1; this.spawnRoom(id, 1); this.emit({ k: 'cwave', room: id, n: 1 }); }
    else this.spawnRoom(id);
    this.emit({ k: 'lock', room: id, boss: room.boss || null });
  }

  spawnRoom(id, wave = 0) {
    const room = this.layout.rooms[id], [ix, iy, iw, ih] = interior(room), sc = this.scale();
    if (room.boss) { this.addEnemy(room.boss, room.x + CW / 2, room.y + CH / 2 - 40, id, sc); return; }
    const pool = POOL[Math.min(this.floor - 1, POOL.length - 1)];
    const n = 2 + this.floor + Math.floor(Math.random() * 3) + (this.players.size - 1); // floor 1 alone: 3–5
    const eliteP = wave === 2 ? 0.5 : this.floor >= 3 ? 0.18 : 0.12;
    const ps = this.alivePlayers();
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 40; k++) {
        const x = ix + 30 + Math.random() * (iw - 60), y = iy + 30 + Math.random() * (ih - 60);
        if (hitsSolid(x, y, this.solid, 22) || ps.some(p => Math.hypot(p.x - x, p.y - y) < (k < 30 ? 170 : 110))) continue;
        this.addEnemy(pool[Math.floor(Math.random() * pool.length)], x, y, id, sc, Math.random() < eliteP);
        break;
      }
    }
  }

  addEnemy(type, x, y, room, sc, elite = false) {
    const d = ENEMIES[type], hp = d.hp * sc * (elite ? 2.2 : 1);
    const e = { id: ++this.seq, type, x, y, vx: 0, vy: 0, room, hp, maxHp: hp, wake: this.t + 0.7, cd: 1 + Math.random(), slow: 0, phase: 1, warn: false, face: 1, ai: {}, elite, r: d.r * (elite ? 1.3 : 1), spd: elite ? 1.15 : 1 };
    this.enemies.push(e);
    return e;
  }

  onClear(id) {
    const room = this.layout.rooms[id], luck = this.luck();
    this.emit({ k: 'clear', room: id });
    const cx = room.x + CW / 2, cy = room.y + CH / 2;
    if (room.boss) {
      const [tx, ty] = this.freeSpot(cx, cy + 90, 30);
      this.trapdoor = { x: tx, y: ty };
      this.offerItems(cx, cy - 60, 3);
      for (let i = 0; i < 2; i++) this.drop('heart', cx - 60 + i * 120, cy + 30);
      this.addChest(cx + 170, cy + 80, 1);
      return;
    }
    if (room.type === 'challenge') {
      this.addChest(cx, cy, 1);
      for (let i = 0; i < 4 + luck; i++) this.drop('coin', cx + (Math.random() - 0.5) * 200, cy + 60 + (Math.random() - 0.5) * 60);
      return;
    }
    const r = Math.random();
    if (r < 0.28) this.drop('heart', cx, cy);
    else if (r < 0.36) this.offerItems(cx, cy, 1);
    for (let i = 0; i < 2 + Math.floor(Math.random() * 3) + luck; i++) this.drop('coin', cx + (Math.random() - 0.5) * 160, cy + (Math.random() - 0.5) * 100);
    if (Math.random() < 0.12 + 0.06 * luck) this.addChest(cx + (Math.random() - 0.5) * 200, cy + 50, 0, Math.random() < 0.2);
  }

  // ---------- attacks ----------
  addShot(p, a, o) {
    const s = { id: ++this.seq, owner: p.id, x: p.x + Math.cos(a) * 18, y: p.y + Math.sin(a) * 18, vx: Math.cos(a) * o.sp, vy: Math.sin(a) * o.sp, hit: [], kind: 0, ...o };
    this.shots.push(s);
    return s;
  }

  fire(p) {
    const st = p.st, w = WEAPONS[p.weapon] || WEAPONS.wand;
    p.cd = st.cd * w.cd;
    if (w.kind === 'melee') return this.swing(p, w);
    if (w.kind === 'wave') return this.shock(p, w);
    const n = st.shots, spread = p.weapon === 'daggers' ? 0.12 : 0.16;
    const kind = p.weapon === 'wand' && st.explode ? 1 : p.weapon === 'wand' && st.freeze ? 2 : w.sk;
    for (let i = 0; i < n; i++) {
      const a = p.aim + (i - (n - 1) / 2) * spread;
      this.addShot(p, a, { sp: w.speed, life: st.life * w.life, dmg: st.dmg * w.dmg, r: st.size, pierce: st.pierce + w.pierce, bounce: st.bounce, homing: st.homing, freeze: st.freeze + (w.freeze || 0), explode: st.explode, kind });
    }
    this.emit({ k: 'shot', id: p.id, x: p.x, y: p.y, w: p.weapon });
  }

  // melee: everything in the arc in front of you (multi widens it, range/big extend it)
  swing(p, w) {
    const st = p.st, a = p.aim;
    const reach = w.r * Math.sqrt(st.life / 0.85) + (st.size - 6) * 1.5;
    const arc = Math.min(Math.PI, w.arc + (st.shots - 1) * 0.18);
    const dmg = st.dmg * w.dmg, here = roomAt(this.layout, p.x, p.y);
    let first = null;
    for (const e of this.enemies.slice()) {
      if (e.hp <= 0 || this.t < e.wake || e.room !== here) continue;
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d > reach + e.r) continue;
      if (d > e.r && angDiff(Math.atan2(e.y - p.y, e.x - p.x), a) > arc + Math.asin(Math.min(1, e.r / d))) continue;
      const ex = e.x, ey = e.y;
      this.knock(e, Math.atan2(e.y - p.y, e.x - p.x), 18);
      this.playerHit(e, dmg, p.id, { freeze: st.freeze, melee: true });
      if (!first) first = [ex, ey, e.id];
    }
    if (w.parry) this.shots = this.shots.filter(s => {
      if (!s.enemy) return true;
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d > reach + s.r || angDiff(Math.atan2(s.y - p.y, s.x - p.x), a) > arc) return true;
      this.emit({ k: 'block', x: s.x, y: s.y }); return false;
    });
    const cr = this.crackRect();
    if (cr) {
      const [nx, ny] = nearestOn(p.x, p.y, cr), d = Math.hypot(nx - p.x, ny - p.y);
      const [mx, my] = [cr[0] + cr[2] / 2, cr[1] + cr[3] / 2];
      if (d <= reach && (d < 1 || angDiff(Math.atan2(ny - p.y, nx - p.x), a) <= arc || angDiff(Math.atan2(my - p.y, mx - p.x), a) <= arc)) this.crackHit(nx, ny);
    }
    if (first && st.split) this.splitFrom(first[0], first[1], a, p.id, dmg, [first[2]]);
    if (st.explode) this.blast(p.x + Math.cos(a) * reach * 0.6, p.y + Math.sin(a) * reach * 0.6, 38 + 14 * st.explode, dmg * 0.5, p.id);
    this.emit({ k: 'slash', id: p.id, x: p.x, y: p.y, a, arc, r: reach, w: p.weapon });
  }

  // hammer: shockwave all around you
  shock(p, w) {
    const st = p.st;
    const r = w.r * Math.sqrt(st.life / 0.85) + (st.size - 6) * 1.5 + (st.shots - 1) * 12;
    const dmg = st.dmg * w.dmg, here = roomAt(this.layout, p.x, p.y);
    for (const e of this.enemies.slice()) {
      if (e.hp <= 0 || this.t < e.wake || e.room !== here) continue;
      if (Math.hypot(e.x - p.x, e.y - p.y) > r + e.r) continue;
      this.knock(e, Math.atan2(e.y - p.y, e.x - p.x), 40);
      this.playerHit(e, dmg, p.id, { freeze: st.freeze, melee: true });
    }
    const cr = this.crackRect();
    if (cr) { const [nx, ny] = nearestOn(p.x, p.y, cr); if (Math.hypot(nx - p.x, ny - p.y) <= r) this.crackHit(nx, ny); }
    if (st.explode) this.blast(p.x, p.y, r * 0.6, dmg * 0.3, p.id);
    this.emit({ k: 'shock', id: p.id, x: p.x, y: p.y, r });
  }

  crackHit(x, y) {
    if (!this.crackRect()) return;
    this.crackHits++;
    this.emit({ k: 'crack', x, y });
    if (this.crackHits >= CRACK_HITS) {
      this.secretOpen = true;
      this.rebuild();
      this.emit({ k: 'secret', room: this.layout.secret.room });
    }
  }

  // push a monster (bosses barely move), staying inside its room
  knock(e, a, dist) {
    const d = ENEMIES[e.type];
    if (d.boss) dist *= 0.15;
    const q = { x: e.x + Math.cos(a) * dist, y: e.y + Math.sin(a) * dist };
    collide(q, d.flies ? this.layout.walls : this.solid, e.r);
    const [ix, iy, iw, ih] = interior(this.layout.rooms[e.room]);
    e.x = clamp(q.x, ix + e.r, ix + iw - e.r); e.y = clamp(q.y, iy + e.r, iy + ih - e.r);
  }

  // a player's hit on a monster: crit, then chain lightning and split shots
  playerHit(e, dmg, by, src = {}) {
    if (e.hp <= 0) return;
    const p = this.players.get(by), st = p?.st;
    let crit = false;
    if (st?.crit && Math.random() < Math.min(0.75, 0.15 * st.crit)) { dmg *= 2.5; crit = true; }
    const ex = e.x, ey = e.y;
    this.damageEnemy(e, dmg, by, src, crit);
    if (st?.chain && !src.chained) {
      let from = [ex, ey];
      const done = [e.id];
      for (let k = 0; k < st.chain; k++) {
        let best = null, bd = 170;
        for (const o of this.enemies) {
          if (done.includes(o.id) || o.hp <= 0 || this.t < o.wake || o.room !== e.room) continue;
          const d = Math.hypot(o.x - from[0], o.y - from[1]);
          if (d < bd) { bd = d; best = o; }
        }
        if (!best) break;
        done.push(best.id);
        this.emit({ k: 'chain', x1: from[0], y1: from[1], x2: best.x, y2: best.y });
        from = [best.x, best.y];
        this.damageEnemy(best, dmg * 0.6, by, { chained: true });
      }
    }
    if (st?.split && src.shot && !src.child && !src.didSplit) {
      src.didSplit = true;
      this.splitFrom(ex, ey, Math.atan2(src.vy, src.vx), by, src.dmg, [e.id], src);
    }
  }

  splitFrom(x, y, a, by, dmg, hit, parent = null) {
    const p = this.players.get(by);
    if (!p) return;
    const st = p.st, k = 0.4 * (1 + 0.3 * (st.split - 1));
    for (const off of [-0.55, 0, 0.55]) {
      const sp = 480;
      this.shots.push({ id: ++this.seq, owner: by, x, y, vx: Math.cos(a + off) * sp, vy: Math.sin(a + off) * sp, sp, life: 0.4, dmg: dmg * k, r: Math.max(3, (parent?.r || st.size) * 0.7), pierce: 0, bounce: 0, homing: 0, freeze: st.freeze, explode: parent ? parent.explode : 0, kind: parent ? parent.kind : 0, hit: hit.slice(), child: true });
    }
  }

  enemyShot(e, a, speed = 260, r = 7) {
    this.shots.push({ id: ++this.seq, enemy: true, x: e.x + Math.cos(a) * (e.r + 4), y: e.y + Math.sin(a) * (e.r + 4), vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, sp: speed, life: 3, r, hit: [], kind: 0 });
  }

  nearestPlayer(e) {
    let best = null, bd = Infinity;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - e.x, p.y - e.y);
      if (d < bd) { bd = d; best = p; }
    }
    return [best, bd];
  }

  // big boss attacks are telegraphed: e.warn for 0.7 s, then fire()
  telegraph(e, ready, fire) {
    if (e.ai.warnAt) {
      if (this.t >= e.ai.warnAt) { e.ai.warnAt = 0; e.warn = false; fire(); }
      return true;
    }
    if (ready) { e.ai.warnAt = this.t + 0.7; e.warn = true; this.emit({ k: 'warn', id: e.id }); return true; }
    return false;
  }

  stepEnemies(dt) {
    const solidNoObst = this.layout.walls; // ghosts drift through rocks, not through walls
    for (const e of this.enemies.slice()) {
      if (e.hp <= 0) continue;
      const d = ENEMIES[e.type];
      if (this.t < e.wake) continue;
      const [p, dist] = this.nearestPlayer(e);
      if (!p) continue;
      const slow = this.t < e.slow ? 0.55 : 1;
      const toP = Math.atan2(p.y - e.y, p.x - e.x);
      e.face = Math.cos(toP) >= 0 ? 1 : -1;
      if (d.boss && e.phase === 1 && e.hp <= e.maxHp * 0.5) {
        e.phase = 2;
        this.emit({ k: 'phase2', x: e.x, y: e.y });
        if (e.type === 'slimeking') for (let k = 0; k < 3; k++) this.addEnemy('slime', e.x + (k - 1) * 60, e.y + 50, e.room, this.scale() * 0.8);
      }
      const p2 = e.phase === 2, f = p2 ? 0.7 : 1; // phase 2: attacks 30% faster
      let mx = 0, my = 0, speed = d.speed * slow * e.spd;
      e.cd -= (dt * slow) / f;
      switch (e.type) {
        case 'slime': mx = Math.cos(toP); my = Math.sin(toP); speed *= 0.75 + 0.35 * Math.abs(Math.sin(this.t * 3 + e.id)); break;
        case 'bat': { const w = Math.sin(this.t * 6 + e.id) * 1.2; mx = Math.cos(toP + w); my = Math.sin(toP + w); break; }
        case 'spider': // waits, then lunges
          if (e.ai.lunge > this.t) { mx = Math.cos(e.ai.la); my = Math.sin(e.ai.la); speed = 360 * slow * e.spd; }
          else if (e.cd <= 0) { e.cd = 1.8 + Math.random(); e.ai.lunge = this.t + 0.45; e.ai.la = toP; }
          break;
        case 'mimic': // hops after you and bites
          if (e.ai.lunge > this.t) { mx = Math.cos(e.ai.la); my = Math.sin(e.ai.la); speed = 320 * slow; }
          else { mx = Math.cos(toP); my = Math.sin(toP); if (e.cd <= 0 && dist < 240) { e.cd = 1.5 + Math.random(); e.ai.lunge = this.t + 0.35; e.ai.la = toP; } }
          break;
        case 'skeleton': { // keeps its distance and shoots arrows
          const want = dist > 300 ? 1 : dist < 190 ? -1 : 0;
          mx = Math.cos(toP) * want + Math.cos(toP + Math.PI / 2) * 0.5 * Math.sin(this.t + e.id);
          my = Math.sin(toP) * want + Math.sin(toP + Math.PI / 2) * 0.5 * Math.sin(this.t + e.id);
          if (e.cd <= 0) { e.cd = 1.7; if (!blocked(e.x, e.y, p.x, p.y, this.solid)) this.enemyShot(e, toP + (Math.random() - 0.5) * 0.12, 300, 6); }
          break;
        }
        case 'ghost': mx = Math.cos(toP); my = Math.sin(toP); break;
        case 'demon':
          mx = Math.cos(toP) * 0.6; my = Math.sin(toP) * 0.6;
          if (e.cd <= 0) { e.cd = 2.4; for (const k of [-0.3, 0, 0.3]) this.enemyShot(e, toP + k, 220, 8); }
          break;
        case 'slimeking':
          mx = Math.cos(toP); my = Math.sin(toP);
          if (this.telegraph(e, e.cd <= 0, () => { e.cd = 2.6; const n = p2 ? 18 : 14; for (let k = 0; k < n; k++) this.enemyShot(e, (k / n) * Math.PI * 2 + this.t, 200, 9); })) speed *= 0.3;
          if ((e.ai.spawn ??= this.t + 5) < this.t) { e.ai.spawn = this.t + 6 * f; for (let k = 0; k < 2; k++) this.addEnemy('slime', e.x + (k ? 50 : -50), e.y + 40, e.room, this.scale() * 0.8); }
          if (p2 && (e.ai.p2 ??= this.t + 1.5) < this.t) { e.ai.p2 = this.t + 1.6; for (let k = -2; k <= 2; k++) this.enemyShot(e, toP + k * 0.18, 250, 8); }
          break;
        case 'cyclops':
          if (e.ai.charge > this.t) { mx = Math.cos(e.ai.ca); my = Math.sin(e.ai.ca); speed = 420 * slow; }
          else {
            mx = Math.cos(toP) * 0.5; my = Math.sin(toP) * 0.5;
            const warned = this.telegraph(e, this.t >= (e.ai.next ??= this.t + 4), () => { e.ai.next = this.t + 5 * f; e.ai.charge = this.t + 0.8; e.ai.ca = toP; this.emit({ k: 'roar', x: e.x, y: e.y }); });
            if (warned) speed *= 0.2;
            else if (e.cd <= 0) { e.cd = 1.3; for (const k of [-0.25, 0, 0.25]) this.enemyShot(e, toP + k, 280, 9); }
            if (p2 && (e.ai.p2 ??= this.t + 2) < this.t) { e.ai.p2 = this.t + 2.2; for (let k = 0; k < 10; k++) this.enemyShot(e, (k / 10) * Math.PI * 2 + this.t, 190, 8); }
          }
          break;
        case 'archdemon':
          mx = Math.cos(toP) * 0.4; my = Math.sin(toP) * 0.4;
          if ((e.ai.spiral ??= 0) <= this.t) {
            e.ai.spiral = this.t + 0.16 * f; e.ai.ang = (e.ai.ang || 0) + 0.45;
            this.enemyShot(e, e.ai.ang, 200, 8); this.enemyShot(e, e.ai.ang + Math.PI, 200, 8);
            if (p2) this.enemyShot(e, -e.ai.ang * 1.3 + Math.PI / 2, 180, 8); // counter spiral
          }
          if (this.telegraph(e, e.cd <= 0, () => { e.cd = 3.6; for (let k = 0; k < 18; k++) this.enemyShot(e, (k / 18) * Math.PI * 2, 170, 10); })) speed *= 0.3;
          break;
      }
      // move (bosses and ghosts are big / float, the rest bump into rocks)
      const q = { x: e.x, y: e.y, vx: e.vx, vy: e.vy };
      move(q, { mx, my }, dt, d.flies ? solidNoObst : this.solid, speed, true, e.r);
      // keep monsters inside their room
      const [ix, iy, iw, ih] = interior(this.layout.rooms[e.room]);
      q.x = clamp(q.x, ix + e.r, ix + iw - e.r); q.y = clamp(q.y, iy + e.r, iy + ih - e.r);
      if (Number.isFinite(q.x) && Number.isFinite(q.y)) { e.x = q.x; e.y = q.y; e.vx = q.vx; e.vy = q.vy; }
      // touching a player hurts them (and thorns hurt back)
      for (const o of this.players.values()) {
        if (!o.alive || Math.hypot(o.x - e.x, o.y - e.y) >= PR + e.r - 2) continue;
        this.hurt(o, e.x, e.y);
        if (o.st.thorns && e.hp > 0 && !(e.ai.thorn > this.t)) { e.ai.thorn = this.t + 0.5; this.damageEnemy(e, o.st.dmg * 0.8 * o.st.thorns, o.id); }
        if (e.hp <= 0) break;
      }
    }
  }

  hurt(p, fx, fy) {
    if (!p.alive || p.god || this.t < p.inv) return;
    p.hp -= 1;
    p.inv = this.t + 1.1;
    const d = Math.hypot(p.x - fx, p.y - fy) || 1;
    p.x += ((p.x - fx) / d) * 26; p.y += ((p.y - fy) / d) * 26;
    collide(p, this.solid);
    this.emit({ k: 'hurt', id: p.id, x: p.x, y: p.y });
    if (p.hp > 0) return;
    if (p.st.phoenix > 0) { // the feather burns: back up with full hearts
      p.st.phoenix--;
      const i = p.items.lastIndexOf('phoenix');
      if (i >= 0) p.items.splice(i, 1);
      p.hp = p.st.maxHp; p.inv = this.t + 2;
      this.emit({ k: 'phoenix', id: p.id, x: p.x, y: p.y });
      return;
    }
    p.hp = 0; p.alive = false; p.revive = 0; p.dashT = 0;
    this.emit({ k: 'down', id: p.id, x: p.x, y: p.y });
  }

  damageEnemy(e, dmg, by, shot, crit = false) {
    if (this.t < e.wake || e.hp <= 0 || !(dmg > 0)) return;
    e.hp -= dmg;
    if (shot?.freeze) e.slow = this.t + 1.2 + 0.4 * shot.freeze;
    this.emit(crit ? { k: 'ehit', id: e.id, x: e.x, y: e.y, dmg: Math.round(dmg), crit: 1 } : { k: 'ehit', id: e.id, x: e.x, y: e.y, dmg: Math.round(dmg) });
    if (e.hp > 0) return;
    this.enemies = this.enemies.filter(o => o !== e);
    const p = this.players.get(by), luck = this.luck();
    if (p) { p.kills++; if (p.st.vamp && Math.random() < 0.06 * p.st.vamp && p.hp < p.st.maxHp) { p.hp++; this.emit({ k: 'heal', id: p.id }); } }
    this.kills++;
    this.emit({ k: 'edie', id: e.id, type: e.type, x: e.x, y: e.y, elite: e.elite ? 1 : 0 });
    if (ENEMIES[e.type].boss) {
      this.emit({ k: 'bossdown', x: e.x, y: e.y });
      for (const o of this.enemies) if (o.room === e.room) o.hp = 0;
      this.enemies = this.enemies.filter(o => o.room !== e.room);
    } else if (e.type === 'mimic') {
      for (let i = 0; i < 6 + luck; i++) this.drop('coin', e.x + (Math.random() - 0.5) * 90, e.y + (Math.random() - 0.5) * 70);
      if (Math.random() < 0.5) this.offerItems(e.x, e.y, 1, { rmin: 1 }); else this.drop('heart', e.x, e.y);
    } else if (e.elite) for (let i = 0; i < 3; i++) this.drop('coin', e.x + (i - 1) * 22, e.y);
    else if (Math.random() < 0.18 + 0.05 * luck) this.drop('coin', e.x, e.y);
  }

  stepShots(dt) {
    const list = this.shots;
    this.shots = []; // split shots born this tick land here and move from the next tick
    for (const s of list) {
      // homing: turn toward the nearest monster
      if (s.homing && !s.enemy) {
        let best = null, bd = 260;
        for (const e of this.enemies) { const d = Math.hypot(e.x - s.x, e.y - s.y); if (d < bd && this.t >= e.wake) { bd = d; best = e; } }
        if (best) {
          const a = Math.atan2(s.vy, s.vx), want = Math.atan2(best.y - s.y, best.x - s.x);
          const da = Math.atan2(Math.sin(want - a), Math.cos(want - a));
          const na = a + Math.max(-1, Math.min(1, da)) * Math.min(1, 4 * s.homing * dt);
          const sp = s.sp || SHOT_SPEED;
          s.vx = Math.cos(na) * sp; s.vy = Math.sin(na) * sp;
        }
      }
      const px = s.x, py = s.y;
      s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt;
      let alive = s.life > 0;
      if (alive && hitsSolid(s.x, s.y, this.solid)) {
        const cr = this.crackRect();
        if (!s.enemy && cr && inRect(s.x, s.y, cr)) { this.crackHit(s.x, s.y); alive = false; }
        else if (!s.enemy && s.bounce > 0) {
          s.bounce--;
          const hx = hitsSolid(s.x, py, this.solid), hy = hitsSolid(px, s.y, this.solid);
          if (hx || !hy) s.vx = -s.vx;
          if (hy || !hx) s.vy = -s.vy;
          s.x = px; s.y = py;
        } else alive = false;
      }
      if (alive && s.enemy) {
        for (const p of this.players.values()) {
          if (!p.alive || Math.hypot(p.x - s.x, p.y - s.y) > PR + s.r) continue;
          if (this.t < p.shieldT) this.emit({ k: 'block', x: s.x, y: s.y });
          else this.hurt(p, s.x - s.vx * 0.05, s.y - s.vy * 0.05);
          alive = false; break;
        }
      } else if (alive) {
        for (const e of this.enemies) {
          if (e.hp <= 0 || s.hit.includes(e.id) || this.t < e.wake) continue;
          if (Math.hypot(e.x - s.x, e.y - s.y) > e.r + s.r) continue;
          s.hit.push(e.id);
          if (s.fb) { alive = false; break; } // the fireball's blast does the damage
          this.playerHit(e, s.dmg, s.owner, Object.assign(s, { shot: true }));
          if (s.pierce > 0) s.pierce--; else { alive = false; break; }
        }
      }
      if (!alive && !s.enemy) {
        if (s.fb) this.blast(s.x, s.y, 95, s.dmg, s.owner);
        else if (s.explode) this.blast(s.x, s.y, (38 + 14 * s.explode) * (s.child ? 0.6 : 1), s.dmg * 0.6, s.owner);
        this.emit({ k: 'poof', x: s.x, y: s.y, kind: s.kind || 0 });
      }
      if (alive) this.shots.push(s);
    }
  }

  blast(x, y, r, dmg, by) {
    this.emit({ k: 'boom', x, y, r });
    for (const e of this.enemies.slice()) if (e.hp > 0 && Math.hypot(e.x - x, e.y - y) < r + e.r) this.damageEnemy(e, dmg, by);
  }

  // orbiting orbs: hurt monsters they touch and swat their shots away
  orbs(p) {
    const out = [];
    for (let i = 0; i < p.st.orbit; i++) { const a = this.t * 3 + (i / p.st.orbit) * Math.PI * 2; out.push([p.x + Math.cos(a) * 46, p.y + Math.sin(a) * 46]); }
    return out;
  }
  stepOrbits() {
    for (const p of this.players.values()) {
      if (!p.alive || !p.st.orbit) continue;
      for (const [ox, oy] of this.orbs(p)) {
        for (const e of this.enemies.slice()) {
          if (e.hp <= 0 || Math.hypot(e.x - ox, e.y - oy) > e.r + 10) continue;
          if ((e.ai.orbHit || 0) > this.t) continue;
          e.ai.orbHit = this.t + 0.3;
          this.damageEnemy(e, 8 * (p.dmgMul || 1), p.id);
        }
        this.shots = this.shots.filter(s => !(s.enemy && Math.hypot(s.x - ox, s.y - oy) < 14));
      }
    }
  }

  // magnet: coins (and hearts you need) in your room fly to you
  stepPickups(dt) {
    for (const p of this.players.values()) {
      if (!p.alive || !p.st.magnet) continue;
      const here = roomAt(this.layout, p.x, p.y), R = 120 + 70 * p.st.magnet;
      for (const u of this.pickups) {
        if (u.type !== 'coin' && !(u.type === 'heart' && p.hp < p.st.maxHp)) continue;
        const d = Math.hypot(p.x - u.x, p.y - u.y);
        if (d > R || d < 1 || roomAt(this.layout, u.x, u.y) !== here) continue;
        const step = Math.min(d, 380 * dt), nx = u.x + ((p.x - u.x) / d) * step, ny = u.y + ((p.y - u.y) / d) * step;
        if (!hitsSolid(nx, ny, this.solid, 10)) { u.x = nx; u.y = ny; }
      }
    }
  }

  addItem(p, item) {
    applyItem(p.st, item);
    if (item === 'heart') p.hp = Math.min(p.st.maxHp, p.hp + 2);
    p.items.push(item);
  }

  // hand a pedestal's code to a player; false = it doesn't apply (full hp, same weapon) and stays
  give(p, code, x, y) {
    if (code === 'hp') {
      if (p.hp >= p.st.maxHp) return false;
      p.hp = p.st.maxHp; this.emit({ k: 'heal', id: p.id });
      return true;
    }
    if (code.startsWith('w:')) {
      const w = code.slice(2);
      if (!WEAPONS[w] || p.weapon === w) return false;
      const old = p.weapon;
      p.weapon = w;
      const u = this.drop('w:' + old, x, y + 40);
      p.wGuard = u.id;
      this.emit({ k: 'weapon', id: p.id, w, x, y });
      return true;
    }
    if (!ITEMS[code]) return false;
    this.addItem(p, code);
    return true;
  }

  touchPickups(p) {
    for (const u of this.pickups.slice()) {
      const d = Math.hypot(u.x - p.x, u.y - p.y);
      if (u.type.startsWith('w:')) { // weapons on the floor: walking over swaps (not straight back)
        if (p.wGuard === u.id) { if (d > PR + 34) p.wGuard = null; continue; }
        if (d > PR + 14) continue;
        const w = u.type.slice(2);
        if (!WEAPONS[w] || w === p.weapon) continue;
        const old = p.weapon;
        p.weapon = w;
        u.type = 'w:' + old; u.id = ++this.seq; p.wGuard = u.id;
        this.emit({ k: 'weapon', id: p.id, w, x: u.x, y: u.y });
        continue;
      }
      if (d > PR + 14) continue;
      if (u.type === 'heart') { if (p.hp >= p.st.maxHp) continue; p.hp = Math.min(p.st.maxHp, p.hp + 2); }
      else if (u.type === 'coin') this.coins++;
      this.pickups = this.pickups.filter(o => o !== u);
      this.emit({ k: 'pick', id: p.id, type: u.type, x: u.x, y: u.y });
    }
    for (const c of this.chests.slice()) {
      if (c.open || Math.hypot(c.x - p.x, c.y - p.y) > PR + 18) continue;
      this.openChest(c, p);
    }
    for (const d of this.pedestals.slice()) {
      if (!this.pedestals.includes(d) || Math.hypot(d.x - p.x, d.y - p.y) > PR + 18) continue;
      if (d.price > 0) { // shop: the team purse pays; each pedestal sells once
        if (this.coins < d.price) { if (this.t > p.nocashT) { p.nocashT = this.t + 1.5; this.emit({ k: 'nocash', id: p.id }); } continue; }
        if (!this.give(p, d.item, d.x, d.y)) continue;
        this.coins -= d.price;
        this.pedestals = this.pedestals.filter(o => o !== d);
        this.emit({ k: 'buy', id: p.id, code: d.item, x: d.x, y: d.y });
        continue;
      }
      const set = this.pedestals.filter(o => o.set === d.set);
      if (set.some(o => o.takenBy.includes(p.id))) continue; // one item per set for each player
      if (!this.give(p, d.item, d.x, d.y)) continue;
      if (d.curse) { // the altar takes 2 max hearts (never below 2)
        p.st.maxHp = Math.max(2, p.st.maxHp - 2); p.hp = Math.min(p.hp, p.st.maxHp);
        this.emit({ k: 'curse', id: p.id, item: d.item });
      }
      if (ITEMS[d.item]) this.emit({ k: 'item', id: p.id, item: d.item, x: d.x, y: d.y });
      d.takenBy.push(p.id);
      (p.tookSets ||= []).push(d.set);
      this.pedestals = this.pedestals.filter(o => o !== d);
      // once everyone has picked from this set, the rest disappear
      const takers = new Set(set.flatMap(o => o.takenBy).concat(p.id));
      if (this.alivePlayers().every(o => takers.has(o.id))) this.pedestals = this.pedestals.filter(o => o.set !== d.set);
    }
  }

  openChest(c, p) {
    if (c.mimic) { // surprise: it bites. The room closes until it's dead
      this.chests = this.chests.filter(o => o !== c);
      const id = roomAt(this.layout, c.x, c.y);
      const e = this.addEnemy('mimic', c.x, c.y, id, this.scale());
      e.wake = this.t + 0.5; e.cd = 1;
      const rs = this.rooms[id];
      if (rs && !rs.locked) { rs.locked = true; rs.mimic = true; this.rebuild(); for (const o of this.players.values()) if (o.alive) collide(o, this.solid); }
      this.emit({ k: 'mimic', x: c.x, y: c.y, id: e.id });
      return;
    }
    c.open = true;
    this.emit({ k: 'chest', x: c.x, y: c.y, kind: c.kind });
    const luck = this.luck();
    if (c.kind === 1) { this.offerItems(c.x, c.y + 50, 1, { rmin: 1 }); return; }
    for (let i = 0; i < 3 + Math.floor(Math.random() * 3) + luck; i++) this.drop('coin', c.x + (Math.random() - 0.5) * 100, c.y + 30 + Math.random() * 40);
    if (Math.random() < 0.35) this.drop('heart', c.x - 40, c.y + 40);
    if (Math.random() < 0.3) this.offerItems(c.x, c.y + 60, 1);
    else if (Math.random() < 0.12) { const ws = WEAPON_LIST.filter(w => w !== p.weapon); this.drop('w:' + ws[Math.floor(Math.random() * ws.length)], c.x + 40, c.y + 50); }
  }
}
