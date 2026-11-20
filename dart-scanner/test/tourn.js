const assert = require('assert');
const { createRooms } = require('../rooms.js');
const timers = [];
const R = createRooms({ later: (fn) => { timers.push(fn); return timers.length; }, legPause: 0 });
const flush = () => { while (timers.length) timers.shift()(); };
const sock = (n) => ({ n, readyState: 1, meta: {}, msgs: [], send(s) { this.msgs.push(JSON.parse(s)); }, close() { this.readyState = 3; },
  last(t) { return [...this.msgs].reverse().find((m) => m.t === t); } });
const S = Array.from({ length: 5 }, (_, i) => sock('P' + i));
R.handle(S[0], { t: 'tcreate', name: 'Domi', startScore: 301, legs: 2 });
const code = S[0].last('tjoined').code;
for (let i = 1; i < 5; i++) R.handle(S[i], { t: 'tjoin', code, name: 'Sp' + i });
assert(S[0].last('tourn').tourn.players.length === 5);
R.handle(S[1], { t: 'tstart' }); assert(/Turnierleiter/.test(S[1].last('error').msg));
R.handle(S[0], { t: 'tstart' });
let T = S[0].last('tourn').tourn;
console.log('Runden', T.rounds.map((r) => r.map((m) => m.status).join(',')).join(' | '));
assert(T.rounds.length === 3 && T.rounds[0].length === 4);
// Wer ist im Match?
const byId = {}; S.forEach((s) => { byId[s.last('tjoined').id] = s; });
function playMatch(room, winnerFirst) {
  // Spieler am Zug wirft 301 runter: T20 T20 T20 (180) -> 121; nächste: T20 T11 D14 (60+33+28=121)
  const g = () => [...Object.values(byId)].map((s) => s.last('room')).filter(Boolean).map((m) => m.room).find((r) => r.code === room)?.game;
  const act = (msg) => { const gm = g(); const cur = gm.players[gm.current].id; R.handle(byId[cur], msg); };
  const throwDarts = (ds) => ds.forEach((d) => act({ t: 'dart', dart: d }));
  throwDarts([{ seg: 20, mult: 3 }, { seg: 20, mult: 3 }, { seg: 20, mult: 3 }]); act({ t: 'next' });
  throwDarts([{ seg: 1, mult: 1 }, { seg: 1, mult: 1 }, { seg: 1, mult: 1 }]); act({ t: 'next' });
  throwDarts([{ seg: 20, mult: 3 }, { seg: 11, mult: 3 }, { seg: 14, mult: 2 }]);
  return g();
}
let guard = 0;
while (S[0].last('tourn').tourn.status !== 'done' && guard++ < 20) {
  T = S[0].last('tourn').tourn;
  const live = T.rounds.flat().filter((m) => m.status === 'live');
  assert(live.length, 'kein Live-Match ' + JSON.stringify(T.rounds));
  for (const m of live) {
    const gm = playMatch(m.room); assert(gm.finished, 'Leg beendet');
    flush();
  }
}
T = S[0].last('tourn').tourn;
assert(T.status === 'done' && T.champion, 'Turnier fertig');
console.log('Sieger', T.players.find((p) => p.id === T.champion).name, 'Runden', T.rounds.map((r) => r.map((m) => `${m.legsA}:${m.legsB}`).join(',')).join(' | '));
// Walkover + rejoin Test
const R2 = createRooms({ later: (fn) => { timers.push(fn); }, legPause: 0 });
const A = sock('A'), B = sock('B');
R2.handle(A, { t: 'tcreate', name: 'A' }); const c2 = A.last('tjoined').code; R2.handle(B, { t: 'tjoin', code: c2, name: 'B' });
R2.handle(A, { t: 'tstart' });
const bid = B.last('tjoined').id; R2.detach(B);
const t2 = A.last('tourn').tourn; assert(!t2.players.find((p) => p.id === bid).online, 'offline');
const B2 = sock('B2'); R2.handle(B2, { t: 'trejoin', code: c2, id: bid }); assert(B2.last('room') && B2.last('room').room.tourn === c2, 'rejoin ins Match');
R2.handle(A, { t: 'twalkover', match: t2.rounds[0][0].id, winner: A.last('tjoined').id });
assert(A.last('tourn').tourn.status === 'done' && B2.last('tmatchdone'), 'walkover');
console.log('Turnier-Tests ok');
