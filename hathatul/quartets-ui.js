// רביעיות – screen, interactions and animations. Rendering is driven by app.js.

import { RANK_NAMES, rankMany, MAX_PLAYERS } from './quartets.js?v=21';
import { fly, burst } from './anim.js?v=21';
import { play, haptic } from './sfx.js?v=21';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const red = suit => suit === '♥' || suit === '♦';
const FACE = { K: '👑', Q: '👸', J: '🤴', A: '' };
const rankOne = r => RANK_NAMES[r]?.one || r;

export const quartetsRulesHtml = () => `<ul>
  <li>משחקים עם חפיסה רגילה. <b>רביעייה</b> = ארבעת הקלפים של אותו ערך, אחד מכל צורה (♠♥♦♣).</li>
  <li>כל הקלפים מחולקים לשחקנים. גודל החפיסה לפי מספר השחקנים (בערך 10 קלפים לכל אחד): תמיד אסים, מלכים, מלכות ונסיכים, ועוד מספרים מ-10 ומטה.</li>
  <li>בתורך: בוחרים ערך שיש לכם ביד ושואלים שחקן אחר, למשל "דנה, יש לך מלכים?".</li>
  <li>אם יש לו, הוא חייב לתת לכם את <b>כל</b> הקלפים מהערך הזה. בכל מקרה, לכל אחד שאלה אחת בתור, ואז התור עובר לשחקן הבא.</li>
  <li>רביעייה שלמה יורדת לשולחן אוטומטית. מי שנגמרים לו הקלפים יוצא מהמשחק.</li>
  <li>רואים רק את השאלה האחרונה, אז כדאי לזכור מי ביקש מה!</li>
  <li>כשכל הרביעיות על השולחן, מנצח מי שאסף הכי הרבה.</li>
</ul>`;

export function pcardHtml(c, cls = '') {
  if (!c) return `<div class="pcard back ${cls}"><span>🂠</span></div>`;
  return `<div class="pcard ${red(c.suit) ? 'red' : ''} ${cls}"><i>${c.rank}<br>${c.suit}</i><b>${FACE[c.rank] || c.suit}</b></div>`;
}

const chips = qs => qs.map(r => `<span class="qchip">${r}</span>`).join('');

export function renderQuartets(v, ui) {
  const myTurn = v.phase === 'play' && v.turn === v.me;
  const meP = v.players[v.me];
  const myPos = v.order.indexOf(v.me);
  const seatNo = i => v.order.indexOf(i) + 1;
  const badge = i => `<span class="seat" title="מקום בסדר התורות">${seatNo(i)}</span>`;
  if (!myTurn) ui.qRank = null;
  if (ui.qRank && !meP.hand?.some(c => c.rank === ui.qRank)) ui.qRank = null;

  const opps = v.order
    .map((_, k) => v.order[(myPos + 1 + k) % v.order.length])
    .filter(i => i !== v.me)
    .map(i => {
      const p = v.players[i];
      const conn = ui.room.players[i]?.connected === false ? ' <small class="off">(מנותק/ת)</small>' : '';
      const askable = myTurn && !p.out;
      const fan = p.hand
        ? p.hand.map(c => pcardHtml(c, 'mini')).join('')
        : Array.from({ length: Math.min(p.count, 10) }, () => pcardHtml(null, 'mini')).join('');
      return `<div class="opp qopp ${v.turn === i && v.phase === 'play' ? 'active' : ''} ${p.out ? 'out' : ''} ${askable ? 'clickable' : ''} ${askable && ui.qRank ? 'askable' : ''}"
          data-seat="${i}" data-k="qo-${i}" ${askable ? `data-act="qAsk" data-p="${i}" role="button" tabindex="0"` : ''}>
        <div class="oname">${badge(i)}${esc(p.name)}${conn}</div>
        <div class="qfan" data-k="qf-${i}">${p.out ? '<span class="qout">יצא/ה מהמשחק</span>' : fan}</div>
        <div class="qmeta">🂠 ${p.count} · 🏆 ${p.quartets.length}</div>
        <div class="qchips" data-k="qq-${i}">${chips(p.quartets)}</div>
      </div>`;
    }).join('');

  // My hand, grouped by rank. Tap a group (or drag it onto a player) to ask for that rank.
  const groups = [];
  for (const c of meP.hand || []) {
    const g = groups.find(x => x.rank === c.rank);
    if (g) g.cards.push(c); else groups.push({ rank: c.rank, cards: [c] });
  }
  const hand = groups.map(g => `<div class="qgroup ${ui.qRank === g.rank ? 'sel' : ''} ${myTurn ? 'clickable' : ''}" data-k="qr-${g.rank}"
      ${myTurn ? `data-act="qSelect" data-r="${g.rank}" role="button" tabindex="0"` : ''}>
      <div class="qstack">${g.cards.map(c => pcardHtml(c)).join('')}</div>
      <span class="qcount">${g.cards.length}/4</span>
    </div>`).join('');

  const last = v.last;
  const lastHtml = last
    ? `<div class="qask">
        <div class="qq-line"><b>${esc(v.players[last.from].name)}</b> שאל/ה את <b>${esc(v.players[last.to].name)}</b>:</div>
        <div class="qq-big">"יש לך ${rankMany(last.rank)}?"</div>
        <div class="qq-ans ${last.got ? 'yes' : 'no'}">${last.got ? `✅ קיבל/ה ${last.got === 1 ? 'קלף אחד' : `${last.got} קלפים`}` : '❌ אין!'}</div>
      </div>`
    : `<div class="qask"><div class="qq-big">🔀 סדר התורות</div><div class="qq-line">${v.order.map(i => esc(v.players[i].name)).join(' ← ')}</div></div>`;
  const laid = v.players.reduce((s, p) => s + p.quartets.length, 0);

  let status;
  if (v.phase === 'end') status = 'המשחק נגמר!';
  else if (!myTurn) status = `התור של ${esc(v.players[v.turn].name)}`;
  else if (!ui.qRank) status = 'התור שלך! בחרו ערך מהיד, ואז שחקן לשאול (או גררו את הקלפים אליו)';
  else status = `בחרתם ${rankMany(ui.qRank)}. עכשיו לחצו על השחקן שתרצו לשאול`;

  return `
    <header class="top">
      <div><b>🃏 רביעיות</b> · ${ui.room.test ? '🧪 חדר בדיקה' : `חדר <span dir="ltr">${ui.room.code}</span>`} · משחק ${v.round}</div>
      ${ui.headerButtons}
    </header>
    <section class="opps">${opps}</section>
    <section class="table qtable">
      ${lastHtml}
      <div class="qprogress">רביעיות על השולחן: ${laid}/${v.ranks.length}</div>
    </section>
    <div class="status ${myTurn ? 'mine' : ''}">${status}</div>
    <div class="controls"></div>
    <section class="me ${myTurn ? 'active' : ''}" data-seat="${v.me}" data-k="qo-${v.me}">
      <div class="oname">${badge(v.me)}${esc(meP.name)} ${ui.room.test ? '(בתור)' : '(את/ה)'} <span class="pts">🏆 ${meP.quartets.length}</span></div>
      <div class="qchips mine" data-k="qq-${v.me}">${chips(meP.quartets)}</div>
      <div class="qhand" data-k="qf-${v.me}">${meP.out ? '<span class="qout">נגמרו לך הקלפים – יצאת מהמשחק. צפו בהמשך!</span>' : hand}</div>
    </section>
    ${ui.emojiBar}
    ${v.phase === 'end' && ui.resultsReady ? resultsHtml(v, ui) : ''}`;
}

function resultsHtml(v, ui) {
  const rows = v.results.slice().sort((a, b) => b.quartets - a.quartets)
    .map((r, i) => `<tr class="${r.winner ? 'win' : ''}" style="--i:${i}"><td>${r.winner ? '<span class="trophy">🏆</span> ' : ''}${esc(r.name)}</td><td>${r.quartets}</td><td>${v.players.find(p => p.id === r.id).quartets.join(' ') || '–'}</td></tr>`).join('');
  return `<div class="overlay"><div class="panel results">
    <h2>סוף משחק ${v.round}</h2>
    <table><thead><tr><th>שחקן</th><th>רביעיות</th><th>אילו</th></tr></thead><tbody>${rows}</tbody></table>
    ${ui.room.isHost ? `<button class="primary" data-act="nextRound">משחק חוזר</button>` : `<p class="sub">מחכים למארח/ת…</p>`}
    <button class="ghost" data-act="closeResults">הצג את השולחן</button>
  </div></div>`;
}

// ---------- drag & drop: drag a rank group onto a player to ask them ----------
export function quartetsDragTargets(key, v, act) {
  if (!v || v.phase !== 'play' || v.turn !== v.me || !key.startsWith('qr-')) return null;
  const rank = key.slice(3);
  const T = v.players
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => i !== v.me && !p.out)
    .map(({ p, i }) => ({ key: `qo-${i}`, hint: `לשאול: ${rankMany(rank)}?`, go: () => act('ask', { target: i, rank }) }));
  return T.length ? T : null;
}

export function quartetsWhy(key, v) {
  if (!v || !key.startsWith('qr-')) return null;
  if (v.phase !== 'play') return null;
  if (v.turn !== v.me) return `זה התור של ${v.players[v.turn].name}`;
  return null;
}

// ---------- animations ----------
const wait = ms => new Promise(r => setTimeout(r, ms));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function bubble(seat, text, cls = '') {
  const host = document.querySelector(`[data-seat="${seat}"]`);
  if (!host) return;
  const r = host.getBoundingClientRect();
  const b = document.createElement('div');
  b.className = `qbubble ${cls}`;
  b.textContent = text;
  b.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top + 4}px`;
  document.getElementById('fx').append(b);
  const anim = b.animate(reduced()
    ? [{ opacity: 1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }]
    : [
      { transform: 'translate(-50%,-80%) scale(.4)', opacity: 0 },
      { transform: 'translate(-50%,-110%) scale(1.08)', opacity: 1, offset: 0.12 },
      { transform: 'translate(-50%,-110%) scale(1)', opacity: 1, offset: 0.85 },
      { transform: 'translate(-50%,-130%) scale(.9)', opacity: 0 },
    ], { duration: 1700, easing: 'ease-out' });
  anim.finished.then(() => b.remove());
  if (cls === 'no' && !reduced()) host.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(7px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(0)' }], { duration: 400, delay: 150 });
}

const cardFrom = (snap, html) => snap && { rect: centerCard(snap.rect), html };
function centerCard(r) {
  const w = 34;
  return { left: r.left + r.width / 2 - w / 2, top: r.top + r.height / 2 - w * 0.7, width: w, height: w * 1.4 };
}

export async function playQuartetEvents(events, before, v) {
  const me = v.me;
  for (const ev of events) {
    switch (ev.type) {
      case 'deal': {
        play('shuffle');
        const n = v.players.length;
        const jobs = [];
        const src = document.querySelector('.qtable');
        const from = src && { rect: centerCard(src.getBoundingClientRect()), html: pcardHtml(null) };
        for (let k = 0; k < Math.min(n * 4, 24); k++) {
          const pi = v.order[k % n];
          setTimeout(() => play('tick'), k * 70);
          jobs.push(fly(from, `qf-${pi}`, { delay: k * 70, duration: 420, arc: 30, hide: false, size: pi === me ? 46 : 30 }));
        }
        await Promise.all(jobs);
        break;
      }
      case 'ask': {
        play('pop');
        bubble(ev.from, `${v.players[ev.to].name}, יש לך ${rankMany(ev.rank)}?`);
        await wait(reduced() ? 0 : 700);
        if (ev.got) {
          play('draw');
          if (ev.to === me) haptic('swapped');
          const src = ev.to === me ? before[`qr-${ev.rank}`] : before[`qf-${ev.to}`];
          const card = { rank: ev.rank, suit: '♠' };
          const dest = ev.from === me ? `qr-${ev.rank}` : `qf-${ev.from}`;
          const html = ev.from === me ? pcardHtml(card) : pcardHtml(null);
          await Promise.all(Array.from({ length: ev.got }, (_, i) =>
            fly(cardFrom(src, html), dest, { delay: i * 120, duration: 520, arc: 50, hide: false, size: ev.from === me ? 46 : 30 })));
        } else {
          play('nope');
          bubble(ev.to, 'אין לי! ❌', 'no');
          await wait(reduced() ? 0 : 600);
        }
        break;
      }
      case 'quartet':
        play('power');
        if (ev.pi === me) haptic('win');
        burst(`[data-k="qq-${ev.pi}"]`, '🎉');
        bubble(ev.pi, `רביעיית ${rankMany(ev.rank)}! 🎉`, 'yes');
        await wait(reduced() ? 0 : 500);
        break;
      case 'out':
        bubble(ev.pi, 'נגמרו הקלפים – יצא/ה מהמשחק', 'no');
        break;
      case 'end':
        await wait(reduced() ? 0 : 600);
        break;
    }
  }
}

export { MAX_PLAYERS as QUARTETS_MAX_PLAYERS, rankOne };
