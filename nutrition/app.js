import {
  state, save, replaceState, resetState, uid, dateKey, parseKey, shiftKey, r1,
  allFoods, getFood, saveFood, deleteFood, unitsOf, touchRecent,
  makeItem, quickItem, reamount, amountLabel, sum,
  day, peekDay, planItems, setWeight, latestWeight, onSave,
  targetsFor, setTargetsFrom, deleteTargetChange, nextTargetChange, trackWater,
  withState, MEASURES, setMeasurement, deleteMeasurement,
} from './store.js?v=8';
import { CATEGORIES, BUILTIN_FOODS } from './foods.js?v=8';
import {
  cloudEnabled, initCloud, push, refresh, currentUser, deleteCloudData,
  signInEmail, signOut, authError,
  listShares, addShare, removeShare, fetchUserData, sendMessage, listMessages, deleteMessage,
  unreadMessages, markRead, uploadPhoto, photoUrls, deletePhoto, analyzeFoodPhoto,
} from './cloud.js?v=8';

export const VERSION = 8; // bump on every deploy, together with version.json, the ?v= in index.html and the imports above

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
  document.body.classList.toggle('readonly', !!viewing);
  if (viewing && !VIEWER_TABS.includes(tab)) tab = 'today';
  for (const b of $tabs.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === tab);
  const views = { today: viewToday, plan: viewPlan, foods: viewFoods, weight: viewWeight, settings: viewSettings };
  if (viewing) {
    $view.innerHTML = viewerBanner() + withState(viewing.data, () => views[tab]());
  } else {
    $view.innerHTML = (tab === 'today' ? athletesChip() : '') + views[tab]();
  }
  if (tab === 'foods') renderFoodsList();
  if (tab === 'settings') { updateMacroCheck(); loadShareBox(); }
  if (tab === 'weight') loadPhotoThumbs();
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
  const ws = state.weights || [];
  const last = ws[ws.length - 1];
  const first = ws[0];
  const weekAgo = shiftKey(dateKey(), -7);
  const ref = [...ws].reverse().find(w => w.date <= weekAgo);
  return `
  <h2 class="page-title">מדדים</h2>
  <h3 class="section-h">⚖️ משקל</h3>
  <section class="card weight-form">
    <label>תאריך<input id="w-date" class="input" type="date" value="${dateKey()}" max="${dateKey()}"></label>
    <label>משקל (ק״ג)<input id="w-kg" class="input" type="text" inputmode="decimal" placeholder="${last ? fmt(last.kg) : '75.0'}"></label>
    <button class="btn primary" data-act="save-weight">שמירה</button>
  </section>
  ${last ? `
  <section class="card stats">
    <div><small>נוכחי</small><b>${fmt(last.kg)}</b></div>
    <div><small>מההתחלה</small><b>${signed(last.kg - first.kg)}</b></div>
    <div><small>בשבוע האחרון</small><b>${ref ? signed(last.kg - ref.kg) : '—'}</b></div>
  </section>` : '<p class="empty">עוד אין שקילות.</p>'}
  ${weightChart(ws)}
  ${ws.length ? `<details class="card more"><summary>כל השקילות (${ws.length})</summary><div class="list">${[...ws].reverse().map(w => `
    <div class="row static">
      <span class="row-main"><span class="row-name">${fmt(w.kg)} ק״ג</span><span class="row-sub">${dayTitle(w.date)} · ${w.date.split('-').reverse().join('.')}</span></span>
      <button class="icon-btn small" data-act="del-weight" data-date="${w.date}" aria-label="מחיקה">✕</button>
    </div>`).join('')}</div></details>` : ''}

  <h3 class="section-h">📏 היקפים</h3>
  ${measuresHtml()}

  <h3 class="section-h">📸 תמונות התקדמות</h3>
  ${photosHtml()}`;
}

const signed = d => { d = r1(d); return `<span dir="ltr">${d > 0 ? '+' : ''}${fmt(d)}</span>`; };
const shortDate = k => { const [y, m, d] = k.split('-'); return `${+d}.${+m}.${y.slice(2)}`; };

function measuresHtml() {
  const ms = state.measurements || [];
  const latest = {}, firstOf = {};
  for (const m of ms) for (const [k] of MEASURES) if (m[k]) { if (!(k in firstOf)) firstOf[k] = m[k]; latest[k] = m[k]; }
  const lastM = ms[ms.length - 1];
  const form = `
  <details class="card measure-form">
    <summary>＋ הוספת מדידה</summary>
    <p class="lead small">בסנטימטרים. אפשר למלא רק חלק. כדאי למדוד באותו מקום ובאותה שעה בכל פעם.</p>
    <label class="field full"><span>תאריך</span><input id="m-date" class="input" type="date" value="${dateKey()}" max="${dateKey()}"></label>
    <div class="fields">${MEASURES.map(([k, l]) => `
      <label class="field"><span>${l}</span><input class="input" data-measure="${k}" inputmode="decimal" placeholder="${latest[k] ? fmt(latest[k]) : ''}"></label>`).join('')}
    </div>
    <button class="btn primary wide" data-act="save-measure">שמירה</button>
  </details>`;
  if (!ms.length) return form + '<p class="empty">עוד אין מדידות.</p>';
  const cls = k => latest[k] < firstOf[k] ? 'down' : latest[k] > firstOf[k] ? 'up' : '';
  return form + `
  <section class="card">
    <div class="m-table">
      <div class="m-row m-head"><span></span><span>נוכחי</span><span>מההתחלה</span></div>
      ${MEASURES.filter(([k]) => latest[k]).map(([k, l]) => `
      <div class="m-row"><span>${l}</span><b>${fmt(latest[k])}</b><span class="${cls(k)}">${latest[k] === firstOf[k] ? '—' : signed(latest[k] - firstOf[k])}</span></div>`).join('')}
    </div>
    <p class="lead small">מדידה אחרונה: ${shortDate(lastM.date)} · בס״מ</p>
  </section>
  <details class="card more"><summary>כל המדידות (${ms.length})</summary><div class="list">${[...ms].reverse().map(m => `
    <div class="row static">
      <span class="row-main"><span class="row-name">${shortDate(m.date)}</span>
        <span class="row-sub">${MEASURES.filter(([k]) => m[k]).map(([k, l]) => `${l.split(' ')[0]} ${fmt(m[k])}`).join(' · ')}</span></span>
      <button class="icon-btn small" data-act="del-measure" data-date="${m.date}" aria-label="מחיקה">✕</button>
    </div>`).join('')}</div></details>`;
}

function photosHtml() {
  const ps = [...(state.photos || [])].reverse();
  let top = '';
  if (viewing) top = '';
  else if (currentUser()) top = `<button class="btn wide photo-add" data-act="progress-photo">＋ הוספת תמונה</button>
    <p class="lead small">התמונות פרטיות. רק את/ה, ומאמן ששיתפת איתו, יכולים לראות אותן.</p>`;
  else top = '<p class="lead small">תמונות נשמרות בענן, לכן צריך להתחבר לחשבון כדי להוסיף אותן.</p>';
  return `
  <section class="card">
    ${top}
    ${ps.length ? `<div class="photo-grid">${ps.map(p => `
      <button class="photo" data-act="photo-open" data-path="${esc(p.path)}" data-date="${p.date}">
        <img data-photo="${esc(p.path)}" alt="תמונה מ-${shortDate(p.date)}"><span>${shortDate(p.date)}</span>
      </button>`).join('')}</div>` : '<p class="empty">עוד אין תמונות.</p>'}
  </section>`;
}

async function loadPhotoThumbs() {
  const imgs = [...document.querySelectorAll('img[data-photo]')];
  if (!imgs.length) return;
  try {
    const urls = await photoUrls(imgs.map(i => i.dataset.photo));
    for (const i of imgs) if (urls[i.dataset.photo]) i.src = urls[i.dataset.photo];
  } catch (e) { console.error(e); }
}

// Shrinks a photo to at most 1280px so it uploads fast and stays small.
async function compressImage(file, max = 1280) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
}

async function addPhoto(file) {
  toast('מעלה תמונה…');
  try {
    const blob = await compressImage(file);
    const path = await uploadPhoto(blob);
    state.photos = [...(state.photos || []), { date: dateKey(), path }];
    save(); render(); toast('התמונה נשמרה');
  } catch (e) { console.error(e); toast('ההעלאה נכשלה. נסו שוב'); }
}

async function openPhoto(path, date) {
  openSheet(`${sheetHead(shortDate(date))}<img class="photo-big" alt="">
    ${viewing ? '' : `<div class="btn-row"><button class="btn danger" data-act="photo-del" data-path="${esc(path)}">מחיקת התמונה</button></div>`}`);
  const urls = await photoUrls([path]).catch(() => ({}));
  const img = $sheetBody.querySelector('.photo-big');
  if (img && urls[path]) img.src = urls[path];
}

// ---------- sharing with a coach ----------

const VIEWER_TABS = ['today', 'plan', 'weight'];
let viewing = null;      // { ownerId, email, data } while a coach looks at someone's data
let shares = { viewers: [], athletes: [] };
const nameOf = email => (email || '').split('@')[0];

async function refreshShares() {
  if (!currentUser()) { shares = { viewers: [], athletes: [] }; return; }
  try { shares = await listShares(); } catch (e) { console.error(e); }
}

function athletesChip() {
  const n = shares.athletes.length;
  if (!n) return '';
  return `<button class="athletes-chip" data-act="athletes">👥 ${n === 1 ? `צפייה ב-<span dir="ltr">${esc(nameOf(shares.athletes[0].owner_email))}</span>` : `צפייה במתאמנים (${n})`}</button>`;
}

function viewerBanner() {
  return `
  <div class="viewer-banner">
    <span class="vb-who">👀 צופה ב-<b dir="ltr">${esc(nameOf(viewing.email))}</b><small>צפייה בלבד</small></span>
    <span class="vb-btns">
      <button class="btn small-btn" data-act="coach-msg">💬 הודעה</button>
      <button class="btn small-btn" data-act="coach-exit">יציאה</button>
    </span>
  </div>`;
}

async function startViewing(row) {
  closeSheet();
  toast('טוען…');
  try {
    const data = await fetchUserData(row.owner_id);
    // missing fields fall back to defaults so the views don't break
    data.targets ||= { kcal: 2000, p: 150, c: 200, f: 65 };
    data.meals ||= state.meals;
    data.plan ||= {};
    data.weights ||= [];
    viewing = { ownerId: row.owner_id, email: row.owner_email, data };
    tab = 'today'; curDay = dateKey();
    render(); window.scrollTo(0, 0);
  } catch (e) { console.error(e); toast('לא הצלחתי לטעון את הנתונים'); }
}

function showAthletes() {
  openSheet(`${sheetHead('מתאמנים ששיתפו איתך')}
    <div class="list">${shares.athletes.map(a => `
      <button class="row" data-act="view-athlete" data-owner="${a.owner_id}">
        <span class="row-main"><span class="row-name" dir="ltr">${esc(a.owner_email)}</span><span class="row-sub">צפייה בתזונה, בתפריט ובמדדים</span></span>
        <span class="row-kcal">←</span>
      </button>`).join('')}</div>`);
}

async function showCoachMessages() {
  openSheet(`${sheetHead(`הודעה ל-${nameOf(viewing.email)}`)}
    <p class="lead small">ההודעה תקפוץ בפעם הבאה שייכנסו לאפליקציה.</p>
    <textarea id="msg-body" class="input textarea" rows="4" maxlength="2000" placeholder="למשל: מעולה, תמשיכו ככה! 💪"></textarea>
    <button class="btn primary wide" data-act="coach-send">שליחה</button>
    <h4>הודעות קודמות</h4>
    <div class="list" id="msg-list"><p class="empty">טוען…</p></div>`);
  try {
    const msgs = await listMessages(viewing.ownerId);
    const el = document.getElementById('msg-list');
    if (el) el.innerHTML = msgs.length ? msgs.map(m => messageRow(m, m.author_id === currentUser()?.id)).join('') : '<p class="empty">עוד לא נשלחו הודעות</p>';
  } catch (e) { console.error(e); }
}

function msgTime(iso) {
  const d = new Date(iso);
  return `${d.getDate()}.${d.getMonth() + 1} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function messageRow(m, mine) {
  return `<div class="msg">
    <div class="msg-head"><span dir="ltr">${esc(nameOf(m.author_email))}</span><span>${msgTime(m.created_at)}${mine ? (m.read_at ? ' · נקרא ✓✓' : ' · עוד לא נקרא') : ''}</span></div>
    <div class="msg-body">${esc(m.body)}</div>
    ${mine ? `<button class="btn ghost small-btn" data-act="coach-del-msg" data-id="${m.id}">מחיקה</button>` : ''}
  </div>`;
}

function shareCard() {
  if (!cloudEnabled) return '';
  if (!currentUser()) return `
  <section class="card"><h3>שיתוף עם מאמן</h3>
    <p class="lead small">כדי לשתף צריך להתחבר לחשבון.</p></section>`;
  return `<section class="card" id="share-box"><h3>שיתוף עם מאמן</h3><p class="empty">טוען…</p></section>`;
}

async function loadShareBox() {
  if (!document.getElementById('share-box')) return;
  await refreshShares();
  const el = document.getElementById('share-box');
  if (!el) return;
  el.innerHTML = `
    <h3>שיתוף עם מאמן</h3>
    <p class="lead small">המאמן יוכל לראות מה אכלת, את התפריט, המשקל, ההיקפים והתמונות, ולשלוח לך הודעות. הוא לא יוכל לשנות שום דבר. הוא צריך להירשם לאפליקציה לפני השיתוף.</p>
    <div class="share-add">
      <input id="share-email" class="input" type="email" dir="ltr" placeholder="המייל של המאמן" autocomplete="off">
      <button class="btn primary" data-act="share-add">שיתוף</button>
    </div>
    ${shares.viewers.length ? `<div class="list">${shares.viewers.map(v => `
      <div class="row static">
        <span class="row-main"><span class="row-name" dir="ltr">${esc(v.viewer_email)}</span><span class="row-sub">יכול לצפות</span></span>
        <button class="icon-btn small" data-act="share-remove" data-owner="${v.owner_id}" data-viewer="${v.viewer_id}" aria-label="הפסקת שיתוף">✕</button>
      </div>`).join('')}</div>` : ''}
    <button class="btn ghost" data-act="my-messages">💬 הודעות שקיבלתי</button>
    ${shares.athletes.length ? `
    <h4 class="sub-h">מתאמנים ששיתפו איתך</h4>
    <div class="list">${shares.athletes.map(a => `
      <div class="row static">
        <button class="row-main" data-act="view-athlete" data-owner="${a.owner_id}"><span class="row-name" dir="ltr">${esc(a.owner_email)}</span><span class="row-sub">לחצו לצפייה</span></button>
        <button class="icon-btn small" data-act="share-remove" data-owner="${a.owner_id}" data-viewer="${a.viewer_id}" aria-label="הפסקת מעקב">✕</button>
      </div>`).join('')}</div>` : ''}`;
}

const SHARE_ERRORS = {
  no_user: 'אין משתמש עם המייל הזה. המאמן צריך להירשם לאפליקציה קודם',
  self: 'זה המייל שלך 🙂',
};

async function showMyMessages() {
  openSheet(`${sheetHead('הודעות שקיבלתי')}<div class="list" id="my-msgs"><p class="empty">טוען…</p></div>`);
  try {
    const msgs = await listMessages(currentUser().id);
    const el = document.getElementById('my-msgs');
    if (el) el.innerHTML = msgs.length ? msgs.map(m => messageRow(m, false)).join('') : '<p class="empty">אין הודעות</p>';
  } catch (e) { console.error(e); }
}

// New messages pop up when the app opens (and when it comes back to the foreground),
// until "read" is tapped.
let msgPopupOpen = false;
async function checkMessages() {
  if (!currentUser() || viewing || msgPopupOpen || screen !== 'app') return;
  let msgs = [];
  try { msgs = await unreadMessages(); } catch (e) { console.error(e); return; }
  if (!msgs.length || $sheet.classList.contains('open') || viewing) return;
  openSheet(`
    <div class="msg-pop">
      <div class="msg-pop-icon">💬</div>
      <h3>${msgs.length === 1 ? 'הודעה חדשה מהמאמן' : `${msgs.length} הודעות חדשות מהמאמן`}</h3>
      ${msgs.map(m => messageRow(m, false)).join('')}
      <button class="btn primary wide" data-act="msgs-read" data-ids="${msgs.map(m => m.id).join(',')}">קראתי 👍</button>
    </div>`);
  msgPopupOpen = true;
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
  ${shareCard()}

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


// ---------- in-app camera ----------
// iPhone home-screen apps often show a black screen when the camera is opened through a file input,
// and never ask for permission. getUserMedia asks for permission explicitly and works there.

let camStream = null;
let camOnShot = null;   // called with the photo (Blob)
let camFacing = 'environment';
let camGallery = null;  // id of the file input to fall back to

function stopCam() {
  if (camStream) camStream.getTracks().forEach(t => t.stop());
  camStream = null;
}

// source chooser: camera or gallery
function showPhotoSource(title, onShot, galleryInputId, facing = 'environment', back = null) {
  camOnShot = onShot; camGallery = galleryInputId; camFacing = facing;
  openSheet(`${sheetHead(title, back)}
    <div class="source-btns">
      <button class="btn source" data-act="cam-open"><span>📸</span>צילום</button>
      <button class="btn source" data-act="cam-gallery"><span>🖼️</span>מהגלריה</button>
    </div>`);
}

function openCamera() {
  openSheet(`${sheetHead('צילום')}
    <div class="cam"><video id="cam-video" playsinline autoplay muted></video><div class="cam-msg" id="cam-msg">פותח מצלמה…</div></div>
    <div class="cam-btns">
      <button class="icon-btn big" data-act="cam-flip" aria-label="החלפת מצלמה">🔄</button>
      <button class="shutter" data-act="cam-shot" aria-label="צילום"></button>
      <button class="icon-btn big" data-act="cam-gallery" aria-label="מהגלריה">🖼️</button>
    </div>`);
  startCam();
}

let camSeq = 0;   // ignores a slow camera start that was replaced by a newer one (e.g. after flipping)
async function startCam() {
  stopCam();
  const seq = ++camSeq;
  const msg = document.getElementById('cam-msg');
  if (!navigator.mediaDevices?.getUserMedia) { camFail('הדפדפן הזה לא תומך בצילום מתוך האפליקציה.'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: camFacing }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false,
    });
    const v = document.getElementById('cam-video');
    if (!v || seq !== camSeq) { stream.getTracks().forEach(t => t.stop()); return; }   // closed or replaced meanwhile
    camStream = stream;
    v.srcObject = stream;
    await v.play().catch(() => {});
    if (msg) msg.hidden = true;
  } catch (e) {
    console.error(e);
    if (e?.name === 'NotAllowedError') camFail('אין הרשאה למצלמה. באייפון: הגדרות ← אפליקציות ← Safari ← מצלמה ← "שאל" או "אפשר", ואז לסגור ולפתוח את האפליקציה.');
    else camFail('לא הצלחתי לפתוח את המצלמה.');
  }
}

function camFail(text) {
  const msg = document.getElementById('cam-msg');
  if (!msg) return;
  msg.hidden = false;
  msg.innerHTML = `${esc(text)}<br><button class="btn" data-act="cam-gallery">בחירה מהגלריה</button>`;
}

async function takeShot() {
  const v = document.getElementById('cam-video');
  if (!v) return;
  // right after opening or flipping, give the camera a moment to deliver a frame
  for (let i = 0; i < 30 && !(camStream && v.videoWidth && v.readyState >= 2); i++) await new Promise(r => setTimeout(r, 100));
  if (!camStream || !v.videoWidth) { toast('המצלמה עוד לא מוכנה'); return; }
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  stopCam();
  c.toBlob(blob => { if (blob && camOnShot) camOnShot(blob); }, 'image/jpeg', 0.9);
}

function openSheet(html) {
  stopCam();
  $sheetBody.innerHTML = html;
  $sheet.hidden = false;
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => $sheet.classList.add('open'));
}

function closeSheet() {
  stopCam();
  msgPopupOpen = false;
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
      ${currentUser() ? '<button class="btn" data-act="pick-photo">📷 מתמונה</button>' : ''}
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


// ---------- food recognition from a photo (Gemini, through a Supabase function) ----------

let ai = null;   // { items: [{ name, grams, g0, kcal0, p0, c0, f0, on }], note, image }

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

// Step 1: show the photo with an optional description, so the AI gets the user's amounts up front.
async function startFoodPhoto(file) {
  try {
    const image = await blobToBase64(await compressImage(file, 1024));
    ai = { image, items: [], note: '', hint: '' };
    showAiCompose();
  } catch (e) {
    console.error(e);
    showAiError('לא הצלחתי לקרוא את התמונה. נסו תמונה אחרת.');
  }
}

function showAiCompose() {
  openSheet(`
    ${sheetHead('זיהוי מתמונה', 'back-picker')}
    <img class="ai-preview" src="data:image/jpeg;base64,${ai.image}" alt="התמונה שנבחרה">
    <label class="field full ai-desc"><span>מה יש בצלחת ובאיזו כמות? <small class="muted">(לא חובה, אבל משפר מאוד את הדיוק)</small></span>
      <textarea id="ai-desc" class="input textarea" rows="3" maxlength="300" placeholder="למשל: 2 ביצים, פרוסת לחם מלא, חצי אבוקדו, סלט עם כף שמן זית">${esc(ai.hint)}</textarea>
    </label>
    <button class="btn primary wide" data-act="ai-go">🔍 זיהוי</button>
    <button class="btn ghost wide" data-act="pick-photo">תמונה אחרת</button>`);
}

function analyzeWith(hint) {
  ai.hint = hint;
  openSheet(`${sheetHead('מזהה את האוכל…')}
    <div class="ai-wait"><div class="spinner"></div><p class="lead">זה לוקח כמה שניות 🍽️</p></div>`);
  runFoodPhoto(hint).catch(e => { console.error(e); showAiError(); });
}

async function runFoodPhoto(hint) {
  const res = await analyzeFoodPhoto(ai.image, hint);
  ai.note = res.note || '';
  ai.items = (res.items || []).map(it => ({ name: it.name, grams: it.grams, g0: it.grams, kcal0: it.kcal, p0: it.p, c0: it.c, f0: it.f, on: true }));
  showAiResult();
}

function showAiError(msg) {
  openSheet(`${sheetHead('לא הצלחתי לזהות', 'back-picker')}
    <p class="lead">${esc(msg || 'השירות עמוס כרגע או שאין חיבור. נסו שוב בעוד דקה, או הוסיפו ידנית.')}</p>
    ${ai?.image ? '<button class="btn primary wide" data-act="ai-again">לנסות שוב</button>' : ''}
    <button class="btn ${ai?.image ? 'ghost' : 'primary'} wide" data-act="pick-photo">תמונה אחרת</button>`);
}

function aiScaled(it) {
  const k = it.g0 > 0 ? it.grams / it.g0 : 0;
  return { kcal: Math.round(it.kcal0 * k), p: r1(it.p0 * k), c: r1(it.c0 * k), f: r1(it.f0 * k) };
}

function showAiResult() {
  const where = sheetCtx.kind === 'plan' ? `לתפריט · ${mealName(sheetCtx.mealId)}` : mealName(sheetCtx.mealId);
  openSheet(`
    ${sheetHead('מה זוהה בתמונה', 'back-picker')}
    ${ai.items.length ? `<p class="lead small">זו הערכה. אפשר לתקן שמות וכמויות, ולבטל סימון של מה שלא נכון.</p>
    <div class="ai-list" id="ai-list">${ai.items.map((it, i) => aiRow(it, i)).join('')}</div>
    <div class="amt-total" id="ai-total"></div>` : '<p class="empty">לא זוהה אוכל בתמונה.</p>'}
    ${ai.note ? `<p class="lead small">💡 ${esc(ai.note)}</p>` : ''}
    <details class="ai-hint">
      <summary>לא מדויק? ספרו מה יש בצלחת ונסו שוב</summary>
      <textarea id="ai-hint" class="input textarea" rows="2" maxlength="300" placeholder="למשל: 150 גרם חזה עוף, כוס אורז, סלט עם כף שמן זית">${esc(ai.hint || '')}</textarea>
      <button class="btn wide" data-act="ai-retry">זיהוי מחדש</button>
    </details>
    ${ai.items.length ? `<button class="btn primary wide" data-act="ai-add">הוספה ל${esc(where)}</button>` : ''}`);
  renderAiTotal();
}

function aiRow(it, i) {
  const s = aiScaled(it);
  return `<div class="ai-row ${it.on ? '' : 'off'}" data-i="${i}">
    <button class="check" data-act="ai-toggle" data-i="${i}" aria-label="${it.on ? 'בטל' : 'סמן'}">${it.on ? '✓' : ''}</button>
    <div class="ai-main">
      <input class="input ai-name" data-ai-name="${i}" value="${esc(it.name)}">
      <div class="ai-sub">
        <label class="ai-grams"><input class="input" data-ai-grams="${i}" inputmode="decimal" value="${it.grams}"><span>גרם</span></label>
        <span class="ai-kcal" id="ai-kcal-${i}"><b>${s.kcal}</b> קק״ל · ${macroLine(s)}</span>
      </div>
    </div>
  </div>`;
}

function renderAiTotal() {
  const el = document.getElementById('ai-total');
  if (!el) return;
  const t = sum(ai.items.filter(it => it.on).map(aiScaled));
  el.innerHTML = `סה״כ <b>${t.kcal}</b> קק״ל<div>${macroLine(t)}</div>`;
}

function addAiItems() {
  const chosen = ai.items.filter(it => it.on && it.grams > 0 && it.name.trim());
  if (!chosen.length) { toast('לא נבחר כלום'); return; }
  const { kind, mealId, date } = sheetCtx;
  for (const it of chosen) {
    const per100 = x => (it.g0 > 0 ? r1((x / it.g0) * 100) : 0);
    const food = { id: null, name: it.name.trim(), kcal: per100(it.kcal0), p: per100(it.p0), c: per100(it.c0), f: per100(it.f0), units: [] };
    const item = makeItem(food, 'גרם', r1(it.grams));
    if (kind === 'plan') planItems(mealId).push(item);
    else day(date).entries.push({ ...item, mealId });
  }
  save(); closeSheet(); render();
  toast(`נוספו ${chosen.length} פריטים`);
  ai = null;
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
  if (viewing && !VIEWER_ACTS.has(act)) return;   // read-only while looking at someone else's data

  switch (act) {
    // measurements & photos
    case 'save-measure': {
      const vals = {};
      for (const i of document.querySelectorAll('[data-measure]')) vals[i.dataset.measure] = num(i.value);
      if (!Object.values(vals).some(v => v > 0)) { toast('צריך למלא לפחות מדידה אחת'); break; }
      setMeasurement(document.getElementById('m-date').value || dateKey(), vals);
      render(); toast('נשמר'); break;
    }
    case 'del-measure':
      if (confirm('למחוק את המדידה?')) { deleteMeasurement(el.dataset.date); render(); }
      break;
    case 'photo-open': openPhoto(el.dataset.path, el.dataset.date); break;
    case 'photo-del': {
      if (!confirm('למחוק את התמונה?')) break;
      const path = el.dataset.path;
      deletePhoto(path).catch(console.error);
      state.photos = (state.photos || []).filter(p => p.path !== path);
      save(); closeSheet(); render(); break;
    }

    // sharing
    case 'athletes': showAthletes(); break;
    case 'view-athlete': { const row = shares.athletes.find(a => a.owner_id === el.dataset.owner); if (row) startViewing(row); break; }
    case 'coach-exit': viewing = null; closeSheet(); tab = 'today'; curDay = dateKey(); render(); window.scrollTo(0, 0); break;
    case 'coach-msg': showCoachMessages(); break;
    case 'coach-send': {
      const body = document.getElementById('msg-body').value.trim();
      if (!body) { toast('צריך לכתוב משהו'); break; }
      el.disabled = true;
      sendMessage(viewing.ownerId, body).then(() => { toast('ההודעה נשלחה ✓'); showCoachMessages(); })
        .catch(e => { console.error(e); el.disabled = false; toast('השליחה נכשלה'); });
      break;
    }
    case 'coach-del-msg':
      if (confirm('למחוק את ההודעה?')) deleteMessage(id).then(showCoachMessages).catch(console.error);
      break;
    case 'share-add': {
      const email = document.getElementById('share-email').value.trim();
      if (!email) { toast('צריך מייל'); break; }
      el.disabled = true;
      addShare(email).then(err => {
        if (err) { toast(SHARE_ERRORS[err] || 'השיתוף נכשל'); el.disabled = false; return; }
        toast('שותף ✓'); loadShareBox();
      }).catch(e => { console.error(e); toast('השיתוף נכשל'); el.disabled = false; });
      break;
    }
    case 'share-remove': {
      const mine = el.dataset.owner === currentUser()?.id;
      if (!confirm(mine ? 'להפסיק את השיתוף? הוא לא יוכל לראות יותר את הנתונים שלך.' : 'להפסיק לעקוב אחרי המתאמן הזה?')) break;
      removeShare(el.dataset.owner, el.dataset.viewer).then(loadShareBox).catch(e => { console.error(e); toast('לא הצליח'); });
      break;
    }
    case 'my-messages': showMyMessages(); break;
    case 'msgs-read':
      markRead(el.dataset.ids.split(',')).catch(console.error);
      closeSheet(); break;

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
    case 'pick-photo': showPhotoSource('זיהוי מתמונה', blob => startFoodPhoto(blob), 'food-photo-input', 'environment', 'back-picker'); break;
    case 'cam-open': openCamera(); break;
    case 'cam-flip': camFacing = camFacing === 'user' ? 'environment' : 'user'; startCam(); break;
    case 'cam-shot': takeShot(); break;
    case 'cam-gallery': stopCam(); document.getElementById(camGallery).click(); break;
    case 'progress-photo': showPhotoSource('תמונת התקדמות', blob => { closeSheet(); addPhoto(blob); }, 'photo-input', 'user'); break;
    case 'ai-toggle': {
      const it = ai.items[+el.dataset.i];
      it.on = !it.on;
      const row = el.closest('.ai-row');
      row.classList.toggle('off', !it.on);
      el.textContent = it.on ? '✓' : '';
      renderAiTotal(); break;
    }
    case 'ai-go': analyzeWith(document.getElementById('ai-desc').value.trim()); break;
    case 'ai-retry': analyzeWith(document.getElementById('ai-hint').value.trim()); break;
    case 'ai-add': addAiItems(); break;
    case 'ai-again': showAiCompose(); break;
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
  else if (t.dataset.aiName !== undefined) ai.items[+t.dataset.aiName].name = t.value;
  else if (t.dataset.aiGrams !== undefined) {
    const i = +t.dataset.aiGrams, it = ai.items[i];
    it.grams = num(t.value);
    const sc = aiScaled(it);
    document.getElementById(`ai-kcal-${i}`).innerHTML = `<b>${sc.kcal}</b> קק״ל · ${macroLine(sc)}`;
    renderAiTotal();
  }
  else if (t.dataset.target) {
    const v = num(t.value);
    if (t.dataset.target === 'water') { state.targets.waterMl = Math.round(v * 1000); save(); }
    else setTargetsFrom(dateKey(), { ...targetsFor(dateKey()), [t.dataset.target]: v });
    updateMacroCheck();
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'food-photo-input' && t.files[0]) { const f = t.files[0]; t.value = ''; startFoodPhoto(f); return; }
  if (t.id === 'photo-input' && t.files[0]) { closeSheet(); addPhoto(t.files[0]); t.value = ''; return; }
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
  checkMessages();
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

const VIEWER_ACTS = new Set(['tab', 'day', 'today', 'close', 'photo-open', 'coach-exit', 'coach-msg', 'coach-send', 'coach-del-msg']);

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
    viewing = null;
    render();
    if (u) refreshShares().then(() => { if (tab === 'today' && !viewing) render(); checkMessages(); });
  },
});
