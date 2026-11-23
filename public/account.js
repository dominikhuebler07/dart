// Konten (Google / E-Mail) + Cloud-Speicher + Weltrangliste über Firebase.
// Ohne Eintrag in firebase-config.js läuft alles lokal weiter (Statistik nur auf diesem Gerät).
const V = '10.12.2';
const cfg = window.FIREBASE_CONFIG;
const listeners = new Set();
const api = {
  available: false,   // Firebase eingerichtet?
  user: null,         // { uid, name, email, photo }
  error: null,
  onChange(fn) { listeners.add(fn); fn(api.user); return () => listeners.delete(fn); },
};
window.Account = api;
const emit = () => { api.ready = true; for (const fn of listeners) { try { fn(api.user); } catch (e) { console.error(e); } } window.dispatchEvent(new CustomEvent('account', { detail: api.user })); };

// verständliche Fehlermeldungen
const MSG = {
  'auth/invalid-email': 'Diese E-Mail-Adresse ist ungültig.',
  'auth/missing-password': 'Bitte ein Passwort eingeben.',
  'auth/weak-password': 'Das Passwort braucht mindestens 6 Zeichen.',
  'auth/email-already-in-use': 'Für diese E-Mail gibt es schon ein Konto – melde dich an.',
  'auth/invalid-credential': 'E-Mail oder Passwort stimmt nicht.',
  'auth/wrong-password': 'E-Mail oder Passwort stimmt nicht.',
  'auth/user-not-found': 'Kein Konto mit dieser E-Mail.',
  'auth/too-many-requests': 'Zu viele Versuche. Warte kurz und probier es dann noch einmal.',
  'auth/popup-closed-by-user': 'Anmeldung abgebrochen.',
  'auth/network-request-failed': 'Keine Internetverbindung.',
  'auth/unauthorized-domain': 'Diese Adresse ist in Firebase noch nicht freigegeben (Authentication → Einstellungen → Autorisierte Domains).',
  'permission-denied': 'Keine Berechtigung – sind die Firestore-Regeln eingetragen?',
};
const nice = (e) => MSG[e && e.code] || (e && e.message) || 'Unbekannter Fehler';

// Entwickler-Modus NUR auf dem eigenen Rechner (localhost) ohne Firebase: Test-Konto über ?dev=Name.
// Der Server akzeptiert solche Test-Anmeldungen nur, wenn dort AUTH_DEV=1 gesetzt ist (auf Render nie).
function devMode() {
  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return false;
  const q = new URLSearchParams(location.search).get('dev');
  if (q) { try { sessionStorage.setItem('ds.dev', q); } catch (_) {} }
  let name = q; try { name = name || sessionStorage.getItem('ds.dev'); } catch (_) {}
  if (!name) return false;
  const uid = 'dev-' + name.toLowerCase().replace(/[^a-z0-9]/g, '');
  api.available = true; api.dev = true;
  api.user = { uid, name, email: name + '@test', photo: '' };
  api.getToken = async () => `dev:${uid}:${name}`;
  const mem = {};
  api.loadUser = async () => mem.user || null;
  api.loadStats = async () => (mem.user && mem.user.stats) || null;
  api.saveStats = async (stats) => { mem.user = Object.assign(mem.user || {}, { stats }); };
  api.saveLearn = async (learn) => { mem.user = Object.assign(mem.user || {}, { learn }); };
  api.saveLeaderboard = async () => {};
  api.fetchLeaderboard = async () => [];
  api.signOut = () => { try { sessionStorage.removeItem('ds.dev'); } catch (_) {} api.user = null; emit(); };
  emit();
  return true;
}

async function start() {
  if (devMode()) return;
  if (!cfg || !cfg.apiKey) { emit(); return; }
  try {
    const appMod = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
    const A = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
    const S = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);
    const app = appMod.initializeApp(cfg);
    const auth = A.getAuth(app);
    const db = S.getFirestore(app);
    auth.languageCode = 'de';
    api.available = true;

    const toUser = (u) => u && { uid: u.uid, name: u.displayName || (u.email ? u.email.split('@')[0] : 'Spieler'), email: u.email || '', photo: u.photoURL || '' };

    api.signInGoogle = async () => {
      const p = new A.GoogleAuthProvider();
      p.setCustomParameters({ prompt: 'select_account' });
      try { await A.signInWithPopup(auth, p); }
      catch (e) {
        // Popups gesperrt (manche Handy-Browser) -> per Weiterleitung anmelden
        if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') return A.signInWithRedirect(auth, p);
        throw new Error(nice(e));
      }
    };
    api.signInEmail = async (email, pw) => { try { await A.signInWithEmailAndPassword(auth, email, pw); } catch (e) { throw new Error(nice(e)); } };
    api.signUpEmail = async (email, pw, name) => {
      try {
        const c = await A.createUserWithEmailAndPassword(auth, email, pw);
        if (name) await A.updateProfile(c.user, { displayName: name });
        api.user = toUser(auth.currentUser);
        emit();
      } catch (e) { throw new Error(nice(e)); }
    };
    api.resetPassword = async (email) => { try { await A.sendPasswordResetEmail(auth, email); } catch (e) { throw new Error(nice(e)); } };
    api.signOut = () => A.signOut(auth);
    api.setName = async (name) => {
      await A.updateProfile(auth.currentUser, { displayName: name });
      api.user = toUser(auth.currentUser);
      emit();
    };

    // --- Daten ---
    api.loadStats = async () => {
      if (!api.user) return null;
      try {
        const snap = await S.getDoc(S.doc(db, 'users', api.user.uid));
        return snap.exists() ? snap.data().stats || null : null;
      } catch (e) { throw new Error(nice(e)); }
    };
    api.saveStats = async (stats) => {
      if (!api.user) return;
      try { await S.setDoc(S.doc(db, 'users', api.user.uid), { stats, name: api.user.name, updatedAt: S.serverTimestamp() }, { merge: true }); }
      catch (e) { throw new Error(nice(e)); }
    };
    // ganzes Nutzer-Dokument (Statistik, Lernpfad, Wartelisten-Bonus-Merker)
    api.loadUser = async () => {
      if (!api.user) return null;
      try { const snap = await S.getDoc(S.doc(db, 'users', api.user.uid)); return snap.exists() ? snap.data() : null; }
      catch (e) { throw new Error(nice(e)); }
    };
    api.saveLearn = async (learn) => {
      if (!api.user) return;
      try { await S.setDoc(S.doc(db, 'users', api.user.uid), { learn, name: api.user.name, updatedAt: S.serverTimestamp() }, { merge: true }); }
      catch (e) { console.warn('Lernpfad nicht gespeichert', e); }
    };
    // Anmelde-Ausweis für den Server (Online-Spiele, Turniere, Melden)
    api.getToken = async (force) => (auth.currentUser ? auth.currentUser.getIdToken(!!force) : null);
    api.saveLeaderboard = async (entry) => {
      if (!api.user) return;
      try { await S.setDoc(S.doc(db, 'leaderboard', api.user.uid), { ...entry, updatedAt: S.serverTimestamp() }); }
      catch (e) { throw new Error(nice(e)); }
    };
    // Rangliste: field = 'rankAvg' | 't180' | 'bestCheckout' | 'wins'
    api.fetchLeaderboard = async (field, n = 50) => {
      try {
        const q = S.query(S.collection(db, 'leaderboard'), S.orderBy(field, 'desc'), S.limit(n));
        const snap = await S.getDocs(q);
        return snap.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((r) => (r[field] || 0) > 0);
      } catch (e) { throw new Error(nice(e)); }
    };

    A.getRedirectResult(auth).catch((e) => { api.error = nice(e); emit(); });
    A.onAuthStateChanged(auth, (u) => { api.user = toUser(u); emit(); });
  } catch (e) {
    console.error('Firebase konnte nicht geladen werden', e);
    api.available = false;
    api.error = 'Anmeldung gerade nicht erreichbar (Internet?)';
    emit();
  }
}
start();
