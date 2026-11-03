// Cloud sync with Supabase (the same project and user accounts as the home app).
// Tables (see supabase.sql): nutrition_state = everything except the daily logs, one row per user;
// nutrition_days = one row per user per day. Row level security limits each user to their own rows.
// The local copy in localStorage stays what the UI reads; this module keeps it and the cloud in step.

const SUPABASE_URL = 'https://sgzphgypyjwozhhiunfq.supabase.co';
// Public (publishable) key – meant to be in client code; access is enforced by the RLS policies.
const SUPABASE_KEY = 'sb_publishable_MTJeFdvhOJfMUQFm3xSXfQ_R_P8mJ_X';
const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.1/+esm';

export const cloudEnabled = true;

let sb = null;
let user = null;
let channel = null;
let hooks = null;
// Last version known to be in the cloud, as stable JSON. Keys: 'meta' and day keys.
let synced = {};
// Versions this device wrote, so their realtime echoes are recognized and ignored.
let written = {};
let dirty = new Set();   // keys whose last write failed (offline) – retried later
let retryTimer = null;

export const currentUser = () => user;

// JSON with sorted keys: Postgres jsonb reorders keys, so plain JSON.stringify can't be compared.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

const metaOf = s => { const { days, ...meta } = s; return meta; };
const isEmptyDay = d => !d?.entries?.length && !d?.waterMl;

async function client() {
  if (sb) return sb;
  const { createClient } = await import(SDK);
  sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'nutrition-auth' },
  });
  return sb;
}

// hooks: getState() -> state, setState(state) replaces local state, onChange() re-renders, onUser(user|null, error?)
export async function initCloud(h) {
  hooks = h;
  try {
    await client();
  } catch (e) {
    console.error('Supabase failed to load', e);
    h.onUser(null, e);
    return;
  }
  let first = true;
  let currentId = null;
  sb.auth.onAuthStateChange((event, session) => {
    const u = session?.user || null;
    // Token refreshes also fire this; only react when the signed-in person changes.
    if (!first && (u?.id || null) === currentId) return;
    first = false;
    currentId = u?.id || null;
    // Supabase recommends not awaiting other calls inside this callback.
    setTimeout(async () => {
      stopSync();
      user = u;
      if (u) {
        try { await startSync(); } catch (e) { console.error(e); }
      }
      h.onUser(u);
    }, 0);
  });
}

async function fetchAll() {
  const [m, d] = await Promise.all([
    sb.from('nutrition_state').select('data').eq('user_id', user.id).maybeSingle(),
    sb.from('nutrition_days').select('day, data').eq('user_id', user.id),
  ]);
  if (m.error) throw m.error;
  if (d.error) throw d.error;
  return { meta: m.data?.data || null, days: d.data || [] };
}

async function startSync() {
  synced = {}; written = {}; dirty = new Set();
  const local = hooks.getState();
  let owner = null;
  try { owner = localStorage.getItem('nutrition-owner'); } catch {}
  // Local data never tied to an account is merged into the first account that signs in;
  // local data from a different account is dropped (it is in that account's cloud).
  const localUsable = !owner || owner === user.id;

  const remote = await fetchAll();
  const next = { ...(localUsable ? local : {}), days: {} };
  if (remote.meta) {
    synced.meta = stable(remote.meta);
    Object.assign(next, remote.meta);
  }
  for (const row of remote.days) {
    synced[row.day] = stable(row.data);
    next.days[row.day] = row.data;
  }
  if (localUsable) {
    for (const [k, d] of Object.entries(local.days || {})) if (!next.days[k] && !isEmptyDay(d)) next.days[k] = d;
  }
  try { localStorage.setItem('nutrition-owner', user.id); } catch {}
  hooks.setState(next);
  push(hooks.getState());   // uploads whatever the cloud doesn't have yet
  listen();
}

function isEcho(key, data) {
  const s = stable(data);
  if (written[key]?.has(s)) { written[key].delete(s); return true; }
  return s === synced[key];
}

function applyRemote(key, data) {
  if (dirty.has(key)) return false;           // our unsent change wins
  if (isEcho(key, data)) return false;
  synced[key] = stable(data);
  const s = hooks.getState();
  if (key === 'meta') hooks.setState({ ...data, days: s.days });
  else hooks.setState({ ...s, days: { ...s.days, [key]: data } });
  return true;
}

function listen() {
  const uid = user.id;
  channel = sb.channel(`nutrition-${uid}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'nutrition_state', filter: `user_id=eq.${uid}` }, p => {
      if (p.new?.data && applyRemote('meta', p.new.data)) hooks.onChange();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'nutrition_days', filter: `user_id=eq.${uid}` }, p => {
      if (p.new?.day && p.new?.data && applyRemote(p.new.day, p.new.data)) hooks.onChange();
    })
    .subscribe();
}

function stopSync() {
  if (channel) { sb.removeChannel(channel); channel = null; }
  clearTimeout(retryTimer);
}

// Catches changes missed while the phone was asleep (realtime doesn't replay them).
export async function refresh() {
  if (!user) return;
  try {
    const remote = await fetchAll();
    let changed = false;
    if (remote.meta) changed = applyRemote('meta', remote.meta) || changed;
    for (const row of remote.days) changed = applyRemote(row.day, row.data) || changed;
    if (changed) hooks.onChange();
    if (dirty.size) push(hooks.getState());
  } catch (e) { console.error(e); }
}

function write(key, data) {
  const s = stable(data);
  synced[key] = s;
  (written[key] ||= new Set()).add(s);
  dirty.delete(key);
  const now = new Date().toISOString();
  const req = key === 'meta'
    ? sb.from('nutrition_state').upsert({ user_id: user.id, data, updated_at: now })
    : sb.from('nutrition_days').upsert({ user_id: user.id, day: key, data, updated_at: now });
  req.then(({ error }) => {
    if (!error) return;
    console.error(error);
    if (synced[key] === s) { delete synced[key]; dirty.add(key); scheduleRetry(); }
  });
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => hooks && push(hooks.getState()), 20000);
}

// Called after every local save: writes only what changed since the last sync.
export function push(state) {
  if (!user || !sb) return;
  const meta = metaOf(state);
  if (stable(meta) !== synced.meta) write('meta', meta);
  for (const [k, d] of Object.entries(state.days || {})) {
    if (synced[k] === undefined && isEmptyDay(d) && !dirty.has(k)) continue;
    if (stable(d) !== synced[k]) write(k, d);
  }
}

addEventListener('online', () => hooks && push(hooks.getState()));

export async function deleteCloudData() {
  if (!user || !sb) return;
  const a = await sb.from('nutrition_days').delete().eq('user_id', user.id);
  const b = await sb.from('nutrition_state').delete().eq('user_id', user.id);
  if (a.error || b.error) throw a.error || b.error;
  synced = {}; written = {}; dirty = new Set();
}

// ---------- auth (email + password, same accounts as the home app) ----------

const ERRORS = [
  [/invalid login credentials/i, 'מייל או סיסמה לא נכונים'],
  [/email not confirmed/i, 'צריך לאשר את המייל קודם (בדקו בתיבת הדואר)'],
  [/already registered|already exists/i, 'כבר יש משתמש עם המייל הזה. נסו להתחבר'],
  [/at least 6|weak password/i, 'הסיסמה צריכה להיות לפחות 6 תווים'],
  [/invalid.*email|email.*invalid/i, 'כתובת מייל לא תקינה'],
  [/rate limit|too many/i, 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות'],
  [/failed to fetch|network/i, 'אין חיבור לאינטרנט'],
];
export const authError = e => (ERRORS.find(([re]) => re.test(e?.message || '')) || [, 'משהו השתבש. נסו שוב'])[1];

// Returns 'confirm' when the account was created but the email must be confirmed first.
export async function signInEmail(email, password, create) {
  await client();
  if (create) {
    const { data, error } = await sb.auth.signUp({ email: email.trim(), password });
    if (error) throw error;
    return data.session ? 'ok' : 'confirm';
  }
  const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
  return 'ok';
}

export async function signOut() {
  await client();
  stopSync();
  await sb.auth.signOut();
}

// ---------- sharing with a coach (read-only) and messages ----------

export async function listShares() {
  if (!user) return { viewers: [], athletes: [] };
  const { data, error } = await sb.from('nutrition_shares').select('*').order('created_at');
  if (error) throw error;
  return {
    viewers: data.filter(r => r.owner_id === user.id),
    athletes: data.filter(r => r.viewer_id === user.id),
  };
}

// Returns null on success, or an error code: 'no_user' | 'self' | ...
export async function addShare(email) {
  const { data, error } = await sb.rpc('nutrition_share_add', { viewer_email: email });
  if (error) throw error;
  return data?.error || null;
}

export async function removeShare(ownerId, viewerId) {
  const { error } = await sb.from('nutrition_shares').delete().eq('owner_id', ownerId).eq('viewer_id', viewerId);
  if (error) throw error;
}

// Someone else's data, read-only (allowed by the share).
export async function fetchUserData(ownerId) {
  const [m, d] = await Promise.all([
    sb.from('nutrition_state').select('data').eq('user_id', ownerId).maybeSingle(),
    sb.from('nutrition_days').select('day, data').eq('user_id', ownerId),
  ]);
  if (m.error) throw m.error;
  if (d.error) throw d.error;
  const days = {};
  for (const r of d.data || []) days[r.day] = r.data;
  return { ...(m.data?.data || {}), days };
}

export async function sendMessage(ownerId, body) {
  const { error } = await sb.from('nutrition_messages').insert({ owner_id: ownerId, body: body.trim() });
  if (error) throw error;
}

export async function listMessages(ownerId) {
  const { data, error } = await sb.from('nutrition_messages').select('*').eq('owner_id', ownerId).order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return data;
}

export async function deleteMessage(id) {
  const { error } = await sb.from('nutrition_messages').delete().eq('id', id);
  if (error) throw error;
}

export async function unreadMessages() {
  if (!user) return [];
  const { data, error } = await sb.from('nutrition_messages').select('*').eq('owner_id', user.id).is('read_at', null).order('created_at');
  if (error) throw error;
  return data;
}

export async function markRead(ids) {
  if (!ids.length) return;
  const { error } = await sb.from('nutrition_messages').update({ read_at: new Date().toISOString() }).in('id', ids);
  if (error) throw error;
}

// ---------- progress photos ----------

const BUCKET = 'nutrition-photos';
const urlCache = new Map();

export async function uploadPhoto(blob) {
  const path = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw error;
  return path;
}

export async function photoUrls(paths) {
  const need = paths.filter(p => !urlCache.has(p));
  if (need.length) {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(need, 60 * 60 * 6);
    if (error) throw error;
    for (const r of data || []) if (r.signedUrl) urlCache.set(r.path, r.signedUrl);
  }
  return Object.fromEntries(paths.map(p => [p, urlCache.get(p) || '']));
}

export async function deletePhoto(path) {
  const { error } = await sb.storage.from(BUCKET).remove([path]);
  if (error) throw error;
  urlCache.delete(path);
}
