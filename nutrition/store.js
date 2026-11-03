// App state: kept in localStorage on this device only. Backup/restore is a JSON file.
import { BUILTIN_FOODS } from './foods.js';

const KEY = 'nutrition-v1';

const DEFAULT_MEALS = [
  { id: 'breakfast', name: 'ארוחת בוקר' },
  { id: 'snack1', name: 'ביניים' },
  { id: 'lunch', name: 'ארוחת צהריים' },
  { id: 'snack2', name: 'ביניים אחה״צ' },
  { id: 'dinner', name: 'ארוחת ערב' },
];

function freshState() {
  return {
    v: 1,
    targets: { kcal: 2000, p: 150, c: 200, f: 65, waterMl: 2500 },
    meals: DEFAULT_MEALS.map(m => ({ ...m })),
    plan: {},          // mealId -> [item]
    customFoods: [],   // user foods, and edited copies of built-in foods (same id)
    days: {},          // 'YYYY-MM-DD' -> { entries: [item], waterMl }
    weights: [],       // [{ date, kg }] sorted by date
    recent: [],        // food ids, most recent first
    profile: {},
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...freshState(), ...JSON.parse(raw) };
  } catch {}
  return freshState();
}

export let state = load();

let saveHook = null;
export function onSave(fn) { saveHook = fn; }

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
  saveHook?.(state);
}

export function replaceState(next) {
  state = { ...freshState(), ...next };
  save();
}

export function resetState() {
  state = freshState();
  save();
}

// Ask the browser not to clear our data when space runs low.
try { navigator.storage?.persist?.(); } catch {}

// ---------- helpers ----------

export const uid = () => Math.random().toString(36).slice(2, 10);

export function dateKey(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function shiftKey(key, days) {
  const d = parseKey(key);
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

export const r1 = n => Math.round(n * 10) / 10;

// ---------- foods ----------

export function allFoods() {
  const custom = new Map(state.customFoods.map(f => [f.id, f]));
  const list = BUILTIN_FOODS.map(f => (custom.has(f.id) ? { ...custom.get(f.id), builtin: true, edited: true } : f));
  for (const f of state.customFoods) if (!BUILTIN_FOODS.some(b => b.id === f.id)) list.push(f);
  return list;
}

export function getFood(id) {
  return allFoods().find(f => f.id === id) || null;
}

export function saveFood(food) {
  const clean = {
    id: food.id || 'u-' + uid(),
    name: food.name.trim(),
    cat: food.cat,
    kcal: +food.kcal || 0, p: +food.p || 0, c: +food.c || 0, f: +food.f || 0,
    units: food.units.filter(([n, g]) => n && g > 0),
  };
  const i = state.customFoods.findIndex(f => f.id === clean.id);
  if (i >= 0) state.customFoods[i] = clean; else state.customFoods.push(clean);
  save();
  return clean;
}

// Removes a user food, or restores a built-in food to its original values.
export function deleteFood(id) {
  state.customFoods = state.customFoods.filter(f => f.id !== id);
  state.recent = state.recent.filter(r => r !== id || BUILTIN_FOODS.some(b => b.id === id));
  save();
}

export function unitsOf(food) {
  return [...(food.units || []), ['גרם', 1]];
}

export function touchRecent(foodId) {
  if (!foodId) return;
  state.recent = [foodId, ...state.recent.filter(id => id !== foodId)].slice(0, 30);
}

// ---------- items (a food + an amount; used both in the plan and in the daily log) ----------

export function makeItem(food, unit, qty) {
  const units = unitsOf(food);
  const g = (units.find(u => u[0] === unit) || units[units.length - 1])[1];
  const grams = r1(g * qty);
  const k = grams / 100;
  return {
    id: uid(),
    foodId: food.id,
    name: food.name,
    n: { kcal: food.kcal, p: food.p, c: food.c, f: food.f },
    units,
    unit, qty, grams,
    kcal: Math.round(food.kcal * k), p: r1(food.p * k), c: r1(food.c * k), f: r1(food.f * k),
  };
}

export function quickItem(name, kcal, p, c, f) {
  return {
    id: uid(), foodId: null, name: name.trim() || 'הוספה מהירה', n: null,
    kcal: Math.round(+kcal || 0), p: r1(+p || 0), c: r1(+c || 0), f: r1(+f || 0),
  };
}

// Re-computes an existing item with a new amount, keeping its id and links.
export function reamount(item, unit, qty) {
  const food = { id: item.foodId, name: item.name, ...item.n, units: item.units.slice(0, -1) };
  const next = makeItem(food, unit, qty);
  return { ...item, ...next, id: item.id };
}

export function amountLabel(item) {
  if (!item.n) return '';
  const q = +item.qty;
  if (item.unit === 'גרם') return `${q} גרם`;
  return `${q} ${item.unit} · ${Math.round(item.grams)} ג׳`;
}

export function sum(items) {
  const t = { kcal: 0, p: 0, c: 0, f: 0 };
  for (const it of items) { t.kcal += it.kcal; t.p += it.p; t.c += it.c; t.f += it.f; }
  return { kcal: Math.round(t.kcal), p: r1(t.p), c: r1(t.c), f: r1(t.f) };
}

// ---------- days ----------

export function day(key) {
  if (!state.days[key]) state.days[key] = { entries: [], waterMl: 0 };
  return state.days[key];
}

export function peekDay(key) {
  return state.days[key] || { entries: [], waterMl: 0 };
}

export function planItems(mealId) {
  return state.plan[mealId] || (state.plan[mealId] = []);
}

// ---------- weight ----------

export function setWeight(date, kg) {
  state.weights = state.weights.filter(w => w.date !== date);
  state.weights.push({ date, kg: r1(kg) });
  state.weights.sort((a, b) => a.date.localeCompare(b.date));
  save();
}

export function latestWeight() {
  return state.weights.length ? state.weights[state.weights.length - 1].kg : null;
}

// ---------- targets that change over time ----------
// state.targets holds the original targets; state.targetHistory = [{ from: 'YYYY-MM-DD', kcal, p, c, f }]
// sorted by date. A day uses the last change made on or before it, so a change never affects earlier days.

const TARGET_KEYS = ['kcal', 'p', 'c', 'f'];

export function targetsFor(key) {
  let t = state.targets;
  for (const e of state.targetHistory || []) if (e.from <= key) t = e;
  const out = {};
  for (const k of TARGET_KEYS) out[k] = +t[k] || 0;
  return out;
}

export function setTargetsFrom(key, vals) {
  const entry = { from: key };
  for (const k of TARGET_KEYS) entry[k] = +vals[k] || 0;
  const list = (state.targetHistory || []).filter(e => e.from !== key);
  list.push(entry);
  list.sort((a, b) => a.from.localeCompare(b.from));
  state.targetHistory = list;
  save();
}

export function deleteTargetChange(key) {
  state.targetHistory = (state.targetHistory || []).filter(e => e.from !== key);
  save();
}

// The next change after this day, if any (its targets take over from that date).
export function nextTargetChange(key) {
  return (state.targetHistory || []).find(e => e.from > key) || null;
}

export const trackWater = () => state.trackWater === true;

// Renders someone else's data with the same view code: swaps the state for the duration of fn.
export function withState(other, fn) {
  const mine = state;
  state = other;
  try { return fn(); } finally { state = mine; }
}

// ---------- body measurements & progress photos ----------

export const MEASURES = [
  ['waist', 'מותן'],
  ['belly', 'בטן (בגובה הטבור)'],
  ['hips', 'ירכיים / אגן'],
  ['chest', 'חזה'],
  ['arm', 'זרוע'],
  ['thigh', 'ירך'],
];

export function setMeasurement(date, vals) {
  const list = (state.measurements || []).filter(m => m.date !== date);
  const entry = { date };
  for (const [k] of MEASURES) if (vals[k] > 0) entry[k] = r1(vals[k]);
  if (Object.keys(entry).length > 1) list.push(entry);
  list.sort((a, b) => a.date.localeCompare(b.date));
  state.measurements = list;
  save();
}

export function deleteMeasurement(date) {
  state.measurements = (state.measurements || []).filter(m => m.date !== date);
  save();
}
