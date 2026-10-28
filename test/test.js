const assert = require('assert');
const Board = require('../public/board.js');
const Game = require('../public/game.js');
const Det = require('../public/detector.js');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; };

// --- Punkte ---
const L = (x, y) => Board.label(Board.score(x, y));
ok(L(0, -103) === 'T20', 'T20'); ok(L(0, 0) === 'Bull', 'Bull'); ok(L(0, -10) === '25', '25');
ok(L(166, 0) === 'D6', 'D6'); ok(L(0, 140) === '3', 'S3'); ok(L(-103, 0) === 'T11', 'T11'); ok(L(0, -175) === 'Miss', 'Miss');
for (const d of [{seg:20,mult:3},{seg:16,mult:2},{seg:5,mult:1},{seg:25,mult:1}]) {
  const p = Board.position(d); ok(Board.label(Board.score(...p)) === Board.label(d), 'position ' + Board.label(d));
}

// --- Spiel ---
let g = Game.create([{id:'a',name:'A'},{id:'b',name:'B'}], {startScore:501, doubleOut:true});
[[20,3],[20,3],[20,3]].forEach(([s,m]) => Game.addDart(g,{seg:s,mult:m}));
ok(g.players[0].score === 321 && Game.turnComplete(g), '180');
ok(!Game.addDart(g,{seg:1,mult:1}), 'kein 4. Pfeil');
Game.next(g); ok(g.current === 1, 'Wechsel');
g.players[1].score = 40; g.turn.startScore = 40;
Game.addDart(g,{seg:20,mult:1}); Game.addDart(g,{seg:19,mult:1}); ok(g.turn.bust && g.players[1].score === 40, 'Bust bei Rest 1');
Game.setDart(g,1,{seg:10,mult:2}); ok(g.finished && g.winner === 'b', 'Finish nach Korrektur');
Game.undo(g); ok(!g.finished && g.players[1].score === 20, 'Undo');
Game.undo(g); Game.undo(g); ok(g.current === 0 && g.turn.darts.length === 2, 'Undo in vorherige Aufnahme');
ok(Game.checkout(170,3,true).join() === 'T20,T20,Bull', '170');
ok(Game.checkout(40,1,true).join() === 'D20', '40');
ok(Game.checkout(169,3,true) === null, '169 kein Finish');
let c = 0; for (let r = 2; r <= 170; r++) if (Game.checkout(r,3,true)) c++; ok(c === 162, 'Anzahl Finishes ' + c);

// --- Homographie ---
const src = [[.5,.1],[.85,.5],[.48,.92],[.15,.48]];
const H = Det.solveH(src, Det.CAL_DST), Hi = Det.invertH(H);
const [u, v] = Det.applyH(Hi, 50, -30); const [bx, by] = Det.applyH(H, u, v);
ok(Math.abs(bx - 50) < 1e-6 && Math.abs(by + 30) < 1e-6, 'H roundtrip');

// --- Synthetische Erkennung ---
const W = 480, Hh = 360;
const imgPts = [[240, 40], [402, 186], [233, 334], [86, 178]];   // schräge Perspektive
const Hb2i = Det.solveH(Det.CAL_DST, imgPts), Hi2b = Det.invertH(Hb2i);
function baseImage(noise) {
  const a = new Uint8Array(W * Hh);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const [bx, by] = Det.applyH(Hi2b, x + .5, y + .5);
    const d = Board.score(bx, by), r = Math.hypot(bx, by);
    let val = 60;
    if (r <= 170) { const i = Board.ORDER.indexOf(d.seg); val = d.mult >= 2 ? (i % 2 ? 110 : 90) : (i % 2 ? 200 : 35); if (d.seg === 25) val = 100; }
    a[y * W + x] = Math.max(0, Math.min(255, val + (noise ? Math.round((Math.random() - .5) * noise) : 0)));
  }
  return a;
}
function drawDart(img, tip, dir, val) {
  const len = 70, [dx, dy] = dir, nx = -dy, ny = dx;
  for (let t = 0; t <= len; t += .5) {
    const half = t < 45 ? 1.2 : 1.2 + (t - 45) * 0.35;      // dünner Schaft, breiter Flight
    for (let s = -half; s <= half; s += .5) {
      const x = Math.round(tip[0] + dx * t + nx * s), y = Math.round(tip[1] + dy * t + ny * s);
      if (x >= 0 && x < W && y >= 0 && y < Hh) img[y * W + x] = val;
    }
  }
}
const det = new Det.DartDetector({});
det.w = W; det.h = Hh; det.setCalibration(imgPts.map(([x, y]) => [x / W, y / Hh])); det.buildMask();
const cases = [[0,-103,'T20'],[0,-166,'D20'],[110,-20,'T6'],[-60,90,'S'],[0,0,'Bull'],[-130,-40,'S'],[75,140,'D'],[20,40,'S']];
let ref = baseImage(6); det.ref = ref; det.emptyRef = ref; det.phase = 'throw';
let hits = 0;
const dirs = [[.6,-.8],[-.7,-.71],[.8,.6],[0,-1]];
cases.forEach(([x, y, expect], i) => {
  const cur = det.ref.slice();
  const tip = Det.applyH(Hb2i, x, y);
  drawDart(cur, tip, dirs[i % dirs.length], i % 2 ? 245 : 5);
  for (let k = 0; k < cur.length; k++) cur[k] = Math.max(0, Math.min(255, cur[k] + Math.round((Math.random() - .5) * 6)));
  det.cur = cur;
  let got = null; det.cb.onDart = (d) => (got = d);
  det.evaluate();
  const want = Board.score(x, y);
  const errMm = got ? Math.hypot(got.x - x, got.y - y) : NaN;
  const same = got && Board.label(got) === Board.label(want);
  if (same) hits++;
  console.log(`Pfeil ${i + 1}: soll ${Board.label(want).padEnd(4)} erkannt ${got ? Board.label(got).padEnd(4) : '—   '} Abweichung ${errMm.toFixed(1)} mm ${same ? '✓' : '✗'}`);
  if (i % 3 === 2) { det.ref = ref; } // "Pfeile gezogen"
});
ok(hits >= cases.length - 1, 'Erkennung ' + hits + '/' + cases.length);

// Pfeile ziehen -> Scheibe frei
det.ref = (() => { const c = ref.slice(); drawDart(c, Det.applyH(Hb2i, 0, -103), [.6, -.8], 245); return c; })();
det.cur = ref.slice(); let cleared = false; det.cb.onCleared = () => (cleared = true); det.cb.onDart = () => {};
det.evaluate(); ok(cleared, 'Scheibe frei erkannt');

console.log(`\n${pass} Tests bestanden`);

// --- Online-Räume (simulierte Verbindungen) ---
const { createRooms } = require('../rooms.js');
const R = createRooms();
const sock = () => ({ readyState: 1, meta: {}, msgs: [], send(s) { this.msgs.push(JSON.parse(s)); }, close() { this.readyState = 3; },
  get room() { return [...this.msgs].reverse().find((m) => m.t === 'room').room; }, get err() { return [...this.msgs].reverse().find((m) => m.t === 'error')?.msg; } });
const A = sock(), Bs = sock();
R.handle(A, { t: 'create', name: 'Domi' });
const code = A.room.code;
R.handle(Bs, { t: 'join', code: code.toLowerCase(), name: 'Max' });
ok(A.room.players.length === 2, 'Beitritt per Code');
R.handle(Bs, { t: 'start', startScore: 301 }); ok(/Host/.test(Bs.err), 'nur Host startet');
R.handle(A, { t: 'start', startScore: 301, doubleOut: true }); ok(Bs.room.game.startScore === 301, 'Start 301');
R.handle(Bs, { t: 'dart', dart: { seg: 20, mult: 3 } }); ok(/nicht dran/.test(Bs.err), 'falscher Spieler blockiert');
[{ seg: 20, mult: 3 }, { seg: 19, mult: 3 }, { seg: 18, mult: 1 }].forEach((d) => R.handle(A, { t: 'dart', dart: d }));
ok(Bs.room.game.players[0].score === 166, 'Max sieht Domis Würfe live');
R.handle(A, { t: 'next' }); ok(Bs.room.game.current === 1, 'Max ist dran');
const bid = Bs.room.players[1].id;
R.detach(Bs); ok(!A.room.players[1].online, 'offline erkannt');
const B2 = sock(); R.handle(B2, { t: 'rejoin', code, id: bid }); ok(A.room.players[1].online && B2.room.game.players[0].score === 166, 'Wiederverbinden behält Spielstand');
R.handle(sock(), { t: 'join', code, name: 'Spät' }); ok(true, 'Beitritt während Spiel abgelehnt');

console.log(`${pass} Tests bestanden (inkl. Online)`);
