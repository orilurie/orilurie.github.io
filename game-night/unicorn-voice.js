// unicorn-voice.js — mic, VAD, recording, funny-voice effects, playback, amplitude.
// API (see unicorn-spec.md):
//   createVoice({onState, onLevel}) -> {start, stop, setStyle, styles, isSupported,
//                                        speak(buffer?), destroy, captureStream}
// onState: 'listening' | 'hearing' | 'talking' | 'idle' | 'denied'
// onLevel(0..1): per animation frame while talking (mouth sync).
//
// Pitch/formant shifting is done with a TD-PSOLA shifter (pitch-synchronous
// overlap-add with autocorrelation pitch tracking) over the whole captured
// utterance, so it keeps the speed where the style asks for it. Colour effects
// (ring-mod, bitcrush, distortion, reverb, echo) are rendered with an
// OfflineAudioContext, then played through an analyser (mouth) and a
// MediaStreamDestination (clip recording).

const STYLE_LIST = [
  { name: 'classic',  label: 'קלאסי',  emoji: '🦄' },
  { name: 'squirrel', label: 'סנאי',   emoji: '🐿️' },
  { name: 'monster',  label: 'מפלצת',  emoji: '👹' },
  { name: 'robot',    label: 'רובוט',  emoji: '🤖' },
  { name: 'helium',   label: 'הליום',  emoji: '🎈' },
  { name: 'slow',     label: 'איטי',   emoji: '🐢' },
];

// resample: >1 raises pitch+formants and speeds up (playbackRate-like).
// stretch: PSOLA time-scale applied after resampling (output length factor).
// pitch: PSOLA pitch factor applied after resampling (formants preserved).
// mono: robot monotone (target f0 = utterance median f0 * mono).
const STYLE_DEF = {
  classic:  { resample: 1.55, stretch: 1.55, pitch: 1.0 },          // cartoon: pitch+formants x1.55, same speed
  squirrel: { resample: 2.0,  stretch: 1,    pitch: 1.0 },          // chipmunk: x2 and fast
  monster:  { resample: 0.78, stretch: 0.78, pitch: 0.75 },         // pitch x0.58, formants x0.78, same speed
  robot:    { resample: 1.0,  stretch: 1,    pitch: 1, mono: 0.85 },// flat pitch + ring-mod + bitcrush
  helium:   { resample: 1.75, stretch: 1.75, pitch: 0.72 },         // formants x1.75, pitch only x1.26
  slow:     { resample: 0.66, stretch: 1,    pitch: 1.0 },          // turtle: low and slow
};

const VAD = {
  chunkSec: 0.02,
  startChunks: 3,       // consecutive loud chunks to trigger
  silenceSec: 0.8,      // stop after this much silence
  minSec: 0.2,          // minimum voiced length
  maxSec: 8,            // cap (keeps the off-thread PSOLA under ~1 s on slow phones)
  prerollSec: 0.35,
  tailSec: 0.3,         // kept after last voiced chunk (soft final consonants)
  quietChunks: 8,       // after unmute/start: need ~170 ms below threshold before arming
  minStart: 0.008,
  minCont: 0.005,
};

export function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  // mp4 first: it carries a duration, seeks in the preview and is accepted by WhatsApp/iOS
  // (Chrome 126+ and Safari record it); webm is the fallback
  const c = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const t of c) { try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) {} }
  return '';
}

const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
const OAC = typeof window !== 'undefined' ? (window.OfflineAudioContext || window.webkitOfflineAudioContext) : null;

const CAPTURE_WORKLET = `
class UniCap extends AudioWorkletProcessor {
  constructor() { super(); this.size = 1024; this.buf = new Float32Array(this.size); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.size) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(this.size); this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('uni-cap', UniCap);
`;

// ---------------------------------------------------------------- DSP helpers

function rmsOf(a, s = 0, e = a.length) {
  let sum = 0; for (let i = s; i < e; i++) sum += a[i] * a[i];
  return Math.sqrt(sum / Math.max(1, e - s));
}

function lowpassFIR(x, cutoff /* fraction of fs, <0.5 */, taps = 31) {
  const h = new Float32Array(taps), M = taps - 1; let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - M / 2;
    const s = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / M) + 0.08 * Math.cos(4 * Math.PI * i / M);
    h[i] = s * w; sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const y = new Float32Array(x.length), half = M >> 1, N = x.length;
  for (let i = 0; i < N; i++) {
    let acc = 0;
    for (let k = 0; k < taps; k++) { const j = i + k - half; if (j >= 0 && j < N) acc += x[j] * h[k]; }
    y[i] = acc;
  }
  return y;
}

// Read x at rate r (r>1 = higher & faster). Band-limits first when compressing.
function resample(x, r) {
  if (Math.abs(r - 1) < 1e-3) return x;
  const src = r > 1.05 ? lowpassFIR(x, 0.45 / r) : x;
  const n = Math.floor((x.length - 1) / r), y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * r, i0 = p | 0, f = p - i0;
    y[i] = src[i0] + (src[i0 + 1] - src[i0]) * f;
  }
  return y;
}

// Autocorrelation (NCCF) pitch tracker on a decimated copy. Returns per-hop f0 (0 = unvoiced).
export function trackPitch(x, sr, fmin = 70, fmax = 700) {
  const D = Math.max(1, Math.round(sr / 12000)), srd = sr / D;
  const nd = Math.floor(x.length / D), y = new Float32Array(nd);
  for (let i = 0; i < nd; i++) { let s = 0; for (let k = 0; k < D; k++) s += x[i * D + k]; y[i] = s / D; }
  const hop = Math.round(srd * 0.01), minL = Math.floor(srd / fmax), maxL = Math.ceil(srd / fmin);
  const n = Math.round(srd * 0.03);
  const frames = Math.max(0, Math.floor((nd - n - maxL) / hop) + 1);
  const f0 = new Float32Array(frames), rms = new Float32Array(frames);
  let maxR = 0;
  for (let f = 0; f < frames; f++) { rms[f] = rmsOf(y, f * hop, f * hop + n); if (rms[f] > maxR) maxR = rms[f]; }
  const gate = Math.max(maxR * 0.06, 1e-4);
  const nccf = new Float32Array(maxL + 2);
  for (let f = 0; f < frames; f++) {
    if (rms[f] < gate) continue;
    const s = f * hop;
    let e1 = 0; for (let i = 0; i < n; i++) e1 += y[s + i] * y[s + i];
    let e2 = 0; for (let i = 0; i < n; i++) e2 += y[s + minL + i] * y[s + minL + i];
    let best = 0;
    for (let L = minL; L <= maxL; L++) {
      let r = 0; for (let i = 0; i < n; i++) r += y[s + i] * y[s + i + L];
      const v = r / Math.sqrt(e1 * e2 + 1e-12);
      nccf[L] = v; if (v > best) best = v;
      e2 += y[s + L + n] * y[s + L + n] - y[s + L] * y[s + L];
    }
    if (best < 0.5) continue;
    // smallest lag whose local peak is near the best: avoids octave-down errors
    let lag = 0;
    for (let L = minL + 1; L < maxL; L++) {
      if (nccf[L] >= nccf[L - 1] && nccf[L] >= nccf[L + 1] && nccf[L] >= best * 0.88) { lag = L; break; }
    }
    if (!lag) continue;
    const a = nccf[lag - 1], b = nccf[lag], c = nccf[lag + 1], den = a - 2 * b + c;
    const off = den ? 0.5 * (a - c) / den : 0;
    f0[f] = srd / (lag + Math.max(-0.5, Math.min(0.5, off)));
  }
  // 3-tap median + fill isolated holes
  const sm = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = f0[Math.max(0, f - 1)], b = f0[f], c = f0[Math.min(frames - 1, f + 1)];
    sm[f] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }
  return { f0: sm, hopSamples: hop * D, offset: Math.round(n * D / 2) };
}

function medianF0(tr) {
  const v = Array.from(tr.f0).filter(f => f > 0).sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : 0;
}

// TD-PSOLA. pitch: factor (voiced only). stretch: output length factor. monoF0: force constant f0.
function psola(x, sr, { pitch = 1, stretch = 1, monoF0 = 0 } = {}, tr = null) {
  if (pitch === 1 && stretch === 1 && !monoF0) return x;
  tr = tr || trackPitch(x, sr);
  const N = x.length, uvT = Math.round(sr * 0.01);
  const f0At = (pos) => {
    const k = Math.round((pos - tr.offset) / tr.hopSamples);
    return (k >= 0 && k < tr.f0.length) ? tr.f0[k] : 0;
  };
  // analysis marks: one per period in voiced parts, snapped to the local peak
  const marks = [], periods = [], voiced = [];
  let pos = 0;
  while (pos < N) {
    const f = f0At(pos), v = f > 0, T = v ? sr / f : uvT;
    let m = Math.round(pos);
    if (v) {
      const r = Math.round(T * 0.25); let best = -Infinity;
      for (let i = Math.max(0, m - r); i <= Math.min(N - 1, m + r); i++) if (x[i] > best) { best = x[i]; m = i; }
      if (marks.length && m <= marks[marks.length - 1] + T * 0.5) m = Math.round(marks[marks.length - 1] + T);
    }
    marks.push(m); periods.push(T); voiced.push(v);
    pos = m + T;
  }
  const outLen = Math.round(N * stretch);
  const out = new Float32Array(outLen), wsum = new Float32Array(outLen);
  let ts = 0, k = 0;
  while (ts < outLen) {
    const ta = ts / stretch;
    while (k + 1 < marks.length && Math.abs(marks[k + 1] - ta) <= Math.abs(marks[k] - ta)) k++;
    const v = voiced[k], T = periods[k];
    let center, H, step;
    if (v) {
      center = marks[k];
      step = monoF0 ? sr / monoF0 : T / pitch;
      H = Math.round(Math.max(T, step * 0.55));
    } else {
      center = Math.round(ta); step = uvT * 0.5; H = uvT;   // plain OLA for noise: no repetition buzz
    }
    const t0 = Math.round(ts);
    for (let i = -H; i <= H; i++) {
      const o = t0 + i, a = center + i;
      if (o < 0 || o >= outLen || a < 0 || a >= N) continue;
      const w = 0.5 + 0.5 * Math.cos(Math.PI * i / H);
      out[o] += x[a] * w; wsum[o] += w;
    }
    ts += Math.max(1, step);
  }
  for (let i = 0; i < outLen; i++) out[i] /= Math.max(wsum[i], 0.5);
  return out;
}

function makeImpulse(ctx, sec, decay, bright = 1) {
  const sr = ctx.sampleRate, n = Math.round(sr * sec), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const r = Math.random() * 2 - 1; lp += (r - lp) * bright;
    d[i] = lp * Math.pow(1 - i / n, decay);
  }
  return b;
}

function shaperCurve(fn, n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn(i / (n - 1) * 2 - 1);
  return c;
}

// Render colour FX for a style. Returns Float32Array.
async function renderFx(x, sr, style) {
  const tail = { classic: 0.5, squirrel: 0.4, monster: 1.6, robot: 0.9, helium: 0.5, slow: 1.4 }[style] || 0.5;
  const len = x.length + Math.round(sr * tail);
  let ctx;
  try { ctx = new OAC(1, len, sr); } catch (e) { return x; }
  const buf = ctx.createBuffer(1, x.length, sr); buf.getChannelData(0).set(x);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const out = ctx.createGain(); out.connect(ctx.destination);
  const dry = ctx.createGain(); dry.connect(out);
  const bq = (type, f, g = 0, q = 0.7) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.gain.value = g; n.Q.value = q; return n; };
  const reverb = (sec, decay, wet, bright = 0.6) => {
    const cv = ctx.createConvolver(); cv.buffer = makeImpulse(ctx, sec, decay, bright);
    const g = ctx.createGain(); g.gain.value = wet; cv.connect(g); g.connect(out); return cv;
  };
  const echo = (time, fb, wet) => {
    const d = ctx.createDelay(2); d.delayTime.value = time;
    const f = ctx.createGain(); f.gain.value = fb; const w = ctx.createGain(); w.gain.value = wet;
    d.connect(f); f.connect(d); d.connect(w); w.connect(out); return d;
  };
  const chain = (...nodes) => { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; };

  if (style === 'classic') {
    const end = chain(src, bq('highpass', 120), bq('highshelf', 3500, 4));
    end.connect(dry); end.connect(reverb(0.6, 3, 0.18, 0.5));
  } else if (style === 'squirrel') {
    const end = chain(src, bq('highpass', 180), bq('peaking', 2500, 3, 1));
    end.connect(dry); end.connect(echo(0.09, 0.25, 0.18));
  } else if (style === 'monster') {
    const drive = ctx.createWaveShaper(); drive.oversample = '4x';
    drive.curve = shaperCurve(v => Math.tanh(v * 2.5) / Math.tanh(2.5));
    const pre = ctx.createGain(); pre.gain.value = 1.0;
    const end = chain(src, bq('lowshelf', 180, 8), pre, drive, bq('lowpass', 3200, 0, 0.9), bq('peaking', 700, -3, 1));
    dry.gain.value = 0.8;
    end.connect(dry); end.connect(reverb(1.6, 2.5, 0.35, 0.3)); end.connect(echo(0.26, 0.3, 0.15));
  } else if (style === 'robot') {
    // ring modulation: signal * (0.35 + 0.65*sin) — keeps some dry for intelligibility
    const ring = ctx.createGain(); ring.gain.value = 0.35;
    const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = 52;
    const depth = ctx.createGain(); depth.gain.value = 0.65; osc.connect(depth); depth.connect(ring.gain);
    const crush = ctx.createWaveShaper();
    const steps = 2 ** 5; crush.curve = shaperCurve(v => Math.round(v * steps) / steps, 4096);
    const end = chain(src, bq('highpass', 160), ring, crush, bq('peaking', 1800, 5, 1.5));
    end.connect(dry);
    end.connect(echo(0.018, 0.55, 0.45));   // metallic comb
    end.connect(echo(0.24, 0.28, 0.2));     // robot echo
    osc.start(0);
  } else if (style === 'helium') {
    const end = chain(src, bq('highpass', 220), bq('highshelf', 4000, 3));
    end.connect(dry); end.connect(reverb(0.5, 3, 0.12, 0.7));
  } else if (style === 'slow') {
    const end = chain(src, bq('lowpass', 4500), bq('lowshelf', 200, 3));
    end.connect(dry); end.connect(reverb(1.2, 2.2, 0.25, 0.4)); end.connect(echo(0.32, 0.3, 0.2));
  } else {
    src.connect(dry);
  }
  src.start(0);
  let rendered;
  try {
    rendered = await new Promise((res, rej) => {
      ctx.oncomplete = (e) => res(e.renderedBuffer);
      const p = ctx.startRendering();
      if (p && p.then) p.then(res, rej);
    });
  } catch (e) { return x; }
  let y = new Float32Array(rendered.getChannelData(0));
  if (style === 'robot') {   // sample-rate reduction (sample & hold) for the bitcrush grit
    const hold = Math.max(2, Math.round(sr / 11025));
    for (let i = 0; i < y.length; i++) if (i % hold) y[i] = y[i - (i % hold)];
  }
  return y;
}

function finish(y, sr) {
  // trim trailing near-silence of the fx tail, normalise, short fades
  let end = y.length;
  const pk = y.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  while (end > 1 && Math.abs(y[end - 1]) < pk * 0.002) end--;
  y = y.subarray(0, Math.min(y.length, end + Math.round(sr * 0.02)));
  const g = Math.min(8, 0.9 / pk);
  const fade = Math.min(Math.round(sr * 0.01), y.length >> 1);
  const o = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) {
    let w = 1; if (i < fade) w = i / fade; else if (i > y.length - fade) w = (y.length - i) / fade;
    o[i] = y[i] * g * w;
  }
  return o;
}

// The heavy, pure DSP part (resample + pitch tracking + PSOLA). Runs in a Worker when it can.
function shiftSync(raw, sr, def) {
  let x = resample(raw, def.resample);
  let monoF0 = 0;
  const tr = trackPitch(x, sr);
  if (def.mono) { const m = medianF0(tr); monoF0 = m ? Math.max(90, Math.min(220, m * def.mono)) : 110; }
  return psola(x, sr, { pitch: def.pitch, stretch: def.stretch, monoF0 }, tr);
}
function voicedSecSync(raw, sr) {
  const tr = trackPitch(raw, sr); let nv = 0; for (const f of tr.f0) if (f > 0) nv++;
  return nv * tr.hopSamples / sr;
}

// Blob-URL worker built from the same functions (they only use Math and typed arrays).
let dspWorker = null, dspFailed = false, dspSeq = 0;
const dspWait = new Map();
function getWorker() {
  if (dspWorker || dspFailed) return dspWorker;
  try {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') throw new Error('no worker');
    const src = [rmsOf, lowpassFIR, resample, trackPitch, medianF0, psola, shiftSync, voicedSecSync]
      .map(f => f.toString().replace(/^export\s+/, '')).join('\n') + `
self.onmessage = (e) => {
  const { id, op, raw, sr, def } = e.data;
  try {
    if (op === 'voiced') self.postMessage({ id, value: voicedSecSync(raw, sr) });
    else { const y = shiftSync(raw, sr, def); const out = y === raw ? y.slice() : y; self.postMessage({ id, value: out }, [out.buffer]); }
  } catch (err) { self.postMessage({ id, error: String(err) }); }
};`;
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    dspWorker = new Worker(url); URL.revokeObjectURL(url);
    dspWorker.onmessage = (e) => { const w = dspWait.get(e.data.id); if (!w) return; dspWait.delete(e.data.id); e.data.error ? w.rej(new Error(e.data.error)) : w.res(e.data.value); };
    dspWorker.onerror = () => { dspFailed = true; try { dspWorker.terminate(); } catch (e) {} dspWorker = null; for (const w of dspWait.values()) w.rej(new Error('worker')); dspWait.clear(); };
  } catch (e) { dspFailed = true; dspWorker = null; }
  return dspWorker;
}
async function dsp(op, raw, sr, def) {
  const w = getWorker();
  if (w) {
    try {
      return await new Promise((res, rej) => {
        const id = ++dspSeq; dspWait.set(id, { res, rej });
        const copy = raw.slice();   // transfer a copy: the caller keeps its array (replay)
        w.postMessage({ id, op, raw: copy, sr, def }, [copy.buffer]);
      });
    } catch (e) { /* fall through to the main thread */ }
  }
  return op === 'voiced' ? voicedSecSync(raw, sr) : shiftSync(raw, sr, def);
}

// Full style pipeline on raw mono samples. Exported for tests / debug.
export async function processVoice(raw, sr, style = 'classic', { fx = true } = {}) {
  const def = STYLE_DEF[style] || STYLE_DEF.classic;
  // fixed input level, so the drive/FX character does not depend on mic gain (AGC)
  { let pk = 0; for (let i = 0; i < raw.length; i++) { const a = Math.abs(raw[i]); if (a > pk) pk = a; }
    if (pk > 1e-4) { const g = 0.3 / pk, r2 = new Float32Array(raw.length); for (let i = 0; i < raw.length; i++) r2[i] = raw[i] * g; raw = r2; } }
  let x = await dsp('shift', raw, sr, def);
  if (!fx) return x;
  x = await renderFx(x, sr, style);
  return finish(x, sr);
}

// ---------------------------------------------------------------- the voice object

export function createVoice({ onState = () => {}, onLevel = () => {}, onMicLevel = null } = {}) {
  const isSupported = !!(AC && typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  let ctx = null, outGain = null, analyser = null, streamDest = null;
  let stream = null, micSrc = null, capNode = null, sink = null, track = null;
  let style = 'classic', active = false, state = 'idle', destroyed = false;
  let playing = null, muted = false, ignoreUntil = 0, lastRaw = null, levelRaf = 0;
  // VAD state
  let floor = 0.004, loudRun = 0, hearing = false, preroll = [], prerollLen = 0;
  let rec = [], recLen = 0, voicedEnd = 0, voicedStart = 0, samplesSeen = 0;
  let holdUntil = 0, needQuiet = 0, bgPaused = false, lvls = [], checking = false;

  const setState = (s, info) => { if (state === s && !info) return; state = s; try { onState(s, info); } catch (e) { console.error(e); } };

  function ensureCtx() {
    if (ctx) return ctx;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
    outGain = ctx.createGain();
    analyser = ctx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.2;
    outGain.connect(analyser); analyser.connect(ctx.destination);
    if (ctx.createMediaStreamDestination) { streamDest = ctx.createMediaStreamDestination(); outGain.connect(streamDest); }
    ctx.onstatechange = () => { if (ctx && ctx.state !== 'running' && ctx.state !== 'closed' && active) ctx.resume().catch(() => {}); };
    return ctx;
  }
  // iOS: unlock with a silent buffer inside the gesture
  function unlock() {
    ensureCtx();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    try { const b = ctx.createBuffer(1, 1, ctx.sampleRate), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); } catch (e) {}
  }
  const onVis = () => {
    // background tab / app switch: stop listening (mic indicator stays, but nothing is heard or repeated)
    if (document.hidden) { bgPaused = true; resetVad(); if (track) track.enabled = false; if (state === 'hearing') setState('listening'); return; }
    bgPaused = false;
    if (track && !playing && !muted) track.enabled = true;
    if (ctx) { ignoreUntil = ctx.currentTime + 0.3; needQuiet = VAD.quietChunks; }
    if (ctx && ctx.state !== 'running' && (active || playing)) ctx.resume().catch(() => {});
  };
  const onGesture = () => { if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('touchend', onGesture, { passive: true });
    document.addEventListener('pointerdown', onGesture, { passive: true });
  }

  function resetVad() {
    loudRun = 0; hearing = false; preroll = []; prerollLen = 0; rec = []; recLen = 0;
  }

  function onChunk(c) {
    if (!active || muted || playing || bgPaused || checking) return;
    const sr = ctx.sampleRate;
    samplesSeen += c.length;
    if (ctx.currentTime < ignoreUntil) return;
    if (!hearing && ctx.currentTime < holdUntil) { loudRun = 0; preroll = []; prerollLen = 0; return; }   // own SFX playing
    const lvl = rmsOf(c);
    if (onMicLevel) { try { onMicLevel(Math.min(1, lvl * 8)); } catch (e) {} }
    const startThr = Math.max(floor * 3.2, VAD.minStart);
    const contThr = Math.max(floor * 2, VAD.minCont);
    if (!hearing) {
      // adaptive noise floor: falls fast, rises slowly (~2 s)
      floor += (lvl - floor) * (lvl < floor ? 0.25 : 0.012);
      floor = Math.min(0.2, Math.max(0.0005, floor));
      preroll.push(c); prerollLen += c.length;
      while (preroll.length > 1 && prerollLen - preroll[0].length >= VAD.prerollSec * sr) prerollLen -= preroll.shift().length;
      if (needQuiet > 0) { needQuiet = lvl < startThr ? needQuiet - 1 : VAD.quietChunks; loudRun = 0; return; }
      loudRun = lvl > startThr ? loudRun + 1 : 0;
      if (loudRun >= VAD.startChunks) {
        lvls = [];
        hearing = true;
        rec = preroll; recLen = prerollLen; preroll = []; prerollLen = 0;
        voicedStart = recLen - loudRun * c.length; voicedEnd = recLen;
        setState('hearing');
      }
      return;
    }
    rec.push(c); recLen += c.length; lvls.push(lvl);
    if (lvl > contThr) voicedEnd = recLen;
    const silent = (recLen - voicedEnd) / sr;
    if (silent >= VAD.silenceSec || recLen / sr >= VAD.maxSec) endUtterance();
  }

  function endUtterance() {
    const sr = ctx.sampleRate;
    const voicedSec = (voicedEnd - voicedStart) / sr;
    const keep = Math.min(recLen, voicedEnd + Math.round(VAD.tailSec * sr));
    const chunks = rec, capped = recLen / sr >= VAD.maxSec, lv = lvls; resetVad();
    if (voicedSec < VAD.minSec) { setState('listening'); return; }
    if (capped) {   // 10 s with no pause: speech has syllable dips, TV/music/fan does not
      const s = lv.slice().sort((a, b) => a - b), med = s[s.length >> 1];
      const dips = lv.filter(l => l < med * 0.25).length / lv.length;
      if (dips < 0.06) { floor = Math.min(0.2, med); needQuiet = VAD.quietChunks; setState('listening'); return; }
    }
    const raw = new Float32Array(keep); let o = 0;
    for (const ch of chunks) { if (o >= keep) break; const n = Math.min(ch.length, keep - o); raw.set(ch.subarray(0, n), o); o += n; }
    // knocks, claps, taps on the phone: no voicing (checked off the main thread)
    checking = true;
    dsp('voiced', raw, sr).then((vs) => {
      checking = false;
      if (destroyed) return;
      if (vs < 0.12 || !active) { needQuiet = VAD.quietChunks; setState(active ? 'listening' : 'idle'); return; }
      lastRaw = raw;
      speak(raw);
    }, () => { checking = false; lastRaw = raw; speak(raw); });
  }

  function muteMic(on) {
    muted = on;
    if (track) track.enabled = !on;
  }

  async function speak(buffer) {
    ensureCtx();
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) {} }
    const sr = ctx.sampleRate;
    let raw;
    if (!buffer) raw = lastRaw;
    else if (buffer instanceof Float32Array) raw = buffer;
    else if (buffer.getChannelData) {
      raw = buffer.getChannelData(0);
      if (buffer.sampleRate !== sr) raw = resample(raw, buffer.sampleRate / sr);
    }
    if (!raw || !raw.length) return;
    if (playing) { try { playing.onended = null; playing.stop(); } catch (e) {} playing = null; }
    muteMic(true); resetVad();
    setState('talking');
    const y = await processVoice(raw, sr, style);
    if (destroyed) return;
    const b = ctx.createBuffer(1, y.length, sr); b.getChannelData(0).set(y);
    const src = ctx.createBufferSource(); src.buffer = b; src.connect(outGain);
    playing = src;
    voice._debug.lastOut = y;
    await new Promise((res) => {
      src.onended = res;
      src.start();
      const td = new Float32Array(analyser.fftSize);
      let lv = 0;
      const tick = () => {
        if (playing !== src) return;
        analyser.getFloatTimeDomainData(td);
        const r = rmsOf(td);
        const target = Math.min(1, Math.pow(r * 4.5, 0.75));
        lv += (target - lv) * (target > lv ? 0.6 : 0.25);
        try { onLevel(lv); } catch (e) {}
        levelRaf = requestAnimationFrame(tick);
      };
      tick();
    });
    if (playing === src) playing = null;
    cancelAnimationFrame(levelRaf);
    try { onLevel(0); } catch (e) {}
    if (destroyed) return;
    // let the reverb/room settle before the mic listens again
    await new Promise(r => setTimeout(r, 250));
    if (playing) return;
    muteMic(bgPaused);
    ignoreUntil = ctx.currentTime + 0.15; needQuiet = VAD.quietChunks;
    setState(active ? 'listening' : 'idle');
  }

  async function start() {
    if (destroyed) return false;
    if (!isSupported) { setState('denied', { reason: 'unsupported' }); return false; }
    unlock();                       // synchronous part, inside the user gesture
    if (active) { setState(playing ? 'talking' : 'listening'); return true; }
    try {
      if (!stream) {
        // iOS 17+: keep output on the loudspeaker while the mic is open
        try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (e) {}
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
        track = stream.getAudioTracks()[0];
        micSrc = ctx.createMediaStreamSource(stream);
        sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
        capNode = null;
        if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
          try {
            const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
            await ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
            capNode = new AudioWorkletNode(ctx, 'uni-cap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
            capNode.port.onmessage = (e) => onChunk(e.data);
          } catch (e) { capNode = null; }
        }
        if (!capNode) {   // older iOS / Safari: ScriptProcessor fallback
          capNode = ctx.createScriptProcessor(1024, 1, 1);
          capNode.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
        }
        micSrc.connect(capNode); capNode.connect(sink);
        track.onended = () => { if (active) { active = false; resetVad(); releaseMic(); setState('denied', { reason: 'ended' }); } };
      }
      if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) {} }
      active = true; resetVad(); muteMic(!!playing);
      ignoreUntil = ctx.currentTime + 0.2; needQuiet = VAD.quietChunks;
      setState(playing ? 'talking' : 'listening');
      return true;
    } catch (err) {
      active = false;
      setState('denied', { reason: !err ? 'error' : (err.name === 'NotAllowedError' || err.name === 'SecurityError') ? 'denied' : (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') ? 'nodevice' : (err.name === 'NotReadableError' || err.name === 'AbortError') ? 'busy' : 'error', error: err });
      return false;
    }
  }

  function releaseMic() {
    try { micSrc && micSrc.disconnect(); capNode && capNode.disconnect(); sink && sink.disconnect(); } catch (e) {}
    if (capNode && capNode.port) capNode.port.onmessage = null;
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = micSrc = capNode = sink = track = null;
  }

  function stop() {
    active = false; resetVad(); releaseMic();
    if (!playing) setState('idle');
  }

  function setStyle(name) { if (STYLE_DEF[name]) style = name; return style; }

  function captureStream() { ensureCtx(); return streamDest ? streamDest.stream : null; }

  function destroy() {
    destroyed = true; active = false;
    if (playing) { try { playing.stop(); } catch (e) {} playing = null; }
    cancelAnimationFrame(levelRaf);
    releaseMic();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('touchend', onGesture);
      document.removeEventListener('pointerdown', onGesture);
    }
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
  }

  // the page's own sounds (SFX, snore) must not be heard as speech: call with the sound's duration
  function holdOff(sec) { if (ctx) holdUntil = Math.max(holdUntil, ctx.currentTime + sec); }

  const voice = {
    start, stop, setStyle, speak, destroy, captureStream, holdOff,
    styles: STYLE_LIST.map(s => ({ ...s })),
    isSupported,
    get style() { return style; },
    get state() { return state; },
    get active() { return active; },
    get context() { return ensureCtx(); },          // for SFX that should land in the clip
    get captureNode() { ensureCtx(); return streamDest; },
    get hasRecording() { return !!lastRaw; },
    recorderMime: pickRecorderMime,
    _debug: { get lastRaw() { return lastRaw; }, lastOut: null, get floor() { return floor; }, processVoice, trackPitch },
  };
  return voice;
}

export default createVoice;
