// Game server for "זירה" – a real-time top-down arena shooter.
// One Durable Object per room runs the authoritative simulation at 30 ticks/second and streams
// snapshots to the players over WebSockets; a single Matchmaker object tracks rooms for "quick play".

import {
  W, H, R, SPEED, BULLET_R, FIRE_CD, DMG, MAX_HP, TICK, MAX_PLAYERS, DM_TIME, RESPAWN, SPAWN_SHIELD,
  COLORS, MAPS, BUFF_TIME, BULLET_SPEED, move, collide, insideWall, blocked, segDist, shotBullets, stepBullet,
  canSee, STEP, NEAR, INTERP_MS, GRENADE, PROPS, propRect, WEAPONS, WEAPON_LIST, DASH, BUSH_REVEAL, inBush,
} from '../../game-night/arena-core.js';
import { DungeonSim, ENEMY_LIST, HEROES, roomAt as dRoomAt, MAX_PLAYERS as D_MAX, TICK as D_TICK, collide as dCollide } from '../../game-night/dungeon-core.js';

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
    if (url.pathname === '/api/daily' && req.method === 'GET') { // the dungeon's daily-run leaderboard
      const r = await mm.fetch(`https://mm/daily${url.search}`);
      return json(await r.json(), r.status);
    }
    const dm = url.pathname.match(/^\/dws\/([A-Z]{4})$/); // the dungeon game
    if (dm) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const run = env.DUNGEON.get(env.DUNGEON.idFromName(dm[1]));
      const headers = new Headers(req.headers);
      headers.set('x-code', dm[1]);
      return run.fetch(new Request(req.url, { headers }));
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
const utcDay = (t = Date.now()) => { const d = new Date(t); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); };
const validDay = d => /^\d{8}$/.test(String(d)) && +String(d).slice(4, 6) >= 1 && +String(d).slice(4, 6) <= 12 && +String(d).slice(6) >= 1 && +String(d).slice(6) <= 31;
const DAILY_TOP = 20;

export class Matchmaker {
  constructor(state) { this.rooms = new Map(); this.storage = state.storage; } // rooms: code -> { pub, humans, phase, mode, t }

  // המבוך daily leaderboard: best result per name per UTC day, top 20, kept in DO storage under daily:YYYYMMDD.
  // Only the Dungeon object posts here (the worker never routes /daily-add from outside).
  async dailyAdd(r) {
    const d = Number(r?.d), name = String(r?.name ?? '').trim().slice(0, 16);
    const int = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v)) || 0));
    if (!validDay(d) || !name) return false;
    const row = { name, score: int(r.score, 1e7), floor: int(r.floor, 99), won: !!r.won, kills: int(r.kills, 1e5) };
    const key = `daily:${d}`;
    const top = (await this.storage.get(key)) || [];
    const old = top.find(x => x.name === name);
    if (old && old.score >= row.score) return true;
    const next = top.filter(x => x.name !== name);
    next.push(row);
    next.sort((a, b) => b.score - a.score);
    await this.storage.put(key, next.slice(0, DAILY_TOP));
    return true;
  }

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
    if (url.pathname === '/daily-add' && req.method === 'POST') {
      let r;
      try { r = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      return json({ ok: await this.dailyAdd(r) });
    }
    if (url.pathname === '/daily') {
      const q = url.searchParams.get('d');
      const d = q ? Number(q) : utcDay();
      if (!validDay(d)) return json({ error: 'bad day' }, 400);
      return json({ d, top: (await this.storage.get(`daily:${d}`)) || [] });
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
// Bot skill. err/errD: aim error (radians) at 0 and per unit of distance; lead: how well they
// guess where a moving target goes; react: seconds of seeing you before the first shot; turn: how
// fast they swing their aim; extraCd: extra pause between shots; range: share of the weapon's
// range they'll shoot from; view: share of the normal sight distance; hear: how far they hear
// steps (0 = deaf); dash: chance to dodge when hit; strafe: sidestep in fights; speed.
const BOT_LEVELS = {
  vez: { err: 0.38, errD: 0.0007, lead: 0, react: 1.3, turn: 0.07, extraCd: 0.7, range: 0.55, view: 0.55, hear: 0, dash: 0, strafe: false, speed: 0.72, mem: 1.5 },
  easy: { err: 0.24, errD: 0.00045, lead: 0.4, react: 0.95, turn: 0.11, extraCd: 0.35, range: 0.75, view: 0.75, hear: 280, dash: 0.05, strafe: true, speed: 0.85, mem: 3 },
  normal: { err: 0.11, errD: 0.00026, lead: 1.1, react: 0.6, turn: 0.22, extraCd: 0, range: 1, view: 1, hear: 480, dash: 0.3, strafe: true, speed: 1, mem: 5 },
  hard: { err: 0.035, errD: 0.0001, lead: 0.35, leadMin: 0.75, react: 0.3, turn: 0.4, extraCd: 0, range: 1, view: 1, hear: 560, dash: 0.45, strafe: true, speed: 1, mem: 6 },
};
const PICKUP_TYPES = ['heal', 'heal', 'shield', 'triple', 'speed', 'smg', 'shotgun', 'sniper', 'rocket', 'laser', 'boomerang', 'nades', 'nades'];
const TEAM_COLORS = ['#ff5d5d', '#4da3ff'];

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
    this.botLevel = 'easy';
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

  get walls() { return this.wallCache || MAPS[this.map].walls; }
  // the map's walls plus every crate and barrel that is still standing
  rebuildWalls() { this.wallCache = [...MAPS[this.map].walls, ...(this.props || []).filter(q => q.alive).map(q => q.rect)]; }
  enemies(a, b) { return a !== b && !(this.mode === 'team' && a.team === b.team); }
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
        if (Number.isFinite(msg.r)) p.rtt = Math.max(0, Math.min(400, msg.r)); // client's measured round trip, ms
        if (Number.isFinite(msg.g) && msg.g !== p.nadeSeen) { if (p.nadeSeen !== undefined) p.wantNade = true; p.nadeSeen = msg.g; }
        if (Array.isArray(msg.c)) for (const c of msg.c.slice(0, 40)) this.applyCmd(p, c);
        return;
      }
      case 'cfg': {
        if (id !== this.host || (this.phase !== 'lobby' && this.phase !== 'end')) return;
        if (msg.mode === 'dm' || msg.mode === 'lms' || msg.mode === 'team') this.mode = msg.mode;
        if (Number.isInteger(msg.map) && msg.map >= -1 && msg.map < MAPS.length) this.mapPick = msg.map;
        if (Number.isInteger(msg.bots)) this.setBots(msg.bots);
        if (BOT_LEVELS[msg.botLevel]) this.botLevel = msg.botLevel;
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
    this.props = (MAPS[this.map].props || []).map((pr, i) => ({ id: i, type: pr[0], x: pr[1], y: pr[2], rect: propRect(pr), hp: PROPS[pr[0]].hp, alive: true, respawnAt: 0 }));
    this.grenades = [];
    this.rebuildWalls();
    // teams: people spread evenly first, then bots fill in
    const ps = [...this.players.values()].filter(p => !p.spectator);
    const order = [...ps.filter(p => !p.bot).sort(() => Math.random() - 0.5), ...ps.filter(p => p.bot)];
    order.forEach((p, i) => { p.team = this.mode === 'team' ? i % 2 : null; });
    for (const p of this.players.values()) {
      if (p.spectator) continue;
      Object.assign(p, { kills: 0, deaths: 0, inRound: true, place: 0, buffs: { triple: 0, speed: 0 }, input: { mx: 0, my: 0, a: p.input.a, f: false } });
      this.spawn(p);
    }
    this.autoNext = 0;
    this.zoneDur = 15 * this.participants().length;
    for (let i = 0; i < 3; i++) this.spawnPickup();
    this.phase = 'count';
    this.countEnd = 3;
    this.endAt = 3 + DM_TIME;
    this.emit({ k: 'start' });
    this.sendMeta();
    this.report();
  }

  spawn(p) {
    const others = [...this.players.values()].filter(o => o.alive && this.enemies(o, p));
    let best = null, bestD = -1;
    for (let i = 0; i < 30; i++) {
      const x = 60 + Math.random() * (W - 120), y = 60 + Math.random() * (H - 120);
      if (insideWall(x, y, this.walls, R + 12)) continue;
      if (this.zone && Math.hypot(x - this.zone.x, y - this.zone.y) > this.zone.r - 60) continue;
      const d = others.length ? Math.min(...others.map(o => Math.hypot(o.x - x, o.y - y))) : 1000;
      if (d > bestD) { bestD = d; best = { x, y }; }
    }
    best ||= { x: W / 2, y: 80 };
    Object.assign(p, best, { hp: MAX_HP, shield: 0, alive: true, protect: this.t + SPAWN_SHIELD, cd: 0.4, buffs: { triple: 0, speed: 0 }, vx: 0, vy: 0, weapon: 'pistol', ammo: Infinity, dashT: 0, dashCd: 0, streak: 0, wantDash: false, nades: GRENADE.start, nadeCd: 0, wantNade: false });
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
    } else if (this.mode === 'team') {
      const score = this.teamScores();
      const win = score[0] === score[1] ? -1 : score[0] > score[1] ? 0 : 1;
      ps.forEach(p => { p.place = win === -1 || p.team === win ? 1 : 2; });
      this.winTeam = win;
    } else {
      const sorted = ps.slice().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
      sorted.forEach((p, i) => { p.place = i > 0 && sorted[i - 1].kills === p.kills && sorted[i - 1].deaths === p.deaths ? sorted[i - 1].place : i + 1; });
    }
    this.results = ps.map(p => ({ id: p.id, name: p.name, color: p.color, kills: p.kills, deaths: p.deaths, place: p.place, bot: p.bot, team: p.team }))
      .sort((a, b) => a.place - b.place || b.kills - a.kills);
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
    this.recordHistory();
    if (this.phase === 'count' && this.t >= this.countEnd) { this.phase = 'play'; this.emit({ k: 'go' }); this.sendMeta(); }
    const playing = this.phase === 'play';
    const walls = this.walls;

    if (this.mode === 'lms' && playing) {
      // 15 seconds per player: the zone closes completely by then (2 players: 30 s, 3: 45 s…).
      // A short grace period first, then it shrinks steadily to nothing, so a round always ends.
      const full = Math.hypot(W, H) / 2 + 40 + Math.hypot(this.zone.x - W / 2, this.zone.y - H / 2);
      const grace = this.zoneDur * 0.12, k = Math.min(1, Math.max(0, (this.t - this.countEnd - grace) / (this.zoneDur - grace)));
      this.zone.r = full * (1 - k);
    }

    for (const p of this.players.values()) {
      if (!p.inRound) continue;
      if (!p.alive) {
        if (this.mode !== 'lms' && playing && p.respawnAt && this.t >= p.respawnAt && (p.on || p.bot)) this.spawn(p);
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
      else move(p, inp, TICK, walls, (this.t < p.buffs.speed ? 1.4 : 1) * BOT_LEVELS[this.botLevel].speed);
      this.footsteps(p, ox, oy);
      }
      p.cd -= TICK;
      if (inp.f && p.cd <= 0) {
        const w = WEAPONS[p.weapon];
        p.cd = w.cd + (p.bot ? BOT_LEVELS[this.botLevel].extraCd : 0);
        p.lastShotT = this.t;
        const lag = this.shooterLag(p);
        for (const b of shotBullets(p.x, p.y, p.aim, this.t < p.buffs.triple, p.weapon, p.shotNo++)) this.bullets.push({ ...b, id: ++this.seq, owner: p.id, lag });
        this.emit({ k: 'shot', id: p.id, x: r1(p.x), y: r1(p.y), w: WEAPON_LIST.indexOf(p.weapon) });
        if (Number.isFinite(p.ammo) && --p.ammo <= 0) { p.weapon = 'pistol'; p.ammo = Infinity; this.emit({ k: 'empty', id: p.id }); }
        for (const o of this.players.values()) {
          if (o.bot && o.alive && o !== p && Math.hypot(o.x - p.x, o.y - p.y) < BOT_LEVELS[this.botLevel].hear * 1.6) o.ai.heard = { x: p.x, y: p.y, t: this.t };
        }
      }
      // grenade
      p.nadeCd -= TICK;
      if (p.wantNade) {
        p.wantNade = false;
        if (p.nades > 0 && p.nadeCd <= 0) {
          p.nades--; p.nadeCd = GRENADE.cd;
          const a = p.aim, d = R + 10;
          this.grenades.push({ id: ++this.seq, owner: p.id, x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d, vx: Math.cos(a) * GRENADE.speed, vy: Math.sin(a) * GRENADE.speed, fuse: GRENADE.fuse });
          this.emit({ k: 'throw', id: p.id, x: r1(p.x), y: r1(p.y) });
        }
      }
      // pickups
      for (let i = this.pickups.length - 1; i >= 0; i--) {
        const u = this.pickups[i];
        if (Math.hypot(u.x - p.x, u.y - p.y) > R + 16) continue;
        if (u.type === 'heal' && p.hp >= MAX_HP) continue;
        if (u.type === 'heal') p.hp = Math.min(MAX_HP, p.hp + 40);
        else if (u.type === 'shield') p.shield = 50;
        else if (u.type === 'nades') { if (p.nades >= GRENADE.max) continue; p.nades = Math.min(GRENADE.max, p.nades + 2); }
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
        const w = WEAPONS[b.w] || WEAPONS.pistol;
        // boomerang: after half its flight (or a wall) it turns back toward its thrower
        if (w.returns) {
          const owner = this.players.get(b.owner);
          if (!b.back && b.life < w.life * 0.5) b.back = true;
          if (b.back) {
            if (!owner?.alive) { continue; }
            const dx = owner.x - b.x, dy = owner.y - b.y, d = Math.hypot(dx, dy);
            if (d < R + 8) continue; // caught
            b.vx = (dx / d) * w.speed; b.vy = (dy / d) * w.speed;
            b.life = Math.max(b.life, 0.2);
            if ((b.backT = (b.backT || 0) + TICK) > 2.5) continue;
          }
        }
        let alive = stepBullet(b, TICK, walls);
        if (!alive) {
          const prop = this.propAt(b.x, b.y) || this.propAt((b.px + b.x) / 2, (b.py + b.y) / 2);
          if (prop) this.hitProp(prop, b.dmg || DMG, b.owner);
          if (w.returns && !b.back && b.life > 0) { b.back = true; b.x = b.px; b.y = b.py; alive = true; } // bounces home
          else if (w.blast) this.explode(b.px, b.py, w.blast.r, w.blast.dmg, b.owner, 'rocket');
        }
        if (alive) {
          for (const p of this.players.values()) {
            if (!p.alive || p.id === b.owner) continue;
            const shooter = this.players.get(b.owner);
            if (shooter && !this.enemies(shooter, p)) continue; // no friendly fire
            if (b.hitIds?.includes(p.id)) continue;
            // lag compensation: test against where the target was on the shooter's screen
            const [tx, ty] = b.lag ? this.posAt(p, this.t - b.lag) : [p.x, p.y];
            if (segDist(b.px, b.py, b.x, b.y, tx, ty) > R + BULLET_R) continue;
            if (w.pierce) (b.hitIds ||= []).push(p.id); else alive = false;
            if (this.t < p.protect) { this.emit({ k: 'block', x: r1(b.x), y: r1(b.y) }); if (!w.pierce) break; continue; }
            this.emit({ k: 'hit', v: p.id, by: b.owner, x: r1(b.x), y: r1(b.y), dmg: b.dmg || DMG });
            if (p.bot) {
              const L = BOT_LEVELS[this.botLevel];
              if (L.hear || Math.random() < 0.4) p.ai.heard = { x: b.x - b.vx * 0.5, y: b.y - b.vy * 0.5, t: this.t, hit: true };
              if (p.dashCd <= 0 && Math.random() < L.dash) p.wantDash = true;
            }
            const sp = Math.hypot(b.vx, b.vy) || 1, push = w.push || 8;
            p.x += (b.vx / sp) * push; p.y += (b.vy / sp) * push;
            collide(p, walls);
            this.damage(p, b.dmg || DMG, b.owner);
            if (w.blast) this.explode(b.x, b.y, w.blast.r, w.blast.dmg, b.owner, 'rocket', p.id);
            if (!w.pierce) break;
          }
        }
        if (alive) live.push(b);
      }
      this.bullets = live;
      this.stepGrenades();
      // crates and barrels come back after a while (not on top of someone)
      for (const q of this.props) {
        if (q.alive || this.t < q.respawnAt) continue;
        if ([...this.players.values()].some(o => o.alive && Math.hypot(o.x - q.x, o.y - q.y) < 50)) continue;
        q.alive = true; q.hp = PROPS[q.type].hp;
        this.rebuildWalls();
        this.emit({ k: 'prop', id: q.id });
      }

      if (this.t >= this.nextPickup) {
        this.nextPickup = this.t + 5;
        if (this.pickups.length < 5) this.spawnPickup();
      }

      if (this.mode !== 'lms' && this.t >= this.endAt) this.endRound();
      else if (this.mode === 'lms' && this.participants().filter(p => p.alive).length <= 1) this.endRound();
    }

    if (this.phase !== 'end') this.sendSnapshot(); // 30 updates a second
  }

  propAt(x, y) {
    return (this.props || []).find(q => q.alive && x > q.rect[0] - 2 && x < q.rect[0] + q.rect[2] + 2 && y > q.rect[1] - 2 && y < q.rect[1] + q.rect[3] + 2);
  }

  hitProp(q, dmg, by) {
    if (!q.alive) return;
    q.hp -= dmg;
    if (q.hp > 0) { this.emit({ k: 'phit', id: q.id }); return; }
    q.alive = false;
    q.respawnAt = this.t + PROPS[q.type].respawn;
    this.rebuildWalls();
    this.emit({ k: 'break', id: q.id, type: q.type, x: q.x, y: q.y });
    if (q.type === 'barrel') this.explode(q.x, q.y, PROPS.barrel.blast.r, PROPS.barrel.blast.dmg, by, 'barrel');
    else if (Math.random() < 0.35) { // a crate sometimes has something inside
      const type = PICKUP_TYPES[Math.floor(Math.random() * PICKUP_TYPES.length)];
      this.pickups.push({ id: ++this.seq, type, x: q.x, y: q.y });
    }
  }

  // An explosion: damage falls off with distance, walls shield you, it pushes people away and
  // sets off barrels and breaks crates nearby. Your own blasts hurt you at half strength.
  explode(x, y, r, dmg, by, kind, skipId = null) {
    this.emit({ k: 'boom', x: r1(x), y: r1(y), r, kind });
    const shooter = this.players.get(by);
    for (const p of this.players.values()) {
      if (!p.alive || p.id === skipId) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d > r + R) continue;
      if (shooter && p !== shooter && !this.enemies(shooter, p)) continue;
      if (blocked(x, y, p.x, p.y, this.walls)) continue;
      const f = 1 - 0.6 * Math.min(1, d / r);
      if (d > 1) { const push = 45 * f; p.x += ((p.x - x) / d) * push; p.y += ((p.y - y) / d) * push; collide(p, this.walls); }
      if (this.t < p.protect) continue;
      this.emit({ k: 'hit', v: p.id, by, x: r1(p.x), y: r1(p.y), dmg: Math.round(dmg * f * (p === shooter ? 0.5 : 1)) });
      this.damage(p, Math.round(dmg * f * (p === shooter ? 0.5 : 1)), by);
    }
    for (const q of this.props || []) if (q.alive && Math.hypot(q.x - x, q.y - y) < r) this.hitProp(q, dmg, by);
    for (const o of this.players.values()) {
      if (o.bot && o.alive && Math.hypot(o.x - x, o.y - y) < 900) o.ai.heard = { x, y, t: this.t };
    }
  }

  stepGrenades() {
    const walls = this.walls, keep = [];
    for (const g of this.grenades) {
      const f = Math.pow(0.32, TICK); // they roll to a stop in about a second
      g.vx *= f; g.vy *= f;
      const nx = g.x + g.vx * TICK, ny = g.y + g.vy * TICK;
      if (insideWall(nx, g.y, walls, 6) || nx < 6 || nx > W - 6) g.vx = -g.vx * 0.6; else g.x = nx;
      if (insideWall(g.x, ny, walls, 6) || ny < 6 || ny > H - 6) g.vy = -g.vy * 0.6; else g.y = ny;
      g.fuse -= TICK;
      if (g.fuse <= 0) this.explode(g.x, g.y, GRENADE.r, GRENADE.dmg, g.owner, 'nade');
      else keep.push(g);
    }
    this.grenades = keep;
  }

  teamScores() {
    const s = [0, 0];
    for (const p of this.players.values()) if (p.inRound && p.team != null) s[p.team] += p.kills;
    return s;
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
    const killer = by && by !== p.id && this.enemies(this.players.get(by) || {}, p) ? this.players.get(by) : null;
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
      if (o.bot && o.alive && o !== p && Math.hypot(o.x - p.x, o.y - p.y) < BOT_LEVELS[this.botLevel].hear) o.ai.heard = { x: p.x, y: p.y, t: this.t };
    }
  }

  // ---------- lag compensation ----------
  // A short history of everyone's positions (≈0.7 s) lets the server look back in time.
  recordHistory() {
    if (this.phase !== 'play') { this.hist = []; return; }
    const pos = {};
    for (const p of this.players.values()) if (p.alive) pos[p.id] = [p.x, p.y];
    (this.hist ||= []).push({ t: this.t, pos });
    if (this.hist.length > 22) this.hist.shift();
  }
  posAt(p, t) {
    const h = this.hist || [];
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].t > t) continue;
      const a = h[i].pos[p.id], nb = h[i + 1], b = nb?.pos[p.id];
      if (!a) return [p.x, p.y];
      if (!b) return a;
      const k = (t - h[i].t) / (nb.t - h[i].t);
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    }
    return h[0]?.pos[p.id] || [p.x, p.y];
  }
  // How far back the shooter's screen is: a full round trip plus the display delay.
  shooterLag(p) {
    if (p.bot) return 0;
    return Math.min(0.25, (p.rtt || 0) / 1000 + INTERP_MS / 1000 + TICK / 2);
  }
  // What a bot "sees" of player o: humans as they were half a round trip + display delay ago
  // (their server position already trails their own screen by the other half).
  perceived(o) {
    if (o.bot) return o;
    const [x, y] = this.posAt(o, this.t - Math.min(0.25, (o.rtt || 0) / 2000 + INTERP_MS / 1000));
    return { id: o.id, x, y, lastShotT: o.lastShotT, alive: true };
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
    const ai = p.ai, walls = this.walls, L = BOT_LEVELS[this.botLevel];
    let target = null, td = Infinity;
    for (const real of this.players.values()) {
      if (!real.alive || !this.enemies(p, real)) continue;
      // bots see people with the same delay people see bots (ping + display smoothing)
      const o = this.perceived(real);
      if (!this.visible(p, o)) continue;
      if (Math.hypot(o.x - p.x, o.y - p.y) > 720 * L.view) continue; // weaker bots see less far
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d < td) { td = d; target = o; }
    }
    if (target) { ai.mem = { x: target.x, y: target.y, t: this.t }; ai.seen += TICK; } else ai.seen = 0;
    // throw a grenade at someone hiding nearby, now and then (not the weakest bots)
    if (this.botLevel !== 'vez' && p.nades > 0 && p.nadeCd <= 0 && Math.random() < (this.botLevel === 'hard' ? 0.02 : 0.008)) {
      const m = target || (ai.mem && this.t - ai.mem.t < 1.5 ? ai.mem : null);
      const d = m ? Math.hypot(m.x - p.x, m.y - p.y) : 1e9;
      if (d > 140 && d < 360) { p.input.a = Math.atan2(m.y - p.y, m.x - p.x); p.wantNade = true; }
    }
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
    else if (ai.mem && this.t - ai.mem.t < L.mem) { goal = ai.mem; look = ai.mem; if (Math.hypot(ai.mem.x - p.x, ai.mem.y - p.y) < 50) ai.mem = null; }
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
      let a = dist > far ? toT : dist < close ? toT + Math.PI + ai.strafe * 0.6 : L.strafe ? toT + ai.strafe * Math.PI / 2 : toT;
      if (!L.strafe && dist <= far && dist >= close) a = null; // weak bots just stand and shoot
      for (const off of a === null ? [] : [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
        const q = { x: p.x, y: p.y };
        move(q, { mx: Math.cos(a + off), my: Math.sin(a + off) }, 0.25, walls, 1, true);
        if (Math.hypot(q.x - p.x, q.y - p.y) > SPEED * 0.25 * 0.7) { a += off; break; }
      }
      if (a !== null) { mx = Math.cos(a); my = Math.sin(a); }
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
        ai.err = gauss * (L.err + dist * L.errD);
        ai.leadK = (L.leadMin || 0) + Math.random() * L.lead;
      }
      const lead = (dist / BULLET_SPEED) * ai.leadK;
      want = Math.atan2(target.y + vy * lead - p.y, target.x + vx * lead - p.x) + ai.err;
      turn = L.turn;
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
    p.input.f = fight && dist < range * L.range && ai.seen > L.react && Math.abs(da) < 0.12 && this.t >= p.protect - SPAWN_SHIELD + 0.5;
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
      tl: this.phase === 'count' ? r1(this.countEnd - this.t) : this.mode !== 'lms' ? r1(Math.max(0, this.endAt - this.t)) : r1(Math.max(0, this.countEnd + this.zoneDur - this.t)),
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
        if (p === v || !p.alive || seesAll || this.visible(v, p) || (this.mode === 'team' && v && p.team === v.team)) { rows.push(row); if (p.alive) visible.add(p.id); }
        else rows.push([p.id, 0, 0, 0, 0, 2, 0, 0, 0]); // alive but hidden (alive = 2, keeps counts right)
      }
      const near = (x, y, d) => seesAll || Math.hypot(x - v.x, y - v.y) < d;
      const ev = this.events.filter(e => {
        if (['kill', 'start', 'go', 'end', 'spawn', 'multi', 'streak', 'stop', 'boom', 'break', 'prop'].includes(e.k)) return true;
        if (e.v === v?.id || e.by === v?.id || e.id === v?.id) return true;
        if (e.k === 'shot') return near(e.x, e.y, 900);
        return e.x === undefined || sees(e.x, e.y);
      }).map(e => (e.k === 'kill' && e.x !== undefined && !sees(e.x, e.y) && e.a !== v?.id && e.v !== v?.id ? { k: e.k, a: e.a, v: e.v } : e));
      const msg = {
        ...base, p: rows, ev,
        me: v && v.inRound ? { w: WEAPON_LIST.indexOf(v.weapon), am: Number.isFinite(v.ammo) ? v.ammo : -1, dc: r1(Math.max(0, v.dashCd)), st: v.streak, nd: v.nades || 0 } : null,
        b: this.bullets.filter(b => b.owner === v?.id || sees(b.x, b.y)).map(b => [b.id, r1(b.x), r1(b.y), r1(b.vx), r1(b.vy), b.owner, WEAPON_LIST.indexOf(b.w)]),
        gr: this.grenades.map(g => [g.id, r1(g.x), r1(g.y), r1(g.fuse)]),
        pr: (this.props || []).map(q => (q.alive ? 1 : 0)),
        fs: seesAll ? [] : this.steps.filter(st => st[4] !== v.id && !visible.has(st[4]) && near(st[0], st[1], 1100)).map(st => st.slice(0, 4)),
      };
      try { ws.send(JSON.stringify(msg)); } catch {}
    }
    if (!to) { this.events = []; this.steps = []; }
  }

  sendMeta() {
    this.broadcast({
      t: 'room', code: this.code, pub: this.pub, host: this.host, phase: this.phase, mode: this.mode,
      mapPick: this.mapPick, map: this.map, bots: this.botCount, botLevel: this.botLevel,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, bot: p.bot, on: p.on, k: p.kills, d: p.deaths, inRound: p.inRound, lvl: p.bot ? 0 : p.lvl, team: p.team ?? null })),
      teamScore: this.mode === 'team' ? this.teamScores() : null, winTeam: this.phase === 'end' ? this.winTeam ?? null : null,
      next: this.phase === 'end' && this.autoNext ? Math.max(0, Math.round((this.autoNext - Date.now()) / 1000)) : null,
      results: this.results,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// המבוך: a co-op dungeon run for 1–4 players. Lobby → run (DungeonSim) → won / lost → again.
// A "daily" room is a solo run on the seed of the UTC day; a clean (no admin) result goes to the daily leaderboard.
const ADMIN_NAME = 'אורי מורי';
const isAdminName = name => String(name || '').trim() === ADMIN_NAME;
const ADMIN_CMDS = new Set(['god', 'coins', 'addcoins', 'heal', 'maxhp', 'item', 'weapon', 'killroom', 'nextfloor', 'reveal', 'speed', 'dmg', 'reviveall']);
const SHOT_KINDS = { bolt: 0, fire: 1, fireball: 1, ice: 2, dagger: 3, daggers: 3, spear: 4, arrow: 4 };
const validHero = h => Number.isInteger(h) && h >= 0 && h < (HEROES?.length || 4);
// admin values: a number (clamped) or a short key such as an item / weapon name
const cleanAdminVal = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.max(-1e6, Math.min(1e6, Math.round(v))) : 0;
  if (typeof v === 'string') { const s = v.slice(0, 24).replace(/[^a-zA-Z0-9_:-]/g, ''); return /^-?\d+$/.test(s) ? Math.max(-1e6, Math.min(1e6, +s)) : s; }
  return null;
};

export class Dungeon {
  constructor(state, env) {
    this.env = env;
    this.code = null;
    this.players = new Map(); // id -> { id, name, on, hero, b }
    this.sockets = new Map();
    this.host = null;
    this.phase = 'lobby'; // lobby | play | end
    this.sim = null;
    this.daily = false; // this room plays the daily run
    this.posted = false; // daily result already sent for the current run
    this.events = [];
    this.timer = null;
    this.tickNo = 0;
  }

  async fetch(req) {
    this.code ||= req.headers.get('x-code');
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener('message', e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      try { this.onMessage(server, msg); } catch (err) { try { server.send(JSON.stringify({ t: 'err', m: 'שגיאת שרת' })); } catch {} }
    });
    const gone = () => this.onClose(server);
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    if (!this.timer) { this.last = Date.now(); this.acc = 0; this.timer = setInterval(() => this.loop(), 1000 / 30); }
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, m) { try { ws.send(JSON.stringify(m)); } catch {} }
  broadcast(m) { const s = JSON.stringify(m); for (const ws of this.sockets.keys()) { try { ws.send(s); } catch {} } }
  mm() { return this.env.MM.get(this.env.MM.idFromName('main')); }

  report(closed = false) {
    if (!this.code) return;
    const body = JSON.stringify({ code: this.code, pub: false, humans: [...this.players.values()].filter(p => p.on).length, phase: this.phase, mode: 'dungeon', closed });
    this.mm().fetch('https://mm/report', { method: 'POST', body }).catch(() => {});
  }

  onMessage(ws, msg) {
    if (msg.t === 'ping') return this.send(ws, { t: 'pong', c: msg.c });
    if (msg.t === 'hello') return this.join(ws, msg);
    const id = this.sockets.get(ws), p = id && this.players.get(id);
    if (!p) return;
    if (msg.t === 'in' && this.sim) {
      const sp = this.sim.players.get(id);
      if (!sp) return;
      sp.input = { a: Number(msg.a) || 0, f: !!msg.f };
      if (Number.isFinite(msg.r)) sp.rtt = Math.max(0, Math.min(400, msg.r));
      if (Array.isArray(msg.c)) for (const c of msg.c.slice(0, 40)) if (Array.isArray(c)) this.sim.applyCmd(sp, c);
      // ability presses: b is a counter the client bumps on each press. The first value after a
      // (re)connect, or a counter that went backwards (client reloaded), only sets the baseline.
      if (Number.isInteger(msg.b) && msg.b >= 0) {
        if (p.b == null || msg.b < p.b) p.b = msg.b;
        else if (msg.b > p.b) {
          p.b = msg.b;
          if (this.phase === 'play' && this.sim.phase === 'play' && sp.alive) this.sim.useAbility(sp);
        }
      }
      return;
    }
    if (msg.t === 'hero') {
      const h = Number(msg.h);
      if (validHero(h) && this.phase !== 'play') { p.hero = h; this.sendMeta(); }
      return;
    }
    if (msg.t === 'adm') {
      if (!isAdminName(p.name) || !this.sim || this.phase !== 'play') return;
      const sp = this.sim.players.get(id), c = String(msg.c || '');
      if (!sp || !ADMIN_CMDS.has(c)) return;
      this.sim.admin(sp, c, cleanAdminVal(msg.v));
      return this.sendMeta(); // run.cheated changed
    }
    if (msg.t === 'start' && id === this.host && this.phase !== 'play') return this.startRun();
    if (msg.t === 'lobby' && id === this.host && this.phase === 'end') { this.phase = 'lobby'; this.sim = null; return this.sendMeta(); }
  }

  join(ws, msg) {
    const id = String(msg.id || '').slice(0, 20), name = String(msg.name || '').trim().slice(0, 16) || 'שחקן';
    if (!id) return;
    const hero = Number(msg.hero);
    if (msg.daily && this.players.size === 0 && this.phase === 'lobby') this.daily = true;
    let p = this.players.get(id);
    if (!p) {
      // the daily run is solo
      if (this.players.size >= D_MAX || (this.daily && this.players.size >= 1)) { this.send(ws, { t: 'err', m: 'החדר מלא', fatal: true }); return ws.close(1000, 'full'); }
      p = { id, name, on: true, hero: validHero(hero) ? hero : null, b: null };
      this.players.set(id, p);
      // joining a run in progress: appear next to a friend
      if (this.sim && this.phase === 'play' && !this.sim.players.has(id)) {
        const i = this.sim.players.size;
        const sp = this.sim.newPlayer({ id, name, hero: validHero(p.hero) ? p.hero : i % 4 }, i);
        const friend = this.sim.alivePlayers()[0];
        if (friend) { sp.x = friend.x + 30; sp.y = friend.y; dCollide(sp, this.sim.solid); }
        this.sim.players.set(id, sp);
      }
    } else if (validHero(hero) && this.phase !== 'play') p.hero = hero;
    for (const [w, pid] of this.sockets) if (pid === id && w !== ws) { this.sockets.delete(w); try { w.close(1000, 'replaced'); } catch {} }
    p.name = name; p.on = true; p.off = 0;
    p.b = null; // new connection: the next ability counter is only a baseline
    this.sockets.set(ws, id);
    if (!this.host || !this.players.get(this.host)?.on) this.host = id;
    const sp = this.sim?.players.get(id);
    if (sp) sp.lastSeq = 0;
    this.send(ws, { t: 'welcome', id, code: this.code });
    this.sendMeta();
    if ((msg.solo || msg.daily) && this.phase === 'lobby' && this.players.size === 1) this.startRun(); // "play alone" starts at once
    this.report();
  }

  onClose(ws) {
    const id = this.sockets.get(ws);
    if (!this.sockets.delete(ws) || !id || [...this.sockets.values()].includes(id)) return;
    const p = this.players.get(id);
    if (!p) return;
    p.on = false; p.off = Date.now();
    if (this.phase === 'lobby') this.players.delete(id);
    if (!this.players.get(this.host)?.on) this.host = [...this.players.values()].find(o => o.on)?.id || null;
    this.sendMeta();
    this.report();
  }

  startRun() {
    const ps = [...this.players.values()].filter(p => p.on);
    if (!ps.length) return;
    const seed = this.daily ? utcDay() : Math.floor(Math.random() * 1e9);
    this.day = this.daily ? seed : null;
    this.sim = new DungeonSim(ps.map((p, i) => ({ id: p.id, name: p.name, hero: validHero(p.hero) ? p.hero : i % 4 })), seed, ev => this.events.push(ev), { daily: this.daily });
    this.posted = false;
    this.phase = 'play';
    this.sendMeta();
    this.report();
  }

  score() { try { return Math.max(0, Math.round(this.sim?.score?.() || 0)); } catch { return 0; } }

  // a daily run that ended without admin help goes to the leaderboard (once per run)
  postDaily() {
    const sim = this.sim;
    if (!this.daily || !sim || this.posted || sim.cheated) return;
    this.posted = true;
    const p = [...sim.players.values()][0];
    if (!p) return;
    const body = JSON.stringify({ d: this.day, name: this.players.get(p.id)?.name || p.name, score: this.score(), floor: sim.floor, won: sim.phase === 'won', kills: sim.kills });
    this.mm().fetch('https://mm/daily-add', { method: 'POST', body }).catch(() => {});
  }

  loop() {
    const now = Date.now();
    this.acc += Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    // players gone for a while leave the run
    for (const p of [...this.players.values()]) if (!p.on && now - p.off > 30000) { this.players.delete(p.id); this.sim?.players.delete(p.id); this.sendMeta(); }
    while (this.acc >= D_TICK) {
      this.acc -= D_TICK;
      if (this.phase === 'play' && this.sim) {
        // a disconnected player stands still
        for (const sp of this.sim.players.values()) if (!this.players.get(sp.id)?.on) sp.input = { a: sp.aim, f: false };
        this.sim.tick();
        this.tickNo++;
        if (this.sim.phase !== 'play') { this.phase = 'end'; this.postDaily(); this.sendSnapshot(); this.sendMeta(); this.report(); }
        else this.sendSnapshot();
      }
    }
    if (this.sockets.size === 0) {
      this.emptySince ||= now;
      if (now - this.emptySince > 60000) { clearInterval(this.timer); this.timer = null; this.players.clear(); this.sim = null; this.phase = 'lobby'; this.daily = false; this.report(true); }
    } else this.emptySince = 0;
  }

  sendMeta() {
    const sim = this.sim;
    this.broadcast({
      t: 'room', code: this.code, host: this.host, phase: this.phase, daily: this.daily,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, on: p.on, hero: sim?.players.get(p.id)?.hero ?? p.hero ?? null, ...(isAdminName(p.name) ? { admin: true } : {}) })),
      run: sim ? { seed: sim.seed, floor: sim.floor, result: sim.phase, kills: sim.kills, coins: sim.coins, t: Math.round(sim.t), daily: this.daily, score: this.score(), cheated: !!sim.cheated } : null,
    });
  }

  sendSnapshot() {
    const sim = this.sim, r1 = v => Math.round((v || 0) * 10) / 10, r2 = v => Math.round((v || 0) * 100) / 100;
    const rooms = new Set([...sim.players.values()].filter(p => p.alive).map(p => dRoomAt(sim.layout, p.x, p.y)));
    const ack = {};
    const players = [...sim.players.values()].map(p => {
      ack[p.id] = p.lastSeq;
      const max = HEROES?.[p.hero]?.abCd || 1;
      return [p.id, r1(p.x), r1(p.y), r2(p.aim), p.hp, p.st.maxHp, p.alive ? 1 : 0, sim.t < p.inv ? 1 : 0, p.dashT > 0 ? 1 : 0, r1(p.vx), r1(p.vy), p.hero, p.st.orbit, Math.round(p.st.speed),
        p.weapon || null, r2(Math.max(0, Math.min(1, 1 - (p.abCd || 0) / max))), sim.t < (p.shieldT || 0) ? 1 : 0, r2(p.revive), p.god ? 1 : 0];
    });
    const base = {
      t: 's', ph: sim.phase, fl: sim.floor, seed: sim.seed, ot: r2(sim.t), ack, p: players,
      rs: sim.rooms.map(r => (r.visited ? 1 : 0) | (r.cleared ? 2 : 0) | (r.locked ? 4 : 0)),
      so: sim.secretOpen ? 1 : 0, ck: sim.crackHits || 0,
      e: sim.enemies.filter(e => rooms.has(e.room)).map(e => [e.id, ENEMY_LIST.indexOf(e.type), r1(e.x), r1(e.y), Math.ceil(e.hp), Math.ceil(e.maxHp), sim.t < e.wake ? 1 : 0, sim.t < e.slow ? 1 : 0, e.face,
        e.elite ? 1 : 0, e.warn ? 1 : 0, e.phase === 2 ? 2 : 1]),
      s: sim.shots.map(s => [s.id, r1(s.x), r1(s.y), r1(s.vx), r1(s.vy), r1(s.r), s.enemy ? 1 : 0, s.owner || null, typeof s.kind === 'number' ? s.kind : SHOT_KINDS[s.kind] ?? 0]),
      u: sim.pickups.map(u => [u.id, u.type, r1(u.x), r1(u.y)]),
      ped: sim.pedestals.map(d => [d.id, d.code ?? d.item, r1(d.x), r1(d.y), d.set ?? null, d.price || 0, d.curse ? 1 : 0]),
      ch: (sim.chests || []).map(c => [c.id, r1(c.x), r1(c.y), c.kind === 1 || c.kind === 'gold' ? 1 : 0, c.open ? 1 : 0]),
      td: sim.trapdoor ? [r1(sim.trapdoor.x), r1(sim.trapdoor.y)] : null,
      ev: this.events,
      coins: sim.coins, kills: sim.kills, score: this.score(), daily: this.daily ? 1 : 0, cheated: sim.cheated ? 1 : 0,
    };
    this.events = [];
    for (const [ws, id] of this.sockets) {
      const sp = sim.players.get(id);
      const me = sp ? {
        items: sp.items, st: { dmg: Math.round(sp.st.dmg), cd: r2(sp.st.cd), shots: sp.st.shots, life: r2(sp.st.life), size: r1(sp.st.size) }, dc: r1(Math.max(0, sp.dashCd)), took: sp.tookSets || [],
        w: sp.weapon || null, ab: { cd: r1(Math.max(0, sp.abCd || 0)), max: HEROES?.[sp.hero]?.abCd || 0 }, god: sp.god ? 1 : 0,
      } : null;
      try { ws.send(JSON.stringify({ ...base, me })); } catch {}
    }
  }
}
