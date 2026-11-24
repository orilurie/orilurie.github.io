// Game server for "זירה" – a real-time top-down arena shooter.
// One Durable Object per room runs the authoritative simulation at 30 ticks/second and streams
// snapshots to the players over WebSockets; a single Matchmaker object tracks rooms for "quick play".

import {
  W, H, R, SPEED, BULLET_R, FIRE_CD, DMG, MAX_HP, TICK, MAX_PLAYERS, DM_TIME, RESPAWN, SPAWN_SHIELD,
  COLORS, MAPS, BUFF_TIME, BULLET_SPEED, move, collide, insideWall, blocked, segDist, shotBullets, stepBullet,
  canSee, STEP, NEAR, WEAPONS, WEAPON_LIST, DASH, BUSH_REVEAL, inBush,
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
const PICKUP_TYPES = ['heal', 'heal', 'shield', 'triple', 'speed', 'smg', 'shotgun', 'sniper', 'smg', 'shotgun'];

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
    this.steps = [];
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
    if (this.phase === 'end' && this.autoNext && now >= this.autoNext) {
      this.autoNext = 0;
      if (this.players.size >= 2 && this.humans().some(p => p.on)) this.startRound();
    }
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
        // aim and trigger, plus the movement steps the client made since its last message:
        // [seq, mx, my, dt, dash]. The server replays exactly those steps, so your own
        // prediction and the server agree (the classic client-prediction model).
        p.input = { ...p.input, a: Number(msg.a) || 0, f: !!msg.f };
        if (Array.isArray(msg.c)) for (const c of msg.c.slice(0, 40)) this.applyCmd(p, c);
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
        this.autoNext = 0;
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
    p.lvl = Math.max(1, Math.min(99, Number(msg.lvl) || 1));
    p.lastSeq = 0; // a reloaded page starts counting its steps again
    p.spectator = !!msg.spec; // watch only (used by tests)
    if (p.spectator) p.inRound = false;
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
      buffs: { triple: 0, speed: 0 }, protect: 0, respawnAt: 0, place: 0, lvl: 1,
      weapon: 'pistol', ammo: Infinity, dashT: 0, dashCd: 0, shotNo: 0, lastShotT: -9, streak: 0, multi: { n: 0, t: -9 },
    };
    if (bot) p.ai = { next: 0, dir: 0, strafe: 1, seen: 0, prev: {}, path: [], goal: null, repath: 0, mem: null, heard: null, wander: null, stuckT: 0, lastPos: { x: 0, y: 0 } };
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
    this.steps = [];
    this.results = null;
    this.t = 0;
    this.nextPickup = 5;
    this.deadOrder = [];
    // the zone closes on a random open spot near the middle
    let zx = W / 2, zy = H / 2;
    for (let i = 0; i < 40; i++) {
      const x = W / 2 + (Math.random() - 0.5) * 700, y = H / 2 + (Math.random() - 0.5) * 400;
      if (!insideWall(x, y, MAPS[this.map].walls, 60)) { zx = x; zy = y; break; }
    }
    this.zone = { x: zx, y: zy, r: Math.hypot(W, H) / 2 + 40 };
    for (const p of this.players.values()) {
      if (p.spectator) continue;
      Object.assign(p, { kills: 0, deaths: 0, inRound: true, place: 0, buffs: { triple: 0, speed: 0 }, input: { mx: 0, my: 0, a: p.input.a, f: false } });
      this.spawn(p);
    }
    this.autoNext = 0;
    for (let i = 0; i < 3; i++) this.spawnPickup();
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
    Object.assign(p, best, { hp: MAX_HP, shield: 0, alive: true, protect: this.t + SPAWN_SHIELD, cd: 0.4, buffs: { triple: 0, speed: 0 }, vx: 0, vy: 0, weapon: 'pistol', ammo: Infinity, dashT: 0, dashCd: 0, streak: 0, wantDash: false });
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
    this.autoNext = Date.now() + 15000; // next round starts by itself (the host can stop it)
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
      p.dashCd -= TICK;
      p.budget = Math.min(0.3, (p.budget || 0) + TICK);
      if (!p.bot) { /* humans move by their own steps (applyCmd) */ }
      else {
      const ox = p.x, oy = p.y;
      if (p.wantDash) {
        p.wantDash = false;
        if (p.dashCd <= 0) {
          const l = Math.hypot(inp.mx, inp.my);
          const a = l > 0.2 ? Math.atan2(inp.my, inp.mx) : inp.a;
          p.dashDir = { mx: Math.cos(a), my: Math.sin(a) };
          p.dashT = DASH.time;
          p.dashCd = DASH.cd;
          this.emit({ k: 'dash', id: p.id, x: r1(p.x), y: r1(p.y) });
        }
      }
      if (p.dashT > 0) { p.dashT -= TICK; move(p, p.dashDir, TICK, walls, DASH.speed, true); }
      else move(p, inp, TICK, walls, this.t < p.buffs.speed ? 1.4 : 1);
      this.footsteps(p, ox, oy);
      }
      p.cd -= TICK;
      if (inp.f && p.cd <= 0) {
        const w = WEAPONS[p.weapon];
        p.cd = w.cd;
        p.lastShotT = this.t;
        for (const b of shotBullets(p.x, p.y, p.aim, this.t < p.buffs.triple, p.weapon, p.shotNo++)) this.bullets.push({ ...b, id: ++this.seq, owner: p.id });
        this.emit({ k: 'shot', id: p.id, x: r1(p.x), y: r1(p.y), w: WEAPON_LIST.indexOf(p.weapon) });
        if (Number.isFinite(p.ammo) && --p.ammo <= 0) { p.weapon = 'pistol'; p.ammo = Infinity; this.emit({ k: 'empty', id: p.id }); }
        for (const o of this.players.values()) {
          if (o.bot && o.alive && o !== p && Math.hypot(o.x - p.x, o.y - p.y) < 750) o.ai.heard = { x: p.x, y: p.y, t: this.t };
        }
      }
      // pickups
      for (let i = this.pickups.length - 1; i >= 0; i--) {
        const u = this.pickups[i];
        if (Math.hypot(u.x - p.x, u.y - p.y) > R + 16) continue;
        if (u.type === 'heal' && p.hp >= MAX_HP) continue;
        if (u.type === 'heal') p.hp = Math.min(MAX_HP, p.hp + 40);
        else if (u.type === 'shield') p.shield = 50;
        else if (WEAPONS[u.type]) { p.weapon = u.type; p.ammo = WEAPONS[u.type].ammo; }
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
            this.emit({ k: 'hit', v: p.id, by: b.owner, x: r1(b.x), y: r1(b.y), dmg: b.dmg || DMG });
            if (p.bot) {
              p.ai.heard = { x: b.x - b.vx * 0.5, y: b.y - b.vy * 0.5, t: this.t, hit: true };
              if (p.dashCd <= 0 && Math.random() < 0.3) p.wantDash = true;
            }
            const sp = Math.hypot(b.vx, b.vy) || 1, push = WEAPONS[b.w]?.push || 8;
            p.x += (b.vx / sp) * push; p.y += (b.vy / sp) * push;
            collide(p, walls);
            this.damage(p, b.dmg || DMG, b.owner);
            break;
          }
        }
        if (alive) live.push(b);
      }
      this.bullets = live;

      if (this.t >= this.nextPickup) {
        this.nextPickup = this.t + 5;
        if (this.pickups.length < 5) this.spawnPickup();
      }

      if (this.mode === 'dm' && this.t >= this.endAt) this.endRound();
      else if (this.mode === 'lms' && this.participants().filter(p => p.alive).length <= 1) this.endRound();
    }

    if (this.phase !== 'end') this.sendSnapshot(); // 30 updates a second
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
    const ended = p.streak;
    p.streak = 0;
    if (killer) {
      killer.kills++;
      killer.streak++;
      killer.multi = this.t - killer.multi.t < 3.5 ? { n: killer.multi.n + 1, t: this.t } : { n: 1, t: this.t };
      if (killer.multi.n >= 2) this.emit({ k: 'multi', id: killer.id, n: killer.multi.n });
      if (killer.streak >= 3 && killer.streak % 2 === 1) this.emit({ k: 'streak', id: killer.id, n: killer.streak });
      if (ended >= 3) { killer.kills++; this.emit({ k: 'stop', a: killer.id, v: p.id, n: ended }); } // bounty: +1
    }
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

  applyCmd(p, c) {
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || c[0] <= p.lastSeq) return;
    p.lastSeq = c[0];
    if (this.phase !== 'play' || !p.alive) return;
    let mx = Number(c[1]) || 0, my = Number(c[2]) || 0;
    const l = Math.hypot(mx, my);
    if (l > 1) { mx /= l; my /= l; }
    // no speed hacks: a step can't use more time than has actually passed
    const dt = Math.min(Math.max(0, Number(c[3]) || 0), 0.1, p.budget);
    p.budget -= dt;
    if (dt <= 0) return;
    if (c[4] && p.dashCd <= 0) {
      const a = l > 0.2 ? Math.atan2(my, mx) : p.input.a;
      p.dashDir = { mx: Math.cos(a), my: Math.sin(a) };
      p.dashT = DASH.time;
      p.dashCd = DASH.cd;
      this.emit({ k: 'dash', id: p.id, x: r1(p.x), y: r1(p.y) });
    }
    const ox = p.x, oy = p.y;
    if (p.dashT > 0) { move(p, p.dashDir, dt, this.walls, DASH.speed, true); p.dashT -= dt; }
    else move(p, { mx, my }, dt, this.walls, this.t < p.buffs.speed ? 1.4 : 1);
    this.footsteps(p, ox, oy);
  }

  // footsteps: others can't see you, but they notice your tracks
  footsteps(p, ox, oy) {
    p.walked = (p.walked || 0) + Math.hypot(p.x - ox, p.y - oy);
    if (p.walked < STEP) return;
    p.walked = 0;
    p.side = -(p.side || 1);
    this.steps.push([r1(p.x), r1(p.y), r2(Math.atan2(p.y - oy, p.x - ox)), p.side, p.id]);
    for (const o of this.players.values()) {
      if (o.bot && o.alive && o !== p && Math.hypot(o.x - p.x, o.y - p.y) < 480) o.ai.heard = { x: p.x, y: p.y, t: this.t };
    }
  }

  // Can viewer v see player o? Vision cone + walls, and a bush hides you unless someone is very
  // close or you just fired.
  visible(v, o) {
    if (!canSee(v.x, v.y, v.aim, o.x, o.y, this.walls)) return false;
    if (inBush(o.x, o.y, this.map) && Math.hypot(o.x - v.x, o.y - v.y) > BUSH_REVEAL && this.t - o.lastShotT > 1.2) return false;
    return true;
  }

  // ---------- bots ----------
  // Bots play by the same rules: they only know about you if they see you (same vision cone),
  // remember where they last saw you, and go check on footsteps, shots and hits they hear.
  botThink(p) {
    const ai = p.ai, walls = this.walls;
    let target = null, td = Infinity;
    for (const o of this.players.values()) {
      if (!o.alive || o === p || !this.visible(p, o)) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d < td) { td = d; target = o; }
    }
    if (target) { ai.mem = { x: target.x, y: target.y, t: this.t }; ai.seen += TICK; } else ai.seen = 0;
    const dist = td;

    // where to go
    const zoneOut = this.mode === 'lms' && this.zone && Math.hypot(p.x - this.zone.x, p.y - this.zone.y) > this.zone.r * 0.75;
    const pick = this.pickups.filter(u => !(u.type === 'heal' && p.hp >= MAX_HP))
      .map(u => ({ u, d: Math.hypot(u.x - p.x, u.y - p.y) * (WEAPONS[u.type] && p.weapon === 'pistol' ? 0.6 : 1) })).sort((a, b) => a.d - b.d)[0];
    let goal = null, look = null, fight = false;
    if (zoneOut) goal = { x: this.zone.x, y: this.zone.y };
    else if (target) { fight = true; }
    else if (pick && pick.d < 320) goal = pick.u;
    else if (ai.heard && this.t - ai.heard.t < 4) { goal = ai.heard; look = ai.heard; if (Math.hypot(ai.heard.x - p.x, ai.heard.y - p.y) < 50) ai.heard = null; }
    else if (ai.mem && this.t - ai.mem.t < 5) { goal = ai.mem; look = ai.mem; if (Math.hypot(ai.mem.x - p.x, ai.mem.y - p.y) < 50) ai.mem = null; }
    else {
      if (!ai.wander || Math.hypot(ai.wander.x - p.x, ai.wander.y - p.y) < 60 || this.t - ai.wander.t > 12) {
        for (let i = 0; i < 20; i++) {
          const x = 80 + Math.random() * (W - 160), y = 80 + Math.random() * (H - 160);
          if (insideWall(x, y, walls, R + 10)) continue;
          if (this.mode === 'lms' && this.zone && Math.hypot(x - this.zone.x, y - this.zone.y) > this.zone.r * 0.7) continue;
          ai.wander = { x, y, t: this.t }; break;
        }
      }
      goal = ai.wander;
    }

    // movement
    let mx = 0, my = 0;
    if (fight) {
      if (this.t >= ai.next) { ai.next = this.t + 0.25 + Math.random() * 0.2; if (Math.random() < 0.15) ai.strafe *= -1; }
      const toT = Math.atan2(target.y - p.y, target.x - p.x);
      const far = { shotgun: 200, sniper: 520, smg: 330 }[p.weapon] || 380, close = p.weapon === 'shotgun' ? 90 : p.weapon === 'sniper' ? 300 : 180;
      let a = dist > far ? toT : dist < close ? toT + Math.PI + ai.strafe * 0.6 : toT + ai.strafe * Math.PI / 2;
      for (const off of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
        const q = { x: p.x, y: p.y };
        move(q, { mx: Math.cos(a + off), my: Math.sin(a + off) }, 0.25, walls, 1, true);
        if (Math.hypot(q.x - p.x, q.y - p.y) > SPEED * 0.25 * 0.7) { a += off; break; }
      }
      mx = Math.cos(a); my = Math.sin(a);
      ai.path = [];
    } else if (goal) {
      const gk = `${Math.round(goal.x / 40)},${Math.round(goal.y / 40)}`;
      if (gk !== ai.goalKey || this.t >= ai.repath || !ai.path.length) {
        ai.goalKey = gk;
        ai.repath = this.t + 1;
        ai.path = this.findPath(p.x, p.y, goal.x, goal.y);
      }
      // skip waypoints we can already walk straight to
      while (ai.path.length > 1 && this.clearWalk(p.x, p.y, ai.path[1][0], ai.path[1][1])) ai.path.shift();
      const wp = ai.path[0] || [goal.x, goal.y];
      if (Math.hypot(wp[0] - p.x, wp[1] - p.y) < 14 && ai.path.length) ai.path.shift();
      const a = Math.atan2(wp[1] - p.y, wp[0] - p.x);
      mx = Math.cos(a); my = Math.sin(a);
    }
    // stuck? try a random nudge and re-plan
    if (this.t - (ai.lastPos.t || 0) > 0.8) {
      if ((mx || my) && Math.hypot(p.x - ai.lastPos.x, p.y - ai.lastPos.y) < 20) { ai.nudge = { a: Math.random() * Math.PI * 2, until: this.t + 0.4 }; ai.repath = 0; }
      ai.lastPos = { x: p.x, y: p.y, t: this.t };
    }
    if (ai.nudge && this.t < ai.nudge.until) { mx = Math.cos(ai.nudge.a); my = Math.sin(ai.nudge.a); }
    p.input.mx = mx; p.input.my = my;

    // looking / aiming
    let want, turn = 0.12;
    if (fight) {
      const prev = ai.prev[target.id];
      const vx = prev ? (target.x - prev.x) / TICK : 0, vy = prev ? (target.y - prev.y) / TICK : 0;
      ai.prev = { [target.id]: { x: target.x, y: target.y } };
      // human-like aim: a new error for every shot (bigger when far away), and a rough guess of
      // where a moving target will be – so bots miss a fair share of their shots
      if (ai.err === undefined || ai.errFor !== ai.shotNo) {
        ai.errFor = ai.shotNo;
        const gauss = (Math.random() + Math.random() + Math.random() - 1.5) / 0.5;
        ai.err = gauss * (0.11 + dist * 0.00026);
        ai.leadK = Math.random() * 1.1;
      }
      const lead = (dist / BULLET_SPEED) * ai.leadK;
      want = Math.atan2(target.y + vy * lead - p.y, target.x + vx * lead - p.x) + ai.err;
      turn = 0.22;
    } else if (look && Math.hypot(look.x - p.x, look.y - p.y) > 40) {
      want = Math.atan2(look.y - p.y, look.x - p.x);
      turn = ai.heard?.hit ? 0.25 : 0.15;
    } else if (mx || my) {
      want = Math.atan2(my, mx) + Math.sin(this.t * 1.7 + p.x * 0.01) * 0.6; // glance around while walking
    } else want = p.input.a + 0.03;
    let da = want - p.input.a;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    p.input.a += da * turn;
    const range = { shotgun: 280, sniper: 900, smg: 480 }[p.weapon] || 620;
    p.input.f = fight && dist < range && ai.seen > 0.6 && Math.abs(da) < 0.12 && this.t >= p.protect - SPAWN_SHIELD + 0.5;
    if (p.input.f && p.cd <= 0) ai.shotNo = (ai.shotNo || 0) + 1; // fires this tick: next shot gets a new error
  }

  // Can a player walk straight from a to b? (checks the two edges of the body, not just the middle)
  clearWalk(ax, ay, bx, by) {
    const a = Math.atan2(by - ay, bx - ax), ox = -Math.sin(a) * (R - 2), oy = Math.cos(a) * (R - 2);
    return !blocked(ax + ox, ay + oy, bx + ox, by + oy, this.walls) && !blocked(ax - ox, ay - oy, bx - ox, by - oy, this.walls);
  }

  // A* over a 40-unit grid; cells too close to a wall are closed.
  findPath(sx, sy, gx, gy) {
    const C = 40, cols = Math.ceil(W / C), rows = Math.ceil(H / C);
    if (!this.grids) this.grids = {};
    let grid = this.grids[this.map];
    if (!grid) {
      grid = new Uint8Array(cols * rows);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const x = i * C + C / 2, y = j * C + C / 2;
        grid[j * cols + i] = x < R || y < R || x > W - R || y > H - R || insideWall(x, y, this.walls, R + 4) ? 1 : 0;
      }
      this.grids[this.map] = grid;
    }
    const cell = (x, y) => [Math.max(0, Math.min(cols - 1, Math.floor(x / C))), Math.max(0, Math.min(rows - 1, Math.floor(y / C)))];
    const nearestOpen = ([i, j]) => {
      if (!grid[j * cols + i]) return [i, j];
      for (let r = 1; r < 6; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const a = i + di, b = j + dj;
        if (a >= 0 && b >= 0 && a < cols && b < rows && !grid[b * cols + a]) return [a, b];
      }
      return [i, j];
    };
    const [si, sj] = nearestOpen(cell(sx, sy)), [gi, gj] = nearestOpen(cell(gx, gy));
    const start = sj * cols + si, goal = gj * cols + gi;
    const gScore = new Float32Array(cols * rows).fill(Infinity), from = new Int32Array(cols * rows).fill(-1);
    const closed = new Uint8Array(cols * rows);
    gScore[start] = 0;
    const open = [[Math.hypot(gi - si, gj - sj), start]];
    while (open.length) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k;
      const [, cur] = open.splice(bi, 1)[0];
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const ci = cur % cols, cj = (cur - ci) / cols;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
        const n = nj * cols + ni;
        if (grid[n] || closed[n]) continue;
        if (di && dj && (grid[cj * cols + ni] || grid[nj * cols + ci])) continue; // no corner cutting
        const gs = gScore[cur] + (di && dj ? 1.414 : 1);
        if (gs < gScore[n]) { gScore[n] = gs; from[n] = cur; open.push([gs + Math.hypot(gi - ni, gj - nj), n]); }
      }
    }
    if (from[goal] === -1 && goal !== start) return [[gx, gy]];
    const path = [];
    for (let c = goal; c !== start && c !== -1; c = from[c]) path.unshift([(c % cols) * C + C / 2, Math.floor(c / cols) * C + C / 2]);
    path.push([gx, gy]);
    return path;
  }

  // ---------- messages ----------
  // Each player gets their own snapshot: only the players they can see (spectators and the dead
  // see everyone), footsteps of the ones they can't, and only events they could notice.
  sendSnapshot(to = null) {
    const ack = {};
    const all = [];
    for (const p of this.players.values()) {
      if (!p.inRound) continue;
      const flags = (this.t < p.buffs.triple ? 1 : 0) | (this.t < p.buffs.speed ? 2 : 0) | (this.t < p.protect ? 4 : 0)
        | (p.dashT > 0 ? 8 : 0) | (p.streak >= 3 ? 16 : 0) | (inBush(p.x, p.y, this.map) ? 32 : 0);
      all.push({ p, row: [p.id, r1(p.x), r1(p.y), r2(p.aim), Math.ceil(p.hp), p.alive ? 1 : 0, Math.ceil(p.shield), flags,
        p.alive ? 0 : Math.max(0, r1(p.respawnAt - this.t)), WEAPON_LIST.indexOf(p.weapon), r1(p.vx || 0), r1(p.vy || 0)] });
      if (!p.bot) ack[p.id] = p.lastSeq;
    }
    const base = {
      t: 's', n: this.tickNo, ph: this.phase,
      tl: this.phase === 'count' ? r1(this.countEnd - this.t) : this.mode === 'dm' ? r1(Math.max(0, this.endAt - this.t)) : null,
      z: this.mode === 'lms' && this.zone ? [r1(this.zone.x), r1(this.zone.y), r1(this.zone.r)] : null,
      ack,
      u: this.pickups.map(u => [u.id, u.type, r1(u.x), r1(u.y)]),
    };
    const walls = this.walls;
    for (const ws of to || this.sockets.keys()) {
      const v = this.players.get(this.sockets.get(ws));
      const seesAll = !v || !v.inRound || !v.alive || this.phase !== 'play';
      const sees = (x, y) => seesAll || canSee(v.x, v.y, v.aim, x, y, walls);
      const visible = new Set();
      const rows = [];
      for (const { p, row } of all) {
        if (p === v || !p.alive || seesAll || this.visible(v, p)) { rows.push(row); if (p.alive) visible.add(p.id); }
        else rows.push([p.id, 0, 0, 0, 0, 2, 0, 0, 0]); // alive but hidden (alive = 2, keeps counts right)
      }
      const near = (x, y, d) => seesAll || Math.hypot(x - v.x, y - v.y) < d;
      const ev = this.events.filter(e => {
        if (['kill', 'start', 'go', 'end', 'spawn', 'multi', 'streak', 'stop'].includes(e.k)) return true;
        if (e.v === v?.id || e.by === v?.id || e.id === v?.id) return true;
        if (e.k === 'shot') return near(e.x, e.y, 900);
        return e.x === undefined || sees(e.x, e.y);
      }).map(e => (e.k === 'kill' && e.x !== undefined && !sees(e.x, e.y) && e.a !== v?.id && e.v !== v?.id ? { k: e.k, a: e.a, v: e.v } : e));
      const msg = {
        ...base, p: rows, ev,
        me: v && v.inRound ? { w: WEAPON_LIST.indexOf(v.weapon), am: Number.isFinite(v.ammo) ? v.ammo : -1, dc: r1(Math.max(0, v.dashCd)), st: v.streak } : null,
        b: this.bullets.filter(b => b.owner === v?.id || sees(b.x, b.y)).map(b => [b.id, r1(b.x), r1(b.y), r1(b.vx), r1(b.vy), b.owner]),
        fs: seesAll ? [] : this.steps.filter(st => st[4] !== v.id && !visible.has(st[4]) && near(st[0], st[1], 1100)).map(st => st.slice(0, 4)),
      };
      try { ws.send(JSON.stringify(msg)); } catch {}
    }
    if (!to) { this.events = []; this.steps = []; }
  }

  sendMeta() {
    this.broadcast({
      t: 'room', code: this.code, pub: this.pub, host: this.host, phase: this.phase, mode: this.mode,
      mapPick: this.mapPick, map: this.map, bots: this.botCount,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, bot: p.bot, on: p.on, k: p.kills, d: p.deaths, inRound: p.inRound, lvl: p.bot ? 0 : p.lvl })),
      next: this.phase === 'end' && this.autoNext ? Math.max(0, Math.round((this.autoNext - Date.now()) / 1000)) : null,
      results: this.results,
    });
  }
}
