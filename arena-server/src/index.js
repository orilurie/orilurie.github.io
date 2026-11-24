// Game server for "זירה" – a real-time top-down arena shooter.
// One Durable Object per room runs the authoritative simulation at 30 ticks/second and streams
// snapshots to the players over WebSockets; a single Matchmaker object tracks rooms for "quick play".

import {
  W, H, R, SPEED, BULLET_R, FIRE_CD, DMG, MAX_HP, TICK, MAX_PLAYERS, DM_TIME, RESPAWN, SPAWN_SHIELD,
  COLORS, MAPS, BUFF_TIME, BULLET_SPEED, move, collide, insideWall, blocked, segDist, shotBullets, stepBullet,
} from '../../hathatul/arena-core.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const randCode = () => Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
const validCode = c => /^[A-Z]{4}$/.test(c || '');

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const mm = env.MM.get(env.MM.idFromName('main'));
    if (url.pathname === '/api/quick' || url.pathname === '/api/new' || url.pathname === '/api/check') {
      const r = await mm.fetch(`https://mm${url.pathname.slice(4)}${url.search}`);
      return json(await r.json());
    }
    const m = url.pathname.match(/^\/ws\/([A-Z]{4})$/);
    if (m) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const room = env.ROOM.get(env.ROOM.idFromName(m[1]));
      const headers = new Headers(req.headers);
      headers.set('x-code', m[1]);
      return room.fetch(new Request(req.url, { headers }));
    }
    if (url.pathname === '/') return json({ ok: true, game: 'arena' });
    return json({ error: 'not found' }, 404);
  },
};

// ---------------------------------------------------------------------------------------------
export class Matchmaker {
  constructor(state) { this.rooms = new Map(); } // code -> { pub, humans, phase, mode, t }

  fresh(r) { return Date.now() - r.t < 25000; }

  async fetch(req) {
    const url = new URL(req.url);
    for (const [c, r] of this.rooms) if (!this.fresh(r)) this.rooms.delete(c);
    if (url.pathname === '/report') {
      const r = await req.json();
      if (r.closed) this.rooms.delete(r.code);
      else this.rooms.set(r.code, { ...r, t: Date.now() });
      return json({ ok: true });
    }
    if (url.pathname === '/check') {
      const r = this.rooms.get((url.searchParams.get('code') || '').toUpperCase());
      return json(r ? { exists: true, humans: r.humans, phase: r.phase } : { exists: false });
    }
    const reserve = pub => {
      let code;
      do code = randCode(); while (this.rooms.has(code));
      this.rooms.set(code, { code, pub, humans: 0, phase: 'lobby', mode: 'dm', t: Date.now(), reserved: true });
      return code;
    };
    if (url.pathname === '/new') return json({ code: reserve(false) });
    if (url.pathname === '/quick') {
      const open = [...this.rooms.values()]
        .filter(r => r.pub && r.humans < MAX_PLAYERS && (r.phase === 'lobby' || r.phase === 'count' || (r.phase === 'play' && r.mode === 'dm')))
        .sort((a, b) => b.humans - a.humans);
      return json({ code: open[0]?.code || reserve(true) });
    }
    return json({ error: 'not found' }, 404);
  }
}

// ---------------------------------------------------------------------------------------------
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const BOT_NAMES = ['רובי', 'צ׳יפ', 'ביפ', 'זיגי', 'טורבו'];
const PICKUP_TYPES = ['heal', 'heal', 'shield', 'triple', 'speed'];

export class Room {
  constructor(state, env) {
    this.env = env;
    this.code = null;
    this.pub = false;
    this.players = new Map(); // id -> player
    this.sockets = new Map(); // ws -> id
    this.host = null;
    this.phase = 'lobby';
    this.mode = 'dm';
    this.mapPick = -1; // -1 random
    this.botCount = 0;
    this.map = 0;
    this.bullets = [];
    this.pickups = [];
    this.events = [];
    this.timer = null;
    this.t = 0; // game clock (seconds)
    this.tickNo = 0;
    this.seq = 0;
    this.results = null;
    this.lastReport = 0;
  }

  get walls() { return MAPS[this.map].walls; }
  humans() { return [...this.players.values()].filter(p => !p.bot); }
  participants() { return [...this.players.values()].filter(p => p.inRound); }

  async fetch(req) {
    this.code ||= req.headers.get('x-code');
    if (new URL(req.url).searchParams.get('pub') === '1') this.pub = true;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.addEventListener('message', e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      try { this.onMessage(server, msg); } catch (err) { this.sendTo(server, { t: 'err', m: 'שגיאת שרת' }); }
    });
    const gone = () => this.onClose(server);
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    this.ensureTimer();
    return new Response(null, { status: 101, webSocket: client });
  }

  sendTo(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch {} }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.sockets.keys()) { try { ws.send(s); } catch {} }
  }

  ensureTimer() {
    if (this.timer) return;
    this.last = Date.now();
    this.acc = 0;
    this.timer = setInterval(() => this.loop(), 1000 / 30);
  }

  loop() {
    const now = Date.now();
    this.acc += Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    while (this.acc >= TICK) { this.acc -= TICK; this.tick(); }
    if (now - this.lastReport > 8000) this.report();
    if (this.sockets.size === 0) {
      this.emptySince ||= now;
      if (now - this.emptySince > 30000) { // nobody left: shut the room down
        clearInterval(this.timer);
        this.timer = null;
        this.players.clear();
        this.phase = 'lobby';
        this.report(true);
      }
    } else this.emptySince = 0;
  }

  report(closed = false) {
    this.lastReport = Date.now();
    if (!this.code) return;
    const body = JSON.stringify({ code: this.code, pub: this.pub, humans: this.humans().filter(p => p.on).length, phase: this.phase, mode: this.mode, closed });
    const mm = this.env.MM.get(this.env.MM.idFromName('main'));
    mm.fetch('https://mm/report', { method: 'POST', body }).catch(() => {});
  }

  // ---------- connections ----------
  onMessage(ws, msg) {
    if (msg.t === 'hello') return this.join(ws, msg);
    if (msg.t === 'ping') return this.sendTo(ws, { t: 'pong', c: msg.c });
    const id = this.sockets.get(ws);
    const p = id && this.players.get(id);
    if (!p) return;
    switch (msg.t) {
      case 'in': {
        if (!Number.isFinite(msg.s) || msg.s <= p.lastSeq) return;
        p.lastSeq = msg.s;
        const mx = Number(msg.mx) || 0, my = Number(msg.my) || 0, l = Math.hypot(mx, my);
        p.input = { mx: l > 1 ? mx / l : mx, my: l > 1 ? my / l : my, a: Number(msg.a) || 0, f: !!msg.f };
        return;
      }
      case 'cfg': {
        if (id !== this.host || (this.phase !== 'lobby' && this.phase !== 'end')) return;
        if (msg.mode === 'dm' || msg.mode === 'lms') this.mode = msg.mode;
        if (Number.isInteger(msg.map) && msg.map >= -1 && msg.map < MAPS.length) this.mapPick = msg.map;
        if (Number.isInteger(msg.bots)) this.setBots(msg.bots);
        return this.sendMeta();
      }
      case 'start':
        if (id !== this.host || (this.phase !== 'lobby' && this.phase !== 'end')) return;
        if (this.players.size < 2) return this.sendTo(ws, { t: 'err', m: 'צריך לפחות 2 משתתפים – הוסיפו בוט 🤖' });
        return this.startRound();
      case 'lobby':
        if (id !== this.host || this.phase !== 'end') return;
        this.phase = 'lobby';
        this.results = null;
        return this.sendMeta();
      case 'emoji':
        if (typeof msg.e === 'string' && msg.e.length <= 4) this.broadcast({ t: 'emo', id, e: msg.e });
        return;
    }
  }

  join(ws, msg) {
    const id = String(msg.id || '').slice(0, 20);
    const name = String(msg.name || '').trim().slice(0, 16) || 'שחקן';
    if (!id) return;
    let p = this.players.get(id);
    if (!p) {
      if (this.humans().length >= MAX_PLAYERS) { this.sendTo(ws, { t: 'err', m: 'החדר מלא', fatal: true }); return ws.close(1000, 'full'); }
      // a human replaces a bot when the room is full
      while (this.players.size >= MAX_PLAYERS) this.removeBot();
      p = this.newPlayer(id, name, false);
      if (this.phase === 'count' || (this.phase === 'play' && this.mode === 'dm')) {
        p.inRound = true;
        p.alive = false;
        p.respawnAt = this.t + 1;
      }
    }
    for (const [w, pid] of this.sockets) if (pid === id && w !== ws) { this.sockets.delete(w); try { w.close(1000, 'replaced'); } catch {} }
    p.name = name;
    p.on = true;
    p.offSince = 0;
    this.sockets.set(ws, id);
    if (!this.host || !this.players.get(this.host)?.on) this.host = id;
    this.sendTo(ws, { t: 'welcome', id, code: this.code });
    this.sendMeta();
    if (this.phase !== 'lobby') this.sendSnapshot([ws]);
    this.report();
  }

  onClose(ws) {
    const id = this.sockets.get(ws);
    if (!this.sockets.delete(ws) || !id) return;
    if ([...this.sockets.values()].includes(id)) return;
    const p = this.players.get(id);
    if (!p) return;
    p.on = false;
    p.offSince = Date.now();
    if (this.phase === 'lobby' || this.phase === 'end') this.players.delete(id);
    this.pickHost();
    this.sendMeta();
    this.report();
  }

  pickHost() {
    if (this.players.get(this.host)?.on) return;
    this.host = this.humans().find(p => p.on)?.id || null;
  }

  newPlayer(id, name, bot) {
    const used = new Set([...this.players.values()].map(p => p.color));
    const color = COLORS.find(c => !used.has(c)) || COLORS[this.players.size % COLORS.length];
    const p = {
      id, name, bot, color, on: true, x: W / 2, y: H / 2, aim: 0, hp: MAX_HP, shield: 0, alive: false,
      inRound: false, kills: 0, deaths: 0, cd: 0, lastSeq: 0, input: { mx: 0, my: 0, a: 0, f: false },
      buffs: { triple: 0, speed: 0 }, protect: 0, respawnAt: 0, place: 0,
    };
    if (bot) p.ai = { next: 0, dir: 0, strafe: 1, seen: 0, tx: W / 2, ty: H / 2, prev: {} };
    this.players.set(id, p);
    return p;
  }

  setBots(n) {
    const want = Math.max(0, Math.min(n, MAX_PLAYERS - this.humans().length));
    const bots = () => [...this.players.values()].filter(p => p.bot);
    while (bots().length > want) this.removeBot();
    let i = 0;
    while (bots().length < want) {
      const id = 'bot' + (++i);
      if (this.players.has(id)) continue;
      this.newPlayer(id, `🤖 ${BOT_NAMES[(i - 1) % BOT_NAMES.length]}`, true);
    }
    this.botCount = want;
  }

  removeBot() {
    const b = [...this.players.values()].reverse().find(p => p.bot);
    if (b) this.players.delete(b.id);
    this.botCount = [...this.players.values()].filter(p => p.bot).length;
  }

  // ---------- round flow ----------
  startRound() {
    this.map = this.mapPick >= 0 ? this.mapPick : Math.floor(Math.random() * MAPS.length);
    this.bullets = [];
    this.pickups = [];
    this.results = null;
    this.t = 0;
    this.nextPickup = 4;
    this.deadOrder = [];
    // the zone closes on a random open spot near the middle
    let zx = W / 2, zy = H / 2;
    for (let i = 0; i < 40; i++) {
      const x = W / 2 + (Math.random() - 0.5) * 700, y = H / 2 + (Math.random() - 0.5) * 400;
      if (!insideWall(x, y, MAPS[this.map].walls, 60)) { zx = x; zy = y; break; }
    }
    this.zone = { x: zx, y: zy, r: Math.hypot(W, H) / 2 + 40 };
    for (const p of this.players.values()) {
      Object.assign(p, { kills: 0, deaths: 0, inRound: true, place: 0, buffs: { triple: 0, speed: 0 }, input: { mx: 0, my: 0, a: p.input.a, f: false } });
      this.spawn(p);
    }
    this.phase = 'count';
    this.countEnd = 3;
    this.endAt = 3 + DM_TIME;
    this.emit({ k: 'start' });
    this.sendMeta();
    this.report();
  }

  spawn(p) {
    const others = [...this.players.values()].filter(o => o !== p && o.alive);
    let best = null, bestD = -1;
    for (let i = 0; i < 30; i++) {
      const x = 60 + Math.random() * (W - 120), y = 60 + Math.random() * (H - 120);
      if (insideWall(x, y, this.walls, R + 12)) continue;
      if (this.zone && Math.hypot(x - this.zone.x, y - this.zone.y) > this.zone.r - 60) continue;
      const d = others.length ? Math.min(...others.map(o => Math.hypot(o.x - x, o.y - y))) : 1000;
      if (d > bestD) { bestD = d; best = { x, y }; }
    }
    best ||= { x: W / 2, y: 80 };
    Object.assign(p, best, { hp: MAX_HP, shield: 0, alive: true, protect: this.t + SPAWN_SHIELD, cd: 0.4, buffs: { triple: 0, speed: 0 } });
    collide(p, this.walls);
    this.emit({ k: 'spawn', id: p.id });
  }

  emit(ev) { this.events.push(ev); }

  endRound() {
    this.phase = 'end';
    const ps = this.participants();
    if (this.mode === 'lms') {
      const order = [...ps.filter(p => p.alive), ...this.deadOrder.slice().reverse().map(id => this.players.get(id)).filter(Boolean)];
      order.forEach((p, i) => { p.place = i + 1; });
      ps.forEach(p => { if (!p.place) p.place = order.length + 1; });
    } else {
      const sorted = ps.slice().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
      sorted.forEach((p, i) => { p.place = i > 0 && sorted[i - 1].kills === p.kills && sorted[i - 1].deaths === p.deaths ? sorted[i - 1].place : i + 1; });
    }
    this.results = ps.map(p => ({ id: p.id, name: p.name, color: p.color, kills: p.kills, deaths: p.deaths, place: p.place, bot: p.bot }))
      .sort((a, b) => a.place - b.place);
    this.bullets = [];
    this.emit({ k: 'end' });
    this.sendSnapshot();
    this.sendMeta();
    this.report();
  }

  // ---------- simulation ----------
  tick() {
    // drop players who have been disconnected for a while
    for (const p of [...this.players.values()]) {
      if (!p.bot && !p.on && Date.now() - p.offSince > 20000) {
        this.players.delete(p.id);
        this.pickHost();
        this.sendMeta();
      }
    }
    if (this.phase !== 'count' && this.phase !== 'play') return;
    this.t += TICK;
    this.tickNo++;
    if (this.phase === 'count' && this.t >= this.countEnd) { this.phase = 'play'; this.emit({ k: 'go' }); this.sendMeta(); }
    const playing = this.phase === 'play';
    const walls = this.walls;

    if (this.mode === 'lms' && playing) { // the safe zone shrinks from 15 s in, over 75 s,
      // then keeps closing to nothing, so a round always ends
      const full = Math.hypot(W, H) / 2 + 40 + Math.hypot(this.zone.x - W / 2, this.zone.y - H / 2), k = Math.min(1, Math.max(0, (this.t - 18) / 75));
      this.zone.r = full + (150 - full) * k;
      if (this.t > 93) this.zone.r = Math.max(0, 150 - (this.t - 93) * 4);
    }

    for (const p of this.players.values()) {
      if (!p.inRound) continue;
      if (!p.alive) {
        if (this.mode === 'dm' && playing && p.respawnAt && this.t >= p.respawnAt && (p.on || p.bot)) this.spawn(p);
        continue;
      }
      if (p.bot) this.botThink(p);
      const inp = p.on || p.bot ? p.input : { mx: 0, my: 0, a: p.aim, f: false };
      p.aim = inp.a;
      if (!playing) continue;
      move(p, inp, TICK, walls, this.t < p.buffs.speed ? 1.4 : 1);
      p.cd -= TICK;
      if (inp.f && p.cd <= 0) {
        p.cd = FIRE_CD;
        for (const b of shotBullets(p.x, p.y, p.aim, this.t < p.buffs.triple)) this.bullets.push({ ...b, id: ++this.seq, owner: p.id });
        this.emit({ k: 'shot', id: p.id });
      }
      // pickups
      for (let i = this.pickups.length - 1; i >= 0; i--) {
        const u = this.pickups[i];
        if (Math.hypot(u.x - p.x, u.y - p.y) > R + 16) continue;
        if (u.type === 'heal' && p.hp >= MAX_HP) continue;
        if (u.type === 'heal') p.hp = Math.min(MAX_HP, p.hp + 40);
        else if (u.type === 'shield') p.shield = 50;
        else p.buffs[u.type] = this.t + BUFF_TIME[u.type];
        this.pickups.splice(i, 1);
        this.emit({ k: 'pick', id: p.id, type: u.type, x: r1(u.x), y: r1(u.y) });
      }
      // outside the safe zone
      if (this.mode === 'lms' && playing && Math.hypot(p.x - this.zone.x, p.y - this.zone.y) > this.zone.r) {
        p.zoneAcc = (p.zoneAcc || 0) + 22 * TICK;
        if (p.zoneAcc >= 5) { this.damage(p, Math.floor(p.zoneAcc), null, true); p.zoneAcc %= 1; }
      }
    }

    // bullets
    if (playing) {
      const live = [];
      for (const b of this.bullets) {
        let alive = stepBullet(b, TICK, walls);
        if (alive) {
          for (const p of this.players.values()) {
            if (!p.alive || p.id === b.owner) continue;
            if (segDist(b.px, b.py, b.x, b.y, p.x, p.y) > R + BULLET_R) continue;
            alive = false;
            if (this.t < p.protect) { this.emit({ k: 'block', x: r1(b.x), y: r1(b.y) }); break; }
            this.emit({ k: 'hit', v: p.id, by: b.owner, x: r1(b.x), y: r1(b.y) });
            this.damage(p, DMG, b.owner);
            break;
          }
        } else this.emit({ k: 'wall', x: r1(b.x - b.vx * TICK * 0.3), y: r1(b.y - b.vy * TICK * 0.3) });
        if (alive) live.push(b);
      }
      this.bullets = live;

      if (this.t >= this.nextPickup) {
        this.nextPickup = this.t + 7;
        if (this.pickups.length < 3) this.spawnPickup();
      }

      if (this.mode === 'dm' && this.t >= this.endAt) this.endRound();
      else if (this.mode === 'lms' && this.participants().filter(p => p.alive).length <= 1) this.endRound();
    }

    if (this.tickNo % 2 === 0 && this.phase !== 'end') this.sendSnapshot();
  }

  damage(p, amount, by, zone = false) {
    if (!p.alive) return;
    if (p.shield > 0 && !zone) {
      const s = Math.min(p.shield, amount);
      p.shield -= s;
      amount -= s;
    }
    p.hp -= amount;
    if (p.hp > 0) return;
    p.hp = 0;
    p.alive = false;
    p.deaths++;
    p.respawnAt = this.t + RESPAWN;
    const killer = by && by !== p.id ? this.players.get(by) : null;
    if (killer) killer.kills++;
    if (this.mode === 'lms') this.deadOrder.push(p.id);
    this.emit({ k: 'kill', a: killer?.id || null, v: p.id, x: r1(p.x), y: r1(p.y) });
    this.sendMeta();
  }

  spawnPickup() {
    for (let i = 0; i < 30; i++) {
      const x = 80 + Math.random() * (W - 160), y = 80 + Math.random() * (H - 160);
      if (insideWall(x, y, this.walls, 30)) continue;
      if (this.mode === 'lms' && Math.hypot(x - this.zone.x, y - this.zone.y) > this.zone.r * 0.8) continue;
      if ([...this.players.values()].some(p => p.alive && Math.hypot(p.x - x, p.y - y) < 120)) continue;
      const type = PICKUP_TYPES[Math.floor(Math.random() * PICKUP_TYPES.length)];
      this.pickups.push({ id: ++this.seq, type, x, y });
      return;
    }
  }

  // ---------- bots ----------
  botThink(p) {
    const ai = p.ai, walls = this.walls;
    const enemies = [...this.players.values()].filter(o => o.alive && o !== p);
    let target = null, td = Infinity;
    for (const o of enemies) {
      const d = Math.hypot(o.x - p.x, o.y - p.y) + (blocked(p.x, p.y, o.x, o.y, walls) ? 250 : 0);
      if (d < td) { td = d; target = o; }
    }
    const los = target && !blocked(p.x, p.y, target.x, target.y, walls);
    const dist = target ? Math.hypot(target.x - p.x, target.y - p.y) : Infinity;

    if (this.t >= ai.next) {
      ai.next = this.t + 0.2 + Math.random() * 0.15;
      if (Math.random() < 0.12) ai.strafe *= -1;
      let goal = null; // [x, y, away?]
      const zoneOut = this.mode === 'lms' && Math.hypot(p.x - this.zone.x, p.y - this.zone.y) > this.zone.r * 0.8;
      const near = this.pickups.filter(u => !(u.type === 'heal' && p.hp >= MAX_HP)).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
      let angle;
      if (zoneOut) angle = Math.atan2(this.zone.y - p.y, this.zone.x - p.x);
      else if (near && Math.hypot(near.x - p.x, near.y - p.y) < 260 && (!los || dist > 300 || p.hp < 50)) angle = Math.atan2(near.y - p.y, near.x - p.x);
      else if (target && (!los || dist > 330)) angle = Math.atan2(target.y - p.y, target.x - p.x);
      else if (target && dist < 170) angle = Math.atan2(p.y - target.y, p.x - target.x) + ai.strafe * 0.6;
      else if (target) angle = Math.atan2(target.y - p.y, target.x - p.x) + ai.strafe * Math.PI / 2;
      else {
        if (Math.hypot(ai.tx - p.x, ai.ty - p.y) < 60) { ai.tx = 100 + Math.random() * (W - 200); ai.ty = 100 + Math.random() * (H - 200); }
        angle = Math.atan2(ai.ty - p.y, ai.tx - p.x);
      }
      // steer around walls: take the first direction that actually moves us
      for (const off of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.3, -2.3, Math.PI]) {
        const a = angle + off, q = { x: p.x, y: p.y };
        move(q, { mx: Math.cos(a), my: Math.sin(a) }, 0.3, walls);
        if (Math.hypot(q.x - p.x, q.y - p.y) > SPEED * 0.3 * 0.75) { ai.dir = a; break; }
      }
      p.input.mx = Math.cos(ai.dir);
      p.input.my = Math.sin(ai.dir);
    }

    // aim with a rough lead, and shoot when there is a clear line
    if (target) {
      const prev = ai.prev[target.id];
      const vx = prev ? (target.x - prev.x) / TICK : 0, vy = prev ? (target.y - prev.y) / TICK : 0;
      ai.prev = { [target.id]: { x: target.x, y: target.y } };
      const lead = (dist / BULLET_SPEED) * 0.8;
      const want = Math.atan2(target.y + vy * lead - p.y, target.x + vx * lead - p.x);
      ai.wobble = (ai.wobble || 0) * 0.9 + (Math.random() - 0.5) * 0.06;
      let da = want + ai.wobble - p.input.a;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      p.input.a += da * 0.35; // turn smoothly, not instantly
      if (los) ai.seen += TICK; else ai.seen = 0;
      p.input.f = los && dist < 620 && ai.seen > 0.35 && Math.abs(da) < 0.3 && this.t >= p.protect - SPAWN_SHIELD + 0.5;
    } else p.input.f = false;
  }

  // ---------- messages ----------
  sendSnapshot(to = null) {
    const players = [];
    const ack = {};
    for (const p of this.players.values()) {
      if (!p.inRound) continue;
      const flags = (this.t < p.buffs.triple ? 1 : 0) | (this.t < p.buffs.speed ? 2 : 0) | (this.t < p.protect ? 4 : 0);
      players.push([p.id, r1(p.x), r1(p.y), r2(p.aim), Math.ceil(p.hp), p.alive ? 1 : 0, Math.ceil(p.shield), flags,
        p.alive ? 0 : Math.max(0, r1(p.respawnAt - this.t))]);
      if (!p.bot) ack[p.id] = p.lastSeq;
    }
    const msg = {
      t: 's', n: this.tickNo, ph: this.phase,
      tl: this.phase === 'count' ? r1(this.countEnd - this.t) : this.mode === 'dm' ? r1(Math.max(0, this.endAt - this.t)) : null,
      z: this.mode === 'lms' && this.zone ? [this.zone.x, this.zone.y, r1(this.zone.r)] : null,
      ack, p: players,
      b: this.bullets.map(b => [b.id, r1(b.x), r1(b.y), r1(b.vx), r1(b.vy), b.owner]),
      u: this.pickups.map(u => [u.id, u.type, r1(u.x), r1(u.y)]),
      ev: this.events,
    };
    this.events = [];
    const s = JSON.stringify(msg);
    for (const ws of to || this.sockets.keys()) { try { ws.send(s); } catch {} }
  }

  sendMeta() {
    this.broadcast({
      t: 'room', code: this.code, pub: this.pub, host: this.host, phase: this.phase, mode: this.mode,
      mapPick: this.mapPick, map: this.map, bots: this.botCount,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, bot: p.bot, on: p.on, k: p.kills, d: p.deaths, inRound: p.inRound })),
      results: this.results,
    });
  }
}
