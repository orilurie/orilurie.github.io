// זירה – recorded sound effects (CC0, see sounds/CREDITS.txt) with simple positional audio:
// sounds from far away are quieter and duller, and pan left/right by where they happen.

import { settings } from './sfx.js?v=47';

// Which pistol shot to use: picked on sounds.html (saved per device), default 3.
export function gunChoice() {
  let n = 3;
  try { n = Number(localStorage.getItem('arena-gun')) || 3; } catch {}
  return n >= 1 && n <= 8 ? n : 3;
}

const FILES = {
  shot: [`candidates/gun${gunChoice()}`], // pistol
  shot_smg: ['candidates/gun2'],
  shot_shotgun: ['candidates/gun5'],
  shot_sniper: ['candidates/gun4'],
  dash: ['dash'], empty: ['empty'],
  hit: ['hit1', 'hit2', 'hit3'],
  hurt: ['hurt1', 'hurt2'],
  wall: ['wall1', 'wall2', 'wall3'],
  step: ['step1', 'step2', 'step3', 'step4', 'step5'],
  die: ['die'], block: ['block'], kill: ['kill'], pickup: ['pickup'], count: ['count'], go: ['go'],
};
const BASE_VOL = { shot_smg: 0.4, shot_shotgun: 0.8, shot_sniper: 0.85, dash: 0.5, empty: 0.6, shot: 0.6, hit: 0.8, hurt: 0.9, wall: 0.25, step: 0.35, die: 0.8, block: 0.4, kill: 0.6, pickup: 0.6, count: 0.5, go: 0.6 };

let ctx = null, master = null;
const buffers = {};
let loading = null;

function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    load();
  }
  if (ctx.state === 'suspended') ctx.resume();
}
addEventListener('pointerdown', unlock, { capture: true, passive: true });
addEventListener('keydown', unlock, { capture: true });

function load() {
  if (loading) return loading;
  const names = [...new Set(Object.values(FILES).flat())];
  loading = Promise.all(names.map(async n => {
    try {
      const res = await fetch(`sounds/${n}.mp3`);
      const data = await res.arrayBuffer();
      buffers[n] = await new Promise((ok, bad) => ctx.decodeAudioData(data, ok, bad));
    } catch {}
  }));
  return loading;
}

// listener = { x, y } (you), at = { x, y } where the sound happens (omit for "in your head" sounds)
export function sound(name, { at = null, listener = null, vol = 1 } = {}) {
  if (!settings.sound || !ctx || ctx.state !== 'running') return;
  const list = FILES[name];
  const buf = list && buffers[list[Math.floor(Math.random() * list.length)]];
  if (!buf) return;
  let gain = (BASE_VOL[name] ?? 0.6) * vol, pan = 0, cutoff = 20000;
  if (at && listener) {
    const dx = at.x - listener.x, dy = at.y - listener.y, d = Math.hypot(dx, dy);
    gain *= 1 / (1 + d / 260);
    pan = Math.max(-1, Math.min(1, dx / 500));
    cutoff = Math.max(900, 18000 / (1 + d / 150));
  }
  if (gain < 0.01) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = 0.94 + Math.random() * 0.12; // a little variety
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = cutoff;
  const g = ctx.createGain();
  g.gain.value = gain;
  let node = src.connect(f).connect(g);
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    node = node.connect(p);
  }
  node.connect(master);
  src.start();
}
