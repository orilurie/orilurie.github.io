// "עולם הפוך" (Flip) — gravity-tilt platformer engine [ENGINE]
// Phaser 3.80.1 (global `Phaser`, loaded by the page) + Arcade physics.
// API (see flip-spec): startLevel(container, level, theme, opts) → handle; preloadAll(onProgress); disposeEngine().
//
// Design notes
// - ONE Phaser.Game is kept alive for the whole page (WebGL contexts are expensive). startLevel() moves the canvas
//   into the given container and (re)starts the 'flip' scene; destroy() stops the scene and detaches the canvas.
// - Physics bodies are invisible Zones (square, so rotating gravity never changes the hitbox); visuals are separate
//   sprites synced every frame, which lets us squash/stretch and rotate freely.
// - Terrain: Phaser Tilemap built from an autotiled, edge-extruded tileset generated once per theme.
// - Three cameras: background (screen space, parallax TileSprites), world (zoom + follow), HUD (screen space).

import * as M from './flip/manifest.js?v=55';

const T = 64;                         // world px per tile
const GRAV = 1400;                    // px/s²
const JUMP_V = 640;                   // px/s
const RUN_MAX = 265;
const SPRING_V = 1040;
const FALL_MAX = 940;
const COYOTE = 0.1, BUFFER = 0.12;
const DEADZONE = 0.12, FULL_TILT = 0.38, FLIP_T = 0.45, HYST = 0.2;
const PB = 42;                        // player body (square)
const SB = 36;                        // slime body
const CB = 60;                        // crate body
// direction indices: 0 down, 1 up, 2 left, 3 right
const GX = [0, 0, -1, 1], GY = [1, -1, 0, 0];
const ANG = [0, 180, 90, -90];        // sprite rotation (deg) so that its feet face direction d
const DN = ['down', 'up', 'left', 'right'];
const ZONE_DIR = { D: 0, U: 1, l: 2, r: 3 };
const SPIKE_ATTACH = { '^': 0, 'v': 1, '<': 3, '>': 2 };

const BASE_URL = new URL(M.BASE, import.meta.url).href;
const DEBUG = typeof location !== 'undefined' && /[?&]debug=1/.test(location.search);

// ------------------------------------------------------------------------------------------------------------------
// module state
let game = null;           // Phaser.Game (kept alive)
let gameReady = null;      // Promise<void>
let session = null;        // active level session
let hostDiv = null;        // hidden parking div for the canvas
let resizeObs = null;
const music = { snd: null, key: null, vol: 0, target: 0, timer: 0, stopAtZero: false };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const approach = (v, t, d) => (v < t ? Math.min(v + d, t) : Math.max(v - d, t));
const PH = () => window.Phaser;

function dprFor(opts) {
  const d = window.devicePixelRatio || 1;
  return opts && opts.graphics === 'low' ? 1 : Math.min(d, 2);
}

function ensureGame(container, opts) {
  if (game) return gameReady;
  const Phaser = PH();
  if (!Phaser) throw new Error('flip-engine: Phaser global missing');
  if (!hostDiv) {
    hostDiv = document.createElement('div');
    hostDiv.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:240px;overflow:hidden;';
    document.body.appendChild(hostDiv);
  }
  const parent = container || hostDiv;
  const D = dprFor(opts);
  const w = Math.max(1, parent.clientWidth || 320), h = Math.max(1, parent.clientHeight || 240);
  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: '#c3e3ff',
    banner: false,
    scale: { mode: Phaser.Scale.NONE, width: Math.round(w * D), height: Math.round(h * D), zoom: 1 / D },
    render: { antialias: true, pixelArt: false, roundPixels: false, powerPreference: 'high-performance' },
    physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, fps: 120, debug: false, tileBias: 24 } },
    input: { activePointers: 4, keyboard: true, mouse: true, touch: true },
    audio: { disableWebAudio: false },
    fps: { target: 60, smoothStep: true },
    disableContextMenu: true,
    scene: [],
  });
  game.__dpr = D;
  game.canvas.style.display = 'block';
  game.canvas.style.touchAction = 'none';
  gameReady = new Promise((res) => {
    if (game.isBooted) res(); else game.events.once('ready', res);
  }).then(() => {
    game.scene.add('flip', makeSceneClass(), false);
    game.scene.add('flip-loader', makeLoaderClass(), false);
  });
  return gameReady;
}

function attachCanvas(container, opts) {
  const c = game.canvas;
  if (c.parentNode !== container) container.appendChild(c);
  const D = dprFor(opts);
  game.__dpr = D;
  resizeToContainer(container);
  if (resizeObs) resizeObs.disconnect();
  if (typeof ResizeObserver !== 'undefined') {
    resizeObs = new ResizeObserver(() => resizeToContainer(container));
    resizeObs.observe(container);
  }
}

function resizeToContainer(container) {
  if (!game) return;
  const D = game.__dpr || 1;
  const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
  const W = Math.round(w * D), H = Math.round(h * D);
  if (game.scale.zoom !== 1 / D) game.scale.setZoom(1 / D);
  if (game.scale.width !== W || game.scale.height !== H) game.scale.resize(W, H);
  const sc = game.scene.getScene('flip');
  if (sc && sc.sys.isActive() && sc.onResize) sc.onResize();
}

// ---------- music (survives scene restarts; crossfades between themes) ----------
function musicTick() {
  const s = music.snd;
  if (!s) { clearInterval(music.timer); music.timer = 0; return; }
  const step = 0.035;
  music.vol = approach(music.vol, music.target, step);
  try { s.setVolume(music.vol); } catch (e) { /* ignore */ }
  if (music.vol === music.target) {
    if (music.target === 0 && music.stopAtZero) {
      try { s.stop(); s.destroy(); } catch (e) { /* ignore */ }
      music.snd = null; music.key = null;
    }
    clearInterval(music.timer); music.timer = 0;
  }
}
function musicFadeTo(target, stopAtZero) {
  music.target = target; music.stopAtZero = !!stopAtZero;
  if (!music.timer) music.timer = setInterval(musicTick, 30);
}
function musicPlay(key, on) {
  if (!game) return;
  const vol = 0.42;
  if (!on) { if (music.snd) musicFadeTo(0, true); return; }
  if (music.snd && music.key === key) { if (!music.snd.isPlaying) music.snd.play(); musicFadeTo(vol, false); return; }
  if (!game.cache.audio.exists(key)) return;
  if (music.snd) { // crossfade: kill the old one quickly
    const old = music.snd;
    let v = music.vol;
    const t = setInterval(() => { v -= 0.05; try { old.setVolume(Math.max(0, v)); } catch (e) { /**/ } if (v <= 0) { clearInterval(t); try { old.stop(); old.destroy(); } catch (e) { /**/ } } }, 30);
  }
  music.snd = game.sound.add(key, { loop: true, volume: 0 });
  music.key = key; music.vol = 0;
  music.snd.play();
  // free the decoded tracks of the other themes (~16 MB each); re-fetched (HTTP cache) if that world is played again
  for (const tn of Object.keys(M.THEMES)) {
    const k = 'music:' + tn;
    if (k !== key) try { if (game.cache.audio.exists(k)) game.cache.audio.remove(k); } catch (e) { /**/ }
  }
  musicFadeTo(vol, false);
}

// ------------------------------------------------------------------------------------------------------------------
// asset loading
function themeOf(name) { return M.THEMES[name] || M.THEMES.grass; }

function musicUrl(tn) { const th = themeOf(tn); return (M.MUSIC && M.MUSIC[tn]) || th.music; }
// Music is NOT part of the blocking loads (3 tracks ~1.6 MB, ~16 MB decoded each): the level's track is fetched lazily
// in create() and starts (crossfade) when it arrives. See ensureMusic().
function queueLoads(scene, themeNames) {
  const L = scene.load;
  L.setPath('');
  let n = 0;
  for (const [k, a] of Object.entries(M.ATLASES)) {
    if (!scene.textures.exists(k)) { L.atlas(k, BASE_URL + a.png, BASE_URL + a.json); n++; }
  }
  for (const tn of themeNames) {
    const th = themeOf(tn);
    for (const p of th.bg) if (!scene.textures.exists('bg:' + p)) { L.image('bg:' + p, BASE_URL + p); n++; }
  }
  for (const [k, p] of Object.entries(M.SFX)) {
    if (!scene.cache.audio.exists('sfx:' + k)) { L.audio('sfx:' + k, BASE_URL + p); n++; }
  }
  return n;
}

function makeLoaderClass() {
  const Phaser = PH();
  return class FlipLoader extends Phaser.Scene {
    constructor() { super({ key: 'flip-loader' }); }
    init(data) { this.cb = data; }
    preload() {
      queueLoads(this, Object.keys(M.THEMES));
      this.load.on('progress', (p) => { try { this.cb.onProgress && this.cb.onProgress(p); } catch (e) { /**/ } });
    }
    create() { const cb = this.cb; this.scene.stop(); cb.done && cb.done(); }
  };
}

// ------------------------------------------------------------------------------------------------------------------
// level parsing
function parseLevel(level) {
  const rows0 = (level && level.rows) || ['#####', '#P.E#', '#####'];
  const H = rows0.length;
  const W = rows0.reduce((m, r) => Math.max(m, r.length), 0);
  const rows = rows0.map((r) => r.padEnd(W, '#'));
  const solid = new Uint8Array(W * H);   // 1 terrain, 2 lock, 3 crumble
  const zone = new Int8Array(W * H).fill(-1);
  const occ = new Uint8Array(W * H);     // something placed here (no decor)
  const P = { start: null, exit: null, gems: [], coins: [], keys: [], locks: [], crates: [], springs: [], crumbles: [],
    slimes: [], flies: [], saws: [], spikes: [], zones: [], checks: [] };
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const ch = rows[r][c], i = r * W + c;
      if (ch !== '.' && ch !== '#') occ[i] = 1;
      switch (ch) {
        case '#': solid[i] = 1; break;
        case 'L': solid[i] = 2; P.locks.push({ c, r }); break;
        case 'X': solid[i] = 3; P.crumbles.push({ c, r }); break;
        case 'P': P.start = { c, r }; break;
        case 'E': P.exit = { c, r }; break;
        case '*': P.gems.push({ c, r }); break;
        case 'c': P.coins.push({ c, r }); break;
        case 'K': P.keys.push({ c, r }); break;
        case 'B': P.crates.push({ c, r }); break;
        case 'S': P.springs.push({ c, r }); break;
        case 's': P.slimes.push({ c, r }); break;
        case 'f': P.flies.push({ c, r }); break;
        case 'O': P.saws.push({ c, r }); break;
        case 'C': P.checks.push({ c, r }); break; // optional checkpoint flag
        case '^': case 'v': case '<': case '>': P.spikes.push({ c, r, ch }); break;
        case 'U': case 'D': case 'l': case 'r': zone[i] = ZONE_DIR[ch]; P.zones.push({ c, r, d: ZONE_DIR[ch] }); occ[i] = 1; break;
        default: break;
      }
    }
  }
  if (!P.start) P.start = { c: 1, r: H - 2 };
  return { W, H, rows, solid, zone, occ, P, objects: (level && level.objects) || [] };
}

// ------------------------------------------------------------------------------------------------------------------
function makeSceneClass() {
  const Phaser = PH();

  class FlipScene extends Phaser.Scene {
    constructor() { super({ key: 'flip' }); }

    init(data) { this.S = data.session; this.S.scene = this; this.state = 'loading'; }

    preload() {
      const S = this.S;
      const n = queueLoads(this, [S.theme]);
      if (n > 0) {
        // simple in-canvas loading bar (screen space)
        const w = this.scale.width, h = this.scale.height, D = this.game.__dpr || 1;
        const bar = this.add.graphics();
        this.load.on('progress', (p) => {
          bar.clear();
          bar.fillStyle(0x000000, 0.25).fillRoundedRect(w / 2 - 120 * D, h / 2 - 6 * D, 240 * D, 12 * D, 6 * D);
          bar.fillStyle(0xffffff, 1).fillRoundedRect(w / 2 - 118 * D, h / 2 - 4 * D, Math.max(8 * D, 236 * D * p), 8 * D, 4 * D);
        });
        this.load.once('complete', () => bar.destroy());
      }
    }

    // ================================================================ create
    create() {
      const S = this.S;
      // The scene object is reused across levels: a level stopped/restarted while paused leaves the clock and the
      // tween manager paused (Phaser keeps those flags across scene restarts) -> delayed calls (respawn, onWin) never fire.
      this.time.paused = false;
      this.tweens.resumeAll();
      if (this.anims.resumeAll) this.anims.resumeAll();
      ensureAnims(this.game);
      this.D = this.game.__dpr || 1;
      this.low = S.opts.graphics === 'low';
      this.th = themeOf(S.theme);
      this.tiles = this.th.tiles;
      this.L = parseLevel(S.level);
      const { W, H } = this.L;
      this.LW = W * T; this.LH = H * T;

      // state (the scene instance is reused across restarts: reset EVERY per-level field here)
      this.bgShade = null; this.pAngObj = null; this.hud = null; this.door = null; this.result = null;
      this.wasGrounded = false; this.lastAlong = 0; this.camFast = 0; this.prevState = null;
      this.state = 'play';
      this.elapsed = 0;
      this.deaths = S.deaths || 0;
      this.gemsGot = 0; this.coinsGot = 0;
      this.gDir = 0; this.lastFlip = -1e9; this.inZone = -1;
      this.tiltOverride = null;
      this.jumpHeld = false; this.jumpPressT = -1e9; this.lastGroundT = -1e9; this.jumpCutDone = true;
      this.walkV = 0; this.springT = -1e9;
      this.ride = null; this.rideNext = null; this.airCarry = 0;
      this.crushFrames = 0; this.platHit = false;
      this.dustT = 0; this.stepT = 0;
      this.sndT = {};
      this.camKX = 0; this.camKY = 0; this.camKVX = 0; this.camKVY = 0;
      this.lookX = 0; this.lookY = 0;

      // layers & cameras
      this.bgL = this.add.layer();
      this.wL = this.add.layer();
      this.hudL = this.add.layer();
      this.bgCam = this.cameras.main;
      this.bgCam.setBackgroundColor(this.th.skyTop || '#c3e3ff');
      this.wCam = this.cameras.add(0, 0, this.scale.width, this.scale.height);
      this.hudCam = this.cameras.add(0, 0, this.scale.width, this.scale.height);
      this.bgCam.ignore([this.wL, this.hudL]);
      this.wCam.ignore([this.bgL, this.hudL]);
      this.hudCam.ignore([this.bgL, this.wL]);

      this.physics.world.setBounds(0, 0, this.LW, this.LH);

      this.buildBackground();
      this.buildTerrain();
      this.decorL = this.add.layer(); this.wL.add(this.decorL);
      this.buildDecor();
      this.objL = this.add.layer(); this.wL.add(this.objL);
      this.buildObjects();
      this.buildPlayer();
      this.fxL = this.add.layer(); this.wL.add(this.fxL);
      this.buildFx();
      this.buildHud();
      this.buildColliders();
      this.buildInput();

      this.onResize(true);
      this.snapCamera();

      // spawn pop
      this.pv.setScale(0);
      this.tweens.add({ targets: this.pScale, s: 1, duration: 320, ease: 'Back.easeOut' });
      this.pScale.s = 0;

      this.ensureMusic();
      this.events.once('shutdown', this.onShutdown, this);
      // lock zones are also checked on every physics sub-step: at low frame rates a fast body could otherwise
      // cross a 1-tile zone between two update() calls (several 120 Hz steps per frame)
      this.physics.world.on('worldstep', this.zoneStep, this);
      if (S.paused) this.setPaused(true);
      if (DEBUG) this.exposeDebug();
    }

    // ================================================================ background
    buildBackground() {
      const th = this.th, info = th.bgInfo || {};
      this.bgLayers = [];
      th.bg.forEach((p, i) => {
        const key = 'bg:' + p;
        if (!this.textures.exists(key)) return;
        const img = this.textures.get(key).getSourceImage();
        const ts = this.add.tileSprite(0, 0, 16, 16, key).setOrigin(0, 1);
        if (th.bgTint && i > 0) ts.setTint(th.bgTint);
        this.bgL.add(ts);
        if (this.low && i === 1) ts.setVisible(false);
        this.bgLayers.push({ ts, h: img.height, w: img.width, scroll: (info.scroll && info.scroll[i]) || i * 0.1,
          off: (info.bottomOffset && info.bottomOffset[i]) || 0, drift: /cloud/.test(p) ? 6 : 0 });
      });
      if (th.bgTint) { // cave mood: a subtle dark wash over the sky
        this.bgShade = this.add.rectangle(0, 0, 16, 16, 0x2a1f3d, 0.22).setOrigin(0, 0);
        this.bgL.addAt(this.bgShade, 1);
      }
    }

    layoutBackground() {
      const w = this.scale.width, h = this.scale.height, D = this.D;
      this.bgS = clamp(h / 820, 0.6 * D, 2.6 * D);
      for (const b of this.bgLayers) {
        // skip the first/last texel row: avoids a 1-px wrap line at the top edge with linear filtering
        b.ts.setTileScale(this.bgS, this.bgS);
        b.ts.setSize(w, (b.h - 2) * this.bgS);
        b.ts.tilePositionY = 1;
        b.ts.setPosition(0, h - b.off * this.bgS);
      }
      if (this.bgShade) this.bgShade.setSize(w, h);
    }

    updateBackground(dt) {
      if (!this.bgLayers.length) return;
      const cx = this.wCam.midPoint.x, cy = this.wCam.midPoint.y, h = this.scale.height;
      const dy = clamp((cy - this.LH / 2) * 0.12, -60, 60);
      for (const b of this.bgLayers) {
        b.ts.tilePositionX = (cx * b.scroll * 0.9 + (b.drift ? this.time.now * 0.001 * b.drift : 0));
        b.ts.y = h - b.off * this.bgS - dy * b.scroll * this.bgS;
      }
    }

    // ================================================================ terrain
    isSolid(c, r) {
      const L = this.L;
      if (c < 0 || r < 0 || c >= L.W || r >= L.H) return true;
      return L.solid[r * L.W + c] !== 0;
    }
    isTerrain(c, r) {
      const L = this.L;
      if (c < 0 || r < 0 || c >= L.W || r >= L.H) return true;
      return L.solid[r * L.W + c] === 1;
    }
    // solid for movement probes (terrain, active locks/crumbles)
    blockedAt(x, y) {
      const c = Math.floor(x / T), r = Math.floor(y / T), L = this.L;
      if (c < 0 || r < 0 || c >= L.W || r >= L.H) return true;
      const v = L.solid[r * L.W + c];
      if (v === 1) return true;
      if (v === 2) { const k = this.lockAt[r * L.W + c]; return !!(k && k.active); }
      if (v === 3) { const k = this.crumbleAt[r * L.W + c]; return !!(k && k.solid); }
      return false;
    }

    buildTerrain() {
      const { W, H } = this.L;
      const tiles = this.tiles;
      const variants = ['single', 'top_left', 'top', 'top_right', 'left', 'center', 'right', 'bottom_left', 'bottom', 'bottom_right',
        'h_left', 'h_mid', 'h_right', 'v_top', 'v_mid', 'v_bottom'];
      const tsKey = 'flip-ts:' + tiles.single;
      if (!this.textures.exists(tsKey)) {
        const CELL = 68;
        const ct = this.textures.createCanvas(tsKey, CELL * variants.length, CELL);
        const ctx = ct.getContext();
        variants.forEach((v, i) => {
          const f = this.textures.getFrame('world', tiles[v]);
          if (!f) return;
          // atlas frames are edge-extruded by 2 px: copy the 68x68 block (no seams at fractional zoom)
          ctx.drawImage(f.source.image, f.cutX - 2, f.cutY - 2, CELL, CELL, i * CELL, 0, CELL, CELL);
        });
        ct.refresh();
      }
      const idx = {}; variants.forEach((v, i) => { idx[tiles[v]] = i; });
      // the map is padded with MARGIN tiles of solid ground all around, so views larger than the level
      // show a solid earth mass instead of empty sky
      const MG = 10;
      const data = [];
      for (let r = -MG; r < H + MG; r++) {
        const row = [];
        for (let c = -MG; c < W + MG; c++) {
          if (!this.isTerrain(c, r)) { row.push(-1); continue; }
          const fr = M.terrainFrame(tiles, this.isTerrain(c, r - 1), this.isTerrain(c, r + 1), this.isTerrain(c - 1, r), this.isTerrain(c + 1, r));
          row.push(idx[fr] != null ? idx[fr] : idx[tiles.center]);
        }
        data.push(row);
      }
      this.map = this.make.tilemap({ data, tileWidth: T, tileHeight: T });
      const ts = this.map.addTilesetImage('ts', tsKey, T, T, 2, 4);
      this.ground = this.map.createLayer(0, ts, -MG * T, -MG * T);
      this.ground.setCollisionByExclusion([-1]);
      this.wL.add(this.ground);
    }

    buildDecor() {
      const th = this.th, L = this.L;
      const pool = (th.decor || []).filter((d) => !/sign|fence|chain|flag|torch/.test(d) && this.textures.getFrame('world', d));
      if (!pool.length || this.low) return;
      let seed = 1234567;
      for (const ch of String(this.S.level.id || 'x')) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const free = (c, r) => c > 0 && r > 0 && c < L.W - 1 && r < L.H - 1 && L.solid[r * L.W + c] === 0 && !L.occ[r * L.W + c];
      for (let r = 1; r < L.H - 1; r++) {
        for (let c = 1; c < L.W - 1; c++) {
          if (!free(c, r)) continue;
          // floor below → upright decor; ceiling above → upside-down ("עולם הפוך")
          let d = -1;
          if (this.isTerrain(c, r + 1) && rnd() < 0.22) d = 0;
          else if (this.isTerrain(c, r - 1) && rnd() < 0.1) d = 1;
          if (d < 0) continue;
          const fr = pool[Math.floor(rnd() * pool.length)];
          const x = c * T + T / 2 + (rnd() - 0.5) * 18, y = d === 0 ? (r + 1) * T : r * T;
          const img = this.add.image(x, y, 'world', fr).setOrigin(0.5, 1).setAngle(ANG[d]).setAlpha(0.95);
          img.setScale(0.7 + rnd() * 0.3);
          if (rnd() < 0.5) img.setFlipX(true);
          this.decorL.add(img);
        }
      }
    }

    // ================================================================ objects
    attachDir(c, r, prefer) {
      const order = prefer || [0, 1, 2, 3];
      for (const d of order) if (this.isSolid(c + GX[d], r + GY[d])) return d;
      return 0;
    }

    buildObjects() {
      const L = this.L, P = L.P, th = this.th;
      const cx = (c) => c * T + T / 2;
      this.lockAt = new Array(L.W * L.H);
      this.crumbleAt = new Array(L.W * L.H);

      // lock zones
      this.zoneArrows = [];
      const zoneTint = [0x6fd3ff, 0xff8fd8, 0xffd26f, 0x9dff8f];
      for (const z of P.zones) {
        const t = this.add.image(cx(z.c), cx(z.r), 'world', M.SPRITES.lockzone.tile).setTint(zoneTint[z.d]).setAlpha(0.35);
        const a = this.add.image(cx(z.c), cx(z.r), 'world', M.SPRITES.lockzone.arrow).setTint(zoneTint[z.d]).setAngle(ANG[z.d] + 180).setScale(0.7);
        this.objL.add(t); this.objL.add(a);
        this.zoneArrows.push({ a, phase: (z.c * GX[z.d] + z.r * GY[z.d]) * 0.9, d: z.d, x: a.x, y: a.y });
      }

      // spikes
      this.spikes = P.spikes.map((s) => {
        const d = SPIKE_ATTACH[s.ch];
        const img = this.add.image(cx(s.c), cx(s.r), 'world', M.SPRITES.spike.frame).setAngle(ANG[d]);
        this.objL.add(img);
        // deadly box (in "up" orientation: x 8..56, y 38..64) rotated with the attach dir
        const a = 10, b = 54, depth = 26;
        let x0, y0, x1, y1;
        const X = s.c * T, Y = s.r * T;
        if (d === 0) { x0 = X + a; x1 = X + b; y0 = Y + T - depth; y1 = Y + T; }
        else if (d === 1) { x0 = X + a; x1 = X + b; y0 = Y; y1 = Y + depth; }
        else if (d === 2) { y0 = Y + a; y1 = Y + b; x0 = X; x1 = X + depth; }
        else { y0 = Y + a; y1 = Y + b; x0 = X + T - depth; x1 = X + T; }
        return { x0, y0, x1, y1 };
      });

      // springs
      this.springs = P.springs.map((s) => {
        const d = this.attachDir(s.c, s.r);
        const img = this.add.image(cx(s.c), cx(s.r), 'world', M.SPRITES.spring.idle).setAngle(ANG[d]);
        this.objL.add(img);
        const X = s.c * T, Y = s.r * T, k = 34; // trigger: the half of the tile at the attached side (+ a little)
        let x0 = X + 4, x1 = X + T - 4, y0 = Y + 4, y1 = Y + T - 4;
        if (d === 0) y0 = Y + T - k; else if (d === 1) y1 = Y + k; else if (d === 2) x1 = X + k; else x0 = X + T - k;
        return { img, d, x0, y0, x1, y1, t: -1e9 };
      });

      // gems / coins / keys
      const glowF = M.FX.glow;
      this.gems = P.gems.map((g, i) => {
        const glow = this.add.image(cx(g.c), cx(g.r), 'fx', glowF).setScale(0.75).setAlpha(0.45).setTint(0xfff3b0).setBlendMode(Phaser.BlendModes.ADD);
        const img = this.add.image(cx(g.c), cx(g.r), 'world', th.gem || 'gem_blue');
        this.objL.add(glow); this.objL.add(img);
        return { img, glow, x: img.x, y: img.y, got: false, ph: i * 1.7 };
      });
      this.coins = P.coins.map((g, i) => {
        const img = this.add.image(cx(g.c), cx(g.r), 'world', 'coin_gold').setScale(0.85);
        this.objL.add(img);
        return { img, x: img.x, y: img.y, got: false, ph: (g.c + g.r) * 0.6 + i * 0.05 };
      });
      this.keys = P.keys.map((g) => {
        const glow = this.add.image(cx(g.c), cx(g.r), 'fx', glowF).setScale(0.7).setAlpha(0.5).setTint(0xfff0a0).setBlendMode(Phaser.BlendModes.ADD);
        const img = this.add.image(cx(g.c), cx(g.r), 'world', th.key || M.SPRITES.key.frame);
        this.objL.add(glow); this.objL.add(img);
        return { img, glow, x: img.x, y: img.y, got: false };
      });

      // static blocks: locks & crumbles
      this.solids = this.physics.add.staticGroup();
      this.locks = P.locks.map((g) => {
        const img = this.add.image(cx(g.c), cx(g.r), 'world', th.lock || M.SPRITES.lock.frame);
        this.objL.add(img);
        const z = this.add.zone(cx(g.c), cx(g.r), T, T);
        this.solids.add(z);
        const o = { img, z, c: g.c, r: g.r, active: true };
        this.lockAt[g.r * L.W + g.c] = o;
        return o;
      });
      const cr = crumbleFrames(this.S.theme);
      this.crumbles = P.crumbles.map((g) => {
        const img = this.add.image(cx(g.c), cx(g.r), 'world', cr.idle);
        this.objL.add(img);
        const z = this.add.zone(cx(g.c), cx(g.r), T, T);
        this.solids.add(z);
        const o = { img, z, c: g.c, r: g.r, x: img.x, y: img.y, solid: true, t: 0, phase: 0, frames: cr };
        z.__crumble = o;
        this.crumbleAt[g.r * L.W + g.c] = o;
        return o;
      });

      // exit door
      this.door = null;
      if (P.exit) {
        const e = P.exit, d = this.attachDir(e.c, e.r, [0, 1, 2, 3]);
        // bottom of the door sits on the attached surface
        const bx = cx(e.c) + GX[d] * T / 2, by = cx(e.r) + GY[d] * T / 2;
        const glow = this.add.image(cx(e.c) - GX[d] * 20, cx(e.r) - GY[d] * 20, 'fx', glowF).setScale(1.3).setAlpha(0).setTint(0xfff2a8).setBlendMode(Phaser.BlendModes.ADD);
        const img = this.add.image(bx, by, 'world', M.SPRITES.door.closed).setOrigin(0.5, 1).setAngle(ANG[d]);
        // shrink if there is no room for a 2-tile door
        if (this.isSolid(e.c - GX[d], e.r - GY[d])) img.setScale(0.62);
        this.objL.add(glow); this.objL.add(img);
        this.door = { img, glow, x: cx(e.c), y: cx(e.r), d, open: false };
      }

      // optional checkpoints ('C')
      this.checks = P.checks.map((g) => {
        const d = this.attachDir(g.c, g.r, [0, 1, 2, 3]);
        const img = this.add.sprite(cx(g.c) + GX[d] * T / 2, cx(g.r) + GY[d] * T / 2, 'world', M.SPRITES.checkpoint.frames.off[0]).setOrigin(0.5, 1).setAngle(ANG[d]);
        this.objL.add(img);
        return { img, x: cx(g.c), y: cx(g.r), d, on: false };
      });

      // moving things from objects[]
      const consumed = new Set();
      const keyOf = (c, r) => c + ',' + r;
      this.platforms = []; this.saws = []; this.flies = [];
      for (const o of L.objects) {
        if (!o || !o.path || !o.path.length) continue;
        const speed = (o.speed || 2) * T;
        const p0 = o.path[0];
        if (o.type === 'platform') {
          const w = o.w || 2, h = o.h || 1;
          const pts = o.path.map(([c, r]) => ({ x: c * T + w * T / 2, y: r * T + h * T / 2 }));
          this.platforms.push(this.makePlatform(pts, w, h, speed, o.wait != null ? o.wait : 0.8));
        } else {
          const pts = o.path.map(([c, r]) => ({ x: cx(c), y: cx(r) }));
          consumed.add(o.type + keyOf(p0[0], p0[1]));
          if (o.type === 'saw') this.saws.push(this.makeSaw(pts, speed));
          else if (o.type === 'fly') this.flies.push(this.makeFly(pts, speed));
        }
      }
      for (const s of P.saws) if (!consumed.has('saw' + keyOf(s.c, s.r))) this.saws.push(this.makeSaw([{ x: cx(s.c), y: cx(s.r) }], 0));
      for (const s of P.flies) if (!consumed.has('fly' + keyOf(s.c, s.r))) this.flies.push(this.makeFly([{ x: cx(s.c), y: cx(s.r) }], 0));

      // crates
      this.crates = P.crates.map((g) => {
        const z = this.add.zone(cx(g.c), cx(g.r), CB, CB);
        this.physics.add.existing(z);
        z.body.setCollideWorldBounds(true);
        z.body.setMaxVelocity(1100, 1100);
        const img = this.add.image(z.x, z.y, 'world', M.SPRITES.crate.frame);
        this.objL.add(img);
        const o = { z, img, sx: z.x, sy: z.y, g: 0, push: 0, pushT: 0, ride: null, rideNext: null, lastAlong: 0 };
        z.__crate = o;
        return o;
      });
      this.crateZones = this.crates.map((o) => o.z);

      // slimes
      this.slimes = P.slimes.map((g, i) => {
        const z = this.add.zone(cx(g.c), (g.r + 1) * T - SB / 2, SB, SB);
        this.physics.add.existing(z);
        z.body.setCollideWorldBounds(true);
        const img = this.add.sprite(z.x, z.y, 'chars', M.SPRITES.slime.frames.walk[0]).setOrigin(0.5, (64 - SB / 2) / 64);
        img.play('flip-slime-walk');
        this.objL.add(img);
        const o = { z, img, dir: i % 2 ? 1 : -1, alive: true, g: 0, ang: 0, turnT: 0, sq: 1, sqv: 0 };
        z.__slime = o;
        return o;
      });
      this.slimeZones = this.slimes.map((o) => o.z);
    }

    // start the theme music now if cached, else fetch it in the background and start it when it arrives
    ensureMusic() {
      const S = this.S, mk = 'music:' + S.theme;
      if (this.cache.audio.exists(mk)) { musicPlay(mk, S.music); if (S.music && S.paused) musicFadeTo(0.12, false); return; }
      if (!S.music) musicPlay(mk, false); else if (music.snd && music.key !== mk) musicFadeTo(0, true);
      const url = musicUrl(S.theme);
      if (!url) return;
      this.load.setPath('');
      this.load.audio(mk, BASE_URL + url);
      this.load.once('filecomplete-audio-' + mk, () => {
        if (S.dead || session !== S || !S.music) return;
        musicPlay(mk, true);
        if (S.paused) musicFadeTo(0.12, false);
      });
      this.load.start();
    }
    pathMover(pts, speed, wait) {
      const loop = pts.length > 2 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y;
      return { pts, speed, i: 0, step: 1, loop, x: pts[0].x, y: pts[0].y, vx: 0, vy: 0, wait: wait || 0, hold: (wait || 0) * 2 };
    }
    // advance a path mover by dt; returns velocity in m.vx/m.vy
    stepMover(m, dt) {
      if (m.pts.length < 2 || !m.speed) { m.vx = m.vy = 0; return; }
      // dwell at the ends of a ping-pong path (platforms): time to get on / step off
      if (m.hold > 0) { m.hold -= dt; m.vx = m.vy = 0; return; }
      let remain = m.speed * dt;
      const ox = m.x, oy = m.y;
      for (let guard = 0; guard < 8 && remain > 0; guard++) {
        let ni = m.i + m.step;
        if (m.loop) { if (ni >= m.pts.length) ni = 1; }
        else if (ni >= m.pts.length || ni < 0) { m.step = -m.step; ni = m.i + m.step; }
        const t = m.pts[ni];
        const dx = t.x - m.x, dy = t.y - m.y, dist = Math.hypot(dx, dy);
        if (dist <= remain) {
          m.x = t.x; m.y = t.y; remain -= dist; m.i = ni;
          if (m.loop && ni === m.pts.length - 1) m.i = 0;
          else if (!m.loop && m.wait > 0 && (ni === m.pts.length - 1 || ni === 0)) { m.hold = m.wait; break; }
        } else { m.x += dx / dist * remain; m.y += dy / dist * remain; remain = 0; }
      }
      m.vx = dt > 0 ? (m.x - ox) / dt : 0; m.vy = dt > 0 ? (m.y - oy) / dt : 0;
    }

    makePlatform(pts, w, h, speed, wait) {
      const m = this.pathMover(pts, speed, wait);
      const z = this.add.zone(m.x, m.y, w * T, h * T);
      this.physics.add.existing(z);
      z.body.setAllowGravity(false); z.body.setImmovable(true); z.body.pushable = false;
      z.body.friction.set(0, 0); // we carry riders ourselves (any gravity direction)
      const ct = this.add.container(m.x, m.y);
      const fr = this.th.platform || ['grass_cloud_left', 'grass_cloud_middle', 'grass_cloud_right'];
      const single = this.tiles.cloud;
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const f = w === 1 ? single : xx === 0 ? fr[0] : xx === w - 1 ? fr[2] : fr[1];
          ct.add(this.add.image((xx - (w - 1) / 2) * T, (yy - (h - 1) / 2) * T, 'world', f));
        }
      }
      this.objL.add(ct);
      const o = { m, z, ct, w, h };
      z.__plat = o;
      return o;
    }
    makeSaw(pts, speed) {
      const m = this.pathMover(pts, speed);
      const img = this.add.image(m.x, m.y, 'world', M.SPRITES.saw.plain.frame);
      if (pts.length > 1 && !this.low) { // dotted track
        const g = this.add.graphics();
        g.lineStyle(4, 0x000000, 0.18);
        for (let i = 0; i < pts.length - 1; i++) g.lineBetween(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
        for (const p of pts) { g.fillStyle(0x000000, 0.22); g.fillCircle(p.x, p.y, 6); }
        this.objL.add(g);
      }
      this.objL.add(img);
      return { m, img, r: 25 };
    }
    makeFly(pts, speed) {
      const m = this.pathMover(pts, speed);
      const img = this.add.sprite(m.x, m.y, 'chars', M.SPRITES.fly.frames.fly[0]);
      img.play('flip-fly');
      this.objL.add(img);
      return { m, img, r: 21, alive: true, ph: Math.random() * 6, bx: m.x, by: m.y, face: -1 };
    }

    // ================================================================ player
    buildPlayer() {
      const st = this.L.P.start;
      this.spawnX = st.c * T + T / 2; this.spawnY = (st.r + 1) * T - PB / 2; this.spawnDir = 0;
      const z = this.add.zone(this.spawnX, this.spawnY, PB, PB);
      this.physics.add.existing(z);
      z.body.setCollideWorldBounds(true);
      z.body.setMaxVelocity(1200, 1200);
      this.pz = z; this.pb = z.body;
      const sp = M.SPRITES.player;
      const sc = 0.64;
      this.pv = this.add.sprite(z.x, z.y, 'chars', sp.frames.idle[0]);
      this.pv.setOrigin(0.5, (128 - (PB / 2) / sc) / 128);
      this.pBase = sc;
      this.pAng = 0; this.pAngT = 0;
      this.pScale = { s: 1 };
      this.sq = 1; this.sqv = 0;   // squash spring (1 = rest; <1 squashed)
      this.facing = 1;
      this.pDir = 0;               // effective gravity dir for the player
      this.wL.add(this.pv);
      this.pv.play('flip-p-idle');
      this.pAnim = 'idle';
    }

    // ================================================================ fx
    buildFx() {
      const ADD = Phaser.BlendModes.ADD;
      const low = this.low ? 0.5 : 1;
      this.emitters = [];
      const E = (frame, cfg) => {
        const e = this.add.particles(0, 0, 'fx', Object.assign({ frame, emitting: false }, cfg));
        this.fxL.add(e);
        this.emitters.push(e);
        return e;
      };
      const groundTint = Phaser.Display.Color.HexStringToColor(this.th.ground || '#cccccc').color;
      this.fxDust = E(M.FX.dust, { lifespan: 420, speed: { min: 20, max: 90 }, scale: { start: 0.42, end: 0.05 }, alpha: { start: 0.55, end: 0 }, tint: [0xffffff, 0xf3efe6], rotate: { min: 0, max: 360 } });
      this.fxSpark = E(M.FX.spark, { lifespan: 520, speed: { min: 120, max: 320 }, scale: { start: 0.6, end: 0 }, alpha: { start: 1, end: 0 }, tint: [0xffc928, 0xffffff, 0x3fc8ff, 0xff7ab8], rotate: { min: 0, max: 360 } });
      this.fxStar = E(M.FX.star, { lifespan: 700, speed: { min: 90, max: 300 }, scale: { start: 0.55, end: 0 }, alpha: { start: 1, end: 0 }, tint: [0xffc928, 0xffa53d, 0xffffff, 0xff7ab8], rotate: { min: -180, max: 180 } });
      this.fxSmoke = E(M.FX.smoke, { lifespan: 650, speed: { min: 30, max: 140 }, scale: { start: 0.6, end: 1.1 }, alpha: { start: 0.55, end: 0 }, tint: [0xffffff, 0xdddddd], rotate: { min: 0, max: 360 } });
      this.fxRing = E(M.FX.ring, { lifespan: 380, speed: 0, scale: { start: 0.1, end: 0.9 }, alpha: { start: 0.9, end: 0 }, tint: 0x3fb4ff });
      this.fxTwinkle = E(M.FX.sparkle, { lifespan: 600, speed: { min: 0, max: 20 }, scale: { start: 0.3, end: 0 }, alpha: { start: 1, end: 0 }, blendMode: ADD, tint: 0xffffff, rotate: { min: 0, max: 90 } });
      this.fxDirt = E(M.FX.dirt, { lifespan: 700, speed: { min: 80, max: 260 }, scale: { start: 0.35, end: 0.1 }, alpha: { start: 1, end: 0 }, tint: groundTint, rotate: { min: 0, max: 360 } });
      this.fxTrail = E(M.FX.soft, { lifespan: 220, speed: 0, scale: { start: 0.45, end: 0 }, alpha: { start: 0.18, end: 0 }, blendMode: ADD, tint: 0xbfe9ff });
      this.fxLow = low;
      this.time.addEvent({ delay: 420, loop: true, callback: this.twinkle, callbackScope: this });
    }
    burst(em, n, x, y) { em.explode(Math.max(1, Math.round(n * this.fxLow)), x, y); }
    twinkle() {
      if (this.state !== 'play') return;
      const g = this.gems[(Math.random() * this.gems.length) | 0];
      if (g && !g.got) this.fxTwinkle.emitParticleAt(g.x + (Math.random() - 0.5) * 30, g.y + (Math.random() - 0.5) * 30, 1);
      if (this.door && this.door.open) this.fxTwinkle.emitParticleAt(this.door.x + (Math.random() - 0.5) * 40, this.door.y + (Math.random() - 0.5) * 50, 1);
    }

    // ================================================================ HUD
    buildHud() {
      this.hud = null;
      if (this.S.opts.hud === false) return;
      const D = this.D;
      const mk = (o) => { this.hudL.add(o); return o; };
      const font = { fontFamily: 'Rubik, system-ui, sans-serif', fontStyle: '800', fontSize: Math.round(22 * D) + 'px', color: '#ffffff', stroke: '#1d2b53', strokeThickness: Math.round(5 * D) };
      const pill = mk(this.add.graphics());
      const gems = [0, 1, 2].map(() => mk(this.add.image(0, 0, 'world', this.th.gem || 'gem_blue').setScale(0.5 * D)));
      const coinI = mk(this.add.image(0, 0, 'world', (M.SPRITES.hud && M.SPRITES.hud.coin) || 'hud_coin').setScale(0.62 * D));
      const coinT = mk(this.add.text(0, 0, '0', font).setOrigin(1, 0.5));
      const timer = mk(this.add.text(0, 0, '0:00.0', font).setOrigin(0.5, 0.5));
      const arrow = mk(this.add.image(0, 0, 'world', M.SPRITES.lockzone.arrow).setScale(0.38 * D).setTint(0xffffff));
      this.hud = { pill, gems, coinI, coinT, timer, arrow, coinsTotal: this.coins.length };
      this.hudGems();
      coinT.setVisible(this.coins.length > 0); coinI.setVisible(this.coins.length > 0);
    }
    layoutHud() {
      const h = this.hud; if (!h) return;
      const I = this.S.insets || {}, sr = I.safeRight || 0;
      const D = this.D, w = this.scale.width, top = (14 + (I.safeTop || 0)) * D, ph = 36 * D;
      const gx = w - (22 + sr) * D, gy = top + 16 * D;
      const gw = (this.coins.length ? 3 * 32 + 62 : 3 * 32 + 12) * D;
      h.gems.forEach((g, i) => g.setPosition(gx - i * 32 * D, gy));
      h.coinI.setPosition(gx - 3 * 32 * D - 4 * D, gy);
      h.coinT.setPosition(gx - 3 * 32 * D - 20 * D, gy + 1 * D);
      // timer pill: centred when there is room, otherwise a second row under the gems (top-left stays free for SHELL)
      const tw = 124 * D;
      let tx = w / 2 - tw / 2, ty = top - 2 * D;
      if (tx + tw > w - (8 + sr) * D - gw - 8 * D) { tx = w - (8 + sr) * D - tw; ty = top + ph + 4 * D; }
      this.hudBottom = (ty + ph) / D + 6; // CSS px covered by the HUD: the camera may scroll past the level top by that much
      h.timer.setPosition(tx + tw / 2 + 12 * D, ty + ph / 2 + 1 * D);
      h.arrow.setPosition(tx + 18 * D, ty + ph / 2 + 1 * D);
      h.pill.clear();
      h.pill.fillStyle(0x10204a, 0.55);
      h.pill.fillRoundedRect(w - (8 + sr) * D - gw, top - 2 * D, gw, ph, ph / 2);
      h.pill.fillRoundedRect(tx, ty, tw, ph, ph / 2);
    }
    hudGems() {
      const h = this.hud; if (!h) return;
      h.gems.forEach((g, i) => {
        const on = i < this.gemsGot;
        // empty slot = white silhouette (reads on any background)
        if (on) g.clearTint().setAlpha(1); else g.setTintFill(0xffffff).setAlpha(0.45);
      });
      h.coinT.setText(String(this.coinsGot));
    }
    hudPop(o) {
      if (!o) return;
      if (o.__base == null) o.__base = o.scale;
      this.tweens.killTweensOf(o);
      o.setScale(o.__base);
      this.tweens.add({ targets: o, scale: o.__base * 1.5, duration: 110, yoyo: true, ease: 'Quad.easeOut' });
    }

    // ================================================================ colliders
    buildColliders() {
      const P = this.physics;
      P.add.collider(this.pz, this.ground);
      P.add.collider(this.pz, this.solids, this.onPlayerSolid, null, this);
      if (this.crates.length) {
        P.add.collider(this.pz, this.crateZones, this.onPlayerCrate, this.procPlayerCrate, this);
        P.add.collider(this.crateZones, this.ground);
        P.add.collider(this.crateZones, this.solids);
        P.add.collider(this.crateZones, this.crateZones, null, this.procCrateCrate, this);
      }
      if (this.slimes.length) {
        P.add.collider(this.slimeZones, this.ground);
        P.add.collider(this.slimeZones, this.solids);
        if (this.crates.length) P.add.collider(this.slimeZones, this.crateZones, this.onSlimeCrate, this.procSlimeCrate, this);
      }
      if (this.platforms.length) {
        const pz = this.platforms.map((p) => p.z);
        P.add.collider(this.pz, pz, this.onPlayerPlat, null, this);
        if (this.crates.length) P.add.collider(this.crateZones, pz, this.onCratePlat, null, this);
        if (this.slimes.length) P.add.collider(this.slimeZones, pz);
      }
    }
    onPlayerSolid(pz, z) { if (z.__crumble) this.triggerCrumble(z.__crumble); }
    procPlayerCrate(pz, cz) {
      // the crate is pushable only when it lands on the player's head; otherwise the player is separated
      const d = this.pDir, relA = (cz.x - pz.x) * GX[d] + (cz.y - pz.y) * GY[d], relP = Math.abs((cz.x - pz.x) * GY[d]) + Math.abs((cz.y - pz.y) * GX[d]);
      const above = relA < 0 && -relA > relP;
      cz.body.pushable = above; pz.body.pushable = !above;
      return true;
    }
    onPlayerCrate(pz, cz) {
      const o = cz.__crate, d = this.pDir;
      const dx = cz.x - pz.x, dy = cz.y - pz.y;
      const relA = dx * GX[d] + dy * GY[d];
      const relP = d < 2 ? dx : dy;
      if (relA > 0 && relA > Math.abs(relP)) { this.rideNext = null; return; } // standing on crate
      if (Math.abs(relP) > Math.abs(relA) && Math.sign(relP) === Math.sign(this.walkV) && Math.abs(this.walkV) > 40) {
        o.push = Math.sign(relP) * 150; o.pushT = 0.08;
      }
    }
    procCrateCrate(a, b) {
      const d = a.__crate.g, relA = (b.x - a.x) * GX[d] + (b.y - a.y) * GY[d];
      // the upper crate (against gravity) gets moved; the lower one holds
      a.body.pushable = relA < 0; b.body.pushable = relA >= 0;
      return true;
    }
    procSlimeCrate(sz, cz) { cz.body.pushable = false; sz.body.pushable = true; return true; }
    onSlimeCrate(sz, cz) {
      const s = sz.__slime, c = cz.__crate, d = c.g;
      const relA = (sz.x - cz.x) * GX[d] + (sz.y - cz.y) * GY[d];
      if (s.alive && relA > 20 && c.lastAlong > 160) this.killSlime(s, false);
      else if (s.alive) s.dir = -s.dir;
    }
    onPlayerPlat(pz, z) {
      this.platHit = true;
      const d = this.pDir, p = z.__plat;
      const relA = (z.x - pz.x) * GX[d] + (z.y - pz.y) * GY[d];
      if (relA > 0 && this.pb.touching[DN[d]]) this.rideNext = p;
    }
    onCratePlat(cz, z) {
      const c = cz.__crate, d = c.g;
      if (cz.body.touching[DN[d]]) c.rideNext = z.__plat;
    }

    // ================================================================ input
    buildInput() {
      const kb = this.input.keyboard;
      this.input.on('pointerdown', () => this.pressJump(true));
      this.input.on('pointerup', () => { if (!this.anyPointerDown()) this.pressJump(false); });
      this.input.on('pointerupoutside', () => { if (!this.anyPointerDown()) this.pressJump(false); });
      if (kb) {
        kb.addCapture('SPACE');
        kb.on('keydown', (e) => {
          const c = e.code;
          if (c === 'Space' || c === 'KeyZ' || c === 'KeyX' || c === 'KeyK' || c === 'KeyJ') { if (!e.repeat) this.pressJump(true); }
          else if (c === 'Escape' || c === 'KeyP') { if (this.state === 'play') { const S = this.S; pauseSession(S, true); } }
          else if (c === 'KeyR' && DEBUG) restartSession(this.S);
        });
        kb.on('keyup', (e) => {
          const c = e.code;
          if (c === 'Space' || c === 'KeyZ' || c === 'KeyX' || c === 'KeyK' || c === 'KeyJ') this.pressJump(false);
        });
      }
    }
    anyPointerDown() {
      const ps = this.input.manager.pointers;
      for (let i = 0; i < ps.length; i++) if (ps[i].isDown) return true;
      return false;
    }
    pressJump(down) {
      if (down) { this.jumpHeld = true; this.jumpPressT = this.time.now; this.jumpCutDone = false; }
      else this.jumpHeld = false;
    }

    // ================================================================ helpers
    sfx(name, cfg, minGap) {
      if (!this.S.sound) return;
      const key = 'sfx:' + name;
      if (!this.cache.audio.exists(key)) return;
      const now = this.time.now;
      if (minGap && this.sndT[name] && now - this.sndT[name] < minGap) return;
      this.sndT[name] = now;
      try { this.sound.play(key, cfg || { volume: 0.7 }); } catch (e) { /* ignore */ }
    }
    vib(p) {
      if (!this.S.opts.haptics || !navigator.vibrate) return;
      try { navigator.vibrate(p); } catch (e) { /* ignore */ }
    }
    zoneAt(x, y) {
      const L = this.L, c = Math.floor(x / T), r = Math.floor(y / T);
      if (c < 0 || r < 0 || c >= L.W || r >= L.H) return -1;
      return L.zone[r * L.W + c];
    }
    zoneStep() {
      const b = this.pb;
      if (this.state !== 'play' || !b || !b.enable) return;
      const zd = this.zoneAt(b.center.x, b.center.y);
      if (zd < 0 || zd === this.pDir) return;
      const vx = b.velocity.x, vy = b.velocity.y;
      this.setPlayerGravity(zd, true);
      this.inZone = zd;
      const gx = GX[zd], gy = GY[zd];
      b.gravity.set(gx * GRAV, gy * GRAV);
      const along = Math.min(FALL_MAX, vx * gx + vy * gy);
      if (zd < 2) { b.velocity.x = this.walkV; b.velocity.y = along * gy; } else { b.velocity.y = this.walkV; b.velocity.x = along * gx; }
    }
    readTilt() {
      if (this.tiltOverride) return this.tiltOverride;
      const s = this.S.opts.sensors;
      let v = null;
      try { v = s && s.read ? s.read() : null; } catch (e) { v = null; }
      if (!v) return ZERO;
      return v;
    }

    // ================================================================ gravity
    pickGravity(tx, ty) {
      const ax = Math.abs(tx), ay = Math.abs(ty);
      let nd = -1, nm = 0;
      if (ax >= ay) { if (ax > FLIP_T) { nd = tx > 0 ? 3 : 2; nm = ax; } }
      else if (ay > FLIP_T) { nd = ty > 0 ? 0 : 1; nm = ay; }
      if (nd < 0 || nd === this.gDir) return;
      const cur = tx * GX[this.gDir] + ty * GY[this.gDir];
      if (nm > cur + HYST && this.time.now - this.lastFlip > 130) {
        this.gDir = nd; this.lastFlip = this.time.now;
      }
    }

    setPlayerGravity(nd, fx) {
      const od = this.pDir;
      if (nd === od) return;
      this.pDir = nd;
      // velocity: keep world velocity, recompute the walk component on the new perpendicular axis
      const b = this.pb;
      this.walkV = nd < 2 ? b.velocity.x : b.velocity.y;
      this.walkV = clamp(this.walkV, -RUN_MAX, RUN_MAX);
      this.lastGroundT = -1e9; // no coyote after a flip
      this.ride = this.rideNext = null;
      this.airCarry = 0; // walkV above already holds the carried world velocity
      // rotate visual: shortest path
      let target = ANG[nd];
      let delta = ((target - this.pAngT) % 360 + 540) % 360 - 180;
      this.pAngT += delta;
      this.tweens.killTweensOf(this.pAngObj || (this.pAngObj = { a: 0 }));
      this.pAngObj.a = this.pAng;
      this.tweens.add({ targets: this.pAngObj, a: this.pAngT, duration: 190, ease: 'Cubic.easeOut' });
      if (fx) {
        this.sqv += 5;
        this.camKVX += GX[nd] * 260; this.camKVY += GY[nd] * 260;
        this.burst(this.fxRing, 1, this.pz.x, this.pz.y);
        this.fxSpark.setParticleGravity(GX[nd] * 300, GY[nd] * 300);
        this.burst(this.fxSpark, 8, this.pz.x, this.pz.y);
        this.sfx('flip', { volume: 0.5, detune: (nd * 70) - 100 }, 90);
        this.vib(12);
        if (this.hud) {
          this.tweens.killTweensOf(this.hud.arrow);
          this.hud.arrow.setScale(0.38 * this.D);
          this.tweens.add({ targets: this.hud.arrow, scale: 0.55 * this.D, duration: 120, yoyo: true });
        }
      }
    }

    // ================================================================ update
    update(time, delta) {
      if (this.state === 'paused') return;
      const dt = Math.min(delta, 100) / 1000; // Arcade simulates the full delta; keep control in step with it
      const tilt = this.readTilt();
      const tx = clamp(+tilt.x || 0, -1, 1), ty = clamp(+tilt.y || 0, -1, 1);
      this.pickGravity(tx, ty);

      if (this.state === 'play') {
        this.elapsed += dt;
        this.updatePlayer(dt, tx, ty);
      }
      this.updatePlatforms(dt);
      this.updateCrates(dt);
      this.updateSlimes(dt);
      this.updateMovers(dt);
      if (this.state === 'play') this.checkContacts();
      this.updateVisuals(dt);
      this.updateCamera(dt);
      this.updateBackground(dt);
      this.updateHud();
    }

    updatePlayer(dt, tx, ty) {
      const b = this.pb, now = this.time.now;
      // effective gravity: lock zone overrides tilt
      const zd = this.zoneAt(this.pz.x, this.pz.y);
      // leaving a lock zone: keep the zone's gravity (as if the tilt had chosen it) until the tilt picks another one
      if (zd < 0 && this.inZone >= 0) this.gDir = this.inZone;
      this.inZone = zd;
      const want = zd >= 0 ? zd : this.gDir;
      if (want !== this.pDir) this.setPlayerGravity(want, true);
      const d = this.pDir, gx = GX[d], gy = GY[d];
      b.gravity.set(gx * GRAV, gy * GRAV);

      const grounded = b.blocked[DN[d]] || b.touching[DN[d]];
      // contacts (rideNext) are only produced by physics steps: on a frame with no step (high refresh rates) keep the
      // current ride, otherwise the platform slides away under the player
      if (this.physics.world.stepsLastFrame) { this.ride = grounded ? this.rideNext : null; this.rideNext = null; }
      else if (!grounded) this.ride = null;

      // landing
      if (grounded && !this.wasGrounded) {
        this.airCarry = 0;
        const impact = this.lastAlong || 0;
        if (impact > 220) {
          const k = clamp(impact / 900, 0.2, 1);
          this.sq = 1 - 0.32 * k; this.sqv = 0;
          this.fxDust.setParticleGravity(-gx * 60, -gy * 60);
          this.burst(this.fxDust, 3 + Math.round(5 * k), this.pz.x + gx * PB / 2, this.pz.y + gy * PB / 2);
          this.sfx('land', { volume: 0.25 + 0.35 * k }, 80);
          if (impact > 700) this.camKVX += gx * 120, this.camKVY += gy * 120;
        }
      }
      if (grounded) this.lastGroundT = now;
      this.wasGrounded = grounded;

      // walking (perpendicular tilt component, screen space)
      const inp = d < 2 ? tx : ty;
      const mag = Math.abs(inp);
      const s = mag < DEADZONE ? 0 : Math.min(1, (mag - DEADZONE) / (FULL_TILT - DEADZONE));
      let target = Math.sign(inp) * s * RUN_MAX;
      // inside a lock zone with no sideways input: ease toward the zone cell's centre line so the 42 px body does not
      // snag on the corners of 1-tile openings (stream exits, lock doorways)
      if (zd >= 0 && s === 0) {
        const pos = d < 2 ? this.pz.x : this.pz.y, cc = Math.floor(pos / T) * T + T / 2;
        target = clamp((cc - pos) * 6, -120, 120);
        if (Math.abs(cc - pos) < 1.5) target = 0;
      }
      const acc = grounded ? (target !== 0 ? 2600 : 3200) : 1500;
      // quicker turnaround
      const turning = target !== 0 && Math.sign(target) !== Math.sign(this.walkV) && this.walkV !== 0;
      this.walkV = approach(this.walkV, target, acc * (turning ? 1.6 : 1) * dt);
      // against a wall (terrain/blocks): stop instead of "running in place" (crates are pushed, see onPlayerCrate)
      if (this.walkV !== 0) {
        const side = d < 2 ? (this.walkV > 0 ? 'right' : 'left') : (this.walkV > 0 ? 'down' : 'up');
        if (b.blocked[side]) this.walkV = 0;
      }

      // along-gravity velocity (positive = falling)
      let along = b.velocity.x * gx + b.velocity.y * gy;

      // jump (buffer + coyote)
      if (now - this.jumpPressT <= BUFFER * 1000 && now - this.lastGroundT <= COYOTE * 1000 && this.state === 'play') {
        along = -JUMP_V;
        this.jumpPressT = -1e9; this.lastGroundT = -1e9;
        this.jumpCutDone = false;
        if (this.ride) { this.airCarry = (d < 2 ? this.ride.m.vx : this.ride.m.vy); this.ride = null; } // keep the platform's speed in the air
        this.sq = 1.28; this.sqv = 0;
        this.fxDust.setParticleGravity(-gx * 40, -gy * 40);
        this.burst(this.fxDust, 5, this.pz.x + gx * PB / 2, this.pz.y + gy * PB / 2);
        this.sfx('jump', { volume: 0.45, detune: (Math.random() * 120) - 60 });
        this.vib(6);
      }
      // variable jump height
      if (!this.jumpHeld && !this.jumpCutDone && along < -200 && now - this.springT > 400) { along *= 0.48; this.jumpCutDone = true; }
      if (along > FALL_MAX) along = FALL_MAX;
      this.lastAlong = along;

      // moving platform carry
      let carryP = 0;
      if (this.ride) {
        const m = this.ride.m;
        carryP = d < 2 ? m.vx : m.vy;
        const pa = m.vx * gx + m.vy * gy;
        if (pa > along) along = pa; // platform moving away (with gravity): stick to it
      }

      if (this.airCarry) {
        const side = d < 2 ? (this.airCarry > 0 ? 'right' : 'left') : (this.airCarry > 0 ? 'down' : 'up');
        if (b.blocked[side]) this.airCarry = 0;
      }
      const perp = this.walkV + carryP + this.airCarry;
      if (d < 2) { b.velocity.x = perp; b.velocity.y = along * gy; }
      else { b.velocity.y = perp; b.velocity.x = along * gx; }

      // facing (in local frame)
      const lr = d === 0 ? 1 : d === 1 ? -1 : d === 2 ? 1 : -1; // local-right sign along the walk axis
      if (Math.abs(this.walkV) > 15) this.facing = Math.sign(this.walkV) * lr;

      // animation
      let anim;
      if (!grounded) anim = along < 0 ? 'jump' : 'fall';
      else if (Math.abs(this.walkV) > 25) anim = 'walk';
      else anim = 'idle';
      if (anim !== this.pAnim) { this.pAnim = anim; this.pv.play('flip-p-' + anim, true); }
      if (anim === 'walk') {
        this.pv.anims.timeScale = 0.6 + Math.abs(this.walkV) / RUN_MAX * 0.8;
        this.dustT -= dt;
        if (this.dustT <= 0) {
          this.dustT = 0.16;
          this.fxDust.setParticleGravity(-gx * 30, -gy * 30);
          this.burst(this.fxDust, 1, this.pz.x + gx * PB / 2 - (d < 2 ? Math.sign(this.walkV) * 10 : 0), this.pz.y + gy * PB / 2 - (d >= 2 ? Math.sign(this.walkV) * 10 : 0));
        }
        this.stepT -= dt * Math.abs(this.walkV) / RUN_MAX;
        if (this.stepT <= 0) { this.stepT = 0.28; this.sfx('step', { volume: 0.12, detune: Math.random() * 200 - 100 }); }
      }

      // crush detection (squeezed between solids)
      // (a crate resting on the head is NOT a crush: only terrain/static blocks and moving platforms count)
      const bl = b.blocked, tc = b.touching;
      // corner correction: the head (jumping, or riding a platform up through a gap) clips a ceiling corner by only a
      // few px → slide the body sideways out of it instead of stopping dead / being crushed
      const upS = DN[d ^ 1];
      if (bl[upS] || tc[upS]) {
        const hx = this.pz.x - gx * (PB / 2 + 2), hy = this.pz.y - gy * (PB / 2 + 2);
        const px = d < 2 ? 1 : 0, py = 1 - px, e = PB / 2 - 1;
        const sa = this.blockedAt(hx - px * e, hy - py * e), sb = this.blockedAt(hx + px * e, hy + py * e);
        if (sa !== sb) {
          const pos = d < 2 ? this.pz.x : this.pz.y;
          const shift = sb ? Math.floor((pos + e) / T) * T - (pos + PB / 2) - 0.5 : Math.floor((pos - e) / T) * T + T - (pos - PB / 2) + 0.5;
          if (Math.abs(shift) <= 16) { this.pz.x += shift * px; this.pz.y += shift * py; b.updateFromGameObject(); }
        }
      }
      let squeezed = (bl.left && bl.right) || (bl.up && bl.down);
      if (!squeezed && this.platHit) squeezed = ((bl.left || tc.left) && (bl.right || tc.right)) || ((bl.up || tc.up) && (bl.down || tc.down));
      if (this.physics.world.stepsLastFrame) this.platHit = false;
      this.crushFrames = squeezed ? this.crushFrames + 1 : 0;
      if (this.crushFrames > 4) this.die('crush');
      // out of the world (should not happen with solid borders)
      if (this.pz.x < -T || this.pz.y < -T || this.pz.x > this.LW + T || this.pz.y > this.LH + T) this.die('out');
    }

    updatePlatforms(dt) {
      for (const p of this.platforms) {
        const m = p.m;
        const ox = m.x, oy = m.y;
        this.stepMover(m, dt);
        // drive the body by velocity so Arcade resolves contacts; correct drift
        const bx = p.z.body.center.x, by = p.z.body.center.y;
        p.z.body.velocity.set(m.vx + (ox - bx) * 8, m.vy + (oy - by) * 8);
        if (this.state !== 'play' && this.state !== 'dead' && this.state !== 'win') p.z.body.velocity.set(0, 0);
      }
    }

    updateCrates(dt) {
      for (const c of this.crates) {
        const b = c.z.body;
        const zd = this.zoneAt(c.z.x, c.z.y);
        const d = zd >= 0 ? zd : this.gDir;
        c.g = d;
        b.gravity.set(GX[d] * GRAV, GY[d] * GRAV);
        const grounded = b.blocked[DN[d]] || b.touching[DN[d]];
        if (this.physics.world.stepsLastFrame) { c.ride = grounded ? c.rideNext : null; c.rideNext = null; }
        else if (!grounded) c.ride = null;
        let along = b.velocity.x * GX[d] + b.velocity.y * GY[d];
        if (grounded && c.lastAlong > 300) {
          this.burst(this.fxDust, 4, c.z.x + GX[d] * CB / 2, c.z.y + GY[d] * CB / 2);
          this.sfx('push', { volume: clamp(c.lastAlong / 1400, 0.15, 0.6) }, 60);
          if (c.lastAlong > 600) { this.camKVX += GX[d] * 90; this.camKVY += GY[d] * 90; }
        }
        if (along > FALL_MAX) along = FALL_MAX;
        c.lastAlong = along;
        let perp = d < 2 ? b.velocity.x : b.velocity.y;
        if (c.pushT > 0) { c.pushT -= dt; perp = approach(perp, c.push, 2400 * dt); }
        else perp = approach(perp, 0, (grounded ? 2400 : 200) * dt);
        if (c.ride) { perp += d < 2 ? c.ride.m.vx : c.ride.m.vy; const pa = c.ride.m.vx * GX[d] + c.ride.m.vy * GY[d]; if (pa > along) along = pa; }
        if (d < 2) { b.velocity.x = perp; b.velocity.y = along * GY[d]; } else { b.velocity.y = perp; b.velocity.x = along * GX[d]; }
        // springs
        for (const s of this.springs) this.springCheck(s, c.z.x - CB / 2, c.z.y - CB / 2, c.z.x + CB / 2, c.z.y + CB / 2, b, d, null);
      }
    }

    updateSlimes(dt) {
      const now = this.time.now;
      for (const s of this.slimes) {
        if (!s.alive) continue;
        const b = s.z.body;
        const zd = this.zoneAt(s.z.x, s.z.y);
        const d = zd >= 0 ? zd : this.gDir;
        if (d !== s.g) { s.g = d; s.turnT = now + 200; }
        b.gravity.set(GX[d] * GRAV, GY[d] * GRAV);
        const grounded = b.blocked[DN[d]] || b.touching[DN[d]];
        // walk axis: x for vertical gravity, y for horizontal
        const px = d < 2 ? 1 : 0, py = d < 2 ? 0 : 1;
        if (grounded && now > s.turnT) {
          const wallName = d < 2 ? (s.dir > 0 ? 'right' : 'left') : (s.dir > 0 ? 'down' : 'up');
          const hx = s.z.x + px * s.dir * (SB / 2 + 6), hy = s.z.y + py * s.dir * (SB / 2 + 6);
          const ledge = !this.blockedAt(hx + GX[d] * (SB / 2 + 12), hy + GY[d] * (SB / 2 + 12));
          const wall = b.blocked[wallName] || b.touching[wallName] || this.blockedAt(hx, hy);
          if (wall || ledge) { s.dir = -s.dir; s.turnT = now + 250; }
        }
        let along = b.velocity.x * GX[d] + b.velocity.y * GY[d];
        if (along > FALL_MAX) along = FALL_MAX;
        const perp = grounded ? s.dir * 75 : (d < 2 ? b.velocity.x : b.velocity.y) * 0.98;
        if (d < 2) { b.velocity.x = perp; b.velocity.y = along * GY[d]; } else { b.velocity.y = perp; b.velocity.x = along * GX[d]; }
        if (grounded && !s.wasG) { s.sq = 0.7; }
        s.wasG = grounded;
      }
    }

    updateMovers(dt) {
      const t = this.time.now / 1000;
      for (const s of this.saws) {
        this.stepMover(s.m, dt);
        s.img.setPosition(s.m.x, s.m.y);
        s.img.rotation += dt * 11;
      }
      for (const f of this.flies) {
        if (!f.alive) continue;
        this.stepMover(f.m, dt);
        const bob = Math.sin(t * 4 + f.ph) * 7;
        f.x = f.m.x; f.y = f.m.y + bob;
        f.img.setPosition(f.x, f.y);
        if (Math.abs(f.m.vx) > 5) f.face = f.m.vx > 0 ? 1 : -1;
        f.img.setFlipX(f.face > 0); // art faces left
      }
    }

    springCheck(s, x0, y0, x1, y1, body, d, isPlayer) {
      if (x1 <= s.x0 || x0 >= s.x1 || y1 <= s.y0 || y0 >= s.y1) return false;
      const now = this.time.now;
      const along = body.velocity.x * GX[d] + body.velocity.y * GY[d];
      if (along < -300 || now - s.t < 180) return false;
      s.t = now;
      const v = isPlayer ? SPRING_V : SPRING_V * 0.85;
      if (d < 2) body.velocity.y = -GY[d] * v; else body.velocity.x = -GX[d] * v;
      s.img.setFrame(M.SPRITES.spring.bounce);
      this.tweens.add({ targets: s.img, scaleX: 1.15, scaleY: 1.15, duration: 80, yoyo: true });
      this.time.delayedCall(220, () => s.img.setFrame(M.SPRITES.spring.idle));
      this.burst(this.fxRing, 1, (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2);
      this.sfx('spring', { volume: 0.6 }, 60);
      return true;
    }

    // ================================================================ contacts (manual, allocation-free)
    checkContacts() {
      const px = this.pz.x, py = this.pz.y, h = PB / 2 - 4;
      const x0 = px - h, y0 = py - h, x1 = px + h, y1 = py + h;
      const d = this.pDir, b = this.pb;
      // spikes
      for (const s of this.spikes) {
        if (x1 > s.x0 && x0 < s.x1 && y1 > s.y0 && y0 < s.y1) { this.die('spike'); return; }
      }
      // springs
      for (const s of this.springs) {
        if (this.springCheck(s, x0, y0, x1, y1, b, d, true)) {
          this.springT = this.time.now; this.jumpCutDone = true;
          this.sq = 1.35; this.sqv = 0; this.vib(15);
          this.lastGroundT = -1e9;
        }
      }
      // saws
      for (const s of this.saws) {
        const cx = clamp(s.m.x, x0, x1), cy = clamp(s.m.y, y0, y1);
        const dx = s.m.x - cx, dy = s.m.y - cy;
        if (dx * dx + dy * dy < s.r * s.r) { this.die('saw'); return; }
      }
      // flies (stompable from "above" relative to gravity)
      for (const f of this.flies) {
        if (!f.alive) continue;
        const cx = clamp(f.x, x0, x1), cy = clamp(f.y, y0, y1);
        const dx = f.x - cx, dy = f.y - cy;
        if (dx * dx + dy * dy < f.r * f.r) {
          const rel = (px - f.x) * GX[d] + (py - f.y) * GY[d];
          const along = b.velocity.x * GX[d] + b.velocity.y * GY[d];
          if (rel < -10 && along > 40) this.stompFly(f); else { this.die('fly'); return; }
        }
      }
      // slimes
      for (const s of this.slimes) {
        if (!s.alive) continue;
        const sx = s.z.x, sy = s.z.y, sh = SB / 2 - 2;
        if (x1 > sx - sh && x0 < sx + sh && y1 > sy - sh && y0 < sy + sh) {
          const rel = (px - sx) * GX[d] + (py - sy) * GY[d];
          const along = b.velocity.x * GX[d] + b.velocity.y * GY[d];
          if (rel < -8 && along > -50) this.killSlime(s, true); else { this.die('slime'); return; }
        }
      }
      // gems / coins / keys
      for (const g of this.gems) {
        if (g.got) continue;
        const dx = g.x - px, dy = g.y - py;
        if (dx * dx + dy * dy < 44 * 44) this.collectGem(g);
      }
      for (const g of this.coins) {
        if (g.got) continue;
        const dx = g.x - px, dy = g.y - py;
        if (dx * dx + dy * dy < 32 * 32) this.collectCoin(g);
      }
      for (const k of this.keys) {
        if (k.got) continue;
        const dx = k.x - px, dy = k.y - py;
        if (dx * dx + dy * dy < 44 * 44) this.collectKey(k);
      }
      for (const k of this.checks) {
        if (k.on) continue;
        const dx = k.x - px, dy = k.y - py;
        if (dx * dx + dy * dy < 40 * 40) this.activateCheck(k);
      }
      // exit
      const door = this.door;
      if (door) {
        const dx = door.x - px, dy = door.y - py, dd = dx * dx + dy * dy;
        if (!door.open && dd < (T * 2.6) * (T * 2.6)) this.openDoor();
        if (Math.abs(dx) < T * 0.6 && Math.abs(dy) < T * 0.6) this.win(); // body overlaps the door (any gravity)
      }
    }

    activateCheck(k) {
      for (const o of this.checks) if (o.on) { o.on = false; o.img.stop(); o.img.setFrame(M.SPRITES.checkpoint.frames.off[0]); }
      k.on = true;
      k.img.play('flip-flag');
      this.spawnX = k.x + GX[k.d] * (T / 2 - PB / 2); this.spawnY = k.y + GY[k.d] * (T / 2 - PB / 2); this.spawnDir = k.d;
      this.tweens.add({ targets: k.img, scaleY: 1.25, duration: 120, yoyo: true });
      this.burst(this.fxStar, 8, k.x, k.y);
      this.sfx('select', { volume: 0.6 });
      this.vib(15);
    }
    collectGem(g) {
      g.got = true;
      this.gemsGot++;
      this.tweens.add({ targets: g.img, scale: 1.7, alpha: 0, duration: 260, ease: 'Quad.easeOut' });
      this.tweens.add({ targets: g.glow, scale: 2.4, alpha: 0, duration: 380 });
      this.burst(this.fxSpark, 14, g.x, g.y);
      this.burst(this.fxStar, 6, g.x, g.y);
      this.burst(this.fxRing, 1, g.x, g.y);
      this.sfx('gem', { volume: 0.7, detune: (this.gemsGot - 1) * 200 });
      this.vib(18);
      this.hudGems();
      if (this.hud) this.hudPop(this.hud.gems[this.gemsGot - 1]);
      try { this.S.opts.onGems && this.S.opts.onGems(this.gemsGot); } catch (e) { console.error(e); }
    }
    collectCoin(g) {
      g.got = true;
      this.coinsGot++;
      this.tweens.add({ targets: g.img, y: g.y - 40 * GY[this.pDir] - 0, x: g.x - 40 * GX[this.pDir], scale: 0.2, alpha: 0, duration: 260, ease: 'Quad.easeOut' });
      this.fxSpark.setParticleGravity(0, 0);
      this.burst(this.fxSpark, 5, g.x, g.y);
      this.sfx('coin', { volume: 0.45, detune: Math.min(this.coinsGot * 15, 300) }, 30);
      this.hudGems();
      if (this.hud) this.hudPop(this.hud.coinI);
    }
    collectKey(k) {
      k.got = true;
      this.tweens.add({ targets: k.img, scale: 1.8, alpha: 0, angle: 200, duration: 380, ease: 'Quad.easeOut' });
      this.tweens.add({ targets: k.glow, scale: 2.5, alpha: 0, duration: 380 });
      this.burst(this.fxStar, 10, k.x, k.y);
      this.sfx('key', { volume: 0.7 });
      this.vib(25);
      this.time.delayedCall(260, () => this.unlockAll());
    }
    unlockAll() {
      let i = 0;
      for (const l of this.locks) {
        if (!l.active) continue;
        const delay = i++ * 90;
        this.tweens.add({ targets: l.img, x: l.img.x + 3, duration: 40, yoyo: true, repeat: 3, delay });
        this.time.delayedCall(delay + 200, () => {
          l.active = false;
          l.z.body.enable = false;
          this.tweens.add({ targets: l.img, scale: 1.4, alpha: 0, duration: 260, ease: 'Quad.easeOut' });
          this.burst(this.fxStar, 6, l.img.x, l.img.y);
          this.burst(this.fxSmoke, 4, l.img.x, l.img.y);
        });
      }
      if (this.locks.length) { this.sfx('unlock', { volume: 0.7 }); this.wCam.shake(120, 0.003); }
    }
    triggerCrumble(o) {
      if (!o.solid || o.phase) return;
      o.phase = 1;
      o.img.setFrame(o.frames.warn || o.frames.idle);
      this.tweens.add({ targets: o.img, x: o.x + 2.5, duration: 45, yoyo: true, repeat: 5 });
      this.sfx('crumble', { volume: 0.35, rate: 1.4 }, 100);
      this.time.delayedCall(500, () => {
        o.solid = false; o.phase = 2;
        o.z.body.enable = false;
        o.img.setVisible(false).setPosition(o.x, o.y);
        this.debris(o);
        this.sfx('crumble', { volume: 0.6 }, 60);
        this.time.delayedCall(3000, () => this.respawnCrumble(o));
      });
    }
    debris(o) {
      const d = this.gDir;
      for (let i = 0; i < 4; i++) {
        const qx = (i & 1) ? 1 : -1, qy = (i & 2) ? 1 : -1;
        const piece = this.add.image(o.x + qx * 16, o.y + qy * 16, 'world', o.frames.idle).setCrop((i & 1) * 32, ((i & 2) >> 1) * 32, 32, 32);
        piece.setPosition(o.x, o.y);
        this.objL.add(piece);
        this.tweens.add({ targets: piece, x: o.x + qx * 28 + GX[d] * 140, y: o.y + qy * 28 + GY[d] * 140, angle: qx * 120, alpha: 0, duration: 650, ease: 'Quad.easeIn', onComplete: () => piece.destroy() });
      }
      this.burst(this.fxDirt, 8, o.x, o.y);
      this.burst(this.fxSmoke, 3, o.x, o.y);
    }
    respawnCrumble(o) {
      if (!this.sys || !this.sys.isActive()) return;
      // wait until nothing overlaps the cell
      const h = T / 2 + PB / 2 - 2;
      if (Math.abs(this.pz.x - o.x) < h && Math.abs(this.pz.y - o.y) < h) { this.time.delayedCall(400, () => this.respawnCrumble(o)); return; }
      for (const c of this.crates) if (Math.abs(c.z.x - o.x) < T - 2 && Math.abs(c.z.y - o.y) < T - 2) { this.time.delayedCall(400, () => this.respawnCrumble(o)); return; }
      o.solid = true; o.phase = 0;
      o.z.body.enable = true;
      o.img.setFrame(o.frames.idle).setVisible(true).setScale(0.2).setAlpha(0);
      this.tweens.add({ targets: o.img, scale: 1, alpha: 1, duration: 260, ease: 'Back.easeOut' });
    }
    killSlime(s, byPlayer) {
      s.alive = false;
      s.z.body.enable = false;
      s.img.stop(); s.img.setFrame(M.SPRITES.slime.frames.dead[0]);
      this.tweens.add({ targets: s.img, alpha: 0, delay: 350, duration: 300, onComplete: () => s.img.setVisible(false) });
      this.burst(this.fxSmoke, 4, s.z.x, s.z.y);
      this.burst(this.fxStar, 5, s.z.x, s.z.y);
      this.sfx('stomp', { volume: 0.7 });
      if (byPlayer) this.bouncePlayer();
    }
    stompFly(f) {
      f.alive = false;
      f.img.stop(); f.img.setFrame(M.SPRITES.fly.frames.dead[0]);
      const d = this.pDir;
      this.tweens.add({ targets: f.img, x: f.x + GX[d] * 200, y: f.y + GY[d] * 200, angle: 180, alpha: 0, duration: 600, ease: 'Quad.easeIn' });
      this.burst(this.fxStar, 5, f.x, f.y);
      this.sfx('stomp', { volume: 0.7 });
      this.bouncePlayer();
    }
    bouncePlayer() {
      const d = this.pDir, b = this.pb, v = this.jumpHeld ? JUMP_V * 0.95 : JUMP_V * 0.6;
      if (d < 2) b.velocity.y = -GY[d] * v; else b.velocity.x = -GX[d] * v;
      this.jumpCutDone = !this.jumpHeld;
      this.sq = 1.3; this.sqv = 0;
      this.vib(20);
      this.camKVX += GX[d] * 80; this.camKVY += GY[d] * 80;
    }
    openDoor() {
      const door = this.door;
      door.open = true;
      door.img.setFrame(M.SPRITES.door.open);
      this.tweens.add({ targets: door.img, scaleX: door.img.scaleX * 1.12, scaleY: door.img.scaleY * 0.94, duration: 120, yoyo: true, ease: 'Quad.easeOut' });
      this.tweens.add({ targets: door.glow, alpha: 0.55, duration: 400 });
      this.tweens.add({ targets: door.glow, scale: 1.5, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      this.burst(this.fxStar, 6, door.x, door.y);
      this.sfx('door', { volume: 0.5 });
    }

    // ================================================================ death / win
    die(cause) {
      if (this.state !== 'play') return;
      this.lastCause = cause || '?';
      this.state = 'dead';
      this.deaths++;
      this.S.deaths = this.deaths;
      const x = this.pz.x, y = this.pz.y;
      this.pb.enable = false;
      this.pb.velocity.set(0, 0);
      this.pv.play('flip-p-hurt', true); this.pAnim = 'hurt';
      this.pv.setTint(0xff8080);
      this.tweens.add({ targets: this.pScale, s: 1.35, duration: 140, ease: 'Quad.easeOut', yoyo: false });
      this.tweens.add({ targets: this.pv, alpha: 0, delay: 120, duration: 200 });
      this.fxSpark.setParticleGravity(0, 0);
      this.burst(this.fxStar, 14, x, y);
      this.burst(this.fxSmoke, 8, x, y);
      this.burst(this.fxRing, 1, x, y);
      this.wCam.shake(220, 0.012);
      this.sfx('death', { volume: 0.7 });
      this.vib([40, 30, 60]);
      try { this.S.opts.onDeath && this.S.opts.onDeath(this.deaths); } catch (e) { console.error(e); }
      this.time.delayedCall(720, () => this.respawn());
    }
    respawn() {
      if (this.state !== 'dead') return;
      // reset crates (puzzles must stay solvable)
      for (const c of this.crates) { c.z.body.reset(c.sx, c.sy); c.z.body.velocity.set(0, 0); c.push = 0; c.pushT = 0; c.lastAlong = 0; }
      const sd = this.spawnDir || 0;
      this.gDir = sd; this.lastFlip = this.time.now; this.inZone = -1;
      this.pDir = sd; this.pAng = this.pAngT = ANG[sd];
      if (this.pAngObj) { this.tweens.killTweensOf(this.pAngObj); this.pAngObj.a = ANG[sd]; }
      this.pb.enable = true;
      this.pb.reset(this.spawnX, this.spawnY);
      this.pb.velocity.set(0, 0);
      this.walkV = 0; this.wasGrounded = false; this.lastAlong = 0;
      this.ride = this.rideNext = null; this.airCarry = 0;
      this.jumpPressT = -1e9; this.lastGroundT = -1e9;
      this.pv.clearTint().setAlpha(1);
      this.pScale.s = 0;
      this.tweens.killTweensOf(this.pScale);
      this.tweens.add({ targets: this.pScale, s: 1, duration: 300, ease: 'Back.easeOut' });
      this.burst(this.fxSpark, 10, this.spawnX, this.spawnY);
      this.burst(this.fxRing, 1, this.spawnX, this.spawnY);
      this.sfx('poof', { volume: 0.4 });
      this.state = 'play';
      this.camFast = 0.35;
    }
    win() {
      if (this.state !== 'play') return;
      this.state = 'win';
      const door = this.door;
      this.pb.enable = false;
      this.pb.velocity.set(0, 0);
      this.pv.play('flip-p-win', true); this.pAnim = 'win';
      this.tweens.add({ targets: this.pz, x: door.x, y: door.y, duration: 300, ease: 'Quad.easeOut' });
      this.tweens.add({ targets: this.pScale, s: 0, delay: 260, duration: 420, ease: 'Back.easeIn' });
      this.tweens.add({ targets: this.pAngObj || (this.pAngObj = { a: this.pAng }), a: this.pAngT + 360, delay: 200, duration: 600 });
      this.time.delayedCall(450, () => {
        this.burst(this.fxStar, 24, door.x, door.y);
        this.burst(this.fxSpark, 16, door.x, door.y);
        this.burst(this.fxRing, 1, door.x, door.y);
      });
      this.wCam.zoomTo(this.wCam.zoom * 1.12, 700, 'Sine.easeInOut');
      this.sfx('win', { volume: 0.75 });
      this.vib([20, 40, 20, 40, 60]);
      const res = { time: Math.round(this.elapsed * 100) / 100, gems: this.gemsGot, coins: this.coinsGot, coinsTotal: this.coins.length, deaths: this.deaths };
      this.result = res;
      this.time.delayedCall(950, () => { try { this.S.opts.onWin && this.S.opts.onWin(res); } catch (e) { console.error(e); } });
    }

    // ================================================================ visuals
    updateVisuals(dt) {
      const t = this.time.now / 1000;
      // player squash spring
      const k = 520, c = 18;
      this.sqv += (k * (1 - this.sq) - c * this.sqv) * dt;
      this.sq += this.sqv * dt;
      this.sq = clamp(this.sq, 0.55, 1.5);
      if (this.pAngObj) this.pAng = this.pAngObj.a;
      let sy = this.sq, sx = 1 + (1 - this.sq) * 0.85;
      if (this.pAnim === 'idle') { const br = Math.sin(t * 3.2) * 0.018; sy += br; sx -= br * 0.6; }
      const S = this.pBase * this.pScale.s;
      this.pv.setPosition(this.pz.x, this.pz.y);
      this.pv.setScale(S * sx * this.facing, S * sy);
      this.pv.setAngle(this.pAng);
      // speed trail when falling fast / springing
      if (this.state === 'play' && !this.low) {
        const v2 = this.pb.velocity.x * this.pb.velocity.x + this.pb.velocity.y * this.pb.velocity.y;
        if (v2 > 700 * 700) this.fxTrail.emitParticleAt(this.pz.x, this.pz.y, 1);
      }

      // gems/coins/keys idle motion
      for (const g of this.gems) if (!g.got) { const o = Math.sin(t * 2.6 + g.ph) * 4; g.img.y = g.y + o; g.glow.setScale(0.7 + Math.sin(t * 3 + g.ph) * 0.08); }
      for (const g of this.coins) if (!g.got) { const cs = Math.cos(t * 3.4 + g.ph); g.img.scaleX = 0.85 * Math.max(0.12, Math.abs(cs)); g.img.y = g.y + Math.sin(t * 2 + g.ph) * 2; }
      for (const g of this.keys) if (!g.got) { g.img.y = g.y + Math.sin(t * 2.2) * 5; g.img.angle = Math.sin(t * 1.7) * 8; }
      // lock-zone arrows flow
      for (const z of this.zoneArrows) {
        const p = (t * 1.6 - z.phase) % 1; const ph = p < 0 ? p + 1 : p;
        z.a.setAlpha(0.25 + 0.6 * Math.sin(ph * Math.PI));
        z.a.setPosition(z.x + GX[z.d] * (ph - 0.5) * 18, z.y + GY[z.d] * (ph - 0.5) * 18);
      }
      // crates
      for (const cr of this.crates) cr.img.setPosition(cr.z.x, cr.z.y);
      // platforms
      for (const p of this.platforms) p.ct.setPosition(p.z.x, p.z.y);
      // slimes
      for (const s of this.slimes) {
        if (!s.alive) continue;
        const target = ANG[s.g];
        let delta = ((target - s.ang) % 360 + 540) % 360 - 180;
        s.ang += delta * Math.min(1, dt * 14);
        s.sqv += (400 * (1 - s.sq) - 14 * s.sqv) * dt; s.sq += s.sqv * dt;
        const lr = s.g === 0 ? 1 : s.g === 1 ? -1 : s.g === 2 ? 1 : -1;
        const face = s.dir * lr; // +1 = moving local-right; art faces left
        const wob = Math.sin(t * 9 + s.z.x * 0.05) * 0.04;
        s.img.setPosition(s.z.x, s.z.y).setAngle(s.ang);
        s.img.setScale((1 + (1 - s.sq) * 0.6 + wob) * (face > 0 ? -1 : 1), s.sq - wob);
      }
    }

    // ================================================================ camera
    onResize(first) {
      const w = this.scale.width, h = this.scale.height;
      this.bgCam.setSize(w, h); this.wCam.setSize(w, h); this.hudCam.setSize(w, h);
      // zoom: ~9 tiles over the short side; fit whole level if it nearly fits
      const desired = Math.min(w, h) / (8.6 * T);
      this.layoutHud(); // → this.hudBottom (the whole-level fit keeps the level clear of the HUD)
      const hb = this.hud ? Math.max(this.S.insets.top, this.hudBottom || 0) * this.D : 0;
      const fit = Math.min(w / this.LW, Math.max(h * 0.5, h - hb) / this.LH);
      this.fitAll = fit >= desired * 0.8;
      if (this.fitAll) this.baseZoom = Math.min(fit * 0.98, desired * 1.6);
      else {
        // if the level is short (or narrow) for this screen, zoom in a bit so it fills that axis
        let z = desired;
        // (not in portrait: filling the tall axis would cut the view to ~6 tiles across)
        if (this.LH * desired < h && h <= w) z = Math.max(z, h / this.LH);
        if (this.LW * desired < w) z = Math.max(z, w / this.LW);
        this.baseZoom = Math.min(z, desired * 1.35);
      }
      if (this.state !== 'win') this.wCam.setZoom(this.baseZoom);
      this.layoutBackground();
      if (!first) this.snapCamera();
    }
    // camera target → this.ctX/ctY ; clamp → this.ccX/ccY (no per-frame allocations)
    camTarget() {
      const d = this.pDir, look = T * 1.3;
      this.ctX = this.pz.x + GX[d] * look + this.lookX;
      this.ctY = this.pz.y + GY[d] * look + this.lookY;
    }
    clampCam(cx, cy) {
      const z = this.wCam.zoom, hw = this.scale.width / (2 * z), hh = this.scale.height / (2 * z);
      const I = this.S.insets, k = this.D / z;
      const il = I.left * k, ir = I.right * k, it = Math.max(I.top, this.hud ? this.hudBottom || 0 : 0) * k, ib = I.bottom * k;
      this.ccX = this.LW <= hw * 2 - il - ir ? this.LW / 2 + (ir - il) / 2 : clamp(cx, hw - il, this.LW - hw + ir);
      this.ccY = this.LH <= hh * 2 - it - ib ? this.LH / 2 + (ib - it) / 2 : clamp(cy, hh - it, this.LH - hh + ib);
    }
    snapCamera() {
      this.camTarget();
      this.clampCam(this.ctX, this.ctY);
      this.camX = this.ccX; this.camY = this.ccY;
      this.wCam.centerOn(this.camX, this.camY);
    }
    updateCamera(dt) {
      // walking lookahead (smoothed)
      const d = this.pDir;
      const wl = this.walkV * 0.35;
      this.lookX += ((d < 2 ? wl : 0) - this.lookX) * Math.min(1, dt * 2.5);
      this.lookY += ((d >= 2 ? wl : 0) - this.lookY) * Math.min(1, dt * 2.5);
      this.camTarget();
      const dz = T * 0.35;
      let fast = 1;
      if (this.camFast > 0) { this.camFast -= dt; fast = 3; }
      const k = Math.min(1, dt * 4.5 * fast);
      const ex = this.ctX - this.camX, ey = this.ctY - this.camY;
      if (Math.abs(ex) > dz) this.camX += (ex - Math.sign(ex) * dz) * k;
      if (Math.abs(ey) > dz) this.camY += (ey - Math.sign(ey) * dz) * k;
      this.clampCam(this.camX, this.camY);
      const cx = this.ccX, cy = this.ccY;
      this.camX = cx; this.camY = cy;
      // kick spring
      this.camKVX += (-120 * this.camKX - 12 * this.camKVX) * dt; this.camKX += this.camKVX * dt;
      this.camKVY += (-120 * this.camKY - 12 * this.camKVY) * dt; this.camKY += this.camKVY * dt;
      this.wCam.centerOn(cx + this.camKX, cy + this.camKY);
    }

    updateHud() {
      const h = this.hud; if (!h) return;
      const s = this.elapsed;
      const m = Math.floor(s / 60), sec = s - m * 60;
      const txt = m + ':' + (sec < 10 ? '0' : '') + sec.toFixed(1);
      if (txt !== h.lastT) { h.timer.setText(txt); h.lastT = txt; }
      const a = ANG[this.pDir] + 180;
      h.arrow.angle += (((a - h.arrow.angle) % 360 + 540) % 360 - 180) * 0.25;
    }

    // ================================================================ lifecycle
    setPaused(p) {
      if (p) {
        if (this.state === 'paused') return;
        this.prevState = this.state; this.state = 'paused';
        this.physics.world.pause();
        this.tweens.pauseAll();
        this.time.paused = true;
        this.anims.pauseAll && this.anims.pauseAll();
        for (const e of this.emitters) e.pause();
        this.jumpHeld = false;
      } else {
        if (this.state !== 'paused') return;
        this.state = this.prevState || 'play';
        this.physics.world.resume();
        this.tweens.resumeAll();
        this.time.paused = false;
        this.anims.resumeAll && this.anims.resumeAll();
        for (const e of this.emitters) e.resume();
        this.jumpPressT = -1e9;
      }
    }
    onShutdown() {
      const kb = this.input.keyboard;
      if (kb) { kb.removeCapture('SPACE'); }
      if (this.physics && this.physics.world) this.physics.world.off('worldstep', this.zoneStep, this);
      if (this.anims.resumeAll) this.anims.resumeAll();
      if (DEBUG && window.__flip && window.__flip.__scene === this) window.__flip.__scene = null;
    }

    exposeDebug() {
      const sc = this;
      const prev = window.__flip || {};
      window.__flip = {
        __scene: sc,
        level: sc.S.level,
        get state() { return sc.state; },
        get player() {
          return { x: sc.pz.x, y: sc.pz.y, gravity: DN[sc.pDir], vx: sc.pb.velocity.x, vy: sc.pb.velocity.y,
            grounded: sc.pb.blocked[DN[sc.pDir]] || sc.pb.touching[DN[sc.pDir]], col: Math.floor(sc.pz.x / T), row: Math.floor(sc.pz.y / T) };
        },
        get gravity() { return DN[sc.gDir]; },
        get gems() { return sc.gemsGot; },
        get coins() { return sc.coinsGot; },
        get deaths() { return sc.deaths; },
        get time() { return sc.elapsed; },
        get now() { return sc.time.now; },
        get fps() { return sc.game.loop.actualFps; },
        setTilt(x, y) { sc.tiltOverride = x == null ? null : { x, y }; },
        jump(down = true) { sc.pressJump(down); },
        tap(ms = 120) { sc.pressJump(true); setTimeout(() => sc.pressJump(false), ms); },
        win() { if (!sc.door) return; sc.state = 'play'; sc.pz.setPosition(sc.door.x, sc.door.y); sc.pb.reset(sc.door.x, sc.door.y); sc.win(); },
        kill() { sc.die('debug'); },
        get lastCause() { return sc.lastCause; },
        teleport(c, r) { sc.pb.reset(c * T + T / 2, r * T + T / 2); },
        stats() { return { objects: sc.children.length, listeners: sc.events.eventNames().length, tweens: sc.tweens.getTweens().length, sounds: sc.sound.sounds.length, textures: Object.keys(sc.textures.list).length }; },
        prev,
      };
    }
  }
  return FlipScene;
}

const ZERO = { x: 0, y: 0 };

function crumbleFrames(theme) {
  const c = M.SPRITES.crumble;
  // (the grey 'stone' variant is too close to stone terrain: crumbling blocks must read as different)
  return { idle: c.idle, warn: c.warn, debris: c.debris };
}

function ensureAnims(g) {
  const A = g.anims;
  const sp = M.SPRITES;
  const mk = (key, atlas, frames, rate, repeat = -1) => {
    if (A.exists(key)) return;
    A.create({ key, frames: frames.map((f) => ({ key: atlas, frame: f })), frameRate: rate, repeat });
  };
  const pf = sp.player.frames;
  mk('flip-p-idle', 'chars', pf.idle, 1);
  mk('flip-p-walk', 'chars', pf.walk, (sp.player.fps && sp.player.fps.walk) || 9);
  mk('flip-p-jump', 'chars', pf.jump, 1);
  mk('flip-p-fall', 'chars', pf.fall || pf.jump, 1);
  mk('flip-p-hurt', 'chars', pf.hurt, 1);
  mk('flip-p-win', 'chars', pf.win || pf.front || pf.idle, 1);
  mk('flip-slime-walk', 'chars', sp.slime.frames.walk, sp.slime.fps || 5);
  mk('flip-fly', 'chars', sp.fly.frames.fly, sp.fly.fps || 14);
  mk('flip-flag', 'world', sp.checkpoint.frames.wave, sp.checkpoint.fps || 4);
}

// ------------------------------------------------------------------------------------------------------------------
// session control
function pauseSession(S, fromEngine) {
  if (!S || S.dead) return;
  S.paused = true;
  const sc = S.scene;
  if (sc && sc.sys && sc.sys.isActive() && sc.setPaused) sc.setPaused(true);
  if (music.snd && S.music) musicFadeTo(0.12, false);
  if (fromEngine) { try { S.opts.onPause && S.opts.onPause(); } catch (e) { console.error(e); } }
}
function resumeSession(S) {
  if (!S || S.dead) return;
  S.paused = false;
  const sc = S.scene;
  if (sc && sc.sys && sc.sys.isActive() && sc.setPaused) sc.setPaused(false);
  if (S.music) musicPlay('music:' + S.theme, true);
}
function restartSession(S) {
  if (!S || S.dead || !game) return;
  S.paused = false;
  S.deaths = 0;
  game.scene.stop('flip');
  game.scene.start('flip', { session: S });
}

/**
 * Start a level. Returns a handle immediately; the level appears once assets are loaded.
 */
export function startLevel(container, level, theme, opts = {}) {
  if (session && !session.dead) destroySession(session, true);
  const S = { level, theme: M.THEMES[theme] ? theme : 'grass', opts, sound: opts.sound !== false, music: opts.music !== false,
    deaths: 0, dead: false, paused: false, scene: null, container, insets: normInsets(opts.insets) };
  session = S;
  ensureGame(container, opts);
  gameReady.then(() => {
    if (S.dead) return;
    attachCanvas(container, opts);
    game.loop.wake();
    startScene(S);
  });
  // visibility → auto-pause
  S.onVis = () => { if (document.hidden && S.scene && S.scene.state === 'play') pauseSession(S, true); };
  document.addEventListener('visibilitychange', S.onVis);

  const handle = {
    pause() { pauseSession(S, false); },
    resume() { resumeSession(S); },
    restart() { restartSession(S); },
    destroy() { destroySession(S, false); },
    setSound(b) { S.sound = !!b; },
    setMusic(b) {
      S.music = !!b; if (S.dead) return;
      if (b) { const sc = S.scene; if (sc && sc.sys && sc.sys.isActive() && sc.ensureMusic) sc.ensureMusic(); else musicPlay('music:' + S.theme, true); if (S.paused) musicFadeTo(0.12, false); }
      else musicFadeTo(0, true);
    },
    // screen-space CSS px covered by SHELL controls (on-screen pad / jump button): the camera may scroll past the
    // level edge by that much, so the player is never hidden under them at a level border
    setInsets(o) { S.insets = normInsets(o); const sc = S.scene; if (sc && sc.sys && sc.sys.isActive() && sc.layoutHud) sc.layoutHud(); },
    jump(down) { const sc = S.scene; if (sc && sc.sys && sc.sys.isActive() && sc.pressJump) sc.pressJump(!!down); },
    get state() { return S.scene ? S.scene.state : 'loading'; },
  };
  return handle;
}

function normInsets(o) {
  o = o || {};
  // top/bottom/left/right: screen area (CSS px) covered by SHELL controls; safe*: device safe-area insets (notch, status bar)
  return { top: +o.top || 0, bottom: +o.bottom || 0, left: +o.left || 0, right: +o.right || 0,
    safeTop: +o.safeTop || 0, safeRight: +o.safeRight || 0, safeBottom: +o.safeBottom || 0, safeLeft: +o.safeLeft || 0 };
}

function startScene(S) {
  // NB: right after boot, scene add/start are queued by Phaser; the scene registers itself in S.scene in init()
  game.scene.start('flip', { session: S });
}

function destroySession(S, replacing) {
  if (S.dead) return;
  S.dead = true;
  document.removeEventListener('visibilitychange', S.onVis);
  if (session === S) session = null;
  if (!game) return;
  if (game.scene.getScene('flip')) game.scene.stop('flip');
  if (!replacing) {
    musicFadeTo(0, true);
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    const c = game.canvas;
    if (c && hostDiv && c.parentNode !== hostDiv) hostDiv.appendChild(c);
    // let the music fade, then sleep the loop
    setTimeout(() => { if (!session && game) game.loop.sleep(); }, 700);
  }
}

/** Optional warm-up: loads every asset (all themes). */
export function preloadAll(onProgress) {
  ensureGame(null, {});
  return gameReady.then(() => new Promise((resolve) => {
    if (game.loop.sleeping) game.loop.wake();
    game.scene.start('flip-loader', { onProgress, done: () => { ensureAnims(game); resolve(); if (!session) game.loop.sleep(); } });
  }));
}

/** Fully destroy the engine (frees the WebGL context). */
export function disposeEngine() {
  if (session) destroySession(session, false);
  if (music.snd) { try { music.snd.stop(); music.snd.destroy(); } catch (e) { /**/ } music.snd = null; music.key = null; }
  if (game) { game.destroy(true); game = null; gameReady = null; }
  if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
}
