// Graphics mode for all games: 'rich' (illustrations, card art, textures, lighting) or 'simple'
// (the original flat look, lighter for weak phones). Saved per device; applied as
// <html data-gfx="…"> so the CSS can switch.
const KEY = 'hathatul-gfx';
export function gfxMode() {
  try { return localStorage.getItem(KEY) === 'simple' ? 'simple' : 'rich'; } catch { return 'rich'; }
}
export function setGfxMode(m) {
  try { localStorage.setItem(KEY, m); } catch {}
  document.documentElement.dataset.gfx = m;
}
export const isRich = () => document.documentElement.dataset.gfx !== 'simple';
document.documentElement.dataset.gfx = gfxMode();
