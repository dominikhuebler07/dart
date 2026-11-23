// Zwei Kameras (links + rechts) zu einem Treffer verrechnen
const assert = require('assert');
const Board = require('../public/board.js');
const Det = require('../public/detector.js');
const Fuse = require('../public/fuse.js');
const { render, camera, drawDart3D } = require('./synth.js');

// ---- Zuordnung ----
{
  let t = 0; const out = [];
  const M = Fuse.createMatcher({ now: () => t, emit: (d, src) => out.push([Board.label(d), src]) });
  M.main({ x: 0, y: -103, bdir: [0.6, 0.8], q: 1 }); t = 200;
  M.help({ x: 1, y: -102, bdir: [-0.6, 0.8], q: 1 });
  assert(out.length === 1 && out[0][0] === 'T20' && out[0][1] === 'beide', 'beide Kameras -> ein Pfeil');
  M.main({ x: 50, y: 50, q: 1 }); t = 1000; M.tick();
  assert(out.length === 2 && out[1][1] === 'haupt', 'nur Hauptkamera -> nach Wartezeit allein');
  M.help({ x: -60, y: 20, q: 1 }); t = 1500; M.tick();
  assert(out.length === 2, '2. Kamera allein wartet noch'); t = 2200; M.tick();
  assert(out.length === 3 && out[2][1] === 'zweite', 'Hauptkamera verdeckt -> 2. Kamera zählt');
  M.main({ x: 0, y: 0, q: 1 }); M.main({ x: 100, y: 0, q: 1 }); M.help({ x: 101, y: 1, q: 1 }); M.help({ x: 1, y: 1, q: 1 });
  assert(out.length === 5 && out.every((o, i) => i < 3 || o[1] === 'beide'), 'zwei Pfeile richtig zugeordnet');
}

// ---- Genauigkeit mit zwei echten (synthetischen) Kameras ----
{
  const W = 640, H = 360;
  const camL = camera({ w: W, h: H, f: 470, pos: [-360, 300, -520] });
  const camR = camera({ w: W, h: H, f: 470, pos: [360, 300, -520] });
  const mk = (cam) => {
    const det = new Det.DartDetector({}); let cur;
    det.w = W; det.h = H; det.ensureSize = () => true; det.grab = () => { det.rgba = cur; det.toGray(cur); };
    const base = render(W, H, cam.imgPts, { noise: 4 });
    cur = base.rgba; det.grab(); det.setCalibration(det.autoCalibrate().pts); det.phase = 'throw';
    return { det, base, cam, set: (f) => { cur = f; } };
  };
  const L = mk(camL), R = mk(camR);
  const qL = L.det.qualityInfo().mmPerPx, qR = R.det.qualityInfo().mmPerPx;
  // 40 Würfe knapp (1,5–4 mm) neben Drähten: da entscheidet die Genauigkeit
  const P = (r, a) => Board.polar(r, a);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const throws = Array.from({ length: 40 }, (_, k) => {
    if (k % 2) { const rings = [99, 107, 162, 170, 15.9, 6.35]; const r0 = rings[Math.floor(rnd() * rings.length)]; return P(r0 + (rnd() < 0.5 ? -1 : 1) * (1.5 + 2.5 * rnd()), rnd() * 360); }
    const r = 20 + rnd() * 140, wireA = Math.floor(rnd() * 20) * 18 + 9, off = ((1.5 + 2.5 * rnd()) / r) * 180 / Math.PI;
    return P(r, wireA + (rnd() < 0.5 ? -1 : 1) * off);
  });
  const err = { L: [], R: [], F: [] }; let okL = 0, okR = 0, okF = 0, n = 0;
  throws.forEach(([bx, by], i) => {
    const want = Board.label(Board.score(bx, by));
    const res = {};
    for (const [k, C] of [['L', L], ['R', R]]) {
      C.set(C.base.rgba); for (let j = 0; j < 4; j++) C.det.tick(); C.det.startTurn();
      let got = null; C.det.cb = { onDart: (d) => (got = d) };
      const f = new Uint8ClampedArray(C.base.rgba);
      drawDart3D(f, C.cam, bx, by, { tilt: [0.08 * ((i % 3) - 1), 0.18], flight: i % 2 ? 235 : 60 });
      C.set(f); for (let j = 0; j < 6; j++) C.det.tick();
      res[k] = got;
    }
    if (!res.L || !res.R) return;
    n++;
    const F = Fuse.combine([{ ...res.L, q: qL }, { ...res.R, q: qR }]);
    err.L.push(Math.hypot(res.L.x - bx, res.L.y - by)); err.R.push(Math.hypot(res.R.x - bx, res.R.y - by)); err.F.push(Math.hypot(F.x - bx, F.y - by));
    if (Board.label(res.L) === want) okL++; if (Board.label(res.R) === want) okR++; if (Board.label(Board.score(F.x, F.y)) === want) okF++;
  });
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`2 Kameras: links Ø ${mean(err.L).toFixed(2)} mm (${okL}/${n}), rechts Ø ${mean(err.R).toFixed(2)} mm (${okR}/${n}), zusammen Ø ${mean(err.F).toFixed(2)} mm (${okF}/${n})`);
  assert(n >= throws.length - 4, 'beide Kameras erkennen die Pfeile');
  assert(mean(err.F) <= Math.min(mean(err.L), mean(err.R)) * 1.02, 'zusammen genauer als jede Kamera allein');
  assert(okF >= Math.max(okL, okR), 'zusammen mindestens so viele richtige Felder');
}
console.log('Zwei-Kamera-Tests ok');
