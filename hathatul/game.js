// חתחתול – game rules. Pure state machine, runs on the host only.

export const POWERS = {
  peek: { label: 'הצצה', icon: '👁️' },
  swap: { label: 'החלפה', icon: '🔄' },
  draw2: { label: 'שלוף 2', icon: '✌️' },
};

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
const HAND_SIZE = 4;

export function buildDeck() {
  const deck = [];
  let id = 0;
  for (let v = 0; v <= 8; v++) for (let i = 0; i < 6; i++) deck.push({ id: id++, kind: 'num', value: v });
  for (let i = 0; i < 12; i++) deck.push({ id: id++, kind: 'num', value: 9 });
  for (const p of Object.keys(POWERS)) for (let i = 0; i < 5; i++) deck.push({ id: id++, kind: 'power', power: p });
  return deck;
}

function shuffle(a, rnd = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createGame(players, rnd = Math.random) {
  const state = {
    rnd,
    round: 0,
    starter: -1,
    players: players.map(p => ({ id: p.id, name: p.name, hand: [], total: 0 })),
    log: [],
    events: [],
    eventSeq: 0,
  };
  dealRound(state);
  return state;
}

function dealRound(state) {
  state.round++;
  state.starter = (state.starter + 1) % state.players.length;
  state.deck = shuffle(buildDeck(), state.rnd);
  state.discard = [];
  for (const p of state.players) p.hand = state.deck.splice(0, HAND_SIZE);
  // The first discard must be a number card.
  let i = state.deck.findIndex(c => c.kind === 'num');
  state.discard.push(state.deck.splice(i, 1)[0]);
  state.phase = 'peek';
  state.ready = new Set();
  state.turn = state.starter;
  state.turnsTaken = 0;
  state.pending = null;
  state.calledBy = null;
  state.results = null;
  state.highlight = null;
  emit(state, { type: 'deal' });
  addLog(state, `סיבוב ${state.round} מתחיל! כל אחד מציץ בשני הקלפים החיצוניים שלו.`);
}

// Events tell clients what just happened, so they can animate it. Contain only public info.
function emit(state, ev) {
  state.events.push({ ...ev, id: ++state.eventSeq });
  if (state.events.length > 12) state.events.shift();
}

function addLog(state, text) {
  state.log.push(text);
  if (state.log.length > 30) state.log.shift();
}

function drawFromDeck(state) {
  if (state.deck.length === 0) {
    const top = state.discard.pop();
    state.deck = shuffle(state.discard, state.rnd);
    state.discard = [top];
    emit(state, { type: 'reshuffle' });
    addLog(state, 'הקופה נגמרה – ערבבנו מחדש את ערימת הזריקה.');
  }
  return state.deck.shift();
}

const cardName = c => (c.kind === 'num' ? String(c.value) : POWERS[c.power].label);

function endTurn(state) {
  state.pending = null;
  state.turnsTaken++;
  state.turn = (state.turn + 1) % state.players.length;
  if (state.calledBy !== null && state.turn === state.calledBy) endRound(state);
}

function endRound(state) {
  state.phase = 'roundEnd';
  state.pending = null;
  const results = state.players.map(p => {
    // Power cards still in hand are replaced by number cards from the deck.
    p.hand = p.hand.map(c => {
      while (c.kind !== 'num') c = drawFromDeck(state);
      return c;
    });
    const score = p.hand.reduce((s, c) => s + c.value, 0);
    p.total += score;
    return { id: p.id, name: p.name, score, total: p.total };
  });
  const best = Math.min(...results.map(r => r.score));
  state.results = results.map(r => ({ ...r, winner: r.score === best }));
  emit(state, { type: 'roundEnd' });
  addLog(state, `הסיבוב נגמר! ${state.results.filter(r => r.winner).map(r => r.name).join(', ')} עם הכי מעט נקודות.`);
}

// Applies an action by playerId. Returns { error } or { privates: [{ to, msg }] }.
export function applyAction(state, playerId, action) {
  const pi = state.players.findIndex(p => p.id === playerId);
  if (pi < 0) return { error: 'שחקן לא מוכר' };
  const me = state.players[pi];
  const privates = [];

  if (action.type === 'ready') {
    if (state.phase !== 'peek') return { error: 'לא בשלב ההצצה' };
    state.ready.add(playerId);
    emit(state, { type: 'ready', pi });
    if (state.ready.size === state.players.length) {
      state.phase = 'play';
      addLog(state, `כולם מוכנים. ${state.players[state.turn].name} מתחיל/ה.`);
    }
    return { privates };
  }

  if (action.type === 'nextRound') {
    if (state.phase !== 'roundEnd') return { error: 'הסיבוב עוד לא נגמר' };
    dealRound(state);
    return { privates };
  }

  if (state.phase !== 'play') return { error: 'המשחק לא בשלב משחק' };
  if (state.turn !== pi) return { error: 'זה לא התור שלך' };
  const pend = state.pending;
  const validSlot = s => Number.isInteger(s) && s >= 0 && s < HAND_SIZE;

  switch (action.type) {
    case 'call': {
      if (pend) return { error: 'אפשר לקרוא חתחתול רק בתחילת התור' };
      if (state.calledBy !== null) return { error: 'מישהו כבר קרא חתחתול' };
      if (state.turnsTaken < state.players.length) return { error: 'אפשר לקרוא חתחתול רק אחרי סבב שלם' };
      state.calledBy = pi;
      emit(state, { type: 'call', pi });
      addLog(state, `${me.name} קרא/ה חתחתול! לכל השאר נשאר תור אחרון.`);
      state.highlight = null;
      endTurn(state);
      return { privates };
    }
    case 'drawDeck': {
      if (pend && pend.type !== 'draw2') return { error: 'כבר שלפת קלף' };
      const remaining = pend ? pend.remaining - 1 : 0;
      const card = drawFromDeck(state);
      emit(state, { type: 'draw', pi, source: 'deck' });
      state.pending = { type: 'drawn', card, source: 'deck', remaining };
      state.highlight = null;
      return { privates };
    }
    case 'takeDiscard': {
      if (pend) return { error: 'כבר שלפת קלף' };
      const top = state.discard[state.discard.length - 1];
      if (!top || top.kind !== 'num') return { error: 'אפשר לקחת מהערימה רק קלף מספר' };
      state.discard.pop();
      emit(state, { type: 'draw', pi, source: 'discard' });
      state.pending = { type: 'drawn', card: top, source: 'discard', remaining: 0 };
      state.highlight = null;
      addLog(state, `${me.name} לקח/ה ${top.value} מערימת הזריקה.`);
      return { privates };
    }
    case 'replace': {
      if (!pend || pend.type !== 'drawn' || pend.card.kind !== 'num') return { error: 'אין קלף מספר להחליף' };
      if (!validSlot(action.slot)) return { error: 'משבצת לא חוקית' };
      const old = me.hand[action.slot];
      me.hand[action.slot] = pend.card;
      state.discard.push(old);
      emit(state, { type: 'replace', pi, slot: action.slot });
      state.highlight = { players: [{ pi, slot: action.slot }] };
      addLog(state, `${me.name} החליף/ה קלף ${action.slot + 1} וזרק/ה ${cardName(old)}.`);
      endTurn(state);
      return { privates };
    }
    case 'discardDrawn': {
      if (!pend || pend.type !== 'drawn') return { error: 'אין קלף לזרוק' };
      if (pend.source === 'discard') return { error: 'קלף מערימת הזריקה חייב להיכנס ליד' };
      state.discard.push(pend.card);
      emit(state, { type: 'discard', pi });
      addLog(state, `${me.name} זרק/ה ${cardName(pend.card)}.`);
      if (pend.remaining > 0) {
        state.pending = { type: 'draw2', remaining: pend.remaining };
      } else {
        endTurn(state);
      }
      return { privates };
    }
    case 'usePower': {
      if (!pend || pend.type !== 'drawn' || pend.card.kind !== 'power') return { error: 'אין קלף כוח לשימוש' };
      const power = pend.card.power;
      state.discard.push(pend.card);
      emit(state, { type: 'power', pi, power });
      addLog(state, `${me.name} משתמש/ת ב${POWERS[power].label}.`);
      state.pending = power === 'draw2' ? { type: 'draw2', remaining: 2 } : { type: power };
      return { privates };
    }
    case 'peek': {
      if (!pend || pend.type !== 'peek') return { error: 'אין הצצה פעילה' };
      if (!validSlot(action.slot)) return { error: 'משבצת לא חוקית' };
      privates.push({ to: playerId, msg: { t: 'reveal', slot: action.slot, card: me.hand[action.slot] } });
      state.highlight = { players: [{ pi, slot: action.slot }] };
      emit(state, { type: 'peek', pi, slot: action.slot });
      addLog(state, `${me.name} הציץ/ה בקלף ${action.slot + 1} שלו/ה.`);
      endTurn(state);
      return { privates };
    }
    case 'swap': {
      if (!pend || pend.type !== 'swap') return { error: 'אין החלפה פעילה' };
      const ti = action.target;
      if (!Number.isInteger(ti) || ti === pi || !state.players[ti]) return { error: 'יריב לא חוקי' };
      if (!validSlot(action.slot) || !validSlot(action.targetSlot)) return { error: 'משבצת לא חוקית' };
      const other = state.players[ti];
      [me.hand[action.slot], other.hand[action.targetSlot]] = [other.hand[action.targetSlot], me.hand[action.slot]];
      state.highlight = { players: [{ pi, slot: action.slot }, { pi: ti, slot: action.targetSlot }] };
      emit(state, { type: 'swap', a: { pi, slot: action.slot }, b: { pi: ti, slot: action.targetSlot } });
      addLog(state, `${me.name} החליף/ה את קלף ${action.slot + 1} שלו/ה עם קלף ${action.targetSlot + 1} של ${other.name}.`);
      endTurn(state);
      return { privates };
    }
    case 'skipPower': {
      if (!pend || (pend.type !== 'peek' && pend.type !== 'swap')) return { error: 'אין מה לדלג' };
      endTurn(state);
      return { privates };
    }
  }
  return { error: 'פעולה לא מוכרת' };
}

// Redacted view of the state for one player.
export function viewFor(state, playerId) {
  const pi = state.players.findIndex(p => p.id === playerId);
  const reveal = state.phase === 'roundEnd';
  const players = state.players.map((p, i) => ({
    id: p.id,
    name: p.name,
    total: p.total,
    hand: p.hand.map((c, slot) => {
      const peeking = state.phase === 'peek' && i === pi && !state.ready.has(p.id) && (slot === 0 || slot === HAND_SIZE - 1);
      return reveal || peeking ? c : null;
    }),
    ready: state.ready.has(p.id),
  }));
  const pend = state.pending;
  let pending = null;
  if (pend) {
    pending = { ...pend };
    if (pend.type === 'drawn' && state.turn !== pi && pend.source === 'deck') pending.card = null;
  }
  return {
    round: state.round,
    phase: state.phase,
    me: pi,
    turn: state.turn,
    players,
    deckCount: state.deck.length,
    discardTop: state.discard[state.discard.length - 1] || null,
    pending,
    calledBy: state.calledBy,
    canCall: state.calledBy === null && state.turnsTaken >= state.players.length,
    results: state.results,
    highlight: state.highlight,
    log: state.log.slice(-12),
    events: state.events,
  };
}
