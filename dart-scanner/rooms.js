// Raumverwaltung für Online-Spiele (unabhängig vom Transport, damit testbar)
const crypto = require('crypto');
const Game = require('./public/game.js');

function createRooms(opts = {}) {
  /** @type {Map<string, any>} */
  const rooms = new Map();
  /** @type {Map<string, any>} Turniere */
  const tourns = new Map();
  const later = opts.later || ((fn, ms) => setTimeout(fn, ms));
  const LEG_PAUSE = opts.legPause != null ? opts.legPause : 3500;
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function newCode() {
    let c;
    do {
      c = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
    } while (rooms.has(c) || tourns.has(c));
    return c;
  }

  function cleanName(n) {
    return String(n || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'Spieler';
  }

  function send(ws, msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function view(room) {
    const v = {
      code: room.code,
      hostId: room.hostId,
      players: room.players.map((p) => ({ id: p.id, name: p.name, online: room.sockets.has(p.id) })),
      game: room.game,
    };
    if (room.tourn) { v.tourn = room.tourn; v.matchId = room.matchId; v.legsToWin = room.legsToWin; }
    return v;
  }

  function broadcast(room) {
    const msg = { t: 'room', room: view(room) };
    for (const ws of room.sockets.values()) send(ws, msg);
    if (room.tourn) { const T = tourns.get(room.tourn); if (T) { syncMatch(T, room); broadcastT(T); } }
  }

  function attach(ws, room, playerId) {
    const old = room.sockets.get(playerId);
    if (old && old !== ws) {
      // gleiche Person, neue Verbindung: alte Verbindung nur aus diesem Raum lösen (Turnier-Zugehörigkeit bleibt)
      if (old.meta && old.meta.tcode && old.meta.tid === playerId) old.meta = { tcode: old.meta.tcode, tid: old.meta.tid };
      else { old.meta = {}; try { old.close(); } catch (_) {} }
    }
    room.sockets.set(playerId, ws);
    ws.meta = { tcode: ws.meta && ws.meta.tcode, tid: ws.meta && ws.meta.tid, code: room.code, id: playerId };
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
    detachRoom(ws);
    detachT(ws);
  }

  function detachRoom(ws) {
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

  // ================= Turniere (K.-o.-System) =================
  function tview(T) {
    return {
      code: T.code,
      hostId: T.hostId,
      status: T.status,
      opts: T.opts,
      champion: T.champion,
      players: T.players.map((p) => ({ id: p.id, name: p.name, online: T.sockets.has(p.id) })),
      rounds: T.rounds.map((r) => r.map((m) => ({
        id: m.id, a: m.a, b: m.b, winner: m.winner, status: m.status, legsA: m.legsA, legsB: m.legsB,
        live: m.live || null, room: m.room || null,
      }))),
    };
  }
  function broadcastT(T) {
    const msg = { t: 'tourn', tourn: tview(T) };
    for (const ws of T.sockets.values()) send(ws, msg);
  }
  function attachT(ws, T, pid) {
    const old = T.sockets.get(pid);
    if (old && old !== ws) { if (old.meta) { old.meta.tcode = null; old.meta.tid = null; } }
    T.sockets.set(pid, ws);
    ws.meta = Object.assign({}, ws.meta || {}, { tcode: T.code, tid: pid });
    T.lastActive = Date.now();
    send(ws, { t: 'tjoined', code: T.code, id: pid });
    broadcastT(T);
  }
  function detachT(ws) {
    const { tcode, tid } = ws.meta || {};
    const T = tcode && tourns.get(tcode);
    if (!T || T.sockets.get(tid) !== ws) return;
    T.sockets.delete(tid);
    T.lastActive = Date.now();
    if (T.status === 'lobby') {
      if (T.hostId === tid) { const other = T.players.find((p) => T.sockets.has(p.id)); if (other) T.hostId = other.id; }
      T.players = T.players.filter((p) => T.sockets.has(p.id) || p.id === T.hostId);
    } else if (T.hostId === tid) {
      const other = T.players.find((p) => T.sockets.has(p.id));
      if (other) T.hostId = other.id;
    }
    broadcastT(T);
  }
  const pname = (T, id) => (T.players.find((p) => p.id === id) || {}).name || '?';

  function buildBracket(T) {
    const ps = T.players.map((p) => p.id);
    for (let i = ps.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ps[i], ps[j]] = [ps[j], ps[i]]; }
    let size = 2;
    while (size < ps.length) size *= 2;
    const rounds = [];
    const first = [];
    for (let i = 0; i < size / 2; i++) first.push(mkMatch(0, i, ps[i] || null, ps[i + size / 2] || null));
    rounds.push(first);
    for (let r = 1, n = size / 4; n >= 1; r++, n /= 2) rounds.push(Array.from({ length: n }, (_, i) => mkMatch(r, i, null, null)));
    T.rounds = rounds;
  }
  function mkMatch(r, i, a, b) { return { id: `r${r}m${i}`, round: r, idx: i, a, b, winner: null, status: 'wait', legsA: 0, legsB: 0, room: null, live: null }; }

  function advance(T) {
    let changed = true;
    while (changed) {
      changed = false;
      T.rounds.forEach((round, r) => round.forEach((m) => {
        if (m.status === 'done' || m.status === 'bye' || m.status === 'live') return;
        if (r > 0) {
          const fa = T.rounds[r - 1][m.idx * 2], fb = T.rounds[r - 1][m.idx * 2 + 1];
          const wa = fa && (fa.status === 'done' || fa.status === 'bye') ? fa.winner : undefined;
          const wb = fb && (fb.status === 'done' || fb.status === 'bye') ? fb.winner : undefined;
          if (wa !== undefined && m.a !== wa) { m.a = wa; changed = true; }
          if (wb !== undefined && m.b !== wb) { m.b = wb; changed = true; }
          const decided = wa !== undefined && wb !== undefined;
          if (!decided) return;
          if (!m.a || !m.b) { m.winner = m.a || m.b; m.status = 'bye'; changed = true; return; }
        } else if (!m.a || !m.b) { m.winner = m.a || m.b; m.status = 'bye'; changed = true; return; }
        startMatch(T, m);
        changed = true;
      }));
    }
    const fin = T.rounds[T.rounds.length - 1][0];
    if (fin && (fin.status === 'done' || fin.status === 'bye') && T.status !== 'done') { T.status = 'done'; T.champion = fin.winner; }
  }

  function startMatch(T, m) {
    const players = [m.a, m.b].map((id) => ({ id, name: pname(T, id) }));
    const room = {
      code: newCode(), hostId: null, players, sockets: new Map(), lastActive: Date.now(),
      game: Game.create(players, { startScore: T.opts.startScore, doubleOut: T.opts.doubleOut }),
      tourn: T.code, matchId: m.id, legsToWin: T.opts.legs,
    };
    rooms.set(room.code, room);
    m.room = room.code; m.status = 'live';
    syncMatch(T, room);
    for (const pid of [m.a, m.b]) { const ws = T.sockets.get(pid); if (ws) attach(ws, room, pid); }
  }

  function findMatch(T, id) { for (const r of T.rounds) for (const m of r) if (m.id === id) return m; return null; }

  // Live-Stand eines Matches in den Turnierbaum übernehmen
  function syncMatch(T, room) {
    const m = findMatch(T, room.matchId);
    if (!m || !room.game) return;
    const g = room.game;
    const pa = g.players.find((p) => p.id === m.a), pb = g.players.find((p) => p.id === m.b);
    m.legsA = pa ? pa.legs : 0; m.legsB = pb ? pb.legs : 0;
    m.live = { a: pa ? pa.score : null, b: pb ? pb.score : null, turn: g.players[g.current] && g.players[g.current].id };
  }

  // Leg zu Ende? -> kurz feiern lassen, dann nächstes Leg oder Match beenden
  function checkLeg(room) {
    if (!room.tourn || !room.game) return;
    clearTimeout(room.legTimer);
    if (!room.game.finished) return;
    const gid = room.game.id;
    room.legTimer = later(() => {
      if (!rooms.has(room.code) || !room.game || room.game.id !== gid || !room.game.finished) return;
      const T = tourns.get(room.tourn);
      const g = room.game, w = g.players.find((p) => p.id === g.winner);
      if (w && w.legs + 1 >= room.legsToWin) return finishMatch(T, room, g.winner);
      room.game = Game.rematch(g);
      room.lastActive = Date.now();
      broadcast(room);
    }, LEG_PAUSE);
  }

  function finishMatch(T, room, winnerId) {
    const m = T && findMatch(T, room.matchId);
    if (room.game) {
      const g = room.game;
      const legs = (pid) => { const p = g.players.find((x) => x.id === pid); return p ? p.legs + (g.finished && g.winner === pid ? 1 : 0) : 0; };
      if (m) { m.legsA = legs(m.a); m.legsB = legs(m.b); }
    }
    clearTimeout(room.legTimer);
    rooms.delete(room.code);
    for (const [pid, ws] of room.sockets) {
      if (ws.meta) { ws.meta.code = null; ws.meta.id = null; }
      send(ws, { t: 'tmatchdone', won: pid === winnerId, winner: winnerId, winnerName: T ? pname(T, winnerId) : '' });
    }
    if (!T || !m) return;
    m.winner = winnerId; m.status = 'done'; m.room = null; m.live = null;
    advance(T);
    T.lastActive = Date.now();
    broadcastT(T);
  }

  function handleT(ws, m) {
    const { tcode, tid } = ws.meta || {};
    const T = tcode ? tourns.get(tcode) : null;
    const err = (msg) => send(ws, { t: 'error', msg });
    switch (m.t) {
      case 'tcreate': {
        if (T) detachT(ws);
        const legs = [1, 2, 3].includes(Number(m.legs)) ? Number(m.legs) : 1;
        const startScore = [301, 501, 701].includes(Number(m.startScore)) ? Number(m.startScore) : 501;
        const nt = { code: newCode(), hostId: null, players: [], sockets: new Map(), status: 'lobby', rounds: [], champion: null,
          opts: { startScore, doubleOut: m.doubleOut !== false, legs }, lastActive: Date.now() };
        tourns.set(nt.code, nt);
        const id = crypto.randomBytes(6).toString('hex');
        nt.players.push({ id, name: cleanName(m.name) });
        nt.hostId = id;
        return attachT(ws, nt, id);
      }
      case 'tjoin': {
        const nt = tourns.get(String(m.code || '').toUpperCase().trim());
        if (!nt) return err('Turnier nicht gefunden. Code prüfen.');
        if (nt.status !== 'lobby') return err('Dieses Turnier hat schon begonnen.');
        if (nt.players.length >= 16) return err('Turnier ist voll (max. 16 Spieler).');
        if (T && T !== nt) detachT(ws);
        const id = crypto.randomBytes(6).toString('hex');
        nt.players.push({ id, name: cleanName(m.name) });
        return attachT(ws, nt, id);
      }
      case 'trejoin': {
        const nt = tourns.get(String(m.code || '').toUpperCase());
        if (!nt || !nt.players.some((p) => p.id === m.id)) return send(ws, { t: 'tgone' });
        attachT(ws, nt, m.id);
        // läuft gerade ein Match dieses Spielers? -> direkt wieder rein
        for (const r of nt.rounds) for (const mt of r) {
          if (mt.status === 'live' && (mt.a === m.id || mt.b === m.id)) { const room = rooms.get(mt.room); if (room) attach(ws, room, m.id); }
        }
        return;
      }
      case 'tleave': {
        if (!T) return;
        T.sockets.delete(tid);
        if (T.status === 'lobby') T.players = T.players.filter((p) => p.id !== tid);
        if (T.hostId === tid) { const other = T.players.find((p) => p.id !== tid && T.sockets.has(p.id)); if (other) T.hostId = other.id; }
        ws.meta = Object.assign({}, ws.meta, { tcode: null, tid: null });
        if (!T.players.length || (T.status === 'lobby' && !T.sockets.size)) tourns.delete(T.code); else broadcastT(T);
        return;
      }
      case 'tstart': {
        if (!T) return err('Nicht verbunden.');
        if (tid !== T.hostId) return err('Nur der Turnierleiter kann starten.');
        if (T.status !== 'lobby') return;
        if (T.players.length < 2) return err('Mindestens 2 Spieler nötig.');
        T.status = 'running';
        buildBracket(T);
        advance(T);
        return broadcastT(T);
      }
      case 'twalkover': {
        if (!T) return err('Nicht verbunden.');
        if (tid !== T.hostId) return err('Nur der Turnierleiter.');
        const mt = findMatch(T, m.match);
        if (!mt || mt.status !== 'live' || (m.winner !== mt.a && m.winner !== mt.b)) return err('Match nicht gefunden.');
        const room = rooms.get(mt.room);
        if (room) return finishMatch(T, room, m.winner);
        mt.winner = m.winner; mt.status = 'done'; mt.room = null;
        advance(T);
        return broadcastT(T);
      }
    }
  }

  function handle(ws, m) {
    const { code, id } = ws.meta || {};
    const room = code ? rooms.get(code) : null;
    const err = (msg) => send(ws, { t: 'error', msg });
    const g = room && room.game;
    const isCurrent = g && g.players[g.current] && g.players[g.current].id === id;
    const changed = () => { room.lastActive = Date.now(); broadcast(room); checkLeg(room); };

    if (m.t[0] === 't' && ['tcreate', 'tjoin', 'trejoin', 'tleave', 'tstart', 'twalkover'].includes(m.t)) return handleT(ws, m);

    switch (m.t) {
      case 'ping':
        return send(ws, { t: 'pong' });

      case 'create': {
        if (room) detachRoom(ws);
        const r = { code: newCode(), hostId: null, players: [], sockets: new Map(), game: null, lastActive: Date.now() };
        rooms.set(r.code, r);
        return addPlayer(ws, r, m.name);
      }

      case 'join': {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) return err('Raum nicht gefunden. Code prüfen.');
        if (r.game) return err('In diesem Raum läuft schon ein Spiel.');
        if (r.players.length >= 8) return err('Raum ist voll (max. 8 Spieler).');
        if (r.tourn) return err('Das ist ein Turnier-Match.');
        if (room) detachRoom(ws);
        return addPlayer(ws, r, m.name);
      }

      case 'rejoin': {
        const r = rooms.get(String(m.code || '').toUpperCase());
        if (!r || !r.players.some((p) => p.id === m.id)) return send(ws, { t: 'gone' });
        return attach(ws, r, m.id);
      }

      case 'leave':
        if (room && room.tourn) { detachRoom(ws); ws.meta.code = null; ws.meta.id = null; return; }
        if (room) {
          detachRoom(ws);
          if (!room.game) room.players = room.players.filter((p) => p.id !== id);
          ws.meta = { tcode: ws.meta.tcode, tid: ws.meta.tid };
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
      case 'correct': {
      if (!g) return;
      const prevIdx = (g.current - 1 + g.players.length) % g.players.length;
      const allowed = isCurrent || id === room.hostId || (!g.turn.darts.length && g.players[prevIdx].id === id);
      if (!allowed) return err('Du darfst diesen Pfeil nicht ändern.');
      if (Game.correct(g, m.index == null ? null : Number(m.index), m.dart)) changed();
      return;
    }
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
    for (const [c, r] of rooms) if (r.sockets.size === 0 && now - r.lastActive > maxIdleMs && !(r.tourn && tourns.has(r.tourn))) rooms.delete(c);
    for (const [c, T] of tourns) if (T.sockets.size === 0 && now - T.lastActive > maxIdleMs * 4) {
      for (const r of T.rounds) for (const mt of r) if (mt.room) rooms.delete(mt.room);
      tourns.delete(c);
    }
  }

  return { rooms, tourns, handle, detach, sweep };
}

module.exports = { createRooms };
