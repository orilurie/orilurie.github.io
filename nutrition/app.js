import {
  state, save, replaceState, resetState, uid, dateKey, parseKey, shiftKey, r1,
  allFoods, getFood, saveFood, deleteFood, unitsOf, touchRecent,
  makeItem, quickItem, reamount, amountLabel, sum,
  day, peekDay, planItems, setWeight, latestWeight, onSave,
  targetsFor, setTargetsFrom, deleteTargetChange, nextTargetChange, trackWater,
} from './store.js?v=4';
import { CATEGORIES, BUILTIN_FOODS } from './foods.js?v=4';
import {
  cloudEnabled, initCloud, push, refresh, currentUser, deleteCloudData,
  signInEmail, signOut, authError,
} from './cloud.js?v=4';

export const VERSION = 4; // bump on every deploy, together with version.json, the ?v= in index.html and the imports above

// Browsers (especially in-app ones) may serve a cached old page. version.json is fetched
// fresh; if it's newer, reload once with a changed URL so the new page is fetched.
fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' })
  .then(r => r.json())
  .then(({ version }) => {
    if (version <= VERSION) return;
    const key = `nutrition-reloaded-${version}`;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch {}
    const q = new URLSearchParams(location.search);
    q.set('v', version);
    location.replace(`${location.pathname}?${q}`);
  })
  .catch(() => {});

if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});

const $view = document.getElementById('view');
const $tabs = document.getElementById('tabs');
const $sheet = document.getElementById('sheet');
const $sheetBody = document.getElementById('sheet-body');
const $toast = document.getElementById('toast');

let tab = 'today';
// 'app' | 'loading' (waiting to learn whether someone is signed in) | 'login'
let screen = 'app';
let auth = { mode: 'in', busy: false, msg: '', email: '' };
const LOCAL_ONLY = 'nutrition-local-only';
const isLocalOnly = () => { try { return localStorage.getItem(LOCAL_ONLY) === '1'; } catch { return false; } };
let curDay = dateKey();
let foodsQuery = '';
let foodsCat = 'all';

// ---------- small helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const fmt = n => (Math.round(n * 10) / 10).toLocaleString('he-IL');
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const MACROS = [
  ['p', 'חלבון', 'var(--protein)'],
  ['c', 'פחמימה', 'var(--carbs)'],
  ['f', 'שומן', 'var(--fat)'],
];

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 1800);
}

function dayTitle(key) {
  const today = dateKey();
  const d = parseKey(key);
  const short = `${d.getDate()}.${d.getMonth() + 1}`;
  if (key === today) return `היום · ${short}`;
  if (key === shiftKey(today, -1)) return `אתמול · ${short}`;
  if (key === shiftKey(today, 1)) return `מחר · ${short}`;
  return `יום ${DAYS[d.getDay()]} · ${short}`;
}

function normalize(s) {
  return String(s).toLowerCase().replace(/[֑-ׇ]/g, '').replace(/["'׳״\-]/g, '').replace(/\s+/g, ' ').trim();
}

function macroLine(t) {
  return `<span class="m p">ח ${fmt(t.p)}</span><span class="m c">פ ${fmt(t.c)}</span><span class="m f">ש ${fmt(t.f)}</span>`;
}

// ---------- rendering ----------

function render() {
  $tabs.hidden = screen !== 'app';
  if (screen === 'loading') { $view.innerHTML = '<div class="splash"><div class="spinner"></div></div>'; return; }
  if (screen === 'login') { $view.innerHTML = viewLogin(); return; }
  for (const b of $tabs.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === tab);
  const views = { today: viewToday, plan: viewPlan, foods: viewFoods, weight: viewWeight, settings: viewSettings };
  $view.innerHTML = views[tab]();
  if (tab === 'foods') renderFoodsList();
  if (tab === 'settings') updateMacroCheck();
}

function ring(eaten, target) {
  const R = 52, C = 2 * Math.PI * R;
  const frac = target > 0 ? Math.min(eaten / target, 1) : 0;
  const over = target > 0 && eaten > target;
  const left = Math.round(target - eaten);
  return `
  <div class="ring ${over ? 'over' : ''}">
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <circle cx="60" cy="60" r="${R}" class="ring-bg"/>
      <circle cx="60" cy="60" r="${R}" class="ring-fg" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - frac)}"/>
    </svg>
    <div class="ring-text">
      <b>${Math.abs(left).toLocaleString('he-IL')}</b>
      <small>${over ? 'קלוריות מעל היעד' : 'קלוריות נשארו'}</small>
    </div>
  </div>`;
}

function bar(label, val, target, color, unit = 'ג׳') {
  const frac = target > 0 ? Math.min(val / target, 1) : 0;
  const over = target > 0 && val > target * 1.05;
  return `
  <div class="bar ${over ? 'over' : ''}">
    <div class="bar-head"><span>${label}</span><span>${fmt(val)} / ${fmt(target)} ${unit}</span></div>
    <div class="bar-track"><div class="bar-fill" style="width:${frac * 100}%;background:${color}"></div></div>
  </div>`;
}

function itemRow(it, act, extra = '') {
  return `
  <button class="row" data-act="${act}" data-id="${it.id}" ${extra}>
    <span class="row-main">
      <span class="row-name">${esc(it.name)}</span>
      <span class="row-sub">${esc(amountLabel(it))}${it.n ? ' · ' : ''}${macroLine(it)}</span>
    </span>
    <span class="row-kcal">${it.kcal}<small>קק״ל</small></span>
  </button>`;
}

function viewToday() {
  const d = peekDay(curDay);
  const T = targetsFor(curDay);
  const tot = sum(d.entries);
  const isToday = curDay === dateKey();
  const hasPlan = state.meals.some(m => (state.plan[m.id] || []).length);
  const mealIds = new Set(state.meals.map(m => m.id));

  let meals = '';
  for (const meal of state.meals) {
    const plan = state.plan[meal.id] || [];
    const entries = d.entries.filter(e => e.mealId === meal.id);
    const planIds = new Set(plan.map(p => p.id));
    const extra = entries.filter(e => !e.planItemId || !planIds.has(e.planItemId));
    const eaten = sum(entries);
    const planRows = plan.map(p => {
      const entry = entries.find(e => e.planItemId === p.id);
      const shown = entry || p;
      return `
      <div class="row plan-row ${entry ? 'done' : ''}">
        <button class="check" data-act="toggle-plan" data-meal="${meal.id}" data-id="${p.id}" aria-label="${entry ? 'בטל סימון' : 'סמן שאכלתי'}">${entry ? '✓' : ''}</button>
        <button class="row-main" data-act="${entry ? 'edit-entry' : 'toggle-plan'}" data-meal="${meal.id}" data-id="${entry ? entry.id : p.id}">
          <span class="row-name">${esc(shown.name)}</span>
          <span class="row-sub">${esc(amountLabel(shown))}${shown.n ? ' · ' : ''}${macroLine(shown)}</span>
        </button>
        <span class="row-kcal">${shown.kcal}<small>קק״ל</small></span>
      </div>`;
    }).join('');
    const allDone = plan.length && plan.every(p => entries.some(e => e.planItemId === p.id));
    meals += `
    <section class="card meal">
      <header class="meal-head">
        <h3>${esc(meal.name)}</h3>
        <span class="meal-kcal">${eaten.kcal ? `${eaten.kcal} קק״ל` : ''}</span>
      </header>
      ${plan.length ? `<div class="list">${planRows}</div>` : ''}
      ${extra.length ? `<div class="list extra">${plan.length ? '<div class="list-label">תוספות</div>' : ''}${extra.map(e => itemRow(e, 'edit-entry')).join('')}</div>` : ''}
      <div class="meal-actions">
        <button class="btn ghost" data-act="add-log" data-meal="${meal.id}">＋ הוספה</button>
        ${plan.length && !allDone ? `<button class="btn ghost" data-act="check-all" data-meal="${meal.id}">✓ אכלתי הכל לפי התפריט</button>` : ''}
      </div>
    </section>`;
  }
  const orphans = d.entries.filter(e => !mealIds.has(e.mealId));
  if (orphans.length) {
    meals += `<section class="card meal"><header class="meal-head"><h3>אחר</h3></header>
      <div class="list">${orphans.map(e => itemRow(e, 'edit-entry')).join('')}</div></section>`;
  }

  const water = d.waterMl || 0;
  const wT = state.targets.waterMl || 0;
  return `
  <div class="daynav">
    <button class="icon-btn" data-act="day" data-delta="-1" aria-label="יום קודם">›</button>
    <button class="day-title" data-act="today">${dayTitle(curDay)}${isToday ? '' : '<small>חזרה להיום</small>'}</button>
    <button class="icon-btn" data-act="day" data-delta="1" aria-label="יום הבא">‹</button>
  </div>

  <section class="card summary">
    ${ring(tot.kcal, T.kcal)}
    <div class="summary-side">
      <button class="eaten" data-act="edit-targets"><span><b>${tot.kcal.toLocaleString('he-IL')}</b> / ${(+T.kcal).toLocaleString('he-IL')} קק״ל</span><span class="edit-pen" aria-label="שינוי יעד">✎</span></button>
      ${MACROS.map(([k, l, c]) => bar(l, tot[k], T[k], c)).join('')}
    </div>
  </section>

  ${trackWater() ? `<section class="card water">
    <div class="water-info">
      <span class="water-icon" aria-hidden="true">💧</span>
      <div><b>${r1(water / 1000)}</b> / ${r1(wT / 1000)} ליטר מים</div>
    </div>
    <div class="water-btns">
      <button class="icon-btn" data-act="water" data-ml="-250" aria-label="הורד כוס">−</button>
      <button class="btn" data-act="water" data-ml="250">＋ כוס</button>
    </div>
    <div class="bar-track"><div class="bar-fill" style="width:${wT ? Math.min(water / wT, 1) * 100 : 0}%;background:var(--water)"></div></div>
  </section>` : ''}

  ${hasPlan ? '' : `<div class="hint">💡 עוד לא הוזן תפריט. בלשונית <b>התפריט</b> אפשר להזין את התפריט מהמאמן, ואז כאן רק מסמנים מה אכלת.</div>`}
  ${meals}`;
}

function viewPlan() {
  const T = targetsFor(dateKey());
  const all = state.meals.flatMap(m => state.plan[m.id] || []);
  const tot = sum(all);
  const meals = state.meals.map(meal => {
    const items = state.plan[meal.id] || [];
    const t = sum(items);
    return `
    <section class="card meal">
      <header class="meal-head">
        <h3>${esc(meal.name)}</h3>
        <span class="meal-kcal">${t.kcal ? `${t.kcal} קק״ל` : ''}</span>
      </header>
      ${items.length ? `<div class="list">${items.map(it => itemRow(it, 'edit-plan', `data-meal="${meal.id}"`)).join('')}</div>` : ''}
      <div class="meal-actions"><button class="btn ghost" data-act="add-plan" data-meal="${meal.id}">＋ הוספה לתפריט</button></div>
    </section>`;
  }).join('');
  return `
  <h2 class="page-title">התפריט שלי</h2>
  <p class="lead">כאן מזינים את התפריט הקבוע מהמאמן. במסך <b>היום</b> הוא יופיע כרשימה לסימון.</p>
  <section class="card plan-total">
    <div class="plan-total-row"><span>סה״כ בתפריט</span><b>${tot.kcal} / ${T.kcal} קק״ל</b></div>
    ${MACROS.map(([k, l, c]) => bar(l, tot[k], T[k], c)).join('')}
  </section>
  ${meals}
  <p class="lead small">שמות הארוחות וסדרן נקבעים בלשונית <b>הגדרות</b>.</p>`;
}

function viewFoods() {
  return `
  <h2 class="page-title">מאגר מזונות</h2>
  <p class="lead">הערכים ל-100 גרם. אפשר לערוך כל מזון ולהוסיף מזונות משלך (למשל מהתווית על האריזה).</p>
  <div class="search-wrap">
    <input id="foods-search" class="input" type="search" placeholder="חיפוש מזון…" value="${esc(foodsQuery)}" autocomplete="off">
  </div>
  <div class="chips" id="foods-chips">${catChips(foodsCat, false, 'foods-cat')}</div>
  <button class="btn primary wide" data-act="new-food">＋ מזון חדש</button>
  <div class="list card" id="foods-list"></div>`;
}

function catChips(active, withRecent, act) {
  const cats = [...(withRecent ? [['recent', 'אחרונים']] : []), ['all', 'הכל'], ['mine', 'שלי'], ...CATEGORIES.map(c => [c, c])];
  return cats.map(([v, l]) => `<button class="chip ${v === active ? 'active' : ''}" data-act="${act}" data-cat="${esc(v)}">${esc(l)}</button>`).join('');
}

function filterFoods(query, cat) {
  let list = allFoods();
  const q = normalize(query);
  if (q) {
    const words = q.split(' ');
    list = list.filter(f => { const n = normalize(f.name); return words.every(w => n.includes(w)); });
    list.sort((a, b) => normalize(a.name).indexOf(q) - normalize(b.name).indexOf(q));
    return list;
  }
  if (cat === 'recent') return state.recent.map(getFood).filter(Boolean);
  if (cat === 'mine') return list.filter(f => !f.builtin || f.edited);
  if (cat !== 'all') return list.filter(f => f.cat === cat);
  return list;
}

function foodRow(f, act) {
  const u = f.units?.[0];
  return `
  <button class="row" data-act="${act}" data-id="${esc(f.id)}">
    <span class="row-main">
      <span class="row-name">${esc(f.name)}${!f.builtin ? ' <span class="tag">שלי</span>' : f.edited ? ' <span class="tag">נערך</span>' : ''}</span>
      <span class="row-sub">100 ג׳ · ${macroLine(f)}${u ? ` · ${esc(u[0])} = ${u[1]} ג׳` : ''}</span>
    </span>
    <span class="row-kcal">${Math.round(f.kcal)}<small>קק״ל</small></span>
  </button>`;
}

function renderFoodsList() {
  const el = document.getElementById('foods-list');
  if (!el) return;
  const list = filterFoods(foodsQuery, foodsCat);
  el.innerHTML = list.length ? list.map(f => foodRow(f, 'edit-food')).join('') : '<p class="empty">לא נמצאו מזונות</p>';
}

function weightChart(ws) {
  if (ws.length < 2) return '';
  const pts = ws.slice(-60);
  const W = 320, H = 150, P = 18;
  const kgs = pts.map(w => w.kg);
  let lo = Math.min(...kgs), hi = Math.max(...kgs);
  if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
  const t0 = parseKey(pts[0].date).getTime(), t1 = parseKey(pts[pts.length - 1].date).getTime();
  const x = d => P + ((parseKey(d).getTime() - t0) / (t1 - t0 || 1)) * (W - 2 * P);
  const y = kg => P + (1 - (kg - lo) / (hi - lo)) * (H - 2 * P);
  const line = pts.map(w => `${x(w.date).toFixed(1)},${y(w.kg).toFixed(1)}`).join(' ');
  const short = k => { const d = parseKey(k); return `${d.getDate()}.${d.getMonth() + 1}`; };
  return `
  <section class="card chart" dir="ltr">
    <svg viewBox="0 0 ${W} ${H + 16}" role="img" aria-label="גרף משקל">
      <line x1="${P}" x2="${W - P}" y1="${y(hi)}" y2="${y(hi)}" class="grid"/>
      <line x1="${P}" x2="${W - P}" y1="${y(lo)}" y2="${y(lo)}" class="grid"/>
      <text x="${W - P}" y="${y(hi) - 4}" text-anchor="end" class="lbl">${fmt(hi)}</text>
      <text x="${W - P}" y="${y(lo) + 12}" text-anchor="end" class="lbl">${fmt(lo)}</text>
      <polyline points="${line}" class="wline"/>
      ${pts.map(w => `<circle cx="${x(w.date).toFixed(1)}" cy="${y(w.kg).toFixed(1)}" r="3" class="wdot"/>`).join('')}
      <text x="${P}" y="${H + 12}" class="lbl">${short(pts[0].date)}</text>
      <text x="${W - P}" y="${H + 12}" text-anchor="end" class="lbl">${short(pts[pts.length - 1].date)}</text>
    </svg>
  </section>`;
}

function viewWeight() {
  const ws = state.weights;
  const last = ws[ws.length - 1];
  const first = ws[0];
  const weekAgo = shiftKey(dateKey(), -7);
  const ref = [...ws].reverse().find(w => w.date <= weekAgo);
  const delta = (a, b) => { const d = r1(a - b); return `${d > 0 ? '+' : ''}${fmt(d)}`; };
  return `
  <h2 class="page-title">מעקב משקל</h2>
  <section class="card weight-form">
    <label>תאריך<input id="w-date" class="input" type="date" value="${dateKey()}" max="${dateKey()}"></label>
    <label>משקל (ק״ג)<input id="w-kg" class="input" type="text" inputmode="decimal" placeholder="${last ? fmt(last.kg) : '75.0'}"></label>
    <button class="btn primary" data-act="save-weight">שמירה</button>
  </section>
  ${last ? `
  <section class="card stats">
    <div><small>נוכחי</small><b>${fmt(last.kg)}</b></div>
    <div><small>מההתחלה</small><b>${delta(last.kg, first.kg)}</b></div>
    <div><small>בשבוע האחרון</small><b>${ref ? delta(last.kg, ref.kg) : '—'}</b></div>
  </section>` : '<p class="empty">עוד אין שקילות. כדאי להישקל בבוקר, אחרי שירותים ולפני אוכל.</p>'}
  ${weightChart(ws)}
  ${ws.length ? `<section class="card list">${[...ws].reverse().map(w => `
    <div class="row static">
      <span class="row-main"><span class="row-name">${fmt(w.kg)} ק״ג</span><span class="row-sub">${dayTitle(w.date)} · ${w.date.split('-').reverse().join('.')}</span></span>
      <button class="icon-btn small" data-act="del-weight" data-date="${w.date}" aria-label="מחיקה">✕</button>
    </div>`).join('')}</section>` : ''}`;
}

function viewLogin() {
  const up = auth.mode === 'up';
  return `
  <div class="login">
    <img class="login-logo" src="icons/icon-192.png" alt="">
    <h1>התזונה שלי</h1>
    <p class="lead">מתחברים כדי שהנתונים יישמרו בענן, לא יימחקו, ויסתנכרנו בין מכשירים.</p>
    <section class="card">
      <div class="fields one">
        <label class="field"><span>מייל</span><input id="a-email" class="input" type="email" autocomplete="email" dir="ltr" value="${esc(auth.email)}"></label>
        <label class="field"><span>סיסמה${up ? ' (לפחות 6 תווים)' : ''}</span><input id="a-pass" class="input" type="password" dir="ltr" autocomplete="${up ? 'new-password' : 'current-password'}"></label>
      </div>
      ${up ? '' : '<p class="lead small">אותו מייל וסיסמה כמו באפליקציית הבית 🏡</p>'}
      ${auth.msg ? `<p class="auth-msg ${auth.ok ? 'ok' : ''}">${esc(auth.msg)}</p>` : ''}
      <button class="btn primary wide" data-act="login-email" ${auth.busy ? 'disabled' : ''}>${auth.busy ? 'רגע…' : up ? 'הרשמה' : 'כניסה'}</button>
      <div class="auth-links">
        <button class="btn ghost" data-act="auth-mode">${up ? 'כבר יש לי חשבון' : 'אין לך חשבון? הרשמה'}</button>
      </div>
    </section>
    <button class="btn ghost wide muted-link" data-act="local-only">המשך בלי חשבון (נשמר רק בטלפון הזה)</button>
  </div>`;
}

function accountCard() {
  if (!cloudEnabled) return '';
  const u = currentUser();
  if (u) return `
  <section class="card">
    <h3>חשבון</h3>
    <p class="lead small">מחובר/ת כ-<b dir="ltr">${esc(u.email || u.displayName || '')}</b><br>☁️ הנתונים נשמרים בענן ומסתנכרנים בין מכשירים.</p>
    <button class="btn" data-act="sign-out">התנתקות</button>
  </section>`;
  return `
  <section class="card">
    <h3>חשבון</h3>
    <p class="lead small">כרגע הנתונים נשמרים רק בטלפון הזה. אחרי התחברות הם יעלו לענן (כולל מה שכבר הזנת).</p>
    <button class="btn primary" data-act="go-login">התחברות / הרשמה</button>
  </section>`;
}

function viewSettings() {
  const T = targetsFor(dateKey());
  const P = state.profile || {};
  const field = (key, label, unit, val) => `
    <label class="field"><span>${label}</span>
      <span class="field-in"><input class="input" data-target="${key}" type="text" inputmode="decimal" value="${val}"><small>${unit}</small></span>
    </label>`;
  const opt = (v, l, cur) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${l}</option>`;
  return `
  <h2 class="page-title">הגדרות</h2>
  ${accountCard()}

  <section class="card">
    <h3>יעדים יומיים</h3>
    <p class="lead small">הכנס את היעדים שקיבלת מהמאמן. שינוי כאן חל מהיום והלאה, והימים הקודמים נשארים עם היעד שהיה להם. אפשר גם לשנות יעד מיום מסוים דרך ✎ במסך <b>היום</b>.</p>
    <div class="fields">
      ${field('kcal', 'קלוריות', 'קק״ל', T.kcal)}
      ${field('p', 'חלבון', 'גרם', T.p)}
      ${field('c', 'פחמימה', 'גרם', T.c)}
      ${field('f', 'שומן', 'גרם', T.f)}
    </div>
    <p class="lead small" id="macro-check"></p>
    <details class="calc">
      <summary>אין לך יעדים? חישוב הערכה לפי נתונים אישיים</summary>
      <div class="fields">
        <label class="field"><span>מין</span><select id="c-sex" class="input">${opt('m', 'גבר', P.sex || 'm')}${opt('f', 'אישה', P.sex)}</select></label>
        <label class="field"><span>גיל</span><input id="c-age" class="input" inputmode="numeric" value="${P.age || ''}"></label>
        <label class="field"><span>גובה (ס״מ)</span><input id="c-height" class="input" inputmode="numeric" value="${P.height || ''}"></label>
        <label class="field"><span>משקל (ק״ג)</span><input id="c-weight" class="input" inputmode="decimal" value="${latestWeight() ?? P.weight ?? ''}"></label>
        <label class="field"><span>פעילות</span><select id="c-act" class="input">
          ${opt('1.2', 'יושבני', P.act || '1.55')}${opt('1.375', 'קלה (1–3 אימונים בשבוע)', P.act || '1.55')}
          ${opt('1.55', 'בינונית (3–5 אימונים)', P.act || '1.55')}${opt('1.725', 'גבוהה (6–7 אימונים)', P.act || '1.55')}
        </select></label>
        <label class="field"><span>מטרה</span><select id="c-goal" class="input">
          ${opt('cut', 'ירידה במשקל', P.goal || 'cut')}${opt('keep', 'שמירה', P.goal)}${opt('bulk', 'עלייה במסה', P.goal)}
        </select></label>
      </div>
      <button class="btn" data-act="calc">חישוב</button>
      <div id="calc-out"></div>
    </details>
    ${targetHistoryHtml()}
  </section>

  <section class="card">
    <label class="switch-row">
      <span><b>מעקב מים</b><br><small class="muted">כרטיס שתייה במסך היום</small></span>
      <input type="checkbox" class="switch" id="track-water" ${trackWater() ? 'checked' : ''}>
    </label>
    ${trackWater() ? `<div class="fields one">${field('water', 'יעד מים יומי', 'ליטר', r1((state.targets.waterMl || 0) / 1000))}</div>` : ''}
  </section>

  <section class="card">
    <h3>ארוחות</h3>
    <div class="meals-edit">
      ${state.meals.map((m, i) => `
      <div class="meal-edit">
        <input class="input" data-meal-name="${m.id}" value="${esc(m.name)}">
        <button class="icon-btn small" data-act="meal-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="למעלה">↑</button>
        <button class="icon-btn small" data-act="meal-down" data-i="${i}" ${i === state.meals.length - 1 ? 'disabled' : ''} aria-label="למטה">↓</button>
        <button class="icon-btn small" data-act="meal-del" data-i="${i}" aria-label="מחיקה">✕</button>
      </div>`).join('')}
    </div>
    <button class="btn ghost" data-act="meal-add">＋ ארוחה</button>
  </section>

  <section class="card">
    <h3>גיבוי</h3>
    <p class="lead small">${currentUser() ? 'קובץ עם כל הנתונים, לשמירה אצלך.' : 'הנתונים נשמרים רק במכשיר הזה. כדאי לשמור גיבוי מדי פעם, וגם כדי להעביר את הנתונים לטלפון אחר.'}</p>
    <div class="btn-row">
      <button class="btn" data-act="export">שמירת גיבוי</button>
      <button class="btn" data-act="import">שחזור מגיבוי</button>
    </div>
    <input id="import-file" type="file" accept="application/json,.json" hidden>
  </section>

  <section class="card">
    <h3>התקנה כאפליקציה</h3>
    <p class="lead small">באייפון: בספארי לוחצים על כפתור השיתוף ← ״הוספה למסך הבית״. באנדרואיד: בתפריט של כרום ← ״התקנת אפליקציה״.</p>
  </section>

  <button class="btn danger wide" data-act="reset">מחיקת כל הנתונים</button>
  <p class="lead small center">ערכי המזונות במאגר הם הערכה. לשימוש אישי, לא תחליף לייעוץ מקצועי.</p>`;
}

function targetHistoryHtml() {
  const h = state.targetHistory || [];
  if (!h.length) return '';
  const short = k => k.split('-').reverse().slice(0, 2).map(Number).join('.') + '.' + k.slice(2, 4);
  const today = dateKey();
  return `
    <h4 class="sub-h">שינויי יעד</h4>
    <div class="list">${[...h].reverse().map(e => `
      <div class="row static">
        <span class="row-main">
          <span class="row-name">מ-${short(e.from)}${e.from > today ? ' <span class="tag">עתידי</span>' : ''}</span>
          <span class="row-sub">${e.kcal} קק״ל · ${macroLine(e)}</span>
        </span>
        <button class="icon-btn small" data-act="del-target" data-date="${e.from}" aria-label="מחיקת השינוי">✕</button>
      </div>`).join('')}
      <div class="row static"><span class="row-main"><span class="row-name">יעד התחלתי</span>
        <span class="row-sub">${state.targets.kcal} קק״ל · ${macroLine(state.targets)}</span></span></div>
    </div>`;
}

function showTargetsSheet() {
  const T = targetsFor(curDay);
  const next = nextTargetChange(curDay);
  const d = parseKey(curDay);
  const nd = next && parseKey(next.from);
  openSheet(`
    ${sheetHead('שינוי יעד יומי')}
    <p class="lead small">היעד החדש יחול מ<b>${dayTitle(curDay).replace(' · ', ' ')}</b> והלאה. ימים קודמים לא ישתנו.
    ${next ? `<br>שימו לב: ב-${nd.getDate()}.${nd.getMonth() + 1} כבר מתוכנן שינוי אחר, והוא ימשיך לחול מאותו יום.` : ''}</p>
    <div class="fields">
      <label class="field"><span>קלוריות</span><input id="t-kcal" class="input" inputmode="decimal" value="${T.kcal}"></label>
      <label class="field"><span>חלבון (ג׳)</span><input id="t-p" class="input" inputmode="decimal" value="${T.p}"></label>
      <label class="field"><span>פחמימה (ג׳)</span><input id="t-c" class="input" inputmode="decimal" value="${T.c}"></label>
      <label class="field"><span>שומן (ג׳)</span><input id="t-f" class="input" inputmode="decimal" value="${T.f}"></label>
    </div>
    <p class="lead small" id="t-check"></p>
    <div class="btn-row">
      <button class="btn" data-act="t-scale">התאם את המאקרו לקלוריות</button>
      <button class="btn primary grow" data-act="t-save">שמירה</button>
    </div>`);
  updateTargetsCheck();
}

function readTargetsSheet() {
  const v = id => num(document.getElementById(id).value);
  return { kcal: v('t-kcal'), p: v('t-p'), c: v('t-c'), f: v('t-f') };
}

function updateTargetsCheck() {
  const el = document.getElementById('t-check');
  if (!el) return;
  const t = readTargetsSheet();
  const fromMacros = Math.round(t.p * 4 + t.c * 4 + t.f * 9);
  const diff = fromMacros - t.kcal;
  el.textContent = `חלבון, פחמימה ושומן יחד = ${fromMacros.toLocaleString('he-IL')} קק״ל` +
    (Math.abs(diff) > 50 ? ` (${diff > 0 ? 'יותר' : 'פחות'} מהיעד ב-${Math.abs(diff)})` : ' ✓');
}

function updateMacroCheck() {
  const el = document.getElementById('macro-check');
  if (!el) return;
  const T = targetsFor(dateKey());
  const fromMacros = Math.round(T.p * 4 + T.c * 4 + T.f * 9);
  const diff = fromMacros - T.kcal;
  el.textContent = `חלבון, פחמימה ושומן יחד = ${fromMacros.toLocaleString('he-IL')} קק״ל` +
    (Math.abs(diff) > 50 ? ` (${diff > 0 ? 'יותר' : 'פחות'} מיעד הקלוריות ב-${Math.abs(diff)})` : ' ✓');
}

// ---------- bottom sheet ----------

let sheetCtx = null;   // where the chosen food goes: { kind: 'log' | 'plan', mealId, date }
let pick = { query: '', cat: 'recent' };
let amt = null;        // amount editor: { food, unit, qty, edit? }
let foodEdit = null;   // food editor: { food, thenAmount }

function openSheet(html) {
  $sheetBody.innerHTML = html;
  $sheet.hidden = false;
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => $sheet.classList.add('open'));
}

function closeSheet() {
  $sheet.classList.remove('open');
  document.body.classList.remove('sheet-open');
  setTimeout(() => { if (!$sheet.classList.contains('open')) { $sheet.hidden = true; $sheetBody.innerHTML = ''; } }, 200);
  amt = null; foodEdit = null;
}

function mealName(id) {
  return state.meals.find(m => m.id === id)?.name || '';
}

function sheetHead(title, back) {
  return `<div class="sheet-head">
    ${back ? `<button class="icon-btn" data-act="${back}" aria-label="חזרה">→</button>` : '<span></span>'}
    <h3>${esc(title)}</h3>
    <button class="icon-btn" data-act="close" aria-label="סגירה">✕</button>
  </div>`;
}

function openPicker(ctx) {
  sheetCtx = ctx;
  pick = { query: '', cat: state.recent.length ? 'recent' : 'all' };
  showPicker();
  setTimeout(() => document.getElementById('pick-search')?.focus({ preventScroll: true }), 250);
}

function showPicker() {
  const where = sheetCtx.kind === 'plan' ? `לתפריט · ${mealName(sheetCtx.mealId)}` : mealName(sheetCtx.mealId);
  openSheet(`
    ${sheetHead(`הוספה ל${where}`)}
    <input id="pick-search" class="input" type="search" placeholder="חיפוש מזון…" value="${esc(pick.query)}" autocomplete="off">
    <div class="chips" id="pick-chips">${catChips(pick.cat, true, 'pick-cat')}</div>
    <div class="list sheet-list" id="pick-list"></div>
    <div class="btn-row sheet-foot">
      <button class="btn" data-act="pick-new">＋ מזון חדש</button>
      ${sheetCtx.kind === 'log' ? '<button class="btn" data-act="pick-quick">הוספה מהירה</button>' : ''}
    </div>`);
  renderPickList();
}

function renderPickList() {
  const el = document.getElementById('pick-list');
  if (!el) return;
  const list = filterFoods(pick.query, pick.cat);
  el.innerHTML = list.length ? list.map(f => foodRow(f, 'pick-food')).join('')
    : `<p class="empty">${pick.query ? 'לא נמצא. אפשר להוסיף אותו כמזון חדש 👇' : 'אין כאן עדיין מזונות'}</p>`;
}

function itemAsFood(it) {
  return { id: it.foodId, name: it.name, ...it.n, units: it.units.slice(0, -1) };
}

function openAmount(food, edit = null) {
  const units = unitsOf(food);
  amt = edit
    ? { food, unit: edit.item.unit, qty: edit.item.qty, edit }
    : { food, unit: units[0][0], qty: units[0][0] === 'גרם' ? 100 : 1 };
  showAmount();
}

function amountTotals() {
  return makeItem(amt.food, amt.unit, amt.qty);
}

function showAmount() {
  const { food, edit } = amt;
  const units = unitsOf(food);
  const back = edit ? null : 'back-picker';
  const title = edit ? (edit.kind === 'plan' ? 'עריכה בתפריט' : 'עריכה') : food.name;
  openSheet(`
    ${sheetHead(title, back)}
    ${edit ? `<p class="amt-name">${esc(food.name)}</p>` : ''}
    <p class="lead small">ל-100 גרם: ${Math.round(food.kcal)} קק״ל · ${macroLine(food)}</p>
    <div class="chips">${units.map(([n, g]) => `<button class="chip ${n === amt.unit ? 'active' : ''}" data-act="amt-unit" data-unit="${esc(n)}">${esc(n)}${g !== 1 ? ` (${g} ג׳)` : ''}</button>`).join('')}</div>
    <div class="stepper">
      <button class="icon-btn big" data-act="amt-step" data-dir="1" aria-label="יותר">＋</button>
      <input id="amt-qty" class="input qty" type="text" inputmode="decimal" value="${amt.qty}">
      <button class="icon-btn big" data-act="amt-step" data-dir="-1" aria-label="פחות">−</button>
    </div>
    <div class="amt-total" id="amt-total"></div>
    <div class="btn-row">
      ${edit ? `<button class="btn danger" data-act="amt-delete">${edit.kind === 'log' && edit.item.planItemId ? 'בטל סימון' : 'מחיקה'}</button>` : ''}
      <button class="btn primary grow" data-act="amt-save">${edit ? 'שמירה' : 'הוספה'}</button>
    </div>`);
  renderAmountTotal();
}

function renderAmountTotal() {
  const el = document.getElementById('amt-total');
  if (!el) return;
  const it = amountTotals();
  el.innerHTML = `<b>${it.kcal}</b> קק״ל <span class="muted">(${Math.round(it.grams)} ג׳)</span><div>${macroLine(it)}</div>`;
}

function commitItem(item) {
  const { kind, mealId, date } = sheetCtx;
  if (kind === 'plan') planItems(mealId).push(item);
  else day(date).entries.push({ ...item, mealId });
  touchRecent(item.foodId);
  save();
  closeSheet();
  render();
  toast(`נוסף: ${item.name}`);
}

function saveAmount() {
  if (!(amt.qty > 0)) { toast('כמות לא תקינה'); return; }
  const { edit } = amt;
  if (!edit) { commitItem(amountTotals()); return; }
  const next = reamount(edit.item, amt.unit, amt.qty);
  const list = edit.kind === 'plan' ? planItems(edit.mealId) : day(curDay).entries;
  const i = list.findIndex(x => x.id === edit.item.id);
  if (i >= 0) list[i] = next;
  save(); closeSheet(); render();
}

function deleteFromAmount() {
  const { edit } = amt;
  if (edit.kind === 'plan') {
    state.plan[edit.mealId] = planItems(edit.mealId).filter(x => x.id !== edit.item.id);
  } else {
    const d = day(curDay);
    d.entries = d.entries.filter(x => x.id !== edit.item.id);
  }
  save(); closeSheet(); render();
}

function showQuick() {
  openSheet(`
    ${sheetHead('הוספה מהירה', 'back-picker')}
    <p class="lead small">למשהו שאין במאגר, כמו ארוחה במסעדה. מספיק למלא קלוריות.</p>
    <div class="fields">
      <label class="field full"><span>מה אכלת</span><input id="q-name" class="input" placeholder="למשל: המבורגר במסעדה"></label>
      <label class="field"><span>קלוריות</span><input id="q-kcal" class="input" inputmode="decimal"></label>
      <label class="field"><span>חלבון (ג׳)</span><input id="q-p" class="input" inputmode="decimal"></label>
      <label class="field"><span>פחמימה (ג׳)</span><input id="q-c" class="input" inputmode="decimal"></label>
      <label class="field"><span>שומן (ג׳)</span><input id="q-f" class="input" inputmode="decimal"></label>
    </div>
    <button class="btn primary wide" data-act="quick-save">הוספה</button>`);
}

function openFoodEditor(food, thenAmount) {
  foodEdit = {
    food: food ? { ...food, units: [...(food.units || [])] } : { name: pick.query || '', cat: CATEGORIES[0], kcal: '', p: '', c: '', f: '', units: [] },
    thenAmount,
  };
  showFoodEditor();
}

function showFoodEditor() {
  const f = foodEdit.food;
  const isBuiltin = BUILTIN_FOODS.some(b => b.id === f.id);
  const units = f.units.length ? f.units : [['', '']];
  openSheet(`
    ${sheetHead(f.id ? 'עריכת מזון' : 'מזון חדש', foodEdit.thenAmount ? 'back-picker' : null)}
    <p class="lead small">ערכים ל-100 גרם, כמו בטבלה על האריזה.</p>
    <div class="fields">
      <label class="field full"><span>שם</span><input id="f-name" class="input" value="${esc(f.name)}"></label>
      <label class="field full"><span>קטגוריה</span><select id="f-cat" class="input">${CATEGORIES.map(c => `<option ${c === f.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label class="field"><span>קלוריות</span><input id="f-kcal" class="input" inputmode="decimal" value="${f.kcal}"></label>
      <label class="field"><span>חלבון (ג׳)</span><input id="f-p" class="input" inputmode="decimal" value="${f.p}"></label>
      <label class="field"><span>פחמימה (ג׳)</span><input id="f-c" class="input" inputmode="decimal" value="${f.c}"></label>
      <label class="field"><span>שומן (ג׳)</span><input id="f-f" class="input" inputmode="decimal" value="${f.f}"></label>
    </div>
    <h4>יחידות מידה <small class="muted">(גרם תמיד קיים)</small></h4>
    <div id="f-units">${units.map(([n, g]) => unitRow(n, g)).join('')}</div>
    <button class="btn ghost" data-act="f-unit-add">＋ יחידה</button>
    <div class="btn-row">
      ${f.id && !isBuiltin ? '<button class="btn danger" data-act="f-delete">מחיקה</button>' : ''}
      ${isBuiltin && f.edited ? '<button class="btn" data-act="f-delete">שחזור ערכים מקוריים</button>' : ''}
      <button class="btn primary grow" data-act="f-save">שמירה</button>
    </div>`);
}

function unitRow(n = '', g = '') {
  return `<div class="unit-row">
    <input class="input" data-u="name" placeholder="למשל: פרוסה" value="${esc(n)}">
    <input class="input" data-u="g" inputmode="decimal" placeholder="גרם" value="${esc(g)}">
    <button class="icon-btn small" data-act="f-unit-del" aria-label="הסרה">✕</button>
  </div>`;
}

function readFoodEditor() {
  const v = id => document.getElementById(id).value;
  const units = [...document.querySelectorAll('#f-units .unit-row')]
    .map(r => [r.querySelector('[data-u=name]').value.trim(), num(r.querySelector('[data-u=g]').value)])
    .filter(([n, g]) => n && g > 0 && n !== 'גרם');
  return { ...foodEdit.food, name: v('f-name'), cat: v('f-cat'), kcal: num(v('f-kcal')), p: num(v('f-p')), c: num(v('f-c')), f: num(v('f-f')), units };
}

// ---------- actions ----------

function stepQty(dir) {
  const grams = amt.unit === 'גרם';
  const step = grams ? 10 : 0.5;
  let q = r1(num(amt.qty) + dir * step);
  if (q <= 0) q = grams ? 10 : 0.5;
  amt.qty = q;
  document.getElementById('amt-qty').value = q;
  renderAmountTotal();
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `nutrition-backup-${dateKey()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function calc() {
  const g = id => document.getElementById(id).value;
  const sex = g('c-sex'), age = num(g('c-age')), h = num(g('c-height')), w = num(g('c-weight'));
  const act = num(g('c-act')), goal = g('c-goal');
  const out = document.getElementById('calc-out');
  if (!age || !h || !w) { out.innerHTML = '<p class="lead small">צריך למלא גיל, גובה ומשקל.</p>'; return; }
  state.profile = { sex, age, height: h, weight: w, act, goal };
  save();
  const bmr = 10 * w + 6.25 * h - 5 * age + (sex === 'm' ? 5 : -161);
  const tdee = bmr * act;
  const kcal = Math.round((goal === 'cut' ? tdee - 500 : goal === 'bulk' ? tdee + 300 : tdee) / 10) * 10;
  const p = Math.round(w * (goal === 'keep' ? 1.6 : 2));
  const f = Math.round(w * 0.8);
  const c = Math.max(0, Math.round((kcal - p * 4 - f * 9) / 4));
  out.innerHTML = `
    <div class="calc-res">
      <p>שריפה יומית משוערת: <b>${Math.round(tdee)}</b> קק״ל</p>
      <p>יעד: <b>${kcal}</b> קק״ל · חלבון ${p} · פחמימה ${c} · שומן ${f}</p>
      <button class="btn primary" data-act="calc-apply" data-v="${[kcal, p, c, f].join(',')}">להשתמש ביעדים האלה</button>
    </div>`;
}

document.addEventListener('click', e => {
  if (e.target === $sheet) { closeSheet(); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id, meal } = el.dataset;

  switch (act) {
    // navigation
    case 'tab': tab = el.dataset.tab; render(); window.scrollTo(0, 0); break;
    case 'day': curDay = shiftKey(curDay, +el.dataset.delta); render(); break;
    case 'today': curDay = dateKey(); render(); break;
    case 'close': closeSheet(); break;

    // today
    case 'water': {
      const d = day(curDay);
      d.waterMl = Math.max(0, (d.waterMl || 0) + +el.dataset.ml);
      save(); render(); break;
    }
    case 'toggle-plan': {
      const d = day(curDay);
      const existing = d.entries.find(x => x.planItemId === id && x.mealId === meal);
      if (existing) d.entries = d.entries.filter(x => x !== existing);
      else {
        const p = planItems(meal).find(x => x.id === id);
        if (p) d.entries.push({ ...p, id: uid(), planItemId: p.id, mealId: meal });
      }
      save(); render(); break;
    }
    case 'check-all': {
      const d = day(curDay);
      for (const p of planItems(meal)) {
        if (!d.entries.some(x => x.planItemId === p.id && x.mealId === meal)) d.entries.push({ ...p, id: uid(), planItemId: p.id, mealId: meal });
      }
      save(); render(); toast('סומן ✓'); break;
    }
    case 'add-log': openPicker({ kind: 'log', mealId: meal, date: curDay }); break;
    case 'edit-entry': {
      const item = peekDay(curDay).entries.find(x => x.id === id);
      if (!item) break;
      if (!item.n) {
        if (confirm(`למחוק את "${item.name}"?`)) { const d = day(curDay); d.entries = d.entries.filter(x => x.id !== id); save(); render(); }
        break;
      }
      openAmount(itemAsFood(item), { kind: 'log', item });
      break;
    }

    // plan
    case 'add-plan': openPicker({ kind: 'plan', mealId: meal }); break;
    case 'edit-plan': {
      const item = planItems(meal).find(x => x.id === id);
      if (item) openAmount(itemAsFood(item), { kind: 'plan', item, mealId: meal });
      break;
    }

    // picker
    case 'pick-cat': pick.cat = el.dataset.cat; pick.query = ''; document.getElementById('pick-search').value = '';
      document.getElementById('pick-chips').innerHTML = catChips(pick.cat, true, 'pick-cat'); renderPickList(); break;
    case 'pick-food': { const f = getFood(id); if (f) openAmount(f); break; }
    case 'pick-new': openFoodEditor(null, true); break;
    case 'pick-quick': showQuick(); break;
    case 'back-picker': amt = null; foodEdit = null; showPicker(); break;
    case 'quick-save': {
      const v = k => document.getElementById(k).value;
      if (!num(v('q-kcal'))) { toast('צריך למלא קלוריות'); break; }
      commitItem(quickItem(v('q-name'), num(v('q-kcal')), num(v('q-p')), num(v('q-c')), num(v('q-f'))));
      break;
    }

    // amount
    case 'amt-unit': {
      // Keep roughly the same amount when switching units.
      const grams = amountTotals().grams || 100;
      amt.unit = el.dataset.unit;
      const g = unitsOf(amt.food).find(u => u[0] === amt.unit)[1];
      amt.qty = amt.unit === 'גרם' ? Math.round(grams) : Math.max(0.5, Math.round((grams / g) * 2) / 2);
      showAmount(); break;
    }
    case 'amt-step': stepQty(+el.dataset.dir); break;
    case 'amt-save': saveAmount(); break;
    case 'amt-delete': deleteFromAmount(); break;

    // foods
    case 'foods-cat': foodsCat = el.dataset.cat; foodsQuery = '';
      document.getElementById('foods-search').value = '';
      document.getElementById('foods-chips').innerHTML = catChips(foodsCat, false, 'foods-cat'); renderFoodsList(); break;
    case 'new-food': openFoodEditor(null, false); break;
    case 'edit-food': { const f = getFood(id); if (f) openFoodEditor(f, false); break; }
    case 'f-unit-add': document.getElementById('f-units').insertAdjacentHTML('beforeend', unitRow()); break;
    case 'f-unit-del': el.closest('.unit-row').remove(); break;
    case 'f-save': {
      const f = readFoodEditor();
      if (!f.name.trim()) { toast('צריך שם'); break; }
      const saved = saveFood(f);
      const then = foodEdit.thenAmount;
      if (then) openAmount(getFood(saved.id));
      else { closeSheet(); render(); toast('נשמר'); }
      break;
    }
    case 'f-delete': {
      const f = foodEdit.food;
      const builtin = BUILTIN_FOODS.some(b => b.id === f.id);
      if (!confirm(builtin ? 'לשחזר את הערכים המקוריים?' : `למחוק את "${f.name}" מהמאגר?`)) break;
      deleteFood(f.id); closeSheet(); render(); break;
    }

    // weight
    case 'save-weight': {
      const kg = num(document.getElementById('w-kg').value);
      const date = document.getElementById('w-date').value || dateKey();
      if (kg < 20 || kg > 400) { toast('משקל לא תקין'); break; }
      setWeight(date, kg); render(); toast('נשמר'); break;
    }
    case 'del-weight':
      if (confirm('למחוק את השקילה?')) { state.weights = state.weights.filter(w => w.date !== el.dataset.date); save(); render(); }
      break;

    // settings
    case 'calc': calc(); break;
    case 'calc-apply': {
      const [kcal, p, c, f] = el.dataset.v.split(',').map(Number);
      setTargetsFrom(dateKey(), { kcal, p, c, f });
      render(); toast('היעדים עודכנו מהיום והלאה'); break;
    }
    case 'del-target':
      if (confirm('למחוק את שינוי היעד הזה? הימים שלו יחזרו ליעד שהיה לפניו.')) { deleteTargetChange(el.dataset.date); render(); }
      break;
    case 'edit-targets': showTargetsSheet(); break;
    case 't-scale': {
      // Keeps protein and fat, and sets carbs so the macros add up to the calories.
      const t = readTargetsSheet();
      document.getElementById('t-c').value = Math.max(0, Math.round((t.kcal - t.p * 4 - t.f * 9) / 4));
      updateTargetsCheck(); break;
    }
    case 't-save': {
      const t = readTargetsSheet();
      if (!(t.kcal > 0)) { toast('צריך יעד קלוריות'); break; }
      setTargetsFrom(curDay, t);
      closeSheet(); render(); toast(curDay === dateKey() ? 'היעד עודכן מהיום והלאה' : 'היעד עודכן מהיום הזה והלאה');
      break;
    }
    case 'meal-add': state.meals.push({ id: 'm-' + uid(), name: 'ארוחה חדשה' }); save(); render(); break;
    case 'meal-up': case 'meal-down': {
      const i = +el.dataset.i, j = act === 'meal-up' ? i - 1 : i + 1;
      [state.meals[i], state.meals[j]] = [state.meals[j], state.meals[i]];
      save(); render(); break;
    }
    case 'meal-del': {
      const m = state.meals[+el.dataset.i];
      if (!confirm(`למחוק את "${m.name}"? הפריטים שלה בתפריט יימחקו (מה שכבר נרשם ביומן נשאר).`)) break;
      state.meals.splice(+el.dataset.i, 1);
      delete state.plan[m.id];
      save(); render(); break;
    }
    case 'export': exportData(); break;
    case 'import': document.getElementById('import-file').click(); break;
    case 'reset':
      if (confirm(`למחוק את כל הנתונים${currentUser() ? ' (גם מהענן)' : ''}? כדאי לשמור גיבוי קודם.`) && confirm('בטוח? אי אפשר לבטל.')) {
        deleteCloudData().catch(console.error).finally(() => { resetState(); render(); toast('נמחק'); });
      }
      break;

    // account
    case 'auth-mode': keepEmail(); auth.mode = auth.mode === 'up' ? 'in' : 'up'; auth.msg = ''; render(); break;
    case 'login-email': {
      const email = document.getElementById('a-email').value, pass = document.getElementById('a-pass').value;
      if (!email) { auth.msg = 'צריך מייל'; render(); break; }
      runAuth(() => signInEmail(email, pass, auth.mode === 'up').then(r => {
        if (r !== 'confirm') return;
        auth.busy = false; auth.mode = 'in'; auth.ok = true;
        auth.msg = 'נשלח אליך מייל אימות. אחרי שתאשרו אותו, חזרו לכאן והתחברו';
        render();
      }));
      break;
    }
    case 'local-only':
      try { localStorage.setItem(LOCAL_ONLY, '1'); } catch {}
      screen = 'app'; render(); break;
    case 'go-login': auth.msg = ''; screen = 'login'; render(); window.scrollTo(0, 0); break;
    case 'sign-out':
      if (!confirm('להתנתק? הנתונים נשארים שמורים בענן ויחזרו כשתתחברו.')) break;
      signOut().then(() => {
        resetState();
        try { localStorage.removeItem('nutrition-owner'); localStorage.removeItem(LOCAL_ONLY); } catch {}
      });
      break;
  }
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'pick-search') { pick.query = t.value; renderPickList(); }
  else if (t.id === 'foods-search') { foodsQuery = t.value; renderFoodsList(); }
  else if (t.id === 'amt-qty') { amt.qty = num(t.value); renderAmountTotal(); }
  else if (t.id && t.id.startsWith('t-')) updateTargetsCheck();
  else if (t.dataset.target) {
    const v = num(t.value);
    if (t.dataset.target === 'water') { state.targets.waterMl = Math.round(v * 1000); save(); }
    else setTargetsFrom(dateKey(), { ...targetsFor(dateKey()), [t.dataset.target]: v });
    updateMacroCheck();
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'track-water') { state.trackWater = t.checked; save(); render(); return; }
  if (t.dataset.mealName) {
    const m = state.meals.find(x => x.id === t.dataset.mealName);
    if (m) { m.name = t.value.trim() || m.name; save(); }
  } else if (t.id === 'import-file' && t.files[0]) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || typeof data !== 'object' || !data.targets || !data.days) throw new Error();
        if (!confirm('לשחזר מהגיבוי? הנתונים הנוכחיים יוחלפו.')) return;
        replaceState(data); render(); toast('שוחזר ✓');
      } catch { toast('הקובץ לא תקין'); }
    };
    reader.readAsText(t.files[0]);
    t.value = '';
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$sheet.hidden) closeSheet();
  if (e.key === 'Enter' && e.target.id === 'amt-qty') saveAmount();
  if (e.key === 'Enter' && e.target.id === 'w-kg') document.querySelector('[data-act=save-weight]')?.click();
});

// Keep "today" correct when the app stays open past midnight.
let lastToday = dateKey();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const now = dateKey();
  if (now !== lastToday) { if (curDay === lastToday) curDay = now; lastToday = now; render(); }
  refresh();
});

function keepEmail() {
  const el = document.getElementById('a-email');
  if (el) auth.email = el.value;
}

function runAuth(fn) {
  keepEmail();
  auth.busy = true; auth.msg = ''; auth.ok = false; render();
  fn().catch(e => { console.error(e); auth.busy = false; auth.msg = authError(e); render(); });
}

// ---------- start ----------

onSave(s => push(s));

if (cloudEnabled && !isLocalOnly()) screen = 'loading';
render();

initCloud({
  getState: () => state,
  setState: s => replaceState(s),
  onChange: () => { if (screen === 'app' && !$sheet.classList.contains('open')) render(); },
  onUser: (u, err) => {
    auth.busy = false;
    if (u) { screen = 'app'; try { localStorage.removeItem(LOCAL_ONLY); } catch {} }
    else if (cloudEnabled && !isLocalOnly() && !err) screen = 'login';
    else screen = 'app';
    if (err) toast('אין חיבור לענן כרגע');
    render();
  },
});
