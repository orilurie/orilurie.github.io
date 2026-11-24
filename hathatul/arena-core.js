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
};
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
  },
  { name: 'עמודים', walls: pillars() },
  {
    name: 'מסדרונות',
    walls: [
      [200, 320, 480, 36], [920, 320, 480, 36], [200, 644, 480, 36], [920, 644, 480, 36],
      [782, 120, 36, 230], [782, 650, 36, 230], [500, 470, 36, 60], [1064, 470, 36, 60],
    ],
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
export function move(p, input, dt, walls, speedMul = 1) {
  let mx = input.mx || 0, my = input.my || 0;
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  p.x += mx * SPEED * speedMul * dt;
  p.y += my * SPEED * speedMul * dt;
  collide(p, walls);
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

// The bullets of one shot: one, or a fan of three with the triple-shot buff.
export function shotBullets(x, y, aim, triple) {
  const angles = triple ? [aim - 0.16, aim, aim + 0.16] : [aim];
  return angles.map(a => ({
    x: x + Math.cos(a) * (R + 6), y: y + Math.sin(a) * (R + 6),
    vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED, life: BULLET_LIFE,
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
