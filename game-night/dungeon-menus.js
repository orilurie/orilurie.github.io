// המבוך v2 – menus: gems & hero unlocks, hero picker, daily leaderboard, admin panel.
// Pure UI helpers; dungeon.js owns the screens and calls into these.
import * as core from './dungeon-core.js?v=53';

// Fallbacks so the module works even if the core hasn't been updated yet (namespace import never throws on a missing export).
const FALLBACK_HEROES = [
  { key: 'knight', name: 'אביר', spr: 97, color: '#ffd27a', ab: 'shield', abName: 'מגן', abCd: 9, weapon: 'sword', hp: 8, unlock: 0 },
  { key: 'wizard', name: 'קוסם', spr: 84, color: '#b07aff', ab: 'fireball', abName: 'כדור אש', abCd: 5, weapon: 'wand', hp: 6, unlock: 0 },
  { key: 'rogue', name: 'נוכלת', spr: 99, color: '#ff7aa8', ab: 'daggers', abName: 'מטר פגיונות', abCd: 6, weapon: 'daggers', hp: 6, unlock: 60 },
  { key: 'elf', name: 'שדונית', spr: 112, color: '#6fe08a', ab: 'volley', abName: 'מטח חיצים', abCd: 5, weapon: 'spear', hp: 6, unlock: 120 },
];
const FALLBACK_WEAPONS = {
  wand: { name: 'שרביט', spr: 130 }, ice: { name: 'מטה קרח', spr: 129 }, daggers: { name: 'פגיונות', spr: 103 },
  spear: { name: 'חנית', spr: 107 }, sword: { name: 'חרב', spr: 104 }, axe: { name: 'גרזן', spr: 118 }, hammer: { name: 'פטיש', spr: 117 },
};
const HEROES = () => (Array.isArray(core.HEROES) && core.HEROES.length ? core.HEROES : FALLBACK_HEROES);
const WEAPONS = () => core.WEAPONS || FALLBACK_WEAPONS;

export const ADMIN_NAME = 'אורי מורי';
export const isAdminName = name => String(name || '').trim() === ADMIN_NAME;

// ---------- small helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const myName = () => lsGet('hathatul-name') || '';

/** Tiny Dungeon tile as an inline sprite (same trick as dungeon.js). */
export const tileIcon = (idx, px = 32, cls = '') => `<span class="dg-ico ${cls}" style="width:${px}px;height:${px}px;background-position:-${(idx % 12) * px}px -${Math.floor(idx / 12) * px}px;background-size:${12 * px}px auto"></span>`;
/** Fluent emoji PNG from dungeon/ui/ with an emoji fallback if the file is missing. */
export const uiIcon = (name, emoji, px = 20) =>
  `<span class="dgm-uic" data-e="${emoji}" style="--s:${px}px"><img src="dungeon/ui/${name}.png" alt="" width="${px}" height="${px}" onerror="this.parentNode.classList.add('fb');this.remove()"></span>`;
const AB_ICON = { shield: ['shield', '🛡️'], fireball: ['fire', '🔥'], daggers: ['dagger', '🗡️'], volley: ['bow', '🏹'] };

// ---------- gems & unlocks ----------
export function gems() { const n = parseInt(lsGet('dungeon-gems'), 10); return Number.isFinite(n) && n > 0 ? n : 0; }
export function addGems(n) { const v = Math.max(0, gems() + Math.round(Number(n) || 0)); lsSet('dungeon-gems', String(v)); return v; }
function unlockedSet() { try { const a = JSON.parse(lsGet('dungeon-unlocked') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
export function isUnlocked(heroIdx, name = myName()) {
  const h = HEROES()[heroIdx];
  if (!h) return false;
  if (!h.unlock || isAdminName(name)) return true;
  return unlockedSet().includes(h.key);
}
export function unlockHero(heroIdx) {
  const h = HEROES()[heroIdx];
  if (!h) return false;
  if (isUnlocked(heroIdx)) return true;
  if (gems() < h.unlock) return false;
  addGems(-h.unlock);
  lsSet('dungeon-unlocked', JSON.stringify([...unlockedSet(), h.key]));
  return true;
}
export function runGems({ floor = 0, kills = 0, won = false } = {}) { return (floor | 0) * 5 + Math.floor((kills | 0) / 5) + (won ? 30 : 0); }

// ---------- hero picker ----------
export function heroPickerHtml(selected = 0) {
  const W = WEAPONS();
  const cards = HEROES().map((h, i) => {
    const open = isUnlocked(i);
    const w = W[h.weapon] || {};
    const [abImg, abEmo] = AB_ICON[h.ab] || ['gear', '✨'];
    const hearts = '❤️'.repeat(Math.ceil((h.hp || 6) / 2));
    return `<div class="dgm-hero ${open ? '' : 'locked'} ${i === selected && open ? 'sel' : ''}" style="--hc:${h.color}">
      <button class="dgm-hero-pick" data-hero="${i}" ${open ? '' : 'disabled'} aria-label="${esc(h.name)}">
        <span class="dgm-hero-spr">${tileIcon(h.spr, 64)}</span>
        <b class="dgm-hero-name">${esc(h.name)}</b>
        <span class="dgm-hero-row">${uiIcon(abImg, abEmo, 18)} ${esc(h.abName)}</span>
        <span class="dgm-hero-row">${w.spr != null ? tileIcon(w.spr, 20) : ''} ${esc(w.name || '')}</span>
        <span class="dgm-hero-hp">${hearts}</span>
      </button>
      ${open ? '' : `<button class="dgm-unlock" data-unlock="${i}">${uiIcon('gem', '💎', 16)} ${h.unlock} · לפתוח</button>`}
    </div>`;
  }).join('');
  return `<div class="dgm-heroes-wrap"><div class="dgm-gems">${uiIcon('gem', '💎', 20)} <b>${gems()}</b> <small>יהלומים</small></div><div class="dgm-heroes">${cards}</div></div>`;
}

export function bindHeroPicker(root, { onPick, onChange } = {}) {
  if (!root || root._dgmBound) return;
  root._dgmBound = true;
  root.addEventListener('click', e => {
    const u = e.target.closest('[data-unlock]');
    if (u && root.contains(u)) {
      e.preventDefault(); e.stopPropagation();
      const i = +u.dataset.unlock, h = HEROES()[i];
      if (!h) return;
      if (gems() < h.unlock) { alert(`צריך עוד ${h.unlock - gems()} 💎 כדי לפתוח את ${h.name}.\nמרוויחים יהלומים בכל ריצה!`); return; }
      if (!confirm(`לפתוח את ${h.name} ב-${h.unlock} 💎?`)) return;
      if (unlockHero(i)) { onChange?.(); onPick?.(i); }
      return;
    }
    const p = e.target.closest('[data-hero]');
    if (p && root.contains(p) && !p.disabled) { e.preventDefault(); onPick?.(+p.dataset.hero); }
  });
}

// ---------- daily ----------
export function dailyKey(date = new Date()) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}
function dailyDateHe(d) {
  const s = String(d || dailyKey());
  const dt = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
  try { return dt.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); }
  catch { return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`; }
}
/** state: { loading?, error?, d?, top?: [{name,score,floor,won,kills}], me?: name to highlight } (or { data:{d,top} }). */
export function dailyHtml(state = {}) {
  const data = state.data || state;
  const top = Array.isArray(data.top) ? data.top.slice(0, 20) : null;
  const me = String(state.me ?? myName()).trim();
  let body;
  if (state.loading) body = '<div class="dgm-daily-msg"><div class="spinner"></div>טוען את הטבלה…</div>';
  else if (state.error) body = `<div class="dgm-daily-msg err">לא הצלחנו לטעון את הטבלה 😕<br><small>${esc(typeof state.error === 'string' ? state.error : 'נסו שוב מאוחר יותר')}</small></div>`;
  else if (!top || !top.length) body = '<div class="dgm-daily-msg">עוד אף אחד לא שיחק היום – היו הראשונים!</div>';
  else body = `<table class="dgm-board"><thead><tr><th>#</th><th>שם</th><th>קומה</th><th>ניקוד</th></tr></thead><tbody>${top.map((r, i) =>
    `<tr class="${String(r.name || '').trim() === me && me ? 'me' : ''}"><td>${i === 0 ? uiIcon('crown', '👑', 18) : i + 1}</td><td class="nm">${esc(r.name)}</td><td>${r.won ? '🏆' : (r.floor ?? '')}</td><td><b>${(+r.score || 0).toLocaleString('en-US')}</b></td></tr>`).join('')}</tbody></table>`;
  return `<section class="dgm-daily">
    <div class="dgm-daily-head">${uiIcon('calendar', '📅', 28)}<div><b>האתגר היומי</b><small>${esc(dailyDateHe(data.d))} · אותו מבוך לכולם</small></div></div>
    <button class="primary dgm-daily-play" data-act="daily">${uiIcon('skull', '💀', 20)} לשחק את האתגר היומי</button>
    ${body}
  </section>`;
}
/** Fetch today's (UTC) top-20. server: base http(s) URL of the worker (ws/wss is converted). Throws on failure. */
export async function loadDaily(server, d = dailyKey()) {
  const base = String(server || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const to = ctrl && setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${base}/api/daily?d=${d}`, { signal: ctrl?.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return { d: j.d ?? d, top: Array.isArray(j.top) ? j.top : [] };
  } finally { if (to) clearTimeout(to); }
}

// ---------- admin panel ----------
const RAR = ['common', 'rare', 'legend'];
let adm = null; // { el, fab, opts, timer, local }

export function closeAdminPanel() {
  if (!adm) return;
  clearInterval(adm.timer);
  adm.el.remove(); adm.fab.remove();
  adm = null;
}

/** Floating RTL admin panel. Calling it again toggles open/closed. Returns { toggle, close, refresh, destroy }. */
export function openAdminPanel(opts = {}) {
  if (adm) { adm.opts = opts; toggle(); return api(); }
  const { ITEMS = core.ITEMS || {}, ITEM_LIST = Object.keys(ITEMS), WEAPONS: WP = WEAPONS(), WEAPON_LIST = Object.keys(WP) } = opts;
  const el = document.createElement('div');
  el.className = 'dgm-admin'; el.dir = 'rtl';
  const tg = (c, label) => `<button class="dgm-tg" data-c="${c}">${label}</button>`;
  el.innerHTML = `
    <div class="dgm-admin-head" data-drag>${uiIcon('gear', '⚙️', 22)}<b>אדמין</b><button class="dgm-admin-x" data-close aria-label="סגור">✕</button></div>
    <div class="dgm-admin-body">
      <div class="dgm-grid3">${tg('god', '🛡️ אל-מוות')}${tg('speed', '💨 מהירות ×2')}${tg('dmg', '💥 נזק ×5')}</div>
      <h4>💰 מטבעות <small class="dgm-coins"></small></h4>
      <div class="dgm-row"><button data-c="addcoins" data-v="50"><bdi dir="ltr">+50</bdi></button><button data-c="addcoins" data-v="500"><bdi dir="ltr">+500</bdi></button>
        <input type="number" inputmode="numeric" min="0" max="99999" class="dgm-coin-in" placeholder="סכום" dir="ltr"><button data-setcoins>קבע</button></div>
      <h4>❤️ חיים</h4>
      <div class="dgm-row"><button data-c="heal">❤️ ריפוי מלא</button><button data-c="maxhp">➕ 2 לבבות</button><button data-c="reviveall">✨ החייאה לכולם</button></div>
      <h4>🗺️ מבוך</h4>
      <div class="dgm-row"><button data-c="killroom">💀 להרוג את החדר</button><button data-c="nextfloor">⬇️ קומה הבאה</button><button data-c="reveal">👁️ לחשוף מפה</button></div>
      <h4>🎁 חפצים <small>(לחיצה = לקבל)</small></h4>
      <div class="dgm-sprgrid">${ITEM_LIST.map(k => { const it = ITEMS[k] || {}; return `<button class="dgm-spr r-${RAR[it.r | 0] || 'common'}" data-c="item" data-v="${esc(k)}" title="${esc(it.name || k)}">${tileIcon(it.spr ?? 0, 32)}<small>${esc(it.name || k)}</small></button>`; }).join('')}</div>
      <h4>⚔️ נשקים</h4>
      <div class="dgm-sprgrid">${WEAPON_LIST.map(k => { const w = WP[k] || {}; return `<button class="dgm-spr" data-c="weapon" data-v="${esc(k)}" title="${esc(w.name || k)}">${tileIcon(w.spr ?? 0, 32)}<small>${esc(w.name || k)}</small></button>`; }).join('')}</div>
      <p class="dgm-admin-note">מצב אדמין — הריצה לא נכנסת לטבלה היומית</p>
    </div>`;
  const fab = document.createElement('button');
  fab.className = 'dgm-admin-fab'; fab.title = 'אדמין'; fab.innerHTML = uiIcon('gear', '⚙️', 26);
  document.body.append(el, fab);
  adm = { el, fab, opts, timer: 0, local: { god: false, speed: false, dmg: false } };

  const send = (c, v) => { try { adm?.opts.send?.(v === undefined ? { t: 'adm', c } : { t: 'adm', c, v }); } catch (e) { console.warn('admin send', e); } };
  const flash = b => { b.classList.add('ok'); setTimeout(() => b.classList.remove('ok'), 350); };
  // keep game input handlers (keyboard, joystick on window) away from the panel
  for (const ev of ['keydown', 'keyup', 'pointerdown', 'touchstart', 'mousedown', 'wheel']) el.addEventListener(ev, e => e.stopPropagation(), { passive: true });
  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-close')) { toggle(false); return; }
    if (b.hasAttribute('data-setcoins')) {
      const inp = el.querySelector('.dgm-coin-in'); const v = Math.max(0, Math.min(99999, Math.round(+inp.value || 0)));
      if (inp.value !== '') { send('coins', v); flash(b); inp.blur(); }
      return;
    }
    const c = b.dataset.c; if (!c) return;
    if (b.classList.contains('dgm-tg')) { adm.local[c] = !curState()[c]; adm.localT = Date.now(); }
    send(c, b.dataset.v === undefined ? undefined : (c === 'addcoins' ? +b.dataset.v : b.dataset.v));
    flash(b); refresh();
  });
  el.querySelector('.dgm-coin-in').addEventListener('keydown', e => { if (e.key === 'Enter') el.querySelector('[data-setcoins]').click(); });
  fab.addEventListener('click', e => { e.stopPropagation(); toggle(); });
  for (const ev of ['pointerdown', 'touchstart']) fab.addEventListener(ev, e => e.stopPropagation(), { passive: true });

  // drag by the header (mouse or touch)
  const head = el.querySelector('[data-drag]');
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = el.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
    head.setPointerCapture?.(e.pointerId);
    const mv = m => {
      const x = Math.max(0, Math.min(innerWidth - r.width, m.clientX - ox)), y = Math.max(0, Math.min(innerHeight - 48, m.clientY - oy));
      Object.assign(el.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
    };
    const up = () => { head.removeEventListener('pointermove', mv); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); };
    head.addEventListener('pointermove', mv); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
  });

  toggle(true);
  return api();
}
function curState() {
  let s = null; try { s = adm?.opts.getState?.() || null; } catch {}
  const fresh = adm && Date.now() - (adm.localT || 0) < 1200; // optimistic value until the server echoes it
  const pick = k => (s && s[k] !== undefined && !fresh ? !!s[k] : !!adm?.local[k]);
  return { god: pick('god'), speed: pick('speed'), dmg: pick('dmg'), coins: s?.coins };
}
function refresh() {
  if (!adm) return;
  const st = curState();
  for (const k of ['god', 'speed', 'dmg']) { adm.local[k] = st[k]; adm.el.querySelector(`.dgm-tg[data-c="${k}"]`)?.classList.toggle('on', st[k]); }
  const c = adm.el.querySelector('.dgm-coins'); if (c) c.textContent = st.coins != null ? `(יש ${st.coins})` : '';
}
function toggle(force) {
  if (!adm) return;
  const open = force ?? adm.el.hidden;
  adm.el.hidden = !open; adm.fab.classList.toggle('on', open);
  clearInterval(adm.timer);
  if (open) { refresh(); adm.timer = setInterval(refresh, 500); }
}
function api() { return { toggle: f => toggle(f), close: () => toggle(false), refresh, destroy: closeAdminPanel }; }
