// DartScan – Server: liefert die Website aus und verwaltet Online-Spiele, Turniere und gekoppelte Geräte per WebSocket
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createRooms } = require('./rooms.js');
const { createLinks } = require('./links.js');
const { createAuth } = require('./auth.js');
const { createReports } = require('./reports.js');

const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const app = express();

// ---------- Immer die neueste Version ausliefern ----------
// Jede Version bekommt eine Kennung (aus dem Inhalt der Dateien). Die Seite lädt ihre Dateien mit ?v=Kennung,
// damit kein Browser (v. a. Safari am iPhone) alte Dateien aus dem Zwischenspeicher nimmt. Unter /version fragt
// die Seite regelmäßig nach – gibt es eine neuere, lädt sie sich selbst neu.
const PUB = path.join(__dirname, 'public');
const VERSION = require('./package.json').version;
const BUILD = (() => {
  const h = crypto.createHash('sha1');
  for (const f of fs.readdirSync(PUB).sort()) { try { h.update(f); h.update(fs.readFileSync(path.join(PUB, f))); } catch (_) {} }
  return h.digest('hex').slice(0, 10);
})();
let indexHtml = null;
function sendIndex(_req, res) {
  if (!indexHtml) {
    indexHtml = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8')
      .replace(/(<script[^>]*\ssrc=")([^"?:]+\.js)(")/g, `$1$2?v=${BUILD}$3`)
      .replace(/(<link rel="stylesheet" href=")([^"?:]+\.css)(")/g, `$1$2?v=${BUILD}$3`)
      .replace('</head>', `  <meta name="ds-build" content="${BUILD}" />\n  <meta name="ds-version" content="${VERSION}" />\n</head>`);
  }
  res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Content-Type': 'text/html; charset=utf-8' }).send(indexHtml);
}
app.get(['/', '/index.html', '/index'], sendIndex);
app.get('/version', (_req, res) => res.set('Cache-Control', 'no-store').json({ v: BUILD, version: VERSION }));
app.use(express.static(PUB, {
  extensions: ['html'],
  setHeaders(res, p) { if (/\.(js|css|html|json)$/.test(p)) res.set('Cache-Control', 'no-cache'); },
}));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, tourns: tourns.size }));

// ---------- Natürliche Stimme (optional): Google Cloud Text-to-Speech ----------
// Auf Render unter "Environment" GOOGLE_TTS_KEY setzen (API-Schlüssel mit freigeschalteter Text-to-Speech-API).
// Optional TTS_VOICE, z. B. de-DE-Neural2-B (männlich) oder de-DE-Neural2-C (weiblich).
const TTS_KEY = process.env.GOOGLE_TTS_KEY || '';
const TTS_VOICE = process.env.TTS_VOICE || 'de-DE-Neural2-B';
const ttsCache = new Map(); // Text -> MP3 (Buffer); Dart-Ansagen wiederholen sich ständig
app.get('/tts/status', (_req, res) => res.json({ enabled: !!TTS_KEY, voice: TTS_KEY ? TTS_VOICE : '' }));
app.get('/tts', async (req, res) => {
  const text = String(req.query.t || '').trim();
  if (!TTS_KEY) return res.status(404).end();
  // nur kurze Ansagen (schützt den Schlüssel vor Missbrauch)
  if (!text || text.length > 60 || !/^[\p{L}\d !?,.:'’-]+$/u.test(text)) return res.status(400).end();
  try {
    let mp3 = ttsCache.get(text);
    if (!mp3) {
      const call = async (voice) => {
        const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(TTS_KEY), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: { text }, voice, audioConfig: { audioEncoding: 'MP3', speakingRate: 1.05 } }),
        });
        if (!r.ok) throw new Error('TTS ' + r.status + ' ' + (await r.text()).slice(0, 200));
        return Buffer.from((await r.json()).audioContent, 'base64');
      };
      try { mp3 = await call({ languageCode: 'de-DE', name: TTS_VOICE }); }
      catch (e) { console.warn(e.message, '– versuche Standardstimme'); mp3 = await call({ languageCode: 'de-DE' }); }
      ttsCache.set(text, mp3);
      if (ttsCache.size > 1500) ttsCache.delete(ttsCache.keys().next().value);
    }
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=604800' }).send(mp3);
  } catch (e) {
    console.error(e.message);
    res.status(502).end();
  }
});

// ---------- Meldungen (Fair Play): Nachricht per Telegram (oder Discord/Brevo) + Übersicht unter /admin/meldungen?key=ADMIN_KEY ----------
const reports = createReports();
app.get('/admin/meldungen', (req, res) => reports.page(req, res));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

const auth = createAuth();
const links = createLinks();
const { rooms, tourns, handle, detach, sweep, tick } = createRooms({
  onReport: (r) => reports.add(r),
  relayToLinks: (ws, msg) => links.relay(ws, msg),
});

wss.on('connection', (ws) => {
  ws.meta = {};
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'auth') {
      // Anmeldung prüfen (Firebase-ID-Token). Danach weiß der Server sicher, welches Konto spielt.
      try {
        const u = await auth.verify(m.token);
        ws.user = { uid: u.uid, name: String(m.name || u.name || '').slice(0, 24) };
        ws.send(JSON.stringify({ t: 'authok', uid: u.uid }));
      } catch (e) {
        ws.user = null;
        ws.send(JSON.stringify({ t: 'autherr', msg: e.message }));
      }
      return;
    }
    if (links.TYPES.has(m.t)) return links.handle(ws, m);
    handle(ws, m);
  });
  ws.on('close', () => { detach(ws); links.detach(ws); });
});

// Verbindungen prüfen, Turniere starten, Abwesende werten, alte Räume aufräumen
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  sweep();
  links.sweep();
}, 30000);
setInterval(tick, 2000);

server.listen(PORT, () => console.log(`DartScan läuft auf http://localhost:${PORT}`));
