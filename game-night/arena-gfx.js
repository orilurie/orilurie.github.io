// זירה – graphics: sprites and effects from Kenney's "Top-down Shooter" and "Particle Pack"
// (both CC0, see arena-gfx/LICENSE-*), plus pseudo-3D walls and soft lighting.

const BASE = 'arena-gfx/';
const imgs = {};
const load = n => {
  if (!imgs[n]) { const i = new Image(); i.src = `${BASE}${n}.png`; imgs[n] = i; }
  return imgs[n];
};
const ready = i => i && i.complete && i.naturalWidth > 0;

// One character per seat (by colour order); bots are robots. The colour shows as a ring.
export const CHARACTERS = ['hitman1', 'manBlue', 'womanGreen', 'manBrown', 'survivor1', 'soldier1'];
const POSE = { pistol: 'gun', smg: 'machine', shotgun: 'silencer', sniper: 'silencer' };
const MAP_LOOK = [
  { floor: 'tile_01', wall: 'tile_69', front: '#7a3b1c', tint: 'rgba(40,70,30,0.10)', deco: 'tile_213' }, // מבצר: grass, bricks
  { floor: 'tile_05', wall: 'tile_96', front: '#8a6a45', tint: 'rgba(80,50,20,0.10)' }, // עמודים: dirt, sand bricks
  { floor: 'tile_08', wall: 'tile_42', front: '#6b4a2a', tint: 'rgba(30,40,60,0.12)' }, // מסדרונות: concrete, wood
];
export const WALL_H = 16; // how tall walls look

export function preload() {
  for (const c of [...CHARACTERS, 'robot1']) for (const p of new Set(Object.values(POSE))) load(`${c}_${p}`);
  for (const m of MAP_LOOK) { load(m.floor); load(m.wall); if (m.deco) load(m.deco); }
  for (const n of ['tile_183', 'muzzle_02', 'smoke_04', 'light_02', 'circle_05', 'scorch_01', 'dirt_01', 'spark_05', 'trace_07', 'trace_01', 'bulletSand1', 'bulletSand2', 'bulletDark3']) load(n);
}

// white particle textures, tinted once per colour
const tinted = new Map();
export function tint(name, color) {
  const key = name + color;
  if (tinted.has(key)) return tinted.get(key);
  const i = load(name);
  if (!ready(i)) return null;
  const c = document.createElement('canvas');
  c.width = i.naturalWidth; c.height = i.naturalHeight;
  const x = c.getContext('2d');
  x.drawImage(i, 0, 0);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  tinted.set(key, c);
  return c;
}

const patterns = new Map();
function pattern(g, name) {
  if (patterns.has(name)) return patterns.get(name);
  const i = load(name);
  if (!ready(i)) return null;
  const p = g.createPattern(i, 'repeat');
  patterns.set(name, p);
  return p;
}

// floor of the arena, with a few decorations scattered (same every time for a map)
export function drawFloor(g, map, W, H) {
  const look = MAP_LOOK[map] || MAP_LOOK[0];
  const p = pattern(g, look.floor);
  g.fillStyle = p || '#1c2436';
  g.fillRect(0, 0, W, H);
  g.fillStyle = look.tint;
  g.fillRect(0, 0, W, H);
  if (look.deco && ready(load(look.deco))) {
    let s = 7 + map * 13;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    g.globalAlpha = 0.55;
    for (let i = 0; i < 40; i++) g.drawImage(load(look.deco), rnd() * W - 24, rnd() * H - 24, 40, 40);
    g.globalAlpha = 1;
  }
  // soft darker edge
  const grd = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.6);
  grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 10;
  g.strokeRect(-5, -5, W + 10, H + 10);
}

// Walls with height: a shadow, a darker front face and a textured top. Draw them after the
// players, so someone standing behind a wall is partly hidden by it, like in a 3D view.
export function drawWalls(g, map, walls) {
  const look = MAP_LOOK[map] || MAP_LOOK[0];
  g.fillStyle = 'rgba(0,0,0,0.32)';
  for (const [x, y, w, h] of walls) g.fillRect(x + 8, y + 6, w, h);
  for (const [x, y, w, h] of walls) {
    g.fillStyle = look.front;
    g.fillRect(x, y + h - WALL_H, w, WALL_H);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(x, y + h - 4, w, 4);
  }
  const p = pattern(g, look.wall);
  for (const [x, y, w, h] of walls) {
    g.fillStyle = p || '#56668f';
    g.fillRect(x, y - WALL_H, w, h);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(x, y - WALL_H, w, 3);
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 2;
    g.strokeRect(x + 1, y - WALL_H + 1, w - 2, h - 2);
  }
}

export function drawBush(g, x, y, r, now, faded) {
  const i = load('tile_183');
  g.globalAlpha = faded ? 0.5 : 1;
  if (ready(i)) {
    const sway = Math.sin(now / 900 + x) * 0.04;
    g.save(); g.translate(x, y); g.rotate(sway + x);
    g.drawImage(i, -r * 1.18, -r * 1.18, r * 2.36, r * 2.36);
    g.restore();
  } else {
    g.fillStyle = '#3a8f52'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
}

// A character sprite, turned to where it aims, with a coloured ring at its feet.
// o: { x, y, aim, w (weapon), moving (0..1), dash, flash (0..1), bot }
export function drawCharacter(g, o, seat, color, now) {
  const name = `${o.bot ? 'robot1' : CHARACTERS[seat % CHARACTERS.length]}_${POSE[o.w] || 'gun'}`;
  const i = load(name);
  // shadow + ring
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.beginPath(); g.ellipse(o.x + 3, o.y + 6, 19, 15, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = color; g.lineWidth = 4; g.globalAlpha = 0.9;
  g.beginPath(); g.arc(o.x, o.y, 21, 0, Math.PI * 2); g.stroke();
  g.globalAlpha = 1;
  if (!ready(i)) return false;
  const bob = 1 + Math.sin(now / 70) * 0.045 * (o.moving || 0); // a little step bounce
  const sx = o.dash ? 1.25 : bob, sy = o.dash ? 0.82 : 2 - bob;
  g.save();
  g.translate(o.x, o.y);
  g.rotate(o.aim);
  g.scale(sx, sy);
  const w = i.naturalWidth, h = i.naturalHeight;
  g.drawImage(i, -17, -h / 2, w, h); // the body's centre sits ~17 px from the sprite's left
  if (o.w === 'sniper') { g.fillStyle = '#2b2f38'; g.fillRect(w - 20, -2.5, 16, 5); } // longer barrel
  if (o.flash > 0) {
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = o.flash;
    g.drawImage(i, -17, -h / 2, w, h);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
  }
  g.restore();
  return true;
}

export function drawMuzzle(g, x, y, a, big, life) {
  const t = tint('muzzle_02', '#ffe08a');
  if (!t) return;
  const s = (big ? 70 : 48) * (0.7 + life * 5);
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.translate(x + Math.cos(a) * 34, y + Math.sin(a) * 34);
  g.rotate(a);
  g.drawImage(t, -s * 0.2, -s / 2, s, s);
  g.restore();
}

export function drawGlow(g, x, y, r, color, alpha = 1) {
  const t = tint('circle_05', color);
  if (!t) return;
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.globalAlpha = alpha;
  g.drawImage(t, x - r, y - r, r * 2, r * 2);
  g.restore();
}

export function drawSprite(g, name, color, x, y, size, rot = 0, alpha = 1, additive = false) {
  const t = tint(name, color);
  if (!t) return;
  g.save();
  if (additive) g.globalCompositeOperation = 'lighter';
  g.globalAlpha = alpha;
  g.translate(x, y); g.rotate(rot);
  g.drawImage(t, -size / 2, -size / 2, size, size);
  g.restore();
}

// Soft lighting: the dark is drawn at low resolution and scaled up, which blurs the edges of
// what you can see for free. lights: [{ x, y, r, a }] in world units, poly: the view polygon.
const lightCanvas = document.createElement('canvas');
export function drawDarkness(g, view, cw, ch, dpr, poly, lights) {
  const k = 0.25;
  const lw = Math.max(1, Math.round(cw * k)), lh = Math.max(1, Math.round(ch * k));
  if (lightCanvas.width !== lw || lightCanvas.height !== lh) { lightCanvas.width = lw; lightCanvas.height = lh; }
  const L = lightCanvas.getContext('2d');
  L.setTransform(1, 0, 0, 1, 0, 0);
  L.globalCompositeOperation = 'source-over';
  L.clearRect(0, 0, lw, lh);
  L.fillStyle = 'rgba(4,7,16,0.74)';
  L.fillRect(0, 0, lw, lh);
  L.setTransform(view.s * k, 0, 0, view.s * k, (cw / 2 - view.x * view.s) * k, (ch / 2 - view.y * view.s) * k);
  L.globalCompositeOperation = 'destination-out';
  if (poly) {
    L.fillStyle = '#000';
    L.beginPath();
    L.moveTo(poly[0], poly[1]);
    for (let i = 2; i < poly.length; i += 2) L.lineTo(poly[i], poly[i + 1]);
    L.closePath();
    L.fill();
  }
  for (const l of lights) {
    const grd = L.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r);
    grd.addColorStop(0, `rgba(0,0,0,${l.a})`); grd.addColorStop(1, 'rgba(0,0,0,0)');
    L.fillStyle = grd;
    L.beginPath(); L.arc(l.x, l.y, l.r, 0, Math.PI * 2); L.fill();
  }
  g.save();
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(lightCanvas, 0, 0, cw, ch);
  g.restore();
}

// A bullet: a glowing tracer streak in the shooter's colour behind a brass slug.
// The look depends on the weapon (sniper: long thin streak, shotgun: short pellets).
const BULLET_LOOK = {
  pistol: { head: 'bulletSand1', hw: 5, hh: 13, trace: 'trace_07', len: 64, wid: 22 },
  smg: { head: 'bulletSand1', hw: 4, hh: 10, trace: 'trace_07', len: 46, wid: 18 },
  shotgun: { head: 'bulletSand2', hw: 5, hh: 7, trace: 'trace_07', len: 30, wid: 16 },
  sniper: { head: 'bulletDark3', hw: 4, hh: 18, trace: 'trace_01', len: 160, wid: 26 },
};
export function drawBullet(g, x, y, vx, vy, color, weapon) {
  const L = BULLET_LOOK[weapon] || BULLET_LOOK.pistol;
  const a = Math.atan2(vy, vx);
  const tr = tint(L.trace, color);
  const head = load(L.head);
  g.save();
  g.translate(x, y);
  g.rotate(a + Math.PI / 2); // sprites point up
  if (tr) {
    g.globalCompositeOperation = 'lighter';
    g.drawImage(tr, -L.wid / 2, 0, L.wid, L.len); // streak trails behind (down = backwards)
    g.globalCompositeOperation = 'source-over'; // a normal pass too, so the colour shows on light floors
    g.globalAlpha = 0.55;
    g.drawImage(tr, -L.wid / 2, 0, L.wid, L.len);
    g.globalAlpha = 1;
  }
  if (ready(head)) g.drawImage(head, -L.hw / 2, -L.hh / 2, L.hw, L.hh);
  g.restore();
  drawGlow(g, x, y, weapon === 'sniper' ? 20 : 14, color, 0.45);
}

// sparks where a bullet hits a wall
export function drawSpark(g, x, y, size, rot, alpha) {
  drawSprite(g, 'spark_05', '#ffd98a', x, y, size, rot, alpha, true);
}
