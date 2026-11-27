// "עולם הפוך" (Flip) — shell / UI [SHELL]
// Screens (hash routes): #  title · #setup controls & sensors · #worlds · #w/<n> level grid · #play/<id> · #howto · #settings
// Owns: TiltSource (DeviceOrientation → screen-space tilt vector), progress, settings, menu audio, in-level overlays.
// The engine (flip-engine.js) only sees tilt.read() → {x,y}.
import { startLevel, preloadAll } from './flip-engine.js?v=55';
import { WORLDS } from './flip-levels.js?v=55';
import * as M from './flip/manifest.js?v=55';

export const VERSION = 55;
const params = new URLSearchParams(location.search);
const debugOn = params.get('debug') === '1';

fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' })
  .then(r => r.json())
  .then(({ version }) => {
    if (version <= VERSION) return;
    const key = `hathatul-reloaded-${version}`;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch {}
    params.set('v', version);
    location.replace(`${location.pathname}?${params}${location.hash}`);
  })
  .catch(() => {});

// <tilt-math> (pure; unit-tested in node by extracting this block)
/** Gravity direction in the device frame (x right, y up, z out of the screen) from DeviceOrientation beta/gamma (degrees). */
function gravityVec(beta, gamma, out) {
  const b = beta * Math.PI / 180, c = gamma * Math.PI / 180;
  out[0] = Math.cos(b) * Math.sin(c);
  out[1] = -Math.sin(b);
  out[2] = -Math.cos(b) * Math.cos(c);
  return out;
}
/** Rotate g by the minimal rotation that takes the calibration vector g0 to straight down (0,0,-1). */
function calibrateVec(g, g0, out) {
  if (!g0) { out[0] = g[0]; out[1] = g[1]; out[2] = g[2]; return out; }
  // k = g0 × d with d = (0,0,-1)  →  (-g0y, g0x, 0); cosθ = g0·d = -g0z
  let kx = -g0[1], ky = g0[0];
  const s = Math.hypot(kx, ky), co = -g0[2];
  if (s < 1e-6) {
    if (co > 0) { out[0] = g[0]; out[1] = g[1]; out[2] = g[2]; }
    else { out[0] = g[0]; out[1] = -g[1]; out[2] = -g[2]; } // face-down calibration: 180° about x
    return out;
  }
  kx /= s; ky /= s;
  const dot = kx * g[0] + ky * g[1];
  // k × g with k=(kx,ky,0): (ky*gz, -kx*gz, kx*gy - ky*gx)
  const cx = ky * g[2], cy = -kx * g[2], cz = kx * g[1] - ky * g[0];
  out[0] = g[0] * co + cx * s + kx * dot * (1 - co);
  out[1] = g[1] * co + cy * s + ky * dot * (1 - co);
  out[2] = g[2] * co + cz * s;
  return out;
}
/** Normalise a screen angle to 0/90/180/270 (window.orientation gives -90). */
function normAngle(a) {
  a = Math.round((Number(a) || 0) / 90) * 90;
  return ((a % 360) + 360) % 360;
}
/**
 * Screen-space tilt vector (x → right, y → down as the player sees the screen), |t| ≤ 1.
 * beta/gamma: DeviceOrientation degrees. angle: screen.orientation.angle (content rotation, counter-clockwise).
 * g0: calibration gravity vector (device frame) or null = flat on a table. maxDeg: tilt for full deflection.
 */
function tiltFromOrientation(beta, gamma, angle, g0, maxDeg, out) {
  out = out || { x: 0, y: 0 };
  const g = calibrateVec(gravityVec(beta, gamma, [0, 0, 0]), g0, [0, 0, 0]);
  const k = 1 / Math.sin((maxDeg || 22) * Math.PI / 180);
  const tx = g[0] * k, ty = -g[1] * k; // natural-portrait screen axes (top edge raised → things roll down → +y)
  const a = normAngle(angle) * Math.PI / 180;
  const ca = Math.round(Math.cos(a)), sa = Math.round(Math.sin(a));
  let x = tx * ca + ty * sa, y = -tx * sa + ty * ca;
  const m = Math.hypot(x, y);
  if (m > 1) { x /= m; y /= m; }
  out.x = x; out.y = y;
  return out;
}
// </tilt-math>
export { gravityVec, calibrateVec, normAngle, tiltFromOrientation };

// ---------------------------------------------------------------- storage
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const isTouch = (() => {
  try {
    if (matchMedia('(pointer: coarse)').matches) return true;
    return navigator.maxTouchPoints > 0 && (matchMedia('(hover: none)').matches || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
  } catch { return false; }
})();
const lowDefault = (() => { try { return localStorage.getItem('hathatul-gfx') === 'simple'; } catch { return false; } })();
const SET = Object.assign({
  sound: true, music: true, haptics: true, graphics: lowDefault ? 'low' : 'high',
  control: 'auto', // auto | tilt | pad | keys
  sens: 22,        // degrees of tilt for full deflection
  autoCal: true, setupDone: false,
}, store.get('flip-settings', {}));
const saveSet = () => store.set('flip-settings', SET);
const PROG = Object.assign({ levels: {}, hints: {}, last: null }, store.get('flip-progress', {}));
if (!PROG.levels || typeof PROG.levels !== 'object') PROG.levels = {};
const saveProg = () => store.set('flip-progress', PROG);
document.documentElement.dataset.gfx = SET.graphics === 'low' ? 'simple' : 'rich';

// ---------------------------------------------------------------- TiltSource
class TiltSource {
  constructor() {
    this.status = 'unknown'; // unknown | live | none | needs-permission | denied
    this.raw = [0, 0, -1];   // smoothed gravity (device frame)
    this.g0 = null;          // calibration
    this.angle = 0;
    this.sens = SET.sens;
    this.sensorOn = true;    // include sensor input in read()
    this.keys = { l: 0, r: 0, u: 0, d: 0 };
    this.strong = { l: false, r: false, u: false, d: false };
    this.lastTap = { l: 0, r: 0, u: 0, d: 0 };
    this.shift = false;
    this.pad = { x: 0, y: 0 };
    this.out = { x: 0, y: 0 };
    this.sm = { x: 0, y: 0 };
    this.tmp = { x: 0, y: 0 };
    this.lastEvt = 0; this.lastRead = 0; this.events = 0;
    this.listeners = new Set();
    this.onOrient = this.onOrient.bind(this);
    this.onKey = this.onKey.bind(this);
    this.onAngle = this.onAngle.bind(this);
  }
  get permissionApi() { return typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function'; }
  needsPermission() { return this.permissionApi && isTouch && this.status !== 'live' && this.status !== 'denied' && !this.granted; }
  start() {
    addEventListener('keydown', this.onKey);
    addEventListener('keyup', this.onKey);
    addEventListener('blur', () => this.clearKeys());
    try { screen.orientation && screen.orientation.addEventListener('change', this.onAngle); } catch {}
    addEventListener('orientationchange', this.onAngle);
    this.angle = this.readAngle();
    if (typeof DeviceOrientationEvent === 'undefined') { this.setStatus('none'); return; }
    // Browsers with requestPermission (iOS Safari, recent Chromium) may still deliver events without it
    // (Android Chrome does): listen anyway; the status flips to 'live' on the first real events.
    if (this.permissionApi && !this.granted) this.setStatus(isTouch ? 'needs-permission' : 'unknown');
    this.listen();
  }
  listen() {
    if (this.listening) return;
    this.listening = true;
    addEventListener('deviceorientation', this.onOrient);
    clearTimeout(this.detectT);
    this.detectT = setTimeout(() => {
      if (this.status === 'live' || this.status === 'denied') return;
      this.setStatus(this.permissionApi && !this.granted && isTouch ? 'needs-permission' : 'none');
    }, 1600);
  }
  /** Must be called from a user gesture (iOS). Resolves 'granted' | 'denied' | 'unsupported'. */
  requestPermission() {
    if (!this.permissionApi) { this.listen(); return Promise.resolve('unsupported'); }
    let p;
    try { p = DeviceOrientationEvent.requestPermission(); } catch (e) { p = Promise.reject(e); }
    return Promise.resolve(p).then((r) => {
      if (r === 'granted') {
        this.granted = true;
        if (this.status !== 'live') this.setStatus('unknown');
        this.listening = false; removeEventListener('deviceorientation', this.onOrient); this.listen();
      }
      else this.setStatus('denied');
      return r;
    }, () => { this.setStatus('denied'); return 'denied'; });
  }
  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    for (const f of this.listeners) try { f(s); } catch {}
  }
  readAngle() {
    try {
      if (screen.orientation && typeof screen.orientation.angle === 'number') return normAngle(screen.orientation.angle);
    } catch {}
    return normAngle(typeof window.orientation === 'number' ? window.orientation : 0);
  }
  onAngle() {
    const a = this.readAngle();
    if (a === this.angle) return;
    this.angle = a;
    if (this.angleCb) this.angleCb(a);
  }
  onOrient(e) {
    if (e.beta == null || e.gamma == null || Number.isNaN(e.beta)) return;
    const g = gravityVec(e.beta, e.gamma, this.tmpG || (this.tmpG = [0, 0, 0]));
    const now = performance.now();
    if (!this.events) { this.raw[0] = g[0]; this.raw[1] = g[1]; this.raw[2] = g[2]; }
    else {
      // low-pass on the gravity vector (time based, ~50 ms) – then renormalise
      const dt = Math.min(0.2, Math.max(0.001, (now - this.lastEvt) / 1000));
      const k = 1 - Math.exp(-dt / 0.05);
      for (let i = 0; i < 3; i++) this.raw[i] += (g[i] - this.raw[i]) * k;
      const m = Math.hypot(this.raw[0], this.raw[1], this.raw[2]) || 1;
      for (let i = 0; i < 3; i++) this.raw[i] /= m;
    }
    this.events++;
    this.lastEvt = now;
    // a single all-zero event is what some desktops send; require a couple of real ones
    if (this.status !== 'live' && this.events >= 2) { clearTimeout(this.detectT); this.setStatus('live'); if (!this.g0) this.calibrate(); }
    const a = this.readAngle();
    if (a !== this.angle) { this.angle = a; if (this.angleCb) this.angleCb(a); }
  }
  calibrate() { this.g0 = [this.raw[0], this.raw[1], this.raw[2]]; this.sm.x = this.sm.y = 0; }
  sensorTilt(out) {
    // tiltFromOrientation takes beta/gamma; we keep the smoothed vector instead, so inline the same math
    const g = calibrateVec(this.raw, this.g0, this.tmpC || (this.tmpC = [0, 0, 0]));
    const k = 1 / Math.sin(this.sens * Math.PI / 180);
    const tx = g[0] * k, ty = -g[1] * k;
    const a = this.angle * Math.PI / 180, ca = Math.round(Math.cos(a)), sa = Math.round(Math.sin(a));
    out.x = tx * ca + ty * sa; out.y = -tx * sa + ty * ca;
    return out;
  }
  // keyboard: arrows / WASD = walk (0.36); Shift+arrow or a quick double-tap = full tilt (gravity flip)
  onKey(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const map = { ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r', ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd' };
    this.shift = e.shiftKey;
    const k = map[e.code];
    if (!k) return;
    if (playing() && e.code.startsWith('Arrow')) e.preventDefault();
    if (e.type === 'keydown') {
      if (e.repeat) return;
      const now = performance.now();
      this.strong[k] = now - this.lastTap[k] < 280;
      this.lastTap[k] = now;
      this.keys[k] = 1;
    } else { this.keys[k] = 0; this.strong[k] = false; }
  }
  clearKeys() { for (const k in this.keys) { this.keys[k] = 0; this.strong[k] = false; } this.shift = false; }
  keyTilt(out) {
    const K = this.keys, S = this.strong, sh = this.shift;
    const m = (k) => (K[k] ? (sh || S[k] ? 1 : 0.36) : 0);
    out.x = m('r') - m('l'); out.y = m('d') - m('u');
    return out;
  }
  setPad(x, y) { this.pad.x = x; this.pad.y = y; }
  /** Called by the engine every frame. Returns the same object each time (no allocation). */
  read() {
    const o = this.out;
    let x = 0, y = 0;
    if (this.sensorOn && this.status === 'live') {
      const s = this.sensorTilt(this.tmp);
      // short extra smoothing in read() (sensor events can be 20–60 Hz)
      const now = performance.now();
      const dt = Math.min(0.1, Math.max(0.001, (now - (this.lastRead || now)) / 1000));
      this.lastRead = now;
      const k = 1 - Math.exp(-dt / 0.04);
      this.sm.x += (s.x - this.sm.x) * k; this.sm.y += (s.y - this.sm.y) * k;
      x += this.sm.x; y += this.sm.y;
    }
    const kt = this.keyTilt(this.tmp);
    x += kt.x + this.pad.x; y += kt.y + this.pad.y;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    o.x = x; o.y = y;
    return o;
  }
}
const tilt = new TiltSource();
tilt.start();

function controlMode() {
  const c = SET.control;
  if (c === 'keys') return 'keys';
  if (c === 'pad') return 'pad';
  if (c === 'tilt' && tilt.status !== 'none' && tilt.status !== 'denied') return 'tilt';
  if (tilt.status === 'live' || ((tilt.status === 'needs-permission' || tilt.status === 'unknown') && isTouch)) return 'tilt';
  return isTouch ? 'pad' : 'keys';
}
const syncSensorUse = () => { tilt.sensorOn = controlMode() === 'tilt'; tilt.sens = SET.sens; };

// ---------------------------------------------------------------- audio (menus; the engine has its own)
const A = (p) => M.BASE + p;
const sndPool = {};
function sfx(name, vol = 0.55) {
  if (!SET.sound || !M.SFX[name]) return;
  try {
    let base = sndPool[name];
    if (!base) { base = sndPool[name] = new Audio(A(M.SFX[name])); base.preload = 'auto'; }
    const a = base.paused && base.currentTime === 0 ? base : base.cloneNode();
    a.volume = vol; a.currentTime = 0;
    const p = a.play(); if (p) p.catch(() => {});
  } catch {}
}
function buzz(ms = 8) { if (SET.haptics && navigator.vibrate) try { navigator.vibrate(ms); } catch {} }
let menuMusic = null, userGestured = false;
function menuMusicWanted() { return SET.music && userGestured && !playing(); }
function syncMenuMusic() {
  try {
    if (menuMusicWanted()) {
      if (!menuMusic) { menuMusic = new Audio(A(M.MUSIC.menu)); menuMusic.loop = true; menuMusic.volume = 0.32; }
      if (menuMusic.paused) { const p = menuMusic.play(); if (p) p.catch(() => {}); }
    } else if (menuMusic && !menuMusic.paused) menuMusic.pause();
  } catch {}
}
addEventListener('pointerdown', () => { if (!userGestured) { userGestured = true; syncMenuMusic(); } }, { capture: true });
addEventListener('keydown', () => { if (!userGestured) { userGestured = true; syncMenuMusic(); } }, { capture: true });
document.addEventListener('visibilitychange', () => { if (document.hidden) { if (menuMusic) menuMusic.pause(); } else syncMenuMusic(); });

// ---------------------------------------------------------------- data helpers
const NEED = [0, 12, 30];
const allLevels = WORLDS.flatMap((w, wi) => w.levels.map((l, li) => ({ level: l, world: w, wi, li })));
const findLevel = (id) => allLevels.find(e => e.level.id === id);
const lp = (id) => PROG.levels[id] || {};
const starsOf = (p) => (p && p.done ? 1 + (p.allGems ? 1 : 0) + (p.fast ? 1 : 0) : 0);
const totalGems = () => allLevels.reduce((s, e) => s + Math.min(3, lp(e.level.id).gems || 0), 0);
const totalStars = () => allLevels.reduce((s, e) => s + starsOf(lp(e.level.id)), 0);
const worldNeed = (wi) => (WORLDS[wi].need != null ? WORLDS[wi].need : NEED[wi] != null ? NEED[wi] : wi * 15);
const worldOpen = (wi) => debugOn || totalGems() >= worldNeed(wi);
const levelOpen = (wi, li) => worldOpen(wi) && (debugOn || li === 0 || !!lp(WORLDS[wi].levels[li - 1].id).done);
const worldStats = (w) => w.levels.reduce((s, l) => { const p = lp(l.id); s.stars += starsOf(p); s.gems += Math.min(3, p.gems || 0); s.done += p.done ? 1 : 0; return s; }, { stars: 0, gems: 0, done: 0 });
const themeOf = (w) => (M.THEMES[w.theme] ? w.theme : 'grass');
function nextPlayable() {
  for (const e of allLevels) if (!lp(e.level.id).done && levelOpen(e.wi, e.li)) return e;
  return null;
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtTime(t) {
  if (t == null || !isFinite(t)) return '–';
  if (t < 60) return t.toFixed(1);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}
const GEM_IMG = { grass: M.UI.gemBlue, stone: M.UI.gemRed, sky: M.UI.gemYellow };
const gemImg = (theme) => A(GEM_IMG[theme] || M.UI.gem);
const img = (src, cls = '', alt = '') => `<img class="${cls}" src="${A(src)}" alt="${alt}" draggable="false">`;

// ---------------------------------------------------------------- routing
const $app = document.getElementById('app');
const $stage = document.getElementById('stage');
const $hud = document.getElementById('hud');
const $toast = document.getElementById('toast');
let route = { name: 'title' };
let play = null; // active level session (see startPlay)
const playing = () => !!(play && !play.ended);

function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [a, b] = h.split('/');
  if (a === 'worlds' || a === 'setup' || a === 'howto' || a === 'settings') return { name: a };
  if (a === 'w' && WORLDS[Number(b) - 1]) return { name: 'levels', wi: Number(b) - 1 };
  if (a === 'play' && findLevel(b)) return { name: 'play', id: b };
  return { name: 'title' };
}
const depth = () => (history.state && history.state.flipDepth) || 0;
const curHash = () => decodeURIComponent(location.hash.replace(/^#\/?/, ''));
function nav(hash, replace) {
  const st = history.state || {};
  const d = replace ? depth() : depth() + 1;
  const from = replace ? st.from : curHash();
  const url = `${location.pathname}${location.search}${hash ? '#' + hash : ''}`;
  history[replace ? 'replaceState' : 'pushState']({ flipDepth: d, from }, '', url);
  render();
}
/** Go "up" to a parent screen: a real history.back() when that is where we came from (keeps the
 *  browser / Android back button consistent), otherwise replace the current entry with the parent. */
function goUp(parent) {
  const st = history.state || {};
  if (depth() > 0 && st.from === parent) history.back(); else nav(parent, true);
}
function goBack(parent) {
  sfx('back', 0.5); buzz(6);
  goUp(parent);
}
addEventListener('popstate', render);
addEventListener('hashchange', () => { if (parseHash().name !== route.name || route.name === 'play') render(); });

function render() {
  const r = parseHash();
  if (route.name === 'play' && (r.name !== 'play' || r.id !== route.id)) stopPlay();
  if (r.name !== route.name) $toast.classList.remove('show');
  route = r;
  stopViz();
  document.body.dataset.screen = r.name;
  if (r.name !== 'play') {
    $app.hidden = false; $stage.hidden = true; $hud.hidden = true;
    document.getElementById('scenery').hidden = false;
  }
  const scr = SCREENS[r.name] || SCREENS.title;
  scr(r);
  syncMenuMusic();
  if (r.name !== 'play') {
    const f = $app.querySelector('[autofocus]');
    if (f && !isTouch) try { f.focus({ preventScroll: true }); } catch {}
    $app.scrollTop = 0;
  }
}
function setScenery(theme, mode) {
  document.body.dataset.theme = theme;
  document.body.dataset.scene = mode || 'idle';
}

// ---------------------------------------------------------------- shared bits
// UI glyphs as inline SVG (flat, tinted with the button colour) instead of system emoji, to match the Kenney art
const SVG = (body) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const SPK = '<path class="f" d="M3.5 9.2h3.8L12 5.3v13.4l-4.7-3.9H3.5z"/>';
const SLASH = '<path d="M4 4l16 16"/>';
const ICON = {
  soundOn: SVG(SPK + '<path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18 6.5a7.8 7.8 0 0 1 0 11"/>'),
  soundOff: SVG(SPK + '<path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>'),
  music: (on) => SVG('<path d="M9 17.5V6.2l10-2.2v11"/><circle class="f" cx="6.6" cy="17.6" r="2.6"/><circle class="f" cx="16.6" cy="15.2" r="2.6"/>' + (on ? '' : SLASH)),
  vib: (on) => SVG('<rect x="8" y="3.5" width="8" height="17" rx="2"/><path d="M4.5 8.5v7M19.5 8.5v7"/>' + (on ? '' : SLASH)),
  gear: SVG('<path d="M4 7h9M18 7h2M4 17h3M12 17h8"/><circle cx="15.5" cy="7" r="2.4"/><circle cx="9.5" cy="17" r="2.4"/>'),
  help: SVG('<circle cx="12" cy="12" r="9"/><path d="M9.4 9.4a2.7 2.7 0 1 1 3.8 2.5c-.8.4-1.2.9-1.2 1.7v.6"/><circle class="f" cx="12" cy="17.2" r="1.2"/>'),
};
const soundIco = () => SET.sound ? ICON.soundOn : ICON.soundOff;
const musicIco = () => `<span class="${SET.music ? '' : 'off'}">${ICON.music(SET.music)}</span>`;
const vibIco = () => `<span class="${SET.haptics ? '' : 'off'}">${ICON.vib(SET.haptics)}</span>`;
const backBtn = (label, parent) => `<button class="btn-back" data-act="back" data-parent="${parent}" aria-label="${label}"><span class="bb-arrow">→</span><span>${label}</span></button>`;
const audioBtns = () => `
  <button class="ibtn" data-act="tSound" aria-label="צלילים" title="צלילים" aria-pressed="${SET.sound}">${soundIco()}</button>
  <button class="ibtn" data-act="tMusic" aria-label="מוזיקה" title="מוזיקה" aria-pressed="${SET.music}">${musicIco()}</button>`;
const starRow = (n, cls = '') => `<span class="stars ${cls}">${[0, 1, 2].map(i => img(i < n ? M.UI.star : M.UI.starEmpty, i < n ? 'st on' : 'st')).join('')}</span>`;
function toast(msg, ms = 2600) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), ms);
}

// ---------------------------------------------------------------- screens
const SCREENS = {};

SCREENS.title = () => {
  setScenery('grass', 'run');
  const tg = totalGems(), ts = totalStars(), max = allLevels.length * 3;
  const nx = nextPlayable();
  const cont = PROG.last || (nx && nx.level.id !== '1-1' ? nx.level.id : null);
  const contE = cont && findLevel(cont);
  $app.innerHTML = `
  <section class="screen s-title">
    <header class="topbar">
      <a class="home-link" href="./${debugOn ? '?debug=1' : ''}">→ לכל המשחקים</a>
      <div class="tb-end">${audioBtns()}</div>
    </header>
    <div class="title-wrap">
      <div class="hero-stage" aria-hidden="true">
        <div class="hero-glow"></div>
        ${img(M.UI.gemBlue, 'fl f1')}${img(M.UI.gemRed, 'fl f2')}${img(M.UI.gemYellow, 'fl f3')}${img(M.UI.coin, 'fl f4 coin')}
        <div class="hero"><div class="hero-flip">${img(M.UI.char.front, 'hero-img')}</div></div>
        <div class="hero-shadow"></div>
      </div>
      <div class="title-col">
        <h1 class="logo" aria-label="עולם הפוך">
          <span class="lw lw1">${[...'עולם'].map((c, i) => `<i style="--i:${i}">${c}</i>`).join('')}</span>
          <span class="lw lw2"><span class="lw2-in">${[...'הפוך'].map((c, i) => `<i style="--i:${i + 4}">${c}</i>`).join('')}</span></span>
        </h1>
        <p class="tagline">הטו את הטלפון – והכבידה מתהפכת</p>
        <div class="menu">
          <button class="btn btn-play" data-act="play" autofocus>שחקו <span class="bp-ico">▶</span></button>
          ${contE && levelOpen(contE.wi, contE.li) ? `<button class="btn btn-cont" data-act="cont" data-id="${esc(cont)}">המשך: שלב ${esc(cont)} · ${esc(contE.level.name)}</button>` : ''}
          <div class="menu-row">
            <button class="btn btn-sec" data-act="go" data-to="howto">${ICON.help} איך משחקים</button>
            <button class="btn btn-sec" data-act="go" data-to="settings">${ICON.gear} הגדרות</button>
          </div>
        </div>
        <div class="totals">
          <span class="tot">${img(M.UI.gem, 'ti')}<span dir="ltr"><b>${tg}</b>/${max}</span></span>
          <span class="tot">${img(M.UI.star, 'ti')}<span dir="ltr"><b>${ts}</b>/${max}</span></span>
        </div>
        <div class="preload" hidden><div class="pl-bar"><i></i></div><span>טוען עולמות…</span></div>
      </div>
    </div>
    <p class="version">גרסה ${VERSION}${debugOn ? ' · debug' : ''}</p>
  </section>`;
  warmUp();
};

SCREENS.setup = () => {
  setScenery('grass', 'idle');
  const st = tilt.status, mode = controlMode();
  const fsOk = !!(document.documentElement.requestFullscreen && screen.orientation && screen.orientation.lock);
  let tiltCard;
  if (st === 'needs-permission') {
    tiltCard = `
      <div class="phone-demo" aria-hidden="true"><div class="pd-phone"><div class="pd-screen">${img(M.UI.char.front, 'pd-char')}</div></div></div>
      <h3>המשחק נשלט בהטיית הטלפון</h3>
      <p>כדי שזה יעבוד צריך לאשר גישה לחיישני התנועה.</p>
      <button class="btn btn-play" data-act="perm" autofocus>📱 אפשרו חיישני תנועה</button>`;
  } else if (st === 'denied') {
    tiltCard = `
      <h3>אין גישה לחיישני התנועה</h3>
      <p>אפשר לשחק עם כפתורים על המסך. כדי להפעיל הטיה: הגדרות ← Safari ← "תנועה וכיוון", ואז לרענן את הדף.</p>
      <button class="btn" data-act="perm">לנסות שוב</button>`;
  } else if (st === 'live') {
    tiltCard = `
      <h3>החיישנים עובדים ✓</h3>
      <p>החזיקו את הטלפון בתנוחה נוחה. הכדור מראה לאן אתם מטים – נסו!</p>
      ${vizHTML()}
      <p class="small">כשמתחילים שלב, התנוחה הנוכחית נקבעת כ"ישר". אפשר לכייל שוב בתפריט ההשהיה.</p>`;
  } else if (st === 'unknown') {
    tiltCard = `<h3>בודקים חיישנים…</h3><div class="spinner"></div>`;
  } else {
    tiltCard = isTouch ? `
      <h3>לא נמצאו חיישני תנועה</h3>
      <p>אין בעיה – תשחקו עם ג'ויסטיק על המסך: גררו מעט כדי ללכת, עד הקצה כדי להפוך את הכבידה, וכפתור לקפיצה.</p>
      ${padDemoHTML()}` : `
      <h3>משחקים במקלדת</h3>
      ${keysHTML()}
      <p class="small">בטלפון המשחק נשלט בהטיה – שווה לנסות!</p>`;
  }
  const rotateCard = (mode === 'tilt' && isTouch) || st === 'needs-permission' || st === 'live' ? `
    <div class="card card-rot">
      <div class="rot-demo" aria-hidden="true"><div class="rd-phone"><span class="rd-lock">🔒</span></div></div>
      <div>
        <h3>חשוב: נעלו את סיבוב המסך</h3>
        <p>כשמטים את הטלפון, המסך עלול להסתובב באמצע משחק. נעלו סיבוב (במרכז הבקרה / בהגדרות המהירות), באיזה כיוון שנוח לכם – לאורך או לרוחב.</p>
        ${fsOk ? '<button class="btn btn-sec" data-act="fs">⛶ מסך מלא + נעילה</button>' : ''}
      </div>
    </div>` : '';
  $app.innerHTML = `
  <section class="screen s-setup">
    <header class="topbar">${backBtn('חזרה', '')}<h2 class="tb-title">שליטה</h2><div class="tb-end"></div></header>
    <div class="setup-grid">
      <div class="card card-tilt">${tiltCard}</div>
      ${rotateCard}
    </div>
    <div class="setup-actions">
      <button class="btn btn-play" data-act="setupDone" ${st === 'needs-permission' ? '' : 'autofocus'}>יאללה, לשחק! ▶</button>
      ${isTouch && st !== 'none' ? `<button class="btn btn-link" data-act="usePad">${mode === 'pad' ? '✓ משחקים עם כפתורים על המסך' : 'אין חיישנים? שחקו עם כפתורים על המסך'}</button>` : ''}
    </div>
  </section>`;
  if (st === 'live') startViz();
};

SCREENS.worlds = () => {
  setScenery('grass', 'idle');
  const tg = totalGems();
  $app.innerHTML = `
  <section class="screen s-worlds">
    <header class="topbar">${backBtn('ראשי', '')}<h2 class="tb-title">בחרו עולם</h2>
      <div class="tb-end"><span class="pill">${img(M.UI.gem, 'ti')}<b>${tg}</b></span></div></header>
    <div class="worlds">
      ${WORLDS.map((w, wi) => {
        const open = worldOpen(wi), s = worldStats(w), th = themeOf(w), need = worldNeed(wi);
        return `<button class="world-card wc-${th} ${open ? '' : 'locked'}" data-act="${open ? 'world' : 'lockedWorld'}" data-wi="${wi}" style="--d:${wi * 90}ms">
          <span class="wc-art" style="background-image:url('${A(M.THEMES[th].thumb || M.UI.world[th])}')"></span>
          <span class="wc-num">${wi + 1}</span>
          <span class="wc-body">
            <b class="wc-name">${esc(w.name)}</b>
            ${open ? `<span class="wc-stats"><span>${img(M.UI.star, 'ti')}<bdi dir="ltr">${s.stars}/${w.levels.length * 3}</bdi></span><span>${img(GEM_IMG[th] || M.UI.gem, 'ti')}<bdi dir="ltr">${s.gems}/${w.levels.length * 3}</bdi></span></span>
              <span class="wc-bar"><i style="width:${Math.round(100 * s.done / w.levels.length)}%"></i></span>`
            : `<span class="wc-need">${img(M.UI.lockIcon, 'ti')} צריך ${need} ${img(M.UI.gem, 'ti')} <small>(יש ${tg})</small></span>
               <span class="wc-bar need"><i style="width:${Math.min(100, Math.round(100 * tg / need))}%"></i></span>`}
          </span>
          ${open ? '' : `<span class="wc-lock">${img(M.UI.lockIcon)}</span>`}
        </button>`;
      }).join('')}
    </div>
  </section>`;
};

SCREENS.levels = ({ wi }) => {
  if (!worldOpen(wi)) return nav('worlds', true);
  const w = WORLDS[wi], th = themeOf(w), s = worldStats(w);
  setScenery(th, 'idle');
  $app.innerHTML = `
  <section class="screen s-levels">
    <header class="topbar">${backBtn('עולמות', 'worlds')}<h2 class="tb-title">עולם ${wi + 1}: ${esc(w.name)}</h2>
      <div class="tb-end"><span class="pill">${img(M.UI.star, 'ti')}<bdi dir="ltr"><b>${s.stars}</b>/${w.levels.length * 3}</bdi></span></div></header>
    <div class="levels lv-${th}">
      ${w.levels.map((l, li) => {
        const open = levelOpen(wi, li), p = lp(l.id), st = starsOf(p);
        const cur = open && !p.done;
        return `<button class="lvl ${open ? '' : 'locked'} ${p.done ? 'done' : ''} ${cur ? 'current' : ''}" data-act="${open ? 'level' : 'lockedLevel'}" data-id="${esc(l.id)}" style="--d:${li * 35}ms" aria-label="שלב ${esc(l.id)} ${esc(l.name)}">
          ${open ? `<span class="lv-num">${li + 1}</span>
            <span class="lv-name">${esc(l.name)}</span>
            ${starRow(st, 'sm')}
            <span class="lv-best">${p.best != null ? '⏱ ' + fmtTime(p.best) : cur ? 'חדש!' : ''}</span>
            <span class="lv-gems">${[0, 1, 2].map(i => `<i class="${i < (p.gems || 0) ? 'on' : ''}"></i>`).join('')}</span>`
          : `${img(M.UI.lockIcon, 'lv-lock')}<span class="lv-num dim">${li + 1}</span>`}
        </button>`;
      }).join('')}
    </div>
    <p class="legend">${img(M.UI.star, 'ti')} סיום · ${img(M.UI.star, 'ti')} כל 3 היהלומים · ${img(M.UI.star, 'ti')} מהר מהזמן המטרה</p>
  </section>`;
};

SCREENS.howto = () => {
  setScenery('sky', 'idle');
  const kb = !isTouch;
  const steps = [
    { art: `<div class="ht-phone tiltL">${img(M.UI.char.walk, 'ht-c')}</div>`, h: 'הטו קצת – הולכים', p: kb ? 'במחשב: חיצים או WASD.' : 'הטיה עדינה ימינה או שמאלה מזיזה את הדמות לאורך הרצפה.' },
    { art: `<div class="ht-flip">${img(M.UI.char.idle, 'ht-c')}${img(M.UI.arrow, 'ht-arrow')}</div>`, h: 'הטו חזק – העולם מתהפך!', p: kb ? 'Shift + חץ (או לחיצה כפולה על חץ) הופכת את הכבידה לכיוון החץ.' : 'הטיה חזקה לכיוון כלשהו הופכת את הכבידה – הקירות והתקרה הופכים לרצפה.' },
    { art: `<div class="ht-jump">${img(M.UI.char.jump, 'ht-c')}</div>`, h: 'לחיצה על המסך – קפיצה', p: kb ? 'רווח / Z לקפיצה. לחיצה קצרה = קפיצה נמוכה.' : 'נגיעה בכל מקום על המסך. נגיעה ארוכה = קפיצה גבוהה יותר.' },
    { art: `<div class="ht-row">${img(M.UI.gemBlue)}${img(M.UI.gemRed)}${img(M.UI.gemYellow)}</div>`, h: '3 יהלומים בכל שלב', p: 'אספו את כולם לכוכב השני, וסיימו מהר מהזמן המטרה לכוכב השלישי. יהלומים פותחים עולמות חדשים.' },
    { art: `<div class="ht-row">${img(M.UI.spikes)}${img(M.UI.saw)}${img(M.UI.enemy.slime)}</div>`, h: 'זהירות!', p: 'קוצים ומסורים מסוכנים. על רירנים וזבובים אפשר לקפוץ מלמעלה – מלמעלה ביחס לכבידה!' },
    { art: `<div class="ht-row">${img(M.UI.key)}${img(M.UI.crate)}${img(M.UI.spring)}</div>`, h: 'מפתחות, ארגזים וקפיצים', p: 'מפתח פותח מנעולים. ארגזים נופלים לפי הכבידה – גם הם מתהפכים. קפיץ זורק אתכם רחוק.' },
    { art: `<div class="ht-door">${img(M.UI.door)}</div>`, h: 'הגיעו לדלת', p: 'הדלת נפתחת כשמתקרבים. בהצלחה!' },
  ];
  $app.innerHTML = `
  <section class="screen s-howto">
    <header class="topbar">${backBtn('חזרה', '')}<h2 class="tb-title">איך משחקים</h2><div class="tb-end"></div></header>
    <div class="howto">
      ${steps.map((s, i) => `<article class="ht-card" style="--d:${i * 60}ms"><div class="ht-art">${s.art}</div><div class="ht-txt"><h3><span class="ht-n">${i + 1}</span>${s.h}</h3><p>${s.p}</p></div></article>`).join('')}
      ${kb ? `<article class="ht-card ht-keys"><div class="ht-txt"><h3>מקלדת</h3>${keysHTML()}</div></article>` : ''}
    </div>
    <div class="setup-actions"><button class="btn btn-play" data-act="play">שחקו ▶</button></div>
  </section>`;
};

SCREENS.settings = () => {
  setScenery('stone', 'idle');
  const tog = (k, label, ico) => `<button class="set-row tog" data-act="set" data-k="${k}" role="switch" aria-checked="${!!SET[k]}"><span class="sr-ico">${ico}</span><span class="sr-l">${label}</span><span class="sw ${SET[k] ? 'on' : ''}"><i></i></span></button>`;
  const seg = (k, opts) => `<span class="seg">${opts.map(([v, l]) => `<button data-act="seg" data-k="${k}" data-v="${v}" class="${String(SET[k]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</span>`;
  const mode = controlMode();
  const modeName = { tilt: 'הטיה', pad: 'כפתורים על המסך', keys: 'מקלדת' }[mode];
  $app.innerHTML = `
  <section class="screen s-settings">
    <header class="topbar">${backBtn('חזרה', '')}<h2 class="tb-title">הגדרות</h2><div class="tb-end"></div></header>
    <div class="settings">
      <div class="card">
        ${tog('sound', 'צלילים', '🔊')}
        ${tog('music', 'מוזיקה', '🎵')}
        ${tog('haptics', 'רטט', '📳')}
        <div class="set-row"><span class="sr-ico">✨</span><span class="sr-l">גרפיקה</span>${seg('graphics', [['high', 'מלאה'], ['low', 'חסכונית']])}</div>
      </div>
      <div class="card">
        <div class="set-row col"><span class="sr-l"><span class="sr-ico">🎮</span> שליטה <small>(עכשיו: ${modeName})</small></span>
          ${seg('control', [['auto', 'אוטומטי'], ['tilt', 'הטיה'], ['pad', 'כפתורים'], ['keys', 'מקלדת']])}</div>
        <div class="set-row col"><span class="sr-l"><span class="sr-ico">📐</span> רגישות הטיה</span>
          ${seg('sens', [[32, 'עדינה'], [22, 'רגילה'], [15, 'חדה']])}</div>
        ${tog('autoCal', 'כיול אוטומטי בתחילת שלב', '🎯')}
        ${tilt.status === 'live' ? `<div class="set-row col cal-row">${vizHTML()}<button class="btn btn-sec" data-act="calibrate">🎯 כיול עכשיו</button></div>`
          : tilt.status === 'needs-permission' || tilt.status === 'denied' ? '<div class="set-row"><button class="btn btn-sec" data-act="perm">📱 אפשרו חיישני תנועה</button></div>'
          : `<p class="small">${tilt.status === 'unknown' ? 'בודקים חיישנים…' : 'לא נמצאו חיישני תנועה במכשיר הזה.'}</p>`}
        <button class="set-row" data-act="go" data-to="setup"><span class="sr-ico">🔒</span><span class="sr-l">נעילת סיבוב ובדיקת חיישנים</span><span class="chev">‹</span></button>
      </div>
      <div class="card">
        <button class="set-row danger" data-act="reset"><span class="sr-ico">🗑️</span><span class="sr-l">איפוס התקדמות</span></button>
        <a class="set-row" href="${A(M.CREDITS || 'CREDITS.txt')}" target="_blank" rel="noopener"><span class="sr-ico">🎨</span><span class="sr-l">קרדיטים: גרפיקה וצלילים Kenney (CC0), מוזיקה OpenGameArt (CC0)</span></a>
      </div>
      <p class="version">גרסה ${VERSION}</p>
    </div>
  </section>`;
  if (tilt.status === 'live') startViz();
};

SCREENS.play = ({ id }) => startPlay(id);

// ---------------------------------------------------------------- small widgets
function vizHTML() {
  return `<div class="tiltviz" aria-hidden="true"><div class="tv-ring"></div><div class="tv-ring in"></div><div class="tv-cross"></div><div class="tv-ball"></div></div>`;
}
function padDemoHTML() {
  return `<div class="pad-demo" aria-hidden="true"><div class="pdj"><i></i></div><div class="pdb">⤒</div></div>`;
}
function keysHTML() {
  return `<div class="keys">
    <div class="kline"><span class="kc">←</span><span class="kc">→</span><span class="kc">↑</span><span class="kc">↓</span><span>הליכה (גם WASD)</span></div>
    <div class="kline"><span class="kc w">Shift</span>+<span class="kc">חץ</span><span>הפיכת כבידה (או לחיצה כפולה על חץ)</span></div>
    <div class="kline"><span class="kc w">רווח</span><span class="kc">Z</span><span>קפיצה</span></div>
    <div class="kline"><span class="kc">Esc</span><span class="kc">P</span><span>השהיה</span></div>
  </div>`;
}
let vizRaf = 0;
function startViz() {
  stopViz();
  const loop = () => {
    const balls = document.querySelectorAll('.tv-ball');
    if (!balls.length) { vizRaf = 0; return; }
    const v = tilt.read();
    const m = Math.hypot(v.x, v.y);
    balls.forEach(b => {
      b.style.transform = `translate(${(v.x * 42).toFixed(1)}px, ${(v.y * 42).toFixed(1)}px)`;
      b.classList.toggle('flip', m > 0.45);
    });
    vizRaf = requestAnimationFrame(loop);
  };
  vizRaf = requestAnimationFrame(loop);
}
function stopViz() { if (vizRaf) cancelAnimationFrame(vizRaf); vizRaf = 0; }

// ---------------------------------------------------------------- preload (warm-up while on the title)
let warm = null, warmP = 0;
function whenPhaser() {
  if (window.Phaser) return Promise.resolve(true);
  if (whenPhaser.p) return whenPhaser.p;
  whenPhaser.p = new Promise((res) => {
    const iv = setInterval(() => { if (window.Phaser) { clearInterval(iv); res(true); } }, 60);
    const fallback = () => {
      if (window.Phaser || fallback.done) return; fallback.done = true;
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser.min.js';
      s.onerror = () => { clearInterval(iv); res(false); };
      document.head.appendChild(s);
    };
    const tag = document.getElementById('phaser-js');
    if (tag) tag.addEventListener('error', fallback);
    setTimeout(fallback, 12000);
    setTimeout(() => { clearInterval(iv); res(!!window.Phaser); }, 30000);
  });
  return whenPhaser.p;
}
function warmUp() {
  if (warm) { showWarm(); return warm; }
  warm = whenPhaser().then((ok) => {
    if (!ok) throw new Error('phaser');
    return preloadAll((p) => { warmP = p; showWarm(); });
  }).then(() => { warmP = 1; showWarm(); }, (e) => { console.warn('flip: preload failed', e); warmP = -1; showWarm(); });
  return warm;
}
function showWarm() {
  const el = $app.querySelector('.preload');
  if (!el) return;
  el.hidden = warmP >= 1 || warmP < 0 ? true : false;
  const i = el.querySelector('i'); if (i) i.style.width = `${Math.round(Math.max(0.04, warmP) * 100)}%`;
}

// ---------------------------------------------------------------- play
function startPlay(id) {
  const e = findLevel(id);
  if (!e) return nav('worlds', true);
  if (!levelOpen(e.wi, e.li)) { toast('השלב עוד נעול'); return nav(`w/${e.wi + 1}`, true); }
  if (play && !play.ended && play.id === id) return; // already running
  if (play) stopPlay(true);
  syncSensorUse();
  const mode = controlMode();
  // touch device whose sensors are not delivering yet: show the on-screen pad too, so it is never uncontrollable
  const showPad = mode === 'pad' || (isTouch && mode === 'tilt' && tilt.status !== 'live');
  const th = themeOf(e.world);
  PROG.last = id; saveProg();
  play = { id, e, mode, handle: null, deaths: 0, gems: 0, ended: false, paused: false, overlay: null, ready: false };
  $app.hidden = true; $app.innerHTML = '';
  document.getElementById('scenery').hidden = true;
  $stage.hidden = false; $hud.hidden = false;
  document.body.dataset.theme = th;
  $hud.className = `hud mode-${mode}${showPad ? ' mode-pad' : ''}`;
  $hud.innerHTML = `
    <div class="hud-tl">
      <button class="hbtn" data-act="pause" aria-label="השהיה" title="השהיה (Esc)"><span class="pz"><i></i><i></i></span></button>
      ${e.level.hint ? '<button class="hbtn sm" data-act="hint" aria-label="רמז" title="רמז">?</button>' : ''}
      <span class="deaths" hidden><span class="sk">💀</span><b>0</b></span>
    </div>
    <div class="veil"><div class="veil-card">${img(M.UI.char.front, 'veil-char')}<div class="pl-bar"><i></i></div><span>טוען…</span></div></div>
    <div class="intro" hidden><span class="in-id">${esc(e.level.id)}</span><b>${esc(e.level.name)}</b></div>
    <div class="hint" hidden role="status"><span class="hint-ico">💡</span><span class="hint-txt">${esc(e.level.hint || '')}</span></div>
    ${mode === 'keys' ? `<div class="kchip" hidden><span class="kc">←→↑↓</span> הליכה · <span class="kc w">Shift</span>+חץ היפוך · <span class="kc w">רווח</span> קפיצה</div>` : ''}
    ${showPad ? `<div class="tpad" aria-hidden="true"><div class="tp-base"><div class="tp-flip"></div><div class="tp-walk"></div>
        <span class="tp-a u">▲</span><span class="tp-a d">▼</span><span class="tp-a l">◀</span><span class="tp-a r">▶</span><div class="tp-knob"></div></div></div>
      <button class="tjump" aria-label="קפיצה">⤒</button>` : ''}
    <div class="ovl" hidden></div>`;
  if (showPad) bindPad();
  const go = () => {
    if (!play || play.id !== id || play.ended) return;
    const S = play;
    S.handle = startLevel($stage, e.level, th, {
      sensors: tilt, sound: SET.sound, music: SET.music, get haptics() { return SET.haptics; }, graphics: SET.graphics, hud: true, insets: padInsets(),
      onWin: (r) => onWin(S, r), onDeath: (n) => onDeath(S, n), onPause: () => { if (play === S && !S.overlay) showPause(); },
      onGems: (n) => { S.gems = n; },
    });
    const t0 = performance.now();
    const waitReady = () => {
      if (play !== S || S.ended) return;
      const st = S.handle.state;
      if (st && st !== 'loading') return onReady(S);
      if (performance.now() - t0 > 25000) { setVeil('הטעינה נכשלה. בדקו את החיבור ונסו שוב.'); return; }
      requestAnimationFrame(waitReady);
    };
    requestAnimationFrame(waitReady);
  };
  setVeil(null, 0.05);
  // Wait for the warm-up (so two loaders never race), then start.
  whenPhaser().then((ok) => {
    if (!ok) { setVeil('לא הצלחנו לטעון את מנוע המשחק. בדקו את החיבור לאינטרנט ונסו שוב.'); return; }
    const w = warm || warmUp();
    const iv = setInterval(() => setVeil(null, Math.max(0.05, warmP)), 100);
    w.then(() => { clearInterval(iv); go(); });
  });
}
// screen area covered by the on-screen pad / jump button → the engine lets the camera scroll past the level edge by that much
// + the top HUD row (pause button) and the device safe areas (notch / status bar: the engine shifts its in-canvas HUD by them)
let saProbe = null;
function safeAreas() {
  try {
    if (!saProbe) {
      saProbe = document.createElement('div');
      saProbe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
      document.body.appendChild(saProbe);
    }
    const cs = getComputedStyle(saProbe);
    return { safeTop: parseFloat(cs.paddingTop) || 0, safeRight: parseFloat(cs.paddingRight) || 0, safeBottom: parseFloat(cs.paddingBottom) || 0, safeLeft: parseFloat(cs.paddingLeft) || 0 };
  } catch { return { safeTop: 0, safeRight: 0, safeBottom: 0, safeLeft: 0 }; }
}
function padInsets() {
  const sa = safeAreas();
  const o = { ...sa, top: 58 + sa.safeTop, bottom: 0, left: 0, right: 0 };
  const pad = $hud.querySelector('.tpad');
  if (!pad) return o;
  const jb = $hud.querySelector('.tjump');
  const W = innerWidth, H = innerHeight, r = pad.getBoundingClientRect(), j = jb ? jb.getBoundingClientRect() : null;
  if (H >= W) o.bottom = Math.max(0, H - Math.min(r.top, j ? j.top : H)) + 8;
  else { o.left = r.right + 8; o.right = j ? Math.max(0, W - j.left) + 8 : 0; }
  return o;
}
const syncInsets = () => { if (play && play.handle && play.handle.setInsets) play.handle.setInsets(padInsets()); };
addEventListener('resize', syncInsets);
addEventListener('orientationchange', () => setTimeout(syncInsets, 250));
function setVeil(msg, p) {
  const v = $hud.querySelector('.veil'); if (!v) return;
  if (msg) {
    v.querySelector('span').textContent = msg;
    if (!v.querySelector('.btn')) v.querySelector('.veil-card').insertAdjacentHTML('beforeend', `<div class="veil-btns"><button class="btn" data-act="retry">נסו שוב</button><button class="btn btn-sec" data-act="toLevels">לשלבים</button></div>`);
  }
  if (p != null) { const i = v.querySelector('i'); if (i) i.style.width = `${Math.round(p * 100)}%`; }
}
function onReady(S) {
  S.ready = true;
  if (S.mode === 'tilt' && SET.autoCal && tilt.status === 'live') tilt.calibrate();
  const v = $hud.querySelector('.veil'); if (v) { v.classList.add('gone'); setTimeout(() => v.remove(), 500); }
  const intro = $hud.querySelector('.intro');
  if (intro) { intro.hidden = false; setTimeout(() => { intro.classList.add('out'); }, 1700); setTimeout(() => { intro.hidden = true; }, 2300); }
  const kc = $hud.querySelector('.kchip');
  if (kc && (S.e.wi === 0 && S.e.li < 3)) { kc.hidden = false; setTimeout(() => kc.classList.add('out'), 7000); }
  const done = !!lp(S.id).done;
  if (S.e.level.hint && !done) setTimeout(() => { if (play === S && !S.overlay) showHint(); }, 2100);
}
function showHint(ms = 6500) {
  const h = $hud.querySelector('.hint'); if (!h) return;
  h.hidden = false; h.classList.remove('out');
  clearTimeout(showHint.t);
  showHint.t = setTimeout(() => { h.classList.add('out'); setTimeout(() => { h.hidden = true; }, 400); }, ms);
}
function onDeath(S, n) {
  if (play !== S) return;
  S.deaths = n;
  const d = $hud.querySelector('.deaths');
  if (d) { d.hidden = false; d.querySelector('b').textContent = n; d.classList.remove('bump'); void d.offsetWidth; d.classList.add('bump'); }
}
function stopPlay(replacing) {
  if (!play) return;
  const S = play;
  S.ended = true;
  try { S.handle && S.handle.destroy(); } catch (e) { console.warn(e); }
  tilt.setPad(0, 0);
  play = null;
  if (!replacing) { $stage.hidden = true; $hud.hidden = true; $hud.innerHTML = ''; }
}

// in-level overlays
function openOverlay(html, cls) {
  const o = $hud.querySelector('.ovl'); if (!o) return null;
  o.className = `ovl ${cls}`; o.innerHTML = html; o.hidden = false;
  const h = $hud.querySelector('.hint'); if (h) h.hidden = true;
  play.overlay = cls;
  const f = o.querySelector('[autofocus]'); if (f) try { f.focus({ preventScroll: true }); } catch {}
  return o;
}
function closeOverlay() {
  const o = $hud.querySelector('.ovl'); if (o) { o.hidden = true; o.innerHTML = ''; }
  if (play) play.overlay = null;
}
function showPause() {
  if (!play || play.ended) return;
  const S = play;
  try { S.handle && S.handle.pause(); } catch {}
  S.paused = true;
  const live = tilt.status === 'live' && S.mode === 'tilt';
  openOverlay(`
    <div class="panel pause-panel">
      <div class="pp-head"><span class="in-id">${esc(S.e.level.id)}</span><h2>${esc(S.e.level.name)}</h2></div>
      <div class="pp-btns">
        <button class="btn btn-play" data-act="resume" autofocus>▶ המשך</button>
        <button class="btn btn-sec" data-act="restart">↻ התחלה מחדש</button>
        ${live ? '<button class="btn btn-sec" data-act="recal">🎯 כיול – החזיקו ישר ולחצו</button>' : ''}
        ${S.e.level.hint ? '<button class="btn btn-sec" data-act="hintP">💡 רמז</button>' : ''}
        ${tilt.needsPermission() && SET.control !== 'pad' && SET.control !== 'keys' ? '<button class="btn btn-sec" data-act="permPlay">📱 אפשרו חיישני תנועה</button>' : ''}
        <button class="btn btn-sec" data-act="toLevels">☰ לשלבים</button>
      </div>
      <div class="pp-toggles">
        <button class="ibtn" data-act="tSound" aria-pressed="${SET.sound}" title="צלילים">${soundIco()}</button>
        <button class="ibtn" data-act="tMusic" aria-pressed="${SET.music}" title="מוזיקה">${musicIco()}</button>
        <button class="ibtn" data-act="tHaptics" aria-pressed="${SET.haptics}" title="רטט">${vibIco()}</button>
      </div>
    </div>`, 'pause');
}
function resumePlay() {
  if (!play) return;
  closeOverlay();
  play.paused = false;
  try { play.handle && play.handle.resume(); } catch {}
}
function onWin(S, r) {
  if (play !== S) return;
  const { level, wi, li, world } = S.e;
  const wasOpen = WORLDS.map((_, i) => worldOpen(i));
  const before = lp(level.id);
  const allGems = (r.gems || 0) >= 3, fast = r.time <= level.par;
  const newBest = before.best == null || r.time < before.best;
  const np = {
    done: true, best: newBest ? r.time : before.best, gems: Math.max(before.gems || 0, r.gems || 0),
    coins: Math.max(before.coins || 0, r.coins || 0), allGems: !!(before.allGems || allGems), fast: !!(before.fast || fast),
    plays: (before.plays || 0) + 1,
  };
  PROG.levels[level.id] = np;
  const nextE = allLevels[allLevels.indexOf(S.e) + 1];
  PROG.last = nextE ? nextE.level.id : null;
  saveProg();
  const runStars = 1 + (allGems ? 1 : 0) + (fast ? 1 : 0);
  const unlocked = WORLDS.map((w, i) => (!wasOpen[i] && worldOpen(i) ? w : null)).filter(Boolean);
  let nextBtn = '';
  if (nextE && levelOpen(nextE.wi, nextE.li)) nextBtn = `<button class="btn btn-play" data-act="next" data-id="${esc(nextE.level.id)}" autofocus>${nextE.wi !== wi ? `לעולם ${nextE.wi + 1} ▶` : 'לשלב הבא ▶'}</button>`;
  const needMsg = nextE && !levelOpen(nextE.wi, nextE.li) && nextE.wi !== wi
    ? `<p class="win-need">${img(M.UI.lockIcon, 'ti')} עולם ${nextE.wi + 1} נפתח ב-${worldNeed(nextE.wi)} ${img(M.UI.gem, 'ti')} (יש ${totalGems()}). חזרו לשלבים ואספו עוד יהלומים!</p>` : '';
  const finale = !nextE ? '<p class="win-need">🏆 סיימתם את כל העולמות! נסו להשיג 3 כוכבים בכל שלב.</p>' : '';
  const labels = ['סיום', 'כל היהלומים', `מתחת ל-${level.par} ש׳`];
  const got = [true, allGems, fast];
  openOverlay(`
    <div class="panel win-panel">
      <div class="win-rays" aria-hidden="true"></div>
      <h2 class="win-title">${runStars === 3 ? 'מושלם!' : runStars === 2 ? 'כל הכבוד!' : 'עברתם!'}</h2>
      <div class="win-stars">${labels.map((l, i) => `<div class="ws ${got[i] ? 'got' : ''}" style="--i:${i}">${img(got[i] ? M.UI.star : M.UI.starEmpty, 'ws-img')}<small>${l}</small></div>`).join('')}</div>
      <div class="win-stats">
        <div class="wst ${newBest ? 'rec' : ''}"><small>זמן</small><b>${fmtTime(r.time)}</b>${newBest && before.best != null ? '<em>שיא חדש!</em>' : `<em class="dim">שיא ${fmtTime(np.best)}</em>`}</div>
        <div class="wst"><small>יהלומים</small><b>${r.gems || 0}/3</b></div>
        <div class="wst"><small>מטבעות</small><b>${r.coins || 0}${r.coinsTotal ? '/' + r.coinsTotal : ''}</b></div>
        <div class="wst"><small>נפילות</small><b>${r.deaths || 0}</b></div>
      </div>
      ${unlocked.map(w => `<p class="win-unlock">🎉 נפתח עולם חדש: <b>${esc(w.name)}</b>!</p>`).join('')}
      ${needMsg}${finale}
      <div class="pp-btns row">
        ${nextBtn}
        <button class="btn btn-sec" data-act="restart">↻ שוב</button>
        <button class="btn btn-sec" data-act="toLevels">☰ שלבים</button>
      </div>
    </div>`, 'win');
  got.forEach((g, i) => setTimeout(() => { if (play === S && g) { sfx('star', 0.6); buzz(15); } }, 450 + i * 380));
}

// on-screen joystick (touch devices without sensors / chosen in settings)
function bindPad() {
  const base = $hud.querySelector('.tp-base'), knob = $hud.querySelector('.tp-knob'), jb = $hud.querySelector('.tjump');
  let id = null, cx = 0, cy = 0, R = 60;
  const set = (px, py) => {
    let dx = px - cx, dy = py - cy;
    const d = Math.hypot(dx, dy), m = Math.min(1, d / R);
    if (d > R) { dx = dx / d * R; dy = dy / d * R; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const flip = m > 0.82;
    base.classList.toggle('flipping', flip);
    const out = flip ? 1 : (m < 0.12 ? 0 : 0.42 * Math.min(1, m / 0.7)); // inner = walk (≤0.42), outer ring = flip
    tilt.setPad(d ? dx / Math.max(1, Math.hypot(dx, dy)) * out : 0, d ? dy / Math.max(1, Math.hypot(dx, dy)) * out : 0);
  };
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null; knob.style.transform = ''; base.classList.remove('flipping', 'active'); tilt.setPad(0, 0);
  };
  base.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    id = e.pointerId; try { base.setPointerCapture(id); } catch {}
    const r = base.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; R = r.width * 0.38;
    base.classList.add('active'); set(e.clientX, e.clientY);
  });
  base.addEventListener('pointermove', (e) => { if (e.pointerId === id) set(e.clientX, e.clientY); });
  base.addEventListener('pointerup', end); base.addEventListener('pointercancel', end); base.addEventListener('lostpointercapture', end);
  if (jb) {
    jb.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); jb.classList.add('down'); try { jb.setPointerCapture(e.pointerId); } catch {} play && play.handle && play.handle.jump(true); });
    const up = () => { jb.classList.remove('down'); play && play.handle && play.handle.jump(false); };
    jb.addEventListener('pointerup', up); jb.addEventListener('pointercancel', up);
  }
}

// rotation during play → recalibrate + remind to lock rotation
tilt.angleCb = () => {
  if (playing() && play.mode === 'tilt' && tilt.status === 'live') {
    toast('🔒 המסך הסתובב – כדאי לנעול סיבוב מסך. כיילנו מחדש.', 3500);
    setTimeout(() => tilt.calibrate(), 450);
  }
};

// ---------------------------------------------------------------- actions
const ACTIONS = {
  back: (el) => goBack(el.dataset.parent || ''),
  go: (el) => nav(el.dataset.to),
  play: () => {
    // iOS: the permission request must happen synchronously inside the tap
    const p = tilt.needsPermission() && SET.control !== 'pad' && SET.control !== 'keys' && SET.setupDone ? tilt.requestPermission() : null;
    if (!SET.setupDone) return nav('setup');
    if (p) p.then((r) => { if (r === 'denied' && isTouch) toast('אין גישה לחיישנים – משחקים עם כפתורים על המסך'); });
    nav('worlds');
  },
  cont: (el) => { if (tilt.needsPermission() && SET.control === 'auto') tilt.requestPermission(); nav(`play/${el.dataset.id}`); },
  // pause menu (iOS after a reload / deep link): ask for the sensors, then restart the level so the HUD drops the pad
  permPlay: () => tilt.requestPermission().then((r) => {
    if (r !== 'granted') { toast('אין גישה לחיישנים – משחקים עם כפתורים על המסך'); return; }
    const t0 = performance.now();
    const wait = () => {
      if (!play || play.ended) return;
      if (tilt.status === 'live') { const id = play.id; stopPlay(); nav(`play/${id}`, true); toast('החיישנים פועלים – הטו כדי לשחק!'); return; }
      if (performance.now() - t0 > 2000) { toast('החיישנים לא מגיבים – נסו לרענן את הדף'); return; }
      setTimeout(wait, 100);
    };
    wait();
  }),
  perm: () => tilt.requestPermission().then(() => { if (route.name === 'setup' || route.name === 'settings') render(); }),
  usePad: () => { SET.control = SET.control === 'pad' ? 'auto' : 'pad'; saveSet(); syncSensorUse(); render(); },
  setupDone: () => {
    if (tilt.needsPermission() && SET.control === 'auto') tilt.requestPermission();
    if (tilt.status === 'live') tilt.calibrate();
    SET.setupDone = true; saveSet();
    nav('worlds', true);
  },
  fs: () => {
    const el = document.documentElement;
    const lock = () => { try { const t = screen.orientation.type; screen.orientation.lock(t).then(() => toast('🔒 הסיבוב ננעל'), () => toast('לא ניתן לנעול כאן – נעלו סיבוב בהגדרות הטלפון')); } catch {} };
    try { const r = el.requestFullscreen({ navigationUI: 'hide' }); if (r && r.then) r.then(lock, () => toast('מסך מלא לא זמין כאן')); else lock(); } catch { toast('מסך מלא לא זמין כאן'); }
  },
  world: (el) => nav(`w/${Number(el.dataset.wi) + 1}`),
  lockedWorld: (el) => { const wi = Number(el.dataset.wi); buzz(30); toast(`צריך ${worldNeed(wi)} יהלומים כדי לפתוח (יש ${totalGems()})`); el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); },
  level: (el) => nav(`play/${el.dataset.id}`),
  lockedLevel: (el) => { buzz(30); toast('סיימו את השלב הקודם כדי לפתוח'); el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); },
  tSound: () => { SET.sound = !SET.sound; saveSet(); if (play && play.handle) play.handle.setSound(SET.sound); refreshToggles(); },
  tMusic: () => { SET.music = !SET.music; saveSet(); if (play && play.handle) play.handle.setMusic(SET.music); syncMenuMusic(); refreshToggles(); },
  tHaptics: () => { SET.haptics = !SET.haptics; saveSet(); buzz(20); refreshToggles(); },
  set: (el) => {
    const k = el.dataset.k; SET[k] = !SET[k]; saveSet();
    if (k === 'music') syncMenuMusic();
    if (k === 'haptics') buzz(20);
    el.setAttribute('aria-checked', String(!!SET[k])); el.querySelector('.sw').classList.toggle('on', !!SET[k]);
  },
  seg: (el) => {
    const k = el.dataset.k; let v = el.dataset.v; if (k === 'sens') v = Number(v);
    SET[k] = v; saveSet();
    if (k === 'graphics') document.documentElement.dataset.gfx = v === 'low' ? 'simple' : 'rich';
    if (k === 'control' && v === 'tilt' && tilt.needsPermission()) tilt.requestPermission().then(() => render());
    syncSensorUse(); render();
  },
  calibrate: () => { tilt.calibrate(); toast('🎯 כויל! התנוחה הזו היא עכשיו "ישר"'); },
  reset: (el) => {
    if (!el.classList.contains('confirm')) { el.classList.add('confirm'); el.querySelector('.sr-l').textContent = 'בטוחים? לחצו שוב למחיקת כל ההתקדמות'; return; }
    PROG.levels = {}; PROG.hints = {}; PROG.last = null; saveProg(); toast('ההתקדמות אופסה'); render();
  },
  // in level
  pause: () => showPause(),
  resume: () => resumePlay(),
  restart: () => { if (!play) return; closeOverlay(); play.paused = false; play.deaths = 0; const d = $hud.querySelector('.deaths'); if (d) d.hidden = true; try { play.handle.restart(); play.handle.resume(); } catch {} if (play.mode === 'tilt' && SET.autoCal && tilt.status === 'live') tilt.calibrate(); },
  recal: () => { tilt.calibrate(); toast('🎯 כויל!'); resumePlay(); },
  hint: () => showHint(),
  hintP: () => { resumePlay(); showHint(); },
  toLevels: () => { const wi = play ? play.e.wi : 0; stopPlay(); goUp(`w/${wi + 1}`); },
  next: (el) => nav(`play/${el.dataset.id}`, true),
  retry: () => { const id = play && play.id; stopPlay(); if (id) { warm = null; nav(`play/${id}`, true); } },
};
function refreshToggles() {
  document.querySelectorAll('[data-act="tSound"]').forEach(b => { b.innerHTML = soundIco(); b.setAttribute('aria-pressed', SET.sound); });
  document.querySelectorAll('[data-act="tMusic"]').forEach(b => { b.innerHTML = musicIco(); b.setAttribute('aria-pressed', SET.music); });
  document.querySelectorAll('[data-act="tHaptics"]').forEach(b => { b.innerHTML = vibIco(); b.setAttribute('aria-pressed', SET.haptics); });
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const f = ACTIONS[el.dataset.act];
  if (!f) return;
  e.preventDefault();
  // iOS motion permission is per page load and must be requested inside a tap: ask on the taps that lead into play
  // (after a reload or a deep link to #w/<n> or #play/<id> the 'play'/'cont' buttons were never pressed)
  if (SET.setupDone && SET.control !== 'pad' && SET.control !== 'keys' && tilt.needsPermission()
    && /^(level|next|world|restart|resume|retry)$/.test(el.dataset.act)) {
    tilt.requestPermission();
  }
  if (el.dataset.act !== 'back' && el.dataset.act !== 'lockedWorld' && el.dataset.act !== 'lockedLevel') { sfx(el.dataset.act === 'play' || el.dataset.act === 'level' ? 'select' : 'click', 0.5); buzz(6); }
  f(el);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (playing()) { if (play.overlay === 'pause') { e.preventDefault(); resumePlay(); } return; }
  const b = $app.querySelector('[data-act="back"]');
  if (b) { e.preventDefault(); b.click(); }
});
// the hint bubble closes on tap
$hud.addEventListener('pointerdown', (e) => { const h = e.target.closest('.hint'); if (h) { h.classList.add('out'); setTimeout(() => { h.hidden = true; }, 300); } });

// ---------------------------------------------------------------- boot
tilt.listeners.add(() => { if (route.name === 'setup' || route.name === 'settings') render(); });
if (!history.state || history.state.flipDepth == null) history.replaceState({ flipDepth: 0 }, '', location.href);
render();
if (debugOn) {
  window.__flipUI = { tilt, tiltFromOrientation, controlMode, SET, PROG, nav, get play() { return play; }, get route() { return route; }, totalGems, worldOpen, levelOpen };
}
