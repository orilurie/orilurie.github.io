// המתחזה – screens and interactions. Rendering is driven by app.js.

import { play, haptic } from './sfx.js?v=37';
import { confetti } from './anim.js?v=37';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const imposterRulesHtml = () => `<ul>
  <li>3 עד 6 שחקנים. כולם מקבלים את אותה מילה סודית – חוץ מהמתחזה (או שניים, מ-5 שחקנים), שמקבל רק רמז (אפשר לכבות את הרמז בהגדרות).</li>
  <li>כל אחד בתורו אומר מילה אחת שקשורה למילה הסודית. לא קל מדי – כדי שהמתחזה לא יבין, ולא קשה מדי – כדי שלא יחשדו בכם.</li>
  <li>אחרי סבב הרמזים כולם מצביעים: מי המתחזה?</li>
  <li>מתחזה שלא נתפס מקבל 3 נקודות. מתחזה שנתפס מקבל הזדמנות אחרונה לנחש את המילה מתוך 8 אפשרויות – ניחוש נכון שווה 2 נקודות.</li>
  <li>כל מי שהצביע נכון על מתחזה מקבל נקודה.</li>
</ul>`;

const outcomeText = {
  citizens: ['🎉 המתחזה נתפס!', 'האזרחים ניצחו בסבב הזה'],
  imposters: ['🕵️ המתחזה ניצח!', 'אף אחד לא זיהה אותו'],
  stolen: ['😈 נתפס – אבל ניחש את המילה!', 'המתחזה הציל את עצמו'],
  mixed: ['⚖️ חצי הצלחה', 'מתחזה אחד נתפס, השני חמק'],
};

function playerChip(v, i, extra = '') {
  const p = v.players[i];
  return `<span class="im-chip ${i === v.me ? 'me' : ''} ${extra}" data-seat="${i}">${esc(p.name)}</span>`;
}

function secretCard(v, ui) {
  const open = ui.imPeek;
  const front = v.role === 'imposter'
    ? `<div class="im-role imp">🕵️ אתה המתחזה!</div>
       <div class="im-sub">${v.k === 2 ? 'יש עוד מתחזה אחד – אבל לא תדעו מי.' : 'כולם יודעים את המילה – חוץ ממך.'}</div>
       ${v.hint ? `<div class="im-hintlabel">הרמז שלך:</div><div class="im-word">${esc(v.hint)}</div>` : '<div class="im-hintlabel">אין רמז בסבב הזה – הקשיבו לאחרים ונסו להשתלב 🤐</div>'}`
    : `<div class="im-role cit">המילה הסודית</div>
       <div class="im-word">${esc(v.word)}</div>
       <div class="im-sub">קטגוריה: ${esc(v.category)}</div>`;
  return `<div class="im-card ${open ? 'open' : ''}" data-act="imPeek" role="button" tabindex="0" aria-label="הצצה בכרטיס">
    <div class="im-card-inner">
      <div class="im-face im-back"><span>🤫</span><b>לחצו כדי להציץ</b><small>שימו לב שאף אחד לא מסתכל</small></div>
      <div class="im-face im-front">${front}</div>
    </div>
  </div>`;
}

export function renderImposter(v, ui) {
  const isHost = ui.room.isHost;
  if (ui.imRound !== v.round) { ui.imRound = v.round; ui.imPeek = false; ui.imSel = []; } // new round: card closed
  const me = v.players[v.me];
  let body = '';

  if (v.phase === 'setup') {
    body = isHost
      ? `<div class="panel im-panel">
          <h2>הגדרות</h2>
          <div class="im-setting"><span>מספר מתחזים</span>
            <div class="im-seg">${[1, 2].map(k => `<button class="${v.settings.imposters === k ? 'on' : ''}" data-act="imSet" data-imposters="${k}" ${k > v.maxImposters ? 'disabled title="מ-5 שחקנים"' : ''}>${k}</button>`).join('')}</div></div>
          ${v.maxImposters < 2 ? '<p class="hint">שני מתחזים אפשר מ-5 שחקנים.</p>' : ''}
          <div class="im-setting"><span>סבבי רמזים</span>
            <div class="im-seg">${[1, 2, 3].map(k => `<button class="${v.settings.clueRounds === k ? 'on' : ''}" data-act="imSet" data-rounds="${k}">${k}</button>`).join('')}</div></div>
          <div class="im-setting"><span>רמז למתחזה</span>
            <div class="im-seg">${[[true, 'דולק'], [false, 'כבוי']].map(([k, t]) => `<button class="${(v.settings.hint !== false) === k ? 'on' : ''}" data-act="imSet" data-hint="${k ? 1 : 0}">${t}</button>`).join('')}</div></div>
          <button class="primary im-big" data-act="imStart">🕵️ התחילו!</button>
        </div>`
      : `<div class="panel im-panel center"><div class="spinner"></div><p>המארח/ת בוחר/ת הגדרות…</p></div>`;
  } else if (v.phase === 'reveal') {
    const seenMe = me.seen;
    body = `${secretCard(v, ui)}
      <div class="im-status">${seenMe ? 'מחכים שכולם יציצו…' : 'הציצו בכרטיס, זכרו – ולחצו "ראיתי"'}</div>
      ${seenMe ? '' : '<button class="primary im-big" data-act="imSeen">👀 ראיתי</button>'}
      <div class="im-chips">${v.players.map((p, i) => playerChip(v, i, p.seen ? 'done' : 'wait')).join('')}</div>`;
  } else if (v.phase === 'clues') {
    const speaker = v.order[v.clues.length % v.order.length];
    const myTurn = speaker === v.me;
    const roundNo = Math.floor(v.clues.length / v.order.length) + 1;
    const rounds = Math.ceil(v.clueTurns / v.order.length);
    body = `<div class="im-status ${myTurn ? 'mine' : ''}">${myTurn ? '🎤 התור שלך! תנו מילה שקשורה' : `🎤 ${esc(v.players[speaker].name)} נותן/ת רמז…`}${rounds > 1 ? ` · סבב ${roundNo}/${rounds}` : ''}</div>
      ${cluesBoard(v, speaker)}
      ${myTurn ? `<div class="im-input">
          <input id="imClue" maxlength="24" placeholder="המילה שלך…" autocomplete="off" enterkeyhint="send">
          <button class="primary" data-act="imClue">שליחה</button>
        </div>
        <button class="ghost im-spoken" data-act="imSpoken">🗣️ אמרתי בקול (בלי להקליד)</button>` : ''}
      ${isHost && !myTurn ? `<button class="ghost im-skip" data-act="imSkip">⏭️ דלג על ${esc(v.players[speaker].name)}</button>` : ''}
      ${secretCard(v, ui)}`;
  } else if (v.phase === 'vote') {
    const slots = v.revote ? v.revote.slots : v.k;
    const cand = (v.revote ? v.revote.among : v.players.map((_, i) => i)).filter(i => i !== v.me);
    const sel = ui.imSel || [];
    const done = !!v.myVote;
    const votedN = v.players.filter(p => p.voted).length;
    body = `<div class="im-status mine">${v.revote ? '⚖️ שוויון! הצבעה חוזרת בין: ' + v.revote.among.map(i => esc(v.players[i].name)).join(', ') : slots === 2 ? '🗳️ מי שני המתחזים?' : '🗳️ מי המתחזה?'}</div>
      ${cluesBoard(v, -1)}
      ${done ? `<div class="im-status">הצבעת ✓ · מחכים לשאר (${votedN}/${v.players.length})</div>`
        : `<div class="im-vote">${cand.map(i => `<button class="im-cand ${sel.includes(i) ? 'on' : ''}" data-act="imPick" data-p="${i}" data-seat="${i}">${esc(v.players[i].name)}</button>`).join('')}</div>
           <button class="primary im-big" data-act="imVote" ${sel.length === Math.min(slots, cand.length) ? '' : 'disabled'}>הצבעה${slots === 2 ? ` (${sel.length}/2)` : ''}</button>`}
      ${isHost ? `<button class="ghost im-skip" data-act="imClose">סגירת ההצבעה עכשיו (${votedN}/${v.players.length})</button>` : ''}
      ${secretCard(v, ui)}`;
  } else if (v.phase === 'guess') {
    const caughtNames = v.accused.map(i => esc(v.players[i].name)).join(' ו');
    body = v.options
      ? `<div class="im-status mine">😱 נתפסת! הזדמנות אחרונה: מה המילה הסודית?</div>
         ${v.hint ? `<div class="im-hintbox">הרמז שלך היה: <b>${esc(v.hint)}</b></div>` : ''}
         <div class="im-options">${v.options.map(w => `<button data-act="imGuess" data-w="${esc(w)}">${esc(w)}</button>`).join('')}</div>`
      : `<div class="im-status">🔍 ${caughtNames} נחשד/ה – ומנסה לנחש את המילה…</div>${cluesBoard(v, -1)}
         ${isHost ? '<button class="ghost im-skip" data-act="imSkipGuess">לדלג על הניחוש</button>' : ''}`;
  } else if (v.phase === 'result') {
    body = resultHtml(v, isHost);
  }

  const scores = v.players.map((p, i) => ({ p, i })).sort((a, b) => b.p.score - a.p.score)
    .map(({ p, i }) => `<span class="im-score ${i === v.me ? 'me' : ''}">${esc(p.name)} <b>${p.score}</b></span>`).join('');
  return `
    <header class="top">
      <div><b>🕵️ המתחזה</b> · ${ui.room.test ? '🧪 חדר בדיקה' : `חדר <span dir="ltr">${ui.room.code}</span>`}${v.round ? ` · סבב ${v.round}` : ''}</div>
      ${ui.headerButtons}
    </header>
    ${v.round ? `<div class="im-scores">${scores}</div>` : ''}
    <section class="im-body">${body}</section>
    ${ui.emojiBar}`;
}

function cluesBoard(v, speaker) {
  const rows = v.order.map(i => {
    const mine = v.clues.filter(c => c.pi === i);
    const items = mine.map(c => `<span class="im-clue ${c.skipped ? 'skip' : ''}">${c.skipped ? '⏭️' : c.spoken ? '🗣️' : esc(c.text)}</span>`).join('');
    return `<div class="im-row ${i === speaker ? 'now' : ''}" data-seat="${i}"><span class="im-name">${esc(v.players[i].name)}${i === v.me ? ' (את/ה)' : ''}</span><span class="im-clues">${items || '<span class="im-clue empty">…</span>'}</span></div>`;
  }).join('');
  return `<div class="im-board">${rows}</div>`;
}

function resultHtml(v, isHost) {
  const r = v.result;
  const [title, sub] = outcomeText[r.outcome];
  const imps = v.imposters.map(i => `<div class="im-reveal-imp"><b>🕵️ ${esc(v.players[i].name)}</b> ${v.hints ? `<span>רמז: ${esc(v.hints[i])}</span>` : ''}${v.guesses[i] ? ` <span>ניחוש: ${esc(v.guesses[i])} ${v.guesses[i] === v.word ? '✅' : '❌'}</span>` : ''}</div>`).join('');
  const votes = v.players.map((p, i) => {
    const ts = v.votes?.[i] || [];
    return `<tr><td>${esc(p.name)}</td><td>${ts.map(t => `${esc(v.players[t].name)}${v.imposters.includes(t) ? ' ✓' : ''}`).join(', ') || '–'}</td><td class="${r.deltas[i] ? 'plus' : ''}">${r.deltas[i] ? '+' + r.deltas[i] : '0'}</td></tr>`;
  }).join('');
  return `<div class="panel im-result">
    <div class="im-res-title">${title}</div>
    <div class="sub">${sub}</div>
    <div class="im-reveal-word">המילה הייתה: <b>${esc(v.word)}</b></div>
    ${imps}
    <table class="im-votes"><thead><tr><th>שחקן</th><th>הצביע/ה על</th><th>נק׳</th></tr></thead><tbody>${votes}</tbody></table>
    ${isHost ? `<div class="im-next"><button class="primary im-big" data-act="imNext">🔄 סבב הבא</button>
      <button class="ghost" data-act="imSettings">⚙️ הגדרות</button></div>` : '<p class="sub">מחכים למארח/ת…</p>'}
  </div>`;
}

// ---------- actions ----------
export function imposterAct(act, el, ui, send) {
  const v = ui.view;
  const A = (type, extra = {}) => send({ t: 'action', action: { type, ...extra } });
  switch (act) {
    case 'imPeek': ui.imPeek = !ui.imPeek; if (ui.imPeek) haptic('tap'); return true;
    case 'imSet':
      if (el.dataset.imposters) A('settings', { imposters: Number(el.dataset.imposters) });
      if (el.dataset.rounds) A('settings', { clueRounds: Number(el.dataset.rounds) });
      if (el.dataset.hint) A('settings', { hint: el.dataset.hint === '1' });
      return false;
    case 'imStart': A('start'); return false;
    case 'imNext': A('nextRound'); return false;
    case 'imSettings': A('toSetup'); return false;
    case 'imSeen': ui.imPeek = false; A('seen'); play('pop'); return false;
    case 'imClue': {
      const input = document.getElementById('imClue');
      const text = input?.value.trim();
      if (!text) { input?.focus(); return false; }
      A('clue', { text });
      return false;
    }
    case 'imSpoken': A('clue', { text: '' }); return false;
    case 'imSkip': A('skip'); return false;
    case 'imPick': {
      const p = Number(el.dataset.p);
      const slots = v.revote ? v.revote.slots : v.k;
      let sel = (ui.imSel || []).slice();
      if (sel.includes(p)) sel = sel.filter(x => x !== p);
      else { sel.push(p); if (sel.length > slots) sel.shift(); }
      ui.imSel = sel;
      play('tick');
      return true;
    }
    case 'imVote': A('vote', { targets: ui.imSel || [] }); ui.imSel = []; play('pop'); return false;
    case 'imClose': A('closeVote'); return false;
    case 'imGuess': A('guess', { word: el.dataset.w }); return false;
    case 'imSkipGuess': A('skipGuess'); return false;
  }
  return false;
}

// ---------- reactions to what happened ----------
export async function playImposterEvents(events, before, v) {
  for (const ev of events) {
    if (ev.type === 'round') { play('shuffle'); haptic('tap'); }
    else if (ev.type === 'cluesStart') { play('turn'); }
    else if (ev.type === 'clue') {
      play('pop');
      const row = document.querySelector(`.im-row[data-seat="${ev.pi}"] .im-clue:last-child`);
      row?.animate([{ transform: 'scale(.4)', opacity: 0 }, { transform: 'scale(1.15)', opacity: 1 }, { transform: 'scale(1)' }], { duration: 380, easing: 'ease-out' });
    } else if (ev.type === 'voteStart') { play('sonar'); haptic('turn'); }
    else if (ev.type === 'revote') { play('nope'); haptic('call'); }
    else if (ev.type === 'caught') { play('bigboom'); haptic('call'); }
    else if (ev.type === 'guessed') { play(ev.right ? 'win' : 'nope'); }
    else if (ev.type === 'result') {
      const r = v.result;
      const imp = v.imposters.includes(v.me);
      const won = imp ? !r.caught.includes(v.me) || r.guessed.includes(v.me) : r.caught.length > 0;
      if (won) { confetti(); play('win'); haptic('win'); } else play('lose');
    }
  }
}
