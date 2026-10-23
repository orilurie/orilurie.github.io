// Helpers shared by the games' rules.

export function shuffle(a, rnd = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Every round gets a new random turn order, but a fair one: among all possible orders we pick,
// at random, one of those that put players in the positions they've had least so far. Over a
// few rounds everyone starts, plays in the middle and plays last about equally often.
export function fairOrder(state) {
  const n = state.players.length;
  state.seatCounts ??= state.players.map(() => Array(n).fill(0)); // [player][position] -> rounds
  let best = [], bestCost = Infinity;
  for (const perm of permutations(shuffle([...Array(n).keys()], state.rnd))) {
    // Squared counts: being placed somewhere you've already been several times costs more.
    // Repeating last round's position (e.g. last twice in a row) is avoided too.
    const cost = perm.reduce((c, pi, pos) => c + (state.seatCounts[pi][pos] + 1) ** 2 + (state.order?.[pos] === pi ? 3 : 0), 0);
    if (cost < bestCost) { bestCost = cost; best = [perm]; }
    else if (cost === bestCost) best.push(perm);
  }
  const order = best[Math.floor(state.rnd() * best.length)];
  order.forEach((pi, pos) => state.seatCounts[pi][pos]++);
  return order;
}

function* permutations(items) {
  if (items.length <= 1) { yield items.slice(); return; }
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const p of permutations(rest)) yield [items[i], ...p];
  }
}
