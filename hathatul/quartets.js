// רביעיות (Quartets) – game rules with a regular deck. Pure state machine, runs on the host.
// A quartet is all four suits of one rank. On your turn you ask another player for a rank you
// hold; if they have it they give you every card of that rank and you ask again, otherwise the
// turn passes to the next player. Complete quartets are laid down automatically. A player with
// no cards left is out. When every quartet is down, whoever has the most wins.

import { shuffle, fairOrder } from './util.js?v=20';

export const RANKS = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
export const SUITS = ['♠', '♥', '♦', '♣'];
export const RANK_NAMES = {
  A: { one: 'אס', many: 'אסים' },
  K: { one: 'מלך', many: 'מלכים' },
  Q: { one: 'מלכה', many: 'מלכות' },
  J: { one: 'נסיך', many: 'נסיכים' },
};
export const rankMany = r => RANK_NAMES[r]?.many || `קלפי ${r}`;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
// About 10 cards per player; always the aces and pictures, then numbers from 10 down.
const QUARTETS_FOR = { 2: 6, 3: 8, 4: 10, 5: 12, 6: 13 };

export function createGame(players, rnd = Math.random) {
  const state = {
    type: 'quartets',
    rnd,
    round: 0,
    players: players.map(p => ({ id: p.id, name: p.name, hand: [], quartets: [], wins: 0 })),
    events: [],
    eventSeq: 0,
  };
  deal(state);
  return state;
}

function emit(state, ev) {
  state.events.push({ ...ev, id: ++state.eventSeq });
  if (state.events.length > 12) state.events.shift();
}

function deal(state) {
  state.round++;
  state.ranks = RANKS.slice(0, QUARTETS_FOR[state.players.length] || 13);
  const deck = shuffle(state.ranks.flatMap(rank => SUITS.map(suit => ({ rank, suit }))), state.rnd);
  state.order = fairOrder(state);
  for (const p of state.players) { p.hand = []; p.quartets = []; }
  // Deal everything, one at a time, starting with the first player in the order.
  deck.forEach((c, i) => state.players[state.order[i % state.order.length]].hand.push(c));
  state.phase = 'play';
  state.turn = state.order[0];
  state.last = null;
  state.results = null;
  emit(state, { type: 'deal' });
  state.players.forEach((_, pi) => layQuartets(state, pi));
  checkEnd(state);
}

const isOut = p => p.hand.length === 0;

function layQuartets(state, pi) {
  const p = state.players[pi];
  for (const rank of state.ranks) {
    if (p.hand.filter(c => c.rank === rank).length === 4) {
      p.hand = p.hand.filter(c => c.rank !== rank);
      p.quartets.push(rank);
      emit(state, { type: 'quartet', pi, rank });
    }
  }
}

function nextTurn(state) {
  const n = state.order.length;
  let pos = state.order.indexOf(state.turn);
  for (let k = 0; k < n; k++) {
    pos = (pos + 1) % n;
    if (!isOut(state.players[state.order[pos]])) { state.turn = state.order[pos]; return; }
  }
}

function checkEnd(state) {
  const laid = state.players.reduce((s, p) => s + p.quartets.length, 0);
  if (laid < state.ranks.length) {
    if (isOut(state.players[state.turn])) nextTurn(state);
    return;
  }
  state.phase = 'end';
  const best = Math.max(...state.players.map(p => p.quartets.length));
  state.results = state.players.map(p => ({ id: p.id, name: p.name, quartets: p.quartets.length, winner: p.quartets.length === best }));
  state.players.forEach(p => { if (p.quartets.length === best) p.wins++; });
  emit(state, { type: 'end' });
}

// Applies an action by playerId. Returns { error } or { privates: [] }.
export function applyAction(state, playerId, action) {
  const pi = state.players.findIndex(p => p.id === playerId);
  if (pi < 0) return { error: 'שחקן לא מוכר' };
  if (action.type === 'nextRound') {
    if (state.phase !== 'end') return { error: 'המשחק עוד לא נגמר' };
    deal(state);
    return { privates: [] };
  }
  if (action.type !== 'ask') return { error: 'פעולה לא מוכרת' };
  if (state.phase !== 'play') return { error: 'המשחק לא פעיל' };
  if (state.turn !== pi) return { error: 'זה לא התור שלך' };
  const me = state.players[pi];
  const ti = action.target;
  const target = state.players[ti];
  if (!target || ti === pi) return { error: 'בחרו שחקן אחר' };
  if (isOut(target)) return { error: `ל${target.name} כבר אין קלפים` };
  if (!me.hand.some(c => c.rank === action.rank)) return { error: 'אפשר לבקש רק ערך שיש לכם ביד' };

  const given = target.hand.filter(c => c.rank === action.rank);
  target.hand = target.hand.filter(c => c.rank !== action.rank);
  me.hand.push(...given);
  state.last = { from: pi, to: ti, rank: action.rank, got: given.length };
  emit(state, { type: 'ask', from: pi, to: ti, rank: action.rank, got: given.length });
  layQuartets(state, pi);
  for (const [i, p] of [[ti, target], [pi, me]]) if (isOut(p) && state.phase === 'play') emit(state, { type: 'out', pi: i });
  if (!given.length) nextTurn(state);
  checkEnd(state);
  return { privates: [] };
}

// Redacted view for one player: your own cards, everyone's card count and laid quartets.
export function viewFor(state, playerId, { revealAll = false } = {}) {
  const me = state.players.findIndex(p => p.id === playerId);
  const sortHand = h => h.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank) || SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit));
  return {
    type: 'quartets',
    round: state.round,
    phase: state.phase,
    me,
    turn: state.turn,
    order: state.order,
    ranks: state.ranks,
    players: state.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      count: p.hand.length,
      hand: i === me || revealAll ? sortHand(p.hand) : null,
      quartets: p.quartets,
      wins: p.wins,
      out: isOut(p),
    })),
    last: state.last,
    results: state.results,
    events: state.events,
  };
}
