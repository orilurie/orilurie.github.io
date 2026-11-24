var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../hathatul/arena-core.js
var W = 1600;
var H = 1e3;
var R = 18;
var SPEED = 240;
var BULLET_SPEED = 780;
var BULLET_R = 5;
var BULLET_LIFE = 0.85;
var FIRE_CD = 0.24;
var DMG = 20;
var MAX_HP = 100;
var TICK = 1 / 30;
var MAX_PLAYERS = 6;
var DM_TIME = 150;
var RESPAWN = 2.5;
var SPAWN_SHIELD = 1.2;
var COLORS = ["#ff5d5d", "#4da3ff", "#3ccf7a", "#ffb02e", "#b36bff", "#ff6fc8"];
var BUFF_TIME = { triple: 8, speed: 6 };
var pillars = /* @__PURE__ */ __name(() => {
  const out = [];
  [300, 550, 800, 1050, 1300].forEach((x, i) => [250, 500, 750].forEach((y, j) => {
    if ((i + j) % 2 === 0 && !(x === 800 && y === 500)) out.push([x - 35, y - 35, 70, 70]);
  }));
  out.push([760, 460, 80, 80]);
  return out;
}, "pillars");
var MAPS = [
  {
    name: "\u05DE\u05D1\u05E6\u05E8",
    walls: [
      [740, 440, 120, 120],
      [300, 200, 200, 40],
      [300, 200, 40, 160],
      [1100, 200, 200, 40],
      [1260, 200, 40, 160],
      [300, 760, 200, 40],
      [300, 640, 40, 160],
      [1100, 760, 200, 40],
      [1260, 640, 40, 160],
      [780, 110, 40, 180],
      [780, 710, 40, 180],
      [120, 480, 160, 40],
      [1320, 480, 160, 40]
    ]
  },
  { name: "\u05E2\u05DE\u05D5\u05D3\u05D9\u05DD", walls: pillars() },
  {
    name: "\u05DE\u05E1\u05D3\u05E8\u05D5\u05E0\u05D5\u05EA",
    walls: [
      [200, 320, 480, 36],
      [920, 320, 480, 36],
      [200, 644, 480, 36],
      [920, 644, 480, 36],
      [782, 120, 36, 230],
      [782, 650, 36, 230],
      [500, 470, 36, 60],
      [1064, 470, 36, 60]
    ]
  }
];
var clamp = /* @__PURE__ */ __name((v, a, b) => v < a ? a : v > b ? b : v, "clamp");
function collide(p, walls, r = R) {
  for (const [x, y, w, h] of walls) {
    const cx = clamp(p.x, x, x + w), cy = clamp(p.y, y, y + h);
    let dx = p.x - cx, dy = p.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r) continue;
    if (d2 > 1e-6) {
      const d = Math.sqrt(d2);
      p.x = cx + dx / d * r;
      p.y = cy + dy / d * r;
    } else {
      const opts = [[p.x - x + r, -1, 0], [x + w - p.x + r, 1, 0], [p.y - y + r, 0, -1], [y + h - p.y + r, 0, 1]];
      opts.sort((a, b) => a[0] - b[0]);
      p.x += opts[0][1] * opts[0][0];
      p.y += opts[0][2] * opts[0][0];
    }
  }
  p.x = clamp(p.x, r, W - r);
  p.y = clamp(p.y, r, H - r);
}
__name(collide, "collide");
function move(p, input, dt, walls, speedMul = 1) {
  let mx = input.mx || 0, my = input.my || 0;
  const len = Math.hypot(mx, my);
  if (len > 1) {
    mx /= len;
    my /= len;
  }
  p.x += mx * SPEED * speedMul * dt;
  p.y += my * SPEED * speedMul * dt;
  collide(p, walls);
}
__name(move, "move");
var insideWall = /* @__PURE__ */ __name((x, y, walls, pad = 0) => walls.some(([wx, wy, w, h]) => x > wx - pad && x < wx + w + pad && y > wy - pad && y < wy + h + pad), "insideWall");
function blocked(ax, ay, bx, by, walls) {
  const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / 12);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (insideWall(ax + (bx - ax) * t, ay + (by - ay) * t, walls)) return true;
  }
  return false;
}
__name(blocked, "blocked");
function segDist(ax, ay, bx, by, px, py) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
  return Math.hypot(ax + dx * t - px, ay + dy * t - py);
}
__name(segDist, "segDist");
function shotBullets(x, y, aim, triple) {
  const angles = triple ? [aim - 0.16, aim, aim + 0.16] : [aim];
  return angles.map((a) => ({
    x: x + Math.cos(a) * (R + 6),
    y: y + Math.sin(a) * (R + 6),
    vx: Math.cos(a) * BULLET_SPEED,
    vy: Math.sin(a) * BULLET_SPEED,
    life: BULLET_LIFE
  }));
}
__name(shotBullets, "shotBullets");
function stepBullet(b, dt, walls) {
  b.px = b.x;
  b.py = b.y;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.life -= dt;
  if (b.life <= 0 || b.x < 0 || b.y < 0 || b.x > W || b.y > H) return false;
  const mx = (b.px + b.x) / 2, my = (b.py + b.y) / 2;
  return !insideWall(b.x, b.y, walls) && !insideWall(mx, my, walls);
}
__name(stepBullet, "stepBullet");

// src/index.js
var CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Cache-Control": "no-store" };
var json = /* @__PURE__ */ __name((obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } }), "json");
var LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
var randCode = /* @__PURE__ */ __name(() => Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join(""), "randCode");
var src_default = {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const mm = env.MM.get(env.MM.idFromName("main"));
    if (url.pathname === "/api/quick" || url.pathname === "/api/new" || url.pathname === "/api/check") {
      const r = await mm.fetch(`https://mm${url.pathname.slice(4)}${url.search}`);
      return json(await r.json());
    }
    const m = url.pathname.match(/^\/ws\/([A-Z]{4})$/);
    if (m) {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const room = env.ROOM.get(env.ROOM.idFromName(m[1]));
      const headers = new Headers(req.headers);
      headers.set("x-code", m[1]);
      return room.fetch(new Request(req.url, { headers }));
    }
    if (url.pathname === "/") return json({ ok: true, game: "arena" });
    return json({ error: "not found" }, 404);
  }
};
var Matchmaker = class {
  static {
    __name(this, "Matchmaker");
  }
  constructor(state) {
    this.rooms = /* @__PURE__ */ new Map();
  }
  // code -> { pub, humans, phase, mode, t }
  fresh(r) {
    return Date.now() - r.t < 25e3;
  }
  async fetch(req) {
    const url = new URL(req.url);
    for (const [c, r] of this.rooms) if (!this.fresh(r)) this.rooms.delete(c);
    if (url.pathname === "/report") {
      const r = await req.json();
      if (r.closed) this.rooms.delete(r.code);
      else this.rooms.set(r.code, { ...r, t: Date.now() });
      return json({ ok: true });
    }
    if (url.pathname === "/check") {
      const r = this.rooms.get((url.searchParams.get("code") || "").toUpperCase());
      return json(r ? { exists: true, humans: r.humans, phase: r.phase } : { exists: false });
    }
    const reserve = /* @__PURE__ */ __name((pub) => {
      let code;
      do
        code = randCode();
      while (this.rooms.has(code));
      this.rooms.set(code, { code, pub, humans: 0, phase: "lobby", mode: "dm", t: Date.now(), reserved: true });
      return code;
    }, "reserve");
    if (url.pathname === "/new") return json({ code: reserve(false) });
    if (url.pathname === "/quick") {
      const open = [...this.rooms.values()].filter((r) => r.pub && r.humans < MAX_PLAYERS && (r.phase === "lobby" || r.phase === "count" || r.phase === "play" && r.mode === "dm")).sort((a, b) => b.humans - a.humans);
      return json({ code: open[0]?.code || reserve(true) });
    }
    return json({ error: "not found" }, 404);
  }
};
var r1 = /* @__PURE__ */ __name((v) => Math.round(v * 10) / 10, "r1");
var r2 = /* @__PURE__ */ __name((v) => Math.round(v * 100) / 100, "r2");
var BOT_NAMES = ["\u05E8\u05D5\u05D1\u05D9", "\u05E6\u05F3\u05D9\u05E4", "\u05D1\u05D9\u05E4", "\u05D6\u05D9\u05D2\u05D9", "\u05D8\u05D5\u05E8\u05D1\u05D5"];
var PICKUP_TYPES = ["heal", "heal", "shield", "triple", "speed"];
var Room = class {
  static {
    __name(this, "Room");
  }
  constructor(state, env) {
    this.env = env;
    this.code = null;
    this.pub = false;
    this.players = /* @__PURE__ */ new Map();
    this.sockets = /* @__PURE__ */ new Map();
    this.host = null;
    this.phase = "lobby";
    this.mode = "dm";
    this.mapPick = -1;
    this.botCount = 0;
    this.map = 0;
    this.bullets = [];
    this.pickups = [];
    this.events = [];
    this.timer = null;
    this.t = 0;
    this.tickNo = 0;
    this.seq = 0;
    this.results = null;
    this.lastReport = 0;
  }
  get walls() {
    return MAPS[this.map].walls;
  }
  humans() {
    return [...this.players.values()].filter((p) => !p.bot);
  }
  participants() {
    return [...this.players.values()].filter((p) => p.inRound);
  }
  async fetch(req) {
    this.code ||= req.headers.get("x-code");
    if (new URL(req.url).searchParams.get("pub") === "1") this.pub = true;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.addEventListener("message", (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      try {
        this.onMessage(server, msg);
      } catch (err) {
        this.sendTo(server, { t: "err", m: "\u05E9\u05D2\u05D9\u05D0\u05EA \u05E9\u05E8\u05EA" });
      }
    });
    const gone = /* @__PURE__ */ __name(() => this.onClose(server), "gone");
    server.addEventListener("close", gone);
    server.addEventListener("error", gone);
    this.ensureTimer();
    return new Response(null, { status: 101, webSocket: client });
  }
  sendTo(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
    }
  }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.sockets.keys()) {
      try {
        ws.send(s);
      } catch {
      }
    }
  }
  ensureTimer() {
    if (this.timer) return;
    this.last = Date.now();
    this.acc = 0;
    this.timer = setInterval(() => this.loop(), 1e3 / 30);
  }
  loop() {
    const now = Date.now();
    this.acc += Math.min(0.25, (now - this.last) / 1e3);
    this.last = now;
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.tick();
    }
    if (now - this.lastReport > 8e3) this.report();
    if (this.sockets.size === 0) {
      this.emptySince ||= now;
      if (now - this.emptySince > 3e4) {
        clearInterval(this.timer);
        this.timer = null;
        this.players.clear();
        this.phase = "lobby";
        this.report(true);
      }
    } else this.emptySince = 0;
  }
  report(closed = false) {
    this.lastReport = Date.now();
    if (!this.code) return;
    const body = JSON.stringify({ code: this.code, pub: this.pub, humans: this.humans().filter((p) => p.on).length, phase: this.phase, mode: this.mode, closed });
    const mm = this.env.MM.get(this.env.MM.idFromName("main"));
    mm.fetch("https://mm/report", { method: "POST", body }).catch(() => {
    });
  }
  // ---------- connections ----------
  onMessage(ws, msg) {
    if (msg.t === "hello") return this.join(ws, msg);
    if (msg.t === "ping") return this.sendTo(ws, { t: "pong", c: msg.c });
    const id = this.sockets.get(ws);
    const p = id && this.players.get(id);
    if (!p) return;
    switch (msg.t) {
      case "in": {
        if (!Number.isFinite(msg.s) || msg.s <= p.lastSeq) return;
        p.lastSeq = msg.s;
        const mx = Number(msg.mx) || 0, my = Number(msg.my) || 0, l = Math.hypot(mx, my);
        p.input = { mx: l > 1 ? mx / l : mx, my: l > 1 ? my / l : my, a: Number(msg.a) || 0, f: !!msg.f };
        return;
      }
      case "cfg": {
        if (id !== this.host || this.phase !== "lobby" && this.phase !== "end") return;
        if (msg.mode === "dm" || msg.mode === "lms") this.mode = msg.mode;
        if (Number.isInteger(msg.map) && msg.map >= -1 && msg.map < MAPS.length) this.mapPick = msg.map;
        if (Number.isInteger(msg.bots)) this.setBots(msg.bots);
        return this.sendMeta();
      }
      case "start":
        if (id !== this.host || this.phase !== "lobby" && this.phase !== "end") return;
        if (this.players.size < 2) return this.sendTo(ws, { t: "err", m: "\u05E6\u05E8\u05D9\u05DA \u05DC\u05E4\u05D7\u05D5\u05EA 2 \u05DE\u05E9\u05EA\u05EA\u05E4\u05D9\u05DD \u2013 \u05D4\u05D5\u05E1\u05D9\u05E4\u05D5 \u05D1\u05D5\u05D8 \u{1F916}" });
        return this.startRound();
      case "lobby":
        if (id !== this.host || this.phase !== "end") return;
        this.phase = "lobby";
        this.results = null;
        return this.sendMeta();
      case "emoji":
        if (typeof msg.e === "string" && msg.e.length <= 4) this.broadcast({ t: "emo", id, e: msg.e });
        return;
    }
  }
  join(ws, msg) {
    const id = String(msg.id || "").slice(0, 20);
    const name = String(msg.name || "").trim().slice(0, 16) || "\u05E9\u05D7\u05E7\u05DF";
    if (!id) return;
    let p = this.players.get(id);
    if (!p) {
      if (this.humans().length >= MAX_PLAYERS) {
        this.sendTo(ws, { t: "err", m: "\u05D4\u05D7\u05D3\u05E8 \u05DE\u05DC\u05D0", fatal: true });
        return ws.close(1e3, "full");
      }
      while (this.players.size >= MAX_PLAYERS) this.removeBot();
      p = this.newPlayer(id, name, false);
      if (this.phase === "count" || this.phase === "play" && this.mode === "dm") {
        p.inRound = true;
        p.alive = false;
        p.respawnAt = this.t + 1;
      }
    }
    for (const [w, pid] of this.sockets) if (pid === id && w !== ws) {
      this.sockets.delete(w);
      try {
        w.close(1e3, "replaced");
      } catch {
      }
    }
    p.name = name;
    p.on = true;
    p.offSince = 0;
    this.sockets.set(ws, id);
    if (!this.host || !this.players.get(this.host)?.on) this.host = id;
    this.sendTo(ws, { t: "welcome", id, code: this.code });
    this.sendMeta();
    if (this.phase !== "lobby") this.sendSnapshot([ws]);
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
    if (this.phase === "lobby" || this.phase === "end") this.players.delete(id);
    this.pickHost();
    this.sendMeta();
    this.report();
  }
  pickHost() {
    if (this.players.get(this.host)?.on) return;
    this.host = this.humans().find((p) => p.on)?.id || null;
  }
  newPlayer(id, name, bot) {
    const used = new Set([...this.players.values()].map((p2) => p2.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[this.players.size % COLORS.length];
    const p = {
      id,
      name,
      bot,
      color,
      on: true,
      x: W / 2,
      y: H / 2,
      aim: 0,
      hp: MAX_HP,
      shield: 0,
      alive: false,
      inRound: false,
      kills: 0,
      deaths: 0,
      cd: 0,
      lastSeq: 0,
      input: { mx: 0, my: 0, a: 0, f: false },
      buffs: { triple: 0, speed: 0 },
      protect: 0,
      respawnAt: 0,
      place: 0
    };
    if (bot) p.ai = { next: 0, dir: 0, strafe: 1, seen: 0, tx: W / 2, ty: H / 2, prev: {} };
    this.players.set(id, p);
    return p;
  }
  setBots(n) {
    const want = Math.max(0, Math.min(n, MAX_PLAYERS - this.humans().length));
    const bots = /* @__PURE__ */ __name(() => [...this.players.values()].filter((p) => p.bot), "bots");
    while (bots().length > want) this.removeBot();
    let i = 0;
    while (bots().length < want) {
      const id = "bot" + ++i;
      if (this.players.has(id)) continue;
      this.newPlayer(id, `\u{1F916} ${BOT_NAMES[(i - 1) % BOT_NAMES.length]}`, true);
    }
    this.botCount = want;
  }
  removeBot() {
    const b = [...this.players.values()].reverse().find((p) => p.bot);
    if (b) this.players.delete(b.id);
    this.botCount = [...this.players.values()].filter((p) => p.bot).length;
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
    let zx = W / 2, zy = H / 2;
    for (let i = 0; i < 40; i++) {
      const x = W / 2 + (Math.random() - 0.5) * 700, y = H / 2 + (Math.random() - 0.5) * 400;
      if (!insideWall(x, y, MAPS[this.map].walls, 60)) {
        zx = x;
        zy = y;
        break;
      }
    }
    this.zone = { x: zx, y: zy, r: Math.hypot(W, H) / 2 + 40 };
    for (const p of this.players.values()) {
      Object.assign(p, { kills: 0, deaths: 0, inRound: true, place: 0, buffs: { triple: 0, speed: 0 }, input: { mx: 0, my: 0, a: p.input.a, f: false } });
      this.spawn(p);
    }
    this.phase = "count";
    this.countEnd = 3;
    this.endAt = 3 + DM_TIME;
    this.emit({ k: "start" });
    this.sendMeta();
    this.report();
  }
  spawn(p) {
    const others = [...this.players.values()].filter((o) => o !== p && o.alive);
    let best = null, bestD = -1;
    for (let i = 0; i < 30; i++) {
      const x = 60 + Math.random() * (W - 120), y = 60 + Math.random() * (H - 120);
      if (insideWall(x, y, this.walls, R + 12)) continue;
      if (this.zone && Math.hypot(x - this.zone.x, y - this.zone.y) > this.zone.r - 60) continue;
      const d = others.length ? Math.min(...others.map((o) => Math.hypot(o.x - x, o.y - y))) : 1e3;
      if (d > bestD) {
        bestD = d;
        best = { x, y };
      }
    }
    best ||= { x: W / 2, y: 80 };
    Object.assign(p, best, { hp: MAX_HP, shield: 0, alive: true, protect: this.t + SPAWN_SHIELD, cd: 0.4, buffs: { triple: 0, speed: 0 } });
    collide(p, this.walls);
    this.emit({ k: "spawn", id: p.id });
  }
  emit(ev) {
    this.events.push(ev);
  }
  endRound() {
    this.phase = "end";
    const ps = this.participants();
    if (this.mode === "lms") {
      const order = [...ps.filter((p) => p.alive), ...this.deadOrder.slice().reverse().map((id) => this.players.get(id)).filter(Boolean)];
      order.forEach((p, i) => {
        p.place = i + 1;
      });
      ps.forEach((p) => {
        if (!p.place) p.place = order.length + 1;
      });
    } else {
      const sorted = ps.slice().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
      sorted.forEach((p, i) => {
        p.place = i > 0 && sorted[i - 1].kills === p.kills && sorted[i - 1].deaths === p.deaths ? sorted[i - 1].place : i + 1;
      });
    }
    this.results = ps.map((p) => ({ id: p.id, name: p.name, color: p.color, kills: p.kills, deaths: p.deaths, place: p.place, bot: p.bot })).sort((a, b) => a.place - b.place);
    this.bullets = [];
    this.emit({ k: "end" });
    this.sendSnapshot();
    this.sendMeta();
    this.report();
  }
  // ---------- simulation ----------
  tick() {
    for (const p of [...this.players.values()]) {
      if (!p.bot && !p.on && Date.now() - p.offSince > 2e4) {
        this.players.delete(p.id);
        this.pickHost();
        this.sendMeta();
      }
    }
    if (this.phase !== "count" && this.phase !== "play") return;
    this.t += TICK;
    this.tickNo++;
    if (this.phase === "count" && this.t >= this.countEnd) {
      this.phase = "play";
      this.emit({ k: "go" });
      this.sendMeta();
    }
    const playing = this.phase === "play";
    const walls = this.walls;
    if (this.mode === "lms" && playing) {
      const full = Math.hypot(W, H) / 2 + 40 + Math.hypot(this.zone.x - W / 2, this.zone.y - H / 2), k = Math.min(1, Math.max(0, (this.t - 18) / 75));
      this.zone.r = full + (150 - full) * k;
      if (this.t > 93) this.zone.r = Math.max(0, 150 - (this.t - 93) * 4);
    }
    for (const p of this.players.values()) {
      if (!p.inRound) continue;
      if (!p.alive) {
        if (this.mode === "dm" && playing && p.respawnAt && this.t >= p.respawnAt && (p.on || p.bot)) this.spawn(p);
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
        this.emit({ k: "shot", id: p.id });
      }
      for (let i = this.pickups.length - 1; i >= 0; i--) {
        const u = this.pickups[i];
        if (Math.hypot(u.x - p.x, u.y - p.y) > R + 16) continue;
        if (u.type === "heal" && p.hp >= MAX_HP) continue;
        if (u.type === "heal") p.hp = Math.min(MAX_HP, p.hp + 40);
        else if (u.type === "shield") p.shield = 50;
        else p.buffs[u.type] = this.t + BUFF_TIME[u.type];
        this.pickups.splice(i, 1);
        this.emit({ k: "pick", id: p.id, type: u.type, x: r1(u.x), y: r1(u.y) });
      }
      if (this.mode === "lms" && playing && Math.hypot(p.x - this.zone.x, p.y - this.zone.y) > this.zone.r) {
        p.zoneAcc = (p.zoneAcc || 0) + 22 * TICK;
        if (p.zoneAcc >= 5) {
          this.damage(p, Math.floor(p.zoneAcc), null, true);
          p.zoneAcc %= 1;
        }
      }
    }
    if (playing) {
      const live = [];
      for (const b of this.bullets) {
        let alive = stepBullet(b, TICK, walls);
        if (alive) {
          for (const p of this.players.values()) {
            if (!p.alive || p.id === b.owner) continue;
            if (segDist(b.px, b.py, b.x, b.y, p.x, p.y) > R + BULLET_R) continue;
            alive = false;
            if (this.t < p.protect) {
              this.emit({ k: "block", x: r1(b.x), y: r1(b.y) });
              break;
            }
            this.emit({ k: "hit", v: p.id, by: b.owner, x: r1(b.x), y: r1(b.y) });
            this.damage(p, DMG, b.owner);
            break;
          }
        } else this.emit({ k: "wall", x: r1(b.x - b.vx * TICK * 0.3), y: r1(b.y - b.vy * TICK * 0.3) });
        if (alive) live.push(b);
      }
      this.bullets = live;
      if (this.t >= this.nextPickup) {
        this.nextPickup = this.t + 7;
        if (this.pickups.length < 3) this.spawnPickup();
      }
      if (this.mode === "dm" && this.t >= this.endAt) this.endRound();
      else if (this.mode === "lms" && this.participants().filter((p) => p.alive).length <= 1) this.endRound();
    }
    if (this.tickNo % 2 === 0 && this.phase !== "end") this.sendSnapshot();
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
    if (this.mode === "lms") this.deadOrder.push(p.id);
    this.emit({ k: "kill", a: killer?.id || null, v: p.id, x: r1(p.x), y: r1(p.y) });
    this.sendMeta();
  }
  spawnPickup() {
    for (let i = 0; i < 30; i++) {
      const x = 80 + Math.random() * (W - 160), y = 80 + Math.random() * (H - 160);
      if (insideWall(x, y, this.walls, 30)) continue;
      if (this.mode === "lms" && Math.hypot(x - this.zone.x, y - this.zone.y) > this.zone.r * 0.8) continue;
      if ([...this.players.values()].some((p) => p.alive && Math.hypot(p.x - x, p.y - y) < 120)) continue;
      const type = PICKUP_TYPES[Math.floor(Math.random() * PICKUP_TYPES.length)];
      this.pickups.push({ id: ++this.seq, type, x, y });
      return;
    }
  }
  // ---------- bots ----------
  botThink(p) {
    const ai = p.ai, walls = this.walls;
    const enemies = [...this.players.values()].filter((o) => o.alive && o !== p);
    let target = null, td = Infinity;
    for (const o of enemies) {
      const d = Math.hypot(o.x - p.x, o.y - p.y) + (blocked(p.x, p.y, o.x, o.y, walls) ? 250 : 0);
      if (d < td) {
        td = d;
        target = o;
      }
    }
    const los = target && !blocked(p.x, p.y, target.x, target.y, walls);
    const dist = target ? Math.hypot(target.x - p.x, target.y - p.y) : Infinity;
    if (this.t >= ai.next) {
      ai.next = this.t + 0.2 + Math.random() * 0.15;
      if (Math.random() < 0.12) ai.strafe *= -1;
      let goal = null;
      const zoneOut = this.mode === "lms" && Math.hypot(p.x - this.zone.x, p.y - this.zone.y) > this.zone.r * 0.8;
      const near = this.pickups.filter((u) => !(u.type === "heal" && p.hp >= MAX_HP)).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
      let angle;
      if (zoneOut) angle = Math.atan2(this.zone.y - p.y, this.zone.x - p.x);
      else if (near && Math.hypot(near.x - p.x, near.y - p.y) < 260 && (!los || dist > 300 || p.hp < 50)) angle = Math.atan2(near.y - p.y, near.x - p.x);
      else if (target && (!los || dist > 330)) angle = Math.atan2(target.y - p.y, target.x - p.x);
      else if (target && dist < 170) angle = Math.atan2(p.y - target.y, p.x - target.x) + ai.strafe * 0.6;
      else if (target) angle = Math.atan2(target.y - p.y, target.x - p.x) + ai.strafe * Math.PI / 2;
      else {
        if (Math.hypot(ai.tx - p.x, ai.ty - p.y) < 60) {
          ai.tx = 100 + Math.random() * (W - 200);
          ai.ty = 100 + Math.random() * (H - 200);
        }
        angle = Math.atan2(ai.ty - p.y, ai.tx - p.x);
      }
      for (const off of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.3, -2.3, Math.PI]) {
        const a = angle + off, q = { x: p.x, y: p.y };
        move(q, { mx: Math.cos(a), my: Math.sin(a) }, 0.3, walls);
        if (Math.hypot(q.x - p.x, q.y - p.y) > SPEED * 0.3 * 0.75) {
          ai.dir = a;
          break;
        }
      }
      p.input.mx = Math.cos(ai.dir);
      p.input.my = Math.sin(ai.dir);
    }
    if (target) {
      const prev = ai.prev[target.id];
      const vx = prev ? (target.x - prev.x) / TICK : 0, vy = prev ? (target.y - prev.y) / TICK : 0;
      ai.prev = { [target.id]: { x: target.x, y: target.y } };
      const lead = dist / BULLET_SPEED * 0.8;
      const want = Math.atan2(target.y + vy * lead - p.y, target.x + vx * lead - p.x);
      ai.wobble = (ai.wobble || 0) * 0.9 + (Math.random() - 0.5) * 0.06;
      let da = want + ai.wobble - p.input.a;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      p.input.a += da * 0.35;
      if (los) ai.seen += TICK;
      else ai.seen = 0;
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
      players.push([
        p.id,
        r1(p.x),
        r1(p.y),
        r2(p.aim),
        Math.ceil(p.hp),
        p.alive ? 1 : 0,
        Math.ceil(p.shield),
        flags,
        p.alive ? 0 : Math.max(0, r1(p.respawnAt - this.t))
      ]);
      if (!p.bot) ack[p.id] = p.lastSeq;
    }
    const msg = {
      t: "s",
      n: this.tickNo,
      ph: this.phase,
      tl: this.phase === "count" ? r1(this.countEnd - this.t) : this.mode === "dm" ? r1(Math.max(0, this.endAt - this.t)) : null,
      z: this.mode === "lms" && this.zone ? [this.zone.x, this.zone.y, r1(this.zone.r)] : null,
      ack,
      p: players,
      b: this.bullets.map((b) => [b.id, r1(b.x), r1(b.y), r1(b.vx), r1(b.vy), b.owner]),
      u: this.pickups.map((u) => [u.id, u.type, r1(u.x), r1(u.y)]),
      ev: this.events
    };
    this.events = [];
    const s = JSON.stringify(msg);
    for (const ws of to || this.sockets.keys()) {
      try {
        ws.send(s);
      } catch {
      }
    }
  }
  sendMeta() {
    this.broadcast({
      t: "room",
      code: this.code,
      pub: this.pub,
      host: this.host,
      phase: this.phase,
      mode: this.mode,
      mapPick: this.mapPick,
      map: this.map,
      bots: this.botCount,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, bot: p.bot, on: p.on, k: p.kills, d: p.deaths, inRound: p.inRound })),
      results: this.results
    });
  }
};

// ../../../../tmp/claude-0/-home-user-orilurie-github-io/0b06a6f4-848b-54b7-abff-d8cda7ed528d/scratchpad/cfw/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../tmp/claude-0/-home-user-orilurie-github-io/0b06a6f4-848b-54b7-abff-d8cda7ed528d/scratchpad/cfw/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-Qp5J5f/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../tmp/claude-0/-home-user-orilurie-github-io/0b06a6f4-848b-54b7-abff-d8cda7ed528d/scratchpad/cfw/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-Qp5J5f/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Matchmaker,
  Room,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
