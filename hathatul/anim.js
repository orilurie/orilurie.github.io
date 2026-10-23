// Animations. Cards "fly" as ghost copies on a fixed layer between their old and new spots
// (snapshot before render -> render -> animate from old rects to new elements).

import { play, haptic } from './sfx.js?v=20';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = ms => new Promise(r => setTimeout(r, ms));
const layer = () => document.getElementById('fx');
const BACK = '<div class="card back"><span>🐾</span></div>';
export const STRIP = ['clickable', 'glow', 'hl', 'sel', 'revealed', 'pop', 'draggable', 'drag-src', 'drop-ok', 'drop-hover'];

// Rect + html of every animatable element ([data-k]) currently on screen.
export function snapshot() {
  const snap = {};
  for (const el of document.querySelectorAll('[data-k]')) {
    snap[el.dataset.k] = { rect: el.getBoundingClientRect(), html: el.outerHTML };
  }
  return snap;
}

const $k = k => document.querySelector(`[data-k="${k}"]`);
const center = r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

function makeGhost(html, rect) {
  const g = document.createElement('div');
  g.className = 'fly-ghost';
  g.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
  setFace(g, html, rect.width);
  layer().append(g);
  return g;
}

function setFace(g, html, w) {
  g.innerHTML = html;
  const c = g.firstElementChild;
  c.classList.remove(...STRIP);
  c.removeAttribute('data-k');
  c.style.setProperty('--w', w + 'px');
  c.style.visibility = '';
}

const isBack = html => /class="card back/.test(html);

// Fly a card from a snapshot entry to the element with key toKey, flipping if the face changes.
export async function fly(from, toKey, { delay = 0, duration = 520, arc = 46, spin = -8, scaleMid = 1.12, hide = true, size = null } = {}) {
  const toEl = $k(toKey);
  if (!from || !toEl) return;
  if (reduced()) return;
  // size: land as a card of this width at the target's centre (when the target is a box, not a card).
  const box = toEl.getBoundingClientRect();
  const to = size ? { left: box.left + box.width / 2 - size / 2, top: box.top + box.height / 2 - size * 0.7, width: size, height: size * 1.4 } : box;
  const endHtml = size ? from.html : toEl.outerHTML;
  const flip = !size && isBack(from.html) !== toEl.classList.contains('back');
  if (hide) toEl.style.visibility = 'hidden';
  if (delay) await wait(delay);
  const g = makeGhost(from.html, from.rect);
  const a = center(from.rect), b = center(to);
  const dx = b.x - a.x, dy = b.y - a.y, s = to.width / from.rect.width;
  const move = g.animate([
    { transform: 'translate(0,0) scale(1) rotate(0deg)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.2))' },
    { transform: `translate(${dx / 2}px,${dy / 2 - arc}px) scale(${((1 + s) / 2) * scaleMid}) rotate(${spin}deg)`, filter: 'drop-shadow(0 14px 14px rgba(0,0,0,.3))', offset: 0.5 },
    { transform: `translate(${dx}px,${dy}px) scale(${s}) rotate(0deg)`, filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.2))' },
  ], { duration, easing: 'cubic-bezier(.45,.05,.3,1)', fill: 'forwards' });
  if (flip) {
    const card = () => g.firstElementChild;
    await card().animate([{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(90deg)' }],
      { duration: duration / 2, easing: 'ease-in', fill: 'forwards' }).finished;
    setFace(g, endHtml, from.rect.width);
    card().animate([{ transform: 'rotateY(-90deg)' }, { transform: 'rotateY(0deg)' }],
      { duration: duration / 2, easing: 'ease-out', fill: 'forwards' });
  }
  await move.finished;
  g.remove();
  const now = $k(toKey);
  if (now && hide) {
    now.style.visibility = '';
    now.animate([{ transform: 'scale(1.1)' }, { transform: 'scale(.97)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' });
  }
}

const backAt = key => {
  const el = $k(key);
  return el && { rect: el.getBoundingClientRect(), html: BACK };
};

// Plays the animations for a list of events. view = the new view.
export async function playEvents(events, before, view) {
  for (const ev of events) {
    const me = view.me;
    switch (ev.type) {
      case 'deal': {
        const deck = backAt('deck');
        const n = view.players.length;
        const jobs = [];
        for (let s = 0; s < 4; s++) {
          for (let k = 0; k < n; k++) {
            const pi = view.order ? view.order[k] : (view.turn + k) % n;
            const delay = (s * n + k) * 90;
            setTimeout(() => play('tick'), delay);
            jobs.push(fly(deck, `h${pi}-${s}`, { delay, duration: 480, arc: 30, spin: 10 }));
          }
        }
        jobs.push(fly(deck, 'discard', { delay: 4 * n * 90, duration: 500 }));
        await Promise.all(jobs);
        break;
      }
      case 'draw':
        play('draw');
        await fly(before[ev.source === 'deck' ? 'deck' : 'discard'] || backAt('deck'), 'drawn', { duration: 480 });
        break;
      case 'replace': {
        const key = `h${ev.pi}-${ev.slot}`;
        play('place');
        setTimeout(() => play('discard'), 250);
        await Promise.all([
          fly(before.drawn, key, { duration: 560, arc: 36 }),
          fly(before[key], 'discard', { delay: 80, duration: 600, arc: 60, spin: 12 }),
        ]);
        break;
      }
      case 'discard':
        play('discard');
        await fly(before.drawn, 'discard', { duration: 480, spin: 14 });
        break;
      case 'power':
        await fly(before.drawn, 'discard', { duration: 420 });
        play('power');
        burst(`[data-k="discard"]`, { peek: '👁️', swap: '🔄', draw2: '✌️' }[ev.power]);
        break;
      case 'peek':
        play('peek');
        peekFx(`h${ev.pi}-${ev.slot}`, ev.pi === me);
        break;
      case 'swap': {
        const ka = `h${ev.a.pi}-${ev.a.slot}`, kb = `h${ev.b.pi}-${ev.b.slot}`;
        play('swap');
        if (ev.b.pi === me) haptic('swapped'); // someone took one of my cards
        await Promise.all([
          fly(before[ka], kb, { duration: 760, arc: 70, spin: 20, scaleMid: 1.6 }),
          fly(before[kb], ka, { duration: 760, arc: -70, spin: -20, scaleMid: 1.6 }),
        ]);
        break;
      }
      case 'ready':
        if (ev.pi === me) play('flip');
        if (ev.pi === me) await Promise.all([0, 3].map(s => fly(before[`h${me}-${s}`], `h${me}-${s}`, { duration: 460, arc: 24, spin: 0 })));
        break;
      case 'reshuffle': {
        const from = before.discard || backAt('discard');
        play('shuffle');
        await Promise.all([0, 1, 2, 3, 4].map(i => fly(from && { ...from, html: BACK }, 'deck', { delay: i * 70, duration: 420, arc: 20 })));
        break;
      }
      case 'call':
        play('call');
        if (ev.pi !== me) haptic('call');
        callBanner(view.players[ev.pi].name, ev.pi === me);
        await wait(reduced() ? 0 : 1500);
        break;
      case 'roundEnd': {
        const jobs = [];
        let i = 0;
        view.players.forEach((p, pi) => p.hand.forEach((_, s) => {
          const key = `h${pi}-${s}`;
          const el = $k(key);
          const prev = before[key];
          if (el && prev && isBack(prev.html)) setTimeout(() => play('flip'), i * 110 + 250);
          if (el && prev && isBack(prev.html)) jobs.push(fly({ rect: el.getBoundingClientRect(), html: BACK }, key, { delay: i++ * 110, duration: 520, arc: 22, spin: 0, scaleMid: 1.25 }));
        }));
        await Promise.all(jobs);
        await wait(reduced() ? 0 : 500);
        break;
      }
    }
  }
}

export function turnFx() {
  const st = document.querySelector('.status.mine');
  if (st && !reduced()) st.animate([{ transform: 'scale(.85)', opacity: 0 }, { transform: 'scale(1.06)', opacity: 1 }, { transform: 'scale(1)' }], { duration: 420, easing: 'ease-out' });
}

export function burst(sel, icon) {
  const el = document.querySelector(sel);
  if (!el || reduced()) return;
  const c = center(el.getBoundingClientRect());
  const b = document.createElement('div');
  b.className = 'burst';
  b.textContent = icon;
  b.style.cssText = `left:${c.x}px;top:${c.y}px`;
  layer().append(b);
  b.animate([
    { transform: 'translate(-50%,-50%) scale(.3)', opacity: 0 },
    { transform: 'translate(-50%,-50%) scale(1.6)', opacity: 1, offset: 0.35 },
    { transform: 'translate(-50%,-90%) scale(2.4)', opacity: 0 },
  ], { duration: 900, easing: 'ease-out' }).finished.then(() => b.remove());
}

function peekFx(key, mine) {
  const el = $k(key);
  if (!el || reduced()) return;
  el.animate([
    { transform: 'translateY(0) rotate(0)' },
    { transform: 'translateY(-16px) rotate(-6deg) scale(1.12)', offset: 0.3 },
    { transform: 'translateY(-16px) rotate(4deg) scale(1.12)', offset: 0.7 },
    { transform: 'translateY(0) rotate(0)' },
  ], { duration: 900, easing: 'ease-in-out' });
  if (!mine) burst(`[data-k="${key}"]`, '👁️');
}

export function callBanner(name, isMe) {
  const el = document.createElement('div');
  el.className = 'call-banner';
  const paws = Array.from({ length: 18 }, (_, i) => {
    const ang = (i / 18) * Math.PI * 2;
    const d = 160 + Math.random() * 140;
    return `<i style="--dx:${Math.cos(ang) * d}px;--dy:${Math.sin(ang) * d}px;--r:${Math.random() * 360}deg;--d:${Math.random() * 200}ms">${i % 3 ? '🐾' : i % 2 ? '🐱' : '🐭'}</i>`;
  }).join('');
  const who = document.createElement('div');
  who.className = 'cb-sub';
  who.textContent = isMe ? 'קראת חתחתול!' : `${name} קרא/ה חתחתול!`;
  el.innerHTML = `<div class="cb-paws">${paws}</div><div class="cb-inner"><div class="cb-mega">📣</div><div class="cb-title">חתחתול!</div></div>`;
  el.querySelector('.cb-inner').append(who);
  const note = document.createElement('div');
  note.className = 'cb-note';
  note.textContent = isMe ? 'לכל השאר נשאר תור אחרון' : 'נשאר לך תור אחרון!';
  el.querySelector('.cb-inner').append(note);
  document.body.append(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3100);
}

export function confetti() {
  if (reduced()) return;
  const colors = ['#ff8a3d', '#ffd23f', '#2f6f5e', '#c0504d', '#7b3fc4', '#4a90d9'];
  for (let i = 0; i < 70; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.cssText = `left:${Math.random() * 100}vw;background:${colors[i % colors.length]};width:${6 + Math.random() * 6}px;height:${10 + Math.random() * 8}px`;
    layer().append(c);
    c.animate([
      { transform: `translateY(-20px) rotate(0deg)`, opacity: 1 },
      { transform: `translate(${(Math.random() - 0.5) * 200}px, 105vh) rotate(${Math.random() * 900}deg)`, opacity: 0.9 },
    ], { duration: 2200 + Math.random() * 1500, delay: Math.random() * 500, easing: 'cubic-bezier(.25,.6,.4,1)' }).finished.then(() => c.remove());
  }
}

// A reaction emoji floats up from the sender's seat, with their name under it.
export function emojiFx(fromEl, emoji, name) {
  const r = fromEl ? fromEl.getBoundingClientRect() : { left: innerWidth / 2 - 40, top: innerHeight - 140, width: 80, height: 60 };
  const el = document.createElement('div');
  el.className = 'emoji-fly';
  el.style.cssText = `left:${r.left + r.width / 2 + (Math.random() - 0.5) * r.width * 0.5}px;top:${r.top + r.height / 2}px`;
  el.innerHTML = `<b></b>${name ? '<small></small>' : ''}`;
  el.querySelector('b').textContent = emoji;
  if (name) el.querySelector('small').textContent = name;
  layer().append(el);
  const drift = (Math.random() - 0.5) * 60;
  const anim = reduced()
    ? el.animate([{ opacity: 1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 1600 })
    : el.animate([
      { transform: 'translate(-50%,-50%) scale(.3) rotate(-20deg)', opacity: 0 },
      { transform: 'translate(-50%,-90%) scale(1.5) rotate(8deg)', opacity: 1, offset: 0.2 },
      { transform: `translate(calc(-50% + ${drift / 2}px),-160%) scale(1.3) rotate(-6deg)`, opacity: 1, offset: 0.6 },
      { transform: `translate(calc(-50% + ${drift}px),-260%) scale(1.1) rotate(4deg)`, opacity: 0 },
    ], { duration: 1800, easing: 'ease-out' });
  anim.finished.then(() => el.remove());
}
