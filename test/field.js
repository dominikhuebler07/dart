// Pfeilrichtung aus echten Würfen lernen: Wenn das Kameramodell die Richtung (Spitze -> Flight) falsch vorhersagt
// (wie bei einem Handy weit weg / nur leicht schräg), darf die App nicht den Flight für die Spitze halten.
const assert = require('assert');
const Board = require('../public/board.js');
const Det = require('../public/detector.js');
const { render, camera, drawDart3D } = require('./synth.js');
const W = 800, H = 450, POS = [300, 250, -520];
const cam = camera({ w: W, h: H, f: 550, pos: POS });
const base = render(W, H, cam.imgPts, {});
const frame = (darts) => { const f = new Uint8ClampedArray(base.rgba); darts.forEach((d) => drawDart3D(f, cam, d[0], d[1], d[2] || {})); return f; };
// Treffer quer über die Scheibe (inkl. linke/untere Hälfte, wo es vorher am schlimmsten war)
const SPOTS = [[0, -103], ...[30, 75, 120, 165, 210, 255, 300, 345].map((a, i) => Board.polar(i % 2 ? 140 : 70, a)), Board.polar(103, 198), Board.polar(160, 252), Board.polar(40, 120)];
function run(rotateModel) {
  const det = new Det.DartDetector({}); let cur;
  det.w = W; det.h = H; det.ensureSize = () => true; det.grab = () => { det.rgba = cur; det.toGray(cur); };
  cur = frame([]); det.grab(); det.setCalibration(det.autoCalibrate().pts);
  if (rotateModel) { // Kameramodell sagt die Richtung um rotateModel Grad verdreht voraus
    const wrap = () => { const c = det.cam; if (!c || c.wrapped) return; const o = c.flightDir; const a = (rotateModel * Math.PI) / 180;
      c.flightDir = (x, y, l) => { const [dx, dy] = o(x, y, l); return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)]; }; c.wrapped = true; };
    const bm = det.buildMask.bind(det); det.buildMask = () => { bm(); wrap(); }; wrap();
  }
  det.startTurn();
  const got = [];
  det.cb = { onDart: (d) => got.push(d), onCleared: () => det.startTurn() };
  const step = (darts, n = 7) => { cur = frame(darts); for (let k = 0; k < n; k++) det.tick(); };
  let right = 0, errs = [];
  for (const s of SPOTS) {
    step([]);
    const before = got.length;
    step([s]);
    const want = Board.label(Board.score(s[0], s[1]));
    const d = got[before];
    if (d && Board.label(d) === want) right++; else errs.push(want + '→' + (d ? Board.label(d) : '–'));
    det.phase = 'pull'; step([], 9); det.phase = 'throw';
  }
  return { right, n: SPOTS.length, errs };
}
const ok0 = run(0);
console.log(`Modell richtig: ${ok0.right}/${ok0.n}`);
assert(ok0.right >= ok0.n - 1, 'mit richtigem Modell erkennt es (fast) alles');
for (const rot of [50, 90, 130, 180]) {
  const bad = run(rot);
  console.log(`Modell um ${rot}° falsch: ${bad.right}/${bad.n}  ${bad.errs.join(' ')}`);
  assert(bad.right >= bad.n - 2, `auch mit um ${rot}° falsch vorhergesagter Pfeilrichtung werden die Treffer richtig gelesen`);
}
console.log('Pfeilrichtungs-Tests ok');
