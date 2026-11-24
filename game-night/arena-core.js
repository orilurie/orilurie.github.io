// זירה (Arena) – shared simulation used by the game server (Cloudflare Durable Object) and by the
// browser for client-side prediction. No imports: the server bundles this file as is.

export const W = 1600, H = 1000; // world size
export const R = 18; // player radius
export const SPEED = 240; // units / second
export const BULLET_SPEED = 780;
export const BULLET_R = 5;
export const BULLET_LIFE = 0.85; // seconds
export const FIRE_CD = 0.45; // seconds between shots
export const DMG = 25;
export const MAX_HP = 100;
export const TICK = 1 / 30;
export const MAX_PLAYERS = 6;
export const DM_TIME = 150; // free-for-all round length, seconds
export const RESPAWN = 2.5;
export const SPAWN_SHIELD = 1.2; // seconds of spawn protection
export const COLORS = ['#ff5d5d', '#4da3ff', '#3ccf7a', '#ffb02e', '#b36bff', '#ff6fc8'];
export const PICKUPS = {
  heal: { icon: '❤️', name: 'חיים' },
  shield: { icon: '🛡️', name: 'מגן' },
  triple: { icon: '🔱', name: 'ירייה משולשת' },
  speed: { icon: '⚡', name: 'מהירות' },
  smg: { icon: '🔥', name: 'תת־מקלע', weapon: true },
  shotgun: { icon: '💥', name: 'רובה ציד', weapon: true },
  sniper: { icon: '🎯', name: 'רובה צלפים', weapon: true },
};

// Weapons: you always have the pistol; a weapon pickup replaces it until its ammo runs out.
// spread: fixed fan for shotgun pellets; jitter: a small repeating pattern for the SMG.
export const WEAPONS = {
  pistol: { name: 'אקדח', icon: '🔫', cd: 0.45, dmg: 25, speed: 780, life: 0.85, pellets: 1, spread: 0, jitter: 0, ammo: Infinity, kick: 3, push: 8 },
  smg: { name: 'תת־מקלע', icon: '🔥', cd: 0.12, dmg: 11, speed: 820, life: 0.6, pellets: 1, spread: 0, jitter: 0.08, ammo: 45, kick: 1.5, push: 4 },
  shotgun: { name: 'רובה ציד', icon: '💥', cd: 0.85, dmg: 13, speed: 700, life: 0.34, pellets: 6, spread: 0.45, jitter: 0, ammo: 8, kick: 7, push: 14 },
  sniper: { name: 'רובה צלפים', icon: '🎯', cd: 1.25, dmg: 70, speed: 1500, life: 0.75, pellets: 1, spread: 0, jitter: 0, ammo: 5, kick: 8, push: 30 },
};
export const WEAPON_LIST = Object.keys(WEAPONS); // index sent over the wire
export const DASH = { time: 0.16, speed: 3.4, cd: 3 }; // a quick dodge
export const BUSH_REVEAL = 90; // in a bush you're hidden unless someone is this close (or you just fired)
export const BUFF_TIME = { triple: 8, speed: 6 };

const pillars = () => {
  const out = [];
  [300, 550, 800, 1050, 1300].forEach((x, i) => [250, 500, 750].forEach((y, j) => {
    if ((i + j) % 2 === 0 && !(x === 800 && y === 500)) out.push([x - 35, y - 35, 70, 70]);
  }));
  out.push([760, 460, 80, 80]);
  return out;
};
export const MAPS = [
  {
    name: 'מבצר',
    walls: [
      [740, 440, 120, 120],
      [300, 200, 200, 40], [300, 200, 40, 160], [1100, 200, 200, 40], [1260, 200, 40, 160],
      [300, 760, 200, 40], [300, 640, 40, 160], [1100, 760, 200, 40], [1260, 640, 40, 160],
      [780, 110, 40, 180], [780, 710, 40, 180], [120, 480, 160, 40], [1320, 480, 160, 40],
    ],
    bushes: [[560, 500, 56], [1040, 500, 56], [180, 150, 52], [1420, 850, 52], [180, 850, 52], [1420, 150, 52]],
  },
  {
    name: 'עמודים', walls: pillars(),
    bushes: [[550, 250, 52], [1050, 750, 52], [300, 500, 50], [1300, 500, 50], [550, 750, 46], [1050, 250, 46]],
  },
  {
    name: 'מסדרונות',
    walls: [
      [200, 320, 480, 36], [920, 320, 480, 36], [200, 644, 480, 36], [920, 644, 480, 36],
      [782, 120, 36, 230], [782, 650, 36, 230], [500, 470, 36, 60], [1064, 470, 36, 60],
    ],
    bushes: [[300, 180, 52], [1300, 820, 52], [300, 820, 52], [1300, 180, 52], [800, 500, 58]],
  },
];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Pushes a circle out of every wall and keeps it inside the world.
export function collide(p, walls, r = R) {
  for (const [x, y, w, h] of walls) {
    const cx = clamp(p.x, x, x + w), cy = clamp(p.y, y, y + h);
    let dx = p.x - cx, dy = p.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r) continue;
    if (d2 > 1e-6) {
      const d = Math.sqrt(d2);
      p.x = cx + (dx / d) * r;
      p.y = cy + (dy / d) * r;
    } else { // centre inside the wall: leave by the nearest side
      const opts = [[p.x - x + r, -1, 0], [x + w - p.x + r, 1, 0], [p.y - y + r, 0, -1], [y + h - p.y + r, 0, 1]];
      opts.sort((a, b) => a[0] - b[0]);
      p.x += opts[0][1] * opts[0][0];
      p.y += opts[0][2] * opts[0][0];
    }
  }
  p.x = clamp(p.x, r, W - r);
  p.y = clamp(p.y, r, H - r);
}

// One movement step. input.mx/my is a joystick vector (length ≤ 1).
// Movement is quick but not instant: you reach ~90% speed in about 0.08 s and stop just as fast
// (crisp, with a touch of weight). Sliding along walls comes from the circle collision; speed
// into a wall is dropped so you don't "stick" to it. instant: skip the ramp (dash, bot probes).
export const ACCEL = 28;
export function move(p, input, dt, walls, speedMul = 1, instant = false) {
  let mx = input.mx || 0, my = input.my || 0;
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  const tvx = mx * SPEED * speedMul, tvy = my * SPEED * speedMul;
  const k = instant ? 1 : 1 - Math.exp(-ACCEL * dt);
  p.vx = (p.vx || 0) + (tvx - (p.vx || 0)) * k;
  p.vy = (p.vy || 0) + (tvy - (p.vy || 0)) * k;
  const x0 = p.x, y0 = p.y, ex = x0 + p.vx * dt, ey = y0 + p.vy * dt;
  p.x = ex; p.y = ey;
  collide(p, walls);
  if (dt > 0 && (Math.abs(p.x - ex) > 0.01 || Math.abs(p.y - ey) > 0.01)) { p.vx = (p.x - x0) / dt; p.vy = (p.y - y0) / dt; }
}

export const insideWall = (x, y, walls, pad = 0) =>
  walls.some(([wx, wy, w, h]) => x > wx - pad && x < wx + w + pad && y > wy - pad && y < wy + h + pad);

// Does the segment a→b cross a wall? (sampled; walls are at least 36 units thick)
export function blocked(ax, ay, bx, by, walls) {
  const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / 12);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (insideWall(ax + (bx - ax) * t, ay + (by - ay) * t, walls)) return true;
  }
  return false;
}

// Distance from point p to segment a→b.
export function segDist(ax, ay, bx, by, px, py) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
  return Math.hypot(ax + dx * t - px, ay + dy * t - py);
}

export const inBush = (x, y, map) => (MAPS[map].bushes || []).some(([bx, by, br]) => Math.hypot(x - bx, y - by) < br);

const JITTER = [0, 0.6, -0.6, 0.3, -0.9, 0.9, -0.3];
// The bullets of one shot. triple (buff) fans single-bullet weapons into three.
export function shotBullets(x, y, aim, triple, weapon = 'pistol', shotNo = 0) {
  const w = WEAPONS[weapon] || WEAPONS.pistol;
  let angles;
  if (w.pellets > 1) angles = Array.from({ length: w.pellets }, (_, i) => aim - w.spread / 2 + (w.spread * i) / (w.pellets - 1));
  else {
    const a = aim + JITTER[shotNo % JITTER.length] * w.jitter;
    angles = triple ? [a - 0.16, a, a + 0.16] : [a];
  }
  return angles.map(a => ({
    x: x + Math.cos(a) * (R + 6), y: y + Math.sin(a) * (R + 6),
    vx: Math.cos(a) * w.speed, vy: Math.sin(a) * w.speed, life: w.life, dmg: w.dmg, w: weapon,
  }));
}

// Moves a bullet; returns false when it hits a wall, leaves the world or runs out.
export function stepBullet(b, dt, walls) {
  b.px = b.x; b.py = b.y;
  b.x += b.vx * dt; b.y += b.vy * dt;
  b.life -= dt;
  if (b.life <= 0 || b.x < 0 || b.y < 0 || b.x > W || b.y > H) return false;
  const mx = (b.px + b.x) / 2, my = (b.py + b.y) / 2;
  return !insideWall(b.x, b.y, walls) && !insideWall(mx, my, walls);
}

// ---------- vision ----------
// You see a cone in front of you (where you aim) and a small circle around you; walls block it.
export const FOV = 1.9; // radians (~110°)
export const VIEW_RANGE = 720;
export const NEAR = 115;
export const STEP = 42; // a footstep every this many units walked

export function canSee(vx, vy, aim, tx, ty, walls) {
  const dx = tx - vx, dy = ty - vy, d = Math.hypot(dx, dy);
  if (d > VIEW_RANGE + R) return false;
  if (d > NEAR + R) {
    let da = Math.atan2(dy, dx) - aim;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    if (Math.abs(da) > FOV / 2 + Math.atan2(R, d)) return false;
  }
  return !blocked(vx, vy, tx, ty, walls);
}

// Distance along a ray until it hits a wall or the world's edge.
export function rayDist(x, y, a, walls, max) {
  const dx = Math.cos(a), dy = Math.sin(a);
  let best = max;
  const slab = (rx, ry, rw, rh) => {
    let t0 = 0, t1 = best;
    for (const [o, d, lo, hi] of [[x, dx, rx, rx + rw], [y, dy, ry, ry + rh]]) {
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return; continue; }
      let ta = (lo - o) / d, tb = (hi - o) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return;
    }
    if (t0 > 0 && t0 < best) best = t0;
  };
  for (const [rx, ry, rw, rh] of walls) slab(rx, ry, rw, rh);
  if (dx > 0) best = Math.min(best, (W - x) / dx); else if (dx < 0) best = Math.min(best, -x / dx);
  if (dy > 0) best = Math.min(best, (H - y) / dy); else if (dy < 0) best = Math.min(best, -y / dy);
  return Math.max(0, best);
}
