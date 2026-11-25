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

// ---------- seeded random ----------
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// ---------- items (upgrades) ----------
// spr: tile index in the Tiny Dungeon sheet used to show the item
export const ITEMS = {
  dmg: { name: 'חרב חדה', desc: '+30% נזק', spr: 104 },
  rate: { name: 'שרביט מהיר', desc: 'יורה מהר יותר', spr: 130 },
  multi: { name: 'מטה משולש', desc: '+1 קליע בכל ירייה', spr: 131 },
  pierce: { name: 'פגיון רפאים', desc: 'קליעים עוברים דרך אויבים', spr: 103 },
  bounce: { name: 'טבעת קפיצה', desc: 'קליעים קופצים מהקירות', spr: 101 },
  homing: { name: 'טבעת ציד', desc: 'קליעים מחפשים מטרה', spr: 102 },
  big: { name: 'שיקוי ענק', desc: 'קליעים גדולים וחזקים', spr: 116 },
  speed: { name: 'שיקוי זריזות', desc: '+15% מהירות', spr: 114 },
  heart: { name: 'שיקוי חיים', desc: '+1 לב (ומתמלא)', spr: 115 },
  vamp: { name: 'בקבוקון דם', desc: 'סיכוי להחזיר לב בכל הריגה', spr: 127 },
  freeze: { name: 'בקבוקון קרח', desc: 'קליעים מאטים אויבים', spr: 128 },
  orbit: { name: 'מגן מסתובב', desc: 'כדור קסם מסתובב סביבך', spr: 66 },
  range: { name: 'חנית ארוכה', desc: '+40% טווח', spr: 107 },
  explode: { name: 'שרביט האש', desc: 'קליעים מתפוצצים', spr: 129 },
};
export const ITEM_LIST = Object.keys(ITEMS);
export const baseStats = () => ({ dmg: 10, cd: 0.36, shots: 1, pierce: 0, bounce: 0, homing: 0, size: 6, speed: 210, life: 0.85, vamp: 0, freeze: 0, orbit: 0, explode: 0, maxHp: 6 });
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
    case 'heart': st.maxHp = Math.min(12, st.maxHp + 2); break;
    case 'vamp': st.vamp += 1; break;
    case 'freeze': st.freeze += 1; break;
    case 'orbit': st.orbit = Math.min(3, st.orbit + 1); break;
    case 'range': st.life *= 1.4; break;
    case 'explode': st.explode += 1; break;
  }
}
export const SHOT_SPEED = 520;

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

export function genFloor(seed, floor) {
  const R = rng(seed * 31 + floor * 7919 + 17);
  const want = 7 + floor * 2;
  const G = 9, key = (x, y) => y * G + x;
  const cells = new Map([[key(4, 4), { gx: 4, gy: 4 }]]);
  const nb = (x, y) => Object.values(DIRS).filter(([dx, dy]) => cells.has(key(x + dx, y + dy))).length;
  for (let guard = 0; cells.size < want && guard < 5000; guard++) {
    const list = [...cells.values()];
    const c = list[Math.floor(R() * list.length)];
    const [dx, dy] = Object.values(DIRS)[Math.floor(R() * 4)];
    const nx = c.gx + dx, ny = c.gy + dy;
    if (nx < 1 || ny < 1 || nx >= G - 1 || ny >= G - 1 || cells.has(key(nx, ny))) continue;
    if (nb(nx, ny) > 1 && R() < 0.85) continue; // keep it branchy, few loops
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
  const treasure = ends.find(r => r !== boss) || far.find(r => r !== boss);
  if (treasure) treasure.type = 'treasure';
  // obstacles
  for (const r of rooms) {
    const lay = r.type === 'normal' ? LAYOUTS[1 + Math.floor(R() * (LAYOUTS.length - 1))] : r.type === 'treasure' ? LAYOUTS[1] : [];
    r.obstacles = lay.map(([tx, ty, tw, th]) => [r.x + T + tx * T, r.y + T + ty * T, tw * T, th * T]);
    r.boss = r.type === 'boss' ? BOSS_OF[Math.min(floor - 1, BOSS_OF.length - 1)] : null;
  }
  // walls: four sides per room, with a door gap where a neighbour is
  const walls = [];
  for (const r of rooms) {
    const cx = r.x + CW / 2, cy = r.y + CH / 2;
    const hw = (y, d) => r.doors[d] == null ? walls.push([r.x, y, CW, T]) : walls.push([r.x, y, cx - DOOR / 2 - r.x, T], [cx + DOOR / 2, y, r.x + CW - cx - DOOR / 2, T]);
    const vw = (x, d) => r.doors[d] == null ? walls.push([x, r.y, T, CH]) : walls.push([x, r.y, T, cy - DOOR / 2 - r.y], [x, cy + DOOR / 2, T, r.y + CH - cy - DOOR / 2]);
    hw(r.y, 'n'); hw(r.y + CH - T, 's'); vw(r.x, 'w'); vw(r.x + CW - T, 'e');
  }
  // door plugs: closing a room fills its door openings (both wall layers)
  for (const r of rooms) {
    const cx = r.x + CW / 2, cy = r.y + CH / 2;
    r.plugs = [];
    if (r.doors.n != null) r.plugs.push([cx - DOOR / 2, r.y - T, DOOR, 2 * T]);
    if (r.doors.s != null) r.plugs.push([cx - DOOR / 2, r.y + CH - T, DOOR, 2 * T]);
    if (r.doors.w != null) r.plugs.push([r.x - T, cy - DOOR / 2, 2 * T, DOOR]);
    if (r.doors.e != null) r.plugs.push([r.x + CW - T, cy - DOOR / 2, 2 * T, DOOR]);
  }
  const grid = new Map(rooms.map(r => [key(r.gx, r.gy), r.id]));
  return { floor, rooms, walls, start: start.id, grid, G };
}

export const roomAt = (layout, x, y) => layout.grid.get(Math.floor(y / CH) * layout.G + Math.floor(x / CW)) ?? null;
export const interior = r => [r.x + T, r.y + T, RW * T, RH * T];

// every solid rectangle right now: walls, obstacles, and the doors of locked rooms
export function solids(layout, locked) {
  const out = layout.walls.slice();
  for (const r of layout.rooms) {
    out.push(...r.obstacles);
    if (locked[r.id]) out.push(...r.plugs);
  }
  return out;
}

// ---------- movement (same model as the arena) ----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
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

// ---------- the game ----------
export class DungeonSim {
  constructor(players, seed, emit) {
    this.seed = seed;
    this.emit = emit || (() => {});
    this.t = 0;
    this.seq = 0;
    this.phase = 'play'; // play | won | lost
    this.players = new Map(players.map((p, i) => [p.id, this.newPlayer(p, i)]));
    this.coins = 0;
    this.kills = 0;
    this.startFloor(1);
  }

  newPlayer(p, i) {
    const st = baseStats();
    return { id: p.id, name: p.name, hero: i % 4, x: 0, y: 0, vx: 0, vy: 0, aim: 0, fire: false, hp: st.maxHp, st, items: [], alive: true, inv: 0, cd: 0, dashT: 0, dashCd: 0, dashDir: null, budget: 0, lastSeq: 0, kills: 0, input: { a: 0, f: false } };
  }

  startFloor(n) {
    this.floor = n;
    this.layout = genFloor(this.seed, n);
    this.rooms = this.layout.rooms.map(r => ({ visited: r.type === 'start', cleared: r.type !== 'normal' && r.type !== 'boss', locked: false }));
    this.enemies = [];
    this.shots = [];
    this.pickups = [];
    this.pedestals = [];
    this.trapdoor = null;
    this.rebuild();
    const s = this.layout.rooms[this.layout.start];
    let i = 0;
    for (const p of this.players.values()) {
      p.x = s.x + CW / 2 + (i % 2 ? 40 : -40) * Math.ceil(i / 2); p.y = s.y + CH / 2 + (i > 1 ? 40 : 0); i++;
      p.vx = p.vy = 0;
      if (!p.alive) { p.alive = true; p.hp = 2; }
    }
    // a treasure room holds three items to choose from
    const tr = this.layout.rooms.find(r => r.type === 'treasure');
    if (tr) this.offerItems(tr.x + CW / 2, tr.y + CH / 2, 3);
    this.emit({ k: 'floor', n });
  }

  rebuild() { this.solid = solids(this.layout, this.rooms.map(r => r.locked)); this.solidSeq = (this.solidSeq || 0) + 1; }
  alivePlayers() { return [...this.players.values()].filter(p => p.alive); }
  scale() { return (1 + 0.3 * (this.floor - 1)) * (1 + 0.45 * (this.players.size - 1)); }

  // nearest spot to (x, y) that isn't inside a rock or wall (drops must be reachable)
  freeSpot(x, y, pad = 22) {
    if (!hitsSolid(x, y, this.solid, pad)) return [x, y];
    for (let d = 20; d < 300; d += 20) for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2, nx = x + Math.cos(a) * d, ny = y + Math.sin(a) * d;
      if (!hitsSolid(nx, ny, this.solid, pad)) return [nx, ny];
    }
    return [x, y];
  }
  drop(type, x, y) { const [fx, fy] = this.freeSpot(x, y, 16); this.pickups.push({ id: ++this.seq, type, x: fx, y: fy }); }

  offerItems(x, y, n) {
    const pool = ITEM_LIST.slice().sort(() => Math.random() - 0.5).slice(0, n);
    const set = ++this.seq;
    pool.forEach((item, i) => { const [px, py] = this.freeSpot(x + (i - (n - 1) / 2) * 110, y, 26); this.pedestals.push({ id: ++this.seq, set, item, x: px, y: py, takenBy: [] }); });
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
      const a = l > 0.2 ? Math.atan2(my, mx) : p.input.a;
      p.dashDir = { mx: Math.cos(a), my: Math.sin(a) }; p.dashT = DASH.time; p.dashCd = DASH.cd;
      p.inv = Math.max(p.inv, this.t + DASH.time + 0.05); // dodge through shots
      this.emit({ k: 'dash', id: p.id, x: p.x, y: p.y });
    }
    if (p.dashT > 0) { move(p, p.dashDir, dt, this.solid, p.st.speed * DASH.speed, true); p.dashT -= dt; }
    else move(p, { mx, my }, dt, this.solid, p.st.speed);
  }

  // ---------- simulation ----------
  tick() {
    if (this.phase !== 'play') return;
    const dt = TICK;
    this.t += dt;
    for (const p of this.players.values()) {
      p.budget = Math.min(0.3, p.budget + dt);
      p.dashCd -= dt;
      if (!p.alive) continue;
      p.aim = p.input.a;
      this.roomCheck(p);
      p.cd -= dt;
      if (p.input.f && p.cd <= 0) this.fire(p);
      this.touchPickups(p);
    }
    this.stepEnemies(dt);
    this.stepShots(dt);
    this.stepOrbits();
    // rooms: clear when their monsters are gone
    this.rooms.forEach((rs, id) => {
      if (!rs.locked) return;
      if (this.enemies.some(e => e.room === id)) return;
      rs.locked = false; rs.cleared = true;
      this.rebuild();
      this.onClear(id);
    });
    // everyone down → the run is over
    if (!this.alivePlayers().length) { this.phase = 'lost'; this.emit({ k: 'lost' }); }
    // stairs: everyone alive standing on them goes down
    if (this.trapdoor) {
      const ps = this.alivePlayers();
      const on = ps.filter(p => Math.hypot(p.x - this.trapdoor.x, p.y - this.trapdoor.y) < 34);
      if (ps.length && on.length === ps.length) {
        if (this.floor >= FLOORS) { this.phase = 'won'; this.emit({ k: 'won' }); }
        else { this.emit({ k: 'stairs' }); this.startFloor(this.floor + 1); }
      }
    }
  }

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
      if (o === p || !o.alive || roomAt(this.layout, o.x, o.y) === id) continue;
      o.x = p.x + (Math.random() - 0.5) * 60; o.y = p.y + (Math.random() - 0.5) * 60; o.vx = o.vy = 0;
      this.emit({ k: 'pull', id: o.id });
    }
    this.rebuild();
    for (const o of this.players.values()) if (o.alive) collide(o, this.solid);
    this.spawnRoom(id);
    this.emit({ k: 'lock', room: id, boss: room.boss || null });
  }

  spawnRoom(id) {
    const room = this.layout.rooms[id], [ix, iy, iw, ih] = interior(room), sc = this.scale();
    if (room.boss) { this.addEnemy(room.boss, room.x + CW / 2, room.y + CH / 2 - 40, id, sc); return; }
    const pool = POOL[Math.min(this.floor - 1, POOL.length - 1)];
    const n = 2 + this.floor + Math.floor(Math.random() * 3) + (this.players.size - 1); // floor 1 alone: 3–5
    const ps = this.alivePlayers();
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 30; k++) {
        const x = ix + 30 + Math.random() * (iw - 60), y = iy + 30 + Math.random() * (ih - 60);
        if (hitsSolid(x, y, this.solid, 22) || ps.some(p => Math.hypot(p.x - x, p.y - y) < 170)) continue;
        this.addEnemy(pool[Math.floor(Math.random() * pool.length)], x, y, id, sc);
        break;
      }
    }
  }

  addEnemy(type, x, y, room, sc) {
    const d = ENEMIES[type];
    this.enemies.push({ id: ++this.seq, type, x, y, vx: 0, vy: 0, room, hp: d.hp * sc, maxHp: d.hp * sc, wake: this.t + 0.7, cd: 1 + Math.random(), slow: 0, phase: 0, face: 1, ai: {} });
  }

  onClear(id) {
    const room = this.layout.rooms[id];
    // the fallen come back when the room is cleared
    const alive = this.alivePlayers();
    for (const p of this.players.values()) if (!p.alive && alive.length) { p.alive = true; p.hp = Math.min(2, p.st.maxHp); p.x = alive[0].x + 30; p.y = alive[0].y; p.inv = this.t + 1.5; collide(p, this.solid); this.emit({ k: 'revive', id: p.id }); }
    this.emit({ k: 'clear', room: id });
    const cx = room.x + CW / 2, cy = room.y + CH / 2;
    if (room.boss) {
      const [tx, ty] = this.freeSpot(cx, cy + 90, 30);
      this.trapdoor = { x: tx, y: ty };
      this.offerItems(cx, cy - 60, 3);
      for (let i = 0; i < 2; i++) this.drop('heart', cx - 60 + i * 120, cy + 30);
      return;
    }
    const r = Math.random();
    if (r < 0.28) this.drop('heart', cx, cy);
    else if (r < 0.36) this.offerItems(cx, cy, 1);
    for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) this.drop('coin', cx + (Math.random() - 0.5) * 160, cy + (Math.random() - 0.5) * 100);
  }

  fire(p) {
    const st = p.st;
    p.cd = st.cd;
    const n = st.shots, spread = 0.16;
    for (let i = 0; i < n; i++) {
      const a = p.aim + (i - (n - 1) / 2) * spread;
      this.shots.push({ id: ++this.seq, owner: p.id, x: p.x + Math.cos(a) * 18, y: p.y + Math.sin(a) * 18, vx: Math.cos(a) * SHOT_SPEED, vy: Math.sin(a) * SHOT_SPEED, life: st.life, dmg: st.dmg, r: st.size, pierce: st.pierce, bounce: st.bounce, homing: st.homing, freeze: st.freeze, explode: st.explode, hit: [] });
    }
    this.emit({ k: 'shot', id: p.id, x: p.x, y: p.y });
  }

  enemyShot(e, a, speed = 260, r = 7) {
    this.shots.push({ id: ++this.seq, enemy: true, x: e.x + Math.cos(a) * (ENEMIES[e.type].r + 4), y: e.y + Math.sin(a) * (ENEMIES[e.type].r + 4), vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: 3, r, hit: [] });
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

  stepEnemies(dt) {
    const solidNoObst = this.layout.walls; // ghosts drift through rocks, not through walls
    for (const e of this.enemies) {
      const d = ENEMIES[e.type];
      if (this.t < e.wake) continue;
      const [p, dist] = this.nearestPlayer(e);
      if (!p) continue;
      const slow = this.t < e.slow ? 0.55 : 1;
      const toP = Math.atan2(p.y - e.y, p.x - e.x);
      e.face = Math.cos(toP) >= 0 ? 1 : -1;
      let mx = 0, my = 0, speed = d.speed * slow;
      e.cd -= dt * slow;
      switch (e.type) {
        case 'slime': mx = Math.cos(toP); my = Math.sin(toP); speed *= 0.75 + 0.35 * Math.abs(Math.sin(this.t * 3 + e.id)); break;
        case 'bat': { const w = Math.sin(this.t * 6 + e.id) * 1.2; mx = Math.cos(toP + w); my = Math.sin(toP + w); break; }
        case 'spider': // waits, then lunges
          if (e.ai.lunge > this.t) { mx = Math.cos(e.ai.la); my = Math.sin(e.ai.la); speed = 360 * slow; }
          else if (e.cd <= 0) { e.cd = 1.8 + Math.random(); e.ai.lunge = this.t + 0.45; e.ai.la = toP; }
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
          if (e.cd <= 0) { e.cd = 2.6; for (let k = 0; k < 14; k++) this.enemyShot(e, (k / 14) * Math.PI * 2 + this.t, 200, 9); }
          if ((e.ai.spawn ??= this.t + 5) < this.t) { e.ai.spawn = this.t + 6; for (let k = 0; k < 2; k++) this.addEnemy('slime', e.x + (k ? 50 : -50), e.y + 40, e.room, this.scale() * 0.8); }
          break;
        case 'cyclops':
          if (e.ai.charge > this.t) { mx = Math.cos(e.ai.ca); my = Math.sin(e.ai.ca); speed = 420 * slow; }
          else {
            mx = Math.cos(toP) * 0.5; my = Math.sin(toP) * 0.5;
            if (e.cd <= 0) { e.cd = 1.3; for (const k of [-0.25, 0, 0.25]) this.enemyShot(e, toP + k, 280, 9); }
            if ((e.ai.next ??= this.t + 4) < this.t) { e.ai.next = this.t + 5; e.ai.charge = this.t + 0.8; e.ai.ca = toP; this.emit({ k: 'roar', x: e.x, y: e.y }); }
          }
          break;
        case 'archdemon':
          mx = Math.cos(toP) * 0.4; my = Math.sin(toP) * 0.4;
          if ((e.ai.spiral ??= 0) <= this.t) { e.ai.spiral = this.t + 0.16; e.phase += 0.45; this.enemyShot(e, e.phase, 200, 8); this.enemyShot(e, e.phase + Math.PI, 200, 8); }
          if (e.cd <= 0) { e.cd = 3.6; for (let k = 0; k < 18; k++) this.enemyShot(e, (k / 18) * Math.PI * 2, 170, 10); }
          break;
      }
      // move (bosses and ghosts are big / float, the rest bump into rocks)
      const q = { x: e.x, y: e.y, vx: e.vx, vy: e.vy };
      move(q, { mx, my }, dt, d.flies ? solidNoObst : this.solid, speed, true, d.r);
      // keep monsters inside their room
      const [ix, iy, iw, ih] = interior(this.layout.rooms[e.room]);
      q.x = clamp(q.x, ix + d.r, ix + iw - d.r); q.y = clamp(q.y, iy + d.r, iy + ih - d.r);
      e.x = q.x; e.y = q.y; e.vx = q.vx; e.vy = q.vy;
      // touching a player hurts them
      for (const o of this.players.values()) if (o.alive && Math.hypot(o.x - e.x, o.y - e.y) < PR + d.r - 2) this.hurt(o, e.x, e.y);
    }
  }

  hurt(p, fx, fy) {
    if (this.t < p.inv || !p.alive) return;
    p.hp -= 1;
    p.inv = this.t + 1.1;
    const d = Math.hypot(p.x - fx, p.y - fy) || 1;
    p.x += ((p.x - fx) / d) * 26; p.y += ((p.y - fy) / d) * 26;
    collide(p, this.solid);
    this.emit({ k: 'hurt', id: p.id, x: p.x, y: p.y });
    if (p.hp <= 0) { p.hp = 0; p.alive = false; this.emit({ k: 'down', id: p.id, x: p.x, y: p.y }); }
  }

  damageEnemy(e, dmg, by, shot) {
    if (this.t < e.wake) return;
    e.hp -= dmg;
    if (shot?.freeze) e.slow = this.t + 1.2 + 0.4 * shot.freeze;
    this.emit({ k: 'ehit', id: e.id, x: e.x, y: e.y, dmg: Math.round(dmg) });
    if (e.hp > 0) return;
    this.enemies = this.enemies.filter(o => o !== e);
    const p = this.players.get(by);
    if (p) { p.kills++; if (p.st.vamp && Math.random() < 0.06 * p.st.vamp && p.hp < p.st.maxHp) { p.hp++; this.emit({ k: 'heal', id: p.id }); } }
    this.kills++;
    this.emit({ k: 'edie', id: e.id, type: e.type, x: e.x, y: e.y });
    if (ENEMIES[e.type].boss) { this.emit({ k: 'bossdown', x: e.x, y: e.y }); this.enemies = this.enemies.filter(o => o.room !== e.room); }
    else if (Math.random() < 0.18) this.drop('coin', e.x, e.y);
  }

  stepShots(dt) {
    const keep = [];
    for (const s of this.shots) {
      // homing: turn toward the nearest monster
      if (s.homing && !s.enemy) {
        let best = null, bd = 260;
        for (const e of this.enemies) { const d = Math.hypot(e.x - s.x, e.y - s.y); if (d < bd && this.t >= e.wake) { bd = d; best = e; } }
        if (best) {
          const a = Math.atan2(s.vy, s.vx), want = Math.atan2(best.y - s.y, best.x - s.x);
          let da = Math.atan2(Math.sin(want - a), Math.cos(want - a));
          const na = a + Math.max(-1, Math.min(1, da)) * Math.min(1, 4 * s.homing * dt);
          s.vx = Math.cos(na) * SHOT_SPEED; s.vy = Math.sin(na) * SHOT_SPEED;
        }
      }
      const px = s.x, py = s.y;
      s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt;
      let alive = s.life > 0;
      if (alive && hitsSolid(s.x, s.y, s.enemy ? this.solid : this.solid)) {
        if (!s.enemy && s.bounce > 0) {
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
          this.hurt(p, s.x - s.vx * 0.05, s.y - s.vy * 0.05);
          alive = false; break;
        }
      } else if (alive) {
        for (const e of this.enemies) {
          if (s.hit.includes(e.id) || this.t < e.wake) continue;
          if (Math.hypot(e.x - s.x, e.y - s.y) > ENEMIES[e.type].r + s.r) continue;
          s.hit.push(e.id);
          this.damageEnemy(e, s.dmg, s.owner, s);
          if (s.pierce > 0) s.pierce--; else { alive = false; break; }
        }
      }
      if (!alive && !s.enemy && s.explode) this.blast(s.x, s.y, 38 + 14 * s.explode, s.dmg * 0.6, s.owner);
      if (!alive && !s.enemy) this.emit({ k: 'poof', x: s.x, y: s.y });
      if (alive) keep.push(s);
    }
    this.shots = keep;
  }

  blast(x, y, r, dmg, by) {
    this.emit({ k: 'boom', x, y, r });
    for (const e of this.enemies.slice()) if (Math.hypot(e.x - x, e.y - y) < r + ENEMIES[e.type].r) this.damageEnemy(e, dmg, by);
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
        for (const e of this.enemies) {
          if (Math.hypot(e.x - ox, e.y - oy) > ENEMIES[e.type].r + 10) continue;
          if ((e.ai.orbHit || 0) > this.t) continue;
          e.ai.orbHit = this.t + 0.3;
          this.damageEnemy(e, 8, p.id);
        }
        this.shots = this.shots.filter(s => !(s.enemy && Math.hypot(s.x - ox, s.y - oy) < 14));
      }
    }
  }

  touchPickups(p) {
    for (const u of this.pickups.slice()) {
      if (Math.hypot(u.x - p.x, u.y - p.y) > PR + 14) continue;
      if (u.type === 'heart') { if (p.hp >= p.st.maxHp) continue; p.hp = Math.min(p.st.maxHp, p.hp + 2); }
      else if (u.type === 'coin') this.coins++;
      this.pickups = this.pickups.filter(o => o !== u);
      this.emit({ k: 'pick', id: p.id, type: u.type, x: u.x, y: u.y });
    }
    for (const d of this.pedestals.slice()) {
      if (Math.hypot(d.x - p.x, d.y - p.y) > PR + 18) continue;
      const set = this.pedestals.filter(o => o.set === d.set);
      if (set.some(o => o.takenBy.includes(p.id))) continue; // one item per set for each player
      applyItem(p.st, d.item);
      if (d.item === 'heart') p.hp = Math.min(p.st.maxHp, p.hp + 2);
      p.items.push(d.item);
      d.takenBy.push(p.id);
      (p.tookSets ||= []).push(d.set);
      this.pedestals = this.pedestals.filter(o => o !== d);
      this.emit({ k: 'item', id: p.id, item: d.item, x: d.x, y: d.y });
      // once everyone has picked from this set, the rest disappear
      const takers = new Set(set.flatMap(o => o.takenBy).concat(p.id));
      if (this.alivePlayers().every(o => takers.has(o.id))) this.pedestals = this.pedestals.filter(o => o.set !== d.set);
    }
  }
}
