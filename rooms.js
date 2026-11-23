// Online-Logik (unabhängig vom Transport, damit testbar):
//  - Räume mit Freunden (Code), schnelles Spiel gegen Zufallsgegner, öffentliche Turniere gegen Fremde
//  - Live-Kamerabild der Scheibe an die Gegner weiterreichen (Fair Play) und Melden
// Wer online spielt, braucht ein Konto: ws.user = { uid, name } wird vom Server nach der Anmeldeprüfung gesetzt.
const crypto = require('crypto');
const Game = require('./public/game.js');

// Öffentliche Turnier-Formate (gegen Fremde). Start, sobald voll – oder nach maxWait mit mindestens minPlayers.
const FORMATS = {
  blitz: { id: 'blitz', title: 'Blitz-Turnier', size: 4, minPlayers: 3, startScore: 301, doubleOut: true, legs: 1, maxWait: 3 * 60e3 },
  cup: { id: 'cup', title: '501-Cup', size: 8, minPlayers: 4, startScore: 501, doubleOut: true, legs: 2, maxWait: 5 * 60e3 },
  masters: { id: 'masters', title: 'Masters', size: 16, minPlayers: 6, startScore: 501, doubleOut: true, legs: 2, maxWait: 8 * 60e3 },
};
const QUICK = [301, 501];

function createRooms(opts = {}) {
  /** @type {Map<string, any>} */
  const rooms = new Map();
  /** @type {Map<string, any>} Turniere */
  const tourns = new Map();
  const queues = new Map(QUICK.map((s) => [s, []])); // Zufallsgegner: Warteschlange je Modus
  const later = opts.later || ((fn, ms) => setTimeout(fn, ms));
  const now = opts.now || (() => Date.now());
  const LEG_PAUSE = opts.legPause != null ? opts.legPause : 3500;
  const START_DELAY = opts.startDelay != null ? opts.startDelay : 10e3;     // Countdown vor Turnierbeginn
  const OFFLINE_FORFEIT = opts.offlineForfeit != null ? opts.offlineForfeit : 75e3; // so lange offline = Aufgabe
  const TURN_TIMEOUT = opts.turnTimeout != null ? opts.turnTimeout : 150e3;  // so lange am Zug ohne Wurf = Aufgabe
  const onReport = opts.onReport || (() => {});
  const relayToLinks = opts.relayToLinks || (() => {}); // gekoppelte Bildschirme des Absenders
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function newCode() {
    let c;
    do {
      c = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
    } while (rooms.has(c) || tourns.has(c));
    return c;
  }
  const newId = () => crypto.randomBytes(6).toString('hex');

  function cleanName(n) {
    return String(n || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Spieler';
  }
  const nameFor = (ws, m) => cleanName((m && m.name) || (ws.user && ws.user.name));

  function send(ws, msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  // ================= Räume =================
  function view(room) {
    const v = {
      code: room.code,
      kind: room.kind,
      hostId: room.hostId,
      players: room.players.map((p) => ({ id: p.id, name: p.name, online: room.sockets.has(p.id), cam: !!(room.lastFrame && now() - (room.lastFrame.get(p.id) || 0) < 8000) })),
      game: room.game,
      forfeit: room.forfeit || null,
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
    if (room.offline) room.offline.delete(playerId);
    ws.meta = { tcode: ws.meta && ws.meta.tcode, tid: ws.meta && ws.meta.tid, code: room.code, id: playerId };
    room.lastActive = now();
    send(ws, { t: 'joined', code: room.code, id: playerId, kind: room.kind });
    broadcast(room);
  }

  function mkRoom(kind, extra = {}) {
    const r = { code: newCode(), kind, hostId: null, players: [], sockets: new Map(), game: null, lastActive: now(), offline: new Map(), frames: new Map(), lastFrame: new Map(), reported: new Set(), ...extra };
    rooms.set(r.code, r);
    return r;
  }

  function addPlayer(ws, room, name) {
    const id = newId();
    room.players.push({ id, name: cleanName(name), uid: ws.user && ws.user.uid });
    if (!room.hostId) room.hostId = id;
    attach(ws, room, id);
  }

  function detach(ws) {
    leaveQueue(ws);
    detachRoom(ws);
    detachT(ws);
  }

  function detachRoom(ws) {
    const { code, id } = ws.meta || {};
    const room = code && rooms.get(code);
    if (!room || room.sockets.get(id) !== ws) return;
    room.sockets.delete(id);
    room.offline.set(id, now());
    room.lastActive = now();
    // Host weitergeben, wenn der Host offline ist
    if (room.hostId === id) {
      const other = room.players.find((p) => room.sockets.has(p.id));
      if (other) room.hostId = other.id;
    }
    // Im Wartebereich offline Spieler entfernen
    if (!room.game) room.players = room.players.filter((p) => room.sockets.has(p.id) || p.id === room.hostId);
    broadcast(room);
  }

  // Spieler gibt auf / ist zu lange weg: Gegner gewinnt (Zufallsgegner- und Turnier-Spiele)
  function forfeit(room, loserId, why) {
    if (!room.game || room.forfeit) return;
    const winner = room.players.find((p) => p.id !== loserId);
    if (!winner) return;
    if (room.tourn) {
      const T = tourns.get(room.tourn);
      for (const ws of room.sockets.values()) send(ws, { t: 'forfeit', winner: winner.id, loser: loserId, why });
      return finishMatch(T, room, winner.id);
    }
    room.forfeit = { winner: winner.id, loser: loserId, why };
    room.game.finished = true;
    room.game.winner = winner.id;
    room.lastActive = now();
    broadcast(room);
  }

  // ================= Zufallsgegner (1 gegen 1) =================
  function leaveQueue(ws) {
    for (const q of queues.values()) {
      const i = q.findIndex((e) => e.ws === ws);
      if (i >= 0) q.splice(i, 1);
    }
  }
  function queueJoin(ws, m) {
    const startScore = QUICK.includes(Number(m.startScore)) ? Number(m.startScore) : 501;
    leaveQueue(ws);
    const q = queues.get(startScore);
    // nicht gegen sich selbst (zweites Gerät mit demselben Konto)
    const i = q.findIndex((e) => e.ws.readyState === 1 && e.uid !== ws.user.uid);
    if (i < 0) {
      q.push({ ws, uid: ws.user.uid, name: nameFor(ws, m), since: now() });
      return send(ws, { t: 'queued', startScore, waiting: q.length });
    }
    const opp = q.splice(i, 1)[0];
    const me = { ws, uid: ws.user.uid, name: nameFor(ws, m) };
    const room = mkRoom('quick');
    for (const e of [opp, me]) { e.pid = newId(); room.players.push({ id: e.pid, name: e.name, uid: e.uid }); }
    room.hostId = room.players[0].id;
    if (crypto.randomInt(2)) room.players.reverse(); // wer anfängt, entscheidet der Zufall
    room.game = Game.create(room.players, { startScore, doubleOut: true });
    room.turnSince = now();
    for (const e of [opp, me]) attachQuiet(e.ws, room, e.pid);
    broadcast(room);
  }
  function attachQuiet(ws, room, pid) {
    room.sockets.set(pid, ws);
    ws.meta = { tcode: ws.meta && ws.meta.tcode, tid: ws.meta && ws.meta.tid, code: room.code, id: pid };
    send(ws, { t: 'joined', code: room.code, id: pid, kind: room.kind });
  }

  // ================= Öffentliche Turniere (K.-o.-System, ohne Turnierleiter) =================
  function tview(T) {
    return {
      code: T.code,
      fmt: T.fmt,
      title: T.title,
      size: T.size,
      status: T.status,
      startsAt: T.startsAt || null,
      waitUntil: T.waitUntil || null,
      opts: T.opts,
      champion: T.champion,
      players: T.players.map((p) => ({ id: p.id, name: p.name, online: T.sockets.has(p.id), out: !!p.out })),
      rounds: T.rounds.map((r) => r.map((m) => ({
        id: m.id, a: m.a, b: m.b, winner: m.winner, status: m.status, legsA: m.legsA, legsB: m.legsB,
        live: m.live || null, room: m.room || null, walk: m.walk || null,
      }))),
    };
  }
  function broadcastT(T) {
    const msg = { t: 'tourn', tourn: tview(T) };
    for (const ws of T.sockets.values()) send(ws, msg);
  }
  function tlist() {
    return Object.values(FORMATS).map((F) => {
      const open = [...tourns.values()].find((T) => T.fmt === F.id && (T.status === 'lobby' || T.status === 'starting'));
      const running = [...tourns.values()].filter((T) => T.fmt === F.id && T.status === 'running').length;
      return { fmt: F.id, title: F.title, size: F.size, minPlayers: F.minPlayers, startScore: F.startScore, legs: F.legs, doubleOut: F.doubleOut,
        waiting: open ? open.players.length : 0, startsAt: open ? open.startsAt || null : null, waitUntil: open ? open.waitUntil || null : null, running };
    });
  }
  function attachT(ws, T, pid) {
    const old = T.sockets.get(pid);
    if (old && old !== ws) { if (old.meta) { old.meta.tcode = null; old.meta.tid = null; } }
    T.sockets.set(pid, ws);
    ws.meta = Object.assign({}, ws.meta || {}, { tcode: T.code, tid: pid });
    T.lastActive = now();
    send(ws, { t: 'tjoined', code: T.code, id: pid });
    broadcastT(T);
  }
  function detachT(ws) {
    const { tcode, tid } = ws.meta || {};
    const T = tcode && tourns.get(tcode);
    if (!T || T.sockets.get(tid) !== ws) return;
    T.sockets.delete(tid);
    T.lastActive = now();
    if (T.status === 'lobby' || T.status === 'starting') {
      T.players = T.players.filter((p) => T.sockets.has(p.id));
      lobbyChanged(T);
    }
    broadcastT(T);
  }
  const pname = (T, id) => (T.players.find((p) => p.id === id) || {}).name || '?';

  function lobbyChanged(T) {
    if (T.status !== 'lobby' && T.status !== 'starting') return;
    if (!T.players.length) { tourns.delete(T.code); return; }
    if (T.players.length >= T.size) {
      if (T.status !== 'starting') { T.status = 'starting'; T.startsAt = now() + START_DELAY; }
    } else if (T.status === 'starting' && !(T.waitUntil && now() >= T.waitUntil && T.players.length >= T.minPlayers)) {
      T.status = 'lobby'; T.startsAt = null;
    }
  }

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

  function startTourn(T) {
    T.status = 'running';
    T.startsAt = null;
    buildBracket(T);
    advance(T);
    broadcastT(T);
  }

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
        // wer das Turnier schon verlassen hat, verliert kampflos
        const outA = T.players.find((p) => p.id === m.a).out, outB = T.players.find((p) => p.id === m.b).out;
        if (outA || outB) { m.winner = outA && outB ? m.a : outA ? m.b : m.a; m.status = 'done'; m.walk = 'Aufgabe'; changed = true; return; }
        startMatch(T, m);
        changed = true;
      }));
    }
    const fin = T.rounds[T.rounds.length - 1][0];
    if (fin && (fin.status === 'done' || fin.status === 'bye') && T.status !== 'done') {
      T.status = 'done'; T.champion = fin.winner; T.lastActive = now();
      opts.onChampion && opts.onChampion(T, T.players.find((p) => p.id === T.champion));
    }
  }

  function startMatch(T, m) {
    const players = [m.a, m.b].map((id) => { const p = T.players.find((x) => x.id === id); return { id, name: p.name, uid: p.uid }; });
    if (crypto.randomInt(2)) players.reverse(); // Anwurf auslosen
    const room = mkRoom('tourn', { tourn: T.code, matchId: m.id, legsToWin: T.opts.legs });
    room.players = players;
    room.game = Game.create(players, { startScore: T.opts.startScore, doubleOut: T.opts.doubleOut });
    room.turnSince = now();
    // Wer gerade nicht verbunden ist, gilt ab jetzt als offline (Uhr für die Aufgabe läuft)
    for (const p of players) if (!T.sockets.has(p.id)) room.offline.set(p.id, now());
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
      room.turnSince = now();
      room.lastActive = now();
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
    const loser = m.a === winnerId ? m.b : m.a;
    const lp = T.players.find((p) => p.id === loser); if (lp) lp.out = true;
    advance(T);
    T.lastActive = now();
    broadcastT(T);
  }

  function handleT(ws, m) {
    const { tcode, tid } = ws.meta || {};
    const T = tcode ? tourns.get(tcode) : null;
    const err = (msg) => send(ws, { t: 'error', msg });
    switch (m.t) {
      case 'tlist':
        return send(ws, { t: 'tlist', list: tlist() });
      case 'tjoin': {
        if (!ws.user) return send(ws, { t: 'needauth' });
        const F = FORMATS[m.fmt];
        if (!F) return err('Turnier nicht gefunden.');
        if (T && T.status !== 'done') {
          if (T.fmt === m.fmt) return attachT(ws, T, tid);
          return err('Du bist schon in einem Turnier. Verlass es zuerst.');
        }
        if (T) detachT(ws);
        // schon in diesem Format angemeldet (anderes Gerät)? -> übernehmen
        for (const X of tourns.values()) {
          if (X.status === 'done') continue;
          const p = X.players.find((pp) => pp.uid === ws.user.uid && !pp.out);
          if (p) return attachT(ws, X, p.id);
        }
        let open = [...tourns.values()].find((X) => X.fmt === F.id && (X.status === 'lobby' || X.status === 'starting') && X.players.length < X.size);
        if (!open) {
          open = { code: newCode(), fmt: F.id, title: F.title, size: F.size, minPlayers: F.minPlayers, players: [], sockets: new Map(), status: 'lobby',
            rounds: [], champion: null, opts: { startScore: F.startScore, doubleOut: F.doubleOut, legs: F.legs }, lastActive: now(), created: now(), waitUntil: now() + F.maxWait };
          tourns.set(open.code, open);
        }
        const id = newId();
        open.players.push({ id, name: nameFor(ws, m), uid: ws.user.uid });
        lobbyChanged(open);
        return attachT(ws, open, id);
      }
      case 'trejoin': {
        const nt = tourns.get(String(m.code || '').toUpperCase());
        const p = nt && nt.players.find((x) => x.id === m.id);
        if (!p || (p.uid && (!ws.user || ws.user.uid !== p.uid))) return send(ws, { t: 'tgone' });
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
        ws.meta = Object.assign({}, ws.meta, { tcode: null, tid: null });
        if (T.status === 'lobby' || T.status === 'starting') {
          T.players = T.players.filter((p) => p.id !== tid);
          lobbyChanged(T);
        } else if (T.status === 'running') {
          // Aufgabe: laufendes Match verloren, künftige kampflos
          const p = T.players.find((x) => x.id === tid);
          if (p && !p.out) {
            p.out = true;
            for (const r of T.rounds) for (const mt of r) {
              if (mt.status === 'live' && (mt.a === tid || mt.b === tid)) { const room = rooms.get(mt.room); if (room) { if (room.sockets.get(tid) === ws) room.sockets.delete(tid); forfeit(room, tid, 'Aufgabe'); } }
            }
            advance(T);
          }
        }
        if (tourns.has(T.code)) broadcastT(T);
        return;
      }
    }
  }

  // ================= Kamerabild (Fair Play) =================
  const MAX_FRAME = 120e3; // Zeichen (Data-URL), ~90 KB Bild
  function frame(ws, m) {
    const img = String(m.img || '');
    if (!img.startsWith('data:image/jpeg;base64,') || img.length > MAX_FRAME) return;
    const t = now();
    if (ws.lastFrameAt && t - ws.lastFrameAt < 280) return; // höchstens ~3 Bilder pro Sekunde
    ws.lastFrameAt = t;
    const f = { img, ts: t, dart: m.dart ? String(m.dart).slice(0, 8) : null };
    relayToLinks(ws, { t: 'frame', from: 'me', img, dart: f.dart });
    const { code, id } = ws.meta || {};
    const room = code && rooms.get(code);
    if (!room || room.sockets.get(id) !== ws) return;
    const list = room.frames.get(id) || [];
    list.push(f);
    // fürs Melden: die letzten Bilder, Würfe mit Treffer bevorzugt behalten
    while (list.length > 10) { const k = list.findIndex((x) => !x.dart); list.splice(k >= 0 && k < list.length - 2 ? k : 0, 1); }
    room.frames.set(id, list);
    const wasCam = room.lastFrame.has(id) && t - room.lastFrame.get(id) < 8000;
    room.lastFrame.set(id, t);
    const msg = { t: 'frame', from: id, img, dart: f.dart };
    for (const [pid, s] of room.sockets) if (pid !== id) send(s, msg);
    if (!wasCam) broadcast(room); // „Kamera an“ bei den anderen anzeigen
  }

  function report(ws, room, m) {
    if (!ws.user) return send(ws, { t: 'needauth' });
    const me = room.players.find((p) => p.id === ws.meta.id);
    const target = room.players.find((p) => p.id === m.target);
    if (!me || !target || target.id === me.id) return send(ws, { t: 'error', msg: 'Spieler nicht gefunden.' });
    const key = me.id + '>' + target.id;
    if (room.reported.has(key)) return send(ws, { t: 'reported', again: true });
    room.reported.add(key);
    const g = room.game;
    const log = g ? g.players.map((p) => ({
      name: p.name, score: p.score,
      turns: [...p.history, ...(g.players[g.current] === p ? [{ darts: g.turn.darts, open: true }] : [])].slice(-12)
        .map((h) => h.darts.map((d) => `${d.label || lbl(d)}${d.auto ? '' : ' (von Hand)'}`).join(', ') + (h.bust ? ' – Bust' : '')),
    })) : [];
    const rep = {
      id: newId(), at: new Date(now()).toISOString(), room: room.code, kind: room.kind, tourn: room.tourn || null,
      reason: String(m.reason || '').slice(0, 60), text: String(m.text || '').slice(0, 600),
      reporter: { uid: ws.user.uid, name: me.name }, target: { uid: target.uid || null, name: target.name },
      targetCam: !!(room.lastFrame.get(target.id) && now() - room.lastFrame.get(target.id) < 15000),
      log, frames: (room.frames.get(target.id) || []).slice(-6),
    };
    onReport(rep);
    send(ws, { t: 'reported', id: rep.id });
  }
  const lbl = (d) => (!d || !d.seg ? 'Miss' : d.seg === 25 ? (d.mult === 2 ? 'Bull' : '25') : (d.mult === 3 ? 'T' : d.mult === 2 ? 'D' : '') + d.seg);

  // ================= Nachrichten =================
  function handle(ws, m) {
    const { code, id } = ws.meta || {};
    const room = code ? rooms.get(code) : null;
    const err = (msg) => send(ws, { t: 'error', msg });
    const g = room && room.game;
    const isCurrent = g && g.players[g.current] && g.players[g.current].id === id;
    const changed = () => { room.lastActive = now(); if (isCurrent) room.turnSince = now(); broadcast(room); checkLeg(room); };
    const needAuth = () => { send(ws, { t: 'needauth' }); };

    if (m.t[0] === 't' && ['tlist', 'tjoin', 'trejoin', 'tleave'].includes(m.t)) return handleT(ws, m);

    switch (m.t) {
      case 'ping':
        return send(ws, { t: 'pong' });

      case 'create': {
        if (!ws.user) return needAuth();
        if (room) detachRoom(ws);
        leaveQueue(ws);
        const r = mkRoom('friends');
        return addPlayer(ws, r, nameFor(ws, m));
      }

      case 'join': {
        if (!ws.user) return needAuth();
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r || r.kind !== 'friends') return err('Raum nicht gefunden. Code prüfen.');
        if (r.game) return err('In diesem Raum läuft schon ein Spiel.');
        if (r.players.length >= 8) return err('Raum ist voll (max. 8 Spieler).');
        if (room) detachRoom(ws);
        leaveQueue(ws);
        return addPlayer(ws, r, nameFor(ws, m));
      }

      case 'rejoin': {
        const r = rooms.get(String(m.code || '').toUpperCase());
        const p = r && r.players.find((x) => x.id === m.id);
        if (!p || (p.uid && (!ws.user || ws.user.uid !== p.uid))) return send(ws, { t: 'gone' });
        return attach(ws, r, m.id);
      }

      case 'quick':
        if (!ws.user) return needAuth();
        if (room) { detachRoom(ws); ws.meta = { tcode: ws.meta.tcode, tid: ws.meta.tid }; }
        return queueJoin(ws, m);

      case 'quickcancel':
        leaveQueue(ws);
        return send(ws, { t: 'unqueued' });

      case 'leave':
        leaveQueue(ws);
        if (room && room.tourn) { detachRoom(ws); ws.meta.code = null; ws.meta.id = null; return; }
        if (room) {
          const running = room.game && !room.game.finished && !room.forfeit;
          detachRoom(ws);
          if (!room.game) room.players = room.players.filter((p) => p.id !== id);
          ws.meta = { tcode: ws.meta.tcode, tid: ws.meta.tid };
          if (room.kind === 'quick' && running) forfeit(room, id, 'Aufgabe');
          else broadcast(room);
        }
        return;

      case 'frame':
        return frame(ws, m);
    }

    if (!room) return err('Nicht verbunden.');

    switch (m.t) {
      case 'report':
        return report(ws, room, m);
      case 'start':
        if (room.kind !== 'friends') return;
        if (id !== room.hostId) return err('Nur der Host kann starten.');
        if (room.players.length < 1) return err('Keine Spieler.');
        room.game = Game.create(room.players, { startScore: m.startScore, doubleOut: m.doubleOut });
        room.forfeit = null; room.turnSince = now();
        return changed();
      case 'dart':
        if (!isCurrent || room.forfeit) return err('Du bist nicht dran.');
        if (Game.addDart(g, m.dart)) changed();
        return;
      case 'set':
        if (!isCurrent || room.forfeit) return err('Du bist nicht dran.');
        if (Game.setDart(g, Number(m.index), m.dart)) changed();
        return;
      case 'remove':
        if (!isCurrent || room.forfeit) return err('Du bist nicht dran.');
        if (Game.removeDart(g, Number(m.index))) changed();
        return;
      case 'correct': {
        if (!g || room.forfeit) return;
        const prevIdx = (g.current - 1 + g.players.length) % g.players.length;
        // Fremde: nur eigene Pfeile. Freunde: zusätzlich der Host.
        const host = room.kind === 'friends' && id === room.hostId;
        const allowed = isCurrent || host || (!g.turn.darts.length && g.players[prevIdx].id === id);
        if (!allowed) return err('Du darfst diesen Pfeil nicht ändern.');
        if (Game.correct(g, m.index == null ? null : Number(m.index), m.dart)) changed();
        return;
      }
      case 'next':
        if (!isCurrent || room.forfeit) return err('Du bist nicht dran.');
        if (Game.next(g)) { room.turnSince = now(); changed(); }
        return;
      case 'undo':
        if (!g || room.forfeit) return;
        if (!isCurrent && !(room.kind === 'friends' && id === room.hostId)) return err('Nur der aktuelle Spieler' + (room.kind === 'friends' ? ' oder der Host.' : '.'));
        if (Game.undo(g)) changed();
        return;
      case 'rematch':
        if (room.kind === 'tourn') return;
        if (room.kind === 'quick') {
          // Revanche gegen Fremde: beide müssen zustimmen
          room.rematchVotes = room.rematchVotes || new Set();
          room.rematchVotes.add(id);
          if (room.rematchVotes.size < room.players.length || room.players.some((p) => !room.sockets.has(p.id))) {
            for (const [pid, s] of room.sockets) send(s, { t: 'rematchvote', from: id, mine: pid === id });
            return;
          }
          room.rematchVotes = null;
        } else if (id !== room.hostId) return err('Nur der Host kann eine Revanche starten.');
        if (g) room.game = Game.rematch(g);
        room.forfeit = null; room.turnSince = now();
        return changed();
      case 'lobby':
        if (room.kind !== 'friends') return;
        if (id !== room.hostId) return err('Nur der Host.');
        room.game = null; room.forfeit = null;
        return changed();
    }
  }

  // Regelmäßig aufrufen (alle paar Sekunden): Turniere starten, Aufgaben bei Abwesenheit
  function tick() {
    const t = now();
    for (const T of [...tourns.values()]) {
      if (T.status === 'lobby' && T.waitUntil && t >= T.waitUntil && T.players.length >= T.minPlayers) { T.status = 'starting'; T.startsAt = t + START_DELAY; broadcastT(T); }
      if (T.status === 'starting' && T.startsAt && t >= T.startsAt) startTourn(T);
      // niemand mehr da: Wartezeit verlängern statt mit 1 Spieler ewig zu warten
      if (T.status === 'lobby' && T.waitUntil && t >= T.waitUntil && T.players.length < T.minPlayers) T.waitUntil = t + 60e3;
    }
    for (const room of [...rooms.values()]) {
      if (!room.game || room.game.finished || room.forfeit || room.kind === 'friends') continue;
      for (const p of room.players) {
        const off = room.offline.get(p.id);
        if (!room.sockets.has(p.id) && off && t - off > OFFLINE_FORFEIT) { forfeit(room, p.id, 'Verbindung weg'); break; }
      }
      if (!rooms.has(room.code) || room.forfeit || room.game.finished) continue;
      const cur = room.game.players[room.game.current];
      if (cur && room.turnSince && t - room.turnSince > TURN_TIMEOUT) forfeit(room, cur.id, 'Zeit abgelaufen');
    }
  }

  function sweep(maxIdleMs = 30 * 60 * 1000) {
    const t = now();
    for (const [c, r] of rooms) if (r.sockets.size === 0 && t - r.lastActive > maxIdleMs && !(r.tourn && tourns.has(r.tourn))) rooms.delete(c);
    for (const [c, T] of tourns) {
      const idle = T.sockets.size === 0 && t - T.lastActive > maxIdleMs * 4;
      const oldDone = T.status === 'done' && t - T.lastActive > maxIdleMs;
      if (idle || oldDone) {
        for (const r of T.rounds) for (const mt of r) if (mt.room) rooms.delete(mt.room);
        tourns.delete(c);
      }
    }
  }

  return { rooms, tourns, queues, handle, detach, sweep, tick, tlist, FORMATS };
}

module.exports = { createRooms, FORMATS };
