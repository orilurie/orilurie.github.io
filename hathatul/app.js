import { createGame, applyAction, viewFor, POWERS, MIN_PLAYERS, MAX_PLAYERS } from './game.js?v=9';
import { hostTransport, clientTransport } from './net.js?v=9';
import { snapshot, playEvents, turnFx, confetti, STRIP } from './anim.js?v=9';

export const VERSION = 9; // bump on every deploy, together with the ?v= in index.html and the imports below
const $app = document.getElementById('app');
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// Per-tab player id: survives a refresh (to rejoin), but each tab is its own player.
let pid = null;
try { pid = sessionStorage.getItem('hathatul-pid'); } catch {}
if (!pid) {
  pid = 'p' + Math.random().toString(36).slice(2, 10);
  try { sessionStorage.setItem('hathatul-pid', pid); } catch {}
}

const ui = {
  screen: 'home', // home | connecting | lobby | game
  name: store.get('hathatul-name') || '',
  joinCode: new URLSearchParams(location.search).get('room') || '',
  error: '',
  room: null, // { code, players, started, isHost }
  view: null,
  reveal: null, // { slot, card }
  swapSlot: null,
  showLog: false,
  dropFrom: null, // snapshot overrides so the next animation starts where a card was dropped
  nextSwapSlot: null,
  lastEventId: undefined, // last game event already animated
  resultsReady: true, // false while the end-of-round reveal is playing
};
let send = () => {}; // sends a message to the host (or handles it locally when hosting)

// ---------- Host ----------
function startHosting(code) {
  const room = { code, players: [], game: null };
  const cidToPid = new Map();
  let transport;

  const sendTo = (p, msg) => {
    if (!p.connected) return;
    if (p.cid === 'self') receive(msg);
    else transport.send(p.cid, msg);
  };
  const broadcast = () => {
    const summary = {
      code,
      started: !!room.game,
      players: room.players.map((p, i) => ({ name: p.name, connected: p.connected, isHost: i === 0 })),
    };
    for (const p of room.players) {
      sendTo(p, { t: 'room', room: { ...summary, isHost: p.pid === pid }, view: room.game ? viewFor(room.game, p.pid) : null });
    }
  };
  const handle = (cid, msg) => {
    if (msg.t === 'join') {
      let p = room.players.find(x => x.pid === msg.pid);
      if (!p) {
        if (room.game) return reply(cid, 'המשחק כבר התחיל');
        if (room.players.length >= MAX_PLAYERS) return reply(cid, 'החדר מלא');
        p = { pid: msg.pid, name: String(msg.name || 'שחקן').slice(0, 16) };
        room.players.push(p);
      }
      p.cid = cid;
      p.connected = true;
      cidToPid.set(cid, p.pid);
      return broadcast();
    }
    const fromPid = cidToPid.get(cid);
    const p = room.players.find(x => x.pid === fromPid);
    if (!p) return;
    const isHost = room.players[0] === p;
    if (msg.t === 'start') {
      if (!isHost || room.game) return;
      if (room.players.length < MIN_PLAYERS) return reply(cid, `צריך לפחות ${MIN_PLAYERS} שחקנים`);
      room.game = createGame(room.players.map(x => ({ id: x.pid, name: x.name })));
      return broadcast();
    }
    if (msg.t === 'action' && room.game) {
      if (msg.action.type === 'nextRound' && !isHost) return;
      const res = applyAction(room.game, p.pid, msg.action);
      if (res.error) return reply(cid, res.error);
      for (const pr of res.privates) sendTo(room.players.find(x => x.pid === pr.to), pr.msg);
      broadcast();
    }
  };
  const reply = (cid, text) => {
    const msg = { t: 'error', text };
    if (cid === 'self') receive(msg);
    else transport.send(cid, msg);
  };

  transport = hostTransport(code, {
    onReady() {
      cidToPid.set('self', pid);
      handle('self', { t: 'join', pid, name: ui.name });
    },
    onConnect() {},
    onData: handle,
    onClose(cid) {
      const p = room.players.find(x => x.cid === cid);
      if (!p) return;
      if (room.game) p.connected = false;
      else room.players.splice(room.players.indexOf(p), 1);
      broadcast();
    },
    onError(err) {
      if (err.type === 'unavailable-id') {
        startHosting(randomCode()); // code collision, try another
      } else {
        fail('שגיאת חיבור: ' + (err.type || err.message));
      }
    },
  });
  send = msg => handle('self', msg);
}

// ---------- Test room ----------
// One person plays every seat, all cards face up. No network: the screen always shows the
// seat whose turn it is, so the normal controls act for that player.
function startTestRoom(n) {
  const names = [ui.name || 'שחקן 1', ...Array.from({ length: n - 1 }, (_, i) => `שחקן ${i + 2}`)];
  const ids = [pid, ...names.slice(1).map((_, i) => `test${i + 2}`)];
  const game = createGame(ids.map((id, i) => ({ id, name: names[i] })));
  const room = {
    code: 'TEST', started: true, isHost: true, test: true,
    players: names.map((name, i) => ({ name, connected: true, isHost: i === 0 })),
  };
  const push = () => {
    const seat = game.players[game.turn].id;
    receive({ t: 'room', room, view: viewFor(game, seat, { revealAll: true }) });
  };
  send = msg => {
    if (msg.t !== 'action') return;
    const { action } = msg;
    if (action.type === 'ready') {
      for (const p of game.players) if (!game.ready.has(p.id)) applyAction(game, p.id, action);
      return push();
    }
    const res = applyAction(game, game.players[game.turn].id, action);
    if (res.error) return receive({ t: 'error', text: res.error });
    push();
  };
  ui.lastEventId = 0;
  push();
}

// ---------- Client ----------
function joinRoom(code) {
  const transport = clientTransport(code, {
    onOpen() { transport.send({ t: 'join', pid, name: ui.name }); },
    onData: receive,
    onClose() { fail('החיבור למארח נותק'); },
    onError(err) {
      fail(err.type === 'peer-unavailable' ? 'לא נמצא חדר עם הקוד הזה' : 'שגיאת חיבור: ' + (err.type || err.message));
    },
  });
  send = msg => transport.send(msg);
}

function receive(msg) {
  if (msg.t === 'room') {
    if (drag?.started) cancelDrag();
    const before = snapshot();
    if (ui.dropFrom) Object.assign(before, ui.dropFrom); // animate from where the card was dropped
    ui.dropFrom = null;
    const prev = ui.view;
    let fresh = [];
    if (msg.view) {
      const evs = msg.view.events;
      if (ui.lastEventId !== undefined) fresh = evs.filter(e => e.id > ui.lastEventId);
      if (evs.length) ui.lastEventId = evs[evs.length - 1].id;
    } else {
      ui.lastEventId = 0; // in the lobby: animate everything from the first deal
    }
    if (fresh.some(e => e.type === 'roundEnd')) ui.resultsReady = false;
    ui.room = msg.room;
    const prevTurnKey = ui.view && `${ui.view.round}-${ui.view.turn}-${ui.view.pending?.type}`;
    ui.view = msg.view;
    const key = ui.view && `${ui.view.round}-${ui.view.turn}-${ui.view.pending?.type}`;
    if (key !== prevTurnKey) ui.swapSlot = null;
    if (ui.nextSwapSlot !== null && ui.view?.pending?.type === 'swap') ui.swapSlot = ui.nextSwapSlot;
    ui.nextSwapSlot = null;
    ui.screen = msg.room.started ? 'game' : 'lobby';
    ui.error = '';
    if (!msg.room.test) history.replaceState(null, '', `?${new URLSearchParams({ ...localParam(), room: msg.room.code })}`);
    render();
    if (ui.view) animate(fresh, before, prev);
    if (dropped) { clearTimeout(dropped.timer); dropped.clone.remove(); dropped = null; }
    return;
  } else if (msg.t === 'reveal') {
    ui.reveal = { slot: msg.slot, card: msg.card };
    setTimeout(() => { ui.reveal = null; render(); }, 4000);
  } else if (msg.t === 'error') {
    if (dropped) { clearTimeout(dropped.timer); returnHome(dropped); dropped = null; }
    toast(msg.text);
    return;
  }
  render();
}

function animate(fresh, before, prev) {
  const v = ui.view;
  const myTurn = x => x && x.phase === 'play' && x.turn === x.me;
  playEvents(fresh, before, v).catch(() => {}).then(() => {
    if (fresh.some(e => e.type === 'roundEnd')) {
      ui.resultsReady = true;
      render();
      const meId = v.players[v.me].id;
      if (v.results?.some(r => r.winner && r.id === meId)) confetti();
    }
    if (myTurn(ui.view) && !myTurn(prev)) turnFx();
  });
}

function fail(text) {
  if (ui.screen === 'game' || ui.screen === 'lobby') {
    toast(text);
  } else {
    ui.screen = 'home';
    ui.error = text;
    render();
  }
}

const localParam = () => (new URLSearchParams(location.search).has('local') ? { local: '1' } : {});
const randomCode = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');

let toastTimer;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- Rendering ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function cardHtml(c, { size = '', act = '', data = '', cls = '', k = '' } = {}) {
  const attrs = `${act ? `data-act="${act}" role="button" tabindex="0"` : ''} ${data} ${k ? `data-k="${k}"` : ''}`;
  if (!c) return `<div class="card back ${size} ${cls} ${act ? 'clickable' : ''}" ${attrs}><span>🐾</span></div>`;
  if (c.kind === 'power') {
    const p = POWERS[c.power];
    return `<div class="card power ${size} ${cls} ${act ? 'clickable' : ''}" ${attrs}><b>${p.icon}</b><small>${p.label}</small></div>`;
  }
  const cat = c.value <= 6;
  return `<div class="card num ${cat ? 'cat' : 'mouse'} ${size} ${cls} ${act ? 'clickable' : ''}" ${attrs}>
    <i class="corner">${c.value}</i><b>${c.value}</b><span>${cat ? '🐱' : '🐭'}</span></div>`;
}

function render() {
  if (drag?.started) { ui.renderQueued = true; return; }
  $app.classList.toggle('game', ui.screen === 'game');
  if (ui.screen === 'home') return renderHome();
  if (ui.screen === 'connecting') {
    $app.innerHTML = `<div class="panel center"><div class="spinner"></div><p>מתחבר…</p></div>`;
    return;
  }
  if (ui.screen === 'lobby') return renderLobby();
  renderGame();
  for (const el of $app.querySelectorAll('.card[data-k]')) if (dragTargets(el.dataset.k)) el.classList.add('draggable');
}

function renderHome() {
  $app.innerHTML = `
    <div class="panel home">
      <h1>חתחתול <span>🐱🐭</span></h1>
      <p class="sub">משחק קלפים אונליין ל-2 עד 6 שחקנים. שמרו את החתולים, היפטרו מהעכברים!</p>
      ${ui.error ? `<p class="err">${esc(ui.error)}</p>` : ''}
      <label>השם שלך<input id="name" maxlength="16" value="${esc(ui.name)}" placeholder="למשל: אורי"></label>
      <button class="primary" data-act="create">צור חדר חדש</button>
      <div class="or">או הצטרף לחדר קיים</div>
      <div class="row">
        <input id="code" maxlength="4" value="${esc(ui.joinCode)}" placeholder="קוד חדר" dir="ltr">
        <button data-act="join">הצטרף</button>
      </div>
      <div class="or">או</div>
      <div class="row test-row">
        <button data-act="test">🧪 חדר בדיקה</button>
        <select id="testN" aria-label="מספר שחקנים">${[2, 3, 4, 5, 6].map(n => `<option value="${n}">${n} שחקנים</option>`).join('')}</select>
      </div>
      <p class="hint">בחדר בדיקה משחקים לבד את כל השחקנים, וכל הקלפים גלויים.</p>
      <details class="rules"><summary>איך משחקים?</summary>${rulesHtml()}</details>
      <p class="version">גרסה ${VERSION}</p>
    </div>`;
}

function rulesHtml() {
  return `<ul>
    <li>לכל שחקן 4 קלפים הפוכים. בתחילת כל סיבוב מציצים רק בשני הקלפים החיצוניים, וצריך לזכור אותם!</li>
    <li>בתורך: שולפים קלף מהקופה, או לוקחים את הקלף העליון מערימת הזריקה.</li>
    <li>אפשר להחליף קלף מהיד בקלף ששלפת (הקלף הישן נזרק), או לזרוק את הקלף ששלפת מהקופה.</li>
    <li>החתולים (0–6) שווים מעט נקודות, והעכברים (7–9) שווים הרבה.</li>
    <li>קלפי כוח: 👁️ <b>הצצה</b> בקלף שלך · 🔄 <b>החלפה</b> של קלף שלך בקלף של יריב (בלי להסתכל) · ✌️ <b>שלוף 2</b>: עד שתי שליפות נוספות.</li>
    <li>אחרי סבב שלם אפשר לקרוא <b>"חתחתול!"</b> בתחילת התור. לכל השאר נשאר עוד תור אחד, ואז כל הקלפים נחשפים.</li>
    <li>אפשר ללחוץ על קלפים או לגרור אותם. בזמן גרירה מסומנים כל המקומות שאפשר להניח בהם את הקלף.</li>
    <li>מי שסכום הקלפים שלו הכי נמוך מנצח בסיבוב. הנקודות מצטברות, והכי מעט נקודות בסוף הוא המנצח.</li>
  </ul>`;
}

function renderLobby() {
  const r = ui.room;
  const link = `${location.origin}${location.pathname}?${new URLSearchParams({ ...localParam(), room: r.code })}`;
  $app.innerHTML = `
    <div class="panel lobby">
      <h2>חדר <span class="code" dir="ltr">${r.code}</span></h2>
      <p class="sub">שלחו לחברים את הקישור או את הקוד:</p>
      <div class="row"><input readonly value="${esc(link)}" dir="ltr" id="link"><button data-act="copy">העתק</button></div>
      <h3>שחקנים (${r.players.length}/${MAX_PLAYERS})</h3>
      <ul class="plist">${r.players.map(p => `<li>${p.isHost ? '👑 ' : '🐱 '}${esc(p.name)}</li>`).join('')}</ul>
      ${r.isHost
        ? `<button class="primary" data-act="start" ${r.players.length < MIN_PLAYERS ? 'disabled' : ''}>התחל משחק</button>
           ${r.players.length < MIN_PLAYERS ? `<p class="sub">מחכים לשחקנים נוספים…</p>` : ''}`
        : `<p class="sub">מחכים שהמארח/ת יתחיל/ה את המשחק…</p>`}
      <p class="hint">המארח/ת צריך/ה להשאיר את הדף פתוח לאורך כל המשחק.</p>
    </div>`;
}

function statusText(v) {
  const meP = v.players[v.me];
  const cur = v.players[v.turn];
  if (v.phase === 'peek') return meP.ready ? 'מחכים שכולם יסיימו להציץ…' : 'זכרו את שני הקלפים החיצוניים שלכם!';
  if (v.phase === 'roundEnd') return 'הסיבוב נגמר!';
  const pend = v.pending;
  if (v.turn !== v.me) {
    if (pend?.type === 'drawn') return `${esc(cur.name)} שלף/ה קלף…`;
    if (pend?.type === 'swap') return `${esc(cur.name)} בוחר/ת קלפים להחלפה…`;
    if (pend?.type === 'peek') return `${esc(cur.name)} מציץ/ה…`;
    return `התור של ${esc(cur.name)}`;
  }
  if (!pend) return 'התור שלך! שלפו מהקופה או קחו מערימת הזריקה.';
  if (pend.type === 'draw2') return `שלוף 2: שלפו קלף מהקופה (${pend.remaining === 2 ? 'שליפה ראשונה' : 'שליפה אחרונה'}).`;
  if (pend.type === 'peek') return 'בחרו קלף שלכם להציץ בו.';
  if (pend.type === 'swap') return ui.swapSlot === null ? 'בחרו קלף שלכם להחלפה.' : 'עכשיו בחרו קלף של יריב.';
  if (pend.card.kind === 'power') return 'שלפתם קלף כוח! להשתמש בו או לזרוק?';
  return pend.source === 'discard' ? 'בחרו איזה קלף ביד להחליף.' : 'בחרו קלף ביד להחלפה, או זרקו את הקלף.';
}

function renderGame() {
  const v = ui.view;
  const myTurn = v.phase === 'play' && v.turn === v.me;
  const pend = v.pending;
  const hl = (pi, slot) => v.highlight?.players.some(h => h.pi === pi && h.slot === slot) ? 'hl' : '';

  const opps = v.players
    .map((p, i) => ({ p, i }))
    .filter(x => x.i !== v.me)
    .map(({ p, i }) => {
      const swapTarget = myTurn && pend?.type === 'swap' && ui.swapSlot !== null;
      const conn = ui.room.players[i]?.connected === false ? ' <small class="off">(מנותק/ת)</small>' : '';
      return `<div class="opp ${v.turn === i && v.phase === 'play' ? 'active' : ''}">
        <div class="oname">${v.calledBy === i ? '📣 ' : ''}${esc(p.name)}${conn} <span class="pts">${p.total} נק׳</span></div>
        <div class="ohand">${p.hand.map((c, s) => cardHtml(c, {
          size: 'sm', cls: hl(i, s), k: `h${i}-${s}`,
          act: swapTarget ? 'swapTarget' : '', data: `data-p="${i}" data-s="${s}"`,
        })).join('')}</div>
        ${v.phase === 'peek' ? `<div class="tag">${p.ready ? '✓ מוכן/ה' : 'מציץ/ה…'}</div>` : ''}
      </div>`;
    }).join('');

  const meP = v.players[v.me];
  const slotAct = myTurn && ((pend?.type === 'drawn' && pend.card?.kind === 'num') || pend?.type === 'peek' || pend?.type === 'swap')
    ? (pend.type === 'drawn' ? 'replace' : pend.type === 'peek' ? 'peek' : 'swapMine') : '';
  const myHand = meP.hand.map((c, s) => {
    let card = c;
    if (ui.reveal && ui.reveal.slot === s && v.phase === 'play') card = ui.reveal.card;
    const sel = pend?.type === 'swap' && ui.swapSlot === s ? 'sel' : '';
    return `<div class="slot">${cardHtml(card, { act: slotAct, k: `h${v.me}-${s}`, data: `data-s="${s}"`, cls: `${hl(v.me, s)} ${sel} ${card && !c ? 'revealed' : ''}` })}<span>${s + 1}</span></div>`;
  }).join('');

  const canDraw = myTurn && (!pend || pend.type === 'draw2');
  const canTake = myTurn && !pend && v.discardTop?.kind === 'num';
  let drawn = '';
  if (pend?.type === 'drawn' && v.phase === 'play') {
    const btns = [];
    if (myTurn && pend.card.kind === 'power') btns.push(`<button class="primary" data-act="usePower">השתמש</button>`);
    if (myTurn && pend.source === 'deck') btns.push(`<button data-act="discardDrawn">זרוק</button>`);
    drawn = `<div class="pile drawn"><div class="plabel">${myTurn ? 'הקלף שלך' : 'נשלף'}</div>${cardHtml(pend.card, { k: 'drawn' })}<div class="btns">${btns.join('')}</div></div>`;
  } else {
    // Empty spot that becomes the drop target when dragging a card off the deck.
    drawn = `<div class="pile drawslot-pile"><div class="plabel">שלוף לכאן</div><div class="card dropslot" ${canDraw ? 'data-k="drawslot"' : ''}></div></div>`;
  }

  const controls = [];
  if (v.phase === 'peek' && !meP.ready) controls.push(`<button class="primary" data-act="ready">זכרתי! הסתר את הקלפים</button>`);
  if (myTurn && !pend && v.canCall) controls.push(`<button class="call" data-act="call">📣 חתחתול!</button>`);
  if (myTurn && (pend?.type === 'peek' || pend?.type === 'swap')) controls.push(`<button data-act="skipPower">דלג</button>`);

  $app.innerHTML = `
    <header class="top">
      <div><b>חתחתול</b> · ${ui.room.test ? '🧪 חדר בדיקה' : `חדר <span dir="ltr">${ui.room.code}</span>`} · סיבוב ${v.round}</div>
      ${ui.room.test ? `<button class="ghost" data-act="exitTest">יציאה</button>` : ''}
      <button class="ghost" data-act="toggleLog">${ui.showLog ? 'הסתר יומן' : 'יומן'}</button>
    </header>
    ${v.calledBy !== null && v.phase === 'play' ? `<div class="lastcall">📣 ${esc(v.players[v.calledBy].name)} קרא/ה חתחתול! ${v.calledBy === v.me ? 'מחכים שכולם ישחקו תור אחרון…' : 'זה הסבב האחרון!'}</div>` : ''}
    <section class="opps">${opps}</section>
    <section class="table">
      <div class="pile"><div class="plabel">קופה (${v.deckCount})</div>${cardHtml(null, { act: canDraw ? 'drawDeck' : '', cls: canDraw ? 'glow' : '', k: 'deck' })}</div>
      <div class="pile"><div class="plabel">ערימת זריקה</div>${v.discardTop ? cardHtml(v.discardTop, { act: canTake ? 'takeDiscard' : '', cls: canTake ? 'glow' : '', k: 'discard' }) : '<div class="card empty" data-k="discard"></div>'}</div>
      ${drawn}
    </section>
    <div class="status ${myTurn ? 'mine' : ''}">${statusText(v)}</div>
    <div class="controls">${controls.join('')}</div>
    <section class="me ${myTurn ? 'active' : ''}">
      <div class="oname">${v.calledBy === v.me ? '📣 ' : ''}${esc(meP.name)} ${ui.room.test ? "(בתור)" : "(את/ה)"} <span class="pts">${meP.total} נק׳</span></div>
      <div class="hand">${myHand}</div>
    </section>
    ${ui.showLog ? `<section class="log">${v.log.slice().reverse().map(l => `<div>${esc(l)}</div>`).join('')}</section>` : ''}
    ${v.phase === 'roundEnd' && ui.resultsReady ? resultsHtml(v) : ''}`;
}

function resultsHtml(v) {
  const rows = v.results.slice().sort((a, b) => a.total - b.total)
    .map((r, i) => `<tr class="${r.winner ? 'win' : ''}" style="--i:${i}"><td>${r.winner ? '<span class="trophy">🏆</span> ' : ''}${esc(r.name)}</td><td>${r.score}</td><td>${r.total}</td></tr>`).join('');
  const hands = v.players.map(p => `<div class="rhand"><span>${esc(p.name)}</span><div>${p.hand.map(c => cardHtml(c, { size: 'xs' })).join('')}</div></div>`).join('');
  return `<div class="overlay"><div class="panel results">
    <h2>סוף סיבוב ${v.round}</h2>
    <div class="rhands">${hands}</div>
    <table><thead><tr><th>שחקן</th><th>סיבוב</th><th>סה״כ</th></tr></thead><tbody>${rows}</tbody></table>
    ${ui.room.isHost ? `<button class="primary" data-act="nextRound">סיבוב הבא</button>` : `<p class="sub">מחכים למארח/ת…</p>`}
    <button class="ghost" data-act="closeResults">הצג את השולחן</button>
  </div></div>`;
}

// ---------- Touch diagnostics (?debug=1) ----------
// Shows what the browser reports during touches, to diagnose devices we can't test on.
const debugOn = new URLSearchParams(location.search).has('debug');
const dbgLines = [];
function dbg(text) {
  if (!debugOn) return;
  dbgLines.push(`${(performance.now() / 1000).toFixed(2)} ${text}`);
  if (dbgLines.length > 12) dbgLines.shift();
  let el = document.getElementById('dbg');
  if (!el) {
    el = document.createElement('pre');
    el.id = 'dbg';
    document.body.append(el);
  }
  el.textContent = `v${VERSION} ${navigator.userAgent.slice(0, 90)}\nscrollY=${Math.round(scrollY)} lock=${lockedY !== null}\n` + dbgLines.join('\n');
}
if (debugOn) addEventListener('scroll', () => dbg('scroll'), { passive: true });

// ---------- Drag & drop ----------
// Every drag maps to the same actions as clicking. Dropping outside a target returns the card.
let drag = null; // in-progress drag
let dropped = null; // card dropped on a target, waiting for the host's answer

function dragTargets(key) {
  const v = ui.view;
  if (ui.screen !== 'game' || !v || v.phase !== 'play' || v.turn !== v.me) return null;
  const pend = v.pending, me = v.me;
  const act = (type, extra = {}) => send({ t: 'action', action: { type, ...extra } });
  const mySlots = (hint, go) => [0, 1, 2, 3].map(s => ({ key: `h${me}-${s}`, hint, go: () => go(s) }));
  const T = [];
  if (key === 'deck' && (!pend || pend.type === 'draw2')) {
    T.push({ key: 'drawslot', hint: 'שלוף', as: 'deck', go: () => act('drawDeck') });
  } else if (key === 'discard' && !pend && v.discardTop?.kind === 'num') {
    T.push(...mySlots('החלף', s => act('takeDiscard', { slot: s })).map(t => ({ ...t, as: 'drawn' })));
  } else if (key === 'drawn' && pend?.type === 'drawn') {
    const c = pend.card;
    if (pend.source === 'deck') T.push({ key: 'discard', hint: 'זרוק', go: () => act('discardDrawn') });
    if (c.kind === 'num') T.push(...mySlots('החלף', s => act('replace', { slot: s })));
    else if (c.power === 'peek') T.push(...mySlots('הצץ', s => { act('usePower'); act('peek', { slot: s }); }));
    else if (c.power === 'swap') T.push(...mySlots('להחלפה', s => { ui.nextSwapSlot = s; act('usePower'); }));
    else if (c.power === 'draw2') T.push({ key: 'deck', hint: 'השתמש', go: () => act('usePower') });
    T.forEach(t => { t.as = 'drawn'; });
  } else if (pend?.type === 'swap' && /^h\d+-\d$/.test(key)) {
    const [pi, slot] = key.slice(1).split('-').map(Number);
    if (pi === me) {
      v.players.forEach((p, i) => {
        if (i !== me) for (let s = 0; s < 4; s++) T.push({ key: `h${i}-${s}`, hint: 'החלף', as: key, go: () => act('swap', { slot, target: i, targetSlot: s }) });
      });
    } else {
      T.push(...mySlots('החלף', s => act('swap', { slot: s, target: pi, targetSlot: slot })).map(t => ({ ...t, as: key })));
    }
  }
  return T.length ? T : null;
}

function startDrag() {
  drag.started = true;
  dbg('drag started');
  drag.targets = drag.targets
    .map(t => ({ ...t, el: $app.querySelector(`[data-k="${t.key}"]`) }))
    .filter(t => t.el);
  for (const t of drag.targets) {
    t.el.classList.add('drop-ok');
    t.el.dataset.hint = t.hint;
    t.el.closest('.drawslot-pile')?.classList.add('show');
  }
  document.body.classList.add('dragging');
  drag.el.classList.add('drag-src');
  const r = drag.rect;
  const clone = document.createElement('div');
  clone.className = 'drag-clone';
  clone.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
  clone.innerHTML = drag.el.outerHTML;
  const c = clone.firstElementChild;
  c.classList.remove(...STRIP);
  c.removeAttribute('data-k');
  c.style.setProperty('--w', r.width + 'px');
  document.getElementById('fx').append(clone);
  drag.clone = clone;
  navigator.vibrate?.(15);
}

function hitTarget(x, y) {
  let best = null, bestD = Infinity;
  for (const t of drag.targets) {
    const r = t.el.getBoundingClientRect();
    const pad = 14;
    if (x < r.left - pad || x > r.right + pad || y < r.top - pad || y > r.bottom + pad) continue;
    const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

function clearDragUi() {
  document.body.classList.remove('dragging');
  for (const el of $app.querySelectorAll('.drop-ok, .drop-hover, .show')) {
    el.classList.remove('drop-ok', 'drop-hover', 'show');
    delete el.dataset.hint;
  }
}

// Slides a dragged card back to where it came from.
function returnHome({ clone, el, key, tilt = 0 }) {
  const home = (el.isConnected ? el : $app.querySelector(`[data-k="${key}"]`)) || el;
  const done = () => { clone.remove(); home.classList?.remove('drag-src'); };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !home.isConnected) return done();
  const from = clone.getBoundingClientRect(), to = home.getBoundingClientRect();
  clone.style.transform = '';
  clone.style.left = to.left + 'px';
  clone.style.top = to.top + 'px';
  clone.animate([
    { transform: `translate(${from.left - to.left}px,${from.top - to.top}px) rotate(${tilt}deg) scale(1.08)` },
    { transform: 'translate(0,0) rotate(0) scale(1)' },
  ], { duration: 380, easing: 'cubic-bezier(.3,1.35,.5,1)' }).finished.then(done);
}

function cancelDrag() {
  const d = drag;
  drag = null;
  releaseLock();
  clearDragUi();
  returnHome(d);
  if (ui.renderQueued) { ui.renderQueued = false; render(); }
}

// While a finger holds a card the page is locked (overflow hidden, touch-action none), so
// the browser has nothing to scroll. iOS Safari ignores preventDefault on touchmove since
// iOS 15; locking the page is what reliably works there.
let lockedY = null;
function lockScroll() {
  if (lockedY !== null) return;
  lockedY = scrollY;
  document.documentElement.classList.add('drag-lock');
}
function unlockScroll() {
  if (lockedY === null) return;
  document.documentElement.classList.remove('drag-lock');
  if (scrollY !== lockedY) scrollTo(0, lockedY);
  lockedY = null;
}

$app.addEventListener('pointerdown', e => {
  const el = e.target.closest('.card[data-k]');
  dbg(`down ${e.pointerType} ${el ? el.dataset.k : '-'} ${el?.classList.contains('draggable') ? 'draggable' : 'not-draggable'}${drag ? ' BUSY-drag' : ''}${dropped ? ' BUSY-drop' : ''}`);
  if (e.button !== 0 || drag || dropped) return;
  const targets = el?.classList.contains('draggable') && dragTargets(el.dataset.k);
  if (!targets) return;
  drag = { el, key: el.dataset.k, targets, x0: e.clientX, y0: e.clientY, lastX: e.clientX, tilt: 0, rect: el.getBoundingClientRect(), started: false, pid: e.pointerId };
  if (e.pointerType !== 'mouse') lockScroll();
});
// Runs after the drag handlers below (registered later on the same target).
const releaseLock = () => setTimeout(() => { if (!drag) unlockScroll(); }, 0);

addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pid) return;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  if (!drag.started) {
    if (Math.hypot(dx, dy) < 6) return;
    startDrag();
  }
  e.preventDefault();
  drag.tilt = Math.max(-14, Math.min(14, drag.tilt * 0.8 + (e.clientX - drag.lastX) * 0.6));
  drag.lastX = e.clientX;
  drag.clone.style.transform = `translate(${dx}px,${dy}px) rotate(${drag.tilt}deg) scale(1.08)`;
  // Near the top/bottom edge, scroll so targets off-screen can be reached.
  const edge = 60;
  if (e.clientY > innerHeight - edge) scrollBy(0, 14);
  else if (e.clientY < edge) scrollBy(0, -14);
  const hit = hitTarget(e.clientX, e.clientY);
  if (hit !== drag.hover) {
    drag.hover?.el.classList.remove('drop-hover');
    hit?.el.classList.add('drop-hover');
    drag.hover = hit;
  }
}, { passive: false });

addEventListener('pointerup', e => {
  if (!drag || e.pointerId !== drag.pid) return;
  if (!drag.started) {
    // Touch on a draggable card: its touchstart was cancelled (to stop scrolling), so the
    // browser sends no click. Treat the tap as the click here.
    const el = drag.el;
    drag = null;
    if (e.pointerType !== 'mouse' && el.dataset.act) {
      ui.justDragged = true; // swallow a click if the browser sends one anyway
      setTimeout(() => { ui.justDragged = false; }, 400);
      onAct(el);
    }
    return;
  }
  ui.justDragged = true;
  setTimeout(() => { ui.justDragged = false; }, 0);
  const hit = hitTarget(e.clientX, e.clientY);
  if (!hit) return cancelDrag();
  const d = drag;
  drag = null;
  clearDragUi();
  const r = d.clone.getBoundingClientRect();
  ui.dropFrom = { [hit.as || d.key]: { rect: r, html: d.el.outerHTML } };
  dropped = { clone: d.clone, el: d.el, key: d.key, timer: setTimeout(() => { if (dropped) { returnHome(dropped); dropped = null; } }, 4000) };
  ui.renderQueued = false;
  hit.go();
});

// Stop the page from scrolling as soon as a finger lands on a draggable card. WebKit
// (every iPhone browser, and in-app browsers) decides to scroll on touchstart.
$app.addEventListener('touchstart', e => {
  if (e.target.closest('.card.draggable')) e.preventDefault();
  dbg(`touchstart prevented=${e.defaultPrevented}`);
}, { passive: false });

// iOS Safari ignores touch-action on its own and scrolls the page instead of dragging;
// cancelling the touch move while a card is held keeps the finger on the card.
addEventListener('touchmove', e => {
  if (drag) e.preventDefault();
}, { passive: false });

addEventListener('pointerup', releaseLock);
addEventListener('pointercancel', e => {
  dbg('POINTERCANCEL (browser took over the gesture)');
  releaseLock();
  if (drag && e.pointerId === drag.pid) {
    if (drag.started) cancelDrag();
    else drag = null;
  }
});

// A drag must not also count as a click on the card it started from.
$app.addEventListener('click', e => {
  if (ui.justDragged) { e.stopPropagation(); e.preventDefault(); }
}, true);

// ---------- Events ----------
function onAct(el) {
  const act = el.dataset.act;
  const s = el.dataset.s !== undefined ? Number(el.dataset.s) : undefined;
  const action = type => send({ t: 'action', action: { type, ...extra } });
  let extra = {};
  switch (act) {
    case 'create':
    case 'join': {
      const name = document.getElementById('name').value.trim();
      if (!name) { ui.error = 'נא להזין שם'; return render(); }
      ui.name = name;
      store.set('hathatul-name', name);
      if (act === 'join') {
        const code = document.getElementById('code').value.trim().toUpperCase();
        if (code.length !== 4) { ui.error = 'קוד חדר צריך להיות 4 אותיות'; return render(); }
        ui.screen = 'connecting';
        render();
        joinRoom(code);
      } else {
        ui.screen = 'connecting';
        render();
        startHosting(randomCode());
      }
      return;
    }
    case 'copy': {
      const link = document.getElementById('link');
      navigator.clipboard?.writeText(link.value).then(() => toast('הקישור הועתק!'), () => { link.select(); });
      return;
    }
    case 'start': return send({ t: 'start' });
    case 'test': {
      ui.name = document.getElementById('name').value.trim();
      if (ui.name) store.set('hathatul-name', ui.name);
      return startTestRoom(Number(document.getElementById('testN').value));
    }
    case 'exitTest': location.href = location.pathname + (localParam().local ? '?local=1' : ''); return;
    case 'toggleLog': ui.showLog = !ui.showLog; return render();
    case 'closeResults': document.querySelector('.overlay')?.remove(); return;
    case 'replace': extra = { slot: s }; return action('replace');
    case 'peek': extra = { slot: s }; return action('peek');
    case 'swapMine': ui.swapSlot = s; return render();
    case 'swapTarget':
      extra = { slot: ui.swapSlot, target: Number(el.dataset.p), targetSlot: s };
      ui.swapSlot = null;
      return action('swap');
    case 'ready': case 'call': case 'drawDeck': case 'takeDiscard':
    case 'discardDrawn': case 'usePower': case 'skipPower': case 'nextRound':
      return action(act);
  }
}

$app.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled) onAct(el);
});
$app.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('#code, #name')) {
    onAct({ dataset: { act: e.target.id === 'code' || ui.joinCode ? 'join' : 'create' } });
  } else if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card[data-act]')) {
    e.preventDefault();
    onAct(e.target);
  }
});

render();
