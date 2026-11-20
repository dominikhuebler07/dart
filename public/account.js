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
const emit = () => { for (const fn of listeners) { try { fn(api.user); } catch (e) { console.error(e); } } window.dispatchEvent(new CustomEvent('account', { detail: api.user })); };

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

async function start() {
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
      try { await S.setDoc(S.doc(db, 'users', api.user.uid), { stats, name: api.user.name, updatedAt: S.serverTimestamp() }); }
      catch (e) { throw new Error(nice(e)); }
    };
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
