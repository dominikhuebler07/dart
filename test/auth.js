// Server-Anmeldeprüfung (Firebase-ID-Token) mit einem Test-Schlüssel
const assert = require('assert');
const crypto = require('crypto');
const { createAuth } = require('../auth.js');
// Test-Schlüssel wird bei jedem Lauf neu erzeugt (Google liefert echte Zertifikate, die Prüfung ist dieselbe)
const { privateKey: key, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const cert = publicKey.export({ type: 'spki', format: 'pem' });
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const now = Math.floor(Date.now() / 1000);
function token(payload, kid = 'k1', k = key) {
  const h = b64({ alg: 'RS256', kid, typ: 'JWT' }), p = b64(payload);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), k).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}
const good = { aud: 'dart-1f6be', iss: 'https://securetoken.google.com/dart-1f6be', sub: 'uid123', iat: now - 10, exp: now + 3600, name: 'Domi', email: 'd@x.at' };
(async () => {
  let fetched = 0;
  const A = createAuth({ projectId: 'dart-1f6be', dev: false, banned: 'bad1', fetchCerts: async () => { fetched++; return { certs: { k1: cert }, maxAge: 3600 }; } });
  const u = await A.verify(token(good));
  assert(u.uid === 'uid123' && u.name === 'Domi', 'gültiges Token');
  const fails = async (t, why) => { let e = null; try { await A.verify(t); } catch (x) { e = x; } assert(e, why); };
  await fails(token({ ...good, exp: now - 100 }), 'abgelaufen');
  await fails(token({ ...good, aud: 'anderes' }), 'falsches Projekt');
  await fails(token(good).slice(0, -4) + 'AAAA', 'Signatur kaputt');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await fails(token(good, 'k1', other), 'fremder Schlüssel');
  await fails(token(good, 'k9'), 'unbekannter Schlüssel');
  await fails(token({ ...good, sub: 'bad1' }), 'gesperrtes Konto');
  await fails('dev:x:y', 'Test-Anmeldung ohne AUTH_DEV');
  assert(fetched <= 3, 'Zertifikate zwischengespeichert');
  const D = createAuth({ dev: true, fetchCerts: async () => ({ certs: {}, maxAge: 1 }) });
  assert((await D.verify('dev:dev-max:Max')).uid === 'dev-max', 'Test-Anmeldung mit AUTH_DEV');
  console.log('Anmelde-Tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
