// Lernmodus-Logik
const assert = require('assert');
const L = require('../public/learn.js');
const T20 = { seg: 20, mult: 3 }, S20 = { seg: 20, mult: 1 }, M = { seg: 0, mult: 0 };
let s = L.create('a1');
for (let i = 0; i < 15; i++) { L.addDart(s, i < 11 ? S20 : M); if (s.st.curDone && !s.st.finished) L.next(s); }
assert(s.st.finished && s.st.passed && s.st.stars === 1, 'Scheibe treffen: 11/15 = 1 Stern');
s = L.create('a3');
for (let n = 1; n <= 10; n++) { L.addDart(s, { seg: n, mult: 1 }); if (s.st.curDone && !s.st.finished) L.next(s); }
assert(s.st.finished && s.st.stars === 3 && s.st.value === 10, 'Rund um die Uhr in 10 Pfeilen');
s = L.create('k3');
L.addDart(s, S20); L.addDart(s, { seg: 10, mult: 2 }); assert(s.st.curDone && s.st.results[0].out === 'ok', 'Checkout 40 über S20, D10');
L.next(s); L.addDart(s, { seg: 16, mult: 1 }); L.addDart(s, { seg: 17, mult: 1 }); assert(s.st.results[1].out === 'bust', 'Bust');
L.undo(s); L.addDart(s, { seg: 8, mult: 2 }); assert(s.st.results[1].out === 'ok', 'Korrigiert per Zurück');
s = L.create('p3');
const nine = [T20, T20, T20, T20, T20, T20, T20, { seg: 19, mult: 3 }, { seg: 12, mult: 2 }];
nine.forEach((d) => { L.addDart(s, d); if (s.st.curDone && !s.st.finished) L.next(s); });
assert(s.st.finished && s.st.passed && s.st.stars === 3 && s.st.value === 9, '9-Darter = 3 Sterne');
s = L.create('f2');
for (let r = 0; r < 10; r++) { L.addDart(s, T20); L.addDart(s, S20); L.addDart(s, M); if (!s.st.finished) L.next(s); }
assert(s.st.finished && s.st.value === 80 && s.st.stars === 3, 'Scoring Ø 80');
const prog = {};
assert(L.unlocked(prog, 'a1') && !L.unlocked(prog, 'a2'), 'nur erste Lektion offen');
L.record(prog, 'a1', { stars: 2, passed: true, value: 12 });
assert(L.unlocked(prog, 'a2') && L.level(prog) === 0, 'freigeschaltet');
// neue Übungen
const play = (id, darts) => { const x = L.create(id); darts.forEach((d) => { L.addDart(x, d); if (x.st.curDone && !x.st.finished) L.next(x); }); return x; };
const D = (n) => ({ seg: n, mult: 2 }), S = (n) => ({ seg: n, mult: 1 }), T = (n) => ({ seg: n, mult: 3 });
s = play('k5', [S(1), D(1), D(2), D(3), D(4), D(5), D(6), D(7), D(8), D(9), D(10)]);
assert(s.st.finished && s.st.passed && s.st.value === 11 && s.st.stars === 3, 'Doppel 1–10: Single zählt nicht');
s = play('f5', [S(1), D(1), T(1)]);
assert(s.st.finished && s.st.shanghai && s.st.stars === 3, 'Shanghai sofort gewonnen');
s = play('f5', [].concat(...[1, 2, 3, 4, 5, 6, 7].map((n) => [T(n), S(n), M])));
assert(s.st.finished && s.st.value === 112 && s.st.stars === 3, 'Shanghai 1–7 Punkte ' + s.st.value);
s = play('e5', [M, M, M]);
assert(!s.st.finished && s.st.info.score === 25, "Bob's 27: D1 verfehlt = 25");
s = play('e5', [M, M, M, M, M, M, M, M, M, M, M, M, M, M, M]);
assert(s.st.finished && s.st.dead && s.st.stars === 0, "Bob's 27: unter 0 vorbei");
s = play('e5', [].concat(...Array.from({ length: 20 }, (_, i) => [D(i + 1), M, M])));
assert(s.st.finished && !s.st.dead && s.st.value === 27 + 420 && s.st.stars === 3, "Bob's 27 alle Doppel " + s.st.value);
s = play('f6', [T(20), T(20), T(20), T(20), T(20), S(1)]);
assert(s.st.finished && s.st.passedRun && s.st.stars === 3, '301 Single-Out mit S1 beendet');
s = play('e4', [T(19), T(20), S(20)]);
assert(s.st.value === 2, 'T20 oder T19 zählen');
const mp = L.mergeProgress({ a1: { stars: 1, best: 11, tries: 2 }, a3: { stars: 2, best: 30, tries: 1 } }, { a1: { stars: 3, best: 14, tries: 1 }, a3: { stars: 1, best: 40, tries: 5 } });
assert(mp.a1.stars === 3 && mp.a1.best === 14 && mp.a3.best === 30 && mp.a3.tries === 5, 'Fortschritt zusammenführen');
const old = { a1: { stars: 1 }, a2: { stars: 1 }, a3: { stars: 2 } };
assert(L.unlocked(old, 'a3') && L.unlocked(old, 'a5') && L.unlocked(old, 'a6') && !L.unlocked(old, 'a7'), 'alter Fortschritt bleibt gültig');
assert(L.nextOpen(old).id === 'a5', 'nächste offene Lektion');
console.log('Lernmodus-Tests ok');

// „Hey DartScan“ als Aktivierungswort
const V = require('../public/voicecmd.js');
const w = (t) => V.parse(t, { direct: false });
for (const t of ['Hey DartScan, weiter', 'hey dart scan weiter', 'Hey Datenscanner weiter', 'hey darts kann weiter', 'Hey Dart Skän weiter', 'Dartcounter weiter']) {
  const r = w(t); assert(r.wake && r.commands[0] && r.commands[0].type === 'next', 'Wake: ' + t + ' -> ' + JSON.stringify(r));
}
let r = w('Hey DartScan, korrigiere 4 auf 18');
assert(r.wake && r.commands[0].type === 'correct' && r.commands[0].from.seg === 4 && r.commands[0].dart.seg === 18, 'Korrektur mit Hey DartScan');
r = w('Hey Datenscanner korrigiere auf Triple 20');
assert(r.commands[0].dart.mult === 3 && r.commands[0].index == null, 'letzter Pfeil auf T20');
r = w('hey dartscan'); assert(r.wake && !r.commands.length, 'nur Aktivierung');
for (const t of ['Triple 20', 'Hundertachtzig', 'Rest 40', 'das ist ein guter Wurf', 'Daten sammeln']) assert(!w(t).wake, 'kein Fehlalarm: ' + t);
console.log('Hey-DartScan-Tests ok');
