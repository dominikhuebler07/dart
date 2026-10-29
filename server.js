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
