// Sound effects synthesized with Web Audio (no audio files) and haptic feedback.

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

export const settings = {
  sound: store.get('hathatul-sound') !== 'off',
  haptics: store.get('hathatul-haptics') !== 'off',
};
export function toggle(kind) {
  settings[kind] = !settings[kind];
  store.set(`hathatul-${kind}`, settings[kind] ? 'on' : 'off');
  if (kind === 'sound' && settings.sound) play('pop');
  if (kind === 'haptics' && settings.haptics) haptic('tap');
}

// ---------- audio ----------
let ctx = null;
// Browsers only allow audio after a user gesture: create/resume the context on the first touch.
function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
}
addEventListener('pointerdown', unlock, { capture: true, passive: true });
addEventListener('keydown', unlock, { capture: true });

function tone({ freq = 440, to = null, type = 'sine', dur = 0.15, vol = 0.2, at = 0, attack = 0.005 }) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

// Filtered noise: card sliding / flicking.
function noise({ dur = 0.12, vol = 0.25, at = 0, from = 1800, to = 600, q = 1 }) {
  const t = ctx.currentTime + at;
  const len = Math.ceil(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = q;
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(t);
}

// A cartoon "meow": a sawtooth through a formant filter with a rising-then-falling pitch.
function meow(at = 0) {
  const t = ctx.currentTime + at;
  const dur = 0.6;
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(420, t);
  o.frequency.linearRampToValueAtTime(780, t + 0.18);
  o.frequency.linearRampToValueAtTime(560, t + dur);
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 7;
  lfoGain.gain.value = 12;
  lfo.connect(lfoGain).connect(o.frequency);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 4;
  f.frequency.setValueAtTime(900, t);
  f.frequency.linearRampToValueAtTime(1800, t + 0.2);
  f.frequency.linearRampToValueAtTime(1100, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + 0.06);
  g.gain.setValueAtTime(0.5, t + dur - 0.2);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(f).connect(g).connect(ctx.destination);
  o.start(t); lfo.start(t);
  o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
}

const SOUNDS = {
  tick: () => noise({ dur: 0.05, vol: 0.15, from: 3000, to: 2000, q: 2 }),
  draw: () => noise({ dur: 0.18, vol: 0.3, from: 1200, to: 3000 }),
  place: () => { noise({ dur: 0.07, vol: 0.3, from: 900, to: 400 }); tone({ freq: 160, to: 90, dur: 0.08, vol: 0.25 }); },
  discard: () => noise({ dur: 0.22, vol: 0.3, from: 2500, to: 500 }),
  flip: () => noise({ dur: 0.06, vol: 0.2, from: 2500, to: 1500, q: 3 }),
  swap: () => { noise({ dur: 0.25, vol: 0.25, from: 600, to: 2400 }); noise({ dur: 0.25, vol: 0.25, at: 0.2, from: 2400, to: 600 }); },
  power: () => [660, 880, 1320].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.18, vol: 0.18, at: i * 0.07 })),
  peek: () => { tone({ freq: 900, to: 1400, type: 'sine', dur: 0.25, vol: 0.15 }); },
  turn: () => { tone({ freq: 880, type: 'triangle', dur: 0.16, vol: 0.22 }); tone({ freq: 1320, type: 'triangle', dur: 0.3, vol: 0.22, at: 0.14 }); },
  call: () => { tone({ freq: 220, type: 'square', dur: 0.12, vol: 0.12 }); meow(0.08); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: i === 3 ? 0.5 : 0.16, vol: 0.2, at: i * 0.12 })),
  lose: () => [392, 330, 262].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.22, vol: 0.16, at: i * 0.16 })),
  pop: () => tone({ freq: 500, to: 1100, type: 'sine', dur: 0.1, vol: 0.2 }),
  nope: () => tone({ freq: 220, to: 160, type: 'square', dur: 0.12, vol: 0.08 }),
  shuffle: () => { for (let i = 0; i < 6; i++) noise({ dur: 0.05, vol: 0.18, at: i * 0.05, from: 2500, to: 1500, q: 2 }); },
};

export function play(name) {
  if (!settings.sound || !ctx || ctx.state !== 'running' || !SOUNDS[name]) return;
  try { SOUNDS[name](); } catch {}
}

// ---------- haptics ----------
// Android: the Vibration API. iPhone has no Vibration API; iOS 18+ gives a haptic tick when a
// <input type=checkbox switch> is toggled, so we toggle a hidden one (works best right after a tap).
const PATTERNS = {
  tap: [15],
  turn: [60, 50, 60],
  call: [120, 60, 120, 60, 200],
  swapped: [100],
  win: [80, 40, 80, 40, 160],
  nope: [25],
  emoji: [10],
};
let iosSwitch = null;
function iosTick() {
  if (!iosSwitch) {
    const label = document.createElement('label');
    label.style.cssText = 'position:fixed;left:-100px;top:0;opacity:0;pointer-events:none';
    label.innerHTML = '<input type="checkbox" switch>';
    document.body.append(label);
    iosSwitch = label;
  }
  iosSwitch.click();
}
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function haptic(name) {
  if (!settings.haptics) return;
  const pattern = PATTERNS[name] || PATTERNS.tap;
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch {}
  } else if (isIOS) {
    // One tick per pulse in the pattern.
    let at = 0;
    pattern.forEach((ms, i) => {
      if (i % 2 === 0) setTimeout(iosTick, at);
      at += ms;
    });
  }
}
