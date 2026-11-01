// Cloud sync with Firebase (Auth + Firestore).
// Layout: users/{uid} holds everything except the daily logs; users/{uid}/days/{YYYY-MM-DD} holds one day each.
// Values are stored as JSON strings (Firestore does not allow nested arrays, which the food units use).
// The local copy in localStorage stays the source the UI reads from; this module keeps it and the cloud in step.
import { firebaseConfig } from './firebase-config.js?v=2';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

export const cloudEnabled = !!firebaseConfig?.apiKey;

let fb = null;          // loaded SDK functions + instances
let user = null;
let unsub = [];
let synced = { meta: null, days: {} };  // last JSON known to be in the cloud
let hooks = { getState: null, setState: null, onChange: null };

export const currentUser = () => user;

const metaOf = s => { const { days, ...meta } = s; return meta; };
const isEmptyDay = d => !d.entries?.length && !d.waterMl;

async function load() {
  if (fb) return fb;
  const [app, auth, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const a = app.initializeApp(firebaseConfig);
  let db;
  try {
    db = fs.initializeFirestore(a, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
  } catch {
    db = fs.getFirestore(a);
  }
  const au = auth.getAuth(a);
  try { await auth.setPersistence(au, auth.indexedDBLocalPersistence); } catch {}
  fb = { auth, fs, au, db };
  return fb;
}

// hooks: getState() -> state, setState(state) replaces local state, onChange() re-renders, onUser(user|null)
export async function initCloud(h) {
  hooks = h;
  if (!cloudEnabled) { h.onUser(null); return; }
  try {
    const { auth, au } = await load();
    auth.onAuthStateChanged(au, async u => {
      stopListening();
      user = u;
      if (u) {
        try { await startSync(); } catch (e) { console.error(e); }
      }
      h.onUser(u);
    });
  } catch (e) {
    console.error('Firebase failed to load', e);
    h.onUser(null, e);
  }
}

const metaRef = () => fb.fs.doc(fb.db, 'users', user.uid);
const daysCol = () => fb.fs.collection(fb.db, 'users', user.uid, 'days');
const dayRef = k => fb.fs.doc(fb.db, 'users', user.uid, 'days', k);

async function startSync() {
  const { fs } = fb;
  const local = hooks.getState();
  let owner = null;
  try { owner = localStorage.getItem('nutrition-owner'); } catch {}
  // Local data that was never tied to an account is merged into the first account that signs in.
  // Local data from a different account is dropped (the cloud has it).
  const localUsable = !owner || owner === user.uid;

  const [metaSnap, daysSnap] = await Promise.all([fs.getDoc(metaRef()), fs.getDocs(daysCol())]);
  synced = { meta: null, days: {} };
  const next = { ...(localUsable ? local : {}), days: {} };

  if (metaSnap.exists()) {
    synced.meta = metaSnap.data().json;
    Object.assign(next, JSON.parse(synced.meta));
  }
  daysSnap.forEach(d => { synced.days[d.id] = d.data().json; next.days[d.id] = JSON.parse(d.data().json); });
  if (localUsable) {
    for (const [k, d] of Object.entries(local.days || {})) if (!next.days[k] && !isEmptyDay(d)) next.days[k] = d;
  }

  try { localStorage.setItem('nutrition-owner', user.uid); } catch {}
  hooks.setState(next);
  push(hooks.getState());   // uploads whatever the cloud doesn't have yet
  listen();
}

function listen() {
  const { fs } = fb;
  unsub.push(fs.onSnapshot(metaRef(), snap => {
    if (snap.metadata.hasPendingWrites || !snap.exists()) return;
    const json = snap.data().json;
    if (json === synced.meta) return;
    synced.meta = json;
    const s = hooks.getState();
    hooks.setState({ ...JSON.parse(json), days: s.days });
    hooks.onChange();
  }));
  unsub.push(fs.onSnapshot(daysCol(), snap => {
    if (snap.metadata.hasPendingWrites) return;
    let changed = false;
    const s = hooks.getState();
    const days = { ...s.days };
    for (const ch of snap.docChanges()) {
      const k = ch.doc.id;
      if (ch.type === 'removed') {
        if (days[k]) { delete days[k]; delete synced.days[k]; changed = true; }
        continue;
      }
      const json = ch.doc.data().json;
      if (json === synced.days[k]) continue;
      synced.days[k] = json;
      days[k] = JSON.parse(json);
      changed = true;
    }
    if (changed) { hooks.setState({ ...s, days }); hooks.onChange(); }
  }));
}

function stopListening() {
  unsub.forEach(f => f());
  unsub = [];
}

// Called after every local save: writes only what changed since the last sync.
export function push(state) {
  if (!user || !fb) return;
  const { fs } = fb;
  const now = Date.now();
  const meta = JSON.stringify(metaOf(state));
  if (meta !== synced.meta) {
    synced.meta = meta;
    fs.setDoc(metaRef(), { json: meta, updatedAt: now }).catch(e => console.error(e));
  }
  for (const [k, d] of Object.entries(state.days || {})) {
    const json = JSON.stringify(d);
    if (json === synced.days[k]) continue;
    if (synced.days[k] === undefined && isEmptyDay(d)) continue;
    synced.days[k] = json;
    fs.setDoc(dayRef(k), { json, updatedAt: now }).catch(e => console.error(e));
  }
}

export async function deleteCloudData() {
  if (!user || !fb) return;
  const { fs } = fb;
  const snap = await fs.getDocs(daysCol());
  const batch = fs.writeBatch(fb.db);
  snap.forEach(d => batch.delete(d.ref));
  batch.delete(metaRef());
  await batch.commit();
  synced = { meta: null, days: {} };
}

// ---------- auth ----------

const ERRORS = {
  'auth/invalid-credential': 'מייל או סיסמה לא נכונים',
  'auth/wrong-password': 'מייל או סיסמה לא נכונים',
  'auth/user-not-found': 'אין משתמש עם המייל הזה. אפשר להירשם',
  'auth/email-already-in-use': 'כבר יש משתמש עם המייל הזה. נסו להתחבר',
  'auth/weak-password': 'הסיסמה צריכה להיות לפחות 6 תווים',
  'auth/invalid-email': 'כתובת מייל לא תקינה',
  'auth/missing-password': 'צריך סיסמה',
  'auth/too-many-requests': 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות',
  'auth/network-request-failed': 'אין חיבור לאינטרנט',
  'auth/popup-closed-by-user': 'החלון נסגר לפני שההתחברות הסתיימה',
  'auth/popup-blocked': 'הדפדפן חסם את חלון ההתחברות. נסו עם מייל וסיסמה',
  'auth/unauthorized-domain': 'האתר לא מאושר בהגדרות Firebase (Authorized domains)',
  'auth/operation-not-allowed': 'שיטת ההתחברות הזו לא מופעלת ב-Firebase',
};
export const authError = e => ERRORS[e?.code] || 'משהו השתבש. נסו שוב';

export async function signInGoogle() {
  const { auth, au } = await load();
  await auth.signInWithPopup(au, new auth.GoogleAuthProvider());
}

export async function signInEmail(email, password, create) {
  const { auth, au } = await load();
  if (create) await auth.createUserWithEmailAndPassword(au, email.trim(), password);
  else await auth.signInWithEmailAndPassword(au, email.trim(), password);
}

export async function resetPassword(email) {
  const { auth, au } = await load();
  await auth.sendPasswordResetEmail(au, email.trim());
}

export async function signOut() {
  const { auth, au } = await load();
  stopListening();
  await auth.signOut(au);
}
