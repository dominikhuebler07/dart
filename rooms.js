// Raumverwaltung für Online-Spiele (unabhängig vom Transport, damit testbar)
const crypto = require('crypto');
const Game = require('./public/game.js');

function createRooms() {
  /** @type {Map<string, any>} */
  const rooms = new Map();
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function newCode() {
    let c;
    do {
      c = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
    } while (rooms.has(c));
    return c;
  }

  function cleanName(n) {
    return String(n || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'Spieler';
  }

  function send(ws, msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function view(room) {
    return {
      code: room.code,
      hostId: room.hostId,
      players: room.players.map((p) => ({ id: p.id, name: p.name, online: room.sockets.has(p.id) })),
      game: room.game,
    };
  }

  function broadcast(room) {
    const msg = { t: 'room', room: view(room) };
    for (const ws of room.sockets.values()) send(ws, msg);
  }

  function attach(ws, room, playerId) {
    const old = room.sockets.get(playerId);
    if (old && old !== ws) { old.meta = {}; try { old.close(); } catch (_) {} }
    room.sockets.set(playerId, ws);
    ws.meta = { code: room.code, id: playerId };
    room.lastActive = Date.now();
    send(ws, { t: 'joined', code: room.code, id: playerId });
    broadcast(room);
  }

  function addPlayer(ws, room, name) {
    const id = crypto.randomBytes(6).toString('hex');
    room.players.push({ id, name: cleanName(name) });
    if (!room.hostId) room.hostId = id;
    attach(ws, room, id);
  }

  function detach(ws) {
    const { code, id } = ws.meta || {};
    const room = code && rooms.get(code);
    if (!room || room.sockets.get(id) !== ws) return;
    room.sockets.delete(id);
    room.lastActive = Date.now();
    // Host weitergeben, wenn der Host offline ist
    if (room.hostId === id) {
      const other = room.players.find((p) => room.sockets.has(p.id));
      if (other) room.hostId = other.id;
    }
    // Im Wartebereich offline Spieler entfernen
    if (!room.game) room.players = room.players.filter((p) => room.sockets.has(p.id) || p.id === room.hostId);
    broadcast(room);
  }

  function handle(ws, m) {
    const { code, id } = ws.meta || {};
    const room = code ? rooms.get(code) : null;
    const err = (msg) => send(ws, { t: 'error', msg });
    const g = room && room.game;
    const isCurrent = g && g.players[g.current] && g.players[g.current].id === id;
    const changed = () => { room.lastActive = Date.now(); broadcast(room); };

    switch (m.t) {
      case 'ping':
        return send(ws, { t: 'pong' });

      case 'create': {
        if (room) detach(ws);
        const r = { code: newCode(), hostId: null, players: [], sockets: new Map(), game: null, lastActive: Date.now() };
        rooms.set(r.code, r);
        return addPlayer(ws, r, m.name);
      }

      case 'join': {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) return err('Raum nicht gefunden. Code prüfen.');
        if (r.game) return err('In diesem Raum läuft schon ein Spiel.');
        if (r.players.length >= 8) return err('Raum ist voll (max. 8 Spieler).');
        if (room) detach(ws);
        return addPlayer(ws, r, m.name);
      }

      case 'rejoin': {
        const r = rooms.get(String(m.code || '').toUpperCase());
        if (!r || !r.players.some((p) => p.id === m.id)) return send(ws, { t: 'gone' });
        return attach(ws, r, m.id);
      }

      case 'leave':
        if (room) {
          detach(ws);
          if (!room.game) room.players = room.players.filter((p) => p.id !== id);
          ws.meta = {};
          broadcast(room);
        }
        return;
    }

    if (!room) return err('Nicht verbunden.');

    switch (m.t) {
      case 'start':
        if (id !== room.hostId) return err('Nur der Host kann starten.');
        if (room.players.length < 1) return err('Keine Spieler.');
        room.game = Game.create(room.players, { startScore: m.startScore, doubleOut: m.doubleOut });
        return changed();
      case 'dart':
        if (!isCurrent) return err('Du bist nicht dran.');
        if (Game.addDart(g, m.dart)) changed();
        return;
      case 'set':
        if (!isCurrent) return err('Du bist nicht dran.');
        if (Game.setDart(g, Number(m.index), m.dart)) changed();
        return;
      case 'remove':
        if (!isCurrent) return err('Du bist nicht dran.');
        if (Game.removeDart(g, Number(m.index))) changed();
        return;
      case 'next':
        if (!isCurrent) return err('Du bist nicht dran.');
        if (Game.next(g)) changed();
        return;
      case 'undo':
        if (!g) return;
        if (!isCurrent && id !== room.hostId) return err('Nur der aktuelle Spieler oder der Host.');
        if (Game.undo(g)) changed();
        return;
      case 'rematch':
        if (id !== room.hostId) return err('Nur der Host kann eine Revanche starten.');
        if (g) room.game = Game.rematch(g);
        return changed();
      case 'lobby':
        if (id !== room.hostId) return err('Nur der Host.');
        room.game = null;
        return changed();
    }
  }

  function sweep(maxIdleMs = 30 * 60 * 1000) {
    const now = Date.now();
    for (const [c, r] of rooms) if (r.sockets.size === 0 && now - r.lastActive > maxIdleMs) rooms.delete(c);
  }

  return { rooms, handle, detach, sweep };
}

module.exports = { createRooms };
