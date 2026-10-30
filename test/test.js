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
const det = new Det.DartDetector({}); det.autoTrack = false;
det.w = W; det.h = Hh; det.setCalibration(imgPts.map(([x, y]) => [x / W, y / Hh])); det.buildMask();
const cases = [[0,-103,'T20'],[0,-166,'D20'],[110,-20,'T6'],[-60,90,'S'],[0,0,'Bull'],[-130,-40,'S'],[75,140,'D'],[20,40,'S']];
const refImg = baseImage(6); const ref = Det.makeRef(refImg, W, Hh); det.ref = ref; det.emptyRef = ref; det.phase = 'throw';
let hits = 0;
const dirs = [[.6,-.8],[-.7,-.71],[.8,.6],[0,-1]];
cases.forEach(([x, y, expect], i) => {
  const cur = det.ref.img.slice();
  const tip = Det.applyH(Hb2i, x, y);
  drawDart(cur, tip, require('./synth.js').dirFor(imgPts, W, Hh, x, y, dirs[i % dirs.length]), i % 2 ? 245 : 5);
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
det.ref = Det.makeRef((() => { const c = refImg.slice(); drawDart(c, Det.applyH(Hb2i, 0, -103), [.6, -.8], 245); return c; })(), W, Hh);
det.cur = refImg.slice(); let cleared = false; det.cb.onCleared = () => (cleared = true); det.cb.onDart = () => {};
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

// --- Automatische Kalibrierung + Verrutschen während des Spiels (echte Kamera, 3D-Pfeile) ---
{
  const { render, camera, drawDart3D } = require('./synth.js');
  const W2 = 800, H2 = 450, POS = [300, 250, -520];
  const camA = camera({ w: W2, h: H2, f: 550, pos: POS });
  function scenario(name, slip, jolt) {
    const camB = camera({ w: W2, h: H2, f: 550, pos: POS.map((v, i) => v + (slip.pos ? slip.pos[i] : 0)), look: slip.look });
    const base = { A: render(W2, H2, camA.imgPts), B: render(W2, H2, camB.imgPts) };
    const frame = (k, darts) => { const cam = k === 'A' ? camA : camB; const f = new Uint8ClampedArray(base[k].rgba); darts.forEach((d) => drawDart3D(f, cam, d[0], d[1], d[2])); return f; };
    const D1 = [0, -103, { flight: 235 }], D2 = [...Board.polar(130, 198), { flight: 60, point: 200 }], D3 = [...Board.polar(140, 18), { flight: 235, barrel: 90 }];
    const seq = jolt ? [['A', []], ['B', [D1]], ['B', [D1, D2]], ['B', [D1, D2, D3]], ['B', []]]
      : [['A', []], ['A', [D1]], ['B', [D1]], ['B', [D1, D2]], ['B', [D1, D2, D3]], ['B', []]];
    const det = new Det.DartDetector({});
    let cur = null;
    det.w = W2; det.h = H2; det.cur = new Uint8Array(W2 * H2); det.tmp = new Uint8Array(W2 * H2);
    det.ensureSize = () => true;
    det.grab = () => { det.rgba = cur; det.toGray(cur); };
    cur = base.A.rgba;
    det.grab();
    const auto = det.autoCalibrate();
    ok(auto && auto.quality > 0.3, name + ': Scheibe automatisch gefunden');
    det.setCalibration(auto.pts);
    det.phase = 'throw';
    const got = []; let cleared = 0, realigned = 0;
    det.cb = { onDart: (d) => got.push(Board.label(d)), onCleared: () => cleared++, onRealign: () => realigned++ };
    for (const [k, darts] of seq) {
      cur = frame(k, darts);
      for (let t = 0; t < 6; t++) det.tick();
      if (got.length === 3 && det.phase === 'throw') det.phase = 'pull';
    }
    const want = [D1, D2, D3].map((d) => Board.label(Board.score(d[0], d[1])));
    const shiftPx = Math.max(...camA.imgPts.map((p, i) => Math.hypot(p[0] - camB.imgPts[i][0], p[1] - camB.imgPts[i][1])));
    console.log(`${name.padEnd(26)} (${shiftPx.toFixed(1)} px) erkannt: ${got.join(', ')}  (soll ${want.join(', ')})  nachgeführt: ${realigned}x  Scheibe frei: ${cleared}x`);
    ok(got.join() === want.join(), name + ': Pfeile trotz Verrutschen richtig');
    ok(cleared === 1, name + ': Ziehen erkannt');
  }
  scenario('Hauch verrutscht', { look: [1.5, -1, 0] });
  scenario('Leicht verrutscht+gekippt', { look: [14, 9, 0], pos: [0, -20, 0] });
  scenario('Stark verrutscht', { look: [-45, 20, 0], pos: [30, 0, 10] });
  scenario('Einschlag stößt Handy an', { look: [9, 6, 0] }, true);
}
console.log(`${pass} Tests bestanden (alles)`);

// --- Realistische Handy-Positionen mit 3D-Pfeilen (Spitze, Barrel, Schaft, Flight) ---
{
  const { render, camera, drawDart3D } = require('./synth.js');
  const BF = require('../public/boardfinder.js');
  const W3 = 640, H3 = 360;
  const setups = {
    'Handy rechts unten': { pos: [330, 260, -520] },
    'Handy links seitlich': { pos: [-420, 40, -480] },
    'Handy unten mittig': { pos: [0, 380, -500] },
    'Handy oben rechts': { pos: [250, -330, -540] },
  };
  const P = (r, a) => Board.polar(r, a);
  const throws = [[0, -103], [0, -166], P(130, 198), P(103, 108), [0, 0], P(70, 288), P(140, 18), P(130, 72), P(60, 216)];
  let total = 0, right = 0;
  for (const [name, s] of Object.entries(setups)) {
    const cam = camera({ w: W3, h: H3, f: 480, pos: s.pos });
    const model = BF.cameraFromH(BF.solveH(BF.CAL_DST, cam.imgPts), W3, H3);
    ok(model && Math.abs(model.f - 480) < 35, name + ': Brennweite geschätzt ' + (model && model.f.toFixed(0)));
    const det = new Det.DartDetector({}); let cur;
    det.w = W3; det.h = H3; det.cur = new Uint8Array(W3 * H3); det.tmp = new Uint8Array(W3 * H3);
    det.ensureSize = () => true; det.grab = () => { det.rgba = cur; det.toGray(cur); };
    const base = render(W3, H3, cam.imgPts, { noise: 4 });
    cur = base.rgba; det.grab();
    det.setCalibration(det.autoCalibrate().pts); det.phase = 'throw';
    const res = [];
    for (const [i, [bx, by]] of throws.entries()) {
      cur = base.rgba; for (let k = 0; k < 4; k++) det.tick();
      det.startTurn();
      let got = null; det.cb = { onDart: (d) => (got = d) };
      const f = new Uint8ClampedArray(base.rgba);
      drawDart3D(f, cam, bx, by, { tilt: [0.1 * ((i % 3) - 1), 0.2], flight: i % 2 ? 235 : 60, point: [115, 200, 60][i % 3], barrel: [150, 90, 190][i % 3] });
      cur = f; for (let k = 0; k < 6; k++) det.tick();
      const want = Board.label(Board.score(bx, by));
      const ok1 = got && Board.label(got) === want;
      res.push(ok1 ? want : `${want}≠${got ? Board.label(got) : '—'}`);
      total++; if (ok1) right++;
    }
    console.log(name.padEnd(22), res.join(' '));
  }
  console.log(`3D-Pfeile: ${right}/${total} richtig`);
  ok(right >= total - 1, '3D-Pfeile ' + right + '/' + total);
}
console.log(`${pass} Tests bestanden (inkl. 3D)`);

// --- Statistik ---
{
  const S = require('../public/stats.js');
  const st = S.empty();
  const T = (seg, mult, x, y) => ({ seg, mult, value: seg * mult, x, y, auto: x != null });
  ok(S.recordTurn(st, { darts: [T(20, 3, 0, -103), T(20, 3, 1, -102), T(20, 3, -1, -104)], startScore: 501 }, { key: 'g:0', legTurn: 0 }), 'Aufnahme erfasst');
  ok(!S.recordTurn(st, { darts: [T(20, 3)], startScore: 321 }, { key: 'g:0' }), 'keine Doppelzählung');
  S.recordTurn(st, { darts: [T(20, 1), T(1, 1), T(5, 1)], startScore: 321 }, { key: 'g:1', legTurn: 1 });
  S.recordTurn(st, { darts: [T(20, 2)], startScore: 40, won: true }, { key: 'g:2', legTurn: 2, doubleOut: true });
  S.recordGame(st, { key: 'g', avg: 90, darts: 7, won: true });
  const sm = S.summary(st);
  ok(st.t180 === 1 && st.darts === 7 && st.points === 246, '180 und Punkte');
  ok(Math.abs(sm.avg - (246 / 7) * 3) < 1e-9, 'Average');
  ok(sm.dblPct === 1 && st.bestCheckout === 40 && st.checkouts === 1, 'Doppelquote und Finish');
  ok(st.fields.T20 === 3 && st.fields.D20 === 1 && sm.seg[20] === 5, 'Felder gezählt');
  ok(st.hits.length === 6, 'Heatmap-Positionen nur für Kamera-Pfeile');
  const m = S.merge(st, st);
  ok(m.darts === 14 && m.t180 === 2 && m.bestCheckout === 40, 'Zusammenführen');
  const e = S.leaderboardEntry(st, 'Domi');
  ok(e.rankAvg === 0 && e.avg > 100, 'Average-Wertung erst ab 99 Pfeilen');
  ok(JSON.stringify(st).length < 2000, 'kompakt speicherbar');
}
console.log(`${pass} Tests bestanden (inkl. Statistik)`);

// --- "Weiter" gedrückt, bevor die Pfeile gezogen sind (früher: 2x Weiter nötig) ---
{
  const { render, camera, drawDart3D } = require('./synth.js');
  const W2 = 800, H2 = 450, cam = camera({ w: W2, h: H2, f: 550, pos: [300, 250, -520] });
  const base = render(W2, H2, cam.imgPts);
  const frame = (darts) => { const f = new Uint8ClampedArray(base.rgba); darts.forEach((d) => drawDart3D(f, cam, d[0], d[1], d[2])); return f; };
  const A = [0, -103, { flight: 235 }], Bd = [...Board.polar(130, 198), { flight: 60 }], C = [...Board.polar(140, 18), { flight: 235 }];
  const N1 = [...Board.polar(60, 252), { flight: 60 }], N2 = [...Board.polar(103, 108), { flight: 235 }];
  const det = new Det.DartDetector({}); let cur;
  det.w = W2; det.h = H2; det.ensureSize = () => true; det.grab = () => { det.rgba = cur; det.toGray(cur); };
  cur = frame([]); det.grab(); det.setCalibration(det.autoCalibrate().pts); det.startTurn();
  const got = []; let cleared = 0;
  det.cb = { onDart: (d) => got.push(Board.label(d)), onCleared: () => cleared++ };
  const step = (darts, n = 6) => { cur = frame(darts); for (let k = 0; k < n; k++) det.tick(); };
  step([]); step([A]); step([A, Bd]); step([A, Bd, C]);
  det.startTurn();               // Nutzer drückt "Weiter", Pfeile stecken noch
  ok(det.awaitClear === true, 'erkennt: Pfeile stecken noch');
  step([A, Bd, C]); step([A]);   // Pfeile werden gezogen …
  step([]);                      // … Scheibe leer
  ok(det.awaitClear === false && got.length === 3, 'Ziehen erkannt, kein falscher Treffer beim Ziehen');
  step([N1]); step([N1, N2]);
  ok(got.slice(3).join() === [N1, N2].map((d) => Board.label(Board.score(d[0], d[1]))).join(), 'nächster Spieler wird wieder automatisch erkannt: ' + got.join(','));
  // Weiter gedrückt und SOFORT neu geworfen, ohne die alten Pfeile zu ziehen
  det.startTurn(); step([N1, N2, A]);
  ok(got[got.length - 1] === Board.label(Board.score(A[0], A[1])), 'Wurf trotz steckender Pfeile erkannt');
}

// --- Lernen aus Korrekturen: Spitze systematisch zu kurz erkannt ---
{
  const det = new Det.DartDetector({});
  const mk = (x, y) => ({ auto: true, x, y, bdir: [0, -1] }); // Spitze zeigt Richtung -y
  // erkannt 4 mm "hinter" der echten Spitze: oberhalb des Triple-Rings statt darin
  for (const x of [-3, 1, 2, -1]) det.learnFromCorrection(mk(x, -94), { seg: 20, mult: 3 });
  ok(det.tipBias > 2 && det.tipBias < 8, 'gelernte Verschiebung ' + (det.tipBias || 0).toFixed(1) + ' mm');
  const before = det.tipBias;
  det.learnFromCorrection(mk(40, -60), { seg: 3, mult: 1 }); // seitlich unerklärbar -> ignoriert
  ok(det.tipBias === before, 'unerklärbare Korrektur wird nicht gelernt');
}
console.log(`${pass} Tests bestanden (inkl. Weiter-Fix)`);

// --- Sprachbefehle ---
{
const V = require('../public/voicecmd.js');
const cases = [
  ['Dartcounter korrigiere auf Triple 20', 'correct last T20'],
  ['Dart Counter korrigiere auf Doppel 16', 'correct last D16'],
  ['dartcounter, korrigiere den zweiten Pfeil auf Triple 19', 'correct 1 T19'],
  ['Dartcounter korrigiere auf drei', 'correct last S3'],
  ['Dartcounter korrigiere den dritten auf fünf', 'correct 2 S5'],
  ['Dartcounter korrigiere auf Bull', 'correct last DB'],
  ['Dartcounter korrigiere auf Single Bull', 'correct last SB'],
  ['Dartcounter korrigiere auf 25', 'correct last SB'],
  ['Dartcounter korrigiere auf daneben', 'correct last M'],
  ['Dartcounter korrigiere Pfeil 1 auf T20', 'correct 0 T20'],
  ['dart counter ändere auf doppelt zwanzig', 'correct last D20'],
  ['Dartcounter korrigiere auf Tripel-17', 'correct last T17'],
  ['Dartcounter weiter', 'next'],
  ['Dartcounter zurück', 'undo'],
  ['Dartcounter trage Triple 20 ein', 'add T20'],
  ['Dartcounter korrigiere auf ein Triple 18', 'correct last T18'],
  ['Dartcounter korrigiere auf achtzehn', 'correct last S18'],
  ['Dartcounter korrigiere den letzten auf Doppel 8', 'correct last D8'],
  ['Dartcounter korrigiere den 2. Pfeil auf 14', 'correct 1 S14'],
  ['Triple 20', 'nowake'],
  ['Dartcounter korrigiere auf hallo', 'unknown'],
];
const fk = (d) => !d.seg ? 'M' : d.seg === 25 ? (d.mult === 2 ? 'DB' : 'SB') : (d.mult === 3 ? 'T' : d.mult === 2 ? 'D' : 'S') + d.seg;
let bad = 0;
for (const [t, want] of cases) {
  const r = V.parse(t);
  let got;
  if (!r.wake) got = 'nowake';
  else if (!r.command) got = 'null';
  else if (r.command.type === 'correct') got = `correct ${r.command.index == null ? 'last' : r.command.index} ${fk(r.command.dart)}`;
  else if (r.command.type === 'add') got = `add ${fk(r.command.dart)}`;
  else got = r.command.type;
  if (got !== want) { bad++; console.log('FALSCH:', t, '->', got, '(soll', want + ')'); }
}
ok(bad === 0, 'Sprachbefehle ' + (cases.length - bad) + '/' + cases.length);

  const G = Game.create([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  [[20, 3], [20, 3], [19, 1]].forEach(([sg, m]) => Game.addDart(G, { seg: sg, mult: m })); Game.next(G);
  ok(Game.correct(G, null, { seg: 20, mult: 3 }) === 'previous' && G.players[0].score === 321 && G.current === 1, 'Korrektur der vorherigen Aufnahme');
}
console.log(`${pass} Tests bestanden (inkl. Sprachbefehle)`);

