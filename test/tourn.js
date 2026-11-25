// Online gegen Fremde: öffentliche Turniere, Zufallsgegner, Aufgabe bei Abwesenheit, Kamerabild, Melden, Geräte koppeln
const assert = require('assert');
const { createRooms } = require('../rooms.js');
const { createLinks } = require('../links.js');
let clock = 1e6;
const timers = [];
const reports = [];
const opts = { later: (fn) => { timers.push(fn); return timers.length; }, legPause: 0, now: () => clock, startDelay: 10e3, offlineForfeit: 60e3, turnTimeout: 120e3, onReport: (r) => reports.push(r) };
const flush = () => { while (timers.length) timers.shift()(); };
let uidN = 0;
const sock = (n, uid) => ({ n, readyState: 1, meta: {}, msgs: [], user: { uid: uid || 'u' + ++uidN, name: n }, send(s) { this.msgs.push(JSON.parse(s)); }, close() { this.readyState = 3; },
  last(t) { return [...this.msgs].reverse().find((m) => m.t === t); } });

// ---------- öffentliches Turnier ----------
{
  const R = createRooms(opts);
  const anon = sock('Gast'); anon.user = null;
  R.handle(anon, { t: 'tjoin', fmt: 'cup' });
  assert(anon.last('needauth'), 'Turnier nur mit Konto');
  const S = Array.from({ length: 5 }, (_, i) => sock('P' + i));
  S.forEach((s) => R.handle(s, { t: 'tjoin', fmt: 'cup' }));
  let T = S[0].last('tourn').tourn;
  assert(T.players.length === 5 && T.status === 'lobby' && T.size === 8, 'Warteraum mit 5 von 8');
  R.handle(S[4], { t: 'tlist' });
  assert(S[4].last('tlist').list.find((f) => f.fmt === 'cup').waiting === 5, 'Turnierliste zeigt Wartende');
  // selbes Konto auf zweitem Gerät landet nicht doppelt im Turnier
  const dup = sock('P0b', S[0].user.uid); R.handle(dup, { t: 'tjoin', fmt: 'cup' });
  assert(dup.last('tourn').tourn.players.length === 5, 'kein Doppel-Eintrag');
  S[0] = dup; // das neuere Gerät übernimmt
  clock += 5 * 60e3 + 1; R.tick();
  assert(S[0].last('tourn').tourn.status === 'starting', 'nach Wartezeit: Countdown');
  clock += 10e3 + 1; R.tick();
  T = S[0].last('tourn').tourn;
  assert(T.status === 'running' && T.rounds.length === 3, 'Turnier läuft (8er-Baum)');
  const byId = {}; S.forEach((s) => { byId[s.last('tjoined').id] = s; });

  const roomOf = (code) => { for (const s of Object.values(byId)) { const r = s.last('room'); if (r && r.room.code === code) return r.room; } return null; };
  function playLeg(code) {
    const act = (msg) => { const g = roomOf(code).game; R.handle(byId[g.players[g.current].id], msg); };
    const darts = (ds) => ds.forEach((d) => act({ t: 'dart', dart: d }));
    darts([{ seg: 20, mult: 3 }, { seg: 20, mult: 3 }, { seg: 20, mult: 3 }]); act({ t: 'next' }); // 321
    darts([{ seg: 1, mult: 1 }, { seg: 1, mult: 1 }, { seg: 1, mult: 1 }]); act({ t: 'next' });
    darts([{ seg: 20, mult: 3 }, { seg: 20, mult: 3 }, { seg: 20, mult: 3 }]); act({ t: 'next' }); // 141
    darts([{ seg: 1, mult: 1 }, { seg: 1, mult: 1 }, { seg: 1, mult: 1 }]); act({ t: 'next' });
    darts([{ seg: 20, mult: 3 }, { seg: 19, mult: 3 }, { seg: 12, mult: 2 }]); // 141 = T20 T19 D12
    return roomOf(code).game;
  }
  let guard = 0;
  while (S[0].last('tourn').tourn.status !== 'done' && guard++ < 30) {
    T = S[0].last('tourn').tourn;
    const live = T.rounds.flat().filter((m) => m.status === 'live');
    assert(live.length, 'kein Live-Match');
    for (const m of live) { if (!roomOf(m.room)) continue; const g = playLeg(m.room); assert(g.finished, 'Leg beendet'); flush(); }
  }
  T = S[0].last('tourn').tourn;
  assert(T.status === 'done' && T.champion, 'Turnier fertig, Sieger ' + (T.players.find((p) => p.id === T.champion) || {}).name);
  assert(T.rounds.flat().every((m) => m.status === 'done' || m.status === 'bye'), 'alle Matches entschieden');
}

// ---------- Aufgabe: offline zu lange / Zeit abgelaufen ----------
{
  const R = createRooms(opts);
  const S = Array.from({ length: 4 }, (_, i) => sock('Q' + i));
  S.forEach((s) => R.handle(s, { t: 'tjoin', fmt: 'blitz' }));
  assert(S[0].last('tourn').tourn.status === 'starting', 'voll: Countdown startet sofort');
  clock += 10e3 + 1; R.tick();
  const T = S[0].last('tourn').tourn;
  const m = T.rounds[0][0];
  const sa = S.find((s) => s.last('tjoined').id === m.a), sb = S.find((s) => s.last('tjoined').id === m.b);
  R.detach(sb);
  clock += 30e3; R.tick();
  assert(sa.last('room').room.game && !sa.last('tmatchdone'), 'noch keine Aufgabe nach 30 s');
  clock += 31e3; R.tick();
  assert(sa.last('tmatchdone') && sa.last('tmatchdone').won, 'nach 60 s offline: Gegner gewinnt');
  const W = S.find((s) => s !== sb); // verbundener Zuschauer
  clock += 121e3; R.tick();
  const done2 = W.last('tourn').tourn.rounds[0][1];
  assert(done2.status === 'done', 'Zeit abgelaufen: Match entschieden');
  // wer aufgibt (Turnier verlassen), verliert
  const T3 = W.last('tourn').tourn;
  const fin = T3.rounds[1][0];
  assert(fin.status === 'live', 'Finale läuft');
  const quitter = S.find((s) => s.last('tjoined').id === fin.a);
  R.handle(quitter, { t: 'tleave' });
  const T4 = S.find((s) => s !== quitter && s.last('tjoined').id === fin.b).last('tourn').tourn;
  assert(T4.status === 'done' && T4.champion === fin.b, 'Aufgabe im Finale');
}

// ---------- Zufallsgegner ----------
{
  const R = createRooms(opts);
  const A = sock('Anna'), A2 = sock('Anna2', A.user.uid), B = sock('Ben');
  R.handle(A, { t: 'quick', startScore: 501 });
  assert(A.last('queued'), 'in der Warteschlange');
  R.handle(A2, { t: 'quick', startScore: 501 });
  assert(!A2.last('room'), 'nicht gegen sich selbst');
  R.handle(A2, { t: 'quickcancel' });
  R.handle(B, { t: 'quick', startScore: 501 });
  const room = A.last('room').room;
  assert(room.kind === 'quick' && room.game && room.game.startScore === 501 && B.last('room').room.code === room.code, 'Spiel startet sofort');
  // Fremde dürfen keine Pfeile des Gegners ändern
  const cur = room.game.players[room.game.current].id;
  const curS = A.last('joined').id === cur ? A : B, other = curS === A ? B : A;
  R.handle(curS, { t: 'dart', dart: { seg: 20, mult: 1 } });
  R.handle(other, { t: 'correct', index: 0, dart: { seg: 20, mult: 3 } });
  assert(/nicht ändern/.test(other.last('error').msg), 'keine Korrektur fremder Pfeile');
  // Kamerabild wird an den Gegner weitergereicht
  const img = 'data:image/jpeg;base64,' + 'A'.repeat(200);
  R.handle(curS, { t: 'frame', img, dart: 'S20' });
  assert(other.last('frame') && other.last('frame').img === img, 'Gegner sieht das Kamerabild');
  assert(other.last('room').room.players.find((p) => p.id === cur).cam, 'Kamera als aktiv angezeigt');
  R.handle(curS, { t: 'frame', img: 'data:text/html,<script>' });
  assert(other.msgs.filter((m) => m.t === 'frame').length === 1, 'nur JPEG-Bilder');
  // Melden
  R.handle(other, { t: 'report', target: cur, reason: 'Wurf falsch', text: 'war daneben' });
  assert(reports.length === 1 && reports[0].frames.length === 1 && reports[0].target.uid === curS.user.uid && reports[0].log.length === 2, 'Meldung mit Bildern und Verlauf');
  R.handle(other, { t: 'report', target: cur, reason: 'nochmal' });
  assert(reports.length === 1 && other.last('reported').again, 'nur einmal pro Spiel melden');
  // Wiederverbinden nur mit dem eigenen Konto
  const pid = A.last('joined').id;
  R.detach(A);
  const evil = sock('Evil'); R.handle(evil, { t: 'rejoin', code: room.code, id: pid });
  assert(evil.last('gone'), 'fremdes Konto kann nicht übernehmen');
  const A3 = sock('Anna3', A.user.uid); R.handle(A3, { t: 'rejoin', code: room.code, id: pid });
  assert(A3.last('room').room.code === room.code, 'eigenes Konto kann wieder rein');
  // Aufgeben (Raum verlassen) = Niederlage
  R.handle(A3, { t: 'leave' });
  const fr = B.last('room').room;
  assert(fr.forfeit && fr.game.finished && fr.game.winner === B.last('joined').id, 'Verlassen = Aufgabe');
}

// ---------- Freunde (Raum-Code) brauchen ein Konto ----------
{
  const R = createRooms(opts);
  const g = sock('Gast'); g.user = null;
  R.handle(g, { t: 'create', name: 'Gast' });
  assert(g.last('needauth') && !g.last('room'), 'Raum nur mit Konto');
}

// ---------- Geräte koppeln ----------
{
  const L = createLinks({ now: () => clock });
  const tv = sock('TV'), phone = sock('Handy'), cam = sock('Cam2');
  L.handle(tv, { t: 'linknew', role: 'display' });
  const code = tv.last('linkcode').code;
  assert(/^[A-Z2-9]{5}$/.test(code), 'Code für den Bildschirm');
  L.handle(phone, { t: 'linkjoin', code: code.toLowerCase() });
  assert(phone.last('linkok') && tv.last('linked'), 'gekoppelt');
  L.handle(phone, { t: 'show', state: { a: 1 } });
  assert(tv.last('show').state.a === 1, 'Spielstand am Bildschirm');
  L.relay(phone, { t: 'frame', from: 'me', img: 'x' });
  assert(tv.last('frame'), 'Kamerabild am Bildschirm');
  L.handle(cam, { t: 'linknew', role: 'cam2' });
  L.handle(phone, { t: 'linkjoin', code: cam.last('linkcode').code });
  assert(phone.last('links').devices.length === 2, 'zwei Geräte gekoppelt');
  L.handle(phone, { t: 'cam2ctl', phase: 'throw', key: 'k1' });
  assert(cam.last('cam2ctl').phase === 'throw' && !tv.last('cam2ctl'), 'Steuerung nur an die 2. Kamera');
  L.handle(cam, { t: 'cam2dart', dart: { x: 1, y: -100 }, key: 'k1' });
  assert(phone.last('cam2dart').dart.y === -100, 'Treffer der 2. Kamera kommt an');
  // Laptop korrigiert einen Wurf -> geht ans Handy, nur gültige Pfeile, die 2. Kamera darf das nicht
  L.handle(tv, { t: 'dispcmd', cmd: { kind: 'correct', which: 'cur', index: 1, dart: { seg: 20, mult: 3 } } });
  const dc = phone.last('dispcmd');
  assert(dc && dc.cmd.kind === 'correct' && dc.cmd.index === 1 && dc.cmd.dart.seg === 20 && dc.cmd.dart.mult === 3, 'Korrektur vom Bildschirm kommt am Handy an');
  phone.msgs = phone.msgs.filter((x) => x.t !== 'dispcmd');
  L.handle(tv, { t: 'dispcmd', cmd: { kind: 'add', dart: { seg: 21, mult: 1 } } });
  L.handle(tv, { t: 'dispcmd', cmd: { kind: 'hack' } });
  L.handle(cam, { t: 'dispcmd', cmd: { kind: 'next' } });
  assert(!phone.last('dispcmd'), 'ungültige Befehle und Befehle der 2. Kamera werden verworfen');
  L.handle(tv, { t: 'dispcmd', cmd: { kind: 'next' } });
  assert(phone.last('dispcmd').cmd.kind === 'next', 'Weiter vom Bildschirm');
  // Bildschirm verliert die Verbindung und kommt wieder
  const tok = tv.last('linkcode').token;
  tv.readyState = 3; L.detach(tv);
  const tv2 = sock('TV2'); L.handle(tv2, { t: 'linkresume', token: tok });
  assert(tv2.last('linked') && tv2.last('show').state.a === 1, 'Bildschirm verbindet sich wieder');
  // Handy verliert die Verbindung und kommt wieder
  const ctok = phone.last('linkok').ctlToken;
  const phone2 = sock('Handy2'); L.handle(phone2, { t: 'linkresume', token: ctok });
  L.handle(phone2, { t: 'show', state: { a: 2 } });
  assert(tv2.last('show').state.a === 2, 'Handy verbindet sich wieder');
  L.handle(phone2, { t: 'linkjoin', code: 'ZZZZZ' });
  assert(/nicht gefunden/.test(phone2.last('error').msg), 'falscher Code');
}
console.log('Turnier-/Online-/Kopplungs-Tests ok');
