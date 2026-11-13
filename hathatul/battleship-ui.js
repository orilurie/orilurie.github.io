// צוללות – HUD (DOM overlay) and controller between the game state and the 3D scene.

import { FLEET, SIZE, cellName, randomFleet, validatePartial } from './battleship.js?v=25';
import { play, haptic } from './sfx.js?v=25';
import { confetti } from './anim.js?v=25';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameOf = type => FLEET.find(f => f.type === type).name;
const ICON = { carrier: '🛳️', battleship: '🚢', cruiser: '⛴️', submarine: '🤿', destroyer: '🚤' };

export const battleshipRulesHtml = () => `<ul>
  <li>קרב ימי לשני שחקנים, כל אחד על לוח 10×10.</li>
  <li>לכל אחד צי של 5 כלי שיט: נושאת מטוסים (5), אוניית מערכה (4), סיירת (3), צוללת (3) ומשחתת (2). ספינות לא יכולות לגעת זו בזו, גם לא באלכסון.</li>
  <li>בהתחלה ממקמים את הצי: "סידור אקראי", או לוחצים על ספינה ואז על משבצת כדי להזיז אותה, ו"סובב" כדי לסובב.</li>
  <li>בתורך בוחרים משבצת בים של היריב ויורים טיל. 💦 החטאה, 💥 פגיעה, ואם כל משבצות הספינה נפגעו – היא טובעת.</li>
  <li>לכל אחד ירייה אחת בתור. מי שמטביע ראשון את כל הצי של היריב – מנצח!</li>
</ul>`;

let ctx = null; // { render, send, toast, ui }

// Visual settings, remembered on this device.
const OPT_KEY = 'hathatul-bs-opts';
const OPT_LABELS = [
  ['topDown', '🛰️ מבט מלמעלה', 'הלוח נראה ממש מלמעלה, כמו מפה'],
  ['smoke', '💨 עשן', 'עשן מפיצוצים, מספינות בוערות ומשובל הטיל'],
  ['fire', '🔥 אש ולהבות', 'להבות על משבצות שנפגעו'],
  ['chase', '🎬 מעקב אחרי הטיל', 'המצלמה רודפת אחרי הטיל ורואה את הפגיעה מקרוב'],
  ['shake', '📳 רעידת מצלמה', 'המסך רועד בפיצוץ'],
  ['bloom', '✨ זוהר', 'הילה זוהרת סביב אש ושמש (כבד יותר לטלפון)'],
];
export const bsOpts = (() => {
  const d = { topDown: false, smoke: true, fire: true, shake: true, bloom: true, chase: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem(OPT_KEY) || '{}') }; } catch { return d; }
})();
function saveOpts() {
  try { localStorage.setItem(OPT_KEY, JSON.stringify(bsOpts)); } catch {}
  scene?.setOptions(bsOpts);
}
let scene = null, loading = null, failed = false;
let queue = Promise.resolve();
const pending = new Set(); // markers/sinks still being animated: "grid:x,y", "sink:grid:type"

export function initBattleship(c) { ctx = c; }

// ---------- HUD ----------
export function renderBattleshipHud(v, ui) {
  const me = v.players[v.me], enemy = v.players[1 - v.me];
  const myTurn = v.phase === 'play' && v.turn === v.me;
  const placing = v.phase === 'place' && !me.ready;
  if (placing && !ui.bsFleet) ui.bsFleet = randomFleet();
  if (!placing) ui.bsSel = null;
  if (!myTurn) ui.bsAim = null;

  let status;
  if (v.phase === 'place') status = me.ready ? `מחכים ש${esc(enemy.name)} יסיים/תסיים למקם את הצי…` : 'מקמו את הצי שלכם';
  else if (v.phase === 'end') status = v.winner === v.me ? '🏆 ניצחת בקרב!' : `${esc(enemy.name)} ניצח/ה בקרב`;
  else if (ui.bsBusy || ui.bsAnimating) status = '🚀 טיל בדרך…';
  else if (myTurn) status = ui.bsAim ? `יעד: ${cellName(ui.bsAim.x, ui.bsAim.y)} – לחצו "אש!" או שוב על המשבצת` : '🎯 התור שלך! בחרו משבצת בים של היריב';
  else status = `⏳ ${esc(enemy.name)} מכוון/ת…`;

  const fleetRow = (label, fleet, cls) => `<div class="bs-fleet ${cls}"><span class="bs-fl-label">${label}</span>${fleet.map(f =>
    `<span class="bs-ship ${f.sunk ? 'sunk' : ''}" title="${nameOf(f.type)}">${ICON[f.type]}<i>${'▮'.repeat(f.len)}</i></span>`).join('')}</div>`;

  let actions = '';
  if (placing) {
    actions = `<div class="bs-hint">${ui.bsSel ? `נבחרה: <b>${nameOf(ui.bsSel)}</b> – לחצו על משבצת כדי להזיז אותה` : 'גררו ספינה כדי להזיז אותה, או לחצו עליה ואז על משבצת'}</div>
      <div class="bs-btns">
        <button data-act="bsRandom">🎲 סידור אקראי</button>
        <button data-act="bsRotate" ${ui.bsSel ? '' : 'disabled'}>🔄 סובב</button>
        <button class="primary" data-act="bsReady">✅ מוכן לקרב!</button>
      </div>`;
  } else if (myTurn && ui.bsAim && !ui.bsBusy) {
    actions = `<div class="bs-btns"><button class="fire" data-act="bsFire">🔥 אש על ${cellName(ui.bsAim.x, ui.bsAim.y)}!</button></div>`;
  }
  const viewBtn = v.phase === 'play'
    ? `<button class="bs-view" data-act="bsView">${(ui.bsViewNow || 'mine') === 'enemy' ? '🛡️ הצי שלי' : '🎯 ים היריב'}</button>` : '';

  return `
    <div class="bs-hud">
      <header class="top bs-top">
        <div class="bs-title"><b>🚢 צוללות</b>${ui.room.test ? ' · 🧪' : ''}</div>
        <button class="ghost bs-tv" data-act="bsTopDown" title="החלפת מבט">${bsOpts.topDown ? '🎥 קולנועי' : '🛰️ מלמעלה'}</button>
        <button class="ghost icon-btn" data-act="bsSettings" aria-label="הגדרות תצוגה" title="הגדרות תצוגה">⚙️</button>
        ${ui.headerButtons}
      </header>
      <div class="bs-versus">
        <span class="bs-player bs-me ${myTurn ? 'turn' : ''}" data-seat="${v.me}">${esc(me.name)} <small>🏆${me.wins}</small></span>
        <span class="bs-vs">נגד</span>
        <span class="bs-player bs-enemy ${v.phase === 'play' && !myTurn ? 'turn' : ''}" data-seat="${1 - v.me}">${esc(enemy.name)} <small>🏆${enemy.wins}</small></span>
      </div>
      <div class="bs-status ${myTurn ? 'mine' : ''}">${status}</div>
      ${v.phase !== 'place' ? `<div class="bs-fleets">${fleetRow('היריב', v.enemyFleet, 'enemy')}${fleetRow('שלי', v.myFleet, 'mine')}</div>` : ''}
      ${failed ? `<div class="bs-nogl">המכשיר הזה לא תומך בגרפיקת תלת־ממד (WebGL), ולכן אי אפשר להציג את הקרב.</div>` : ''}
      <div class="bs-bottom">
        ${actions}
        <div class="bs-row">${viewBtn}${ui.emojiBar}</div>
      </div>
    </div>
    ${v.phase === 'end' && ui.resultsReady ? resultsHtml(v, ui) : ''}
    ${ui.bsSettingsOpen ? settingsHtml() : ''}`;
}

function settingsHtml() {
  return `<div class="overlay"><div class="panel bs-settings" role="dialog" aria-modal="true">
    <h2>⚙️ הגדרות תצוגה</h2>
    ${OPT_LABELS.map(([k, label, hint]) => `<button class="bs-opt ${bsOpts[k] ? 'on' : ''}" data-act="bsOpt" data-o="${k}" role="switch" aria-checked="${bsOpts[k]}">
      <span class="bs-opt-text"><b>${label}</b><small>${hint}</small></span><span class="bs-switch"></span></button>`).join('')}
    <button class="primary" data-act="bsSettings">סגירה</button>
  </div></div>`;
}

function resultsHtml(v, ui) {
  const won = v.winner === v.me;
  return `<div class="overlay"><div class="panel results bs-results">
    <div class="bs-res-icon">${won ? '🏆' : '⚓'}</div>
    <h2>${won ? 'ניצחת בקרב!' : `${esc(v.players[v.winner].name)} ניצח/ה`}</h2>
    <p class="sub">${won ? 'כל הצי של היריב הוטבע.' : 'הצי שלך הוטבע. בפעם הבאה!'}</p>
    <table><tbody>${v.players.map(p => `<tr class="${p.id === v.players[v.winner].id ? 'win' : ''}"><td>${esc(p.name)}</td><td>🏆 ${p.wins}</td></tr>`).join('')}</tbody></table>
    ${ui.room.isHost ? `<button class="primary" data-act="nextRound">⚓ קרב חוזר</button>` : `<p class="sub">מחכים למארח/ת…</p>`}
    <button class="ghost" data-act="closeResults">הצג את הים</button>
  </div></div>`;
}

// ---------- actions from the HUD ----------
export function battleshipAct(act, ui, el) {
  if (act === 'bsOpt') { const k = el.dataset.o; bsOpts[k] = !bsOpts[k]; saveOpts(); play('pop'); return true; }
  const v = ui.view;
  if (act === 'bsRandom') { ui.bsFleet = randomFleet(); ui.bsSel = null; play('shuffle'); return true; }
  if (act === 'bsRotate' && ui.bsSel) {
    const fleet = ui.bsFleet.map(s => ({ ...s }));
    const s = fleet.find(x => x.type === ui.bsSel);
    s.dir = s.dir === 'h' ? 'v' : 'h';
    const len = FLEET.find(f => f.type === s.type).len;
    // keep it on the board
    if (s.dir === 'h') s.x = Math.min(s.x, SIZE - len); else s.y = Math.min(s.y, SIZE - len);
    if (validatePartial(fleet)) { nope('אין מקום לסובב כאן – ספינות לא יכולות לגעת זו בזו'); return true; }
    ui.bsFleet = fleet; play('place'); return true;
  }
  if (act === 'bsReady') {
    ctx.send({ t: 'action', action: { type: 'place', ships: ui.bsFleet } });
    play('sonar');
    return true;
  }
  if (act === 'bsFire') { fire(ui); return true; }
  if (act === 'bsTopDown') { bsOpts.topDown = !bsOpts.topDown; saveOpts(); play('pop'); return true; }
  if (act === 'bsSettings') { ui.bsSettingsOpen = !ui.bsSettingsOpen; return true; }
  if (act === 'bsView') {
    ui.bsViewNow = (ui.bsViewNow || 'mine') === 'enemy' ? 'mine' : 'enemy';
    ui.bsManualView = true;
    scene?.setView(ui.bsViewNow);
    return true;
  }
  return false;
}

function nope(text) { ctx.toast(text); play('nope'); haptic('nope'); }

function fire(ui) {
  const a = ui.bsAim;
  if (!a || ui.bsBusy) return;
  ui.bsAim = null;
  ui.bsBusy = true; // until the shot animation finishes
  ctx.send({ t: 'action', action: { type: 'fire', x: a.x, y: a.y } });
  setTimeout(() => { if (ui.bsBusy && !ui.bsAnimating) { ui.bsBusy = false; ctx.render(); } }, 4000); // safety
}

// ---------- dragging ships while placing ----------
const placing = () => { const v = ctx.ui.view; return v?.phase === 'place' && !v.players[v.me].ready; };
const canDrag = () => placing();
const movedFleet = (type, x, y) => ctx.ui.bsFleet.map(s => (s.type === type ? { ...s, x, y } : { ...s }));
function onShipDrag(type, x, y) {
  play('tick');
  return !validatePartial(movedFleet(type, x, y));
}
function onShipDrop(type, x, y, ok) {
  const ui = ctx.ui;
  if (ok) {
    ui.bsFleet = movedFleet(type, x, y);
    ui.bsSel = type;
    play('place');
    haptic('tap');
  } else if (!(x === ui.bsFleet.find(s => s.type === type).x && y === ui.bsFleet.find(s => s.type === type).y)) {
    nope(validatePartial(movedFleet(type, x, y)) === 'out' ? 'הספינה יוצאת מהלוח' : 'אי אפשר לשם – ספינות לא יכולות לגעת זו בזו');
  }
  ctx.render();
}

// ---------- taps in the 3D scene ----------
function onShip(type) {
  const ui = ctx.ui, v = ui.view;
  if (!(v.phase === 'place' && !v.players[v.me].ready)) return false;
  ui.bsSel = ui.bsSel === type ? null : type;
  play('pop');
  ctx.render();
  return true;
}

function onCell(grid, x, y) {
  const ui = ctx.ui, v = ui.view;
  if (v.phase === 'place' && !v.players[v.me].ready) {
    if (grid !== 'mine' || !ui.bsSel) return;
    const fleet = ui.bsFleet.map(s => (s.type === ui.bsSel ? { ...s, x, y } : { ...s }));
    const err = validatePartial(fleet);
    if (err) return nope(err === 'out' ? 'הספינה יוצאת מהלוח' : 'אי אפשר לשם – ספינות לא יכולות לגעת זו בזו');
    ui.bsFleet = fleet;
    play('place');
    ctx.render();
    return;
  }
  if (v.phase !== 'play' || grid !== 'enemy') return;
  if (v.turn !== v.me) return nope(`זה התור של ${v.players[v.turn].name}`);
  if (ui.bsBusy) return;
  if (v.myShots[`${x},${y}`]) return nope('כבר ירית לשם');
  if (ui.bsAim && ui.bsAim.x === x && ui.bsAim.y === y) return fire(ui);
  ui.bsAim = { x, y };
  play('aim');
  haptic('tap');
  ctx.render();
}

// ---------- keep the 3D scene in step with the state ----------
export function syncBattleship(v, ui) {
  if (failed) return;
  if (!scene) {
    if (!loading) {
      let stage = document.getElementById('bs-stage');
      if (!stage) {
        stage = document.createElement('div');
        stage.id = 'bs-stage';
        document.body.prepend(stage);
      }
      loading = import('./battleship-3d.js?v=25').then(m => {
        if (!m.webglAvailable()) { failed = true; ctx.render(); return; }
        scene = new m.Battle3D(stage, { onCell, onShip, canDrag, onShipDrag, onShipDrop });
        scene.setOptions(bsOpts);
        if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { __bsScene: scene, __bsUi: ctx.ui, __bsCell: onCell, __bsWave: m.waveHeight });
        syncBattleship(ctx.ui.view, ctx.ui);
      }).catch(err => { console.error(err); failed = true; ctx.render(); });
    }
    return;
  }
  const me = v.players[v.me];
  const placing = v.phase === 'place' && !me.ready;
  const fleetMine = placing
    ? (ui.bsFleet || []).map(s => ({ ...s, len: FLEET.find(f => f.type === s.type).len }))
    : (v.myShips || []).map(s => ({ ...s, sunk: s.hits.length === s.len && !pending.has(`sink:mine:${s.type}`) }));
  scene.syncShips('mine', fleetMine, { selected: placing ? ui.bsSel : null });
  const enemyList = (v.enemyShips
    ? v.enemyShips.map(s => ({ ...s, sunk: v.enemySunk.some(x => x.type === s.type) && !pending.has(`sink:enemy:${s.type}`) }))
    : v.enemySunk.filter(s => !pending.has(`sink:enemy:${s.type}`)).map(s => ({ ...s, sunk: true })));
  scene.syncShips('enemy', enemyList, { ghost: !!v.enemyShips });
  scene.syncMarkers('mine', v.shotsAtMe, pending);
  scene.syncMarkers('enemy', v.myShots, pending);
  if (!ui.bsAnimating) {
    scene.setHighlight(ui.bsAim ? 'enemy' : null, ui.bsAim);
    scene.setActiveGrid(v.phase === 'place' ? 'mine' : v.phase === 'play' ? (v.turn === v.me ? 'enemy' : 'mine') : null);
    const want = v.phase === 'place' ? 'mine' : v.phase === 'end' ? 'overview' : v.turn === v.me ? 'enemy' : 'mine';
    if (ui.bsAutoView !== want) { ui.bsAutoView = want; ui.bsManualView = false; }
    const target = ui.bsManualView ? ui.bsViewNow : want;
    if (scene.view !== target) scene.setView(target);
    ui.bsViewNow = target;
  }
}

// Before the screen re-renders with a new state: hold back markers/sinks whose animation is coming.
export function prepareBattleshipEvents(fresh, v) {
  for (const ev of fresh) {
    if (ev.type === 'shot') {
      const grid = ev.by === v.me ? 'enemy' : 'mine';
      pending.add(`${grid}:${ev.x},${ev.y}`);
      if (ev.sunk) pending.add(`sink:${grid}:${ev.sunk.type}`);
    }
    if (ev.type === 'newRound') pending.clear();
  }
  if (fresh.some(e => e.type === 'shot' || e.type === 'battle')) ctx.ui.bsAnimating = true;
}

function banner(text, kind = '') {
  document.querySelectorAll('.bs-banner').forEach(b => b.remove()); // one message at a time
  const el = document.createElement('div');
  el.className = `bs-banner ${kind}`;
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.classList.add('out'), 1700);
  setTimeout(() => el.remove(), 2200);
}
const wait = ms => new Promise(r => setTimeout(r, ms / (window.__bsSpeed || 1)));

export function playBattleshipEvents(fresh, before, v) {
  const ui = ctx.ui;
  const run = async () => {
    if (!scene) await loading;
    for (const ev of fresh) {
      if (!scene) break;
      if (ev.type === 'newRound') {
        ui.bsFleet = null; ui.bsSel = null; ui.bsAim = null;
        play('shuffle');
        banner('⚓ מקמו את הצי!');
        ctx.render();
      } else if (ev.type === 'ready' && ev.pi !== v.me) {
        play('sonar');
        ctx.toast('היריב מוכן לקרב!');
      } else if (ev.type === 'battle') {
        play('sonar');
        haptic('turn');
        banner('⚔️ הקרב מתחיל!', 'big');
        await scene.setView('overview');
        await wait(900);
      } else if (ev.type === 'shot') {
        const mine = ev.by === v.me;
        const grid = mine ? 'enemy' : 'mine';
        await scene.setView(mine ? 'enemy' : 'mine');
        play('launch');
        await scene.shot(grid, ev.x, ev.y, ev.result);
        pending.delete(`${grid}:${ev.x},${ev.y}`);
        if (ev.result === 'miss') {
          play('splash');
          banner(mine ? '💦 החטאה' : '💦 היריב החטיא', 'miss');
        } else {
          play(ev.result === 'sunk' ? 'bigboom' : 'boom');
          haptic(mine ? 'tap' : 'swapped');
          banner(mine ? '💥 פגיעה!' : '💥 נפגעת!', 'hit');
        }
        if (ev.sunk) {
          await wait(700);
          play('sink');
          banner(mine ? `🔥 הטבעת את ה${nameOf(ev.sunk.type)}!` : `☠️ ה${nameOf(ev.sunk.type)} שלך הוטבעה!`, 'big');
          haptic('call');
          if (mine) await scene.revealAndSink(ev.sunk);
          else await scene.sinkShip('mine', ev.sunk.type);
          pending.delete(`sink:${grid}:${ev.sunk.type}`);
        }
        await wait(800);
      } else if (ev.type === 'end') {
        const won = ev.winner === v.me;
        banner(won ? '🏆 ניצחון!' : '⚓ הפסד', 'big');
        if (won) { confetti(); haptic('win'); }
        play(won ? 'win' : 'lose');
        await scene.setView('overview');
        await wait(1200);
      }
    }
    ui.bsAnimating = false;
    ui.bsBusy = false;
    if (v.phase === 'end') document.querySelectorAll('.bs-banner').forEach(b => b.remove());
    ctx.render();
  };
  queue = queue.then(run, run);
  return queue;
}
