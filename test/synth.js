// Erzeugt künstliche Farbbilder einer Dartscheibe aus beliebiger Perspektive (für Tests)
const Board = require('../public/board.js');
const F = require('../public/boardfinder.js');
const COL = { red: [200, 45, 40], green: [30, 140, 70], dark: [28, 27, 26], cream: [225, 210, 170], surround: [22, 22, 22], wall: [150, 148, 140], num: [230, 230, 230] };
function render(w, h, imgPts, opts = {}) {
  const Hb2i = F.solveH(F.CAL_DST, imgPts), Hi2b = F.invertH(Hb2i);
  const rgba = new Uint8ClampedArray(w * h * 4);
  const noise = opts.noise ?? 6, light = opts.light ?? 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; const acc = [0, 0, 0];
    for (const [ox, oy] of [[.25, .25], [.75, .25], [.25, .75], [.75, .75]]) { // 4x Supersampling
      const [bx, by] = F.applyH(Hi2b, x + ox, y + oy);
      const r = Math.hypot(bx, by), d = Board.score(bx, by);
      let c = COL.wall;
      if (r < 225) c = COL.surround;
      if (r <= 170) {
        const i = Board.ORDER.indexOf(d.seg), even = i % 2 === 0;
        c = d.mult >= 2 ? (even ? COL.red : COL.green) : even ? COL.dark : COL.cream;
        if (d.seg === 25) c = d.mult === 2 ? COL.red : COL.green;
      }
      acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; s++;
    }
    const j = (y * w + x) * 4;
    for (let k = 0; k < 3; k++) rgba[j + k] = acc[k] / s * light + (Math.random() - .5) * noise;
    rgba[j + 3] = 255;
  }
  return { rgba, Hb2i };
}
const gray = (rgba) => { const g = new Uint8Array(rgba.length / 4); for (let i = 0; i < g.length; i++) g[i] = (rgba[i*4]*77 + rgba[i*4+1]*150 + rgba[i*4+2]*29) >> 8; return g; };
function drawDart(rgba, w, h, Hb2i, bx, by, dir, val) {
  const tip = F.applyH(Hb2i, bx, by), [dx, dy] = dir, nx = -dy, ny = dx;
  for (let t = 0; t <= 75; t += .5) { const half = t < 48 ? 1.3 : 1.3 + (t - 48) * .35;
    for (let s = -half; s <= half; s += .5) { const x = Math.round(tip[0] + dx * t + nx * s), y = Math.round(tip[1] + dy * t + ny * s);
      if (x >= 0 && x < w && y >= 0 && y < h) { const j = (y * w + x) * 4; rgba[j] = rgba[j+1] = rgba[j+2] = val; } } }
}
module.exports = { render, gray, drawDart };

// ---------- Realistische Kamera + 3D-Pfeile ----------
// Scheiben-Koordinaten: x rechts, y unten, z in die Wand (Kamera steht bei z < 0)
function camera({ w, h, f, pos, look = [0, 0, 0] }) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const nrm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  const zc = nrm(sub(look, pos)), xc = nrm(cross([0, 1, 0], zc)), yc = cross(zc, xc);
  const project = (X) => {
    const d = sub(X, pos);
    const P = [xc, yc, zc].map((r) => r[0] * d[0] + r[1] * d[1] + r[2] * d[2]);
    return [(f * P[0]) / P[2] + w / 2, (f * P[1]) / P[2] + h / 2, P[2]];
  };
  const imgPts = F.CAL_DST.map(([x, y]) => project([x, y, 0]).slice(0, 2));
  return { w, h, f, project, imgPts };
}
// Pfeil steckt bei (bx,by), ragt ~110 mm nach vorn; tilt = leichte Neigung (mm pro mm)
// Profil: Spitze 0–28 mm dünn, Barrel 28–70 mm dick, Schaft 70–85 mm dünn, Flight 85–125 mm breit
function drawDart3D(rgba, cam, bx, by, opts = {}) {
  const { tilt = [0.15, 0.25], barrel = 150, flight = 235 } = opts;
  const { w, h } = cam;
  for (let t = 0; t <= 125; t += 0.4) {
    const X = [bx + tilt[0] * t, by + tilt[1] * t, -t];
    const [u, v, z] = cam.project(X);
    const mm = t < 28 ? 1 : t < 70 ? 3.4 : t < 85 ? 1.6 : 9 * Math.min(1, (t - 85) / 12);
    const col = t < 85 ? (t < 28 ? (opts.point ?? 115) : barrel) : flight;
    const r = Math.max(0.6, (mm * cam.f) / z);
    for (let yy = Math.floor(v - r); yy <= Math.ceil(v + r); yy++) for (let xx = Math.floor(u - r); xx <= Math.ceil(u + r); xx++) {
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || Math.hypot(xx - u, yy - v) > r) continue;
      const j = (yy * w + xx) * 4; rgba[j] = rgba[j + 1] = rgba[j + 2] = col;
    }
  }
}
module.exports.camera = camera;
module.exports.drawDart3D = drawDart3D;
// Physikalisch passende Bildrichtung Spitze->Flight für eine (aus imgPts abgeleitete) Kamera
function dirFor(imgPts, w, h, bx, by, fallback) {
  const m = F.cameraFromH(F.solveH(F.CAL_DST, imgPts), w, h);
  if (!m) return fallback;
  const [dx, dy] = m.flightDir(bx, by), l = Math.hypot(dx, dy);
  return l > 4 ? [dx / l, dy / l] : fallback;
}
module.exports.dirFor = dirFor;
