// "ניצנוץ" – talking unicorn: shell / UI [SHELL]
// Screens: start (unlocks audio + asks for the mic) → main view (full-screen scene, bars, sheets).
// Wires unicorn-scene.js (rendering) and unicorn-voice.js (mic → funny voice), plays the SFX, records clips.
import { createVoice, pickRecorderMime } from './unicorn-voice.js?v=55';

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

// ---------------------------------------------------------------- config
const ASSETS = 'unicorn/';
const SFX_NAMES = ['giggle', 'pop', 'sparkle', 'munch', 'bonk', 'snore'];
const SFX_EXT = ['mp3', 'ogg', 'wav'];       // first one that loads wins
const MUSIC_FILES = ['music/loop2.mp3', 'music/loop.mp3', 'music.mp3'];
const SLEEP_AFTER_MS = 40000;
const CLIP_MAX_MS = 15000;
const DOUBLE_TAP_MS = 320;
const SWIPE_PX = 70;
const HEART_MAX = 5;

// ---------------------------------------------------------------- storage / settings
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const SET = {
  sound: store.get('uni-sound') !== 'off',
  music: store.get('uni-music') === 'on',
  quality: store.get('uni-quality') || (matchMedia('(pointer: coarse)').matches && (navigator.hardwareConcurrency || 4) <= 4 ? 'low' : 'high'),
  style: store.get('uni-style') || 'classic',
};
const saveSet = () => {
  store.set('uni-sound', SET.sound ? 'on' : 'off'); store.set('uni-music', SET.music ? 'on' : 'off');
  store.set('uni-quality', SET.quality); store.set('uni-style', SET.style);
};

// ---------------------------------------------------------------- dom
const $ = (s) => document.querySelector(s);
const $stage = $('#stage'), $start = $('#start'), $go = $('#go'), $loading = $('#loading');
const $top = $('#top'), $bar = $('#bar'), $status = $('#status'), $hearts = $('#hearts');
const $mic = $('#btn-mic'), $feed = $('#btn-feed'), $rec = $('#btn-rec'), $chips = $('#chips');
const $settings = $('#settings'), $clip = $('#clip'), $toast = $('#toast');
if (debugOn) for (const a of document.querySelectorAll('a.home-link')) a.href = './?debug=1';
$('#version').textContent = `גרסה ${VERSION}${debugOn ? ' · debug' : ''}`;

let toastT = 0;
function toast(msg, ms = 3200) {
  $toast.textContent = msg; $toast.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => $toast.classList.remove('show'), ms);
}
let statusT = 0;
function status(msg, ms = 0) {
  $status.textContent = msg || '';
  clearTimeout(statusT); if (ms && msg) statusT = setTimeout(() => { $status.textContent = ''; }, ms);
}
const buzz = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };

// ---------------------------------------------------------------- voice
let micWanted = false;       // the user's toggle
let voiceState = 'idle';
const voice = createVoice({ onState: onVoiceState, onLevel: onVoiceLevel, onMicLevel });

// ---------------------------------------------------------------- audio: SFX + music (share the voice's AudioContext so clips get them too)
let sfxBus = null, musicGain = null, musicEl = null, musicSrc = null;
const sfxBuf = {};
function audioCtx() { try { return voice.context; } catch { return null; } }
function ensureBus() {
  const ctx = audioCtx(); if (!ctx || sfxBus) return ctx;
  sfxBus = ctx.createGain(); sfxBus.gain.value = SET.sound ? 0.8 : 0;
  sfxBus.connect(ctx.destination);
  try { const cap = voice.captureNode; if (cap) sfxBus.connect(cap); } catch {}
  return ctx;
}
async function loadSfx() {
  const ctx = ensureBus(); if (!ctx) return;
  await Promise.all(SFX_NAMES.map(async (n) => {
    for (const ext of SFX_EXT) {
      try {
        const r = await fetch(`${ASSETS}sfx/${n}.${ext}?v=${VERSION}`);
        if (!r.ok) continue;
        const ab = await r.arrayBuffer();
        sfxBuf[n] = await new Promise((res, rej) => ctx.decodeAudioData(ab, res, rej));
        return;
      } catch {}
    }
  }));
}
/** Tiny synthesized fallback so taps never feel dead if a file is missing. */
function synth(name) {
  const ctx = audioCtx(); if (!ctx) return;
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  const f = { giggle: [700, 1100], pop: [500, 900], sparkle: [1200, 2400], munch: [180, 120], bonk: [220, 90], snore: [90, 70] }[name] || [600, 900];
  o.type = name === 'bonk' || name === 'munch' ? 'square' : 'sine';
  o.frequency.setValueAtTime(f[0], t); o.frequency.exponentialRampToValueAtTime(f[1], t + 0.15);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  o.connect(g).connect(sfxBus); o.start(t); o.stop(t + 0.25);
  voice.holdOff && voice.holdOff(0.5);
}
function sfx(name, vol = 1, rate = 1) {
  if (!SET.sound) return;
  const ctx = ensureBus(); if (!ctx || ctx.state !== 'running') return;
  const b = sfxBuf[name];
  if (!b) { synth(name); return; }
  const s = ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = rate * (0.94 + Math.random() * 0.12);
  const g = ctx.createGain(); g.gain.value = vol;
  s.connect(g).connect(sfxBus); s.start();
  voice.holdOff && voice.holdOff(b.duration / s.playbackRate.value + 0.3);
}
let musicProbed = false;
async function setupMusic() {
  if (musicEl || musicProbed) return;
  musicProbed = true;
  for (const f of MUSIC_FILES) {
    try { const r = await fetch(`${ASSETS}${f}?v=${VERSION}`, { method: 'HEAD' }); if (!r.ok) continue; } catch { continue; }
    musicEl = new Audio(); musicEl.preload = 'none'; musicEl.src = `${ASSETS}${f}?v=${VERSION}`; musicEl.loop = true; musicEl.crossOrigin = 'anonymous';
    const ctx = ensureBus();
    if (ctx) {
      try { musicSrc = ctx.createMediaElementSource(musicEl); musicGain = ctx.createGain(); musicGain.gain.value = 0.18; musicSrc.connect(musicGain).connect(ctx.destination); }
      catch { musicEl.volume = 0.18; }
    } else musicEl.volume = 0.18;
    break;
  }
  if (!musicEl) $('#set-music').closest('.row').hidden = true;
  syncMusic();
}
function syncMusic() {
  if (!musicEl) return;
  // music plays only while the mic is off: the mic would hear it (no echo cancellation) and repeat it
  const on = SET.music && !micWanted && !document.hidden && voiceState !== 'talking' && voiceState !== 'hearing';
  if (musicGain) musicGain.gain.setTargetAtTime(on ? 0.18 : 0, musicGain.context.currentTime, 0.3);
  if (on) musicEl.play().catch(() => {}); else if (!musicGain || !SET.music || micWanted || document.hidden) musicEl.pause();
}

// ---------------------------------------------------------------- scene
let scene = null, sceneState = 'idle';
const SCENE_STUB = { setState() {}, react() {}, setMouth() {}, onHit() {}, resize() {}, destroy() {} };
async function mountScene() {
  try {
    const mod = await import(`./unicorn-scene.js?v=${VERSION}`);
    const s = await mod.createScene($stage, { assets: ASSETS, quality: SET.quality, debug: debugOn });
    scene = { ...SCENE_STUB, ...bindAll(s) };
  } catch (e) {
    console.error('[unicorn] scene failed', e);
    scene = SCENE_STUB;
    toast('ניצנוץ לא הצליח להיטען 😢 נסו לרענן', 5000);
  }
  scene.onHit(onHit);
  sceneState = '';
  setScene(voiceState === 'talking' ? 'talking' : 'idle');
}
function bindAll(s) { const o = {}; for (const k of Object.keys(SCENE_STUB)) if (typeof s[k] === 'function') o[k] = s[k].bind(s); o.raw = s; return o; }
function setScene(st) {
  if (!scene || st === sceneState) return;
  sceneState = st; scene.setState(st);
}
async function remountScene() {
  if (!scene) return;
  try { scene.destroy(); } catch {}
  $stage.textContent = '';
  scene = null;
  await mountScene();
}

// ---------------------------------------------------------------- idle → sleep
let lastActive = performance.now();
function poke() {
  lastActive = performance.now();
  if (sceneState === 'sleeping') wake();
}
function wake() {
  if (sceneState !== 'sleeping') return;
  sceneState = 'idle';
  scene && scene.react('wake');
  scene && scene.setState(voiceState === 'talking' ? 'talking' : voiceState === 'hearing' ? 'listening' : 'idle');
  sceneState = voiceState === 'talking' ? 'talking' : voiceState === 'hearing' ? 'listening' : 'idle';
  sfx('pop', 0.6);
  status('ניצנוץ התעורר! ☀️', 1800);
}
let snoreT = 0;
setInterval(() => {
  if (!scene || document.hidden) return;
  const busy = voiceState === 'talking' || voiceState === 'hearing' || recording;
  if (busy) { lastActive = performance.now(); return; }
  if (sceneState !== 'sleeping' && performance.now() - lastActive > SLEEP_AFTER_MS) {
    setScene('sleeping'); status('💤 ניצנוץ נרדם… דברו אליו כדי להעיר אותו');
    snoreT = 0;
  }
  if (sceneState === 'sleeping' && (snoreT++ % 4) === 0) sfx('snore', 0.5);
}, 1000);

// ---------------------------------------------------------------- voice → scene
function onVoiceState(s, info) {
  voiceState = s;
  $mic.classList.toggle('hearing', s === 'hearing');
  $mic.classList.toggle('talking', s === 'talking');
  if (s === 'hearing') {
    poke(); coachHeard = true;
    if (sceneState !== 'sleeping') setScene('listening');
    status('👂 ניצנוץ מקשיב…');
  } else if (s === 'talking') {
    lastActive = performance.now();
    if (sceneState === 'sleeping') wake();
    setScene('talking'); status('');
    addHeart(0.25);
  } else if (s === 'listening') {
    if (sceneState !== 'sleeping') setScene('idle');
    if (!$status.textContent || $status.textContent.startsWith('👂')) status('🎤 דברו אל ניצנוץ!', 2500);
    setMic(true);
  } else if (s === 'idle') {
    if (sceneState !== 'sleeping') setScene('idle');
    if (!micWanted) setMic(false);
    status('');
  } else if (s === 'denied') {
    micWanted = false; setMic(false, true);
    if (sceneState !== 'sleeping') setScene('idle');
    const r = info && info.reason;
    toast(r === 'unsupported' ? 'הדפדפן הזה לא תומך במיקרופון – אבל אפשר ללטף ולהאכיל את ניצנוץ 💖'
      : r === 'nodevice' ? 'לא מצאנו מיקרופון 🎤 – אפשר עדיין לשחק עם ניצנוץ'
      : r === 'ended' ? 'המיקרופון התנתק – לחצו על 🎤 כדי לחבר מחדש'
      : r === 'busy' ? 'המיקרופון תפוס באפליקציה אחרת – סגרו אותה ולחצו 🎤'
      : r === 'denied' ? 'בלי מיקרופון ניצנוץ לא שומע 🙉 אפשר לאשר בהגדרות הדפדפן – ובינתיים ללטף אותו!'
      : 'משהו השתבש עם המיקרופון – נסו שוב', 5200);
  }
  syncMusic();
}
let lvlRaf = 0, lvlTarget = 0;
function setLvl(v) { lvlTarget = v; if (!lvlRaf) lvlRaf = requestAnimationFrame(() => { lvlRaf = 0; $mic.style.setProperty('--lvl', lvlTarget.toFixed(3)); }); }
function onVoiceLevel(v) { if (scene) scene.setMouth(v); setLvl(v); }
function onMicLevel(v) {
  if (voiceState === 'talking') return;
  setLvl(Math.min(1, Math.sqrt(Math.max(0, v)) * 3));
}
function setMic(on, off = false) {
  $mic.setAttribute('aria-pressed', on ? 'true' : 'false');
  $mic.classList.toggle('off', !!off);
  $mic.setAttribute('aria-label', on ? 'מיקרופון פועל – לחצו לכיבוי' : 'מיקרופון כבוי – לחצו להפעלה');
  if (!on) setLvl(0);
}

// ---------------------------------------------------------------- interactions
const REACT = {
  head: { kind: 'pet', sfx: 'giggle', heart: 0.5, msg: 'ניצנוץ אוהב ליטופים 💕' },
  body: { kind: 'pet', sfx: 'pop', heart: 0.3 },
  belly: { kind: 'tickle', sfx: 'giggle', heart: 0.5, msg: 'חחח זה מדגדג! 🤭' },
  horn: { kind: 'horn', sfx: 'sparkle', heart: 0.4, msg: 'קסם קשת! 🌈' },
};
let lastHit = 0, lastBonk = 0;
function onHit(h) {
  poke(); coachDone();
  const now = performance.now();
  if (now - lastHit < DOUBLE_TAP_MS) { lastHit = 0; bonk(); return; }
  lastHit = now;
  if (now - lastBonk < 1600) return;      // let the dizzy animation play out
  const r = REACT[h && h.part] || REACT.body;
  scene.react(r.kind); sfx(r.sfx, 0.9, r.kind === 'tickle' ? 1.08 : 1); buzz(12);
  addHeart(r.heart);
  if (r.msg) status(r.msg, 1600);
}
function bonk() {
  const now = performance.now();
  if (now - lastBonk < 1600) return;
  lastBonk = now;
  scene.react('bonk'); sfx('bonk', 1); buzz([20, 40, 20]);
  addHeart(-0.6);
  status('אאוץ׳! 💫', 1600);
}
// swipe on the stage → bonk
let sw = null;
$stage.addEventListener('pointerdown', (e) => { sw = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }; poke(); }, { passive: true });
$stage.addEventListener('pointerup', (e) => {
  if (!sw || sw.id !== e.pointerId) return;
  const dx = e.clientX - sw.x, dy = e.clientY - sw.y, dt = performance.now() - sw.t;
  sw = null;
  if (Math.hypot(dx, dy) > SWIPE_PX && dt < 450) { lastHit = 0; bonk(); }
}, { passive: true });
$stage.addEventListener('pointercancel', () => { sw = null; }, { passive: true });

let feedBusy = 0;
$feed.addEventListener('click', () => {
  const now = performance.now();
  if (now < feedBusy || !scene) return;
  feedBusy = now + 2200;
  poke(); if (sceneState === 'sleeping') wake();
  scene.react('eat'); sfx('pop', 0.6);
  setTimeout(() => sfx('munch', 1), 700);
  setTimeout(() => sfx('munch', 0.8, 1.1), 1100);
  addHeart(0.6); buzz(10);
  status(['יאמי! 🧁', 'ממממ טעים! 🍭', 'עוד! עוד! 🍬'][Math.floor(Math.random() * 3)], 1800);
});

// ---------------------------------------------------------------- hearts meter
let hearts = Math.min(HEART_MAX, Math.max(0, parseFloat(store.get('uni-hearts')) || 3));
function renderHearts(gainIdx = -1) {
  const full = Math.round(hearts);
  $hearts.innerHTML = Array.from({ length: HEART_MAX }, (_, i) => `<i class="${i < full ? '' : 'off'}${i === gainIdx ? ' gain' : ''}">💖</i>`).join('');
  $hearts.setAttribute('aria-valuenow', String(full));
}
function addHeart(d) {
  const before = Math.round(hearts);
  hearts = Math.min(HEART_MAX, Math.max(0, hearts + d));
  const after = Math.round(hearts);
  store.set('uni-hearts', hearts.toFixed(2));
  if (after !== before) renderHearts(after > before ? after - 1 : -1);
}
setInterval(() => { if (!document.hidden && hearts > 1) addHeart(-0.1); }, 30000);
renderHearts();

// ---------------------------------------------------------------- first-run coach mark (tap the unicorn)
let coachEl = null, coachT = 0, coachHeard = false, coachRaf = 0;
function coachDone() {
  clearTimeout(coachT); cancelAnimationFrame(coachRaf);
  if (coachEl) { coachEl.remove(); coachEl = null; store.set('uni-coached', '1'); status(''); }
}
function headPos() {
  try { const p = scene && scene.raw && scene.raw.partAt && scene.raw.partAt('head'); if (p && isFinite(p.x) && isFinite(p.y)) return p; } catch {}
  const r = $stage.getBoundingClientRect(); return { x: r.width / 2, y: r.height * 0.4 };
}
function coachMaybe() {
  if (store.get('uni-coached') === '1') return;
  coachT = setTimeout(() => {
    if (coachHeard || sceneState === 'sleeping' || !scene || document.body.dataset.screen !== 'main') { if (!coachHeard) coachMaybe(); return; }
    coachEl = document.createElement('div'); coachEl.className = 'coach'; coachEl.setAttribute('aria-hidden', 'true'); coachEl.textContent = '👆';
    document.body.appendChild(coachEl);
    const follow = () => { if (!coachEl) return; const p = headPos(); coachEl.style.left = `${p.x}px`; coachEl.style.top = `${p.y}px`; coachRaf = requestAnimationFrame(follow); };
    follow();
    status('לטפו את ניצנוץ על הראש, הבטן או הקרן ✨', 9000);
    coachT = setTimeout(() => { if (coachEl) { coachEl.remove(); coachEl = null; cancelAnimationFrame(coachRaf); } }, 9000);
  }, 5000);
}

// ---------------------------------------------------------------- mic toggle
$mic.addEventListener('click', () => {
  poke();
  if (micWanted) { micWanted = false; voice.stop(); setMic(false); status('🎤 המיקרופון כבוי', 1500); syncMusic(); return; }
  micWanted = true; setMic(true); syncMusic();
  voice.start().then((ok) => { if (!ok) { micWanted = false; setMic(false, true); } });
});

// ---------------------------------------------------------------- voice style chips
function renderChips() {
  $chips.innerHTML = (voice.styles || []).map(s =>
    `<button class="chip" type="button" role="radio" data-style="${s.name}" aria-checked="${s.name === SET.style}"><span class="ce">${s.emoji}</span>${s.label}</button>`).join('');
}
$chips.addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  SET.style = voice.setStyle(b.dataset.style) || b.dataset.style; saveSet();
  for (const c of $chips.children) c.setAttribute('aria-checked', String(c.dataset.style === SET.style));
  b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  sfx('pop', 0.5); poke();
  // replay the last sentence in the new voice
  if (voice.hasRecording && voiceState !== 'talking' && voiceState !== 'hearing') voice.speak().catch(() => {});
});

// ---------------------------------------------------------------- clip recording
let recording = null;
const canRecord = () => typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
function startClip() {
  const canvas = $stage.querySelector('canvas');
  if (!canRecord() || !canvas) { toast('הדפדפן הזה לא יודע להקליט סרטון 🎥'); return; }
  ensureBus();
  const vstream = canvas.captureStream(30);
  const tracks = [...vstream.getVideoTracks()];
  try { const a = voice.captureStream(); if (a) tracks.push(...a.getAudioTracks()); } catch {}
  const mime = (voice.recorderMime ? voice.recorderMime() : pickRecorderMime()) || '';
  let mr;
  try { mr = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined); }
  catch (e) { console.error(e); toast('לא הצלחנו להתחיל להקליט 😕'); return; }
  const chunks = [];
  mr.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  mr.onstop = () => {
    for (const t of vstream.getTracks()) t.stop();
    const type = (mr.mimeType || mime || 'video/webm').split(';')[0];
    showClip(new Blob(chunks, { type }));
  };
  try { scene && scene.raw && scene.raw.lockResolution && scene.raw.lockResolution(true); } catch {}
  mr.start(250);
  const t0 = performance.now();
  recording = { mr, t0, timer: setTimeout(stopClip, CLIP_MAX_MS), tick: setInterval(() => status(`🔴 מקליטים… ${Math.ceil((CLIP_MAX_MS - (performance.now() - t0)) / 1000)}`), 250) };
  $rec.setAttribute('aria-pressed', 'true'); $rec.querySelector('.al').textContent = 'עצירה';
  sfx('pop', 0.5);
  if (!micWanted) toast('טיפ: הדליקו את 🎤 כדי שניצנוץ ידבר בסרטון', 2600);
}
function stopClip() {
  if (!recording) return;
  const r = recording; recording = null;
  try { scene && scene.raw && scene.raw.lockResolution && scene.raw.lockResolution(false); } catch {}
  clearTimeout(r.timer); clearInterval(r.tick); status('');
  $rec.setAttribute('aria-pressed', 'false'); $rec.querySelector('.al').textContent = 'סרטון';
  try { r.mr.state !== 'inactive' && r.mr.stop(); } catch {}
}
let clipUrl = '';
function showClip(blob) {
  if (!blob.size) { toast('הסרטון יצא ריק 😕 נסו שוב'); return; }
  if (clipUrl) URL.revokeObjectURL(clipUrl);
  clipUrl = URL.createObjectURL(blob);
  const ext = /mp4/.test(blob.type) ? 'mp4' : 'webm';
  const name = `nitznutz-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
  const v = $('#clip-video'); v.src = clipUrl;
  const dl = $('#btn-download'); dl.href = clipUrl; dl.download = name;
  const share = $('#btn-share');
  let file = null;
  try { file = new File([blob], name, { type: blob.type }); } catch {}
  share.hidden = !(file && navigator.canShare && navigator.canShare({ files: [file] }));
  share.onclick = () => navigator.share({ files: [file], title: 'ניצנוץ', text: 'תראו מה ניצנוץ אמר! 🦄' }).catch(() => {});
  $clip.hidden = false; $toast.classList.remove('show');
  v.play().catch(() => {});
}
$rec.addEventListener('click', () => { poke(); recording ? stopClip() : startClip(); });
$('#btn-close-clip').addEventListener('click', () => { const v = $('#clip-video'); v.pause(); $clip.hidden = true; });
$('#btn-download').addEventListener('click', () => setTimeout(() => toast('הסרטון נשמר 💾'), 300));

// ---------------------------------------------------------------- settings sheet
const $sound = $('#set-sound'), $music = $('#set-music'), $quality = $('#set-quality');
function syncSettingsUI() {
  $sound.checked = SET.sound; $music.checked = SET.music;
  for (const b of $quality.children) { b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(b.dataset.q === SET.quality)); }
}
function openSettings(open) {
  $settings.hidden = !open; $('#btn-settings').setAttribute('aria-expanded', String(open));
  if (open) { syncSettingsUI(); $toast.classList.remove('show'); }
}
$('#btn-settings').addEventListener('click', () => openSettings($settings.hidden));
$('#btn-close-settings').addEventListener('click', () => openSettings(false));
$settings.addEventListener('click', (e) => { if (e.target === $settings) openSettings(false); });
$clip.addEventListener('click', (e) => { if (e.target === $clip) $('#btn-close-clip').click(); });
$sound.addEventListener('change', () => {
  SET.sound = $sound.checked; saveSet();
  if (sfxBus) sfxBus.gain.value = SET.sound ? 0.8 : 0;
  if (SET.sound) sfx('pop', 0.6);
});
$music.addEventListener('change', () => {
  SET.music = $music.checked; saveSet(); setupMusic().then(syncMusic);
  if (SET.music && micWanted) toast('🎵 המוזיקה מתנגנת רק כשהמיקרופון כבוי', 2600);
});
$quality.addEventListener('click', (e) => {
  const b = e.target.closest('[data-q]'); if (!b || b.dataset.q === SET.quality) return;
  SET.quality = b.dataset.q; saveSet(); syncSettingsUI();
  remountScene();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$clip.hidden) $('#btn-close-clip').click(); else if (!$settings.hidden) openSettings(false);
});

// ---------------------------------------------------------------- lifecycle
let resizeRaf = 0;
const onResize = () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(() => scene && scene.resize()); };
addEventListener('resize', onResize);
addEventListener('orientationchange', () => setTimeout(onResize, 250));
if (window.visualViewport) visualViewport.addEventListener('resize', onResize);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (recording) stopClip();
    if (musicEl) musicEl.pause();
  } else {
    lastActive = performance.now();
    const ctx = audioCtx(); if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    syncMusic();
    // iOS may leave the context 'interrupted' until a tap: say so instead of looking deaf
    setTimeout(() => { const c = audioCtx(); if (micWanted && c && c.state !== 'running') status('👆 געו במסך כדי להעיר את ניצנוץ', 4000); }, 600);
  }
});
// iOS may suspend the context after an interruption; any tap resumes it.
addEventListener('pointerdown', () => { const ctx = sfxBus && audioCtx(); if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); }, { capture: true, passive: true });

// ---------------------------------------------------------------- start
SET.style = voice.setStyle(SET.style) || 'classic';
renderChips();
const scenePromise = mountScene();   // load the unicorn behind the start screen right away
let started = false;
$go.addEventListener('click', async () => {
  if (started) return; started = true;
  // must run synchronously inside the gesture: creates/resumes the AudioContext and asks for the mic
  micWanted = !!voice.isSupported;
  const micP = voice.isSupported ? voice.start() : Promise.resolve(false);
  if (!voice.isSupported) onVoiceState('denied', { reason: 'unsupported' });
  ensureBus();
  loadSfx().then(() => sfx('sparkle', 0.7));
  setupMusic();
  $go.disabled = true;
  if (!scene) $loading.hidden = false;
  await scenePromise;
  $loading.hidden = true;
  document.body.dataset.screen = 'main';
  $start.hidden = true; $top.hidden = false; $bar.hidden = false; $status.hidden = false;
  scene.resize(); poke();
  scene.react('wake');
  $chips.querySelector('[aria-checked="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  coachMaybe();
  micP.then((ok) => { if (ok) status('🎤 דברו אל ניצנוץ – הוא יחזור אחריכם!', 3500); else if (micWanted) { micWanted = false; setMic(false, true); } });
});

if (debugOn) {
  window.__uni = {
    VERSION, SET, voice, get scene() { return scene; }, get sceneState() { return sceneState; }, get voiceState() { return voiceState; },
    get hearts() { return hearts; }, sfx, sfxBuf, onHit, bonk, wake, toast, status, startClip, stopClip,
    sleepNow() { lastActive = -1e9; }, remountScene, coachDone, get coachEl() { return coachEl; },
  };
}
