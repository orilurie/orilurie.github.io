// צוללות (Battleship) – rules for two players. Pure state machine, runs on the host.
// Each player places a fleet on a 10x10 grid (ships may not touch, not even diagonally), then
// the players take turns firing one shot each. A ship sinks when all its cells are hit; the
// first to sink the whole enemy fleet wins.

import { shuffle, fairOrder } from './util.js?v=25';

export const SIZE = 10;
export const FLEET = [
  { type: 'carrier', len: 5, name: 'נושאת מטוסים' },
  { type: 'battleship', len: 4, name: 'אוניית מערכה' },
  { type: 'cruiser', len: 3, name: 'סיירת' },
  { type: 'submarine', len: 3, name: 'צוללת' },
  { type: 'destroyer', len: 2, name: 'משחתת' },
];
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 2;
export const COLS = 'ABCDEFGHIJ';
export const cellName = (x, y) => `${COLS[x]}${y + 1}`;

// Cells of a ship placed at (x, y) going right (dir 'h') or down (dir 'v').
export function shipCells({ x, y, dir, len }) {
  return Array.from({ length: len }, (_, i) => (dir === 'h' ? [x + i, y] : [x, y + i]));
}

// Returns an error message, or null when the fleet is a legal placement.
export function validateFleet(ships) {
  if (!Array.isArray(ships) || ships.length !== FLEET.length) return 'צריך למקם את כל הצי';
  const taken = new Map();
  for (const spec of FLEET) {
    const s = ships.find(x => x && x.type === spec.type);
    if (!s || !['h', 'v'].includes(s.dir) || !Number.isInteger(s.x) || !Number.isInteger(s.y)) return 'מיקום לא חוקי';
    for (const [cx, cy] of shipCells({ ...s, len: spec.len })) {
      if (cx < 0 || cy < 0 || cx >= SIZE || cy >= SIZE) return `${spec.name} יוצאת מהלוח`;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const other = taken.get(`${cx + dx},${cy + dy}`);
          if (other && other !== spec.type) return 'ספינות לא יכולות לגעת זו בזו';
        }
      }
      taken.set(`${cx},${cy}`, spec.type);
    }
  }
  return null;
}

export function randomFleet(rnd = Math.random) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const ships = [];
    let ok = true;
    for (const spec of FLEET) {
      let placed = false;
      for (let t = 0; t < 200 && !placed; t++) {
        const dir = rnd() < 0.5 ? 'h' : 'v';
        const x = Math.floor(rnd() * (dir === 'h' ? SIZE - spec.len + 1 : SIZE));
        const y = Math.floor(rnd() * (dir === 'v' ? SIZE - spec.len + 1 : SIZE));
        const cand = [...ships, { type: spec.type, x, y, dir }];
        if (!validatePartial(cand)) { ships.push(cand[cand.length - 1]); placed = true; }
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return ships;
  }
  throw new Error('could not place fleet');
}

// Like validateFleet but for a fleet that is still incomplete.
export function validatePartial(ships) {
  const taken = new Map();
  for (const s of ships) {
    const spec = FLEET.find(f => f.type === s.type);
    for (const [cx, cy] of shipCells({ ...s, len: spec.len })) {
      if (cx < 0 || cy < 0 || cx >= SIZE || cy >= SIZE) return 'out';
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const other = taken.get(`${cx + dx},${cy + dy}`);
        if (other && other !== s.type) return 'touch';
      }
      taken.set(`${cx},${cy}`, s.type);
    }
  }
  return null;
}

export function createGame(players, rnd = Math.random) {
  if (players.length !== 2) throw new Error('battleship needs exactly 2 players');
  const state = {
    type: 'battleship',
    rnd,
    round: 0,
    players: players.map(p => ({ id: p.id, name: p.name, wins: 0 })),
    events: [],
    eventSeq: 0,
  };
  newRound(state);
  return state;
}

function emit(state, ev) {
  state.events.push({ ...ev, id: ++state.eventSeq });
  if (state.events.length > 12) state.events.shift();
}

function newRound(state) {
  state.round++;
  state.order = fairOrder(state); // who fires first alternates fairly between games
  for (const p of state.players) {
    p.ships = null; // [{ type, x, y, dir, len, hits: Set-like array of cell indexes }]
    p.shotsAt = {}; // shots fired AT this player: "x,y" -> 'hit' | 'miss'
    p.ready = false;
  }
  state.phase = 'place';
  state.turn = state.order[0];
  state.winner = null;
  state.lastShot = null;
  emit(state, { type: 'newRound' });
}

const allSunk = p => p.ships.every(s => s.hits.length === s.len);

export function applyAction(state, playerId, action) {
  const pi = state.players.findIndex(p => p.id === playerId);
  if (pi < 0) return { error: 'שחקן לא מוכר' };
  const me = state.players[pi];
  const enemy = state.players[1 - pi];

  if (action.type === 'place') {
    if (state.phase !== 'place') return { error: 'שלב המיקום הסתיים' };
    if (me.ready) return { error: 'כבר סימנת מוכן' };
    const err = validateFleet(action.ships);
    if (err) return { error: err };
    me.ships = FLEET.map(spec => {
      const s = action.ships.find(x => x.type === spec.type);
      return { type: spec.type, x: s.x, y: s.y, dir: s.dir, len: spec.len, hits: [] };
    });
    me.ready = true;
    emit(state, { type: 'ready', pi });
    if (enemy.ready) {
      state.phase = 'play';
      emit(state, { type: 'battle' });
    }
    return { privates: [] };
  }

  if (action.type === 'nextRound') {
    if (state.phase !== 'end') return { error: 'הקרב עוד לא נגמר' };
    newRound(state);
    return { privates: [] };
  }

  if (action.type !== 'fire') return { error: 'פעולה לא מוכרת' };
  if (state.phase !== 'play') return { error: 'הקרב לא פעיל' };
  if (state.turn !== pi) return { error: 'זה לא התור שלך' };
  const { x, y } = action;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= SIZE || y >= SIZE) return { error: 'משבצת לא חוקית' };
  const key = `${x},${y}`;
  if (enemy.shotsAt[key]) return { error: 'כבר ירית לשם' };

  let result = 'miss', sunk = null;
  for (const s of enemy.ships) {
    const idx = shipCells(s).findIndex(([cx, cy]) => cx === x && cy === y);
    if (idx >= 0) {
      result = 'hit';
      s.hits.push(idx);
      if (s.hits.length === s.len) {
        result = 'sunk';
        sunk = { type: s.type, x: s.x, y: s.y, dir: s.dir, len: s.len };
      }
      break;
    }
  }
  enemy.shotsAt[key] = result === 'miss' ? 'miss' : 'hit';
  state.lastShot = { by: pi, x, y, result, sunkType: sunk?.type || null };
  emit(state, { type: 'shot', by: pi, x, y, result, sunk });
  if (allSunk(enemy)) {
    state.phase = 'end';
    state.winner = pi;
    me.wins++;
    emit(state, { type: 'end', winner: pi });
  } else {
    state.turn = 1 - pi; // one shot per turn
  }
  return { privates: [] };
}

// Redacted view: your own fleet; of the enemy fleet only what your shots revealed.
export function viewFor(state, playerId, { revealAll = false } = {}) {
  const me = state.players.findIndex(p => p.id === playerId);
  const enemyI = 1 - me;
  const enemy = state.players[enemyI];
  const sunkShips = p => (p.ships || []).filter(s => s.hits.length === s.len).map(({ hits, ...s }) => s);
  const fleetStatus = p => FLEET.map(f => {
    const s = p.ships?.find(x => x.type === f.type);
    return { type: f.type, len: f.len, sunk: !!s && s.hits.length === s.len };
  });
  return {
    type: 'battleship',
    round: state.round,
    phase: state.phase,
    me,
    turn: state.turn,
    order: state.order,
    winner: state.winner,
    players: state.players.map((p, i) => ({ id: p.id, name: p.name, wins: p.wins, ready: p.ready })),
    myShips: state.players[me].ships ? state.players[me].ships.map(s => ({ ...s, hits: s.hits.slice() })) : null,
    shotsAtMe: state.players[me].shotsAt,
    myShots: enemy.shotsAt,
    enemySunk: sunkShips(enemy),
    enemyShips: revealAll && enemy.ships ? enemy.ships.map(({ hits, ...s }) => s) : null,
    myFleet: fleetStatus(state.players[me]),
    enemyFleet: fleetStatus(enemy),
    lastShot: state.lastShot,
    results: state.phase === 'end'
      ? state.players.map((p, i) => ({ id: p.id, name: p.name, winner: i === state.winner, wins: p.wins }))
      : null,
    events: state.events,
  };
}
