// המתחזה (Imposter) – rules. Pure state machine, runs on the host.
// Everyone gets the same secret word except 1–2 imposters, who get one hint instead. Players
// give one clue each in turn, then vote for who they think the imposter is. A caught imposter
// gets a last chance: guess the word from 8 options.

import { shuffle, fairOrder } from './util.js?v=26';
import { WORDS } from './imposter-words.js?v=26';

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 6;
export const maxImposters = n => (n >= 5 ? 2 : 1);
const RECENT_KEEP = 60; // when the whole list is used up, still avoid the last few dozen words
const GUESS_OPTIONS = 8;
const MAX_CLUE_LEN = 24;

// ---------- Hebrew text helpers (clue checks) ----------
const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
export function normalize(s) {
  return String(s || '')
    .replace(/[֑-ׇ]/g, '') // niqqud / cantillation
    .replace(/[^א-תa-zA-Z0-9\s]/g, ' ')
    .replace(/[ךםןףץ]/g, c => FINALS[c])
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
const PREFIXES = 'והבכלמש';
// A clue "contains" the word if any token, with up to two prefix letters removed (ה, ו, ב, ל…),
// is the word or contains it; or the whole clue without spaces contains it (multi-word words).
export function clueRevealsWord(clue, word) {
  const w = normalize(word).replace(/ /g, '');
  const c = normalize(clue);
  if (!w || !c) return false;
  if (c.replace(/ /g, '').includes(w)) return true;
  for (const tok of c.split(' ')) {
    const variants = [tok];
    if (PREFIXES.includes(tok[0])) variants.push(tok.slice(1));
    if (PREFIXES.includes(tok[0]) && PREFIXES.includes(tok[1])) variants.push(tok.slice(2));
    for (const v of variants) if (v === w || (w.length >= 3 && v.includes(w))) return true;
  }
  return false;
}

// ---------- game ----------
export function createGame(players, rnd = Math.random, { used = [] } = {}) {
  if (players.length < MIN_PLAYERS) throw new Error('need at least 3 players');
  const n = players.length;
  return {
    type: 'imposter',
    rnd,
    round: 0,
    players: players.map(p => ({ id: p.id, name: p.name, score: 0, timesImposter: 0 })),
    settings: { imposters: 1, clueRounds: 1 },
    used: used.filter(i => Number.isInteger(i) && i >= 0 && i < WORDS.length),
    phase: 'setup',
    turn: 0,
    k: 1,
    events: [],
    eventSeq: 0,
    lastImposters: [],
    n,
  };
}

function emit(state, ev) {
  state.events.push({ ...ev, id: ++state.eventSeq });
  if (state.events.length > 16) state.events.shift();
}

function pickWord(state) {
  const usedSet = new Set(state.used);
  let pool = WORDS.map((_, i) => i).filter(i => !usedSet.has(i));
  if (!pool.length) {
    // every word was played: start over, but not with the most recent ones
    state.used = state.used.slice(-Math.min(RECENT_KEEP, Math.floor(WORDS.length / 2))); // a short list must still leave words
    const recent = new Set(state.used);
    pool = WORDS.map((_, i) => i).filter(i => !recent.has(i));
  }
  const idx = pool[Math.floor(state.rnd() * pool.length)];
  state.used.push(idx);
  return idx;
}

// Weighted draw without replacement: people who were the imposter less often are likelier,
// and last round's imposters are much less likely to be picked again right away.
function pickImposters(state, k) {
  const chosen = [];
  const cand = state.players.map((p, i) => i);
  for (let j = 0; j < k; j++) {
    const left = cand.filter(i => !chosen.includes(i));
    const minTimes = Math.min(...left.map(i => state.players[i].timesImposter));
    const weights = left.map(i => {
      const extra = state.players[i].timesImposter - minTimes;
      let w = 1 / (1 + extra) ** 2;
      if (state.lastImposters.includes(i)) w *= 0.25;
      return w;
    });
    let r = state.rnd() * weights.reduce((a, b) => a + b, 0);
    let pick = left[left.length - 1];
    for (let t = 0; t < left.length; t++) { r -= weights[t]; if (r <= 0) { pick = left[t]; break; } }
    chosen.push(pick);
  }
  return chosen;
}

function newRound(state) {
  const n = state.players.length;
  state.round++;
  state.k = Math.min(state.settings.imposters, maxImposters(n));
  state.wordIdx = pickWord(state);
  state.imposters = pickImposters(state, state.k);
  state.lastImposters = state.imposters.slice();
  for (const i of state.imposters) state.players[i].timesImposter++;
  // each imposter gets a different hint, so two imposters can't recognise each other by it
  const hintOrder = shuffle([0, 1, 2, 3, 4], state.rnd);
  state.hints = Object.fromEntries(state.imposters.map((pi, j) => [pi, hintOrder[j]]));
  // speaking order: the fair rotation; if an imposter would open, usually let a regular player start
  let order = fairOrder(state);
  if (state.imposters.includes(order[0]) && state.rnd() < 0.65) {
    const first = order.findIndex(i => !state.imposters.includes(i));
    order = order.slice(first).concat(order.slice(0, first));
  }
  state.order = order;
  state.seen = [];
  state.clues = []; // [{ pi, text, spoken?, skipped? }]
  state.votes = {}; // pi -> [targets]
  state.revote = null; // { among: [pi], fixed: [pi], slots }
  state.accused = [];
  state.guesses = {}; // pi -> chosen word
  state.options = null;
  state.result = null;
  state.phase = 'reveal';
  setTurn(state);
  emit(state, { type: 'round' });
}

const totalTurns = state => state.settings.clueRounds * state.order.length;

function setTurn(state) {
  const n = state.players.length;
  if (state.phase === 'reveal') state.turn = [...Array(n).keys()].find(i => !state.seen.includes(i)) ?? 0;
  else if (state.phase === 'clues') state.turn = state.order[state.clues.length % state.order.length];
  else if (state.phase === 'vote') state.turn = voters(state).find(i => !state.votes[i]) ?? 0;
  else if (state.phase === 'guess') state.turn = state.accused.find(i => state.imposters.includes(i) && !state.guesses[i]) ?? 0;
  else state.turn = 0;
}

const voters = state => state.players.map((_, i) => i);
const slotsNow = state => (state.revote ? state.revote.slots : state.k);
const candidatesNow = (state, voter) => (state.revote ? state.revote.among : state.players.map((_, i) => i)).filter(i => i !== voter);

function tally(state) {
  const count = new Map();
  for (const ts of Object.values(state.votes)) for (const t of ts) count.set(t, (count.get(t) || 0) + 1);
  const slots = slotsNow(state);
  const ranked = [...count.entries()].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  const fixed = state.revote ? state.revote.fixed.slice() : [];
  if (ranked.length <= slots) return finishVote(state, fixed.concat(ranked.map(([pi]) => pi)));
  const cutoff = ranked[slots - 1][1];
  const above = ranked.filter(([, c]) => c > cutoff).map(([pi]) => pi);
  const atCut = ranked.filter(([, c]) => c === cutoff).map(([pi]) => pi);
  const free = slots - above.length;
  if (atCut.length <= free) return finishVote(state, fixed.concat(above, atCut));
  if (!state.revote) {
    // tie at the cut-off: one revote, only among the tied players
    state.revote = { among: atCut, fixed: fixed.concat(above), slots: free };
    state.votes = {};
    emit(state, { type: 'revote', among: atCut });
    setTurn(state);
    return;
  }
  // tied again: the tied players are not accused (the imposter slipped through the confusion)
  finishVote(state, fixed.concat(above));
}

function finishVote(state, accused) {
  state.accused = accused;
  state.finalVotes = state.finalVotes || {};
  const caught = accused.filter(i => state.imposters.includes(i));
  if (caught.length) {
    // last chance: guess the word among 8 options from the same category where possible
    const word = WORDS[state.wordIdx];
    const same = shuffle(WORDS.map((w, i) => i).filter(i => i !== state.wordIdx && WORDS[i].c === word.c), state.rnd);
    const other = shuffle(WORDS.map((w, i) => i).filter(i => i !== state.wordIdx && WORDS[i].c !== word.c), state.rnd);
    const picks = same.concat(other).slice(0, GUESS_OPTIONS - 1).map(i => WORDS[i].w);
    state.options = shuffle([word.w, ...picks], state.rnd);
    state.phase = 'guess';
    emit(state, { type: 'caught', who: caught });
    setTurn(state);
  } else {
    score(state);
  }
}

function score(state) {
  const word = WORDS[state.wordIdx].w;
  const deltas = state.players.map(() => 0);
  const final = state.allVotes;
  state.players.forEach((p, i) => {
    if (state.imposters.includes(i)) {
      if (!state.accused.includes(i)) deltas[i] += 3;
      else if (state.guesses[i] === word) deltas[i] += 2;
    } else {
      for (const t of final[i] || []) if (state.imposters.includes(t)) deltas[i] += 1;
    }
  });
  deltas.forEach((d, i) => { state.players[i].score += d; });
  const caught = state.imposters.filter(i => state.accused.includes(i));
  const guessed = caught.filter(i => state.guesses[i] === word);
  state.result = {
    deltas,
    caught,
    guessed,
    wrongAccused: state.accused.filter(i => !state.imposters.includes(i)),
    outcome: caught.length === 0 ? 'imposters' : guessed.length === caught.length && caught.length === state.imposters.length ? 'stolen' : caught.length === state.imposters.length ? 'citizens' : 'mixed',
  };
  state.phase = 'result';
  setTurn(state);
  emit(state, { type: 'result' });
}

export function applyAction(state, playerId, action) {
  const pi = state.players.findIndex(p => p.id === playerId);
  if (pi < 0) return { error: 'שחקן לא מוכר' };
  const ok = { privates: [] };
  const n = state.players.length;

  switch (action.type) {
    case 'settings': { // host
      if (state.phase !== 'setup' && state.phase !== 'result') return { error: 'אפשר לשנות הגדרות רק בין סבבים' };
      const imp = Number(action.imposters), cr = Number(action.clueRounds);
      if (imp) state.settings.imposters = Math.max(1, Math.min(imp, maxImposters(n)));
      if (cr) state.settings.clueRounds = Math.max(1, Math.min(cr, 3));
      return ok;
    }
    case 'toSetup': // host: back to the settings between rounds
      if (state.phase !== 'result') return { error: 'אפשר רק בין סבבים' };
      state.phase = 'setup';
      return ok;
    case 'start': case 'nextRound': // host
      if (state.phase !== 'setup' && state.phase !== 'result') return { error: 'הסבב עוד לא נגמר' };
      newRound(state);
      return ok;
    case 'seen':
      if (state.phase !== 'reveal') return ok; // harmless repeat
      if (!state.seen.includes(pi)) state.seen.push(pi);
      if (state.seen.length === n) { state.phase = 'clues'; emit(state, { type: 'cluesStart' }); }
      setTurn(state);
      return ok;
    case 'clue': case 'skip': {
      if (state.phase !== 'clues') return { error: 'זה לא שלב הרמזים' };
      const speaker = state.order[state.clues.length % state.order.length];
      if (action.type === 'clue' && speaker !== pi) return { error: 'זה לא התור שלך' };
      let entry;
      if (action.type === 'skip') entry = { pi: speaker, skipped: true };
      else {
        const text = String(action.text || '').trim().replace(/\s+/g, ' ');
        if (!text) entry = { pi, spoken: true }; // said out loud, not typed
        else {
          if (text.length > MAX_CLUE_LEN || text.split(' ').length > 3) return { error: 'רמז קצר בבקשה – עד 3 מילים' };
          const isImposter = state.imposters.includes(pi);
          // Only regular players are stopped from saying the word: rejecting an imposter's clue
          // would tell them they hit the secret word.
          if (!isImposter && clueRevealsWord(text, WORDS[state.wordIdx].w)) return { error: 'אסור להגיד את המילה עצמה 🙂' };
          if (state.clues.some(c => c.text && normalize(c.text) === normalize(text))) return { error: 'מישהו כבר אמר את זה – נסו משהו אחר' };
          entry = { pi, text };
        }
      }
      state.clues.push(entry);
      emit(state, { type: 'clue', pi: entry.pi });
      if (state.clues.length >= totalTurns(state)) {
        state.phase = 'vote';
        state.allVotes = {};
        emit(state, { type: 'voteStart' });
      }
      setTurn(state);
      return ok;
    }
    case 'vote': {
      if (state.phase !== 'vote') return { error: 'זה לא שלב ההצבעה' };
      const slots = slotsNow(state);
      const cand = candidatesNow(state, pi);
      const targets = [...new Set((action.targets || []).map(Number))];
      if (targets.length !== Math.min(slots, cand.length) || targets.some(t => !cand.includes(t))) {
        return { error: slots === 1 ? 'בחרו שחקן אחד' : `בחרו ${slots} שחקנים` };
      }
      state.votes[pi] = targets;
      state.allVotes[pi] = (state.revote ? (state.allVotes[pi] || []).filter(t => !state.revote.among.includes(t)) : []).concat(targets);
      emit(state, { type: 'voted', pi });
      if (voters(state).every(i => state.votes[i])) tally(state);
      else setTurn(state);
      return ok;
    }
    case 'closeVote': // host: someone left; count the votes that are in
      if (state.phase !== 'vote') return { error: 'אין הצבעה פתוחה' };
      if (!Object.keys(state.votes).length) return { error: 'עוד אף אחד לא הצביע' };
      tally(state);
      return ok;
    case 'guess': {
      if (state.phase !== 'guess') return { error: 'זה לא שלב הניחוש' };
      if (!state.accused.includes(pi) || !state.imposters.includes(pi)) return { error: 'רק המתחזה שנתפס מנחש' };
      if (state.guesses[pi]) return ok;
      if (!state.options.includes(action.word)) return { error: 'בחרו אחת מהאפשרויות' };
      state.guesses[pi] = action.word;
      emit(state, { type: 'guessed', pi, right: action.word === WORDS[state.wordIdx].w });
      const caught = state.accused.filter(i => state.imposters.includes(i));
      if (caught.every(i => state.guesses[i])) score(state);
      else setTurn(state);
      return ok;
    }
    case 'skipGuess': // host: the caught imposter left
      if (state.phase !== 'guess') return { error: 'אין ניחוש פתוח' };
      score(state);
      return ok;
  }
  return { error: 'פעולה לא מוכרת' };
}

// Only these actions may be sent by the room's host.
export const HOST_ACTIONS = ['settings', 'toSetup', 'start', 'nextRound', 'skip', 'closeVote', 'skipGuess'];

export function viewFor(state, playerId, { revealAll = false } = {}) {
  const me = state.players.findIndex(p => p.id === playerId);
  const done = state.phase === 'result';
  const word = state.wordIdx !== undefined ? WORDS[state.wordIdx] : null;
  const isImposter = !!state.imposters?.includes(me);
  const show = done || revealAll;
  return {
    type: 'imposter',
    round: state.round,
    phase: state.phase,
    me,
    turn: state.turn,
    order: state.order || state.players.map((_, i) => i),
    settings: state.settings,
    maxImposters: maxImposters(state.players.length),
    k: state.k,
    players: state.players.map((p, i) => ({
      id: p.id, name: p.name, score: p.score,
      seen: !!state.seen?.includes(i),
      voted: !!state.votes?.[i],
    })),
    // what this player is told
    role: state.phase === 'setup' ? null : isImposter ? 'imposter' : 'citizen',
    word: !word ? null : (!isImposter || show) ? word.w : null,
    category: word && (!isImposter || show) ? word.c : null,
    hint: isImposter && word ? word.h[state.hints[me]] : null,
    clues: state.clues || [],
    clueTurns: state.order ? totalTurns(state) : 0,
    revote: state.revote ? { among: state.revote.among, slots: state.revote.slots } : null,
    myVote: state.votes?.[me] || null,
    accused: state.phase === 'guess' || done ? state.accused : null,
    options: state.phase === 'guess' && state.accused.includes(me) && isImposter && !state.guesses[me] ? state.options : null,
    // full reveal at the end of the round (or in the test room)
    imposters: show ? state.imposters : null,
    hints: show ? Object.fromEntries(Object.entries(state.hints || {}).map(([pi, h]) => [pi, word.h[h]])) : null,
    votes: done ? state.allVotes : null,
    guesses: done ? state.guesses : null,
    result: done ? state.result : null,
    used: state.used,
    events: state.events,
  };
}
