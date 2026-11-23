// Pfeile ziehen -> automatisch weiter (auch nach 1–2 Pfeilen, bei Wackeln, Lichtänderung, verdeckter Scheibe)
const assert = require('assert');
const Board = require('../public/board.js');
const Det = require('../public/detector.js');
const { render, camera, drawDart3D } = require('./synth.js');
const W = 800, H = 450, POS = [300, 250, -520];
const camA = camera({ w: W, h: H, f: 550, pos: POS });
const camB = camera({ w: W, h: H, f: 550, pos: POS, look: [4, 3, 0] }); // Handy beim Ziehen leicht angestoßen
const bases = new Map();
const base = (cam, light) => { const k = cam.imgPts.flat().join() + ':' + light; if (!bases.has(k)) bases.set(k, render(W, H, cam.imgPts, { light })); return bases.get(k); };
const A = [0, -103, { flight: 235 }], B = [...Board.polar(130, 198), { flight: 60, point: 200 }], C = [...Board.polar(140, 18), { flight: 235, barrel: 90 }];
function frame(darts, { cam = camA, light = 1, block = false, marks = 0 } = {}) {
  const f = new Uint8ClampedArray(base(cam, light).rgba);
  for (let m = 0; m < marks; m++) { // Löcher/aufgestellte Sisalfasern nach dem Ziehen, leicht verdrehte Scheibe
    const cx = 260 + (m * 53) % 260, cy = 120 + (m * 37) % 200;
    for (let y = cy; y < cy + 6; y++) for (let x = cx; x < cx + 6; x++) { const j = (y * W + x) * 4; f[j] = f[j + 1] = f[j + 2] = 245; }
  }
  darts.forEach((d) => drawDart3D(f, cam, d[0], d[1], d[2]));
  if (block) { // Spieler steht vor der Scheibe
    for (let y = 40; y < H; y++) for (let x = 120; x < 640; x++) { const j = (y * W + x) * 4; f[j] = 70; f[j + 1] = 52; f[j + 2] = 44; }
  }
  return f;
}
function setup() {
  const det = new Det.DartDetector({}); let cur;
  det.w = W; det.h = H; det.ensureSize = () => true; det.grab = () => { det.rgba = cur; det.toGray(cur); };
  cur = frame([]); det.grab(); det.setCalibration(det.autoCalibrate().pts); det.startTurn();
  const log = { darts: [], cleared: 0 };
  det.cb = { onDart: (d) => log.darts.push(Board.label(d)), onCleared: () => { log.cleared++; det.startTurn(); } }; // wie die App: weiter -> neue Aufnahme
  const step = (darts, o, n = 7) => { cur = frame(darts, o); for (let k = 0; k < n; k++) det.tick(); };
  return { det, log, step };
}
let n = 0;
const ok = (c, m) => { assert(c, m); n++; };
const want = (...ds) => ds.map((d) => Board.label(Board.score(d[0], d[1]))).join();

{ // 1 Pfeil geworfen, dann gezogen (3. und 2. Pfeil daneben) -> weiter
  const { det, log, step } = setup();
  step([]); step([A]);
  ok(log.darts.join() === want(A), '1 Pfeil erkannt');
  step([]);
  ok(log.cleared === 1 && log.darts.length === 1, 'nach 1 Pfeil: Ziehen erkannt');
}
{ // 2 Pfeile, einzeln gezogen (mit Pause dazwischen) -> kein Phantom-Pfeil, dann weiter
  const { det, log, step } = setup();
  step([]); step([A]); step([A, B]);
  step([B]);
  ok(log.cleared === 0 && log.darts.length === 2, 'halb gezogen: kein falscher Treffer, noch nicht weiter (' + log.darts.join() + ')');
  step([]);
  ok(log.cleared === 1, 'nach 2 Pfeilen einzeln gezogen: weiter');
}
{ // 3 Pfeile, beim Ziehen steht der Spieler vor der Scheibe und zieht in zwei Etappen
  const { det, log, step } = setup();
  step([]); step([A]); step([A, B]); step([A, B, C]);
  det.phase = 'pull';
  step([A, B, C], { block: true }, 14);
  step([C]);                   // zwei gezogen, Spieler tritt kurz zur Seite
  ok(log.cleared === 0, 'ein Pfeil steckt noch');
  step([C], { block: true }, 14);
  step([]);
  ok(log.cleared === 1, 'verdeckt + in Etappen gezogen: weiter (' + det.lastClear + ')');
}
{ // 3 Pfeile, beim Ziehen angestoßen und Licht ändert sich
  const { det, log, step } = setup();
  step([]); step([A]); step([A, B]); step([A, B, C]);
  det.phase = 'pull';
  step([], { cam: camB, light: 0.86 }, 14);
  ok(log.cleared === 1, 'Wackeln + Lichtänderung: weiter (' + det.lastClear + ')');
}
{ // lange Pause (Gegner dran), Licht ändert sich langsam, dann eigener Zug
  const { det, log, step } = setup();
  det.phase = 'idle';
  step([], { light: 0.95 }); step([], { light: 0.9 }); step([], { light: 0.85 });
  det.startTurn();
  ok(!det.awaitClear, 'nach Lichtänderung keine „Pfeile ziehen“-Sperre');
  step([A], { light: 0.85 }); step([A, B], { light: 0.85 }); step([A, B, C], { light: 0.85 });
  ok(log.darts.join() === want(A, B, C), 'Würfe nach Pause erkannt');
  det.phase = 'pull';
  step([], { light: 0.85 });
  ok(log.cleared === 1, 'nach Pause + Lichtänderung: weiter');
}
{ // nach dem Ziehen bleiben kleine Spuren (Löcher, Fasern) – früher blieb es dann hängen
  const { det, log, step } = setup();
  step([]); step([A]); step([A, B]);
  step([], { marks: 9 });
  ok(log.cleared === 1, '2 Pfeile gezogen, kleine Spuren bleiben: weiter (' + det.lastClear + ')');
  det.phase = 'throw';
  step([B], { marks: 9 }); step([B, C], { marks: 9 }); step([A, B, C], { marks: 9 });
  det.phase = 'pull';
  step([], { marks: 18 });
  ok(log.cleared === 2, '3 Pfeile gezogen, mehr Spuren: weiter (' + det.lastClear + ')');
}
console.log(`Pfeile-ziehen-Tests ok (${n})`);
