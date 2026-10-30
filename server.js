// DartScan – Server: liefert die Website aus und verwaltet Online-Räume per WebSocket
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createRooms } = require('./rooms.js');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

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

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const { rooms, handle, detach, sweep } = createRooms();

wss.on('connection', (ws) => {
  ws.meta = {};
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (m && typeof m.t === 'string') handle(ws, m);
  });
  ws.on('close', () => detach(ws));
});

// Verbindungen prüfen + leere Räume nach 30 Min. löschen
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  sweep();
}, 30000);

server.listen(PORT, () => console.log(`DartScan läuft auf http://localhost:${PORT}`));
