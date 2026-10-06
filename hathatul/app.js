import { createGame, applyAction, viewFor, POWERS, MIN_PLAYERS, MAX_PLAYERS } from './game.js';
import { hostTransport, clientTransport } from './net.js';
import { snapshot, playEvents, turnFx, confetti } from './anim.js';

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
    const before = snapshot();
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
    ui.screen = msg.room.started ? 'game' : 'lobby';
    ui.error = '';
    history.replaceState(null, '', `?${new URLSearchParams({ ...localParam(), room: msg.room.code })}`);
    render();
    if (ui.view) animate(fresh, before, prev);
    return;
  } else if (msg.t === 'reveal') {
    ui.reveal = { slot: msg.slot, card: msg.card };
    setTimeout(() => { ui.reveal = null; render(); }, 4000);
  } else if (msg.t === 'error') {
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
  if (ui.screen === 'home') return renderHome();
  if (ui.screen === 'connecting') {
    $app.innerHTML = `<div class="panel center"><div class="spinner"></div><p>מתחבר…</p></div>`;
    return;
  }
  if (ui.screen === 'lobby') return renderLobby();
  renderGame();
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
      <details class="rules"><summary>איך משחקים?</summary>${rulesHtml()}</details>
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
  }

  const controls = [];
  if (v.phase === 'peek' && !meP.ready) controls.push(`<button class="primary" data-act="ready">זכרתי! הסתר את הקלפים</button>`);
  if (myTurn && !pend && v.canCall) controls.push(`<button class="call" data-act="call">📣 חתחתול!</button>`);
  if (myTurn && (pend?.type === 'peek' || pend?.type === 'swap')) controls.push(`<button data-act="skipPower">דלג</button>`);

  $app.innerHTML = `
    <header class="top">
      <div><b>חתחתול</b> · חדר <span dir="ltr">${ui.room.code}</span> · סיבוב ${v.round}</div>
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
      <div class="oname">${v.calledBy === v.me ? '📣 ' : ''}${esc(meP.name)} (את/ה) <span class="pts">${meP.total} נק׳</span></div>
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
