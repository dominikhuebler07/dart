// Meldungen: Telegram / Discord (mit nachgebautem Server)
const assert = require('assert');
const { createReports } = require('../reports.js');
const img = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const rep = { id: 'x', at: new Date().toISOString(), room: 'AB12', kind: 'quick', reason: 'Würfe falsch gezählt', text: 'T20 war <daneben>',
  reporter: { uid: 'u1', name: 'Anna' }, target: { uid: 'u2', name: 'Ben' }, targetCam: true,
  log: [{ name: 'Ben', score: 321, turns: ['T20, T20, T20'] }], frames: [{ img, ts: Date.now(), dart: 'T20' }, { img, ts: Date.now() }] };
(async () => {
  const calls = [];
  const fetch = async (url, o) => {
    calls.push({ url, o });
    if (url.endsWith('/getUpdates')) return { ok: true, json: async () => ({ ok: true, result: [{ message: { chat: { id: 4711, type: 'private' }, text: '/start' } }] }) };
    return { ok: true, json: async () => ({ ok: true, result: {} }), text: async () => '' };
  };
  // ohne Chat-ID: nie an einen gefundenen (evtl. fremden) Chat senden, nur in der Übersicht anzeigen
  const U = createReports({ TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '', DISCORD_WEBHOOK_URL: '', BREVO_API_KEY: '', ADMIN_KEY: 'pw', fetch });
  const ru = await U.add(rep);
  assert(!ru.sent.length && /TELEGRAM_CHAT_ID/.test(ru.errors[0]) && !calls.length, 'ohne Chat-ID wird nichts gesendet');
  let page = ''; await U.page({ query: { key: 'pw' } }, { set() {}, status() { return this; }, send(x) { page = x; } });
  assert(/4711/.test(page) && calls[0].url.endsWith('/getUpdates') && !calls.some((c) => /send/.test(c.url)), 'Chat-ID wird nur angezeigt');
  calls.length = 0;
  const R = createReports({ TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '4711', DISCORD_WEBHOOK_URL: '', BREVO_API_KEY: '', ADMIN_KEY: '', fetch });
  const res = await R.add(rep);
  assert.deepStrictEqual(res.sent, ['Telegram'], 'über Telegram gesendet ' + JSON.stringify(res));
  const msg = JSON.parse(calls[0].o.body);
  assert(msg.chat_id === '4711' && /Ben/.test(msg.text) && /&lt;daneben&gt;/.test(msg.text), 'Text sicher (HTML maskiert)');
  assert(calls[1].url.endsWith('/sendMediaGroup') && calls[1].o.body instanceof FormData && calls[1].o.body.get('p1'), 'Bilder als Album');
  // Discord
  const dc = [];
  const D = createReports({ TELEGRAM_BOT_TOKEN: '', DISCORD_WEBHOOK_URL: 'https://discord.test/hook', BREVO_API_KEY: '', ADMIN_KEY: '', fetch: async (u, o) => { dc.push({ u, o }); return { ok: true }; } });
  const r2 = await D.add(rep);
  assert(r2.sent[0] === 'Discord' && dc[0].o.body.get('files[1]') && /Ben/.test(JSON.parse(dc[0].o.body.get('payload_json')).content), 'Discord mit Bildern');
  // Fehler werden gemeldet, nicht geworfen
  const F = createReports({ TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '1', DISCORD_WEBHOOK_URL: '', BREVO_API_KEY: '', ADMIN_KEY: '', fetch: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) }) });
  const r3 = await F.add(rep);
  assert(!r3.sent.length && /Unauthorized/.test(r3.errors[0]), 'Fehler sichtbar');
  // ohne Einrichtung: nur Log
  const N = createReports({ TELEGRAM_BOT_TOKEN: '', DISCORD_WEBHOOK_URL: '', BREVO_API_KEY: '', ADMIN_KEY: '', fetch: async () => { throw new Error('nicht aufrufen'); } });
  const log = console.log; console.log = () => {}; const r4 = await N.add(rep); console.log = log;
  assert(!r4.sent.length && !r4.errors.length, 'ohne Einrichtung nur Log');
  console.log('Meldungs-Tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
