// Prüft Firebase-Anmeldungen (ID-Token) auf dem Server – ohne Zusatzpaket, nur mit Node-Bordmitteln.
// Ein ID-Token ist ein von Google signiertes JWT. Wir prüfen Signatur (RS256), Projekt, Aussteller und Ablaufzeit.
// Test-Modus: Mit AUTH_DEV=1 werden zusätzlich Test-Anmeldungen "dev:<uid>:<name>" angenommen (nur lokal verwenden!).
const crypto = require('crypto');

const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

function createAuth(opts = {}) {
  const projectId = opts.projectId || process.env.FIREBASE_PROJECT_ID || 'dart-1f6be';
  const dev = opts.dev != null ? opts.dev : process.env.AUTH_DEV === '1';
  const banned = new Set(String(opts.banned != null ? opts.banned : process.env.BANNED_UIDS || '').split(/[\s,]+/).filter(Boolean));
  const fetchCerts = opts.fetchCerts || (async () => {
    const r = await fetch(CERT_URL);
    if (!r.ok) throw new Error('Zertifikate nicht ladbar: ' + r.status);
    const maxAge = Number((/max-age=(\d+)/.exec(r.headers.get('cache-control') || '') || [])[1] || 3600);
    return { certs: await r.json(), maxAge };
  });
  let cache = null; // { certs, until }

  async function certs(force) {
    if (!force && cache && Date.now() < cache.until) return cache.certs;
    const { certs: c, maxAge } = await fetchCerts();
    cache = { certs: c, until: Date.now() + Math.max(60, maxAge) * 1000 };
    return c;
  }

  const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

  async function verify(token) {
    token = String(token || '');
    if (dev && token.startsWith('dev:')) {
      const [, uid, name] = token.split(':');
      if (!uid) throw new Error('Test-Anmeldung ungültig');
      return check({ uid, name: name || uid, email: '', dev: true });
    }
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Anmeldung ungültig');
    let header, payload;
    try { header = JSON.parse(b64(parts[0]).toString('utf8')); payload = JSON.parse(b64(parts[1]).toString('utf8')); }
    catch (_) { throw new Error('Anmeldung ungültig'); }
    if (header.alg !== 'RS256' || !header.kid) throw new Error('Anmeldung ungültig');
    let c = await certs(false);
    if (!c[header.kid]) c = await certs(true); // Google wechselt die Schlüssel regelmäßig
    const pem = c[header.kid];
    if (!pem) throw new Error('Anmeldung ungültig (Schlüssel)');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey(pem), b64(parts[2]));
    if (!ok) throw new Error('Anmeldung ungültig (Signatur)');
    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== projectId || payload.iss !== 'https://securetoken.google.com/' + projectId) throw new Error('Anmeldung gehört zu einem anderen Projekt');
    if (!(payload.exp > now - 30)) throw new Error('Anmeldung abgelaufen');
    if (!(payload.iat <= now + 300)) throw new Error('Anmeldung ungültig (Zeit)');
    if (!payload.sub) throw new Error('Anmeldung ungültig');
    return check({ uid: payload.sub, name: payload.name || (payload.email ? String(payload.email).split('@')[0] : ''), email: payload.email || '' });
  }

  function check(u) {
    if (banned.has(u.uid)) throw new Error('Dieses Konto ist für Online-Spiele gesperrt.');
    return u;
  }

  return { verify, projectId, dev, ban: (uid) => banned.add(uid), isBanned: (uid) => banned.has(uid) };
}

module.exports = { createAuth };
